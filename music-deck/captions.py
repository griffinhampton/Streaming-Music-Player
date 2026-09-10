"""
The live-captions bridge: one state, two engines.

  whisper  OpenAI's Whisper on the CPU (captions_whisper.py) - accurate, the
           default once its model is downloaded.
  windows  Windows' own dictation engine in a PowerShell helper
           (captions.ps1) - nothing to download, but it guesses a lot.

Either way nothing leaves this machine, the microphone opens only when
someone presses Start, and the server gets the same small rolling window of
what was just said. Both engines speak one message protocol (ready / partial
/ final / audio / level), folded into that state by _apply.
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
        self._proc = None                 # the Windows helper, when that engine runs
        self._stop_evt = None             # tells a Whisper session to wind down
        self._listener = None             # the running Whisper session, if any
        self._settings = {"engine": "windows"}
        self._on = False
        self._gen = 0                     # bumps per start(), so a stale reader can tell
        self._available = None            # None = starting, True = listening, False = error
        self._error = ""
        self._audio = ""
        self._level = 0.0
        self._partial = ""
        self._lines = collections.deque(maxlen=self.KEEP)
        self._version = 0                 # bumps on every visible change
        self._recognizer = ""

    # ------------------------------------------------------------- lifecycle

    def configure(self, settings):
        """Engine, model folder, microphone, expected words. A running
        session restarts if anything it depends on changed."""
        with self._lock:
            old, self._settings = self._settings, dict(settings)
            running, listener = self._on, self._listener
        if settings == old or not running:
            return
        rest = lambda s: {k: v for k, v in s.items() if k != "words"}
        if listener is not None and rest(settings) == rest(old):
            # New words to expect: a running Whisper takes them on its next
            # read, without the second or two a restart would cost.
            listener.set_words(settings.get("words", ""))
            return
        self.stop()
        self.start()

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
            engine = self._settings.get("engine")
        target = self._supervise_whisper if engine == "whisper" else self._supervise_windows
        threading.Thread(target=target, args=(gen,), daemon=True).start()

    def stop(self):
        with self._lock:
            self._on = False
            self._available = None
            self._partial = ""
            self._audio = ""
            self._level = 0.0
            self._version += 1
            proc, self._proc = self._proc, None
            evt, self._stop_evt = self._stop_evt, None
            self._listener = None
        if evt:
            evt.set()
        if proc:
            try:
                proc.kill()
            except Exception:
                pass

    def _current(self, gen):
        with self._lock:
            return self._on and self._gen == gen

    # ------------------------------------------------------------- Whisper

    def _supervise_whisper(self, gen):
        """Run Whisper sessions while captions are on. One that cannot start
        - no microphone, a model that will not load - is retried slowly, and
        the deck shows why in the meantime."""
        backoff = 5
        while True:
            with self._lock:
                if not self._on or self._gen != gen:
                    return
                s = dict(self._settings)
                stop = threading.Event()
                self._stop_evt = stop
            if not s.get("model_dir"):
                self._apply({"ok": False, "error": "Whisper's model isn't downloaded yet - "
                                                   "press Download on the Captions tab."})
                return        # finishing the download reconfigures, which restarts this

            def emit(msg, gen=gen):
                if self._current(gen):
                    self._apply(msg)
            try:
                from captions_whisper import WhisperListener
                listener = WhisperListener(s["model_dir"], emit, mic=s.get("mic", ""),
                                           words=s.get("words", ""),
                                           label=s.get("label", "Whisper"))
                with self._lock:
                    if self._gen == gen:
                        self._listener = listener
                ok = listener.run(stop)
            except Exception as exc:
                emit({"ok": False, "error": f"Whisper stopped: {exc}"})
                ok = False
            if not self._current(gen):
                return
            time.sleep(2 if ok else backoff)
            if not ok:
                backoff = min(backoff * 2, 60)

    # ------------------------------------------------------------- Windows

    def _spawn(self):
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        return subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", SCRIPT, str(os.getpid())],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace",
            bufsize=1, creationflags=flags,
        )

    def _supervise_windows(self, gen):
        """Keep the PowerShell helper alive while captions are on.

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

    # ------------------------------------------------------------- state

    def _apply(self, msg):
        """Fold one engine message into the state. True means the engine
        reported something fatal and is about to stop."""
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
            if t == "level":
                # The meter moves constantly; it is not a visible change of
                # the captions themselves, so it leaves the version alone.
                self._level = float(msg.get("value") or 0)
            elif t == "partial":
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
                "engine": self._settings.get("engine", "windows"),
                "audio": self._audio,
                "level": self._level,
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
