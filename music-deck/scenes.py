"""
Scenes: the layouts the Canvas Builder edits and the output windows show.

A scene is a versioned JSON document - a format, a background, how empty
areas are treated on stream, and an ordered list of layers, each with a
transform, a style and its own properties. The store keeps one file per
scene, writes atomically, keeps the last five versions, validates on load
(unknown fields kept, bad values clamped) and migrates old files forward.
Every save bumps a revision so editors and outputs can tell stale from
current.
"""

import json
import math
import os
import secrets
import shutil
import threading
import time

VERSION = 1
BACKUPS = 5
FORMATS = {"horizontal": (1920, 1080), "phone": (1080, 1920)}
TRANSPARENCY = ("opaque", "see-through", "key")
BLENDS = ("normal", "multiply", "screen", "overlay", "darken", "lighten",
          "color-dodge", "color-burn", "hard-light", "soft-light", "difference",
          "exclusion", "hue", "saturation", "color", "luminosity")
ANCHORS = ("tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br")
MAX_SIZE = 7680


class Conflict(Exception):
    """The scene changed since the caller last read it."""


def _num(value, default=0.0, lo=None, hi=None):
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = float(default)
    if not math.isfinite(v):
        v = float(default)
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def _color(value, default="#000000"):
    v = str(value or default).strip()
    return v if v and len(v) <= 64 else default


def new_id():
    return secrets.token_hex(4)


def new_layer(ltype, name=None, **props):
    # `ltype`, not `kind`: a shape's own props carry a `kind` of their own.
    return {
        "id": new_id(), "type": str(ltype), "name": name or str(ltype).capitalize(),
        "visible": True, "locked": False, "group": "",
        "transform": {"x": 0, "y": 0, "w": 400, "h": 300, "rotation": 0, "anchor": "tl"},
        "style": {"opacity": 1, "blend": "normal", "radius": 0,
                  "border": {"w": 0, "color": "#ffffff"},
                  "shadow": {"x": 0, "y": 0, "blur": 0, "color": "#000000"},
                  "blur": 0, "crop": {"t": 0, "r": 0, "b": 0, "l": 0}},
        "props": dict(props), "triggers": [],
    }


def new_scene(name, fmt="horizontal", width=None, height=None):
    if fmt not in FORMATS:
        fmt = "custom"
    w, h = FORMATS.get(fmt, (int(width or 1920), int(height or 1080)))
    now = round(time.time())
    return validate({
        "version": VERSION, "id": new_id(), "name": str(name or "New scene").strip()[:80] or "New scene",
        "format": fmt, "width": w, "height": h,
        "background": {"mode": "solid", "color": "#0f0f17", "color2": "#241a3d", "angle": 135,
                       "image": "", "fit": "cover"},
        "transparency": "opaque", "key_color": "#00ff00",
        "layers": [], "guides": {"h": [], "v": []},
        "rev": 0, "created": now, "updated": now,
    })


