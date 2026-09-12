"""Does the NV12 ring hold at 60 fps? Capture + convert + encode a window
whose whole picture changes every frame, decode the recording, and look for
frames whose rows come from two different moments (a horizontal band that
did not change while the rest did).

    python tearcheck.py <window title part> <seconds> <fps> [kbps]
"""
import ctypes
import os
import subprocess
import sys
import time

import numpy as np

S = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(S, "testrig"))
import nativelive  # noqa: E402
import capture  # noqa: E402

FF = r"C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin"
title, seconds, fps = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
kbps = int(sys.argv[4]) if len(sys.argv) > 4 else 7600
ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
out = os.path.join(S, "live", f"tear_{fps}.h264")


class FileEngine:
    """Writes Annex B; the FLV framing is not the point here."""
    def __init__(self, path):
        self.f = open(path, "wb")
        self.t0 = time.monotonic()
        self.n = 0
        self.sps = self.pps = None

    def clock_ms(self):
        return int((time.monotonic() - self.t0) * 1000)

    def push(self, kind, ts, flags, payload):
        if kind == nativelive.K_VCONFIG:
            # avcC: 5 bytes header, then SPS count/len/data, PPS count/len/data
            n_sps = payload[5] & 0x1F
            p = 6
            for _ in range(n_sps):
                ln = int.from_bytes(payload[p:p + 2], "big"); self.sps = payload[p + 2:p + 2 + ln]; p += 2 + ln
            n_pps = payload[p]; p += 1
            for _ in range(n_pps):
                ln = int.from_bytes(payload[p:p + 2], "big"); self.pps = payload[p + 2:p + 2 + ln]; p += 2 + ln
            self.f.write(b"\x00\x00\x00\x01" + self.sps + b"\x00\x00\x00\x01" + self.pps)
        elif kind == nativelive.K_VIDEO:
            pos = 0
            while pos + 4 <= len(payload):
                ln = int.from_bytes(payload[pos:pos + 4], "big")
                self.f.write(b"\x00\x00\x00\x01" + payload[pos + 4:pos + 4 + ln])
                pos += 4 + ln
            self.n += 1


hwnd = capture.find_window(title)
if not hwnd:
    sys.exit(f"no window titled like {title!r}")
eng = FileEngine(out)
nv = nativelive.NativeVideo(eng, log=print)
nv.start(hwnd=hwnd, fps=fps, kbps=kbps)
nv.wait_ready()
print("status:", nv.status())
time.sleep(seconds)
nv.stop()
eng.f.close()
st = nv.status()
print(f"encoded {st['frames']} frames at {st['fps']} fps, dropped {st['dropped']}, {os.path.getsize(out) / 1024:.0f} KB")

# Decode to small gray frames and look at row-wise change between neighbors.
W, H = 320, 180
raw = subprocess.run(creationflags=0x08000000, args=[os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "error", "-r", str(fps), "-i", out,
                      "-vf", f"scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1, H, W).astype(np.int16)
print(f"decoded {len(frames)} frames")
torn, still, moving = 0, 0, 0
examples = []
for i in range(1, len(frames)):
    rows = np.abs(frames[i] - frames[i - 1]).mean(axis=1)          # change per row
    if rows.mean() < 1.5:
        still += 1                                                  # a repeated frame: not a tear
        continue
    moving += 1
    quiet = rows < 0.5
    # A tear: one contiguous band of quiet rows at the top or the bottom
    # covering at least a tenth of the picture while the rest moved.
    top = 0
    while top < H and quiet[top]:
        top += 1
    bottom = 0
    while bottom < H and quiet[H - 1 - bottom]:
        bottom += 1
    band = max(top, bottom)
    if band >= H // 10 and band < H - H // 10:
        torn += 1
        if len(examples) < 5:
            examples.append((i, top, bottom))
print(f"frames that moved: {moving}, repeated: {still}, torn: {torn} {examples}")
