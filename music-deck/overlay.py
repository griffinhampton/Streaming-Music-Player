"""
Owns the on-screen Now Playing window end to end.

Launches Chrome in app mode, waits for the page to report how big its viewport
actually came out, then either leaves it alone (plain mode) or tucks it inside a
frameless host window so a capture source sees only the card - no browser title
bar. See hostwin.py for why that dance is necessary.
"""

import os
import subprocess
import threading
import time
import webbrowser

import winwin
from hostwin import HostWindow, chrome_insets

# The host window wears the friendly name, because that is the one people pick
# out of TikTok Studio's window list.
HOST_TITLE = "Awesome Streaming Deck - Now Playing"
PAGE_TITLE = "Awesome Streaming Deck - Now Playing (source)"

# Chrome throttles or stops painting windows it believes nobody can see, which
# is precisely wrong for a capture source.
STREAM_FLAGS = [
    "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion,Translate",
    "--autoplay-policy=no-user-gesture-required",
    # CSS pixels == screen pixels, so the size you ask for is the size you get.
    "--force-device-scale-factor=1",
]

# One Chrome for every pop-out window. Opening a window then asks the browser
# that is already running for one more page, instead of starting a whole new
# browser, GPU process and helpers for each. The deck keeps its own, since it
# draws at the screen's own scale and these are pinned to 1.
SHARED_PROFILE = "chrome-windows"
# Flags that only matter for the next launch of the shared Chrome - the
# capture source a scene wants auto-selected, say. The server fills this
# right before an open when no pop-out is running yet.
LAUNCH_EXTRA = []


def find_browser():
    for path in (
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
    ):
        if os.path.isfile(path):
            return path
    return None