def _layer(raw, seen):
    """One layer, cleaned. Unknown keys inside survive untouched."""
    layer = dict(raw) if isinstance(raw, dict) else {}
    lid = str(layer.get("id") or "").strip()
    if not lid or lid in seen:
        lid = new_id()
    seen.add(lid)
    layer["id"] = lid
    layer["type"] = str(layer.get("type") or "image")[:40]
    layer["name"] = str(layer.get("name") or layer["type"].capitalize())[:80]
    layer["visible"] = bool(layer.get("visible", True))
    layer["locked"] = bool(layer.get("locked", False))
    layer["group"] = str(layer.get("group") or "")[:40]
    t = dict(layer.get("transform") or {})
    t["x"] = _num(t.get("x"), 0, -MAX_SIZE * 2, MAX_SIZE * 2)
    t["y"] = _num(t.get("y"), 0, -MAX_SIZE * 2, MAX_SIZE * 2)
    t["w"] = _num(t.get("w"), 400, 1, MAX_SIZE)
    t["h"] = _num(t.get("h"), 300, 1, MAX_SIZE)
    t["rotation"] = math.fmod(_num(t.get("rotation"), 0), 360.0)
    t["anchor"] = t.get("anchor") if t.get("anchor") in ANCHORS else "tl"
    layer["transform"] = t
    s = dict(layer.get("style") or {})
    s["opacity"] = _num(s.get("opacity"), 1, 0, 1)
    s["blend"] = s.get("blend") if s.get("blend") in BLENDS else "normal"
    s["radius"] = _num(s.get("radius"), 0, 0, MAX_SIZE)
    border = dict(s.get("border") or {})
    s["border"] = {"w": _num(border.get("w"), 0, 0, 200), "color": _color(border.get("color"), "#ffffff")}
    shadow = dict(s.get("shadow") or {})
    s["shadow"] = {"x": _num(shadow.get("x"), 0, -500, 500), "y": _num(shadow.get("y"), 0, -500, 500),
                   "blur": _num(shadow.get("blur"), 0, 0, 500), "color": _color(shadow.get("color"))}
    s["blur"] = _num(s.get("blur"), 0, 0, 200)
    crop = dict(s.get("crop") or {})
    s["crop"] = {k: _num(crop.get(k), 0, 0, 0.99) for k in ("t", "r", "b", "l")}
    layer["style"] = s
    layer["props"] = dict(layer.get("props") or {})
    layer["triggers"] = [dict(tr) for tr in (layer.get("triggers") or []) if isinstance(tr, dict) and tr.get("on")]
    return layer


def validate(raw):
    """A scene with every field present and every value in range. Fields we
    do not know are kept, so a newer editor's data survives an older server."""
    scene = dict(raw) if isinstance(raw, dict) else {}
    scene["version"] = VERSION
    scene["id"] = str(scene.get("id") or new_id()).strip()[:40]
    scene["name"] = str(scene.get("name") or "Scene").strip()[:80] or "Scene"
    fmt = scene.get("format")
    if fmt in FORMATS:
        scene["width"], scene["height"] = FORMATS[fmt]
    else:
        scene["format"] = "custom"
        scene["width"] = int(_num(scene.get("width"), 1920, 16, MAX_SIZE))
        scene["height"] = int(_num(scene.get("height"), 1080, 16, MAX_SIZE))
    bg = dict(scene.get("background") or {})
    bg["mode"] = bg.get("mode") if bg.get("mode") in ("solid", "gradient", "image", "scene", "none") else "solid"
    bg["color"] = _color(bg.get("color"), "#0f0f17")
    bg["color2"] = _color(bg.get("color2"), "#241a3d")
    bg["angle"] = _num(bg.get("angle"), 135, 0, 360)
    bg["image"] = str(bg.get("image") or "")[:120]
    bg["fit"] = bg.get("fit") if bg.get("fit") in ("cover", "contain", "stretch", "tile") else "cover"
    scene["background"] = bg
    scene["transparency"] = scene.get("transparency") if scene.get("transparency") in TRANSPARENCY else "opaque"
    scene["key_color"] = _color(scene.get("key_color"), "#00ff00")
    seen = set()
    scene["layers"] = [_layer(l, seen) for l in (scene.get("layers") or []) if isinstance(l, dict)]
    guides = dict(scene.get("guides") or {})
    scene["guides"] = {axis: [_num(g, 0, -MAX_SIZE, MAX_SIZE) for g in (guides.get(axis) or [])][:200]
                       for axis in ("h", "v")}
    scene["rev"] = int(_num(scene.get("rev"), 0, 0))
    now = round(time.time())
    scene["created"] = int(_num(scene.get("created"), now, 0))
    scene["updated"] = int(_num(scene.get("updated"), now, 0))
    return scene


def migrate(raw):
    """Bring an older file up to the current shape, then validate it."""
    scene = dict(raw) if isinstance(raw, dict) else {}
    version = int(_num(scene.get("version"), 0, 0))
    if version < 1:
        # Pre-release drafts kept size as [w, h] and layers as "items".
        if isinstance(scene.get("size"), (list, tuple)) and len(scene["size"]) == 2:
            scene.setdefault("width", scene["size"][0])
            scene.setdefault("height", scene["size"][1])
        if "items" in scene and "layers" not in scene:
            scene["layers"] = scene.pop("items")
    return validate(scene)


