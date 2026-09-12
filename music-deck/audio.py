"""
Native audio for going LIVE: the microphone and what the PC plays, taken
straight from Windows (WASAPI, shared mode, loopback for the speakers),
mixed here and encoded to AAC by Windows' own encoder through Media
Foundation. ctypes and numpy only; nothing is recorded.

The mixer runs on a wall clock: every 1024 samples of stream time it takes
what each source has delivered, pads a source that is behind with silence,
mixes, clips, and hands the frame to the encoder. Stamps come from the
LIVE engine's clock, the same one the video uses.
"""

import ctypes
import math
import struct
import threading
import time
from ctypes import wintypes, c_void_p, POINTER, byref, c_int32, c_uint, c_ushort, c_ulonglong

from capture import GUID, guid, vcall, qi, release, check

ole32 = ctypes.windll.ole32
try:
    mfplat = ctypes.windll.mfplat
except OSError:            # Windows N without the Media Feature Pack
    mfplat = None
NO_MF = "Media Foundation is missing - on Windows N, install the Media Feature Pack"

CLSID_MMDeviceEnumerator = guid("BCDE0395-E52F-467C-8E3D-C4579291692E")
IID_IMMDeviceEnumerator = guid("A95664D2-9614-4F35-A746-DE8DB63617E6")
IID_IAudioClient = guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")
IID_IAudioCaptureClient = guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317")
CLSID_AACMFTEncoder = guid("93AF0C51-2275-45D2-A35B-F2BA21CAED00")
IID_IMFTransform = guid("bf94c121-5b05-4e6f-8000-ba598961414d")
MFMediaType_Audio = guid("73647561-0000-0010-8000-00aa00389b71")
MFAudioFormat_PCM = guid("00000001-0000-0010-8000-00aa00389b71")
MFAudioFormat_AAC = guid("00001610-0000-0010-8000-00aa00389b71")
MF_MT_MAJOR_TYPE = guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f")
MF_MT_SUBTYPE = guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5")
MF_MT_AUDIO_BITS_PER_SAMPLE = guid("f2deb57f-40fa-4764-aa33-ed4f2d1ff669")
MF_MT_AUDIO_SAMPLES_PER_SECOND = guid("5faeeae7-0290-4c31-9e8a-c534f68d9dba")
MF_MT_AUDIO_NUM_CHANNELS = guid("37e48bf5-645e-4c5b-89de-ada9e29b696a")
MF_MT_AUDIO_AVG_BYTES_PER_SECOND = guid("1aab75c8-cfef-451c-ab95-ac034b8e1731")
MF_MT_AUDIO_BLOCK_ALIGNMENT = guid("322de230-9eeb-43bd-ab7a-ff412251541d")
MF_MT_AAC_PAYLOAD_TYPE = guid("bfbabe79-7434-4d1c-94f0-72a3b9e17188")
MF_MT_USER_DATA = guid("b6bc765f-4c3b-40a4-bd51-2535b66fe09d")
PKEY_Device_FriendlyName = (guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14)

eRender, eCapture = 0, 1
DEVICE_STATE_ACTIVE = 1
CLSCTX_ALL = 23
AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000
AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000
AUDCLNT_BUFFERFLAGS_SILENT = 0x2
MF_E_TRANSFORM_NEED_MORE_INPUT = -1072861838
RATE, CHANNELS, FRAME = 48000, 2, 1024


class WAVEFORMATEX(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("wFormatTag", c_ushort), ("nChannels", c_ushort), ("nSamplesPerSec", c_uint),
                ("nAvgBytesPerSec", c_uint), ("nBlockAlign", c_ushort), ("wBitsPerSample", c_ushort),
                ("cbSize", c_ushort)]


class PROPVARIANT(ctypes.Structure):
    _fields_ = [("vt", c_ushort), ("r1", c_ushort), ("r2", c_ushort), ("r3", c_ushort),
                ("val", c_void_p), ("val2", c_void_p)]


