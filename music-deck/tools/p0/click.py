"""Synthetic input for the LIVE Studio test: click <x> <y> | type <text> | key <name> | pos
Restores the cursor afterwards. Coordinates are real screen pixels (DPI aware)."""
import ctypes, sys, time
from ctypes import wintypes

u = ctypes.windll.user32
u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
VK = {"enter": 0x0D, "esc": 0x1B, "delete": 0x2E, "tab": 0x09, "ctrl": 0x11, "a": 0x41, "v": 0x56}


class KEYBD(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class MOUSE(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class INPUT(ctypes.Structure):
    class U(ctypes.Union):
        _fields_ = [("ki", KEYBD), ("mi", MOUSE)]
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", U)]


def send(*inputs):
    arr = (INPUT * len(inputs))(*inputs)
    u.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))


def key(vk, up=False):
    i = INPUT(type=1); i.ki = KEYBD(wVk=vk, dwFlags=2 if up else 0); return i


def uni(ch, up=False):
    i = INPUT(type=1); i.ki = KEYBD(wVk=0, wScan=ord(ch), dwFlags=(4 | 2) if up else 4); return i


def click(x, y):
    old = wintypes.POINT(); u.GetCursorPos(ctypes.byref(old))
    # Absolute move through SendInput (0..65535 across the virtual screen),
    # so the app sees a real mouse move before the button goes down.
    vx, vy = u.GetSystemMetrics(76), u.GetSystemMetrics(77)
    vw, vh = u.GetSystemMetrics(78), u.GetSystemMetrics(79)
    nx = int((int(x) - vx) * 65535 / (vw - 1)); ny = int((int(y) - vy) * 65535 / (vh - 1))
    mv = INPUT(type=0); mv.mi = MOUSE(dx=nx, dy=ny, dwFlags=0x0001 | 0x8000 | 0x4000)
    send(mv); time.sleep(0.12)
    now = wintypes.POINT(); u.GetCursorPos(ctypes.byref(now))
    print(f"cursor at {now.x},{now.y} (asked {x},{y}); window under it:",
          u.WindowFromPoint(now))
    d = INPUT(type=0); d.mi = MOUSE(dx=nx, dy=ny, dwFlags=0x0002 | 0x8000 | 0x4000)
    up = INPUT(type=0); up.mi = MOUSE(dx=nx, dy=ny, dwFlags=0x0004 | 0x8000 | 0x4000)
    send(d); time.sleep(0.08); send(up); time.sleep(0.2)
    u.SetCursorPos(old.x, old.y)


cmd = sys.argv[1]
if cmd == "click":
    click(sys.argv[2], sys.argv[3])
elif cmd == "type":
    for ch in " ".join(sys.argv[2:]):
        send(uni(ch)); send(uni(ch, True)); time.sleep(0.01)
elif cmd == "key":
    for name in sys.argv[2:]:
        vk = VK[name.lower()]
        send(key(vk)); time.sleep(0.05); send(key(vk, True)); time.sleep(0.1)
elif cmd == "combo":       # e.g. combo ctrl a
    vks = [VK[n.lower()] for n in sys.argv[2:]]
    for vk in vks: send(key(vk)); time.sleep(0.03)
    for vk in reversed(vks): send(key(vk, True)); time.sleep(0.03)
elif cmd == "pos":
    p = wintypes.POINT(); u.GetCursorPos(ctypes.byref(p)); print(p.x, p.y)
elif cmd == "post":
    # Click delivered straight to a window's render widget by message, so no
    # other app is touched and the cursor never moves: post <hwnd> <x> <y>
    top, x, y = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    kids = []
    ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h, _):
        b = ctypes.create_unicode_buffer(64); u.GetClassNameW(h, b, 64)
        if b.value == "Chrome_RenderWidgetHostHWND": kids.append(h)
        return True
    u.EnumChildWindows(top, ENUM(cb), 0)
    target = kids[0] if kids else top
    lp = (y << 16) | (x & 0xFFFF)
    u.PostMessageW(target, 0x0200, 0, lp)            # WM_MOUSEMOVE
    time.sleep(0.05)
    u.PostMessageW(target, 0x0201, 1, lp)            # WM_LBUTTONDOWN, MK_LBUTTON
    time.sleep(0.06)
    u.PostMessageW(target, 0x0202, 0, lp)            # WM_LBUTTONUP
    print("posted to", target, "of", len(kids), "widgets")
elif cmd in ("top", "notop"):
    h = int(sys.argv[2])
    u.SetWindowPos(h, -1 if cmd == "top" else -2, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)
    if cmd == "top":
        u.SetForegroundWindow(h)
elif cmd == "rect":
    ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    want = sys.argv[2].lower()
    def cb(h, _):
        if u.IsWindowVisible(h):
            t = ctypes.create_unicode_buffer(256); u.GetWindowTextW(h, t, 256)
            if want in t.value.lower():
                r = wintypes.RECT(); u.GetWindowRect(h, ctypes.byref(r))
                print(h, repr(t.value), r.left, r.top, r.right - r.left, r.bottom - r.top)
        return True
    u.EnumWindows(ENUM(cb), 0)
