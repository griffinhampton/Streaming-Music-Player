"""Windows Graphics Capture (the API OBS and Discord use) from Python, ctypes only.

    python wgc.py window <hwnd | title substring> <out.png> [seconds] [half]
    python wgc.py monitor <index> <out.png> [seconds] [half]

Captures for `seconds` (default 1.5), counts delivered frames, reads the last
one back to the CPU once and writes it as PNG. Prints item size, frame content
size, frame count, and this process's CPU while capturing (no readback in the
loop - that is the cost of capture alone).
"""
import ctypes, struct, sys, time, uuid, zlib
from ctypes import wintypes, c_void_p, POINTER, byref, HRESULT, c_int32, c_uint

user32 = ctypes.windll.user32
combase = ctypes.windll.combase
d3d11 = ctypes.windll.d3d11
kernel32 = ctypes.windll.kernel32
user32.SetProcessDpiAwarenessContext(c_void_p(-4))


class GUID(ctypes.Structure):
    _fields_ = [("a", ctypes.c_ubyte * 16)]


def iid(s):
    g = GUID()
    ctypes.memmove(byref(g), uuid.UUID(s).bytes_le, 16)
    return g


IID_IGraphicsCaptureItemInterop = iid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")
IID_IGraphicsCaptureItem = iid("79C3F95B-31F7-4EC2-A464-632EF5D30760")
IID_IDirect3D11CaptureFramePoolStatics2 = iid("589B103F-6BBC-5DF5-A991-02E28B3B66D5")
IID_IGraphicsCaptureSession2 = iid("2C39AE40-7D2E-5044-804E-8B6799D4CF9E")
IID_IGraphicsCaptureSession3 = iid("F2CDD966-22AE-5EA1-9596-3A289344C3BE")
IID_IDirect3DDxgiInterfaceAccess = iid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")
IID_ID3D11Texture2D = iid("6F15AAF2-D208-4E89-9AB4-489535D34F9C")
IID_IDXGIDevice = iid("54EC77FA-1377-44E6-8C32-88FD5F44C84C")
IID_IClosable = iid("30D5A829-7FA4-4026-83BB-D75BAE4EA99E")


class SizeInt32(ctypes.Structure):
    _fields_ = [("Width", c_int32), ("Height", c_int32)]


class TEX2D_DESC(ctypes.Structure):
    _fields_ = [("Width", c_uint), ("Height", c_uint), ("MipLevels", c_uint), ("ArraySize", c_uint),
                ("Format", c_uint), ("SampleCount", c_uint), ("SampleQuality", c_uint), ("Usage", c_uint),
                ("BindFlags", c_uint), ("CPUAccessFlags", c_uint), ("MiscFlags", c_uint)]


class MAPPED(ctypes.Structure):
    _fields_ = [("pData", c_void_p), ("RowPitch", c_uint), ("DepthPitch", c_uint)]


def vcall(obj, index, restype, argtypes, *args):
    vtbl = ctypes.cast(obj, POINTER(POINTER(c_void_p))).contents
    return ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)(vtbl[index])(obj, *args)


def qi(obj, g):
    out = c_void_p()
    vcall(obj, 0, HRESULT, [POINTER(GUID), POINTER(c_void_p)], byref(g), byref(out))
    return out


def release(obj):
    if obj:
        vcall(obj, 2, ctypes.c_ulong, [])


def factory(cls, g):
    hs = c_void_p()
    combase.WindowsCreateString(ctypes.c_wchar_p(cls), len(cls), byref(hs))
    out = c_void_p()
    combase.RoGetActivationFactory.restype = HRESULT
    combase.RoGetActivationFactory(hs, byref(g), byref(out))
    combase.WindowsDeleteString(hs)
    return out


def find_window(arg):
    if arg.isdigit():
        return int(arg)
    best = []
    ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, _):
        if user32.IsWindowVisible(h):
            t = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(h, t, 256)
            if arg.lower() in t.value.lower():
                r = wintypes.RECT(); user32.GetWindowRect(h, byref(r))
                best.append(((r.right - r.left) * (r.bottom - r.top), h, t.value))
        return True
    user32.EnumWindows(ENUM(cb), 0)
    if not best:
        sys.exit(f"no visible window titled like {arg!r}")
    best.sort(reverse=True)
    print(f"window: {best[0][2]!r} hwnd={best[0][1]}")
    return best[0][1]


