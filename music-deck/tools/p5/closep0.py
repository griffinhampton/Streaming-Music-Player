import ctypes, ctypes.wintypes as w, time
u = ctypes.windll.user32
found = []
@ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)
def cb(h, l):
    n = u.GetWindowTextLengthW(h)
    if n:
        b = ctypes.create_unicode_buffer(n + 1); u.GetWindowTextW(h, b, n + 1)
        if b.value.startswith("P0 Tear") or b.value.startswith("P0 Ring Check") or b.value.startswith("P0 Anim Source"):
            found.append((h, b.value))
    return True
u.EnumWindows(cb, 0)
for h, t in found:
    u.PostMessageW(h, 0x0010, 0, 0)
    print("closed:", t)
print(len(found), "test windows closed")
