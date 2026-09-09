"""
Dependency-free audio metadata reader (Python stdlib only).

Reads title / artist / album / track / duration and embedded cover art from:
    .mp3            ID3v2.2 / v2.3 / v2.4, falls back to ID3v1
    .flac           Vorbis comments + PICTURE block
    .m4a .mp4 .m4b  iTunes-style atoms
    .ogg .opus      Vorbis comment / OpusTags
    .wav            RIFF INFO chunk
Anything unreadable falls back to a filename guess, so nothing is ever skipped.
"""

import os
import struct

AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".mp4", ".m4b", ".ogg", ".opus",
              ".wav", ".aac", ".wma", ".aiff", ".aif", ".webm"}


# ---------------------------------------------------------------- helpers

def _synchsafe(b):
    return (b[0] & 0x7F) << 21 | (b[1] & 0x7F) << 14 | (b[2] & 0x7F) << 7 | (b[3] & 0x7F)


def _decode_text(enc, data):
    """Decode an ID3 text payload, tolerating junk and stray terminators."""
    try:
        if enc == 1:
            if len(data) % 2:
                data = data[:-1]
            s = data.decode("utf-16", "replace")
        elif enc == 2:
            if len(data) % 2:
                data = data[:-1]
            s = data.decode("utf-16-be", "replace")
        elif enc == 3:
            s = data.decode("utf-8", "replace")
        else:
            s = data.decode("latin-1", "replace")
    except Exception:
        s = data.decode("latin-1", "replace")
    s = s.replace("﻿", "")
    # v2.4 packs multiple values behind NULs; take the first, drop terminators.
    return s.split("\x00")[0].strip()


def _split_null(data, enc, start=0):
    """Return (bytes_before_terminator, index_after_terminator)."""
    if enc in (1, 2):
        i = start
        while i + 1 < len(data):
            if data[i] == 0 and data[i + 1] == 0:
                return data[start:i], i + 2
            i += 2
        return data[start:], len(data)
    i = data.find(b"\x00", start)
    if i < 0:
        return data[start:], len(data)
    return data[start:i], i + 1


def _from_filename(path):
    """Guess from a "01 - Artist - Title.mp3" style name, as a last resort."""
    stem = os.path.splitext(os.path.basename(path))[0]
    parts = [p.strip() for p in stem.split(" - ") if p.strip()]
    if parts and parts[0].isdigit():
        parts = parts[1:]
    if len(parts) >= 2:
        return {"artist": parts[0], "title": " - ".join(parts[1:])}
    return {"artist": "", "title": stem}


# ---------------------------------------------------------------- mp3 / id3

_ID3_MAP_24 = {
    "TIT2": "title", "TPE1": "artist", "TALB": "album",
    "TPE2": "albumartist", "TRCK": "track", "TDRC": "year", "TYER": "year",
}
_ID3_MAP_22 = {
    "TT2": "title", "TP1": "artist", "TAL": "album",
    "TP2": "albumartist", "TRK": "track", "TYE": "year",
}


def _read_id3v2(f, want_art):
    head = f.read(10)
    if len(head) < 10 or head[:3] != b"ID3":
        return None
    major = head[3]
    flags = head[5]
    size = _synchsafe(head[6:10])
    body = f.read(size)
    if flags & 0x80:  # unsynchronisation applied to the whole tag
        body = body.replace(b"\xff\x00", b"\xff")
    if flags & 0x40:  # skip extended header
        if major >= 4 and len(body) >= 4:
            body = body[_synchsafe(body[0:4]):]
        elif len(body) >= 4:
            body = body[4 + struct.unpack(">I", body[0:4])[0]:]

    out, pos = {}, 0
    id_len = 3 if major == 2 else 4

    while pos + id_len + id_len <= len(body):
        fid = body[pos:pos + id_len].decode("latin-1", "replace")
        if not fid.strip("\x00 "):
            break
        if major == 2:
            fsize = int.from_bytes(body[pos + 3:pos + 6], "big")
            fpos = pos + 6
            mapping = _ID3_MAP_22
        else:
            raw = body[pos + 4:pos + 8]
            # v2.4 sizes are synchsafe; some encoders get it wrong, so sanity-check.
            fsize = _synchsafe(raw) if major >= 4 else struct.unpack(">I", raw)[0]
            if major >= 4 and (fsize > len(body) - pos - 10 or fsize == 0):
                plain = struct.unpack(">I", raw)[0]
                if 0 < plain <= len(body) - pos - 10:
                    fsize = plain
            fpos = pos + 10
            mapping = _ID3_MAP_24
        if fsize <= 0 or fpos + fsize > len(body):
            break
        payload = body[fpos:fpos + fsize]

        key = mapping.get(fid)
        if key and payload:
            out.setdefault(key, _decode_text(payload[0], payload[1:]))
        elif want_art and fid in ("APIC", "PIC") and payload and "art" not in out:
            art = _parse_apic(payload, fid)
            if art:
                out["art"] = art
        pos = fpos + fsize
    return out


