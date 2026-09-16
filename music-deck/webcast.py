"""
TikTok's live-room messages, as the user's own live page receives them (T6).

Gifts are never drawn into the page's chat list, so the chat reader cannot see
them. Checked against real live pages on 2026-09-15: the page receives chat,
gifts, likes and joins as protobuf on its own websocket to TikTok's webcast
servers, and draws only some of it. tiktok_chat.py already holds a DevTools
connection to that page; it watches the page's network - read only, the way
DevTools' Network tab does - and hands each frame here. The page has already
done the request signing that every other route sends to a third party; this
only reads what arrived, on this PC.

Only one socket is ever read: TikTok's webcast room socket (is_webcast). The
page opens others - im-ws, TikTok's messaging socket, among them, which on a
signed-in page would carry the user's private messages - and their frames are
dropped without being decoded.

Nothing here talks to anything. It decodes bytes it is handed, with the
standard library: no protobuf compiler, no schema file, no dependency. The
field numbers are facts about TikTok's messages - the community's protobuf
definitions name them - and each one used here was checked against frames a
real live page received before anything was built on it (DECISIONS, "Gifts
from the page's own websocket").

The bytes come off the network, so they are treated as hostile: every length
is checked before it is used, a number is ten bytes at most, gzip is inflated
to MAX_INFLATED and no further, and only the fixed paths below are walked -
nothing recurses on what the bytes say.
"""

import base64
import re
import time
import zlib
from collections import OrderedDict
from urllib.parse import parse_qsl, urlparse

MAX_INFLATED = 4 * 1024 * 1024
MAX_B64 = 8 * 1024 * 1024
GZIP = bytes([0x1F, 0x8B])
GIFT = "WebcastGiftMessage"
CHAT = "WebcastChatMessage"
SOCIAL = "WebcastSocialMessage"
HANDLE = re.compile(r"^[a-z0-9._]{2,24}$")
_HOST = re.compile(r"webcast[a-z0-9-]*(\.[a-z0-9-]+)*\.tiktok\.com")


class Bad(ValueError):
    """Bytes that are not what TikTok sends."""


# ------------------------------------------------------------ the wire format

def varint(b, i):
    value = shift = 0
    for _ in range(10):
        if i >= len(b):
            raise Bad("a number runs off the end")
        c = b[i]
        i += 1
        value |= (c & 0x7F) << shift
        if not c & 0x80:
            return value, i
        shift += 7
    raise Bad("a number longer than ten bytes")


def fields(b):
    """[(field, wire type, value)] for one message. A length-delimited value is
    bytes and anything else an int. Anything malformed raises Bad."""
    out, i, n = [], 0, len(b)
    while i < n:
        key, i = varint(b, i)
        num, wt = key >> 3, key & 7
        if num == 0:
            raise Bad("field 0")
        if wt == 0:
            v, i = varint(b, i)
        elif wt == 2:
            size, i = varint(b, i)
            if size > n - i:
                raise Bad("a field longer than its message")
            v, i = b[i:i + size], i + size
        elif wt in (1, 5):
            size = 8 if wt == 1 else 4
            if size > n - i:
                raise Bad("a field longer than its message")
            v, i = int.from_bytes(b[i:i + size], "little"), i + size
        else:
            raise Bad(f"wire type {wt}")
        out.append((num, wt, v))
    return out


def _all(fs, num, wt):
    return [v for n, w, v in fs if n == num and w == wt]


def _int(fs, num):
    v = _all(fs, num, 0)
    return v[-1] if v else 0          # protobuf: the last one wins


def _bytes(fs, num):
    v = _all(fs, num, 2)
    return v[-1] if v else b""


def _text(fs, num, limit):
    return _bytes(fs, num)[:limit * 4].decode("utf-8", "replace")[:limit]


def inflate(data):
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        out = d.decompress(data, MAX_INFLATED)
    except zlib.error as exc:
        raise Bad(f"gzip: {exc}") from None
    if d.unconsumed_tail:
        raise Bad("larger than MAX_INFLATED once inflated")
    return out


