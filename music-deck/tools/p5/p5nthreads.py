"""What native sources cost the server (P5): one LIVE session, the live
scene switched between no native source, a native window, a native camera
and both; per setup the server's total and its CPU by (named) thread, and
the native video's fps and drops. Back to back, so outside load (a game)
weighs on every setup alike.

    python p5nthreads.py [preset] [camera hint]
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
FF = r"C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin"
preset = sys.argv[1] if len(sys.argv) > 1 else "1080p30"
cam_hint = sys.argv[2] if len(sys.argv) > 2 else ""


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
    return subprocess.run(creationflags=0x08000000, args=["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=120).stdout


def server_cpu(seconds):
    out = ps("$p8 = (Get-NetTCPConnection -State Listen -LocalPort 8799).OwningProcess | Select-Object -First 1; "
             "$p = Get-Process -Id $p8; $c0 = $p.TotalProcessorTime.TotalSeconds; $sw = [Diagnostics.Stopwatch]::StartNew(); "
             f"Start-Sleep -Seconds {seconds}; $p = Get-Process -Id $p8; "
             "'{0:N1}' -f (100 * ($p.TotalProcessorTime.TotalSeconds - $c0) / $sw.Elapsed.TotalSeconds)")
    return out.strip()


def source_window(on):
    ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-srcwin*' } | "
       "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
    if on:
        subprocess.Popen([CHROME, "--app=http://127.0.0.1:8799/p0-anim.html?title=P0%20Anim%20Source&label=SRC&fps=30",
                          "--window-size=1292,726", "--window-position=2700,620", "--no-first-run", "--no-default-browser-check",
                          "--force-device-scale-factor=1", "--disable-component-update", "--disable-background-networking",
                          # a covered Chrome window stops drawing: keep the source alive under other windows
                          "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
                          "--disable-features=CalculateNativeWinOcclusion",
                          f"--user-data-dir={os.path.join(S, 'prof-srcwin')}"])
        time.sleep(4)


def make_scene(mode):
    sc = post("/api/scenes", {"template": "gaming_landscape", "name": f"P5 nthreads {mode}"})["scene"]
    keep = []
    for layer in sc["layers"]:
        p = layer["props"]
        if layer["type"] == "capture":
            if mode not in ("window", "both"):
                continue
            p.update(mode="native", fit="contain", source={"kind": "window", "title": "P0 Anim Source"})
            layer["transform"].update({"x": 0, "y": 0, "w": 1440, "h": 810})
        if layer["type"] == "camera":
            if mode not in ("camera", "both"):
                continue
            p.update(mode="native", device=cam_hint, width=640, height=480, fps=30, mirror=True, mask="circle")
        if layer["type"] == "text":
            p["decor"] = {"border": "sparkle", "sides": "all", "size": 0.9, "opacity": 0.9, "color": "#ffd1ff", "gap": 0.6, "animate": True}
        keep.append(layer)
    sc["layers"] = keep
    return post(f"/api/scenes/{sc['id']}", {"scene": sc})["scene"]["id"]


source_window(True)
modes = ["none", "window", "camera", "both"]
scenes = {m: make_scene(m) for m in modes}
post("/api/canvas/live", {"id": scenes["none"], "transition": "cut"})
post("/api/components/live/open")
time.sleep(8)
out = os.path.join(S, "live", "p5nthreads.flv")
sk = subprocess.Popen(creationflags=0x08000000, args=[os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "warning", "-y", "-listen", "1", "-timeout", "60",
                       "-i", "rtmp://127.0.0.1:1935/live/test", "-c", "copy", "-f", "flv", out], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
r = post("/api/live/start", {"url": "rtmp://127.0.0.1:1935/live", "key": "test", "preset": preset, "source": "live",
                             "audio": {"mic": True, "system": True}})
print("start:", json.dumps(r)[:140], flush=True)
time.sleep(8)
for mode in modes:
    post("/api/canvas/live", {"id": scenes[mode], "transition": "cut"})
    time.sleep(8)
    d0 = get("/api/live/status")["native"]["dropped"]
    a = get("/api/debug/threads")
    total = server_cpu(15)
    b = get("/api/debug/threads")
    st = get("/api/live/status")
    span = b["at"] - a["at"]
    before = {t["id"]: t for t in a["threads"]}
    rows = sorted(((100 * (t["cpu"] - before[t["id"]]["cpu"]) / span, t["name"]) for t in b["threads"] if t["id"] in before), reverse=True)
    srcs = " ".join(f"{x.get('kind')}:{x.get('frames')}{'!' + x['error'] if x.get('error') else ''}" for x in st["native"].get("sources") or []) or "-"
    print(f"\n== {mode}: server {total}% of one core; native {st['native']['fps']} fps, dropped +{st['native']['dropped'] - d0} in ~15 s; "
          f"{st['stats']['kbps']} kbps; sources {srcs}", flush=True)
    for pct, name in rows:
        if pct >= 0.3:
            print(f"   {pct:5.1f}%  {name}", flush=True)
post("/api/live/stop")
sk.wait(20)
post("/api/components/live/close")
post("/api/canvas/live", {"id": ""})
for sid in scenes.values():
    post(f"/api/scenes/{sid}/delete")
source_window(False)