def _parse_apic(payload, fid):
    enc = payload[0]
    if fid == "PIC":
        fmt = payload[1:4].decode("latin-1", "replace").upper()
        mime = "image/png" if fmt == "PNG" else "image/jpeg"
        idx = 5
    else:
        mime_b, idx = _split_null(payload, 0, 1)
        mime = mime_b.decode("latin-1", "replace").strip() or "image/jpeg"
        if mime == "-->":
            return None  # external URL reference, not embedded data
        if "/" not in mime:
            mime = "image/" + mime.lower()
        idx += 1  # picture type byte
    _, idx = _split_null(payload, enc, idx)
    data = payload[idx:]
    return (mime, data) if len(data) > 100 else None


def _mp3_duration(path, tag_end):
    """Duration from a Xing/VBRI header when present, else a CBR estimate."""
    bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
    rates = {0: [11025, 12000, 8000], 3: [44100, 48000, 32000], 2: [22050, 24000, 16000]}
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            f.seek(tag_end)
            buf = f.read(8192)
            for i in range(len(buf) - 4):
                if buf[i] != 0xFF or (buf[i + 1] & 0xE0) != 0xE0:
                    continue
                ver = (buf[i + 1] >> 3) & 0x03
                layer = (buf[i + 1] >> 1) & 0x03
                br_i = (buf[i + 2] >> 4) & 0x0F
                sr_i = (buf[i + 2] >> 2) & 0x03
                if ver == 1 or layer != 1 or br_i in (0, 15) or sr_i == 3:
                    continue
                sr = rates.get(ver, rates[0])[sr_i]
                br = bitrates[br_i] * (1 if ver == 3 else 0.5) * 1000
                if not sr or not br:
                    continue
                mono = ((buf[i + 3] >> 6) & 0x03) == 3
                side = (17 if mono else 32) if ver == 3 else (9 if mono else 17)
                tagpos = i + 4 + side
                spf = 1152 if ver == 3 else 576
                head = buf[tagpos:tagpos + 4]
                if head in (b"Xing", b"Info"):
                    fl = struct.unpack(">I", buf[tagpos + 4:tagpos + 8])[0]
                    if fl & 1:
                        frames = struct.unpack(">I", buf[tagpos + 8:tagpos + 12])[0]
                        return round(frames * spf / sr, 2)
                if buf[i + 36:i + 40] == b"VBRI":
                    frames = struct.unpack(">I", buf[i + 50:i + 54])[0]
                    return round(frames * spf / sr, 2)
                return round((size - tag_end) * 8 / br, 2)
    except Exception:
        pass
    return 0


def _read_mp3(path, want_art):
    meta = {}
    tag_end = 0
    with open(path, "rb") as f:
        v2 = _read_id3v2(f, want_art)
        if v2 is not None:
            tag_end = f.tell()
            meta.update(v2)
        if not meta.get("title") or not meta.get("artist"):
            try:  # ID3v1 lives in the final 128 bytes
                f.seek(-128, os.SEEK_END)
                t = f.read(128)
                if t[:3] == b"TAG":
                    def d(b):
                        return b.rstrip(b"\x00 ").decode("latin-1", "replace").strip()
                    if not meta.get("title"):
                        meta["title"] = d(t[3:33])
                    if not meta.get("artist"):
                        meta["artist"] = d(t[33:63])
                    if not meta.get("album"):
                        meta["album"] = d(t[63:93])
            except Exception:
                pass
    meta["duration"] = _mp3_duration(path, tag_end)
    return meta


# ---------------------------------------------------------------- flac

_VORBIS_MAP = {"TITLE": "title", "ARTIST": "artist", "ALBUM": "album",
               "ALBUMARTIST": "albumartist", "TRACKNUMBER": "track", "DATE": "year"}


def _parse_vorbis_comment(data):
    out = {}
    try:
        vlen = struct.unpack("<I", data[0:4])[0]
        pos = 4 + vlen
        count = struct.unpack("<I", data[pos:pos + 4])[0]
        pos += 4
        for _ in range(min(count, 512)):
            ln = struct.unpack("<I", data[pos:pos + 4])[0]
            pos += 4
            item = data[pos:pos + ln].decode("utf-8", "replace")
            pos += ln
            if "=" in item:
                k, v = item.split("=", 1)
                key = _VORBIS_MAP.get(k.upper())
                if key and v.strip():
                    out.setdefault(key, v.strip())
    except Exception:
        pass
    return out


