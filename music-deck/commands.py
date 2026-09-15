"""
The command engine: what `!something` in chat is allowed to do.

chat.py already pulls the command out of every message, whatever service it
came from, so this module never parses text and never learns what Twitch is.
It is handed the one message shape and decides three things: whether that
person may run this command, whether it is being run too often, and what
happens if it does.

Roles are a ladder rather than a set. A gate of "mod" is passed by a moderator
and by the broadcaster, not only by someone whose badge says exactly
"moderator" - the obvious reading, and the one that is easy to get wrong by
comparing strings.

Two cooldowns, because they answer different questions. The per-command one
keeps a command from filling the stream however many people ask for it; the
per-user one keeps one person from holding it. They are separate clocks, so a
second viewer is not made to wait out the first viewer's turn.

A third limit sits over all of them (T10): the effects budget. Cooldowns are
per command, so ten picture commands with a ten-second cooldown each are still
a picture a second between them. The budget counts every effect that reached
the stream, whichever command sent it, and holds the rest back.

And a stop. While the engine is paused it refuses every command except the
ones whose action is "stop" - which is what lets a moderator's !resume work
while everything else is off.

"What it says back" is recorded, not sent. This app cannot speak in chat: S10
signs in anonymously so it holds no credential, and the adapter has no way to
send a message at all. A response goes into the log the Live view reads, and at
S15 onto the canvas. Sending one into Twitch needs an account and an OAuth
token, which is a decision for the user rather than a thing to build quietly.

Nothing here reaches out. The engine is inert until something calls handle().
"""

import re
import threading
import time
from collections import deque

LOG_KEEP = 300              # what the Live view can look back over
NAME_RE = re.compile(r"^[a-z0-9_][a-z0-9_-]{0,31}$")
MAX_RESPONSE = 400

# The ladder. Anything at or above the gate may run the command.
ROLES = ("everyone", "subscriber", "vip", "mod", "broadcaster")
RANK = {name: i for i, name in enumerate(ROLES)}

# Twitch's badge names, mapped onto it. A founder is an early subscriber, so it
# would be wrong to leave them below one.
BADGE_ROLE = {"broadcaster": "broadcaster", "moderator": "mod", "vip": "vip",
              "subscriber": "subscriber", "founder": "subscriber"}

ACTIONS = ("say", "scene", "queue", "poll", "gif", "sound", "stop")

# What puts something in front of the audience with nobody checking it first.
# A song request waits for approval and a scene switch is one of yours; these
# go straight on screen, so these are what the budget counts - a layer's own
# command (T11, below) included. T7's "speak" joins them the day it exists.
EFFECTS = ("gif", "sound", "effect")

# T11: commands that belong to a layer on the canvas rather than to the list.
# The layer is the setup - its command's name, who may run it and its two
# waits live in its props - so adding the layer makes the command and deleting
# it removes it. T7's voice layer ("speak") is the second; T8's gift layer
# joins them the day it exists.
LAYER_TYPES = ("effect", "speak")
# What such a command does. Deliberately not in ACTIONS: that tuple is what the
# Commands panel offers, and a list entry pointing at a layer id would be a
# command that breaks the moment the layer is deleted or the scene changes, so
# clean() refuses it from config for exactly that reason.
LAYER_ACTION = "effect"

# At most COUNT effects in any SECONDS, across every command. Five in thirty
# is about what one effect layer can show anyway - it holds each for five
# seconds and keeps three waiting - so the default costs a normal stream
# nothing and stops a flood at the door rather than in the layer's queue.
BUDGET_COUNT = 5
BUDGET_SECONDS = 30


def clean_budget(value):
    """The budget as config holds it, normalised. Seconds of 0 means no
    budget at all - an honest setting for a small stream, and a spelled-out
    one, rather than a count of 0 that would read as "no effects ever"."""
    value = value if isinstance(value, dict) else {}

    def num(key, default, lo, hi):
        try:
            v = value.get(key, default)
            return max(lo, min(hi, int(default if v is None else v)))
        except (TypeError, ValueError):
            return default
    return {"count": num("count", BUDGET_COUNT, 1, 60),
            "seconds": num("seconds", BUDGET_SECONDS, 0, 600)}