class PROPERTYKEY(ctypes.Structure):
    _fields_ = [("fmtid", GUID), ("pid", c_uint)]


def _create(clsid, iid):
    out = c_void_p()
    ole32.CoCreateInstance.restype = c_int32
    check(ole32.CoCreateInstance(byref(clsid), None, CLSCTX_ALL, byref(iid), byref(out)), "CoCreateInstance")
    return out


def _device_name(dev):
    store = c_void_p()
    if vcall(dev, 4, c_int32, [c_uint, POINTER(c_void_p)], 0, byref(store)) != 0 or not store:
        return ""
    key = PROPERTYKEY(PKEY_Device_FriendlyName[0], PKEY_Device_FriendlyName[1])
    pv = PROPVARIANT()
    name = ""
    if vcall(store, 5, c_int32, [POINTER(PROPERTYKEY), POINTER(PROPVARIANT)], byref(key), byref(pv)) == 0 and pv.vt == 31:
        name = ctypes.wstring_at(pv.val)
        ole32.PropVariantClear(byref(pv))
    release(store)
    return name


def list_devices():
    """Active microphones and speakers, by friendly name."""
    ole32.CoInitializeEx(None, 0)
    enum = _create(CLSID_MMDeviceEnumerator, IID_IMMDeviceEnumerator)
    out = {"capture": [], "render": []}
    try:
        for flow, key in ((eCapture, "capture"), (eRender, "render")):
            coll = c_void_p()
            if vcall(enum, 3, c_int32, [c_uint, c_uint, POINTER(c_void_p)], flow, DEVICE_STATE_ACTIVE, byref(coll)) != 0:
                continue
            n = c_uint()
            vcall(coll, 3, c_int32, [POINTER(c_uint)], byref(n))
            for i in range(n.value):
                dev = c_void_p()
                if vcall(coll, 4, c_int32, [c_uint, POINTER(c_void_p)], i, byref(dev)) == 0 and dev:
                    out[key].append(_device_name(dev))
                    release(dev)
            release(coll)
    finally:
        release(enum)
    return out


