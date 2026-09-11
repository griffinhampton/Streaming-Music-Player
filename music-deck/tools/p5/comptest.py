"""Compositor check without a screen: a synthetic BGRA scene (gradient, a
black circular hole with a ring drawn over it, a red square, a near-black
box), a synthetic BGRA source keyed into the hole (mirrored), two seconds
of encoding, one decoded frame to look at."""
import ctypes, math, os, struct, subprocess, sys, time
sys.path.insert(0, r"C:\Users\ghamp\streaming stuff\music-deck")
import capture, mfenc
from ctypes import c_void_p, c_uint, c_int32, POINTER, byref

S = os.path.dirname(os.path.abspath(__file__))
FF = r"C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin"
W, H = 1280, 720
d3d = capture.D3D()

# --- the scene: purple gradient; a layer box (200,100,480x480) painted black inside a circle
#     (the hole), with a white ring drawn over the circle's edge; a red square; a near-black box
cx, cy, rad = 200 + 240, 100 + 240, 230
rows = bytearray()
for y in range(H):
    row = bytearray()
    for x in range(W):
        d = math.hypot(x - cx, y - cy)
        if d < rad - 6:
            b, g, r = 0, 0, 0                                      # the hole
        elif d < rad:
            b, g, r = 255, 255, 255                                # a ring over the hole's edge
        elif 900 <= x < 1100 and 150 <= y < 350:
            b, g, r = 40, 40, 230                                  # a red square: must stay
        elif 900 <= x < 1100 and 400 <= y < 600:
            b, g, r = 14, 14, 14                                   # near-black: must NOT be a hole
        else:
            b, g, r = 120 + (x * 60) // W, 30, 60 + (y * 120) // H  # purple-ish gradient
        row += bytes((b, g, r, 255))
    rows += row
scene = d3d.texture(W, H)
capture.vcall(d3d.context, 48, None, [c_void_p, c_uint, c_void_p, c_void_p, c_uint, c_uint],
              scene, 0, None, bytes(rows), W * 4, 0)              # UpdateSubresource

# --- the source: BGRA 640x480, green on the left, yellow on the right, a blue bar at the top
sw, sh = 640, 480
srcpix = bytearray()
for y in range(sh):
    for x in range(sw):
        if y < 40:
            b, g, r = 240, 60, 20
        elif x < sw // 2:
            b, g, r = 40, 200, 40
        else:
            b, g, r = 20, 220, 230
        srcpix += bytes((b, g, r, 255))
src = d3d.texture(sw, sh)
capture.vcall(d3d.context, 48, None, [c_void_p, c_uint, c_void_p, c_void_p, c_uint, c_uint],
              src, 0, None, bytes(srcpix), sw * 4, 0)

comp = capture.Compositor(d3d, W, H, 30)
comp.set_sources([{"texture": lambda: src, "size": lambda: (sw, sh), "rect": (200, 100, 480, 480),
                   "fit": "cover", "mirror": True}])
enc = mfenc.H264Encoder(d3d, W, H, 30, 3400, log=print)
out = os.path.join(S, "live", "comptest.h264")
n = 0
t0 = time.perf_counter()
with open(out, "wb") as f:
    tick = 0
    while tick < 60:
        if enc.ready():
            tex = comp.convert(scene)
            if enc.submit(tex, int(tick * 1e7 / 30), int(1e7 / 30)):
                tick += 1
        for key, ms, payload in enc.collect():
            pos = 0
            while pos + 4 <= len(payload):
                ln = struct.unpack(">I", payload[pos:pos + 4])[0]
                nal = payload[pos + 4:pos + 4 + ln]
                if key and nal and (nal[0] & 0x1F) == 5 and enc.sps and enc.pps and n == 0:
                    f.write(b"\x00\x00\x00\x01" + enc.sps + b"\x00\x00\x00\x01" + enc.pps)
                f.write(b"\x00\x00\x00\x01" + nal)
                pos += 4 + ln
            n += 1
        time.sleep(0.005)
print(f"encoded {n} frames in {time.perf_counter() - t0:.1f}s, composited {comp.composited}")
enc.close(); comp.close()
subprocess.run([os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "error", "-y", "-r", "30", "-i", out,
                "-ss", "1", "-frames:v", "1", "-update", "1", os.path.join(S, "live", "comptest.png")])
print("png:", os.path.exists(os.path.join(S, "live", "comptest.png")))
