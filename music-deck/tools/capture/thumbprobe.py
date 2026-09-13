"""Does /api/capture/thumb answer more than once?

Every call opens its OWN connection and asks for it to be closed: a kept-alive
connection is served by one server thread, and sharing a thread is exactly what
hid the missing per-thread WinRT init (0x800401f0). Fresh connection per call
means a fresh thread per call, which is the case that used to fail.

    python thumbprobe.py [port] [count]
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 12
B = "http://127.0.0.1:%d" % PORT


def ask(path):
    req = urllib.request.Request(B + path, headers={"Connection": "close"})
    return urllib.request.urlopen(req, timeout=25)


src = json.load(ask("/api/capture/sources"))
wins = [w for w in src.get("windows", []) if w.get("title")]
print("%d windows, %d monitors" % (len(wins), len(src.get("monitors", []))))
if not wins:
    print("nothing open to capture - cannot judge")
    sys.exit(2)

pick = wins[0]
cases = [
    ("monitor", "monitor=0&w=320"),
    ("hwnd", "hwnd=%d&w=480" % pick["hwnd"]),
    ("title", "title=%s&w=480" % urllib.parse.quote(pick["title"])),
]
print("window under test: %s" % pick["title"][:60])

ok = bad = 0
t0 = time.monotonic()
for i in range(ROUNDS):
    name, q = cases[i % len(cases)]
    try:
        r = ask("/api/capture/thumb?" + q)
        body = r.read()
        png = body[:4] == b"\x89PNG"
        ok += 1 if png else 0
        bad += 0 if png else 1
        print("%2d %+6.1fs %-8s 200 %7d bytes %s" % (i + 1, time.monotonic() - t0, name, len(body),
                                                     "PNG" if png else "NOT A PNG"))
    except urllib.error.HTTPError as e:
        bad += 1
        print("%2d %+6.1fs %-8s %s %s" % (i + 1, time.monotonic() - t0, name, e.code,
                                          e.read().decode("utf-8", "replace")[:90]))
    except Exception as exc:
        bad += 1
        print("%2d %+6.1fs %-8s ERR %s" % (i + 1, time.monotonic() - t0, name, exc))
    time.sleep(0.4)

print("\n%d of %d gave a picture" % (ok, ok + bad))
sys.exit(0 if bad == 0 else 1)
