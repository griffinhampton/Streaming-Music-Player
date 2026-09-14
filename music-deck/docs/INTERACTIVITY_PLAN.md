# The interactivity plan (from 2026-09-13)

Gifts, chat, text to speech and commands that do things on screen, as ordered
steps.

**How this runs.** You say "continue" and I do exactly one step: build it, test
it on the rig at 8799, update `docs/canvas-builder/DECISIONS.md`, and hand you
the commit command. No approval gates - where a step has a real fork I pick the
one written here and say why. One step has a fork I am *not* taking on your
behalf, and it is marked as such: T5 sends data to a third party, and that is
your call to make, not mine.

**Standing rules these steps obey**: rig at 8799, never the real app at 8713;
headless Chrome only (one monitor, and you game on it); US spelling; no
multi-agent workflow runs; every committed check carries a negative control and
a floor; secret-scan before every commit.

## What is already true (measured 2026-09-13, not remembered)

Most of what this asks for extends something that exists. The parts that do not
are named plainly.

| Thing | Where it stands |
| --- | --- |
| Chat pipeline | **Pluggable already.** `chat.py`: "one message shape, one adapter per service... A fourth service is a new adapter and nothing else." `Adapter` (chat.py:213) wants `service`, `_run()`, and `on_message(message(...))`. |
| Command engine | Exists. `commands.py` `ACTIONS = ("say", "scene", "queue", "poll")`, outward actions injected at `server.py:1299`. |
| Command symbol | **Was hardcoded; T1 made it a setting.** `chat.py:114` `text[:1] in marks`, filled centrally in `message()` so every service agrees. `commands.py:76` strips leading punctuation from names. Two places, one behavior. |
| Alerts | Exist, on their own WebSocket feed (`feeds.serve_ws_feed(self, ALERTS, FEEDS)`, server.py:2155) - deliberately not the state broadcast (server.py:985: "a whole-state broadcast per alert is the mistake"). `KINDS = ("command", "request", "poll", "note")`. |
| Alert *look* | A card: `.alert-title` + `.alert-text` (scene.js:793). `detail` is read in exactly one place, for poll tallies. **A spinning coin with somebody's avatar is not expressible.** |
| TikTok | **No event connection at all.** `tiktok_live.py` is 499 lines of Streamlabs stream-key plumbing (`/tiktok/stream/start`, `end`, `info`). It never joins a live room, and holds no room id. |
| TTS | **None.** `voice.py` is speech *detection*; `captions.ps1` is System.Speech **Recognition**. Synthesis is the same bridge shape, unwritten. |
| Sound on stream | The scene page plays nothing today (every audio path is `muted`/`audio: false`). Stream audio is mic + **system loopback** (`audio.py`), so anything the PC plays is already on air. |
| Adding alert/poll layers | `TYPE_NAME` (inspectors.js:18) and the ADD palette (canvas.js:988) list neither. `canvas.js`, `canvastools.js` and `deck.js` mention neither, at all. They look **API-only**. |
| Third-party deps | `requirements.txt` is four packages, all for Whisper: "the rest of the app is the Python standard library." `protobuf` and `httpx` are present only as transitive deps - not declared, so not to be relied on. |

## Group A - the plumbing, none of which needs TikTok

### T1. A command symbol you choose

`!`, `/`, `@`, or anything else, including "more than one". One setting, applied
in `chat.py`'s `message()` so it means the same thing on every service, plus
`commands.py:76`'s name-stripping. A saved command called `!gif` keeps working
when the symbol changes, because the stored name has never included it.

Care: `/` collides with nothing here, but a symbol that is also ordinary
punctuation (`.` say) will fire on sentences. The setting refuses an empty
symbol and warns on `.` and `,` rather than forbidding them.

Checks: a table of (symbol, text) -> (command, args) including the awkward ones
- symbol alone, symbol-space, doubled symbol, a symbol inside a word.

