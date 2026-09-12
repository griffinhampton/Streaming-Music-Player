"""
The native video path into the LIVE engine: the output window captured
with Windows Graphics Capture, the scene's native sources (a camera, a
window, a screen) keyed into the holes it left for them, the whole frame
converted to NV12 and encoded by the graphics card through Media
Foundation, pushed to `live.LiveEngine` as FLV video - all in this
process, no pixel ever on the CPU but a camera's. Audio comes from
`audio.py` (or the page, on the browser path); the engine stamps both
against one clock.
"""

import ctypes
import json
import threading
import time

import capture
import mfenc
from live import K_META, K_VCONFIG, K_VIDEO


class _Sources:
    """The scene's native sources as compositor inputs, built on the
    encoder's thread from the specs `scenes.native_sources` makes: a window
    or screen through WGC, a camera through Media Foundation. Specs that
    did not change keep their capture; the rest is rebuilt."""

    def __init__(self, d3d, log):
        self.d3d, self.log = d3d, log
        self.items = []            # [(spec key, spec, capture object)]

    def apply(self, specs):
        keep = {key: (spec, obj) for key, spec, obj in self.items}
        items = []
        for spec in specs or []:
            key = json.dumps(spec, sort_keys=True)
            if key in keep:
                items.append((key, spec, keep.pop(key)[1]))
                continue
            try:
                obj = self._open(spec)
            except Exception as exc:          # a missing window is not the stream's problem
                obj = {"error": str(exc)}
                self.log(f"native source {spec.get('kind')}: {exc}")
            items.append((key, spec, obj))
        for _, obj in keep.values():
            self._close(obj)
        self.items = items

    def _open(self, spec):
        kind = spec.get("kind")
        if kind == "camera":
            import camera
            return camera.Camera(self.d3d, spec.get("device", ""), spec.get("width", 1280), spec.get("height", 720),
                                 spec.get("fps", 30), log=self.log)
        if kind == "monitor":
            mons = capture.list_monitors()
            i = int(spec.get("monitor") or 0)
            if not 0 <= i < len(mons):
                raise OSError(f"no screen {i}")
            cap = capture.WindowCapture(self.d3d, monitor=mons[i]["hmon"], cursor=spec.get("cursor", False))
        else:
            hwnd = capture.find_window(spec.get("title") or "")
            if not hwnd:
                raise OSError(f"no window titled like {spec.get('title')!r}")
            cap = capture.WindowCapture(self.d3d, hwnd=hwnd, cursor=spec.get("cursor", False))
        cap.start()
        return cap

    @staticmethod
    def _close(obj):
        try:
            if hasattr(obj, "close"):
                obj.close()
        except Exception:
            pass

    def tick(self):
        """Pull the newest frame of every source; the compositor reads the
        textures right after."""
        for _, spec, obj in self.items:
            try:
                if isinstance(obj, dict):
                    continue
                if spec.get("kind") == "camera":
                    obj.upload()
                else:
                    obj.poll()
            except Exception as exc:
                self.log(f"native source {spec.get('kind')}: {exc}")

    def inputs(self):
        """What the compositor keys in, in layer order."""
        out = []
        for _, spec, obj in self.items:
            if isinstance(obj, dict):
                continue
            if spec.get("kind") == "camera":
                out.append({"texture": (lambda o=obj: o.texture if o.have else None), "size": obj.size,
                            "rect": tuple(spec["rect"]), "fit": spec.get("fit", "cover"),
                            "mirror": bool(spec.get("mirror")), "flip": bool(getattr(obj, "flip", False))})
            else:
                out.append({"texture": (lambda o=obj: o.texture), "size": (lambda o=obj: o.texture_size if o.texture else None),
                            "rect": tuple(spec["rect"]), "fit": spec.get("fit", "contain")})
        return out

    def status(self):
        out = []
        for _, spec, obj in self.items:
            row = {"kind": spec.get("kind"), "rect": list(spec["rect"])}
            if isinstance(obj, dict):
                row["error"] = obj.get("error", "")
            elif spec.get("kind") == "camera":
                row.update(obj.status())
            else:
                row.update({"title": spec.get("title", ""), "size": "%dx%d" % obj.texture_size if obj.texture else "",
                            "frames": obj.frames})
            out.append(row)
        return out

    def close(self):
        for _, _, obj in self.items:
            self._close(obj)
        self.items = []