# ------------------------------------------------------------ TikTok's messages

def messages(frame):
    """What one websocket frame carries: [(method, payload, id, history)].

    The push frame: its type (7) says msg, hb or ack, and only msg carries
    anything; its payload (8) is gzip - said by a compress_type header, and
    checked here by the bytes themselves. Inside, each message (1) has its
    name (1), its own bytes (2), an id (3), and a history flag (6) that marks
    what was said before the page joined."""
    push = fields(frame)
    if _text(push, 7, 40) != "msg":
        return []
    body = _bytes(push, 8)
    if body[:2] == GZIP:
        body = inflate(body)
    out = []
    for m in _all(fields(body), 1, 2):
        mf = fields(m)
        out.append((_text(mf, 1, 80), _bytes(mf, 2), _int(mf, 3), bool(_int(mf, 6))))
    return out


def user(b):
    """Who: TikTok's numeric id (1), the display name (3), and the @handle (38).
    The handle is unique - unlike a display name, nobody can take someone
    else's - so it is the one that can say who a gift was sent to."""
    fs = fields(b)
    handle = _text(fs, 38, 40).lower()
    return {"id": _int(fs, 1), "name": _text(fs, 3, 80), "handle": handle if HANDLE.match(handle) else "",
            "avatar": avatar_url(_bytes(fs, 9))}


def avatar_url(b):
    """The picture (9): a list of links (1) to the same image, as WebP and as
    JPEG from several of TikTok's servers. The JPEG if there is one - every
    browser takes it - else the first. Only a link: avatars.py decides whether
    it may be fetched at all."""
    if not b:
        return ""
    urls = [u[:2048].decode("utf-8", "replace") for u in _all(fields(b), 1, 2)][:8]
    jpeg = [u for u in urls if urlparse(u).path.lower().endswith((".jpeg", ".jpg"))]
    return (jpeg or urls or [""])[0]


def gift(payload):
    """A WebcastGiftMessage, as what the gift layer needs - or None.

    The message: the gift's id (2), the running total of a streak (5), the
    sender (7), who it was sent to (8, absent when it is the host), the end of
    a streak (9), and which streak (11). The gift itself (15): its id (5),
    its type (11) - 1 for a gift sent as a streak - its coin value (12) and
    its name (16)."""
    fs = fields(payload)
    info = fields(_bytes(fs, 15))
    gid = _int(info, 5) or _int(fs, 2)
    if not gid:
        return None
    to = _bytes(fs, 8)
    return {"id": gid, "name": _text(info, 16, 40), "coins": _int(info, 12),
            "streak": _int(info, 11) == 1, "count": max(1, _int(fs, 5)),
            "end": _int(fs, 9) == 1, "group": _int(fs, 11),
            "user": user(_bytes(fs, 7)), "to": user(to)["handle"] if to else ""}


def chat(payload):
    """A WebcastChatMessage: the sender (2), the words (3), and what TikTok
    says about the sender in this room (18). Two of those flags are used, each
    checked on real lives before it was:
      5 - a moderator of this room: on the line the page drew a moderator
          badge on, and on none of about a hundred others.
      4 - follows the streamer: absent from every line of people who had not
          yet followed, and on every line after they followed, the same
          people, lined up against TikTok's own follow announcement.
      1 - has gifted the streamer: on every line of all nine people who
          chatted after sending a gift, and on some lines of people before
          their first gift of that stream - so TikTok's "has gifted you",
          not only "this stream". The gift gate takes it beside the ledger's
          own count (gifts.py).
    The rest - 2 and 3, subscriber and mutual follow by the community's
    definitions - are not read, and need not be: in ten more rooms, 3 was on
    35 lines from 16 people and 2 on two (wearing TikTok's super-fan badge),
    and 4 was on every one. A mutual follow or a subscriber is already a
    follower here, so nobody the streamer follows back is turned away."""
    fs = fields(payload)
    ident = fields(_bytes(fs, 18))
    return {"user": user(_bytes(fs, 2)), "text": _text(fs, 3, 500), "mod": _int(ident, 5) == 1,
            "follower": _int(ident, 4) == 1, "gifter": _int(ident, 1) == 1}