class WasapiCapture:
    """One endpoint in shared mode, converted by Windows to 48 kHz float
    stereo where the driver allows, else read in the device's own format."""

    def __init__(self, loopback=False, device=""):
        ole32.CoInitializeEx(None, 0)
        self.loopback = loopback
        enum = _create(CLSID_MMDeviceEnumerator, IID_IMMDeviceEnumerator)
        dev = c_void_p()
        try:
            if device:
                dev = self._find(enum, eRender if loopback else eCapture, device)
            if not dev:
                check(vcall(enum, 4, c_int32, [c_uint, c_uint, POINTER(c_void_p)],
                            eRender if loopback else eCapture, 0, byref(dev)), "default audio device")
            self.name = _device_name(dev)
            self.client = c_void_p()
            check(vcall(dev, 3, c_int32, [POINTER(GUID), c_uint, c_void_p, POINTER(c_void_p)],
                        byref(IID_IAudioClient), CLSCTX_ALL, None, byref(self.client)), "IAudioClient")
        finally:
            release(dev)
            release(enum)
        flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
        if loopback:
            flags |= AUDCLNT_STREAMFLAGS_LOOPBACK
        fmt = WAVEFORMATEX(3, CHANNELS, RATE, RATE * CHANNELS * 4, CHANNELS * 4, 32, 0)
        hr = vcall(self.client, 3, c_int32, [c_uint, c_uint, c_ulonglong, c_ulonglong, POINTER(WAVEFORMATEX), c_void_p],
                   0, flags, 2_000_000, 0, byref(fmt), None)
        self.rate, self.channels, self.float = RATE, CHANNELS, True
        if hr != 0:
            # No conversion offered: take the mix format and convert here.
            mix = POINTER(WAVEFORMATEX)()
            check(vcall(self.client, 8, c_int32, [POINTER(POINTER(WAVEFORMATEX))], byref(mix)), "GetMixFormat")
            f = mix.contents
            self.rate, self.channels = f.nSamplesPerSec, f.nChannels
            self.float = f.wFormatTag == 3 or (f.wFormatTag == 0xFFFE and f.wBitsPerSample == 32)
            check(vcall(self.client, 3, c_int32, [c_uint, c_uint, c_ulonglong, c_ulonglong, POINTER(WAVEFORMATEX), c_void_p],
                        0, flags & ~(AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY),
                        2_000_000, 0, mix, None), "IAudioClient.Initialize")
            ole32.CoTaskMemFree(mix)
        self.capture = c_void_p()
        check(vcall(self.client, 14, c_int32, [POINTER(GUID), POINTER(c_void_p)],
                    byref(IID_IAudioCaptureClient), byref(self.capture)), "IAudioCaptureClient")
        check(vcall(self.client, 10, c_int32, []), "IAudioClient.Start")
        self.bytes_per_frame = self.channels * (4 if self.float else 2)

    @staticmethod
    def _find(enum, flow, wanted):
        coll = c_void_p()
        if vcall(enum, 3, c_int32, [c_uint, c_uint, POINTER(c_void_p)], flow, DEVICE_STATE_ACTIVE, byref(coll)) != 0:
            return None
        n = c_uint()
        vcall(coll, 3, c_int32, [POINTER(c_uint)], byref(n))
        found = None
        for i in range(n.value):
            dev = c_void_p()
            if vcall(coll, 4, c_int32, [c_uint, POINTER(c_void_p)], i, byref(dev)) == 0 and dev:
                if found is None and wanted.lower() in _device_name(dev).lower():
                    found = dev
                else:
                    release(dev)
        release(coll)
        return found

    def read(self):
        """Every packet waiting, as (frames, channels) float32 at self.rate."""
        import numpy as np
        chunks = []
        while True:
            n = c_uint()
            if vcall(self.capture, 5, c_int32, [POINTER(c_uint)], byref(n)) != 0 or n.value == 0:
                break
            ptr, frames, flags = c_void_p(), c_uint(), c_uint()
            pos1, pos2 = c_ulonglong(), c_ulonglong()
            hr = vcall(self.capture, 3, c_int32, [POINTER(c_void_p), POINTER(c_uint), POINTER(c_uint),
                                                  POINTER(c_ulonglong), POINTER(c_ulonglong)],
                       byref(ptr), byref(frames), byref(flags), byref(pos1), byref(pos2))
            if hr != 0 or not frames.value:
                break
            if flags.value & AUDCLNT_BUFFERFLAGS_SILENT:
                arr = np.zeros((frames.value, self.channels), dtype=np.float32)
            else:
                raw = ctypes.string_at(ptr, frames.value * self.bytes_per_frame)
                if self.float:
                    arr = np.frombuffer(raw, dtype=np.float32).reshape(-1, self.channels).copy()
                else:
                    arr = np.frombuffer(raw, dtype=np.int16).reshape(-1, self.channels).astype(np.float32) / 32768.0
            vcall(self.capture, 4, c_int32, [c_uint], frames.value)
            chunks.append(arr)
        if not chunks:
            return None
        out = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        if out.shape[1] != CHANNELS:
            out = np.repeat(out[:, :1], CHANNELS, axis=1) if out.shape[1] == 1 else out[:, :CHANNELS]
        if self.rate != RATE:
            n = int(round(len(out) * RATE / self.rate))
            x = np.linspace(0, len(out) - 1, n, dtype=np.float32)
            out = np.stack([np.interp(x, np.arange(len(out)), out[:, c]) for c in range(CHANNELS)], axis=1).astype(np.float32)
        return out

    def close(self):
        if self.client:
            vcall(self.client, 11, c_int32, [])
        release(self.capture)
        release(self.client)
        self.capture = self.client = None


