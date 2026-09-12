"""
VOICE: is the streamer talking right now, and how loud.

While captions run, the caption engine already listens and says whether
it hears speech - that is used as is. Otherwise a small monitor of its own
opens the microphone, but only while a page has asked for it (a lease that
has to be renewed), and closes it the moment nobody needs it. The sound
never leaves the process; only a level and a yes/no do.
"""

import math
import threading
import time

LEASE_S = 30.0          # a page renews well inside this
BLOCK_S = 0.05          # 50 ms of audio per reading
THRESHOLD = 0.08        # level that counts as speech, unless the config says otherwise
HOLD_S = 0.35           # keep "speaking" this long after the last loud block
ATTACK_BLOCKS = 2       # loud blocks in a row before "speaking" turns on


class MicMonitor:
    """RMS level with attack, hold and release, from sounddevice."""

    def __init__(self, device=None, on_change=None, log=None, threshold=None):
        self.device = device
        self.on_change = on_change
        self.log = log or (lambda *_: None)
        self.threshold = threshold or (lambda: THRESHOLD)     # read on every block: a change counts at once
        self.level = 0.0
        self.speaking = False
        self.error = ""
        self._stream = None
        self._loud = 0
        self._last_loud = 0.0

    def start(self):
        try:
            import sounddevice as sd
        except Exception as exc:
            self.error = f"no audio library ({exc})"
            return False
        rate = 16000
        try:
            self._stream = sd.InputStream(samplerate=rate, blocksize=int(rate * BLOCK_S),
                                          channels=1, dtype="float32", device=self._resolve(sd),
                                          callback=self._block)
            self._stream.start()
            self.error = ""
            return True
        except Exception as exc:
            self.error = f"microphone: {exc}"
            self._stream = None
            return False

    def _resolve(self, sd):
        """A device index from a configured name, else the default."""
        if not self.device:
            return None
        try:
            for i, d in enumerate(sd.query_devices()):
                if d.get("max_input_channels", 0) > 0 and self.device.lower() in str(d.get("name", "")).lower():
                    return i
        except Exception:
            pass
        return None

    def _block(self, data, frames, _time, status):
        try:
            try:
                import numpy as np
                rms = float(np.sqrt(np.mean(np.square(data[:, 0], dtype="float64"))))
            except ImportError:
                total = 0.0
                for v in data[:, 0]:
                    total += float(v) * float(v)
                rms = math.sqrt(total / max(1, frames))
        except Exception:
            return
        self.level = min(1.0, rms * 6.0)
        now = time.monotonic()
        if self.level >= self.threshold():
            self._loud += 1
            self._last_loud = now
        else:
            self._loud = 0
        was = self.speaking
        if not was and self._loud >= ATTACK_BLOCKS:
            self.speaking = True
        elif was and now - self._last_loud > HOLD_S:
            self.speaking = False
        if self.speaking != was and self.on_change:
            try:
                self.on_change()
            except Exception:
                pass

    def stop(self):
        s, self._stream = self._stream, None
        if s:
            try:
                s.stop()
                s.close()
            except Exception:
                pass
        self.level, self.speaking = 0.0, False


class Voice:
    def __init__(self, captions, mic_name=None, on_change=None, log=None, threshold=THRESHOLD):
        self.captions = captions            # the CaptionBridge; .get() is a cached read
        self.mic_name = mic_name
        self.threshold = THRESHOLD
        self.set_threshold(threshold)
        self.on_change = on_change
        self.log = log or (lambda *_: None)
        self._monitor = None
        self._leases = {}
        self._lock = threading.Lock()
        self._seq = 0
        self._last_speaking = None
        self.force = None           # tests: a speaking state set by hand

    def set_threshold(self, value):
        """How loud counts as talking for the monitor (0.01-0.9 of full scale).
        While captions listen, their own speech detector decides instead."""
        try:
            self.threshold = min(0.9, max(0.01, float(value)))
        except (TypeError, ValueError):
            pass
        return self.threshold

    def override(self, speaking):
        """For tests on a rig without a microphone: None lifts it."""
        self.force = None if speaking is None else bool(speaking)
        self.tick()
        return self.status()

    def _captions_listening(self):
        try:
            c = self.captions.get()
            return c.get("on") and c.get("state") == "listening", c
        except Exception:
            return False, {}

    def status(self):
        """Everything, level and threshold included - for meters that poll."""
        return dict(self._status(), threshold=self.threshold)

    def _status(self):
        if self.force is not None:
            return {"level": 1.0 if self.force else 0.0, "speaking": self.force,
                    "source": "override", "error": ""}
        listening, c = self._captions_listening()
        if listening:
            return {"level": float(c.get("level") or 0), "speaking": c.get("audio") == "speech",
                    "source": "captions", "error": ""}
        m = self._monitor
        if m:
            return {"level": m.level, "speaking": m.speaking, "source": "monitor", "error": m.error}
        return {"level": 0.0, "speaking": False, "source": "off", "error": ""}

    def snapshot(self):
        """For the state feed: what changes rarely."""
        s = self.status()
        return {"speaking": s["speaking"], "source": s["source"], "error": s["error"],
                "leases": len(self._leases)}

    def hold(self, token=None):
        """A page wants voice state; renew every few seconds or it lapses."""
        with self._lock:
            if not token or token not in self._leases:
                self._seq += 1
                token = str(self._seq)
            self._leases[token] = time.monotonic() + LEASE_S
        self._reconcile()
        return {"ok": True, "token": token, **self.status()}

    def release(self, token):
        with self._lock:
            self._leases.pop(str(token), None)
        self._reconcile()
        return {"ok": True}

    def tick(self):
        """Called by the state pump: expire leases, follow captions."""
        now = time.monotonic()
        with self._lock:
            for t in [t for t, until in self._leases.items() if until < now]:
                del self._leases[t]
        self._reconcile()
        speaking = self.status()["speaking"]
        if speaking != self._last_speaking:
            self._last_speaking = speaking
            if self.on_change:
                self.on_change()

    def _reconcile(self):
        listening, _ = self._captions_listening()
        want = bool(self._leases) and not listening
        with self._lock:
            if want and not self._monitor:
                m = MicMonitor(self.mic_name, on_change=self.on_change, log=self.log, threshold=lambda: self.threshold)
                if m.start():
                    self.log("voice: listening for speech")
                else:
                    self.log("voice: " + m.error)
                self._monitor = m
            elif not want and self._monitor:
                self._monitor.stop()
                self._monitor = None
                self.log("voice: monitor off")

    def stop(self):
        with self._lock:
            self._leases.clear()
        self._reconcile()
