"""Native path spike: WGC window capture -> Media Foundation hardware H.264,
all on the GPU, from this Python process. Writes raw Annex B and reports CPU.

    python nativetest.py <window title part> <w> <h> <fps> <kbps> <seconds> <out.h264>
"""
import ctypes, os, struct, sys, time
from ctypes import wintypes, byref
sys.path.insert(0, r"C:\Users\ghamp\streaming stuff\music-deck")
import capture, mfenc

title, w, h, fps, kbps, seconds, out = sys.argv[1], *map(int, sys.argv[2:6]), float(sys.argv[6]), sys.argv[7]
ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))


def cpu_seconds():
    k, u, c, e = (wintypes.FILETIME() for _ in range(4))
    ctypes.windll.kernel32.GetProcessTimes(ctypes.windll.kernel32.GetCurrentProcess(), byref(c), byref(e), byref(k), byref(u))
    f = lambda ft: (ft.dwHighDateTime << 32 | ft.dwLowDateTime) / 1e7
    return f(k) + f(u)


hwnd = capture.find_window(title)
if not hwnd:
    sys.exit(f"no window titled like {title!r}")
d3d = capture.D3D()
cap = capture.WindowCapture(d3d, hwnd=hwnd)
print(f"window {hwnd}: capture item {cap.size}")
cap.start()
# The encoder is sized from what the capture really delivers (WGC trims a
# window's invisible borders), so the first frame decides.
for _ in range(200):
    if cap.poll():
        break
    time.sleep(0.01)
if cap.texture is None:
    sys.exit("no frame arrived from the window")
w, h = cap.texture_size
print(f"first frame {w}x{h}")
enc = mfenc.H264Encoder(d3d, w, h, fps, kbps, log=print)
print(f"encoder provides samples: {enc.provides_samples}")

period = 1.0 / fps
t0 = time.perf_counter()
c0 = cpu_seconds()
frames, keys, total, skipped_no_frame, skipped_busy = 0, 0, 0, 0, 0
with open(out, "wb") as f:
    next_tick = t0
    pending = False          # a frame is due and waits for the encoder to ask
    tick = 0
    while time.perf_counter() - t0 < seconds:
        now = time.perf_counter()
        if now >= next_tick:
            next_tick += period
            if pending:
                skipped_busy += 1        # the encoder never asked during a whole period
            cap.poll()
            if cap.texture is None:
                skipped_no_frame += 1
                pending = False
            elif cap.texture_size != (w, h):
                sys.exit(f"the window changed size to {cap.texture_size} mid-test")
            else:
                pending = True
                tick += 1
        if pending and enc.ready():
            if enc.submit(cap.texture, int(tick * 1e7 / fps), int(1e7 / fps)):
                frames += 1
                pending = False
        else:
            time.sleep(0.002)
        for key, ms, payload in enc.collect():
            # back to Annex B for the file: 4-byte lengths -> start codes
            pos = 0
            while pos + 4 <= len(payload):
                n = struct.unpack(">I", payload[pos:pos + 4])[0]
                nal = payload[pos + 4:pos + 4 + n]
                if key and nal and (nal[0] & 0x1F) == 5 and enc.sps and enc.pps and total == 0:
                    f.write(b"\x00\x00\x00\x01" + enc.sps + b"\x00\x00\x00\x01" + enc.pps)
                f.write(b"\x00\x00\x00\x01" + nal)
                pos += 4 + n
            total += len(payload)
            keys += key
    time.sleep(0.2)
    for key, ms, payload in enc.collect():
        total += len(payload); keys += key
el = time.perf_counter() - t0
cpu = cpu_seconds() - c0
print(f"encoder: {enc.name}")
print(f"{el:.1f}s: captured frames {cap.frames}, submitted {frames}, encoded {enc.frames_out}, keyframes {keys}, "
      f"skipped (no frame yet) {skipped_no_frame}, (encoder busy) {skipped_busy}")
print(f"output {total / 1000:.0f} KB = {total * 8 / el / 1000:.0f} kbps; avcC {'yes' if enc.avcc else 'no'} "
      f"(sps {len(enc.sps or b'')} B, pps {len(enc.pps or b'')} B)")
print(f"process CPU {100 * cpu / el:.1f}% of one core (capture + encode + file)")
enc.close()
cap.close()
