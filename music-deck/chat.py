"""
Chat, ingested: one message shape, one adapter per service.

The point of this module is that the rest of the app never learns what
Twitch is. An adapter connects to a service, translates whatever it speaks
into the single message shape below, and hands it to the hub; everything
downstream - the panel, the command engine, the queue - sees only that shape.
A fourth service is a new adapter and nothing else.

Twitch first, over TLS IRC on irc.chat.twitch.tv:6697. The plan said "IRC
over websocket", which is the right framing for a browser; this runs in the
server, where the app's WebSocket class is explicitly the *server* side (it
writes no mask bit, and RFC 6455 requires client-to-server frames to be
masked). Wrapping IRC in a WebSocket we would first have to write a client
half of buys nothing, so this speaks IRC to the socket directly.

Reading a public channel needs no account: an anonymous `justinfan` nick is
enough. This module therefore holds no credential of any kind, which is the
reason it can exist without the conversation the stream key needed.

Nothing here reaches out on import. The hub is inert until something calls
connect().
"""

import json
import queue
import random
import re
import socket
import ssl
import threading
import time
from collections import deque

RECENT = 300               # messages kept for a page that opens late
# Per subscriber, and deliberately far deeper than the state feed's 8. That
# hub fans out whole snapshots, where a dropped one is superseded by the next,
# so a slow page loses freshness and nothing else. A dropped chat message is
# simply gone - and a burst long enough to overrun a queue is exactly the busy
# moment when the messages matter most. Measured: 40 lines sent back to back
# reached a page as 12. Still bounded, so a wedged page cannot grow it forever.
QUEUE_DEPTH = 512
BACKOFF_MAX_S = 30
MAX_TEXT = 500             # Twitch's own limit; a defence against a bad line
LINE_CAP = 8192

TWITCH_HOST = "irc.chat.twitch.tv"
TWITCH_PORT = 6697

# What an anonymous reader is called. Twitch accepts any justinfan<digits>.
def _anon_nick():
    return "justinfan%d" % random.randint(10000, 99999)


# ------------------------------------------------------------------ the shape

SYMBOL_DEFAULT = "!"
MAX_SYMBOLS = 4
# Module state, where songreq.py and captions.py would take a configure() on
# an object. The reason is the sentence in message() below: the command is
# filled in centrally so that "!queue" means the same thing whichever service
# it arrived from. Hand the symbol to each adapter instead and two services
# could disagree about what starts a command, which is the one property this
# function exists to guarantee. There is one setting, so there is one place.
_symbols = (SYMBOL_DEFAULT,)


def set_symbols(value):
    """What starts a command. Returns what was accepted, which is what the
    caller should save and show - a refused character is not kept quietly.

    A letter or a digit is refused, and that is why this validates at all:
    with "a" as the symbol every word starting with one becomes a command, so
    "apple" would run "pple". Whitespace goes for the same reason. Several are
    allowed ("!/" is both), because a streamer moving from one to the other
    should not have to break every viewer's habit on the day they switch.

    Nothing usable left falls back to "!" rather than to nothing at all: a
    chat where no command can ever fire looks like the app is broken, and the
    setting that did it would be invisible.
    """
    chars = []
    for ch in str(value or ""):
        if ch.isalnum() or ch.isspace() or ch in chars:
            continue
        chars.append(ch)
    global _symbols
    _symbols = tuple(chars[:MAX_SYMBOLS]) or (SYMBOL_DEFAULT,)
    return "".join(_symbols)


def symbols():
    """What starts a command right now, for whatever has to show it."""
    return "".join(_symbols)


