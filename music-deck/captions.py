"""
Python side of the live-captions bridge.

Runs one PowerShell helper on demand - never at boot unless captions were left
on - reads the partial and final phrases it emits, and hands the server a small
rolling window of what was just said. Windows' own on-device recognizer does
the listening; nothing leaves this machine.
"""

import collections
import json
import os
import subprocess
import threading
import time

import paths

SCRIPT = paths.resource("captions.ps1")


class CaptionBridge:
    """The last few things said into the microphone, as text."""

    KEEP = 8            # finals kept server-side; the window shows fewer
    MIN_CONF = 0.05     # below this a "final" is noise the engine guessed at

    def __init__(self):
        self._lock = threading.Lock()
        self._proc = None
        self._on = False
        self._gen = 0                     # bumps per start(), so a stale reader can tell
        self._available = None            # None = starting, True = listening, False = error
        self._error = ""
        self._audio = ""
        self._partial = ""
        self._lines = collections.deque(maxlen=self.KEEP)
        self._version = 0                 # bumps on every visible change
        self._recognizer = ""

    # ------------------------------------------------------------- lifecycle

    def start(self):
        with self._lock:
            if self._on:
                return
            self._on = True
            self._gen += 1
            gen = self._gen
            self._available = None
            self._error = ""
            self._partial = ""
            self._audio = ""
            self._version += 1
        threading.Thread(target=self._supervise, args=(gen,), daemon=True).start()

    def stop(self):
        with self._lock:
            self._on = False
            self._available = None
            self._partial = ""
            self._audio = ""
            self._version += 1
            proc, self._proc = self._proc, None
        if proc:
            try:
                proc.kill()
            except Exception:
                pass

    def _spawn(self):
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        return subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", SCRIPT, str(os.getpid())],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace",
            bufsize=1, creationflags=flags,
        )

    def _supervise(self, gen):
        """Keep the helper alive while captions are on.

        A helper that reports a problem - no microphone, no recognizer - is
        retried slowly, since a microphone may get plugged in, and the deck
        shows the reason in the meantime. One that simply dies is restarted.
        """
        backoff = 5
        while True:
            with self._lock:
                if not self._on or self._gen != gen:
                    return
            try:
                proc = self._spawn()
            except Exception as exc:
                with self._lock:
                    self._available = False
                    self._error = f"Could not start PowerShell: {exc}"
                    self._version += 1
                return
            with self._lock:
                self._proc = proc
            failed = False
            try:
                for line in proc.stdout:
                    with self._lock:
                        if not self._on or self._gen != gen:
                            break
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    if self._apply(msg):
                        failed = True
            except Exception:
                pass
            try:
                proc.kill()
            except Exception:
                pass
            with self._lock:
                if not self._on or self._gen != gen:
                    return
                if not failed:
                    self._available = None
                    self._error = "Captions stopped unexpectedly - restarting"
                    self._version += 1
            time.sleep(backoff if failed else 2)
            backoff = min(backoff * 2, 60)

    def _apply(self, msg):
        """Fold one helper message into the state. True means the helper
        reported something fatal and is about to exit."""
        with self._lock:
            if msg.get("ok") is False:
                self._available = False
                self._error = msg.get("error") or "captions unavailable"
                self._partial = ""
                self._version += 1
                return True
            if msg.get("ready"):
                self._available = True
                self._error = ""
                self._recognizer = msg.get("recognizer") or ""
                self._version += 1
                return False
            t = msg.get("t")
            if t == "partial":
                self._partial = (msg.get("text") or "").strip()
                self._version += 1
            elif t == "final":
                text = (msg.get("text") or "").strip()
                self._partial = ""
                # Room noise now and then settles into a "phrase" the engine
                # itself barely believes (a keyboard became "it has a has" at
                # 0.01). Real speech scores far above this; noise does not.
                conf = msg.get("conf")
                if text and (conf is None or conf >= self.MIN_CONF):
                    self._lines.append({"text": text, "at": round(time.time(), 2),
                                        "conf": conf})
                self._version += 1
            elif t == "audio":
                self._audio = msg.get("state") or ""
                self._version += 1
            return False

    # ------------------------------------------------------------- readout

    def get(self):
        """State for the broadcast: what is showing and why."""
        with self._lock:
            if not self._on:
                state = "off"
            elif self._available is None:
                state = "starting"
            elif self._available:
                state = "listening"
            else:
                state = "unavailable"
            return {
                "on": self._on,
                "state": state,
                "audio": self._audio,
                "error": self._error,
                "recognizer": self._recognizer,
                "partial": self._partial,
                "lines": list(self._lines),
                "version": self._version,
            }

    def clear(self):
        with self._lock:
            self._lines.clear()
            self._partial = ""
            self._version += 1
