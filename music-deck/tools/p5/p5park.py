"""Park/unpark cycles on an always-animating scene: capture rate and Chrome
CPU at each step, then remedies (a host resize nudge, a rebuild)."""
import json, os, subprocess, sys, time, urllib.request
BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())

def post(path, data=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(data or {}).encode(), method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def cpu(seconds=6):
    out = subprocess.run(creationflags=0x08000000, args=["powershell", "-NoProfile", "-Command", f'& "{S}\cpuby.ps1" -Match testrig -Seconds {seconds}'], capture_output=True, text=True, timeout=120).stdout
    return " | ".join(l.strip().replace(" % of one core", "%").replace("  ", " ") for l in out.splitlines() if any(k in l for k in ("browser", "gpu-process", "renderer", "TOTAL")))

def fps(title="Canvas: P5 park"):
    out = subprocess.run(creationflags=0x08000000, args=[sys.executable, os.path.join(S, "wgc.py"), "window", title, os.path.join(S, "live", "p5park.png"), "1", "half"], capture_output=True, text=True).stdout
    return " ".join(l.split(";")[0] for l in out.splitlines() if l.startswith("frames"))

def step(tag):
    print(f"{tag:>22}: {fps()} | {cpu()}", flush=True)

sc = post("/api/scenes", {"template": "just_chatting", "name": "P5 park"})["scene"]
for layer in sc["layers"]:
    if layer["type"] == "text":
        layer["props"]["decor"] = {"border": "sparkle", "sides": "all", "size": 0.9, "opacity": 0.9, "color": "#ffd1ff", "gap": 0.6, "animate": True}
        break
post(f"/api/scenes/{sc['id']}", {"scene": sc})
cid = f"scene:{sc['id']}"
post(f"/api/components/{cid}/open"); time.sleep(8)
step("open")
post(f"/api/components/{cid}/park"); time.sleep(3)
step("park 1")
post(f"/api/components/{cid}/unpark"); time.sleep(3)
step("unpark 1")
post(f"/api/components/{cid}/park"); time.sleep(3)
step("park 2")
post(f"/api/components/{cid}/unpark"); time.sleep(3)
step("unpark 2")
post(f"/api/components/{cid}/resize", {"dw": 2, "dh": 0}); time.sleep(1)
post(f"/api/components/{cid}/resize", {"dw": -2, "dh": 0}); time.sleep(3)
step("after resize nudge")
post(f"/api/components/{cid}/park"); time.sleep(3)
step("park 3 after nudge")
post(f"/api/components/{cid}/unpark"); time.sleep(3)
r = post(f"/api/components/{cid}/rebuild"); time.sleep(8)
step("after rebuild")
post(f"/api/components/{cid}/park"); time.sleep(3)
step("park 4 after rebuild")
post(f"/api/components/{cid}/unpark"); time.sleep(3)
step("unpark 4")
post(f"/api/components/{cid}/close")
post(f"/api/scenes/{sc['id']}/delete")
