"""
Awesome Streaming Deck - a local-only now-playing rig for streaming.

Runs a small HTTP server bound to 127.0.0.1 (nothing is reachable from your
network, let alone the internet) and serves two windows:

    Deck         - your control room: library, playback, overlay settings
    Now Playing  - the borderless window you add to TikTok Studio

Sources: your own audio files, and whatever Spotify is playing (read from
Windows' media session, not from Spotify's servers - no login, no API keys).

Run:  python server.py
"""

import os
# numpy's BLAS reserves a thread pool with hundreds of MB of private memory
# at import; the audio mixer does element-wise work only and needs none of it.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import functools
import hashlib
import json
import mimetypes
import re
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.parse
from urllib.parse import urlparse, parse_qs

import overlay as overlay_mod
from assets import AssetStore
import capture
import components
import feeds
import guard
import scenes
import sceneio
import chat
import commands
import songreq
import alerts
import polls
import tts
import voice
from lyrics import Lyrics
from spotify_api import SpotifyAccount
import tags
import tiktok_live
import winwin
from smtc import MediaBridge
from captions import CaptionBridge
from captions_whisper import gpu_failure, list_microphones
import fonts
import gpu
import live
import models
import nativelive
import audio as audio_mod

import paths

WEB = paths.resource("web")
CACHE = paths.data("cache")
ASSETS = os.path.join(CACHE, "assets")
CONFIG_PATH = paths.data("config.json")
LIBRARY_CACHE = os.path.join(CACHE, "library.json")

DECK_TITLE = "Awesome Streaming Deck"

DEFAULT_CONFIG = {
    "port": 8713,
    "music_dirs": [],
    "canvas": {
        "outputs": {},               # per-scene output window settings, keyed "scene:<id>"
        "live": "",                  # the scene the "Canvas (live)" output follows
        "transition": "fade",        # fade | cut, when the live scene changes
        "duration": 300,             # ms, for the fade
        "export_dir": "",            # where a scene's Export .zip goes; "" = the Downloads folder
    },
    "voice": {
        "threshold": 0.08,           # how loud counts as talking, for reactive images (voice.py)
    },
    "chat": {
        # Reading a public Twitch channel needs no account, so there is nothing
        # secret in here and nothing to keep in the vault (chat.py).
        "twitch": {"channel": "", "auto": False},
        # Muted locally, by login: the panel stops showing them and nothing is
        # sent to the service. Hiding a single message is not kept - the hub's
        # ring ages messages out, so a list of ids could only ever grow.
        "blocked": [],
    },
    "commands": {
        # The spine S13 to S15 hang off (commands.py). Settings a person edits,
        # so config rather than a store of its own - scenes.py is for documents
        # with revisions and backups, which these are not. Not filed under
        # "chat" either: S14 starts a poll from the Live view or by a command
        # from you, so a command is not chat's property.
        "list": [],
        # What starts a command in chat: "!" by default, "/" or "@" or several
        # at once ("!/") if that suits better. chat.set_symbols refuses a
        # letter or a digit - with "a" as the symbol, "apple" would run the
        # command "pple" - so what is saved here is what it accepted.
        "symbol": "!",
        # At most `count` pictures or sounds in any `seconds`, from every
        # command together (T10, commands.clean_budget). Seconds of 0 is no
        # budget. Whether commands are paused is deliberately not in here.
        "budget": {"count": 5, "seconds": 30},
    },
    "requests": {
        # Song requests (songreq.py). Moderated by default, and the default is
        # the interesting part: Spotify can append to a queue but has no
        # endpoint to take anything out of one again, so letting a request
        # through is the step that cannot be undone.
        "moderated": True,
        "max_seconds": 420,          # 0 for no limit
        "blocked": [],               # matched against the request and against what came back
    },
    "live": {
        "preset": "720p30",          # see live.PRESETS
        "source": "live",            # the component whose window goes on stream ("page" = the browser path)
        "audio": {
            "mic": True, "mic_device": "",   # "" = the Windows default microphone
            "system": False,                 # what the PC plays (WASAPI loopback)
            "gain": {"mic": 1.0, "system": 1.0},
            "mute": {"mic": False, "system": False},
        },
    },
    "source_mode": "auto",          # auto | local | spotify
    "theme": "",                    # last full theme applied, so the picker can show it
    "volume": 0.7,
    "ui": {
        "preset": "",                # last app preset applied
        "follow_np": True,           # take accent and text colors from the pop-out
        "accent": "#8b5cf6",
        "bg": "#000000",
        "panel": "#0a0a0c",
        "border": "#1b1b22",
        "text": "#f0f0f4",
        "muted": "#7e7e8c",
        "radius": 12,
        "font": "Segoe UI",
        "density": "normal",         # compact | normal | roomy
        "glow": False,
        # Ultra optimized: nothing animates in any window, animated pictures
        # hold their first frame, clocks tick once a second, captions show
        # finished lines only and the media bridge reads Windows once a second.
        "ultra": False,
        # The same shape as nowplaying.bg, so one editor and one painter
        # serve the app and all three windows. (ui.bg above is the app's flat
        # background color, which this sits on top of.)
        "wallpaper": {
            "mode": "solid",         # solid | gradient | image | scene
            "color": "#000000",
            "color2": "#241a3d",
            "angle": 135,
            "image": "",             # asset id
            "fit": "cover",          # cover | contain | stretch | tile
            "dim": 0.0,              # veil in the app's own background color
            "blur": 0,
            "pos_x": 50,
            "pos_y": 50,
            # Recolor the picture into two colors, the way a duotone print
            # does: the image keeps its light and shade, you choose the ink.
            "zoom": 1.0,             # 1 = fit exactly; more crops in
            "tint": {
                "on": False,
                "c1": "",            # blank = the palette's line color
                "c2": "",            # blank = the accent
                "angle": 135,
                "strength": 1.0,     # 0 leaves the picture alone
            },
            "scene": {
                "id": "", "c1": "", "c2": "", "c3": "",
                "scale": 1.0, "density": 1.0, "tile_scale": 1.0, "seed": 1,
            },
        },
        "decor": {
            "border": "",
            "custom": "",
            "sides": "none",
            "size": 0.7,
            "opacity": 0.5,
            "color": "",
            "gap": 0.6,
            "kaomoji": "",
            "animate": False,
            "layer": "over",
            "blur": 0,
        },
    },
    "spotify": {
        "client_id": "",             # from your app at developer.spotify.com
        "use_account": True,         # prefer the account over the Windows bridge when both know a track
    },
    "queue": {
        "font": "",                  # "" = the Now Playing font
        "width": 420, "height": 320, "x": 60, "y": 300,
        "borderless": True,
        "topmost": True,
        "scale": 1.0,
        "rows": 12,                  # ceiling; the window shows as many as fit
        "heading": "UP NEXT",
        "show_header": True,
        "show_now": False,           # include the track playing right now
        "show_art": True,
        "show_artist": True,
        "show_times": True,
        "follow_theme": True,        # colors, font and background from the pop-out
        "bg": "#0f0f17",
        "interactive": True,         # click a track to play it
        "colors": {"text": "", "muted": "", "accent": ""},   # "" = inherit Now Playing
        # Transport buttons drawn inside the window. Off by default, and
        # hidden until the mouse is over it, so they never land on stream.
        "controls": {
            "show": False,
            "hover_only": True,
            "prev": True,
            "play": True,
            "next": True,
            "place": "card",         # card | art | corner
            "align": "right",        # left | center | right
            "size": 1.0,
            "opacity": 0.9,
            "shape": "round",        # round | square | bare
            "anchor": "",            # tl tc tr ml mc mr bl br; "" = legacy place/align
            "offset": {"x": 0, "y": 0},   # px fine-tune from the anchor
        },
        "bg_own": {              # used when follow_theme is off
            "mode": "solid", "color": "#0f0f17", "color2": "#241a3d", "angle": 135,
            "image": "", "fit": "cover", "dim": 0.0, "blur": 0,
            "pos_x": 50, "pos_y": 50,
            # Recolor the picture into two colors, the way a duotone print
            # does: the image keeps its light and shade, you choose the ink.
            "zoom": 1.0,             # 1 = fit exactly; more crops in
            "tint": {
                "on": False,
                "c1": "",            # blank = the palette's line color
                "c2": "",            # blank = the accent
                "angle": 135,
                "strength": 1.0,     # 0 leaves the picture alone
            },
            "scene": {"id": "", "c1": "", "c2": "", "c3": "",
                      "scale": 1.0, "density": 1.0, "tile_scale": 1.0, "seed": 1},
        },
    },
    # Screen sharing: decorative frames with a hole the game or camera shows through.
    "screenframe": {
        "width": 1280, "height": 720, "x": 120, "y": 120,
        "borderless": True, "topmost": True,
        "frame": {
            "hole": "clear",             # clear (see-through) | key (painted the key color)
            "key_color": "#00ff00",
            "shape": "rounded",            # rect | rounded | circle
            "radius": 18,                # px, for rounded
            "border": {"style": "solid", "width": 8, "color": ""},   # solid | double | dashed | glow | none; "" = the accent
            "loop": {"border": "", "custom": "", "size": 0.9, "color": "", "animate": True},   # decor.js patterns
            "badges": {"tl": "", "tr": "", "bl": "", "br": "", "size": 1.0, "color": ""},
            "title": {"text": "", "place": "top", "size": 1.0, "color": ""},
        },
    },
    "camframe": {
        "width": 480, "height": 480, "x": 160, "y": 160,
        "borderless": True, "topmost": True,
        "frame": {
            "hole": "clear",             # clear (see-through) | key (painted the key color)
            "key_color": "#00ff00",
            "shape": "circle",            # rect | rounded | circle
            "radius": 18,                # px, for rounded
            "border": {"style": "solid", "width": 8, "color": ""},   # solid | double | dashed | glow | none; "" = the accent
            "loop": {"border": "", "custom": "", "size": 0.9, "color": "", "animate": True},   # decor.js patterns
            "badges": {"tl": "", "tr": "", "bl": "", "br": "", "size": 1.0, "color": ""},
            "title": {"text": "", "place": "top", "size": 1.0, "color": ""},
        },
    },
    "captions": {
        "enabled": False,            # listen on launch; off until you press Start
        "engine": "whisper",         # whisper (accurate) | windows (built-in, no download)
        "model": "base.en",          # which Whisper model, once downloaded
        "mic": "",                   # "" = the Windows default microphone
        "words": "",                 # names and terms to expect, comma separated
        "live_words": True,          # words while you still talk (about 3x the CPU of off)
        "device": "cpu",             # cpu | gpu: Whisper on an NVIDIA card, once its library is downloaded
        "font": "",                  # "" = the Now Playing font
        "width": 900, "height": 200, "x": 120, "y": 780,
        "borderless": True,
        "topmost": True,
        "scale": 1.0,                # text size
        "lines": 2,                  # finished lines kept above the live one
        "hold": 6.0,                 # seconds a finished line stays before fading
        "align": "center",           # center | left
        "follow_theme": True,        # background from the pop-out
        "bg": "#0f0f17",             # used when not following the theme
        "colors": {"text": "", "muted": "", "accent": ""},   # "" = inherit Now Playing
        "bg_own": {              # used when follow_theme is off
            "mode": "solid", "color": "#0f0f17", "color2": "#241a3d", "angle": 135,
            "image": "", "fit": "cover", "dim": 0.0, "blur": 0,
            "pos_x": 50, "pos_y": 50,
            "zoom": 1.0,
            "tint": {"on": False, "c1": "", "c2": "", "angle": 135, "strength": 1.0},
            "scene": {"id": "", "c1": "", "c2": "", "c3": "",
                      "scale": 1.0, "density": 1.0, "tile_scale": 1.0, "seed": 1},
        },
    },
    "lyrics": {
        "font": "",                  # "" = the Now Playing font
        "online": True,              # ask lrclib.net when no .lrc file exists
        "width": 560, "height": 320, "x": 120, "y": 420,
        "borderless": True,
        "topmost": True,
        "scale": 1.0,                # text size
        "lines": 5,                  # lines visible at once
        "align": "center",           # center | left
        "highlight": "accent",       # accent | text
        "dim_past": True,
        "show_header": False,        # song title above the words
        "offset": 0.0,               # seconds; + shows lines earlier
        "follow_theme": True,        # colors, font and background from the pop-out
        "bg": "#0f0f17",             # used when not following the theme
        "interactive": True,         # click a line to jump to it
        "colors": {"text": "", "muted": "", "accent": ""},   # "" = inherit Now Playing
        # Transport buttons drawn inside the window. Off by default, and
        # hidden until the mouse is over it, so they never land on stream.
        "controls": {
            "show": False,
            "hover_only": True,
            "prev": True,
            "play": True,
            "next": True,
            "place": "card",         # card | art | corner
            "align": "right",        # left | center | right
            "size": 1.0,
            "opacity": 0.9,
            "shape": "round",        # round | square | bare
            "anchor": "",            # tl tc tr ml mc mr bl br; "" = legacy place/align
            "offset": {"x": 0, "y": 0},   # px fine-tune from the anchor
        },
        "bg_own": {              # used when follow_theme is off
            "mode": "solid", "color": "#0f0f17", "color2": "#241a3d", "angle": 135,
            "image": "", "fit": "cover", "dim": 0.0, "blur": 0,
            "pos_x": 50, "pos_y": 50,
            # Recolor the picture into two colors, the way a duotone print
            # does: the image keeps its light and shade, you choose the ink.
            "zoom": 1.0,             # 1 = fit exactly; more crops in
            "tint": {
                "on": False,
                "c1": "",            # blank = the palette's line color
                "c2": "",            # blank = the accent
                "angle": 135,
                "strength": 1.0,     # 0 leaves the picture alone
            },
            "scene": {"id": "", "c1": "", "c2": "", "c3": "",
                      "scale": 1.0, "density": 1.0, "tile_scale": 1.0, "seed": 1},
        },
    },
    "nowplaying": {
        "preset": "midnight",
        "layout": "auto",            # auto | bar | card | compact
        "width": 760,
        "height": 190,
        "x": 60,
        "y": 60,
        "scale": 1.0,
        "borderless": True,
        "topmost": True,
        "accent": "#8b5cf6",
        # The four colors everything else inherits from. Any specific color
        # left blank takes its value from here, so changing one of these
        # restyles the whole pop-out at once.
        "palette": {
            "text": "#f4f4f8",       # titles and primary text
            "muted": "#9a9aa8",      # artist, times, secondary text
            "line": "#2a2a3a",       # borders and rules
        },
        "bg": {
            "mode": "solid",         # solid | gradient | image | scene
            "color": "#0f0f17",
            "color2": "#241a3d",
            "angle": 135,
            "image": "",             # asset id
            "fit": "cover",          # cover | contain | stretch | tile
            "dim": 0.0,              # dark veil over the image, 0..1
            "blur": 0,
            "pos_x": 50,             # which part of the picture shows, 0-100
            "pos_y": 50,
            # Recolor the picture into two colors, the way a duotone print
            # does: the image keeps its light and shade, you choose the ink.
            "zoom": 1.0,             # 1 = fit exactly; more crops in
            "tint": {
                "on": False,
                "c1": "",            # blank = the palette's line color
                "c2": "",            # blank = the accent
                "angle": 135,
                "strength": 1.0,     # 0 leaves the picture alone
            },
            "scene": {               # generated artwork, see web/scenes.js
                "id": "",            # watercolor | sakura | doodle | moon | embers
                "c1": "", "c2": "", "c3": "",   # blank = the scene's own colors
                "scale": 1.0,        # motif size
                "density": 1.0,      # how many motifs
                "tile_scale": 1.0,   # how big each repeating tile is
                "seed": 1,           # shuffle the layout
            },
        },
        "card": {
            "radius": 18,
            "padding": 12,
            "border": 1,
            "border_color": "#2a2a3a",
            "fill": "",              # empty means "let the background show"
            "fill_alpha": 1.0,       # how solid that fill is
            "glow": True,            # accent wash behind the text
        },
        "text": {
            "font": "Segoe UI",
            "align": "left",
            "title_size": 1.72,
            "title_color": "",
            "title_weight": 700,
            "artist_size": 1.0,
            "artist_color": "",
            "label_size": 0.72,
            "label_color": "",
            "shadow": 0.0,
            "uppercase": False,
            "marquee": True,
        },
        "art": {
            "show": True,
            "radius": 10,
            "border": 0,
            "border_color": "#ffffff33",
        },
        "progress": {
            "show": True,
            "height": 5,
            "color": "",
            "times": True,
            "glow": True,
            # What sits either side of the bar: elapsed | remaining | duration | none
            "left": "elapsed",
            "right": "remaining",
        },
        # Clicking inside the pop-outs drives playback. Off makes them inert,
        # which is safer if you click around your canvas a lot while live.
        "interactive": True,
        # Transport buttons drawn inside the window. Off by default, and
        # hidden until the mouse is over it, so they never land on stream.
        "controls": {
            "show": False,
            "hover_only": True,
            "prev": True,
            "play": True,
            "next": True,
            "place": "card",         # card | art | corner
            "align": "right",        # left | center | right
            "size": 1.0,
            "opacity": 0.9,
            "shape": "round",        # round | square | bare
            "anchor": "",            # tl tc tr ml mc mr bl br; "" = legacy place/align
            "offset": {"x": 0, "y": 0},   # px fine-tune from the anchor
            "relative_to": "window",     # window | progress | art: what the anchor grid is measured from
        },
        "label": {"show": True, "text": "NOW PLAYING"},
        "surround": {
            "mode": "solid",         # solid = one color around the card | theme = the background
            "color": "#000000",      # black so the window melts into a black stream canvas
        },
        "decor": {
            "border": "",            # named pattern, see deck.js BORDERS
            "custom": "",            # your own characters, wins over `border`
            "sides": "tb",           # tb | all | top | bottom | none
            "size": 0.62,            # em, relative to the card text
            "opacity": 0.85,
            "color": "",             # blank = accent
            "gap": 0.5,              # letter spacing in em
            "kaomoji": "",           # shown next to the label
            "animate": False,        # slow drift along the border
            "layer": "under",        # under = watermark behind the card
            "blur": 0,               # soften it into a shadow
            "inset": 1.0,            # how far the card steps in from the frame (0-1)
            "tint": True,            # recolor the artwork so it reads on any background
            "place": "in",           # in = inside the card's frame | out = around it
            "speed": 1.0,            # drift speed; higher is faster
        },
        "source_badge": False,
        "equalizer": True,
        "stickers": [],
    },
}

