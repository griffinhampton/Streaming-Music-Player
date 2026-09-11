"""
The native video path into the LIVE engine: a window (or monitor) captured
with Windows Graphics Capture, converted to NV12 and encoded by the graphics
card through Media Foundation, pushed to `live.LiveEngine` as FLV video -
all in this process, no pixel ever on the CPU. Audio comes from `audio.py`
(or the page, on the browser path); the engine stamps both against one
clock.
"""

import threading
import time

import capture
import mfenc
from live import K_META, K_VCONFIG, K_VIDEO


class NativeVideo:
    def __init__(self, engine, log=None):
        self.engine = engine
        self.log = log or (lambda *_: None)
        self._thread = None
        self._stop = threading.Event()
        self._ready = threading.Event()    # set once the encoder runs, or the attempt failed
        self.error = ""
        self.stats = {"fps": 0, "dropped": 0, "size": "", "encoder": "", "frames": 0, "settings": {}}
        self._enc = None

    def status(self):
        return {"running": bool(self._thread and self._thread.is_alive()), "error": self.error,
                **self.stats}

    def force_keyframe(self):
        enc = self._enc
        return bool(enc and enc.force_keyframe())

    def wait_ready(self, timeout=8.0):
        """True once frames are being encoded; False if that failed (see
        `error`) or nothing happened within `timeout` seconds."""
        return self._ready.wait(timeout) and not self.error

    def start(self, title=None, hwnd=None, monitor=None, fps=30, kbps=3400):
        if self._thread and self._thread.is_alive():
            return {"ok": True, "already": True}
        if not hwnd and title:
            hwnd = capture.find_window(title)
        if not hwnd and monitor is None:
            return {"ok": False, "error": f"no window titled like {title!r}"}
        self.error = ""
        self.stats.update(fps=0, dropped=0, size="", encoder="", frames=0)
        self._stop.clear()
        self._ready.clear()
        self._thread = threading.Thread(target=self._run, args=(hwnd, monitor, int(fps), int(kbps)), daemon=True)
        self._thread.start()
        return {"ok": True}

    def stop(self):
        self._stop.set()
        t = self._thread
        if t and t.is_alive():
            t.join(5)
        self._thread = None
        return {"ok": True}

    def _run(self, hwnd, monitor, fps, kbps):
        cap = enc = conv = None
        try:
            d3d = capture.D3D()
            cap = capture.WindowCapture(d3d, hwnd=hwnd, monitor=monitor)
            cap.start()
            deadline = time.monotonic() + 5
            while not cap.poll():
                if self._stop.is_set() or time.monotonic() > deadline:
                    raise OSError("no frame arrived from the window")
                time.sleep(0.01)
            w, h = cap.texture_size
            enc = mfenc.H264Encoder(d3d, w, h, fps, kbps, log=self.log)
            self._enc = enc
            if enc.input_format == "nv12":
                # Convert on the GPU ourselves; see capture.Nv12Converter.
                conv = capture.Nv12Converter(d3d, w, h, fps)
            self.stats.update(size=f"{w}x{h}", encoder=enc.name,
                              settings=dict(enc.codec_settings, input=enc.input_format))
            self.engine.push(K_META, 0, 0, _meta(w, h, fps, kbps))
            self._ready.set()
            self._loop(cap, enc, conv, fps)
        except OSError as exc:
            self.error = str(exc)
            self.log(f"native video: {exc}")
        finally:
            self._ready.set()
            self._enc = None
            if enc:
                enc.close()
            if conv:
                conv.close()
            if cap:
                cap.close()

    def _loop(self, cap, enc, conv, fps):
        period = 1.0 / fps
        t0 = time.perf_counter()
        next_tick = t0
        pending, tick, sent_avcc = None, 0, None
        rate_n, rate_t = 0, t0
        # Frames are stamped by their tick, offset to the engine's clock, so
        # they come out evenly spaced whatever the encoder's own delay does.
        base_ms = self.engine.clock_ms()
        while not self._stop.is_set():
            now = time.perf_counter()
            if now >= next_tick:
                next_tick += period
                if now - next_tick > 1.0:          # fell far behind: start afresh
                    next_tick = now + period
                if pending is not None:
                    self.stats["dropped"] += 1
                if cap.poll() or cap.texture is not None:
                    if cap.texture_size != (enc.width, enc.height):
                        raise OSError(f"the output window changed size to {cap.texture_size[0]}x{cap.texture_size[1]} "
                                      f"while streaming at {enc.width}x{enc.height} - stop and start again to "
                                      f"stream at the new size")
                    # The frame the encoder gets: NV12 of our making, or the
                    # captured BGRA when the encoder converts itself.
                    pending = conv.convert(cap.texture) if conv else cap.texture
                    tick += 1
            if pending is not None and enc.ready():
                if enc.submit(pending, int(tick * 1e7 / fps), int(1e7 / fps)):
                    pending = None
            else:
                time.sleep(0.002)
            for key, ms, payload in enc.collect():
                stamp = base_ms + ms
                if enc.avcc and enc.avcc != sent_avcc:
                    sent_avcc = enc.avcc
                    self.engine.push(K_VCONFIG, stamp, 0, enc.avcc)
                self.engine.push(K_VIDEO, stamp, 1 if key else 0, payload)
                self.stats["frames"] += 1
                rate_n += 1
            if now - rate_t >= 1.0:
                self.stats["fps"] = round(rate_n / (now - rate_t), 1)
                rate_n, rate_t = 0, now


def _meta(w, h, fps, kbps):
    import json
    return json.dumps({"width": w, "height": h, "framerate": fps, "videodatarate": kbps,
                       "videocodecid": 7, "encoder": "Awesome Streaming Deck"}).encode("utf-8")
