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

1. **Done 2026-09-12 - the Link source keeps transparency.** The user added
   the test page as a Link in their LIVE Studio (1.35.2), with the app
   running, and the scene behind it showed through: see-through overlays
   reach LIVE Studio through Link, as decisions 2 and 3 assumed, and LIVE
   Studio's pre-check accepted the app's answer. The check as it was set:
   **Manual 30-second check (Link transparency):** in LIVE Studio, Add
   source > **Link**, URL `http://127.0.0.1:8713/transparency-test.html`, with
   the app running. (The user's LIVE Studio menu, 2026-09-12, has no entry
   called "Browser capture" - that name came from its internal strings; the
   menu says Link, and Window capture for windows.) LIVE Studio checks a Link
   before it takes it (`static/js/modal.d626db29.js`, 1.35.2): a format test,
   `/(http(s)?:\/\/)?[(www.)?a-zA-Z0-9@:%._+~#=]{2,256}\.[a-z]{2,6}\b.../`,
   unanchored - `test.html` satisfies its "dot and letters" part, so the IP
   address passes - and then an `XMLHttpRequest` GET of the address that
   fails only on a network error or a 404. With the app not running that
   request cannot connect: "Enter correct URL" (what the user saw on
   2026-09-12; the app was indeed not running). Most of LIVE Studio's windows
   run with `webSecurity: false`, so the guard's 403 to that foreign-origin
   request should still count as an answer, and the Link itself loads as a
   plain navigation, which the guard allows - both unconfirmed until the user
   tries again with the app running.
   If the scene background shows through around the pink card, the yellow
   dot and the text, the Link source keeps alpha (expected). If it comes out
   black, transparent overlays for LIVE Studio use the key-color fallback.
   Delete the source afterwards. (Injected clicks are blocked from the
   sandboxed tool process, so this could not be automated here.)
2. Camera CPU in a `<video>` (camera was busy with OBS + LIVE Studio).
3. `getDisplayMedia` capture cost, cleanly measured (P1).
4. Whether the user's account shows a Server URL + Stream key in LIVE
   Center (needed for direct streaming; LIVE Studio access suggests yes).
   2026-09-12: the page is TikTok's LIVE Producer,
   `livecenter.tiktok.com/producer` - fill in the LIVE, press Save and Go
   LIVE, and the Server URL and Stream Key show a few seconds later; a new key
   for every LIVE. Access is gated (guides, not TikTok's own help, say it is
   unlocked through TikTok's creator networks); a page that redirects means
   not unlocked. **Answered the same day: the user's account is not
   unlocked** - `/producer` redirects them to the LIVE Center home (Home,
   Analytics, Real-time performance, LIVE recordings, LIVE rewards, Fan Club,
   About me; no Producer entry). So for now they stream through LIVE Studio:
   scenes by Window capture (solid), see-through overlays by Link. The app's
   own LIVE engine is done and tested and waits for a key.
   The second route to one - the TikTok tab, below - is built but just as
   shut: Streamlabs answers `never_applied` and `can_be_live: false` for this
   account (2026-09-12, the user at the PC), so neither path has a key. A
   Streamlabs token is not LIVE access; TikTok granting LIVE access is the one
   thing both are waiting on.
5. (After P12, all four above are still open and need the user at the PC.)
   The user's installed app was rebuilt from P12 on 2026-09-12 (they ran
   `rebuild.ps1 -NoLaunch` themselves: try-out passed, config.json and
   cache\ left in place, a safety copy kept); next, a first real TikTok
   LIVE from the app with their own key.

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

## Keys you can see, and handles you can hit (2026-09-12)

The third slice of the walk-through: the spatial mechanics. Not all of them -
Space-to-pan, wheel-to-zoom and drag-to-marquee are conventions worth arguing
about separately, and this slice only makes what already exists legible.

- **Handles.** 9 px squares, aimed at by people who miss. 12 px now, with the
  invisible padding widened so the target is 28 px rather than 23. The rotate
  knob differed from the eight resize handles by two pixels and a border
  radius; it is filled with the accent and ringed in white, so it reads as a
  different control rather than a ninth corner.
- **The modifier keys.** Shift, Alt and Ctrl change what a drag does, and the
  only place that was written down was one dialog behind a "?" button - which
  is nowhere near the hand that needs it. `step()` now records the modifiers on
  the gesture and `paintHud` draws them at the bottom of the canvas while you
  drag: "Shift keep the shape - Alt from the middle - Ctrl no snapping", with
  the one you are holding lit. `restep()` already re-ran the step when a
  modifier changed with the pointer still, so it lights up the moment you press
  it, not at the next mouse move.
- **The left panel's headings** went from 10.4 px in the dimmest token to
  11.5 px a step lighter, and asset names from 10.9 px to 11.8 px.

**The inspector's headings did not, on purpose.** P9 photographs that panel and
compares it pixel for pixel, failing on any size difference at all; taller
headings change the clip height of all ten goldens at once. Rewriting ten
reference images to land a font-size is the tail wagging the dog, and a global
`update` blesses every image including any drift you did not mean. The
inspector's type is its own change, with the goldens rewritten as the point of
it. What was needed here instead was surgical: the capture inspector genuinely
changed in the slice before this one (relabelled control, the native-mode hint
now shown, picker labels no longer squeezed to 9.4 px), so *that one golden*
was deleted and left to regenerate - `p9test.js` writes any golden it cannot
find - while the other nine stayed under comparison and all nine still matched
at 0.00%.

**A regression this slice introduced, and what it nearly cost.** P9 came back
71 of 72: "live indicator: gone once the camera is hidden". The cause was the
slice before it. `holePreview` set `entry.media = img` for the editor's
thumbnail, `SceneDebug.layers()` reports `media: !!e.media`, and
`inspectors.js` counts *any* camera or capture layer with media as live - so a
capture layer holding a still fetched over HTTP was being reported as an open
source. The failing assertion was the small part: that badge is a privacy
signal, a red dot that means something is watching you, and it was firing for a
layer that was watching nothing. A badge like that being wrong in the direction
of a false alarm is worse than it being ugly. The still lives on `entry.shot`
now; `dropStream` clears it, and the fit line takes `entry.media || entry.shot`
so "Fill the box" still applies to it. The indicator and the test were left
alone - both were right.

The near-miss is worth writing down. The regenerated `p9_screen.png` was
captured *during* that failing run, with the false live state in force, and
`HIDE_DYNAMIC` hides the live note with `visibility: hidden`, which keeps its
layout. The bug would have been baked into the reference image and the next run
would have failed against it. It was deleted and regenerated a second time,
after the fix.

Verified: P9 72 of 72, P8 56 of 56 (resizes land exactly at 200% and 30% zoom
with the bigger handles; the knob still turns a clean quarter and steps by 15
with Shift), and `tools/capture/pickertest.js` 19 of 19, which now drags a
handle with Shift held and reads the hint back: "Shift keep the shape - Alt
from the middle - Ctrl no snapping", lit: Shift, gone when the drag ends.

