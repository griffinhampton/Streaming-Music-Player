"""
The event bus (S15): what the app just did, on its way to the canvas.

S12's commands, S13's song requests and S14's polls all produce the same kind of
thing - a short statement that something happened - and a scene should be able
to show it without learning which of them it came from. One shape, one hub, and
a fourth producer is a caller and nothing else.

Deliberately not on the state feed. `/ws/events` fans out whole snapshots, so an
event carried on it would make every page in the app rebuild its whole model
each time somebody typed. The chat messages were kept off it for that reason and
this is the same decision; `feeds.serve_ws_feed` is already generic over the hub,
so a second feed costs one route and no new endpoint code.

Nothing here reaches out, and nothing here decides what an alert looks like -
that is the scene's business. The hub is inert until something posts to it.
"""

import json
import queue
import random
import threading
import time
from collections import deque

KEEP = 200                  # what a page that opens late can catch up on
MAX_TEXT = 300

# Per subscriber, and deliberately deep - the same lesson S11 learned the hard
# way. The state hub can afford a depth of 8 because a dropped snapshot is
# superseded by the next one; a dropped event is simply gone, and a burst is
# exactly the busy moment when the alerts matter. Still bounded, so a page that
# has wedged cannot grow it without end.
QUEUE_DEPTH = 256

# "gif" is its own kind rather than riding "command": an effect layer should
# be able to show pictures without also firing on every !command that happens
# to carry a response. event() turns an unknown kind into "note", so a kind
# that is not listed here fails silently - the alert still arrives, and the
# layer waiting for it never does.
#
# "stop" is not something to show (T10). scene.js hands it to the takeDown() of
# every layer that can hold something on screen, whatever kinds that layer
# listens for, and never to alert() - a layer filtering for "gif" must still
# hear it.
#
# "effect" is a layer's own command (T11), addressed to that layer by id and
# scene in `detail`; the layer answers whatever kinds it listens for, and every
# other effect layer ignores it.
#
# "speak" is a clip for a Voice layer (T7), addressed the same way; "skip" is
# the Live view's Skip, which ends the clip being read and starts the next.
#
# "gift" is one finished gift (T8): who, which, how many, the coin total after
# a combo is coalesced, and the sender's picture as a local asset id. Every
# Gift layer hears every gift and keeps the ones its filters want.
# "follow" is one new follower (T6): TikTok announces it on the same socket the
# gifts arrive on, and it carries who and their picture. Its own kind, so a
# layer can show followers without also firing on every gift.
KINDS = ("command", "request", "poll", "note", "gif", "sound", "stop", "effect", "speak", "skip", "gift", "follow")


def event(kind, text, user="", title="", detail=None, at=None):
    """The one shape. Every producer returns this and nothing else."""
    kind = kind if kind in KINDS else "note"
    return {
        "id": "%s-%.6f-%d" % (kind, time.time(), random.randint(0, 999999)),
        "at": float(at if at is not None else time.time()),
        "kind": kind,
        "title": str(title or "")[:80],
        "text": str(text or "")[:MAX_TEXT],
        "user": str(user or "")[:80],
        "detail": detail if isinstance(detail, dict) else {},
    }


class AlertHub:
    """Events, fanned out to whichever scene pages want them, and kept briefly.

    subscribe/unsubscribe are the contract the state feed uses, so the WebSocket
    endpoint serving alerts is the state feed's endpoint with a different queue.
    """

    def __init__(self, log=None):
        self.log = log or (lambda *_: None)
        self._subs = []
        self._lock = threading.Lock()
        self._recent = deque(maxlen=KEEP)
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

    def post(self, ev):
        """Hand one event to every page listening. Never raises: this is called
        from the chat reading loop by way of the command engine, and an event
        that cannot be delivered must not take the connection down with it."""
        if not isinstance(ev, dict) or not ev.get("id"):
            return None
        payload = json.dumps(ev)
        with self._lock:
            self._recent.append(ev)
            self.total += 1
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(payload)
            except queue.Full:
                self.dropped += 1
        return ev

    def say(self, kind, text, **kw):
        """The short way in, for producers that have nothing to keep."""
        return self.post(event(kind, text, **kw))

    # -- what pages read
    def recent(self, limit=50):
        with self._lock:
            items = list(self._recent)
        return items[-max(0, min(int(limit or 0), KEEP)):]

    def status(self):
        with self._lock:
            return {"kept": len(self._recent), "total": self.total,
                    "dropped": self.dropped, "subscribers": len(self._subs)}

    def snapshot(self):
        """For the state feed: how many have fired, never the events. Putting
        them here is the mistake this hub exists to avoid.

        Both of these only ever climb, so server.py's _change_key drops them
        before deciding whether to send: a counter that moves on its own is
        enough to make the whole state look changed every time it is checked.
        """
        with self._lock:
            return {"total": self.total, "dropped": self.dropped}
