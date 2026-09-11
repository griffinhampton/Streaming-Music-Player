"""List top-level windows of a process and grab each with PrintWindow
(PW_RENDERFULLCONTENT) - no focus change, no clicks. Writes half-size PNGs.

usage: python capwin.py <exe-substring> <out-prefix> [scale]
"""
import ctypes, struct, sys, zlib
from ctypes import wintypes

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32
try:
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    pass

user32.GetWindowDC.restype = wintypes.HDC
user32.GetWindowDC.argtypes = [wintypes.HWND]
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]
gdi32.SetStretchBltMode.argtypes = [wintypes.HDC, ctypes.c_int]
gdi32.CreateDIBSection.restype = wintypes.HBITMAP
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.c_void_p, wintypes.UINT,
                                   ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
gdi32.StretchBlt.argtypes = [wintypes.HDC] + [ctypes.c_int] * 4 + [wintypes.HDC] + [ctypes.c_int] * 4 + [wintypes.DWORD]


class BIH(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


def dib(dc, w, h):
    bi = BIH(ctypes.sizeof(BIH), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
    bits = ctypes.c_void_p()
    bmp = gdi32.CreateDIBSection(dc, ctypes.byref(bi), 0, ctypes.byref(bits), None, 0)
    return bmp, bits


def write_png(path, w, h, bgra):
    a = bytearray(bgra)
    a[0::4], a[2::4] = a[2::4], a[0::4]
    a[3::4] = b"\xff" * (w * h)
    stride = w * 4
    raw = b"".join(b"\x00" + bytes(a[y * stride:(y + 1) * stride]) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def exe_of(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    h = kernel32.OpenProcess(0x1000, False, pid.value)
    if not h:
        return pid.value, ""
    buf = ctypes.create_unicode_buffer(520)
    n = wintypes.DWORD(520)
    kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n))
    kernel32.CloseHandle(h)
    return pid.value, buf.value


def main():
    want, prefix = sys.argv[1].lower(), sys.argv[2]
    scale = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
    found = []
    EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, _):
        if not user32.IsWindowVisible(h):
            return True
        t = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(h, t, 256)
        pid, exe = exe_of(h)
        if want in exe.lower() and t.value:
            r = wintypes.RECT()
            user32.GetWindowRect(h, ctypes.byref(r))
            found.append((h, t.value, exe, r.left, r.top, r.right - r.left, r.bottom - r.top,
                          bool(user32.IsIconic(h))))
        return True

    user32.EnumWindows(EnumProc(cb), 0)
    for i, (h, title, exe, x, y, w, hh, mini) in enumerate(found):
        print(f"[{i}] hwnd={h} {w}x{hh} at {x},{y} min={mini} title={title!r} exe={exe.split(chr(92))[-1]}")
        if mini or w < 50 or hh < 50:
            continue
        sdc = user32.GetWindowDC(None)
        mdc = gdi32.CreateCompatibleDC(sdc)
        bmp, bits = dib(sdc, w, hh)
        old = gdi32.SelectObject(mdc, bmp)
        ok = user32.PrintWindow(h, mdc, 2)
        ow, oh = max(1, int(w * scale)), max(1, int(hh * scale))
        ddc = gdi32.CreateCompatibleDC(sdc)
        bmp2, bits2 = dib(sdc, ow, oh)
        old2 = gdi32.SelectObject(ddc, bmp2)
        gdi32.SetStretchBltMode(ddc, 4)
        gdi32.StretchBlt(ddc, 0, 0, ow, oh, mdc, 0, 0, w, hh, 0x00CC0020)
        data = ctypes.string_at(bits2, ow * oh * 4)
        path = f"{prefix}_{i}.png"
        write_png(path, ow, oh, data)
        print(f"    printwindow={ok} -> {path} ({ow}x{oh})")
        gdi32.SelectObject(mdc, old); gdi32.SelectObject(ddc, old2)
        gdi32.DeleteObject(bmp); gdi32.DeleteObject(bmp2)
        gdi32.DeleteDC(mdc); gdi32.DeleteDC(ddc)
        user32.ReleaseDC(None, sdc)


if __name__ == "__main__":
    main()