Still open from the walk-through: the inspector's type (above), rotation that
lands on 357.4 degrees with no easy way back to straight, resizing a text box
stretching the box and not the letters, and the conventions listed at the top.
(An earlier draft of this list ended "and the camera layer's black box in the
editor". There is no such black box - see the withdrawal below.)

## Words on the buttons, and a Save you can press (2026-09-12)

The Canvas Builder was walked through as somebody who has not used a design
tool before, and the write-up runs to about sixty separate complaints. This is
the second slice of them: the controls that do not say what they are, and the
saving nobody believes in. The spatial ones - handles, modifier keys, panning -
are their own job and are not done here.

**The emoji were against our own rule.** `icons.js` opens by saying emoji
"render differently on every machine and font, and look by turns childish and
broken", and then the layer list used a padlock emoji for locked, a filled
circle for visible and a dotted circle for hidden. Nobody reads a dotted circle
as "hidden", and the filled circle was also the camera's type icon two columns
to the left. `ICONS` gained `eye`, `eyeOff`, `lock` and `unlock` - outlines, so
they do not turn into blobs at 15 px - and `svgIcon` learned a set of stroked
names instead of testing for `close` alone. `canvas.html` did not load
`icons.js` at all; it does now, checked first for an identifier clash, since a
second top-level `const ICONS` in any of its ten scripts would have blanked the
whole editor.

**A type icon whose tooltip said "capture".** The row's little glyph explained
itself with our internal type name - "capture", "reactive", "component". It
says "Screen or window", "Reactive image", "A window from the deck" now.

**Saving.** There is no File menu, saving is a 60 ms debounce, and the only
confirmation was the word "Saved" at 12 px in grey in a corner - which reads,
to somebody who has lost work before, as something to distrust rather than
rely on. The indicator is a button now: same class, same box, same text, so the
top bar cannot wrap where it did not before (it did, at 1440-1600 px, and that
was a real regression once) and P9's goldens, which hide `.cb-save` with
`visibility: hidden` and therefore keep its layout, are unmoved. Pressing it
flushes and says "Saved. Your work is kept as you go." Its tooltip is in the
HTML as well as in `setSaveState`, because that function only runs when the
state *changes* and an editor nobody has touched never changes - the first
paint would have had no tooltip at all.

**Two things the walk-through got wrong, corrected here rather than "fixed".**

- It said the row's eye and lock buttons are unreachable by keyboard because
  they are `tabindex="-1"`. They are, and that is correct: roving tabindex is
  how a tree is supposed to work, `canvas.js` really does implement `H` and `L`
  (1168-1169), and `canvastools.js` offers Show/Hide and Lock/Unlock in the
  right-click menu with those keys printed next to them. The fault was that
  nothing on the button said so; the tooltips name the key now.
- It called the inspector's reset control an unlabeled circle. It lives in
  `deck.html`, carries `title="Reset to theme"` and draws a return arrow. It
  wants an `aria-label`, not a rescue.

Verified headless on the rig, 17 of 17 (`tools/capture/pickertest.js`, which
now covers this slice too): the save indicator is a BUTTON with words in its
tooltip before anything is touched, the row's buttons are two drawn glyphs with
no characters left in them and a tooltip each, pressing Saved says so out loud,
and nothing is thrown - which is also the runtime proof that adding `icons.js`
to that page collides with nothing.

Left for the next slice: the 9 px resize handles and the rotate knob that looks
like them, the modifier keys nobody can see (Shift, Alt and Ctrl change what
dragging does), Space-to-pan and wheel-to-zoom, and the 10.4 px uppercase
headings in `--dim` that carry the inspector's structure. (This paragraph also
listed "the camera layer's black box in the editor, same cause as the capture
one". That was wrong and is withdrawn below: the camera previews in the editor
and always did.)

## The window that would not show itself (2026-09-12)

The user added a window to a scene and got a black rectangle that never became
anything, and read the app as broken. It was two faults on top of each other,
and only one of them was the one everybody could see.

**The one you could see.** A capture layer in native mode is a *hole*: the page
paints it black and the server's compositor keys the real picture into that
shape while LIVE (P5). Nothing fills it in the editor, so the box was black for
good, and the only thing saying why was a 12 px `.source-note` living inside the
zoomed preview iframe - about 6 px at Fit zoom, unreadable. The escape hatch was
a segmented control reading "Drawn: By the app / In the page", which names the
mechanism and not the consequence.

So the editor now shows the real thing: `scene.js holePreview()` asks the server
for the same one-shot thumbnail the picker uses, every 1.5 s, only when PREVIEW,
and fades it in over the hole. A scene going out is untouched - the hole stays a
hole for the compositor. A window that has since closed says so in red instead
of showing a stale picture.

**The one underneath, which was the real fault.** WinRT is initialized per
thread, `server.py` answers every request on a thread of its own
(`ThreadingHTTPServer`), and `capture.py` called `RoInitialize` in exactly one
place: `D3D.__init__`, which runs once per process because `_shared["d3d"]`
caches the device. So the thread that happened to build the device could
capture, and every later request thread failed at `RoGetActivationFactory` with
`0x800401f0`, CO_E_NOTINITIALIZED. **Every window thumbnail after the first one
in the life of the process was failing**, and had been all along.

It hid well. A browser keeps connections alive, and requests sharing a
connection share a server thread, so some pictures arrived and some did not -
which reads as flaky, not broken. It even made two of our own probes disagree:
PowerShell pools connections and said 200, 200; Python opens a new one each time
and said 200 then 404 forever. `factory()` now calls `RoInitialize(1)` itself,
unchecked, the way `D3D` already did - S_FALSE means the thread had it,
RPC_E_CHANGED_MODE means the thread chose its own apartment.

| Fresh connection per call | Before | After |
|---|---|---|
| 12 thumbnails, monitor / hwnd / title | 1 then `0x800401f0` for ever | 12 of 12 |
| Every open window, one at a time | - | 11 of 11, dialogs included |

**A third thing, claimed here and then withdrawn.** This section first said the
editor's preview iframe carries no `allow=` attribute, so Permissions Policy
blocked `getDisplayMedia` and `getUserMedia` inside it, and that a camera layer
therefore could not preview in the editor either. **That was wrong.** `camera`
and `display-capture` default to an allowlist of `self`, which a *same-origin*
iframe satisfies with no `allow=` attribute, and the scene preview is
same-origin with the editor. Cross-origin reasoning, applied to a frame that is
not cross-origin.

P9 proves it: "live indicator: the camera open in the editor shows in the top
bar, the list and the inspector" passes, and that badge only lights when a
camera layer has `entry.media`, which only `getUserMedia` sets
(`scene.js TYPES.camera.start`). **The camera previews in the editor. There is
no camera black box.**

What is true about "In the page" capture is duller and was already written down
in P3: Chrome's auto-select flag names one capture source per launch of the
shared Chrome, so a layer switched to that mode inside the editor has no source
named for it and `browser()` falls through to `native()`. The box is not empty
either - the fallback is the hole, which now carries the thumbnail. The
inspector's hint said "Chrome is not allowed to do that inside the editor, so
this box stays empty here", which was wrong twice over and shipped; it now says
Chrome has to be told which window as it starts, so this usually cannot begin
in the editor and the box falls back to the app's own picture.

**The picker.** One button, "Choose a window or screen...", opens a gallery of
everything open: cards about 210 px wide with their own picture refreshed every
2 s, the program's name underneath, our own windows marked "this app". Clicking
one adds it **at the shape the window really is** (it used to arrive in a fixed
70 %-of-scene box, so a wide window was squashed before you touched it) and
switches to the Layers list, so you can see what appeared. It replaces two
different pickers that did the same job differently - a 72x44 list that never
refreshed, and the inspector's grid that refreshed every 3 s.

Smaller things settled with it:

- `/api/capture/thumb` takes `title=` now. A scene names its window by title,
  because a handle is a different number every time that program starts; the
  editor asks the way the compositor looks it up, and gets a 404 saying the
  window is not open when it is not.
- Cards keep `loading="lazy"`: only what you can see is fetched, and every
  thumbnail is a real GPU capture. Checked before leaving it alone - all 11
  windows thumbnail fine on demand, so a blank card is "not scrolled to", not
  "cannot be captured".
- `TYPE_DEFAULTS` claimed capture layers default to `auto` while the code made
  them `native`. They agree now.
- The dead `.capture-list` / `.src` rules went with the old list. They were also
  cascading into the inspector's picker, where `.src span` computed to about
  9.4 px; those labels are now ~10.6 px.

Kept for next time: `tools/capture/thumbprobe.py` (does the endpoint answer more
than once, on a new connection each time) and `tools/capture/pickertest.js`
(the canvas editor driven as a person drives it, in headless Chrome - 19 checks
by the end of the slices below: the gallery has real pictures in it, a window
can be chosen, the layer arrives at the right shape, the editor shows it rather
than a black box, the row's eye and lock are drawn rather than typed, pressing
Saved says so, a handle dragged with Shift held names the keys, and nothing is
thrown). Launch Chrome as the P-suites do - `--headless=new
--remote-debugging-port=9357 --user-data-dir=<.rig>\prof-picker` - then
`node pickertest.js 9357 8799`. One monitor here, so headless is not optional.

A note for whoever writes the next test: the first version of `pickertest.js`
failed its own aspect-ratio check and it was the test's fault - it read the
scene back over HTTP before the editor's 60 ms autosave had run. It waits for
`saveState` to say Saved now. The app was right and the test was in a hurry.

## The TikTok tab: where the Server URL and the key come from (2026-09-12)