# Where TikTok's own LIVE interface sits over a portrait stream on a viewer's
# phone (top bar, side buttons, the comment column, the input bar). Measured
# by eye from the app; approximate, and only guidance for placing things.
SAFE_ZONES = {
    "phone": [
        {"name": "Top bar", "x": 0, "y": 0, "w": 1080, "h": 230},
        {"name": "Side buttons", "x": 880, "y": 980, "w": 200, "h": 760},
        {"name": "Comments", "x": 0, "y": 1330, "w": 780, "h": 420},
        {"name": "Bottom bar", "x": 0, "y": 1750, "w": 1080, "h": 170},
    ],
    "horizontal": [],
}


def _placed(ltype, name, x, y, w, h, **props):
    layer = new_layer(ltype, name, **props)
    layer["transform"].update({"x": x, "y": y, "w": w, "h": h})
    return layer


def _component(name, cid, x, y, w, h, **options):
    return _placed("component", name, x, y, w, h, component=cid, design="linked", options=options)


def _text(name, x, y, w, h, text, size=48, **more):
    props = dict(text=text, size=size, weight=700, color="#ffffff", align="left", valign="center",
                 shadow={"x": 0, "y": 2, "blur": 12, "color": "rgba(0,0,0,.6)"})
    props.update(more)
    return _placed("text", name, x, y, w, h, **props)


def _camera(name, x, y, w, h, mask="rounded"):
    return _placed("camera", name, x, y, w, h, width=1280, height=720, fps=30, mirror=True, mask=mask)


def _capture(name, x, y, w, h):
    return _placed("capture", name, x, y, w, h, mode="native",
                   source={"kind": "window", "title": ""}, fps=30, fit="contain")


def template_just_chatting():
    s = new_scene("Just chatting", "horizontal")
    s["background"] = {"mode": "gradient", "color": "#141026", "color2": "#2b1b4d", "angle": 160}
    s["layers"] = [
        _placed("shape", "Camera frame", 1140, 120, 720, 840, kind="frame", pad=18, hole_radius=28,
                fill="rgba(255,255,255,.12)", stroke={"w": 3, "color": "#c9a7ff"}),
        _camera("Camera", 1158, 138, 684, 804, mask="rounded"),
        _text("Title", 60, 60, 1000, 110, "Just chatting", size=80, letter=0.02),
        _text("Now", 60, 180, 1000, 60, "{title} - {artist}", size=34, weight=500, color="#d9cffc"),
        _component("Now Playing", "np", 60, 820, 760, 190),
        _component("Captions", "captions", 60, 640, 1000, 160, card_bg=False, frame=False),
    ]
    return validate(s)


def template_music_lyrics():
    s = new_scene("Music + lyrics", "horizontal")
    s["background"] = {"mode": "scene", "color": "#1a0f1f", "color2": "#241a3d", "angle": 135, "image": "",
                       "fit": "cover", "scene": {"id": "sakura", "c1": "", "c2": "", "c3": "",
                                                 "scale": 1.0, "density": 1.0, "tile_scale": 1.0, "seed": 3}}
    s["layers"] = [
        _component("Now Playing", "np", 60, 60, 760, 190),
        _component("Queue", "queue", 60, 300, 760, 560),
        _component("Lyrics", "lyrics", 900, 60, 960, 640),
        _text("Song", 900, 760, 960, 120, "{title}", size=64, fit=True, align="center"),
        _text("Artist", 900, 880, 960, 80, "{artist}", size=40, weight=500, align="center", color="#e9ddff"),
    ]
    return validate(s)


def template_gaming_portrait():
    s = new_scene("Gaming portrait", "phone")
    s["background"] = {"mode": "gradient", "color": "#0b0b10", "color2": "#1c1230", "angle": 180}
    s["layers"] = [
        _capture("Game", 0, 230, 1080, 1080),
        _placed("shape", "Camera frame", 40, 1330, 380, 380, kind="frame", pad=10, hole_radius=190,
                fill="rgba(255,255,255,.14)", stroke={"w": 3, "color": "#ffffff"}),
        _camera("Camera", 50, 1340, 360, 360, mask="circle"),
        _component("Captions", "captions", 440, 1330, 600, 150, card_bg=False, frame=False),
        _component("Now Playing", "np", 60, 1500, 760, 190, hide=["progress", "transport"]),
        _text("Handle", 60, 120, 900, 90, "{title}", size=44, weight=600, color="#ffffff", fit=True),
    ]
    return validate(s)


