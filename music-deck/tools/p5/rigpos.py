"""Put every rig window on the second (non-primary) monitor: the user works
on the main one. Run while the rig server is stopped (it rewrites config)."""
import ctypes, ctypes.wintypes as w, json, os, sys
u = ctypes.windll.user32
u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
class MI(ctypes.Structure):
    _fields_ = [("cb", w.DWORD), ("rc", w.RECT), ("work", w.RECT), ("flags", w.DWORD), ("dev", w.WCHAR * 32)]
mons = []
P = ctypes.WINFUNCTYPE(ctypes.c_bool, w.HMONITOR, w.HDC, ctypes.POINTER(w.RECT), w.LPARAM)
def cb(h, dc, r, l):
    m = MI(); m.cb = ctypes.sizeof(MI); u.GetMonitorInfoW(h, ctypes.byref(m))
    mons.append((bool(m.flags & 1), m.work.left, m.work.top, m.work.right, m.work.bottom, m.dev))
    return True
u.EnumDisplayMonitors(None, None, P(cb), 0)
second = [m for m in mons if not m[0]]
if not second:
    sys.exit("only one monitor - nothing to move")
_, L, T, R, B, dev = second[0]
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testrig", "config.json")
cfg = json.load(open(path, encoding="utf-8"))
moved = 0
def fix(d, key=""):
    global moved
    if isinstance(d, dict):
        if "x" in d and "y" in d and "width" in d and key != "offset":
            x, y = int(d["x"] or 0), int(d["y"] or 0)
            if not (L <= x < R and T <= y < B):
                d["x"], d["y"] = L + 60, T + 40
                moved += 1
        for k, v in d.items():
            fix(v, k)
fix(cfg)
json.dump(cfg, open(path, "w", encoding="utf-8"), indent=2)
print(f"{moved} window positions moved to {dev} at {L + 60},{T + 40}")

# The rig's own copy of overlay.py: whatever position a window is asked to
# open at or move to - a new scene's default 60,60, an unpark fallback - if
# it is on the main monitor it goes to the second one instead. Parking
# (far off every screen) is left alone. The product code is not touched.
HELPER = '''

# ---- test rig only (added by rigpos.py): never open on the main monitor
def _rig_off_main(x, y):
    import ctypes, ctypes.wintypes as w
    u = ctypes.windll.user32
    class MI(ctypes.Structure):
        _fields_ = [("cb", w.DWORD), ("rc", w.RECT), ("work", w.RECT), ("flags", w.DWORD)]
    mons = []
    P = ctypes.WINFUNCTYPE(ctypes.c_bool, w.HMONITOR, w.HDC, ctypes.POINTER(w.RECT), w.LPARAM)
    def cb(h, dc, r, l):
        m = MI(); m.cb = ctypes.sizeof(MI); u.GetMonitorInfoW(h, ctypes.byref(m))
        mons.append((bool(m.flags & 1), m.rc.left, m.rc.top, m.rc.right, m.rc.bottom, m.work.left, m.work.top))
        return True
    u.EnumDisplayMonitors(None, None, P(cb), 0)
    main = [m for m in mons if m[0]]
    second = [m for m in mons if not m[0]]
    if not main or not second or x is None or y is None:
        return x, y
    _, L, T, R, B, _, _ = main[0]
    if L <= int(x) < R and T <= int(y) < B:
        return second[0][5] + 60, second[0][6] + 40
    return x, y
'''
ov = os.path.join(os.path.dirname(path), "overlay.py")
src = open(ov, encoding="utf-8").read()
if "_rig_off_main" not in src:
    for sig in ("    def open(self, url, width, height, x, y, borderless=True, topmost=True):\n",
                "    def move(self, x, y):\n"):
        assert src.count(sig) == 1, sig
        src = src.replace(sig, sig + "        x, y = _rig_off_main(x, y)\n")
    src += HELPER
    open(ov, "w", encoding="utf-8", newline="\n").write(src)
    print("testrig overlay.py: windows kept off the main monitor")

# Rig only: the shared pop-out Chrome listens for DevTools on 9360, so a
# real pop-out window can be probed (compositor frames, animations) - the
# product's flags are untouched.
src = open(ov, encoding="utf-8").read()
if "--remote-debugging-port=9360" not in src:
    marker = '    "--disable-backgrounding-occluded-windows",\n'
    if src.count(marker) == 1:
        src = src.replace(marker, marker + '    "--remote-debugging-port=9360",      # rig only (rigpos.py)\n')
        open(ov, "w", encoding="utf-8", newline="\n").write(src)
        print("testrig overlay.py: pop-out Chrome on DevTools port 9360")
    else:
        print("testrig overlay.py: STREAM_FLAGS marker not found - no DevTools port")
