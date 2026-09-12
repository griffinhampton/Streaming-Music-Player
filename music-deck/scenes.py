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

import copy
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
    # Everything between TikTok's top bar (230) and its comments (1330), left of
    # its side buttons (880): the P3 version put the camera, the captions and
    # Now Playing right under the comments.
    s = new_scene("Gaming portrait", "phone")
    s["background"] = {"mode": "gradient", "color": "#0b0b10", "color2": "#1c1230", "angle": 180}
    s["layers"] = [
        _capture("Game", 0, 230, 1080, 608),
        _placed("shape", "Camera frame", 48, 862, 300, 300, kind="frame", pad=10, hole_radius=150,
                fill="rgba(255,255,255,.14)", stroke={"w": 3, "color": "#ffffff"}),
        _camera("Camera", 58, 872, 280, 280, mask="circle"),
        _text("Handle", 372, 872, 488, 80, "{title}", size=40, weight=600, color="#ffffff", fit=True),
        _component("Captions", "captions", 372, 968, 488, 180, card_bg=False, frame=False),
        _component("Now Playing", "np", 48, 1172, 760, 134, hide=["progress", "transport"]),
    ]
    return validate(s)


def template_just_chatting_phone():
    s = new_scene("Just chatting (phone)", "phone")
    s["background"] = {"mode": "gradient", "color": "#141026", "color2": "#2b1b4d", "angle": 170}
    s["layers"] = [
        _text("Title", 48, 254, 812, 90, "Just chatting", size=64, letter=0.02),
        _placed("shape", "Camera frame", 48, 360, 812, 760, kind="frame", pad=16, hole_radius=36,
                fill="rgba(255,255,255,.12)", stroke={"w": 3, "color": "#c9a7ff"}),
        _camera("Camera", 64, 376, 780, 728, mask="rounded"),
        _component("Captions", "captions", 64, 960, 780, 140, card_bg=False, frame=False),
        _component("Now Playing", "np", 48, 1136, 812, 170),
    ]
    return validate(s)


def template_music_phone():
    s = new_scene("Music (phone)", "phone")
    s["background"] = {"mode": "scene", "color": "#1a0f1f", "color2": "#241a3d", "angle": 135, "image": "",
                       "fit": "cover", "scene": {"id": "sakura", "c1": "", "c2": "", "c3": "",
                                                 "scale": 1.0, "density": 1.0, "tile_scale": 1.0, "seed": 3}}
    s["layers"] = [
        _component("Now Playing", "np", 48, 254, 984, 230),
        _component("Lyrics", "lyrics", 48, 510, 812, 440),
        _text("Song", 48, 980, 812, 120, "{title}", size=60, fit=True, align="center"),
        _text("Artist", 48, 1110, 812, 76, "{artist}", size=38, weight=500, align="center", color="#e9ddff"),
        _component("Captions", "captions", 48, 1196, 812, 110, card_bg=False, frame=False),
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
    "gaming_landscape": ("Gaming landscape", "horizontal", template_gaming_landscape),
    "just_chatting_phone": ("Just chatting (phone)", "phone", template_just_chatting_phone),
    "music_phone": ("Music (phone)", "phone", template_music_phone),
    "gaming_portrait": ("Gaming portrait", "phone", template_gaming_portrait),
}


def template_list():
    return [{"id": k, "name": v[0], "format": v[1]} for k, v in TEMPLATES.items()]


def from_template(key):
    return TEMPLATES[key][2]()


def template_previews():
    """Every template as the New scene gallery draws it: its size, its
    background and each layer's box (P10)."""
    keep = ("component", "kind", "mask", "text", "fill")
    out = []
    for key, (name, fmt, make) in TEMPLATES.items():
        s = make()
        out.append({"id": key, "name": name, "format": fmt, "width": s["width"], "height": s["height"],
                    "background": s["background"],
                    "layers": [{"type": l["type"], "name": l["name"], "transform": l["transform"],
                                "props": {k: l["props"][k] for k in keep if k in l["props"]}}
                               for l in s["layers"]]})
    return out


# ---------------------------------------------------------------- formats (P10)

ANCHOR_FRAC = {"tl": (0, 0), "tc": (.5, 0), "tr": (1, 0), "ml": (0, .5), "mc": (.5, .5), "mr": (1, .5),
               "bl": (0, 1), "bc": (.5, 1), "br": (1, 1)}