def message(service, channel, text, user=None, badges=None, at=None, mid="",
            action=False, system=False, symbols=None):
    """The one shape. Every adapter returns this and nothing else.

    `command` is filled in here rather than by each adapter, so "!queue" means
    the same thing whichever service it arrived from - which is what S12 hangs
    off. polls.py leans on it too: a vote is "!1" read as the command "1", and
    its header says outright that there is no second parser. So this is the
    only place the symbol is read, and changing it here carries commands, song
    requests and poll votes along with it.

    `symbols` is for tests, which should not have to reach into module state
    to ask a question about parsing.
    """
    text = (text or "")[:MAX_TEXT]
    cmd, args = "", ""
    marks = tuple(symbols) if symbols else _symbols
    if text[:1] in marks and len(text) > 1 and not text[1].isspace():
        word, _, rest = text[1:].partition(" ")
        cmd, args = word.lower()[:32], rest.strip()
    u = dict(user or {})
    return {
        "service": service,
        "channel": channel,
        "id": mid or ("%s-%.6f-%d" % (service, time.time(), random.randint(0, 999999))),
        "at": float(at if at is not None else time.time()),
        "user": {"id": str(u.get("id") or ""), "login": str(u.get("login") or ""),
                 "name": str(u.get("name") or u.get("login") or ""),
                 "color": str(u.get("color") or "")},
        "badges": list(badges or []),
        "text": text,
        "command": cmd,
        "args": args,
        "action": bool(action),
        "system": bool(system),
    }


# ------------------------------------------------------------------ IRCv3

_TAG_UNESCAPE = {"\\:": ";", "\\s": " ", "\\\\": "\\", "\\r": "\r", "\\n": "\n"}
_ESCAPE_RE = re.compile(r"\\[\\:snr]")


def unescape_tag(value):
    """IRCv3 tag values escape ; space \\ CR and LF. A lone trailing backslash
    is dropped, which is what the spec says to do with a stray escape."""
    if "\\" not in value:
        return value
    out = _ESCAPE_RE.sub(lambda m: _TAG_UNESCAPE[m.group(0)], value)
    return out[:-1] if out.endswith("\\") else out


def parse_line(line):
    """One IRC line -> (tags, prefix, command, params).

    The last parameter may be introduced by a colon, in which case it runs to
    the end of the line and may contain spaces and further colons - which is
    exactly where a naive split falls over on a message that mentions a URL.
    """
    tags, prefix = {}, ""
    rest = (line or "").strip("\r\n")[:LINE_CAP]
    if rest.startswith("@"):
        raw, _, rest = rest.partition(" ")
        for part in raw[1:].split(";"):
            if not part:
                continue
            key, sep, value = part.partition("=")
            tags[key] = unescape_tag(value) if sep else ""
    if rest.startswith(":"):
        prefix, _, rest = rest[1:].partition(" ")
    trailing = None
    head = rest
    if " :" in rest:
        head, _, trailing = rest.partition(" :")
    elif rest.startswith(":"):
        head, trailing = "", rest[1:]
    bits = [b for b in head.split(" ") if b]
    command = bits[0].upper() if bits else ""
    params = bits[1:]
    if trailing is not None:
        params.append(trailing)
    return tags, prefix, command, params


def _badges(tags):
    raw = tags.get("badges") or ""
    return [b for b in raw.split(",") if b]


def _nick(prefix):
    return prefix.split("!", 1)[0] if prefix else ""


ACTION = "\x01ACTION "


def twitch_message(tags, prefix, params):
    """A Twitch PRIVMSG in the shape above."""
    channel = (params[0][1:] if params and params[0].startswith("#") else (params[0] if params else ""))
    text = params[1] if len(params) > 1 else ""
    action = text.startswith(ACTION) and text.endswith("\x01")
    if action:
        text = text[len(ACTION):-1]
    ts = tags.get("tmi-sent-ts")
    at = (float(ts) / 1000.0) if (ts or "").isdigit() else None
    login = _nick(prefix)
    return message(
        "twitch", channel, text,
        user={"id": tags.get("user-id", ""), "login": login,
              "name": tags.get("display-name") or login, "color": tags.get("color", "")},
        badges=_badges(tags), at=at, mid=tags.get("id", ""), action=action)


# ------------------------------------------------------------------ adapters

