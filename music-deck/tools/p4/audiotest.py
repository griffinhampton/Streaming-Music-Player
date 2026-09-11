"""Native audio spike: WASAPI mic (+ loopback) -> AAC via Media Foundation.
Writes an ADTS .aac file ffprobe can read and reports levels and rate.

    python audiotest.py <seconds> <out.aac> [system 0|1]
"""
import os, sys, time
sys.path.insert(0, r"C:\Users\ghamp\streaming stuff\music-deck")
import audio

seconds, out = float(sys.argv[1]), sys.argv[2]
system = len(sys.argv) > 3 and sys.argv[3] == "1"
print("devices:", audio.list_devices())


class FakeEngine:
    def __init__(self):
        self.t0 = time.monotonic()
        self.frames = []
        self.asc = None
        self.meta = None

    def clock_ms(self):
        return int((time.monotonic() - self.t0) * 1000)

    def push(self, kind, ts, flags, payload):
        if kind == 2:
            self.asc = payload
        elif kind == 4:
            self.meta = payload
        elif kind == 3:
            self.frames.append((ts, payload))


eng = FakeEngine()
mixer = audio.AudioMixer(eng, mic=True, system=system, kbps=128, log=print)
mixer.start()
t0 = time.time()
while time.time() - t0 < seconds:
    time.sleep(1)
    print(f"  {time.time() - t0:4.1f}s frames {len(eng.frames)} level {mixer.level} dropped {mixer.dropped} err {mixer.error!r}")
mixer.stop()
print("asc:", eng.asc.hex() if eng.asc else None, "expected 1190 for 48k stereo LC")
if eng.frames:
    first, last = eng.frames[0][0], eng.frames[-1][0]
    print(f"frames {len(eng.frames)}, first ts {first} ms, last ts {last} ms, span {(last - first) / 1000:.2f}s vs "
          f"{len(eng.frames) * 1024 / 48000:.2f}s of audio; bytes {sum(len(p) for _, p in eng.frames)}")
    # ADTS so ffprobe can read the raw frames: 7-byte header per frame
    with open(out, "wb") as f:
        for _, frame in eng.frames:
            n = len(frame) + 7
            hdr = bytes([0xFF, 0xF1, (1 << 6) | (3 << 2) | 0, (2 << 6) | ((n >> 11) & 3), (n >> 3) & 0xFF,
                         ((n & 7) << 5) | 0x1F, 0xFC])
            f.write(hdr + frame)
    print("wrote", out)
