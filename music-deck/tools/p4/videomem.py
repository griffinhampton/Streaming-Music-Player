"""Standalone memory check of the native video path against a window:
`capture` polls frames only, `encode` runs NativeVideo (capture + encoder)
into a fake engine. This process's working set logged every 30 s.

    python videomem.py <capture|encode> <window title part> <minutes>
"""
import ctypes
import os
import sys
import time

S = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(S, "testrig"))
import capture  # noqa: E402
import nativelive  # noqa: E402

mode, title = sys.argv[1], sys.argv[2]
minutes = float(sys.argv[3]) if len(sys.argv) > 3 else 3
ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
LOG = open(os.path.join(S, "live", f"videomem_{mode}.log"), "w", buffering=1)


def say(*a):
    line = " ".join(str(x) for x in a)
    print(line, flush=True)
    LOG.write(line + "\n")


class _PMC(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_uint32), ("PageFaultCount", ctypes.c_uint32)] + \
        [(n, ctypes.c_size_t) for n in ("PeakWorkingSet", "WorkingSet", "QPeakPaged", "QPaged",
                                        "QPeakNonPaged", "QNonPaged", "Pagefile", "PeakPagefile")]


def working_set_mb():
    pmc = _PMC(); pmc.cb = ctypes.sizeof(_PMC)
    f = ctypes.windll.psapi.GetProcessMemoryInfo
    f.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32]
    f(ctypes.c_void_p(-1), ctypes.byref(pmc), pmc.cb)
    return round(pmc.WorkingSet / 1048576, 1), round(pmc.Pagefile / 1048576, 1)


class FakeEngine:
    def __init__(self):
        self.t0 = time.monotonic()
        self.n = 0
        self.bytes = 0

    def clock_ms(self):
        return int((time.monotonic() - self.t0) * 1000)

    def push(self, kind, ts, flags, payload):
        self.n += 1
        self.bytes += len(payload)


hwnd = capture.find_window(title)
if not hwnd:
    sys.exit(f"no window titled like {title!r}")
say(f"window {hwnd} mode {mode}")

if mode == "reuse":
    # Experiment: one input sample + surface buffer for the whole run instead
    # of a fresh pair per frame.
    import mfenc
    from ctypes import c_void_p, c_uint, c_int32, byref
    from capture import vcall, release, check

    def submit_reuse(self, texture, time_100ns, duration_100ns):
        if self.events:
            self._pump_events()
            if self.need_input <= 0:
                return False
        held = getattr(self, "_held", None)
        if held is None or held[1] != texture.value:
            buf, sample = c_void_p(), c_void_p()
            check(mfenc.mfplat.MFCreateDXGISurfaceBuffer(byref(mfenc.IID_ID3D11Texture2D_), texture, 0, False, byref(buf)),
                  "surface buffer")
            check(mfenc.mfplat.MFCreateSample(byref(sample)), "MFCreateSample")
            check(vcall(sample, 42, c_int32, [c_void_p], buf), "AddBuffer")
            release(buf)
            if held:
                release(held[0])
            self._held = held = (sample, texture.value)
        sample = held[0]
        vcall(sample, 36, c_int32, [ctypes.c_longlong], time_100ns)
        vcall(sample, 38, c_int32, [ctypes.c_longlong], duration_100ns)
        hr = vcall(self.mft, 24, c_int32, [c_uint, c_void_p, c_uint], 0, sample, 0)
        if hr == mfenc.MF_E_NOTACCEPTING:
            return False
        check(hr, "ProcessInput")
        self.need_input -= 1
        self.frames_in += 1
        return True

    mfenc.H264Encoder.submit = submit_reuse
    mode = "encode"

if mode == "noread":
    # Experiment: drain output samples but never touch their bytes.
    import mfenc
    from ctypes import c_void_p, c_uint, c_int32, byref
    from capture import vcall, release, check

    def read_noread(self):
        data = mfenc.MFT_OUTPUT_DATA_BUFFER()
        status = c_uint()
        hr = vcall(self.mft, 25, c_int32, [c_uint, c_uint, ctypes.POINTER(mfenc.MFT_OUTPUT_DATA_BUFFER), ctypes.POINTER(c_uint)],
                   0, 1, byref(data), byref(status))
        if data.pEvents:
            release(c_void_p(data.pEvents))
        if hr == mfenc.MF_E_TRANSFORM_NEED_MORE_INPUT or (hr == 0 and not data.pSample):
            return None
        check(hr, "ProcessOutput")
        release(c_void_p(data.pSample))
        self.frames_out += 1
        return (False, 0, b"x")

    mfenc.H264Encoder._read_output = read_noread
    mode = "encode"

