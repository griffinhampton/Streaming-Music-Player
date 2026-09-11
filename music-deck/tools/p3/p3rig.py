"""P3 checks on the rig (8799): every layer type rendered and captured in
both formats, embedded components vs pop-outs (CPU), camera and capture
sources, reactive latency through DevTools, and 20 live switches.

    python p3rig.py [part ...]   parts: render ab live latency capture all
"""
import base64, json, os, struct, subprocess, sys, time, urllib.request, zlib

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PARTS = set(sys.argv[1:]) or {"all"}
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)


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


def windiag():
    out = subprocess.run([sys.executable, os.path.join(S, "windiag2.py"), "8799"], capture_output=True, text=True).stdout
    print("   " + out.strip().replace("\n", "\n   "))
    return out


def wgc(title, name, seconds=1.0):
    out = subprocess.run([sys.executable, os.path.join(S, "wgc.py"), "window", title,
                          os.path.join(S, "apps", name), str(seconds), "half"], capture_output=True, text=True).stdout
    lines = [l for l in out.splitlines() if l.startswith(("capture item", "frames", "wrote"))]
    return out, lines


def cpu(match, seconds=15):
    out = ps(f'& "{S}\\cpuby.ps1" -Match \'{match}\' -Seconds {seconds}')
    total = [l for l in out.splitlines() if "TOTAL" in l]
    print("   " + out.strip().replace("\n", "\n   "))
    return float(total[0].split()[1]) if total else -1


def png(w, h, color, color2=None):
    """A flat PNG, or a two-color checker, as a data URL."""
    rows = []
    for y in range(h):
        row = bytearray()
        for x in range(w):
            c = color2 if color2 and ((x // 16 + y // 16) % 2) else color
            row += bytes(c) + b"\xff"
        rows.append(b"\x00" + bytes(row))
    raw = b"".join(rows)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))
    return "data:image/png;base64," + base64.b64encode(data).decode()


def upload(name, data_url):
    st, r = post("/api/assets/upload", {"name": name, "data": data_url})
    assert r.get("ok"), r
    return r["id"]


def layer(kind, name, x, y, w, h, props=None, **more):
    out = {"type": kind, "name": name, "transform": {"x": x, "y": y, "w": w, "h": h, "rotation": more.pop("rotation", 0)},
           "props": props or {}, "visible": True}
    out.update(more)
    return out


def close_all():
    st, snap = get("/api/state")
    for cid, w in snap["windows"].items():
        if w.get("open"):
            post(f"/api/components/{cid}/close")
    time.sleep(2)


def source_window(on):
    prof = os.path.join(S, "prof-srcwin")
    ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-srcwin*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
    if on:
        subprocess.Popen([CHROME, "--app=http://127.0.0.1:8799/p0-anim.html?title=P0%20Anim%20Source&label=SRC&fps=30",
                          "--window-size=1292,726", "--window-position=40,80", "--no-first-run", "--no-default-browser-check",
                          "--force-device-scale-factor=1", "--disable-component-update", "--disable-background-networking",
                          f"--user-data-dir={prof}"])
        time.sleep(3)


def want(part):
    return "all" in PARTS or part in PARTS


created = []
# ------------------------------------------------------------ the scenes
idle = upload("idle.png", png(96, 96, (80, 140, 255)))
talking = upload("talking.png", png(96, 96, (255, 150, 60)))
checker = upload("checker.png", png(128, 128, (255, 255, 255), (30, 30, 40)))

