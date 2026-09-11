"""Can Python drive a hardware H.264 encoder through Media Foundation?
Enumerates hardware video encoders, unlocks them, sets a 720p30 H.264 output
type, then lists the input formats each accepts. Read-only probe."""
import ctypes, sys, uuid
from ctypes import c_void_p, POINTER, byref, c_int32 as HRESULT, c_uint32, c_uint64

ole32 = ctypes.windll.ole32
mfplat = ctypes.windll.mfplat
APT = int(sys.argv[1]) if len(sys.argv) > 1 else 0        # 0 = MTA, 2 = STA
print("CoInitializeEx:", hex(ole32.CoInitializeEx(None, APT) & 0xFFFFFFFF), "apartment", APT)


class GUID(ctypes.Structure):
    _fields_ = [("a", ctypes.c_ubyte * 16)]

    def __str__(self):
        return str(uuid.UUID(bytes_le=bytes(self.a)))


def guid(s):
    g = GUID(); ctypes.memmove(byref(g), uuid.UUID(s).bytes_le, 16); return g


def vcall(obj, index, restype, argtypes, *args):
    vtbl = ctypes.cast(obj, POINTER(POINTER(c_void_p))).contents
    return ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)(vtbl[index])(obj, *args)


def qi(obj, g):
    out = c_void_p()
    vcall(obj, 0, HRESULT, [POINTER(GUID), POINTER(c_void_p)], byref(g), byref(out))
    return out


# IMFAttributes vtable: 7 GetUINT32, 10 GetGUID, 11 GetStringLength, 12 GetString,
# 21 SetUINT32, 22 SetUINT64, 24 SetGUID. IMFActivate adds 33 ActivateObject,
# 34 ShutdownObject. IMFTransform: 8 GetAttributes, 13 GetInputAvailableType,
# 14 GetOutputAvailableType, 15 SetInputType, 16 SetOutputType, 23 ProcessMessage.
MFT_CATEGORY_VIDEO_ENCODER = guid("f79eac7d-e545-4387-bdee-d647d7bde42a")
MFMediaType_Video = guid("73646976-0000-0010-8000-00aa00389b71")
MFVideoFormat_H264 = guid("34363248-0000-0010-8000-00aa00389b71")
MFVideoFormat_HEVC = guid("43564548-0000-0010-8000-00aa00389b71")
IID_IMFTransform = guid("bf94c121-5b05-4e6f-8000-ba598961414d")
IID_IMFAttributes = guid("2cd2d921-c447-44a7-a13c-4adabfc247e3")
MFT_FRIENDLY_NAME_Attribute = guid("314ffbae-5b41-4c95-9c19-4e7d586face3")
MF_TRANSFORM_ASYNC = guid("f81a699a-649a-497d-8c73-29f8fed6ad7a")
MF_TRANSFORM_ASYNC_UNLOCK = guid("e5666d6b-3422-4eb6-a421-da7db1f8e207")
MF_SA_D3D11_AWARE = guid("206b4fc8-fcf9-4c51-afe3-9764369e33a0")
MF_MT_MAJOR_TYPE = guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f")
MF_MT_SUBTYPE = guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5")
MF_MT_AVG_BITRATE = guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e")
MF_MT_FRAME_SIZE = guid("1652c33d-d6b2-4012-b834-72030849a37d")
MF_MT_FRAME_RATE = guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0")
MF_MT_INTERLACE_MODE = guid("e2724bb1-e1e5-4bcd-b135-ae87f0d6f2b6")
MF_MT_MPEG2_PROFILE = guid("ad76a80b-2d5c-4e0b-b375-64e520137036")
MF_MT_PIXEL_ASPECT_RATIO = guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6")
FOURCC = {"3231564e": "NV12", "32595559": "YUY2", "00000015": "RGB32", "00000016": "RGB24", "00000014": "RGB555",
          "34363248": "H264", "43564548": "HEVC", "30323449": "I420", "56555949": "IYUV", "3132564e": "NV21",
          "31434d49": "IMC1", "30313050": "P010", "41524742": "ARGB32", "32323449": "I422", "34343449": "I444",
          "38323452": "R24", "56595559": "UYVY", "59565955": "YUYV", "3234524d": "?"}


class MFT_REGISTER_TYPE_INFO(ctypes.Structure):
    _fields_ = [("guidMajorType", GUID), ("guidSubtype", GUID)]


def subtype_name(g):
    s = str(g)
    return FOURCC.get(s[:8], s)


def attr_string(attrs, key):
    n = c_uint32()
    if vcall(attrs, 11, HRESULT, [POINTER(GUID), POINTER(c_uint32)], byref(key), byref(n)) != 0:
        return "?"
    buf = ctypes.create_unicode_buffer(n.value + 1)
    vcall(attrs, 12, HRESULT, [POINTER(GUID), c_void_p, c_uint32, POINTER(c_uint32)], byref(key), buf, n.value + 1, byref(n))
    return buf.value