class Adapter:
    """What every service must be. start/stop/status, and messages handed to
    `on_message`; nothing else is allowed out."""

    service = "?"

    def __init__(self, channel, on_message, log=None):
        self.channel = (channel or "").lstrip("#").lower()
        self.on_message = on_message
        self.log = log or (lambda *_: None)
        self.state = "idle"          # idle | connecting | joined | reconnecting | failed
        self.error = ""
        self.messages = 0
        self.reconnects = 0
        self._stop = threading.Event()
        self._thread = None

    def status(self):
        return {"service": self.service, "channel": self.channel, "state": self.state,
                "error": self.error, "messages": self.messages, "reconnects": self.reconnects}

    def start(self):
        if self._thread and self._thread.is_alive():
            return False
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name=self.service + " chat")
        self._thread.start()
        return True

    def stop(self):
        self._stop.set()
        t = self._thread
        if t and t.is_alive():
            t.join(3)
        self._thread = None
        self.state = "idle"

    def _set(self, state, error=""):
        self.state, self.error = state, error

    def _run(self):
        raise NotImplementedError


class TwitchAdapter(Adapter):
    """Anonymous read of one public channel, over TLS IRC.

    The loop is LiveEngine's: connect, reset the backoff on success, and on a
    drop wait on the stop event rather than sleeping - so quitting is instant
    instead of taking however long the backoff had grown to.
    """

    service = "twitch"
    # Where to connect, and whether to wrap the socket in TLS. Overridden only
    # by the rig check, which stands a plain IRC server up on localhost: the
    # alternative is mocking the socket, which would exercise the mock rather
    # than the reading, the reconnect and the PING answer that actually break.
    host = TWITCH_HOST
    port = TWITCH_PORT
    tls = True

    def _run(self):
        backoff = 1
        while not self._stop.is_set():
            sock = None
            try:
                self._set("connecting")
                sock = self._connect()
                self._set("joined")
                backoff = 1
                self._read(sock)
                if self._stop.is_set():
                    return
                text = "the server closed the connection"
            except OSError as exc:
                text = str(exc) or exc.__class__.__name__
            except _Fatal as exc:
                self._set("failed", str(exc))
                self.log("chat: twitch: " + str(exc))
                return
            finally:
                if sock is not None:
                    try:
                        sock.close()
                    except OSError:
                        pass
            if self._stop.is_set():
                return
            self.reconnects += 1
            self._set("reconnecting", text)
            if self._stop.wait(backoff):
                return
            backoff = min(BACKOFF_MAX_S, backoff * 2)

    def _connect(self):
        raw = socket.create_connection((self.host, self.port), timeout=15)
        sock = (ssl.create_default_context().wrap_socket(raw, server_hostname=self.host)
                if self.tls else raw)
        sock.settimeout(360)          # Twitch pings every five minutes
        send = lambda s: sock.sendall((s + "\r\n").encode("utf-8"))
        # tags carries the badges, color, display name and message id; commands
        # carries the notices that say a join went wrong.
        send("CAP REQ :twitch.tv/tags twitch.tv/commands")
        send("NICK " + _anon_nick())
        send("JOIN #" + self.channel)
        self.log("chat: twitch: reading #%s" % self.channel)
        return sock

    def _read(self, sock):
        buf = b""
        while not self._stop.is_set():
            try:
                chunk = sock.recv(8192)
            except socket.timeout:
                return                      # nothing in six minutes: reconnect
            if not chunk:
                return
            buf += chunk
            if len(buf) > LINE_CAP * 8:
                buf = buf[-LINE_CAP:]       # a line that never ends is not one
            while b"\r\n" in buf:
                line, _, buf = buf.partition(b"\r\n")
                self._line(sock, line.decode("utf-8", "replace"))

    def _line(self, sock, line):
        tags, prefix, command, params = parse_line(line)
        if command == "PING":
            sock.sendall(("PONG :" + (params[0] if params else "tmi.twitch.tv") + "\r\n").encode())
            return
        if command == "PRIVMSG":
            self.messages += 1
            self.on_message(twitch_message(tags, prefix, params))
            return
        if command == "NOTICE":
            text = params[-1] if params else ""
            if "authentication failed" in text.lower() or "improperly formatted" in text.lower():
                raise _Fatal(text)
            self.log("chat: twitch: " + text)


