"""
Live state feeds and their budget.

Chrome allows six connections per host and port in one profile, and every
open feed holds one for as long as the page lives. The pop-outs share one
profile, so the seventh page there would never even load. This keeps count
of who holds a feed, says so loudly when the shared profile is at its
limit, and offers a WebSocket feed - a separate pool of 255 - for the pages
that come after the four.
"""

import queue
import threading
import time
import urllib.parse

from live import WebSocket, ws_accept_key

LIMIT = 6
DECK_PAGES = ("deck.html", "canvas.html")


class Feeds:
    def __init__(self, log=None):
        self.log = log or (lambda *_: None)
        self._open = {}
        self._lock = threading.RLock()      # status() counts while holding it
        self._seq = 0
        self._warned = False

    @staticmethod
    def page_of(handler):
        ref = handler.headers.get("Referer") or ""
        path = urllib.parse.urlsplit(ref).path
        return path.rsplit("/", 1)[-1] or "?"

    @staticmethod
    def group_of(page):
        # The deck has its own Chrome; everything else shares one.
        return "deck" if page in DECK_PAGES else "windows"

    def track(self, kind, page):
        with self._lock:
            self._seq += 1
            token = self._seq
            self._open[token] = {"kind": kind, "page": page, "group": self.group_of(page),
                                 "since": time.time()}
            held = self._count("windows", "sse")
        if held >= LIMIT and kind == "sse" and not self._warned:
            self._warned = True
            self.log(f"feeds: {held} event streams open from the pop-out windows - Chrome allows "
                     f"{LIMIT} per profile, so one more page there would stall; use the "
                     f"WebSocket feed for it")
        return token

    def release(self, token):
        with self._lock:
            self._open.pop(token, None)
            if self._count("windows", "sse") < LIMIT:
                self._warned = False

    def _count(self, group, kind=None):
        return sum(1 for f in self._open.values()
                   if f["group"] == group and (kind is None or f["kind"] == kind))

    def counts(self):
        with self._lock:
            return {"windows_sse": self._count("windows", "sse"),
                    "windows_ws": self._count("windows", "ws"),
                    "deck": self._count("deck"), "limit": LIMIT}

    def status(self):
        with self._lock:
            return {"open": [dict(f, age=round(time.time() - f["since"])) for f in self._open.values()],
                    "counts": self.counts()}


def serve_ws_feed(handler, hub, feeds):
    """GET /ws/events with an Upgrade header: the state feed over a WebSocket.
    The same payloads /api/events sends, one message each; runs on the
    handler's thread until the page hangs up."""
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
    token = feeds.track("ws", feeds.page_of(handler))
    q = hub.subscribe()
    gone = threading.Event()

    def reader():
        # Pings and the close handshake; nothing else is expected from a page.
        try:
            while ws.recv() is not None:
                pass
        except (ConnectionError, OSError, ValueError):
            pass
        gone.set()

    threading.Thread(target=reader, daemon=True).start()
    try:
        while not gone.is_set():
            try:
                payload = q.get(timeout=15)
            except queue.Empty:
                ws.send(0x9, b"")          # ping keeps a quiet line open
                continue
            ws.send_text(payload)
    except (ConnectionError, OSError, ValueError):
        pass
    finally:
        hub.unsubscribe(q)
        feeds.release(token)
        ws.open = False
