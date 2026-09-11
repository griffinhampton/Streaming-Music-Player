"""NV12 path check: capture a window, convert on the GPU, encode for a few
seconds, write Annex B for ffmpeg to decode - colors are checked by eye.

    python nv12test.py <window title part> <seconds> <out.h264>
"""
import ctypes
import os
import struct
import sys
import time

S = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, r"C:\Users\ghamp\streaming stuff\music-deck")
import capture  # noqa: E402
import mfenc  # noqa: E402

title, seconds, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
hwnd = capture.find_window(title)
if not hwnd:
    sys.exit(f"no window titled like {title!r}")
d3d = capture.D3D()
cap = capture.WindowCapture(d3d, hwnd=hwnd)
cap.start()
for _ in range(300):
    if cap.poll():
        break
    time.sleep(0.01)
w, h = cap.texture_size
print("frame", w, h)
enc = mfenc.H264Encoder(d3d, w, h, 30, 3400, log=print)
print("encoder", enc.name, "input", enc.input_format, "settings", enc.codec_settings)
conv = capture.Nv12Converter(d3d, w, h, 30) if enc.input_format == "nv12" else None
t0 = time.perf_counter()
frames = total = keys = 0
tick, pending, next_tick = 0, None, t0
with open(out, "wb") as f:
    while time.perf_counter() - t0 < seconds:
        now = time.perf_counter()
        if now >= next_tick:
            next_tick += 1 / 30
            cap.poll()
            if cap.texture is not None:
                pending = conv.convert(cap.texture) if conv else cap.texture
                tick += 1
        if pending is not None and enc.ready():
            if enc.submit(pending, int(tick * 1e7 / 30), int(1e7 / 30)):
                frames += 1
                pending = None
        else:
            time.sleep(0.002)
        for key, ms, payload in enc.collect():
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
el = time.perf_counter() - t0
print(f"{el:.1f}s: submitted {frames}, encoded {enc.frames_out}, keyframes {keys}, {total * 8 / el / 1000:.0f} kbps")
enc.close()
if conv:
    conv.close()
cap.close()
