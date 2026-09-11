"""
Going LIVE straight from the app.

The output page does the heavy lifting on the graphics card: it captures
itself and encodes H.264 and AAC with WebCodecs, then hands the encoded
chunks to this module over a WebSocket. Here they become an RTMP stream -
FLV video and audio tags pushed to TikTok's ingest (or any RTMP server) with
the Server URL and Stream key from LIVE Center.

Everything is standard library: an AMF0 codec, an RTMP publisher, the FLV
tag layout, a small RFC 6455 WebSocket, and a DPAPI vault for the key. One
publisher at a time.
"""

import base64
import ctypes
import hashlib
import json
import os
import socket
import ssl
import struct
import threading
import time
import urllib.parse
from collections import deque
from ctypes import wintypes

# ------------------------------------------------------------------ AMF0


class EcmaArray(dict):
    """A dict encoded as an AMF0 ECMA array, which is what onMetaData wants."""


def amf_encode(value):
    if value is None:
        return b"\x05"
    if isinstance(value, bool):
        return b"\x01" + (b"\x01" if value else b"\x00")
    if isinstance(value, (int, float)):
        return b"\x00" + struct.pack(">d", float(value))
    if isinstance(value, str):
        raw = value.encode("utf-8")
        if len(raw) > 0xFFFF:
            return b"\x0c" + struct.pack(">I", len(raw)) + raw
        return b"\x02" + struct.pack(">H", len(raw)) + raw
    if isinstance(value, EcmaArray):
        return b"\x08" + struct.pack(">I", len(value)) + _amf_pairs(value)
    if isinstance(value, dict):
        return b"\x03" + _amf_pairs(value)
    if isinstance(value, (list, tuple)):
        return b"\x0a" + struct.pack(">I", len(value)) + b"".join(amf_encode(v) for v in value)
    raise TypeError(f"cannot encode {type(value).__name__} as AMF0")


def _amf_pairs(mapping):
    out = []
    for key, val in mapping.items():
        raw = str(key).encode("utf-8")
        out.append(struct.pack(">H", len(raw)) + raw + amf_encode(val))
    out.append(b"\x00\x00\x09")
    return b"".join(out)


def amf_decode(data):
    """Every AMF0 value in `data`, in order."""
    values, pos = [], 0
    while pos < len(data):
        value, pos = _amf_read(data, pos)
        values.append(value)
    return values


def _amf_read(d, p):
    kind = d[p]
    p += 1
    if kind == 0x00:
        return struct.unpack(">d", d[p:p + 8])[0], p + 8
    if kind == 0x01:
        return bool(d[p]), p + 1
    if kind == 0x02:
        n = struct.unpack(">H", d[p:p + 2])[0]
        return d[p + 2:p + 2 + n].decode("utf-8", "replace"), p + 2 + n
    if kind == 0x03:
        return _amf_read_pairs(d, p)
    if kind in (0x05, 0x06):
        return None, p
    if kind == 0x08:
        return _amf_read_pairs(d, p + 4)
    if kind == 0x0a:
        n = struct.unpack(">I", d[p:p + 4])[0]
        p += 4
        items = []
        for _ in range(n):
            item, p = _amf_read(d, p)
            items.append(item)
        return items, p
    if kind == 0x0c:
        n = struct.unpack(">I", d[p:p + 4])[0]
        return d[p + 4:p + 4 + n].decode("utf-8", "replace"), p + 4 + n
    raise ValueError(f"AMF0 type 0x{kind:02x} not supported")


def _amf_read_pairs(d, p):
    obj = {}
    while True:
        n = struct.unpack(">H", d[p:p + 2])[0]
        p += 2
        if n == 0 and d[p] == 0x09:
            return obj, p + 1
        key = d[p:p + n].decode("utf-8", "replace")
        p += n
        obj[key], p = _amf_read(d, p)


# ------------------------------------------------------------------ FLV tag bodies

def video_tag(keyframe, packet_type, data, composition_ms=0):
    """AVC video tag body: frame type + codec 7, then AVCPacketType (0 =
    sequence header, 1 = NAL units, 2 = end) and a 3-byte composition offset."""
    return (bytes([0x17 if keyframe else 0x27, packet_type])
            + int(composition_ms).to_bytes(3, "big", signed=True) + data)


