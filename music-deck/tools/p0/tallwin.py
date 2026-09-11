"""P0 experiment: a hosted pop-out taller than the screen, captured with WGC.

    python tallwin.py <w> <h> <x> <y> <label>

Uses the app's own Overlay/HostWindow code from the test rig (its Chrome
profile lives in scratchpad/prof-p0, not the rig's). The page cannot post
metrics to this process, so a helper thread measures Chrome's render widget
and reports that instead - the same numbers the page would send.
"""
import os
import sys
import threading
import time

S = os.path.dirname(os.path.abspath(__file__))
# The app's modules: a test-rig copy next to this file, else the music-deck
# folder two levels up (tools/p0 -> music-deck).
for cand in (os.path.join(S, "testrig"), os.path.abspath(os.path.join(S, "..", ".."))):
    if os.path.isfile(os.path.join(cand, "overlay.py")):
        sys.path.insert(0, cand)
        break
import winwin                      # noqa: E402  (sets DPI awareness on import)
import hostwin                     # noqa: E402
import overlay                     # noqa: E402
from wgc import capture            # noqa: E402

W, H, X, Y = (int(a) for a in sys.argv[1:5])
label = sys.argv[5] if len(sys.argv) > 5 else "TALL"
title = f"P0 {label}"
url = f"http://127.0.0.1:8799/p0-anim.html?title={title.replace(' ', '%20')}&label={label}"
out = os.path.join(S, "apps", f"tall_{label}")
ov = overlay.Overlay(os.path.join(S, "prof-p0"), kind="p0",
                     host_title=f"P0 Host {label}", page_title=title)
stop = False


def feed():
    while not stop:
        h = winwin.find_window(title)
        if h:
            vp = hostwin.viewport_rect(h)
            if vp:
                ov.report_metrics({"inner_w": vp["w"], "inner_h": vp["h"], "dpr": 1})
        time.sleep(0.2)


threading.Thread(target=feed, daemon=True).start()


def show(tag):
    st = ov.status()
    print(f"[{tag}] host rect {st.get('rect')} viewport_rect {st.get('viewport_rect')} "
          f"metrics {st.get('viewport')} hosted={st.get('hosted')}")
    return st


print("screen:", winwin.screen_size(), "asked:", W, "x", H, "at", X, ",", Y)
t0 = time.time()
res = ov.open(url, W, H, X, Y, borderless=True, topmost=False)
print(f"open -> {res} in {time.time() - t0:.1f}s; plain-window insets {ov.insets}")
time.sleep(1.5)
st = show("after open")
r = st.get("rect") or {}
if st.get("hosted") and (r.get("w") != W or r.get("h") != H):
    print(f"host came out {r.get('w')}x{r.get('h')} - the plain window was clamped; "
          f"resizing the hosted window to {W}x{H} now that Chrome is a child")
    ov.apply(width=W, height=H)
    time.sleep(2.0)
    st = show("after apply")

print("\n== capture on screen (partly below the screen edge if H > screen)")
c1 = capture("window", f"P0 Host {label}", out + "_onscreen.png", 1.5, True)

print("\n== move fully off screen (x = -3000)")
ov.move(-3000, 0)
time.sleep(1.0)
show("off screen")
c2 = capture("window", f"P0 Host {label}", out + "_offscreen.png", 1.5, True)

print("\n== move back, half off the right edge")
sw, sh = winwin.screen_size()
ov.move(sw - W // 2, 0)
time.sleep(1.0)
show("half off")
c3 = capture("window", f"P0 Host {label}", out + "_halfoff.png", 1.5, True)

print("\n== summary")
for name, c in (("on screen", c1), ("fully off screen", c2), ("half off right edge", c3)):
    print(f"  {name:20s} item {c.get('item')} content {c.get('content')} frames {c.get('frames')} "
          f"({c.get('fps', 0):.1f} fps)")
stop = True
ov.close()
time.sleep(0.5)
