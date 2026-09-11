"""
The component registry: every window the deck can put on stream, declared
once. A component is a page, the config section its settings live in, a
default size, the titles its windows carry, and what it needs (a
microphone, Spotify). Adding one is adding an entry here; the deck, the
routes and the state feed read the registry rather than knowing four names.

Scene outputs are components too - registered as scenes come and go - so
"Canvas: My Layout" opens, snaps, parks and heals like Now Playing does.
"""

import json
import os

import overlay as overlay_mod

TITLE = "Awesome Streaming Deck"

# The routes the deck, scripts and rebuild.ps1 have always used.
ALIASES = {
    "window": "np",
    "lyrics/window": "lyrics",
    "queue/window": "queue",
    "captions/window": "captions",
}


class Component:
    def __init__(self, cid, label, page, section, size, group="music",
                 capabilities=(), host_title=None, page_title=None, dynamic=False):
        self.id = cid
        self.label = label
        self.page = page                  # served path, query included
        self.section = section            # config section; None for dynamic ones
        self.size = tuple(size)
        self.group = group                # music | sharing | canvas
        self.capabilities = tuple(capabilities)
        self.host_title = host_title or f"{TITLE} - {label}"
        self.page_title = page_title or f"{self.host_title} (source)"
        self.dynamic = dynamic
        self.overlay = None

    def describe(self):
        return {"id": self.id, "label": self.label, "page": self.page,
                "section": self.section, "group": self.group,
                "size": list(self.size), "capabilities": list(self.capabilities),
                "dynamic": self.dynamic, "host_title": self.host_title}

    def config(self, root):
        """This component's window settings inside the config."""
        if self.section:
            return root.setdefault(self.section, {})
        outputs = root.setdefault("canvas", {}).setdefault("outputs", {})
        cfg = outputs.get(self.id)
        if cfg is None:
            cfg = outputs[self.id] = {"width": self.size[0], "height": self.size[1],
                                      "x": 60, "y": 60, "borderless": True, "topmost": True}
        return cfg


class Registry:
    def __init__(self, cache_dir):
        self.cache = cache_dir
        self._items = {}

    def add(self, comp):
        if comp.id in self._items:
            return self._items[comp.id]
        comp.overlay = overlay_mod.Overlay(self.cache, comp.id, comp.host_title, comp.page_title)
        self._items[comp.id] = comp
        return comp

    def remove(self, cid):
        comp = self._items.pop(cid, None)
        if comp and comp.overlay:
            try:
                comp.overlay.close()
            except Exception:
                pass
        return comp

    def get(self, cid):
        return self._items.get(cid)

    def resolve(self, key):
        """A component from its id or from one of the old route names."""
        return self._items.get(ALIASES.get(key, key))

    def __iter__(self):
        return iter(list(self._items.values()))

    def ids(self):
        return list(self._items)

    def describe_all(self):
        return [c.describe() for c in self]

    def statuses(self):
        out = {}
        for c in self:
            try:
                out[c.id] = c.overlay.status()
            except Exception:
                out[c.id] = {"open": False, "hosted": False, "minimized": False, "rect": None}
        return out

    def any_open(self):
        return any(c.overlay.is_open() for c in self)

    def close_all(self):
        for c in self:
            try:
                c.overlay.close()
            except Exception:
                pass

    # ------------------------------------------------ scene outputs

    @staticmethod
    def scene_id(scene_id):
        return f"scene:{scene_id}"

    def sync_scenes(self, scenes):
        """Keep one output component per scene; drop the ones whose scene is gone."""
        want = {}
        for s in scenes:
            cid = self.scene_id(s["id"])
            want[cid] = s
            comp = self._items.get(cid)
            if comp is None:
                self.add(Component(
                    cid, f"Canvas: {s['name']}", f"scene.html?id={s['id']}", None,
                    (int(s.get("width") or 1920), int(s.get("height") or 1080)),
                    group="canvas", capabilities=("scene",),
                    page_title=f"{TITLE} - Canvas {s['id']} (source)", dynamic=True))
            else:
                # A rename shows in the picker's title next time it opens.
                comp.label = f"Canvas: {s['name']}"
                comp.size = (int(s.get("width") or 1920), int(s.get("height") or 1080))
        for cid in list(self._items):
            if cid.startswith("scene:") and cid not in want:
                self.remove(cid)


def builtin(cache_dir):
    reg = Registry(cache_dir)
    reg.add(Component("np", "Now Playing", "nowplaying.html", "nowplaying", (760, 190),
                      capabilities=("music", "designer")))
    reg.add(Component("lyrics", "Lyrics", "lyrics.html", "lyrics", (560, 320),
                      capabilities=("music", "designer")))
    reg.add(Component("queue", "Queue", "queue.html", "queue", (420, 320),
                      capabilities=("music", "spotify", "designer")))
    reg.add(Component("captions", "Captions", "captions.html", "captions", (900, 200),
                      capabilities=("microphone", "designer")))
    return reg


# ------------------------------------------------------------------ camera and mic

def seed_media_permissions(profile_dir, port, log=None):
    """Allow the camera and microphone for the app's own origin in a Chrome
    profile, so no prompt ever has to be clicked in a window nobody can
    reach. Written only while no Chrome uses the profile (it rewrites the
    file on exit), and only when something is missing."""
    prefs = os.path.join(profile_dir, "Default", "Preferences")
    origin = f"http://127.0.0.1:{port},*"
    try:
        data = {}
        if os.path.isfile(prefs):
            with open(prefs, "r", encoding="utf-8") as f:
                data = json.load(f)
        exceptions = (data.setdefault("profile", {}).setdefault("content_settings", {})
                      .setdefault("exceptions", {}))
        changed = False
        for key in ("media_stream_camera", "media_stream_mic"):
            entries = exceptions.setdefault(key, {})
            if (entries.get(origin) or {}).get("setting") != 1:
                entries[origin] = {"setting": 1}
                changed = True
        if not changed:
            return False
        os.makedirs(os.path.dirname(prefs), exist_ok=True)
        tmp = prefs + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, prefs)
        if log:
            log(f"camera and microphone allowed for the app in {os.path.basename(profile_dir)}")
        return True
    except Exception as exc:
        if log:
            log(f"could not seed permissions in {profile_dir}: {exc}")
        return False
