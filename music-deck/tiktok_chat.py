"""
TikTok chat (T4, T5): read from the streamer's own logged-in TikTok page.

TikTok publishes no API for live-room events, and every community client signs
its requests through somebody else's server. On 2026-09-15 the user chose the
route where nothing leaves this machine: a Chrome window of its own, which they
sign into TikTok themselves, open on their live page - and this reads the chat
the way the page draws it.

How it reads, and what it never does:

  * A Chrome of its own (cache/chrome-tiktok), started with a DevTools port on
    127.0.0.1 - one free when chosen, never port 0 (free_port says why) -
    written into the profile's DevToolsActivePort. This connects to that port, installs
    one binding, and injects OBSERVER, which watches the chat list and hands
    each new line to the binding. The page sends nothing anywhere else.
  * Hidden (headless) unless the streamer asks to see it, to sign in there -
    which is also how every check on real lives ran it. Either way it is
    stopped by asking Chrome to quit, so a sign-in is saved (close_browser).
  * OBSERVER only reads. It never clicks, submits or navigates. The page is the
    user's, signed in as them, and a script that could press things there
    could press Go LIVE (NEVER GO LIVE, 2026-09-15).
    tests/test_tiktok_chat.py holds it to that.
  * The window starts muted. The live page plays the user's own stream back to
    them, and unmuted, Desktop sound would feed it into the stream again.
  * What is on screen when it attaches is history: marked seen, never sent. A
    reader that joined late must not replay ten minutes of !tts.
  * It goes where it is pointed and nowhere else: www.tiktok.com/@you/live.
    The rig points it at a local fixture instead (TEST_RIG only), headless.
  * Gifts are never drawn into the chat list; the page receives them on its
    own websocket to TikTok's webcast servers. So the connection also watches
    the page's network, read only, and hands the frames of that one socket -
    never any other - to webcast.py (T6). The tab opens blank and is sent to
    the live page only once that watching has begun, or the socket would open
    unseen, and the gifts with it.

The fragile part, named plainly: the selectors are TikTok's page, which TikTok
changes when it likes. They are all in OBSERVER, and the page reports what it
can see - a chat list or not, signed in or not - so the chat panel says which
part stopped matching instead of simply going quiet.
"""

import base64
import io
import json
import os
import re
import socket
import struct
import subprocess
import time
import urllib.request
from urllib.parse import urlparse

import chat
import webcast

TIKTOK = "https://www.tiktok.com"
NAME_RE = re.compile(r"^[a-z0-9._]{2,24}$")
BINDING = "__asdTikTok"
START_TIMEOUT = 25
MAX_FRAME = 16 * 1024 * 1024
# Chat comes from the room socket (webcast.py), which carries each sender's
# @handle and marks the backlog. The page's own drawing of the chat is the
# fallback, used only when no room socket has been heard from: never in the
# first PAGE_WAIT seconds after the page opens - when TikTok draws its backlog,
# before its socket is up - and never while the socket was heard from within
# SOCKET_FRESH seconds.
PAGE_WAIT = 15
SOCKET_FRESH = 60
# Opened before the streamer is live, the live page shows the live has ended
# and opens no room socket (seen 2026-09-15). Whether TikTok's page moves on to
# the live by itself when it starts was not seen either way - it asks
# check_alive every five seconds, about what is its business - so the reader
# does not wait to find out: with no room socket since the page loaded, it
# opens the page again after `reopen_first` seconds (a class attribute, which
# the rig shortens), then twice as long each time up to REOPEN_MAX, and never
# while the streamer is typing in that window.
REOPEN_MAX = 300

# Muted, so the live page's own sound never reaches Desktop sound; and kept
# awake behind other windows, or Chrome throttles the page and the chat stalls.
FLAGS = ["--no-first-run", "--no-default-browser-check", "--mute-audio",
         "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
         "--disable-renderer-backgrounding", "--disable-features=Translate,CalculateNativeWinOcclusion",
         "--window-size=460,820"]

