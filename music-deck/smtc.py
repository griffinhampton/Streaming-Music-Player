"""
Python side of the Windows media-session bridge.

Keeps one PowerShell helper alive, reads its JSON lines, and hands the server a
current picture of whatever Spotify (or any other app) is playing. Restarts the
helper if it dies. Everything is local - no Spotify account, no network.
"""

import json
import os
import subprocess
import threading
import time

import paths

SCRIPT = paths.resource("smtc.ps1")
CACHE = paths.data("cache")
ART_DIR = os.path.join(CACHE, "art")
CMD_FILE = os.path.join(CACHE, "command.txt")

# Friendlier names than the raw app-model ids Windows reports.
_APP_NAMES = {
    "spotify": "Spotify",
    "chrome": "Chrome",
    "msedge": "Edge",
    "firefox": "Firefox",
    "vlc": "VLC",
    "applemusic": "Apple Music",
    "itunes": "iTunes",
    "foobar": "foobar2000",
    "musicbee": "MusicBee",
    "aimp": "AIMP",
}


def _pretty_app(app_id):
    low = (app_id or "").lower()
    for key, name in _APP_NAMES.items():
        if key in low:
            return name
    base = (app_id or "").split("!")[-1]
    return base.replace(".exe", "") or "System"


class MediaBridge:
    """Live view of the Windows 'now playing' session."""

    def __init__(self):
        self._lock = threading.Lock()
        self._proc = None
        self._stop = threading.Event()
        self._raw = {}
        self._received_at = 0.0
        self._available = None      # None = still starting up
        self._error = ""
        self._interval_ms = 400     # while music plays; ultra optimized asks for 1000
        os.makedirs(ART_DIR, exist_ok=True)

    # ------------------------------------------------------------- lifecycle

    def start(self):
        threading.Thread(target=self._supervise, daemon=True).start()

    def _spawn(self):
        flags = 0
        if os.name == "nt":
            flags = subprocess.CREATE_NO_WINDOW
        return subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", SCRIPT, ART_DIR, CMD_FILE, str(self._interval_ms), str(os.getpid())],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace",
            bufsize=1, creationflags=flags,
        )

    def _supervise(self):
        backoff = 2
        while not self._stop.is_set():
            try:
                self._proc = self._spawn()
            except Exception as exc:
                with self._lock:
                    self._available = False
                    self._error = f"Could not start PowerShell: {exc}"
                return

            try:
                for line in self._proc.stdout:
                    if self._stop.is_set():
                        break
                    line = line.strip()
                    if not line or not line.startswith("{"):
                        continue
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    with self._lock:
                        if not msg.get("ok", True):
                            self._available = False
                            self._error = msg.get("error", "media session unavailable")
                            continue
                        self._available = True
                        self._error = ""
                        if msg.get("ready"):
                            continue
                        self._raw = msg
                        self._received_at = time.time()
            except Exception:
                pass

            if self._stop.is_set():
                return
            # Helper exited (Windows restart, session change). Try again shortly.
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)

    def stop(self):
        self._stop.set()
        if self._proc:
            try:
                self._proc.kill()
            except Exception:
                pass

    # ------------------------------------------------------------- readout

    def get(self):
        """Current session, with the progress bar advanced to right now."""
        with self._lock:
            raw = dict(self._raw)
            received = self._received_at
            available = self._available
            error = self._error

        if available is None:
            return {"available": None, "has": False, "status": "starting"}
        if not available:
            return {"available": False, "has": False, "error": error}
        if not raw.get("has"):
            return {"available": True, "has": False}

        # Spotify refreshes its timeline lazily; close the gap ourselves.
        position = float(raw.get("position") or 0)
        duration = float(raw.get("duration") or 0)
        if raw.get("playing"):
            position += float(raw.get("age") or 0) + max(0.0, time.time() - received)
        if duration > 0:
            position = max(0.0, min(position, duration))

        art = raw.get("art") or ""
        return {
            "available": True,
            "has": True,
            "source": "spotify" if "spotify" in (raw.get("app") or "").lower() else "system",
            "app": _pretty_app(raw.get("app")),
            "app_id": raw.get("app") or "",
            "title": raw.get("title") or "",
            "artist": raw.get("artist") or "",
            "album": raw.get("album") or "",
            "playing": bool(raw.get("playing")),
            "status": raw.get("status") or "",
            "position": round(position, 2),
            "duration": round(duration, 2),
            "has_art": bool(art and os.path.isfile(art)),
            "art_token": os.path.basename(art),
            "can_next": bool(raw.get("canNext")),
            "can_prev": bool(raw.get("canPrev")),
            "can_pause": bool(raw.get("canPause")),
            "can_play": bool(raw.get("canPlay")),
            "stale": time.time() - received > 5,
        }

    def art_path(self, token):
        """Resolve an art token to a file inside the cache, or None."""
        if not token:
            return None
        name = os.path.basename(token)
        if not name.startswith("smtc_"):
            return None
        path = os.path.join(ART_DIR, name)
        return path if os.path.isfile(path) else None

    def command(self, cmd):
        """Ask the helper to drive playback: play / pause / playpause / next / prev."""
        if cmd not in ("play", "pause", "playpause", "next", "prev"):
            return False
        return self._send(cmd)

    def set_interval(self, ms):
        """How often to read Windows while music plays. Ultra optimized asks for
        once a second; a running helper picks it up at its next command check,
        and a restarted one is launched with it."""
        ms = max(100, int(ms))
        if ms == self._interval_ms:
            return
        self._interval_ms = ms
        if self._proc and self._proc.poll() is None:
            self._send(f"interval {ms}")

    def _send(self, line):
        # One command per line, appended, so a press and a pace change sent
        # close together both arrive instead of one overwriting the other.
        try:
            os.makedirs(CACHE, exist_ok=True)
            with open(CMD_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
            return True
        except Exception:
            return False
