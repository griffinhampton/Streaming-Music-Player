"""
Windows Graphics Capture and the Direct3D 11 device behind it - ctypes only.

The same API OBS and Discord use: a window or a monitor is captured straight
into GPU textures, and no pixel touches the CPU. `WindowCapture.poll()` keeps
a copy of the newest frame in a texture of ours, so an encoder on the same
device can take it whenever it likes.
"""

import ctypes
import uuid
from ctypes import wintypes, c_void_p, POINTER, byref, c_int32, c_uint

user32 = ctypes.windll.user32
combase = ctypes.windll.combase
d3d11 = ctypes.windll.d3d11


class GUID(ctypes.Structure):
    _fields_ = [("a", ctypes.c_ubyte * 16)]


def guid(text):
    g = GUID()
    ctypes.memmove(byref(g), uuid.UUID(text).bytes_le, 16)
    return g


def vcall(obj, index, restype, argtypes, *args):
    """Call slot `index` of a COM object's vtable."""
    vtbl = ctypes.cast(obj, POINTER(POINTER(c_void_p))).contents
    return ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)(vtbl[index])(obj, *args)


def check(hr, what):
    if hr != 0:
        raise OSError(f"{what} failed: 0x{hr & 0xFFFFFFFF:08x}")
    return hr


def qi(obj, iid, what="QueryInterface"):
    out = c_void_p()
    check(vcall(obj, 0, c_int32, [POINTER(GUID), POINTER(c_void_p)], byref(iid), byref(out)), what)
    return out


def release(obj):
    if obj:
        vcall(obj, 2, ctypes.c_ulong, [])


def closable_close(obj):
    try:
        closable = qi(obj, IID_IClosable)
    except OSError:
        return
    vcall(closable, 6, c_int32, [])
    release(closable)


def factory(cls, iid):
    hs = c_void_p()
    combase.WindowsCreateString(ctypes.c_wchar_p(cls), len(cls), byref(hs))
    out = c_void_p()
    combase.RoGetActivationFactory.restype = c_int32
    check(combase.RoGetActivationFactory(hs, byref(iid), byref(out)), f"activation factory {cls}")
    combase.WindowsDeleteString(hs)
    return out


IID_IGraphicsCaptureItemInterop = guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")
IID_IGraphicsCaptureItem = guid("79C3F95B-31F7-4EC2-A464-632EF5D30760")
IID_IDirect3D11CaptureFramePoolStatics2 = guid("589B103F-6BBC-5DF5-A991-02E28B3B66D5")
IID_IGraphicsCaptureSession2 = guid("2C39AE40-7D2E-5044-804E-8B6799D4CF9E")
IID_IGraphicsCaptureSession3 = guid("F2CDD966-22AE-5EA1-9596-3A289344C3BE")
IID_IDirect3DDxgiInterfaceAccess = guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")
IID_ID3D11Texture2D = guid("6F15AAF2-D208-4E89-9AB4-489535D34F9C")
IID_IDXGIDevice = guid("54EC77FA-1377-44E6-8C32-88FD5F44C84C")
IID_IClosable = guid("30D5A829-7FA4-4026-83BB-D75BAE4EA99E")
IID_ID3D10Multithread = guid("9B7E4E00-342C-4106-A19F-4F2704F689F0")
DXGI_FORMAT_B8G8R8A8_UNORM = 87


class SizeInt32(ctypes.Structure):
    _fields_ = [("Width", c_int32), ("Height", c_int32)]


class TEX2D_DESC(ctypes.Structure):
    _fields_ = [("Width", c_uint), ("Height", c_uint), ("MipLevels", c_uint), ("ArraySize", c_uint),
                ("Format", c_uint), ("SampleCount", c_uint), ("SampleQuality", c_uint), ("Usage", c_uint),
                ("BindFlags", c_uint), ("CPUAccessFlags", c_uint), ("MiscFlags", c_uint)]