class _Fatal(Exception):
    """Something retrying will not fix."""


ADAPTERS = {"twitch": TwitchAdapter}


# ------------------------------------------------------------------ the hub

class ChatHub:
    """Every adapter's messages, fanned out to pages and kept briefly.

    subscribe/unsubscribe are the same contract the state feed uses, so the
    WebSocket endpoint serving chat is the state feed's endpoint with a
    different queue - and a page that cannot keep up drops messages instead of
    growing a queue without end.
    """

    def __init__(self, log=None):
        self.log = log or (lambda *_: None)
        self._subs = []
        self._watchers = []
        self._lock = threading.Lock()
        self._recent = deque(maxlen=RECENT)
        self._adapters = {}
        self.dropped = 0
        self.total = 0

    # -- fan-out
    def subscribe(self):
        q = queue.Queue(maxsize=QUEUE_DEPTH)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def watch(self, fn):
        """Something in the server that wants every message as it arrives - the
        command engine, and whatever S13 to S15 add. Pages use subscribe(); a
        watcher is in-process and is called directly, so it must be quick."""
        with self._lock:
            self._watchers.append(fn)

    def post(self, msg):
        payload = json.dumps(msg)
        with self._lock:
            self._recent.append(msg)
            self.total += 1
            subs = list(self._subs)
            watchers = list(self._watchers)
        for q in subs:
            try:
                q.put_nowait(payload)
            except queue.Full:
                self.dropped += 1       # a page that cannot keep up misses some
        # Pages first, then the watchers, and each of them guarded: a watcher
        # that throws must not stop the others or the reading loop that called
        # us, and none of this runs under the lock - a watcher that took it
        # would deadlock the next message.
        for fn in watchers:
            try:
                fn(msg)
            except Exception as exc:
                self.log(f"chat: a watcher failed: {exc}")

    def recent(self, limit=100):
        with self._lock:
            items = list(self._recent)
        return items[-max(0, min(int(limit or 0), RECENT)):]

    # -- adapters
    def connect(self, service, channel):
        service = (service or "").lower()
        maker = ADAPTERS.get(service)
        if not maker:
            return {"ok": False, "error": "no adapter for " + (service or "?")}
        if not (channel or "").strip():
            return {"ok": False, "error": "a channel is needed"}
        self.disconnect(service)
        ad = maker(channel, self.post, self.log)
        with self._lock:
            self._adapters[service] = ad
        ad.start()
        return {"ok": True, "status": ad.status()}

    def disconnect(self, service):
        with self._lock:
            ad = self._adapters.pop((service or "").lower(), None)
        if ad:
            ad.stop()
        return {"ok": True}

    def stop(self):
        for service in list(self._adapters):
            self.disconnect(service)

    def status(self):
        with self._lock:
            ads = [a.status() for a in self._adapters.values()]
        return {"services": ads, "kept": len(self._recent), "total": self.total,
                "dropped": self.dropped, "subscribers": len(self._subs)}

    def snapshot(self):
        """For the state feed: what changes rarely. Never the messages.

        `total` is the exception, and it is not rare at all - it ticks on
        every message. server.py's _change_key drops it before deciding
        whether anything changed, because left in, a busy chat put the whole
        state on the wire every pump tick: one send per 0.41 s against 2.00 s
        idle, for a number no page draws. Any counter added here needs the
        same treatment, and tools/ui/keyleak.js is what notices if it does
        not get it.
        """
        with self._lock:
            ads = [{"service": a.service, "channel": a.channel, "state": a.state, "error": a.error}
                   for a in self._adapters.values()]
        return {"services": ads, "total": self.total}
