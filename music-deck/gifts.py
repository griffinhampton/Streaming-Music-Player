"""
The coins gifted on stream - per person, and in all (the ledger).

A gift message says which gift, what it costs in coins and how many were sent;
webcast.py turns each finished gift - a one-off at once, a streak at its end -
into its coins, and every one lands here. Kept by the sender's @handle, which
TikTok sets and nobody can copy, so nobody can claim a gifter's total by taking
their display name.

What it is for: the streamer seeing what the stream brought in, and from whom;
and the command gate - someone who has gifted this stream counts as a gifter
(commands.py, the "follower" rung: followers and gifters).

Saved to the cache as it goes - at most every SAVE_EVERY seconds, and on quit -
so a restart mid-stream keeps the totals. A new live starts a new count by
itself: TikTok gives every live a room id of its own, which the reader passes
on when the streamer's room socket opens (begin). The same id is the same live
- a restart, the page opened again - and changes nothing; a different one is a
new live, so what was counted is kept as the last stream's and the count
starts again. Reset starts it again by hand. It holds viewers' names on this PC
only: this stream's senders, and the last stream's top few.
Senders beyond MAX_SENDERS are not kept one by one; the totals still count them.
"""

import json
import os
import threading
import time

SAVE_EVERY = 2.0
MAX_SENDERS = 5000
TOP = 5
ROOM_MAX = 25          # TikTok's room ids are 19 digits (seen 2026-09-15)


def _room(value):
    """A room id as TikTok writes one - digits, and not too many - or ""."""
    value = str(value or "")
    return value if value.isdigit() and len(value) <= ROOM_MAX else ""


def _last(d):
    """The last stream's totals as kept on disk, or None if missing or damaged."""
    if not isinstance(d, dict):
        return None
    try:
        top = [{"handle": str(t.get("handle") or "")[:40], "name": str(t.get("name") or "")[:40],
                "coins": max(0, int(t.get("coins") or 0)), "gifts": max(0, int(t.get("gifts") or 0))}
               for t in list(d.get("top") or [])[:TOP] if isinstance(t, dict)]
        return {"since": float(d.get("since") or 0), "until": float(d.get("until") or 0),
                "coins": max(0, int(d.get("coins") or 0)), "gifts": max(0, int(d.get("gifts") or 0)),
                "senders": max(0, int(d.get("senders") or 0)), "top": top}
    except (TypeError, ValueError, AttributeError):
        return None


class GiftLedger:
    def __init__(self, path, clock=time.time):
        self.path = path
        self.clock = clock
        self._lock = threading.Lock()
        self._saved_at = 0.0
        self._dirty = False
        self.room = ""             # the live this count is for: TikTok's room id, once known
        self.last = None           # the last stream's totals, kept when a new live began
        self._load()

    def _blank(self):
        self.since = self.clock()
        self.coins = 0
        self.gifts = 0
        self.senders = {}          # handle -> {"name", "coins", "gifts", "last"}

    def _load(self):
        self._blank()
        try:
            with open(self.path, encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, ValueError):
            return
        if not isinstance(d, dict):
            return
        try:
            since, coins, gifts = float(d.get("since") or self.since), int(d.get("coins") or 0), int(d.get("gifts") or 0)
            senders = {}
            for h, s in list((d.get("senders") or {}).items())[:MAX_SENDERS]:
                if isinstance(s, dict):
                    senders[str(h)[:40]] = {"name": str(s.get("name") or "")[:40], "coins": max(0, int(s.get("coins") or 0)),
                                            "gifts": max(0, int(s.get("gifts") or 0)), "last": float(s.get("last") or 0)}
        except (TypeError, ValueError, AttributeError):
            return                                   # a damaged file: start clean rather than half-read
        self.since, self.coins, self.gifts, self.senders = since, max(0, coins), max(0, gifts), senders
        self.room, self.last = _room(d.get("room")), _last(d.get("last"))

    def _top(self, top):
        best = sorted(self.senders.items(), key=lambda kv: (-kv[1]["coins"], -kv[1]["last"]))[:max(0, int(top))]
        return [{"handle": h, "name": s["name"], "coins": s["coins"], "gifts": s["gifts"]} for h, s in best]

    def record(self, handle, name, coins, count=1):
        """One finished gift of `coins` in all (`count` of them). Returns the
        sender's total; a gift with no handle counts toward the stream only."""
        handle = str(handle or "").strip().lower()[:40]
        try:
            coins, count = max(0, int(coins or 0)), max(1, int(count or 1))
        except (TypeError, ValueError):
            return 0
        total = 0
        with self._lock:
            self.coins += coins
            self.gifts += count
            if handle:
                s = self.senders.get(handle)
                if s is None and len(self.senders) < MAX_SENDERS:
                    s = self.senders[handle] = {"name": "", "coins": 0, "gifts": 0, "last": 0.0}
                if s is not None:
                    s["name"] = str(name or s["name"] or handle)[:40]
                    s["coins"] += coins
                    s["gifts"] += count
                    s["last"] = self.clock()
                    total = s["coins"]
            self._dirty = True
        self.save(force=False)
        return total

    def begin(self, room):
        """The streamer's live, by TikTok's room id, as the reader found it.
        The live this count is already for changes nothing. Any other is a new
        live: what was counted is kept as the last stream's, and the count
        starts again. True when it did."""
        room = _room(room)
        if not room:
            return False
        with self._lock:
            if room == self.room:
                return False
            if self.coins or self.gifts:
                self.last = {"since": self.since, "until": self.clock(), "coins": self.coins,
                             "gifts": self.gifts, "senders": len(self.senders), "top": self._top(TOP)}
            self._blank()
            self.room = room
            self._dirty = True
        self.save(force=True)
        return True

    def coins_from(self, handle):
        """What this sender has gifted since the ledger began: 0 for nobody."""
        with self._lock:
            s = self.senders.get(str(handle or "").strip().lower())
            return s["coins"] if s else 0

    def snapshot(self, top=TOP):
        with self._lock:
            return {"since": self.since, "coins": self.coins, "gifts": self.gifts, "senders": len(self.senders),
                    "top": self._top(top), "live": bool(self.room),
                    "last": dict(self.last, top=list(self.last["top"])) if self.last else None}

    def reset(self):
        """By hand: every total back to nothing, and said so on disk. The live
        it counts for stays the one it was, so the reader finding that live
        again does not count as a new one."""
        with self._lock:
            self._blank()
            self._dirty = True
        self.save(force=True)
        return self.snapshot()

    def save(self, force=True):
        """Write what changed; unforced, at most every SAVE_EVERY seconds."""
        with self._lock:
            now = self.clock()
            if not self._dirty or (not force and now - self._saved_at < SAVE_EVERY):
                return False
            text = json.dumps({"since": self.since, "coins": self.coins, "gifts": self.gifts, "senders": self.senders,
                               "room": self.room, "last": self.last})
            self._dirty = False
            self._saved_at = now
        tmp = self.path + ".part"
        try:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(text)
            os.replace(tmp, self.path)
        except OSError:
            with self._lock:
                self._dirty = True                 # try again next time
            return False
        return True