st, r = post("/api/scenes", {"name": "All types", "format": "horizontal"})
ALL = r["scene"]
ALL["background"] = {"mode": "gradient", "color": "#101828", "color2": "#3b1d5e", "angle": 135}
ALL["layers"] = [
    layer("background", "Backdrop", 1200, 60, 660, 360, {"mode": "scene", "scene": {"id": "sakura", "seed": 2, "c1": "", "c2": "", "c3": ""}, "dim": 0.15}),
    layer("text", "Headline", 60, 40, 1100, 130, {"text": "{title} - {artist}  {time}", "size": 64, "fit": True, "color": "#ffffff",
          "pill": {"on": True, "color": "rgba(0,0,0,.45)", "pad": 14, "radius": 18}, "shadow": {"x": 0, "y": 3, "blur": 14, "color": "#000"}}),
    layer("text", "Gradient words", 60, 190, 900, 110, {"text": "Gradient stroke shadow", "size": 72, "align": "left",
          "gradient": {"on": True, "c1": "#ffd1ff", "c2": "#7cf5ff", "angle": 90}, "stroke": {"w": 2, "color": "#000"}}),
    layer("image", "Checker", 60, 330, 300, 300, {"src": checker, "fit": "contain", "flip_h": True}),
    layer("shape", "Rect", 400, 330, 260, 140, {"kind": "rect", "fill": "rgba(255,80,120,.8)", "stroke": {"w": 6, "color": "#fff"}},
          style={"radius": 24, "shadow": {"x": 0, "y": 8, "blur": 24, "color": "rgba(0,0,0,.6)"}}),
    layer("shape", "Ellipse", 700, 330, 200, 200, {"kind": "ellipse", "fill": "#7cf5ff"}, style={"opacity": 0.8}),
    layer("shape", "Frame", 940, 330, 240, 200, {"kind": "frame", "pad": 20, "hole_radius": 16, "fill": "rgba(255,255,255,.9)", "stroke": {"w": 3, "color": "#8b5cf6"}}),
    layer("shape", "Line", 400, 520, 500, 40, {"kind": "line", "stroke": {"w": 8, "color": "#ffe66d"}}, rotation=6),
    layer("reactive", "Avatar", 1300, 470, 240, 240, {"idle": idle, "talking": talking, "bounce": 24, "fit": "contain"}),
    layer("text", "Looped", 1560, 470, 300, 240, {"text": "border loop", "size": 40, "color": "#fff",
          "decor": {"border": "sparkle", "sides": "all", "size": 0.9, "opacity": 0.9, "color": "#ffd1ff", "gap": 0.6, "animate": True}}),
    layer("capture", "Game (native hole)", 1200, 740, 660, 300, {"mode": "native", "source": {"kind": "window", "title": "P0 Anim Source"}}),
    layer("camera", "Camera", 940, 560, 240, 180, {"width": 1280, "height": 720, "fps": 30, "mirror": True, "mask": "rounded"}),
    layer("component", "Now Playing", 60, 830, 760, 190, {"component": "np", "design": "linked"}),
    layer("component", "Captions", 860, 930, 320, 120, {"component": "captions", "options": {"card_bg": False, "frame": False}}),
    layer("text", "Speaking only", 60, 700, 500, 90, {"text": "SPEAKING", "size": 60, "color": "#ff6b6b"},
          triggers=[{"on": "speaking", "do": "show"}]),
]
st, r = post(f"/api/scenes/{ALL['id']}", {"scene": ALL, "expect_rev": 1})
check("all-types scene saved", r.get("ok") and len(r["scene"]["layers"]) == 15, json.dumps(r)[:120])
ALL = r["scene"]
created.append(ALL["id"])
tmpl = {}
for key in ("just_chatting", "music_lyrics", "gaming_portrait", "gaming_landscape"):
    st, r = post("/api/scenes", {"template": key})
    check(f"template {key}", r.get("ok") and r["scene"]["layers"], json.dumps(r)[:100])
    tmpl[key] = r["scene"]
    created.append(r["scene"]["id"])

