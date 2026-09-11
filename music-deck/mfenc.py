"""
Hardware H.264 encoding through Media Foundation - ctypes only.

Feeds Direct3D textures (NV12 from `capture.Nv12Converter`, or the BGRA
capture texture for an encoder that converts itself) to the graphics card's
own encoder and hands back FLV-ready H.264: length-prefixed NAL units plus
the AVCDecoderConfigurationRecord for the stream header. The GPU does the
color conversion and the encoding; this thread only shuffles handles.

Picks the first hardware encoder that accepts the device - on a laptop
where the desktop lives on the integrated GPU that is the integrated
encoder, which is also where the captured textures already are.
"""

import ctypes
import struct
from ctypes import c_void_p, POINTER, byref, c_int32, c_uint, c_uint64, c_ushort

from capture import GUID, guid, vcall, qi, release, check

try:
    mfplat = ctypes.windll.mfplat
except OSError:            # Windows N without the Media Feature Pack
    mfplat = None

# IMFAttributes slots: 7 GetUINT32, 10 GetGUID, 11 GetStringLength, 12 GetString,
# 21 SetUINT32, 22 SetUINT64, 24 SetGUID, 27 SetUnknown. IMFActivate: 33 ActivateObject,
# 34 ShutdownObject. IMFTransform: 7 GetOutputStreamInfo, 8 GetAttributes,
# 13 GetInputAvailableType, 15 SetInputType, 16 SetOutputType, 23 ProcessMessage,
# 24 ProcessInput, 25 ProcessOutput. IMFSample: 36 SetSampleTime, 38 SetSampleDuration,
# 41 ConvertToContiguousBuffer, 42 AddBuffer. IMFMediaBuffer: 3 Lock, 4 Unlock.
MFT_CATEGORY_VIDEO_ENCODER = guid("f79eac7d-e545-4387-bdee-d647d7bde42a")
MFMediaType_Video = guid("73646976-0000-0010-8000-00aa00389b71")
MFVideoFormat_H264 = guid("34363248-0000-0010-8000-00aa00389b71")
IID_IMFTransform = guid("bf94c121-5b05-4e6f-8000-ba598961414d")
IID_IMFMediaEventGenerator = guid("2CD0BD52-BCD5-4B89-B62C-EADC0C031E7D")
IID_ICodecAPI = guid("901db4c7-31ce-41a2-85dc-8fa0bf41b8da")
MFT_FRIENDLY_NAME_Attribute = guid("314ffbae-5b41-4c95-9c19-4e7d586face3")
MF_TRANSFORM_ASYNC = guid("f81a699a-649a-497d-8c73-29f8fed6ad7a")
MF_TRANSFORM_ASYNC_UNLOCK = guid("e5666d6b-3422-4eb6-a421-da7db1f8e207")
MF_LOW_LATENCY = guid("9c27891a-ed7a-40e1-88e8-b22727a024ee")
MF_MT_MAJOR_TYPE = guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f")
MF_MT_SUBTYPE = guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5")
MF_MT_AVG_BITRATE = guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e")
MF_MT_FRAME_SIZE = guid("1652c33d-d6b2-4012-b834-72030849a37d")
MF_MT_FRAME_RATE = guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0")
MF_MT_INTERLACE_MODE = guid("e2724bb1-e1e5-4bcd-b135-ae87f0d6f2b6")
MF_MT_MPEG2_PROFILE = guid("ad76a80b-2d5c-4e0b-b375-64e520137036")
MF_MT_PIXEL_ASPECT_RATIO = guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6")
MF_MT_MAX_KEYFRAME_SPACING = guid("c16eb52b-73a1-476f-8d62-839d6a020652")
MF_MT_ALL_SAMPLES_INDEPENDENT = guid("c9173739-5e56-461c-b713-46fb995cb95f")
MFSampleExtension_CleanPoint = guid("9cdf01d8-a0f0-43ba-b077-eaa06cbd728a")
CODECAPI_AVEncCommonRateControlMode = guid("1c0608e9-370c-4710-8a58-cb6181c42423")
CODECAPI_AVEncCommonMeanBitRate = guid("f7222374-2144-4815-b550-a37f8e12ee52")
CODECAPI_AVEncMPVGOPSize = guid("95f31b26-95a4-41aa-9303-246a7fc6eef1")
CODECAPI_AVEncVideoForceKeyFrame = guid("398c1b98-8353-475a-9ef2-8f265d260345")
# Four-byte-per-pixel formats in the order we like them: both match the
# B8G8R8A8 layout of the capture textures.
# Input formats we can feed, best first: NV12 (converted on the GPU by
# capture.Nv12Converter, what every encoder takes), then RGB32/ARGB32 (the
# encoder converts itself - the AMD one leaks doing so).
INPUT_FORMATS = (("3231564e", "nv12"), ("00000016", "rgb32"), ("00000015", "rgb32"))
MFT_MESSAGE_SET_D3D_MANAGER = 0x00000002
MFT_MESSAGE_NOTIFY_BEGIN_STREAMING = 0x10000000
MFT_MESSAGE_NOTIFY_END_STREAMING = 0x10000001
MFT_MESSAGE_NOTIFY_END_OF_STREAM = 0x10000002
MFT_MESSAGE_NOTIFY_START_OF_STREAM = 0x10000003
MFT_MESSAGE_COMMAND_FLUSH = 0x00000000
METransformNeedInput, METransformHaveOutput = 601, 602
MF_E_NO_EVENTS_AVAILABLE = -1072875904          # 0xC00D3E80
MF_E_TRANSFORM_NEED_MORE_INPUT = -1072861838    # 0xC00D6D72
MF_E_NOTACCEPTING = -1072861515                 # 0xC00D36B5