def layer_command(layer):
    """The command one canvas layer answers to (T11), or None.

    Normalised by clean() itself - handed an ordinary action to get past its
    check, then given the layer's - so the name, the role and the waits obey
    exactly the rules a command in the list does: one cleaner, not two that
    drift apart. A hidden layer answers to nothing, because it could show
    nothing.
    """
    if not isinstance(layer, dict) or layer.get("type") not in LAYER_TYPES:
        return None
    if layer.get("visible") is False or not layer.get("id"):
        return None
    p = layer.get("props") if isinstance(layer.get("props"), dict) else {}
    cmd = clean({"name": p.get("command"), "action": "say", "role": p.get("role"),
                 "cooldown": p.get("cooldown"), "user_cooldown": p.get("user_cooldown")})
    if cmd is None:
        return None
    cmd.update(action=LAYER_ACTION, target=str(layer["id"]), response="",
               layer=str(layer.get("name") or "")[:80], layer_type=layer.get("type"))
    return cmd


def scene_commands(scene):
    """Every command the layers of one scene answer to, in layer order.

    A second layer answering to a name already taken is kept but marked
    `shadowed`: the first one answers, and the inspector and the panel say so
    rather than the server settling it somewhere nobody can see.
    """
    out, seen = [], set()
    for layer in (scene or {}).get("layers") or []:
        cmd = layer_command(layer)
        if cmd is None:
            continue
        cmd["shadowed"] = cmd["name"] in seen
        seen.add(cmd["name"])
        out.append(cmd)
    return out


def rank_of(badges):
    """The highest role a set of badges carries, as a rung on the ladder."""
    best = RANK["everyone"]
    for badge in badges or []:
        role = BADGE_ROLE.get(str(badge).split("/", 1)[0].lower())
        if role:
            best = max(best, RANK[role])
    return best


def clean(item):
    """One command from config, normalised - or None if it is not usable.

    Anything the user can edit by hand can arrive malformed, and a command that
    is half-valid is worse than one that is ignored: it would fire on some
    messages and not others for reasons nobody could see.
    """
    if not isinstance(item, dict):
        return None
    # Whatever symbol starts a command, a stored name never carries it. This
    # used to strip "!" alone; it strips the whole class instead, because
    # NAME_RE requires a letter, digit or underscore first, so anything before
    # that is somebody typing the symbol into the box out of habit. Stripping
    # the class rather than one character means the box still works the day
    # the symbol changes, and every saved command survives that change
    # untouched - the name never held the symbol in the first place.
    name = re.sub(r"^[^a-z0-9_]+", "", str(item.get("name") or "").strip().lower())
    if not NAME_RE.match(name):
        return None
    action = str(item.get("action") or "say").lower()
    if action not in ACTIONS:
        return None
    role = str(item.get("role") or "everyone").lower()
    if role not in RANK:
        role = "everyone"
    def secs(key):
        try:
            return max(0, min(3600, int(item.get(key) or 0)))
        except (TypeError, ValueError):
            return 0
    return {"name": name, "action": action, "role": role,
            "response": str(item.get("response") or "")[:MAX_RESPONSE],
            "target": str(item.get("target") or ""),
            "cooldown": secs("cooldown"), "user_cooldown": secs("user_cooldown"),
            "enabled": item.get("enabled") is not False}


def fill(text, msg):
    """The few placeholders a response may carry. Deliberately not a template
    language: three names, and anything else is left exactly as typed."""
    who = (msg.get("user") or {}).get("name") or (msg.get("user") or {}).get("login") or ""
    return (text.replace("{user}", who)
                .replace("{args}", msg.get("args") or "")
                .replace("{channel}", msg.get("channel") or ""))


