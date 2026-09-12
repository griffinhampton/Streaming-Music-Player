"""
The asset library: pictures, GIFs and short videos people drop onto the
overlay and into scenes.

Files are copied into the cache so a look keeps working after the original
moves, and so the whole look travels with the config folder. A file is
named by its own hash, so the same picture uploaded twice is stored once.
A thumbnail made by the browser can ride along with an upload; scenes that
use an asset are counted before it can be deleted.
"""

import base64
import hashlib
import json
import os
import time
import urllib.parse


class AssetStore:
    OK_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
              ".webm": "video/webm", ".mp4": "video/mp4"}
    VIDEO_EXT = (".webm", ".mp4")
    MAX_BYTES = 12 * 1024 * 1024
    MAX_VIDEO_BYTES = 80 * 1024 * 1024
    THUMB = ".thumb.jpg"

    def __init__(self, folder, builtin=None):
        self.folder = folder
        self.builtin = builtin           # shipped artwork, read-only
        os.makedirs(folder, exist_ok=True)
        self.index_path = os.path.join(folder, "index.json")
        self._index = self._load_index()
        self._builtin_animated = {}      # shipped files never change

    def _load_index(self):
        try:
            with open(self.index_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _save_index(self):
        try:
            with open(self.index_path, "w", encoding="utf-8") as f:
                json.dump(self._index, f, indent=1)
        except Exception:
            pass

    @classmethod
    def kind_of(cls, name, animated=False):
        ext = os.path.splitext(name)[1].lower()
        if ext in cls.VIDEO_EXT:
            return "video"
        return "gif" if animated else "image"

    @staticmethod
    def _is_animated(raw, ext):
        """Does this file hold more than one frame?

        Worth knowing because a tinted sticker is drawn through a CSS mask, and
        a mask only ever uses the first frame - so tinting silently freezes an
        animation. Better to say so than to let someone wonder why their GIF
        stopped moving.
        """
        try:
            if ext == ".gif":
                # Each frame is introduced by a Graphics Control Extension.
                # Two is all we need to know about, so stop at the second
                # rather than counting every frame of a long animation.
                gce = bytes([0x21, 0xF9, 0x04])
                first = raw.find(gce)
                return first >= 0 and raw.find(gce, first + 3) >= 0
            if ext == ".webp":
                return b"ANMF" in raw[:4096] or b"ANIM" in raw[:4096]
            if ext == ".png":
                return b"acTL" in raw[:4096]          # APNG animation control
        except Exception:
            pass
        return False

    def _sniff_file(self, full):
        """Read just enough of a file on disk to answer _is_animated."""
        ext = os.path.splitext(full)[1].lower()
        if ext not in (".gif", ".webp", ".png"):
            return False
        try:
            with open(full, "rb") as f:
                # A GIF has to be read through to count its frames; the other
                # two declare themselves in an early chunk.
                raw = f.read() if ext == ".gif" else f.read(4096)
        except OSError:
            return False
        return self._is_animated(raw, ext)

    @staticmethod
    def _decode(data_url):
        if "," not in (data_url or ""):
            return None
        return base64.b64decode(data_url.split(",", 1)[1], validate=False)

    def save(self, name, data_url, thumb=None):
        """Accept a browser FileReader data: URL and write it to the cache.
        `thumb` is an optional small JPEG/PNG data: URL the browser made."""
        try:
            ext = os.path.splitext(name)[1].lower()
            if ext not in self.OK_EXT:
                return {"ok": False, "reason": f"{ext or 'that file type'} is not a picture or video"}
            raw = self._decode(data_url)
            if raw is None:
                return {"ok": False, "reason": "bad upload"}
            res = self.save_bytes(name, raw, self._decode(thumb) if thumb else None)
        except Exception as exc:
            return {"ok": False, "reason": str(exc)}
        if res.get("ok"):
            res["assets"] = self.list()
        return res

    def save_bytes(self, name, raw, thumb=None):
        """Store a file's bytes - an upload, or a picture from an imported
        scene. `thumb` is an optional small JPEG/PNG, as bytes."""
        try:
            ext = os.path.splitext(name)[1].lower()
            if ext not in self.OK_EXT:
                return {"ok": False, "reason": f"{ext or 'that file type'} is not a picture or video"}
            limit = self.MAX_VIDEO_BYTES if ext in self.VIDEO_EXT else self.MAX_BYTES
            if len(raw) > limit:
                return {"ok": False, "reason": f"file is larger than {limit // (1024 * 1024)} MB"}
            if not raw:
                return {"ok": False, "reason": "empty file"}

            asset_id = hashlib.sha1(raw).hexdigest()[:16] + ext
            full = os.path.join(self.folder, asset_id)
            duplicate = os.path.isfile(full)
            if not duplicate:
                with open(full, "wb") as f:
                    f.write(raw)
            animated = self._is_animated(raw, ext)
            meta = self._index.get(asset_id) or {"added": round(time.time())}
            meta.update({"name": os.path.basename(name), "bytes": len(raw), "animated": animated})
            self._index[asset_id] = meta
            if thumb and len(thumb) <= 512 * 1024:
                with open(full + self.THUMB, "wb") as f:
                    f.write(thumb)
            self._save_index()
            return {"ok": True, "id": asset_id, "name": os.path.basename(name),
                    "url": f"/asset/{asset_id}", "duplicate": duplicate,
                    "kind": self.kind_of(asset_id, animated)}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)}

    def path(self, asset_id):
        asset_id = urllib.parse.unquote(asset_id or "")
        # Shipped artwork is addressed as "builtin:<file>" and never written to.
        if asset_id.startswith("builtin:"):
            if not self.builtin:
                return None
            name = os.path.basename(asset_id.split(":", 1)[1])
            full = os.path.join(self.builtin, name)
            ok = os.path.splitext(name)[1].lower() in self.OK_EXT
            return full if ok and os.path.isfile(full) else None
        name = os.path.basename(asset_id)
        if not name or name == "index.json":
            return None
        if os.path.splitext(name)[1].lower() not in self.OK_EXT:
            return None
        full = os.path.join(self.folder, name)
        return full if os.path.isfile(full) else None

    def list(self, kind=None):
        """Newest first, with whatever the file was called when it arrived."""
        out = []
        dirty = False
        try:
            for name in os.listdir(self.folder):
                if self.THUMB in name or os.path.splitext(name)[1].lower() not in self.OK_EXT:
                    continue
                full = os.path.join(self.folder, name)
                meta = self._index.get(name, {})
                if "animated" not in meta:
                    # Added before we started checking, or dropped into the
                    # folder by hand. Look now and remember the answer.
                    meta["animated"] = self._sniff_file(full)
                    self._index[name] = meta
                    dirty = True
                item = {"id": name, "url": f"/asset/{name}",
                        "name": meta.get("name", name),
                        "added": meta.get("added", int(os.path.getmtime(full))),
                        "animated": bool(meta.get("animated")),
                        "kind": self.kind_of(name, bool(meta.get("animated"))),
                        "size": os.path.getsize(full)}
                if os.path.isfile(full + self.THUMB):
                    item["thumb"] = f"/asset/{name}{self.THUMB}"
                out.append(item)
        except Exception:
            pass
        if dirty:
            self._save_index()          # or every restart re-reads every GIF
        out.sort(key=lambda a: a["added"], reverse=True)

        shipped = []
        try:
            for name in sorted(os.listdir(self.builtin or "")):
                if os.path.splitext(name)[1].lower() not in self.OK_EXT:
                    continue
                if name not in self._builtin_animated:
                    # Shipped files never change, so one look each per run.
                    self._builtin_animated[name] = self._sniff_file(
                        os.path.join(self.builtin, name))
                shipped.append({
                    "id": "builtin:" + name,
                    "url": "/asset/builtin:" + urllib.parse.quote(name),
                    "name": os.path.splitext(name)[0],
                    "animated": self._builtin_animated[name],
                    "kind": self.kind_of(name, self._builtin_animated[name]),
                    "builtin": True, "added": 0,
                    "size": os.path.getsize(os.path.join(self.builtin, name)),
                })
        except Exception:
            pass
        items = out + shipped
        if kind:
            items = [a for a in items if a["kind"] == kind]
        return items

    # ------------------------------------------------ who uses what

    @staticmethod
    def _mentions(value, asset_id):
        if isinstance(value, str):
            return value == asset_id or value.endswith("/" + asset_id)
        if isinstance(value, dict):
            return any(AssetStore._mentions(v, asset_id) for v in value.values())
        if isinstance(value, list):
            return any(AssetStore._mentions(v, asset_id) for v in value)
        return False

    def used_by(self, asset_id, scenes=(), config=None):
        """Names of the scenes (and config sections) that refer to an asset."""
        users = []
        for scene in scenes:
            if self._mentions(scene.get("background"), asset_id) or \
                    any(self._mentions(l.get("props"), asset_id) for l in scene.get("layers", [])):
                users.append(f"scene: {scene.get('name', scene.get('id'))}")
        # Said the way the deck names them, since people read this.
        for section, label in (("nowplaying", "the Now Playing window"), ("lyrics", "the Lyrics window"),
                               ("queue", "the Queue window"), ("captions", "the Captions window"),
                               ("ui", "the deck's own look")):
            if config and self._mentions(config.get(section), asset_id):
                users.append(label)
        return users

    def delete(self, asset_id):
        if (asset_id or "").startswith("builtin:"):
            return False             # shipped artwork is read-only
        full = self.path(asset_id)
        if not full:
            return False
        try:
            os.remove(full)
            try:
                os.remove(full + self.THUMB)
            except OSError:
                pass
            self._index.pop(os.path.basename(asset_id), None)
            self._save_index()
            return True
        except Exception:
            return False

    def remove(self, asset_id, scenes=(), config=None, force=False):
        """Delete unless something still uses it (or the caller insists)."""
        users = self.used_by(asset_id, scenes, config)
        if users and not force:
            return {"ok": False, "reason": "still used by " + ", ".join(users), "used_by": users}
        return {"ok": self.delete(asset_id), "used_by": users}