class MFT_REGISTER_TYPE_INFO(ctypes.Structure):
    _fields_ = [("guidMajorType", GUID), ("guidSubtype", GUID)]


class MFT_OUTPUT_STREAM_INFO(ctypes.Structure):
    _fields_ = [("dwFlags", c_uint), ("cbSize", c_uint), ("cbAlignment", c_uint)]


class MFT_OUTPUT_DATA_BUFFER(ctypes.Structure):
    _fields_ = [("dwStreamID", c_uint), ("pSample", c_void_p), ("dwStatus", c_uint), ("pEvents", c_void_p)]


class VARIANT(ctypes.Structure):
    _fields_ = [("vt", c_ushort), ("r1", c_ushort), ("r2", c_ushort), ("r3", c_ushort),
                ("val", c_uint64), ("pad", c_uint64)]


def _attr_string(attrs, key):
    n = c_uint()
    if vcall(attrs, 11, c_int32, [POINTER(GUID), POINTER(c_uint)], byref(key), byref(n)) != 0:
        return ""
    buf = ctypes.create_unicode_buffer(n.value + 1)
    vcall(attrs, 12, c_int32, [POINTER(GUID), c_void_p, c_uint, POINTER(c_uint)], byref(key), buf, n.value + 1, byref(n))
    return buf.value


def _attr_uint(attrs, key):
    v = c_uint()
    return v.value if vcall(attrs, 7, c_int32, [POINTER(GUID), POINTER(c_uint)], byref(key), byref(v)) == 0 else None


def _set_uint(attrs, key, value):
    return vcall(attrs, 21, c_int32, [POINTER(GUID), c_uint], byref(key), value)


def _set_uint64(attrs, key, value):
    return vcall(attrs, 22, c_int32, [POINTER(GUID), c_uint64], byref(key), value)


def _set_guid(attrs, key, value):
    return vcall(attrs, 24, c_int32, [POINTER(GUID), POINTER(GUID)], byref(key), byref(value))


def _guid_text(g):
    import uuid
    return str(uuid.UUID(bytes_le=bytes(g.a)))


def split_nals(annexb):
    """NAL units of an Annex B byte stream, start codes stripped."""
    out, n, i = [], len(annexb), 0
    start = annexb.find(b"\x00\x00\x01")
    while start >= 0:
        start += 3
        nxt = annexb.find(b"\x00\x00\x01", start)
        end = n if nxt < 0 else nxt
        # A four-byte start code leaves a trailing zero on the previous unit.
        while end > start and nxt >= 0 and annexb[end - 1] == 0:
            end -= 1
        if end > start:
            out.append(annexb[start:end])
        start = nxt
    return out


def avcc_record(sps, pps):
    return (b"\x01" + sps[1:4] + b"\xff\xe1" + struct.pack(">H", len(sps)) + sps
            + b"\x01" + struct.pack(">H", len(pps)) + pps)


