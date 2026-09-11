"""Recovery on the rig (P5): the live output's window killed mid-stream
comes back and re-joins the stream; every output's page killed (renderers
shot) gets rebuilt; a server restart brings the outputs back, parked ones
parked.

    python p5recover.py
"""
import ctypes, json, os, subprocess, sys, time, urllib.request

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))
FF = r"C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin"
PY = r"C:\Users\ghamp\streaming stuff\.build-env\Scripts\python.exe"
sys.path.insert(0, os.path.join(S, "testrig"))
import capture  # noqa: E402
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


def wait_for(pred, timeout, every=1.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if pred():
                return True
        except Exception:
            pass
        time.sleep(every)
    return False


def rig_log():
    return open(os.path.join(S, "rig.log"), encoding="utf-8", errors="replace").read()


def sink(name):
    out = os.path.join(S, "live", name)
    if os.path.exists(out):
        os.remove(out)
    p = subprocess.Popen([os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "warning", "-y", "-listen", "1",
                          "-timeout", "60", "-i", "rtmp://127.0.0.1:1935/live/test", "-c", "copy", "-f", "flv", out],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    return p, out


def close_all():
    snap = get("/api/state")
    for cid, w in snap["windows"].items():
        if w.get("open"):
            post(f"/api/components/{cid}/close")
    time.sleep(2.5)


created = []
close_all()
r = post("/api/scenes", {"template": "just_chatting", "name": "P5 recover"})
scene = r["scene"]; created.append(scene["id"])
r = post("/api/scenes", {"template": "gaming_landscape", "name": "P5 recover 2"})
scene2 = r["scene"]; created.append(scene2["id"])
post("/api/canvas/live", {"id": scene["id"], "transition": "cut"})
r = post("/api/components/live/open")
check("live output opens", r.get("ok") and r.get("hosted"), json.dumps(r)[:100])
time.sleep(6)

# ---- 1. the live window dies mid-stream
sk, out = sink("p5_recover.flv")
r = post("/api/live/start", {"url": "rtmp://127.0.0.1:1935/live", "key": "test", "preset": "720p30", "source": "live",
                             "audio": {"mic": False, "system": False}})
check("live starts natively", r.get("ok") and r.get("path") == "native", json.dumps(r)[:120])
time.sleep(6)
st = get("/api/live/status")
f0 = st["native"]["frames"]
hwnd = capture.find_window("Awesome Streaming Deck - Canvas (live)")
print("   killing the live window", hwnd)
ctypes.windll.user32.PostMessageW(ctypes.c_void_p(hwnd), 0x0010, 0, 0)          # WM_CLOSE to the host
time.sleep(1.5)
st = get("/api/components/live/status")
check("the window is gone", not st.get("open"), json.dumps(st)[:80])
back = wait_for(lambda: get("/api/components/live/status").get("hosted"), 20)
check("the watchdog opened it again within 20 s", back)
time.sleep(6)
st = get("/api/live/status")
f1 = st["native"]["frames"]
check("the stream is still live and the video re-joined it", st["state"] == "live" and st["native"]["running"]
      and f1 > f0 and not st["native"]["stalled"] and not st["native"]["error"],
      f"frames {f0} -> {f1}, stalled {st['native']['stalled']}, err {st['native']['error']!r}")
check("the log says so", "re-joined the stream" in rig_log() and "is gone; opening it again" in rig_log())
post("/api/live/stop")
sk.wait(20)
probe = subprocess.run([os.path.join(FF, "ffprobe.exe"), "-v", "error", "-select_streams", "v:0", "-count_frames",
                        "-show_entries", "stream=nb_read_frames:format=duration", "-of", "default=nw=1", out],
                       capture_output=True, text=True).stdout.strip().replace("\n", " ")
print("   recording:", probe)

# ---- 2. every page shot (renderers killed): outputs rebuilt after they go quiet
post(f"/api/components/scene:{scene2['id']}/open")
time.sleep(6)
before = get("/api/feeds")["counts"]
n = ps("$n = 0; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*testrig*' -and $_.CommandLine -like '*--type=renderer*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; $n").strip()
print(f"   killed {n} renderers; feeds before {json.dumps(before)}")
time.sleep(2)
after_kill = get("/api/feeds")["counts"]
rebuilt = wait_for(lambda: get("/api/feeds")["counts"]["windows_ws"] >= 2 and "gone quiet" in rig_log(), 40, 2)
time.sleep(3)
snap = get("/api/state")
hosted = {cid: w.get("hosted") for cid, w in snap["windows"].items() if w.get("open")}
check("pages shot: their feeds dropped", after_kill["windows_ws"] < before["windows_ws"], f"{before} -> {after_kill}")
check("quiet outputs were rebuilt and their feeds are back", rebuilt and len(hosted) == 2 and all(hosted.values()),
      f"{json.dumps(get('/api/feeds')['counts'])} {json.dumps(hosted)}")

# ---- 3. a server restart brings the outputs back, a parked one parked
post(f"/api/components/scene:{scene2['id']}/park")
time.sleep(1)
remembered = json.load(open(os.path.join(S, "testrig", "config.json"), encoding="utf-8"))["canvas"].get("reopen", {})
check("the open outputs are remembered, with the parked flag", set(remembered) == {"live", f"scene:{scene2['id']}"}
      and remembered[f"scene:{scene2['id']}"]["parked"] and not remembered["live"]["parked"], json.dumps(remembered))
ps("Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'python.exe' -and $_.CommandLine -like '*server.py*') -or ($_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*testrig*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
time.sleep(2)
subprocess.Popen([PY, "-u", "server.py", "--no-open"], cwd=os.path.join(S, "testrig"),
                 stdout=open(os.path.join(S, "rig.log"), "w"), stderr=open(os.path.join(S, "rig.err"), "w"),
                 creationflags=0x08000000)
up = wait_for(lambda: get("/api/state") is not None, 30)
check("the server is back", up)
restored = wait_for(lambda: all(get("/api/state")["windows"].get(c, {}).get("hosted") for c in ("live", f"scene:{scene2['id']}")), 40, 2)
time.sleep(2)
snap = get("/api/state")
w2 = snap["windows"].get(f"scene:{scene2['id']}", {})
check("both outputs re-opened after the restart", restored, json.dumps({c: snap['windows'].get(c, {}).get('hosted') for c in ('live', f'scene:{scene2["id"]}')}))
check("the parked one came back parked", w2.get("parked") is True and (w2.get("rect") or {}).get("x", 0) < -1000, json.dumps(w2.get("rect")))

close_all()
post("/api/canvas/live", {"id": ""})
for sid in created:
    post(f"/api/scenes/{sid}/delete")
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)} of {len(results)} checks passed" + (f"; FAILED: {failed}" if failed else ""))
