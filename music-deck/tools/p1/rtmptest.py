"""Drive live.RtmpClient straight at an ffmpeg RTMP listener with fake media,
no browser involved. Prints every command the server sends and ffmpeg's log."""
import os, struct, subprocess, sys, time
sys.path.insert(0, r"C:\Users\ghamp\streaming stuff\music-deck")
import live

FF = r"C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin\ffmpeg.exe"
OUT = os.path.join(os.path.dirname(__file__), "live", "rtmptest.flv")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
sink = subprocess.Popen([FF, "-hide_banner", "-loglevel", "verbose", "-y", "-listen", "1", "-timeout", "30",
                         "-i", "rtmp://127.0.0.1:1935/live/test", "-c", "copy", "-f", "flv", OUT],
                        stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True)
time.sleep(1.0)

# A tiny but valid-looking H.264 stream: avcC with a made-up SPS/PPS, then
# "frames" of one NAL each (the sink copies, it never decodes).
sps = bytes.fromhex("6764001facd94050045a1000000300100000030320f162d960")
pps = bytes.fromhex("68ebe3cb22c0")
avcc = (b"\x01" + sps[1:4] + b"\xff\xe1" + struct.pack(">H", len(sps)) + sps + b"\x01" + struct.pack(">H", len(pps)) + pps)
asc = live.audio_specific_config(48000, 2)

c = live.RtmpClient("rtmp://127.0.0.1:1935/live", "test", log=lambda m: print("  ", m))
t0 = time.time()
try:
    c.connect_publish()
    print(f"connected + published in {time.time() - t0:.2f}s, stream id {c.stream_id}")
    c.send_metadata({"width": 1280, "height": 720, "framerate": 30, "videocodecid": 7,
                     "audiocodecid": 10, "audiosamplerate": 48000, "stereo": True})
    c.send_video(0, live.video_tag(True, 0, avcc))
    c.send_audio(0, live.audio_tag(0, asc))
    for i in range(90):
        ts = int(i * 1000 / 30)
        key = i % 60 == 0
        nal = (b"\x65" if key else b"\x41") + os.urandom(3000 if key else 800)
        c.send_video(ts, live.video_tag(key, 1, struct.pack(">I", len(nal)) + nal))
        if i % 2 == 0:
            c.send_audio(ts, live.audio_tag(1, b"\x21\x00\x49\x90\x02\x19\x00\x23\x80" + os.urandom(120)))
        time.sleep(1 / 30)
    print("sent 3 s of fake media; bytes out", c.bytes_out, "alive", c.alive, "error", c.error)
finally:
    c.close(polite=True)
try:
    err = sink.communicate(timeout=15)[1]
except subprocess.TimeoutExpired:
    sink.kill(); err = sink.communicate()[1]
print("ffmpeg exit", sink.returncode)
print("\n".join("  ff| " + l for l in err.strip().splitlines()[-25:]))
print("file:", os.path.getsize(OUT) if os.path.exists(OUT) else "missing")