class H264Encoder:
    def __init__(self, d3d, width, height, fps, kbps, log=None):
        self.d3d, self.width, self.height, self.fps, self.kbps = d3d, width, height, fps, kbps
        self.log = log or (lambda *_: None)
        self.name = ""
        self.input_format = ""     # "nv12" or "rgb32": what submit() must be given
        self.api = None
        self.codec_settings = {}
        self.mft = self.activate = self.events = self.manager = None
        self.provides_samples = False
        self.need_input = 0
        self.avcc = None
        self.sps = self.pps = None
        self.frames_in = self.frames_out = 0
        if mfplat is None:
            raise OSError("Media Foundation is missing - on Windows N, install the Media Feature Pack")
        mfplat.MFStartup.restype = c_int32
        check(mfplat.MFStartup(0x00020070, 0), "MFStartup")
        self._open()

    # ------------------------------------------------ setup

    def _candidates(self):
        info = MFT_REGISTER_TYPE_INFO(MFMediaType_Video, MFVideoFormat_H264)
        acts, n = c_void_p(), c_uint()
        mfplat.MFTEnumEx.restype = c_int32
        mfplat.MFTEnumEx.argtypes = [GUID, c_uint, c_void_p, c_void_p, POINTER(c_void_p), POINTER(c_uint)]
        # hardware, async or sync, sorted by merit
        check(mfplat.MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, 0x1 | 0x2 | 0x4 | 0x40, None, byref(info),
                               byref(acts), byref(n)), "MFTEnumEx")
        arr = ctypes.cast(acts, POINTER(c_void_p))
        return [(arr[i], _attr_string(arr[i], MFT_FRIENDLY_NAME_Attribute)) for i in range(n.value)]

    def _open(self):
        errors = []
        for act, name in self._candidates():
            try:
                self._try(act, name)
                self.activate, self.name = act, name
                self.log(f"encoder: {name} ({self.input_format} in)")
                return
            except OSError as exc:
                errors.append(f"{name}: {exc}")
                if self.mft:
                    release(self.mft)
                    self.mft = None
        raise OSError("no hardware H.264 encoder would start (" + "; ".join(errors) + ")")

    def _try(self, act, name):
        mft = c_void_p()
        check(vcall(act, 33, c_int32, [POINTER(GUID), POINTER(c_void_p)], byref(IID_IMFTransform), byref(mft)),
              "activate")
        self.mft = mft
        attrs = c_void_p()
        if vcall(mft, 8, c_int32, [POINTER(c_void_p)], byref(attrs)) == 0 and attrs:
            if _attr_uint(attrs, MF_TRANSFORM_ASYNC):
                check(_set_uint(attrs, MF_TRANSFORM_ASYNC_UNLOCK, 1), "async unlock")
            _set_uint(attrs, MF_LOW_LATENCY, 1)
            release(attrs)
        # The device the textures live on.
        if not self.manager:
            token, mgr = c_uint(), c_void_p()
            mfplat.MFCreateDXGIDeviceManager.restype = c_int32
            check(mfplat.MFCreateDXGIDeviceManager(byref(token), byref(mgr)), "device manager")
            check(vcall(mgr, 7, c_int32, [c_void_p, c_uint], self.d3d.device, token.value), "ResetDevice")
            self.manager = mgr
        check(vcall(mft, 23, c_int32, [c_uint, c_void_p], MFT_MESSAGE_SET_D3D_MANAGER, self.manager),
              "set D3D manager")
        # Output first (encoders decide their inputs from it), then an RGB input.
        out = self._output_type()
        check(vcall(mft, 16, c_int32, [c_uint, c_void_p, c_uint], 0, out, 0), "SetOutputType")
        offered = {}
        for j in range(32):
            mt = c_void_p()
            if vcall(mft, 13, c_int32, [c_uint, c_uint, POINTER(c_void_p)], 0, j, byref(mt)) != 0 or not mt:
                break
            sub = GUID()
            vcall(mt, 10, c_int32, [POINTER(GUID), POINTER(GUID)], byref(MF_MT_SUBTYPE), byref(sub))
            key = _guid_text(sub)[:8]
            if key in dict(INPUT_FORMATS) and key not in offered:
                offered[key] = mt
            else:
                release(mt)
        chosen = None
        for key, name in INPUT_FORMATS:
            if key in offered and chosen is None:
                chosen, self.input_format = offered.pop(key), name
        for mt in offered.values():
            release(mt)
        if chosen is None:
            raise OSError("takes neither NV12 nor RGB input")
        _set_uint64(chosen, MF_MT_FRAME_SIZE, (self.width << 32) | self.height)
        _set_uint64(chosen, MF_MT_FRAME_RATE, (self.fps << 32) | 1)
        _set_uint64(chosen, MF_MT_PIXEL_ASPECT_RATIO, (1 << 32) | 1)
        _set_uint(chosen, MF_MT_INTERLACE_MODE, 2)
        check(vcall(mft, 15, c_int32, [c_uint, c_void_p, c_uint], 0, chosen, 0), "SetInputType")
        release(chosen)
        self._codec_api(mft)
        info = MFT_OUTPUT_STREAM_INFO()
        vcall(mft, 7, c_int32, [c_uint, POINTER(MFT_OUTPUT_STREAM_INFO)], 0, byref(info))
        self.provides_samples = bool(info.dwFlags & 0x300)     # provides or can provide samples
        self.out_size = max(info.cbSize, 4 << 20)
        # Async encoders announce their appetite through events; the AMD one
        # calls itself async but has no event generator, and simply answers
        # "not accepting" / "need more input" when driven directly.
        try:
            self.events = qi(mft, IID_IMFMediaEventGenerator, "event generator")
        except OSError:
            self.events = None
        check(vcall(mft, 23, c_int32, [c_uint, c_void_p], MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, None), "begin streaming")
        check(vcall(mft, 23, c_int32, [c_uint, c_void_p], MFT_MESSAGE_NOTIFY_START_OF_STREAM, None), "start of stream")

    def _output_type(self):
        mt = c_void_p()
        mfplat.MFCreateMediaType.restype = c_int32
        check(mfplat.MFCreateMediaType(byref(mt)), "MFCreateMediaType")
        _set_guid(mt, MF_MT_MAJOR_TYPE, MFMediaType_Video)
        _set_guid(mt, MF_MT_SUBTYPE, MFVideoFormat_H264)
        _set_uint(mt, MF_MT_AVG_BITRATE, self.kbps * 1000)
        _set_uint64(mt, MF_MT_FRAME_SIZE, (self.width << 32) | self.height)
        _set_uint64(mt, MF_MT_FRAME_RATE, (self.fps << 32) | 1)
        _set_uint64(mt, MF_MT_PIXEL_ASPECT_RATIO, (1 << 32) | 1)
        _set_uint(mt, MF_MT_INTERLACE_MODE, 2)
        _set_uint(mt, MF_MT_MPEG2_PROFILE, 100)                 # High
        _set_uint(mt, MF_MT_MAX_KEYFRAME_SPACING, self.fps * 2)  # a keyframe every 2 s
        return mt

    def _codec_api(self, mft):
        """Constant bitrate at the asked rate and a keyframe every two
        seconds, when the encoder lets us say so. The AMD encoder ignores
        the keyframe spacing on the media type but honors this."""
        try:
            self.api = qi(mft, IID_ICodecAPI)
        except OSError:
            self.api = None
            return
        self.codec_settings = {}
        for name, key, value in (("rate_control", CODECAPI_AVEncCommonRateControlMode, 0),
                                 ("bitrate", CODECAPI_AVEncCommonMeanBitRate, self.kbps * 1000),
                                 ("gop", CODECAPI_AVEncMPVGOPSize, self.fps * 2)):
            var = VARIANT(vt=19, val=value)
            hr = vcall(self.api, 9, c_int32, [POINTER(GUID), POINTER(VARIANT)], byref(key), byref(var))
            self.codec_settings[name] = hr == 0

    def force_keyframe(self):
        """The next frame in is a keyframe - after a reconnect, a viewer
        joining the stream must not wait out the GOP."""
        if not self.api:
            return False
        var = VARIANT(vt=19, val=1)
        return vcall(self.api, 9, c_int32, [POINTER(GUID), POINTER(VARIANT)],
                     byref(CODECAPI_AVEncVideoForceKeyFrame), byref(var)) == 0

    # ------------------------------------------------ running

    def ready(self):
        """True when the encoder is asking for a frame."""
        if not self.events:
            return True
        self._pump_events()
        return self.need_input > 0

    def submit(self, texture, time_100ns, duration_100ns):
        """Hand one texture to the encoder. False if it is not asking yet."""
        if self.events:
            self._pump_events()
            if self.need_input <= 0:
                return False
        buf, sample = c_void_p(), c_void_p()
        mfplat.MFCreateDXGISurfaceBuffer.restype = c_int32
        check(mfplat.MFCreateDXGISurfaceBuffer(byref(IID_ID3D11Texture2D_), texture, 0, False, byref(buf)),
              "surface buffer")
        mfplat.MFCreateSample.restype = c_int32
        check(mfplat.MFCreateSample(byref(sample)), "MFCreateSample")
        check(vcall(sample, 42, c_int32, [c_void_p], buf), "AddBuffer")
        vcall(sample, 36, c_int32, [ctypes.c_longlong], time_100ns)
        vcall(sample, 38, c_int32, [ctypes.c_longlong], duration_100ns)
        hr = vcall(self.mft, 24, c_int32, [c_uint, c_void_p, c_uint], 0, sample, 0)
        release(buf)
        release(sample)
        if hr == MF_E_NOTACCEPTING:
            return False
        check(hr, "ProcessInput")
        self.need_input -= 1
        self.frames_in += 1
        return True

    def _pump_events(self):
        while True:
            ev = c_void_p()
            hr = vcall(self.events, 3, c_int32, [c_uint, POINTER(c_void_p)], 1, byref(ev))   # no wait
            if hr != 0 or not ev:
                return
            kind = c_uint()
            vcall(ev, 33, c_int32, [POINTER(c_uint)], byref(kind))
            release(ev)
            if kind.value == METransformNeedInput:
                self.need_input += 1
            elif kind.value == METransformHaveOutput:
                self._pending_output += 1

    _pending_output = 0

    def collect(self):
        """Encoded frames ready so far: a list of (keyframe, time_ms, payload)
        where payload is length-prefixed NAL units, FLV style."""
        out = []
        if self.events:
            self._pump_events()
            while self._pending_output > 0:
                self._pending_output -= 1
                item = self._read_output()
                if item:
                    out.append(item)
            return out
        while True:
            item = self._read_output()
            if item is None:
                return out
            out.append(item)

    def _read_output(self):
        data = MFT_OUTPUT_DATA_BUFFER()
        own = None
        if not self.provides_samples:
            own, mem = c_void_p(), c_void_p()
            mfplat.MFCreateMemoryBuffer.restype = c_int32
            check(mfplat.MFCreateMemoryBuffer(self.out_size, byref(mem)), "MFCreateMemoryBuffer")
            mfplat.MFCreateSample(byref(own))
            vcall(own, 42, c_int32, [c_void_p], mem)
            release(mem)
            data.pSample = own.value
        status = c_uint()
        hr = vcall(self.mft, 25, c_int32, [c_uint, c_uint, POINTER(MFT_OUTPUT_DATA_BUFFER), POINTER(c_uint)],
                   0, 1, byref(data), byref(status))
        if data.pEvents:
            release(c_void_p(data.pEvents))      # an event list we never asked for
        if hr == MF_E_TRANSFORM_NEED_MORE_INPUT or (hr == 0 and not data.pSample):
            if own:
                release(own)
            return None
        if hr != 0 and own:
            release(own)
        check(hr, "ProcessOutput")
        sample = c_void_p(data.pSample)
        try:
            when = ctypes.c_longlong()
            vcall(sample, 35, c_int32, [POINTER(ctypes.c_longlong)], byref(when))
            key = _attr_uint(sample, MFSampleExtension_CleanPoint) == 1
            buf = c_void_p()
            check(vcall(sample, 41, c_int32, [POINTER(c_void_p)], byref(buf)), "ConvertToContiguousBuffer")
            ptr, maxlen, cur = c_void_p(), c_uint(), c_uint()
            check(vcall(buf, 3, c_int32, [POINTER(c_void_p), POINTER(c_uint), POINTER(c_uint)],
                        byref(ptr), byref(maxlen), byref(cur)), "Lock")
            raw = ctypes.string_at(ptr, cur.value)
            vcall(buf, 4, c_int32, [])
            release(buf)
        finally:
            release(sample)
        self.frames_out += 1
        return self._to_flv(raw, key, when.value // 10000)

    def _to_flv(self, annexb, key, time_ms):
        parts = []
        for nal in split_nals(annexb):
            kind = nal[0] & 0x1F
            if kind == 7:
                self.sps = nal
            elif kind == 8:
                self.pps = nal
            elif kind == 9:
                continue                   # access unit delimiters carry nothing
            else:
                if kind == 5:
                    key = True
                parts.append(struct.pack(">I", len(nal)) + nal)
        if self.sps and self.pps:
            rec = avcc_record(self.sps, self.pps)
            if rec != self.avcc:
                self.avcc = rec
        return (key, time_ms, b"".join(parts)) if parts else None

    def close(self):
        if self.mft:
            try:
                vcall(self.mft, 23, c_int32, [c_uint, c_void_p], MFT_MESSAGE_NOTIFY_END_OF_STREAM, None)
                vcall(self.mft, 23, c_int32, [c_uint, c_void_p], MFT_MESSAGE_NOTIFY_END_STREAMING, None)
            except OSError:
                pass
        for attr in ("api", "events", "mft", "manager"):
            obj = getattr(self, attr)
            if obj:
                release(obj)
                setattr(self, attr, None)
        if self.activate:
            vcall(self.activate, 34, c_int32, [])
            self.activate = None


IID_ID3D11Texture2D_ = guid("6F15AAF2-D208-4E89-9AB4-489535D34F9C")