# The page half. Read-only by design: it reads the chat list and calls the
# binding, and nothing else - no clicks, no form posts, no navigation, no
# requests of its own. Selectors are TikTok's, as its live page drew them in
# September 2026; several per part, because TikTok renames class names often
# and its data-e2e attributes rarely.
OBSERVER = r"""(() => {
  if (window.__asdReading) return;
  window.__asdReading = true;
  const send = (o) => { try { window.__asdTikTok(JSON.stringify(o)); } catch (_) { /* not bound yet */ } };
  const ROOMS = ['[data-e2e="chat-room"]', '[class*="DivChatRoomContent"]', '.live-shared-ui-chat-list-scrolling-list',
                 '[data-e2e="live-chat-container"]', '[data-e2e="public-screen-live-chat-slot"]'];
  const MSG = '[data-e2e="chat-message"]';
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const seen = new Set(), order = [];
  const fresh = (k) => {
    if (seen.has(k)) return false;
    seen.add(k); order.push(k);
    if (order.length > 800) seen.delete(order.shift());
    return true;
  };
  function read(m) {
    const who = m.querySelector('[data-e2e="message-owner-name"]');
    const name = clean(who && (who.textContent || who.getAttribute('title')));
    // The words. Checked against TikTok's real page on 2026-09-15: the old
    // -DivComment class is gone and the words sit in a utility-classed element
    // (break-words) right after the row holding the name. So after the class
    // names, the rule is structural - the first element after the name's row,
    // never past the line itself - which holds whatever the classes are called.
    // Measured again later that day against the room socket's copy of the
    // same lines: the first break-words element holds the name's row as well
    // as the words, which sit in a second break-words inside it - so every
    // line came out as the name and the words. The words are the last such
    // element that does not hold the name.
    const marked = [...m.querySelectorAll('.break-words')].filter((b) => !who || !b.contains(who));
    let body = marked.pop() || m.querySelector("[class*='-DivComment']") ||
      m.querySelector('.live-shared-ui-chat-list-chat-message-comment');
    if (!body && who) {
      let row = who;
      while (row.parentElement && row.parentElement !== m && !row.nextElementSibling) row = row.parentElement;
      body = row.parentElement && row.parentElement !== m ? row.nextElementSibling : null;
    }
    const text = clean(body && body.textContent);
    if (!name || !text) return null;
    const link = m.querySelector('a[href*="/@"]');
    const login = link ? (((link.getAttribute('href') || '').match(/\/@([A-Za-z0-9._]+)/) || [])[1] || '') : '';
    const pics = [...m.querySelectorAll('img')].map((i) => i.getAttribute('src') || '');
    const role = pics.some((s) => /\/moderat[oe]r_/.test(s)) ? 'moderator' : pics.some((s) => /\/subs?_/.test(s)) ? 'subscriber' : '';
    const slot = m.closest('[data-index]');
    return { key: (slot ? slot.getAttribute('data-index') : '') + '|' + login + '|' + name + '|' + text, name, login, text, role };
  }
  const each = (root, fn) => {
    if (!root || root.nodeType !== 1) return;
    if (root.matches(MSG)) fn(root);
    root.querySelectorAll(MSG).forEach(fn);
  };
  const offer = (m) => {
    const r = read(m);
    if (r && fresh(r.key)) send({ t: 'chat', name: r.name, login: r.login, text: r.text, role: r.role });
  };
  let room = null, watcher = null, last = '', lastAt = 0;
  function attach() {
    // Whichever container really holds chat lines; TikTok's page has had two
    // at once (live-chat-container and public-screen-live-chat-slot).
    const all = ROOMS.map((s) => document.querySelector(s)).filter(Boolean);
    const r = all.find((x) => x.querySelector(MSG)) || all[0] || null;
    if (r === room) return;
    if (watcher) watcher.disconnect();
    watcher = null;
    room = r;
    if (!r) return;
    // Already on screen means already said: seen, never sent.
    each(r, (m) => { const x = read(m); if (x) fresh(x.key); });
    watcher = new MutationObserver((changes) => {
      for (const c of changes) {
        if (c.type === 'childList') c.addedNodes.forEach((n) => each(n, offer));
        // A recycled slot, rewritten in place rather than replaced.
        const t = c.target.nodeType === 1 ? c.target : c.target.parentElement;
        const m = t && t.closest ? t.closest(MSG) : null;
        if (m) offer(m);
      }
    });
    watcher.observe(r, { childList: true, subtree: true, characterData: true });
  }
  function tick() {
    attach();
    // Nobody watches this window, so its video need not cost this PC anything.
    document.querySelectorAll('video').forEach((v) => { try { v.muted = true; if (!v.paused) v.pause(); } catch (_) {} });
    // Signed out shows a Log in button, and TikTok draws it more than one way:
    // on 2026-09-15 one real room page had button#header-login-button, the next
    // a plain button that only says "Log in" - and the top-login-button first
    // looked for was on neither, which is how a signed-out page read as signed
    // in. So the words are checked as well as the names. (English words: the
    // page follows the account's language, and this user's is English.)
    const signedOut = !!document.querySelector('[data-e2e="top-login-button"], #header-login-button') ||
      [...document.querySelectorAll('button')].some((b) => /^log ?in$/i.test((b.textContent || '').trim()));
    // This runs from the first moment of the page (T6: the tab is watched
    // before the page loads), when there is no Log in button to find yet and
    // no chat list either. That is "not known yet", not "signed in".
    // Whether a text field has focus - never what is in it - so the reader
    // never opens the page again under someone typing (REOPEN_MAX).
    const f = document.activeElement;
    const typing = !!(f && f.matches && f.matches('input, textarea, [contenteditable=""], [contenteditable="true"]'));
    const state = { t: 'status', room: !!room, signedIn: signedOut ? false : room ? true : null,
                    path: location.pathname, typing };
    const k = JSON.stringify(state);
    if (k !== last || Date.now() - lastAt > 10000) { last = k; lastAt = Date.now(); send(state); }
  }
  tick();
  setInterval(tick, 2000);
})();"""