def audio_tag(packet_type, data):
    """AAC audio tag body. 0xAF = AAC, 44 kHz field (always 3 for AAC), 16-bit,
    stereo; then AACPacketType 0 = AudioSpecificConfig, 1 = a raw frame."""
    return b"\xaf" + bytes([packet_type]) + data


def audio_specific_config(sample_rate, channels):
    """Two-byte AAC-LC AudioSpecificConfig, for when the encoder gives none."""
    rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
    idx = rates.index(sample_rate) if sample_rate in rates else 3
    bits = (2 << 11) | (idx << 7) | (int(channels) << 3)
    return struct.pack(">H", bits)


# ------------------------------------------------------------------ RTMP publisher

SIO_TCP_INFO = 0xD8000027       # _WSAIORW(IOC_VENDOR, 39): what the TCP stack knows about a socket


class _TCP_INFO(ctypes.Structure):
    # TCP_INFO_v0 from mstcpip.h (Windows 10 1703+)
    _fields_ = [("State", ctypes.c_int), ("Mss", ctypes.c_uint), ("ConnectionTimeMs", ctypes.c_ulonglong),
                ("TimestampsEnabled", ctypes.c_ubyte), ("RttUs", ctypes.c_uint), ("MinRttUs", ctypes.c_uint),
                ("BytesInFlight", ctypes.c_uint), ("Cwnd", ctypes.c_uint), ("SndWnd", ctypes.c_uint),
                ("RcvWnd", ctypes.c_uint), ("RcvBuf", ctypes.c_uint), ("BytesOut", ctypes.c_ulonglong),
                ("BytesIn", ctypes.c_ulonglong), ("BytesReordered", ctypes.c_uint), ("BytesRetrans", ctypes.c_uint),
                ("FastRetrans", ctypes.c_uint), ("DupAcksIn", ctypes.c_uint), ("TimeoutEpisodes", ctypes.c_uint),
                ("SynRetrans", ctypes.c_ubyte)]


class RtmpError(Exception):
    pass