class Engine:
    """The registry, the gates, the clocks and the log.

    The actions that reach outside are injected, so this module imports nothing
    from the server and can be tested without one:

        run_scene(name_or_id) -> (ok, text)      put a scene on air
        run_request(message)  -> (ok, text)      a song request (S13, songreq.py)
        run_poll(target, msg) -> (ok, text)      open or close a poll (S14)
        run_gif(asset, msg)   -> (ok, text)      a picture on the canvas (T2)
        run_sound(asset, msg) -> (ok, text)      a clip played on the canvas
        run_stop(target, msg) -> (ok, text)      clear the stream and pause, or resume (T10)
        run_effect(layer, msg) -> (ok, text)     set off a layer's own command (T11)
        layers() -> [command]                    what the layers on air answer to (T11)

    The list comes first when a name is in both: it answers the way it did
    before the layer existed, and the conflict is shown rather than settled.

    Song requests are gated and cooled here rather than in songreq.py: who may
    ask, and how often, is the same question for every command, and answering it
    twice in two places is how the two answers drift apart.
    """

    def __init__(self, run_scene=None, run_request=None, run_poll=None, run_gif=None,
                 run_sound=None, run_stop=None, run_effect=None, layers=None,
                 log=None, clock=time.monotonic):
        self.log = log or (lambda *_: None)
        self.run_scene = run_scene
        self.run_request = run_request
        self.run_poll = run_poll
        self.run_gif = run_gif
        self.run_sound = run_sound
        self.run_stop = run_stop
        self.run_effect = run_effect
        self.layers = layers or (lambda: [])
        # Deliberately not saved anywhere. A pause is a mid-stream decision; one
        # that survived a restart would be commands that silently do nothing at
        # the start of the next stream, with no memory of why.
        self.paused = False
        self._budget = clean_budget(None)
        self._spent = deque()               # when each recent effect ran, oldest first
        self.clock = clock                  # injected so cooldowns can be tested without sleeping
        self._lock = threading.Lock()
        self._cmds = {}
        self._recent = deque(maxlen=LOG_KEEP)
        self._last_cmd = {}                 # name -> when it last ran
        self._last_user = {}                # (name, user) -> when they last ran it
        self.ran = 0
        self.refused = 0

    # -- the registry
    def load(self, items):
        """Replace the registry from config. Bad entries are dropped and said."""
        good, bad = {}, 0
        for item in items or []:
            c = clean(item)
            if c is None:
                bad += 1
                continue
            good[c["name"]] = c
        with self._lock:
            self._cmds = good
        if bad:
            self.log(f"commands: {bad} entry(ies) in the config could not be read and were ignored")
        return self.list()

    def list(self):
        with self._lock:
            return [dict(c) for c in sorted(self._cmds.values(), key=lambda c: c["name"])]

    def get(self, name):
        with self._lock:
            c = self._cmds.get((name or "").lower())
            return dict(c) if c else None

    def _layer_cmds(self):
        """The layers' commands, from the injected source. A scene the source
        cannot read must not take the chat reader down with it."""
        try:
            return list(self.layers() or [])
        except Exception as exc:
            self.log(f"commands: could not read the layers' commands: {exc}")
            return []

    def layer_list(self):
        """The layers' commands as the panel and the inspector show them, each
        with what, if anything, keeps it from answering: "list" when the
        Commands list has the name, "layer" when an earlier layer took it."""
        with self._lock:
            listed = set(self._cmds)
        out = []
        for c in self._layer_cmds():
            c = dict(c)
            c["conflict"] = "list" if c["name"] in listed else ("layer" if c.get("shadowed") else "")
            out.append(c)
        return out

    # -- the limits over all of it (T10)
    def set_budget(self, value):
        """Replace the effects budget from config; returns what was kept."""
        kept = clean_budget(value)
        with self._lock:
            self._budget = kept
        return dict(kept)

    def budget(self):
        with self._lock:
            return dict(self._budget)

    def set_paused(self, flag):
        with self._lock:
            self.paused = bool(flag)
            return self.paused

    def _take_budget(self, now):
        """Claim one effect from the budget, or say it is spent. Claimed before
        the effect runs and handed back if it fails, so two services reading
        chat at once cannot both slip in under the last slot."""
        with self._lock:
            count, secs = self._budget["count"], self._budget["seconds"]
            if not secs:
                return True
            while self._spent and now - self._spent[0] >= secs:
                self._spent.popleft()
            if len(self._spent) >= count:
                return False
            self._spent.append(now)
            return True

    def _give_back(self, now):
        with self._lock:
            try:
                self._spent.remove(now)
            except ValueError:
                pass                        # aged out already, or the budget was replaced

    # -- running one
    def handle(self, msg):
        """A message from any service. Returns the log entry, or None if this
        was not a command of ours.

        Unknown `!words` return None on purpose: every stream has people typing
        `!` at things that do not exist, and a log full of "no such command" is
        a log nobody reads.
        """
        name = (msg or {}).get("command") or ""
        if not name:
            return None
        with self._lock:
            cmd = self._cmds.get(name)
            cmd = dict(cmd) if cmd else None
        if cmd is None:
            # T11: a layer on the scene on air. Asked only after the list, so a
            # name in both answers the way it did before the layer existed.
            cmd = next((dict(c) for c in self._layer_cmds()
                        if c.get("name") == name and not c.get("shadowed")), None)
        if cmd is None or not cmd["enabled"]:
            return None

        user = (msg.get("user") or {})
        who = user.get("login") or user.get("id") or ""
        now = self.clock()

        # First, so a paused stream answers the same way to everybody. "stop"
        # is exempt because it is the way back: a moderator's resume has to
        # work while everything else is off. It still passes the role gate
        # below, so nobody below the gate can resume what a mod stopped.
        if self.paused and cmd["action"] != "stop":
            return self._record(msg, cmd, "paused", "commands are paused")

        if rank_of(msg.get("badges")) < RANK[cmd["role"]]:
            return self._record(msg, cmd, "denied", f"{cmd['name']} is for {cmd['role']} and above")

        with self._lock:
            last = self._last_cmd.get(cmd["name"], None)
            last_user = self._last_user.get((cmd["name"], who), None)
        if cmd["cooldown"] and last is not None and now - last < cmd["cooldown"]:
            return self._record(msg, cmd, "cooling", f"{cmd['name']} is cooling down")
        if cmd["user_cooldown"] and last_user is not None and now - last_user < cmd["user_cooldown"]:
            return self._record(msg, cmd, "cooling", f"you asked for {cmd['name']} very recently")

        # Last of the gates, so a command refused for any other reason never
        # spends the budget. "held" rather than "cooling": the log has to say
        # which limit did it, or a streamer raises the wrong cooldown.
        effect = cmd["action"] in EFFECTS
        if effect and not self._take_budget(now):
            b = self.budget()
            return self._record(msg, cmd, "held", f"too many effects at once - {b['count']} every {b['seconds']} s")

        ok, text = self._do(cmd, msg)
        if effect and not ok:
            self._give_back(now)
        with self._lock:
            self._last_cmd[cmd["name"]] = now
            self._last_user[(cmd["name"], who)] = now
        return self._record(msg, cmd, "ran" if ok else "failed", text)

    def _do(self, cmd, msg):
        if cmd["action"] == "say":
            return True, fill(cmd["response"], msg)
        if cmd["action"] == "scene":
            if not self.run_scene:
                return False, "no scene switcher is wired up"
            try:
                return self.run_scene(cmd["target"] or (msg.get("args") or ""))
            except Exception as exc:                      # a bad scene must not kill the reader
                return False, str(exc) or exc.__class__.__name__
        if cmd["action"] == "queue":
            if not self.run_request:
                return False, "song requests are not set up"
            try:
                return self.run_request(msg)
            except Exception as exc:                      # nor must a bad request
                return False, str(exc) or exc.__class__.__name__
        if cmd["action"] == "poll":
            # `target` says what to do - "close", or a question and its choices
            # written as "Which song? | Sabotage | Intergalactic". Whoever may
            # run this command is the gate; a viewer voting is a different path
            # entirely (polls.py watches the hub for that).
            if not self.run_poll:
                return False, "polls are not set up"
            try:
                return self.run_poll(cmd.get("target") or (msg.get("args") or ""), msg)
            except Exception as exc:
                return False, str(exc) or exc.__class__.__name__
        if cmd["action"] == "gif":
            # `target` is an asset id, chosen from a list in the editor rather
            # than typed: the picture belongs to the command, so one effect
            # layer can serve every gif command instead of needing one layer
            # each. An empty target means the layer shows whatever picture it
            # was given itself.
            if not self.run_gif:
                return False, "showing pictures is not set up"
            try:
                return self.run_gif(cmd.get("target") or "", msg)
            except Exception as exc:                      # nor must a bad picture
                return False, str(exc) or exc.__class__.__name__
        if cmd["action"] == "sound":
            # The same shape as gif, and deliberately a separate action rather
            # than a second field on that one: "show this" and "play this" are
            # different things to a viewer, and a streamer setting up either
            # should not have to think about the other.
            if not self.run_sound:
                return False, "playing sound is not set up"
            try:
                return self.run_sound(cmd.get("target") or "", msg)
            except Exception as exc:                      # nor must a bad clip
                return False, str(exc) or exc.__class__.__name__
        if cmd["action"] == "stop":
            # `target` is "resume" or anything else, and anything else means
            # stop: a command meant to stop the stream must never quietly do
            # nothing because its target was mistyped.
            if not self.run_stop:
                return False, "stopping is not set up"
            try:
                return self.run_stop(cmd.get("target") or "", msg)
            except Exception as exc:
                return False, str(exc) or exc.__class__.__name__
        if cmd["action"] == LAYER_ACTION:
            # The layer is the setup: it already knows what to show and play,
            # so all that goes out is which layer.
            if not self.run_effect:
                return False, "layer commands are not set up"
            try:
                return self.run_effect(cmd.get("target") or "", msg)
            except Exception as exc:
                return False, str(exc) or exc.__class__.__name__
        return False, "no such action"

    def _record(self, msg, cmd, outcome, text):
        user = msg.get("user") or {}
        entry = {"at": time.time(), "service": msg.get("service", ""), "channel": msg.get("channel", ""),
                 "user": user.get("name") or user.get("login") or "",
                 "command": cmd["name"], "args": msg.get("args", ""),
                 "outcome": outcome, "response": (text or "")[:MAX_RESPONSE]}
        with self._lock:
            self._recent.append(entry)
            if outcome == "ran":
                self.ran += 1
            else:
                self.refused += 1
        return entry

    # -- what the pages read
    def recent(self, limit=100):
        with self._lock:
            items = list(self._recent)
        return items[-max(0, min(int(limit or 0), LOG_KEEP)):]

    def status(self):
        with self._lock:
            return {"commands": len(self._cmds), "kept": len(self._recent),
                    "ran": self.ran, "refused": self.refused, "paused": self.paused}

    def snapshot(self):
        """For the state feed: what changes rarely. Never the log.

        `ran` and `refused` only climb, and nothing draws them, so server.py's
        _change_key drops them before deciding whether to send - otherwise
        every command outcome, refusals included, would broadcast the whole
        state to every window.

        `paused` is the opposite case and belongs here: it changes when a
        person presses something, and every window that shows a stop control
        has to agree about it at once.
        """
        with self._lock:
            return {"commands": len(self._cmds), "ran": self.ran, "refused": self.refused,
                    "paused": self.paused}