def monitors():
    out = []
    PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, c_void_p, c_void_p, POINTER(wintypes.RECT), wintypes.LPARAM)
    user32.EnumDisplayMonitors(None, None, PROC(lambda h, dc, r, l: out.append(h) or True), 0)
    return out


def write_png(path, w, h, rows):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    raw = b"".join(b"\x00" + r for r in rows)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def cpu_seconds():
    k, u_, c, e = (wintypes.FILETIME() for _ in range(4))
    kernel32.GetProcessTimes(kernel32.GetCurrentProcess(), byref(c), byref(e), byref(k), byref(u_))
    f = lambda ft: (ft.dwHighDateTime << 32 | ft.dwLowDateTime) / 1e7
    return f(k) + f(u_)


_inited = False


def capture(mode, target, out, seconds=1.5, half=False):
    """Capture `target` (hwnd/title for "window", index for "monitor") for
    `seconds`; write the last frame to `out`. Returns a dict of what happened."""
    global _inited
    if not _inited:
        combase.RoInitialize(1)
        _inited = True
    res = {}

    dev, ctx, fl = c_void_p(), c_void_p(), c_uint()
    d3d11.D3D11CreateDevice.restype = HRESULT
    d3d11.D3D11CreateDevice(None, 1, None, 0x20, None, 0, 7, byref(dev), byref(fl), byref(ctx))
    dxgi = qi(dev, IID_IDXGIDevice)
    wdev = c_void_p()
    d3d11.CreateDirect3D11DeviceFromDXGIDevice.restype = HRESULT
    d3d11.CreateDirect3D11DeviceFromDXGIDevice(dxgi, byref(wdev))

    interop = factory("Windows.Graphics.Capture.GraphicsCaptureItem", IID_IGraphicsCaptureItemInterop)
    item = c_void_p()
    if mode == "window":
        hwnd = find_window(str(target))
        r = wintypes.RECT(); user32.GetWindowRect(hwnd, byref(r))
        print(f"window rect: {r.right - r.left}x{r.bottom - r.top} at {r.left},{r.top}")
        res["rect"] = (r.left, r.top, r.right - r.left, r.bottom - r.top)
        vcall(interop, 3, HRESULT, [wintypes.HWND, POINTER(GUID), POINTER(c_void_p)],
              hwnd, byref(IID_IGraphicsCaptureItem), byref(item))
    else:
        hmon = monitors()[int(target)]
        vcall(interop, 4, HRESULT, [c_void_p, POINTER(GUID), POINTER(c_void_p)],
              hmon, byref(IID_IGraphicsCaptureItem), byref(item))
    size = SizeInt32()
    vcall(item, 7, HRESULT, [POINTER(SizeInt32)], byref(size))
    print(f"capture item size: {size.Width}x{size.Height}")
    res["item"] = (size.Width, size.Height)

    statics = factory("Windows.Graphics.Capture.Direct3D11CaptureFramePool", IID_IDirect3D11CaptureFramePoolStatics2)
    pool = c_void_p()
    vcall(statics, 6, HRESULT, [c_void_p, ctypes.c_int, ctypes.c_int, SizeInt32, POINTER(c_void_p)],
          wdev, 87, 2, size, byref(pool))
    session = c_void_p()
    vcall(pool, 10, HRESULT, [c_void_p, POINTER(c_void_p)], item, byref(session))
    try:
        s3 = qi(session, IID_IGraphicsCaptureSession3)
        vcall(s3, 7, HRESULT, [ctypes.c_bool], False)       # no yellow border
        print("border: off")
    except OSError as e:
        print("border: could not turn off", e)
    try:
        s2 = qi(session, IID_IGraphicsCaptureSession2)
        vcall(s2, 7, HRESULT, [ctypes.c_bool], False)       # no cursor
    except OSError:
        pass

    c0 = cpu_seconds()
    t0 = time.perf_counter()
    vcall(session, 6, HRESULT, [])
    frames, last, first_at = 0, None, None
    while time.perf_counter() - t0 < seconds:
        f = c_void_p()
        vcall(pool, 7, HRESULT, [POINTER(c_void_p)], byref(f))
        if not f:
            time.sleep(0.004)
            continue
        frames += 1
        first_at = first_at or time.perf_counter() - t0
        if last:
            vcall(qi(last, IID_IClosable), 6, HRESULT, [])
            release(last)
        last = f
    el = time.perf_counter() - t0
    cpu = cpu_seconds() - c0
    print(f"frames: {frames} in {el:.2f}s ({frames / el:.1f} fps), first after {first_at or 0:.3f}s; "
          f"capture-loop CPU {100 * cpu / el:.1f}% of one core (includes 4 ms polling)")
    res.update(frames=frames, fps=frames / el, cpu=100 * cpu / el)
    if not last:
        print("no frame arrived")
        vcall(qi(session, IID_IClosable), 6, HRESULT, [])
        vcall(qi(pool, IID_IClosable), 6, HRESULT, [])
        return res

    cs = SizeInt32()
    vcall(last, 8, HRESULT, [POINTER(SizeInt32)], byref(cs))
    surf = c_void_p()
    vcall(last, 6, HRESULT, [POINTER(c_void_p)], byref(surf))
    acc = qi(surf, IID_IDirect3DDxgiInterfaceAccess)
    tex = c_void_p()
    vcall(acc, 3, HRESULT, [POINTER(GUID), POINTER(c_void_p)], byref(IID_ID3D11Texture2D), byref(tex))
    desc = TEX2D_DESC()
    vcall(tex, 10, None, [POINTER(TEX2D_DESC)], byref(desc))
    print(f"frame content size: {cs.Width}x{cs.Height}; texture {desc.Width}x{desc.Height} fmt {desc.Format}")
    desc.Usage, desc.BindFlags, desc.CPUAccessFlags, desc.MiscFlags = 3, 0, 0x20000, 0
    stage = c_void_p()
    vcall(dev, 5, HRESULT, [POINTER(TEX2D_DESC), c_void_p, POINTER(c_void_p)], byref(desc), None, byref(stage))
    vcall(ctx, 47, None, [c_void_p, c_void_p], stage, tex)
    m = MAPPED()
    vcall(ctx, 14, HRESULT, [c_void_p, c_uint, ctypes.c_int, c_uint, POINTER(MAPPED)], stage, 0, 1, 0, byref(m))
    w, h = min(cs.Width, desc.Width), min(cs.Height, desc.Height)
    buf = ctypes.string_at(m.pData, m.RowPitch * h)
    vcall(ctx, 15, None, [c_void_p, c_uint], stage, 0)
    rows = []
    step = 2 if half else 1
    for y in range(0, h, step):
        row = bytearray(buf[y * m.RowPitch: y * m.RowPitch + w * 4])
        if half:
            row = bytearray(memoryview(bytes(row)).cast("I")[::2].tobytes())
        row[0::4], row[2::4] = row[2::4], row[0::4]
        rows.append(bytes(row))
    ow = len(rows[0]) // 4
    write_png(out, ow, len(rows), rows)
    # Alpha check: how much of the frame is not fully opaque?
    alpha = buf[3::4]
    clear = sum(1 for a in alpha[::97] if a < 255)
    print(f"wrote {out} ({ow}x{len(rows)}); non-opaque sample fraction {clear / max(1, len(alpha[::97])):.3f}")
    res.update(content=(cs.Width, cs.Height), out=out, nonopaque=clear / max(1, len(alpha[::97])))
    vcall(qi(session, IID_IClosable), 6, HRESULT, [])
    vcall(qi(pool, IID_IClosable), 6, HRESULT, [])
    return res


def main():
    mode, target, out = sys.argv[1], sys.argv[2], sys.argv[3]
    seconds = float(sys.argv[4]) if len(sys.argv) > 4 else 1.5
    half = len(sys.argv) > 5 and sys.argv[5] == "half"
    capture(mode, target, out, seconds, half)


if __name__ == "__main__":
    main()