**Built (2026-09-13).** One parser, as hoped - `chat.py`'s `message()`, with
`polls.py` confirming in its own header that it keeps none of its own, so poll
votes followed for free. The larger half was display: five places said `!` out
loud, two of them alert titles that go on stream. A letter or digit is refused
(`a` would make "apple" run "pple"), and nothing usable falls back to `!`
rather than to nothing. 271 tests to 282, plus nine rig checks on the wiring -
one of which proved that writing the symbol through `/api/config` does not
wipe the saved command list. See DECISIONS, "The symbol that starts a command".

### T2. Commands that do something on screen

Three new actions on the engine that already exists, injected at
`server.py:1299` the way `run_scene` is: **gif** (show a picture or clip),
**sound** (play a clip), **speak** (say text aloud). Each is a `_do()` branch
and an `ACTIONS` entry; the gates, cooldowns and the "who may run this" test
are already written and apply unchanged.

The per-command cooldown matters more here than for `say`: a sound command
with no cooldown is a way for one viewer to make your stream unusable.

**A third built (2026-09-13): `gif` only.** The panel's action list comes
straight from `commands.ACTIONS`, so adding `sound` and `speak` before their
capabilities exist would put two options in front of you that quietly do
nothing. `gif` is in (`commands.py:47`), it names its own picture, and an
Effect layer listening for the `gif` kind shows it - one layer serves every
gif command. `sound` waits on T3's audio asset class; `speak` waits on T7's
bridge. See DECISIONS, "A command that puts a picture on the canvas".

### T3. Sound the app can play

The one genuinely new capability in Group A. Decided here: the sound plays in
the **scene page**, not the server, because a scene output window is already
on stream and Windows' loopback puts anything the PC plays into the mix.
`scene.js:658` already handles the case this runs into - "a page nobody clicked
starts its AudioContext suspended" - and resumes it, so the precedent is
written.

A volume, a per-clip cap, and a queue so two clips do not talk over each other.

**Part one built (2026-09-13): the app will keep a clip now.** The blocker is
gone - mp3, ogg, wav and m4a are assets like any other, with a 24 MB cap of
their own, a `kind` of "audio" so the pickers offer them, magic-byte checks on
the import path, and a serving route that no longer risks handing a clip over
as `image/png`. Both browser prerequisites were already in place
(`--autoplay-policy=no-user-gesture-required`, `overlay.py:32`).

**Part two built (2026-09-13): it plays.** A `sound` action beside `gif`, its
own alert kind, and an effect layer that plays the clip an event names - one
audio element per layer, so a new event stops the last rather than layering
over it, and the clip stops when the effect ends or the layer is deleted.
Volume is a setting, defaulting to 0.8 rather than to silence. A layer with a
sound and no picture is fine: it shows nothing and just plays.

**T3 is done.** What is deliberately *not* here is a global effects budget -
per-command cooldowns already gate this, and the wider "stop everything"
control belongs with T10's abuse pass rather than being invented twice. See
DECISIONS, "Sound the app will play", including the batched edit that left the
layer broken for a few minutes and the probe that failed on a working feature.

## Group B - TikTok

### T4. Where TikTok events would come from (a decision, before any code)

TikTok publishes no supported API for live-room events. The route everything
else uses is the Webcast websocket: discover the room from the username, open
the socket, decode protobuf messages. Discovery and the socket handshake need
request signing, and every community client signs through **somebody else's
server**.

That is the fork I will not take for you, because it means your TikTok session
data passes through a third party. The three honest options:

1. **A signing service** (what TikTokLive and its kin do). Works today, breaks
   whenever TikTok changes, and sends your identifiers somewhere else.
2. **Streamlabs, which you already authorize.** `tiktok_live.py` already holds
   a Streamlabs token and calls `/tiktok/info`. If Streamlabs exposes events
   for the session it started, this needs no new trust. **Unknown** - and I
   will not spend your credentials probing a third-party API to find out.
3. **A local browser session.** The app already runs Chrome; a hidden page on
   your own logged-in TikTok LIVE session can read events the same way the site
   does, with nothing leaving this machine.