class Overlay:
    def __init__(self, cache_dir, kind="np", host_title=HOST_TITLE, page_title=PAGE_TITLE):
        self.cache = cache_dir
        self.kind = kind                  # names the Chrome profile folder
        self.host_title = host_title      # what capture software lists
        self.page_title = page_title      # how we find Chrome's own window
        self.browser = find_browser()
        self.host = None
        self.child = None
        self.metrics = {}        # what the page says its viewport measures
        self.insets = None       # (horizontal, vertical) chrome around the viewport
        self._lock = threading.Lock()
        self._watchdog = None
        self._rebuild_hint = None   # (url, cfg) so the watchdog can start over
        # Parked: moved off every screen while it keeps rendering - a capture
        # still sees it, the desktop does not.
        self.parked = False
        self._closing = None        # the host we are closing ourselves
        self.on_user_closed = None  # the server's hook: closed by hand stays closed
        self._parked_from = None

    # ------------------------------------------------------------- reporting

    def report_metrics(self, data):
        self.metrics = {
            "inner_w": int(data.get("inner_w") or 0),
            "inner_h": int(data.get("inner_h") or 0),
            "dpr": float(data.get("dpr") or 1),
            "visibility": str(data.get("visibility") or ""),
            "focus": bool(data.get("focus")),
            "ts": time.time(),
        }

    def _wait_metrics(self, timeout=8, after=None):
        deadline = time.time() + timeout
        while time.time() < deadline:
            m = self.metrics
            if m.get("inner_w") and (after is None or m.get("ts", 0) > after):
                return m
            time.sleep(0.15)
        return None

    # ------------------------------------------------------------- state

    def is_open(self):
        if self.host and self.host.alive():
            return True
        return bool(winwin.find_window(self.page_title))

    def status(self):
        # A minimized window has no rect worth reporting: Windows parks it at
        # -32000, -32000 at a stub size, and passing that on made the deck show
        # a 221 x 1 window. None tells every caller to keep what it had.
        if self.host and self.host.alive():
            from hostwin import viewport_rect
            minimized = self.host.minimized()
            vp = viewport_rect(self.host.child) if self.host.child and not minimized else None
            return {"open": True, "hosted": True, "minimized": minimized,
                    "parked": self.parked,
                    "rect": None if minimized else self.host.rect(),
                    "viewport": [self.metrics.get("inner_w"), self.metrics.get("inner_h")],
                    "visibility": self.metrics.get("visibility", ""),
                    "viewport_rect": vp}
        hwnd = winwin.find_window(self.page_title)
        if hwnd:
            minimized = winwin.is_minimized(hwnd)
            return {"open": True, "hosted": False, "minimized": minimized, "parked": self.parked,
                    "rect": None if minimized else self._plain_rect(hwnd),
                    "outer": None if minimized else winwin.get_rect(hwnd)}
        return {"open": False, "hosted": False, "minimized": False, "parked": False, "rect": None}

    def _plain_rect(self, hwnd):
        """An un-hosted window as everything else sees windows: its outer
        position, with the size Chrome's frame leaves for the page.

        The config, the deck and the edge drag all work in page sizes, and
        _set_bounds adds the frame back on. Handing them the outer size
        instead made every drag tick grow the window by the frame - dragging
        a bottom corner up to shrink it made it taller."""
        r = winwin.get_rect(hwnd)
        if not r:
            return None
        hx, hy = self.insets or (16, 80)
        return {"x": r["x"], "y": r["y"],
                "w": max(1, r["w"] - hx), "h": max(1, r["h"] - hy)}

    # ------------------------------------------------------------- open/close

    def open(self, url, width, height, x, y, borderless=True, topmost=True):
        with self._lock:
            if self.is_open():
                return {"ok": True, "already": True}

            if not self.browser:
                webbrowser.open(url)
                return {"ok": False, "reason": "no Chrome or Edge found"}

            self.metrics = {}
            profile = os.path.join(self.cache, SHARED_PROFILE)
            os.makedirs(profile, exist_ok=True)

            # First guess at the outer size; we correct it once the page measures itself.
            guess_w, guess_h = width + 16, height + 80
            args = [self.browser, f"--app={url}", f"--user-data-dir={profile}",
                    f"--window-size={guess_w},{guess_h}",
                    f"--window-position={int(x)},{int(y)}"] + STREAM_FLAGS + list(LAUNCH_EXTRA)
            subprocess.Popen(
                args, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            child = None
            deadline = time.time() + 15
            while time.time() < deadline:
                child = winwin.find_window(self.page_title)
                if child:
                    break
                time.sleep(0.25)
            if not child:
                return {"ok": False, "reason": "browser window never appeared"}
            self.child = child

            metrics = self._wait_metrics()
            if not metrics:
                # The page never checked in; leave the plain window rather than
                # reparenting something we cannot measure.
                winwin.set_topmost(child, topmost)
                return {"ok": True, "hosted": False, "reason": "no metrics"}

            # Work out Chrome's own overhead, then resize so the viewport is exact.
            rect = winwin.get_rect(child) or {"w": guess_w, "h": guess_h}
            self.insets = (rect["w"] - metrics["inner_w"],
                           rect["h"] - metrics["inner_h"])
            stamp = metrics["ts"]
            # A window added to a browser that is already running ignores
            # --window-position, so put it where it belongs here.
            winwin.move_resize(child, int(x), int(y),
                               width + self.insets[0], height + self.insets[1])
            metrics = self._wait_metrics(timeout=4, after=stamp) or metrics
            time.sleep(0.25)

            if not borderless:
                winwin.set_topmost(child, topmost)
                return {"ok": True, "hosted": False}

            # Align against what the viewport actually measures, not what we
            # asked for - one pixel of drift here shows as a sliver of title bar.
            inner_w = metrics["inner_w"] or width
            inner_h = metrics["inner_h"] or height
            off_x, off_y, cw, ch = chrome_insets(child, inner_w, inner_h)
            host = HostWindow(self.host_title)
            if not host.start(x, y, inner_w, inner_h, on_closed=lambda h=host: self._on_host_closed(h)):
                winwin.set_topmost(child, topmost)
                return {"ok": True, "hosted": False, "reason": "host window failed"}

            adopted_at = time.time()
            if not host.adopt(child, off_x, off_y, cw, ch):
                self._closing = host
                host.close()
                winwin.set_topmost(child, topmost)
                return {"ok": True, "hosted": False, "reason": "could not adopt window"}

            # Shedding its frame on adoption shifts Chrome's viewport. Once it
            # has settled, learn the frame from that one good reading; from then
            # on every size is computed from it rather than re-measured.
            time.sleep(0.45)
            host.learn_frame()
            host.align_child()
            # Windows clamps a plain window to the screen, so a page taller
            # than it measured short. As a child of the host it can be any
            # size - a 1080x1920 phone canvas on a 1440 px screen - so the
            # host takes the size that was asked for and Chrome follows.
            if (inner_w, inner_h) != (int(width), int(height)):
                host.resize_content(int(width), int(height))
            host.schedule_align(0.9)

            self.host = host
            self.parked = False
            host.set_topmost(topmost)
            self._start_watchdog()
            return {"ok": True, "hosted": True}

    def remember_for_rebuild(self, url, cfg):
        self._rebuild_hint = (url, cfg)

    def heal(self, url=None, cfg=None):
        """Make sure the window is right; rebuild it if a nudge is not enough."""
        host = self.host
        if not host or not host.alive():
            return {"ok": True, "state": "closed"}
        if host.aligned():
            return {"ok": True, "state": "ok"}
        host.align_child()
        time.sleep(0.35)
        if host.aligned():
            return {"ok": True, "state": "realigned"}
        # Still off: the frame learned when the window opened no longer fits -
        # it opened on a screen with a different scale (or off every screen)
        # and was moved. Learn it again from what Chrome shows now.
        if host.learn_frame():
            host.align_child()
            time.sleep(0.35)
            if host.aligned():
                return {"ok": True, "state": "relearned"}
        if url and cfg:
            return dict(self.rebuild(url, cfg), state="rebuilt")
        return {"ok": False, "state": "misaligned"}

    def rebuild(self, url, cfg):
        """Close the window and open a fresh one at the same size and place."""
        rect = None
        if self.host and self.host.alive():
            rect = self.host.rect()
        self.close()
        for _ in range(40):
            if not (self.host and self.host.alive()):
                break
            time.sleep(0.05)
        time.sleep(0.35)
        self.metrics = {}
        self.insets = None
        return self.open(url,
                         rect["w"] if rect else cfg["width"],
                         rect["h"] if rect else cfg["height"],
                         rect["x"] if rect else cfg["x"],
                         rect["y"] if rect else cfg["y"],
                         borderless=bool(cfg.get("borderless", True)),
                         topmost=bool(cfg.get("topmost", True)))

    def _start_watchdog(self):
        """Repair the window if Chrome and the host ever drift apart.

        Anything can knock them out of step - Windows moving the window between
        monitors, Chrome re-laying out late - and the visible result is a band
        of bare host background, which looks like the overlay broke.
        """
        if self._watchdog and self._watchdog.is_alive():
            return

        def run():
            misses = 0
            while True:
                time.sleep(2)
                host = self.host
                if not host or not host.alive():
                    return
                try:
                    if host.aligned():
                        misses = 0
                        continue
                    host.align_child()
                    time.sleep(0.3)
                    if not host.aligned() and misses >= 1 and host.learn_frame():
                        # Off two checks running, so not Chrome mid-layout: the
                        # frame learned at opening no longer fits (the window
                        # moved to a screen with another scale). Learn it again
                        # - cheaper and calmer on stream than a rebuild.
                        host.align_child()
                        time.sleep(0.3)
                    misses = 0 if host.aligned() else misses + 1
                    if misses >= 3 and self._rebuild_hint:
                        # Nudging is not getting there; start over cleanly.
                        misses = 0
                        self.rebuild(*self._rebuild_hint)
                        return
                except Exception:
                    pass

        self._watchdog = threading.Thread(target=run, daemon=True)
        self._watchdog.start()

    def _on_host_closed(self, host):
        """A host window is gone: closed by us (close, rebuild, a failed
        open), or by hand - Alt+F4, the taskbar - which the server hears
        about, so a window the user closed is not brought back."""
        if self.host is host:
            self.host = None
            self.child = None
        elif self._closing is not host:
            return                  # a host that never held the window
        if self._closing is host:
            self._closing = None
        elif self.on_user_closed:
            try:
                self.on_user_closed()
            except Exception:
                pass

    def close(self):
        if self.host and self.host.alive():
            self._closing = self.host
            self.host.close()
            self.host = None
            self.child = None
            return True
        hwnd = winwin.find_window(self.page_title)
        if hwnd:
            winwin.close_window(hwnd)
            return True
        return False

    # ------------------------------------------------------------- geometry

    def set_backdrop(self, hex_color):
        if self.host and self.host.alive():
            self.host.set_backdrop(hex_color)

    def apply(self, width=None, height=None, topmost=None):
        if self.host and self.host.alive():
            if topmost is not None:
                self.host.set_topmost(topmost)
            if width and height:
                hx, hy = self.insets or (16, 80)
                self.host.resize_content(int(width), int(height),
                                         int(width) + hx, int(height) + hy)
            return self.host.rect()   # a settle-timer alignment follows

        hwnd = winwin.find_window(self.page_title)
        if not hwnd:
            return None
        if topmost is not None:
            winwin.set_topmost(hwnd, topmost)
        if width and height:
            hx, hy = self.insets or (16, 80)
            winwin.move_resize(hwnd, None, None, width + hx, height + hy)
        return self._plain_rect(hwnd)

    def resize_by(self, dw, dh, min_w=160, min_h=60, max_w=3840, max_h=2160):
        """Grow or shrink from the bottom-right corner, as the grip drags."""
        rect = self.status().get("rect")
        if not rect:
            return None
        w = max(min_w, min(max_w, rect["w"] + int(dw)))
        h = max(min_h, min(max_h, rect["h"] + int(dh)))
        return self.apply(width=w, height=h)

    def resize_edge(self, edge, dx, dy, min_w=160, min_h=60, max_w=3840, max_h=2160):
        """Drag any edge or corner; the opposite edge stays put.

        `edge` is a substring of the eight compass codes (t b l r tl tr bl br);
        `dx`/`dy` are accumulated screen-pixel deltas since the drag began.
        """
        rect = self.status().get("rect")
        if not rect:
            return None
        x, y, w, h = rect["x"], rect["y"], rect["w"], rect["h"]
        dx, dy, edge = int(dx), int(dy), edge or ""

        def clamp_w(v):
            return max(min_w, min(max_w, v))

        def clamp_h(v):
            return max(min_h, min(max_h, v))

        if "l" in edge:
            new_w = clamp_w(w - dx)
            x += w - new_w
            w = new_w
        elif "r" in edge:
            w = clamp_w(w + dx)
        if "t" in edge:
            new_h = clamp_h(h - dy)
            y += h - new_h
            h = new_h
        elif "b" in edge:
            h = clamp_h(h + dy)
        return self._set_bounds(x, y, w, h)

    def _set_bounds(self, x, y, w, h):
        """Move and size the window in one shot; returns the new rect."""
        if self.host and self.host.alive():
            return self.host.set_bounds(int(x), int(y), int(w), int(h))
        hwnd = winwin.find_window(self.page_title)
        if hwnd:
            hx, hy = self.insets or (16, 80)
            winwin.move_resize(hwnd, int(x), int(y), int(w) + hx, int(h) + hy)
            return self._plain_rect(hwnd)
        return None

    def minimize(self):
        """To the taskbar without stealing focus. The page sees itself
        minimized in the snapshot and idles like Ultra (idleHere in
        motion.js), and Chrome shrinks with the host, so it draws next to
        nothing. Measured in P5 with the screen on: a minimized scene costs
        9.8% of a core against 22.0% parked in its place (22.4% if Chrome
        is kept at full size inside the minimized host), and captures at
        the same rate once restored. (The server refuses it for the live output
        while on air: a minimized window cannot be captured.)"""
        if self.host and self.host.alive():
            return self.host.minimize()
        hwnd = winwin.find_window(self.page_title)
        if hwnd:
            return winwin.minimize(hwnd)
        return False

    def restore(self):
        if self.host and self.host.alive():
            return self.host.restore()
        hwnd = winwin.find_window(self.page_title)
        if hwnd:
            return winwin.restore(hwnd)
        return False

    def nudge(self, dx, dy):
        if self.host and self.host.alive():
            r = self.host.rect()
            if r:
                self.host.move(r["x"] + int(dx), r["y"] + int(dy))
                return self.host.rect()
            return None
        hwnd = winwin.find_window(self.page_title)
        if hwnd:
            winwin.nudge(hwnd, dx, dy)
            return self._plain_rect(hwnd)
        return None

    def move(self, x, y):
        if self.host and self.host.alive():
            self.host.move(x, y)
            return self.host.rect()
        hwnd = winwin.find_window(self.page_title)
        if hwnd:
            winwin.move_resize(hwnd, x, y)
            return self._plain_rect(hwnd)
        return None

    PARK_X = -20000

    def park(self):
        """Move off every screen; rendering and capture carry on."""
        rect = self.status().get("rect")
        if not rect:
            return None
        if not self.parked:
            self._parked_from = (rect["x"], rect["y"])
        self.parked = True
        return self.move(self.PARK_X, 0)

    def unpark(self, x=None, y=None):
        """Back to where it was parked from, or to the given spot."""
        if not self.parked:
            return self.status().get("rect")
        fx, fy = self._parked_from or (x or 60, y or 60)
        self.parked = False
        return self.move(x if x is not None and not self._parked_from else fx,
                         y if y is not None and not self._parked_from else fy)
