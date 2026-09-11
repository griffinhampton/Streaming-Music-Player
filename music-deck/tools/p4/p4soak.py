"""P4 soak on the rig: go LIVE natively (output window captured + native
audio) to a local ffmpeg sink, log health every minute, switch scenes
twice, kill and restart the sink once, probe the recordings.

    python p4soak.py <minutes> <preset> [switch_min1,switch_min2] [kill_min]
"""
import json, os, subprocess, sys, time, urllib.request

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))
FF = r"C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin"
minutes = float(sys.argv[1]) if len(sys.argv) > 1 else 30
preset = sys.argv[2] if len(sys.argv) > 2 else "720p30"
switches = [float(x) for x in sys.argv[3].split(",")] if len(sys.argv) > 3 else [10, 20]
kill_at = float(sys.argv[4]) if len(sys.argv) > 4 else 15
FLAGS = set(sys.argv[5:])
TRACE = "trace" in FLAGS          # tracemalloc on the server: slower, but says where memory goes
NOAUDIO = "noaudio" in FLAGS      # video only, to bisect memory growth
TAG = ("_trace" if TRACE else "") + ("_noaudio" if NOAUDIO else "")
LOG = open(os.path.join(S, "live", f"soak_{preset}{TAG}.log"), "w", buffering=1)


def say(*a):
    line = " ".join(str(x) for x in a)
    print(line, flush=True)
    LOG.write(line + "\n")


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())


def post(path, data=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(data or {}).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}")


def sink(n):
    out = os.path.join(S, "live", f"soak_{preset}_{n}.flv")
    if os.path.exists(out):
        os.remove(out)
    p = subprocess.Popen([os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "warning", "-y", "-listen", "1",
                          "-timeout", "120", "-i", "rtmp://127.0.0.1:1935/live/test", "-c", "copy", "-f", "flv", out],
                         stdout=subprocess.DEVNULL, stderr=open(os.path.join(S, "live", f"soak_sink_{n}.err"), "w"))
    time.sleep(1)
    return p, out


def server_pid():
    out = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-NetTCPConnection -State Listen -LocalPort 8799).OwningProcess"],
                         capture_output=True, text=True).stdout.split()
    return int(out[0]) if out else 0


def proc_cpu_mem(pid):
    """(cpu seconds, working set MB, threads, handles) of a process."""
    out = subprocess.run(["powershell", "-NoProfile", "-Command",
                          f"$p = Get-Process -Id {pid}; '{{0}} {{1}} {{2}} {{3}}' -f $p.TotalProcessorTime.TotalSeconds, "
                          f"[math]::Round($p.WorkingSet64/1MB), $p.Threads.Count, $p.HandleCount"],
                         capture_output=True, text=True).stdout.split()
    return (float(out[0]), int(out[1]), int(out[2]), int(out[3])) if len(out) == 4 else (0.0, 0, 0, 0)


def probe(path):
    if not os.path.exists(path):
        return "missing"
    out = subprocess.run([os.path.join(FF, "ffprobe.exe"), "-v", "error", "-show_entries",
                          "stream=codec_name,width,height,avg_frame_rate,sample_rate,channels:format=duration",
                          "-of", "default=nw=1", path], capture_output=True, text=True).stdout
    keys = subprocess.run([os.path.join(FF, "ffprobe.exe"), "-v", "error", "-select_streams", "v:0", "-show_entries",
                           "frame=key_frame,pts_time", "-of", "csv=p=0", path], capture_output=True, text=True).stdout.splitlines()
    kf = [float(l.split(",")[1]) for l in keys if l.startswith("1,")]
    gaps = [round(b - a, 2) for a, b in zip(kf, kf[1:])]
    a = subprocess.run([os.path.join(FF, "ffprobe.exe"), "-v", "error", "-select_streams", "a:0", "-show_entries",
                        "packet=pts_time", "-of", "csv=p=0", path], capture_output=True, text=True).stdout.splitlines()
    return (out.strip().replace("\n", " ") + f" | video frames {len(keys)} keyframes {len(kf)} gap min/max {min(gaps) if gaps else '-'}/"
            f"{max(gaps) if gaps else '-'} | audio packets {len(a)} first {a[0] if a else '-'} last {a[-1] if a else '-'}")