The LIVE panel has a second tab beside the pasted key: it asks Streamlabs for
a TikTok live the way the Streamlabs desktop app does, and streams the deck to
what comes back. What this entry records is where each half of that pair
actually lives, because the two are not in the same place.

- **The token kept on this PC holds no key.** Streamlabs' own local storage
  (`%appdata%\slobs-client\Local Storage\leveldb\*.log`) carries `apiToken`
  and nothing else of use to us: no Server URL, no stream key. So "Load from
  this PC" cannot bring them along, however the button is worded. Both exist
  only in the answer to `POST /api/v5/slobs/tiktok/stream/start` - one pair
  per live, dead when that live ends.
- **So the pair is kept for the life of the live, and no longer.**
  `TikTokBridge` holds `url` and `_key` in memory from the moment the live
  opens; `end()` and `forget()` wipe both, and the deck's Stop already closes
  TikTok's side wherever it is pressed. Nothing new is written to disk:
  `live.Vault` already keeps the key encrypted to this Windows user.
- **The address rides the poll; the key does not.** `/api/tiktok/status`
  carries `url` (TikTok's ingest address, no secret - `live.Vault` says as
  much) and `has_session_key`, which is all the panel needs to decide what to
  draw twice a second. The key itself comes from `POST /api/tiktok/reveal`,
  asked for only when Show or Copy is pressed. That is also how Copy works
  without ever putting the key on screen.
- **What the panel shows.** A "This live" box, the way the standalone
  generator showed it: the Server URL plain with Copy, the stream key behind
  Show with Copy, and a line saying both are there for a second app (OBS,
  LIVE Studio) and stop working when the live ends. It appears when Streamlabs
  hands the pair over and goes when the live closes.
- **Found on the way:** `.lp-group` and `.lp-health` set their own `display`,
  which beats the browser's `[hidden]` rule - so the account box was never
  actually hidden when it was meant to be. One rule fixes both.
- **Inert on this account, and not because of us.** Streamlabs reports
  `never_applied` and `can_be_live: false`, so Go LIVE stays disabled and the
  box never appears. A Streamlabs token is not LIVE access. The hint now names
  the status instead of saying "cannot go live yet", since applying is the one
  thing the user can actually do about it.
- **The risk this carries, written down once.** Asking Streamlabs for a key
  means introducing ourselves as the Streamlabs desktop app
  (`tiktok_live.UA_STREAM`). That is what makes a key appear at all, and it is
  the user's own TikTok account that answers for it if either company
  objects. The tab is a second way to reach a key, not a replacement for the
  one LIVE Center hands out.

Tests: `tests/test_tiktok.py` gained a `Session` class (5 tests) - the pair
kept from the start payload, a status that carries the address but never the
key, the wipe on ending the live and on forgetting the token, and nothing to
reveal before a live opens. 18 of 18 pass; the session is put in by hand, so
they need neither Windows nor the internet.

## After P12: the rig beside the repo (2026-09-12)

Everything the tests and the rebuild stood on - the rig (an isolated copy of
the app on port 8799), `rigrestart.ps1`, `rigpos.py`, `rebuild.ps1`, the
Whisper model and cuBLAS wheel kept for seeding, the rebuild's safety copy -
lived only in a Claude session's temp scratchpad, which Windows Storage Sense
may empty. Now:

- The scripts are in the repo, `music-deck/tools/rig/`, their paths worked out
  from where they sit. `rigrestart.ps1` makes a fresh rig if there is none (a
  folder with a `config.json` on port 8799), and stops only the tests' own
  RTMP listeners (ffmpeg on `rtmp://127.0.0.1:1935`) instead of every ffmpeg on
  the PC. `rigpos.py` takes the rig folder as an argument.
