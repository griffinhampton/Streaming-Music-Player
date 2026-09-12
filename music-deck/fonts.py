"""
Fonts people add themselves, usable anywhere a font can be picked.

A dropped .ttf / .otf / .woff / .woff2 is stored in cache/fonts and handed to
every page through one generated stylesheet, /fonts.css: an @font-face rule
per file, under the family name written inside the file. Two files of one
family - a Regular and a Bold, say - become one family with both weights, the
way installed fonts behave, and a variable font gets its whole weight range.
"""

import base64
import hashlib
import json
import os
import re
import struct
import threading
import time
import zlib

# extension -> (MIME type, CSS format() hint)
EXT = {".ttf": ("font/ttf", "truetype"), ".otf": ("font/otf", "opentype"),
       ".woff": ("font/woff", "woff"), ".woff2": ("font/woff2", "woff2")}
MAX_BYTES = 20 * 1024 * 1024
ID = re.compile(r"^[0-9a-f]{16}\.(?:ttf|otf|woff|woff2)$")
WANTED = (b"name", b"OS/2", b"fvar")


def _tables(raw):
    """{tag: bytes} for the few tables read here, from TTF/OTF/TTC or WOFF."""
    out = {}
    sig = raw[:4]
    if sig == b"wOFF":
        count = struct.unpack(">H", raw[12:14])[0]
        for i in range(count):
            tag, off, clen, olen, _ = struct.unpack(">4sIIII", raw[44 + 20 * i:64 + 20 * i])
            if tag in WANTED:
                data = raw[off:off + clen]
                out[tag] = zlib.decompress(data) if clen < olen else data
        return out
    if sig == b"wOF2":
        return out               # Brotli inside; the file name will have to do
    base = struct.unpack(">I", raw[12:16])[0] if sig == b"ttcf" else 0
    count = struct.unpack(">H", raw[base + 4:base + 6])[0]
    for i in range(count):
        tag, _, off, length = struct.unpack(">4sIII", raw[base + 12 + 16 * i:base + 28 + 16 * i])
        if tag in WANTED:
            out[tag] = raw[off:off + length]
    return out


def _family(table):
    """The family name, preferring the typographic one (ID 16), in English."""
    _, count, str_off = struct.unpack(">HHH", table[:6])
    best, best_score = None, -1
    for i in range(count):
        pid, _eid, lid, nid, length, off = struct.unpack(">HHHHHH", table[6 + 12 * i:18 + 12 * i])
        if nid not in (1, 16):
            continue
        raw = table[str_off + off:str_off + off + length]
        if pid in (0, 3):
            text = raw.decode("utf-16-be", "ignore").strip()
        elif pid == 1:
            text = raw.decode("mac_roman", "ignore").strip()
        else:
            continue
        score = (4 if nid == 16 else 0) + (2 if pid == 3 and lid == 0x409 else 0) + (pid == 3)
        if text and score > best_score:
            best, best_score = text, score
    return best


def clean_family(name):
    """Safe inside a quoted CSS string and an HTML attribute."""
    name = re.sub(r'["\\<>{};\r\n\t]', "", name or "")
    return " ".join(name.split())[:60] or "Custom font"


def describe(raw, filename):
    """(family, weight, italic, variable). A file that will not parse is
    named after itself, with its style guessed from that name."""
    family, weight, italic, variable = None, 400, False, False
    try:
        tables = _tables(raw)
        if b"name" in tables:
            family = _family(tables[b"name"])
        os2 = tables.get(b"OS/2", b"")
        if len(os2) >= 6:
            w = struct.unpack(">H", os2[4:6])[0]
            weight = w if 1 <= w <= 1000 else 400
        if len(os2) >= 64:
            italic = bool(struct.unpack(">H", os2[62:64])[0] & 1)
        variable = b"fvar" in tables
    except Exception:
        pass
    if not family:
        stem = re.sub(r"[-_]+", " ", os.path.splitext(os.path.basename(filename))[0])
        low = stem.lower()
        weight = 700 if "bold" in low else weight
        italic = italic or "italic" in low
        family = re.sub(r"\s+(regular|bold|italic|light|medium|semibold|black|thin)\b.*$",
                        "", stem, flags=re.I)
    return clean_family(family), weight, italic, variable


