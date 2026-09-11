"""
NVIDIA's cuBLAS, so Whisper can run on the graphics card - fetched once, and
only on request.

CTranslate2 (Whisper's engine) has CUDA built in and needs one thing from
NVIDIA besides the driver: cuBLAS 12. It comes from NVIDIA's own package on
PyPI (nvidia-cublas-cu12), pinned to one version and checked against the hash
PyPI publishes for it. Only its two DLLs are kept, with NVIDIA's license, in
cache/cuda; the download itself is deleted once they are out. Nothing is
fetched unless someone presses Download in the deck. No cuDNN: CTranslate2
4.8's Windows build does not use it.

Measured on an RTX 3080 laptop with base.en, the card otherwise idle: a read
takes about 0.12 s instead of 1.2 s on two processor cores, and about 0.1 s
of processor time instead of 2.5 s.
"""

import ctypes
import hashlib
import json
import os
import shutil
import threading
import urllib.request
import zipfile

PACKAGE = "nvidia-cublas-cu12"
VERSION = "12.9.2.10"
WHEEL = "nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl"
SHA256 = "623f43027d40d44ceadf0043f002bd25cf353e8f13ce90b9a87057019f560661"
SIZE = 553162896
# What CTranslate2 needs from it. cublasLt first: cublas depends on it.
DLLS = ("cublasLt64_12.dll", "cublas64_12.dll")
INNER = "nvidia/cublas/bin/"
LICENSE = "nvidia_cublas_cu12-12.9.2.10.dist-info/licenses/License.txt"
FOLDER = f"cublas-{VERSION}"
INDEX = f"https://pypi.org/pypi/{PACKAGE}/{VERSION}/json"
FILES_HOST = "https://files.pythonhosted.org/"
UA = "StreamingDeck/1.0 (local captions)"
CHUNK = 1024 * 1024              # unpacking
NET_CHUNK = 256 * 1024           # downloading: small reads keep Cancel and progress quick
DOWNLOAD_MB = round(SIZE / 1e6)
DISK_MB = 770                    # the two DLLs once unpacked
NEED_FREE = SIZE + 1100 * 1000 * 1000   # the download, the DLLs and some room
# CUDA 12 runs on NVIDIA's Windows drivers from 528.33 up.
MIN_DRIVER = (528, 33)
# Windows' display adapters, one numbered key per adapter's driver.
DISPLAY_CLASS = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"


def _nvidia_version(windows_version):
    """NVIDIA's driver number from Windows' version of it: 32.0.15.9621 is (596, 21),
    and 32.0.16.523 (a file version, which drops the leading zero) is (605, 23)."""
    parts = str(windows_version).split(".")
    if len(parts) < 2:
        return None
    digits = (parts[-2] + parts[-1].zfill(4))[-5:]
    return (int(digits[:3]), int(digits[3:])) if len(digits) == 5 and digits.isdigit() else None


def _file_version(path):
    """A DLL's version as "a.b.c.d", or "" when it has none."""
    try:
        ver = ctypes.WinDLL("version")
        size = ver.GetFileVersionInfoSizeW(path, None)
        if not size:
            return ""
        buf = ctypes.create_string_buffer(size)
        if not ver.GetFileVersionInfoW(path, 0, size, buf):
            return ""
        info = ctypes.c_void_p()
        length = ctypes.c_uint()
        if not ver.VerQueryValueW(buf, "\\", ctypes.byref(info), ctypes.byref(length)):
            return ""
        # VS_FIXEDFILEINFO: signature, struct version, then the file version as two DWORDs.
        fixed = ctypes.cast(info, ctypes.POINTER(ctypes.c_uint32 * 4)).contents
        ms, ls = fixed[2], fixed[3]
        return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"
    except (OSError, AttributeError, ValueError):
        return ""