class AacEncoder:
    """Windows' AAC-LC encoder, driven synchronously: 16-bit PCM in, raw
    AAC frames out, and the AudioSpecificConfig the stream header needs."""

    def __init__(self, kbps=128):
        if mfplat is None:
            raise OSError(NO_MF)
        ole32.CoInitializeEx(None, 0)
        mfplat.MFStartup.restype = c_int32
        check(mfplat.MFStartup(0x00020070, 0), "MFStartup")
        self.mft = _create(CLSID_AACMFTEncoder, IID_IMFTransform)
        want = {96: 12000, 128: 16000, 160: 20000, 192: 24000}.get(int(kbps), 16000)
        chosen = None
        for j in range(64):
            mt = c_void_p()
            if vcall(self.mft, 14, c_int32, [c_uint, c_uint, POINTER(c_void_p)], 0, j, byref(mt)) != 0 or not mt:
                break
            if (self._u32(mt, MF_MT_AUDIO_SAMPLES_PER_SECOND) == RATE and self._u32(mt, MF_MT_AUDIO_NUM_CHANNELS) == CHANNELS
                    and self._u32(mt, MF_MT_AUDIO_AVG_BYTES_PER_SECOND) == want and chosen is None):
                chosen = mt
            else:
                release(mt)
        if chosen is None:
            raise OSError(f"the AAC encoder offers no {RATE} Hz stereo type at {kbps} kbps")
        check(vcall(self.mft, 16, c_int32, [c_uint, c_void_p, c_uint], 0, chosen, 0), "AAC SetOutputType")
        release(chosen)
        inp = c_void_p()
        mfplat.MFCreateMediaType.restype = c_int32
        mfplat.MFCreateMediaType(byref(inp))
        for key, val in ((MF_MT_MAJOR_TYPE, MFMediaType_Audio), (MF_MT_SUBTYPE, MFAudioFormat_PCM)):
            vcall(inp, 24, c_int32, [POINTER(GUID), POINTER(GUID)], byref(key), byref(val))
        for key, val in ((MF_MT_AUDIO_BITS_PER_SAMPLE, 16), (MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE),
                         (MF_MT_AUDIO_NUM_CHANNELS, CHANNELS), (MF_MT_AUDIO_BLOCK_ALIGNMENT, CHANNELS * 2),
                         (MF_MT_AUDIO_AVG_BYTES_PER_SECOND, RATE * CHANNELS * 2)):
            vcall(inp, 21, c_int32, [POINTER(GUID), c_uint], byref(key), val)
        check(vcall(self.mft, 15, c_int32, [c_uint, c_void_p, c_uint], 0, inp, 0), "AAC SetInputType")
        release(inp)
        # The stream header: the AudioSpecificConfig ends the encoder's user data.
        cur = c_void_p()
        check(vcall(self.mft, 18, c_int32, [c_uint, POINTER(c_void_p)], 0, byref(cur)), "AAC GetOutputCurrentType")
        size = c_uint()
        blob = b""
        if vcall(cur, 14, c_int32, [POINTER(GUID), POINTER(c_uint)], byref(MF_MT_USER_DATA), byref(size)) == 0 and size.value:
            buf = ctypes.create_string_buffer(size.value)
            got = c_uint()
            vcall(cur, 15, c_int32, [POINTER(GUID), c_void_p, c_uint, POINTER(c_uint)], byref(MF_MT_USER_DATA), buf, size.value, byref(got))
            blob = buf.raw[:got.value]
        release(cur)
        self.asc = blob[-2:] if len(blob) >= 2 else struct.pack(">H", (2 << 11) | (3 << 7) | (CHANNELS << 3))
        info = (c_uint * 3)()
        vcall(self.mft, 7, c_int32, [c_uint, c_void_p], 0, info)
        self.out_size = max(int(info[1]), 8192)
        vcall(self.mft, 23, c_int32, [c_uint, c_void_p], 0x10000000, None)    # begin streaming
        vcall(self.mft, 23, c_int32, [c_uint, c_void_p], 0x10000003, None)    # start of stream
        self.frames = 0

    @staticmethod
    def _u32(attrs, key):
        v = c_uint()
        return v.value if vcall(attrs, 7, c_int32, [POINTER(GUID), POINTER(c_uint)], byref(key), byref(v)) == 0 else None

    def _sample(self, data, time_100ns=0, duration_100ns=0, size=None):
        """A sample holding `data`, or an empty one of `size` bytes for output."""
        buf, sample = c_void_p(), c_void_p()
        mfplat.MFCreateMemoryBuffer.restype = c_int32
        check(mfplat.MFCreateMemoryBuffer(max(size or len(data), 1), byref(buf)), "MFCreateMemoryBuffer")
        if data:
            ptr, mx, cur = c_void_p(), c_uint(), c_uint()
            check(vcall(buf, 3, c_int32, [POINTER(c_void_p), POINTER(c_uint), POINTER(c_uint)], byref(ptr), byref(mx), byref(cur)), "Lock")
            ctypes.memmove(ptr, data, len(data))
            vcall(buf, 4, c_int32, [])
            vcall(buf, 6, c_int32, [c_uint], len(data))
        mfplat.MFCreateSample.restype = c_int32
        check(mfplat.MFCreateSample(byref(sample)), "MFCreateSample")
        vcall(sample, 42, c_int32, [c_void_p], buf)
        # The encoder refuses a sample without a time - the first one is at 0.
        vcall(sample, 36, c_int32, [ctypes.c_longlong], int(time_100ns))
        vcall(sample, 38, c_int32, [ctypes.c_longlong], int(duration_100ns))
        release(buf)
        return sample

    def encode(self, pcm16, time_100ns):
        """Feed 16-bit stereo PCM; return the AAC frames ready so far."""
        sample = self._sample(pcm16, time_100ns, int(len(pcm16) / (CHANNELS * 2) * 1e7 / RATE))
        hr = vcall(self.mft, 24, c_int32, [c_uint, c_void_p, c_uint], 0, sample, 0)
        release(sample)
        check(hr, "AAC ProcessInput")
        out = []
        while True:
            own = self._sample(b"", size=self.out_size)
            data = _OUTBUF(0, own.value, 0, None)
            status = c_uint()
            hr = vcall(self.mft, 25, c_int32, [c_uint, c_uint, POINTER(_OUTBUF), POINTER(c_uint)], 0, 1, byref(data), byref(status))
            if data.pEvents:
                release(c_void_p(data.pEvents))
            if hr == MF_E_TRANSFORM_NEED_MORE_INPUT:
                release(own)
                break
            check(hr, "AAC ProcessOutput")
            buf = c_void_p()
            vcall(own, 41, c_int32, [POINTER(c_void_p)], byref(buf))
            ptr, mx, cur = c_void_p(), c_uint(), c_uint()
            vcall(buf, 3, c_int32, [POINTER(c_void_p), POINTER(c_uint), POINTER(c_uint)], byref(ptr), byref(mx), byref(cur))
            out.append(ctypes.string_at(ptr, cur.value))
            vcall(buf, 4, c_int32, [])
            release(buf)
            release(own)
        self.frames += len(out)
        return out

    def close(self):
        if self.mft:
            vcall(self.mft, 23, c_int32, [c_uint, c_void_p], 0x10000002, None)   # end of stream
            release(self.mft)
            self.mft = None