def social(payload):
    """A WebcastSocialMessage: someone followed, or shared the live. Which one
    is TikTok's own action number (4) - 1 a follow, 3 a share - beside the key
    of the message's display text (common 1, displayText 8, key 1), which names
    it: pm_main_follow_message_viewer_2 for a follow, pm_mt_guidance_share for
    a share. Counted on real lives (2026-09-15): 18 follows and 133 shares, and
    the two always agreed. Both are read, because a bare number that changed
    meaning would otherwise announce followers nobody has."""
    fs = fields(payload)
    key = _text(fields(_bytes(fields(_bytes(fs, 1)), 8)), 1, 80).lower()
    return {"user": user(_bytes(fs, 2)), "action": _int(fs, 4), "key": key}


def is_webcast(url, allow_local=False):
    """The one socket whose frames are read: TikTok's webcast room socket,
    wss://webcast...tiktok.com/webcast/im/... Every other socket on the page
    is dropped unread. `allow_local` is the rig's fixture, on 127.0.0.1."""
    try:
        u = urlparse(url or "")
        host = (u.hostname or "").lower()
    except ValueError:
        return False
    if not (u.path or "").startswith("/webcast/im/"):
        return False
    if u.scheme == "wss" and _HOST.fullmatch(host):
        return True
    return bool(allow_local) and u.scheme == "ws" and host in ("127.0.0.1", "localhost")


# ------------------------------------------------------------ streaks

class Combos:
    """TikTok sends a streak of the same gift as a run of messages, each with
    the total so far, and a last one flagged as the end. Counting each as a
    gift is the classic way to get this wrong - five Roses would throw
    1+2+3+4+5 - so only a finished gift leaves here: a one-off at once, a
    streak at its end with its total, or, if the end never comes (the page
    reconnected mid-streak), its last total once it has been quiet for QUIET
    seconds. A late message for a streak that already finished is dropped
    rather than starting it over."""

    QUIET = 8.0
    ENDED = 120.0
    MAX_OPEN = 500
    MAX_ENDED = 5000

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.open = OrderedDict()        # key -> (gift, when last heard)
        self.ended = OrderedDict()       # key -> when it finished

    @staticmethod
    def key(g):
        return (g["user"]["id"], g["id"], g["group"])

    def add(self, g):
        if not g["streak"]:
            return [g]
        now, k = self.clock(), self.key(g)
        self._forget(now)
        if k in self.ended:
            return []
        was = self.open.pop(k, None)
        if was and was[0]["count"] > g["count"]:
            g = dict(g, count=was[0]["count"])        # a total never goes back
        if g["end"]:
            self._finish(k, now)
            return [g]
        self.open[k] = (g, now)
        fired = []
        while len(self.open) > self.MAX_OPEN:
            k0, (g0, _) = self.open.popitem(last=False)
            self._finish(k0, now)
            fired.append(g0)
        return fired

    def due(self):
        """Streaks whose end never came, once quiet for QUIET seconds."""
        now = self.clock()
        out = []
        for k, (g, at) in list(self.open.items()):
            if now - at >= self.QUIET:
                del self.open[k]
                self._finish(k, now)
                out.append(g)
        return out

    def _finish(self, k, now):
        # Without a streak id a new streak of the same gift from the same
        # person would look like a late message from the last one, and be
        # dropped; so only streaks that have one are remembered.
        if k[2]:
            self.ended[k] = now
            while len(self.ended) > self.MAX_ENDED:
                self.ended.popitem(last=False)

    def _forget(self, now):
        while self.ended:
            k, at = next(iter(self.ended.items()))
            if now - at < self.ENDED:
                break
            del self.ended[k]