# ------------------------------------------------------------ the WebSocket

def frame(payload, opcode=1, mask=None):
    """One client frame, FIN set, masked as RFC 6455 requires of a client."""
    data = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)
    mask = mask if mask is not None else os.urandom(4)
    n = len(data)
    if n < 126:
        head = bytes([0x80 | opcode, 0x80 | n])
    elif n < 65536:
        head = bytes([0x80 | opcode, 0x80 | 126]) + struct.pack(">H", n)
    else:
        head = bytes([0x80 | opcode, 0x80 | 127]) + struct.pack(">Q", n)
    return head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data))


def frame_end(buf):
    """How many bytes the first frame in `buf` takes, or None if it is not all
    there yet. Nothing is consumed until a frame is whole, so a timeout in the
    middle of one can never leave the stream out of step."""
    if len(buf) < 2:
        return None
    n, off = buf[1] & 0x7F, 2
    if n == 126:
        if len(buf) < 4:
            return None
        n, off = struct.unpack(">H", buf[2:4])[0], 4
    elif n == 127:
        if len(buf) < 10:
            return None
        n, off = struct.unpack(">Q", buf[2:10])[0], 10
    if n > MAX_FRAME:
        raise OSError("DevTools sent a frame too large to be sane")
    if buf[1] & 0x80:
        off += 4
    return off + n if len(buf) >= off + n else None


def read_frame(raw):
    """(opcode, fin, payload) from one whole frame."""
    f = io.BytesIO(raw)
    b0, b1 = f.read(2)
    n = b1 & 0x7F
    if n == 126:
        n = struct.unpack(">H", f.read(2))[0]
    elif n == 127:
        n = struct.unpack(">Q", f.read(8))[0]
    mask = f.read(4) if b1 & 0x80 else None
    data = f.read(n)
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return b0 & 0x0F, bool(b0 & 0x80), data


