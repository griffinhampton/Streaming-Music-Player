# Canvas Builder - P0 decisions

Measured on 2026-09-11 on the user's PC (Windows 11, 2560x1440 at 150%,
165 Hz, RTX 3080 + Radeon iGPU, TikTok LIVE Studio 1.35.2, OBS 32.0.4,
Chrome stable). Everything below was either measured here with the tools in
`music-deck/tools/p0/` or read from the installed apps' own files. Web
sources are marked as such.

## The decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | How are scenes output? | As web pages (`scene.html`) inside hosted pop-out windows, like the four components today. Any size works, including 1080x1920 portrait, and a window can be parked entirely off screen and still renders and captures at full rate. |
| 2 | How do scenes reach the stream? | Two ways. **A. Through LIVE Studio:** *Window capture* of the output window (opaque, with the scene's own background) or *Browser capture* (the "Link" source) of `http://127.0.0.1:8713/scene.html?id=...` when the overlay must be see-through. **B. Straight from the app:** the app encodes and pushes RTMP to TikTok with the Server URL + Stream key that LIVE Center hands out, no LIVE Studio or OBS in the loop. B is a new track in the plan. |
| 3 | How is transparency delivered? | Browser capture (Link) for see-through overlays, a key color as the fallback. Never per-pixel alpha through window capture: our host windows are opaque, and window capture drops alpha anyway. |
| 4 | Capture engine for screen, window, game and camera | Windows Graphics Capture, the API OBS and Discord use. Proven from Python with ctypes alone at ~0% CPU (frames stay on the GPU). Inside scene pages, Chrome's `getDisplayMedia` (also WGC underneath) with `--auto-select-window-capture-source-by-title` opens the source with no picker. **Decided in P1 (below): the app captures the output window itself and encodes on the GPU; Chrome renders the scene and, for now, supplies audio.** Chrome's own capture-and-encode path stays as the fallback. |
| 5 | Encoding | **P1:** the GPU's H.264 encoder through Media Foundation, on the adapter the desktop runs on (`mfenc.py`). WebCodecs in Chrome (H.264 High incl. portrait, HEVC, AAC-LC - all supported here) is the fallback path and the audio path for now. Presets copied from LIVE Studio's own table. No ffmpeg bundled (a GPL 94 MB build sits in Downloads; fine as a test sink, not shipped). |
| 6 | Live state feeds | Chrome allows exactly 6 connections per host:port per profile, and SSE streams count. Rule: one feed per page; embedded components get state by `postMessage`; a small stdlib WebSocket endpoint (its own pool of 255) carries encoded media from the output page and the state feed for pages past the cap. |
| 7 | Camera and mic permission | The app grants itself camera and mic for its own origin by seeding `content_settings.exceptions` in the pop-out Chrome profile's `Preferences` (proven: no prompt). Grants are per origin including the port. Screen capture needs no grant with the auto-select flag. |
| 8 | Portrait size | 1080x1920 native output (no downscale needed); 720x1280 as a lower preset for weak upload. |
| 9 | Order of work | Backend, streaming and architecture first (run with Fable), frontend last (run with Opus). |

## Evidence

### 1. TikTok LIVE Studio 1.35.2 (installed copy, read from its own files)

Source types, from `TTStore/localStore.json` (`add_source_config`): general
= game, camera, monitor, window, image, text, browser, media, android, ios,
anglog (capture card), restream; widgets = alert, goal, chatbox,
interactiveCounter, rankingSticker, leaderBoard, countdown. The English
strings name the browser one "Browser capture - add web content to your
scene, such as web pages and widgets. Supported contents: websites,
third-party widgets, HTML". The help center calls it "Link".

- **No CEF.** The install has no `libcef.dll`; `browser_visual_source.dll`
  is 0.2 MB and takes BGRA textures (`BufferWithHandleTexture`,
  `AMGPixelFormat`), so Electron itself renders Link sources off screen.
  `merge_process_browser_type` = text, alert, goal, chatbox, countdown,
  leaderBoard: LIVE Studio's own Text and Alert sources are browser
  sources composited with alpha over the scene. Link sources ride the same
  path, so a transparent page should keep its alpha. Overlay vendors give
  users transparent URLs for the Link source (web, community). A 30-second
  manual check is listed under Open items.
- **Chroma key** exists (`chroma_key_visual_filter.dll`, strings under
  "camera background"), documented for the camera. Not relied on.
- **Layouts:** portrait, landscape and dual. Dual needs NVENC/AMF, the
  second canvas is capped at 720x1280 (`dual_canvas` config). Quality
  presets (`preset_config_v2`): 1080P60 7600 kbps H.264 / 6400 HEVC,
  1080P 6000/5200, 720P60 4400/3800, 720P 3400/3000, 480P (852x480)
  2000/1800; audio 256 kbps. Our encoder presets copy these.
- **Stream key:** LIVE Center strings "Server URL", "Stream key", "Go LIVE
  to get stream key", "Copy the new key to your streaming software to
  resume your LIVE" and "Your stream key is updated due to unstable
  connection". So keys exist, are shown when a LIVE is started from LIVE
  Center, and can rotate mid-stream (the app must surface that).
- **Frame rate limiting on fast screens:** `electron_framerate_limit`
  divides its UI rate by 2 at >=100 Hz and 3 at >=180 Hz. Same idea as our
  30 fps motion rule.
- **Scene transitions:** fade by default on hardware levels A/B, browser
  sources preloaded (max 20), `source_invisible_optimization` on.
- Web (official help, Feb 2025): window capture advice is "keep the window
  open"; capture methods named are "shared texture" and "memory" for game
  capture; a Sep 2024 community report says a transparent PNGTuber window
  came out black in Window and Game capture.

### 2. A window taller than the screen, captured whole (measured)

`tools/p0/tallwin.py` opened a 1080x1920 page through the app's own
`Overlay` + `HostWindow` code:

- The plain Chrome window was clamped by Windows to 1080x1427 (the screen
  is 1440 tall; `WM_GETMINMAXINFO`). Once adopted as a `WS_CHILD` of the
  host, resizing to 1080x1920 worked and the page laid out at 1084x1924
  (2 px overhang each side, as designed). **App rule:** size the host first,
  resize Chrome after adoption; never trust the plain window's height.
- WGC of the host (`tools/p0/wgc.py`): item and content 1080x1920, the
  bottom label at y=1924 visible in the frame, 55 fps delivered.
  Fully off screen at x=-3000: still 54.5 fps with the counter advancing.
  Half off the right edge: 55 fps. Capture loop CPU ~0% of one core.
- So output windows never have to be on the desktop. Chrome keeps painting
  because the app already runs it with `CalculateNativeWinOcclusion` off
  and backgrounding disabled.

### 3. Capture "like OBS or Discord" (measured)

`wgc.py` is Windows Graphics Capture from Python with ctypes only (no
packages): `Direct3D11CaptureFramePool` on a D3D11 device, cursor off,
yellow border off. LIVE Studio's window: 30.6 fps (its own paint rate),
first frame after 9 ms, ~0% CPU while capturing. This becomes the app's
capture module (source lists with live thumbnails, and the native
compositor fallback). Chrome's `getDisplayMedia` uses WGC too, so both
paths are the OBS mechanism.

### 4. Camera and screen share in a Chrome `--app` window on 127.0.0.1 (measured)

`tools/p0/mediatest.ps1` + `cdp.js` (DevTools `Runtime.evaluate` with
`userGesture`, which is the transient activation `getDisplayMedia` wants):

- `getDisplayMedia({video:{frameRate:30}})` with
  `--auto-select-window-capture-source-by-title=P0 Anim Source`: resolved
  in under a second, no picker, `displaySurface: window`, 30 fps into a
  `<video>` (first run, 30.2 fps by `requestVideoFrameCallback`). The
  second run reported no new frames in 4 s, so its CPU number (9.3% of one
  core for capture + decode + video, source in another process) is not
  trusted. P1 re-measures.
- `getUserMedia` camera, fresh profile: blocked on a permission prompt.
  With `Default/Preferences` seeded
  (`profile.content_settings.exceptions.media_stream_camera`/`_mic` ->
  `"http://127.0.0.1:8799,*": {"setting": 1}`): no prompt, the call reached
  the device (`NotReadableError` only because OBS and LIVE Studio were
  holding the camera). Camera CPU was therefore not measured; P3 does.
- Chrome one-time permissions (web, Chrome 116+): "Allow this time" vs
  "Allow on every visit"; grants are per origin, and a port is part of the
  origin.

### 5. The six-connection cap (measured)

`tools/p0/sse.ps1` with `p0-sse.html` on the rig, fresh profile:

- One page opening 8 `EventSource`s: exactly +6 established connections;
  the 7th and 8th never opened.
- 8 windows with one `EventSource` each, same profile: windows 1-6 got
  their feed; windows 7 and 8 never even loaded their page; plain
  `fetch('/api/state')` from windows 3-6 stalled past 6 s (windows 1-2 had
  fetched before the pool filled).
- Today's app: deck + 4 pop-outs = 5 feeds. Two scene outputs would hit
  the cap, and every embedded component would add one. Hence decision 6.
- Chromium: 6 sockets per group, group = scheme+host+port (so 8713 and
  8799 are separate), WebSockets in their own pool of 255 (web, source).

### 6. Baseline CPU (measured on the rig, 15 s, `tools/p0/cpuby.ps1`)

Now Playing + Captions windows open, caption engine off, nothing playing:
Chrome 20.7% of one core (gpu-process 12.7, renderer 7.2, browser 0.2),
server 1.1%. On 16 logical processors that is ~1.4% of the machine. The
user's target for everything is about 5% total; a scene with the same two
components embedded must not exceed the two pop-outs (P3 measures the A/B).

### 7. Encoders on this machine (measured)

Media Foundation transforms registered: NVIDIA H.264 and HEVC, AMD H.264
and H.265, Microsoft H264 (software) and Microsoft AAC. `nvEncodeAPI64.dll`
present. Chrome WebCodecs (`p0-codecs.html`): `avc1.640028` 1920x1080@60
hardware = true, software = true, 1080x1920 portrait hardware = true,
HEVC hardware = true, `mp4a.40.2` 48 kHz and 44.1 kHz = true, Opus = true.
A real encode of 60 frames of 1080p (canvas draw + `VideoFrame` +
`VideoEncoder` realtime) took 1133 ms including encoder start-up.
`ffmpeg` 8.0 (gyan.dev essentials, GPL) is on PATH from Downloads with
`h264_nvenc`, `aac`, `rtmp`/`rtmps`: a good local RTMP sink for tests
(`-listen 1`), not something to ship.

## What OBS and LIVE Studio do well, and where this app goes further

**OBS** (user's scene collection + UI): scenes hold sources with a full
transform (position, scale, crop, rotation, bounds type), each source has
filters (chroma key, color, scaling), an audio mixer with meters and per-
source gain, studio mode (preview then Take), transitions with duration,
projectors, virtual camera, hotkeys, and everything is a plain JSON scene
collection. It idles at 1.7% CPU while rendering 60 fps.

**LIVE Studio:** portrait-first with a dual layout that syncs sources to
landscape, TikTok-shaped widgets (alerts, goals, chatbox, leaderboard,
countdown, polls) that are just browser sources, camera background removal
and effects, hardware-level tiers that decide defaults, preloaded browser
sources for instant scene switches, capture-source picking with a live
list, and the stream key flow with mid-stream key rotation.

**Where we go further:** everything local and one process; the components
already fed by live song, lyrics and caption state; a real design system
for overlays (fonts, border loops, generative backgrounds); output windows
that live off screen so nothing clutters the desktop or gets captured by
accident; images and triggers driven by the mic; near-zero idle cost; and
going LIVE without LIVE Studio or OBS at all.

## CPU budgets (one core = 100%)

| Situation | Budget |
|-----------|--------|
| Idle static scene window (no motion) | <= 2% |
| Scene with Now Playing + Captions embedded | <= the two pop-outs (20.7% today) |
| Border loop / motion layers | 30 fps, stepped, still under Ultra |
| Window or camera source in a scene, 720p30 | <= 8% each, measured in P3 |
| Going LIVE 1080p30 direct (capture + encode + mux) | <= 15% total, Chrome <= 10, Python <= 3 |
| Mic level monitor | <= 1% |

## Open items

1. **Manual 30-second check (Link transparency):** in LIVE Studio, Add
   source > Browser capture, URL `http://127.0.0.1:8713/transparency-test.html`.
   If the scene background shows through around the pink card, the yellow
   dot and the text, the Link source keeps alpha (expected). If it comes out
   black, transparent overlays for LIVE Studio use the key-color fallback.
   Delete the source afterwards. (Injected clicks are blocked from the
   sandboxed tool process, so this could not be automated here.)
2. Camera CPU in a `<video>` (camera was busy with OBS + LIVE Studio).
3. `getDisplayMedia` capture cost, cleanly measured (P1).
4. Whether the user's account shows a Server URL + Stream key in LIVE
   Center (needed for direct streaming; LIVE Studio access suggests yes).

## P1 - the streaming engine (measured 2026-09-11)

Both ways of going LIVE were built and run against a local RTMP sink
(`ffmpeg -listen 1`) on the rig, with every recording probed afterwards.
The publisher is `live.py` (FLV tags, RTMP handshake/connect/publish/acks/
pings/extended timestamps/clean unpublish, reconnect with backoff, a DPAPI
key vault, a stdlib WebSocket); connect + publish takes 20 ms.

**Path A - Chrome captures and encodes** (`web/stream-spike.html`: source ->
`VideoEncoder` H.264 on the GPU + `AudioEncoder` AAC -> WebSocket -> RTMP).
Warm profile, no preview, source window exactly the output size, 45 s runs:

| Source, preset | Chrome % of one core (gpu / browser / renderer) | Server |
|---|---|---|
| Window capture, 720p30 | 37.5 (21.2 / 7.4 / 6.7) | 3.0 |
| Window capture, 1080p30 | 58.3 (34.4 / 11.7 / 9.3) | 3.6 |
| Tab self-capture, 720p30 | 45.9, of which 12.6 is drawing the page itself | 2.8 |

The cost is in Chrome's plumbing (frames copied capture -> renderer -> GPU
process), not in the encoder, and it is the same whichever way the frames
get in. The stream itself was fine: 28-30 fps, 3.3-5.5 Mbps, keyframes every
2 s, AAC 48 kHz, zero drops.

**Path B - native** (`capture.py` WGC -> `mfenc.py` Media Foundation ->
`nativelive.py` -> `live.py`; the page carries only audio):

| Preset | Server % of one core (capture + encode + mux) | Chrome, audio only | Result |
|---|---|---|---|
| 720p30, 45 s | 12.4 | 8.2 | 30.0 fps, 3.5 Mbps, 0 drops |
| 1080p30, 45 s | 14.1 | 9.0 | 30.0 fps, 6.1 Mbps, 0 drops |
| 720p30, 5-minute soak | 13.7 | 7.4 | 9745 frames, 15306 audio packets, 0 drops |
| 1080p30, 5-minute soak | 14.6 | 8.2 | 9767 frames, 15322 audio packets, 0 drops |

Capture and encode alone (no RTMP, standalone `tools/p1/nativetest.py`):
9.5% of one core at 720p30, 3358 kbps against 3400 asked, every frame
decodable, memory flat (63-66 MB over 60 s). The window being captured
costs 14-19% in its own Chrome (that is the stand-in for the scene).

**Decision: go with the native path.** It meets the budget (<= 15% of one
core for the server at 1080p30); with audio still in Chrome the total is
about 23%, expected to fall under 17% once audio goes native in P4. Path A
stays as the fallback for a machine whose hardware encoder refuses the
device.

What the build taught us:

- The encoder must sit on the adapter the desktop is drawn on, because
  that is where WGC's textures live. Here that is the AMD integrated GPU:
  `AMDh264Encoder` activates, is D3D11-aware, and takes **RGB32 textures
  directly** (no color conversion of ours). The NVIDIA MFT answers
  `E_UNEXPECTED` to activation in this process (the device is the other
  GPU); Chrome manages it because its GPU process sits on the NVIDIA card.
  P4 tries a device on the NVIDIA adapter when the desktop runs there.
- The AMD MFT is asynchronous: it must be unlocked, then fed on
  `METransformNeedInput` and drained on `METransformHaveOutput`. Offering a
  frame only at the tick and dropping it if the encoder has not asked yet
  halves the frame rate; keeping the frame until it asks gives exactly
  30 fps. Driven without events it accepts input and returns empty samples.
- `IMFMediaEventGenerator` is `{2CD0BD52-BCD5-4B89-B62C-EADC0C031E7D}` -
  the last byte is 7D, not 7B; the registry (`HKCR\Interface`) is the
  quickest source of truth for such constants without the SDK headers.
- `MF_MT_MAX_KEYFRAME_SPACING` on the output type is ignored by the AMD
  encoder: keyframes came every 1 s (30 frames) at both sizes. Fine for
  streaming; P4 sets the GOP through `ICodecAPI` instead.
- WGC trims a plain window's invisible 6 px borders (a 1280x720 window
  captures as 1268x714); a frameless host window captures at its exact
  size. Output windows are hosted, so the stream size is the window size.