- The rig, the model, the wheel and the backups are in `<repo root>\.rig\`
  (git-ignored), moved - same drive, renamed, nothing re-downloaded. Every
  runner sets `O=<repo>/.rig` and calls `../rig/rigrestart.ps1`; the P5 deck
  scripts' helpers (`cpuby.ps1`, and `wins.py`, which was already here) sit
  beside them in `tools/p5`, and `abtest.sh`, which looked for the rig next to
  itself, finds it in `.rig`.
- The rest of the old scratchpad (one-off scripts, old screenshots and
  profiles, old backups) is left where it was.
- Run again from `.rig`: P6 21 and 22 of 22, P7 16 of 16, P12 30 of 30 and
  7 of 7, P8 56 of 56, P9 72 of 72, P10 24 of 24, P11 24 of 24 (a real
  stream to the local listener). The first P12 LIVE run from the new place stayed
  "Off air" after Start and failed on from there; it did not come back - not
  when the same start was driven through the API (LIVE in a second, 12.8 MB
  recorded), not in two more full runs - so it is not the path (which now has
  a space in it). Unexplained, so `p12live.js` now records, on that failure,
  what the panel itself knew: whether Start was enabled, the saved key and
  URL, the state and the error.
- **The CI build, as a friend gets it** (the artifact of ba75afd, downloaded
  with the user's OK): both .exe files match `SHA256SUMS.txt`. The folder
  build, started in a folder of its own on port 8796 with no windows (the
  installer not run), says 1.0.0.0, is up in a second, serves every page and
  API, has no shipped artwork (on purpose), lists the six templates, makes a
  scene from one, exports it (1.3 KB) and imports it back whole; the deck and
  the Canvas Builder load in headless Chrome with no console error. Found on
  the way, in the test script, not the app: `Start-Process -ArgumentList`
  joins its arguments without quotes, so a Chrome profile path under
  `streaming stuff` split at the space and Chrome made a profile folder
  `C:\Users\ghamp\streaming` (moved into `.rig`, nothing else touched). An
  argument that holds a path has to carry its own quotes.

## P12 - release (2026-09-12)

Run on Opus 5 (the plan has Fable first, then Opus for what it flags; the
user continued on Opus). `sceneio.py`, `tests/test_p12.py`, `tools/p12`,
README sections, and the rebuild script (scratchpad `rebuild.ps1`).

- **A scene as one .zip (`sceneio.py`).** Export writes `scene.json`, a
  `manifest.json` (format `awesome-streaming-deck/scene`, version, what is
  inside), `assets/<id>` for every picture or video the scene names anywhere
  (stored, not squeezed again; thumbnails ride along) and `fonts/<id>` for
  every added font whose family the scene names. Shipped artwork
  (`builtin:`) is listed, not packed: it is not in the repository, so a
  friend's build may not have it, and the import says so. A picture that is
  used but was deleted is listed as missing.
- **Where an export goes.** `POST /api/scenes/<id>/export` writes it into
  `canvas.export_dir`, or the real Downloads folder (SHGetKnownFolderPath,
  so a moved Downloads is found), as "Name.zip", then "Name (2).zip" - never
  over a file. Not a browser download: the editor is a Chrome app window,
  where where a download lands and whether it asks is not ours to know; a
  file in Downloads and a line saying which is predictable, and a test can
  point `export_dir` at a scratch folder instead of the user's Downloads.
  `GET /api/scenes/<id>/export` returns the bytes (the build check uses it).
- **An import trusts nothing.** Refused outright (a person-readable
  `ImportRefused`): empty, not a zip, over 300 MB, over 500 members, over
  600 MB unpacked, password-protected, no `scene.json`, a manifest of another
  format, `scene.json` over 4 MB, damaged, or not a scene. Then per file,
  left out and listed: names that are absolute, have a drive, a backslash
  or `..`; anything but `assets/<hash>.<ext>` and `fonts/<hash>.<ext>`;
  files the scene does not use; a file larger than its kind allows (checked
  on the header, and again on what is actually read - a lying header cannot
  unpack a bomb); a picture, video or font that does not start the way its
  kind of file starts. Files are stored by their own hash, as uploads are:
  one whose content changed gets its real name, and the scene is pointed at
  it (`id`, and `/asset/<id>` forms). Fonts are kept only when the scene
  names their family. The scene goes through `scenes.migrate`, and
  `SceneStore.add` gives it a new id. The route sits before the per-scene
  regex, which would take "import" for a scene id.
- **SVG.** Pictures can now come from someone else's scene. An `<img>` never
  runs an SVG's script, but a tab opened on `/asset/x.svg` would have run it
  on the app's own origin; SVGs are served with `Content-Security-Policy:
  default-src 'none'; ...; sandbox` and every asset with `nosniff`.
- **One way in for files.** `AssetStore.save_bytes` and `FontStore.save_bytes`
  take bytes; uploads decode their data URL and call them, imports call them
  directly. `used_by` speaks the deck's words ("the Now Playing window").
- **A damaged scene file** is set aside as `<file>.corrupt` - not tried again
  at every start, and not shuffled into the backups by the next save (it
  would have become backup 1, and restoring it a 500). A scene that came
  back from a backup has its file written whole again at once. One with no
  good copy is listed in `/api/scenes` as `unreadable`, and the editor says
  so once. `restore()` of a damaged backup returns None.
- **QA found, and fixed:**
  - The deck's delete on a picture a scene uses did nothing, and said
    nothing: the server refused, the deck ignored the answer. It now says
    where the picture is used and asks "Delete it anyway?".
  - A picture whose file is gone (deleted anyway, or not in an import)
    showed Chrome's broken-image icon on stream. `scene.js` hides it there
    and outlines the box in the editor's preview ("Picture missing").
  - The editor's top bar wrapped to two rows at 1280 wide (150% on a
    1920 x 1080 screen). The grid size menu shows only while the grid is on,
    the bar is tighter under 1440 px, and the save state says "Saved" (as
    the page starts) rather than "All changes saved".
  - The deck at 480 and 360 px wide cut off its LIVE strip (Remote, Quit)
    and the looks row ("Delete"): `body` does not scroll sideways, so what
    was wider than the window could not be reached at all. Both rows wrap.
  - A font that is not on this PC was already handled (`writeControl` adds
    "Nope Sans (not available)" to the menu) - checked, not changed.
  - Autosave conflicts: P7's test covers them (a save held while someone
    else saves; the editor reloads and says so) and passed again.
- **The build.** `rebuild.ps1` is rewritten. The old one let PyInstaller's
  `--noconfirm` replace the whole app folder and put back only config.json
  and five cache folders - the scenes and the saved stream key
  (`cache\live.json`) would have been lost, and the app was down for the
  whole build. Now: the build goes to `dist-staging` while the app runs; it
  is tried there on port 8797 (every page and API, and a scene exported and
  imported by the build itself); only then is the app asked to quit and the
  program files mirrored over with `robocopy /MIR`, `config.json` and
  `cache\` excluded by full path, so nothing of the user's is moved, copied
  over or deleted (a safety copy is still made first). `pip --no-index`: a
  rebuild never downloads. `-CheckOnly` stops after the try-out: built in
  50 s, every new web file inside, all ten pages and APIs 200, export and
  import 200 - the user's app untouched.
- **Tests.** `tests/test_p12.py` (16): the round trip to a second PC's
  stores, thumbnails, a new name, a newer manifest, never over a file, a
  deleted picture listed; every refusal above; every file left out above;
  capped reads; a changed file re-pointed; the damaged-file handling; an
  upload with its thumbnail; `used_by` in words; the import route's place;
  the SVG policy. `tools/p12` on the rig, headless, 30 of 30: the two scene
  files damaged by the runner (one back from its backup, one set aside and
  said once); the missing font; Export from Share (2 pictures and 1 font
  inside) and Import from New scene (the same scene back as a new one, and
  what came with it said); a tampered .zip (1 picture not in it, outlined;
  2 files left out, said) and a file that is no .zip (refused in words,
  nothing changed); the deck's delete on a picture in use (where it is used;
  No keeps it, "anyway" deletes it; the output then shows nothing there);
  every inspector field of seven layer types and of the scene - 271, each
  one undo step, undo and redo exact (a first run failed from field ~200 on:
  the editor keeps 200 steps, so the test now reloads between layer types);
  keyboard only (33 Tabs to the layers list, arrows, Shift+arrows, Ctrl+D,
  Delete, Ctrl+Z / Ctrl+Shift+Z, "+20" Enter in X, ? and Esc); the editor at
  150% on 1920 x 1080 and 2560 x 1440 screens and at 100% (one row, nothing
  sideways); the deck at 1400, 1280 at 150%, 1024, 760, 480 and 360 px; no
  console errors. `p12live.js`, 7 of 7: LIVE from the panel to a local
  listener; the listener killed - *Reconnecting* in 0.1 s; a new listener -
  LIVE again 0.5 s later, one reconnect counted; Stop asked twice; the 191
  frames recorded after the reconnect decode without a decoder error (the
  engine sends a keyframe first).
- Again after P12: P6 21 and 22 of 22, P7 16 of 16, P8 56 of 56, P9 72 of
  72 (its scene inspector golden replaced: the new Share section, placed
  after Transparency - an action after the settings), P10 24 of 24, P11 24
  of 24; the Python tests, 97.
- **Still open, and the user's:** the transparency test page in LIVE Studio
  (a Link source on `/transparency-test.html`), a first real TikTok LIVE
  with their own key, and rebuilding their installed app (it runs pre-P1
  code) - `rebuild.ps1`, when they are not gaming.

## P11 - running a show (2026-09-12)

`web/livepanel.js` + `livepanel.css` (the LIVE panel, one for the deck and
the editor), `web/studio.js` (studio mode in the editor), `web/remote.html`
(the scene remote), and three small server pieces: the program monitor's
picture, the remote's window and its "on top", and the sound sources
remembered for the next start. P4's engine did the rest already.

- **The LIVE panel** - from the editor's LIVE button and the deck strip's
  LIVE…, or Ctrl+Shift+L in either. The Server URL and stream key (a
  password field; Paste reads the clipboard into it; Save keeps it
  encrypted with DPAPI and empties the field - the page never receives a
  key back, only whether one is kept; Forget asks twice), the quality
  preset with what it asks of your upload (the preset's video bitrate plus
  audio, with a third to spare), the scene that goes out, the microphone
  (which one) and desktop sound with gain, mute and a meter each (the meters
  are the native mixer's levels, so they move while LIVE; sources and the
  microphone count from the next start, gain and mute at once), Start and
  Stop, and the health: time on air, bitrate, frame rate, dropped frames,
  reconnects, delay. "TikTok refused the stream key after it had been live"
  (the engine's own message when a key is rotated mid-stream) becomes a
  plain "copy the new one from LIVE Center, paste it, Save, Start" with the
  focus in the key field. While open it polls `/api/live/status` twice a
  second when LIVE, every 1.5 s otherwise, never while closed or hidden.
- **Stop asks twice**, in the panel, the deck's strip and the remote: one
  stray click must not end a show. (P6's deck test clicks twice now.)
- **Studio mode** (the editor's Studio, Ctrl+Shift+P): the scene being edited
  is the preview; beside it the program - a picture of the live output
  window taken once a second (`/api/live/program.png`, the stream's own
  source, off screen or not) - with Cut or Fade and its length, and Take
  (Ctrl+Enter) to put the edited scene on air, after saving it. Editing the
  scene already on air turns Take off and says that changes go out as they
  are made. Nothing polls while studio mode is off or the editor hidden.
- **The scene remote** (Remote, in the editor and the deck): a small
  window - every scene as a big button (press one: on air), the one before
  or after, Cut or Fade, Start and Stop, and "On top" (remembered;
  `winwin.set_topmost` on its window). It opens only when asked for - it is
  a topmost window, and those never pop up by themselves. Keys: 1-9, the
  arrows, C and F. One state feed, no polling.
- **In-app shortcuts only** - no global hotkeys yet, so nothing is taken
  from a game.

Tests (`tools/p11/p11test.js`, headless, a real stream on the rig to a local
ffmpeg RTMP listener, the live output window parked off screen and not on
top, no camera in the scenes and the sound turned off in the panel - nothing
of this PC's recorded):

- 24 of 24. The LIVE button opens the panel with the focus in it; Start
  waits for a key and a scene; the Server URL and key typed and saved (the
  key gone from the page, never sent back, only "Saved"); 720p30, the scene,
  the microphone and desktop sound off - all from the panel; the upload
  hint. Start: LIVE in 3.5 s, the health showing 3.40 Mb/s at 30 fps (the
  first run found Start disabled forever - it waited for the engine's URL,
  empty until a first start; the vault's saved URL is in the status now,
  and the numbers say "measuring…" for the seconds before they are
  known). Ctrl+Shift+P: studio mode, its program monitor showing the live
  output (off screen), Take off while editing the scene on air. 20 switches
  - remote clicks, its number keys, a studio Take with Ctrl+Enter - each on
  air, the stream LIVE throughout. Stop asked twice; the rotated-key error;
  Forget (asked twice). Every control of the panel (16), the program panel
  (3) and the remote (20) reached with Tab. The recording, decoded: 862
  frames over 28.7 s - 30.0 fps, the largest gap 34 ms; 20 changes between
  the two scenes (counted with a margin, so a fade passing the middle
  counts once); no black frame and no frame darker than its neighbors -
  the darkest 92, the brightest 182 of 255. No console errors.
- Found by running P9 again after P11, and fixed:
  - The editor's top bar went to two rows at 1600 px once the live-media
    badge showed: Studio and Remote took the last 130 px, and every panel
    below lost 40 px. It already wrapped at 1440. Below 1700 px the
    "Canvas Builder" brand is hidden (the window title says it), so the bar
    stays on one row, badge included.
  - The voice threshold slider could save the old value. The meter polls
    every 150 ms, and a reply landing inside the slider's 120 ms debounce
    put the old number back into an unfocused slider; the timer then saved
    that. The value is now taken when it changes, and until it is saved no
    poll paints the slider (a poll asked before the change is ignored too).
  - The P6 and P7 runners left a Chrome profile (cookies and all) and a
    copy of the rig's scenes in the repo's tools folders, untracked and one
    `git add` away from a commit. They use the rig's scratch folder now,
    like every runner since P8.
- Again after P11 and those fixes: P6 21 and 22 of 22 (Stop is now
  clicked twice), P7 16 of 16, P8 56 of 56, P9 72 of 72, P10 24 of 24, P11
  24 of 24; the Python tests, 81.

## P10 - the phone canvas (2026-09-12)

`scenes.py` (the layout for another format, what sits under TikTok's
controls, the gallery's data, three phone templates), `web/newscene.js` (the
gallery, the format switch, "Make a phone version"), and the warnings in
the canvas tools, the layer list and the inspector.

- **One layout, on the server.** `scenes.convert(scene, fmt)` lays a scene
  out again for the other format; the unit tests hold it to its promise -
  every layer inside the canvas, rotation included, for every template both
  ways and sixty random scenes (huge, off the canvas, rotated, grouped). It
  keeps every layer's id, order and settings. "Make a phone version" stores
  its result as a new scene (`POST /api/scenes/<id>/convert`); the editor's
  Horizontal / Phone switch uses it on the working copy
  (`POST /api/scenes/convert`, nothing stored) and makes it one undo step -
  before P10 the switch only resized the canvas and left the layers where
  they were, off it.
- **The rules.** Backgrounds fill the new canvas. A game or screen capture
  that filled the old one becomes the picture across the top - 16:9, as wide
  as the phone, just under TikTok's top bar. Everything else moves in units:
  a group, and layers stacked on each other (a camera inside its frame, a
  caption on a picture), found by overlap. Each unit keeps its side of the
  canvas - the third it was in - and its order down the page, placed where
  it was in proportion; if that runs past the room, they are packed from the
  top, side by side where they do not overlap, none over another, and shrink
  together until they fit (down to half; beyond that they overflow and are
  marked). On a phone the room is between TikTok's top bar and its comments,
  and clear of its side buttons. Sizes in pixels (text, frame widths,
  corners, strokes) shrink with the box.
- **TikTok's controls** (`SAFE_ZONES`, P3's approximations): a layer is
  "under" them when they cover at least 8% of it; backgrounds and anything
  filling most of the canvas are meant to sit under them and are left out.
  The same rule in Python (`zone_hits`) and in the editor (`zoneHits`):
  a ⚠ at the layer's corner on the canvas, a ⚠ on its row, a line in its
  inspector naming the controls, and the scene's count in the scene
  inspector. The overlay itself (P8) still toggles, and its edges are
  snapping targets; the warnings stay when it is hidden - the controls are
  there on the phone either way.
- **Templates.** "Gaming portrait" (P3) had its camera, captions and Now
  Playing under the comments; it is laid out again, and two phone templates
  join it - Just chatting (phone), Music (phone) - all clear of TikTok's
  controls (a unit test). The New scene dialog (the scene menu's "+ New
  scene…", or the empty editor's button) shows two blanks and every
  template, each drawn from its boxes as a small picture (background,
  windows, camera, text, TikTok's zones on phone ones): instant, and exactly
  where things are. A name, arrows between the choices, Enter to make it,
  Esc to go back.

Tests:

- Unit (`tests/test_p10.py`, 12): every template both ways inside, and the
  horizontal ones clear of TikTok as phone versions; sixty random scenes
  inside; a camera kept in its frame; a group moving as one; the game across
  the top and backgrounds filling; text shrinking with its box; which
  controls cover a layer, a sliver not counting, none on horizontal scenes;
  the phone templates clear; the gallery's data.
- `tools/p10/p10test.js` (headless, fake camera): 24 of 24. Every template
  as its output draws it, a screenshot each, every layer drawn and inside;
  each laid out for the other format and drawn again, inside, and the phone
  versions of the horizontal ones clear of TikTok's controls. The gallery: two
  blanks and six templates, each with its thumbnail; the scene's format
  chosen and focused, the scene menu left as it was; arrows, Esc; a template
  made into a named scene the editor opens. The Phone switch: every layer
  inside, none under TikTok, one undo step, undone exactly. "Make a phone
  version": a new phone scene, the original untouched. A layer moved under
  the comments: the ⚠ on the canvas and its row, the inspector's line, the
  scene's count. The safe zones toggling off and on (the first run found the
  button stuck disabled after a switch from a horizontal scene - it now
  follows the scene), the warnings staying; a layer dragged near the
  comments snapping to their edge. No console errors.
- Again after P10: P7 16 of 16, P8 56 of 56, P9 72 of 72 (its scene
  inspector's golden rewritten for the new Format section, checked by eye
  first - the only difference); Python 76.

## P9 - inspectors for every layer type (2026-09-12)

`web/inspectors.js` (the sections), `web/designer.js` (the deck's control
vocabulary, now shared), small hooks in `canvas.js`, and a little runtime
and backend: entrances and loops in `scene.js`, a settable voice threshold,
the mouse pointer for native captures, a camera list route.

- **The deck's controls, not copies of them.** The deck's design controls
  were already plain markup - `data-np="text.font" data-kind="range"`, a
  readout beside it - bound by one generic binder. That binder's pieces
  (`readControl`, `writeControl`, `showOut`), the font lists and upload, and
  the deck's background editor (`bgEditorHTML`) moved into `designer.js`,
  loaded by both pages; `bindDesign`/`syncDesign` bind the same vocabulary
  inside any container, to any scope. deck.js lost its copies (10.5k
  characters) and uses the shared ones.
- **Every inspector speaks that vocabulary.** A layer's controls are
  `data-lx="props.size"`, the scene's `data-sx="background.mode"`; each
  change is `setField` (so merged runs, undo and autosave as everywhere).
  Settings a layer does not carry show the runtime's own default.
- **"Customize for this scene" is the deck's own tabs.** The editor fetches
  `deck.html` once and takes the component's look tabs (Now Playing:
  Colors, Text, Art & bar, Decor; the others: Look, Text) plus its
  background editor, strips the deck's wiring (ids, buttons that act on the
  deck, window-only settings like Clickable or Look up online) and binds
  what is left to `props.custom`. `embedhost.js` already laid that over the
  deck's live design, so a customized window starts as your design and only
  what you change is the scene's: the rest keeps following the deck. A reset
  dot hands one setting back; "Back to my design" drops them all.
- **Backgrounds** - the background layer and the scene's own - get the
  deck's background editor as it is (solid, gradient, generated artwork with
  its thumbnails, a picture), its pickers turned into the editor's.
- **Pictures** have one picker everywhere (image layers, reactive images,
  background pictures): the asset grid, an Upload tile, and drop to upload;
  it loads the asset list the first time it is needed (the test found the
  grids empty until the Assets tab had been opened).
- **Motion (runtime):** an entrance (fade, rise, drop, from the left or
  right, pop, zoom; duration, delay) plays when a layer appears - the scene
  opening, a switch, a trigger showing it - and from the inspector's Play.
  A loop (float, pulse, sway, spin) runs while shown. Both use the
  individual `translate`/`scale`/`rotate` properties, so the layer's own
  rotation stays. Loops are endless, so motion.js steps them at 30 fps and
  Ultra stops them; entrances count their own steps and are skipped in
  Ultra. They live in `props.enter` and `props.motion` - `props.loop` was
  already a video's loop switch.
- **Voice threshold:** a setting now (`config.voice.threshold`, POST
  `/api/voice {threshold}`), read by the monitor on every block, so the
  reactive-image inspector's slider counts at once; its meter polls
  `/api/voice` only while that section is open and the editor visible.
  While captions listen, their speech detector decides, and the meter says so.
- **Capture:** the picker shows the screens and windows with thumbnails that
  refresh every 3 s while the list is open. "Show the mouse pointer" reaches
  Windows Graphics Capture through the native sources (IsCursorCaptureEnabled,
  Session2's slot 7; Session3's slot 7 stays IsBorderRequired = off).
- **Camera:** the device menu lists the cameras Media Foundation knows
  (`/api/camera/devices`), plus resolution, frame rate, shape, fit, mirror.
- **Live indicator:** whenever the editor's preview holds a camera or screen
  stream, a red badge says so in the top bar, the layer's row gets a dot and
  its inspector a line - polled once a second from the preview, and only
  while the editor is visible.
- **Triggers** are rows (when: talking, quiet, starting to talk; do: show,
  hide, bounce, pop, add a style); "pop" and "when I start talking" go
  together, since that is the only moment a pop happens.

Tests (`tools/p9`, headless only; fake camera; what depends on this PC - the
asset list, screens and windows, cameras - answered by the test):

- `p9test.js`: 72 of 72, twice - writing the goldens, then comparing (all
  ten inspectors, 0.00% of pixels different). Per layer type: its sections
  and a golden picture of the inspector. Then some forty fields driven as a
  person would, each one exactly one undo step with exact undo and redo,
  and checked in the preview's rendering: words and a live-text chip, weight,
  alignment, gradient, glow, a pill color with its opacity, letter spacing
  and its readout; a picture from the grid, one dropped onto it (uploaded),
  tile, flip, a border, a 20% crop shown as a percentage; a background
  gradient and generated artwork; a frame with a hole; a border loop drawn;
  a rise-in played and played again, a float loop, stopped by Ultra;
  triggers. The customized Now Playing's accent (the deck's own control)
  reaches the output while a deck change reaches the linked Lyrics live and
  not the customized setting; no card and no album art inside the embedded
  page; Back to my design. The camera's device menu, 1080p, a circle; the
  live indicator on, and off when the camera is hidden. Capture sources with
  thumbnails, a window, the pointer. The threshold slider kept in the
  config, "Try it". A font added from the inspector's Add font (one step).
  The scene's own background. Connections: the output one feed, its four
  windows none, 0 of 6 event streams. Undo all 36 steps: the scene exactly
  as it was, on the server too. No console errors.
- Unit tests (`tests/test_p9.py`): the threshold clamped, reported and read
  live by the monitor; the pointer reaching the native sources; the shared
  scripts loaded before the pages that use them, deck.js without its copies;
  the deck panes the inspectors borrow exist; every entrance and loop has
  its style, the loops endless.
- Again after P9: P6 21 of 21 and 22 of 22 (with three new checks for the
  deck's side of designer.js: the helpers, the 27-font menus, the five
  background editors, a range saving with its readout), P7 16 of 16, P8 56
  of 56; Python 64.

## P8 - canvas tools (2026-09-12)

Direct manipulation on the Canvas Builder's canvas: `web/canvastools.js`
(the tools), `web/snap.js` (the snapping math, pure, so node tests it on its
own), and small hooks in `canvas.js` (`recordGesture`, `paintHud`, the
inspector's number fields).

- **One gesture, one command.** A drag changes the working copy live - the
  preview redraws, the inspector follows, the autosave runs - and on release
  one command goes on the stack with the scene from before the drag
  (`recordGesture`). Esc mid-drag puts the before back. If the scene is
  replaced under a drag (a conflict reload, an undo), the drag is dropped
  instead of being applied to the new scene.
- **The output follows the drag.** Because the autosave runs during the drag
  (every ~150 ms at most, one save at a time), an open output window - and
  so a stream - shows a layer moving before it is let go; still one undo
  step. Drag steps run on animation frames with a 50 ms timer behind them:
  the test found a page with no frames (the output tab in front of the
  editor's) stepped nothing until release.
- **Pointer math.** scene = (client - viewport corner - pan) / zoom, all in
  CSS pixels, so the screen's 150% never enters it. Handles, guides, rulers
  and labels are drawn in screen space (`#hud`), the same size at any zoom;
  the grid and safe zones in scene space under them. Tested at 49%, 200% and
  30% with the page at device scale 1.5: moves and resizes land to the pixel.