class Seen:
    """Message ids already handled, the newest `keep` of them: a socket that
    reconnects can hand the same message over twice."""

    def __init__(self, keep=4096):
        self.keep = keep
        self.ids = OrderedDict()

    def first(self, mid):
        if not mid:
            return True
        if mid in self.ids:
            return False
        self.ids[mid] = True
        if len(self.ids) > self.keep:
            self.ids.popitem(last=False)
        return True


# ------------------------------------------------------------ one page

class Room:
    """One live page's webcast traffic, in; chat lines and finished gifts, out.
    Fed by the reader's DevTools events: which sockets are TikTok's room
    socket, and the frames they receive. `heard` is when the room socket last
    opened or delivered, which is how the reader knows the page's own drawing
    of the chat is not needed."""

    def __init__(self, channel, allow_local=False, clock=time.monotonic):
        self.channel = channel
        self.allow_local = allow_local
        self.clock = clock
        self.sockets = set()
        self.seen = Seen()
        self.combos = Combos(clock)
        self.frames = 0
        self.bad = 0
        self.gifts = 0
        self.chats = 0
        self.follows = 0
        self.heard = float("-inf")
        # Which live this is: TikTok's room id, from the room socket's address
        # - 19 digits on every real live, and the same number every message on
        # it carries in its header (common, field 3; seen 2026-09-15).
        self.room_id = ""

    def opened(self, request_id, url):
        if request_id and is_webcast(url, self.allow_local):
            self.sockets.add(request_id)
            self.heard = self.clock()
            rid = dict(parse_qsl(urlparse(url).query)).get("room_id") or ""
            if rid.isdigit() and len(rid) <= 25:
                self.room_id = rid

    def closed(self, request_id):
        self.sockets.discard(request_id)

    def frame(self, request_id, opcode, data):
        """One frame the page received, as events: {"kind": "chat", ...} for
        a line of chat, with the sender's @handle, and {"kind": "gift", ...}
        for a finished gift, in the shape server.py's post_gift takes; [] for
        everything else."""
        if request_id not in self.sockets or opcode != 2:
            return []
        if len(data) > MAX_B64:
            self.bad += 1
            return []
        try:
            msgs = messages(base64.b64decode(data, validate=True))
        except ValueError:                   # Bad, and base64's own error
            self.bad += 1
            return []
        self.frames += 1
        self.heard = self.clock()
        out = []
        for method, payload, mid, history in msgs:
            if method not in (GIFT, CHAT, SOCIAL) or history or not self.seen.first(mid):
                continue
            try:
                if method == CHAT:
                    out += self._said(chat(payload))
                    continue
                if method == SOCIAL:
                    out += self._followed(social(payload))
                    continue
                g = gift(payload)
            except Bad:
                self.bad += 1
                continue
            # Sent to a guest on a shared live, not to this page's host.
            if not g or (g["to"] and g["to"] != self.channel):
                continue
            out += self._done(self.combos.add(g))
        return out

    def due(self):
        return self._done(self.combos.due())

    def _said(self, c):
        text = c["text"].strip()
        if not text:
            return []
        self.chats += 1
        u = c["user"]
        return [{"kind": "chat", "user": u["name"] or u["handle"] or "Someone", "handle": u["handle"],
                 "text": text, "mod": c["mod"], "follower": c["follower"], "gifter": c["gifter"]}]

    def _followed(self, s):
        """A follow, and only a follow: the action and the template id have to
        agree (social). A share is not something this app shows."""
        if s["action"] != 1 or "follow" not in s["key"]:
            return []
        u = s["user"]
        self.follows += 1
        return [{"kind": "follow", "user": u["name"] or u["handle"] or "Someone",
                 "handle": u["handle"], "avatar_url": u["avatar"]}]

    def _done(self, finished):
        out = []
        for g in finished:
            self.gifts += 1
            out.append({"kind": "gift", "user": g["user"]["name"] or g["user"]["handle"] or "Someone",
                        "handle": g["user"]["handle"], "gift": g["name"] or "a gift",
                        "count": g["count"], "coins": min(g["coins"] * g["count"], 1_000_000),
                        "avatar_url": g["user"]["avatar"]})
        return out