MIMES = {
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4",
    ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg",
    ".wav": "audio/wav", ".aac": "audio/aac", ".webm": "audio/webm",
    ".aiff": "audio/aiff", ".aif": "audio/aiff", ".wma": "audio/x-ms-wma",
}


# ================================================================= config

_config_lock = threading.Lock()


def _deep_merge(base, override):
    out = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _merge_into(target, override):
    """Deep-merge in place, so anything holding a reference sees the update."""
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _merge_into(target[key], value)
        else:
            target[key] = value
    return target


def _migrate(cfg):
    """Carry older settings forward so nobody's look resets on upgrade.

    The app wallpaper used to be a lone asset id plus a darken slider, with a
    separate scene block that quietly won over it. It is now the same `bg`
    block every window uses, so fold the old keys in and drop them.
    """
    ui = cfg.get("ui")
    if not isinstance(ui, dict):
        return cfg
    old_scene = ui.pop("scene", None)
    old_dim = ui.pop("wallpaper_dim", None)
    # `wallpaper` used to be a bare asset id; it is a whole block now. Because
    # this runs on the raw file, before defaults are merged in, a string here
    # can only be the old shape.
    # Only pop it if it is the old shape: an already-migrated block is a dict
    # and must be left exactly where it is.
    old_image = ui.pop("wallpaper") if isinstance(ui.get("wallpaper"), str) else None
    if old_scene is None and old_image is None and old_dim is None:
        return cfg

    wall = {}
    if isinstance(old_scene, dict) and old_scene.get("id"):
        wall["scene"] = dict(old_scene)
        wall["mode"] = "scene"                    # the scene used to win
    elif old_image:
        wall["image"] = old_image
        wall["mode"] = "image"
    if isinstance(old_dim, (int, float)):
        wall["dim"] = old_dim
    ui["wallpaper"] = wall              # merged onto the defaults after this
    return cfg


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if os.path.isfile(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                # Migrate first, merge second: the migration only has to
                # understand shapes people actually wrote, not the defaults.
                cfg = _deep_merge(cfg, _migrate(json.load(f)))
        except Exception as exc:
            # Don't silently drop someone's folder list - say so and keep the
            # broken file around so it can be rescued by hand.
            backup = CONFIG_PATH + ".broken"
            try:
                os.replace(CONFIG_PATH, backup)
            except Exception:
                backup = CONFIG_PATH
            print(f"\n  ! config.json could not be read ({exc})")
            print(f"  ! starting from defaults; your old file is at {backup}\n")
    return cfg


def save_config(cfg):
    with _config_lock:
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2)
        except Exception as exc:
            print(f"  ! could not save config: {exc}")


CONFIG = load_config()

# NEVER GO LIVE from the test rig (2026-09-15: the user has a real TikTok stream
# key now). tools/rig/rigrestart.ps1 writes "test_rig": true into the rig's own
# config and nothing else ever does, so the user's app is untouched by this.
# Read once, here: a page posting to /api/config cannot lift it mid-session.
# While it holds, the engine streams to 127.0.0.1 alone and the TikTok routes
# that open a live or fetch the Streamlabs token are refused outright.
TEST_RIG = CONFIG.get("test_rig") is True


# ================================================================= themes

# Named looks live in their own file beside config, with their own lock so the
# themes API never contends with (or corrupts) the live config writer.
THEMES_PATH = os.path.join(CACHE, "themes.json")
_themes_lock = threading.Lock()


def load_themes():
    """The on-disk theme store as a dict keyed by id (fresh read each call)."""
    try:
        with open(THEMES_PATH, "r", encoding="utf-8") as f:
            blob = json.load(f)
        themes = blob.get("themes")
        return themes if isinstance(themes, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as exc:
        print(f"  ! themes.json unreadable ({exc}); starting empty")
        return {}


def save_themes(themes):
    with _themes_lock:
        try:
            os.makedirs(CACHE, exist_ok=True)
            with open(THEMES_PATH, "w", encoding="utf-8") as f:
                json.dump({"themes": themes}, f, indent=2)
        except Exception as exc:
            print(f"  ! could not save themes: {exc}")


def _theme_slug(name):
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:48]
    return slug or ("look-" + str(int(time.time())))


# ================================================================= library

class Library:
    """Scans the configured folders and remembers tags between runs."""

    def __init__(self):
        self.tracks = []
        self.by_id = {}
        self.scanning = False
        self.progress = ""
        self._cache = {}
        self._lock = threading.Lock()
        self._load_cache()

    def _load_cache(self):
        try:
            with open(LIBRARY_CACHE, "r", encoding="utf-8") as f:
                self._cache = json.load(f)
        except Exception:
            self._cache = {}

    def _save_cache(self):
        try:
            os.makedirs(CACHE, exist_ok=True)
            with open(LIBRARY_CACHE, "w", encoding="utf-8") as f:
                json.dump(self._cache, f)
        except Exception:
            pass

    @staticmethod
    def _track_id(path):
        return hashlib.sha1(path.lower().encode("utf-8", "replace")).hexdigest()[:14]

    def scan(self, dirs, force=False):
        with self._lock:
            if self.scanning:
                return
            self.scanning = True
        try:
            found, seen = [], set()
            for root_dir in dirs:
                if not os.path.isdir(root_dir):
                    continue
                for dirpath, dirnames, filenames in os.walk(root_dir):
                    dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                    for name in filenames:
                        if os.path.splitext(name)[1].lower() not in tags.AUDIO_EXTS:
                            continue
                        path = os.path.join(dirpath, name)
                        key = path.lower()
                        if key in seen:
                            continue
                        seen.add(key)
                        found.append(path)

            total = len(found)
            tracks = []
            for i, path in enumerate(found):
                if i % 25 == 0:
                    self.progress = f"Reading tags {i}/{total}"
                try:
                    stat = os.stat(path)
                    sig = f"{stat.st_mtime_ns}:{stat.st_size}"
                except OSError:
                    continue

                cached = self._cache.get(path.lower())
                if not force and cached and cached.get("sig") == sig:
                    meta = cached["meta"]
                else:
                    meta = tags.read_tags(path)
                    self._cache[path.lower()] = {"sig": sig, "meta": meta}

                tracks.append({
                    "id": self._track_id(path),
                    "path": path,
                    "title": meta["title"],
                    "artist": meta["artist"],
                    "album": meta["album"],
                    "track": meta["track"],
                    "year": meta["year"],
                    "duration": meta["duration"],
                    "folder": os.path.basename(os.path.dirname(path)),
                })

            def sort_key(t):
                try:
                    num = int(t["track"] or 0)
                except ValueError:
                    num = 0
                return (t["artist"].lower(), t["album"].lower(), num, t["title"].lower())

            tracks.sort(key=sort_key)
            self.tracks = tracks
            self.by_id = {t["id"]: t for t in tracks}
            self.progress = ""
            self._save_cache()
        finally:
            self.scanning = False

    def get(self, track_id):
        return self.by_id.get(track_id)


LIBRARY = Library()
BRIDGE = MediaBridge()
CAPTIONS = CaptionBridge()
MODEL_STORE = models.ModelStore(os.path.join(CACHE, "models"))
GPU_STORE = gpu.GpuStore(os.path.join(CACHE, "cuda"))
FONT_STORE = fonts.FontStore(os.path.join(CACHE, "fonts"))


def ultra_on():
    """Ultra optimized (an app setting): the lightest version of everything."""
    return bool((CONFIG.get("ui") or {}).get("ultra"))


def bridge_interval():
    """How often the media bridge reads Windows while music plays, in ms."""
    return 1000 if ultra_on() else 400


def captions_settings():
    """What the caption engine needs from the config, resolved: which engine,
    the model folder if it is on disk, the microphone, the expected words,
    and NVIDIA's library when Whisper should run on the graphics card and it
    has been downloaded (until then Whisper keeps to the processor).
    Ultra optimized keeps to finished lines, which reads each phrase once."""
    c = CONFIG.get("captions", {})
    engine = c.get("engine") if c.get("engine") in ("whisper", "windows") else "whisper"
    name = c.get("model") if c.get("model") in models.MODELS else models.DEFAULT
    cuda = (GPU_STORE.path() if engine == "whisper" and c.get("device") == "gpu"
            and GPU_STORE.gpu and GPU_STORE.driver_ok else None)
    return {"engine": engine, "model": name, "model_dir": MODEL_STORE.path(name),
            "mic": c.get("mic") or "", "words": c.get("words") or "",
            "live": c.get("live_words", True) is not False and not ultra_on(),
            "cuda_dir": cuda,
            "label": f"Whisper {name}" if engine == "whisper" else "Windows speech"}


# A model or NVIDIA's library arriving (or going) changes what a running
# session can use.
MODEL_STORE.on_change = lambda _name: CAPTIONS.configure(captions_settings())
GPU_STORE.on_change = lambda: CAPTIONS.configure(captions_settings())


# ================================================================= assets

# The library itself lives in assets.py; this is the one instance.
ASSET_STORE = AssetStore(ASSETS, paths.builtin_dir())


# ================================================================= state