MARGIN = 48             # from the canvas edge, when a layout places things
GAP = 16                # between things a layout stacks
UNDER_UI = 0.08         # a layer counts as under TikTok's controls when they cover this share of it


def bounds(t):
    """The axis-aligned box a transform covers, its rotation included: (x, y, w, h)."""
    x, y, w, h = (float(t.get(k) or 0) for k in ("x", "y", "w", "h"))
    r = math.radians(float(t.get("rotation") or 0))
    if abs(math.sin(r)) < 1e-9 and math.cos(r) > 0:
        return x, y, w, h
    fx, fy = ANCHOR_FRAC.get(t.get("anchor"), (0, 0))
    px, py = x + fx * w, y + fy * h
    c, s = math.cos(r), math.sin(r)
    pts = [(px + (qx - px) * c - (qy - py) * s, py + (qx - px) * s + (qy - py) * c)
           for qx, qy in ((x, y), (x + w, y), (x + w, y + h), (x, y + h))]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


def _union(boxes):
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    return x0, y0, max(b[0] + b[2] for b in boxes) - x0, max(b[1] + b[3] for b in boxes) - y0


def _overlap(a, b):
    w = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    h = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def safe_zones(fmt):
    return SAFE_ZONES.get(fmt) or []


def _backdrop(layer, width, height):
    """Background layers, and anything filling most of the canvas: meant to sit under everything."""
    if layer.get("type") == "background":
        return True
    b = bounds(layer.get("transform") or {})
    return b[2] >= 0.9 * width and b[3] >= 0.9 * height


def zone_hits(scene, layer):
    """The names of TikTok's on-screen controls covering part of this layer
    (a phone scene): those covering at least UNDER_UI of it. Backdrops are
    meant to sit under them and are left out, as are hidden layers."""
    zones = safe_zones(scene.get("format"))
    if not zones or layer.get("visible") is False or _backdrop(layer, scene["width"], scene["height"]):
        return []
    b = bounds(layer.get("transform") or {})
    area = max(1.0, b[2] * b[3])
    return [z["name"] for z in zones if _overlap(b, (z["x"], z["y"], z["w"], z["h"])) >= UNDER_UI * area]


def _band(fmt, width, height):
    """Where a layout puts things, top to bottom: clear of TikTok's top bar and
    comments on a phone, inside the margins otherwise."""
    zones = safe_zones(fmt)
    top = max([MARGIN] + [z["y"] + z["h"] + 24 for z in zones if z["y"] <= 0])
    bottom = min([height - MARGIN] + [z["y"] - 24 for z in zones if z["y"] > height / 2 and z["x"] <= 0])
    return top, bottom


def _fills(layer, w0, h0):
    """Does this layer fill the old canvas - the background, the game?"""
    if layer.get("type") == "background":
        return True
    b = bounds(layer.get("transform") or {})
    if layer.get("type") == "capture" and (b[2] >= 0.85 * w0 or b[3] >= 0.85 * h0):
        return True
    return b[2] >= 0.85 * w0 and b[3] >= 0.85 * h0


def _hero_rect(fmt, width, height, layer, top):
    """Where a layer that filled the old canvas goes on the new one."""
    t = layer["transform"]
    if layer["type"] == "background":
        return 0, 0, width, height
    if layer["type"] == "capture":
        # A game or a screen is 16:9: as wide as the canvas, under TikTok's top bar on a phone.
        if fmt == "phone":
            return 0, max(0, top - 24), width, round(width * 9 / 16)
        return 0, 0, width, height
    aspect = max(0.01, float(t["w"]) / max(1.0, float(t["h"])))
    w, h = width, width / aspect
    if h > height:
        h, w = height, height * aspect
    return (width - w) / 2, (height - h) / 2, w, h