def attr_uint(attrs, key):
    v = c_uint32()
    hr = vcall(attrs, 7, HRESULT, [POINTER(GUID), POINTER(c_uint32)], byref(key), byref(v))
    return v.value if hr == 0 else None


def list_types(mft, index, label):
    types = []
    for j in range(24):
        mt = c_void_p()
        hr = vcall(mft, index, HRESULT, [c_uint32, c_uint32, POINTER(c_void_p)], 0, j, byref(mt))
        if hr != 0 or not mt:
            break
        sub = GUID()
        vcall(mt, 10, HRESULT, [POINTER(GUID), POINTER(GUID)], byref(MF_MT_SUBTYPE), byref(sub))
        types.append(subtype_name(sub))
        vcall(mt, 2, c_uint32, [])
    print(f"      {label}: {types or '(none)'}")
    return types


def h264_type(w, h, fps, kbps):
    mt = c_void_p()
    mfplat.MFCreateMediaType.restype = HRESULT
    mfplat.MFCreateMediaType(byref(mt))
    vcall(mt, 24, HRESULT, [POINTER(GUID), POINTER(GUID)], byref(MF_MT_MAJOR_TYPE), byref(MFMediaType_Video))
    vcall(mt, 24, HRESULT, [POINTER(GUID), POINTER(GUID)], byref(MF_MT_SUBTYPE), byref(MFVideoFormat_H264))
    vcall(mt, 21, HRESULT, [POINTER(GUID), c_uint32], byref(MF_MT_AVG_BITRATE), kbps * 1000)
    vcall(mt, 22, HRESULT, [POINTER(GUID), c_uint64], byref(MF_MT_FRAME_SIZE), (w << 32) | h)
    vcall(mt, 22, HRESULT, [POINTER(GUID), c_uint64], byref(MF_MT_FRAME_RATE), (fps << 32) | 1)
    vcall(mt, 22, HRESULT, [POINTER(GUID), c_uint64], byref(MF_MT_PIXEL_ASPECT_RATIO), (1 << 32) | 1)
    vcall(mt, 21, HRESULT, [POINTER(GUID), c_uint32], byref(MF_MT_INTERLACE_MODE), 2)
    vcall(mt, 21, HRESULT, [POINTER(GUID), c_uint32], byref(MF_MT_MPEG2_PROFILE), 100)
    return mt


mfplat.MFStartup.restype = HRESULT
print("MFStartup:", hex(mfplat.MFStartup(0x00020070, 0) & 0xFFFFFFFF))
mfplat.MFTEnumEx.restype = HRESULT
mfplat.MFTEnumEx.argtypes = [GUID, c_uint32, c_void_p, c_void_p, POINTER(c_void_p), POINTER(c_uint32)]
for codec, name in ((MFVideoFormat_H264, "H264"), (MFVideoFormat_HEVC, "HEVC")):
    out_type = MFT_REGISTER_TYPE_INFO(MFMediaType_Video, codec)
    acts, n = c_void_p(), c_uint32()
    hr = mfplat.MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, 0x1 | 0x2 | 0x4 | 0x8, None, byref(out_type), byref(acts), byref(n))
    print(f"\n== {name} encoders: hr={hex(hr & 0xFFFFFFFF)} count={n.value}")
    arr = ctypes.cast(acts, POINTER(c_void_p))
    for i in range(n.value):
        act = arr[i]
        print(f"  [{i}] {attr_string(act, MFT_FRIENDLY_NAME_Attribute)}")
        mft = c_void_p()
        hr = vcall(act, 33, HRESULT, [POINTER(GUID), POINTER(c_void_p)], byref(IID_IMFTransform), byref(mft))
        if hr != 0 or not mft:
            print("      activate failed", hex(hr & 0xFFFFFFFF)); continue
        ta = c_void_p()
        if vcall(mft, 8, HRESULT, [POINTER(c_void_p)], byref(ta)) == 0 and ta:
            is_async = attr_uint(ta, MF_TRANSFORM_ASYNC)
            print("      async:", is_async, " d3d11 aware:", attr_uint(ta, MF_SA_D3D11_AWARE))
            if is_async:
                print("      async unlock:", hex(vcall(ta, 21, HRESULT, [POINTER(GUID), c_uint32], byref(MF_TRANSFORM_ASYNC_UNLOCK), 1) & 0xFFFFFFFF))
        list_types(mft, 14, "output types")
        list_types(mft, 13, "input types before output set")
        if codec is MFVideoFormat_H264:
            mt = h264_type(1280, 720, 30, 3400)
            hr = vcall(mft, 16, HRESULT, [c_uint32, c_void_p, c_uint32], 0, mt, 0)
            print("      set output H264 720p30:", hex(hr & 0xFFFFFFFF))
            if hr == 0:
                list_types(mft, 13, "input types now")
        vcall(act, 34, HRESULT, [])
