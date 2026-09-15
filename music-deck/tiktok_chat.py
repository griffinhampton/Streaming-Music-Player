"""
TikTok chat (T4, T5): read from the streamer's own logged-in TikTok page.

TikTok publishes no API for live-room events, and every community client signs
its requests through somebody else's server. On 2026-09-15 the user chose the
route where nothing leaves this machine: a Chrome window of its own, which they
sign into TikTok themselves, open on their live page - and this reads the chat
the way the page draws it.

How it reads, and what it never does:

  * A Chrome of its own (cache/chrome-tiktok), started with a DevTools port on
    127.0.0.1 that Chrome picks itself (--remote-debugging-port=0) and writes
    into the profile's DevToolsActivePort. This connects to that port, installs
    one binding, and injects OBSERVER, which watches the chat list and hands
    each new line to the binding. The page sends nothing anywhere else.
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
from urllib.parse import quote, urlparse

import chat

TIKTOK = "https://www.tiktok.com"
NAME_RE = re.compile(r"^[a-z0-9._]{2,24}$")
BINDING = "__asdTikTok"
START_TIMEOUT = 25
MAX_FRAME = 16 * 1024 * 1024

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
    let body = m.querySelector('.break-words') || m.querySelector("[class*='-DivComment']") ||
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
    const state = { t: 'status', room: !!room, signedIn: !signedOut, path: location.pathname };
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

def devtools_port(profile):
    """The port Chrome chose, from the file it writes into its profile."""
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
    login = linked or re.sub(r"\s+", "", name.lower())[:40]
    role = p.get("role")
    badges = []
    if linked and linked == channel:
        badges.append("broadcaster/1")
    elif role == "moderator":
        badges.append("moderator/1")
    elif role == "subscriber":
        badges.append("subscriber/1")
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

    def __init__(self, channel, on_message, log=None):
        super().__init__((channel or "").strip().lstrip("@#"), on_message, log)
        self.page = {"room": False, "signed_in": None, "path": ""}
        self._proc = None
        self._tab = ""
        self._port = None

    def status(self):
        return dict(super().status(), page=dict(self.page))

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
            self._port = self._open(url)
            ws_url, self._tab = self._page(self._port)
            cdp = Cdp(ws_url)
            cdp.sock.settimeout(1.0)
            for method, params in (("Runtime.enable", {}), ("Page.enable", {}),
                                   ("Runtime.addBinding", {"name": BINDING}),
                                   ("Page.addScriptToEvaluateOnNewDocument", {"source": OBSERVER}),
                                   ("Runtime.evaluate", {"expression": OBSERVER})):
                cdp.send(method, params)
            self._set("joined")
            self.log(f"chat: tiktok: reading @{self.channel}")
            while not self._stop.is_set():
                msg = cdp.recv()
                if msg and msg.get("method") == "Runtime.bindingCalled":
                    params = msg.get("params") or {}
                    if params.get("name") == BINDING:
                        self._payload(params.get("payload") or "")
        except OSError as exc:
            if not self._stop.is_set():
                closed = "closed" in str(exc).lower() or "refused" in str(exc).lower()
                self._set("failed", "the TikTok window was closed - press Open TikTok to open it again"
                          if closed else f"could not read the TikTok window: {exc}")
                self.log("chat: tiktok: " + self.error)
        finally:
            if cdp:
                cdp.close()
            if self._stop.is_set():
                self._close()

    def _open(self, url):
        """A running reader window gets one more tab; otherwise a new one."""
        os.makedirs(self.profile, exist_ok=True)
        port = devtools_port(self.profile)
        if port and _alive(port):
            _http(port, "/json/new?" + quote(url, safe=""), method="PUT")
            return port
        try:
            os.remove(os.path.join(self.profile, "DevToolsActivePort"))
        except OSError:
            pass
        args = [self.browser, f"--user-data-dir={self.profile}", "--remote-debugging-port=0"] + FLAGS
        if self.headless:
            args.append("--headless=new")
        args.append(url)
        self._proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                      creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        deadline = time.monotonic() + START_TIMEOUT
        while time.monotonic() < deadline and not self._stop.is_set():
            port = devtools_port(self.profile)
            if port and _alive(port):
                return port
            time.sleep(0.25)
        raise OSError("the TikTok window did not start")

    def _page(self, port):
        tabs = json.loads(_http(port, "/json/list"))
        pages = [t for t in tabs if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
        want = [t for t in pages if "/live" in str(t.get("url", ""))] or pages
        if not want:
            raise OSError("the TikTok window has no page")
        return want[0]["webSocketDebuggerUrl"], want[0].get("id", "")

    def _payload(self, raw):
        try:
            p = json.loads(raw)
        except ValueError:
            return
        if not isinstance(p, dict):
            return
        if p.get("t") == "status":
            self.page = {"room": bool(p.get("room")), "signed_in": bool(p.get("signedIn")),
                         "path": str(p.get("path") or "")[:120]}
            return
        if p.get("t") == "chat":
            msg = to_message(self.channel, p)
            if msg:
                self.messages += 1
                self.on_message(msg)

    def _close(self):
        """Stopping closes what this opened: the whole window if it was ours,
        or just the tab it added to one that was already running."""
        proc, self._proc = self._proc, None
        if proc is not None:
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
