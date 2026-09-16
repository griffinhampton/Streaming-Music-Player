"""S5's acceptance check: a frame layer around a NATIVE capture hole, seen in
the encoded stream rather than in the browser.

    python framenative.py [seconds]

Why this exists. A CDP screenshot photographs Chrome's rendering. The native
path is different: the page paints the capture layer as a hole and the server's
compositor keys the captured picture in on the GPU (P5's shader-keyed holes).
A hole can look perfectly see-through in the editor and still key wrong, or
come out opaque, in the frame that reaches the encoder - and that divergence is
the whole reason S5 is judged by a captured frame instead of a screenshot.

So: one scene, a native monitor capture with a Frame layer wrapped exactly
around it, LIVE to a local ffmpeg sink for a few seconds, one frame decoded out
of the recording. Then look at live/framenative.png and check the three things
a screenshot cannot answer:

  1. the captured picture fills the hole, and is not black or a flat key color;
  2. the ring, glow, title plate and LIVE badge are drawn AROUND it, not over
     it, and are not doubled or offset from the hole's edge;
  3. the frame's surround is opaque where it should be - the hole's edge is
     where the picture stops, with no halo of background between the two.

Compare it against .rig/p6shots/frame_camera.png (the same dressing drawn by
the pop-out page). They should agree.

NOT YET RUN. This needs a visible, composed window: WGC delivers no frames
while DWM is idle, so the screen has to be on and not locked, and the live
output window opens on the desktop. On a one-monitor machine that means it will
appear over what you are doing - don't run it mid-stream or mid-game. It streams
to 127.0.0.1 only, never outward.

Unlike p5native.py this asks for NO audio: the check is about video keying, and
there is no reason to record a microphone for it.

Needs: the rig up on 8799 (tools/rig/rigrestart.ps1) and ffmpeg where FF points.
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))
FF = r"C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin"
seconds = float(sys.argv[1] if len(sys.argv) > 1 else 20)
results = []

# The hole, and the frame drawn around it. pad is the frame's width in pixels,
# so the frame's box is the capture's box grown by pad on every side and the
# hole lands exactly on the capture.
CAP = (300, 190, 1320, 700)
PAD = 60
FRAME = (CAP[0] - PAD, CAP[1] - PAD, CAP[2] + PAD * 2, CAP[3] + PAD * 2)


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())


def post(path, data=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(data or {}).encode("utf-8"),
                                 method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}")


def layer(n, name, ltype, rect, props):
    x, y, w, h = rect
    return {"id": format(0xf1000000 + n, "x"),
            "type": ltype, "name": name, "visible": True, "locked": False, "group": "",
            "transform": {"x": x, "y": y, "w": w, "h": h, "rotation": 0, "anchor": "tl"},
            "style": {"opacity": 1, "blend": "normal", "radius": 0},
            "props": props, "triggers": []}


made = post("/api/scenes", {"name": "S5 frame over a native hole", "format": "horizontal"})
sc = made.get("scene") or {}
sid = sc.get("id")
if not sid:
    sys.exit(f"could not make a scene: {json.dumps(made)[:200]}")

sc["background"] = {"mode": "solid", "color": "#101014"}
sc["transparency"] = "opaque"
sc["layers"] = [
    # Underneath: the screen, captured and keyed in by the app itself.
    layer(0, "Screen (native)", "capture", CAP,
          {"mode": "native", "source": {"kind": "monitor", "monitor": 0},
           "fit": "cover", "fps": 30, "cursor": False}),
    # Over it: the frame, its hole exactly the capture's box.
    layer(1, "Frame", "shape", FRAME,
          {"kind": "frame", "pad": PAD, "shape": "rounded", "hole_radius": 16,
           "hole": "clear", "fill": "rgba(16, 16, 20, 1)",
           "border": {"style": "glow", "width": 10, "color": "#ff7ab6"},
           "title": {"text": "cam", "place": "bottom", "size": 1, "color": "#ffffff"},
           "badges": {"tl": "", "tr": "LIVE", "bl": "\u2728", "br": "", "size": 1, "color": ""}}),
]
saved = post(f"/api/scenes/{sid}", {"scene": sc, "expect_rev": sc.get("rev")})
check("the scene saved with a frame over a native capture", bool(saved.get("ok") or saved.get("scene")),
      json.dumps(saved)[:120])

post("/api/canvas/live", {"id": sid, "transition": "cut"})
r = post("/api/components/live/open")
check("the live output window opens", r.get("ok") and r.get("hosted"), json.dumps(r)[:120])
time.sleep(8)

out = os.path.join(S, "live", "framenative.flv")
os.makedirs(os.path.dirname(out), exist_ok=True)
if os.path.exists(out):
    os.remove(out)
sink = subprocess.Popen(creationflags=0x08000000,
                        args=[os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "warning", "-y",
                              "-listen", "1", "-timeout", "60", "-i", "rtmp://127.0.0.1:1935/live/test",
                              "-c", "copy", "-f", "flv", out],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
r = post("/api/live/start", {"url": "rtmp://127.0.0.1:1935/live", "key": "test", "preset": "1080p30",
                             "source": "live", "audio": {"mic": False, "system": False}})
check("it goes live natively, with no audio", r.get("ok") and r.get("path") == "native", json.dumps(r)[:160])

time.sleep(max(6.0, seconds - 8))
st = get("/api/live/status")
srcs = (st.get("native") or {}).get("sources") or []
mon = [x for x in srcs if x.get("kind") == "monitor"] or srcs
check("the compositor is keying a source in", bool(mon) and mon[0].get("frames", 0) > 30 and not mon[0].get("error"),
      json.dumps(mon)[:180])
print("   native fps", (st.get("native") or {}).get("fps"), "dropped", (st.get("native") or {}).get("dropped"))

post("/api/live/stop")
try:
    sink.wait(20)
except subprocess.TimeoutExpired:
    sink.kill()
png = os.path.join(S, "live", "framenative.png")
subprocess.run(creationflags=0x08000000,
               args=[os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "error", "-y",
                     "-ss", "4", "-i", out, "-frames:v", "1", "-update", "1", png])
check("a frame was decoded out of the recording", os.path.exists(png) and os.path.getsize(png) > 10000,
      f"{png} {os.path.getsize(png) if os.path.exists(png) else 0} bytes")

post("/api/components/live/close")
post("/api/canvas/live", {"id": ""})
post(f"/api/scenes/{sid}/delete")

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)} of {len(results)} passed" + (f"; FAILED: {failed}" if failed else ""))
print(f"\nNow LOOK at {png} - the checks above only say the pipe ran.")
print("The judgement is the three points in this file's docstring, against")
print(".rig/p6shots/frame_camera.png.")