- **Whole pixels.** Moves and resizes of unrotated layers land on whole
  pixels; the pointer's travel is rounded before it is used, so a resize
  from the center stays centered (the test caught 299 for 298). Rotated
  layers keep positions to 0.01 px: turning about the center with a corner
  anchor needs them.
- **Modifiers.** The plan asks Alt for both "resize from the center" and
  "skip snapping". Moving: Shift keeps to one axis, Alt (or Ctrl) skips
  snapping. Resizing: Shift keeps the shape, Alt from the center, Ctrl skips
  snapping. Rotating: Shift turns in 15 degree steps; otherwise it settles
  on 0/90/180/270 within 3 degrees. A modifier pressed or let go mid-drag
  counts at once (the step is taken again). No Alt-drag duplicate: Alt is
  the snapping override.
- **What snaps, and to what.** The canvas's edges and center; other visible
  layers' edges and centers (a rotated layer by its bounds); equal spacing
  between two neighbors in a row or column; guides; the grid (only where
  nothing else is in reach); the safe zones while shown. Reach: 6 screen
  pixels. The closest line wins on each axis - which the test layout proved
  twice by snapping to a line its author had not noticed (T's center, A's
  middle). Resizing snaps the moving edges of an unrotated box. Smart
  guides: a line across both boxes (or the whole canvas for canvas, guide
  and safe-zone lines), the two equal gaps with their size, and while moving
  the distance to the nearest neighbor on each side.