My recommendation is to check (2) first because it costs nothing new, then (3),
and to treat (1) as the fallback. Say the word and T4 becomes "find out about
(2)" rather than a design step.

### T5. TikTok chat, through the pipeline that exists

Once T4 has a source, this is one `Adapter` subclass: translate a comment into
`chat.message(service="tiktok", ...)` and everything downstream - the panel,
commands, `!queue`, mentions - works with no further change. That is the payoff
of `chat.py` having been built the way it was.

### T6. Gifts as events

A `gift` kind on the alert hub, carrying what a gift actually is: who sent it,
which gift, how many, the coin value, and whether the combo is still running.
TikTok sends repeat gifts as a *stream* of increments with a "finished" flag;
counting each increment as a separate gift is the classic way to get this
wrong, so the combo is coalesced and only the finished total fires an effect.

**The avatar is a problem this codebase just solved in the other direction.**
A donor's picture is a remote TikTok CDN URL, and as of today `scene.js`'s
`assetUrl` refuses remote schemes outright - because a scene that fetches
someone else's URL is a beacon (see DECISIONS, "A scene that could call
home"). So avatars are fetched **by the server**, cached as ordinary local
assets, and referenced by asset id like everything else. That keeps the rule
intact rather than punching a hole in it, and it also means a dead CDN cannot
stall a layer mid-stream.

### T7. Text to speech, for followers

A `System.Speech.Synthesis` bridge, built like `captions.ps1`: a PowerShell
child process, JSON lines in, audio out of the PC's speakers, which the stream
already captures. No model download, no network, and it is the same shape the
captions bridge proved.

"Following" has to come from the same event source as T4; until then the gate
falls back to "anyone" or "gifters only", which need no follower list.

TTS reads viewer-written text aloud, so it ships with the abuse controls in the
same step, not after: a length cap, a rate limit per user, a queue with a
maximum depth, a blocklist, and a skip control on the deck. A stream cannot be
un-said.

## Group C - the effects layer

### T8. A Gift effects layer

The new layer type. `TYPES.gift` in `scene.js`, an inspector section, a
`TYPE_NAME` entry, an ADD palette entry, and its CSS - three files plus the
palette, which is what every existing type touches.

What it draws, in order of ambition: a card (what alerts do today), a picture
or clip chosen per gift, **an object thrown for each coin**, and **a spinning
coin wearing the donor's avatar**. The last two are CSS 3D transforms on a
small pool of elements - not a physics engine, and capped hard, because one
object per coin on a 5,000-coin gift is a frozen stream. The cap is a setting
with a sane default and the overflow is expressed as speed, not count.

**Half built (2026-09-13): the layer exists, the gift part does not.**
`TYPES.effect` (`scene.js:866`) shows a picture or a clip when an event
arrives and hides after its seconds, filtered by kind, queue-capped, riding
the alert socket that was already there. It went in with its palette entry,
its `TYPE_NAME` and its inspector together, so it does not repeat the alert
layer's fate below.

What is left here is the gift-shaped part, and it is the larger half: coin
counts and combos (T6), an avatar fetched and cached server-side rather than
hotlinked, one object thrown per coin with a hard cap, and the spinning coin.
The card-and-picture case is done; the physics-ish case is not. See DECISIONS,
"A layer that shows something when something happens" - including the two
faults it turned up: every picture picker in the app was hiding animated GIFs,
and the first probe passed 8 of 8 while photographing an empty stage.

### T9. Alert and poll layers you can actually add

**Built (2026-09-13).** Both are in the Add palette with the defaults their own
runtimes fall back to, so a layer added from the grid matches one built through
the API. Verified by adding each and reading the layer back, with a control
that inserting into `ADD` did not shift the two places that index it by
position. It also turned up a real bug next door: pasted text was cloning the
PNGtuber entry's props, so it drew at 48px instead of 72 and carried five
meaningless props into the scene. See DECISIONS, "Alert and poll layers you
can actually add".

