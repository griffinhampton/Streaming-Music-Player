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

    def texture(self, width, height, bind=0x8 | 0x20):
        desc = TEX2D_DESC(width, height, 1, 1, DXGI_FORMAT_B8G8R8A8_UNORM, 1, 0, 0, bind, 0, 0)
        tex = c_void_p()
        check(vcall(self.device, 5, c_int32, [POINTER(TEX2D_DESC), c_void_p, POINTER(c_void_p)],
                    byref(desc), None, byref(tex)), "CreateTexture2D")
        return tex

    def copy(self, dst, src):
        vcall(self.context, 47, None, [c_void_p, c_void_p], dst, src)     # CopyResource


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
