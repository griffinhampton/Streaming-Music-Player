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