class RtmpClient:
    """Publishes one live stream to an RTMP(S) server, FMLE style."""

    CSID_CTRL, CSID_INVOKE, CSID_AUDIO, CSID_VIDEO, CSID_STREAM = 2, 3, 4, 6, 8
    T_CHUNK_SIZE, T_ACK, T_USER, T_WINDOW, T_PEER_BW = 1, 3, 4, 5, 6
    T_AUDIO, T_VIDEO, T_DATA, T_COMMAND = 8, 9, 18, 20

    def __init__(self, url, key, log=None):
        u = urllib.parse.urlsplit((url or "").strip())
        if u.scheme not in ("rtmp", "rtmps") or not u.hostname:
            raise RtmpError("the server URL must look like rtmp://host/app")
        self.host = u.hostname
        self.tls = u.scheme == "rtmps"
        self.port = u.port or (443 if self.tls else 1935)
        self.app = u.path.strip("/") + (("?" + u.query) if u.query else "")
        self.tc_url = f"{u.scheme}://{u.netloc}/{self.app}"
        self.key = (key or "").strip()
        if not self.key:
            raise RtmpError("no stream key")
        # The server may echo the key back in a status; it never reaches a log.
        self.log = (lambda msg: (log or (lambda *_: None))(msg.replace(self.key, "***")))
        self.sock = None
        self.alive = False
        self.error = ""
        self.stream_id = 0
        self.out_chunk = 128
        self.in_chunk = 128
        self.window = 0
        self.bytes_in = 0
        self.acked = 0
        self.bytes_out = 0
        self._buf = bytearray()
        self._in = {}
        self._wlock = threading.Lock()
        self._reader = None

    # ------------------------------------------------ socket plumbing

    def _readn(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RtmpError("the server closed the connection")
            self._buf += chunk
            self.bytes_in += len(chunk)
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def _write(self, data):
        with self._wlock:
            self.sock.sendall(data)
        self.bytes_out += len(data)

    def tcp_info(self):
        """Round trip, bytes in flight and retransmits straight from the TCP
        stack - the network health a viewer would feel. None if unavailable."""
        sock = self.sock
        if not sock:
            return None
        try:
            ioctl = ctypes.windll.ws2_32.WSAIoctl
            ioctl.restype = ctypes.c_int
            ioctl.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p,
                              ctypes.c_uint, ctypes.POINTER(ctypes.c_uint), ctypes.c_void_p, ctypes.c_void_p]
            info, version, got = _TCP_INFO(), ctypes.c_uint(0), ctypes.c_uint(0)
            if ioctl(ctypes.c_void_p(sock.fileno()), SIO_TCP_INFO, ctypes.byref(version), 4, ctypes.byref(info),
                     ctypes.sizeof(info), ctypes.byref(got), None, None) != 0:
                return None
            return info
        except Exception:
            return None

    def _handshake(self):
        c1 = struct.pack(">II", int(time.time()) & 0xFFFFFFFF, 0) + os.urandom(1528)
        self._write(b"\x03" + c1)
        if self._readn(1) != b"\x03":
            raise RtmpError("not an RTMP server")
        s1 = self._readn(1536)
        self._write(s1)                      # C2 echoes S1
        self._readn(1536)                    # S2

    def _send(self, csid, mtype, stream_id, timestamp, payload):
        """One message as fmt-0 chunk plus fmt-3 continuations."""
        ts = int(timestamp) & 0xFFFFFFFF
        ext = ts >= 0xFFFFFF
        head = (bytes([csid]) + (b"\xff\xff\xff" if ext else ts.to_bytes(3, "big"))
                + len(payload).to_bytes(3, "big") + bytes([mtype]) + struct.pack("<I", stream_id))
        if ext:
            head += struct.pack(">I", ts)
        cont = bytes([0xC0 | csid]) + (struct.pack(">I", ts) if ext else b"")
        size = self.out_chunk
        parts = [head, payload[:size]]
        for i in range(size, len(payload), size):
            parts.append(cont)
            parts.append(payload[i:i + size])
        self._write(b"".join(parts))

    def _invoke(self, name, txn, *args, csid=None, stream_id=0):
        body = b"".join(amf_encode(v) for v in (name, txn) + args)
        self._send(csid or self.CSID_INVOKE, self.T_COMMAND, stream_id, 0, body)

    def _read_message(self):
        """Blocks until one whole message has arrived; handles protocol
        control messages on the way. Returns (type, stream id, timestamp, payload)."""
        while True:
            b0 = self._readn(1)[0]
            fmt, csid = b0 >> 6, b0 & 0x3F
            if csid == 0:
                csid = 64 + self._readn(1)[0]
            elif csid == 1:
                b = self._readn(2)
                csid = 64 + b[0] + (b[1] << 8)
            st = self._in.setdefault(csid, {"ts": 0, "len": 0, "type": 0, "sid": 0,
                                            "buf": bytearray(), "ext": False})
            if fmt <= 2:
                ts = int.from_bytes(self._readn(3), "big")
                if fmt <= 1:
                    st["len"] = int.from_bytes(self._readn(3), "big")
                    st["type"] = self._readn(1)[0]
                if fmt == 0:
                    st["sid"] = struct.unpack("<I", self._readn(4))[0]
                st["ext"] = ts == 0xFFFFFF
                if st["ext"]:
                    ts = struct.unpack(">I", self._readn(4))[0]
                st["ts"] = ts if fmt == 0 else (st["ts"] + ts) & 0xFFFFFFFF
            elif st["ext"] and not st["buf"]:
                self._readn(4)
            need = min(self.in_chunk, st["len"] - len(st["buf"]))
            if need > 0:
                st["buf"] += self._readn(need)
            if len(st["buf"]) >= st["len"]:
                payload = bytes(st["buf"])
                st["buf"] = bytearray()
                self._control(st["type"], payload)
                if self.window and self.bytes_in - self.acked >= self.window:
                    self.acked = self.bytes_in
                    self._send(self.CSID_CTRL, self.T_ACK, 0, 0, struct.pack(">I", self.bytes_in & 0xFFFFFFFF))
                return st["type"], st["sid"], st["ts"], payload

    def _control(self, mtype, payload):
        if mtype == self.T_CHUNK_SIZE and len(payload) >= 4:
            self.in_chunk = max(1, struct.unpack(">I", payload[:4])[0] & 0x7FFFFFFF)
        elif mtype == self.T_WINDOW and len(payload) >= 4:
            self.window = struct.unpack(">I", payload[:4])[0]
        elif mtype == self.T_PEER_BW and len(payload) >= 4:
            # Acknowledge the bandwidth the server asks for with our own window.
            self._send(self.CSID_CTRL, self.T_WINDOW, 0, 0, payload[:4])
        elif mtype == self.T_USER and len(payload) >= 2:
            event = struct.unpack(">H", payload[:2])[0]
            if event == 6:       # PingRequest -> PingResponse with the same stamp
                self._send(self.CSID_CTRL, self.T_USER, 0, 0, b"\x00\x07" + payload[2:6])

    def _await(self, want, txn, timeout):
        """Read until the command `want` for transaction `txn` arrives."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.sock.settimeout(max(0.1, deadline - time.monotonic()))
            try:
                mtype, _sid, _ts, payload = self._read_message()
            except socket.timeout:
                break
            if mtype != self.T_COMMAND:
                continue
            try:
                cmd = amf_decode(payload)
            except Exception:
                continue
            name = cmd[0] if cmd else ""
            self.log(f"rtmp: <- {name} {_status_text(cmd, '')}".rstrip())
            if name == "_error":
                raise RtmpError(_status_text(cmd, "the server refused the connection"))
            if name == "onStatus":
                info = cmd[3] if len(cmd) > 3 and isinstance(cmd[3], dict) else {}
                if info.get("level") == "error":
                    raise RtmpError(_status_text(cmd, "the server refused the stream"))
                if want == "onStatus":
                    return cmd
            if name == want and (txn is None or (len(cmd) > 1 and cmd[1] == txn)):
                return cmd
        raise RtmpError(f"no answer to {want} from the server")

    # ------------------------------------------------ the publish flow

    def connect_publish(self, timeout=10):
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        if self.tls:
            self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=self.host)
        self._handshake()
        self._invoke("connect", 1, {"app": self.app, "type": "nonprivate",
                                    "flashVer": "FMLE/3.0 (compatible; FMSc/1.0)",
                                    "tcUrl": self.tc_url})
        self._send(self.CSID_CTRL, self.T_WINDOW, 0, 0, struct.pack(">I", 2500000))
        res = self._await("_result", 1, timeout)
        info = res[3] if len(res) > 3 and isinstance(res[3], dict) else {}
        if info.get("code", "NetConnection.Connect.Success") != "NetConnection.Connect.Success":
            raise RtmpError(_status_text(res, "connect failed"))
        self._send(self.CSID_CTRL, self.T_CHUNK_SIZE, 0, 0, struct.pack(">I", 4096))
        self.out_chunk = 4096
        self._invoke("releaseStream", 2, None, self.key)
        self._invoke("FCPublish", 3, None, self.key)
        self._invoke("createStream", 4, None)
        res = self._await("_result", 4, timeout)
        self.stream_id = int(res[3]) if len(res) > 3 and isinstance(res[3], (int, float)) else 1
        self._invoke("publish", 5, None, self.key, "live", csid=self.CSID_STREAM, stream_id=self.stream_id)
        try:
            self._await("onStatus", None, 5)
        except RtmpError as exc:
            if "no answer" not in str(exc):
                raise
            self.log("no publish status from the server; sending anyway")
        self.sock.settimeout(20)
        self.alive = True
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self):
        """Keeps answering pings and watching for the server dropping us."""
        while self.alive:
            try:
                mtype, _sid, _ts, payload = self._read_message()
            except socket.timeout:
                continue
            except (OSError, RtmpError) as exc:
                if self.alive:
                    self.error = str(exc) or "connection lost"
                    self.alive = False
                return
            if mtype == self.T_COMMAND:
                try:
                    cmd = amf_decode(payload)
                except Exception:
                    continue
                if cmd:
                    self.log(f"rtmp: <- {cmd[0]} {_status_text(cmd, '')}".rstrip())
                if cmd and cmd[0] == "onStatus":
                    info = cmd[3] if len(cmd) > 3 and isinstance(cmd[3], dict) else {}
                    if info.get("level") == "error":
                        self.error = _status_text(cmd, "the server stopped the stream")
                        self.alive = False
                        return

    def send_metadata(self, meta):
        body = amf_encode("@setDataFrame") + amf_encode("onMetaData") + amf_encode(EcmaArray(meta))
        self._send(self.CSID_INVOKE, self.T_DATA, self.stream_id, 0, body)

    def send_video(self, timestamp_ms, body):
        self._send(self.CSID_VIDEO, self.T_VIDEO, self.stream_id, timestamp_ms, body)

    def send_audio(self, timestamp_ms, body):
        self._send(self.CSID_AUDIO, self.T_AUDIO, self.stream_id, timestamp_ms, body)

    def close(self, polite=True):
        self.alive = False
        sock, self.sock = self.sock, None
        if not sock:
            return
        try:
            if polite:
                sock.settimeout(2)
                self.sock = sock
                self._invoke("FCUnpublish", 6, None, self.key)
                self._invoke("deleteStream", 7, None, self.stream_id)
                self.sock = None
        except Exception:
            pass
        try:
            sock.close()
        except Exception:
            pass


def _status_text(cmd, fallback):
    info = cmd[3] if len(cmd) > 3 and isinstance(cmd[3], dict) else {}
    code, desc = info.get("code", ""), info.get("description", "")
    return (f"{code}: {desc}" if code and desc else code or desc or fallback)


# ------------------------------------------------------------------ WebSocket (RFC 6455)

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def ws_accept_key(key):
    return base64.b64encode(hashlib.sha1((key.strip() + WS_GUID).encode()).digest()).decode()


class WebSocket:
    """Server side of one connection, on the handler's buffered files."""

    def __init__(self, rfile, wfile):
        self.rfile = rfile
        self.wfile = wfile
        self._wlock = threading.Lock()
        self.open = True

    def _readn(self, n):
        data = self.rfile.read(n) if n else b""
        if len(data) < n:
            raise ConnectionError("websocket closed")
        return data

    def recv(self):
        """The next complete message as (opcode, bytes); None once closed."""
        message, opcode = bytearray(), None
        while True:
            head = self._readn(2)
            fin, op = head[0] & 0x80, head[0] & 0x0F
            masked, length = head[1] & 0x80, head[1] & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._readn(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._readn(8))[0]
            mask = self._readn(4) if masked else None
            payload = self._readn(length)
            if mask and length:
                # XOR as one big integer: C speed, no per-byte Python loop.
                full = (mask * ((length + 3) // 4))[:length]
                payload = (int.from_bytes(payload, "little") ^ int.from_bytes(full, "little")
                           ).to_bytes(length, "little")
            if op == 0x8:
                self.send(0x8, payload[:2])
                self.open = False
                return None
            if op == 0x9:
                self.send(0xA, payload)
                continue
            if op == 0xA:
                continue
            if op in (0x1, 0x2):
                opcode = op
            message += payload
            if fin:
                out = bytes(message)
                return opcode, out

    def send(self, opcode, payload):
        n = len(payload)
        if n < 126:
            head = bytes([0x80 | opcode, n])
        elif n < 65536:
            head = bytes([0x80 | opcode, 126]) + struct.pack(">H", n)
        else:
            head = bytes([0x80 | opcode, 127]) + struct.pack(">Q", n)
        with self._wlock:
            self.wfile.write(head + payload)

    def send_text(self, text):
        self.send(0x1, text.encode("utf-8"))

    def close(self):
        if self.open:
            self.open = False
            try:
                self.send(0x8, b"\x03\xe8")
            except Exception:
                pass


# ------------------------------------------------------------------ the key vault (DPAPI)

class _BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(func, raw):
    crypt32 = ctypes.windll.crypt32
    buf = ctypes.create_string_buffer(raw, len(raw))
    inp = _BLOB(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    out = _BLOB()
    if func == "protect":
        ok = crypt32.CryptProtectData(ctypes.byref(inp), "Awesome Streaming Deck stream key",
                                      None, None, None, 1, ctypes.byref(out))
    else:
        ok = crypt32.CryptUnprotectData(ctypes.byref(inp), None, None, None, None, 1, ctypes.byref(out))
    if not ok:
        raise OSError("Windows would not %s the stream key" % func)
    data = ctypes.string_at(out.pbData, out.cbData)
    ctypes.windll.kernel32.LocalFree(out.pbData)
    return data


class Vault:
    """The Server URL and Stream key, the key encrypted to this Windows user.
    The key is never returned in full - only whether one is stored."""

    def __init__(self, cache_dir):
        self.path = os.path.join(cache_dir, "live.json")

    def _read(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def save(self, url, key):
        data = self._read()
        data["url"] = (url or data.get("url") or "").strip()
        if key:
            data["key"] = base64.b64encode(_dpapi("protect", key.strip().encode("utf-8"))).decode()
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, self.path)
        return {"ok": True, "has_key": bool(data.get("key")), "url": data["url"]}

    def load(self):
        data = self._read()
        key = None
        if data.get("key"):
            try:
                key = _dpapi("unprotect", base64.b64decode(data["key"])).decode("utf-8")
            except Exception:
                key = None
        return data.get("url", ""), key

    def has_key(self):
        return bool(self._read().get("key"))

    def forget(self):
        try:
            os.remove(self.path)
        except OSError:
            pass
        return {"ok": True, "has_key": False}


# ------------------------------------------------------------------ the engine

# Binary frame header from the page: type, flags, timestamp ms (big endian).
K_VCONFIG, K_VIDEO, K_ACONFIG, K_AUDIO, K_META = 0, 1, 2, 3, 4
QUEUE_MAX = 600          # about 7 s of 30 fps video plus AAC frames
BACKOFF_MAX_S = 30

# LIVE Studio's own quality table: the sizes, rates and bitrates TikTok
# expects. A portrait scene streams at its own size with the preset's rate.
PRESETS = {
    "1080p60": {"width": 1920, "height": 1080, "fps": 60, "kbps": 7600, "hevc_kbps": 6400},
    "1080p30": {"width": 1920, "height": 1080, "fps": 30, "kbps": 6000, "hevc_kbps": 5200},
    "720p60": {"width": 1280, "height": 720, "fps": 60, "kbps": 4400, "hevc_kbps": 3800},
    "720p30": {"width": 1280, "height": 720, "fps": 30, "kbps": 3400, "hevc_kbps": 3000},
    "480p30": {"width": 852, "height": 480, "fps": 30, "kbps": 2000, "hevc_kbps": 1800},
}
AUDIO_KBPS = 128
KEY_ROTATED_HINT = ("TikTok refused the stream key after it had been live - LIVE Center may have "
                    "issued a new key; copy it, paste it here and start again")


class LiveEngine:
    """Owns the RTMP connection and the queue between the page and the wire."""

    def __init__(self, cache_dir, log=None):
        self.vault = Vault(cache_dir)
        self.log = log or (lambda *_: None)
        self.on_change = None
        self.on_reconnect = None   # the video source forces a keyframe here
        self.preset = "720p30"
        self.state = "idle"        # idle | connecting | live | reconnecting | failed
        self.error = ""
        self.url = ""
        self.key = None
        self.meta = None           # onMetaData fields from the page
        self.avcc = None           # AVCDecoderConfigurationRecord
        self.asc = None            # AudioSpecificConfig
        self._q = deque()
        self._cv = threading.Condition()
        self._sender = None
        self._stop = threading.Event()
        self._session = None
        self.stats = {"bytes": 0, "kbps": 0, "vfps": 0, "afps": 0, "queue": 0, "delay_ms": 0,
                      "dropped": 0, "reconnects": 0, "uptime": 0, "connected_at": 0,
                      "rtt_ms": 0, "inflight_kb": 0, "retrans_kb": 0}
        self._counts = {"v": 0, "a": 0, "bytes": 0, "at": time.monotonic()}
        # One clock for everything: video encoded in this process and audio
        # arriving from the page are both stamped against it when the native
        # path is on, so they line up without the page knowing our time.
        self._t0 = time.monotonic()
        self.restamp_audio = False
        self._last_audio_ms = -1

    def clock_ms(self):
        return int((time.monotonic() - self._t0) * 1000)

    # ------------------------------------------------ reporting

    def status(self):
        s = dict(self.stats)
        s["queue"] = len(self._q)
        if self.state == "live" and s["connected_at"]:
            s["uptime"] = int(time.time() - s["connected_at"])
        return {"state": self.state, "error": self.error, "has_key": self.vault.has_key(),
                "url": self.url, "page": bool(self._session), "preset": self.preset, "stats": s}

    def snapshot_status(self):
        """What the deck's state feed carries: nothing that changes every second."""
        return {"state": self.state, "error": self.error, "has_key": self.vault.has_key(),
                "url": self.url, "preset": self.preset, "reconnects": self.stats["reconnects"]}

    def _set_state(self, state, error=""):
        if state == self.state and error == self.error:
            return
        self.state, self.error = state, error
        self.log(f"live: {state}" + (f" ({error})" if error else ""))
        if self.on_change:
            try:
                self.on_change()
            except Exception:
                pass

    # ------------------------------------------------ start / stop

    def start(self, url=None, key=None, remember=False, preset=None):
        if self._sender and self._sender.is_alive():
            return {"ok": True, "already": True, "state": self.state}
        saved_url, saved_key = self.vault.load()
        url = (url or "").strip() or saved_url
        key = (key or "").strip() or saved_key
        if not url or not key:
            return {"ok": False, "error": "a Server URL and a Stream key are needed"}
        if remember:
            self.vault.save(url, key)
        if preset in PRESETS:
            self.preset = preset
        self.url, self.key = url, key
        self.stats.update(bytes=0, kbps=0, vfps=0, afps=0, dropped=0, reconnects=0, uptime=0,
                          connected_at=0, delay_ms=0, rtt_ms=0, inflight_kb=0, retrans_kb=0)
        self._t0 = time.monotonic()
        self._last_audio_ms = -1
        self.meta = None
        with self._cv:
            self._q.clear()
        self._stop.clear()
        self._set_state("connecting")
        self._sender = threading.Thread(target=self._run, daemon=True)
        self._sender.start()
        return {"ok": True, "state": self.state}

    def stop(self):
        self._stop.set()
        with self._cv:
            self._cv.notify_all()
        sender = self._sender
        if sender and sender.is_alive():
            sender.join(5)
        self._sender = None
        self.key = None
        self._set_state("idle")
        return {"ok": True, "state": self.state}

    # ------------------------------------------------ from the page

    def push(self, kind, timestamp_ms, flags, payload):
        if kind == K_META:
            # Video and audio facts may come from different senders.
            try:
                self.meta = dict(self.meta or {}, **json.loads(payload.decode("utf-8")))
            except Exception:
                return
        elif kind == K_VCONFIG:
            self.avcc = payload
        elif kind == K_ACONFIG:
            self.asc = payload
        elif kind == K_AUDIO and self.restamp_audio:
            # Arrival time on our clock, never stepping backwards.
            timestamp_ms = max(self.clock_ms(), self._last_audio_ms + 1)
            self._last_audio_ms = timestamp_ms
        with self._cv:
            if len(self._q) >= QUEUE_MAX:
                self._drop_one()
            self._q.append((kind, timestamp_ms, flags, payload))
            self._cv.notify()

    def _drop_one(self):
        # The wire is behind: lose a non-key video frame before anything else.
        for i, item in enumerate(self._q):
            if item[0] == K_VIDEO and not (item[2] & 1):
                del self._q[i]
                self.stats["dropped"] += 1
                return
        self._q.popleft()
        self.stats["dropped"] += 1

    # ------------------------------------------------ the sender thread

    def _run(self):
        backoff = 1
        was_live = False
        while not self._stop.is_set():
            client = None
            try:
                client = RtmpClient(self.url, self.key, self.log)
                client.connect_publish()
                self.stats["connected_at"] = time.time()
                self._set_state("live")
                backoff = 1
                if was_live and self.on_reconnect:
                    # Back on the air: the next frame out must be a keyframe,
                    # or a viewer waits out the GOP looking at nothing.
                    try:
                        self.on_reconnect()
                    except Exception:
                        pass
                was_live = True
                self._stream(client)
                return
            except (OSError, RtmpError, ValueError) as exc:
                text = str(exc) or exc.__class__.__name__
                if client:
                    client.close(polite=False)
                if self._stop.is_set():
                    return
                if _is_fatal(text):
                    self._set_state("failed", (KEY_ROTATED_HINT + " (" + text + ")") if was_live else text)
                    return
                self.stats["reconnects"] += 1
                self._set_state("reconnecting", text)
                if self._stop.wait(backoff):
                    return
                backoff = min(BACKOFF_MAX_S, backoff * 2)
            finally:
                if client and not client.alive and self._stop.is_set():
                    client.close(polite=True)

    def _stream(self, client):
        """Drain the queue onto the wire until stopped or the socket dies."""
        need_key = True
        if self.meta:
            client.send_metadata(self.meta)
        if self.avcc:
            client.send_video(0, video_tag(True, 0, self.avcc))
        if self.asc:
            client.send_audio(0, audio_tag(0, self.asc))
        self._counts = {"v": 0, "a": 0, "bytes": client.bytes_out, "at": time.monotonic()}
        while not self._stop.is_set():
            with self._cv:
                while not self._q and not self._stop.is_set():
                    self._cv.wait(0.5)
                    if not client.alive:
                        break
                item = self._q.popleft() if self._q else None
            if not client.alive:
                raise RtmpError(client.error or "connection lost")
            if item is None:
                continue
            kind, ts, flags, payload = item
            if kind == K_META:
                client.send_metadata(self.meta)
            elif kind == K_VCONFIG:
                client.send_video(ts, video_tag(True, 0, payload))
            elif kind == K_ACONFIG:
                client.send_audio(ts, audio_tag(0, payload))
            elif kind == K_VIDEO:
                key = bool(flags & 1)
                if need_key and not key:
                    self.stats["dropped"] += 1
                    continue
                need_key = False
                client.send_video(ts, video_tag(key, 1, payload))
                self._counts["v"] += 1
                # How far behind its capture a frame goes out: encoder plus queue.
                self.stats["delay_ms"] = max(0, self.clock_ms() - int(ts))
            elif kind == K_AUDIO:
                client.send_audio(ts, audio_tag(1, payload))
                self._counts["a"] += 1
            self._tick(client)
        client.close(polite=True)

    def _tick(self, client):
        now = time.monotonic()
        span = now - self._counts["at"]
        if span < 1.0:
            return
        c = self._counts
        self.stats["kbps"] = int((client.bytes_out - c["bytes"]) * 8 / span / 1000)
        self.stats["vfps"] = round(c["v"] / span, 1)
        self.stats["afps"] = round(c["a"] / span, 1)
        self.stats["bytes"] = client.bytes_out
        self._counts = {"v": 0, "a": 0, "bytes": client.bytes_out, "at": now}
        tcp = client.tcp_info()
        if tcp:
            self.stats["rtt_ms"] = round(tcp.RttUs / 1000, 1)
            self.stats["inflight_kb"] = round(tcp.BytesInFlight / 1024, 1)
            self.stats["retrans_kb"] = round(tcp.BytesRetrans / 1024, 1)

    # ------------------------------------------------ the page's socket

    def serve_websocket(self, handler):
        """Called from the HTTP handler on GET /ws/live with an Upgrade header.
        Runs until the page hangs up; the handler thread is ours meanwhile."""
        key = handler.headers.get("Sec-WebSocket-Key")
        if not key or "websocket" not in (handler.headers.get("Upgrade") or "").lower():
            handler.send_error(400, "websocket upgrade expected")
            return
        handler.send_response(101)
        handler.send_header("Upgrade", "websocket")
        handler.send_header("Connection", "Upgrade")
        handler.send_header("Sec-WebSocket-Accept", ws_accept_key(key))
        handler.end_headers()
        handler.wfile.flush()
        handler.close_connection = True

        ws = WebSocket(handler.rfile, handler.wfile)
        old, self._session = self._session, ws
        if old:
            old.close()
        stop_stats = threading.Event()
        threading.Thread(target=self._stats_pump, args=(ws, stop_stats), daemon=True).start()
        try:
            while True:
                msg = ws.recv()
                if msg is None:
                    break
                opcode, data = msg
                if opcode == 0x2 and len(data) >= 6:
                    kind, flags = data[0], data[1]
                    ts = struct.unpack(">I", data[2:6])[0]
                    self.push(kind, ts, flags, data[6:])
                elif opcode == 0x1:
                    self._command(data)
        except (ConnectionError, OSError, ValueError):
            pass
        finally:
            stop_stats.set()
            if self._session is ws:
                self._session = None
            ws.open = False

    def _command(self, data):
        try:
            cmd = json.loads(data.decode("utf-8"))
        except Exception:
            return
        if cmd.get("cmd") == "stop":
            self.stop()

    def _stats_pump(self, ws, stop):
        while not stop.is_set() and ws.open:
            try:
                ws.send_text(json.dumps(self.status()))
            except Exception:
                return
            stop.wait(1.0)


def _is_fatal(text):
    """Errors that a retry will not fix: a wrong key, a refused connection
    from the server's side, a key that was rotated mid-stream."""
    t = text.lower()
    return any(s in t for s in ("badname", "rejected", "unauthor", "forbidden", "invalid",
                                "refused the", "no stream key", "must look like",
                                "not an rtmp server"))