class Cdp:
    """A DevTools connection to one page: the smallest WebSocket client that
    does the job, on the standard library, like the rest of the app."""

    def __init__(self, ws_url, timeout=10):
        u = urlparse(ws_url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\n"
                           f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise OSError("DevTools closed the connection")
            head += chunk
            if len(head) > 65536:
                raise OSError("DevTools sent no handshake")
        status, _, rest = head.partition(b"\r\n\r\n")
        if b" 101 " not in status.split(b"\r\n", 1)[0]:
            raise OSError("DevTools refused the connection")
        self._buf = rest
        self._parts = b""
        self.id = 0

    def send(self, method, params=None):
        self.id += 1
        self.sock.sendall(frame(json.dumps({"id": self.id, "method": method, "params": params or {}})))
        return self.id

    def recv(self):
        """The next whole message as a dict, or None when the socket's timeout
        passed with nothing - so the reader can check whether to stop."""
        while True:
            end = frame_end(self._buf)
            if end is None:
                try:
                    chunk = self.sock.recv(65536)
                except socket.timeout:
                    return None
                if not chunk:
                    raise OSError("DevTools closed the connection")
                self._buf += chunk
                continue
            raw, self._buf = self._buf[:end], self._buf[end:]
            op, fin, data = read_frame(raw)
            if op == 9:                                  # ping
                self.sock.sendall(frame(data, opcode=10))
                continue
            if op == 8:
                raise OSError("DevTools closed the connection")
            if op not in (0, 1):
                continue
            self._parts += data
            if not fin:
                continue
            text, self._parts = self._parts, b""
            try:
                return json.loads(text.decode("utf-8", "replace"))
            except ValueError:
                continue

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# ------------------------------------------------------------ helpers

def free_port():
    """A DevTools port for the reader's window: one this PC has free now.

    Not --remote-debugging-port=0, which has Chrome pick the port and write
    it down itself - the obvious way, and the first version's. Checked on real
    live pages on 2026-09-15: a Chrome launched that way loads TikTok's live
    page but never enters the room - room/enter refused, no webcast socket,
    no chat drawn - while the same Chrome given a fixed port, high or low,
    reads it. Why is TikTok's business; the reader never asks for port 0."""
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def devtools_port(profile):
    """The reader window's port, from the file written into its profile."""
    try:
        with open(os.path.join(profile, "DevToolsActivePort"), encoding="utf-8") as f:
            return int(f.readline().strip())
    except (OSError, ValueError):
        return None


def _http(port, path, method="GET"):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method)
    with urllib.request.urlopen(req, timeout=3) as r:
        return r.read().decode("utf-8", "replace")


def _alive(port):
    try:
        _http(port, "/json/version")
        return True
    except OSError:
        return False


# Which Chrome the reader started, kept in its profile beside the port file:
# its kind - "hidden" (headless) or "shown" (a window) - and its browser id.
MODE_FILE = "asd-window"


def _browser_id(port):
    """The DevTools address of the Chrome on `port` itself,
    /devtools/browser/<id>: new each time a Chrome starts, and no other Chrome
    answers to it. "" if nothing answers."""
    try:
        path = urlparse(json.loads(_http(port, "/json/version")).get("webSocketDebuggerUrl") or "").path
    except (OSError, ValueError, AttributeError):
        return ""
    return path if path.startswith("/devtools/browser/") else ""


def reader_on(profile):
    """(port, kind, browser id) of the reader's Chrome if the one answering on
    the port it wrote down is the one it started - the same browser id - and
    None otherwise: a Chrome that has since taken that port is someone else's,
    and is never closed or used. The kind is "hidden" or "shown"."""
    port = devtools_port(profile)
    try:
        with open(os.path.join(profile, MODE_FILE), encoding="utf-8") as f:
            kind, bid = (f.read().split() + ["", ""])[:2]
    except OSError:
        return None
    if not port or not bid.startswith("/devtools/browser/") or _browser_id(port) != bid:
        return None
    return port, "hidden" if kind == "hidden" else "shown", bid


def close_browser(port, bid):
    """Ask the reader's Chrome to quit, as its own Exit would: it saves its
    profile first - a sign-in made a moment ago included - which ending it
    outright could lose. Sent to its browser id, so any other Chrome refuses
    it. False if it could not be asked."""
    if not bid.startswith("/devtools/browser/"):
        return False
    try:
        c = Cdp(f"ws://127.0.0.1:{port}{bid}", timeout=3)
    except OSError:
        return False
    try:
        c.send("Browser.close", {})
        try:
            c.recv()                 # its answer, or the connection closing as it quits
        except OSError:
            pass
        return True
    except OSError:
        return False
    finally:
        c.close()


def close_hidden(profile):
    """Close a hidden reader Chrome still running from a run of the app that
    ended without stopping it. Nobody can see one to close it, so server.py
    calls this at the app's start, before any reader runs. A window is left
    alone: it is on screen, and the streamer may be using it."""
    known = reader_on(profile)
    if not known or known[1] != "hidden":
        return False
    return close_browser(known[0], known[2])