class D3D:
    """One device for capture and encoding, on the adapter Windows draws the
    desktop with - the textures never have to cross to another GPU."""

    def __init__(self):
        combase.RoInitialize(1)          # multithreaded; harmless if already done
        self.device, self.context, level = c_void_p(), c_void_p(), c_uint()
        d3d11.D3D11CreateDevice.restype = c_int32
        # BGRA support for the capture textures, video support for the encoder.
        check(d3d11.D3D11CreateDevice(None, 1, None, 0x20 | 0x800, None, 0, 7,
                                      byref(self.device), byref(level), byref(self.context)),
              "D3D11CreateDevice")
        # The encoder works the device from its own threads.
        mt = qi(self.device, IID_ID3D10Multithread)
        vcall(mt, 5, c_int32, [c_int32], 1)
        release(mt)
        dxgi = qi(self.device, IID_IDXGIDevice)
        self.winrt = c_void_p()
        d3d11.CreateDirect3D11DeviceFromDXGIDevice.restype = c_int32
        check(d3d11.CreateDirect3D11DeviceFromDXGIDevice(dxgi, byref(self.winrt)), "WinRT device")
        release(dxgi)

    def texture(self, width, height, bind=0x8 | 0x20, usage=0, cpu=0, fmt=DXGI_FORMAT_B8G8R8A8_UNORM):
        desc = TEX2D_DESC(width, height, 1, 1, fmt, 1, 0, usage, bind, cpu, 0)
        tex = c_void_p()
        check(vcall(self.device, 5, c_int32, [POINTER(TEX2D_DESC), c_void_p, POINTER(c_void_p)],
                    byref(desc), None, byref(tex)), "CreateTexture2D")
        return tex

    def copy(self, dst, src):
        vcall(self.context, 47, None, [c_void_p, c_void_p], dst, src)     # CopyResource

    def read_pixels(self, tex, width, height):
        """One trip to the CPU: the texture's BGRA rows and their pitch.
        For thumbnails only - the stream never comes this way."""
        stage = self.texture(width, height, bind=0, usage=3, cpu=0x20000)     # staging, CPU read
        try:
            self.copy(stage, tex)
            m = MAPPED()
            check(vcall(self.context, 14, c_int32, [c_void_p, c_uint, c_int32, c_uint, POINTER(MAPPED)],
                        stage, 0, 1, 0, byref(m)), "Map")
            try:
                return ctypes.string_at(m.pData, m.RowPitch * height), m.RowPitch
            finally:
                vcall(self.context, 15, None, [c_void_p, c_uint], stage, 0)
        finally:
            release(stage)


class MAPPED(ctypes.Structure):
    _fields_ = [("pData", c_void_p), ("RowPitch", c_uint), ("DepthPitch", c_uint)]


# ------------------------------------------------------------------ BGRA -> NV12 on the GPU

IID_ID3D11VideoDevice = guid("10EC4D5B-975A-4689-B9E4-D0AAC30FE333")
IID_ID3D11VideoContext = guid("61F21C45-3C0E-4A74-9CEA-67100D9AD5E4")
DXGI_FORMAT_NV12 = 103


class VP_CONTENT_DESC(ctypes.Structure):
    _fields_ = [("InputFrameFormat", c_uint), ("InputFrameRate", c_uint * 2), ("InputWidth", c_uint),
                ("InputHeight", c_uint), ("OutputFrameRate", c_uint * 2), ("OutputWidth", c_uint),
                ("OutputHeight", c_uint), ("Usage", c_uint)]


class VP_INPUT_VIEW_DESC(ctypes.Structure):
    _fields_ = [("FourCC", c_uint), ("ViewDimension", c_uint), ("MipSlice", c_uint), ("ArraySlice", c_uint)]


class VP_OUTPUT_VIEW_DESC(ctypes.Structure):
    _fields_ = [("ViewDimension", c_uint), ("MipSlice", c_uint), ("FirstArraySlice", c_uint), ("ArraySize", c_uint)]


class VP_STREAM(ctypes.Structure):
    _fields_ = [("Enable", c_int32), ("OutputIndex", c_uint), ("InputFrameOrField", c_uint), ("PastFrames", c_uint),
                ("FutureFrames", c_uint), ("ppPastSurfaces", c_void_p), ("pInputSurface", c_void_p),
                ("ppFutureSurfaces", c_void_p), ("ppPastSurfacesRight", c_void_p), ("pInputSurfaceRight", c_void_p),
                ("ppFutureSurfacesRight", c_void_p)]