# --- scenes: two of the same format, so switching is allowed while live
scenes = get("/api/scenes")["scenes"]
mine = [s for s in scenes if s["name"].startswith("Soak ")]
if len(mine) < 2:
    a = post("/api/scenes", {"template": "just_chatting", "name": "Soak A"})["scene"]
    b = post("/api/scenes", {"template": "gaming_landscape", "name": "Soak B"})["scene"]
    mine = [a, b]
ids = [s["id"] for s in mine[:2]]
say("scenes:", ids)
post("/api/canvas/live", {"id": ids[0], "transition": "fade", "duration": 300})
post("/api/voice/override", {"speaking": None})

n = 1
sk, out1 = sink(n)
res = post("/api/live/start", {"url": "rtmp://127.0.0.1:1935/live", "key": "test", "preset": preset, "source": "live",
                               "audio": {"mic": not NOAUDIO, "system": not NOAUDIO}})
say("start:", json.dumps(res))
time.sleep(8)
if TRACE:
    say("tracing:", json.dumps({k: get("/api/debug/mem?start=1").get(k) for k in ("tracing", "working_set_mb")}))
    time.sleep(30)
    get("/api/debug/mem")          # a baseline snapshot after warm-up; the end compares against it
st = get("/api/live/status")
say("status:", json.dumps({k: st[k] for k in ("state", "error", "preset")}), "native:", json.dumps(st["native"]),
    "audio:", json.dumps({k: st["audio"].get(k) for k in ("running", "error", "devices", "frames")}))
pid = server_pid()
c0, m0, th0, h0 = proc_cpu_mem(pid)
t0 = time.time()
say(f"server pid {pid}; {m0} MB, {th0} threads, {h0} handles at start")
say("{:>5} {:>7} {:>4} {:>6} {:>6} {:>6} {:>5} {:>5} {:>6} {:>8} {:>6} {:>7} {:>10}".format(
    "min", "mem MB", "thr", "handl", "cpu%", "kbps", "vfps", "afps", "queue", "delay ms", "drop", "recon", "state"))
done_switch, killed, files = set(), False, [out1]
last_c, last_t = c0, t0
while time.time() - t0 < minutes * 60:
    time.sleep(60)
    mins = (time.time() - t0) / 60
    c1, m1, th1, h1 = proc_cpu_mem(pid)
    st = get("/api/live/status")
    s = st["stats"]
    say("{:>5.1f} {:>7} {:>4} {:>6} {:>6.1f} {:>6} {:>5} {:>5} {:>6} {:>8} {:>6} {:>7} {:>10}".format(
        mins, m1, th1, h1, 100 * (c1 - last_c) / (time.time() - last_t), s["kbps"], s["vfps"], s["afps"], s["queue"],
        s["delay_ms"], s["dropped"], s["reconnects"], st["state"]) +
        f"  rtt {s.get('rtt_ms')} ms inflight {s.get('inflight_kb')} KB retrans {s.get('retrans_kb')} KB"
        f"  native {st['native']['fps']} fps drop {st['native']['dropped']}  audio frames {st['audio'].get('frames')} drop {st['audio'].get('dropped')} err {st['native']['error'] or st['audio'].get('error') or st['error'] or '-'}")
    last_c, last_t = c1, time.time()
    for sw in switches:
        if mins >= sw and sw not in done_switch:
            done_switch.add(sw)
            target = ids[len(done_switch) % 2]
            r = post("/api/live/scene", {"id": target, "transition": "fade", "duration": 300})
            say(f"  switch -> {target}: {json.dumps({k: r.get(k) for k in ('ok', 'reason', 'live')})}")
    if mins >= kill_at and not killed:
        killed = True
        say("  killing the sink (forced disconnect)")
        sk.kill()
        sk.wait()
        time.sleep(4)
        n += 1
        sk, out2 = sink(n)
        files.append(out2)
        say("  sink restarted; waiting for the reconnect")
mem = get("/api/debug/mem")
say("mem before stop:", json.dumps({k: mem.get(k) for k in ("working_set_mb", "private_mb", "traced_mb", "gc_objects")}))
for line in mem.get("top", []):
    say("   ", line)
say("stop:", json.dumps(post("/api/live/stop")))
sk.wait(30)
for f in files:
    say("probe", os.path.basename(f), ":", probe(f))
time.sleep(3)
mem = get("/api/debug/mem")
say("mem after stop:", json.dumps({k: mem.get(k) for k in ("working_set_mb", "private_mb", "traced_mb", "gc_objects")}))