def detect_gpu():
    """(name, driver) of the NVIDIA card, or ("", "") when there is none.

    Read without waking anything - asking the driver instead (nvidia-smi, or
    CUDA itself) wakes a laptop's sleeping NVIDIA card at every launch. The
    driver is the one CUDA will load, nvcuda.dll, whose version is the
    driver's; no nvcuda.dll means no CUDA. The name comes from the registry,
    where Windows lists each display adapter's driver - but it also keeps
    entries for cards long gone, so only entries on that same driver count.
    With more than one NVIDIA card, or CUDA told which to use, the name stays
    general: CUDA picks the fastest (or the one it was told), in an order the
    registry does not show."""
    root = os.environ.get("SystemRoot", r"C:\Windows")
    nvcuda = os.path.join(root, "System32", "nvcuda.dll")
    if not os.path.isfile(nvcuda):
        return "", ""
    installed = _file_version(nvcuda)
    cards = []
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, DISPLAY_CLASS) as cls:
            i = 0
            while True:
                try:
                    sub = winreg.EnumKey(cls, i)
                except OSError:
                    break
                i += 1
                if not sub.isdigit():
                    continue
                try:
                    with winreg.OpenKey(cls, sub) as key:
                        provider = str(winreg.QueryValueEx(key, "ProviderName")[0])
                        name = str(winreg.QueryValueEx(key, "DriverDesc")[0])
                        version = str(winreg.QueryValueEx(key, "DriverVersion")[0])
                except OSError:
                    continue
                if "NVIDIA" in provider.upper():
                    cards.append((name, version))
    except (ImportError, OSError):
        pass
    want = _nvidia_version(installed) if installed else None
    current = [c for c in cards if want and _nvidia_version(c[1]) == want] or cards
    version = want or max((v for v in (_nvidia_version(c[1]) for c in current) if v), default=None)
    driver = f"{version[0]}.{version[1]:02d}" if version else ""
    if not current:
        return "", driver
    if len({c[0] for c in current}) > 1 or os.environ.get("CUDA_VISIBLE_DEVICES"):
        return "NVIDIA graphics card", driver
    return current[0][0], driver


_dll_dirs = {}                   # add_dll_directory handles by folder, kept for the process's life
_prepared = set()


def prepare(folder):
    """Make cuBLAS loadable for CTranslate2, which asks Windows for it by bare
    name the first time it reads: both DLLs are loaded now by full path, and
    Windows answers a later request by name with the copy already loaded.
    Nothing goes on PATH, which every program the app starts would inherit.
    Raises OSError saying which file would not load."""
    if folder in _prepared:
        return
    for name in DLLS:
        if not os.path.isfile(os.path.join(folder, name)):
            raise OSError(f"{name} is missing")
    # With CUDA_PATH set (a CUDA toolkit installed), CTranslate2 points the
    # process's DLL search at the toolkit before it asks for cuBLAS - a change
    # that outlasts the request and moves where every later DLL is looked for.
    os.environ.pop("CUDA_PATH", None)
    if folder not in _dll_dirs:
        try:
            _dll_dirs[folder] = os.add_dll_directory(folder)
        except (AttributeError, OSError):
            _dll_dirs[folder] = None
    for name in DLLS:
        try:
            ctypes.WinDLL(os.path.join(folder, name))
        except OSError as exc:
            code = getattr(exc, "winerror", None)
            raise OSError(f"{name} would not load" + (f", Windows error {code}" if code else "")) from exc
    _prepared.add(folder)


