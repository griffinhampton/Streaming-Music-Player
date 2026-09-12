"""On air, the live output cannot be minimized (a minimized window cannot
be captured) but can be parked; off air it minimizes for real, the page
idles, and it comes back where it was at full size."""
import json, os, subprocess, time, urllib.request, urllib.error
BASE = "http://127.0.0.1:8799"
FF = r"C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin"
S = os.path.dirname(os.path.abspath(__file__))
results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok))); print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)
def get(p):
    return json.loads(urllib.request.urlopen(BASE + p, timeout=30).read())
def post(p, d=None):
    r = urllib.request.Request(BASE + p, data=json.dumps(d or {}).encode(), method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as x:
            return x.status, json.loads(x.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")
post("/api/components/live/open"); time.sleep(6)
code, r = post("/api/components/live/minimize"); time.sleep(3)
st = get("/api/components/live/status")
check("off air: minimize is a real minimize", code == 200 and st.get("minimized") and not st.get("parked"), json.dumps(st)[:120])
print("   viewport while minimized (Chrome follows the host down):", st.get("viewport"))
post("/api/components/live/restore"); time.sleep(4)
st = get("/api/components/live/status")
check("restored where it was, at full size", not st.get("minimized") and (st.get("rect") or {}).get("x", 0) >= 2560
      and (st.get("viewport") or [0])[0] >= 1900, f"{json.dumps(st.get('rect'))} viewport {st.get('viewport')}")
sk = subprocess.Popen(creationflags=0x08000000, args=[os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "error", "-y", "-listen", "1", "-timeout", "60",
                       "-i", "rtmp://127.0.0.1:1935/live/test", "-c", "copy", "-f", "flv", os.path.join(S, "live", "onair.flv")],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
code, r = post("/api/live/start", {"url": "rtmp://127.0.0.1:1935/live", "key": "test", "preset": "720p30", "source": "live",
                                   "audio": {"mic": False, "system": False}})
time.sleep(6)
code, r = post("/api/components/live/minimize"); time.sleep(1)
st = get("/api/components/live/status")
check("on air: minimize is refused with a reason", code == 409 and not r.get("ok") and "park" in r.get("reason", "") and not st.get("minimized"),
      f"{code} {json.dumps(r)[:100]}")
code, r = post("/api/components/live/park"); time.sleep(4)
f0 = get("/api/live/status")["native"]["frames"]; time.sleep(4)
ls = get("/api/live/status")
check("on air: parking keeps the stream fed", ls["native"]["frames"] > f0 + 60 and not ls["native"]["stalled"],
      f"frames {f0} -> {ls['native']['frames']}, fps {ls['native']['fps']}")
post("/api/components/live/unpark")
post("/api/live/stop"); sk.wait(20)
post("/api/components/live/close")
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)} of {len(results)} checks passed" + (f"; FAILED: {failed}" if failed else ""))
