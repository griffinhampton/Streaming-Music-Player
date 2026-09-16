"""
Text to speech (T7): chat, read out loud, in Windows' own voices.

The voices are System.Speech's, driven by a PowerShell helper (tts.ps1) the
way captions.ps1 drives recognition: a child process, JSON lines in and out,
nothing to download and nothing leaving this machine.

The helper never plays anything. Each utterance comes back as a WAV that is
kept here briefly for the scene page to fetch, and the Voice layer on the scene
on air plays it (scene.js, TYPES.speak). That detour is the design: played by
the page, a voice obeys everything the canvas already enforces - the layer's
own volume, Stop effects, Skip, and "only the scene on air answers" (T11). Made
to play by this process it would obey none of them.

Reading viewer-written text aloud is the riskiest thing the app does - a stream
cannot be un-said - so the abuse controls ship in this step rather than after
it (docs/INTERACTIVITY_PLAN.md, T7). clean_text() caps the length, refuses
blocked words, reads a link as "a link" and flattens "aaaaaaa"; the queue here
refuses past MAX_WAITING; and the command engine's waits, effects budget and
pause (T10) stand in front of all of it.
"""

import base64
import json
import os
import queue
import re
import subprocess
import threading
import time
import uuid
from collections import OrderedDict

import paths

SCRIPT = paths.resource("tts.ps1")

MAXLEN = 150            # letters: the layer's default, and it may set 20 to 500
MAX_WAITING = 5         # utterances being made or waiting to be; past this, refused
KEEP_CLIPS = 12         # finished clips held for the scene page to fetch
START_TIMEOUT = 20      # seconds for PowerShell and System.Speech to come up
SAY_TIMEOUT = 30        # seconds one utterance may take to make
IDLE_SECONDS = 300      # the helper is let go after this long with nothing to say

_URL = re.compile(r"(?i)\b(?:https?://|www\.)\S+")
_REPEAT = re.compile(r"(.)\1{3,}")
_RUNS = re.compile(r"(.)\1+")
_CTRL = re.compile(r"[\x00-\x1f\x7f]")
_SPACE = re.compile(r"\s+")


def blocked_words(value):
    """The layer's list as words and phrases - one per line or separated by
    commas - lower-cased, at most 200."""
    out = []
    for part in re.split(r"[,\n]", str(value or "")):
        w = _SPACE.sub(" ", part).strip().lower()
        if w and w not in out:
            out.append(w)
    return out[:200]


def _has(haystack, word):
    return re.search(r"(?<![0-9a-z])" + re.escape(word) + r"(?![0-9a-z])", haystack) is not None


def clean_text(text, maxlen=MAXLEN, blocked=""):
    """(what may be read out, "") - or (None, why not)."""
    t = _CTRL.sub(" ", str(text or ""))
    t = _URL.sub("a link", t)
    t = _REPEAT.sub(lambda m: m.group(1) * 3, t)       # "aaaaaaaa" is read as "aaa"
    t = _SPACE.sub(" ", t).strip()
    if not t:
        return None, "there was nothing to read out"
    # Matched twice: as written, and with every run of a letter squashed to
    # one - or a blocked word gets past the list by stretching a vowel.
    low = t.lower()
    squashed = _RUNS.sub(r"\1", low)
    for w in blocked_words(blocked):
        if _has(low, w) or _has(squashed, _RUNS.sub(r"\1", w)):
            return None, "that has a blocked word in it"
    try:
        n = max(20, min(500, int(maxlen)))
    except (TypeError, ValueError):
        n = MAXLEN
    if len(t) > n:
        cut = t[:n]
        space = cut.rfind(" ")
        t = (cut[:space] if space > n * 0.6 else cut).rstrip(" ,;:-")
    return t, ""


def _rate(value):
    try:
        return max(-10, min(10, int(value)))
    except (TypeError, ValueError):
        return 0


def _spawn_powershell():
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    return subprocess.Popen(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, str(os.getpid())],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", errors="replace", bufsize=1, creationflags=flags,
    )


def _pump(proc, lines):
    """The helper's stdout, parsed, onto a queue - so waiting for an answer can
    have a time limit, which a bare readline() cannot."""
    try:
        for line in proc.stdout:
            line = line.strip()
            if line.startswith("{"):
                try:
                    lines.put(json.loads(line))
                except ValueError:
                    pass
    except Exception:
        pass
    lines.put(None)                                     # gone


def _next(lines, timeout):
    try:
        return lines.get(timeout=max(0.0, timeout))
    except queue.Empty:
        return None


def _kill(proc):
    try:
        proc.kill()
    except Exception:
        pass