def _is_local(url):
    try:
        u = urlparse(url)
    except ValueError:
        return False
    return u.scheme == "http" and (u.hostname or "") in ("127.0.0.1", "localhost")


def to_message(channel, p):
    """One chat line from the page, in chat.py's one shape - or None.

    The streamer's own lines get the broadcaster badge only when the page gave
    a real profile link that names them. A display name is anybody's to set,
    and matching on it would let a viewer who called themselves the streamer
    through every gate on the ladder.
    """
    name = str(p.get("name") or "").strip()[:40]
    text = str(p.get("text") or "").strip()
    if not name or not text:
        return None
    linked = re.sub(r"[^a-z0-9._]", "", str(p.get("login") or "").lower())[:24]
    # With no handle - a line read from the page's drawing - the login is made
    # from the display name, and marked with "~", which no handle can hold: a
    # stranger calling themselves "Bob" must never be taken for @bob, whose
    # coins and gifts are counted by handle (gifts.py, commands' coin price).
    login = linked or "~" + re.sub(r"\s+", "", name.lower())[:40]
    role = p.get("role")
    badges = []
    if linked and linked == channel:
        badges.append("broadcaster/1")
    elif role == "moderator":
        badges.append("moderator/1")
    elif role == "subscriber":
        badges.append("subscriber/1")
    elif role == "follower":
        badges.append("follower/1")
    if p.get("gifter"):
        badges.append("gifter/1")        # commands.py puts gifters on the follower rung
    return chat.message("tiktok", channel, text, user={"id": login, "login": login, "name": name}, badges=badges)


# ------------------------------------------------------------ the adapter

