"""Drive the AMD H.264 MFT step by step and print every HRESULT.
    python mfdbg.py <unlock 0|1> <own output sample 0|1> [encoder name part]"""
import ctypes, sys, time
from ctypes import c_void_p, POINTER, byref, c_int32, c_uint, c_uint64
sys.path.insert(0, r"C:\Users\ghamp\streaming stuff\music-deck")
import capture, mfenc
from capture import GUID, guid, vcall, release
from mfenc import *   # noqa

unlock, own_sample = int(sys.argv[1]), int(sys.argv[2])
want = sys.argv[3] if len(sys.argv) > 3 else "AMD"
hx = lambda hr: hex(hr & 0xFFFFFFFF)
ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
d3d = capture.D3D()
hwnd = capture.find_window("P0 Anim Source")
cap = capture.WindowCapture(d3d, hwnd=hwnd); cap.start()
for _ in range(200):
    if cap.poll(): break
    time.sleep(0.01)
w, h = cap.texture_size
print("texture", w, h)

mfplat = ctypes.windll.mfplat
mfplat.MFStartup.restype = c_int32; mfplat.MFStartup(0x00020070, 0)
info = MFT_REGISTER_TYPE_INFO(MFMediaType_Video, MFVideoFormat_H264)
acts, n = c_void_p(), c_uint()
mfplat.MFTEnumEx.restype = c_int32
mfplat.MFTEnumEx.argtypes = [GUID, c_uint, c_void_p, c_void_p, POINTER(c_void_p), POINTER(c_uint)]
mfplat.MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, 0x1 | 0x2 | 0x4 | 0x40, None, byref(info), byref(acts), byref(n))
arr = ctypes.cast(acts, POINTER(c_void_p))
act = next(arr[i] for i in range(n.value) if want.lower() in mfenc._attr_string(arr[i], MFT_FRIENDLY_NAME_Attribute).lower())
print("encoder:", mfenc._attr_string(act, MFT_FRIENDLY_NAME_Attribute))
mft = c_void_p()
print("activate", hx(vcall(act, 33, c_int32, [POINTER(GUID), POINTER(c_void_p)], byref(IID_IMFTransform), byref(mft))))
attrs = c_void_p(); vcall(mft, 8, c_int32, [POINTER(c_void_p)], byref(attrs))
print("MF_TRANSFORM_ASYNC:", mfenc._attr_uint(attrs, MF_TRANSFORM_ASYNC), "D3D11 aware:", mfenc._attr_uint(attrs, guid("206b4fc8-fcf9-4c51-afe3-9764369e33a0")))
if unlock:
    print("unlock", hx(mfenc._set_uint(attrs, MF_TRANSFORM_ASYNC_UNLOCK, 1)))
ev = c_void_p()
print("QI event generator:", hx(vcall(mft, 0, c_int32, [POINTER(GUID), POINTER(c_void_p)], byref(IID_IMFMediaEventGenerator), byref(ev))))
ids_in, ids_out = c_uint(), c_uint()
print("GetStreamCount", hx(vcall(mft, 4, c_int32, [POINTER(c_uint), POINTER(c_uint)], byref(ids_in), byref(ids_out))), ids_in.value, ids_out.value)
a_in, a_out = (c_uint * 4)(), (c_uint * 4)()
hr = vcall(mft, 5, c_int32, [c_uint, POINTER(c_uint), c_uint, POINTER(c_uint)], 4, a_in, 4, a_out)
print("GetStreamIDs", hx(hr), list(a_in)[:ids_in.value], list(a_out)[:ids_out.value])
token, mgr = c_uint(), c_void_p()
mfplat.MFCreateDXGIDeviceManager.restype = c_int32
mfplat.MFCreateDXGIDeviceManager(byref(token), byref(mgr))
print("ResetDevice", hx(vcall(mgr, 7, c_int32, [c_void_p, c_uint], d3d.device, token.value)))
print("SET_D3D_MANAGER", hx(vcall(mft, 23, c_int32, [c_uint, c_void_p], MFT_MESSAGE_SET_D3D_MANAGER, mgr)))
enc = mfenc.H264Encoder.__new__(mfenc.H264Encoder)
enc.width, enc.height, enc.fps, enc.kbps = w, h, 30, 3400
out = enc._output_type()
print("SetOutputType", hx(vcall(mft, 16, c_int32, [c_uint, c_void_p, c_uint], 0, out, 0)))
chosen = None
for j in range(32):
    mt = c_void_p()
    if vcall(mft, 13, c_int32, [c_uint, c_uint, POINTER(c_void_p)], 0, j, byref(mt)) != 0 or not mt: break
    sub = GUID(); vcall(mt, 10, c_int32, [POINTER(GUID), POINTER(GUID)], byref(MF_MT_SUBTYPE), byref(sub))
    name = mfenc._guid_text(sub)[:8]
    print("  input type", j, name)
    if name in RGB_FORMATS and chosen is None: chosen = mt
