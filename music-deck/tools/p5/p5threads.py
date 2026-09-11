"""Where the server's CPU goes while LIVE (P5): two reads of
/api/debug/threads fifteen seconds apart, per-thread percent of one core,
on the animated just-chatting scene at the window's size with mic + system
audio. Prints the table and the server total.

    python p5threads.py [preset]
"""
import json, os, subprocess, sys, time, urllib.request

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))
FF = r"C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin"
preset = sys.argv[1] if len(sys.argv) > 1 else "1080p30"


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


def ps(script):
    return subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=120).stdout


def server_cpu(seconds):
    out = ps("$pid8799 = (Get-NetTCPConnection -State Listen -LocalPort 8799).OwningProcess | Select-Object -First 1; "
             "$p = Get-Process -Id $pid8799; $c0 = $p.TotalProcessorTime.TotalSeconds; $sw = [Diagnostics.Stopwatch]::StartNew(); "
             f"Start-Sleep -Seconds {seconds}; $p = Get-Process -Id $pid8799; "
             "'{0:N1}' -f (100 * ($p.TotalProcessorTime.TotalSeconds - $c0) / $sw.Elapsed.TotalSeconds)")
    return out.strip()


r = post("/api/scenes", {"template": "just_chatting", "name": "P5 threads"})
s = r["scene"]
for layer in s["layers"]:
    if layer["type"] == "text":
        layer["props"]["decor"] = {"border": "sparkle", "sides": "all", "size": 0.9, "opacity": 0.9, "color": "#ffd1ff", "gap": 0.6, "animate": True}
        break
r = post(f"/api/scenes/{s['id']}", {"scene": s})
sid = r["scene"]["id"]
post("/api/canvas/live", {"id": sid, "transition": "cut"})
post("/api/components/live/open")
time.sleep(8)
out = os.path.join(S, "live", "p5threads.flv")
sk = subprocess.Popen([os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "warning", "-y", "-listen", "1", "-timeout", "60",
                       "-i", "rtmp://127.0.0.1:1935/live/test", "-c", "copy", "-f", "flv", out], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
r = post("/api/live/start", {"url": "rtmp://127.0.0.1:1935/live", "key": "test", "preset": preset, "source": "live",
                             "audio": {"mic": True, "system": True}})
print("start:", json.dumps(r))
time.sleep(10)
a = get("/api/debug/threads")
total = server_cpu(15)
b = get("/api/debug/threads")
span = b["at"] - a["at"]
before = {t["id"]: t for t in a["threads"]}
rows = []
for t in b["threads"]:
    if t["id"] in before:
        rows.append((100 * (t["cpu"] - before[t["id"]]["cpu"]) / span, t["name"]))
rows.sort(reverse=True)
st = get("/api/live/status")
print(f"preset {preset}: {st['native']['size']} {st['native']['fps']} fps, {st['stats']['kbps']} kbps, audio {st['audio'].get('frames')} frames")
print(f"server total {total}% of one core; by thread:")
for pct, name in rows:
    if pct >= 0.05:
        print(f"   {pct:5.1f}%  {name}")
post("/api/live/stop")
sk.wait(20)
post("/api/components/live/close")
post("/api/canvas/live", {"id": ""})
post(f"/api/scenes/{sid}/delete")