class Hub:
    """Merged now-playing state plus the SSE fan-out."""

    def __init__(self):
        self.local = {"track_id": None, "playing": False, "position": 0.0,
                      "duration": 0.0, "volume": CONFIG["volume"], "dpr": 1.0}
        # A seek or a transport press asked for by a pop-out. The deck owns
        # the <audio> element, so the request rides the state broadcast and the
        # deck is what actually applies it.
        self.local_seek = None
        self.local_cmd = None
        self._subs = []
        self._lock = threading.Lock()
        self._last_payload = None      # what every window last got
        self._last_key = None          # ...minus what moves on its own
        self._last_sent = 0.0

    def update_local(self, data):
        for key in ("playing", "position", "duration", "volume", "dpr"):
            if key in data:
                self.local[key] = data[key]
        if "track_id" in data:
            self.local["track_id"] = data["track_id"]

    _lyr_key = None
    _lyr_info = None

    def _lyrics_info(self, now):
        """A one-line summary of the lyrics situation for the deck.

        Recomputed only when the track changes or while a lookup is still
        landing: LYRICS.get dedupes in-flight lookups, and this runs a few
        times a second inside the broadcast.
        """
        if not now:
            self._lyr_key, self._lyr_info = None, {"status": "none", "reason": "nothing playing"}
            return self._lyr_info
        key = (now.get("title"), now.get("artist"), now.get("duration"))
        if key != self._lyr_key or (self._lyr_info or {}).get("status") == "loading":
            track_path = None
            if now.get("source") == "local" and self.local.get("track_id"):
                track = LIBRARY.get(self.local["track_id"])
                track_path = track["path"] if track else None
            res = LYRICS.get(now.get("title", ""), now.get("artist", ""),
                             now.get("album", ""), now.get("duration", 0),
                             path=track_path,
                             online=bool(CONFIG.get("lyrics", {}).get("online", True)))
            self._lyr_key = key
            self._lyr_info = {"status": res.get("status"), "source": res.get("source", ""),
                              "lines": len(res.get("lines") or []), "reason": res.get("reason", "")}
        return self._lyr_info

    def snapshot(self):
        spotify = BRIDGE.get()
        # Tell the account poller whether it is even needed right now. Reading
        # Windows costs nothing; asking Spotify does.
        SPOTIFY.bridge_has = bool(spotify.get("has"))
        local_track = LIBRARY.get(self.local["track_id"]) if self.local["track_id"] else None

        local_view = None
        if local_track:
            local_view = {
                "source": "local",
                "source_label": "Local library",
                "title": local_track["title"],
                "artist": local_track["artist"],
                "album": local_track["album"],
                "art_url": f"/art/{local_track['id']}",
                "playing": bool(self.local["playing"]),
                "position": float(self.local["position"] or 0),
                "duration": float(self.local["duration"] or local_track["duration"] or 0),
            }

        account = SPOTIFY.get()
        # Two sources know what is playing. Windows (the SMTC bridge) reports
        # it for free, in real time, for anything playing on this PC. The
        # Spotify account only knows what its last poll said - once a minute at
        # best, and frozen entirely inside a rate-limit window - so its view
        # can be minutes old. The account leads only while it is fresh (it is
        # the one that knows the device name and has full-size art); the moment
        # it goes stale, Windows takes over. A stale account view is kept as a
        # last resort for playback on a phone or speaker, where Windows sees
        # nothing - get() has already dropped its "playing" claim by then.
        use_account = CONFIG["spotify"].get("use_account", True)
        # The account is only read while the queue window is open, so with it
        # closed its view is not kept up to date - and an old view is how a
        # song that ended long ago used to stay "playing". Windows alone
        # speaks then.
        live = SPOTIFY.active
        acct_has = bool(account.get("has")) and live
        account_view = None
        if acct_has and use_account:
            art = ""
            if account.get("art"):
                art = "/spotify/art?u=" + urllib.parse.quote(account["art"], safe="")
            device = account.get("device") or ""
            account_view = {
                "source": "spotify",
                "source_label": f"Spotify \u00b7 {device}" if device else "Spotify",
                "title": account["title"],
                "artist": account["artist"],
                "album": account["album"],
                "art_url": art,
                "playing": account["playing"],
                "position": account["position"],
                "duration": account["duration"],
            }
        bridge_view = None
        if spotify.get("has"):
            # A track change seen here is the free, immediate signal that the
            # queue moved on - let the account poller know instead of waiting.
            SPOTIFY.note_track((spotify.get("title"), spotify.get("artist")))
            art = f"/smtc/art?t={spotify['art_token']}" if spotify.get("has_art") else ""
            bridge_view = {
                "source": spotify.get("source", "system"),
                "source_label": spotify.get("app", "Spotify"),
                "title": spotify["title"],
                "artist": spotify["artist"],
                "album": spotify["album"],
                "art_url": art,
                "playing": spotify["playing"],
                "position": spotify["position"],
                "duration": spotify["duration"],
            }
        # The cover comes from Windows whenever Windows knows the track: it is
        # the picture Spotify itself hands the system, it costs no Spotify
        # call, and it is there whether or not the queue window is open. The
        # account's picture is only for playback Windows cannot see.
        if (account_view and bridge_view and bridge_view["art_url"]
                and SPOTIFY._same_track({"title": account_view["title"],
                                         "artist": account_view["artist"]},
                                        (bridge_view["title"], bridge_view["artist"]))):
            account_view["art_url"] = bridge_view["art_url"]
        if account_view and not account.get("stale"):
            spotify_view = account_view
        else:
            spotify_view = bridge_view or account_view

        mode = CONFIG.get("source_mode", "auto")
        if mode == "local":
            now = local_view
        elif mode == "spotify":
            now = spotify_view
        else:
            # Auto: whatever is actually making noise wins; local breaks ties.
            candidates = [v for v in (local_view, spotify_view) if v]
            playing = [v for v in candidates if v["playing"]]
            now = (playing or candidates or [None])[0]

        return {
            "now": now,
            "local": local_view,
            "spotify": spotify_view,
            "spotify_status": {
                "available": spotify.get("available"),
                "error": spotify.get("error", ""),
                "has": bool(spotify_view),
                "app": ("Spotify" if (acct_has and CONFIG["spotify"].get("use_account", True))
                        else spotify.get("app", "")),
                "can_next": acct_has or spotify.get("can_next", False),
                "can_prev": acct_has or spotify.get("can_prev", False),
                "account": {
                    "connected": account.get("connected", False),
                    "has": acct_has,
                    "device": account.get("device", "") if live else "",
                    "live": live,
                    "error": account.get("error", ""),
                    "client_id_set": account.get("client_id_set", False),
                    "redirect_uri": SPOTIFY.redirect_uri,
                },
            },
            "local_seek": self.local_seek,
            "local_cmd": self.local_cmd,
            "source_mode": mode,
            "spotify_account": {
                "shuffle": account.get("shuffle", False),
                "repeat": account.get("repeat", "off"),
            } if account.get("connected") else None,
            # The queue, the devices, the three windows' state and the lyrics
            # situation ride this broadcast too, so the deck and the queue
            # window read one model instead of each polling for it. Every one
            # of these is a cached, local read - nothing here waits on a network.
            "spotify_queue": SPOTIFY.peek_queue(),
            "spotify_devices": SPOTIFY.peek_devices(),
            "windows": COMPONENTS.statuses(),
            # The registry itself, the scenes and who is talking, so the deck,
            # the editor and every output read one model.
            "components": COMPONENTS.describe_all(),
            "scenes": SCENES.list(),
            "canvas": {"live": CONFIG["canvas"].get("live", ""),
                       "transition": CONFIG["canvas"].get("transition", "fade"),
                       "duration": CONFIG["canvas"].get("duration", 300),
                       "at": CANVAS_SWITCHED[0]},
            "voice": VOICE.snapshot(),
            # Which services are connected, never the messages themselves.
            "chat": CHAT.snapshot(),
            # How many commands there are and how they have gone - never the
            # log itself, which the editor asks for when it is open.
            "commands": COMMANDS.snapshot(),
            # Whether a Voice layer on the scene on air answers to anything:
            # the Live view shows Skip only then. Never the queue or the
            # counts, which move on every message (see _change_key).
            "tts": {"on_air": any(c.get("layer_type") == "speak" for c in live_layer_commands())},
            # How many requests are waiting - never the list, which the Live
            # view asks for while it is showing it.
            "requests": REQUESTS.snapshot(),
            # How many events have fired, never the events: they ride their own
            # feed, because a whole-state broadcast per alert is the mistake
            # the chat messages were kept away from.
            "alerts": ALERTS.snapshot(),
            # Whether a poll is open and what it asks - never the counts, which
            # move on every vote and go to the canvas over the bus instead.
            "polls": POLLS.snapshot(),
            "feeds": FEEDS.counts(),
            "lyrics_info": self._lyrics_info(now),
            # What the microphone is hearing, for the captions window and the
            # deck's status line. A cached read; the helper does the listening.
            "captions": CAPTIONS.get(),
            "captions_models": MODEL_STORE.status(),
            "captions_gpu": dict(GPU_STORE.status(), failed=gpu_failure()),
            "live": LIVE.snapshot_status(),
            # Fonts people added: the families for the pickers, and a version
            # every page watches to reload /fonts.css when the set changes.
            "fonts": FONT_STORE.families(),
            "fonts_v": FONT_STORE.version,
            "nowplaying": CONFIG["nowplaying"],
            "lyrics_cfg": CONFIG.get("lyrics", {}),
            "queue_cfg": CONFIG.get("queue", {}),
            "captions_cfg": CONFIG.get("captions", {}),
            "frames": {"screenframe": (CONFIG.get("screenframe") or {}).get("frame", {}),
                       "camframe": (CONFIG.get("camframe") or {}).get("frame", {})},
            # Ultra optimized, for every page: stop all motion, tick slowly.
            "ultra": ultra_on(),
            "server_time": time.time(),
        }

    # -- SSE ---------------------------------------------------------------

    def subscribe(self):
        import queue
        q = queue.Queue(maxsize=8)
        with self._lock:
            self._subs.append(q)
            last = self._last_payload
        if last:
            # A window that has just connected gets the current state at once,
            # rather than waiting for the next change.
            try:
                q.put_nowait(last)
            except Exception:
                pass
        return q

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    HEARTBEAT = 2.0      # seconds between sends when nothing changes
    sends = 0            # counted for /api/debug/mem
    sent_bytes = 0

    @staticmethod
    def _change_key(snap):
        """The snapshot minus what moves on its own: the clocks every window
        runs itself, the microphone meter's fine grain, ages counting up, and
        the counters that only ever climb. A playing position is reduced to
        where the song would have started, which holds still while it plays
        and jumps on a seek - so a seek is still sent at once, and steady
        playback is not."""
        s = dict(snap)
        s.pop("server_time", None)
        t = time.time()
        for k in ("now", "local", "spotify"):
            v = s.get(k)
            if isinstance(v, dict) and "position" in v:
                pos = float(v.get("position") or 0)
                s[k] = dict(v, position=round(pos - t if v.get("playing") else pos))
        if isinstance(s.get("captions"), dict):
            # The microphone meter flickers constantly; the deck asks for it
            # on its own while the meter is on screen (/api/captions/level).
            s["captions"] = {k: v for k, v in s["captions"].items() if k != "level"}
        if isinstance(s.get("spotify_queue"), dict):
            s["spotify_queue"] = {k: v for k, v in s["spotify_queue"].items()
                                  if k not in ("age", "retry_in")}
        # Totals that only go up, and that no page draws. A chat message ticks
        # chat.total, an alert ticks alerts.total, a command ticks one of
        # commands.ran/refused. Left in the key, any of them turns "send when
        # something a window shows has changed" back into a send every pump
        # tick: measured on the rig at one send per 0.41 s while chat was
        # busy, against 2.00 s idle - five times the traffic, for numbers
        # nothing reads. They stay in the payload, exactly as captions.level
        # does; they simply stop being a reason to send it.
        for name, climbing in (("chat", ("total",)),
                               ("alerts", ("total", "dropped")),
                               ("commands", ("ran", "refused")),
                               ("requests", ("queued", "refused"))):
            sub = s.get(name)
            if isinstance(sub, dict):
                s[name] = {kk: vv for kk, vv in sub.items() if kk not in climbing}
        return json.dumps(s, sort_keys=True, default=str)

    def _send(self, snap, key):
        payload = json.dumps(snap)
        with self._lock:
            self._last_payload, self._last_key, self._last_sent = payload, key, time.time()
            subs = list(self._subs)
            self.sends += 1
            self.sent_bytes += len(payload)
        for q in subs:
            try:
                q.put_nowait(payload)
            except Exception:
                pass  # slow client; it will catch the next one

    def broadcast(self):
        """Send now: something just happened (a setting, a press, a window)."""
        snap = self.snapshot()
        self._send(snap, self._change_key(snap))

    def broadcast_if_changed(self):
        """The pump's send: only when something a window shows has changed,
        or every HEARTBEAT seconds to keep every window's clock in step.
        Sending the whole state 2.5 times a second regardless had every
        window parsing and re-checking it for nothing."""
        snap = self.snapshot()
        key = self._change_key(snap)
        with self._lock:
            due = key != self._last_key or time.time() - self._last_sent >= self.HEARTBEAT
        if due:
            self._send(snap, key)


HUB = Hub()


def _pump():
    """Look for changes a few times a second; send only when there are."""
    while True:
        try:
            VOICE.tick()
            HUB.broadcast_if_changed()
        except Exception:
            pass
        time.sleep(0.4)


