# The Stream Deck plan (from 2026-09-12)

Everything asked for after the Canvas Builder walk-through, as ordered steps.

**How this runs.** You say "continue" and I do exactly one step: build it, test
it on the rig, rebuild your app, update DECISIONS.md, and hand you the commit
command. No questions, no approval gates, no choosing between options - where a
step has a real fork in it I pick the one written here and say why. Nothing
waits on you except the commit itself, which I cannot run: the permission
classifier blocks git commit and push from this session, so each step ends with
a command for you to paste. That is the one thing I cannot take off your hands.

**Standing rules these steps obey** (from the project's own history): test on
the rig at 8799, never the real app at 8713; one monitor here, so headless
Chrome only; secret-scan before every commit; US spelling; no multi-agent
workflow runs; the golden screenshots in `tools/p9/golden` are regenerated
deliberately, one file at a time, never with a blanket `update`.

**What is already true**, so no step wastes effort rediscovering it:

| Thing | Where it stands today |
|---|---|
| Scrollbars | Styled in `deck.css` 787-793 only. `canvas.css` has no rule, so the Canvas Builder falls back to Chrome's Windows scrollbar with arrow buttons. |
| Output windows | `hostwin.py` 25-34 makes them `WS_POPUP` with **no `WS_CAPTION`** - borderless on purpose. Windows therefore gives no title bar to drag and no close button. Position already persists in config under `canvas.outputs.<id>`. |
| The cards | `deck.js` 2420 `cardHtml()` and 2436 `sceneCardHtml()`; three buttons crammed into `.wc-foot` beside the size text. |
| The warning mark | A `⚠` **text emoji** in two rendered places: `canvastools.js` 543 (`.zone-badge`) and `canvas.js` 655 (`.row-warn`). Emoji carry their own baseline, which is why it sits off-center in a centered box. `icons.js` is the app's SVG convention and already forbids emoji in as many words. |
| Screen frame, Camera frame | Registered pop-out components (`components.py` 160-165) serving `frame.html?kind=screen\|camera`, settings in app config, not in a scene. That is why they feel disconnected from the canvas. |
| PNGtuber support | Already exists as the `reactive` layer type - idle / talking / blink pictures with a bounce, driven by `/api/voice`. It is buried behind a generic `triggers: [{on, do}]` system that explains nothing. |
| Audio | `live.py` already mixes WASAPI microphone + desktop loopback into the stream; `/api/live/audio` takes source, gain 0-4 and mute; the LIVE panel has meters. There is no audio panel outside going live. |
| Chat | Nothing. No Twitch, YouTube or TikTok code anywhere. |
| Spotify queue | Read-only. `_fetch_queue` reads `/me/player/queue`; appending is possible in the Web API but was never built. |

---

## Group A - the things that look broken

### S1. Scrollbars, everywhere

`deck.css` styles them and nothing else does, so the Canvas Builder, the LIVE
panel and every component page show Chrome's default Windows scrollbar. Move
the rule into a shared place both stylesheets pull from, cover the editor's two
side panels, the inspector's scrolling sections, the picker grids and the
modals, and keep a visible thumb on a dark ground rather than a hairline.

*Checked by:* a headless pass over `deck.html`, `canvas.html` and `scene.html`
reading the computed scrollbar width, plus a screenshot of the editor's left
panel scrolled.

### S2. Every mark in a button, centered and drawn

Add a `warn` glyph to `ICONS` and replace both `⚠` emoji with `svgIcon('warn')`.
Then walk every icon-bearing button in the deck and the editor - `.btn.icon`,
`.row-btn`, `.align-bar`, `.ctx-row`, the transport buttons, the reset dot, the
caret - and confirm each glyph is optically centered at its real rendered size,
not merely inside a flex box. The reset dot's `↻` and the caret's `▾` are text
characters too and go the same way.

*Checked by:* a headless sweep that measures every `button` containing an svg or
a single glyph and reports any whose ink center is more than one pixel off the
button's center; the list must come back empty.

### S3. Output windows you can move and close

Frameless is deliberate - a border would be captured into the stream - so this
builds the affordance rather than turning the frame back on. In the output
page: a grab strip along the top that appears on hover and drags the host
window, a close button beside it, both hidden while LIVE unless held, and both
absent from what the stream captures. The window's new position is written to
`canvas.outputs.<id>` so it opens where you left it. In the editor and the deck
card: "Move to…" (a screen picker, plus off-screen), "Reset position", and a
close that actually closes.

*Checked by:* rig test - open an output, drag it, confirm the host moved and the
config recorded it; close it from the page and from the card; reopen and land in
the same place; confirm the strip is not in a WGC capture of the window.

### S4. The cards

`sceneCardHtml` puts a primary and two ghost buttons in a row beside the size;
`cardHtml` puts a lone Open inline. Rebuild both: one clear primary action per
card, the rest behind a small menu, a real state chip rather than the word
"closed" in grey, the size as quiet metadata, and a card that reads as one
object rather than a row of controls. Same treatment for the Screen frame and
Camera frame cards until S5 removes them.

*Checked by:* screenshots at the three deck widths the CSS already breaks at,
plus the existing deck suite staying green.

---

## Group B - the canvas makes sense

### S5. Frames belong to the canvas

Screen frame and Camera frame are windows with their own settings, which is why
they do not appear to work when you are setting a scene up. Port them to a
first-class **Frame layer** in the Canvas Builder: the same border styles,
shape, corner badges, title plate and decor loop, but read from layer props and
drawn in the scene, with a see-through or key-color hole like the existing
`shape: frame`. Diagnose what is broken about the pop-out version on the way and
record it. Keep the pop-outs working for anyone using them through LIVE Studio,
but the deck cards move to a "legacy windows" group so the canvas is the
obvious home.

*Checked by:* a scene with a frame layer around a native capture hole, captured
by WGC and compared against the same frame drawn by the pop-out page.

### S6. PNGtuber first, and triggers cut down to what makes sense

The feature you wanted exists: the `reactive` layer swaps a quiet picture for a
talking one off the microphone. It is unfindable and sits next to a generic
trigger system that reads like nonsense. So: rename it in plain words ("You,
talking" or similar), give it a proper place in the Add list with a picture of
what it does, and make its setup one screen - quiet image, talking image,
optional blink, sensitivity with the live meter right there.

Then narrow triggers to the cases that are real: **while I talk** and **when I
start talking**, with a short list of things worth doing (swap picture, bounce,
show or hide, glow). Everything else goes. Add the one you named: **highlight
the camera frame while talking** - a talk-driven outline on any layer, so a
camera or a frame layer lights up when you speak.

*Checked by:* rig test driving `/api/voice` between quiet and talking and
reading the rendered scene each way; the P9 trigger checks rewritten to the new
vocabulary.

### S7. The microphone as a source, and an audio panel

The mixer already exists inside going live; nothing exposes it otherwise. Build
a proper audio panel - reachable from the deck and the editor - with the input
device, gain, mute, a live meter and monitoring, the desktop-sound channel
beside it, and the talking threshold shared with S6 so there is one number, not
two. Add a **microphone layer** for scenes: a level meter or waveform you can
place on the canvas, which is what "add your microphone as a source" means for
an overlay.

*Checked by:* the panel driving `/api/live/audio` and `/api/voice` on the rig
with the meters moving; a scene with a microphone layer captured while sound
plays.

### S8. The whole flow, gone through button by button

The pass you actually asked for. Every control in the Canvas Builder, in order
of the job someone is trying to do: make a scene, put things in it, arrange
them, see it, put it on stream. Fix what does not read, what is out of order,
what has no empty state, and what offers no way back. Bring the deck's
per-component design into the editor properly - a modal is fine - so you are
not sent to another window to change the colors of a thing you are looking at.
First-run guidance for an empty canvas. A written walk-through of the intended
flow goes in DECISIONS.md so the next change has something to disagree with.

*Checked by:* the persona walk-through re-run against the new flow, and the
remaining audit items from the first one closed or explicitly deferred.

---

## Group C - the stream deck

### S9. A Live view

A page like the Canvas Builder but for a stream that is running: what is on
air, health, the scene switcher, audio, and the chat from S11. Same shell, same
tokens, its own job.

### S10. Chat, ingested

**Twitch first** - IRC over websocket is official, documented and free, and it
is the fastest way to a working chat pipeline. **YouTube second** - the Live
Chat API is official and quota'd. **TikTok is a decision, not a step**: there is
no official read API for LIVE comments at this tier, so it needs an unofficial
connector, which carries the same account risk I flagged over the stream key.
When we reach it I will lay out what it costs and what it risks, and you decide
- I will not quietly build it in.

Design it as one internal message shape with a per-service adapter, so a fourth
service is an adapter and nothing else.

### S11. The chat panel

Chat in the Live view: one merged stream with the service marked per message,
badges, an at-a-glance highlight for commands and mentions, pause-on-scroll,
and basic moderation - hide a message, block a user locally. Read-only from the
streamer's side to begin with; replying is its own step.

### S12. The command engine

`!command` parsing with a registry: who may run it (anyone, subscriber, mod,
you), a cooldown per command and per user, what it does, and what it says back.
An editor for it in the Live view. Every command logged so you can see what
fired. This is the spine the next three steps hang off.

### S13. `!queue` - chat queues music

Needs new Spotify work: search for what they asked for, then append to the
queue, which the app has never done. Guard rails: a per-user cooldown, a
length cap, a block list, and a queue of pending requests you can approve or
skip if you want it moderated. The existing queue window shows what is coming.

### S14. Polls and voting

A poll engine - open a poll, collect votes from chat commands, close it, keep
the result - and a **poll layer** for scenes so viewers see the bars on stream.
Started from the Live view or by a command from you.

### S15. Alerts and command output on stream

Whatever chat sets off should be able to appear on the canvas: an alert layer
driven by events, and a small event bus so S12's commands, S13's queue and
S14's polls all reach the scene the same way.

---

## Group D - the debts already on the books

### S16. The inspector's type, and the goldens

Deliberately deferred earlier: growing the inspector's 10.4 px headings changes
the clip height of all ten P9 goldens. This is the step where regenerating them
is the point rather than a side effect.

Do one more thing while they are all being rewritten anyway. S1 turned up that
the goldens **contain the inspector's own scrollbar**: `#inspector` is 300 px
wide including its bar, the clip is that whole width, and changing the bar from
Chrome's 15 px default to our 10 px thumb repainted a full-height band at
x 285-298 *and* handed the content five more pixels, which shifted every
`width: 100%` control sideways - 6.51% of the image against a 1% threshold,
with no change in height at all to warn anyone. So any future scrollbar tweak
silently breaks this suite. Add a scrollbar suppression to `HIDE_DYNAMIC`
(which already hides the live note, the meters and the save state for stable
shots) so the bar is not in the picture, and the whole class of change stops
mattering. It has to happen in the step that regenerates all ten regardless.

### S17. The rest of the walk-through

Rotation that lands on 357.4 degrees with no easy way back to straight;
resizing a text box stretching the box rather than the letters; and the
conventions worth arguing about - Space-to-pan, wheel-to-zoom, drag-to-marquee.

### S18. Housekeeping

`rebuild.ps1` needs `exit 0` so it stops reporting a fake failure on every
build - it has reported one six times in a row and each needed checking by
hand. And the Spotify token in commit 62e2105 still wants revoking; that one is
yours to do.

---

## Order, and why

A first, because you are looking at it and it is small: scrollbars, marks,
windows you can move, cards that read. B next, because the canvas has to make
sense before more is piled onto it, and because S6 and S7 are features you
believe are missing that are mostly buried. C last and largest, because chat is
a new subsystem and everything in it depends on S12's spine. D whenever a step
in it blocks something else, and S16 the moment the inspector is touched again.

Nothing here is fixed. If a step turns out to be wrong when I open the code, I
will say so before building it rather than after.
