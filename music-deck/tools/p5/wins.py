import ctypes, ctypes.wintypes as w
u = ctypes.windll.user32
u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
fg = u.GetForegroundWindow()
out = []
@ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)
def cb(h, l):
    if not u.IsWindowVisible(h): return True
    n = u.GetWindowTextLengthW(h)
    if not n: return True
    b = ctypes.create_unicode_buffer(n + 1); u.GetWindowTextW(h, b, n + 1)
    r = w.RECT(); u.GetWindowRect(h, ctypes.byref(r))
    if r.right - r.left < 150 or b.value in ("Program Manager",): return True
    pid = w.DWORD(); u.GetWindowThreadProcessId(h, ctypes.byref(pid))
    MON = u.MonitorFromWindow(h, 0)
    mon = "MAIN" if MON == u.MonitorFromPoint(w.POINT(0, 0), 1) else ("second" if MON else "off-screen")
    out.append(f"{'*' if h == fg else ' '} {b.value[:44]:44} pid={pid.value:<6} {r.left},{r.top} {r.right-r.left}x{r.bottom-r.top}  {mon}  min={bool(u.IsIconic(h))}")
    return True
u.EnumWindows(cb, 0)
print("\n".join(out))
pt = w.POINT(); u.GetCursorPos(ctypes.byref(pt)); print("cursor:", pt.x, pt.y)
