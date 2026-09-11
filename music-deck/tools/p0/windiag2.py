"""Read-only: for the hosted windows of ONE app process (the rig or the real
app share window titles), is the visible page exactly covering its frame?

    python windiag2.py <port>      (finds the owning process by its port)
"""
import ctypes
import subprocess
import sys
from ctypes import wintypes

u = ctypes.WinDLL("user32")
# Read real pixels: a process that is not DPI-aware gets every other window's
# rect scaled down to 100% (and rounded) on a 150% screen.
u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))    # per-monitor v2
u.GetParent.restype = wintypes.HWND
u.GetWindowLongW.restype = ctypes.c_long
ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
MARGIN = 2

port = sys.argv[1]
out = subprocess.run(["powershell", "-NoProfile", "-Command",
                      f"(Get-NetTCPConnection -State Listen -LocalPort {port}).OwningProcess"],
                     capture_output=True, text=True).stdout.split()
owner = int(out[0]) if out else 0


def rect(h):
    r = wintypes.RECT(); u.GetWindowRect(h, ctypes.byref(r))
    return (r.left, r.top, r.right - r.left, r.bottom - r.top)


def cls(h):
    b = ctypes.create_unicode_buffer(128); u.GetClassNameW(h, b, 128); return b.value


def title(h):
    b = ctypes.create_unicode_buffer(256); u.GetWindowTextW(h, b, 256); return b.value


def pid(h):
    p = wintypes.DWORD(); u.GetWindowThreadProcessId(h, ctypes.byref(p)); return p.value


hosts = []
u.EnumWindows(ENUM(lambda h, _: (hosts.append(h) if title(h).startswith("Awesome Streaming Deck - ")
                                 and "(source)" not in title(h) and pid(h) == owner else None) or True), 0)
ok_all = True
for host in hosts:
    hx, hy, hw, hh = rect(host)
    widgets = []

    def cb(h, _):
        if cls(h) == "Chrome_RenderWidgetHostHWND":
            vis = bool(u.GetWindowLongW(h, -16) & 0x10000000)
            widgets.append((vis, rect(h)))
        return True
    u.EnumChildWindows(host, ENUM(cb), 0)
    vis = [r for v, r in widgets if v]
    page = max(vis, key=lambda r: r[2] * r[3]) if vis else None
    ok = bool(page) and page[0] == hx - MARGIN and page[1] == hy - MARGIN \
        and page[2] == hw + 2 * MARGIN and page[3] == hh + 2 * MARGIN
    ok_all &= ok
    print(f"{title(host)[25:]:12s} frame {hw}x{hh} at {hx},{hy}; visible page "
          f"{page[2]}x{page[3]} at {page[0]},{page[1]}" if page else "no visible page",
          "-> COVERS IT EXACTLY" if ok else "-> MISALIGNED",
          f"(hidden widgets: {[r[2:] for v, r in widgets if not v and r[2] > 20]})")
print(f"{len(hosts)} window(s) for process {owner}:", "all aligned" if ok_all and hosts else "PROBLEM")
