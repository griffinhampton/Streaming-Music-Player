"""
Song requests (S13): what happens when chat asks for a track.

The engine in commands.py decides whether someone may run `!queue` at all -
their role, and how often. This module decides whether the *song* is allowed:
it is looked up, measured against the guard rails, and then either appended
straight away or parked for you to approve.

Why parking is the interesting half. Spotify's Web API can read the queue and
append to it, but there is no endpoint to reorder or remove - `_fetch_queue`
in spotify_api.py has said so since P0. So appending is a one-way door: once a
request is in the real queue this app cannot take it out again. That is why the
pending list is the app's own and why approval is the irreversible step, rather
than something to undo afterwards. It is also why "moderated" defaults on.

Spotify itself is injected, as commands.py injects the scene switcher:

    find(text)    -> (ok, track_or_reason)
    enqueue(uri)  -> (ok, reason)

so every test here runs without an account and without putting anything into
anybody's real queue. Verifying this code is not a reason to queue songs on
someone's stream.

Nothing here reaches out on import.
"""

import re
import threading
import time
from collections import deque

KEEP = 200                  # history, the way chat.py and commands.py keep theirs
MAX_PENDING = 50            # a parked list nobody drains must not grow without end
MAX_TEXT = 200


def clean_rules(cfg):
    """The guard rails from config, with anything unusable replaced rather than
    half-applied - a rule that silently does not work is worse than no rule."""
    cfg = cfg if isinstance(cfg, dict) else {}

    def secs(key, fallback):
        try:
            return max(0, min(3600, int(cfg.get(key, fallback))))
        except (TypeError, ValueError):
            return fallback
    blocked = [str(w).strip().lower() for w in (cfg.get("blocked") or []) if str(w).strip()]
    return {"max_seconds": secs("max_seconds", 420),
            "moderated": cfg.get("moderated") is not False,
            "blocked": blocked[:200]}


