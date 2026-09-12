"""
A scene as one file to keep or pass on: a .zip holding the scene
(scene.json), the pictures and videos it shows (assets/), the fonts it
names (fonts/) and a manifest.json that says what is inside.

Nothing in an imported file is trusted. The archive's size, its number of
members and their names are checked before anything is unpacked; every
member is read with a cap, so a header that lies about its size cannot
unpack a bomb; pictures, videos and fonts have to start the way their kind
of file starts; the scene goes through scenes.migrate (bad values clamped,
unknown fields kept); and only the files the scene uses are kept. Files are
stored by their own hash, as uploads are, so one whose content no longer
matches its name is stored under its real name and the scene pointed at it.
"""

import base64
import ctypes
import io
import json
import os
import re
import time
import urllib.parse
import uuid
import zipfile
import zlib

import fonts
import scenes

FORMAT = "awesome-streaming-deck/scene"
VERSION = 1
MB = 1024 * 1024
MAX_ZIP = 300 * MB            # the file itself
MAX_TOTAL = 600 * MB          # everything in it, unpacked
MAX_MEMBERS = 500
MAX_JSON = 4 * MB
MAX_THUMB = 512 * 1024

ASSET_ID = re.compile(r"^[0-9a-f]{16}\.(?:png|jpe?g|gif|webp|svg|webm|mp4)$")
ASSET_FILE = re.compile(r"^assets/([0-9a-f]{16}\.(?:png|jpe?g|gif|webp|svg|webm|mp4))$")
THUMB_FILE = re.compile(r"^assets/[0-9a-f]{16}\.(?:png|jpe?g|gif|webp|svg|webm|mp4)\.thumb\.jpg$")
FONT_FILE = re.compile(r"^fonts/([0-9a-f]{16}\.(?:ttf|otf|woff2?))$")

# How each kind of file starts. A "picture" that does not start like one is
# left out, whatever else it might be.
_SFNT = (b"\x00\x01\x00\x00", b"true", b"ttcf", b"OTTO")
MAGIC = {
    ".png": lambda b: b.startswith(b"\x89PNG\r\n\x1a\n"),
    ".jpg": lambda b: b.startswith(b"\xff\xd8\xff"),
    ".jpeg": lambda b: b.startswith(b"\xff\xd8\xff"),
    ".gif": lambda b: b[:6] in (b"GIF87a", b"GIF89a"),
    ".webp": lambda b: b[:4] == b"RIFF" and b[8:12] == b"WEBP",
    ".svg": lambda b: b"<svg" in b[:65536].lower(),
    ".webm": lambda b: b.startswith(b"\x1a\x45\xdf\xa3"),
    ".mp4": lambda b: b[4:8] == b"ftyp",
    ".ttf": lambda b: b[:4] in _SFNT,
    ".otf": lambda b: b[:4] in _SFNT,
    ".woff": lambda b: b[:4] == b"wOFF",
    ".woff2": lambda b: b[:4] == b"wOF2",
}
_DAMAGED = (zipfile.BadZipFile, zlib.error, EOFError, OSError, NotImplementedError, RuntimeError, ValueError)


class ImportRefused(Exception):
    """Not a scene this app will take in; the message says why, to a person."""


class _Skip(Exception):
    """One file inside is left out; the message says why."""


def _mb(n):
    return f"{n // MB} MB"


# ------------------------------------------------------------ what a scene uses

