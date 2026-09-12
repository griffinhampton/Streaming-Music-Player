"""Scene switches keep what they can (P5): a following output page in a
debug Chrome, 20 live switches between two templates that share their
components and camera - the iframes must never be rebuilt, the camera
stream must survive, and the burst must cost far less than P3's 66%.

    python p5switch.py
"""
import json, os, subprocess, sys, time, urllib.request

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
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


def ev(expr):
    return subprocess.run(["node", os.path.join(S, "cdp.js"), "9448", "Canvas", expr], capture_output=True, text=True).stdout.strip()


prof = os.path.join(S, "prof-p5")
kill = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-p5*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
ps(kill)
created = []
tmpl = {}
for key in ("just_chatting", "gaming_landscape"):
    r = post("/api/scenes", {"template": key, "name": f"P5 switch {key}"})
    s = r["scene"]
    for layer in s["layers"]:
        if layer["type"] == "camera":
            layer["props"]["device"] = "IR"
            layer["props"]["width"], layer["props"]["height"] = 640, 480
    r = post(f"/api/scenes/{s['id']}", {"scene": s})
    tmpl[key] = r["scene"]
    created.append(s["id"])
chat, game = tmpl["just_chatting"], tmpl["gaming_landscape"]
post("/api/canvas/live", {"id": chat["id"], "transition": "fade", "duration": 300})
subprocess.Popen([CHROME, f"--app={BASE}/scene.html?follow=1&preview=1", "--window-size=1296,760", "--window-position=2960,740",
                  "--no-first-run", "--no-default-browser-check", "--force-device-scale-factor=1", "--remote-debugging-port=9448",
                  "--disable-component-update", "--disable-background-networking", "--autoplay-policy=no-user-gesture-required",
                  "--disable-features=CalculateNativeWinOcclusion", "--use-fake-ui-for-media-stream", f"--user-data-dir={prof}"])
time.sleep(9)
before = json.loads(ev("SceneDebug.embeds()") or "{}")
layers0 = json.loads(ev("SceneDebug.layers()") or "[]")
print("   before:", before, [(l["type"], l["status"]) for l in layers0 if l["type"] in ("camera", "component")])
cam0 = [l for l in layers0 if l["type"] == "camera"]
ev("window.__cam = document.querySelector('.type-camera video'); window.__np = document.querySelector('.type-component iframe'); 'kept'")
print("   idle CPU of the page's Chrome:")
idle_out = ps(f'& "{S}\\cpuby.ps1" -Match prof-p5 -Seconds 12')
print("   " + idle_out.strip().replace("\n", "\n   "))
idle_total = [l for l in idle_out.splitlines() if "TOTAL" in l]
idle = float(idle_total[0].split()[1]) if idle_total else -1
meter = subprocess.Popen(["powershell", "-NoProfile", "-Command", f'& "{S}\\cpuby.ps1" -Match prof-p5 -Seconds 24'],
                         stdout=subprocess.PIPE, text=True)
t0 = time.time()
for i in range(20):
    post("/api/canvas/live", {"id": (game if i % 2 == 0 else chat)["id"], "transition": "fade", "duration": 300})
    time.sleep(1.2)
meterout = meter.communicate()[0]
print("   CPU during 20 switches every 1.2 s:")
print("   " + meterout.strip().replace("\n", "\n   "))
total = [l for l in meterout.splitlines() if "TOTAL" in l]
burst = float(total[0].split()[1]) if total else -1
time.sleep(1.5)
after = json.loads(ev("SceneDebug.embeds()") or "{}")
layers1 = json.loads(ev("SceneDebug.layers()") or "[]")
same_cam = ev("document.querySelector('.type-camera video') === window.__cam")
same_np = ev("document.querySelector('.type-component iframe') === window.__np")
scene_now = ev("SceneDebug.scene().name")
print("   after:", after, [(l["type"], l["status"]) for l in layers1 if l["type"] in ("camera", "component")], "scene", scene_now)
check("no iframe was rebuilt across 20 switches", after.get("created") == before.get("created") and after.get("live") == before.get("live"),
      f"{before} -> {after}")
check("the camera element survived every switch", same_cam == "true", same_cam)
check("the Now Playing iframe is the same element", same_np == "true", same_np)
check("the page shows the scene the last switch asked for", scene_now.strip('"') == chat["name"], scene_now)
check("20 switches in 24 s add no more than 35% of one core over the scene's idle cost", 0 <= burst - idle <= 35,
      f"idle {idle:.1f}% -> burst {burst:.1f}% (P3: 66% with every switch rebuilding the pages)")
ps(kill)
post("/api/canvas/live", {"id": ""})
for sid in created:
    post(f"/api/scenes/{sid}/delete")
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)} of {len(results)} checks passed" + (f"; FAILED: {failed}" if failed else ""))