- **Selecting.** A click picks the topmost visible, unlocked layer; a
  grouped layer brings its whole group, and a double-click picks just the
  layer. Background layers fill the canvas, so the canvas does not pick
  them (dragging on one draws a selection box); the layer list does.
  Pressing on the selection and dragging moves all of it; a click without
  a drag narrows it to what was clicked. A selection box takes what it
  touches; Shift or Ctrl adds.
- **Guides** are the scene's own (`scene.guides {h, v}`, validated since
  P2): dragged out of the rulers, moved, snapped to layers and the canvas
  while dragged, removed by dragging them back onto a ruler or from their
  menu. The view toggles - snapping, grid and its size, rulers, safe zones -
  are this editor's (localStorage), not the scene's.
- **Number fields take math.** They are text fields now: a plain number
  applies as it is typed (one merged step), anything else on Enter or when
  the field is left. `1920/3`, `100+20*2`; `+20`, `*2`, `/2` change what
  the field held when you came to it; `-20` is a value, so subtracting is
  `-=20` (`+=`, `*=`, `/=` also work). With several layers selected, each
  one's own value changes (`*2` doubles each width) and the field is blank
  where they differ. Up/Down step by 1 (Shift 10, Alt 0.1); Esc puts the
  value back, and a merged run that ends where it began leaves no step
  (`exec` drops it).
- **Align, space out, arrange** work on units: a group selected whole moves
  as one. One unit selected aligns to the canvas. Space out gives equal gaps,
  the outer two staying. Send to back stops above background layers. Arrow
  nudges merge into one step while the presses keep coming.
- **Copy and paste.** Copy puts the layers on the clipboard in a type of
  their own (`application/x-awesome-canvas`; Chrome carries custom types
  between its pages, so another editor window can paste them), their names
  as plain text, and a copy in localStorage for when the clipboard can't be
  read. Pasting our layers: where they were; back onto their originals, a
  24 px step per paste; off a smaller canvas, centered; background layers
  sized to the new canvas; groups get new ids. A pasted picture is uploaded
  to Assets and added as an image layer; pasted text becomes a text layer.
  The tests use the page's own clipboard events, so the user's clipboard is
  never touched.
