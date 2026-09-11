"""The P5 stress on the rig: a scene with 60 layers, the four components,
one camera (the IR one) and one window source, LIVE natively to the local
sink for N minutes. Server and the scene's Chrome logged every minute:
memory, threads, CPU, fps, drops.

    python p5stress.py <minutes>
"""
import json, os, subprocess, sys, time, urllib.request

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
FF = r"C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin"
minutes = float(sys.argv[1]) if len(sys.argv) > 1 else 120
LOG = open(os.path.join(S, "live", "p5stress.log"), "w", buffering=1)


def say(*a):
    line = " ".join(str(x) for x in a)
    print(line, flush=True)
    LOG.write(line + "\n")


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


def procs():
    """(cpu seconds, working set MB, threads) of the server, and of the rig's Chrome as a whole."""
    out = ps("$s = (Get-NetTCPConnection -State Listen -LocalPort 8799).OwningProcess | Select-Object -First 1; $p = Get-Process -Id $s; "
             "$c = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*testrig*' } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }; "
             "'{0} {1} {2} {3} {4} {5}' -f $p.TotalProcessorTime.TotalSeconds, [math]::Round($p.WorkingSet64/1MB), $p.Threads.Count, "
             "(($c | Measure-Object -Property TotalProcessorTime -Sum).Sum.TotalSeconds), [math]::Round((($c | Measure-Object -Property WorkingSet64 -Sum).Sum)/1MB), $c.Count").split()
    return (float(out[0]), int(out[1]), int(out[2]), float(out[3] or 0), int(out[4] or 0), int(out[5] or 0)) if len(out) == 6 else (0, 0, 0, 0, 0, 0)


def source_window(on):
    prof = os.path.join(S, "prof-srcwin")
    ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-srcwin*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
    if on:
        subprocess.Popen([CHROME, "--app=http://127.0.0.1:8799/p0-anim.html?title=P0%20Anim%20Source&label=SRC&fps=30",
                          "--window-size=1292,726", "--window-position=40,80", "--no-first-run", "--no-default-browser-check",
                          "--force-device-scale-factor=1", "--disable-component-update", "--disable-background-networking",
                          f"--user-data-dir={prof}"])
        time.sleep(3)


def layer(kind, name, x, y, w, h, props=None, **more):
    out = {"type": kind, "name": name, "transform": {"x": x, "y": y, "w": w, "h": h, "rotation": more.pop("rotation", 0)},
           "props": props or {}, "visible": True}
    out.update(more)
    return out


def close_all():
    snap = get("/api/state")
    for cid, w in snap["windows"].items():
        if w.get("open"):
            post(f"/api/components/{cid}/close")
    time.sleep(2.5)


close_all()
r = post("/api/scenes", {"name": "P5 stress", "format": "horizontal"})
s = r["scene"]
s["background"] = {"mode": "gradient", "color": "#101828", "color2": "#3b1d5e", "angle": 135}
layers = [layer("capture", "Window", 0, 0, 1280, 720, {"mode": "browser", "source": {"kind": "window", "title": "P0 Anim Source"}, "fps": 30}),
          layer("camera", "Camera", 1440, 60, 440, 330, {"device": "IR", "width": 640, "height": 480, "fps": 30, "mirror": True, "mask": "rounded"}),
          layer("component", "Now Playing", 60, 830, 760, 190, {"component": "np"}),
          layer("component", "Lyrics", 860, 760, 500, 300, {"component": "lyrics"}),
          layer("component", "Queue", 1400, 420, 480, 300, {"component": "queue"}),
          layer("component", "Captions", 860, 1000, 1000, 70, {"component": "captions", "options": {"card_bg": False, "frame": False}})]
