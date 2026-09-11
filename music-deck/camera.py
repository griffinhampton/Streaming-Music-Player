"""
A camera through Media Foundation, straight into the LIVE stream.

The source reader hands over RGB32 frames; they go into a Direct3D texture
the compositor (capture.Compositor) keys into the scene's hole. The page
never opens the camera, so Chrome pays nothing for it - a camera in the
page costs about 22% of a core (measured in P5), most of it Chrome's own
capture service. ctypes only; nothing is recorded.
"""

import ctypes
import threading
from ctypes import c_void_p, c_uint, c_int32, POINTER, byref, c_longlong

from capture import GUID, guid, vcall, release, check
from mfenc import (MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_MT_FRAME_SIZE, MF_MT_FRAME_RATE, MFMediaType_Video,
                   _attr_string, _attr_uint, _set_uint, _set_uint64, _set_guid)

mfplat = ctypes.windll.mfplat
ole32 = ctypes.windll.ole32
try:
    mf = ctypes.windll.mf
    mfreadwrite = ctypes.windll.mfreadwrite
except OSError:            # Windows N without the Media Feature Pack
    mf = mfreadwrite = None

MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE = guid("c60ac5fe-252a-478f-a0ef-bc8fa5f7cad3")
MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID = guid("8ac3587a-4ae7-42d8-99e0-0a6013eef90f")
MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME = guid("60d0e559-52f8-4fa2-bbce-acdb34a8ec01")
MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING = guid("fb394f3d-ccf1-42ee-bbb3-f9b845d5681d")
MF_MT_DEFAULT_STRIDE = guid("644b4e48-1e02-4516-b0eb-c01ca9d49ac6")
IID_IMFMediaSource = guid("279a808d-aec7-40c8-9c6b-a6b492c78a66")
MFVideoFormat_RGB32 = guid("00000016-0000-0010-8000-00aa00389b71")
FIRST_VIDEO_STREAM = 0xFFFFFFFC
MF_SOURCE_READERF_ENDOFSTREAM = 0x2
# IMFSourceReader: 5 GetNativeMediaType, 6 GetCurrentMediaType, 7 SetCurrentMediaType,
# 9 ReadSample, 10 Flush


def _attrs(n):
    a = c_void_p()
    mfplat.MFCreateAttributes.restype = c_int32
    check(mfplat.MFCreateAttributes(byref(a), n), "MFCreateAttributes")
    return a


def _attr_uint64(attrs, key):
    v = ctypes.c_uint64()
    return v.value if vcall(attrs, 8, c_int32, [POINTER(GUID), POINTER(ctypes.c_uint64)], byref(key), byref(v)) == 0 else 0


def _devices():
    """Every video capture device as (activate, friendly name); release them."""
    if mf is None:
        raise OSError("Media Foundation is missing - on Windows N, install the Media Feature Pack")
    mfplat.MFStartup.restype = c_int32
    check(mfplat.MFStartup(0x00020070, 0), "MFStartup")
    a = _attrs(1)
    _set_guid(a, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)
    acts, n = c_void_p(), c_uint()
    mf.MFEnumDeviceSources.restype = c_int32
    mf.MFEnumDeviceSources.argtypes = [c_void_p, POINTER(c_void_p), POINTER(c_uint)]
    try:
        check(mf.MFEnumDeviceSources(a, byref(acts), byref(n)), "MFEnumDeviceSources")
    finally:
        release(a)
    arr = ctypes.cast(acts, POINTER(c_void_p))
    out = [(c_void_p(arr[i]), _attr_string(c_void_p(arr[i]), MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME)) for i in range(n.value)]
    if acts:
        ole32.CoTaskMemFree(acts)
    return out


def list_cameras():
    devs = _devices()
    names = [name for _, name in devs]
    for act, _ in devs:
        release(act)
    return names


