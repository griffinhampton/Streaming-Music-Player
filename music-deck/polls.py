"""
Polls (S14): a question, some choices, and whatever chat votes.

One poll is open at a time - a stream can only ask one thing at once, and two
at once would make `!1` ambiguous, which is the whole point of the numbering.

Votes arrive as ordinary chat commands. `chat.py` already parses `!1` centrally
as the command "1", so there is no second parser here; this watches the hub
beside the command engine rather than behind it, because S12's model is a role
gate and a cooldown and voting wants neither. The rule is one each.

First vote wins. Letting people change their mind sounds kinder and is worse on
a stream: the total stops matching the number of people who voted, and "you can
change it" is a rule nobody can see. Later votes are ignored, which is the rule
that can be said out loud in one sentence.

The tally goes out through an injected `publish`, so this module never learns
that alerts.py exists - the same arrangement the command engine has with the
scene switcher. What it publishes is always the whole tally and never a delta,
so a page that joins halfway through is right at the next vote instead of
adding up what it missed. And it is coalesced: a busy poll must not put one
event on the bus per vote.

Nothing here reaches out. The engine is inert until something opens a poll.
"""

import threading
import time
from collections import deque

KEEP = 20                   # past polls kept, for "what did they say last time"
MAX_CHOICES = 8             # !1 to !8; more than that nobody reads on stream
MAX_QUESTION = 200
MAX_CHOICE = 80
COALESCE_S = 0.25           # at most four tallies a second reach the canvas


def clean_choices(items):
    out = []
    for c in items or []:
        text = str(c).strip()[:MAX_CHOICE]
        if text:
            out.append(text)
        if len(out) >= MAX_CHOICES:
            break
    return out


class Polls:
    """The open poll, the ones before it, and the counting."""

    def __init__(self, publish=None, log=None, clock=time.time):
        self.publish = publish          # publish(tally) -> None, injected
        self.log = log or (lambda *_: None)
        self.clock = clock
        self._lock = threading.Lock()
        self._open = None               # {id, question, choices, votes, opened}
        self._past = deque(maxlen=KEEP)
        self._timer = None
        self._last_sent = 0.0
        self._seq = 0

    # ------------------------------------------------------------- opening

    def open(self, question, choices):
        """Start one. Any poll already running is closed first: two at once
        would make `!1` mean two different things."""
        picks = clean_choices(choices)
        if len(picks) < 2:
            return {"ok": False, "reason": "a poll needs at least two things to choose between"}
        text = str(question or "").strip()[:MAX_QUESTION]
        if not text:
            return {"ok": False, "reason": "the poll needs a question"}
        if self._open:
            self.close()
        with self._lock:
            self._seq += 1
            self._open = {"id": "p%d" % self._seq, "question": text, "choices": picks,
                          "votes": {}, "opened": self.clock(), "closed": 0.0}
        self._send(force=True)
        return {"ok": True, "poll": self.current()}

    def close(self):
        with self._lock:
            poll = self._open
            self._open = None
            if poll:
                poll["closed"] = self.clock()
                self._past.append(poll)
        if not poll:
            return {"ok": False, "reason": "no poll is open"}
        self._send(force=True)          # the final bars, so the canvas settles on the result
        return {"ok": True, "poll": self._tally(poll)}

    # ------------------------------------------------------------- counting

    def vote(self, who, choice):
        """One vote. Returns True only when it actually counted, so a caller
        can tell "counted" from "ignored" without reading the tally."""
        with self._lock:
            poll = self._open
            if not poll:
                return False
            try:
                n = int(choice)
            except (TypeError, ValueError):
                return False
            if n < 1 or n > len(poll["choices"]):
                return False            # a choice that does not exist is not a vote
            who = str(who or "").lower()
            if not who or who in poll["votes"]:
                return False            # first one counts; later ones are ignored
            poll["votes"][who] = n
        self._send()
        return True

    def handle(self, msg):
        """A chat message, from the hub's watcher. `!1` arrives as the command
        "1"; `!vote 2` arrives as "vote" with "2" in args."""
        cmd = (msg or {}).get("command") or ""
        if not cmd:
            return None
        user = (msg.get("user") or {})
        who = user.get("login") or user.get("id") or ""
        if cmd.isdigit():
            return self.vote(who, cmd) or None
        if cmd == "vote":
            return self.vote(who, (msg.get("args") or "").strip().split(" ")[0]) or None
        return None

    # ------------------------------------------------------------- reading

    def _tally(self, poll):
        if not poll:
            return None
        counts = [0] * len(poll["choices"])
        for n in poll["votes"].values():
            if 1 <= n <= len(counts):
                counts[n - 1] += 1
        total = sum(counts)
        return {"id": poll["id"], "question": poll["question"], "choices": poll["choices"],
                "counts": counts, "total": total,
                "shares": [round(c / total, 4) if total else 0.0 for c in counts],
                "open": poll["closed"] == 0.0, "opened": poll["opened"], "closed": poll["closed"]}

    def current(self):
        with self._lock:
            return self._tally(self._open)

    def recent(self, limit=10):
        with self._lock:
            items = [self._tally(p) for p in self._past]
        return items[-max(0, min(int(limit or 0), KEEP)):]

    def status(self):
        with self._lock:
            return {"open": bool(self._open), "kept": len(self._past)}

    def snapshot(self):
        """For the state feed: whether one is open and what it asks - never the
        counts, which change on every vote and belong on the bus."""
        with self._lock:
            poll = self._open
            return {"open": bool(poll), "id": poll["id"] if poll else "",
                    "question": poll["question"] if poll else ""}

    # ------------------------------------------------------- to the canvas

    def _send(self, force=False):
        """The whole tally, at most every COALESCE_S. A poll that is being
        hammered must not put an event on the bus per vote - and the last vote
        of a burst must still arrive, which is what the timer is for."""
        if not self.publish:
            return
        now = time.monotonic()
        with self._lock:
            due = force or (now - self._last_sent) >= COALESCE_S
            if due:
                self._last_sent = now
                if self._timer:
                    self._timer.cancel()
                    self._timer = None
            elif self._timer is None:
                self._timer = threading.Timer(COALESCE_S - (now - self._last_sent), self._flush)
                self._timer.daemon = True
                self._timer.start()
        if due:
            self._deliver()

    def _flush(self):
        with self._lock:
            self._timer = None
            self._last_sent = time.monotonic()
        self._deliver()

    def _deliver(self):
        tally = self.current() or (self.recent(1) or [None])[-1]
        if not tally:
            return
        try:
            self.publish(tally)
        except Exception as exc:        # the bus must not break the vote counting
            self.log(f"polls: could not publish the tally: {exc}")