def _parse_flac_picture(data):
    try:
        pos = 4
        mlen = struct.unpack(">I", data[pos:pos + 4])[0]
        pos += 4
        mime = data[pos:pos + mlen].decode("latin-1", "replace")
        pos += mlen
        dlen = struct.unpack(">I", data[pos:pos + 4])[0]
        pos += 4 + dlen + 16
        ilen = struct.unpack(">I", data[pos:pos + 4])[0]
        pos += 4
        img = data[pos:pos + ilen]
        return (mime or "image/jpeg", img) if len(img) > 100 else None
    except Exception:
        return None


def _read_flac(path, want_art):
    meta = {}
    with open(path, "rb") as f:
        if f.read(4) != b"fLaC":
            return meta
        while True:
            hdr = f.read(4)
            if len(hdr) < 4:
                break
            last = bool(hdr[0] & 0x80)
            btype = hdr[0] & 0x7F
            blen = int.from_bytes(hdr[1:4], "big")
            if btype == 0:  # STREAMINFO
                b = f.read(blen)
                if len(b) >= 18:
                    sr = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4)
                    total = ((b[13] & 0x0F) << 32) | struct.unpack(">I", b[14:18])[0]
                    if sr:
                        meta["duration"] = round(total / sr, 2)
            elif btype == 4:
                meta.update(_parse_vorbis_comment(f.read(blen)))
            elif btype == 6 and want_art:
                art = _parse_flac_picture(f.read(blen))
                if art:
                    meta["art"] = art
            else:
                f.seek(blen, os.SEEK_CUR)
            if last:
                break
    return meta


# ---------------------------------------------------------------- mp4 / m4a

_MP4_MAP = {b"\xa9nam": "title", b"\xa9ART": "artist", b"\xa9alb": "album",
            b"aART": "albumartist", b"\xa9day": "year"}


def _mp4_atoms(f, start, end):
    pos = start
    while pos < end - 8:
        f.seek(pos)
        hdr = f.read(8)
        if len(hdr) < 8:
            return
        size = int.from_bytes(hdr[0:4], "big")
        typ = hdr[4:8]
        body = pos + 8
        if size == 1:
            size = int.from_bytes(f.read(8), "big")
            body = pos + 16
        elif size == 0:
            size = end - pos
        if size < 8 or pos + size > end:
            return
        if typ == b"meta":
            body += 4  # full atom: version + flags
        yield typ, body, pos + size
        pos += size


def _read_mp4(path, want_art):
    meta = {}
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        for typ, body, end in _mp4_atoms(f, 0, size):
            if typ != b"moov":
                continue
            for t2, b2, e2 in _mp4_atoms(f, body, end):
                if t2 == b"mvhd":
                    f.seek(b2)
                    d = f.read(24)
                    if d and d[0] == 0 and len(d) >= 20:
                        ts, dur = struct.unpack(">II", d[12:20])
                        if ts:
                            meta["duration"] = round(dur / ts, 2)
                elif t2 == b"udta":
                    for t3, b3, e3 in _mp4_atoms(f, b2, e2):
                        if t3 != b"meta":
                            continue
                        for t4, b4, e4 in _mp4_atoms(f, b3, e3):
                            if t4 != b"ilst":
                                continue
                            for t5, b5, e5 in _mp4_atoms(f, b4, e4):
                                for t6, b6, e6 in _mp4_atoms(f, b5, e5):
                                    if t6 != b"data":
                                        continue
                                    f.seek(b6)
                                    flags = int.from_bytes(f.read(4), "big") & 0xFFFFFF
                                    f.seek(b6 + 8)
                                    raw = f.read(max(0, e6 - b6 - 8))
                                    if t5 in _MP4_MAP:
                                        meta.setdefault(
                                            _MP4_MAP[t5],
                                            raw.decode("utf-8", "replace").strip())
                                    elif t5 == b"trkn" and len(raw) >= 4:
                                        meta.setdefault(
                                            "track", str(int.from_bytes(raw[2:4], "big")))
                                    elif t5 == b"covr" and want_art and "art" not in meta:
                                        mime = "image/png" if flags == 14 else "image/jpeg"
                                        if len(raw) > 100:
                                            meta["art"] = (mime, raw)
    return meta


# ---------------------------------------------------------------- ogg / opus

def _ogg_pages(f, limit=40):
    for _ in range(limit):
        hdr = f.read(27)
        if len(hdr) < 27 or hdr[:4] != b"OggS":
            return
        nseg = hdr[26]
        segs = f.read(nseg)
        yield hdr, f.read(sum(segs))


