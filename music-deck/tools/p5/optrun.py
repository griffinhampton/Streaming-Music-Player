"""Efficiency pass (2026-09-12): every piece of the app measured on the rig,
Chrome by process type and the server by thread, against the user's
~5%-of-a-core goal. Measures only; changes nothing.

    python optrun.py [part ...]   parts: popouts deck scene transient all (transient is not in all)
"""
import ctypes, json, os, subprocess, sys, time, urllib.request, urllib.error

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PARTS = set(sys.argv[1:]) or {"all"}
LOG = open(os.path.join(S, "live", "optrun.log"), "a", buffering=1)
rows = []


def say(*a):
    line = " ".join(str(x) for x in a)
    sys.stdout.buffer.write((line + "\n").encode("utf-8", "replace"))   # window titles carry non-cp1252 glyphs
    sys.stdout.flush()
    LOG.write(line + "\n")


def want(p):
    return p in PARTS or ("all" in PARTS and p != "transient")


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
    return subprocess.run(creationflags=0x08000000, args=["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=timeout).stdout


def foreground():
    u = ctypes.windll.user32
    h = u.GetForegroundWindow()
    n = u.GetWindowTextLengthW(h)
    b = ctypes.create_unicode_buffer(n + 1)
    u.GetWindowTextW(h, b, n + 1)
    games = ps("(Get-Process | Where-Object { $_.Name -match 'League|TFT|isaac|VALORANT' } | "
               "Select-Object -ExpandProperty Name) -join ','").strip()
    return b.value[:40], games or "none"


def chrome_cpu(seconds):
    """cpuby.ps1's table as {process type: percent of one core}."""
    out = ps(f'& "{S}\\cpuby.ps1" -Match testrig -Seconds {seconds}')
    table = {}
    for line in out.splitlines():
        if "% of one core" not in line:
            continue
        head = line.split("% of one core")[0].split()
        try:
            table[" ".join(head[:-1])] = float(head[-1])
        except (ValueError, IndexError):
            pass
    return table


def measure(label, seconds=15):
    """Chrome (the rig's, by process type) and the server (by thread) over the same window."""
    a = get("/api/debug/threads")
    m0 = get("/api/debug/mem")
    chrome = chrome_cpu(seconds)
    b = get("/api/debug/threads")
    m1 = get("/api/debug/mem")
    span = b["at"] - a["at"]
    before = {t["id"]: t for t in a["threads"]}
    threads = sorted(((100 * (t["cpu"] - before[t["id"]]["cpu"]) / span, t["name"]) for t in b["threads"]
                      if t["id"] in before), reverse=True)
    server = sum(p for p, _ in threads)
    total = chrome.get("TOTAL", -1)
    sends = ""
    if "hub" in m0 and "hub" in m1:
        sends = f"  sends {(m1['hub']['sends'] - m0['hub']['sends']) / span:.2f}/s"
    fg, games = foreground()
    top = ", ".join(f"{n} {v:.1f}" for n, v in sorted(chrome.items(), key=lambda kv: -kv[1]) if n != "TOTAL" and v >= 0.5)
    hot = ", ".join(f"{n} {p:.1f}" for p, n in threads if p >= 0.3)
    say(f"{label:<42} Chrome {total:5.1f}%  server {server:4.1f}%{sends}  [{top}]  server: [{hot}]  fg: {fg}; games: {games}")
    rows.append((label, total, server))
    return total, server


def close_all():
    snap = get("/api/state")
    for cid, st in snap["windows"].items():
        if st.get("open"):
            post(f"/api/components/{cid}/close")
    time.sleep(2.5)


def wins_line(title):
    out = subprocess.run([sys.executable, os.path.join(S, "wins.py")], capture_output=True, text=True,
                         encoding="utf-8", errors="replace", creationflags=0x08000000,
                         env=dict(os.environ, PYTHONIOENCODING="utf-8")).stdout or ""
    return [l for l in out.splitlines() if title in l]


def deck(on):
    # "testrig" in the profile path: cpuby.ps1 counts it and rigrestart.ps1 kills it.
    prof = os.path.join(S, "testrig", "cache", "prof-deck")
    ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-deck*' } | "
       "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
    if not on:
        time.sleep(1.5)
        return True
    subprocess.Popen([CHROME, f"--user-data-dir={prof}", f"--app={BASE}/deck.html", "--window-size=1180,820",
                      "--window-position=2860,640", "--no-first-run", "--no-default-browser-check",
                      "--disable-component-update", "--disable-background-networking",
                      "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
                      "--disable-features=CalculateNativeWinOcclusion"])
    time.sleep(8)
    lines = wins_line("Deck")
    say("   deck window:", lines[0].strip() if lines else "NOT FOUND")
    if not lines or " second " not in lines[0]:
        say("   the deck is not on the second monitor - closing it, not measuring")
        deck(False)
        return False
    return True


fg, games = foreground()
say(f"\n===== efficiency pass {time.strftime('%Y-%m-%d %H:%M')}  foreground: {fg}; games: {games}")
close_all()
deck(False)
post("/api/config", {"ui": {"ultra": False}})
post("/api/canvas/live", {"id": ""})
time.sleep(3)
measure("server at rest, no windows", 20)

if want("popouts"):
    for cid in ("np", "lyrics", "queue", "captions"):
        post(f"/api/components/{cid}/open")
        time.sleep(8)
        measure(f"{cid}: open, nothing playing")
        post("/api/config", {"ui": {"ultra": True}})
        time.sleep(3)
        measure(f"{cid}: Ultra")
        post("/api/config", {"ui": {"ultra": False}})
        time.sleep(1)
        post(f"/api/components/{cid}/minimize")
        time.sleep(4)
        measure(f"{cid}: minimized")
        post(f"/api/components/{cid}/close")
        time.sleep(2.5)

if want("deck"):
    if deck(True):
        measure("deck alone")
        sid = post("/api/scenes", {"template": "just_chatting", "name": "opt preview"})["scene"]["id"]
        post("/api/canvas/live", {"id": sid, "transition": "cut"})
        time.sleep(6)
        measure("deck, a live scene set (its preview)")
        post("/api/canvas/live", {"id": ""})
        post(f"/api/scenes/{sid}/delete")
        time.sleep(2)
        for cid in ("np", "lyrics", "queue", "captions"):
            post(f"/api/components/{cid}/open")
            time.sleep(4)
        time.sleep(6)
        measure("deck + the four pop-outs, idle")
        post("/api/config", {"ui": {"ultra": True}})
        time.sleep(3)
        measure("deck + the four pop-outs, Ultra")
        post("/api/config", {"ui": {"ultra": False}})
        close_all()
        deck(False)

if want("scene"):
    sc = post("/api/scenes", {"template": "just_chatting", "name": "opt scene"})["scene"]
    sid = sc["id"]
    cams = [l for l in sc["layers"] if l["type"] == "camera"]
    say(f"   just_chatting: {len(sc['layers'])} layers, {len(cams)} camera layer(s) in the page")
    post(f"/api/components/scene:{sid}/open")
    time.sleep(9)
    measure("scene output, idle (template as shipped)")
    for l in sc["layers"]:
        if l["type"] == "camera":
            l["visible"] = False
    sc = post(f"/api/scenes/{sid}", {"scene": sc}).get("scene", sc)
    time.sleep(5)
    measure("scene output, idle, camera hidden")
    post("/api/config", {"ui": {"ultra": True}})
    time.sleep(3)
    measure("scene output, Ultra")
    post("/api/config", {"ui": {"ultra": False}})
    time.sleep(1)
    post(f"/api/components/scene:{sid}/minimize")
    time.sleep(4)
    measure("scene output, minimized")
    post(f"/api/components/scene:{sid}/close")
    post(f"/api/scenes/{sid}/delete")
    time.sleep(2)

if want("transient"):
    # Is the browser-process burst after a minimize or an Ultra switch a
    # cost that stays, or a settling that passes? Three 10 s samples each.
    post("/api/components/np/open")
    time.sleep(10)
    measure("np: open, settled 10 s", 10)
    measure("np: open, settled 20 s", 10)
    post("/api/components/np/minimize")
    time.sleep(1)
    for i in range(3):
        measure(f"np: minimized, sample {i + 1} (10 s each)", 10)
    post("/api/components/np/restore")
    time.sleep(4)
    post("/api/config", {"ui": {"ultra": True}})
    time.sleep(1)
    for i in range(3):
        measure(f"np: Ultra on, sample {i + 1} (10 s each)", 10)
    post("/api/config", {"ui": {"ultra": False}})
    post("/api/components/np/close")
    time.sleep(2.5)

fg, games = foreground()
say(f"===== done  foreground: {fg}; games: {games}")