The gap found while reading for this plan: `TYPE_NAME` and the ADD palette
list neither, so S14's and S15's layers appear addable only through the API.
T8 must not repeat it, and this step fixes it for the two that already shipped.

### T11. Set up on the canvas, like everything else (asked for 2026-09-13)

Your words: *"the tts, gift animations, and chat commands, should be able to be
set up like the components on the canvas builder"*.

How I read that: each one is a layer you add from the Add grid and set up in
the inspector, and **the layer is the setup** - not a layer on the canvas plus
a separate form somewhere else that has to be kept in step with it.

- **Chat commands.** An Effect layer gets a "Triggered by" section in its
  inspector: a command name, who may run it, and its two waits. Adding the
  layer makes the command; deleting the layer removes it. Its events are
  addressed to that layer, so two effect layers with two commands never answer
  for each other. The Commands list stays, for what has no layer to belong to:
  say, scene, queue, poll and stop.
- **Gift animations (T8).** Already a layer by design; its inspector is where a
  gift, a coin threshold, what gets thrown and the cap are chosen.
- **Text to speech (T7).** A layer too: voice, speed, volume, who may use it,
  what starts it (a command, or every message from a follower), the length
  cap, the per-person wait, the blocklist - and, if you want it, the line
  being read drawn on screen as it is spoken.

The rule that makes this coherent: **only the scene on air listens.** A
command, a gift animation or a voice belongs to a layer, and a layer on a
scene nobody is watching can show nothing and play nothing - the sound comes
out of the scene page itself (T3). So switching to a scene without a TTS layer
switches TTS off, which is also the simplest mid-stream "off" there could be.

What does not change: T10's budget, pause and stop sit in the engine, so a
command that belongs to a layer is counted, paused and stopped exactly like one
from the list. A layer's command with the same name as one in the list is a
conflict the inspector must show, not one the server settles quietly.

Consequence for the order: T7 and T8 are built as layers from the start, and
this step comes first, because it decides the shape they are built into. None
of it needs TikTok.

**Built (2026-09-13) for the Effect layer**, the one that exists; T7's and
T8's layers join the same list (`commands.py` `LAYER_TYPES`) when they do. An
effect layer's inspector has a **Chat command** section - a name, who may run
it, and its two waits - and a note under it that says in words what the name
does, or why it will not: not a usable name, the Commands list has it, another
layer took it first, the layer is hidden, or the scene is not on air yet. The
Commands panel lists these read-only, so everything the stream answers to is
in one place. The server asks the scene on air on every command, cached on its
revision, so no switch, save, undo or restore can leave a command answering for
a layer that is gone. T10's budget, pause and stop apply unchanged. Driven
through the real inspector and a fake chat server on the rig, 27 checks. See
DECISIONS, "Commands set up on the layer they set off".

## Group D - before any of it goes near a real stream

### T10. The abuse pass

One step that goes over the whole surface at once, because the pieces are only
safe together: cooldowns per command and per user, a global effects budget, the
TTS controls from T7, what a moderator can switch off mid-stream, and a single
"stop everything" control on the deck. Rig-tested by firing a flood at it and
watching what the scene does.

**Built (2026-09-13), all but the TTS part** - T7 ships its own controls in
the same step, as its text says, and they will sit under these. An effects
budget over every command (five pictures or sounds in any thirty seconds by
default, `held` in the log); a pause that refuses every command except the new
`stop` action, so a moderator's resume still gets through its role gate; and
**Stop effects** in the Live view's header, which clears every effect and alert
layer - queue included - and pauses, with its label riding the state feed so a
moderator stopping from chat changes it in every window. Fired at with twelve
viewers on the rig, 38 checks, with the budget switched off as the control.

It shipped with a bug for one run: the scene hook was called `stop()`, which
the microphone layer already had, so pressing the button would have frozen a
meter on stream. Renamed, and guarded twice. See DECISIONS, "Stop everything,
and a limit over every command".
