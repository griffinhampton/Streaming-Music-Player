"""
Gift senders' pictures (T6): fetched by the server from TikTok's image
servers, kept in a cache of their own, and served by this app.

A scene never fetches anything remote - scene.js refuses remote URLs, because
a scene that fetches someone else's URL is a beacon (DECISIONS, "A scene that
could call home"). So the picture a TikTok gift message names is fetched here,
once, and the gift carries a local /avatar/ address instead.

What it will fetch, and nothing else:
  * https from TikTok's image servers - *.tiktokcdn.com and its -us and -eu
    twins, which is where real gift messages pointed on 2026-09-15. The rig's
    fixture on 127.0.0.1 only when the rig says so (allow_local).
  * no redirects: a redirect is a way to a host that is not on that list.
  * at most MAX_BYTES, and only a JPEG, PNG or WebP by its own first bytes,
    whatever the server calls it.
  * never on the reader's thread: Poster fetches in the background, in order,
    so chat never waits on a picture and a gift waits at most TIMEOUT.

The pictures are other people's, so only the newest KEEP are kept and the rest
are deleted; they never appear in the asset library.
"""

import hashlib
import os
import queue
import re
import threading
import time
import urllib.request
from urllib.parse import urlparse

MAX_BYTES = 512 * 1024
TIMEOUT = 4
KEEP = 200
ID_RE = re.compile(r"^[0-9a-f]{16}\.(jpg|png|webp)$")
TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
_HOST = re.compile(r"^[a-z0-9-]+\.tiktokcdn(-[a-z]+)?\.com$")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Awesome-Streaming-Deck"


def kind_of(raw):
    """The picture's type by its own first bytes, or None."""
    if raw[:3] == bytes([0xFF, 0xD8, 0xFF]):
        return "jpg"
    if raw[:8] == bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]):
        return "png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return None


def allowed(url, allow_local=False):
    try:
        u = urlparse(url or "")
        host, port = (u.hostname or "").lower(), u.port
    except ValueError:
        return False
    if u.username or u.password:
        return False
    if u.scheme == "https" and _HOST.match(host) and port in (None, 443):
        return True
    return bool(allow_local) and u.scheme == "http" and host in ("127.0.0.1", "localhost")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None                     # a 3xx becomes an error, never a second request


class AvatarCache:
    def __init__(self, folder, log=None, allow_local=False):
        self.folder = folder
        os.makedirs(folder, exist_ok=True)
        self.log = log or (lambda *_: None)
        self.allow_local = allow_local
        self._open = urllib.request.build_opener(_NoRedirect).open
        self._lock = threading.Lock()
        self.fetched = 0
        self.refused = 0

    @staticmethod
    def key(url):
        """TikTok signs its picture links with a query that expires, and serves
        the same picture from several hosts - but under one path."""
        return hashlib.sha1(urlparse(url).path.encode("utf-8", "replace")).hexdigest()[:16]

    def path(self, avatar_id):
        """The file for an id this cache made, or None."""
        if not ID_RE.match(avatar_id or ""):
            return None
        full = os.path.join(self.folder, avatar_id)
        return full if os.path.isfile(full) else None

    def get(self, url):
        """A local id for the picture at `url` - kept, or fetched now - or ""
        when it may not, or cannot, be had."""
        if not allowed(url, self.allow_local):
            self.refused += 1
            return ""
        k = self.key(url)
        for ext in TYPES:
            full = self.path(f"{k}.{ext}")
            if full:
                try:
                    os.utime(full)          # newest first, for pruning
                except OSError:
                    pass
                return f"{k}.{ext}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/*"})
            with self._open(req, timeout=TIMEOUT) as r:
                if r.status != 200:
                    raise OSError(f"HTTP {r.status}")
                raw = r.read(MAX_BYTES + 1)
        except Exception as exc:          # urllib's, http.client's, a timeout
            self.refused += 1
            self.log(f"avatars: not fetched ({type(exc).__name__})")
            return ""
        ext = kind_of(raw)
        if not raw or len(raw) > MAX_BYTES or not ext:
            self.refused += 1
            return ""
        aid = f"{k}.{ext}"
        with self._lock:
            tmp = os.path.join(self.folder, aid + ".part")
            with open(tmp, "wb") as f:
                f.write(raw)
            os.replace(tmp, os.path.join(self.folder, aid))
            self.fetched += 1
            self._prune()
        return aid

    def _prune(self):
        try:
            names = [n for n in os.listdir(self.folder) if ID_RE.match(n)]
        except OSError:
            return
        names.sort(key=lambda n: os.path.getmtime(os.path.join(self.folder, n)), reverse=True)
        for n in names[KEEP:]:
            try:
                os.remove(os.path.join(self.folder, n))
            except OSError:
                pass


class Poster:
    """Gifts wait here for their sender's picture - in order, one at a time,
    off the reader's thread - and are then handed to `post(gift, avatar_id)`.
    A full queue posts at once, without the picture, rather than wait."""

    def __init__(self, cache, post, depth=200):
        self.cache = cache
        self.post = post
        self._q = queue.Queue(maxsize=depth)
        self._t = threading.Thread(target=self._run, daemon=True, name="gift pictures")
        self._t.start()

    def put(self, gift):
        try:
            self._q.put_nowait(gift)
        except queue.Full:
            self._post(gift, "")

    def _run(self):
        while True:
            g = self._q.get()
            if g is None:
                return
            url = g.get("avatar_url") or ""
            self._post(g, self.cache.get(url) if url else "")

    def _post(self, g, aid):
        try:
            self.post(g, aid)
        except Exception as exc:
            self.cache.log(f"avatars: a gift could not be shown: {exc}")

    def close(self, wait=2):
        try:
            self._q.put_nowait(None)
        except queue.Full:
            pass
        self._t.join(wait)

    def idle(self, within=5.0):
        """For tests: wait until the queue is empty."""
        deadline = time.monotonic() + within
        while not self._q.empty() and time.monotonic() < deadline:
            time.sleep(0.02)
        time.sleep(0.05)