- **Menus** on layers (canvas and list), the empty canvas, guides and rulers:
  `role=menu`, arrows, Home/End, Enter, Esc, disabled items skipped, focus
  back where it was; Shift+F10 or the menu key opens the selection's.

Tests (`tools/p8`, headless only - one monitor):

- `snaptest.js`: 13 of 13 - bounds, edges, centers, guides, spacing, grid,
  safe zones, distances, field math (also run by `tests/test_p8.py`
  wherever node is installed).
- `p8test.js`: 56 of 56 - real CDP pointer drags on the test layout at
  49% zoom (snapping reach 12.3 scene px): select, box select over the
  background, Shift/Ctrl+click; move exact; snapping to an edge (with its
  smart guide), to the canvas center, to equal spacing (both 140 px gaps
  labeled), to a guide and to the grid; Alt pressed mid-drag letting go of
  a snap and letting it back; resize by corner, Shift, Alt, snapped to the
  center line, two layers from their shared box, a rotated layer with its
  far side fixed to 0.00 px; rotate to 90 about the center and in 15 degree
  steps; nudges as one step; a guide added from the ruler, moved, snapped
  to, removed onto the ruler; five inspector sums and a two-layer `*0.5`;
  space out, align left, align one to the canvas; front, back, forward
  from the keyboard; the right-click menu by pointer and keyboard and
  Shift+F10; moves and resizes exact at 200% and 30% with the page at
  device scale 1.5; an open output showing a drag before release; copy,
  paste twice in place, paste into a phone scene, text pasted as a layer;
  the phone scene's safe zones and grid; no console errors. Every action
  checked for where it lands and for being exactly one undo step with exact
  undo and redo; then undo all the way back to the layout (5 and 12 steps),
  on the server too.
- P7's suite again after P8: 16 of 16 (edit to output 83-87 ms).

Not done here: Figma's rotate-from-outside-a-corner, snapping for rotated
resizes, and editing a text layer's words on the canvas (P9's inspectors).

## P7 - the Canvas Builder editor (2026-09-12)

`web/canvas.html` (+ `canvas.css`, `canvas.js`), opened from the deck's
Canvas Builder button or a scene card's Edit. What it is built on:

- **The canvas is the real renderer.** The center shows `scene.html` in
  preview mode, sized to the scene and scaled and panned by the editor -
  so what you edit is exactly what an output window shows, every layer
  type included, with no second renderer to keep in step. The editor
  pushes its working copy into that preview by `postMessage` on every
  change (a small hook in scene.js, preview only, same origin only; once
  pinned, the preview ignores revisions from the feed, because the editor
  is ahead of them). The editor itself only draws the selection over it.
  Zoom to fit, 100%, the wheel zooming around the pointer, Space+drag (or
  the middle button) to pan; a checkerboard shows through see-through
  scenes; a click picks the topmost visible, unlocked layer, rotation
  included.
- **One store, every change a command.** A command keeps the scene before
  and after it, so undo and redo are exact whatever the change was; the
  same change repeated within 0.9 s (typing a name, dragging a slider)
  merges into one step. History is 200 steps.
- **Autosave, with revision checks.** A change is saved 60 ms after the
  last edit and never more than 150 ms after the first unsaved one, one
  save in flight at a time, each carrying the revision it was based on
  (`expect_rev`). A save the server refuses as stale (409: someone saved
  first) is dropped; the newer scene is loaded, the history cleared, and a
  notice says so. With nothing pending, a change made elsewhere (the deck,
  another editor) is simply taken. An open output window sees an edit
  through the ordinary path - save, revision, feed, render - and that path
  is short (`tools/p7/latprobe.js`, six edits): the save's round trip 15-19
  ms, the feed reaching the output 1-4 ms, the output fetching the scene
  and showing it 3-4 ms, 21-25 ms in all; the editor's own 60 ms debounce
  comes on top. An undo or redo ends a merge run, so an edit after one is
  a step of its own.
- **Backups at the editor's pace.** The scene store kept five backups and
  shuffled them on every save - with an editor saving several times a
  second they would have held the last few keystrokes. They now shuffle
  only when the newest is a minute old (`SceneStore.backup_every`; the
  rotation tests set 0, `tests/test_p7.py` covers the throttle).
- **Layers panel:** top first; drag to reorder (a layer, the selection, or
  a whole group); visibility and lock per layer and per group; rename by
  double-click, F2 or Enter; click, Ctrl+click and Shift+click selection;
  groups (`layer.group`, names in `scene.groups`, a collapsed group is a
  view choice and not saved). **Sources:** an Add menu from the layer
  types (text, shape, image or video, camera, the four components,
  reactive image, background), and the windows and screens from
  `/api/capture/sources` with a thumbnail each - picked, they become a
  native capture layer. **Assets:** the library with thumbnails, upload,
  and a picked asset either becomes a picture layer or replaces the
  selected one's picture.
- **Inspector:** the selection's name, position, size, rotation, opacity,
  corners, blend, visibility and lock, plus the main settings of its type;
  with nothing selected, the scene's own name, background and transparency.
  (The full per-type inspectors are P9; moving and resizing on the canvas
  is P8.)
- **Keyboard and accessibility:** a toolbar, tabs with arrow keys, the
  layers as a multi-select tree (one Tab stop, arrows and Shift+arrows,
  Alt+arrows to reorder), a labeled canvas and inspector, a visible focus
  ring, announcements for undo, redo, saves and conflicts, and a shortcuts
  dialog (`?`) that keeps focus and gives it back.