class NativeVideo:
    def __init__(self, engine, log=None):
        self.engine = engine
        self.log = log or (lambda *_: None)
        self._thread = None
        self._stop = threading.Event()
        self._ready = threading.Event()    # set once the encoder runs, or the attempt failed
        self.error = ""
        self.stats = {"fps": 0, "dropped": 0, "size": "", "encoder": "", "frames": 0, "settings": {},
                      "stalled": False,     # no frame from the window for two seconds
                      "sources": []}
        self._enc = None
        self._specs = []                   # the scene's native sources, as specs
        self._specs_changed = threading.Event()

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

    def set_sources(self, specs):
        """The scene's native sources (see scenes.native_sources); picked up
        by the encoder thread at its next tick, live or not yet."""
        self._specs = list(specs or [])
        self._specs_changed.set()

    def start(self, title=None, hwnd=None, monitor=None, fps=30, kbps=3400, sources=None):
        if self._thread and self._thread.is_alive():
            return {"ok": True, "already": True}
        if not hwnd and title:
            hwnd = capture.find_window(title)
        if not hwnd and monitor is None:
            return {"ok": False, "error": f"no window titled like {title!r}"}
        self.error = ""
        self.stats.update(fps=0, dropped=0, size="", encoder="", frames=0, stalled=False, sources=[])
        if sources is not None:
            self._specs = list(sources)
        self._specs_changed.set()
        self._stop.clear()
        self._ready.clear()
        self._thread = threading.Thread(target=self._run, args=(hwnd, monitor, int(fps), int(kbps)), daemon=True,
                                        name="native video")
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
        cap = enc = conv = srcs = None
        self._crop = None
        # Windows Graphics Capture only sees what the compositor draws, and it
        # stops drawing when the display sleeps: the viewers would get a
        # frozen picture. Hold the display on for as long as this thread
        # streams (the request belongs to the thread and ends with it).
        _keep_display_on(True)
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
            # NV12 and H.264 need even sizes. A window with an odd side streams
            # without its last row or column: one GPU copy per frame, and only then.
            ew, eh = w & ~1, h & ~1
            self._d3d, self._frame_size = d3d, (w, h)
            if (ew, eh) != (w, h):
                self._crop = d3d.texture(ew, eh)
            enc = mfenc.H264Encoder(d3d, ew, eh, fps, kbps, log=self.log)
            self._enc = enc
            if enc.input_format == "nv12":
                # Convert (and composite) on the GPU ourselves; see capture.Compositor.
                conv = capture.Compositor(d3d, ew, eh, fps)
                srcs = _Sources(d3d, self.log)
            self.stats.update(size=f"{w}x{h}", encoded=f"{ew}x{eh}", encoder=enc.name,
                              settings=dict(enc.codec_settings, input=enc.input_format))
            self.engine.push(K_META, 0, 0, _meta(ew, eh, fps, kbps))
            self._ready.set()
            self._loop(cap, enc, conv, srcs, fps)
        except OSError as exc:
            self.error = str(exc)
            self.log(f"native video: {exc}")
        finally:
            _keep_display_on(False)
            self._ready.set()
            self._enc = None
            if enc:
                enc.close()
            if srcs:
                srcs.close()
            if conv:
                conv.close()
            if cap:
                cap.close()
            if self._crop:
                capture.release(self._crop)
                self._crop = None

    def _loop(self, cap, enc, conv, srcs, fps):
        """Each tick: take the newest frame, key the sources in, and hold
        the result until the encoder asks for it. While a frame waits the
        thread checks every 2 ms (the asynchronous encoder asks when it is
        ready, not at the tick - offering only at the tick halves the frame
        rate, measured twice); with nothing waiting it sleeps to the next
        tick. Finished frames are collected on every pass."""
        period = 1.0 / fps
        t0 = time.perf_counter()
        next_tick = t0
        pending, tick, sent_avcc = None, 0, None
        rate_n, rate_t = 0, t0
        # Frames are stamped by their tick, offset to the engine's clock, so
        # they come out evenly spaced whatever the encoder's own delay does.
        base_ms = self.engine.clock_ms()
        last_frame = t0
        while not self._stop.is_set():
            now = time.perf_counter()
            if now >= next_tick:
                next_tick += period
                if now - next_tick > 1.0:          # fell far behind: start afresh
                    next_tick = now + period
                pending, tick, last_frame = self._tick(cap, enc, conv, srcs, now, pending, tick, last_frame)
            if pending is not None and enc.ready():
                if enc.submit(pending, int(tick * 1e7 / fps), int(1e7 / fps)):
                    pending = None
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
                if srcs and srcs.items:
                    self.stats["sources"] = srcs.status()
            wait = next_tick - time.perf_counter()
            if wait > 0:
                time.sleep(min(wait, 0.002 if pending is not None else 0.05))

    def _tick(self, cap, enc, conv, srcs, now, pending, tick, last_frame):
        """The work of one tick: sources that changed, the newest frame,
        the sources keyed in. Returns the frame now waiting for the encoder."""
        if srcs and self._specs_changed.is_set():
            self._specs_changed.clear()
            srcs.apply(self._specs)
            conv.set_sources(srcs.inputs())
            self.stats["sources"] = srcs.status()
        fresh = cap.poll()
        if fresh:
            last_frame = now
        self.stats["stalled"] = now - last_frame > 2.0
        if fresh or cap.texture is not None:
            if cap.texture_size != self._frame_size:
                raise OSError(f"the output window changed size to {cap.texture_size[0]}x{cap.texture_size[1]} "
                              f"while streaming it at {self._frame_size[0]}x{self._frame_size[1]} - stop and "
                              f"start again to stream at the new size")
            if pending is not None:
                self.stats["dropped"] += 1         # the encoder never asked during a whole tick
            if srcs:
                srcs.tick()
            # The frame the encoder gets: NV12 of our making (sources keyed
            # in), or the captured BGRA when the encoder converts itself.
            frame = cap.texture
            if self._crop:
                self._d3d.copy_region(self._crop, frame, enc.width, enc.height)
                frame = self._crop
            pending = conv.convert(frame) if conv else frame
            tick += 1
        return pending, tick, last_frame


def _keep_display_on(on):
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED, ES_DISPLAY_REQUIRED = 0x80000000, 0x1, 0x2
    try:
        ctypes.windll.kernel32.SetThreadExecutionState(
            ES_CONTINUOUS | (ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED if on else 0))
    except (AttributeError, OSError):
        pass


def _meta(w, h, fps, kbps):
    return json.dumps({"width": w, "height": h, "framerate": fps, "videodatarate": kbps,
                       "videocodecid": 7, "encoder": "Awesome Streaming Deck"}).encode("utf-8")