def template_gaming_landscape():
    s = new_scene("Gaming landscape", "horizontal")
    s["background"] = {"mode": "solid", "color": "#000000"}
    s["layers"] = [
        _capture("Game", 0, 0, 1920, 1080),
        _placed("shape", "Camera frame", 1590, 30, 300, 300, kind="frame", pad=8, hole_radius=150,
                fill="rgba(0,0,0,.35)", stroke={"w": 3, "color": "#ffffff"}),
        _camera("Camera", 1598, 38, 284, 284, mask="circle"),
        _component("Now Playing", "np", 60, 830, 760, 190),
        _component("Captions", "captions", 860, 930, 1000, 120, card_bg=False, frame=False),
    ]
    return validate(s)


TEMPLATES = {
    "just_chatting": ("Just chatting", "horizontal", template_just_chatting),
    "music_lyrics": ("Music + lyrics", "horizontal", template_music_lyrics),
    "gaming_portrait": ("Gaming portrait", "phone", template_gaming_portrait),
    "gaming_landscape": ("Gaming landscape", "horizontal", template_gaming_landscape),
}


def template_list():
    return [{"id": k, "name": v[0], "format": v[1]} for k, v in TEMPLATES.items()]


def from_template(key):
    return TEMPLATES[key][2]()


def native_sources(scene):
    """The scene's layers the server fills in itself while LIVE: capture
    layers in native mode (a window or a screen) and camera layers in
    native mode, each with the rectangle the page left black for it, in
    layer order (the compositor keys them in bottom-up)."""
    out = []
    for layer in (scene or {}).get("layers") or []:
        if layer.get("visible") is False:
            continue
        p = layer.get("props") or {}
        t = layer.get("transform") or {}
        rect = [int(round(float(t.get(k, 0) or 0))) for k in ("x", "y", "w", "h")]
        if rect[2] <= 0 or rect[3] <= 0:
            continue
        if layer.get("type") == "capture" and p.get("mode") == "native":
            src = p.get("source") or {}
            # The mouse pointer is left out unless the layer asks for it.
            if src.get("kind") == "monitor":
                out.append({"kind": "monitor", "monitor": int(src.get("monitor") or 0), "rect": rect,
                            "fit": "cover" if p.get("fit") == "cover" else "contain", "cursor": bool(p.get("cursor"))})
            elif src.get("title"):
                out.append({"kind": "window", "title": str(src["title"]), "rect": rect,
                            "fit": "cover" if p.get("fit") == "cover" else "contain", "cursor": bool(p.get("cursor"))})
        elif layer.get("type") == "camera" and p.get("mode") == "native":
            out.append({"kind": "camera", "device": str(p.get("device") or ""), "width": int(p.get("width") or 1280),
                        "height": int(p.get("height") or 720), "fps": int(p.get("fps") or 30), "rect": rect,
                        "fit": "contain" if p.get("fit") == "contain" else "cover",
                        "mirror": p.get("mirror") is not False})
    return out


def summary(scene):
    return {"id": scene["id"], "name": scene["name"], "format": scene["format"],
            "width": scene["width"], "height": scene["height"], "rev": scene["rev"],
            "layers": len(scene["layers"]), "updated": scene["updated"]}


