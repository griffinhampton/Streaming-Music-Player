"""P5 measurements on the rig (8799): every template scene idle, animated,
with a camera and with a window source; LIVE at a real 720p30 and 1080p30;
Ultra, minimized and parked outputs; the feed cap with seven windows.

    python p5rig.py [part ...]   parts: measure live ultra feeds all
"""
import json, os, subprocess, sys, time, urllib.request

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
FF = r"C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin"
PARTS = set(sys.argv[1:]) or {"all"}
LOG = open(os.path.join(S, "live", "p5rig.log"), "w", buffering=1)
results = []


def say(*a):
    line = " ".join(str(x) for x in a)
    print(line, flush=True)
    LOG.write(line + "\n")


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    say(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        body = r.read()
        return r.status, (json.loads(body) if r.headers.get("Content-Type", "").startswith("application/json") else body)


def post(path, data=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(data or {}).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def ps(script, timeout=120):
    return subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=timeout).stdout


def cpu(match, seconds=15):
    out = ps(f'& "{S}\\cpuby.ps1" -Match \'{match}\' -Seconds {seconds}')
    total = [l for l in out.splitlines() if "TOTAL" in l]
    say("   " + out.strip().replace("\n", "\n   "))
    return float(total[0].split()[1]) if total else -1


def server_cpu(seconds=15):
    """The rig server's CPU over `seconds`, by the pid that owns port 8799."""
    out = ps("$pid8799 = (Get-NetTCPConnection -State Listen -LocalPort 8799).OwningProcess | Select-Object -First 1; "
             "$p = Get-Process -Id $pid8799; $c0 = $p.TotalProcessorTime.TotalSeconds; $sw = [Diagnostics.Stopwatch]::StartNew(); "
             f"Start-Sleep -Seconds {seconds}; $p = Get-Process -Id $pid8799; "
             "'{0:N1}' -f (100 * ($p.TotalProcessorTime.TotalSeconds - $c0) / $sw.Elapsed.TotalSeconds)")
    try:
        return float(out.strip())
    except ValueError:
        return -1


def wgc(title, name, seconds=1.0):
    out = subprocess.run([sys.executable, os.path.join(S, "wgc.py"), "window", title,
                          os.path.join(S, "live", name), str(seconds), "half"], capture_output=True, text=True).stdout
    return out


def close_all():
    st, snap = get("/api/state")
    for cid, w in snap["windows"].items():
        if w.get("open"):
            post(f"/api/components/{cid}/close")
    time.sleep(2.5)


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


def want(part):
    return "all" in PARTS or part in PARTS


def sink(name):
    out = os.path.join(S, "live", name)
    if os.path.exists(out):
        os.remove(out)
    p = subprocess.Popen([os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "warning", "-y", "-listen", "1",
                          "-timeout", "60", "-i", "rtmp://127.0.0.1:1935/live/test", "-c", "copy", "-f", "flv", out],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    return p, out


def variant(scene, kind):
    """A copy of a template scene with one thing changed."""
    s = json.loads(json.dumps(scene))
    for layer in s["layers"]:
        p = layer.setdefault("props", {})
        if kind == "animated" and layer["type"] == "text":
            p["decor"] = {"border": "sparkle", "sides": "all", "size": 0.9, "opacity": 0.9, "color": "#ffd1ff", "gap": 0.6, "animate": True}
            break
        if kind == "camera" and layer["type"] == "camera":
            p["device"] = "IR"          # the IR camera is the one OBS and LIVE Studio leave free
            p["width"], p["height"] = 640, 480
        if kind == "window" and layer["type"] == "capture":
            p["mode"] = "browser"
            p["source"] = {"kind": "window", "title": "P0 Anim Source"}
    if kind == "window" and not any(l["type"] == "capture" for l in s["layers"]):
        s["layers"].insert(0, {"type": "capture", "name": "Window", "transform": {"x": 0, "y": 0, "w": s["width"], "h": s["height"] // 2, "rotation": 0},
                               "props": {"mode": "browser", "source": {"kind": "window", "title": "P0 Anim Source"}, "fps": 30}, "visible": True})
    if kind == "camera" and not any(l["type"] == "camera" for l in s["layers"]):
        s["layers"].append({"type": "camera", "name": "Camera", "transform": {"x": 40, "y": 40, "w": 480, "h": 360, "rotation": 0},
                            "props": {"device": "IR", "width": 640, "height": 480, "fps": 30, "mirror": True, "mask": "rounded"}, "visible": True})
    return s


created = []
table = []


def measure(name, sid, title, seconds=15, want_source=False):
    st, r = post(f"/api/components/scene:{sid}/open")
    if not r.get("ok"):
        say(f"   {name}: window did not open: {r}")
        return -1
    time.sleep(9)
    st, status = get(f"/api/components/scene:{sid}/status")
    total = cpu("testrig", seconds)
    srv = server_cpu(5)
    raw = wgc(title, f"p5_{name.replace(' ', '_').replace('/', '-')}.png", 0.6)
    frames = [l for l in raw.splitlines() if l.startswith("frames")]
    table.append((name, total, srv, frames[0] if frames else "no capture"))
    say(f"=> {name}: {total:.1f}% of one core total (server {srv:.1f}%), {frames[0] if frames else 'no capture'}")
    post(f"/api/components/scene:{sid}/close")
    time.sleep(2.5)
    return total


if want("measure"):
    close_all()
    for key in ("just_chatting", "music_lyrics", "gaming_portrait", "gaming_landscape"):
        st, r = post("/api/scenes", {"template": key, "name": f"P5 {key}"})
        base = r["scene"]
        created.append(base["id"])
        for kind in ("idle", "animated", "camera", "window"):
            if kind == "idle":
                sid = base["id"]
            else:
                st, r = post("/api/scenes", {"name": f"P5 {key} {kind}", "format": base["format"],
                                             "width": base["width"], "height": base["height"]})
                v = variant(base, kind)
                v["id"] = r["scene"]["id"]
                st, r = post(f"/api/scenes/{v['id']}", {"scene": v})
                sid = r["scene"]["id"]
                created.append(sid)
            if kind == "window":
                source_window(True)
            say(f"--- {key} / {kind}")
            measure(f"{key} {kind}", sid, f"Awesome Streaming Deck - Canvas: P5 {key}" + ("" if kind == "idle" else f" {kind}"))
            if kind == "window":
                source_window(False)

if want("live"):
    close_all()
    st, r = post("/api/scenes", {"template": "just_chatting", "name": "P5 live 1080"})
    live1080 = variant(r["scene"], "animated")
    st, r = post(f"/api/scenes/{live1080['id']}", {"scene": live1080})
    created.append(live1080["id"])
    st, r = post("/api/scenes", {"name": "P5 live 720", "format": "horizontal", "width": 1280, "height": 720})
    live720 = variant(r["scene"], "animated")
    live720["background"] = live1080["background"]
    live720["layers"] = json.loads(json.dumps(live1080["layers"]))
    for layer in live720["layers"]:
        t = layer["transform"]
        for k in ("x", "y", "w", "h"):
            t[k] = round(t[k] * 2 / 3)
        if layer["type"] == "text":
            layer["props"]["size"] = round(layer["props"].get("size", 48) * 2 / 3)
    st, r = post(f"/api/scenes/{live720['id']}", {"scene": live720})
    created.append(live720["id"])
    for label, scene, preset in (("720p30", live720, "720p30"), ("1080p30", live1080, "1080p30")):
        post("/api/canvas/live", {"id": scene["id"], "transition": "cut"})
        st, r = post("/api/components/live/open")
        time.sleep(9)
        sk, out = sink(f"p5_live_{label}.flv")
        st, r = post("/api/live/start", {"url": "rtmp://127.0.0.1:1935/live", "key": "test", "preset": preset, "source": "live",
                                         "audio": {"mic": True, "system": True}})
        say(f"--- LIVE {label}: {json.dumps(r)}")
        time.sleep(8)
        total = cpu("testrig", 15)
        st, ls = get("/api/live/status")
        srv = server_cpu(5)
        say(f"=> LIVE {label}: {total:.1f}% total, server {srv:.1f}%; {ls['stats']['kbps']} kbps {ls['stats']['vfps']} fps, native {ls['native']['size']} {ls['native']['fps']} fps, drop {ls['stats']['dropped']}")
        table.append((f"LIVE {label} ({ls['native']['size']})", total, srv, f"{ls['stats']['kbps']} kbps {ls['stats']['vfps']} fps"))
        post("/api/live/stop")
        sk.wait(20)
        post("/api/components/live/close")
        post("/api/canvas/live", {"id": ""})
        time.sleep(2.5)

if want("ultra"):
    close_all()
    st, r = post("/api/scenes", {"template": "just_chatting", "name": "P5 ultra"})
    u = variant(r["scene"], "animated")
    st, r = post(f"/api/scenes/{u['id']}", {"scene": u})
    created.append(u["id"])
    sid = u["id"]
    title = "Awesome Streaming Deck - Canvas: P5 ultra"
    st, r = post(f"/api/components/scene:{sid}/open")
    time.sleep(9)
    say("--- animated, normal")
    a = cpu("testrig", 15)
    post("/api/config", {"ui": {"ultra": True}})
    time.sleep(3)
    say("--- animated, Ultra on")
    b = cpu("testrig", 15)
    post("/api/config", {"ui": {"ultra": False}})
    time.sleep(3)
    post(f"/api/components/scene:{sid}/minimize")
    time.sleep(3)
    say("--- animated, minimized")
    c = cpu("testrig", 15)
    post(f"/api/components/scene:{sid}/restore")
    time.sleep(2)
    post(f"/api/components/scene:{sid}/park")
    time.sleep(3)
    say("--- animated, parked off screen")
    d = cpu("testrig", 15)
    raw = wgc(title, "p5_parked.png", 0.6)
    frames = [l for l in raw.splitlines() if l.startswith("frames")]
    post(f"/api/components/scene:{sid}/unpark")
    table += [("animated normal", a, -1, ""), ("animated Ultra", b, -1, ""), ("animated minimized", c, -1, ""),
              ("animated parked", d, -1, frames[0] if frames else "")]
    check("Ultra stops the motion (<= 40% of the animated cost)", b <= a * 0.4 + 1, f"{a:.1f}% -> {b:.1f}%")
    check("minimized goes idle (<= 3% of one core)", c <= 3, f"{c:.1f}%")
    check("parked keeps rendering and captures", frames and int(frames[0].split()[1]) > 10, frames)
    post(f"/api/components/scene:{sid}/close")
    time.sleep(2.5)

if want("feeds"):
    close_all()
    ids = []
    for key in ("just_chatting", "gaming_landscape"):
        st, r = post("/api/scenes", {"template": key, "name": f"P5 feed {key}"})
        ids.append(r["scene"]["id"]); created.append(r["scene"]["id"])
    post("/api/canvas/live", {"id": ids[0], "transition": "cut"})
    for cid in ("np", "lyrics", "queue", "captions", "live", f"scene:{ids[0]}", f"scene:{ids[1]}"):
        st, r = post(f"/api/components/{cid}/open")
        say(f"   open {cid}: {r.get('ok')} hosted {r.get('hosted')}")
        time.sleep(1.5)
    prof = os.path.join(S, "prof-deck")
    ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-deck*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
    subprocess.Popen([CHROME, f"--app={BASE}/deck.html", "--window-size=1180,820", "--window-position=2860,640", "--no-first-run",
                      "--no-default-browser-check", "--disable-component-update", "--disable-background-networking", f"--user-data-dir={prof}"])
    time.sleep(10)
    st, f = get("/api/feeds")
    say("   feeds:", json.dumps(f["counts"]), [(o["kind"], o["page"]) for o in f["open"]])
    st, snap = get("/api/state")
    hosted = {cid: w.get("hosted") for cid, w in snap["windows"].items() if w.get("open")}
    check("seven windows open and hosted with the deck", len(hosted) == 7 and all(hosted.values()), json.dumps(hosted))
    check("pop-outs on SSE (4), outputs on the WebSocket feed (3), deck 1", f["counts"]["windows_sse"] == 4 and f["counts"]["windows_ws"] == 3 and f["counts"]["deck"] >= 1, json.dumps(f["counts"]))
    # A change must still reach every page: switch the live scene to a phone one and watch the live output resize.
    st, r = post("/api/scenes", {"template": "gaming_portrait", "name": "P5 feed phone"})
    created.append(r["scene"]["id"])
    post("/api/canvas/live", {"id": r["scene"]["id"], "transition": "cut"})
    time.sleep(5)
    st, st2 = get("/api/components/live/status")
    check("the live output followed the switch with seven feeds open", (st2.get("rect") or {}).get("h") == 1920, json.dumps(st2.get("rect")))
    log = open(os.path.join(S, "rig.log"), encoding="utf-8", errors="replace").read()
    check("no six-connection warning in the server log", "event streams open" not in log)
    ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-deck*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
    post("/api/canvas/live", {"id": ""})
    close_all()

close_all()
for sid in created:
    post(f"/api/scenes/{sid}/delete")
say("\n| Scene | Total % of one core (Chrome + server) | Server alone | Capture |")
say("|---|---|---|---|")
for name, total, srv, frames in table:
    say(f"| {name} | {total:.1f} | {srv:.1f} | {frames} |" if srv >= 0 else f"| {name} | {total:.1f} | | {frames} |")
failed = [n for n, ok in results if not ok]
say(f"\n{len(results) - len(failed)} of {len(results)} checks passed" + (f"; FAILED: {failed}" if failed else ""))