class TikTokAdapter(chat.Adapter):
    """chat.py's Adapter, for TikTok: the channel is the username."""

    service = "tiktok"
    # Set once by server.py. The rig sets headless (never a window on the
    # user's screen) and may point `base` at its fixture; nothing else can.
    browser = None
    profile = ""
    headless = False
    base = TIKTOK
    allow_local_base = False
    # A finished gift, for server.py's post_gift (T6). Called through the
    # class, so it stays a plain function rather than becoming a method.
    on_gift = None
    # Coins a handle has gifted this stream (gifts.py's coins_from), set by
    # server.py - so a gifter is known the moment their gift lands, not only
    # once TikTok's own flag says so. Called through the class, like on_gift.
    gifted = None
    reopen_first = 60        # REOPEN_MAX says why

    def __init__(self, channel, on_message, log=None):
        super().__init__((channel or "").strip().lstrip("@#"), on_message, log)
        self.page = {"room": False, "signed_in": None, "path": ""}
        self.room = webcast.Room(self.channel, allow_local=self.allow_local_base)
        self._opened = time.monotonic()
        # Which page the window is on: the main frame's id and path, from
        # DevTools' own navigation events (_own).
        self._main = ""
        self._at = ""
        self.elsewhere = 0
        # Whether the page that last loaded has a live on it (_live), and when
        # to look again if not (_reopen_due).
        self._loaded_at = time.monotonic()
        self._drawn_at = float("-inf")
        self._wait = type(self).reopen_first
        self._looking = False
        self.looks = 0
        # When the window left the streamer's page (_navigated) - or opened, if
        # it has not been there yet: a hidden reader goes back after the wait.
        self._left_at = time.monotonic()
        # The kind this reader is, fixed now: the window switch sets the next
        # one's a moment before starting it (server.py).
        self.headless = type(self).headless
        self._proc = None
        self._bid = ""               # its Chrome's browser id, once started (reader_on)
        self._tab = ""
        self._port = None

    def status(self):
        live = self._live()
        # Once it has opened the page again it is plainly waiting, however
        # recently that last load was.
        waiting = self._own() and not live and (self._looking or time.monotonic() - self._loaded_at >= PAGE_WAIT)
        return dict(super().status(), page=dict(self.page, socket=bool(self.room.sockets), gifts=self.room.gifts,
                                                chat_from=self._chat_from(), own=self._own(), live=live,
                                                waiting=waiting, looks=self.looks, shown=not self.headless))

    def _live(self):
        """Has the page that last loaded shown a live - its room socket heard,
        or (the fallback) a line of its chat read - since it loaded?"""
        return self.room.heard >= self._loaded_at or self._drawn_at >= self._loaded_at

    def _reopen_due(self, now):
        """Time to open the streamer's own page again? Twice as long between
        looks each time; the wait starts over once there is a live.

        On their page with no live on it (REOPEN_MAX) - never under someone
        typing in the window. On any other page only when hidden: a window on
        screen is the streamer's to steer, but a hidden one has nobody to bring
        it back when TikTok moves an ended live on to another."""
        if not self._own():
            if not self.headless or now - self._left_at < self._wait:
                return False
            self._left_at = now
        elif self._live():
            self._wait = type(self).reopen_first
            self._looking = False
            return False
        elif (self.page.get("typing") and not self.headless) or now - self._loaded_at < self._wait:
            return False
        self._wait = min(self._wait * 2, REOPEN_MAX)
        self.looks += 1
        self._looking = True
        return True

    def _own(self):
        """Is the window on the streamer's own live page?

        Only then is anything read. TikTok's live page offers other lives, and
        one that has ended can move on to another - and a reader that read
        whatever the window showed would put a stranger's gifts on this
        stream, run their chat's commands, and read their chat aloud. So chat
        and gifts count only while the main frame is at /@<channel>/live, as
        DevTools reports each navigation - a full load (Page.frameNavigated)
        or TikTok moving within its one page (Page.navigatedWithinDocument)."""
        return self._at == f"/@{self.channel}/live"

    def _gifter(self, e):
        """Has this chatter gifted the streamer? TikTok's own flag (webcast.chat),
        or a coin in this stream's ledger under their @handle - the handle, not
        the display name, which anybody can copy."""
        if e.get("gifter"):
            return True
        gifted, handle = type(self).gifted, e.get("handle") or ""
        if not gifted or not handle:
            return False
        try:
            return gifted(handle) > 0
        except Exception:
            return False

    def _navigated(self, url):
        was = self._own()
        self._at = urlparse(url or "").path.lower().rstrip("/")
        if was and not self._own():
            self._left_at = time.monotonic()     # for a hidden reader's way back (_reopen_due)

    def _chat_from(self):
        """Where chat is being read from: the room socket, the page's drawing
        (the fallback), or not decided yet."""
        now = time.monotonic()
        if now - self.room.heard < SOCKET_FRESH:
            return "socket"
        return "" if now - self._opened < PAGE_WAIT else "page"

    def live_url(self):
        if not NAME_RE.match(self.channel):
            raise ValueError(f'"{self.channel}" is not a TikTok username - it is the part after @ in your profile link')
        base = (self.base or TIKTOK).rstrip("/")
        if base != TIKTOK and not (self.allow_local_base and _is_local(base)):
            raise ValueError("the TikTok reader only opens www.tiktok.com")
        return f"{base}/@{self.channel}/live"

    def _run(self):
        try:
            url = self.live_url()
        except ValueError as exc:
            self._set("failed", str(exc))
            return
        if not self.browser:
            self._set("failed", "Chrome was not found on this PC")
            return
        self._set("connecting")
        cdp = None
        try:
            self._port, ws_url, self._tab = self._open()
            cdp = Cdp(ws_url)
            cdp.sock.settimeout(1.0)
            # The tab is blank until all of this is in place, so the page's
            # first socket to TikTok - the one its gifts arrive on - opens in
            # view. Network.enable reads, as DevTools' Network tab reads; its
            # buffers are small because no response body is ever asked for.
            for method, params in (("Runtime.enable", {}), ("Page.enable", {}),
                                   ("Network.enable", {"maxTotalBufferSize": 1_000_000,
                                                       "maxResourceBufferSize": 100_000}),
                                   # What the reader costs is TikTok's page: its
                                   # animations. Asking for reduced motion - as
                                   # the Windows setting would - took the reader's
                                   # Chrome from about half a core to a third or
                                   # less on real lives, side by side, with the
                                   # same chat (DECISIONS, "What the reader costs").
                                   ("Emulation.setEmulatedMedia", {"features": [
                                       {"name": "prefers-reduced-motion", "value": "reduce"}]}),
                                   ("Runtime.addBinding", {"name": BINDING}),
                                   ("Page.addScriptToEvaluateOnNewDocument", {"source": OBSERVER}),
                                   ("Page.navigate", {"url": url})):
                cdp.send(method, params)
            self._opened = time.monotonic()
            self._set("joined")
            self.log(f"chat: tiktok: reading @{self.channel}")
            tick = time.monotonic()
            while not self._stop.is_set():
                msg = cdp.recv()
                if msg:
                    self._event(msg.get("method"), msg.get("params") or {})
                if time.monotonic() - tick >= 1:
                    tick = time.monotonic()
                    self._room_events(self.room.due())
                    if self._reopen_due(tick):
                        self.log("chat: tiktok: no live on the page yet - opening it again")
                        cdp.send("Page.navigate", {"url": url})
        except OSError as exc:
            if not self._stop.is_set():
                closed = "closed" in str(exc).lower() or "refused" in str(exc).lower()
                what = "the TikTok reader" if self.headless else "the TikTok window"
                self._set("failed", f"{what} was closed - press Open TikTok to open it again"
                          if closed else f"could not read {what}: {exc}")
                self.log("chat: tiktok: " + self.error)
        finally:
            if cdp:
                cdp.close()
            if self._stop.is_set():
                self._close()

    def _open(self):
        """(port, DevTools address, tab id) of a blank tab: one more in the
        reader's window if a window is wanted and one is running; otherwise the
        first of a new Chrome of the kind asked for - hidden (headless) or a
        window - once whatever else ran on this profile has quit."""
        os.makedirs(self.profile, exist_ok=True)
        known = reader_on(self.profile)
        if known:
            port, kind, bid = known
            if not self.headless and kind == "shown":
                t = json.loads(_http(port, "/json/new?about:blank", method="PUT"))
                if not t.get("webSocketDebuggerUrl"):
                    raise OSError("the TikTok window would not open a tab")
                return port, t["webSocketDebuggerUrl"], t.get("id", "")
            # A hidden one nobody can see, or the other kind than the one asked
            # for: asked to quit - so it saves its profile - before a new one.
            close_browser(port, bid)
            deadline = time.monotonic() + 10
            while _alive(port) and time.monotonic() < deadline and not self._stop.is_set():
                time.sleep(0.25)
            if _alive(port):
                raise OSError("the TikTok reader already running would not close")
        port_file = os.path.join(self.profile, "DevToolsActivePort")
        for name in (port_file, os.path.join(self.profile, MODE_FILE)):
            try:
                os.remove(name)
            except OSError:
                pass
        for _ in range(2):
            if self._stop.is_set():
                break                # stopped while the last one closed: start nothing
            port = free_port()
            args = [self.browser, f"--user-data-dir={self.profile}", f"--remote-debugging-port={port}"] + FLAGS
            if self.headless:
                args.append("--headless=new")
            args.append("about:blank")
            self._proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self._port, self._bid = port, ""
            # Given a port, Chrome writes no port file of its own; this one is
            # how the next Open TikTok finds the reader already running.
            with open(port_file, "w", encoding="utf-8") as f:
                f.write(f"{port}\n")
            deadline = time.monotonic() + START_TIMEOUT
            while time.monotonic() < deadline and not self._stop.is_set():
                page = self._page(port) if _alive(port) else None
                if page:
                    # And beside it, which Chrome this is: its kind, and the
                    # browser id only it answers to (reader_on).
                    self._bid = _browser_id(port)
                    with open(os.path.join(self.profile, MODE_FILE), "w", encoding="utf-8") as f:
                        f.write(f"{'hidden' if self.headless else 'shown'}\n{self._bid}\n")
                    return (port,) + page
                if self._proc.poll() is not None:
                    break
                time.sleep(0.25)
            if self._proc.poll() is None or self._stop.is_set():
                break
            # It left at once: Chrome hands itself to one still closing on the
            # same profile. Once more, a moment later.
            time.sleep(1)
        raise OSError("the TikTok reader did not start")

    def _page(self, port):
        """A new window's one page, once DevTools lists it."""
        try:
            tabs = json.loads(_http(port, "/json/list"))
        except (OSError, ValueError):
            return None
        pages = [t for t in tabs if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
        return (pages[0]["webSocketDebuggerUrl"], pages[0].get("id", "")) if pages else None

    def _event(self, method, params):
        """One DevTools event: a chat line or status from OBSERVER, or the
        page's sockets opening, closing and receiving - which webcast.Room
        sorts into its one room socket and everything it never reads."""
        if method == "Runtime.bindingCalled":
            if params.get("name") == BINDING:
                self._payload(params.get("payload") or "")
        elif method == "Network.webSocketCreated":
            self.room.opened(params.get("requestId"), params.get("url"))
        elif method == "Network.webSocketClosed":
            self.room.closed(params.get("requestId"))
        elif method == "Page.frameNavigated":
            f = params.get("frame") or {}
            if not f.get("parentId"):              # the page itself, not a frame inside it
                self._main = f.get("id") or ""
                self._navigated(f.get("url"))
                self._loaded_at = time.monotonic()
        elif method == "Page.navigatedWithinDocument":
            if params.get("frameId") == self._main:
                self._navigated(params.get("url"))
        elif method == "Network.webSocketFrameReceived":
            if not self._own():
                self.elsewhere += 1                # someone else's live: not even decoded
                return
            r = params.get("response") or {}
            self._room_events(self.room.frame(params.get("requestId"), r.get("opcode"), r.get("payloadData") or ""))

    def _room_events(self, events):
        """Chat lines and finished gifts from the room socket.

        A line's sender comes with their @handle, which TikTok sets and nobody
        can copy - so the streamer's own lines are the broadcaster's, found by
        handle, and a viewer who copies the streamer's display name is still
        nobody. A moderator and a follower are TikTok's own flags for this room
        (webcast.chat)."""
        if not self._own():
            return               # a streak finishing after the window left is not this live's either
        post = type(self).on_gift
        for e in events:
            if e["kind"] == "chat":
                role = "moderator" if e["mod"] else "follower" if e.get("follower") else ""
                msg = to_message(self.channel, {"name": e["user"], "login": e["handle"], "text": e["text"],
                                                "role": role, "gifter": self._gifter(e)})
                if msg:
                    self.messages += 1
                    self.on_message(msg)
                continue
            # Names are chat, and chat is text (chat.inert): no control or
            # direction characters onto the stream.
            g = dict(e, user=chat.inert(e["user"])[:40] or "Someone", gift=chat.inert(e["gift"])[:40] or "a gift")
            if post:
                try:
                    post(g)
                except Exception as exc:
                    self.log(f"chat: tiktok: a gift could not be shown: {exc}")

    def _payload(self, raw):
        try:
            p = json.loads(raw)
        except ValueError:
            return
        if not isinstance(p, dict):
            return
        if p.get("t") == "status":
            signed = p.get("signedIn")
            self.page = {"room": bool(p.get("room")), "signed_in": None if signed is None else bool(signed),
                         "typing": bool(p.get("typing")),
                         "path": str(p.get("path") or "")[:120]}
            return
        if p.get("t") == "chat":
            if self._chat_from() != "page" or not self._own():
                return               # the room socket is the source (PAGE_WAIT, SOCKET_FRESH), or not this live
            msg = to_message(self.channel, p)
            if msg:
                self.messages += 1
                self._drawn_at = time.monotonic()
                self.on_message(msg)

    def _close(self):
        """Stopping closes what this opened: the whole Chrome if it was ours -
        asked to quit first, so it saves its profile and a sign-in in it, and
        ended only if it will not - or just the tab it added to a window that
        was already running."""
        proc, self._proc = self._proc, None
        if proc is not None:
            # Ours, so the Chrome on its port is too, even before its id was
            # written down. One that cannot be asked never came up, and has
            # nothing to save: it is ended at once rather than in five seconds.
            asked = proc.poll() is None and close_browser(self._port, self._bid or _browser_id(self._port))
            try:
                proc.wait(5 if asked else 0.5)
            except Exception:
                try:
                    proc.terminate()
                    proc.wait(5)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
        elif self._port and self._tab:
            try:
                _http(self._port, "/json/close/" + self._tab)
            except OSError:
                pass


chat.ADAPTERS["tiktok"] = TikTokAdapter