mfenc._set_uint64(chosen, MF_MT_FRAME_SIZE, (w << 32) | h)
mfenc._set_uint64(chosen, MF_MT_FRAME_RATE, (30 << 32) | 1)
mfenc._set_uint(chosen, MF_MT_INTERLACE_MODE, 2)
print("SetInputType", hx(vcall(mft, 15, c_int32, [c_uint, c_void_p, c_uint], 0, chosen, 0)))
sinfo = MFT_OUTPUT_STREAM_INFO()
print("GetOutputStreamInfo", hx(vcall(mft, 7, c_int32, [c_uint, POINTER(MFT_OUTPUT_STREAM_INFO)], 0, byref(sinfo))), "flags", hex(sinfo.dwFlags), "cbSize", sinfo.cbSize)
iinfo = (c_uint * 5)()
print("GetInputStreamInfo", hx(vcall(mft, 6, c_int32, [c_uint, c_void_p], 0, iinfo)), "flags", hex(iinfo[2]) if False else list(iinfo))
print("BEGIN_STREAMING", hx(vcall(mft, 23, c_int32, [c_uint, c_void_p], MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, None)))
print("START_OF_STREAM", hx(vcall(mft, 23, c_int32, [c_uint, c_void_p], MFT_MESSAGE_NOTIFY_START_OF_STREAM, None)))
st = c_uint()
print("GetInputStatus", hx(vcall(mft, 19, c_int32, [c_uint, POINTER(c_uint)], 0, byref(st))), st.value)
print("GetOutputStatus", hx(vcall(mft, 20, c_int32, [POINTER(c_uint)], byref(st))), st.value)


def out_once(tag):
    data = MFT_OUTPUT_DATA_BUFFER()
    own = None
    if own_sample:
        own, mem = c_void_p(), c_void_p()
        mfplat.MFCreateMemoryBuffer.restype = c_int32
        mfplat.MFCreateMemoryBuffer(4 << 20, byref(mem)); mfplat.MFCreateSample(byref(own)); vcall(own, 42, c_int32, [c_void_p], mem)
        data.pSample = own.value
    status = c_uint()
    hr = vcall(mft, 25, c_int32, [c_uint, c_uint, POINTER(MFT_OUTPUT_DATA_BUFFER), POINTER(c_uint)], 0, 1, byref(data), byref(status))
    detail = ""
    if hr == 0 and data.pSample:
        s = c_void_p(data.pSample)
        n, cnt, when = c_uint(), c_uint(), ctypes.c_longlong()
        h1 = vcall(s, 44, c_int32, [POINTER(c_uint)], byref(n))
        h2 = vcall(s, 39, c_int32, [POINTER(c_uint)], byref(cnt))
        h3 = vcall(s, 35, c_int32, [POINTER(ctypes.c_longlong)], byref(when))
        buf = c_void_p()
        h4 = vcall(s, 41, c_int32, [POINTER(c_void_p)], byref(buf))
        cur, mx, ptr = c_uint(), c_uint(), c_void_p()
        h5 = vcall(buf, 3, c_int32, [POINTER(c_void_p), POINTER(c_uint), POINTER(c_uint)], byref(ptr), byref(mx), byref(cur)) if buf else -1
        head = ctypes.string_at(ptr, min(8, cur.value)).hex() if h5 == 0 and cur.value else ""
        if h5 == 0: vcall(buf, 4, c_int32, [])
        clean = mfenc._attr_uint(s, MFSampleExtension_CleanPoint)
        detail = (f"total {n.value} ({hx(h1)}) buffers {cnt.value} ({hx(h2)}) time {when.value} ({hx(h3)}) "
                  f"contig {hx(h4)} lock {hx(h5)} cur {cur.value} max {mx.value} head {head} clean {clean}")
        release(s)
    print(f"  ProcessOutput {tag}: {hx(hr)} status {hex(data.dwStatus)} sample {'yes' if data.pSample else 'no'} {detail}")
    return hr


out_once("before any input")
for i in range(6):
    cap.poll()
    buf, sample = c_void_p(), c_void_p()
    mfplat.MFCreateDXGISurfaceBuffer.restype = c_int32
    print("surface buffer", hx(mfplat.MFCreateDXGISurfaceBuffer(byref(IID_ID3D11Texture2D_), cap.texture, 0, False, byref(buf))))
    mfplat.MFCreateSample(byref(sample)); vcall(sample, 42, c_int32, [c_void_p], buf)
    vcall(sample, 36, c_int32, [ctypes.c_longlong], int(i * 1e7 / 30)); vcall(sample, 38, c_int32, [ctypes.c_longlong], int(1e7 / 30))
    print(f"ProcessInput {i}:", hx(vcall(mft, 24, c_int32, [c_uint, c_void_p, c_uint], 0, sample, 0)))
    print("  GetInputStatus", hx(vcall(mft, 19, c_int32, [c_uint, POINTER(c_uint)], 0, byref(st))), st.value, end="; ")
    print("GetOutputStatus", hx(vcall(mft, 20, c_int32, [POINTER(c_uint)], byref(st))), st.value)
    if ev:
        e = c_void_p(); hr = vcall(ev, 3, c_int32, [c_uint, POINTER(c_void_p)], 1, byref(e))
        if hr == 0 and e:
            k = c_uint(); vcall(e, 33, c_int32, [POINTER(c_uint)], byref(k)); print("  event", k.value)
    time.sleep(0.05)
    out_once(f"after input {i}")
time.sleep(0.3)
out_once("after 300 ms")