def _strings(value):
    """Every string anywhere inside a scene."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)


def used_assets(scene):
    """(asset ids, names of shipped pictures) the scene refers to, anywhere
    in it: "<id>" or ".../asset/<id>", and "builtin:<file>"."""
    ids, builtin = set(), set()
    for s in _strings(scene):
        if s.startswith("builtin:"):
            builtin.add(os.path.basename(s.split(":", 1)[1]))
            continue
        tail = urllib.parse.unquote(s).rsplit("/", 1)[-1]
        if ASSET_ID.match(tail):
            ids.add(tail)
    return ids, builtin


def _named(scene):
    """Every short string in the scene, as a font family would be written."""
    return {s.strip().strip("\"'").lower() for s in _strings(scene) if 0 < len(s) <= 80}


def used_fonts(scene, font_store):
    """The added font files whose family the scene names somewhere."""
    named = _named(scene)
    return [f for f in font_store.list() if f["family"].lower() in named]


def _repoint(value, remap):
    """The scene with each asset reference in `remap` pointed at its new id."""
    if isinstance(value, str):
        tail = value.rsplit("/", 1)[-1]
        return value[:len(value) - len(tail)] + remap[tail] if tail in remap else value
    if isinstance(value, dict):
        return {k: _repoint(v, remap) for k, v in value.items()}
    if isinstance(value, list):
        return [_repoint(v, remap) for v in value]
    return value


# ------------------------------------------------------------ export

def _slug(name):
    s = re.sub(r"[^A-Za-z0-9 _.()-]+", "", name or "").strip().strip(".")
    return re.sub(r"\s+", " ", s)[:60] or "Scene"


def export_zip(scene, asset_store, font_store):
    """(the .zip's bytes, a file name for it, what went in)."""
    ids, builtin = used_assets(scene)
    names = {a["id"]: a.get("name") for a in asset_store.list() if not a.get("builtin")}
    manifest = {
        "format": FORMAT, "version": VERSION, "app": "Awesome Streaming Deck",
        "exported": round(time.time()),
        "scene": {"name": scene.get("name"), "format": scene.get("format"),
                  "width": scene.get("width"), "height": scene.get("height"),
                  "layers": len(scene.get("layers") or [])},
        "assets": [], "fonts": [], "builtin": sorted(builtin), "missing": [],
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for aid in sorted(ids):
            full = asset_store.path(aid)
            if not full:
                manifest["missing"].append(aid)     # used, but deleted since
                continue
            # Pictures and videos are compressed already: stored, not squeezed again.
            zf.write(full, "assets/" + aid, compress_type=zipfile.ZIP_STORED)
            if os.path.isfile(full + asset_store.THUMB):
                zf.write(full + asset_store.THUMB, "assets/" + aid + asset_store.THUMB,
                         compress_type=zipfile.ZIP_STORED)
            manifest["assets"].append({"id": aid, "name": names.get(aid) or aid,
                                       "bytes": os.path.getsize(full)})
        for f in used_fonts(scene, font_store):
            full = font_store.path(f["id"])
            if full:
                zf.write(full, "fonts/" + f["id"])
                manifest["fonts"].append({"id": f["id"], "family": f["family"], "weight": f["weight"],
                                          "italic": f["italic"], "name": f.get("name") or f["id"]})
        zf.writestr("scene.json", json.dumps(scene, indent=1))
        zf.writestr("manifest.json", json.dumps(manifest, indent=1))
    return buf.getvalue(), _slug(scene.get("name")) + ".zip", manifest


def downloads_dir():
    """The user's Downloads folder, wherever they have moved it."""
    try:
        class GUID(ctypes.Structure):
            _fields_ = [("d1", ctypes.c_uint32), ("d2", ctypes.c_uint16),
                        ("d3", ctypes.c_uint16), ("d4", ctypes.c_ubyte * 8)]
        folder = GUID.from_buffer_copy(uuid.UUID("374DE290-123F-4565-9164-39C4925E467B").bytes_le)
        out = ctypes.c_wchar_p()
        shell32, ole32 = ctypes.windll.shell32, ctypes.windll.ole32
        if shell32.SHGetKnownFolderPath(ctypes.byref(folder), 0, None, ctypes.byref(out)) == 0:
            path = out.value
            ole32.CoTaskMemFree(out)
            if path and os.path.isdir(path):
                return path
    except (AttributeError, OSError, ValueError):
        pass
    return os.path.join(os.path.expanduser("~"), "Downloads")


def unique_path(folder, filename):
    """folder/filename, or "name (2).zip" and on, so nothing is overwritten."""
    stem, ext = os.path.splitext(filename)
    path, n = os.path.join(folder, filename), 2
    while os.path.exists(path):
        path, n = os.path.join(folder, f"{stem} ({n}){ext}"), n + 1
    return path


def save_export(scene, asset_store, font_store, folder):
    """Write the scene's .zip into `folder` (made if need be)."""
    data, filename, manifest = export_zip(scene, asset_store, font_store)
    os.makedirs(folder, exist_ok=True)
    path = unique_path(folder, filename)
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return {"ok": True, "path": path, "file": os.path.basename(path), "bytes": len(data),
            "assets": len(manifest["assets"]), "fonts": len(manifest["fonts"]),
            "missing": manifest["missing"], "builtin": manifest["builtin"]}


# ------------------------------------------------------------ import

def from_data_url(value):
    """The bytes of a browser FileReader data: URL (or of bare base64)."""
    s = str(value or "")
    try:
        return base64.b64decode(s.split(",", 1)[1] if "," in s else s, validate=False)
    except ValueError:
        raise ImportRefused("That file arrived damaged - try again.") from None


def _safe(name):
    parts = name.split("/")
    return (0 < len(name) <= 200 and not name.startswith("/") and "\\" not in name
            and ":" not in name and ".." not in parts and "" not in parts[:-1])


def _read(zf, info, limit):
    if info.file_size > limit:
        raise _Skip(f"{info.filename} is larger than {_mb(limit) if limit >= MB else f'{limit // 1024} KB'}")
    try:
        with zf.open(info) as f:
            data = f.read(limit + 1)
    except _DAMAGED as exc:
        raise _Skip(f"{info.filename} is damaged ({exc})") from exc
    if len(data) > limit:
        raise _Skip(f"{info.filename} is larger than it says")
    return data


def import_zip(raw, asset_store, font_store, name=None):
    """(a scene ready for SceneStore.add, what happened). Raises ImportRefused
    when the file is not a scene at all; files inside that fail their checks
    are left out and listed instead."""
    if not raw:
        raise ImportRefused("That file is empty.")
    if len(raw) > MAX_ZIP:
        raise ImportRefused(f"That file is larger than {_mb(MAX_ZIP)}.")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
        infos = zf.infolist()
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, ValueError, EOFError):
        raise ImportRefused("That is not a .zip file.") from None
    if len(infos) > MAX_MEMBERS:
        raise ImportRefused(f"That .zip holds more than {MAX_MEMBERS} files - not a scene from this app.")
    if sum(i.file_size for i in infos) > MAX_TOTAL:
        raise ImportRefused(f"That .zip unpacks to more than {_mb(MAX_TOTAL)}.")
    members, report = {}, {"assets": 0, "fonts": 0, "skipped": [], "missing": [],
                           "builtin_missing": [], "newer": False}
    for info in infos:
        n = info.filename
        if n.endswith("/"):
            continue
        if info.flag_bits & 0x1:
            raise ImportRefused("That .zip is password-protected.")
        if n in members or not _safe(n):
            report["skipped"].append(f"{n[:80]}: not a file name this app writes")
            continue
        members[n] = info
    if "scene.json" not in members:
        raise ImportRefused("There is no scene in that .zip (scene.json is missing) - "
                            "export one from the Canvas Builder's scene settings.")

    labels, font_labels = {}, {}
    try:
        if "manifest.json" in members:
            manifest = json.loads(_read(zf, members["manifest.json"], MAX_JSON).decode("utf-8-sig"))
            if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
                raise ImportRefused("That .zip is not a scene exported from Awesome Streaming Deck.")
            report["newer"] = int(scenes._num(manifest.get("version"), 0, 0)) > VERSION
            labels = {a.get("id"): str(a.get("name") or "") for a in manifest.get("assets") or []
                      if isinstance(a, dict)}
            font_labels = {f.get("id"): str(f.get("name") or "") for f in manifest.get("fonts") or []
                           if isinstance(f, dict)}
        data = json.loads(_read(zf, members["scene.json"], MAX_JSON).decode("utf-8-sig"))
    except _Skip as exc:
        raise ImportRefused(f"The scene in that .zip cannot be read: {exc}.") from None
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise ImportRefused("The scene in that .zip cannot be read (scene.json is damaged).") from None
    if not isinstance(data, dict) or not isinstance(data.get("layers", []), list):
        raise ImportRefused("The scene.json in that .zip does not hold a scene.")
    scene = scenes.migrate(data)
    ids, builtin = used_assets(scene)
    named = _named(scene)

    remap, stored = {}, set()
    for n, info in members.items():
        if n in ("scene.json", "manifest.json") or THUMB_FILE.match(n):
            continue
        try:
            m = ASSET_FILE.match(n)
            if m:
                aid = m.group(1)
                if aid not in ids:
                    raise _Skip(f"{n}: the scene does not use it")
                ext = os.path.splitext(aid)[1]
                body = _read(zf, info, asset_store.MAX_VIDEO_BYTES if ext in asset_store.VIDEO_EXT
                             else asset_store.MAX_BYTES)
                if not MAGIC[ext](body):
                    raise _Skip(f"{n} is not a {ext[1:].upper()} file")
                thumb = None
                tinfo = members.get(n + asset_store.THUMB)
                if tinfo:
                    try:
                        t = _read(zf, tinfo, MAX_THUMB)
                        thumb = t if (MAGIC[".jpg"](t) or MAGIC[".png"](t)) else None
                    except _Skip:
                        thumb = None
                stem = os.path.splitext(os.path.basename(labels.get(aid) or ""))[0][:80] or aid[:16]
                res = asset_store.save_bytes(stem + ext, body, thumb)
                if not res.get("ok"):
                    raise _Skip(f"{n}: {res.get('reason')}")
                report["assets"] += 1
                stored.add(aid)
                if res["id"] != aid:
                    remap[aid] = res["id"]
                continue
            m = FONT_FILE.match(n)
            if m:
                fid = m.group(1)
                ext = os.path.splitext(fid)[1]
                body = _read(zf, info, fonts.MAX_BYTES)
                if not MAGIC[ext](body):
                    raise _Skip(f"{n} is not a {ext[1:].upper()} font")
                label = os.path.basename(font_labels.get(fid) or "")
                if os.path.splitext(label)[1].lower() != ext:
                    label = fid
                if fonts.describe(body, label)[0].lower() not in named:
                    raise _Skip(f"{n}: the scene does not use it")
                res = font_store.save_bytes(label, body)
                if not res.get("ok"):
                    raise _Skip(f"{n}: {res.get('reason')}")
                report["fonts"] += 1
                continue
            raise _Skip(f"{n[:80]}: not part of a scene")
        except _Skip as exc:
            report["skipped"].append(str(exc))

    report["missing"] = sorted(a for a in ids if a not in stored and not asset_store.path(a))
    report["builtin_missing"] = sorted(b for b in builtin if not asset_store.path("builtin:" + b))
    if remap:
        scene = scenes.validate(_repoint(scene, remap))
    scene["id"] = ""
    if name and str(name).strip():
        scene["name"] = str(name).strip()[:80]
    return scene, report
