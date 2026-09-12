"""The native compositor on the rig (P5): a scene with a native window
source (the P0 anim page) and a native camera, LIVE for a short while,
Chrome's cost with nothing but holes to draw, the server's cost with the
sources keyed in, and a decoded frame to look at.

    python p5native.py [seconds] [camera hint]
"""
import json, os, subprocess, sys, time, urllib.request

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
FF = r"C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin"
seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 25
cam_hint = sys.argv[2] if len(sys.argv) > 2 else ""
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)


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


def ps(script, timeout=120):
    return subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=timeout).stdout


def cpu(match, secs=12):
    out = ps(f'& "{S}\\cpuby.ps1" -Match \'{match}\' -Seconds {secs}')
    total = [l for l in out.splitlines() if "TOTAL" in l]
    return float(total[0].split()[1]) if total else -1


def server_cpu(secs=12):
    out = ps("$p8 = (Get-NetTCPConnection -State Listen -LocalPort 8799).OwningProcess | Select-Object -First 1; "
             "$p = Get-Process -Id $p8; $c0 = $p.TotalProcessorTime.TotalSeconds; $sw = [Diagnostics.Stopwatch]::StartNew(); "
             f"Start-Sleep -Seconds {secs}; $p = Get-Process -Id $p8; "
             "'{0:N1}' -f (100 * ($p.TotalProcessorTime.TotalSeconds - $c0) / $sw.Elapsed.TotalSeconds)")
    try:
        return float(out.strip())
    except ValueError:
        return -1


def source_window(on):
    prof = os.path.join(S, "prof-srcwin")
    ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-srcwin*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
    if on:
        subprocess.Popen([CHROME, "--app=http://127.0.0.1:8799/p0-anim.html?title=P0%20Anim%20Source&label=SRC&fps=30",
                          "--window-size=1292,726", "--window-position=2700,620", "--no-first-run", "--no-default-browser-check",
                          "--force-device-scale-factor=1", "--disable-component-update", "--disable-background-networking",
                          # a covered Chrome window stops drawing: keep the source alive under other windows
                          "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
                          "--disable-features=CalculateNativeWinOcclusion",
                          f"--user-data-dir={prof}"])
        time.sleep(3)


def close_all():
    snap = get("/api/state")
    for cid, w in snap["windows"].items():
        if w.get("open"):
            post(f"/api/components/{cid}/close")
    time.sleep(2.5)


close_all()
source_window(True)
sc = post("/api/scenes", {"template": "gaming_landscape", "name": "P5 native"})["scene"]
for layer in sc["layers"]:
    p = layer["props"]
    if layer["type"] == "capture":
        p["mode"] = "native"
        p["source"] = {"kind": "window", "title": "P0 Anim Source"}
        p["fit"] = "contain"
        layer["transform"].update({"x": 0, "y": 0, "w": 1440, "h": 810})
    if layer["type"] == "camera":
        p.update(mode="native", device=cam_hint, width=640, height=480, fps=30, mirror=True, mask="circle")
    if layer["type"] == "text":
        p["decor"] = {"border": "sparkle", "sides": "all", "size": 0.9, "opacity": 0.9, "color": "#ffd1ff", "gap": 0.6, "animate": True}
sc["background"] = {"mode": "gradient", "color": "#1a1030", "color2": "#301848", "angle": 135}
r = post(f"/api/scenes/{sc['id']}", {"scene": sc})
sid = r["scene"]["id"]
post("/api/canvas/live", {"id": sid, "transition": "cut"})
r = post("/api/components/live/open")
check("live output opens", r.get("ok") and r.get("hosted"), json.dumps(r)[:100])
time.sleep(8)
print("   Chrome, scene with native holes only (no LIVE yet):", f"{cpu('testrig', 10):.1f}%")
out = os.path.join(S, "live", "p5native.flv")
if os.path.exists(out):
    os.remove(out)
sk = subprocess.Popen([os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "warning", "-y", "-listen", "1", "-timeout", "60",
                       "-i", "rtmp://127.0.0.1:1935/live/test", "-c", "copy", "-f", "flv", out], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
r = post("/api/live/start", {"url": "rtmp://127.0.0.1:1935/live", "key": "test", "preset": "1080p30", "source": "live",
                             "audio": {"mic": True, "system": True}})
check("live starts natively", r.get("ok") and r.get("path") == "native", json.dumps(r)[:120])
time.sleep(8)
st = get("/api/live/status")
print("   sources:", json.dumps(st["native"].get("sources")))
chrome = cpu("testrig", 12)
srv = server_cpu(12)
st = get("/api/live/status")
print(f"   LIVE with native window + camera: Chrome {chrome:.1f}%, server {srv:.1f}%; {st['stats']['kbps']} kbps {st['stats']['vfps']} fps, native {st['native']['fps']} fps drop {st['native']['dropped']}")
srcs = st["native"].get("sources") or []
win = [x for x in srcs if x.get("kind") == "window"]
cam = [x for x in srcs if x.get("kind") == "camera"]
check("the window source is captured", win and win[0].get("frames", 0) > 30 and not win[0].get("error"), json.dumps(win)[:160])
check("the camera source delivers frames (needs a free camera)", cam and cam[0].get("frames", 0) > 30 and not cam[0].get("error"), json.dumps(cam)[:160])
check("Chrome pays nothing for the sources (<= 22% of one core with the animated scene)", 0 <= chrome <= 22, f"{chrome:.1f}% (a browser camera + window source measured 35-42%)")
time.sleep(max(0, seconds - 20))
post("/api/live/stop")
sk.wait(20)
subprocess.run([os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "error", "-y", "-ss", "10", "-i", out,
                "-frames:v", "1", "-update", "1", "-vf", "scale=960:-1", os.path.join(S, "live", "p5native.png")])
print("   frame:", os.path.join(S, "live", "p5native.png"), os.path.exists(os.path.join(S, "live", "p5native.png")))
post("/api/components/live/close")
post("/api/canvas/live", {"id": ""})
post(f"/api/scenes/{sid}/delete")
source_window(False)
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)} of {len(results)} checks passed" + (f"; FAILED: {failed}" if failed else ""))