def _units(items):
    """Layers that move as one: a group, and layers stacked on each other
    (a camera inside its frame, a caption on a picture)."""
    parent = list(range(len(items)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    boxes = [bounds(l["transform"]) for l in items]
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            gi, gj = items[i].get("group"), items[j].get("group")
            smaller = max(1.0, min(boxes[i][2] * boxes[i][3], boxes[j][2] * boxes[j][3]))
            if (gi and gi == gj) or _overlap(boxes[i], boxes[j]) >= 0.6 * smaller:
                parent[find(i)] = find(j)
    groups = {}
    for i in range(len(items)):
        groups.setdefault(find(i), []).append(items[i])
    return list(groups.values())


def _clear_side_zones(fmt, box):
    """Out from under a zone at the side (TikTok's buttons), if it fits to the left of it."""
    x, y, w, h = box
    for z in safe_zones(fmt):
        if z["x"] > 0 and y < z["y"] + z["h"] and y + h > z["y"] and x + w > z["x"]:
            nx = z["x"] - GAP - w
            if nx >= MARGIN:
                x = nx
    return x, y, w, h


def _layout(boxes, fmt, width, h0, w0, top, bottom, k, pack):
    """Place the units: each on its side of the canvas (which third it was in),
    in its old order down the page - where it was, in proportion, or packed
    from the top - never over another one, all scaled by k. Returns each
    unit's (x, y, scale) and how far down it went."""
    span = max(1.0, bottom - top)
    placed, res = [], [None] * len(boxes)
    for i in sorted(range(len(boxes)), key=lambda i: (boxes[i][1] + boxes[i][3] / 2, i)):
        ux, uy, uw, uh = boxes[i]
        sc = min(1.0, (width - 2 * MARGIN) / max(1.0, uw), span / max(1.0, uh)) * k
        w, h = uw * sc, uh * sc
        cx, cy = ux + uw / 2, uy + uh / 2
        if w >= width - 2 * MARGIN - 1:
            x = (width - w) / 2
        elif cx < w0 / 3:
            x = MARGIN
        elif cx > 2 * w0 / 3:
            x = width - MARGIN - w
        else:
            x = (width - w) / 2
        y = top if pack else max(top, min(top + (cy / h0) * span - h / 2, bottom - h))
        box = (x, y, w, h)
        for _ in range(4 * len(boxes) + 4):
            box = _clear_side_zones(fmt, box)
            hit = next((p for p in placed if _overlap(box, p) > 0), None)
            if not hit:
                break
            box = (box[0], hit[1] + hit[3] + GAP, w, h)
        placed.append(box)
        res[i] = (box[0], box[1], sc)
    return res, max((p[1] + p[3] for p in placed), default=top)


def _scale_props(layer, sc):
    """Sizes a layer carries in pixels shrink with its box."""
    if abs(sc - 1) < 1e-6:
        return
    p, st = layer.get("props") or {}, layer.get("style") or {}
    if layer["type"] == "text" and p.get("size"):
        p["size"] = max(6, round(float(p["size"]) * sc, 1))
    for key in ("pad", "hole_radius"):
        if isinstance(p.get(key), (int, float)):
            p[key] = round(p[key] * sc, 1)
    if isinstance(p.get("stroke"), dict) and p["stroke"].get("w"):
        p["stroke"]["w"] = max(1, round(p["stroke"]["w"] * sc, 1))
    if st.get("radius"):
        st["radius"] = round(st["radius"] * sc, 1)
    if isinstance(st.get("border"), dict) and st["border"].get("w"):
        st["border"]["w"] = max(1, round(st["border"]["w"] * sc, 1))


def _keep_inside(t, width, height):
    """Whatever happened before: the layer's box, rotation included, inside the canvas."""
    b = bounds(t)
    if b[2] > width or b[3] > height:
        f = min(width / max(1e-6, b[2]), height / max(1e-6, b[3]))
        cx, cy = t["x"] + t["w"] / 2, t["y"] + t["h"] / 2
        t["w"], t["h"] = t["w"] * f, t["h"] * f
        t["x"], t["y"] = cx - t["w"] / 2, cy - t["h"] / 2
        b = bounds(t)
    t["x"] += -b[0] if b[0] < 0 else min(0.0, width - (b[0] + b[2]))
    t["y"] += -b[1] if b[1] < 0 else min(0.0, height - (b[1] + b[3]))
    r = math.radians(float(t.get("rotation") or 0))
    if abs(math.sin(r)) < 1e-9 and math.cos(r) > 0:      # upright, as bounds() means it (180 is not)
        t["w"], t["h"] = max(1, min(width, round(t["w"]))), max(1, min(height, round(t["h"])))
        t["x"] = max(0, min(width - t["w"], round(t["x"])))
        t["y"] = max(0, min(height - t["h"], round(t["y"])))
    else:
        for k in ("x", "y", "w", "h"):
            t[k] = round(t[k], 2)
        b = bounds(t)            # rounding may not push it out: shrink the step it made
        t["x"] += max(0.0, -b[0]) + min(0.0, width - (b[0] + b[2]))
        t["y"] += max(0.0, -b[1]) + min(0.0, height - (b[1] + b[3]))


def convert(scene, fmt, name=None):
    """The scene laid out again for another format (P10) - a starting point to
    fix by hand, never a layer off the canvas.

    Backgrounds fill the new canvas; a game or screen capture that filled the
    old one becomes the picture across the top (16:9, under TikTok's top bar
    on a phone). Everything else moves in units - groups, and layers stacked on
    each other, like a camera and its frame - each keeping its side of the
    canvas and its place down the page, between TikTok's top bar and its
    comments, clear of its side buttons, and none over another. When they do
    not fit they shrink together, down to half size; then they overflow below
    the band and are marked as under TikTok's controls. Every layer keeps its
    id, order and settings; sizes in pixels (text, frames) shrink with it."""
    if fmt not in FORMATS:
        raise ValueError(f"no format {fmt!r}")
    out = validate(copy.deepcopy(scene))
    w0, h0 = out["width"], out["height"]
    width, height = FORMATS[fmt]
    out.update(format=fmt, width=width, height=height, guides={"h": [], "v": []})
    if name:
        out["name"] = str(name)[:80]
    top, bottom = _band(fmt, width, height)
    heroes, items = [], []
    for layer in out["layers"]:
        (heroes if _fills(layer, w0, h0) else items).append(layer)
    hero_bottom = None
    for layer in heroes:
        x, y, w, h = _hero_rect(fmt, width, height, layer, top)
        layer["transform"].update(x=x, y=y, w=w, h=h, rotation=0)
        if layer["type"] == "capture" and fmt == "phone":
            hero_bottom = max(hero_bottom or 0, y + h)
    if hero_bottom is not None and bottom - (hero_bottom + 24) >= 160:
        top = hero_bottom + 24
    units = _units(items)
    boxes = [_union([bounds(l["transform"]) for l in u]) for u in units]
    # Where they were, at full size; else packed from the top, shrinking until they fit.
    res, reach = _layout(boxes, fmt, width, h0, w0, top, bottom, 1.0, False)
    if reach > bottom:
        k = 1.0
        for _ in range(12):
            res, reach = _layout(boxes, fmt, width, h0, w0, top, bottom, k, True)
            if reach <= bottom or k <= 0.5:
                break
            k = max(0.5, min(k - 0.02, k * (bottom - top) / max(1.0, reach - top)))
    for unit, (ux, uy, _uw, _uh), (x, y, sc) in zip(units, boxes, res):
        for layer in unit:
            t = layer["transform"]
            t["x"], t["y"] = x + (t["x"] - ux) * sc, y + (t["y"] - uy) * sc
            t["w"], t["h"] = t["w"] * sc, t["h"] * sc
            _scale_props(layer, sc)
    for layer in out["layers"]:
        _keep_inside(layer["transform"], width, height)
    return validate(out)


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
        self.unreadable = []        # scene files no version of which could be read
        for name in sorted(os.listdir(self.folder)):
            if not name.endswith(".json"):
                continue
            sid = name[:-5]
            scene, bad = None, []
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
                    bad.append(path)
                    self.log(f"scenes: {os.path.basename(path)} unreadable ({exc})")
            # A file that cannot be read is set aside as "<file>.corrupt", where
            # it can still be looked at, rather than tried again at every start
            # or shuffled into the backups by the next save.
            kept = [self._set_aside(path) for path in bad]
            if scene:
                scene["id"] = sid
                self._scenes[sid] = scene
                if bad and bad[0] == self._path(sid):
                    self._write(scene)          # the newest readable copy is the scene again
            elif kept:
                self.unreadable.append({"id": sid, "file": name, "kept_as": os.path.basename(kept[0] or name)})

    def _set_aside(self, path):
        target = path + ".corrupt"
        if os.path.exists(target):
            target = f"{path}.{round(time.time())}.corrupt"
        try:
            os.replace(path, target)
            return target
        except OSError:
            return None

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
            # (0 means every save, said outright: a file's time comes from the
            # file system's coarser clock and can read a hair ahead of
            # time.time(), so "age >= 0" failed now and then on CI.)
            newest = self._path(scene["id"], 1)
            if (self.backup_every <= 0 or not os.path.isfile(newest)
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
        try:
            scene = migrate(self._read(path))
        except (OSError, ValueError, RecursionError) as exc:
            self.log(f"scenes: {os.path.basename(path)} unreadable ({exc})")
            return None
        scene["id"] = sid
        return self.save(scene)