if mode in ("static", "nv12static"):
    # Experiment: the encoder alone, fed one texture that never changes;
    # nv12static hands it NV12 so the encoder's own RGB conversion is skipped.
    import mfenc
    d3d = capture.D3D()
    w, h = 1920, 1080
    if mode == "nv12static":
        mfenc.RGB_FORMATS = ("3231564e",)          # MFVideoFormat_NV12
        desc = capture.TEX2D_DESC(w, h, 1, 1, 103, 1, 0, 0, 0x8, 0, 0)   # DXGI_FORMAT_NV12, shader resource
        tex = capture.c_void_p()
        capture.check(capture.vcall(d3d.device, 5, capture.c_int32, [capture.POINTER(capture.TEX2D_DESC), capture.c_void_p,
                                    capture.POINTER(capture.c_void_p)], capture.byref(desc), None, capture.byref(tex)), "CreateTexture2D NV12")
    else:
        tex = d3d.texture(w, h)
    enc = mfenc.H264Encoder(d3d, w, h, 30, 3400, log=say)
    say("encoder", enc.name, "provides samples", enc.provides_samples)
    say("{:>5} {:>7} {:>8} {:>7} {:>7}".format("min", "ws MB", "priv MB", "in", "out"))
    t0 = time.time()
    period, next_tick, tick, pending = 1 / 30, time.perf_counter(), 0, False
    next_report = t0 + 30
    while time.time() - t0 < minutes * 60:
        now = time.perf_counter()
        if now >= next_tick:
            next_tick += period
            pending = True
            tick += 1
        if pending and enc.ready():
            if enc.submit(tex, int(tick * 1e7 / 30), int(1e7 / 30)):
                pending = False
        else:
            time.sleep(0.002)
        enc.collect()
        if time.time() >= next_report:
            next_report += 30
            ws, pv = working_set_mb()
            say("{:>5.1f} {:>7} {:>8} {:>7} {:>7}".format((time.time() - t0) / 60, ws, pv, enc.frames_in, enc.frames_out))
    enc.close()
    time.sleep(2)
    say("after stop:", working_set_mb())
    sys.exit(0)
eng = FakeEngine()
t0 = time.time()
if mode == "capture":
    d3d = capture.D3D()
    cap = capture.WindowCapture(d3d, hwnd=hwnd)
    cap.start()
    say("{:>5} {:>7} {:>8} {:>7}".format("min", "ws MB", "priv MB", "frames"))
    next_report = t0 + 30
    while time.time() - t0 < minutes * 60:
        cap.poll()
        time.sleep(1 / 30)
        if time.time() >= next_report:
            next_report += 30
            ws, pv = working_set_mb()
            say("{:>5.1f} {:>7} {:>8} {:>7}".format((time.time() - t0) / 60, ws, pv, cap.frames))
    cap.close()
else:
    nv = nativelive.NativeVideo(eng, log=say)
    nv.start(hwnd=hwnd, fps=30, kbps=3400)
    nv.wait_ready()
    say("status:", nv.status())
    say("{:>5} {:>7} {:>8} {:>7} {:>6} {:>7}".format("min", "ws MB", "priv MB", "frames", "fps", "pushed"))
    while time.time() - t0 < minutes * 60:
        time.sleep(30)
        ws, pv = working_set_mb()
        st = nv.status()
        say("{:>5.1f} {:>7} {:>8} {:>7} {:>6} {:>7}".format((time.time() - t0) / 60, ws, pv, st["frames"], st["fps"], eng.n))
    nv.stop()
    say("stopped:", nv.status(), "pushed", eng.n, "bytes", eng.bytes)
time.sleep(2)
say("after stop:", working_set_mb())