class SceneStore:
    backup_every = 60.0      # seconds; 0 keeps one backup per save

    def __init__(self, folder, on_change=None, log=None):
        self.folder = folder
        self.on_change = on_change
        self.log = log or (lambda *_: None)
        self._scenes = {}
        self._lock = threading.Lock()
        os.makedirs(folder, exist_ok=True)
        self._load_all()

    # ------------------------------------------------ files

    def _path(self, sid, n=0):
        base = os.path.join(self.folder, f"{sid}.json")
        return f"{base}.{n}" if n else base

    def _read(self, path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _load_all(self):
        for name in sorted(os.listdir(self.folder)):
            if not name.endswith(".json"):
                continue
            sid = name[:-5]
            scene = None
            for n in range(0, BACKUPS + 1):
                path = self._path(sid, n)
                if not os.path.isfile(path):
                    continue
                try:
                    scene = migrate(self._read(path))
                    if n:
                        self.log(f"scenes: {sid} restored from backup {n}")
                    break
                except Exception as exc:
                    self.log(f"scenes: {os.path.basename(path)} unreadable ({exc})")
            if scene:
                scene["id"] = sid
                self._scenes[sid] = scene

    def _write(self, scene):
        """Atomic: the new file lands whole or not at all, and the previous
        versions shuffle down one slot."""
        path = self._path(scene["id"])
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(scene, f, indent=1)
        if os.path.isfile(path):
            # The editor saves many times a minute; the backups are for going
            # back minutes, not the last five keystrokes. So they only shuffle
            # down when the newest is at least backup_every seconds old.
            newest = self._path(scene["id"], 1)
            if (not os.path.isfile(newest)
                    or time.time() - os.path.getmtime(newest) >= self.backup_every):
                for n in range(BACKUPS, 1, -1):
                    older = self._path(scene["id"], n - 1)
                    if os.path.isfile(older):
                        os.replace(older, self._path(scene["id"], n))
                shutil.copyfile(path, newest)
        os.replace(tmp, path)

    def _changed(self):
        if self.on_change:
            try:
                self.on_change()
            except Exception:
                pass

    # ------------------------------------------------ api

    def list(self):
        with self._lock:
            out = [summary(s) for s in self._scenes.values()]
        out.sort(key=lambda s: s["updated"], reverse=True)
        return out

    def get(self, sid):
        with self._lock:
            s = self._scenes.get(sid)
            return json.loads(json.dumps(s)) if s else None

    def revisions(self):
        with self._lock:
            return {sid: s["rev"] for sid, s in self._scenes.items()}

    def create(self, name, fmt="horizontal", width=None, height=None):
        return self.add(new_scene(name, fmt, width, height))

    def add(self, scene):
        """Store a prepared scene (a template's, an import) as a new one."""
        scene = validate(scene)
        with self._lock:
            while not scene["id"] or scene["id"] in self._scenes:
                scene["id"] = new_id()
            scene["rev"] = 1
            scene["created"] = scene["updated"] = round(time.time())
            self._write(scene)
            self._scenes[scene["id"]] = scene
        self._changed()
        return self.get(scene["id"])

    def save(self, scene, expect_rev=None):
        scene = validate(scene)
        with self._lock:
            current = self._scenes.get(scene["id"])
            if current is None:
                raise KeyError(scene["id"])
            if expect_rev is not None and int(expect_rev) != current["rev"]:
                raise Conflict(f"scene {scene['id']} is at revision {current['rev']}, not {expect_rev}")
            scene["rev"] = current["rev"] + 1
            scene["created"] = current["created"]
            scene["updated"] = round(time.time())
            self._write(scene)
            self._scenes[scene["id"]] = scene
        self._changed()
        return self.get(scene["id"])

    def delete(self, sid):
        with self._lock:
            if sid not in self._scenes:
                return False
            del self._scenes[sid]
            for n in range(0, BACKUPS + 1):
                try:
                    os.remove(self._path(sid, n))
                except OSError:
                    pass
        self._changed()
        return True

    def duplicate(self, sid, name=None):
        source = self.get(sid)
        if not source:
            return None
        copy = validate(source)
        with self._lock:
            copy["id"] = new_id()
            while copy["id"] in self._scenes:
                copy["id"] = new_id()
            copy["name"] = (name or f"{source['name']} copy")[:80]
            copy["rev"] = 1
            copy["created"] = copy["updated"] = round(time.time())
            self._write(copy)
            self._scenes[copy["id"]] = copy
        self._changed()
        return self.get(copy["id"])

    def backups(self, sid):
        out = []
        for n in range(1, BACKUPS + 1):
            path = self._path(sid, n)
            if os.path.isfile(path):
                out.append({"n": n, "saved": int(os.path.getmtime(path)), "bytes": os.path.getsize(path)})
        return out

    def restore(self, sid, n):
        path = self._path(sid, int(n))
        if not os.path.isfile(path):
            return None
        scene = migrate(self._read(path))
        scene["id"] = sid
        return self.save(scene)