class GpuStore:
    def __init__(self, folder):
        self.folder = folder
        self._lock = threading.Lock()
        self._job = {}               # progress of a running or failed download
        self._ready = None           # the unpacked folder, once complete
        self._pending = False        # removed, but its files stay in use until the app restarts
        self.version = 0             # bumps whenever anything visible changes
        self.on_change = None        # called once the library arrives or goes
        os.makedirs(folder, exist_ok=True)
        self._check()
        self.gpu, self.driver = detect_gpu()     # "" when there is no NVIDIA card
        parts = self.driver.split(".")
        nv = tuple(int(p) for p in parts) if len(parts) == 2 and all(p.isdigit() for p in parts) else None
        self.driver_ok = nv is None or nv >= MIN_DRIVER

    def cleanup(self):
        """Clear what an older version, a crash, a cancel or a removal of files
        still in use left behind. Called once this process owns the app - a
        second copy started by mistake must not touch the first one's files."""
        ok = self._check()
        for name in os.listdir(self.folder):
            if ok and name == FOLDER:
                continue
            path = os.path.join(self.folder, name)
            if os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
            else:
                try:
                    os.remove(path)
                except OSError:
                    pass

    # ------------------------------------------------------------- state

    def _check(self):
        """Is a complete copy on disk? Reads the manifest written last, so a
        half-finished unpack never counts."""
        final = os.path.join(self.folder, FOLDER)
        ok = False
        try:
            with open(os.path.join(final, "manifest.json"), encoding="utf-8") as f:
                files = json.load(f)["files"]
            ok = set(files) == set(DLLS) and all(
                os.path.getsize(os.path.join(final, name)) == size
                for name, size in files.items())
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            ok = False
        with self._lock:
            self._ready = final if ok else None
            self.version += 1
        return ok

    def path(self):
        with self._lock:
            return self._ready

    def status(self):
        """Cheap: the broadcast reads this several times a second."""
        with self._lock:
            job = self._job
            return {
                "gpu": self.gpu, "driver": self.driver, "driver_ok": self.driver_ok,
                "ready": bool(self._ready),
                "pending": self._pending,
                "downloading": bool(job.get("running")),
                "phase": job.get("phase", "") if job.get("running") else "",   # download | unpack
                "done": job.get("done", 0), "total": job.get("total", SIZE),
                "error": job.get("error", ""),
                "download_mb": DOWNLOAD_MB, "disk_mb": DISK_MB,
            }

    # ------------------------------------------------------------- download

    def download(self):
        final = os.path.join(self.folder, FOLDER)
        with self._lock:
            if self._job.get("running") or self._ready:
                return {"ok": True, "already": True}
            if self._pending:
                return {"ok": False, "reason": "The copy removed earlier is still in use - "
                                               "restart the app, then download again."}
            self._job = {"running": True, "phase": "download", "done": 0, "total": SIZE,
                         "error": "", "cancel": False}
            self.version += 1
        # Anything incomplete left from a failed try (nothing of it was loaded).
        shutil.rmtree(final, ignore_errors=True)
        threading.Thread(target=self._download, daemon=True).start()
        return {"ok": True}

    def cancel(self):
        with self._lock:
            if self._job.get("running"):
                self._job["cancel"] = True
        return {"ok": True}

    def remove(self):
        with self._lock:
            if self._job.get("running"):
                return {"ok": False, "reason": "still downloading"}
        final = os.path.join(self.folder, FOLDER)
        try:
            # First, so it stops counting as there even if the DLLs are in use
            # (loaded this run, they cannot be deleted until the app closes;
            # the next start clears them).
            os.remove(os.path.join(final, "manifest.json"))
        except OSError:
            pass
        shutil.rmtree(final, ignore_errors=True)
        with self._lock:
            self._pending = os.path.exists(final)
        self._check()
        self._changed()
        return {"ok": True, "pending": self._pending}

    def install_wheel(self, wheel_path):
        """Unpack an already-downloaded copy of the pinned wheel, after checking
        it is exactly that file. The download ends here too."""
        h = hashlib.sha256()
        with open(wheel_path, "rb") as f:
            for block in iter(lambda: f.read(CHUNK), b""):
                h.update(block)
        if os.path.getsize(wheel_path) != SIZE or h.hexdigest() != SHA256:
            raise RuntimeError("that file is not the expected cuBLAS package")
        self._unpack(wheel_path)
        self._verify()
        self._changed()

    def _verify(self):
        """After an unpack: does the copy check out? If not, it goes - none of
        it has been loaded, so it can - and the error says why."""
        if not self._check():
            shutil.rmtree(os.path.join(self.folder, FOLDER), ignore_errors=True)
            raise RuntimeError("the unpacked files did not check out - "
                               "an antivirus may have removed one")

    def _changed(self):
        if self.on_change:
            try:
                self.on_change()
            except Exception:
                pass

    def _update(self, **kw):
        with self._lock:
            self._job.update(kw)
            self.version += 1

    def _cancelled(self):
        with self._lock:
            return self._job.get("cancel")

    def _get(self, url, timeout=30):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        return urllib.request.urlopen(req, timeout=timeout)

    def _unpack(self, wheel_path):
        """Only the two DLLs and NVIDIA's license, each by its exact name inside
        the archive and written under a name of our own: no path from the
        archive is ever used, so no archive could place a file anywhere."""
        staging = os.path.join(self.folder, FOLDER + ".partial")
        final = os.path.join(self.folder, FOLDER)
        shutil.rmtree(staging, ignore_errors=True)
        os.makedirs(staging)
        try:
            sizes = {}
            wanted = [(INNER + name, name) for name in DLLS] + [(LICENSE, "License.txt")]
            with zipfile.ZipFile(wheel_path) as z:
                for member, name in wanted:
                    info = z.getinfo(member)
                    target = os.path.join(staging, name)
                    with z.open(info) as src, open(target, "wb") as dst:   # zipfile checks each CRC
                        for block in iter(lambda: src.read(CHUNK), b""):
                            if self._cancelled():
                                raise InterruptedError("canceled")
                            dst.write(block)
                    if os.path.getsize(target) != info.file_size:
                        raise RuntimeError(f"{name} unpacked incomplete")
                    if name in DLLS:
                        sizes[name] = info.file_size
            with open(os.path.join(staging, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump({"package": PACKAGE, "version": VERSION, "sha256": SHA256,
                           "files": sizes}, f, indent=2)
            shutil.rmtree(final, ignore_errors=True)
            if os.path.exists(final):
                raise RuntimeError("the copy removed earlier is still in use - "
                                   "restart the app, then try again")
            os.replace(staging, final)
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    def _download(self):
        part = os.path.join(self.folder, WHEEL + ".part")
        try:
            free = shutil.disk_usage(self.folder).free
            if free < NEED_FREE:
                raise RuntimeError(f"it needs about {NEED_FREE / 1e9:.1f} GB free on this drive "
                                   f"and there is {free / 1e9:.1f} GB")
            # Where PyPI keeps that exact file, and the hash it publishes for it.
            with self._get(INDEX) as r:
                info = json.load(r)
            entry = next((u for u in info.get("urls", []) if u.get("filename") == WHEEL), None)
            if not entry:
                raise RuntimeError("PyPI no longer lists that file")
            if (entry.get("digests") or {}).get("sha256") != SHA256:
                raise RuntimeError("PyPI's hash for it is not the one this app expects")
            url = entry.get("url") or ""
            if not url.startswith(FILES_HOST):
                raise RuntimeError("PyPI pointed somewhere unexpected")
            h = hashlib.sha256()
            got = 0
            with self._get(url, timeout=60) as r, open(part, "wb") as out:
                while True:
                    if self._cancelled():
                        raise InterruptedError("canceled")
                    block = r.read(NET_CHUNK)
                    if not block:
                        break
                    out.write(block)
                    h.update(block)
                    got += len(block)
                    if got > SIZE:
                        raise RuntimeError("the download is larger than expected")
                    self._update(done=got)
            if got != SIZE:
                raise RuntimeError("the download arrived incomplete")
            if h.hexdigest() != SHA256:
                raise RuntimeError("the download did not match its published hash")
            self._update(phase="unpack")
            self._unpack(part)
            self._verify()
            self._update(running=False, phase="", error="")
            self._changed()
        except Exception as exc:
            if isinstance(exc, InterruptedError) or self._cancelled():
                # Canceled - even when the connection gave up first.
                self._update(running=False, phase="", error="", done=0)
            else:
                reason = getattr(exc, "reason", None) or exc
                self._update(running=False, phase="", error=f"Download failed: {reason}")
        finally:
            try:
                os.remove(part)
            except OSError:
                pass
