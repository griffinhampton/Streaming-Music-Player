"""Minimized and parked, step by step: where does the browser process's
CPU go while a hosted window is minimized, and does a window still render
off screen after a minimize/restore round trip?"""
import json, os, subprocess, sys, time, urllib.request

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())


def post(path, data=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(data or {}).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def cpu(match, seconds):
    out = subprocess.run(creationflags=0x08000000, args=["powershell", "-NoProfile", "-Command", f'& "{S}\cpuby.ps1" -Match \'{match}\' -Seconds {seconds}'],
                         capture_output=True, text=True, timeout=120).stdout
    return " | ".join(l.strip() for l in out.splitlines() if any(k in l for k in ("browser", "gpu-process", "renderer", "TOTAL")))


def wgc(title):
    out = subprocess.run(creationflags=0x08000000, args=[sys.executable, os.path.join(S, "wgc.py"), "window", title, os.path.join(S, "live", "p5min.png"), "1", "half"],
                         capture_output=True, text=True).stdout
    return " ".join(l for l in out.splitlines() if l.startswith("frames"))


what = sys.argv[1] if len(sys.argv) > 1 else "scene"
if what == "scene":
    sid = post("/api/scenes", {"template": "just_chatting", "name": "P5 min"})["scene"]["id"]
    cid, title = f"scene:{sid}", "Canvas: P5 min"
else:
    sid, cid, title = None, "np", "Now Playing"
post(f"/api/components/{cid}/open"); time.sleep(8)
print("normal:   ", cpu("testrig", 8))
post(f"/api/components/{cid}/minimize"); time.sleep(3)
print("min 1:    ", cpu("testrig", 8))
print("min 2:    ", cpu("testrig", 8))
print("status:   ", json.dumps(get(f"/api/components/{cid}/status")))
post(f"/api/components/{cid}/restore"); time.sleep(3)
print("restored: ", cpu("testrig", 8), wgc(title))
post(f"/api/components/{cid}/park"); time.sleep(3)
print("parked:   ", cpu("testrig", 8), wgc(title))
post(f"/api/components/{cid}/unpark"); time.sleep(3)
print("unparked: ", cpu("testrig", 6), wgc(title))
post(f"/api/components/{cid}/close")
if sid:
    post(f"/api/scenes/{sid}/delete")