class Voice:
    """The helper, one utterance at a time, and the clips it made.

    `spawn` is injected so the process handling can be tested without
    PowerShell; everything else is the same code the app runs.
    """

    def __init__(self, log=None, spawn=None, say_timeout=SAY_TIMEOUT,
                 start_timeout=START_TIMEOUT, idle_seconds=IDLE_SECONDS):
        self.log = log or (lambda *_: None)
        self._spawn = spawn or _spawn_powershell
        self.say_timeout = say_timeout
        self.start_timeout = start_timeout
        self.idle_seconds = idle_seconds
        self._lock = threading.Lock()
        self._jobs = queue.Queue()
        self._waiting = 0
        self._clips = OrderedDict()
        self._voices = None
        self._proc = None
        self._lines = None
        self._worker = None
        self.error = ""
        self.made = 0
        self.failed = 0

    # -- asking
    def say(self, text, voice="", rate=0, done=None):
        """Queue one utterance: (True, clip id) or (False, why).

        `done(id, ok, error)` is called from the worker once the clip exists or
        cannot. Refused here rather than queued without end: a flood that the
        engine's limits let through must still not become a minute of speech.
        """
        with self._lock:
            if self._waiting >= MAX_WAITING:
                return False, "the voice has too much to say already - try again in a moment"
            self._waiting += 1
        cid = uuid.uuid4().hex[:16]
        self._jobs.put({"op": "say", "id": cid, "text": str(text), "voice": str(voice or ""),
                        "rate": _rate(rate), "done": done})
        self._ensure_worker()
        return True, cid

    def say_and_wait(self, text, voice="", rate=0, timeout=None):
        """The inspector's "Hear it": the same queue, waited on."""
        got, ev = {}, threading.Event()

        def done(cid, ok, err):
            got.update(id=cid, ok=ok, error=err)
            ev.set()
        ok, res = self.say(text, voice, rate, done)
        if not ok:
            return False, res
        if not ev.wait(timeout or (self.start_timeout + self.say_timeout + 5)):
            return False, "the voice took too long"
        return (True, got["id"]) if got.get("ok") else (False, got.get("error") or "the voice could not say that")

    def voices(self, timeout=None):
        """The installed voices, asked for once and then remembered."""
        if self._voices is not None:
            return list(self._voices)
        ev, box = threading.Event(), {}
        self._jobs.put({"op": "voices", "event": ev, "box": box})
        self._ensure_worker()
        ev.wait(timeout or (self.start_timeout + self.say_timeout))
        got = box.get("voices")
        if isinstance(got, list):
            self._voices = [v for v in got if isinstance(v, dict) and v.get("name")]
            return list(self._voices)
        if isinstance(got, dict) and got.get("name"):   # PowerShell unwraps a list of one
            self._voices = [got]
            return list(self._voices)
        return []

    def clip(self, cid):
        with self._lock:
            return self._clips.get(str(cid or ""))

    def status(self):
        with self._lock:
            return {"running": bool(self._proc and self._proc.poll() is None),
                    "waiting": self._waiting, "kept": len(self._clips),
                    "made": self.made, "failed": self.failed, "error": self.error}

    def close(self):
        self._stop_helper()

    # -- the worker
    def _ensure_worker(self):
        with self._lock:
            if self._worker and self._worker.is_alive():
                return
            self._worker = threading.Thread(target=self._work, name="tts", daemon=True)
            self._worker.start()

    def _work(self):
        while True:
            try:
                job = self._jobs.get(timeout=self.idle_seconds)
            except queue.Empty:
                # Nothing to say for a while: let the helper go. The next
                # message starts it again, which costs a second or two once.
                self._stop_helper()
                with self._lock:
                    if self._jobs.empty():
                        self._worker = None
                        return
                continue
            if job["op"] == "voices":
                ans = self._ask({"op": "voices"}, self.say_timeout)
                job["box"]["voices"] = ans.get("voices") if ans.get("ok") else None
                job["event"].set()
                continue
            ans = self._ask({k: job[k] for k in ("op", "id", "text", "voice", "rate")}, self.say_timeout)
            ok, err = False, ""
            if ans.get("ok"):
                try:
                    wav = base64.b64decode(ans.get("wav") or "")
                except (ValueError, TypeError):
                    wav = b""
                if wav[:4] == b"RIFF" and len(wav) > 44:
                    with self._lock:
                        self._clips[job["id"]] = wav
                        while len(self._clips) > KEEP_CLIPS:
                            self._clips.popitem(last=False)
                        self.made += 1
                    ok = True
                else:
                    err = "the voice made no sound"
            else:
                err = ans.get("error") or "the voice did not answer"
            with self._lock:
                self._waiting -= 1
                if not ok:
                    self.failed += 1
            if not ok:
                self.log(f"voice: could not say that: {err}")
            if job.get("done"):
                try:
                    job["done"](job["id"], ok, err)
                except Exception as exc:                 # a caller's bug must not stop the voice
                    self.log(f"voice: {exc}")

    def _helper(self):
        """The running helper, started if it is not. False, with self.error
        saying why, when it cannot be."""
        p = self._proc
        if p is not None and p.poll() is None:
            return True
        self._stop_helper()
        try:
            p = self._spawn()
        except Exception as exc:
            self.error = f"Could not start PowerShell: {exc}"
            return False
        lines = queue.Queue()
        threading.Thread(target=_pump, args=(p, lines), daemon=True).start()
        first = _next(lines, self.start_timeout)
        if not first or not first.get("ready"):
            self.error = (first or {}).get("error") or "Windows text to speech did not start"
            _kill(p)
            return False
        self._proc, self._lines, self.error = p, lines, ""
        return True

    def _ask(self, req, timeout):
        """One request, one answer, or a helper that is let go."""
        if not self._helper():
            return {"ok": False, "error": self.error}
        try:
            self._proc.stdin.write(json.dumps(req) + "\n")
            self._proc.stdin.flush()
        except (OSError, ValueError, AttributeError) as exc:
            self._stop_helper()
            return {"ok": False, "error": f"the voice stopped: {exc}"}
        deadline = time.monotonic() + timeout
        while True:
            msg = _next(self._lines, deadline - time.monotonic())
            if msg is None:
                # Too slow, or gone. Either way it is not trusted with the next
                # one: an answer that turns up late would be taken for the
                # answer to something else.
                late = time.monotonic() >= deadline
                self._stop_helper()
                return {"ok": False, "error": "the voice took too long" if late else "the voice stopped"}
            if msg.get("op") == req["op"] and (req["op"] != "say" or msg.get("id") == req["id"]):
                return msg

    def _stop_helper(self):
        p, self._proc, self._lines = self._proc, None, None
        if p is not None:
            try:
                p.stdin.close()                           # the helper exits on end of input
            except Exception:
                pass
            _kill(p)