class Store:
    """Requests: asked for, parked, approved or turned down - and a short
    history of all of it, so the Live view can show what happened."""

    def __init__(self, find=None, enqueue=None, rules=None, log=None, clock=time.time):
        self.log = log or (lambda *_: None)
        self.find = find
        self.enqueue = enqueue
        self.clock = clock
        self.rules = clean_rules(rules or {})
        self._lock = threading.Lock()
        self._pending = []
        self._recent = deque(maxlen=KEEP)
        self._seq = 0
        self.queued = 0
        self.refused = 0

    def configure(self, rules):
        self.rules = clean_rules(rules or {})
        return dict(self.rules)

    # ------------------------------------------------------------- asking

    def ask(self, msg, text=None):
        """Somebody typed `!queue something`. Returns the entry, always: a
        refusal is a result, not a silence - the whole point of the log is
        seeing what was turned down as easily as what went through."""
        wanted = (text if text is not None else (msg or {}).get("args") or "").strip()[:MAX_TEXT]
        user = (msg or {}).get("user") or {}
        who = user.get("name") or user.get("login") or ""

        if not wanted:
            return self._finish(msg, who, "", None, "refused", "say what to queue: !queue artist - song")
        low = wanted.lower()
        hit = next((w for w in self.rules["blocked"] if w in low), "")
        if hit:
            # Deliberately not repeating the blocked word back: it would put it
            # on screen, which is the thing the list exists to prevent.
            return self._finish(msg, who, wanted, None, "refused", "that one is on the block list")

        if not self.find:
            return self._finish(msg, who, wanted, None, "refused", "Spotify is not connected")
        try:
            ok, found = self.find(wanted)
        except Exception as exc:                      # this runs on the chat reading loop
            return self._finish(msg, who, wanted, None, "refused", str(exc)[:120] or "search failed")
        if not ok or not found:
            return self._finish(msg, who, wanted, None, "refused",
                                (found if isinstance(found, str) else "") or "nothing found for that")

        cap = self.rules["max_seconds"]
        if cap and float(found.get("duration") or 0) > cap:
            return self._finish(msg, who, wanted, found, "refused",
                                f"that one is longer than the {cap // 60}m {cap % 60}s limit")

        blocked_track = f"{found.get('title', '')} {found.get('artist', '')}".lower()
        hit = next((w for w in self.rules["blocked"] if w in blocked_track), "")
        if hit:
            return self._finish(msg, who, wanted, found, "refused", "that one is on the block list")

        if self.rules["moderated"]:
            with self._lock:
                full = len(self._pending) >= MAX_PENDING
            if full:
                return self._finish(msg, who, wanted, found, "refused", "the request list is full just now")
            return self._finish(msg, who, wanted, found, "pending", "waiting to be let through")
        return self._send(self._entry(msg, who, wanted, found, "pending", ""))

    # ------------------------------------------------------- letting through

    def approve(self, rid):
        """Put a parked request into the real queue. One way: Spotify cannot
        take it back out, so this is the step that cannot be undone."""
        with self._lock:
            entry = next((e for e in self._pending if e["id"] == rid), None)
            if entry is not None:
                self._pending.remove(entry)
        if entry is None:
            return {"ok": False, "reason": "no such request"}
        done = self._send(entry)
        return {"ok": done["state"] == "queued", "request": done, "reason": done["reason"]}

    def skip(self, rid):
        """Turn a parked request down. Spotify is not called at all."""
        with self._lock:
            entry = next((e for e in self._pending if e["id"] == rid), None)
            if entry is not None:
                self._pending.remove(entry)
        if entry is None:
            return {"ok": False, "reason": "no such request"}
        entry["state"], entry["reason"] = "skipped", "you skipped it"
        self._remember(entry)
        return {"ok": True, "request": entry}

    def _send(self, entry):
        if not self.enqueue:
            entry["state"], entry["reason"] = "refused", "Spotify is not connected"
            self._remember(entry)
            return entry
        try:
            ok, reason = self.enqueue((entry.get("track") or {}).get("uri", ""))
        except Exception as exc:
            ok, reason = False, str(exc)[:120]
        # Spotify's own words survive the trip: 404 means nothing is playing and
        # 403 means the account is not Premium, and both are worth saying as
        # such rather than flattening into "that did not work".
        entry["state"] = "queued" if ok else "refused"
        entry["reason"] = reason or ("queued" if ok else "Spotify would not take it")
        self._remember(entry)
        return entry

    # ------------------------------------------------------------- plumbing

    def _entry(self, msg, who, wanted, track, state, reason):
        with self._lock:
            self._seq += 1
            rid = "r%d" % self._seq
        return {"id": rid, "at": self.clock(), "service": (msg or {}).get("service", ""),
                "channel": (msg or {}).get("channel", ""), "user": who,
                "text": wanted, "track": track, "state": state, "reason": reason}

    def _finish(self, msg, who, wanted, track, state, reason):
        entry = self._entry(msg, who, wanted, track, state, reason)
        if state == "pending":
            with self._lock:
                self._pending.append(entry)
            self._remember(entry)
            return entry
        self._remember(entry)
        return entry

    def _remember(self, entry):
        with self._lock:
            self._recent = deque([e for e in self._recent if e["id"] != entry["id"]], maxlen=KEEP)
            self._recent.append(dict(entry))
            if entry["state"] == "queued":
                self.queued += 1
            elif entry["state"] in ("refused", "skipped"):
                self.refused += 1

    # ------------------------------------------------------- what pages read

    def pending(self):
        with self._lock:
            return [dict(e) for e in self._pending]

    def recent(self, limit=100):
        with self._lock:
            items = [dict(e) for e in self._recent]
        return items[-max(0, min(int(limit or 0), KEEP)):]

    def status(self):
        with self._lock:
            return {"pending": len(self._pending), "kept": len(self._recent),
                    "queued": self.queued, "refused": self.refused, "rules": dict(self.rules)}

    def snapshot(self):
        """For the state feed: how many are waiting, never the list itself."""
        with self._lock:
            return {"pending": len(self._pending), "queued": self.queued, "refused": self.refused}