def launch_auth_window(url):
    """Show Spotify's approval page in its own window, not a stray browser tab.

    It uses the deck's browser profile, so a Spotify login is remembered and
    reconnecting later is a single click.
    """
    if not BROWSER:
        webbrowser.open(url)
        return False
    profile = os.path.join(CACHE, "chrome-deck")
    os.makedirs(profile, exist_ok=True)
    args = [BROWSER, f"--app={url}", f"--user-data-dir={profile}",
            "--window-size=560,760", "--no-first-run", "--no-default-browser-check"]
    subprocess.Popen(args, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


def _callback_page(title, message, done=False):
    dot = "#1db954" if done else "#f87171"
    closer = ("<script>setTimeout(function(){window.close()},1600)</script>"
              if done else "")
    return f"""<!doctype html><meta charset="utf-8"><title>{title}</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0b11;color:#f0f0f4;
font-family:Segoe UI,system-ui,sans-serif"><div style="text-align:center;max-width:32em;padding:2em">
<div style="width:10px;height:10px;border-radius:50%;background:{dot};margin:0 auto 1.2em;box-shadow:0 0 18px {dot}"></div>
<h1 style="font-size:1.3em;margin:0 0 .5em">{title}</h1><p style="color:#9a9aa8;line-height:1.5">{message}</p>
</div>{closer}</body>"""


# ================================================================= windows

# Every window the deck can put on stream is declared in components.py; the
# four names below are the same objects, kept for the code that grew up
# with them.
COMPONENTS = components.builtin(CACHE)
OVERLAY = COMPONENTS.get("np").overlay
LYRICS_WIN = COMPONENTS.get("lyrics").overlay
QUEUE_WIN = COMPONENTS.get("queue").overlay
CAPTIONS_WIN = COMPONENTS.get("captions").overlay
_log = lambda msg: print("  " + msg)
# Scenes get an output component each; the registry follows the store.
SCENES = scenes.SceneStore(os.path.join(CACHE, "scenes"), log=_log)
SCENES.on_change = lambda: (COMPONENTS.sync_scenes(SCENES.list()), HUB.broadcast())
COMPONENTS.sync_scenes(SCENES.list())
VOICE = voice.Voice(CAPTIONS, mic_name=CONFIG["captions"].get("mic"),
                    on_change=lambda: HUB.broadcast(), log=_log,
                    threshold=(CONFIG.get("voice") or {}).get("threshold", voice.THRESHOLD))
FEEDS = feeds.Feeds(log=_log)
# Chat in, from any service, in one shape (chat.py). Inert until something
# connects it; the messages ride their own feed rather than the state snapshot,
# which exists to send whole state rarely and would be the wrong pipe entirely.
CHAT = chat.ChatHub(log=_log)
# The event bus (alerts.py): what the app just did, on its way to the canvas.
# The producers never import it - the wiring is here, so S14's polls will be a
# caller and not a dependency.
ALERTS = alerts.AlertHub(log=_log)
# Chat, read out loud (T7). Inert until a Voice layer's command runs: the
# PowerShell helper starts on the first utterance and is let go when idle.
TTS = tts.Voice(log=_log)


def publish_tally(tally):
    """A poll's whole tally onto the bus, so the poll layer can draw the bars.

    The whole tally and never a delta: a page that joins halfway through a poll
    is then right at the next vote instead of adding up what it missed. polls.py
    never learns alerts.py exists - the same arrangement every other producer
    here has.
    """
    ALERTS.post(alerts.event("poll", tally.get("question", ""), title="poll",
                             detail={"poll": tally}))


POLLS = polls.Polls(publish=publish_tally, log=_log)


def command_poll(target, msg):
    """`!poll` run by someone allowed to: "close", or a question and its
    choices written as "Which song? | Sabotage | Intergalactic".

    This is the streamer's way in. A viewer voting is a different path
    entirely - polls.py watches the chat hub for `!1`, because a vote wants
    neither a role gate nor a cooldown.
    """
    text = str(target or "").strip()
    if text.lower() in ("close", "end", "stop"):
        res = POLLS.close()
        HUB.broadcast()
        return bool(res.get("ok")), res.get("reason") or "the poll is closed"
    parts = [p.strip() for p in text.split("|") if p.strip()]
    if len(parts) < 3:
        return False, "say it as: !poll Which song? | Sabotage | Intergalactic"
    res = POLLS.open(parts[0], parts[1:])
    HUB.broadcast()
    if not res.get("ok"):
        return False, res.get("reason") or "could not open that poll"
    return True, f"poll open: {parts[0]} - vote with !1 to !{len(parts) - 1}"


def alert_for_request(entry):
    """A song that actually went into the queue is worth showing; one that was
    refused or skipped is the streamer's business and not the viewers'."""
    if entry and entry.get("state") == "queued":
        track = entry.get("track") or {}
        ALERTS.say("request", f"{entry.get('user') or 'someone'} queued {track.get('title') or 'a song'}",
                   user=entry.get("user", ""), title=chat.symbols()[:1] + "queue",
                   detail={"artist": track.get("artist", ""), "uri": track.get("uri", "")})
    return entry


def command_scene(target):
    """The one command action that reaches outside: put a scene on air.

    A command names a scene the way a person would ("!gaming" -> "Gaming"),
    while set_live_scene wants an id - a config file full of ids would be
    unusable to whoever has to edit it. So match on the name, then fall back to
    treating the string as an id. Scene names are not unique (there are two
    called "P5 stress" on the test rig), so take the first in list order:
    predictable beats refusing to switch in the middle of a show.
    """
    want = (target or "").strip().lower()
    if not want:
        return False, "that command does not say which scene"
    for s in SCENES.list():
        if (s.get("name") or "").strip().lower() == want:
            res = set_live_scene(s["id"])
            if res.get("ok"):
                HUB.broadcast()
                return True, f"{s['name']} is on air"
            return False, res.get("reason") or "could not switch"
    res = set_live_scene(target)
    if res.get("ok"):
        HUB.broadcast()
        return True, "on air"
    return False, res.get("reason") or "no scene by that name"


# What `!something` is allowed to do (commands.py). The engine watches the chat
# hub in process rather than subscribing to it like a page would: this is not a
# feed to a browser, it is the app reacting to its own messages, and a watcher
# is called directly instead of going through a queue that can drop.
def spotify_find(text):
    """Look a request up. Named rather than a lambda so the rig's test hook has
    something to put back when it is finished faking."""
    ok, found = SPOTIFY.search(text, limit=1)
    return (True, found[0]) if ok and found else (False, found if isinstance(found, str) else "")


def spotify_enqueue(uri):
    return SPOTIFY.add_to_queue(uri)


# Song requests (songreq.py): the song half of `!queue`. Who may ask, and how
# often, stays with the command engine - asking that question in two places is
# how the two answers drift apart.
REQUESTS = songreq.Store(find=spotify_find, enqueue=spotify_enqueue,
                         rules=CONFIG.get("requests"), log=_log)


def command_request(msg):
    """`!queue something`. By the time this runs the engine has already decided
    that this person may ask and is not asking too often; what is left is
    whether the song itself is allowed."""
    entry = REQUESTS.ask(msg)
    track = entry.get("track") or {}
    what = (f"{track.get('title', '')} - {track.get('artist', '')}".strip(" -")
            or entry.get("text") or "that")
    HUB.broadcast()
    alert_for_request(entry)
    if entry["state"] == "queued":
        return True, f"queued {what}"
    if entry["state"] == "pending":
        return True, f"{what} is waiting to be let through"
    return False, entry.get("reason") or "no"


def command_gif(asset, msg):
    """Put a picture on the canvas (T2).

    A kind of its own rather than "command", so an effect layer can show
    pictures without also firing on every command that happens to carry a
    response. The picture rides in `detail`, which means one effect layer
    serves every gif command instead of needing one layer each - and a
    command with no picture of its own is not a failure, because the layer
    falls back to whatever it was given.

    Nothing is returned as text, and that is deliberate. `_record` keeps
    whatever comes back as the command's response (commands.py:249), and
    `after_command` posts a second alert for any command that has one - so a
    sentence here would put the picture on screen and an alert card beside
    it, off one command. The log still shows that it ran.
    """
    user = (msg.get("user") or {}).get("name") or ""
    name = chat.symbols()[:1] + (msg.get("command") or "")
    ALERTS.say("gif", (user + " ran " + name).strip(), user=user, title=name,
               detail={"asset": str(asset or "")})
    return True, ""


def command_sound(asset, msg):
    """Play a clip on the canvas - `command_gif`'s twin, and for the same
    reasons: its own kind so a layer can listen for sound without firing on
    every command, the clip in `detail` so one layer serves every sound
    command, and no text back so one command stays one alert."""
    user = (msg.get("user") or {}).get("name") or ""
    name = chat.symbols()[:1] + (msg.get("command") or "")
    ALERTS.say("sound", (user + " ran " + name).strip(), user=user, title=name,
               detail={"sound": str(asset or "")})
    return True, ""


def stop_everything(by=""):
    """T10's one control: what chat put on the stream comes off it now, and
    nothing more goes on until somebody resumes.

    Both halves, because either alone fails at the moment it is needed.
    Clearing without pausing lasts until the next message of a flood; pausing
    without clearing leaves the clip that made you reach for the button
    playing to the end. Polls keep counting - a vote is not an effect, and
    nothing a viewer does to a poll reaches the stream except its bars.
    """
    COMMANDS.set_paused(True)
    ALERTS.say("stop", "", user=by, title="stop")
    HUB.broadcast()
    _log("commands: stopped" + (f" by {by}" if by else "") + " - effects cleared, commands paused")


def resume_commands(by=""):
    COMMANDS.set_paused(False)
    HUB.broadcast()
    _log("commands: resumed" + (f" by {by}" if by else ""))


def command_stop(target, msg):
    """The same control as a command, for the moderators. "resume" resumes;
    anything else stops, so a mistyped target can never leave a stop command
    doing nothing. No text back, for the reason command_gif gives: a response
    becomes an alert card, and a stop that put a card on stream would be a
    strange way to clear it."""
    by = (msg.get("user") or {}).get("name") or ""
    if str(target or "").strip().lower() == "resume":
        resume_commands(by)
    else:
        stop_everything(by)
    return True, ""


_LAYER_CMDS = {"key": None, "cmds": []}


def live_layer_commands():
    """T11: what the layers of the scene on air answer to in chat.

    Asked on every command rather than rebuilt on events, because a scene
    changes in more ways than there are hooks - a switch, a save, an undo, a
    restore, an import over the live one - and a hook missed is a command still
    answering for a layer that is gone. Cached on the scene's id and revision,
    which every one of those moves, so a chat message costs a lookup.

    Only the scene on air: a layer on a scene nobody is watching can show
    nothing and play nothing, so it answers to nothing either.
    """
    sid = CONFIG.get("canvas", {}).get("live", "")
    key = (sid, SCENES.revisions().get(sid)) if sid else None
    if key != _LAYER_CMDS["key"]:
        _LAYER_CMDS["cmds"] = commands.scene_commands(SCENES.get(sid)) if sid else []
        _LAYER_CMDS["key"] = key
    return _LAYER_CMDS["cmds"]


def live_layer(layer_id):
    """(the live scene's id, that layer) - or the id and None if it has gone."""
    sid = CONFIG.get("canvas", {}).get("live", "")
    for layer in ((SCENES.get(sid) if sid else None) or {}).get("layers") or []:
        if layer.get("id") == layer_id:
            return sid, layer
    return sid, None


def command_speak(layer_id, msg):
    """A Voice layer's command (T7): what was typed after it, read out.

    Everything that can refuse does so here, before the command is logged as
    run - an empty message, a blocked word, a full queue - so the log says why
    and the effects budget gets its place back (commands.py hands it back for
    any failure). The clip is made on the voice's own thread; the event that
    tells the layer to play it goes out when it exists, addressed like any
    layer command, with the words as they will be heard.
    """
    sid, layer = live_layer(layer_id)
    if not layer:
        return False, "that Voice layer is not on air any more"
    p = layer.get("props") or {}
    text, why = tts.clean_text(msg.get("args"), p.get("maxlen", tts.MAXLEN), p.get("blocked", ""))
    if text is None:
        return False, why
    user = (msg.get("user") or {}).get("name") or ""
    said = f"{user} says: {text}" if user and p.get("sayname", True) is not False else text
    name = chat.symbols()[:1] + (msg.get("command") or "")

    def made(clip_id, ok, error):
        if ok:
            ALERTS.say("speak", said, user=user, title=name,
                       detail={"layer": str(layer_id), "scene": sid,
                               "clip": f"/api/tts/{clip_id}.wav", "said": said})
    ok, res = TTS.say(said, voice=p.get("voice") or "", rate=p.get("rate") or 0, done=made)
    return (True, "") if ok else (False, res)


def post_gift(user, gift, coins, count=1, avatar=""):
    """One finished gift on the bus (T8), in the shape T6's TikTok reader will
    post it. `coins` is the total after a combo is coalesced - TikTok streams
    repeats as increments with a "finished" flag, and only the finish belongs
    here. The avatar is a local asset id or nothing: a picture this app does
    not hold is dropped rather than passed on, and scene.js refuses remote
    URLs outright (DECISIONS, "A scene that could call home")."""
    def num(value, lo, hi, default):
        try:
            return max(lo, min(hi, int(value)))
        except (TypeError, ValueError):
            return default
    user = str(user or "Someone").strip()[:40] or "Someone"
    gift = str(gift or "a gift").strip()[:40] or "a gift"
    coins = num(coins, 0, 1_000_000, 1)
    count = num(count, 1, 100_000, 1)
    avatar = str(avatar or "")
    if avatar and not ASSET_STORE.path(avatar):
        avatar = ""
    text = f"{user} sent {gift}" + (f" x{count}" if count > 1 else "")
    return ALERTS.say("gift", text, user=user, title=gift,
                      detail={"user": user, "gift": gift, "coins": coins, "count": count, "avatar": avatar})


def command_effect(layer_id, msg):
    """A layer's own command (T11). The layer already holds its picture and
    its clip, so the event only says which layer - and on which scene, so a
    page showing some other scene with a layer of the same id stays still.
    No text back, for command_gif's reason. A Voice layer's command goes to
    command_speak instead: it has words to make into a clip first."""
    kind = next((c.get("layer_type") for c in live_layer_commands() if c.get("target") == layer_id), "")
    if kind == "speak":
        return command_speak(layer_id, msg)
    user = (msg.get("user") or {}).get("name") or ""
    name = chat.symbols()[:1] + (msg.get("command") or "")
    ALERTS.say("effect", (user + " ran " + name).strip(), user=user, title=name,
               detail={"layer": str(layer_id or ""),
                       "scene": CONFIG.get("canvas", {}).get("live", "")})
    return True, ""


COMMANDS = commands.Engine(run_scene=command_scene, run_request=command_request,
                           run_poll=command_poll, run_gif=command_gif,
                           run_sound=command_sound, run_stop=command_stop,
                           run_effect=command_effect, layers=live_layer_commands, log=_log)
COMMANDS.load((CONFIG.get("commands") or {}).get("list") or [])
# Written back as kept, for the reason command_symbol gives: a config holding a
# budget the engine is not honoring would be a setting that lies.
CONFIG.setdefault("commands", {})["budget"] = COMMANDS.set_budget(
    (CONFIG.get("commands") or {}).get("budget"))


def command_symbol():
    """Apply the saved symbol and write back what was accepted. A config
    holding a symbol the app is not honoring would be a setting that lies -
    the panel reads this value to label every command it shows."""
    kept = chat.set_symbols((CONFIG.get("commands") or {}).get("symbol") or chat.SYMBOL_DEFAULT)
    CONFIG.setdefault("commands", {})["symbol"] = kept
    return kept


command_symbol()
def after_command(msg):
    """Run the command, then tell the canvas about it.

    Only a command that ran becomes an alert. A refusal or a cooldown is worth
    writing in the log the streamer reads, and is not worth putting on screen
    for everybody watching somebody else be turned down.
    """
    entry = COMMANDS.handle(msg)
    if entry and entry.get("outcome") == "ran" and entry.get("response"):
        ALERTS.say("command", entry["response"], user=entry.get("user", ""),
                   # On stream, so it shows the symbol actually in force. One
                   # of them, not all: "!/queue" would read as a typo.
                   title=chat.symbols()[:1] + entry.get("command", ""))
    return entry


CHAT.watch(after_command)
# Beside the command engine, not behind it: a vote is not a command anyone
# registered, and it wants neither a role gate nor a cooldown - just one each.
CHAT.watch(POLLS.handle)
CANVAS_SWITCHED = [0.0]         # when the live scene last changed


def capture_flags_for(page):
    """The shared Chrome can auto-select one capture source per launch. If
    the scene about to open wants a window or screen through the browser,
    this is the flag that names it."""
    sid = ""
    if page.startswith("scene.html?id="):
        sid = page.split("=", 1)[1]
    elif page.startswith("scene.html?follow"):
        sid = CONFIG["canvas"].get("live", "")
    scene = SCENES.get(sid) if sid else None
    for layer in (scene or {}).get("layers", []):
        if layer.get("type") != "capture" or (layer.get("props") or {}).get("mode") == "native":
            continue
        src = (layer.get("props") or {}).get("source") or {}
        if src.get("kind") == "monitor":
            return ["--auto-select-desktop-capture-source=Screen"]
        if src.get("title"):
            return [f"--auto-select-window-capture-source-by-title={src['title']}"]
    return []


AUDIO = [None]                  # the native mixer while streaming


def live_status():
    return dict(LIVE.status(), native=NATIVE.status(),
                audio=AUDIO[0].status() if AUDIO[0] else {"running": False},
                config=CONFIG.get("live", {}))


def live_start(data):
    """Go LIVE: the RTMP publisher, then the native capture of the output
    window and the native audio mixer - or, for the browser path, the page
    does capture and audio itself."""
    cfg = CONFIG.setdefault("live", {})
    for key in ("preset", "source"):
        if data.get(key):
            cfg[key] = str(data[key])
    if isinstance(data.get("audio"), dict):
        _merge_into(cfg.setdefault("audio", {}), data["audio"])
    save_config(CONFIG)
    preset = live.PRESETS.get(cfg.get("preset") or "720p30") or live.PRESETS["720p30"]
    res = LIVE.start(data.get("url"), data.get("key"), remember=bool(data.get("remember")),
                     preset=cfg.get("preset"))
    if not res.get("ok"):
        return res
    if cfg.get("source") == "page":
        LIVE.restamp_audio = False
        return dict(res, path="page")
    comp = COMPONENTS.get(cfg.get("source") or "live")
    if not comp:
        LIVE.stop()
        return {"ok": False, "error": f"no output called {cfg.get('source')!r}"}
    if not comp.overlay.is_open():
        opened = window_action(comp.overlay, comp.config(CONFIG), comp.page, "open", {})
        if not opened.get("ok"):
            LIVE.stop()
            return {"ok": False, "error": "the output window would not open: " + str(opened.get("reason", ""))}
    hwnd = comp.overlay.host.hwnd if comp.overlay.host and comp.overlay.host.alive() else None
    if not hwnd:
        LIVE.stop()
        return {"ok": False, "error": "the output window is not hosted, so it cannot be captured"}
    LIVE.restamp_audio = False
    LIVE.on_reconnect = NATIVE.force_keyframe
    NATIVE.start(hwnd=hwnd, fps=preset["fps"], kbps=preset["kbps"], sources=live_native_sources())
    if not NATIVE.wait_ready():
        # No capture or no encoder: say so now rather than stream silence.
        why = NATIVE.error or "the output window gave no frame"
        live_stop()
        return {"ok": False, "error": "the output could not be captured: " + why}
    a = cfg.get("audio") or {}
    if a.get("mic", True) or a.get("system"):
        mixer = audio_mod.AudioMixer(LIVE, mic=bool(a.get("mic", True)), mic_device=a.get("mic_device", ""),
                                     system=bool(a.get("system")), kbps=live.AUDIO_KBPS, log=_log)
        for src in ("mic", "system"):
            mixer.set(src, gain=(a.get("gain") or {}).get(src), mute=(a.get("mute") or {}).get(src))
        mixer.start()
        AUDIO[0] = mixer
    HUB.broadcast()
    return dict(res, path="native", source=comp.id, size=list(comp.size))


def live_stop():
    NATIVE.stop()
    if AUDIO[0]:
        AUDIO[0].stop()
        AUDIO[0] = None
    LIVE.restamp_audio = False
    res = LIVE.stop()
    # End Live, wherever Stop was pressed: the panel, the deck strip, the
    # remote, or quitting. Closing the RTMP side only would leave the live open
    # at TikTok with nothing arriving on it. A no-op when we did not open one.
    ended = TIKTOK.end()
    HUB.broadcast()
    return dict(res, tiktok_ended=bool(ended.get("ended")))


def tiktok_go_live(data):
    """The TikTok tab's Go LIVE: open the live at TikTok's end, keep what it
    hands back the way a pasted key is kept, and stream to it.

    Two buttons became one on purpose - opening a live nobody streams to, or
    streaming at a key no live is listening on, are both halfway states worth
    not having."""
    res = TIKTOK.start(data.get("title", ""), data.get("category", ""), bool(data.get("mature")))
    if not res.get("ok"):
        return res
    LIVE.vault.save(res["url"], res["key"])
    started = live_start(dict(data, url=res["url"], key=res["key"]))
    if not started.get("ok"):
        TIKTOK.end()        # nothing is going out on it: do not leave it open
        return started
    return dict(started, live_id=res.get("live_id"))


def live_audio(data):
    """Gains and mutes, live, and remembered; which sources and which
    microphone, for the next start (P11's LIVE panel)."""
    a = CONFIG.setdefault("live", {}).setdefault("audio", {})
    src = data.get("source")
    if src in ("mic", "system"):
        if "gain" in data:
            a.setdefault("gain", {})[src] = max(0.0, min(4.0, float(data["gain"])))
        if "mute" in data:
            a.setdefault("mute", {})[src] = bool(data["mute"])
        if AUDIO[0]:
            AUDIO[0].set(src, gain=data.get("gain"), mute=data.get("mute"))
    for k in ("mic", "system"):
        if isinstance(data.get(k), bool):
            a[k] = data[k]
    if "mic_device" in data:
        a["mic_device"] = str(data.get("mic_device") or "")[:200]
    save_config(CONFIG)
    return {"ok": True, "audio": a, "live": AUDIO[0].status() if AUDIO[0] else None}


REMOTE_TITLE = "Awesome Streaming Deck - Scene remote"


def remote_on_top(on, wait=5.0):
    """Put the scene remote's window on top of the others, or not. Chrome
    takes a moment to open it, so look for it for a little while."""
    import winwin
    deadline = time.time() + wait
    while True:
        hwnd = winwin.find_window(REMOTE_TITLE)
        if hwnd:
            winwin.set_topmost(hwnd, on)
            return True
        if time.time() > deadline:
            return False
        time.sleep(0.2)


def remember_outputs():
    """Which outputs are open right now, and whether parked. A restart brings
    them back the same way, and the watchdog re-opens one that dies."""
    for c in COMPONENTS:
        if c.group == "canvas":
            c.overlay.on_user_closed = functools.partial(forget_output, c.id)
    canvas = CONFIG.setdefault("canvas", {})
    canvas["reopen"] = {c.id: {"parked": bool(c.overlay.status().get("parked"))}
                        for c in COMPONENTS if c.group == "canvas" and c.overlay.is_open()}
    save_config(CONFIG)


def forget_output(cid):
    """The user closed an output by hand (Alt+F4, the taskbar): it stays
    closed. The watchdog brings back only what dies on its own - a Chrome
    that crashed, a page gone quiet, the outputs of the last run."""
    reopen = CONFIG.get("canvas", {}).get("reopen") or {}
    if cid in reopen:
        reopen.pop(cid, None)
        save_config(CONFIG)
    _log(f"outputs: {cid} was closed by hand; it stays closed"
         + ("; the stream holds its last frame until the output is opened again"
            if cid == "live" and LIVE.state in ("connecting", "live", "reconnecting") else ""))
    HUB.broadcast()


def open_output(cid, parked=False):
    comp = COMPONENTS.get(cid)
    if not comp:
        return {"ok": False, "reason": "no such output"}
    comp.overlay.on_user_closed = functools.partial(forget_output, cid)
    res = window_action(comp.overlay, comp.config(CONFIG), comp.page, "open", {})
    if res.get("ok") and parked:
        window_action(comp.overlay, comp.config(CONFIG), comp.page, "park", {})
    return res


def rejoin_live():
    """The live output was opened again mid-stream: capture the new window
    into the running stream. The engine's clock carries on, so the viewer
    sees a still for a moment, then the picture again."""
    comp = COMPONENTS.get("live")
    host = comp.overlay.host if comp else None
    hwnd = host.hwnd if host and host.alive() else None
    if not hwnd:
        return False
    preset = live.PRESETS.get(CONFIG.get("live", {}).get("preset") or "720p30") or live.PRESETS["720p30"]
    NATIVE.stop()
    NATIVE.start(hwnd=hwnd, fps=preset["fps"], kbps=preset["kbps"], sources=live_native_sources())
    ok = NATIVE.wait_ready()
    _log("live: the video re-joined the stream from the re-opened output" if ok
         else f"live: the video could not re-join ({NATIVE.error})")
    return ok


def _watch_outputs():
    """Every two seconds: an output that should be open but is not gets
    opened again (three tries in two minutes, then it is left closed), a
    window whose page has stopped talking to us is rebuilt, and the live
    output re-joins the stream. At start this is also what brings back the
    outputs of the last run."""
    tries = {}
    quiet_since = {}
    while True:
        time.sleep(2)
        try:
            wanted = dict(CONFIG.get("canvas", {}).get("reopen") or {})
            for cid, how in wanted.items():
                comp = COMPONENTS.get(cid)
                if not comp:
                    continue
                now = time.time()
                if comp.overlay.is_open():
                    # Open, but is anyone home? A page holds a feed for as
                    # long as it lives; fifteen quiet seconds means it is gone.
                    if FEEDS.has_page(comp.page):
                        quiet_since.pop(cid, None)
                        continue
                    if now - quiet_since.setdefault(cid, now) < 15:
                        continue
                    action, why = "rebuild", "its page has gone quiet"
                else:
                    action, why = "open", "it is gone"
                quiet_since.pop(cid, None)
                recent = [t for t in tries.get(cid, []) if now - t < 120]
                if len(recent) >= 3:
                    _log(f"outputs: {cid} keeps dying; leaving it closed")
                    CONFIG["canvas"]["reopen"].pop(cid, None)
                    save_config(CONFIG)
                    tries.pop(cid, None)
                    try:
                        comp.overlay.close()
                    except Exception:
                        pass
                    HUB.broadcast()
                    continue
                tries[cid] = recent + [now]
                _log(f"outputs: {cid}: {why}; opening it again")
                if action == "rebuild":
                    res = window_action(comp.overlay, comp.config(CONFIG), comp.page, "rebuild", {})
                else:
                    res = open_output(cid, parked=bool(how.get("parked")))
                if res.get("ok") and cid == "live" and LIVE.state in ("connecting", "live", "reconnecting"):
                    rejoin_live()
                HUB.broadcast()
        except Exception as exc:
            _log(f"outputs: watchdog error: {exc}")


def live_native_sources():
    """What the server composites into the stream: the live scene's native
    camera and capture layers (see scenes.native_sources)."""
    sid = CONFIG.get("canvas", {}).get("live", "")
    return scenes.native_sources(SCENES.get(sid)) if sid else []


def refresh_native_sources(sid=None):
    """After a live switch or a save of the live scene: the encoder thread
    picks the new sources up at its next tick."""
    if sid and sid != CONFIG.get("canvas", {}).get("live", ""):
        return
    if NATIVE.status().get("running"):
        NATIVE.set_sources(live_native_sources())


def streaming_size():
    """The size the stream is locked to while the native path runs, or None."""
    st = NATIVE.status()
    if LIVE.state in ("connecting", "live", "reconnecting") and st.get("running") and st.get("size"):
        w, h = st["size"].split("x")
        return int(w), int(h)
    return None


def set_live_scene(sid, transition=None, duration=None):
    """Point the live output at a scene; resize it if the format differs."""
    scene = SCENES.get(sid) if sid else None
    if sid and not scene:
        return {"ok": False, "reason": "no such scene"}
    locked = streaming_size()
    if scene and locked and (scene["width"], scene["height"]) != locked:
        return {"ok": False, "reason": f"the stream is running at {locked[0]}x{locked[1]}; "
                                       f"{scene['name']} is {scene['width']}x{scene['height']} - stop the stream first"}
    canvas = CONFIG.setdefault("canvas", {})
    canvas["live"] = sid or ""
    if transition in ("fade", "cut"):
        canvas["transition"] = transition
    if duration is not None:
        canvas["duration"] = max(60, min(3000, int(duration)))
    CANVAS_SWITCHED[0] = time.time()
    save_config(CONFIG)
    comp = COMPONENTS.get("live")
    if scene and comp:
        size = (scene["width"], scene["height"])
        cfg = comp.config(CONFIG)
        if comp.size != size or (cfg.get("width"), cfg.get("height")) != size:
            comp.size = size
            cfg["width"], cfg["height"] = size
            if comp.overlay.is_open():
                comp.overlay.apply(width=size[0], height=size[1])
    refresh_native_sources()
    HUB.broadcast()
    return {"ok": True, "live": canvas["live"], "transition": canvas.get("transition"),
            "duration": canvas.get("duration")}
LYRICS = Lyrics(CACHE)
SPOTIFY = SpotifyAccount(CACHE, f"http://127.0.0.1:{CONFIG['port']}/spotify/callback")
SPOTIFY.configure(CONFIG["spotify"].get("client_id", ""))
BROWSER = overlay_mod.find_browser()
# Going LIVE from the app: the output page encodes, this pushes RTMP.
LIVE = live.LiveEngine(CACHE, log=lambda msg: print("  " + msg))
LIVE.on_change = lambda: HUB.broadcast()
LIVE.local_only = TEST_RIG          # NEVER GO LIVE from the rig: see TEST_RIG
NATIVE = nativelive.NativeVideo(LIVE, log=lambda msg: print("  " + msg))
# TikTok's own side of the show: the key Go LIVE asks for, and the session
# End Live closes. The engine above streams; this opens and shuts the live.
TIKTOK = tiktok_live.TikTokBridge(CACHE, log=lambda msg: print("  " + msg))


def window_action(ov, cfg, page, action, data):
    """Everything a pop-out window can be asked to do, for either window."""
    if action == "metrics":
        ov.report_metrics(data)
        return {"ok": True}
    if action == "open":
        url = f"http://127.0.0.1:{CONFIG['port']}/{page}"
        if not COMPONENTS.any_open():
            # No pop-out Chrome is running, so its profile can be seeded: the
            # camera and the microphone are allowed for our own pages, and a
            # scene's capture source can be named for the launch.
            components.seed_media_permissions(os.path.join(CACHE, overlay_mod.SHARED_PROFILE),
                                              CONFIG["port"], _log)
            overlay_mod.LAUNCH_EXTRA[:] = capture_flags_for(page)
        res = ov.open(url, cfg["width"], cfg["height"], cfg["x"], cfg["y"],
                      borderless=bool(cfg.get("borderless", True)),
                      topmost=bool(cfg.get("topmost", True)))
        sur = CONFIG["nowplaying"].get("surround") or {}
        ov.set_backdrop(sur.get("color", "#000000")
                        if sur.get("mode") == "solid" else "#000000")
        ov.remember_for_rebuild(url, cfg)
        if ov is QUEUE_WIN:
            SPOTIFY.set_active(True)          # the one thing the account is for
        return res
    if action == "close":
        ok = ov.close()
        if ov is QUEUE_WIN:
            SPOTIFY.set_active(False)
        return {"ok": ok}
    if action == "heal":
        url = f"http://127.0.0.1:{CONFIG['port']}/{page}"
        return ov.heal(url, cfg)
    if action == "rebuild":
        url = f"http://127.0.0.1:{CONFIG['port']}/{page}"
        if not ov.is_open():
            return {"ok": True, "state": "closed"}
        return dict(ov.rebuild(url, cfg), state="rebuilt")
    if action == "apply":
        rect = ov.apply(width=data.get("width", cfg.get("width")),
                        height=data.get("height", cfg.get("height")),
                        topmost=data.get("topmost"))
        if rect is None:
            return {"ok": False, "reason": "window not open"}
        cfg.update({"x": rect["x"], "y": rect["y"], "width": rect["w"], "height": rect["h"]})
        save_config(CONFIG)
        return {"ok": True, "rect": rect}
    if action == "resize":
        rect = ov.resize_by(data.get("dw", 0), data.get("dh", 0))
        if rect:
            cfg.update({"width": rect["w"], "height": rect["h"]})
            save_config(CONFIG)
            HUB.broadcast()
        return {"ok": bool(rect), "rect": rect}
    if action == "snap":
        status = ov.status()
        if not status["open"]:
            return {"ok": False, "reason": "window not open"}
        # Snap by the window's real footprint, frame included when it has one.
        rect = status.get("outer") or status["rect"] or {"w": cfg["width"], "h": cfg["height"]}
        sw, sh = winwin.screen_size()
        margin, corner = 32, data.get("corner", "tl")
        x = margin if corner in ("tl", "bl") else sw - rect["w"] - margin
        y = margin if corner in ("tl", "tr") else sh - rect["h"] - margin - 48
        ov.move(x, y)
        cfg.update({"x": x, "y": y})
        save_config(CONFIG)
        return {"ok": True, "x": x, "y": y}
    if action == "nudge":
        rect = ov.nudge(data.get("dx", 0), data.get("dy", 0))
        if rect:
            cfg.update({"x": rect["x"], "y": rect["y"]})
            save_config(CONFIG)
        return {"ok": bool(rect), "rect": rect}
    if action == "edge":
        rect = ov.resize_edge(data.get("edge", ""), data.get("dx", 0), data.get("dy", 0))
        if rect:
            cfg.update({"x": rect["x"], "y": rect["y"],
                        "width": rect["w"], "height": rect["h"]})
            save_config(CONFIG)
            HUB.broadcast()
        return {"ok": bool(rect), "rect": rect}
    if action == "park":
        # Off every screen, still rendering: a capture sees it, nobody else.
        rect = ov.park()
        return {"ok": bool(rect), "rect": rect, "parked": True}
    if action == "unpark":
        rect = ov.unpark(cfg.get("x"), cfg.get("y"))
        return {"ok": bool(rect), "rect": rect, "parked": False}
    if action == "minimize":
        return {"ok": ov.minimize(), "minimized": True}
    if action == "restore":
        ok = ov.restore()
        if ok and cfg.get("topmost", True):
            ov.apply(topmost=True)
        return {"ok": ok, "minimized": False}
    return {"ok": False, "reason": "unknown action"}


def launch_deck(url, width=1180, height=820):
    """Open the deck as a Chrome app window: no tabs, no address bar."""
    if not BROWSER:
        webbrowser.open(url)
        return False
    profile = os.path.join(CACHE, "chrome-deck")
    os.makedirs(profile, exist_ok=True)
    args = [BROWSER, f"--app={url}", f"--user-data-dir={profile}",
            f"--window-size={int(width)},{int(height)}",
            "--no-first-run", "--no-default-browser-check",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--autoplay-policy=no-user-gesture-required"]
    subprocess.Popen(args, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


# ================================================================= folder picker

def pick_folder():
    """Native Windows folder chooser, run on its own Tk thread."""
    result = {}

    def run():
        try:
            import tkinter
            from tkinter import filedialog
            root = tkinter.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            path = filedialog.askdirectory(title="Choose a music folder")
            try:
                root.destroy()
            except Exception:
                pass
            result["path"] = path or ""
        except Exception as exc:
            result["error"] = str(exc)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(180)
    return result


# ================================================================= http

class QuietServer(ThreadingHTTPServer):
    """A browser closing mid-request is normal here, not something to print."""

    daemon_threads = True
    # On Windows, address reuse lets a second copy bind the port the first is
    # already serving, so both would run (two media bridges, two microphones
    # listening). Without it the second bind fails and that copy just opens
    # the deck; a quick restart still binds fine.
    allow_reuse_address = False

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "StreamingDeck"

    def log_message(self, *_args):
        pass  # the console is for status, not a request log

    # -- helpers -----------------------------------------------------------

    def _send(self, code, body=b"", mime="application/json", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj), "application/json")

    def _trusted(self):
        """Only this machine's own pages may use the server (see guard.py)."""
        return guard.trusted(self.headers.get("Host"), self.headers.get("Origin"), CONFIG.get("port", 8713))

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    def _spotify_command(self, cmd):
        """Drive Spotify by whichever route is actually live.

        The account can reach a phone or a speaker; the Windows bridge only
        knows about this PC but needs no login. Both /api/transport and
        /api/spotify/<cmd> want exactly this decision, so it lives once.
        """
        account = SPOTIFY.get()
        use_account = CONFIG["spotify"].get("use_account", True)
        if SPOTIFY.active:
            via_account = bool(account.get("has")) and use_account
        else:
            # The queue window is closed, so the account is not being read.
            # A press still has to reach the music: through Windows when it
            # plays on this PC (no Spotify call at all), through the account
            # only when it plays somewhere Windows cannot see.
            via_account = (use_account and SPOTIFY.connected()
                           and not BRIDGE.get().get("has"))
        if via_account:
            res = SPOTIFY.command(cmd)
            if res.get("ok"):
                HUB.broadcast()
            return res
        return {"ok": BRIDGE.command(cmd)}

    def _serve_static(self, name):
        safe = os.path.basename(name)
        path = os.path.join(WEB, safe)
        if not os.path.isfile(path):
            return self._send(404, "not found", "text/plain")
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if safe.endswith(".js"):
            mime = "text/javascript"
        with open(path, "rb") as f:
            self._send(200, f.read(), mime + "; charset=utf-8")

    def _serve_range(self, path, mime):
        """Byte-range aware file streaming - required for seeking in <audio>."""
        try:
            size = os.path.getsize(path)
        except OSError:
            return self._send(404, "not found", "text/plain")

        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            first, _, last = rng[6:].split(",")[0].partition("-")
            try:
                if first.strip():
                    start = int(first)
                    if last.strip():
                        end = min(int(last), size - 1)
                elif last.strip():
                    start = max(0, size - int(last))
            except ValueError:
                start, end = 0, size - 1
            if start > end or start >= size:
                return self._send(416, b"", mime,
                                  {"Content-Range": f"bytes */{size}"})
            status = 206

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command == "HEAD":
            return

        try:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(131072, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass  # Chrome cancels range requests constantly; not an error

    # -- GET ---------------------------------------------------------------

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._trusted():
            return self.send_error(403, "Forbidden")
        url = urlparse(self.path)
        path = url.path
        query = parse_qs(url.query)

        if path in ("/", "/index.html"):
            return self._send(302, b"", "text/plain", {"Location": "/deck.html"})

        if path == "/favicon.ico":
            return self._send(204)

        if path.startswith("/audio/"):
            track = LIBRARY.get(path.split("/")[-1])
            if not track or not os.path.isfile(track["path"]):
                return self._send(404, "not found", "text/plain")
            ext = os.path.splitext(track["path"])[1].lower()
            return self._serve_range(track["path"], MIMES.get(ext, "audio/mpeg"))

        if path.startswith("/art/"):
            track = LIBRARY.get(path.split("/")[-1])
            if not track:
                return self._send(404, "no art", "text/plain")
            art = tags.read_art(track["path"])
            if not art:
                return self._send(404, "no art", "text/plain")
            mime, data = art
            return self._send(200, data, mime, {"Cache-Control": "max-age=600"})

        if path.startswith("/asset/"):
            asset = ASSET_STORE.path(path[len("/asset/"):])
            if not asset:
                return self._send(404, "no asset", "text/plain")
            with open(asset, "rb") as f:
                data_bytes = f.read()
            # The store's own table first, and the OS only as a fallback:
            # mimetypes reads the registry on Windows, so a machine missing an
            # association would get the old "image/png" default - and with
            # nosniff set below, a sound served as a picture simply never
            # plays, with nothing said anywhere. This ships as an .exe to
            # other people's machines, so that is not hypothetical.
            ext = os.path.splitext(asset)[1].lower()
            mime = (ASSET_STORE.OK_EXT.get(ext)
                    or mimetypes.guess_type(asset)[0] or "application/octet-stream")
            # A picture can come from someone else's scene now (an import): an
            # SVG opened on its own must not run script on this origin.
            extra = {"Cache-Control": "max-age=86400", "X-Content-Type-Options": "nosniff"}
            if asset.lower().endswith(".svg"):
                extra["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"
            return self._send(200, data_bytes, mime, extra)

        if path == "/api/assets":
            return self._json({"assets": ASSET_STORE.list((query.get("kind") or [None])[0])})

        if path == "/spotify/callback":
            err = (query.get("error") or [""])[0]
            if err:
                return self._send(200, _callback_page("Spotify said no",
                                  f"Spotify reported: {err}. You can close this tab."), "text/html")
            ok, reason = SPOTIFY.finish((query.get("code") or [""])[0],
                                        (query.get("state") or [""])[0])
            if ok:
                HUB.broadcast()
                return self._send(200, _callback_page(
                    "Spotify connected",
                    "Awesome Streaming Deck can see your playback now. This window closes itself.",
                    done=True), "text/html")
            return self._send(200, _callback_page("That did not work", reason), "text/html")

        if path == "/spotify/art":
            art = SPOTIFY.fetch_art((query.get("u") or [""])[0])
            if not art:
                return self._send(404, "no art", "text/plain")
            mime, data_bytes = art
            return self._send(200, data_bytes, mime, {"Cache-Control": "max-age=3600"})

        if path == "/smtc/art":
            art_path = BRIDGE.art_path((query.get("t") or [""])[0])
            if not art_path:
                return self._send(404, "no art", "text/plain")
            with open(art_path, "rb") as f:
                data = f.read()
            mime = "image/png" if art_path.endswith(".png") else "image/jpeg"
            return self._send(200, data, mime, {"Cache-Control": "max-age=600"})

        if path == "/api/state":
            return self._json(HUB.snapshot())

        if path == "/api/config":
            return self._json(CONFIG)

        if path == "/api/themes":
            themes = load_themes()
            ordered = sorted(themes.values(),
                             key=lambda t: t.get("updated", t.get("created", 0)),
                             reverse=True)
            return self._json({"themes": ordered})

        if path == "/api/library":
            if query.get("rescan"):
                LIBRARY.scan(CONFIG["music_dirs"], force=bool(query.get("force")))
            elif not LIBRARY.tracks and CONFIG["music_dirs"]:
                LIBRARY.scan(CONFIG["music_dirs"])
            return self._json({
                "tracks": [{k: v for k, v in t.items() if k != "path"}
                           for t in LIBRARY.tracks],
                "count": len(LIBRARY.tracks),
                "dirs": CONFIG["music_dirs"],
                "scanning": LIBRARY.scanning,
            })

        if path == "/api/window/status":
            return self._json(OVERLAY.status())

        if path == "/api/spotify/queue":
            return self._json(SPOTIFY.queue())

        if path == "/api/spotify/devices":
            return self._json(SPOTIFY.devices())

        if path == "/api/lyrics/window/status":
            return self._json(LYRICS_WIN.status())

        if path == "/api/queue/window/status":
            return self._json(QUEUE_WIN.status())

        if path == "/api/captions/window/status":
            return self._json(CAPTIONS_WIN.status())

        if path == "/api/captions/mics":
            return self._json({"mics": list_microphones()})

        if path == "/api/captions/level":
            # The deck's meter, asked for only while it is on screen, so the
            # broadcast does not have to carry every flicker of it.
            c = CAPTIONS.get()
            return self._json({"level": c["level"], "audio": c["audio"], "state": c["state"]})

        if path == "/api/fonts":
            return self._json({"fonts": FONT_STORE.list()})

        if path == "/fonts.css":
            # Every page links this; it changes whenever a font is added or
            # removed, so it is never cached.
            body = FONT_STORE.css().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/css; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path.startswith("/font/"):
            full = FONT_STORE.path(path[len("/font/"):])
            if not full:
                return self._send(404, "no such font")
            with open(full, "rb") as f:
                body = f.read()
            # Named by its own hash, so a given address never changes content.
            self.send_response(200)
            self.send_header("Content-Type", FONT_STORE.mime(full))
            self.send_header("Cache-Control", "max-age=31536000, immutable")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/lyrics":
            now = HUB.snapshot()["now"]
            if not now:
                return self._json({"status": "none", "reason": "nothing playing"})
            track_path = None
            if now.get("source") == "local" and HUB.local.get("track_id"):
                track = LIBRARY.get(HUB.local["track_id"])
                track_path = track["path"] if track else None
            res = LYRICS.get(now.get("title", ""), now.get("artist", ""),
                             now.get("album", ""), now.get("duration", 0),
                             path=track_path,
                             online=bool(CONFIG.get("lyrics", {}).get("online", True)))
            return self._json(res)

        if path == "/api/events":
            return self._sse()

        if path == "/ws/live":
            return LIVE.serve_websocket(self)
        if path == "/ws/events":
            return feeds.serve_ws_feed(self, HUB, FEEDS)
        if path == "/ws/chat":
            # The same server, a different hub: ChatHub offers the same
            # subscribe/unsubscribe contract the state hub does, so one
            # implementation serves both.
            return feeds.serve_ws_feed(self, CHAT, FEEDS)
        if path == "/ws/alerts":
            # A third hub through the same endpoint. A scene page opens this
            # only when the scene it is showing has a layer that wants alerts -
            # a scene that wants nothing costs nothing.
            return feeds.serve_ws_feed(self, ALERTS, FEEDS)
        if path == "/api/live/status":
            return self._json(live_status())
        if path == "/api/live/program.png":
            # Studio mode's program monitor: the live output window - the
            # stream's own source - as a small picture taken now.
            comp = COMPONENTS.get("live")
            host = comp.overlay.host if comp else None
            hwnd = host.hwnd if host and host.alive() else None
            if not hwnd:
                return self._send(404, "the live output is not open", "text/plain")
            try:
                png, _w, _h = capture.thumbnail(hwnd=hwnd, max_w=int((query.get("w") or ["480"])[0]))
            except Exception as exc:
                return self._send(404, f"no picture: {exc}", "text/plain")
            return self._send(200, png, "image/png", {"Cache-Control": "no-store"})
        if path == "/api/tiktok/status":
            return self._json(TIKTOK.status())
        if path == "/api/tiktok/info":
            return self._json(TIKTOK.info())
        if path == "/api/tiktok/search":
            return self._json(TIKTOK.search((query.get("q") or [""])[0]))
        if path == "/api/live/presets":
            return self._json({"presets": live.PRESETS, "current": CONFIG.get("live", {}).get("preset")})
        if path == "/api/live/devices":
            try:
                return self._json(audio_mod.list_devices())
            except Exception as exc:
                return self._json({"capture": [], "render": [], "error": str(exc)})
        if path == "/api/feeds":
            return self._json(FEEDS.status())
        if path == "/api/debug/mem":
            # Where memory goes while streaming: working set, and Python's own
            # allocations by source line once tracing is on (?start=1).
            import gc
            import tracemalloc
            out = {"working_set_mb": 0, "gc_objects": len(gc.get_objects()), "tracing": tracemalloc.is_tracing(),
                   "threads": threading.active_count(),
                   "hub": {"sends": HUB.sends, "bytes": HUB.sent_bytes, "subscribers": len(HUB._subs)}}
            try:
                import ctypes as _ct
                class _PMC(_ct.Structure):
                    _fields_ = [("cb", _ct.c_uint32), ("PageFaultCount", _ct.c_uint32)] + \
                        [(n, _ct.c_size_t) for n in ("PeakWorkingSet", "WorkingSet", "QPeakPaged", "QPaged",
                                                    "QPeakNonPaged", "QNonPaged", "Pagefile", "PeakPagefile")]
                pmc = _PMC(); pmc.cb = _ct.sizeof(_PMC)
                # The current-process pseudo handle is -1 as a full 64-bit
                # HANDLE; passed as a plain int it gets truncated to 32 bits
                # and the call fails quietly, so hand it over as a pointer.
                gpmi = _ct.windll.psapi.GetProcessMemoryInfo
                gpmi.argtypes = [_ct.c_void_p, _ct.c_void_p, _ct.c_uint32]
                if gpmi(_ct.c_void_p(-1), _ct.byref(pmc), pmc.cb):
                    out["working_set_mb"] = round(pmc.WorkingSet / 1048576, 1)
                    out["private_mb"] = round(pmc.Pagefile / 1048576, 1)
            except Exception:
                pass
            if query.get("start") and not tracemalloc.is_tracing():
                tracemalloc.start(12)
                out["tracing"] = True
            if tracemalloc.is_tracing():
                snap = tracemalloc.take_snapshot()
                prev = getattr(Handler, "_mem_snap", None)
                stats = snap.compare_to(prev, "lineno") if prev else snap.statistics("lineno")
                out["top"] = [f"{s.size_diff / 1024:+.0f} KB {s.size / 1024:.0f} KB {s.count} {s.traceback}"
                              if prev else f"{s.size / 1024:.0f} KB {s.count} {s.traceback}" for s in stats[:15]]
                out["traced_mb"] = round(sum(s.size for s in snap.statistics("filename")) / 1048576, 1)
                Handler._mem_snap = snap
            return self._json(out)

        if path == "/api/debug/snapshot":
            # What one snapshot costs, and where: 50 builds under cProfile.
            import cProfile
            import io as _io
            import pstats
            prof = cProfile.Profile()
            t0 = time.perf_counter()
            prof.enable()
            for _ in range(50):
                HUB._change_key(HUB.snapshot())
            prof.disable()
            ms = (time.perf_counter() - t0) * 1000 / 50
            buf = _io.StringIO()
            pstats.Stats(prof, stream=buf).sort_stats("cumulative").print_stats(18)
            return self._json({"ms_per_build": round(ms, 2), "profile": buf.getvalue()[-6000:]})
        if path == "/api/debug/threads":
            # CPU seconds per thread of this process, by the thread's name:
            # two reads apart say where the server's time goes.
            import ctypes as _ct
            from ctypes import wintypes as _wt
            k32 = _ct.windll.kernel32
            k32.OpenThread.restype = _wt.HANDLE
            k32.OpenThread.argtypes = [_wt.DWORD, _wt.BOOL, _wt.DWORD]
            out = []
            for t in threading.enumerate():
                h = k32.OpenThread(0x0800, False, t.native_id or 0)       # THREAD_QUERY_LIMITED_INFORMATION
                if not h:
                    continue
                c, e, k, u = (_wt.FILETIME() for _ in range(4))
                if k32.GetThreadTimes(h, _ct.byref(c), _ct.byref(e), _ct.byref(k), _ct.byref(u)):
                    secs = sum((f.dwHighDateTime << 32 | f.dwLowDateTime) / 1e7 for f in (k, u))
                    out.append({"name": t.name, "id": t.native_id, "cpu": round(secs, 3)})
                k32.CloseHandle(h)
            return self._json({"threads": out, "at": time.time()})

        if path == "/api/components":
            return self._json({"components": COMPONENTS.describe_all(),
                               "windows": COMPONENTS.statuses()})
        m = re.match(r"^/api/components/([^/]+)/status$", path)
        if m:
            comp = COMPONENTS.resolve(urllib.parse.unquote(m.group(1)))
            if not comp:
                return self._json({"ok": False, "reason": "no such component"}, 404)
            return self._json(comp.overlay.status())

        if path == "/api/scenes":
            # "unreadable": scene files set aside at start because no copy of them could be read.
            return self._json({"scenes": SCENES.list(), "unreadable": SCENES.unreadable})
        if path == "/api/scenes/formats":
            return self._json({"formats": {k: list(v) for k, v in scenes.FORMATS.items()},
                               "safe_zones": scenes.SAFE_ZONES, "templates": scenes.template_list()})
        if path == "/api/scenes/templates":
            # The New scene gallery: each template's size, background and layer boxes.
            return self._json({"templates": scenes.template_previews(), "safe_zones": scenes.SAFE_ZONES})
        m = re.match(r"^/api/scenes/([^/]+)(/backups|/export)?$", path)
        if m:
            scene = SCENES.get(m.group(1))
            if not scene:
                return self._json({"ok": False, "reason": "no such scene"}, 404)
            if m.group(2) == "/backups":
                return self._json({"backups": SCENES.backups(scene["id"])})
            if m.group(2) == "/export":
                # The scene as one .zip - its pictures and fonts inside (sceneio.py).
                zipped, filename, _ = sceneio.export_zip(scene, ASSET_STORE, FONT_STORE)
                return self._send(200, zipped, "application/zip",
                                  {"Content-Disposition": f'attachment; filename="{filename}"'})
            return self._json(scene)

        if path == "/api/capture/sources":
            # Only a list; nothing starts capturing until a scene asks.
            try:
                return self._json(capture.list_sources())
            except Exception as exc:
                return self._json({"windows": [], "monitors": [], "error": str(exc)})
        if path == "/api/capture/thumb":
            hwnd = int((query.get("hwnd") or ["0"])[0] or 0)
            title = (query.get("title") or [""])[0]
            mon = (query.get("monitor") or [""])[0]
            try:
                hmon = None
                if mon != "":
                    mons = capture.list_monitors()
                    hmon = mons[int(mon)]["hmon"] if 0 <= int(mon) < len(mons) else None
                if not hwnd and not hmon and title:
                    # A scene names its window by title: a handle is a different
                    # number every time that program is started, so the editor
                    # asks for the picture the same way the compositor finds it.
                    hit = next((w for w in capture.list_windows() if w["title"] == title), None)
                    if not hit:
                        return self._send(404, "that window is not open", "text/plain")
                    hwnd = hit["hwnd"]
                png, _w, _h = capture.thumbnail(hwnd=hwnd or None, monitor=hmon,
                                                max_w=int((query.get("w") or ["320"])[0]))
            except Exception as exc:
                return self._send(404, f"no picture: {exc}", "text/plain")
            return self._send(200, png, "image/png", {"Cache-Control": "no-store"})

        if path == "/api/chat/status":
            return self._json(CHAT.status())
        if path == "/api/commands":
            return self._json({"commands": COMMANDS.list(), "status": COMMANDS.status(),
                               "roles": list(commands.ROLES), "actions": list(commands.ACTIONS),
                               # So the editor labels every row with the symbol
                               # in force rather than the one it was written with.
                               "symbol": chat.symbols(),
                               "budget": COMMANDS.budget(), "paused": COMMANDS.paused,
                               # T11: the ones that belong to layers on the
                               # scene on air, each with any conflict it has.
                               "layers": COMMANDS.layer_list()})
        if path == "/api/tts/voices":
            return self._json({"voices": TTS.voices(), "status": TTS.status()})
        m = re.match(r"^/api/tts/([0-9a-f]{16})\.wav$", path)
        if m:
            wav = TTS.clip(m.group(1))
            if not wav:
                return self._send(404, "no such clip", "text/plain")
            return self._send(200, wav, "audio/wav", {"Cache-Control": "no-store"})
        if path == "/api/commands/recent":
            # What fired, for the editor's log. Off the state feed on purpose:
            # it changes whenever anyone types, which is the wrong cadence for
            # a whole-state broadcast.
            return self._json({"log": COMMANDS.recent(int((query.get("n") or ["100"])[0] or 100))})
        if path == "/api/requests":
            return self._json({"pending": REQUESTS.pending(), "status": REQUESTS.status()})
        if path == "/api/requests/recent":
            return self._json({"log": REQUESTS.recent(int((query.get("n") or ["100"])[0] or 100))})
        if path == "/api/polls":
            return self._json({"current": POLLS.current(), "recent": POLLS.recent(10),
                               "status": POLLS.status(),
                               # The panel tells people to vote by typing "!1".
                               # That sentence has to name the symbol actually
                               # in force or it is instructions to fail.
                               "symbol": chat.symbols()})
        if path == "/api/alerts/recent":
            # For a page that opened late, and for the tests. The feed itself
            # sends nothing on connect, exactly as the chat one does not.
            return self._json({"events": ALERTS.recent(int((query.get("n") or ["50"])[0] or 50)),
                               "status": ALERTS.status()})
        if path == "/api/chat/recent":
            # A page that opens mid-stream would otherwise show an empty panel
            # until somebody happened to type.
            return self._json({"messages": CHAT.recent(int((query.get("n") or ["100"])[0] or 100))})
        if path == "/api/voice":
            return self._json(VOICE.status())
        if path == "/api/camera/devices":
            # The cameras Windows knows, by name: the camera layer's device picker.
            try:
                import camera as camera_mod
                return self._json({"cameras": camera_mod.list_cameras()})
            except Exception as exc:
                return self._json({"cameras": [], "error": str(exc)})

        # Last resort: a file we ship in web/. This has to come after every
        # real route, or a route whose path ends in something dot-shaped
        # (/asset/abc.png) gets mistaken for a static file.
        if not path.startswith("/api/") and "." in os.path.basename(path):
            return self._serve_static(path.lstrip("/"))

        return self._send(404, "not found", "text/plain")

    def _sse(self):
        queue_ = HUB.subscribe()
        token = FEEDS.track("sse", FEEDS.page_of(self))
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    payload = queue_.get(timeout=15)
                except Exception:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            pass
        finally:
            HUB.unsubscribe(queue_)
            FEEDS.release(token)
        self.close_connection = True

    # -- POST --------------------------------------------------------------

    def do_POST(self):
        if not self._trusted():
            return self.send_error(403, "Forbidden")
        path = urlparse(self.path).path
        data = self._body()

        if path == "/api/state":
            HUB.update_local(data)
            if "volume" in data:
                CONFIG["volume"] = data["volume"]
            HUB.broadcast()
            return self._json({"ok": True})

        if path == "/api/config":
            _merge_into(CONFIG, data)
            save_config(CONFIG)
            # A new engine, model, microphone or word list restarts a running
            # caption session; anything else leaves it alone.
            CAPTIONS.configure(captions_settings())
            BRIDGE.set_interval(bridge_interval())
            SPOTIFY.configure(CONFIG["spotify"].get("client_id", ""))
            # An edited block list or length cap has to take effect now, not at
            # the next restart - the moment you want one is mid-stream.
            REQUESTS.configure(CONFIG.get("requests"))
            # And the command symbol, for the same reason: the moment somebody
            # changes what starts a command is mid-stream, not at the next
            # restart. This also catches a config restored from a backup.
            command_symbol()
            sur = CONFIG["nowplaying"].get("surround") or {}
            backdrop = sur.get("color", "#000000") if sur.get("mode") == "solid" else "#000000"
            OVERLAY.set_backdrop(backdrop)
            HUB.broadcast()
            return self._json(CONFIG)

        if path == "/api/folders/add":
            manual = (data.get("path") or "").strip().strip('"')
            chosen = manual if manual else pick_folder().get("path", "")
            if not chosen:
                return self._json({"ok": False, "reason": "canceled"})
            if not os.path.isdir(chosen):
                return self._json({"ok": False, "reason": "not a folder"})
            chosen = os.path.abspath(chosen)
            if chosen not in CONFIG["music_dirs"]:
                CONFIG["music_dirs"].append(chosen)
                save_config(CONFIG)
            LIBRARY.scan(CONFIG["music_dirs"])
            return self._json({"ok": True, "path": chosen,
                               "dirs": CONFIG["music_dirs"],
                               "count": len(LIBRARY.tracks)})

        if path == "/api/folders/remove":
            target = data.get("path")
            CONFIG["music_dirs"] = [d for d in CONFIG["music_dirs"] if d != target]
            save_config(CONFIG)
            LIBRARY.scan(CONFIG["music_dirs"])
            return self._json({"ok": True, "dirs": CONFIG["music_dirs"],
                               "count": len(LIBRARY.tracks)})

        if path == "/api/spotify/connect":
            if data.get("client_id") is not None:
                CONFIG["spotify"]["client_id"] = str(data["client_id"]).strip()
                save_config(CONFIG)
            SPOTIFY.configure(CONFIG["spotify"].get("client_id", ""))
            res = SPOTIFY.begin()
            if res.get("ok"):
                res["windowed"] = launch_auth_window(res["url"])
            return self._json(res)

        if path == "/api/spotify/disconnect":
            SPOTIFY.disconnect()
            HUB.broadcast()
            return self._json({"ok": True})

        if path == "/api/seek":
            # Whichever source is on screen; the pop-outs do not need to know.
            now = HUB.snapshot()["now"] or {}
            if now.get("source") == "local":
                seconds = float(data.get("seconds", 0))
                HUB.local_seek = {"to": seconds, "id": time.time()}
                HUB.update_local({"position": seconds})
                HUB.broadcast()
                return self._json({"ok": True, "source": "local"})
            return self._json(SPOTIFY.seek(data.get("seconds", 0)))

        if path == "/api/transport":
            # Whichever source is on screen; a window does not need to know
            # where the music is coming from to put a Next button on it.
            cmd = str(data.get("cmd", ""))
            if cmd not in ("prev", "next", "playpause"):
                return self._json({"ok": False, "reason": "unknown command"})
            if (HUB.snapshot()["now"] or {}).get("source") == "local":
                # The deck owns the <audio> element, so the press rides the
                # broadcast and the deck is what actually applies it.
                HUB.local_cmd = {"cmd": cmd, "id": time.time()}
                HUB.broadcast()
                return self._json({"ok": True, "source": "local"})
            return self._json(self._spotify_command(cmd))

        if path == "/api/spotify/seek":
            return self._json(SPOTIFY.seek(data.get("seconds", 0)))

        if path == "/api/spotify/volume":
            return self._json(SPOTIFY.set_volume(data.get("percent", 70)))

        if path == "/api/spotify/transfer":
            return self._json(SPOTIFY.transfer(data.get("device_id", "")))

        if path == "/api/spotify/toggle":
            return self._json(SPOTIFY.set_toggle(data.get("what", ""), data.get("value")))

        if path == "/api/spotify/refresh":
            # The Refresh button. An event for the poller, not a call to
            # Spotify from here: the broadcast carries the answer when it lands.
            SPOTIFY.refresh()
            return self._json({"ok": True})

        if path.startswith("/api/spotify/"):
            return self._json(self._spotify_command(path.split("/")[-1]))

        if path == "/api/assets/upload":
            res = ASSET_STORE.save(data.get("name", "image.png"),
                                   data.get("data", ""), thumb=data.get("thumb"))
            return self._json(res)

        if path == "/api/assets/delete":
            # Refused while a scene or a window still shows it, unless forced.
            res = ASSET_STORE.remove(data.get("id", ""),
                                     [SCENES.get(s["id"]) for s in SCENES.list()],
                                     CONFIG, force=bool(data.get("force")))
            return self._json(dict(res, assets=ASSET_STORE.list()))

        if path == "/api/scenes":
            if data.get("template"):
                if data["template"] not in scenes.TEMPLATES:
                    return self._json({"ok": False, "reason": "no such template"}, 404)
                scene = scenes.from_template(data["template"])
                if data.get("name"):
                    scene["name"] = str(data["name"])[:80]
                return self._json({"ok": True, "scene": SCENES.add(scene)})
            scene = SCENES.create(data.get("name") or "New scene", data.get("format") or "horizontal",
                                  data.get("width"), data.get("height"))
            return self._json({"ok": True, "scene": scene})

        if path == "/api/canvas/editor/open":
            # The Canvas Builder in its own app window (the editor itself is P7).
            sid = str(data.get("scene") or "")
            q = ("?scene=" + urllib.parse.quote(sid, safe="")) if sid and SCENES.get(sid) else ""
            ok = launch_deck(f"http://127.0.0.1:{CONFIG['port']}/canvas.html{q}", 1440, 900)
            return self._json({"ok": bool(ok)})
        if path == "/api/canvas/live":
            return self._json(set_live_scene(data.get("id", ""), data.get("transition"), data.get("duration")))
        if path == "/api/canvas/remote/open":
            # The scene remote (P11): a small window, kept on top of the others
            # while its "Keep on top" is on - and only ever opened when asked for.
            ok = launch_deck(f"http://127.0.0.1:{CONFIG['port']}/remote.html", 340, 640)
            if ok and CONFIG["canvas"].get("remote_on_top", True):
                threading.Thread(target=remote_on_top, args=(True,), daemon=True, name="remote on top").start()
            return self._json({"ok": bool(ok)})
        if path == "/api/live/view/open":
            # The Live view (S9): what is on air, its health, the scene
            # switcher, sound and chat in one window - a window of its own like
            # the editor and the remote, not a component. Components are
            # overlays that go on the stream; this is the desk you run it from.
            ok = launch_deck(f"http://127.0.0.1:{CONFIG['port']}/liveview.html", 1280, 880)
            return self._json({"ok": bool(ok)})
        if path == "/api/canvas/remote/topmost":
            on = bool(data.get("on"))
            CONFIG.setdefault("canvas", {})["remote_on_top"] = on
            save_config(CONFIG)
            return self._json({"ok": remote_on_top(on, wait=1.0), "on": on})

        if path == "/api/debug/spotify-fake":
            # The same idea as the chat hook below, and refused on the real app
            # for a sharper reason: there it would quietly cut song requests off
            # from the account they are meant to reach, while still looking as
            # though they had worked. Pass a track to fake with, or nothing at
            # all to put the real Spotify back.
            if int(CONFIG.get("port") or 8713) == 8713:
                return self._json({"ok": False, "error": "test hook: not on the real app"}, 403)
            track = data.get("track")
            if not isinstance(track, dict):
                REQUESTS.find, REQUESTS.enqueue = spotify_find, spotify_enqueue
                return self._json({"ok": True, "fake": False})
            ok = bool(data.get("ok", True))
            reason = str(data.get("reason") or ("queued" if ok else "Spotify would not take it"))
            REQUESTS.find = lambda text, t=dict(track): (True, dict(t))
            REQUESTS.enqueue = lambda uri, o=ok, r=reason: (o, r)
            return self._json({"ok": True, "fake": True, "track": track})
        if path == "/api/debug/gift":
            # A test hook for the Gift layer (T8), and the test rig's alone -
            # gated on TEST_RIG, not the port, because a gift that reached a
            # real stream from here would be a lie told to an audience. The
            # editor's "Try it" never comes here: it plays in the editor's own
            # preview. Real gifts arrive from TikTok (T6) through post_gift().
            if not TEST_RIG:
                return self._json({"ok": False, "error": "test hook: the test rig only"}, 403)
            ev = post_gift(data.get("user"), data.get("gift"), data.get("coins"),
                           data.get("count", 1), data.get("avatar", ""))
            return self._json({"ok": True, "event": ev})
        if path == "/api/debug/chat-endpoint":
            # A test hook, and the only one in the app that is refused on the
            # real thing. Saying "speaking" below is harmless; telling a network
            # client where to dial is not, so this answers on the rig's port
            # only. The rig check stands a plain IRC server on localhost and
            # points the adapter at it, which exercises the reading loop, the
            # PING answer and the reconnect - the parts a mocked socket would
            # not touch.
            if int(CONFIG.get("port") or 8713) == 8713:
                return self._json({"ok": False, "error": "test hook: not on the real app"}, 403)
            ad = chat.ADAPTERS.get(str(data.get("service") or "twitch").lower())
            if not ad:
                return self._json({"ok": False, "error": "no such adapter"})
            ad.host = str(data.get("host") or chat.TWITCH_HOST)
            ad.port = int(data.get("port") or chat.TWITCH_PORT)
            ad.tls = bool(data.get("tls", True))
            return self._json({"ok": True, "host": ad.host, "port": ad.port, "tls": ad.tls})

        if path == "/api/voice/override":
            # A test hook: a rig without a microphone can still say "speaking".
            return self._json(VOICE.override(data.get("speaking")))
        if path == "/api/voice":
            # How loud counts as talking (the Canvas Builder's reactive-image inspector).
            if "threshold" in data:
                CONFIG.setdefault("voice", {})["threshold"] = VOICE.set_threshold(data.get("threshold"))
                save_config(CONFIG)
            return self._json(VOICE.status())
        if path == "/api/scenes/import":
            # A scene someone exported, as a .zip: sceneio.py trusts nothing in it.
            try:
                scene, report = sceneio.import_zip(sceneio.from_data_url(data.get("data")),
                                                   ASSET_STORE, FONT_STORE, name=data.get("name"))
            except sceneio.ImportRefused as exc:
                return self._json({"ok": False, "reason": str(exc)}, 400)
            if report["fonts"]:
                HUB.broadcast()          # the pages' fonts.css has new faces in it
            return self._json({"ok": True, "scene": SCENES.add(scene), "report": report})
        if path == "/api/scenes/convert":
            # The editor's working copy laid out for another format, not stored:
            # a format switch in place, which the editor makes one undo step.
            src = data.get("scene") if isinstance(data.get("scene"), dict) else None
            if not src or data.get("format") not in scenes.FORMATS:
                return self._json({"ok": False, "reason": "a scene and a format, please"}, 400)
            return self._json({"ok": True, "scene": scenes.convert(src, data["format"])})
        m = re.match(r"^/api/scenes/([^/]+)(?:/(delete|duplicate|restore|convert|export))?$", path)
        if m:
            sid, what = m.groups()
            if not SCENES.get(sid):
                return self._json({"ok": False, "reason": "no such scene"}, 404)
            if what == "export":
                # Saved as a file where downloads go (or canvas.export_dir), never over another.
                folder = CONFIG["canvas"].get("export_dir") or sceneio.downloads_dir()
                try:
                    return self._json(sceneio.save_export(SCENES.get(sid), ASSET_STORE, FONT_STORE, folder))
                except OSError as exc:
                    return self._json({"ok": False, "reason": f"Could not write the file: {exc}"}, 500)
            if what == "convert":
                # "Make a phone version": a new scene, laid out for the other format.
                fmt = data.get("format")
                if fmt not in scenes.FORMATS:
                    return self._json({"ok": False, "reason": "no such format"}, 400)
                src = SCENES.get(sid)
                made = scenes.convert(src, fmt, name=data.get("name") or f"{src['name']} ({fmt})")
                made["id"] = ""
                return self._json({"ok": True, "scene": SCENES.add(made)})
            if what == "delete":
                COMPONENTS.remove(COMPONENTS.scene_id(sid))
                return self._json({"ok": SCENES.delete(sid)})
            if what == "duplicate":
                return self._json({"ok": True, "scene": SCENES.duplicate(sid, data.get("name"))})
            if what == "restore":
                scene = SCENES.restore(sid, data.get("n", 1))
                return self._json({"ok": bool(scene), "scene": scene})
            body = data.get("scene") if isinstance(data.get("scene"), dict) else data
            body = dict(body, id=sid)
            try:
                scene = SCENES.save(body, expect_rev=data.get("expect_rev"))
            except scenes.Conflict as exc:
                return self._json({"ok": False, "reason": str(exc), "conflict": True,
                                   "scene": SCENES.get(sid)}, 409)
            refresh_native_sources(sid)
            return self._json({"ok": True, "scene": scene})

        if path == "/api/chat/connect":
            service = str(data.get("service") or "twitch").lower()
            channel = str(data.get("channel") or "").strip()
            res = CHAT.connect(service, channel)
            if res.get("ok"):
                CONFIG.setdefault("chat", {}).setdefault(service, {})["channel"] = channel.lstrip("#").lower()
                save_config(CONFIG)
                HUB.broadcast()
            return self._json(res)
        if path == "/api/polls/open":
            res = POLLS.open(data.get("question"), data.get("choices"))
            HUB.broadcast()
            return self._json(res)
        if path == "/api/polls/close":
            res = POLLS.close()
            HUB.broadcast()
            return self._json(res)
        if path == "/api/requests/approve":
            # The one-way door: Spotify can be appended to but not un-appended,
            # so this is the press that cannot be taken back.
            res = REQUESTS.approve(str(data.get("id") or ""))
            alert_for_request(res.get("request"))    # moderated: it becomes news here
            HUB.broadcast()
            return self._json(res)
        if path == "/api/requests/skip":
            res = REQUESTS.skip(str(data.get("id") or ""))
            HUB.broadcast()
            return self._json(res)
        if path == "/api/commands/save":
            items = data.get("commands")
            if not isinstance(items, list):
                return self._json({"ok": False, "error": "a list of commands is needed"}, 400)
            CONFIG.setdefault("commands", {})["list"] = items
            # The symbol rides the same save as the list: the panel has one
            # Save button, and two round trips could leave a list saved beside
            # a symbol that was refused.
            if "symbol" in data:
                CONFIG["commands"]["symbol"] = str(data.get("symbol") or "")
            symbol = command_symbol()
            if "budget" in data:
                CONFIG["commands"]["budget"] = COMMANDS.set_budget(data.get("budget"))
            save_config(CONFIG)
            kept = COMMANDS.load(items)          # what survived cleaning, so the editor can show it
            HUB.broadcast()
            return self._json({"ok": True, "commands": kept, "symbol": symbol,
                               "budget": COMMANDS.budget()})
        if path == "/api/commands/stop":
            stop_everything()
            return self._json({"ok": True, "paused": COMMANDS.paused})
        if path == "/api/tts/test":
            # The inspector's "Hear it": made exactly as chat's clips are, and
            # played by the editor page that asked - never on stream.
            text, why = tts.clean_text(data.get("text") or "This is how chat will sound.",
                                       data.get("maxlen", tts.MAXLEN), data.get("blocked", ""))
            if text is None:
                return self._json({"ok": False, "error": why})
            ok, res = TTS.say_and_wait(text, voice=data.get("voice") or "", rate=data.get("rate") or 0)
            return self._json({"ok": True, "clip": f"/api/tts/{res}.wav"} if ok else {"ok": False, "error": res})
        if path == "/api/tts/skip":
            # The Live view's Skip: the clip being read ends, the next starts.
            ALERTS.say("skip", "")
            return self._json({"ok": True})
        if path == "/api/commands/resume":
            resume_commands()
            return self._json({"ok": True, "paused": COMMANDS.paused})
        if path == "/api/chat/disconnect":
            res = CHAT.disconnect(str(data.get("service") or "twitch").lower())
            HUB.broadcast()
            return self._json(res)

        if path in ("/api/voice/hold", "/api/voice/release"):
            if path.endswith("hold"):
                return self._json(VOICE.hold(data.get("token")))
            return self._json(VOICE.release(data.get("token", "")))

        if path == "/api/themes/save":
            name = (data.get("name") or "").strip()
            if not name:
                return self._json({"ok": False, "reason": "a name is required"})
            patch = data.get("data")
            if not isinstance(patch, dict):
                return self._json({"ok": False, "reason": "no settings to save"})
            themes = load_themes()
            tid = data.get("id") or _theme_slug(name)
            now = round(time.time())
            existing = themes.get(tid) or {}
            themes[tid] = {"id": tid, "name": name,
                           "created": existing.get("created", now),
                           "updated": now, "data": patch}
            save_themes(themes)
            ordered = sorted(themes.values(),
                             key=lambda t: t.get("updated", 0), reverse=True)
            return self._json({"ok": True, "theme": themes[tid], "themes": ordered})

        if path == "/api/themes/delete":
            tid = data.get("id", "")
            themes = load_themes()
            removed = themes.pop(tid, None) is not None
            if removed:
                save_themes(themes)
            ordered = sorted(themes.values(),
                             key=lambda t: t.get("updated", 0), reverse=True)
            return self._json({"ok": removed, "themes": ordered})

        if path in ("/api/captions/model/download", "/api/captions/model/cancel",
                    "/api/captions/model/remove"):
            # Only ever on a press in the deck: the one download captions need.
            name = data.get("name") or models.DEFAULT
            what = path.rsplit("/", 1)[1]
            res = (MODEL_STORE.download(name) if what == "download" else
                   MODEL_STORE.cancel(name) if what == "cancel" else
                   MODEL_STORE.remove(name))
            HUB.broadcast()
            return self._json(dict(res, models=MODEL_STORE.status()))

        if path in ("/api/captions/gpu/download", "/api/captions/gpu/cancel",
                    "/api/captions/gpu/remove"):
            # NVIDIA's cuBLAS, for Whisper on the graphics card: only ever on a
            # press in the deck, like the model.
            what = path.rsplit("/", 1)[1]
            res = (GPU_STORE.download() if what == "download" else
                   GPU_STORE.cancel() if what == "cancel" else
                   GPU_STORE.remove())
            HUB.broadcast()
            return self._json(dict(res, gpu=GPU_STORE.status()))

        if path in ("/api/fonts/upload", "/api/fonts/delete"):
            res = (FONT_STORE.save(data.get("name", "font.ttf"), data.get("data", ""))
                   if path.endswith("upload") else
                   {"ok": FONT_STORE.delete(data.get("id", ""))})
            HUB.broadcast()
            return self._json(dict(res, fonts=FONT_STORE.list()))

        if path in ("/api/captions/start", "/api/captions/stop", "/api/captions/clear"):
            # The microphone is only ever opened on purpose, from here. Start
            # and stop are remembered, so a deck left listening comes back
            # listening; nothing else touches the microphone.
            what = path.rsplit("/", 1)[1]
            if what == "start":
                CAPTIONS.start()
            elif what == "stop":
                CAPTIONS.stop()
            else:
                CAPTIONS.clear()
            if what != "clear":
                CONFIG.setdefault("captions", {})["enabled"] = (what == "start")
                save_config(CONFIG)
            HUB.broadcast()
            return self._json({"ok": True, "captions": CAPTIONS.get()})

        # Any component's window, by its id (/api/components/<id>/<action>) or
        # by the four names the deck has always used.
        m = re.match(r"^/api/(window|lyrics/window|queue/window|captions/window|components/[^/]+)/([a-z]+)$", path)
        if m:
            which, action = m.groups()
            key = which[len("components/"):] if which.startswith("components/") else which
            comp = COMPONENTS.resolve(urllib.parse.unquote(key))
            if not comp:
                return self._json({"ok": False, "reason": "no such component"}, 404)
            if (comp.id == "live" and action == "minimize" and NATIVE.status().get("running")
                    and LIVE.state in ("connecting", "live", "reconnecting")):
                # Windows cannot capture a minimized window: the viewers would
                # get a frozen picture. Parking keeps it drawing off screen.
                return self._json({"ok": False, "reason": "the live output is on air and a minimized window "
                                   "cannot be captured - park it instead"}, 409)
            res = window_action(comp.overlay, comp.config(CONFIG), comp.page, action, data)
            if comp.group == "canvas" and action in ("open", "close", "park", "unpark", "rebuild"):
                remember_outputs()
                if (comp.id == "live" and action in ("open", "rebuild") and res.get("ok")
                        and LIVE.state in ("connecting", "live", "reconnecting")):
                    rejoin_live()           # the stream follows its new window
            if action != "metrics":
                HUB.broadcast()             # minimized, parked, moved: the pages hear it now
            return self._json(res)

        if path == "/api/live/start":
            return self._json(live_start(data))
        if path == "/api/live/stop":
            return self._json(live_stop())
        if path == "/api/live/audio":
            return self._json(live_audio(data))
        if path == "/api/live/scene":
            # The scene remote: a scene by id, or next/previous in the list.
            order = [s["id"] for s in SCENES.list()]
            target = data.get("id")
            if data.get("step") and order:
                cur = CONFIG["canvas"].get("live", "")
                i = order.index(cur) if cur in order else -1
                target = order[(i + int(data["step"])) % len(order)]
            res = set_live_scene(target or "", data.get("transition"), data.get("duration"))
            return self._json(dict(res, scenes=order))
        if path == "/api/live/native":
            # Video captured and encoded in this process; the page then only
            # carries audio, stamped on our clock as it arrives.
            if data.get("action") == "stop":
                NATIVE.stop()
                LIVE.restamp_audio = False
                return self._json({"ok": True})
            LIVE.restamp_audio = True
            return self._json(NATIVE.start(title=data.get("title"), hwnd=data.get("hwnd"),
                                           monitor=data.get("monitor"), fps=data.get("fps", 30),
                                           kbps=data.get("kbps", 3400)))
        if TEST_RIG and path in ("/api/tiktok/token", "/api/tiktok/start"):
            # The rig never opens a live at TikTok, and never goes looking for
            # the token Streamlabs keeps on this PC - which is the user's own.
            return self._json({"ok": False, "refused": True,
                               "error": "this is the test rig - it never goes live at TikTok and "
                                        "never loads the Streamlabs token"}, 403)
        if path == "/api/tiktok/token":
            # Pasted, read off this PC, or fetched through the browser. The
            # token is kept encrypted and never handed back to the page.
            src = data.get("source")
            if src == "local":
                return self._json(TIKTOK.load_local())
            if src == "web":
                return self._json(TIKTOK.sign_in())
            return self._json(TIKTOK.use_token(data.get("token", "")))
        if path == "/api/tiktok/token/forget":
            return self._json(TIKTOK.forget())
        if path == "/api/tiktok/reveal":
            # Show and Copy on the panel: the pair the open live goes out on,
            # handed over when asked for rather than on every status poll.
            return self._json(TIKTOK.reveal())
        if path == "/api/tiktok/start":
            return self._json(tiktok_go_live(data))
        if path == "/api/tiktok/end":
            # End Live from the tab: the same stop everything else uses, which
            # closes TikTok's side with it.
            return self._json(live_stop())
        if path == "/api/live/key":
            return self._json(LIVE.vault.save(data.get("url", ""), data.get("key", "")))
        if path == "/api/live/key/forget":
            return self._json(LIVE.vault.forget())

        if path == "/api/quit":
            self._json({"ok": True})

            def shutdown():
                time.sleep(0.3)
                COMPONENTS.close_all()   # otherwise the reparented Chrome windows are orphaned
                VOICE.stop()
                BRIDGE.stop()        # and the PowerShell helper would outlive us
                CAPTIONS.stop()      # likewise the one holding the microphone
                TTS.close()          # and the voice's
                live_stop()          # unpublish cleanly rather than vanish
                time.sleep(0.4)
                os._exit(0)
            threading.Thread(target=shutdown, daemon=True).start()
            return

        return self._send(404, "not found", "text/plain")


# ================================================================= main

def main():
    # A windowed .exe has no console: print() must never be able to crash us.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")

    # Before any window exists, or every coordinate we use gets DPI-virtualised.
    winwin.make_dpi_aware()
    os.makedirs(CACHE, exist_ok=True)
    port = int(CONFIG.get("port", 8713))

    try:
        httpd = QuietServer(("127.0.0.1", port), Handler)
    except OSError:
        # Already running: double-clicking again should just bring the deck up.
        print(f"\n  Port {port} is busy - Awesome Streaming Deck is already running; opening the deck.\n")
        launch_deck(f"http://127.0.0.1:{port}/deck.html")
        return

    httpd.daemon_threads = True

    # Before any Chrome runs: allow the camera and microphone for our own
    # pages in both profiles, so no window ever waits on a prompt.
    for profile in (overlay_mod.SHARED_PROFILE, "chrome-deck"):
        components.seed_media_permissions(os.path.join(CACHE, profile), port, _log)

    BRIDGE.set_interval(bridge_interval())
    # Only now, with the port ours: a second copy started by mistake exits
    # above and must leave this one's graphics-card files alone.
    GPU_STORE.cleanup()
    BRIDGE.start()
    SPOTIFY.start()

    # The account is read only while the queue window is open. Opening and
    # closing it from the deck says so at once; this also catches the window
    # going any other way - Alt+F4, its own close button, a crash - with a
    # window lookup every two seconds.
    def follow_queue_window():
        while True:
            try:
                SPOTIFY.set_active(QUEUE_WIN.is_open())
            except Exception:
                pass
            time.sleep(2)
    threading.Thread(target=follow_queue_window, daemon=True).start()
    # Outputs that were open last time come back, and stay back.
    threading.Thread(target=_watch_outputs, daemon=True).start()

    # The microphone is opened only if captions were left on last time.
    CAPTIONS.configure(captions_settings())
    if CONFIG.get("captions", {}).get("enabled"):
        CAPTIONS.start()
    threading.Thread(target=_pump, daemon=True, name="feed pump").start()
    if CONFIG["music_dirs"]:
        threading.Thread(target=lambda: LIBRARY.scan(CONFIG["music_dirs"]),
                         daemon=True).start()

    base = f"http://127.0.0.1:{port}"
    print("\n  Awesome Streaming Deck")
    print("  " + "-" * 46)
    print(f"  Deck         {base}/deck.html")
    print(f"  Now Playing  {base}/nowplaying.html")
    print(f"  Browser      {BROWSER or 'not found - falling back to default'}")
    print("  Bound to 127.0.0.1 only. Nothing leaves this machine.")
    print("  Close this window to stop.\n")

    if "--no-open" not in sys.argv:
        launch_deck(f"{base}/deck.html")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        BRIDGE.stop()
        CAPTIONS.stop()


if __name__ == "__main__":
    main()