class FontStore:
    def __init__(self, folder):
        self.folder = folder
        os.makedirs(folder, exist_ok=True)
        self._lock = threading.Lock()
        self._index_path = os.path.join(folder, "index.json")
        try:
            with open(self._index_path, encoding="utf-8") as f:
                index = json.load(f)
        except (OSError, ValueError):
            index = {}
        # Forget entries whose file has gone.
        self._index = {k: v for k, v in index.items()
                       if ID.match(k) and os.path.isfile(os.path.join(folder, k))}
        self.version = 1

    def _save(self):
        try:
            with open(self._index_path, "w", encoding="utf-8") as f:
                json.dump(self._index, f, indent=1)
        except OSError:
            pass

    def save(self, name, data_url):
        ext = os.path.splitext(name or "")[1].lower()
        if ext not in EXT:
            return {"ok": False, "reason": "fonts have to be .ttf, .otf, .woff or .woff2 files"}
        if "," not in (data_url or ""):
            return {"ok": False, "reason": "bad upload"}
        try:
            raw = base64.b64decode(data_url.split(",", 1)[1], validate=False)
        except ValueError:
            return {"ok": False, "reason": "bad upload"}
        return self.save_bytes(name, raw)

    def save_bytes(self, name, raw):
        """Store a font file's bytes - an upload, or a font from an imported scene."""
        ext = os.path.splitext(name or "")[1].lower()
        if ext not in EXT:
            return {"ok": False, "reason": "fonts have to be .ttf, .otf, .woff or .woff2 files"}
        if not raw:
            return {"ok": False, "reason": "empty file"}
        if len(raw) > MAX_BYTES:
            return {"ok": False, "reason": "that font is larger than 20 MB"}
        family, weight, italic, variable = describe(raw, name)
        fid = hashlib.sha1(raw).hexdigest()[:16] + ext
        with open(os.path.join(self.folder, fid), "wb") as f:
            f.write(raw)
        with self._lock:
            self._index[fid] = {"family": family, "weight": weight, "italic": italic,
                                "variable": variable, "name": os.path.basename(name),
                                "bytes": len(raw), "added": round(time.time())}
            self._save()
            self.version += 1
        return {"ok": True, "id": fid, "family": family}

    def delete(self, fid):
        if not ID.match(fid or ""):
            return False
        with self._lock:
            known = self._index.pop(fid, None)
            self._save()
            self.version += 1
        try:
            os.remove(os.path.join(self.folder, fid))
        except OSError:
            pass
        return known is not None

    def path(self, fid):
        fid = os.path.basename(fid or "")
        if not ID.match(fid):
            return None
        full = os.path.join(self.folder, fid)
        return full if os.path.isfile(full) else None

    @staticmethod
    def mime(full):
        return EXT.get(os.path.splitext(full)[1].lower(), ("application/octet-stream",))[0]

    def list(self):
        with self._lock:
            items = [dict(v, id=k) for k, v in self._index.items()]
        return sorted(items, key=lambda f: (f["family"].lower(), f["weight"], f["italic"]))

    def families(self):
        with self._lock:
            return sorted({v["family"] for v in self._index.values()}, key=str.lower)

    def css(self):
        rules = []
        for f in self.list():
            fmt = EXT[os.path.splitext(f["id"])[1]][1]
            weight = "1 1000" if f.get("variable") else str(f["weight"])
            style = "italic" if f["italic"] else "normal"
            rules.append(f'@font-face {{ font-family: "{f["family"]}"; '
                         f'src: url("/font/{f["id"]}") format("{fmt}"); '
                         f'font-weight: {weight}; font-style: {style}; font-display: swap; }}')
        return "\n".join(rules) + "\n"
