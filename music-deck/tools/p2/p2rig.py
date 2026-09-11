"""P2 end-to-end checks against the rig on 8799. Read-only for the user's
real app (8713 is never touched)."""
import base64, hashlib, json, os, socket, struct, subprocess, sys, time, urllib.request

BASE = "http://127.0.0.1:8799"
S = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(S, "testrig"))
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=20) as r:
        body = r.read()
        return r.status, (json.loads(body) if r.headers.get("Content-Type", "").startswith("application/json") else body)


def post(path, data=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(data or {}).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def windiag():
    out = subprocess.run([sys.executable, os.path.join(S, "windiag2.py"), "8799"], capture_output=True, text=True).stdout
    print("   " + out.strip().replace("\n", "\n   "))
    return out


# --- registry and snapshot
st, comps = get("/api/components")
ids = [c["id"] for c in comps["components"]]
check("registry lists the four", ids[:4] == ["np", "lyrics", "queue", "captions"], ",".join(ids))
st, snap = get("/api/state")
check("snapshot carries components/scenes/voice/feeds",
      all(k in snap for k in ("components", "scenes", "voice", "feeds")) and "np" in snap["windows"])

# --- the four windows through the registry routes, one through an old alias
for cid in ("np", "lyrics", "captions"):
    st, r = post(f"/api/components/{cid}/open")
    check(f"open {cid} via registry", r.get("ok"), json.dumps(r))
st, r = post("/api/queue/window/open")
check("open queue via old alias", r.get("ok"), json.dumps(r))
post("/api/queue/window/snap", {"corner": "br"})   # the rig config parks it off screen
time.sleep(3)
st, r = get("/api/window/status")
check("old status alias answers", r.get("open") is True)
out = windiag()
check("four windows aligned", "4 window(s)" in out and "all aligned" in out)

# --- a phone scene and its output window
st, r = post("/api/scenes", {"name": "Phone test", "format": "phone"})
scene = r["scene"]
sid = scene["id"]
check("scene created 1080x1920 rev 1", (scene["width"], scene["height"], scene["rev"]) == (1080, 1920, 1))
st, comps = get("/api/components")
check("scene output registered", f"scene:{sid}" in [c["id"] for c in comps["components"]])
st, r = post(f"/api/components/scene:{sid}/open")
check("scene output opens", r.get("ok") and r.get("hosted"), json.dumps(r))
time.sleep(3.5)
st, status = get(f"/api/components/scene:{sid}/status")
rect = status.get("rect") or {}
check("output host is 1080x1920", (rect.get("w"), rect.get("h")) == (1080, 1920), json.dumps(rect))
out = windiag()
check("five windows aligned incl. the tall one", "5 window(s)" in out and "all aligned" in out)
cap = subprocess.run([sys.executable, os.path.join(S, "wgc.py"), "window", "Awesome Streaming Deck - Canvas: Phone test",
                      os.path.join(S, "apps", "p2_scene.png"), "1.0", "half"], capture_output=True, text=True).stdout
check("WGC captures the output whole", "capture item size: 1080x1920" in cap and "frames: " in cap,
      [l for l in cap.splitlines() if l.startswith(("capture item", "frames"))])

# --- park / unpark
st, r = post(f"/api/components/scene:{sid}/park")
check("park moves it off screen", r.get("ok") and (r.get("rect") or {}).get("x", 0) <= -10000, json.dumps(r))
time.sleep(0.8)
cap = subprocess.run([sys.executable, os.path.join(S, "wgc.py"), "window", "Awesome Streaming Deck - Canvas: Phone test",
                      os.path.join(S, "apps", "p2_parked.png"), "1.0", "half"], capture_output=True, text=True).stdout
frames = [l for l in cap.splitlines() if l.startswith("frames")]
check("parked window still captures", frames and int(frames[0].split()[1]) > 0, frames)
st, status = get(f"/api/components/scene:{sid}/status")
check("status says parked", status.get("parked") is True)
st, r = post(f"/api/components/scene:{sid}/unpark")
check("unpark brings it back", r.get("ok") and (r.get("rect") or {}).get("x", -1) >= 0, json.dumps(r))

# --- scene save / conflict / backups / duplicate
scene["name"] = "Phone test 2"
scene["layers"].append({"type": "text", "name": "Title", "transform": {"x": 100, "y": 100, "w": 800, "h": 120},
                        "props": {"text": "hello"}})
st, r = post(f"/api/scenes/{sid}", {"scene": scene, "expect_rev": 1})
check("save with matching revision", r.get("ok") and r["scene"]["rev"] == 2 and len(r["scene"]["layers"]) == 1, json.dumps(r)[:120])
st, r = post(f"/api/scenes/{sid}", {"scene": scene, "expect_rev": 1})
check("stale save is a 409 conflict", st == 409 and r.get("conflict"), f"{st} {json.dumps(r)[:80]}")
st, r = get(f"/api/scenes/{sid}/backups")
check("one backup after two saves", len(r.get("backups", [])) == 1, json.dumps(r))
st, comps = get("/api/components")
label = [c["label"] for c in comps["components"] if c["id"] == f"scene:{sid}"]
check("rename reaches the component label", label == ["Canvas: Phone test 2"], label)
st, r = post(f"/api/scenes/{sid}/duplicate", {"name": "Copy"})
dup = r["scene"]["id"]
check("duplicate", r.get("ok") and dup != sid and r["scene"]["name"] == "Copy")

# --- assets: upload with thumb, refuse delete while used
png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
data_url = "data:image/png;base64," + base64.b64encode(png).decode()
st, r = post("/api/assets/upload", {"name": "p2test.png", "data": data_url, "thumb": data_url})
aid = r.get("id")
check("asset upload with thumb", r.get("ok") and any(a["id"] == aid and a.get("thumb") for a in r["assets"]), json.dumps(r)[:100])
scene = get(f"/api/scenes/{sid}")[1]
scene["layers"].append({"type": "image", "name": "Pic", "props": {"src": f"/asset/{aid}"}})
post(f"/api/scenes/{sid}", {"scene": scene})
st, r = post("/api/assets/delete", {"id": aid})
check("delete refused while a scene uses it", not r.get("ok") and "Phone test 2" in (r.get("reason") or ""), r.get("reason"))
st, r = post("/api/assets/delete", {"id": aid, "force": True})
check("forced delete", r.get("ok"))

# --- capture sources and a thumbnail
st, src = get("/api/capture/sources")
ours = [w for w in src.get("windows", []) if w.get("ours")]
check("sources list windows and monitors", len(src.get("windows", [])) >= 5 and len(src.get("monitors", [])) >= 1,
      f"{len(src.get('windows', []))} windows, {len(src.get('monitors', []))} monitors, {len(ours)} ours")
target = ours[0] if ours else src["windows"][0]
st, body = get(f"/api/capture/thumb?hwnd={target['hwnd']}&w=240")
check("window thumbnail is a PNG", st == 200 and body[:8] == b"\x89PNG\r\n\x1a\n", f"{len(body)} bytes of {target['title']!r}")
st, body = get("/api/capture/thumb?monitor=0&w=320")
check("monitor thumbnail is a PNG", st == 200 and body[:8] == b"\x89PNG\r\n\x1a\n", f"{len(body)} bytes")

# --- voice lease
st, r = post("/api/voice/hold")
token = r.get("token")
time.sleep(0.6)
st, v = get("/api/voice")
check("voice lease starts a monitor (or reports why not)", v.get("source") in ("monitor", "captions"), json.dumps(v))
post("/api/voice/release", {"token": token})
time.sleep(0.6)
st, v = get("/api/voice")
check("voice monitor stops after release", v.get("source") == "off", json.dumps(v))

# --- the WebSocket state feed
sock = socket.create_connection(("127.0.0.1", 8799), timeout=10)
key = base64.b64encode(os.urandom(16)).decode()
sock.sendall((f"GET /ws/events HTTP/1.1\r\nHost: 127.0.0.1:8799\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
              f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nReferer: {BASE}/scene.html?id={sid}\r\n\r\n").encode())
head = b""
while b"\r\n\r\n" not in head:
    head += sock.recv(4096)
accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
check("ws feed handshake", head.startswith(b"HTTP/1.1 101") and accept.encode() in head)
rest = head.split(b"\r\n\r\n", 1)[1]
buf = rest
while len(buf) < 2:
    buf += sock.recv(65536)
ln = buf[1] & 0x7F
hdr = 2 + (2 if ln == 126 else 8 if ln == 127 else 0)
while len(buf) < hdr:
    buf += sock.recv(65536)
need = ln if ln < 126 else struct.unpack(">H", buf[2:4])[0] if ln == 126 else struct.unpack(">Q", buf[2:10])[0]
while len(buf) < hdr + need:
    buf += sock.recv(65536)
payload = json.loads(buf[hdr:hdr + need])
check("ws feed sends the snapshot", "components" in payload and "scenes" in payload, f"{need} bytes")
st, f = get("/api/feeds")
check("feed accounting sees the ws feed from a pop-out page", f["counts"]["windows_ws"] >= 1, json.dumps(f["counts"]))
sock.close()

# --- clean up: close windows, delete scenes
for cid in ("np", "lyrics", "queue", "captions", f"scene:{sid}"):
    post(f"/api/components/{cid}/close")
time.sleep(1.5)
st, r = post(f"/api/scenes/{sid}/delete")
post(f"/api/scenes/{dup}/delete")
st, comps = get("/api/components")
check("deleted scene's component is gone", f"scene:{sid}" not in [c["id"] for c in comps["components"]])
st, snap = get("/api/state")
check("all windows closed", not any(w.get("open") for w in snap["windows"].values()))

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)} of {len(results)} checks passed" + (f"; FAILED: {failed}" if failed else ""))