for i in range(54):
    x, y = 20 + (i % 9) * 140, 740 - (i // 9) * 40
    if i % 3 == 0:
        layers.append(layer("text", f"Text {i}", x, y, 130, 36, {"text": f"{{title}} {i} {{time}}" if i % 6 == 0 else f"layer {i}", "size": 22, "color": "#ffffff"}))
    elif i % 3 == 1:
        layers.append(layer("shape", f"Shape {i}", x, y, 130, 36, {"kind": "rect" if i % 2 else "ellipse", "fill": f"rgba({(i * 37) % 255},{(i * 91) % 255},{(i * 53) % 255},.6)"},
                            style={"radius": 8}))
    else:
        layers.append(layer("text", f"Loop {i}", x, y, 130, 36, {"text": "~", "size": 18, "color": "#ffd1ff",
                            "decor": {"border": "sparkle", "sides": "top", "size": 0.6, "opacity": 0.8, "color": "#ffd1ff", "gap": 0.6, "animate": i % 6 == 2}}))
s["layers"] = layers
r = post(f"/api/scenes/{s['id']}", {"scene": s})
say(f"scene: {r.get('ok')} {len(r['scene']['layers'])} layers")
sid = r["scene"]["id"]
source_window(True)
post("/api/canvas/live", {"id": sid, "transition": "cut"})
r = post("/api/components/live/open")
say("live output:", json.dumps(r)[:120])
time.sleep(10)
out = os.path.join(S, "live", "p5stress.flv")
if os.path.exists(out):
    os.remove(out)
sk = subprocess.Popen([os.path.join(FF, "ffmpeg.exe"), "-hide_banner", "-loglevel", "warning", "-y", "-listen", "1", "-timeout", "120",
                       "-i", "rtmp://127.0.0.1:1935/live/test", "-c", "copy", "-f", "flv", out], stdout=subprocess.DEVNULL,
                      stderr=open(os.path.join(S, "live", "p5stress_sink.err"), "w"))
time.sleep(1)
r = post("/api/live/start", {"url": "rtmp://127.0.0.1:1935/live", "key": "test", "preset": "720p30", "source": "live",
                             "audio": {"mic": True, "system": True}})
say("start:", json.dumps(r))
time.sleep(10)
st = get("/api/live/status")
say("status:", json.dumps({k: st[k] for k in ("state", "error")}), "native:", json.dumps(st["native"]),
    "audio:", json.dumps({k: st["audio"].get(k) for k in ("running", "error", "devices")}))
c0, m0, th0, cc0, cm0, cn0 = procs()
t0 = time.time()
say(f"server {m0} MB {th0} threads; Chrome {cn0} processes {cm0} MB")
say("{:>6} {:>7} {:>4} {:>6} {:>8} {:>7} {:>6} {:>5} {:>5} {:>6} {:>7} {:>5} {:>7}".format(
    "min", "srv MB", "thr", "srv%", "chrome%", "chr MB", "kbps", "vfps", "afps", "delay", "drop", "recon", "state"))
last_c, last_cc, last_t = c0, cc0, t0
while time.time() - t0 < minutes * 60:
    time.sleep(60)
    mins = (time.time() - t0) / 60
    c1, m1, th1, cc1, cm1, cn1 = procs()
    now = time.time()
    st = get("/api/live/status")
    s_ = st["stats"]
    say("{:>6.1f} {:>7} {:>4} {:>6.1f} {:>8.1f} {:>7} {:>6} {:>5} {:>5} {:>6} {:>7} {:>5} {:>7}".format(
        mins, m1, th1, 100 * (c1 - last_c) / (now - last_t), 100 * (cc1 - last_cc) / (now - last_t), cm1, s_["kbps"], s_["vfps"], s_["afps"],
        s_["delay_ms"], s_["dropped"], s_["reconnects"], st["state"]) +
        f"  native {st['native']['fps']} fps drop {st['native']['dropped']} stalled {st['native']['stalled']}  audio frames {st['audio'].get('frames')} drop {st['audio'].get('dropped')}  err {st['native']['error'] or st['audio'].get('error') or st['error'] or '-'}")
    last_c, last_cc, last_t = c1, cc1, now
mem = get("/api/debug/mem")
say("mem before stop:", json.dumps({k: mem.get(k) for k in ("working_set_mb", "private_mb", "gc_objects", "threads")}))
say("stop:", json.dumps(post("/api/live/stop")))
sk.wait(30)
probe = subprocess.run([os.path.join(FF, "ffprobe.exe"), "-v", "error", "-show_entries",
                        "stream=codec_name,width,height,avg_frame_rate:format=duration", "-of", "default=nw=1", out],
                       capture_output=True, text=True).stdout.strip().replace("\n", " ")
keys = subprocess.run([os.path.join(FF, "ffprobe.exe"), "-v", "error", "-select_streams", "v:0", "-show_entries",
                       "frame=key_frame,pts_time", "-of", "csv=p=0", out], capture_output=True, text=True).stdout.splitlines()
kf = [float(l.split(",")[1]) for l in keys if l.startswith("1,")]
gaps = [round(b - a, 2) for a, b in zip(kf, kf[1:])]
say(f"probe: {probe} | video frames {len(keys)} keyframes {len(kf)} gap min/max {min(gaps) if gaps else '-'}/{max(gaps) if gaps else '-'}")
time.sleep(3)
mem = get("/api/debug/mem")
say("mem after stop:", json.dumps({k: mem.get(k) for k in ("working_set_mb", "private_mb", "gc_objects", "threads")}))
post("/api/components/live/close")
post("/api/canvas/live", {"id": ""})
source_window(False)
post(f"/api/scenes/{sid}/delete")