Tests (`tools/p7/p7run.sh`, headless only - test windows never go on the
main monitor, and the second one was unplugged): 16 of 16 on a
just-chatting scene. The page and the scene fit at 1600x900 and 1280x720
(screenshots); the panels are tabs, the layers a multi-select tree with one
item per layer and one Tab stop, the inspector labeled; Tab goes top bar,
panels, canvas, inspector, with a visible focus ring; `?` opens the
shortcuts and Esc gives focus back. Undo of all 11 steps of a mixed run -
add, rename, move, text, hide, lock, group, reorder, duplicate, delete, a
scene field - returns the scene exactly, redo returns every change, and
typing a name is one step. Autosave lands on the server. An edit reaches a
separate output page in 83-96 ms (median 83; the first run read ~400 ms
because the headless output page was a throttled background tab - the
runner now starts Chrome with the app's own no-throttling flags). An
autosave conflict - the editor's save held while the scene was saved from
outside, then let go - is refused, the newer scene loaded, the history
cleared and a notice shown; an outside change with nothing pending is
taken quietly. No console errors in the editor or the output page.
`tests/test_p7.py` covers the backup throttle.

## P6 - the deck shows the new backend (2026-09-12)

What the deck gained, and the choices behind it:

- **The components row is drawn from the registry** (`components` in the
  state) instead of four cards written into deck.html. It is one strip in
  three groups - Music and words (the four), Screen sharing (the two
  frames), Canvas (one card per scene) - that scrolls sideways: cards snap,
  an edge with more beyond it fades, arrows page it, a vertical wheel
  scrolls it, a focused card is brought into view, and the left and right
  arrow keys move between cards. The four music cards keep the element ids
  the rest of deck.js binds to (`npToggle`, `lyStatus`, ...), and the row is
  first drawn from the registry's own four before anything binds to them,
  then redrawn from each snapshot; their nodes are kept, so their listeners
  stay. New cards - frames, scenes - act through one delegated handler and
  the registry routes (`/api/components/<id>/<action>`). Each card's line
  comes from the registry (`sub`).
- **Screen frame and Camera frame** are components like the others
  (`screenframe`, `camframe`; one page, `frame.html?kind=screen|camera`;
  settings under `frame` in their own config sections, and in the state as
  `frames`). A frame is a border around a hole the game or camera shows
  through - see-through (a scene, or a capture that keeps transparency) or
  the key color (chroma key); everything that is not frame is the hole, so
  a round camera frame's corners key out with it. Border styles solid,
  double, dashed, glow or none; square, rounded or circle; decor.js's loop
  of characters or motifs round the edge (the same patterns as Now Playing,
  paused and stilled like it); four corner badges and a title plate. The
  deck designs them in four tabs (Frame, Loop, Badges & title, Size) through
  a `data-fr` scope bound to whichever frame is picked, pushed straight into
  the preview and saved debounced, like the other windows. A minimized frame
  idles like any window (`idleHere` knows the page by its kind).
- **Canvas cards**: Open output (the scene's own output window), Go LIVE
  (makes it the live scene; streaming itself stays the LIVE strip's Start),
  Edit (the Canvas Builder on that scene).
- **Canvas Builder button**: `/api/canvas/editor/open` opens
  `canvas.html[?scene=]` as its own app window through the deck's launcher;
  the page is a placeholder until P7.
- **LIVE strip** in the top bar: the state (Off air, Connecting, LIVE with
  uptime and bitrate, Reconnecting), the live scene picker, Start/Stop wired
  to `/api/live`. Start stays disabled, and says why, until a stream key is
  saved - the key, presets and audio are the LIVE panel's (P11).
- Fixed on the way: Enter or Space on a card's own button selected the card
  and swallowed the press (the button never ran from the keyboard); the top
  bar wraps its controls onto a second line on a narrow deck instead of
  pushing Quit off the edge; and the deck's pause check (the efficiency
  pass) threw while the preview was between pages - a document with no root
  element yet - so it now skips that moment. And the strip's own test
  caught snapping at work against focus: a focused card at the end of a
  group was scrolled in, then pulled half back out to the nearest snap
  point. Focus now scrolls by the smallest amount that shows the card, with
  snapping paused until the next wheel, click or touch on the strip.

Tests. `tests/test_p6.py` covers the registry the row is drawn from (the
groups, every card's line, the frames' own sections, scene cards coming
and going with their scenes, the old route names); the P2 registry tests
know the two frames. On the rig (`tools/p6/p6run.sh`), headless only - the
second monitor was unplugged, and test windows never go on the main one -
with every request that would open, move or resize a real window, open the
Canvas Builder or start a stream answered by the test instead, so it checks
the deck asks for the right one: 19 of 19 checks with no scenes (six cards)
and 20 of 20 with four scenes (ten cards) - the row in its groups, the
music cards' ids, both frame cards, screenshots at 1400 and 700 px, the
arrows, the wheel and focus at 700 px, open, close, heal and snap for each
of the four windows, a frame card picked (the frame page in the preview,
only the frame tabs, a setting saved to that frame), a frame opened by the
registry route, a scene card's output and Edit, the LIVE strip off air and
live, the Canvas Builder button, and no console errors. Both frame pages
loaded with none either. What was not run: a real window opening, since
there was no second monitor to put it on; the windows' own open, close,
snap and heal are unchanged from P2-P5 and were measured there.

## Efficiency pass (2026-09-12, after P5)

A check that everything runs as lightly as it should, against the user's
~5%-of-a-core goal: every piece measured alone on the rig, Chrome by
process type and the server by thread (`tools/p5/optrun.py`), no game
running. It measures; the two fixes it made are below.

The matrix (no game running; Chrome by process type, the server by
thread; each figure is % of one core):

| Piece | Chrome | server |
|---|---|---|
| server at rest, no windows | - | 1.2 |
| Now Playing, nothing playing | 11.8 | 1.8 |
| Now Playing, Ultra | 6.8 | 2.0 |
| Now Playing, minimized | ~1 (a browser burst apart) | 1.7 |
| Lyrics / Queue / Captions, idle | 0.5-0.9 | 1.6-2.0 |
| the deck alone | 34.5 | 0.2 |
| the deck, a live scene in its preview | 38.1 | 1.2 |
| the deck + the four pop-outs, idle | 56.6 | 2.0 |
| the deck + the four pop-outs, Ultra | 24.2 | 2.4 |
| scene output, idle (just_chatting, as shipped) | 13.5 | 1.9 |
| scene output, idle, camera layer hidden | 1.9 | 1.8 |
| scene output, Ultra | ~1 (a browser burst apart) | 2.5 |
| scene output, minimized | 0.9 | 2.2 |
| LIVE 1080p30, no native source | - | 12.7 (audio 4.3, video 3.8) |
| LIVE 1080p30, native window | - | 12.8 |
| LIVE 1080p30, native camera | - | 11.9 (+ camera reader 2.2) |
| LIVE 1080p30, both | - | 15.6 |

The LIVE numbers are the true ones (the P5 tables ran with a game on the
other monitor and read 23-33% - the game, not the stream). Everything the
user pays for the actual stream is the server column; a native source in
the page would have cost Chrome 22-42% (P5), the native compositor costs
the server 0-3.

What was found and fixed:

- **The state snapshot spent 90% of its time looking for windows.** Every
  snapshot asks every component whether its window is open; a component
  whose window is closed fell through to `winwin.find_window`, one pass
  over every top-level window on the desktop (~350) - 17 passes per
  snapshot on the rig, 2.5 snapshots a second from the feed pump, plus
  every broadcast and every `/api/state`. `find_window` takes a `max_age`
  now: the status lookups share one pass (0.3 s), and anything that acts
  on the answer still asks fresh. A snapshot build fell from **5.87 ms to
  0.34 ms** (`/api/debug/snapshot` profiles it); `find_window` no longer
  shows in the profile at all. This is heaviest on the rig (45 scene
  outputs in its config); the user's app has a handful, so its saving is
  smaller - but the cost grew with every scene, and now it does not.
- **The deck's preview moved all the time the deck was in front** - the
  priciest window: 34.5% alone, 41-86% of a core focused (fresh), 56.6%
  with the four pop-outs. Its embedded Now Playing shows a demo track
  "playing": the equalizer bounces, a long title slides, the progress bar
  creeps a few times a second, and each change repaints the preview scaled
  into a large window at 150% (`perfprobe.js`: 60 layouts and 470 style
  recalculations in 10 s, from the preview alone). The deck paused the
  endless animations only while it was behind another window. Now it also
  pauses them after 10 s without the pointer or the keyboard (any input
  resumes at once; `IDLE_STILL_MS` in deck.js), and a paused preview's
  clock moves once a second, as in Ultra (`data-still` set by the deck,
  read by `tick` in nowplaying.js). The preview's decoration ring is a
  canvas drawn by a 30-a-second timer in decor.js, which no CSS pause
  reaches: it now stops on `data-still` too, and a ring standing still is
  drawn once (it used to be cleared and redrawn twice a second while the
  deck was behind another window).

  | The deck, Chrome, % of one core | |
  |---|---|
  | in front, preview moving (real window) | 41 |
  | in front, 20 s without input, before the ring fix (real window) | 13.7 |
  | behind other windows, long idle (real window) | 1.4 |
  | in front, 20 s without input, after the ring fix (headless) | compositor frames 61 -> 2.6 a second, the ring's timer 27.5 -> 2 calls a second with no redraw, the preview clock 5 -> 1 tick a second, paint 7.8 -> 1.8 ms a second |

  The last row is headless only: the second monitor, where every test
  window goes, was unplugged before the real window could be measured
  again, and headless Chrome rasterizes in software, so its CPU figure
  (8.3%) does not compare with a real window's.

Checked and left alone, with the reason:

- **The feed pump's sends:** 0.5 a second at rest and while LIVE - the
  2-second heartbeat; `LIVE.snapshot_status` already leaves out the
  per-second stream stats, so a stream does not make every page re-read
  the state. A send counter on `/api/debug/mem` confirmed it.
- **Now Playing idle at 11.8%** was Chrome settling right after the
  window opened. Probed on the real window through a DevTools port (a
  rig-only flag), settled and idle it costs 1.4% of a core: its page's main
  thread 0.00% over 12 s, no animation, GPU 0.0%. The marquee runs only
  when a title overflows (it does not at the pop-out's 315-of-644 px), the
  equalizer only while playing, the clock stops when nothing plays.
- **Chrome's browser process sometimes spends one to two seconds of CPU
  at once** - seen after minimizing, after an Ultra switch, and at random
  while test windows were being opened. Sampled side by side for two
  minutes, the rig's hosted Now Playing window and a plain, not reparented
  Chrome window with the same flags: neither burst at all (0.4% and 1.0%
  of a core on average). It is Chrome's own, not the hosting's, and the
  minimized and Ultra states themselves cost ~1%.

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