class _OUTBUF(ctypes.Structure):
    _fields_ = [("dwStreamID", c_uint), ("pSample", c_void_p), ("dwStatus", c_uint), ("pEvents", c_void_p)]


class AudioMixer:
    """Mic and/or what the PC plays -> one AAC stream into the LIVE engine."""

    def __init__(self, engine, mic=True, mic_device="", system=False, kbps=128, log=None):
        self.engine = engine
        self.log = log or (lambda *_: None)
        self.want_mic, self.mic_device, self.want_system = mic, mic_device, system
        self.kbps = int(kbps)
        self.gain = {"mic": 1.0, "system": 1.0}
        self.mute = {"mic": False, "system": False}
        self.level = {"mic": 0.0, "system": 0.0}
        self.error = ""
        self.frames = 0
        self.dropped = 0
        self.names = {}
        self._stop = threading.Event()
        self._thread = None

    def status(self):
        return {"running": bool(self._thread and self._thread.is_alive()), "error": self.error,
                "level": dict(self.level), "gain": dict(self.gain), "mute": dict(self.mute),
                "frames": self.frames, "dropped": self.dropped, "devices": dict(self.names), "kbps": self.kbps}

    def set(self, source, gain=None, mute=None):
        if source in self.gain:
            if gain is not None:
                self.gain[source] = max(0.0, min(4.0, float(gain)))
            if mute is not None:
                self.mute[source] = bool(mute)

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self.error = ""
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="audio mixer")
        self._thread.start()

    def stop(self):
        self._stop.set()
        t = self._thread
        if t and t.is_alive():
            t.join(3)
        self._thread = None

    def _run(self):
        from live import K_ACONFIG, K_AUDIO, K_META
        import json
        import numpy as np
        sources, enc = {}, None
        try:
            if self.want_mic:
                sources["mic"] = WasapiCapture(False, self.mic_device)
            if self.want_system:
                sources["system"] = WasapiCapture(True)
            if not sources:
                raise OSError("no audio source chosen")
            self.names = {k: s.name for k, s in sources.items()}
            enc = AacEncoder(self.kbps)
            self.engine.push(K_META, 0, 0, json.dumps({"audiodatarate": self.kbps, "audiosamplerate": RATE,
                                                       "audiosamplesize": 16, "stereo": True, "audiocodecid": 10}).encode())
            self.engine.push(K_ACONFIG, 0, 0, enc.asc)
            self.log("audio: " + ", ".join(f"{k} = {v}" for k, v in self.names.items()))
        except Exception as exc:
            self.error = str(exc)
            self.log(f"audio: {exc}")
            for s in sources.values():
                s.close()
            return
        rings = {k: np.zeros((0, CHANNELS), dtype=np.float32) for k in sources}
        base_ms = self.engine.clock_ms()
        produced = 0
        cap = RATE // 3                                        # a source may run 330 ms ahead, no more
        try:
            while not self._stop.is_set():
                for key, src in sources.items():
                    arr = src.read()
                    if arr is None:
                        continue
                    self.level[key] = float(min(1.0, math.sqrt(float(np.mean(arr * arr))) * 4)) if len(arr) else 0.0
                    if self.mute[key]:
                        arr = np.zeros_like(arr)
                    elif self.gain[key] != 1.0:
                        arr = arr * np.float32(self.gain[key])
                    ring = np.concatenate((rings[key], arr))
                    if len(ring) > cap:
                        self.dropped += len(ring) - cap
                        ring = ring[-cap:]
                    rings[key] = ring
                due = int((self.engine.clock_ms() - base_ms) * RATE / 1000) - produced
                while due >= FRAME:
                    mix = np.zeros((FRAME, CHANNELS), dtype=np.float32)
                    for key in rings:
                        ring = rings[key]
                        take = ring[:FRAME]
                        if len(take):
                            mix[:len(take)] += take
                        rings[key] = ring[FRAME:]
                    pcm = np.clip(mix * 32767.0, -32768, 32767).astype(np.int16).tobytes()
                    frames = enc.encode(pcm, int((produced * 1e7) // RATE))
                    for frame in frames:
                        ts = base_ms + int((self.frames * FRAME * 1000) / RATE)
                        self.engine.push(K_AUDIO, ts, 0, frame)
                        self.frames += 1
                    produced += FRAME
                    due -= FRAME
                time.sleep(0.02)                  # a frame is 21 ms; the rings hold 330
        except Exception as exc:
            self.error = str(exc)
            self.log(f"audio stopped: {exc}")
        finally:
            for s in sources.values():
                s.close()
            if enc:
                enc.close()