- One clock: the engine stamps native video by tick and re-stamps the
  page's audio on arrival, so both share a timeline without the page
  knowing the server's time; the recordings show continuous A/V.
- Two COM reference leaks were found and fixed (a per-frame `IClosable`
  and the output buffer's event list). What remains: the server's working
  set climbs ~3 MB/min while streaming after a ~45 MB warm-up, and is not
  returned after stop (34 -> 91 MB between soaks); standalone capture and
  encode are flat, so it is in the engine/socket path or MF output
  handling in the server process. **P4 finds it** (a 2-hour soak is P5's).
- Chrome's screen capture, WebCodecs and the AAC encoder all worked as
  documented; the `--auto-select-window-capture-source-by-title` and
  `--auto-accept-this-tab-capture` flags skip the pickers as expected.
  A fresh Chrome profile burns 8-10% of a core on first-run work for
  minutes; measure on warm profiles, and add
  `--disable-component-update --disable-background-networking` to the
  pop-out flags in P2.

Not done in P1: a real LIVE to TikTok with the user's key (the page and
vault are ready; it needs the key pasted once). `tools/p1/` keeps
`livetest.ps1` (the rig driver, `-Native` for path B, `-Seconds` over 120
for a soak), `rtmptest.py`, `nativetest.py`, `mfprobe.py`, `mfdbg.py`,
`memcap.py`.

## P2 - the server architecture (2026-09-11)

The backend every later step stands on, as modules next to `server.py`:

- `components.py` - the registry. A component is an id, label, page,
  config section, default size, group and capabilities; the four old route
  names are aliases. Scene outputs register as dynamic components
  (`scene:<id>`, settings under `canvas.outputs`) and follow the store as
  scenes are created, renamed and deleted. Also the camera/microphone
  self-grant (P0's method), run for both Chrome profiles at start and again
  before the first pop-out opens.
- `feeds.py` - who holds a state feed, by page group, with a log line the
  moment the shared pop-out profile reaches Chrome's six; and `/ws/events`,
  the same snapshots over a WebSocket (its own pool) for the pages after the
  four.
- `scenes.py` - the versioned scene schema (format, background,
  transparency mode, layers with transform/style/props/triggers, guides),
  validation that clamps and keeps unknown fields, migration, and a store
  with atomic writes, five rolling backups, revisions with 409 conflicts,
  restore and duplicate.
- `assets.py` - the library, moved out of `server.py` and extended: webm/mp4,
  kinds, dedupe by content hash, browser-made thumbnails, usage counts and a
  refusal to delete what a scene or window still shows.
- `voice.py` - `{level, speaking}` from the caption engine while it listens,
  else a microphone monitor of our own that runs only behind renewed leases.
- `capture.py` - plus `list_windows`, `list_monitors` and one-shot
  thumbnails (a single WGC frame read back, then closed).
- `overlay.py` - the host is sized first and Chrome resized after adoption
  (a 1080x1920 output measured 1427 tall as a plain window; it now opens at
  1920), and `park`/`unpark`. `hostwin.py` re-aligns after every move.

Routes: `/api/components` (+ `/<id>/status`, `/<id>/<action>` with the old
names kept, `park` and `unpark` added), `/api/scenes` (list, create;
`/<id>` read and save with `expect_rev`; `delete`, `duplicate`, `restore`,
`backups`), `/api/assets?kind=` (upload with `thumb`, delete checked for
use), `/api/capture/sources`, `/api/capture/thumb`, `/api/voice` (+
`hold`, `release`), `/api/feeds`, `/ws/events`. The snapshot carries
`components`, `scenes`, `voice`, `feeds`, and `windows` for every component.

Verified: 14 unit tests (now run in CI) and 36 rig checks
(`tools/p2/p2rig.py`) - the four windows through the registry and an old
alias, `windiag2` clean, a phone output opened at 1080x1920, aligned and
captured whole by WGC, still captured while parked, save/conflict/backup/
restore/duplicate, upload with thumbnail and the refusal while used, ten
windows and one monitor listed with PNG thumbnails, the voice lease
lifecycle, the WebSocket feed's handshake and first snapshot, feed
accounting. Two bugs found and fixed on the way: a re-entrant lock in the
feed accounting, and a pixel of misalignment right after a window was
moved from off screen.

Notes: the deck's own UI still names the four (P6 makes it read the
registry); `scene.html` is a placeholder until P3; the WebSocket feed sends
whole snapshots like SSE does (deltas are P5's); the rig's Python has no
`sounddevice`, so the live microphone monitor is exercised by the built app
only (its error is reported in the voice status).

## P3 - the scene runtime (2026-09-11)

`web/scene.html?id=<scene>` (or `?follow=1` for whatever scene is live)
renders a scene at its own size and scales it with one transform; the
output window is that size, so the scale is 1. `web/scene.js` is the
engine: a registry of layer types (`create` / `update` / `destroy`, plus
`state`, `voice` and `motion` hooks), layers diffed by their JSON so only
what changed is touched when a revision moves, two stages so a live switch
crossfades in place, and one WebSocket feed (`/ws/events`) for the whole
scene - embedded components get it by `postMessage` through
`web/embedhost.js`, never a feed of their own (measured: one feed open for
a scene with two components).

Layer types: background (solid, gradient, image, the generative scenes),
text (fonts, size/weight/spacing, fill or gradient, stroke, shadow, pill,
auto-fit, live `{title} {artist} {album} {source} {elapsed} {duration}
{time} {date} {caption} {caption_live}`), image/GIF/video (fit, tile,
flip, loop/mute; Ultra stills GIFs and pauses video), shape (rect, ellipse,
line, frame with a see-through hole), component (the four pages in embed
mode: `?embed=1`, transparent stage, card background/frame/opacity and
parts to hide, linked or per-scene design), camera (device, size, fps,
mirror, mask), capture (a window or screen through `getDisplayMedia`, or
a native hole for P4's compositor), reactive image (idle/talking/blink
pictures, bounce). Any layer can carry the decor.js border loop, and
"while speaking" / "silent" / "speech start" triggers (show, hide, bounce,
class, pop). Voice state rides the feed; the page holds a lease only while
something reacts to it. Four templates (`scenes.py`: just chatting, music
+ lyrics, gaming portrait, gaming landscape) and approximate TikTok safe
zones for the phone canvas.

Measured on the rig (`tools/p3/p3rig.py`, 44 checks):

| What | Result |
|---|---|
| A scene with every layer type (sakura background, 4 texts, image, 4 shapes, reactive image, border loop, camera, capture hole, Now Playing + Captions embedded) | 23-28% of one core, captured at 46 fps (the loop animates) |
| Now Playing + Captions embedded in one 1920x1080 scene vs the two pop-outs | **11.2% vs 18.2%** of one core: one window is cheaper than two |
| Phone template output | 1080x1920, aligned, captured whole at 30 fps |
| Reactive image, voice change on the server -> picture swapped on the page | 8-31 ms (median ~10); with the monitor's 100 ms attack, ~110-130 ms end to end |
| 20 live switches with a 300 ms fade, every 1.2 s | window never re-opened, 29.5 fps captured throughout; the live output resized itself to the phone scene |
| A 1600x900 window source through `getDisplayMedia`, auto-selected at Chrome's launch | painted, 22 fps captured, 15.3% of one core for the whole scene |

Findings:

- Chrome's auto-select flags name **one** capture source per launch of the
  shared Chrome, so a scene's first browser-mode capture layer is passed
  when the pop-out Chrome starts (`overlay.LAUNCH_EXTRA`). Scenes opened
  later cannot change it; the native hole (`mode: native`) is the general
  answer and P4's compositor fills it.
- Switching scenes every 1.2 s cost ~66% of one core for the burst: each
  switch rebuilds the embedded component pages and asks for the camera
  again. Steady state is the scene's own cost. **P5:** keep component
  iframes and camera streams alive across a switch when the next scene
  uses the same ones.
- The camera on this PC was held by OBS and LIVE Studio during the tests
  (`NotReadableError`), shown as a dashed box with the reason; the camera's
  CPU cost is still to be measured (P4, with the camera free).
- Auto-fit text measured a detached element as fitting: layers are now
  attached before they are built, and fit again once connected.
- The captures are read with the app's own WGC path, not screenshots, so
  what was checked is what a stream would carry.

## P4 - the Go LIVE engine (2026-09-11)

The spike is now the app's engine: `POST /api/live/start` connects the RTMP
publisher, captures the hosted output window with WGC, converts each frame
to NV12 on the GPU, encodes it with the hardware H.264 encoder, mixes the
microphone and (optionally) what the PC plays into AAC, and pushes it all
on one clock - in the server process, nothing in Chrome but the scene
itself. `/api/live/stop` unpublishes cleanly. State (`idle | connecting |
live | reconnecting | failed`), error, preset and reconnect count ride the
deck's snapshot; the key never does.

Routes: `GET /api/live/status` (state, stats, native video, audio, config),
`/api/live/presets`, `/api/live/devices`; `POST /api/live/start`
(`url`, `key`, `remember`, `preset`, `source`, `audio`), `/stop`, `/audio`
(`source`, `gain` 0-4, `mute`), `/scene` (`id` or `step` +1/-1, with
`transition`/`duration`), `/key`, `/key/forget`. `GET /api/debug/mem` reads
the working set (and, with `?start=1`, Python's allocations by line).

Presets are LIVE Studio's table (`live.PRESETS`: 1080p60 7600 kbps, 1080p30
6000, 720p60 4400, 720p30 3400, 480p30 2000; HEVC rates alongside for
later), audio 128 kbps AAC-LC 48 kHz stereo. The stream is the output
window's size at the preset's rate; a scene of another size cannot be made
live while streaming (`set_live_scene` says so), same-size switches keep
the encoder running.

Measured on the rig (`tools/p4/p4soak.py`), 1920x1080 window, 720p30 preset:

| What | Result |
|---|---|
| Native audio (WASAPI mic + loopback -> numpy mix -> Windows AAC MFT) | 5.7% of one core in the server, 48 kHz stereo 132 kbps, ffprobe clean; the page's audio path costs 7-9% in Chrome, so **native it is** |
| GOP through `ICodecAPI` (`AVEncMPVGOPSize`), CBR (`AVEncCommonRateControlMode`) | keyframes every 2.00 s exactly (the media-type hint gave 1 s); 3400 kbps on the nose |
| Forced keyframe after a reconnect (`AVEncVideoForceKeyFrame`) | first frame after the reconnect is a keyframe 0.57 s in, instead of up to 2 s of nothing |
| Sink killed and restarted mid-stream | back live after 2 attempts (1 s, 2 s backoff), 16 stale frames dropped, recording resumes |
| Two live scene switches (fade 300 ms) | encoder untouched, 30 fps throughout |
| Whole server while live (capture + convert + encode + audio + mux) | 17-21% of one core, see the soak |

The 30-minute soak (`p4soak.py 30 720p30 10,20 15`: scene switches at 10 and
20 minutes, the sink killed and restarted at 15), with the NV12 fix in:

| Minute | Working set | Threads | CPU % of one core | Video / audio fps | Queue | Drops | State |
|---|---|---|---|---|---|---|---|
| 1 | 116 MB | 41 | 18.4 | 30.0 / 46.9 | 0 | 0 | live |
| 10 -> switch | 108 MB | 40 | 19.5 | 30.6 / 46.5 | 0 | 0 | live |
| 15 -> sink killed | 110 MB | 46 | 18.8 | 29.5 / 47.3 | 0 | 0 | live |
| 16 | 110 MB | 47 | 19.0 | 29.5 / 47.3 | 0 | 41 | live again, 2 attempts |
| 20 -> switch | 111 MB | 45 | 19.0 | 29.7 / 46.5 | 0 | 41 | live |
| 30 | 111 MB | 39 | 19.7 | 29.8 / 46.7 | 0 | 41 | live |
| after stop | 97 MB | | | | | | idle |

Memory flat for half an hour (P1's run would have added ~90 MB), 30 fps
throughout, the only drops the 41 stale frames flushed at the reconnect,
`delay_ms` 0, threads and handles steady. The recordings: before the kill
27429 frames / 458 keyframes every 2.00 s / 42849 AAC packets; after it
909.9 s, 27252 frames, keyframes 1.73-2.00 s apart (the forced one after
the reconnect), audio continuous. Private bytes sit near 590 MB the whole
time: numpy's OpenBLAS reserves that at import (the standalone mixer shows
the same 512 MB) - P5 can cap it with `OPENBLAS_NUM_THREADS=1` before
importing numpy.

**The memory growth from P1 - found and fixed.** Tracing Python's heap
(`/api/debug/mem?start=1`) showed 0.4 MB flat while the working set climbed
2.8 MB/min, so it was native. Bisected with standalone runs
(`tools/p4/audiomem.py`, `videomem.py`):

| Run (3 min each) | Memory |
|---|---|
| Audio mixer alone (mic + loopback -> AAC) | flat (46.2 -> 46.4 MB) |
| WGC capture alone, 30 fps | flat (41.2 MB) |
| Capture + encoder, RGB32 in | **+3.0 MB/min** |
| Same, one input sample reused for every frame | +3.0 MB/min |
| Same, output samples released without reading them | +2.0 MB/min |
| Encoder alone, one static RGB32 texture | +2.9 MB/min |
| Encoder alone, one static **NV12** texture | **flat (46.1 MB)**, and 23 MB less at start |

The AMD encoder's own RGB -> NV12 conversion leaks about 1.7 KB per frame
and never gives it back (only ~4 MB returned after stop). The fix is to
convert ourselves: `capture.Nv12Converter` runs the Direct3D 11 video
processor (`ID3D11VideoContext::VideoProcessorBlt`, full-range RGB in,
BT.709 limited out, a ring of three NV12 textures so the encoder may still
be reading the previous one), and `mfenc` now prefers NV12 input over
RGB32. A decoded frame matches the WGC capture of the same window. NV12
is also what the NVIDIA and Microsoft encoders take, so the encoder chain
is now: any D3D11-aware hardware encoder on the desktop's adapter (AMD,
Intel, NVIDIA when the desktop runs on it), then Chrome's WebCodecs page
path (`source: "page"`, which has its own software fallback); the software
MFT would need a CPU readback per frame - P5 if anyone needs it.

Also in P4:

- `/api/live/start` waits for the native path to deliver (encoder up, first
  frame in) and fails with the reason instead of streaming silence.
- Health stats gained `rtt_ms`, `inflight_kb`, `retrans_kb` straight from
  the TCP stack (`SIO_TCP_INFO`), next to kbps, fps, queue, `delay_ms`
  (capture-to-wire) and drops.
- A fatal RTMP error after the stream had been live is reported as
  "TikTok refused the stream key after it had been live - LIVE Center may
  have issued a new key ..." (`live.KEY_ROTATED_HINT`), the case the UI
  must show.
- `/api/debug/mem` read 0 MB at first: the current-process pseudo handle
  (-1) passed as a plain int is truncated to 32 bits by ctypes; it goes in
  as a pointer now.
- Media Foundation missing (Windows N) no longer breaks the import of
  `mfenc`/`audio`; going live says what to install.
- `tests/test_p4.py` (10 tests): presets, AMF0/FLV/ASC bytes, the fatal
  error list, the queue's drop order, meta merging, and the reconnect ->
  forced keyframe -> rotated-key path against a fake RTMP client.

Not done: a real LIVE to TikTok with the user's key (needs the key pasted
and the user's app rebuilt); the camera's CPU cost (OBS and LIVE Studio
still hold the camera on this PC). The converter feeds the encoder the
newest frame while the previous one may still be encoding - three rotating
textures cover it at 30 fps, P5 measures 60.

## P5 - the backend measured, fixed and hardened (2026-09-11)

Every template scene was measured on the rig (`tools/p5/p5rig.py`) as a
real hosted window, Chrome's cost for the whole rig profile, 15 s each,
warm profile, screen on. The four templates ship with a camera layer and
(the gaming ones) a capture hole; "animated" adds the decor loop to a
text, "camera" points the camera at the one device OBS and LIVE Studio
leave free (the IR camera, 640x480), "window" swaps the capture to a
browser `getDisplayMedia` of a 30 fps source window.

| Template (Chrome, % of one core) | idle | animated | + camera in the page | + window source in the page |
|---|---|---|---|---|
| Just chatting | 13.0 | 18.4 | 35.1 | 28.1 |
| Music + lyrics | 11.3 | 16.5 | 32.3 | 26.5 |
| Gaming portrait (1080x1920) | 12.9 | 19.1 | 41.9 | 29.9 |
| Gaming landscape | 10.7 | 10.2 (no text to animate) | 35.1 | 29.6 |

"Idle" is not static: the embedded Now Playing and Captions pages tick
(P3 measured the same two at 11.2%), which is where the 10-13% goes. The
two costs that blow the budget are Chrome's: a camera through
`getUserMedia` adds ~22% (12% of it Chrome's video-capture service, the
rest renderer, GPU and browser process) and a window through
`getDisplayMedia` adds ~15% (the browser process does the capture). The
native hole costs nothing in Chrome. **So the native compositor is the
fix** (below).

| Also measured | Result |
|---|---|
| LIVE, animated Just chatting, 720p30 preset (at the 1920x1080 window) | Chrome 21.7%, server 16.2%, 3533 kbps, 30 fps |
| LIVE, 1080p30 preset | Chrome 25.6%, server 22.7%, 3984 kbps, 29.8 fps |
| Capture loop, first P5 version (offer a frame at the tick only) | **15.0 fps** at the 30 fps preset, server 15.0% - half the frames never reached the encoder |
| Capture loop, shipped (2 ms poll only while a frame waits) vs P4's (2 ms poll always), back to back, 1080p30, a game running on the other monitor | 30.0 / 30.2 fps at 40.6% / 42.9% vs 30.0 / 30.0 fps at 45.2% / 49.7% of one core (whole server; the game inflates every figure, the order is what counts) |
| Animated scene, Ultra on | 18.4% -> 2.4% (later runs 17-19% -> 4.1-4.4%) |
| Animated scene, parked off screen | 18.4%, captured at 41 fps |
| Minimized, before | 19.4%: the host watchdog, seeing a host at -32000, rebuilt the window after ~6 s (a pre-existing bug: minimize never stuck), and the pages kept animating |
| Minimized, after (screen on, a game on the other monitor) | real minimize: scene 9.8%, Now Playing 1.6%; parked in its place: scene 22.0%, Now Playing 2.1%; captured after restore at 13-14 fps (the scene draws only when something changes) and 22-24 fps (Now Playing) either way |
| Parked, off every screen | keeps drawing and captures at 21-34 fps, but the browser process spikes to 24-40% of a core in about half the samples (occlusion tracking is already off for these windows; cause open) |
| Seven windows (deck + 4 pop-outs + 3 outputs) | pop-outs on SSE (4), outputs on the WebSocket feed (3), the deck and its preview iframe counted as the deck's Chrome, every page followed a live switch, no six-connection warning |
| 20 live switches every 1.2 s | no iframe rebuilt (`EmbedHost.created` stayed at 2), the camera `<video>` and the Now Playing iframe are the same elements before and after, the page shows the scene the last switch asked for ; rerun with a game on the other monitor: the same, and 20 switches in 24 s cost 36.8 points of a core over the scene's idle (85.8% -> 122.6%; P3 rebuilt every page for 66%) |
| Native compositor on the rig (`tools/p5/p5native.py`), a native window + native camera in an animated scene, LIVE 1080p30 | 5 of 5: Chrome 3.5% (the same two in the page: 35-42%), server 33.4%, 30.1 fps; the window keyed into its hole (the camera's own picture was black - a shutter or a dark room - so its keying is covered by the synthetic test) |
| Native sources by thread (`tools/p5/p5nthreads.py`), one stream, the live scene switched between them | server 23.8% none, 26.7% a window, 30.6% a camera, 33.2% both; the capture thread 6.0-8.3%, the camera reader 4.0-4.5%, the audio mixer ~7%, the feed pump ~3%, the RTMP sender ~3%; no drops, 30 fps in all four |
| Camera, first version | 10.9% for the camera reader and a black hole: the camera stayed in its default 1280x720 mode while the code read 640x480 frames out of it |
| The 60 fps ring (`tools/p5/tearcheck.py`), a source window repainting its whole picture, NV12 ring of 3, 20 s | 1199 frames encoded at 60.0 fps, 1 dropped, none torn; the source drew 304 new pictures (~15 fps under the game's load), so the ring ran at the encoder's full pace but not with a new picture every frame |
| Recovery (`tools/p5/p5recover.py`) | 16 of 16: the live window closed by hand mid-stream stays closed (the stream holds its last frame and reports `stalled`) and, opened again from the deck, re-joins the stream (frames 91 -> 241); every page's renderer shot -> feeds drop, the quiet outputs are rebuilt and their feeds return; a server restart re-opens the outputs that were open, the parked one parked |

What changed:

- **Scene switches move boxes, not pages.** `web/scene.js` renders in one
  stage now: on a switch, layers the next scene shares - a component (an
  iframe reloads when rebuilt, or even when moved in the document), a
  camera or capture (a new stream), a video - are kept and glide to their
  new box; new layers fade in, the old fade out, the background crossfades.
  Identity is the media (component id; camera device/size/rate; capture
  source; video src), not the layer id, so two templates share their
  Now Playing.
- **Minimize is a real minimize, and the page idles.** Part 1 parked a
  hosted window in place of minimizing it, on numbers taken while the
  screen was off. Re-measured with the screen on, the real minimize wins:
  a minimized scene costs 9.8% of a core against 22.0% parked in its
  place (the GPU process stops drawing), and both come back capturing at
  the same rate. What part 1 got right stays: every page treats its own
  window's `minimized` flag in the snapshot like Ultra (`idleHere` in
  motion.js; a scene passes it on to its embedded pages); the host's
  alignment check treats a minimized host as aligned, so the watchdog no
  longer rebuilds it after 6 s; every window action broadcasts a snapshot,
  so the pages hear about it at once. Chrome follows the host down to its
  minimized stub size, and that is most of the saving: kept at full size
  inside the minimized host (tried), the scene drew on at 22.4%. One exception: while on
  air the server refuses to minimize the live output (409, "park it
  instead"), because a minimized window cannot be captured.
- **Recovery.** `remember_outputs` keeps the open outputs (parked or not)
  in `canvas.reopen`; `_watch_outputs` rebuilds one whose page has held no
  feed for 15 s (Chrome crashed or the renderer died - the host stays),
  re-opens one that is gone (three tries in two minutes, then it is left
  closed), and at start brings back last time's outputs. A window the user
  closes by hand (Alt+F4, the taskbar) is not "gone": the host tells a
  hand close from the app's own (`Overlay._on_host_closed`), the server
  drops it from `canvas.reopen`, and it stays closed. Opening the live
  output again while LIVE - from the deck or by the watchdog - re-joins
  the stream (`rejoin_live`: a fresh capture, the engine's clock carries
  on); until then the stream holds its last frame and reports `stalled`. WebSocket feeds name
  their page (`/ws/events?page=`), so the server knows which output holds
  which feed; `nativelive` reports `stalled` when the window stops
  delivering. A corrupted scene file already fell back to its newest
  readable backup at load; now there is a test for it.
- **Security pass.** `guard.trusted` (Host must be ours, Origin ours or
  absent) is the one door for GET, HEAD, POST and both WebSockets, with
  tests for DNS rebinding, another origin, another port and `null`.
  Assets and scenes never leave their folders (`os.path.basename`, ids
  looked up in the store, backup numbers as ints - tested with `..`,
  `%2F`, `builtin:..`). The RTMP client masks the stream key in every log
  line, even when the server echoes it in a status.
- **The engine's own cost.** The capture loop sleeps until the next tick
  when no frame is waiting, and polls the encoder every 2 ms only while one
  is (P4 polled every 2 ms all the time). A first version offered each
  frame at the tick only and streamed 15 fps at a 30 fps preset - the
  asynchronous encoder asks for input when it is ready, not on our clock
  (the P1 lesson, relearned). The audio mixer sleeps 20 ms (a frame is 21).
  The capture thread holds the display on while it streams
  (`SetThreadExecutionState`): WGC stops when the display sleeps, which
  would freeze the viewers' picture. `OPENBLAS_NUM_THREADS=1` before numpy loads (its BLAS
  reserved ~500 MB of private memory the mixer never uses).
  `/api/debug/threads` reports CPU per thread by name, and the
  streaming threads have names now (native video, camera reader, audio
  mixer, rtmp sender, rtmp reader, live stats).
- **Any window size streams.** NV12 and H.264 need even sizes: a window
  with an odd side failed at its first texture (`CreateTexture2D`
  E_INVALIDARG - the ring check found it, its test window measured
  1276x687, and a scene may be any size from 16 px). The capture thread
  crops such a frame to even with one `CopySubresourceRegion` and streams
  it without its last row or column; even sizes pay nothing.
- **The native compositor** (`capture.Compositor`, `camera.py`,
  `scenes.native_sources`): a capture layer in native mode or a camera
  layer with `mode: native` is a hole in the page - painted black, in the
  layer's own shape (a circle, a rounded box) - and while LIVE the server
  fills it: the window or screen through WGC, the camera through a Media
  Foundation source reader (RGB32, one `UpdateSubresource` per frame),
  keyed into the scene by a 20-line pixel shader (a source pixel lands
  where the scene's luma is under 0.035, so a frame drawn over the hole
  stays, and `mirror` flips the camera), then the video processor's NV12
  conversion as before. The AMD driver has no luma key in its video
  processor (checked), hence the shader. Verified with synthetic textures
  (`tools/p5/comptest.py`): a mirrored source shows inside a circular
  hole under a ring, a red square and a near-black box stay untouched,
  60/60 frames encoded. On the rig with a real window and the laptop's
  camera: 5 of 5, Chrome 3.5% and 30 fps (the table above). The camera
  reader first switches the camera to the mode nearest the layer's size -
  the reader's video processing converts the pixel format but never
  resizes, so without that the camera stayed at 1280x720 while 640x480
  was read out of it - then sizes the texture from what the reader
  settled on, and refuses a frame of any other length. Sources follow the
  live scene: set at start, on a live switch, on a save of the live scene. Not mirrored natively: the
  camera picture's masks other than the hole's shape.

A note on measuring: WGC only delivers frames while DWM composes, and
DWM stops when the screen is off - every capture-rate figure taken in
the two hours after the display timed out read 2-4 fps for everything,
the whole monitor included, which first looked like a park/unpark bug.
The one check that tells: capture the whole monitor for a second
(`wgc.py monitor 0`; ~55 fps with the screen on). Neither
`DwmGetCompositionTimingInfo` (0x88980090 with the screen on too) nor the
session-lock flag says anything. `tools/p5/keepawake.py` holds the display
on for capture tests outside a stream. Two more traps: a Chrome window
that is fully covered stops drawing (Chrome's occlusion tracking), so a
browser window used as a window source freezes while something covers
it - as it does in OBS - and the test source windows run with occlusion
throttling off; and a Chrome started with a relative `--user-data-dir`
joins the user's own browser session, ignoring the window position the
test asked for. Test windows go on the second monitor (`tools/p5/rigpos.py`).

The 2-hour stress (`tools/p5/p5stress.py`): a 1920x1080 scene of 60
layers - the four components, 18 texts with the time and the title, 18
shapes, 18 decor loops (a third of them animating), a native window
source and the native camera - LIVE at 720p30 to a local sink with the
mic and system audio, a game running on the other monitor.
It ran 33 minutes (stopped there by choice; long enough to show a
trend) and nothing grew:

| Stress, per minute | Start | 33 min |
|---|---|---|
| Server working set | 125 MB | 95 MB (after stop: 95 MB, 124 MB private, 7 threads) |
| Server threads | 35 | 34 |
| Server CPU | 35-44% of one core throughout (a game on the other monitor) | |
| Chrome (the rig's, all processes) | 671 MB, 28% | 501 MB, 18% |
| Video / audio | 29-31 fps, 0 audio frames dropped, 0 reconnects | the same |
| Native video dropped | 10 at start | 32 (22 in ~59,000 frames after the start) |
| Native sources | window ~24 new frames/s, camera ~10/s, no errors | the same |

The recording: 1978.6 s of 1920x1080 H.264 at 30 fps with AAC, 59,315
video frames, keyframes every 2.00-2.33 s, the longest gap between two
frames 200 ms (three over 100 ms). At the very end someone closed the
live output by hand: the server said so, left it closed, and the stream
held its last frame and reported `stalled` - the new rule, met in real
use.

## Tools kept for later steps (`music-deck/tools/p0/`)

- `wgc.py` - Windows Graphics Capture of a window or monitor, PNG + fps + CPU.
- `capwin.py` - PrintWindow screenshots of a process's windows.
- `tallwin.py` - the tall hosted window experiment (uses the test rig's modules).
- `cpuby.ps1` - CPU per Chrome process type for processes matching a string.
- `cdp.js` - DevTools evaluate with a user gesture; `--titles` lists pages.
- `sse.ps1`, `mediatest.ps1` - the connection-cap and camera/screen tests.
- `click.py` - input helpers (note: SendInput is blocked from the sandbox).
- `p0-anim.html`, `p0-media.html`, `p0-sse.html`, `p0-codecs.html` - test pages
  (copy into a rig's `web/` to serve them).
- `web/transparency-test.html` ships with the app for capture checks.
