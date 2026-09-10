"""
Speech models for the captions, fetched once and only on request.

Whisper needs its weights on disk before it can listen. They come from
Systran's faster-whisper repositories on Hugging Face - only when someone
presses Download in the deck, never on their own - are checked against the
hashes Hugging Face publishes for that exact revision, and then live in
cache/models. After that, captions run fully offline.
"""

import hashlib
import json
import os
import shutil
import threading
import urllib.parse
import urllib.request

# Only these can be fetched. The deck asks by name, so a local endpoint can
# never be talked into pulling arbitrary files onto the machine.
MODELS = {
    "tiny.en":  {"repo": "Systran/faster-whisper-tiny.en",  "label": "Tiny",  "approx_mb": 75,
                 "note": "fastest, makes more mistakes"},
    "base.en":  {"repo": "Systran/faster-whisper-base.en",  "label": "Base",  "approx_mb": 150,
                 "note": "fast and accurate (recommended)"},
    "small.en": {"repo": "Systran/faster-whisper-small.en", "label": "Small", "approx_mb": 485,
                 "note": "most accurate, uses more CPU"},
}
DEFAULT = "base.en"

# What faster-whisper loads from a model folder (its own allow-list).
WANTED = ("config.json", "preprocessor_config.json", "model.bin", "tokenizer.json")
HUB = "https://huggingface.co"
UA = "StreamingDeck/1.0 (local captions)"
CHUNK = 256 * 1024


def _wanted(name):
    return name in WANTED or name.startswith("vocabulary.")


class ModelStore:
    def __init__(self, folder):
        self.folder = folder
        self._lock = threading.Lock()
        self._jobs = {}              # name -> progress of a running/failed download
        self._ready = {}             # name -> folder, refreshed on change only
        self.version = 0             # bumps whenever anything visible changes
        self.on_change = None        # called with a name once it arrives or goes
        os.makedirs(folder, exist_ok=True)
        for name in MODELS:
            self._check(name)

    # ------------------------------------------------------------- state

    def _check(self, name):
        """Is a complete, verified copy on disk? Reads the manifest the
        download writes last, so a half-finished one never counts."""
        folder = os.path.join(self.folder, name)
        ok = False
        try:
            with open(os.path.join(folder, "manifest.json"), encoding="utf-8") as f:
                files = json.load(f)["files"]
            ok = bool(files) and all(
                os.path.getsize(os.path.join(folder, fn)) == size
                for fn, size in files.items())
        except (OSError, ValueError, KeyError, TypeError):
            ok = False
        with self._lock:
            if ok:
                self._ready[name] = folder
            else:
                self._ready.pop(name, None)
            self.version += 1
        return ok

    def path(self, name):
        with self._lock:
            return self._ready.get(name)

    def status(self):
        """Cheap: the broadcast reads this several times a second."""
        with self._lock:
            out = {}
            for name, meta in MODELS.items():
                job = self._jobs.get(name) or {}
                out[name] = {
                    "label": meta["label"], "approx_mb": meta["approx_mb"],
                    "note": meta["note"],
                    "ready": name in self._ready,
                    "downloading": bool(job.get("running")),
                    "done": job.get("done", 0), "total": job.get("total", 0),
                    "error": job.get("error", ""),
                }
            return out

    # ------------------------------------------------------------- download

    def download(self, name):
        if name not in MODELS:
            return {"ok": False, "reason": "unknown model"}
        with self._lock:
            job = self._jobs.get(name)
            if job and job.get("running"):
                return {"ok": True, "already": True}
            self._jobs[name] = {"running": True, "done": 0, "total": 0,
                                "error": "", "cancel": False}
            self.version += 1
        threading.Thread(target=self._download, args=(name,), daemon=True).start()
        return {"ok": True}

    def cancel(self, name):
        with self._lock:
            job = self._jobs.get(name)
            if job and job.get("running"):
                job["cancel"] = True
        return {"ok": True}

    def remove(self, name):
        if name not in MODELS:
            return {"ok": False, "reason": "unknown model"}
        with self._lock:
            job = self._jobs.get(name)
            if job and job.get("running"):
                return {"ok": False, "reason": "still downloading"}
        shutil.rmtree(os.path.join(self.folder, name), ignore_errors=True)
        self._check(name)
        self._changed(name)
        return {"ok": True}

    def _changed(self, name):
        if self.on_change:
            try:
                self.on_change(name)
            except Exception:
                pass

    def _update(self, name, **kw):
        with self._lock:
            self._jobs[name].update(kw)
            self.version += 1

    def _cancelled(self, name):
        with self._lock:
            return self._jobs[name].get("cancel")

    def _get(self, url, timeout=30):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        return urllib.request.urlopen(req, timeout=timeout)

    def _download(self, name):
        repo = MODELS[name]["repo"]
        partial = os.path.join(self.folder, name + ".partial")
        try:
            # The file list and hashes, pinned to one revision so the files
            # and the hashes they are checked against always match.
            with self._get(f"{HUB}/api/models/{repo}?blobs=true") as r:
                info = json.load(r)
            sha = info.get("sha") or "main"
            files = [s for s in info.get("siblings", []) if _wanted(s.get("rfilename", ""))]
            names = {s["rfilename"] for s in files}
            if not {"config.json", "model.bin", "tokenizer.json"} <= names:
                raise RuntimeError("the model repository is missing files")
            total = sum(int(s.get("size") or 0) for s in files)
            self._update(name, total=total)

            shutil.rmtree(partial, ignore_errors=True)
            os.makedirs(partial)
            done, sizes = 0, {}
            for s in files:
                fn = s["rfilename"]
                url = f"{HUB}/{repo}/resolve/{sha}/{urllib.parse.quote(fn)}"
                lfs = s.get("lfs") or {}
                want_sha256 = lfs.get("sha256") or lfs.get("oid")
                h = hashlib.sha256() if want_sha256 else hashlib.sha1()
                size = int(s.get("size") or 0)
                if not want_sha256:
                    # A plain git file is addressed by the hash of its blob.
                    h.update(b"blob %d\0" % size)
                got = 0
                with self._get(url, timeout=60) as r, \
                        open(os.path.join(partial, fn), "wb") as out:
                    while True:
                        if self._cancelled(name):
                            raise InterruptedError("canceled")
                        block = r.read(CHUNK)
                        if not block:
                            break
                        out.write(block)
                        h.update(block)
                        got += len(block)
                        done += len(block)
                        self._update(name, done=done)
                if size and got != size:
                    raise RuntimeError(f"{fn} arrived incomplete")
                want = want_sha256 or s.get("blobId")
                if want and h.hexdigest() != want:
                    raise RuntimeError(f"{fn} did not match its published hash")
                sizes[fn] = got

            with open(os.path.join(partial, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump({"repo": repo, "revision": sha, "files": sizes}, f, indent=2)
            final = os.path.join(self.folder, name)
            shutil.rmtree(final, ignore_errors=True)
            os.replace(partial, final)
            self._check(name)
            self._update(name, running=False, error="")
            self._changed(name)
        except InterruptedError:
            shutil.rmtree(partial, ignore_errors=True)
            self._update(name, running=False, error="", done=0)
        except Exception as exc:
            shutil.rmtree(partial, ignore_errors=True)
            reason = getattr(exc, "reason", None) or exc
            self._update(name, running=False, error=f"Download failed: {reason}")