class Nv12Converter:
    """BGRA textures -> NV12 through the Direct3D 11 video processor, on the
    GPU, no shader of ours. NV12 is what every H.264 encoder takes natively;
    handing the AMD encoder RGB instead makes it convert internally, and
    that path leaks ~1.7 KB per frame (measured: 3 MB/min at 30 fps)."""

    ID3D11VideoDevice_CreateVideoProcessor = 4
    ID3D11VideoDevice_CreateInputView = 8
    ID3D11VideoDevice_CreateOutputView = 9
    ID3D11VideoDevice_CreateEnumerator = 10
    ID3D11VideoContext_SetOutputColorSpace = 15
    ID3D11VideoContext_SetStreamFrameFormat = 27
    ID3D11VideoContext_SetStreamColorSpace = 28
    ID3D11VideoContext_Blt = 53

    def __init__(self, d3d, width, height, fps=30, ring=3):
        self.d3d, self.width, self.height = d3d, width, height
        self.vdev = qi(d3d.device, IID_ID3D11VideoDevice, "ID3D11VideoDevice")
        self.vctx = qi(d3d.context, IID_ID3D11VideoContext, "ID3D11VideoContext")
        self.enum = self.vp = None
        self.outputs = []          # (NV12 texture, output view), used in turn so the
        self._turn = 0             # encoder can still be reading the previous one
        self._input = (None, None)  # (source texture address, its input view)
        try:
            desc = VP_CONTENT_DESC(0, (c_uint * 2)(fps, 1), width, height, (c_uint * 2)(fps, 1), width, height, 0)
            self.enum = c_void_p()
            check(vcall(self.vdev, self.ID3D11VideoDevice_CreateEnumerator, c_int32,
                        [POINTER(VP_CONTENT_DESC), POINTER(c_void_p)], byref(desc), byref(self.enum)),
                  "CreateVideoProcessorEnumerator")
            self.vp = c_void_p()
            check(vcall(self.vdev, self.ID3D11VideoDevice_CreateVideoProcessor, c_int32,
                        [c_void_p, c_uint, POINTER(c_void_p)], self.enum, 0, byref(self.vp)), "CreateVideoProcessor")
            # Full-range RGB in; BT.709 limited-range video out, as HD streams expect.
            # The color space is a bitfield: Usage:1 RGB_Range:1 YCbCr_Matrix:1 xvYCC:1 Nominal_Range:2.
            out_cs = c_uint((1 << 2) | (1 << 4))
            vcall(self.vctx, self.ID3D11VideoContext_SetOutputColorSpace, None, [c_void_p, POINTER(c_uint)],
                  self.vp, byref(out_cs))
            in_cs = c_uint(2 << 4)
            vcall(self.vctx, self.ID3D11VideoContext_SetStreamColorSpace, None, [c_void_p, c_uint, POINTER(c_uint)],
                  self.vp, 0, byref(in_cs))
            vcall(self.vctx, self.ID3D11VideoContext_SetStreamFrameFormat, None, [c_void_p, c_uint, c_uint],
                  self.vp, 0, 0)                                                      # progressive
            for _ in range(ring):
                tex = d3d.texture(width, height, fmt=DXGI_FORMAT_NV12)
                ovd = VP_OUTPUT_VIEW_DESC(1, 0, 0, 0)
                ov = c_void_p()
                check(vcall(self.vdev, self.ID3D11VideoDevice_CreateOutputView, c_int32,
                            [c_void_p, c_void_p, POINTER(VP_OUTPUT_VIEW_DESC), POINTER(c_void_p)],
                            tex, self.enum, byref(ovd), byref(ov)), "CreateVideoProcessorOutputView")
                self.outputs.append((tex, ov))
        except OSError:
            self.close()
            raise

    def convert(self, src):
        """Blit `src` (BGRA, our size) into the next NV12 texture; returns it."""
        if self._input[0] != src.value:
            if self._input[1]:
                release(self._input[1])
            ivd = VP_INPUT_VIEW_DESC(0, 1, 0, 0)
            iv = c_void_p()
            check(vcall(self.vdev, self.ID3D11VideoDevice_CreateInputView, c_int32,
                        [c_void_p, c_void_p, POINTER(VP_INPUT_VIEW_DESC), POINTER(c_void_p)],
                        src, self.enum, byref(ivd), byref(iv)), "CreateVideoProcessorInputView")
            self._input = (src.value, iv)
        tex, ov = self.outputs[self._turn]
        self._turn = (self._turn + 1) % len(self.outputs)
        stream = VP_STREAM(1, 0, 0, 0, 0, None, self._input[1].value, None, None, None, None)
        check(vcall(self.vctx, self.ID3D11VideoContext_Blt, c_int32,
                    [c_void_p, c_void_p, c_uint, c_uint, POINTER(VP_STREAM)],
                    self.vp, ov, 0, 1, byref(stream)), "VideoProcessorBlt")
        return tex

    def close(self):
        if self._input[1]:
            release(self._input[1])
        self._input = (None, None)
        for tex, ov in self.outputs:
            release(ov)
            release(tex)
        self.outputs = []
        for attr in ("vp", "enum", "vctx", "vdev"):
            obj = getattr(self, attr)
            if obj:
                release(obj)
                setattr(self, attr, None)