class Camera:
    """One camera as a BGRA texture on `d3d`, refreshed by `upload()`.
    `hint` picks the device by a piece of its name (empty: the first)."""

    def __init__(self, d3d, hint="", width=1280, height=720, fps=30, log=None):
        self.d3d = d3d
        self.log = log or (lambda *_: None)
        self.reader = None
        self.texture = None
        self.name = ""
        self.width = self.height = self.stride = 0
        self.fps = 0
        self.error = ""
        self.frames = 0
        self.have = False                 # a frame has been uploaded at least once
        self._latest = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        devs = _devices()
        pick = None
        for act, name in devs:
            if pick is None and (not hint or str(hint).lower() in (name or "").lower()):
                pick = (act, name)
        try:
            if pick is None:
                raise OSError(f"no camera called like {hint!r}" if hint else "no camera")
            self.name = pick[1]
            src = c_void_p()
            check(vcall(pick[0], 33, c_int32, [POINTER(GUID), POINTER(c_void_p)], byref(IID_IMFMediaSource), byref(src)),
                  "camera source")
        finally:
            for act, _ in devs:
                release(act)
        ra = _attrs(2)
        _set_uint(ra, MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)     # the reader converts the pixel format for us
        reader = c_void_p()
        mfreadwrite.MFCreateSourceReaderFromMediaSource.restype = c_int32
        mfreadwrite.MFCreateSourceReaderFromMediaSource.argtypes = [c_void_p, c_void_p, POINTER(c_void_p)]
        hr = mfreadwrite.MFCreateSourceReaderFromMediaSource(src, ra, byref(reader))
        release(ra)
        release(src)
        check(hr, "camera source reader")
        self.reader = reader
        # The native mode nearest what the layer asks for; the reader can
        # change the pixel format but not the size.
        best = None
        for i in range(64):
            mt = c_void_p()
            if vcall(reader, 5, c_int32, [c_uint, c_uint, POINTER(c_void_p)], FIRST_VIDEO_STREAM, i, byref(mt)) != 0 or not mt:
                break
            size = _attr_uint64(mt, MF_MT_FRAME_SIZE)
            rate = _attr_uint64(mt, MF_MT_FRAME_RATE)
            w, h = size >> 32, size & 0xFFFFFFFF
            fr = (rate >> 32) / max(1, rate & 0xFFFFFFFF)
            score = abs(w * h - int(width) * int(height)) + abs(fr - float(fps)) * 20000
            if best is None or score < best[0]:
                if best:
                    release(best[1])
                best = (score, mt, w, h, fr, rate)
            else:
                release(mt)
        if best is None:
            self.close()
            raise OSError(f"{self.name}: no video modes")
        _, mt, w, h, fr, rate = best
        want = c_void_p()
        mfplat.MFCreateMediaType.restype = c_int32
        check(mfplat.MFCreateMediaType(byref(want)), "MFCreateMediaType")
        _set_guid(want, MF_MT_MAJOR_TYPE, MFMediaType_Video)
        _set_guid(want, MF_MT_SUBTYPE, MFVideoFormat_RGB32)
        _set_uint64(want, MF_MT_FRAME_SIZE, (w << 32) | h)
        _set_uint64(want, MF_MT_FRAME_RATE, rate)
        hr = vcall(reader, 7, c_int32, [c_uint, c_void_p, c_void_p], FIRST_VIDEO_STREAM, None, want)
        release(want)
        release(mt)
        if hr != 0:
            self.close()
            raise OSError(f"{self.name}: RGB32 at {w}x{h} refused (0x{hr & 0xFFFFFFFF:08x})")
        cur = c_void_p()
        stride = 0
        if vcall(reader, 6, c_int32, [c_uint, POINTER(c_void_p)], FIRST_VIDEO_STREAM, byref(cur)) == 0 and cur:
            stride = _attr_uint(cur, MF_MT_DEFAULT_STRIDE) or 0
            release(cur)
        self.width, self.height, self.fps = int(w), int(h), round(fr, 2)
        # A negative stride is Media Foundation's way of saying bottom-up;
        # the compositor flips such a picture in the shader for free.
        if stride >= 1 << 31:
            stride -= 1 << 32
        self.flip = stride < 0
        self.stride = abs(int(stride)) or self.width * 4
        self.texture = d3d.texture(self.width, self.height)
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        self.log(f"camera: {self.name} {self.width}x{self.height}@{self.fps}" + (" (bottom-up)" if self.flip else ""))

    def status(self):
        return {"name": self.name, "size": f"{self.width}x{self.height}" if self.texture else "",
                "fps": self.fps, "frames": self.frames, "error": self.error}

    def size(self):
        return (self.width, self.height) if self.have else None

    def _run(self):
        while not self._stop.is_set():
            si, flags, ts, sample = c_uint(), c_uint(), c_longlong(), c_void_p()
            hr = vcall(self.reader, 9, c_int32, [c_uint, c_uint, POINTER(c_uint), POINTER(c_uint), POINTER(c_longlong), POINTER(c_void_p)],
                       FIRST_VIDEO_STREAM, 0, byref(si), byref(flags), byref(ts), byref(sample))
            if hr != 0:
                if not self._stop.is_set():
                    self.error = f"camera read failed (0x{hr & 0xFFFFFFFF:08x})"
                return
            if flags.value & MF_SOURCE_READERF_ENDOFSTREAM:
                self.error = "camera stream ended"
                return
            if not sample:
                continue
            buf = c_void_p()
            if vcall(sample, 41, c_int32, [POINTER(c_void_p)], byref(buf)) == 0 and buf:
                ptr, mx, cur = c_void_p(), c_uint(), c_uint()
                if vcall(buf, 3, c_int32, [POINTER(c_void_p), POINTER(c_uint), POINTER(c_uint)], byref(ptr), byref(mx), byref(cur)) == 0:
                    data = ctypes.string_at(ptr, cur.value)
                    vcall(buf, 4, c_int32, [])
                    with self._lock:
                        self._latest = data
                release(buf)
            release(sample)

    def upload(self):
        """Copy the newest frame into the texture; True once one is there."""
        with self._lock:
            data, self._latest = self._latest, None
        if data is None or not self.texture:
            return self.have
        if len(data) < self.height * self.stride:
            return self.have
        # One copy straight into the texture (UpdateSubresource); the row
        # pitch is the picture's own, so no repacking on the CPU.
        vcall(self.d3d.context, 48, None, [c_void_p, c_uint, c_void_p, c_void_p, c_uint, c_uint],
              self.texture, 0, None, data, self.stride, 0)
        self.frames += 1
        self.have = True
        return True

    def close(self):
        self._stop.set()
        if self.reader:
            vcall(self.reader, 10, c_int32, [c_uint], FIRST_VIDEO_STREAM)     # Flush unblocks a waiting ReadSample
            t = self._thread
            if t and t.is_alive():
                t.join(2)
            release(self.reader)
            self.reader = None
        if self.texture:
            release(self.texture)
            self.texture = None