def _read_ogg(path, want_art):
    meta = {}
    with open(path, "rb") as f:
        sr = 0
        for _hdr, data in _ogg_pages(f):
            if data[:7] == b"\x01vorbis" and len(data) >= 16:
                sr = struct.unpack("<I", data[12:16])[0]
            elif data[:8] == b"OpusHead":
                sr = 48000
            elif data[:7] == b"\x03vorbis":
                meta.update(_parse_vorbis_comment(data[7:]))
            elif data[:8] == b"OpusTags":
                meta.update(_parse_vorbis_comment(data[8:]))
            if "title" in meta and sr:
                break
        # Duration = granule position of the final page / sample rate.
        if sr:
            try:
                size = os.path.getsize(path)
                f.seek(max(0, size - 65536))
                tail = f.read()
                idx = tail.rfind(b"OggS")
                if idx >= 0 and idx + 14 <= len(tail):
                    gp = struct.unpack("<Q", tail[idx + 6:idx + 14])[0]
                    meta["duration"] = round(gp / sr, 2)
            except Exception:
                pass
    return meta


# ---------------------------------------------------------------- wav

_WAV_MAP = {b"INAM": "title", b"IART": "artist", b"IPRD": "album", b"ITRK": "track"}


def _read_wav(path, want_art):
    meta = {}
    with open(path, "rb") as f:
        if f.read(4) != b"RIFF":
            return meta
        f.read(8)
        byte_rate = 0
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            cid, clen = hdr[:4], struct.unpack("<I", hdr[4:8])[0]
            if cid == b"fmt ":
                d = f.read(clen)
                if len(d) >= 12:
                    byte_rate = struct.unpack("<I", d[8:12])[0]
            elif cid == b"data":
                if byte_rate:
                    meta["duration"] = round(clen / byte_rate, 2)
                f.seek(clen + (clen & 1), os.SEEK_CUR)
            elif cid == b"LIST":
                d = f.read(clen)
                if d[:4] == b"INFO":
                    p = 4
                    while p + 8 <= len(d):
                        k = d[p:p + 4]
                        n = struct.unpack("<I", d[p + 4:p + 8])[0]
                        v = d[p + 8:p + 8 + n].rstrip(b"\x00").decode("latin-1", "replace")
                        if k in _WAV_MAP and v.strip():
                            meta.setdefault(_WAV_MAP[k], v.strip())
                        p += 8 + n + (n & 1)
            else:
                f.seek(clen + (clen & 1), os.SEEK_CUR)
    return meta


# ---------------------------------------------------------------- public API

_READERS = {
    ".mp3": _read_mp3, ".flac": _read_flac,
    ".m4a": _read_mp4, ".mp4": _read_mp4, ".m4b": _read_mp4,
    ".ogg": _read_ogg, ".opus": _read_ogg, ".wav": _read_wav,
}


def read_tags(path, want_art=False):
    """Return {title, artist, album, track, year, duration} (+ art when asked).

    Never raises: a damaged file degrades to a filename guess.
    """
    ext = os.path.splitext(path)[1].lower()
    meta = {}
    reader = _READERS.get(ext)
    if reader:
        try:
            meta = reader(path, want_art) or {}
        except Exception:
            meta = {}

    guess = _from_filename(path)
    out = {
        "title": (meta.get("title") or "").strip() or guess["title"],
        "artist": (meta.get("artist") or "").strip() or guess["artist"],
        "album": (meta.get("album") or "").strip(),
        "albumartist": (meta.get("albumartist") or "").strip(),
        "track": (meta.get("track") or "").split("/")[0].strip(),
        "year": (meta.get("year") or "").strip()[:4],
        "duration": float(meta.get("duration") or 0),
    }
    if want_art:
        out["art"] = meta.get("art")
    return out


def read_art(path):
    """Embedded cover art as (mime, bytes), or a cover file sitting next to it."""
    try:
        art = read_tags(path, want_art=True).get("art")
        if art:
            return art
    except Exception:
        pass
    folder = os.path.dirname(path)
    for name in ("cover", "folder", "front", "album", "albumart", "artwork"):
        for ext in (".jpg", ".jpeg", ".png", ".webp"):
            candidate = os.path.join(folder, name + ext)
            if os.path.isfile(candidate):
                try:
                    with open(candidate, "rb") as f:
                        data = f.read()
                    mime = {".png": "image/png", ".webp": "image/webp"}.get(ext, "image/jpeg")
                    return mime, data
                except Exception:
                    pass
    return None