if want("render"):
    # ------------------------------------------------------------ outputs and captures
    close_all()
    source_window(True)
    st, r = post(f"/api/components/scene:{ALL['id']}/open")
    check("all-types output opens", r.get("ok") and r.get("hosted"), json.dumps(r))
    time.sleep(8)
    out = windiag()
    check("all-types output aligned", "all aligned" in out)
    raw, lines = wgc("Awesome Streaming Deck - Canvas: All types", "p3_all.png", 1.0)
    check("all-types captured 1920x1080", "capture item size: 1920x1080" in raw, lines)
    st, f = get("/api/feeds")
    check("one feed for the whole scene (ws)", f["counts"]["windows_ws"] == 1 and f["counts"]["windows_sse"] == 0, json.dumps(f["counts"]))
    print("--- CPU: all-types scene output (camera, capture hole, components, loop)")
    full = cpu("testrig", 15)
    st, r = get("/api/live/status")     # keep the server awake on the same cadence
    st, r = post("/api/voice/override", {"speaking": True})
    time.sleep(1.5)
    raw, lines = wgc("Awesome Streaming Deck - Canvas: All types", "p3_all_speaking.png", 0.6)
    post("/api/voice/override", {"speaking": None})
    post(f"/api/components/scene:{ALL['id']}/close")
    time.sleep(2)
    st, r = post(f"/api/components/scene:{tmpl['gaming_portrait']['id']}/open")
    check("phone template output opens", r.get("ok") and r.get("hosted"), json.dumps(r))
    time.sleep(7)
    out = windiag()
    check("phone output 1080x1920 aligned", "1080x1920" in out and "all aligned" in out)
    raw, lines = wgc("Awesome Streaming Deck - Canvas: Gaming portrait", "p3_phone.png", 1.0)
    check("phone captured whole", "capture item size: 1080x1920" in raw, lines)
    post(f"/api/components/scene:{tmpl['gaming_portrait']['id']}/close")
    time.sleep(2)
    st, r = post(f"/api/components/scene:{tmpl['music_lyrics']['id']}/open")
    time.sleep(8)
    raw, lines = wgc("Awesome Streaming Deck - Canvas: Music + lyrics", "p3_music.png", 1.0)
    check("music template captured", "capture item size: 1920x1080" in raw, lines)
    post(f"/api/components/scene:{tmpl['music_lyrics']['id']}/close")
    source_window(False)

if want("ab"):
    # ------------------------------------------------------------ embedded vs pop-outs
    close_all()
    post("/api/components/np/open"); post("/api/components/captions/open")
    time.sleep(7)
    print("--- CPU: Now Playing + Captions as pop-outs")
    a = cpu("testrig", 15)
    close_all()
    st, r = post("/api/scenes", {"name": "AB", "format": "horizontal"})
    ab = r["scene"]; created.append(ab["id"])
    ab["background"] = {"mode": "solid", "color": "#000000"}
    ab["layers"] = [layer("component", "Now Playing", 60, 830, 760, 190, {"component": "np"}),
                    layer("component", "Captions", 860, 930, 900, 200, {"component": "captions"})]
    post(f"/api/scenes/{ab['id']}", {"scene": ab})
    post(f"/api/components/scene:{ab['id']}/open")
    time.sleep(8)
    print("--- CPU: the same two embedded in one 1920x1080 scene")
    b = cpu("testrig", 15)
    check("embedded costs no more than the two pop-outs (+15% slack)", b <= a * 1.15 + 2, f"pop-outs {a:.1f}%, embedded {b:.1f}% of one core")
    close_all()

if want("live"):
    # ------------------------------------------------------------ the live output and switching
    close_all()
    chat, game = tmpl["just_chatting"], tmpl["gaming_landscape"]
    st, r = post("/api/canvas/live", {"id": chat["id"], "transition": "fade", "duration": 300})
    check("live scene set", r.get("ok") and r["live"] == chat["id"], json.dumps(r))
    st, r = post("/api/components/live/open")
    check("live output opens", r.get("ok") and r.get("hosted"), json.dumps(r))
    time.sleep(8)
    st, before = get("/api/components/live/status")
    cap = subprocess.Popen([sys.executable, os.path.join(S, "wgc.py"), "window", "Awesome Streaming Deck - Canvas (live)",
                            os.path.join(S, "apps", "p3_live.png"), "26", "half"], stdout=subprocess.PIPE, text=True)
    meter = subprocess.Popen(["powershell", "-NoProfile", "-Command", f'& "{S}\\cpuby.ps1" -Match testrig -Seconds 24'],
                             stdout=subprocess.PIPE, text=True)
    t0 = time.time()
    for i in range(20):
        post("/api/canvas/live", {"id": (game if i % 2 == 0 else chat)["id"], "transition": "fade", "duration": 300})
        time.sleep(1.2)
    switching = time.time() - t0
    capout = cap.communicate()[0]
    meterout = meter.communicate()[0]
    frames = [l for l in capout.splitlines() if l.startswith("frames")]
    print("   " + meterout.strip().replace("\n", "\n   "))
    st, after = get("/api/components/live/status")
    check("20 switches: window never re-opened", after.get("rect") == before.get("rect") and after.get("hosted"), f"{before.get('rect')} -> {after.get('rect')}")
    check("20 switches: frames kept flowing", frames and int(frames[0].split()[1]) > 200, frames)
    st, r = post("/api/canvas/live", {"id": tmpl["gaming_portrait"]["id"], "transition": "cut"})
    time.sleep(4)
    st, st2 = get("/api/components/live/status")
    out = windiag()
    check("live output resized to the phone scene", (st2.get("rect") or {}).get("h") == 1920 and "all aligned" in out, json.dumps(st2.get("rect")))
    post("/api/canvas/live", {"id": ""})
    close_all()