def find_window(title_part):
    """The largest visible top-level window whose title contains the text."""
    best = []
    ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, _):
        if user32.IsWindowVisible(h):
            t = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(h, t, 256)
            if title_part.lower() in t.value.lower():
                r = wintypes.RECT()
                user32.GetWindowRect(h, byref(r))
                best.append(((r.right - r.left) * (r.bottom - r.top), h))
        return True
    user32.EnumWindows(ENUM(cb), 0)
    return max(best)[1] if best else None


class WindowCapture:
    """Frames of one window (or monitor) as a texture of ours, newest wins."""

    def __init__(self, d3d, hwnd=None, monitor=None, buffers=2):
        self.d3d = d3d
        interop = factory("Windows.Graphics.Capture.GraphicsCaptureItem", IID_IGraphicsCaptureItemInterop)
        self.item = c_void_p()
        if hwnd:
            check(vcall(interop, 3, c_int32, [wintypes.HWND, POINTER(GUID), POINTER(c_void_p)],
                        hwnd, byref(IID_IGraphicsCaptureItem), byref(self.item)), "capture item for window")
        else:
            check(vcall(interop, 4, c_int32, [c_void_p, POINTER(GUID), POINTER(c_void_p)],
                        monitor, byref(IID_IGraphicsCaptureItem), byref(self.item)), "capture item for monitor")
        release(interop)
        size = SizeInt32()
        vcall(self.item, 7, c_int32, [POINTER(SizeInt32)], byref(size))
        self.size = (size.Width, size.Height)
        self.buffers = buffers
        statics = factory("Windows.Graphics.Capture.Direct3D11CaptureFramePool", IID_IDirect3D11CaptureFramePoolStatics2)
        self.pool = c_void_p()
        check(vcall(statics, 6, c_int32, [c_void_p, c_int32, c_int32, SizeInt32, POINTER(c_void_p)],
                    d3d.winrt, DXGI_FORMAT_B8G8R8A8_UNORM, buffers, size, byref(self.pool)), "frame pool")
        release(statics)
        self.session = c_void_p()
        check(vcall(self.pool, 10, c_int32, [c_void_p, POINTER(c_void_p)], self.item, byref(self.session)),
              "capture session")
        for iid in (IID_IGraphicsCaptureSession3, IID_IGraphicsCaptureSession2):
            try:
                s = qi(self.session, iid)
                vcall(s, 7, c_int32, [ctypes.c_bool], False)      # no yellow border / no cursor
                release(s)
            except OSError:
                pass
        self.texture = None
        self.texture_size = (0, 0)
        self.frames = 0
        self.started = False

    def start(self):
        check(vcall(self.session, 6, c_int32, []), "StartCapture")
        self.started = True

    def poll(self):
        """Copy the newest waiting frame into our texture. True if one came."""
        newest = None
        while True:
            f = c_void_p()
            vcall(self.pool, 7, c_int32, [POINTER(c_void_p)], byref(f))    # TryGetNextFrame
            if not f:
                break
            if newest:
                closable_close(newest)
                release(newest)
            newest = f
        if not newest:
            return False
        try:
            cs = SizeInt32()
            vcall(newest, 8, c_int32, [POINTER(SizeInt32)], byref(cs))
            size = (cs.Width, cs.Height)
            if size != self.size:
                # The window changed size: the pool must follow before the
                # next frame is worth anything.
                self.size = size
                vcall(self.pool, 6, c_int32, [c_void_p, c_int32, c_int32, SizeInt32],
                      self.d3d.winrt, DXGI_FORMAT_B8G8R8A8_UNORM, self.buffers, cs)     # Recreate
                return False
            surf = c_void_p()
            vcall(newest, 6, c_int32, [POINTER(c_void_p)], byref(surf))
            acc = qi(surf, IID_IDirect3DDxgiInterfaceAccess)
            src = c_void_p()
            check(vcall(acc, 3, c_int32, [POINTER(GUID), POINTER(c_void_p)],
                        byref(IID_ID3D11Texture2D), byref(src)), "frame texture")
            if self.texture is None or self.texture_size != size:
                if self.texture:
                    release(self.texture)
                self.texture = self.d3d.texture(*size)
                self.texture_size = size
            self.d3d.copy(self.texture, src)
            release(src)
            release(acc)
            release(surf)
            self.frames += 1
            return True
        finally:
            closable_close(newest)
            release(newest)

    def close(self):
        if self.session:
            closable_close(self.session)
            release(self.session)
            self.session = None
        if self.pool:
            closable_close(self.pool)
            release(self.pool)
            self.pool = None
        if self.texture:
            release(self.texture)
            self.texture = None
        release(self.item)
        self.item = None