if want("latency"):
    # ------------------------------------------------------------ reactive latency and source status (DevTools)
    close_all()
    prof = os.path.join(S, "prof-p3")
    ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-p3*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
    subprocess.Popen([CHROME, f"--app={BASE}/scene.html?id={ALL['id']}&preview=1", "--window-size=1296,760", "--window-position=300,200",
                      "--no-first-run", "--no-default-browser-check", "--force-device-scale-factor=1", "--remote-debugging-port=9448",
                      "--disable-component-update", "--disable-background-networking", "--autoplay-policy=no-user-gesture-required",
                      "--disable-features=CalculateNativeWinOcclusion", f"--user-data-dir={prof}"])
    time.sleep(7)
    ev = lambda expr: subprocess.run(["node", os.path.join(S, "cdp.js"), "9448", "Canvas", expr], capture_output=True, text=True).stdout.strip()
    print("   layers:", ev("SceneDebug.layers().map(l => [l.type, l.status])"))
    print("   embeds:", ev("SceneDebug.embeds()"))
    print("   fitted font sizes:", ev("[...document.querySelectorAll('.type-text .text-body')].map(b => b.style.fontSize)"))
    ev("window.__lat = []; new MutationObserver(() => window.__lat.push(Date.now())).observe(document.querySelector('.type-reactive img'), {attributes: true, attributeFilter: ['src']}); 'armed'")
    lat = []
    for i in range(6):
        t0 = time.time() * 1000
        post("/api/voice/override", {"speaking": i % 2 == 0})
        time.sleep(0.7)
        stamps = json.loads(ev("window.__lat") or "[]")
        if stamps:
            lat.append(float(stamps[-1]) - t0)
    post("/api/voice/override", {"speaking": None})
    lat.sort()
    check("reactive image swaps within 150 ms of the voice change (server -> page)", lat and lat[len(lat) // 2] < 150,
          f"samples ms: {[round(x) for x in lat]}")
    layers = json.loads(ev("SceneDebug.layers()") or "[]")
    cam = [l for l in layers if l["type"] == "camera"]
    print("   camera:", cam[0]["status"] if cam else "none")
    ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-p3*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")

if want("capture"):
    # ------------------------------------------------------------ a window source through the browser (auto-selected at launch)
    close_all()
    source_window(True)
    st, r = post("/api/scenes", {"name": "Cap", "format": "horizontal"})
    capscene = r["scene"]; created.append(capscene["id"])
    capscene["background"] = {"mode": "solid", "color": "#000000"}
    capscene["layers"] = [layer("capture", "Window", 160, 90, 1600, 900, {"mode": "browser", "source": {"kind": "window", "title": "P0 Anim Source"}, "fps": 30})]
    post(f"/api/scenes/{capscene['id']}", {"scene": capscene})
    st, r = post(f"/api/components/scene:{capscene['id']}/open")
    time.sleep(10)
    raw, lines = wgc("Awesome Streaming Deck - Canvas: Cap", "p3_capture.png", 1.0)
    check("capture scene output captured", "capture item size: 1920x1080" in raw, lines)
    print("--- CPU: scene with one 1600x900 window source through getDisplayMedia (30 fps source)")
    c = cpu("testrig", 15)
    post(f"/api/components/scene:{capscene['id']}/close")
    source_window(False)

# ------------------------------------------------------------ clean up
close_all()
for sid in created:
    post(f"/api/scenes/{sid}/delete")
for aid in (idle, talking, checker):
    post("/api/assets/delete", {"id": aid, "force": True})
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)} of {len(results)} checks passed" + (f"; FAILED: {failed}" if failed else ""))