# ------------------------------------------------------------------ what can be captured

GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x80
DWMWA_CLOAKED = 14
_shared = {"d3d": None}


def _process_name(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, byref(pid))
    kernel32 = ctypes.windll.kernel32
    h = kernel32.OpenProcess(0x1000, False, pid.value)
    if not h:
        return pid.value, ""
    try:
        buf = ctypes.create_unicode_buffer(520)
        n = wintypes.DWORD(520)
        kernel32.QueryFullProcessImageNameW(h, 0, buf, byref(n))
        return pid.value, buf.value.replace("\\", "/").rsplit("/", 1)[-1]
    finally:
        kernel32.CloseHandle(h)


def list_windows():
    """Visible, titled top-level windows: what a picker offers. Our own
    windows are included and marked, so a scene can be a source too."""
    out = []
    dwm = ctypes.windll.dwmapi
    ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, _):
        if not user32.IsWindowVisible(h) or user32.IsIconic(h):
            return True
        t = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(h, t, 256)
        title = t.value.strip()
        if not title:
            return True
        if user32.GetWindowLongW(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
            return True
        cloaked = c_uint(0)
        dwm.DwmGetWindowAttribute(h, DWMWA_CLOAKED, byref(cloaked), 4)
        if cloaked.value:
            return True                  # another virtual desktop, or hidden by the shell
        r = wintypes.RECT()
        user32.GetWindowRect(h, byref(r))
        w, hh = r.right - r.left, r.bottom - r.top
        if w < 50 or hh < 50:
            return True
        pid, exe = _process_name(h)
        out.append({"hwnd": int(h), "title": title, "process": exe, "pid": pid,
                    "x": r.left, "y": r.top, "w": w, "h": hh,
                    "ours": title.startswith("Awesome Streaming Deck")})
        return True

    user32.EnumWindows(ENUM(cb), 0)
    return out


class MONITORINFOEXW(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD), ("szDevice", ctypes.c_wchar * 32)]


def list_monitors():
    out = []
    PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, c_void_p, c_void_p, POINTER(wintypes.RECT), wintypes.LPARAM)

    def cb(hmon, _dc, _r, _l):
        info = MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(MONITORINFOEXW)
        user32.GetMonitorInfoW(hmon, byref(info))
        r = info.rcMonitor
        out.append({"index": len(out), "hmon": int(hmon), "name": info.szDevice.lstrip("\\\\.\\"),
                    "x": r.left, "y": r.top, "w": r.right - r.left, "h": r.bottom - r.top,
                    "primary": bool(info.dwFlags & 1)})
        return True

    user32.EnumDisplayMonitors(None, None, PROC(cb), 0)
    return out


def list_sources():
    return {"windows": list_windows(), "monitors": list_monitors()}


def _png(width, height, rows):
    import struct
    import zlib

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    raw = b"".join(b"\x00" + r for r in rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def thumbnail(hwnd=None, monitor=None, max_w=320, timeout=1.5):
    """One frame of a window or monitor as a small PNG: (bytes, w, h).
    Opens a capture, takes the first frame, closes it - nothing keeps running."""
    import time
    if _shared["d3d"] is None:
        _shared["d3d"] = D3D()
    d3d = _shared["d3d"]
    cap = WindowCapture(d3d, hwnd=hwnd, monitor=monitor, buffers=1)
    try:
        cap.start()
        deadline = time.monotonic() + timeout
        while not cap.poll():
            if time.monotonic() > deadline:
                raise OSError("no frame arrived")
            time.sleep(0.01)
        w, h = cap.texture_size
        data, pitch = d3d.read_pixels(cap.texture, w, h)
    finally:
        cap.close()
    step = max(1, -(-w // max_w))
    rows = []
    for y in range(0, h, step):
        px = memoryview(data)[y * pitch:y * pitch + w * 4].cast("I")[::step]
        row = bytearray(px.tobytes())
        row[0::4], row[2::4] = row[2::4], row[0::4]       # BGRA -> RGBA
        row[3::4] = b"\xff" * (len(row) // 4)
        rows.append(bytes(row))
    ow = len(rows[0]) // 4 if rows else 0
    return _png(ow, len(rows), rows), ow, len(rows)
