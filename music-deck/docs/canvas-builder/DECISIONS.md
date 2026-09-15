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

## Chat from the room socket (2026-09-15)

The step after T6, because it closed the gap the page left open. TikTok's page
puts no profile link on a chat line, so from the page's drawing nobody could be
the broadcaster - the streamer included - and moderators were guessed from
badge picture names. The room socket the gifts arrive on carries chat too, and
every line there has the sender's @handle (`webcast.py:175`).

**Who is who, now.** The streamer's own lines are the broadcaster's, found by
handle (`tiktok_chat.py:536`): TikTok sets it and nobody can take someone
else's, so a viewer who copies the streamer's display name is still nobody. A
moderator is TikTok's own flag for the room - field 18, number 5 - checked on
real lives against the moderator badge the page draws: it was on the one
badge-marked line that could be lined up with the socket's, and on none of
about a hundred others. Moderators chat less than viewers, so the positives are
few; the side that matters, a viewer handed a moderator's powers, did not
happen once. A real moderator the flag ever missed would only lose a power -
the safe way to be wrong.
The other flags there (1-4: gift-giver, subscriber, mutual follow and follower,
by the community's definitions) are not taken for roles. The page never drew a
subscriber badge to check 2 against, and a role nobody has checked is not one
to hand out.

**The backlog** is TikTok's own history flag: what was said before the page
joined never arrives. That mattered at once. Since T6 the page script runs from
the page's first moment, and TikTok draws its backlog after the script is
already watching - so in one real room the page reader sent exactly the six
backlog lines as new.

**The page's drawing is the fallback** (`tiktok_chat.py:413`): never in the
first 15 seconds after the page opens, when TikTok draws that backlog before its
socket is up, and never while the room socket was heard from in the last
minute - so a line is never sent twice, once from each. If TikTok ever changes
its socket, chat still arrives, from the page. The status says which
(`chat_from`).

**What the comparison found.** Lining the page's lines up against the socket's
showed the page reader had been reading every line as the name and the words
together (the fourth fault under "TikTok chat, from your own page", below) - a
command typed in TikTok chat could never have run. Fixed; afterwards every line
paired by name across four real rooms had the same words on the page as on the
socket.

**Checked** in `tests/test_webcast.py` and `tests/test_tiktok_chat.py`, on the
rig by `tools/ui/ttgifts.js` (the host by handle, the copycat, the moderator
flag and its control, history, the page's copy not sent twice) and
`tools/ui/tiktokchat.js` (the fallback waits, and a line drawn in the first
seconds is never sent), and on real lives with the reader as it ships: chat from
the room socket, 84 frames decoded and none bad. One live had no chat socket at
all; the research browser saw the same there, so that room had chat off.

## Gifts from the page's own websocket (2026-09-15)

T6. Gifts are never drawn into TikTok's chat list, so the chat reader could
not see them. Watched on real live pages - headless, muted, throwaway profiles,
signed out, recording shapes and counts only, the recordings deleted after -
the page receives chat, gifts, likes and joins as protobuf on its own websocket
to `webcast-ws...tiktok.com/webcast/im/`, and draws only some of it.

**How it reads.** The reader's DevTools connection turns on `Network.enable`
for its tab (`tiktok_chat.py:449`), which reads the page's traffic as DevTools'
Network tab does, and hands each frame to `webcast.py`. The page has already
done the request signing every other route sends to a third party; the app only
reads what arrived, on this PC. The tab now opens blank and is sent to the live
page (`:453`) only once all of that is in place - or the socket would open
unseen, and the gifts with it. That also means the page script runs from the
page's first moment, before any Log in button is drawn, so signed in is "not
known yet" until the page has drawn its chat list or its button (`:169`), and
the chat panel says it is waiting for the live page rather than guessing.

**One socket, and no other.** `is_webcast` (`webcast.py:189`) passes only
`wss` to a `webcast...tiktok.com` host under `/webcast/im/`. Every other socket
on the page is dropped without being decoded - `im-ws` among them, TikTok's
messaging socket, which on a signed-in page would carry the user's private
messages. A unit test and the rig both send a gift down that other socket and
check it never arrives.

**Decoding, on the standard library.** No protobuf compiler, no schema file,
no dependency. The field numbers come from the community's protobuf
definitions and each one used was checked against real frames first: the push
frame's type and gzip payload, each message's name, id and history flag, the
gift message's id, streak total, end flag, streak id, sender and recipient, and
the gift's own id, type, coin value and name. The bytes are treated as hostile:
lengths checked before use, a number at most ten bytes, gzip inflated to 4 MB
and no further (`:112`), only fixed paths walked. `tests/test_webcast.py`
throws 3,000 random and damaged frames at it: an answer or `Bad`, never another
exception, which would end the reader.

**Streaks.** TikTok sends a streak as messages carrying the total so far and a
last one flagged as the end - recorded for real, a Rose streak of one arrived as
two messages. `Combos` (`:207`) lets only finished gifts out: a one-off at once,
a streak at its end with its total, or its last total after eight quiet seconds
if the end never comes; a late message after an end is dropped, not counted
again. Ids already seen are skipped (a reconnecting socket can resend),
history-flagged messages are never replayed, and a gift to a guest on a shared
live is not the host's - decided by the recipient's @handle, which unlike a
display name nobody can copy. Finished gifts go through `chat.inert` and
`tiktok_gift` (`server.py:1868`) to `post_gift()`. Stop effects' pause does not
hold gifts - that pause is for chat's commands, and a gift is not one - but the
stop itself still takes a showing gift down.

**Checked** in `tests/test_webcast.py`, and on the rig by `tools/ui/ttgifts.js`:
a local page with two sockets, frames built field by field, 26 checks each with
a control. And on a real live, with the reader exactly as it ships
(`tools/ui/ttrealreader.py`): the room socket found, 147 frames decoded and none
bad, 45 chat lines, and a real gift - Heart Me, 1 coin - posted.

**Why the reader had never worked, and does now.** Run as it ships on real
lives, the reader read nothing at all: TikTok's page loaded, but `room/enter`
was refused, no webcast socket opened, and no chat was drawn. Not T6's doing -
the reader as committed before it read nothing either. The earlier "checked
against TikTok's real page" had run its page script in a Chrome of the check's
own, so it could not see how the reader launches. A bisection on one room, one
difference at a time with a control beside it, cleared the window size, the
network buffers, the binding, the injected script, the profile, the tab and the
window flags, and found it: `--remote-debugging-port=0`, Chrome choosing its own
port. Given a fixed one - 9456, or a free one in the same high range - the same
Chrome reads the room; given 0, never. Why TikTok's page cares is TikTok's
business. The reader now picks a free port itself (`tiktok_chat.py:310`) and
writes the port file Chrome no longer writes (`:494`); a test fails if port 0
comes back. `ttreal.js` still answers its own question - does the script read
TikTok's page - and says in its header that it cannot answer this one.

**Not yet:** the sender's picture - a gift shows their initial for now. Chat
from the same socket came next ("Chat from the room socket", above).

## TikTok chat, from your own page (2026-09-15)

T4 and T5. TikTok publishes no API for live-room chat, and Streamlabs' public
docs cover no TikTok events at all (recorded under T4 in the plan). The user
chose the route where nothing leaves the machine: *"Your own logged-in TikTok
LIVE page, running inside the app on this PC."*

**How it reads.** `tiktok_chat.py` opens a Chrome of its own, profile in
`cache/chrome-tiktok` - so the sign-in lives there and nowhere else, and the
rebuild's safety copy skips it with the other `chrome*` folders - on
`www.tiktok.com/@user/live`, with a DevTools port on 127.0.0.1 it picks itself
(`:310`) - never port 0, for the reason in the gifts section above. It connects to
that port, installs one binding, and injects `OBSERVER` (`:81`), which watches the chat list and hands each new line to the
binding. The selectors were first gathered as facts - `data-e2e="chat-message"`,
`message-owner-name`, `-DivComment`, badge image names - from how Social Stream
Ninja's open-source reader finds them, and then checked against TikTok's real
page, which had moved on (below); the code is this project's own. Each line
becomes chat.py's one shape through an Adapter registered beside Twitch's
(`:601`), so `!tts`, layer
commands, polls and the role ladder work for TikTok viewers with no other
change.

**What it never does.** `OBSERVER` only reads: no clicks, submits, navigation
or requests of its own. The page is the user's, signed in as them, and a script
that could press things there could press Go LIVE - `tests/test_tiktok_chat.py`
fails on any of it. The window starts muted (`:71`), or the live page would play
the user's own stream back into Desktop sound and the stream. What is on screen
when it attaches is history, marked seen and never sent (`:147`): a reader that
joined late must not replay ten minutes of `!tts`. It goes to TikTok and nowhere
else (`:421`); the rig's hook that points it at a fixture (`server.py:2828`)
answers only with `TEST_RIG` and only for a 127.0.0.1 address, and the rig's
reader never shows a window (`:1865`). Quitting the app closes the reader's
window (`:3178`).

**Who is who.** A TikTok moderator's or subscriber's badge image reaches the
ladder, so a mod-only command runs for a TikTok mod. The streamer is the
broadcaster only when given a real handle naming them
(`tiktok_chat.py:374`) - a display name is anybody's to set, and matching on it
would let a viewer calling themselves the streamer through every gate. TikTok's
real page puts **no** profile link on a chat line, so in the page's drawing
nobody is the broadcaster, the streamer included. That was the side to fail on,
and it is now only the fallback's: chat comes from the room socket, where every
line carries the sender's @handle ("Chat from the room socket", above).

**The DevTools client** is the standard library's: a small RFC 6455 client
(`:238`) whose reads never consume half a frame (`frame_end`, `:200`), so a
timeout in the middle of one cannot put the stream out of step.

**The chat panel** has a TikTok row beside Twitch's and a line saying what the
window can see (`chatpanel.js:147`): signed in or not, the live page's chat
found or not. That state rides the state feed (`chat.py:498`) - it changes when
the user does something in the window, never per message, so it cannot turn
into a broadcast per chat line.

**The page script, checked against TikTok's real page, 2026-09-15.** The first
version had been tested only against a fixture drawn from secondhand facts, so
it was run against one real public live room: `tools/ui/ttreal.js` - headless,
muted, a throwaway profile, signed out, reporting counts and never a name or a
message - takes `OBSERVER` exactly as it ships, in a Chrome of its own. That is
why it could not see the fault that mattered most, in how the reader launches
its Chrome (the section above). It found three faults, each invisible to the
fixture:
- **The words.** `-DivComment` is gone; the words are in a utility-classed
  element (`break-words`) after the row holding the name. The reader now takes
  that class first and, failing every class, the first element after the name's
  row, never past the line itself (`tiktok_chat.py:114`) - structure rather than
  a name TikTok can change.
- **Which list.** The page had two chat containers at once and the first one
  found was empty; the reader takes whichever holds chat lines (`:139`).
- **Signed in.** A signed-out page was reported signed in: the `top-login-button`
  looked for was not there. TikTok draws that button more than one way - one
  room had `button#header-login-button`, the next a plain button that only says
  "Log in" - so the reader checks the words as well as the names (`:169`).
  English words: the page follows the account's language, and this user's is
  English.
- **The words, again.** Found later the same day, by comparing against the
  room socket's copy of the same lines: the first `break-words` element holds
  the name's row as well as the words, which sit in a second one inside it. So
  every line was read as the name and the words together, and `!hello` arrived
  as "Name !hello" - a command that could never run. The reader now takes the
  last `break-words` that does not hold the name (`tiktok_chat.py:109`); across
  four real rooms, every line paired by name then had the same words on the page
  as on the socket.

After the fix, 25 lines were handed over in 35 s, every one with a name and
words. A second pass with the video left playing - in case pausing it, which
saves this PC the decoding, also stopped the chat - handed over 29, the same
kind of number: the pause stays. The fixture in `tools/ui/tiktokchat.js` is now
drawn in the recorded shape, with a line whose words carry no class so only the
structural rule can find them and a Log in button with only the words, and
`tests/test_tiktok_chat.py` pins all three. `ttreal.js` fails if its signed-out
profile reads as signed in. The signed-*in* side was not checked for real - that
needs the user's own sign-in, which the reader never does for them - and TikTok
will change its page again; running `ttreal.js` is how to find out it has, and
`ttrealreader.py`, which runs the reader itself, how to find out the reader
still reads a live.

## Chat is text, and only ever text (2026-09-15)

Asked for mid-step, in the user's words: *"make sure the screen reader cant run
scripts or code chatters might text out to be malicious!"*

**Where chat goes, and why none of it can run.** The reader takes chat as
`textContent`, hands it over as a JSON string that is only ever parsed as data
(`tiktok_chat.py:563`), and the only script ever run in the page is its own
fixed one, put there before the page loads. The voice reads with the plain-text `Speak()` and gets its words
as JSON on stdin, never on a command line. Every page draws chat as text: the
audit went through every `innerHTML` in the pages that show chat, commands,
requests and polls, and found each escaping or setting the words as text after -
the poll bars on stream included, since a mod's `!poll` can carry typed choices.

**What the parser takes out.** `chat.inert` (`chat.py:61`), which every
service's text and names pass through (`:131`), strips control characters and
the Unicode direction overrides and isolates that flip or hide words - a line
must not read one way in the log and another on stream. Markup is kept as the
characters typed, because "<3" is a heart and every page escapes it; emoji
joiners are kept, or families and skin tones break.

**The mistake made writing it**, and it is the same attack from the other side.
The tools decoded escapes on their way to the file. The first version of the
pattern put the real direction-override characters into `chat.py`'s source - the
"Trojan Source" trick, code that reads one way in an editor and runs another -
and the repair script put real NUL bytes there, so `chat.py` stopped importing.
The rig imported it too: one regression probe failed with "fetch failed" on
exactly that, the rig's error log said so, and it passed once repaired. The
pattern is now built from code points (`chat.py:57`, `:58`), never typed, and
`tests/test_inert.py` fails if any source file carries a hidden direction or
zero-width character. That scan found one more, older than today: a literal
byte-order mark in `tags.py`, now `chr(0xFEFF)` (`tags.py:43`) with no change
in what it does.

Checked by `tests/test_inert.py` and `tests/test_tiktok_chat.py` - 404 tests in
all - and `tools/ui/tiktokchat.js` on the rig, 32 of 32: the reader opening
headless and finding the chat, the backlog not replayed, a new line arriving
through Twitch's pipeline, a viewer's command, a mod-only command denied to a
viewer and run for a badged moderator, the broadcaster by profile link and a
copied display name as nobody, a recycled slot read once, signing in noticed,
and then the attacks: a `<script>`, an `<img onerror>`, a display name made of
markup echoed back by `!hello`, and a direction override. They arrived as the
characters typed, the override stripped, the markup name shown literally on
stream in the alert card - and nothing ran, on the stream page or in the Live
view: no flag set, no `<img src=x>`, no script. Stopping closed the reader's
window. Rerun: `chatui` 30, `onair` 40, `keyleak` 7, `layercmd` 27.

## A gift, on stream (2026-09-15)

T8, built ahead of the gifts themselves. TikTok gifts need T4's event source
and T6's combo counting, so this builds the layer they will land in and the
one function they will arrive through, `post_gift()` (`server.py:1452`).

**What it draws.** A **Gift** layer, full size from the Add grid (`scene.js:1126`):
a coin spinning in 3D that wears the sender's picture - their initial when
there is none - one thing thrown at a target for every coin, or both, and a
card saying who sent what. The target is another layer on the scene, chosen by
name in the inspector (`inspectors.js:859`); the throw is computed from the two
layers' transforms, from a point on this layer's edge to somewhere on the
target's middle, arcing, so ten coins land as a pile rather than a laser. Every
Gift layer hears every gift and keeps what its filters want - at least so many
coins (`scene.js:1196`), or only these gift names - so one layer can take the
small gifts and another the big ones.

**The cap is the design, not a detail.** One element per coin, flown by the Web
Animations API: composited transforms and no script per frame. At most the
layer's "most in the air" (30 by default), never past `GIFT_HARD_CAP` of 60
whatever it says (`scene.js:1125`). A gift bigger than the cap throws the same
number of things faster (`:1228`): a 500-coin gift was 20 things at 360 ms each
against 900 ms for a small one - overflow expressed as speed, not count, as the
plan asked. Every thrown element is removed when it lands. In Ultra nothing
flies and the card says it (`:1224`).

**Stop means now.** `clear()` (`scene.js:1288`) removes everything in the air
synchronously rather than cancelling and waiting: a cancelled animation's event
arrives a task later, and Stop effects is the button pressed because something
is on screen that should not be.

**Nothing pretend reaches an audience.** "Try it" in the inspector sends a
sample gift to the editor's own preview frame by message
(`inspectors.js:1104`), and the frame answers it only in preview
(`scene.js:1825`) - it never calls the server, so it has no path to the bus.
The rig's test route, `/api/debug/gift` (`server.py:2840`), posts a gift to
the bus and refuses unless `TEST_RIG` is set: gated on the flag rather than the
port, because a gift that reached a real stream from a test hook would be a lie
told to the people watching. `post_gift()` keeps the sender's picture only if it
is an asset this app holds (`:1469`); scene.js refuses remote URLs anyway, and
T6 will fetch avatars through the server for exactly that reason.

One test was wrong on its first run. The check that the test route asks about
the rig before posting looked for the first `post_gift(` after the route - and
found the route's own comment, which names the function before the check
comes. It looks for the call now.

Checked by `tests/test_golive.py` (the test route and "Try it" held to their
limits), `test_takedown` (Stop reaches the gift layer) and `test_alerts` (gift
is a kind of its own) - 372 tests in all - and `tools/ui/giftprobe.js` on the
rig, 28 of 28 on its first run: the coin on screen wearing the sender's picture,
which loaded, and turning (its 3D transform read twice, 250 ms apart); exactly
one throw per coin, all ten landing inside the target layer's drawn box and
none left in the page; a big-gift layer dark for small gifts; a gift below the
minimum showing nothing while one a coin richer does; the cap and its speed;
Stop mid-flight with no element left behind; the inspector's target picker;
and "Try it" throwing seven in the editor's preview and none on the stage.
Rerun on the changed code - the Add grid, Stage's stop, the inspector's click
handlers: `addpalette` 12, `fxflood` 39, `ttsprobe` 31, `layercmd` 27, all green.

## The rig can never go live (2026-09-15)

The user, in capitals: *"i finally actually have a streaming key from tiktok
so MAKE SURE TO NEVER ACCIDENTALLY GO LIVE"*. Until that day there was no key,
so a stray start went nowhere. Now a stray start is a public broadcast, and a
rule remembered is not a guard.

**What was already true, checked rather than assumed.** The key lives in the
app's own cache (`live.py`'s `Vault`, `cache/live.json`), encrypted with DPAPI -
which means encrypted *to this Windows user*, so any copy of the app running as
the same user could decrypt it if it read that file. The rig does not: it runs
from `.rig/testrig`, its cache is its own, and it holds no `live.json` and no
Streamlabs token. Every test that streams sends to `rtmp://127.0.0.1:1935`, a
local ffmpeg; no probe or test calls a TikTok route; the rebuild's try-out runs
the new build from a fresh folder with a fresh config. So nothing was wrong -
but all of that was separation by habit, and one mistyped port or copied
config away from not being true.

**The guard, in code.** `live.is_local_url` (`live.py:619`) and a `local_only`
switch on the engine, checked in `start()` *after* the address is resolved
(`:706`) - because `start()` with no address falls back to the saved one, and
a guard on the request alone would wave the vault's address straight through.
Every way of going live, the TikTok tab included, ends in that one method.
`server.py:601` sets `TEST_RIG` from the rig's own config, read once at start
so a page posting to `/api/config` cannot lift it; `:1838` switches the engine;
`:3136` refuses TikTok's go-live and token routes outright on the rig, with a
403 - opening a live at TikTok happens *before* any stream starts, so the
engine's guard alone would come too late for it. `rigrestart.ps1` writes
`"test_rig": true` into a new rig (`:23`), stamps it into an old one on every
restart (`:30`), and refuses to start a rig whose config does not say it
(`:31`). The user's app never has the flag, so nothing changes for it.

**And the mirror image.** `rebuild.ps1` quits the running app to replace it,
so a rebuild started mid-stream would *end* a broadcast. It now asks the app
first and stops, changing nothing, if it is on air (`rebuild.ps1:105`).

Checked on a restarted rig: a start at `rtmp://example.invalid` - a host that
can never resolve, so even a broken guard could reach nobody - refused with
the reason; `/api/tiktok/start` and a token load from this PC both 403; the rig
holds no key; and the control, a start at 127.0.0.1, accepted and then
stopped. Nine unit tests (`tests/test_golive.py`), the vault fallback among
them, and the new voice probe begins by checking the refusal and stops if it
is missing.

## Chat, read out loud (2026-09-15)

T7, built as the user asked the day before: set up on the canvas like
everything else. **Voice** is a layer, its command is on the layer (T11), and
only the scene on air answers.

**Made here, played there.** The voices are Windows' own - System.Speech in a
PowerShell helper (`tts.ps1`) shaped like the captions one, JSON lines in and
out, nothing downloaded and nothing sent anywhere. Its call is `Speak()`, the
plain-text one, never `SpeakSsml()` (`tts.ps1:69`): the text is a viewer's,
and markup in it is read out as characters, not obeyed. The helper never plays
a sound. It hands back a WAV, the server keeps a dozen of them, and the Voice
layer on the scene page plays them one at a time. That detour is the design:
played by the page, a voice obeys the layer's volume, Stop effects
(`takeDown`), the Live view's Skip and "only the scene on air answers" - played
by the helper it would obey none of them. Warm, a clip takes about 0.1 s to
make; the first after an idle spell takes about a second while PowerShell
starts, and an idle helper is let go after five minutes.

**The abuse controls, in the same step.** Reading viewer text aloud is the
riskiest thing the app does. `clean_text` (`tts.py:67`) cuts to the layer's
length at a word, reads a link as "a link", flattens "aaaaaaa" to "aaa", and
refuses a message with a blocked word in it outright - matched as written and
again with every run of letters squashed to one (`:78`), or "baaaadword" walks
past a list that says "badword". A blocked word inside another word is not a
match, so "ass" does not refuse "class". The helper's queue refuses past five
(`:39`). In front of all that sit the layer's own waits - thirty seconds per
person and five between anyone, written into the layer by the Add grid rather
than left to fallbacks - and T10's budget, pause and Stop. Everything that can
refuse does so in `command_speak` (`server.py:1422`) before the command is
logged as run, so the log says why and the budget gets its place back.

**Skip** is a new event the scene page hands to a `skipCurrent()` hook by its
own name (`scene.js:1518`), for `takeDown`'s reason; `tests/test_takedown.py`
now pins that only the Voice layer has one. The Live view shows **Skip voice**
only while a Voice layer on the scene on air answers to something - a flag on
the state feed (`server.py:997`) that changes when scenes do, never per message.

**In the editor**, the inspector lists the voices this PC has (here, David and
Zira), has a "Hear it" button that plays a sample in the editor and never on
stream, and its command note says what the name does for a voice: "Chat can
type !tts and a message to have it read out."

Two things found on the way. `rigrestart.ps1` copied the Python and the web
folder into the rig but never the PowerShell helpers, so the rig had been
running whichever `captions.ps1` it was first given; it copies `*.ps1` now. And
a unit test passed for the wrong reason: the length cap was tested on
`"x" * 900`, which the stretch rule rightly squashes to three letters before
the cap is reached, so "at most 500" held on a three-letter string. It uses
text with no repeats now and asserts exact lengths.

Not done: followers-only needs T4's event source, so the gate is the role
ladder for now; the voices are whatever Windows has installed.

Checked by 22 new unit tests (347 to 369), among them the helper hanging,
dying and answering with nothing - against a stand-in that speaks its protocol
- and the real helper making real speech; and `tools/ui/ttsprobe.js` on the
rig, 31 of 31 on its first run: a message read with its clip really playing
and its words on screen, a layer listening for everything staying dark, the
clip fetched back as a 138 KB WAV, a blocked word refused with the same
message minus the word read as the control, an empty message refused, a link
read as "a link", a long message cut to 60 letters at a word, Skip ending a
clip part way through and the next one still playing, Stop effects silencing
the voice, `!tts` refused while paused, the inspector's voices and "Hear it",
and Skip hidden once no voice is on air. Rerun on the changed code - the
command note, the new Skip dispatch, the Add grid and the Live view's header
all moved: `layercmd` 27, `fxflood` 39, `addpalette` 12, `onair` 40, all green.

## Commands set up on the layer they set off (2026-09-13)

T11, asked for in the middle of T10: *"the tts, gift animations, and chat
commands, should be able to be set up like the components on the canvas
builder"*. Read as: the layer is the setup, not a layer plus a form somewhere
else that has to be kept in step with it.

**What it is.** An effect layer's inspector has a Chat command section - a
name, who may run it, and its two waits (`inspectors.js:442`). Those four props
are all the server reads (`commands.py:99`), and it reads them through
`clean()` itself, so a layer's command obeys exactly the rules a list command
does: one cleaner, not two to drift apart. Adding the layer makes the command
and deleting it deletes the command. The action it runs, `effect` (`:73`), is
deliberately not in `ACTIONS` - that tuple is what the Commands panel offers,
and a list entry pointing at a layer id would break the day the layer went, so
`clean()` refuses one from config.

**Only the scene on air listens.** A layer on a scene nobody is watching can
show nothing and play nothing, so it answers to nothing - which is also the
simplest "off" there is: switch to a scene without the layer. "On air" is
`canvas.live`, the scene the Canvas (live) source shows (`scene.html?follow=1`,
components.py:174). The event carries the layer's id and the scene
(`server.py:1397`), and an effect layer answers only when both are its own
(`scene.js:911`) - whatever kinds it listens for, because the command is part
of its own setup. Every other effect layer ignores it, including one listening
for everything.

**Read on every command, not rebuilt on events.** `live_layer_commands()`
(`server.py:1377`) is asked on each command. A scene changes in more ways than
there are hooks - a switch, a save, an undo, a restore, an import over the
live one - and a hook missed is a command still answering for a layer that is
gone. It is cached on the live scene's id and revision, which every one of
those moves, so a chat message costs a lookup. A source that throws is caught
in the engine (`commands.py:271`): a scene the server cannot read must not take
the chat reader down with it, nor the list's commands.

**Conflicts are shown, not settled where nobody can see.** A name in the
Commands list answers first - the layers are asked only after it
(`commands.py:350`) - so a list command behaves as it did before the layer
existed. Two layers on one scene with one name: the first answers and the
second is marked `shadowed`. Both are said in the layer's note
(`inspectors.js:462`), which puts in words what the name does or why it will
not - not a usable name, the list has it, another layer took it, the layer is
hidden, the scene is not on air yet - and in the Commands panel, which now
lists the layers' commands read-only under "On the scene on air"
(`cmdpanel.js:269`), so everything the stream answers to can be seen in one
place.

**What T10 gives it for free.** `effect` is one of `EFFECTS`, so a layer's
command is counted by the budget, refused while paused and cleared by Stop
effects exactly as a list command is.

**The probe's one false failure.** `layercmd.js` first asserted that a layer
stayed dark when the Commands list answered its name, and failed. That layer
listens for every kind, so the list command's answer - a `command` card -
rightly lit it, as any command would. What must not happen is the layer's own
command firing, and that is what it checks now: no event addressed to it.

Not changed: the gif and sound actions in the list stay, so a streamer with
them set up keeps them. T7's voice and T8's gift layers join `LAYER_TYPES`
when they exist.

Checked by 15 new unit tests (323 to 338) and `tools/ui/layercmd.js`, 27 of 27:
a command named in the real Canvas Builder's inspector - typed, saved by the
editor's own debounce - and fired through a fake IRC server; the owner
answering past a kinds filter that would never let the event in; a layer
listening for everything staying dark (the control); the same layer id on a
scene off air, open in its own page, staying still; a rename moving the
command, and the old name ceasing to be one; the list winning a shared name,
with the conflict shown by the inspector, the server and the panel; and with
nothing on air, no command at all until the scene goes back.

Rerun on the changed code: `fxgif` 11, `fxsound` 13, `addpalette` 12, `onair`
40 - and `fxflood` 37 of 38. Its failure was "the button resumes as well":
after a moderator's `!hush`, a click on the Live view left the label reading
"Resume commands". It had passed on four runs before and passed on the three
that followed, so it is intermittent, and the run that failed recorded nothing
that could say why - the label alone cannot tell a click that sent the wrong
thing from a stale snapshot arriving after the right one. The feed itself has
no throttle (`HUB.broadcast()` sends at once, the pump within 0.4 s), and the
one staleness I can find by reading - the pump building a snapshot just before
a change and sending it just after - corrects itself at the pump's next tick,
well inside the probe's wait. So rather than a guessed fix, the probe now
records the Live view's side: every feed message's `paused`, every stop or
resume the button posts, and the label at the moment of the click - and it
checks that the Live view heard the moderator's stop *before* clicking, as a
check of its own. On the two passing runs the pause reached the Live view 4 ms
after the `!hush`, the click sent `resume`, and the feed said so 3 ms later. If
it fails again, it will say which half.

## Stop everything, and a limit over every command (2026-09-13)

T10, the abuse pass: three limits that sit over every command, whichever
service it came from. None of it needs TikTok.

**A budget over all of them.** Cooldowns are per command, so ten picture
commands with a ten-second wait each are still a picture a second between
them. `commands.py:62` names the actions that put something in front of the
audience with nobody checking it first - `gif` and `sound`, with T7's `speak`
to join them - and at most five of those get through in any thirty seconds
(`:68`), however many commands they come from. A place is claimed before the
effect runs and handed back if it fails (`:228`), so two services reading chat
at once cannot both slip in under the last slot. It is the last gate (`:294`):
a command refused for any other reason never spends it, and a held effect
starts none of its command's clocks. The log says `held`, not `cooling` - a
streamer who reads one for the other raises the wrong limit. Seconds of 0
turns it off, spelled that way rather than as a count of 0, which would read as
"no effects ever". Five in thirty because an effect layer holds each for five
seconds and keeps three waiting: the default costs a normal stream nothing and
stops a flood at the door rather than in the layer's queue.

**A pause, and a stop.** `stop_everything` (`server.py:1338`) does two things,
because either alone fails at the moment it is needed. Clearing without
pausing lasts until the next message of the flood; pausing without clearing
leaves playing the clip that made you reach for the button. The clear is an
alert of its own kind, `stop` (`alerts.py`, `KINDS`), which the scene page
hands to every layer's `takeDown()` whatever kinds that layer listens for, and
never to `alert()`, where a layer listening for everything would show a blank
card. The effect layer drops its picture, its clip and - the part that matters
most - its queue, or the next two events of the flood would walk straight on.
Polls keep counting: a vote is not an effect.

The pause refuses every command (`commands.py:276`) except those whose action
is `stop`, which is how a moderator's `!resume` gets through. It still passes
the role gate, so a viewer cannot resume what a mod stopped, and a stop command
made in the editor starts at `mod` rather than `everyone` (`cmdpanel.js:207`).
The pause is not saved: one that survived a restart would be commands silently
doing nothing at the start of the next stream, with no memory of why.

**Where the button is.** The plan said "on the deck". It is in the Live view's
header (`liveview.js:219`), first in the row, because the commands and polls
are run from there mid-stream and the deck's top bar is already full. No
click-again-to-confirm, unlike the Stop beside it: stopping effects harms
nothing and is wanted at once. Its label rides the state feed (`:126`), so a
moderator stopping from chat changes it in every window with nobody pressing
anything - which the rig checks, rather than assuming.

**The bug this shipped with, for one run.** T10's hook was first called
`stop()`, and `TYPES.mic` already had one, meaning "cancel my draw loop, close
my AudioContext, release the microphone". Pressing Stop effects would have
frozen a meter on stream until the page was reloaded. Thirty-six checks passed
straight over it, because the probe's scene had no microphone layer on it. It
was found by reading every `stop(entry)` in scene.js before writing this entry,
not by a test. The hook is `takeDown` now, and guarded twice: `fxflood.js`
carries a microphone layer that must be moving before the stop and after it -
run once against the unfixed name to see it go red (six distinct readings of
six before, one of six after: frozen), then green - and `tests/test_takedown.py`
pins that only the alert and effect types define `takeDown`, with a floor on
its own parse and the microphone's `stop()` kept as the control.

**The probe's other lesson.** Its first run failed six checks on a feature
that worked. Opening the Live view put the scene page in a background tab, and
a hidden tab runs no transitions and defers media, so opacity read the reverse
of the class and `play()` never resolved. The scene page is brought to the
front now, as the output window is on a real stream. No check was loosened.

**Asked for mid-step, and planned rather than built:** that text to speech,
gift animations and chat commands be set up on the canvas like everything else
there. Written into the plan as T11, ahead of T7 and T8, because it decides the
shape they are built into.

Not done: the text-to-speech controls (T7 ships its own, in the same step);
a hotkey for the button; saving the pause (above, on purpose).

Checked by 21 new unit tests (302 to 323) and `tools/ui/fxflood.js` on the rig,
38 of 38: twelve viewers flooding three commands (3 ran, 9 held, 3 effects
reached the stream), a stop from the button and one from a moderator in chat,
a viewer's resume denied and a moderator's let through, the queue shown to be
empty by what appears next, and the control - the same kind of flood with the
budget off, where every one runs. `fxgif` 11, `fxsound` 13, `t1shot` 11 and
`onair` 40 were rerun on the changed code and are green.

## The probes that were only ever run once (2026-09-13)

Five checks written during this run - `capcheck`, `t1shot`, `fxgif`,
`fxsound`, `addpalette` - moved out of a scratch folder into `tools/ui` and
registered in `uirun.sh` (`:56`, ports 9392-9396), which now knows 17. The
runner exists for exactly this: its own header records that an eighteen-step
plan went by without any of the probes running, because they had been driven
once from a scratch folder and never again.

Copying was the smallest part.

**`capcheck` named this repo.** Its fixture string held
`C:\Users\...\streaming stuff\music-deck\...`, and `tests/test_tools.py`
forbids that in anything under `tools/` - a tool that writes the path out
breaks the next time the folder moves and works on nobody else's machine. A
stand-in path fixed it and immediately broke the probe's own negative control,
which asked whether the leaked text was visible by looking for the username
that no longer appeared. It went red rather than passing quietly, which is
what a control is for. It now asserts against the fixture string itself
(`capcheck.js:109`), so it cannot drift again the next time the fixture moves.

**`fxsound` needed a flag the runner did not pass.**
`--autoplay-policy=no-user-gesture-required` is in the shared launch now
(`uirun.sh:89`), the same flag `overlay.py` gives the app's own windows -
without it `play()` is rejected and that probe reports a broken feature that
works. Confirmed in the runner rather than only under a hand-started Chrome:
"the play was accepted, not refused by autoplay policy ([])".

**`t1shot` exited 127 every time, after printing 11 of 11.** libuv's
`UV_HANDLE_CLOSING` assertion, from `process.exit()` racing a socket that is
still closing. `onstream.js` and `fxsound.js` have the same teardown and never
trip it, so the pattern is not wrong - this script is. It sets
`process.exitCode` and lets the loop drain instead (`t1shot.js:144`). The
reason to bother: a registered probe that always exits non-zero makes
`uirun.sh all` permanently red, and a suite that is always red stops being
read.

**`fxlayer` was not promoted.** It chose `assets[0]` and would have fallen
back to the rig's 4x4 token, failing its own pixel checks the moment anyone
ran it on a clean machine. Repairing it meant duplicating `fxgif`'s
picture-building machinery for a probe that overlapped it anyway, so its one
unique assertion moved instead: a second layer listening for a different kind,
which hears the same event and must stay dark (`fxgif.js:152`, `:189`). One
fewer probe to keep, nothing lost.

56 checks across the five, every one green through the runner: capcheck 9,
t1shot 11, fxgif 11, fxsound 13, addpalette 12.

## Alert and poll layers you can actually add (2026-09-13)

T9, and the smallest step in the plan: two entries in the Add palette
(`canvas.js:1017`, `:1020`) and two keys in `TYPE_NAME` (`inspectors.js:20`).
Both types have had a working runtime (`scene.js:791`, `:980`) and a full
inspector (`inspectors.js:195`, `:185`) since the day they shipped, and no way
at all to create one - the only route was the API, which is how the rig made
them, and why nobody noticed for two whole steps.

The defaults written into the palette are the values each layer's own code
falls back to - `seconds` 6 and `max` 5 for an alert, `bar` and `linger` for a
poll - so a layer added from the grid is the same as one the server would have
built. That is the failure this could have had: addable but inert, because a
prop was named something the runtime never reads. The probe checks the created
layers' props rather than trusting the entries.

**`ADD` is indexed by position in two places**, which is worth knowing before
inserting anything into it: `canvastools.js` pastes text using `ADD[0]`, and
`tools/p7/p7test.js` calls `Editor.add(0)`. Both mean index 0, so inserting
before the last entry leaves them alone - and the probe carries a control that
`ADD[0]` still yields a `reactive` layer afterwards.

Checking that turned up a real bug in the pasting. `ADD[0]` is the PNGtuber
entry, not the text one, so pasted text was built from `{idle, talking, blink,
bounce, fit}` - props `TYPES.text` never reads - and without the text entry's
own size. Honest about the size of it: `TYPES.text` falls back internally
(`p.size || 48`, `p.weight || 700`, `p.color || '#ffffff'`), so pasted text
looked reasonable; it drew at 48px where a palette-added one is 72, and it
carried five meaningless props into the saved scene for ever. It looks the
entry up by type now (`canvastools.js:966`), which also removes the positional
fragility that caused it.

**The `TYPE_NAME` half was polish, not a repair**, and the record should say
so. Its only consumer is the type tag in the inspector header,
`TYPE_NAME[l.type] || l.type` (`canvas.js:866`), so without the two keys the
tag read "alert" and "poll" in lowercase - never "undefined".

11 of 11 on the rig at first, on a scene created and deleted for it - and one
of those passes was hollow, which is worth keeping in the record even though
it has since been fixed. A check that the inspector "calls it something, not
undefined" used guessed selectors and came back with "Position and size", a
heading every layer type has: it would have passed with the `TYPE_NAME` edit
reverted, so it proved nothing at all. Promoting the probe was the moment to
deal with it rather than leave a check that prints PASS for ever without
earning it. It now reads the one place `TYPE_NAME` is used - the type tag in
the inspector header - and asserts the exact words (`addpalette.js:111`). 12
of 12, with the tag reading "Alert" and "Poll", so the claim is measured now
rather than argued from the picture.

## Sound the app will play (2026-09-13)

The rest of T3. A `sound` action beside `gif` (`commands.py:47`, the branch at
`:244`, the injection at `:124`), its own alert kind (`alerts.py:41`), a
handler that carries the clip in `detail` and answers with no text so one
command stays one alert (`server.py:1322`), and an effect layer that plays
what the event names (`scene.js:955`).

**Its own action rather than a second field on `gif`.** "Show this" and "play
this" are different things to a viewer, and a streamer setting up either
should not have to think about the other. The cost is one more `_do()` branch;
the benefit is that neither action has a half-used field on it.

**One audio element per layer, reused** (`scene.js:913`). A new event stops
whatever was playing rather than layering over it, which is the whole of "two
clips do not talk over each other" - the queue the layer already had does the
rest. `hush()` (`:930`) is called when the box hides and again in `destroy`,
because a layer somebody deletes mid-clip must not keep playing to the stream.
A layer with a sound and no picture is a legitimate thing to build: it shows
nothing and just plays.

An unset volume means 0.8, not silence. `Number(undefined)` is 0, and a
feature that is silent by default looks exactly like a feature that is broken.

**A batched edit left the code broken for a few minutes, which is worth
recording.** Three edits went out together; one was refused because its anchor
matched twice - the effect layer's `next()` opens with bytes identical to the
alert layer's, having been modelled on it - while the other two applied. That
left `this.sound(...)` being called with no such method: a TypeError on the
first event. The tool refusing to guess is what surfaced it. The anchor that
is unique turned out to be a single character: the effect layer caps its queue
at `|| 3` where the alert layer uses `|| 5`.

**The probe failed first, on a working feature.** It asked whether the element
was paused, two seconds after firing a clip half a second long - by which time
a perfectly successful play has finished and paused itself. That is the same
error as measuring any state whose meaning depends on when you look. It asks
two timing-independent questions now: did the play promise resolve (a
rejection is what blocked autoplay looks like, and the app swallows it on
purpose so the alert loop survives), and did `currentTime` advance. 13 of 13,
with `refused: []` and `0.5s, ended=true`.

Two things the probe had to solve rather than change the app to suit it. The
element is detached - `new Audio()` never enters the document, so
`querySelector` cannot find it - so a recorder is injected before the page
loads, wrapping `Audio.prototype.play`. And the clip has to really decode: an
ID3 header full of zeros uploads happily and then fails, so the probe builds
an actual WAV, header and PCM samples, which any browser will play. Chrome is
started with `--autoplay-policy=no-user-gesture-required`, the same flag
`overlay.py:32` gives the app's own windows; without it the probe would report
a broken feature that works.

Four unit tests, 298 to 302, including a control that `gif` and `sound` do not
answer for each other - both take an asset id in `target`, so a branch written
into the wrong one would look right in every other test.

## Sound the app will keep (2026-09-13)

T3's blocker, cleared. The step wants a clip a command can play; there was no
clip to point at, because `assets.py` accepted pictures and video only. Four
extensions now join it - mp3, ogg, wav, m4a (`assets.py:31`) - with a cap of
their own at 24 MB (`:37`). Neither existing cap fits: a minute of wav is
about 10 MB, so the picture cap would refuse ordinary clips, while the video
cap would let somebody park an album in the folder. `kind_of` answers "audio"
(`:65`), which matters because `renderAssetGrid` filters on `kind` - an
unlisted kind is a file the picker will not offer, which is exactly how every
animated GIF became invisible earlier today.

**Two different gates, and worth being precise about.** An upload is checked
by extension and size only; `save_bytes` never looks inside the file, and that
was already true of pictures. An *import* is checked byte by byte, because the
.zip came from somebody else - so `sceneio.MAGIC` gained a validator per type
(`sceneio.py:61`) and the id and file patterns gained the extensions (`:40`),
without which a shared scene would arrive with its clips silently dropped.

**The serving route was quietly wrong for anything new.** It took its type
from `mimetypes.guess_type` with `image/png` as the fallback, and sets
`X-Content-Type-Options: nosniff`. On Windows mimetypes reads the registry, so
a machine without an `.ogg` association would serve a clip as a picture that
the browser then refuses to sniff - a 200 that never plays, with nothing said
anywhere. `OK_EXT` was already the authoritative map and the route ignored it;
it asks the store first now (`server.py:2226`). It resolves correctly on this
machine, which is the point: this ships as an .exe to other people's.

**Three places would have drawn a broken picture, and one was expensive.**
Both asset grids render `<img src=thumb||url>` for anything that is not
video-without-thumb, so a clip drew the broken-image icon; they show a mark
instead (`inspectors.js:576`, `canvas.js:1117`). The costly one is
`deck.js:1684`: every asset is measured through `new Image()` when the deck
loads, and an `<img>` pointed at a clip fetches the whole file - up to 24 MB -
to fail at decoding it, with no `onerror` to notice. Video was already paying
that.

Two deck lists offered every asset there is: the picture themes, which are
read out of an asset's colors, and the sticker picker, which draws an `<img>`
on the overlay. Both are filtered to picture kinds now (`deck.js:700`,
`:1638`). That also removes video from them - which was already broken there
rather than newly so, and is worth saying plainly rather than letting an audio
change look like it did more than it did.

`tests/test_assets.py` is new, because the store had no tests at all: twelve,
including a control that the audio branch of `kind_of` did not swallow the
other kinds, the size class sitting between the other two, and every magic
validator against an impostor wearing the wrong extension and against a
truncated file that must read as "not that type" rather than throwing. On the
rig, 8 of 8 on the wire: a clip uploads, lists as sound, and comes back as
audio/mpeg with nosniff intact, beside a picture that is still image/png.

What this does **not** do is play anything. The clip can be kept, served,
imported and chosen; the `sound` action and the playing of it are the rest of
T3.

## A command that puts a picture on the canvas (2026-09-13)

T2 of `docs/INTERACTIVITY_PLAN.md`, and only a third of it. The step promised
`gif`, `sound` and `speak`; the panel's action list is built straight from
`commands.ACTIONS`, so shipping the other two would put options in front of
somebody that quietly do nothing. Sound has no asset class yet and speech has
no bridge, so `gif` went in alone (`commands.py:47`, the branch at `:230`, the
injection at `:122`).

**The picture belongs to the command, not the layer.** It rides in the alert's
`detail` (`server.py:1299`), which is why one effect layer can serve every gif
command instead of needing one layer each - and a command with no picture is
not a failure, because the layer falls back to whatever it was given.
`scene.js:922` prefers `ev.detail.asset` and keeps `props.src` as the
fallback.

**A kind of its own, and that is not cosmetic.** `alerts.event()` turns an
unknown kind into "note", so posting "gif" without listing it in `KINDS`
(`alerts.py:41`) would fail *silently*: the alert still arrives and the layer
waiting for it never fires. Riding "command" instead would have meant every
!command with a response also firing the picture layers.

**One command, one alert.** `_record` keeps whatever the handler returns as
the command's response (`commands.py:249`), and `after_command` posts a second
alert for any command that has one - so a chatty `command_gif` would put a
picture on screen *and* an alert card beside it, off one command. It returns
no text for that reason. That claim cannot be unit-tested here: injecting a
double that returns "" and asserting it returned "" tests the double. It is
pinned on the rig instead, where both halves exist - fire `!pic`, count the
alerts, and there is exactly one, of kind "gif", carrying the asset in
`detail`.

Two smaller things, both the sort that fail quietly. `cmdpanel.js` asked the
same question in two places - which field an action keeps its argument in -
and a third answer was about to be added; it is one `fieldOf()` now
(`:45`), because when `row()` and `readRows()` disagree a command saves its
picture into a field nothing reads and the setting simply does not stick. And
the effect layer decides its element type per source (`scene.js:883`) rather
than once when the layer is made: a gif command can name an `.mp4`, and a clip
arriving by event would otherwise land in an `<img>` and draw nothing.

The rig said 10 of 10, on a layer deliberately given no picture of its own, so
what appeared could only have come from the command. Four unit tests, 282 to
286. One of them failed first, and usefully: it asserted the outcome "refused",
which is the name of the engine's *counter* - the outcome is "denied". Reading
the real words out of `commands.py` also showed the test only covered the role
half of what its own docstring claimed mattered, so the cooldown is pinned now
as well. For a picture command that is the half that matters: without it, one
viewer can make a stream unwatchable.

## A layer that shows something when something happens (2026-09-13)

The display half of T3 and T8 in `docs/INTERACTIVITY_PLAN.md`: `TYPES.effect`
(`scene.js:866`), a layer that shows a picture or a clip when an event
arrives and hides again after its seconds.

It needed no new transport. `Stage.alert()` hands each event to every layer
whose type declares an `alert()` hook, and `needsAlerts()` opens the socket
only when such a layer is visible - so declaring the hook (`scene.js:895`) was
the whole of it. The queue rule is copied from the alert layer deliberately:
keep the newest few, drop the rest. That matters more for pictures than for
text, because a burst turning into a minute of backlog would leave the stream
showing something that finished long ago.

It ships with its palette entry (`canvas.js:1009`), its `TYPE_NAME`
(`inspectors.js:20`) and its inspector (`:207`) in the same change, because
the alert layer is the cautionary tale: it has a full inspector and no way to
create it, so S15's layer can only be made through the API.

**No sound, and that is a finding rather than a gap.** `assets.py`'s `OK_EXT`
holds pictures and video only, so there is no `.mp3` to point at. Audio needs
an extension, a magic-byte check and a size class of its own, plus the
matching half in `sceneio.py`'s import - the validation hardened earlier
today. `--autoplay-policy=no-user-gesture-required` is already set
(`overlay.py:32`), so the browser side is ready and the asset side is not.

**Every picture picker in the app was hiding animated GIFs.** `kind_of`
(`assets.py:52`) returns "gif" for a multi-frame image, "image" for a still
one and "video" for a clip, and `renderAssetGrid` filters
`kinds.includes(a.kind)` (`inspectors.js:576`). Every call site asked for
"image video" or "image", so a real GIF matched none of them. Found by
looking rather than reading: the rig holds one asset and its kind is "gif", so
the image layer's picker on this machine was empty while an asset existed.
Fixed at all five sites (`inspectors.js:210, 250, 351, 352, 353`). The app
plainly expects animated pictures in layers - `stillOf()` exists to freeze
them for ultra mode - so this was an oversight, not a policy.

**The probe passed 8 of 8 and photographed an empty stage.** It measured the
classes and the computed opacity and never asked whether a pixel had been
drawn, which is S7's microphone layer exactly - the one `onstream.js`'s header
records as passing "24 bars above the floor" while every bar had flexed to
zero width. Two things were wrong at once: the assertions, and the asset. The
rig's only picture was a 4x4 token, which `object-fit: contain` blows up into
four flat pixels that are indistinguishable from a dark background, so a layer
working perfectly looked like a layer doing nothing. It now asks for
`naturalWidth` (did it decode) and `getBoundingClientRect` (was it laid out
with real size), points at a 240x240 fixture made for the purpose, and shoots
at 1920x1080 rather than photographing a thumbnail of the scene. 11 of 11, and
the picture shows a magenta square where the listening layer is and nothing
where the control layer is.

## The symbol that starts a command (2026-09-13)

T1 of `docs/INTERACTIVITY_PLAN.md`. The ask was to let the streamer choose
what starts a command - `!`, `/`, `@`, whatever suits - and the work turned
out to be small in the parser and much larger everywhere the symbol is shown.

**One parser, and that was worth establishing before touching anything.**
`chat.py`'s `message()` fills `command` and `args` centrally, "so !queue means
the same thing whichever service it arrived from", and `polls.py`'s own header
says outright that a vote of "!1" is read as the command "1" and that it keeps
no parser of its own. A grep for anything reading a leading `!` found exactly
two places in the app: that line, and `commands.py:76` normalising a saved
name. So one setting carries commands, song requests and poll votes together,
and no adapter had to learn anything.

**Five places said `!` out loud, though**, and a setting that changes parsing
without changing them would look broken while working perfectly: the command
editor's row legend and its fired-log, the poll panel's "vote by typing !1",
and - the two that matter most, because they go on stream - the alert titles
at `server.py` for a queued song and for any command that ran. All of them
build the label from the symbol in force now. One was left alone deliberately:
`scene.js`'s alert *sample*, which is an illustration in the builder rather
than a label on anything real.

**A letter or a digit is refused**, and that is the whole reason `set_symbols`
validates rather than just storing a string. With `a` in force, "apple" runs
the command "pple" and half of ordinary chat becomes commands. Whitespace goes
the same way, duplicates are dropped, and nothing usable left falls back to
`!` rather than to nothing - a chat where no command can ever fire looks like
a broken app, and the setting that did it would be invisible. What the setter
keeps is what it returns, and the caller saves *that*, so config cannot end up
holding a symbol the app is not honoring.

**Module state, where `songreq.py` and `captions.py` would take a
`configure()` on an object.** Threading the symbol to each adapter instead
would make a per-service symbol expressible, which is precisely the property
`message()` exists to prevent. One setting, one place. `message()` takes an
optional `symbols=` so tests can ask a parsing question without reaching into
module state and changing what every later test in the run parses.

`commands.py` no longer strips `"!"` from a saved name but the whole class of
leading punctuation. `NAME_RE` wants a letter, digit or underscore first, so
anything before that was somebody typing the symbol out of habit - and the
change means every command saved under the old symbol survives the switch
untouched, because the stored name never carried a symbol at all.

Checked twice over. Eleven unit tests took the suite from 271 to 282: a table
of awkward shapes pinned to their old answers (symbol alone, symbol-space, a
doubled symbol reading as a name `NAME_RE` then refuses, a symbol inside a
word), several symbols live at once, and the control that matters - with `/`
in force, `!queue` has to become ordinary text. Then nine checks on the rig
for the wiring the unit tests cannot see, one of them a risk that had only
been read and not exercised: `_merge_into` is a deep merge, so writing the
symbol through `/api/config` does not wipe `commands.list`. Had it been
shallow, changing your command symbol would have deleted every command you
had.

## A scene that could call home (2026-09-13)

Scenes can be shared - `/api/scenes/import` takes a .zip somebody else made,
and `server.py:2228` says so in as many words: "A picture can come from someone
else's scene now (an import)." The zip itself is well guarded: size caps, a
member cap, password-protected files refused, names checked, `scene.json`
required, and every asset re-stored locally after its magic bytes are read.

What is not guarded is `props`. `scenes.py`'s `_layer()` coerces the transform
and the style - `_num()` with ranges, enum whitelists, length caps - and then
line 124 does `layer["props"] = dict(layer.get("props") or {})` and hands them
through as they came. And `scene.js`'s `assetUrl` read

    /^(\/|https?:|data:|blob:)/.test(src) ? src : '/asset/' + encodeURIComponent(src)

so a layer whose `src` was `https://somewhere/beacon.png` was fetched from
wherever it pointed, on this machine, while the scene was on stream. That is an
IP address and the timing of a stream handed to whoever wrote the scene, and a
picture they can change whenever they like, on somebody else's stream.

Measured rather than argued. A scene holding one image layer pointed at
`https://example.invalid/beacon.png` - a TLD that cannot resolve, so the test
could not contact anybody even if it failed - imported into the rig and came
back with the URL stored verbatim. The import reported `assets: 0, skipped: [],
missing: [], builtin_missing: []`: a clean bill of health. It is clean because
`used_assets()` only collects strings whose last segment matches `ASSET_ID`,
`^[0-9a-f]{16}\.(png|jpe?g|...)$`, and "beacon.png" is not one - so the URL is
never remapped, never stored, and never reported.

Fixed in `assetUrl`, which is where a string becomes a request, and not at the
import: an import is one way in and the API is another. Anything carrying a
scheme is refused, `builtin:` excepted (assets.py:156 - this app's own name for
shipped artwork). A leading `/` is not enough on its own, because `//host/x` is
remote too; that one would have shipped if the rule had been written from
memory instead of tested. Nothing legitimate is lost: the picker uploads a file
and keeps the id it gets back (`canvas.js:1123`, `canvastools.js:928`), no
layer type has a `url` or `link` prop, and `data:`/`blob:` only ever appear on
the *upload* side. A refused src renders as empty, which is the state a layer
with no picture chosen is already in.

The neighbouring line went too: `url("${src}")`, now at scene.js:224, took a
quote straight into CSS, so a src holding one could close the `url()` and
write declarations of its own. It is `JSON.stringify`d now.

Checked on the rig at the wire, not in the DOM, because the claim is about a
request that must not happen: Network enabled on a blank target *before*
navigating, since a page opened straight at the URL has already made its early
requests. 7 of 7 - the layer was built, nothing was requested from the host the
scene named, the layer did not adopt the URL, and the control fired, the same
listener catching `https://example.invalid/control.png` when the page was told
to ask for it deliberately.

Two things left undone on purpose. The import still calls such a scene clean,
which is a lie of omission worth fixing where the report is written rather than
here; `tools/ui/scenebeacon.js` records it as a standing check so it cannot be
forgotten. That probe is committed and registered in `uirun.sh` at port 9391
rather than left in a scratch folder, which is the habit `uirun.sh` exists to
end. And
`props` are still unvalidated server-side - `validate()` keeps unknown fields
deliberately, "so a newer editor's data survives an older server", and
narrowing that is a bigger change than this finding justifies.

## The overlay that would have read out a file path (2026-09-13)

`captions.js` had a second fault, one branch below the one in the section
below. That one carried an instruction; this one carried `c.error` - whatever
the engine threw - and drew it on the overlay.

What that can be was produced rather than guessed. Handed a model folder with
no weights in it, faster-whisper says "Unable to open file 'model.bin' in
model 'C:\Users\<name>\...\models\small.en'", and `captions_whisper.py:440`
sends it on as "Whisper could not load: ..." - 130 characters against this
machine's own store, 63 of them the absolute path to it. It reaches the
window through `captions.py:234`, which keeps the engine's message as
`_error`, and `:292`, which ships it in the snapshot the state feed
broadcasts to every open page. The tamer thing the same branch
carries is `captions.py:130`, fixed text and no better in front of an
audience: "press Download on the Captions tab" is an instruction to whoever is
holding a deck the audience has not got.

Fixed at the overlay, and where is the whole decision. The deck draws the same
`c.error` in full at `deck.js:3214`. That surface is private, and it is the
one place the path is the useful part, because it is how somebody fixes their
own setup. Capping the text where it is made - the `str(exc)[:80]` that
`spotify_api.py` uses ten times and `songreq.py` twice - would blind the deck
and still leak, since the path starts well inside the first 160 characters.
`captions_whisper.py` does have `_gpu_reason()`, which caps at 160, but it is
for graphics-card failures and strips no paths. The rule is about the
audience, not the string: private surfaces may say anything, on-stream
surfaces may not.

Two claims were dropped rather than written up. The PowerShell spawn at
`captions.py:163` puts `SCRIPT`, an absolute path, in its argv, and `:190`
wraps a failure as "Could not start PowerShell: {exc}" - which looked like a
second route until it was run. It produces "[WinError 2] The system cannot
find the file specified", with no path in it at all, and a bogus `-File`
raises nothing, because the script's own errors go to `DEVNULL`. The other
dropped claim was the first plan for the fix - cap it at the source - which
the paragraph above overturned.

Checked on the rig, 9 of 9, on the plain page and never `?preview=1`: under
preview `demoTick()` keeps the stage 'on', so the branch never runs there,
which is the same trap the other one set. The probe carries its own control -
it is shown finding the path when that text is written into the very node the
fix stopped writing to, and finding nothing once it is put back.

`tests/test_onstream.py` holds the line, and takes its scope from
`components.py` instead of a list kept in the test, so a seventh overlay is
policed the day it is added - today 7 components, 6 pages, 16 modules, 4,997
lines. `scene.js` is the one allowed exception, its error banner being a
weighed decision ("a black window that looks fine from the outside is the
worst way to find out"), and it doubles as the positive control: it has to
keep matching, or the rule has broken rather than the code having got
cleaner. That control earned itself immediately - the rule's first version
looked only for `.error`, matched nothing in any on-stream module, and would
have passed forever.

## Looking at the four screens, at the sizes they actually open (2026-09-13)

A whole session of reading code and none of looking at it. So: headless shots
of the deck, the Canvas Builder, the Live view and the remote, reviewed as a
user would see them.

The first set was worthless, and worth saying why. I shot all four at
1500x1000, and `launch_deck` opens them at 1180x820, 1440x900, 1280x880 and
340x640. The remote is a 340 px strip - at 1500 it is not a narrow layout, it
is a narrow layout stranded in dead space. Worse, `canvas.css` has
`@media (max-width: 1440px)`, and the builder opens at exactly 1440: shot at
1500 it sits on the wrong side of its own breakpoint, showing a layout nobody
gets. Review these at their launch sizes or not at all.

Then the surfaces that actually go on stream, at their configured sizes:
nowplaying 880x230, lyrics 560x320, queue 420x320, captions 900x200, camframe
480x480, and a composed scene at 1920x1080. One thing there is worth more than
the shots. `?preview=1` does not show what goes on stream: `lyrics.js:29` keeps
sample lines, `:268` substitutes a demo track "Neon Highway - The Static
Waves", and `captions.js:242` runs a demo tick. Shot in preview, the lyrics
overlay reads "Headlights on the wet road" while the server holds the real
synced words from lrclib. I chose preview to dodge `windowctl`'s 4 s first-open
hint, which `shotpage`'s 3500 ms wait would have photographed, and traded a
cosmetic artefact for a fabricated one. Shoot these plain, and wait past 4 s.

One thing found, and fixed. `captions.js:114` set "Captions are off - press
Start in the deck" as its whole off-state status. `queue.js` says something
similar and has weighed it in writing - "the real reason is worth the two extra
words on stream" - but that is a reason, and this was an instruction.

Reading it made the fault sharper than "preview text reaching the stream". The
branch only ever renders on stream: under PREVIEW, `demoTick()` calls
`render({ on: true })` from the first tick and every 2.2 s after, so the stage
is never 'off' there and the line is never reached. It could only ever be read
by an audience with no deck to press Start in.

The status now says "Captions are off" and nothing else. A first attempt gated
the sentence on PREVIEW, which was worse - a branch that cannot execute, under
a comment claiming the hint "stays in the preview" where it had never been.
Checked on the rig both ways: on stream 'off' with the instruction gone from
the document, in preview 'on' with the status hidden throughout.

Nothing else was wrong. Every candidate dissolved on inspection: the CANVAS card
clipped at the deck's right edge is `overflow-x: auto` at `deck.css:988`, a
scroller doing its job; the remote's sliced card is the same with a fixed
footer; the wall of "Loop 53 / Shape 52" layers is the rig's P5 stress scene,
not a naming problem; and "step 3 is below the fold" was simply false - body is
`overflow: hidden` at `deck.css:48` with the scrolling in `.col` and `.rail`,
and step 3's heading measures at y=773 in an 820 viewport. What is good is
worth naming too: the Live view's empty state says the output window is not
open and offers the button that opens it, and the inspector's says which
settings it is showing and how to change them.

## The token that already got out, and the road it took (2026-09-13)

**A credential has already left this repository once, so the question worth
answering is not whether the code looks careful but whether the same road is
still open.** Revoking the token in 62e2105 is the user's to do at Spotify's
end - it is in git history for good. Shutting the road is this.

The road was not the one I expected. That commit added no config file and no
token file: it added `dist/Music Deck.exe` and nine `__pycache__/*.pyc`, one
of them `spotify_api.cpython-313.pyc`. The credential rode out inside a build
artifact. Every pattern that would have stopped it is in `.gitignore` now -
`dist/` at 27, `dist-staging/` at 28, `__pycache__/` at 33, `*.pyc` at 34 -
alongside `cache/`, `config.json`, `*.token.json`, `spotify_token.json`,
`.env`, `*.pem`, `*.key`, `.rig/` and `.build-env/`. Nothing binary is tracked
today, and `.gitignore` is itself tracked, so the guards travel with the repo
rather than living on one machine.

The cargo does not escape either, on any path checked. `CONFIG` is served raw
by `GET /api/config`, which is fine because it holds no secret: the whole
`spotify` block is `client_id` - public by design under PKCE - and
`use_account`. `_post_token` reads a response body only on success; its
`HTTPError` branch never calls `exc.read()`, and on a 400 or 401 it clears the
token, deletes the file and sets one fixed sentence. The five Spotify keys on
the state broadcast carry derived values only, and `client_id_set` is a
boolean on purpose: it says whether an id is set, never what it is.

Measured as well as read, because reading shows intent and only the bytes show
what is there: 41 leaf fields across the spotify, now and local keys of a live
payload, one credential-shaped *name* - that boolean - and no long opaque
string anywhere. The scan printed names, lengths and counts, never values.

`tests/test_secrets.py` keeps both halves, and the second could not follow the
house pattern. `alerts.py`, `commands.py`, `polls.py` and `songreq.py` each
carry a `test_the_module_holds_no_credential` that greps their own source for
`access_token`. `spotify_api.py` is the OAuth client; that string is in it
because that is its job, and weakening the test until it passed would be worse
than not having one. For a module that is supposed to hold a secret the
question is whether the secret can get out, so this seeds a fake token and
looks for it in everything the module hands to anyone else.

Both halves were checked by breaking them. Removing `dist/` from `.gitignore`
fails naming the pattern and the reason it is there; making `peek_queue()`
return the token fails naming `peek_queue()` and `queue()` - two surfaces,
because one delegates to the other. Both files were restored byte for byte.

That second run found a fault in the test itself. `assertNotIn` prints the
needle and the haystack, so the day it caught a real token it would paste that
token into the terminal and into any log the run was kept in - a test against
exposure being the thing that exposes. It collects the names of the offending
surfaces now and asserts on that list; the value is never quoted.

What it does not cover is written into it: git history, which no test can
change, and whatever a build tool decides to bundle. It guards the road and
the cargo, not the whole journey. 266 tests pass, one skipped.

## Every endpoint the pages and tools call (2026-09-13)

**The pages and the tools both reach the app over HTTP, and nothing had ever
checked that the paths they name lead anywhere.** `test_tools.py` checks how
tools find each other; `test_harness_urls.py` checks how they encode a URL.
Neither asks whether the URL is served. The pages matter more than the tools
here: a tool that breaks wastes a debugging session, a page that breaks is the
app.

The question came out of reading `framenative.py` line by line before handing
it back: it was written against S5's server and S9 to S18 moved a great deal of
that. It was fine, but reading one tool by hand does not scale to forty, and a
tool that calls a renamed route fails only when somebody runs it - usually
mid-debugging, which is the worst moment to find the instrument broken.

The answer is that nothing is broken: of 185 distinct paths - 113 under `web/`
and 72 under `tools/` - every one is served, by one of 101 literal routes, one
of four regex routers, or the `/api/spotify/` prefix. That is now
`tests/test_endpoints.py`, and the suite is 266.

The path check itself failed three times first, and each is the reason it is
worth keeping. It passed everything on its first run: `server.py` has
`if not path.startswith("/api/")` as a guard against static files, the scan
collected that as a route prefix, and every path in the world matched it - a
green that could not go red. Then it could not read fourteen paths: an
f-string like `f"/api/scenes/{ALL[0]['id']}"` carries quotes inside its braces
and the extractor stopped at the first one, so interpolations are collapsed
before paths are pulled out rather than after. Then, pointed at `web/`, it
reported seven faults that were not faults: the tools write their paths whole,
the pages build them. `windowctl.js` is handed `/api/window` and appends
`/close` itself; `reqpanel.js` posts to `/api/requests/${which}`.

Hence two weaker rules - a path some route continues (a base), and a path
whose interpolated segment stands for a real one (a wildcard) - and hence
`test_the_scan_can_actually_fail` carrying one control per rule: a bogus path,
a bogus base and a bogus wildcard must all still come back unserved.

Checked by adding a bogus endpoint to a shipped page rather than a tool, and
watching it name the page and the line, then restoring it byte for byte.

Then the method, which the first version left out and said so. A wrong verb is
not a loud failure: both handlers end in `self._send(404, "not found")`, at
2344 for GET and 2857 for POST, so a GET at a POST route looks exactly like a
route that is not there. Splitting the routes by the handler they live in
gives 39 GET-only, 58 POST-only and four served by both, and every call site
is classified by the verb it actually uses - `fetch` without options, a
`post(...)` helper, `sendBeacon`, `new EventSource`, `urlopen`. Of 651 calls
classified, none uses the wrong one.

That check reported a fault too, and it was mine again: `canvas.js` calls
fetch('/api/components/' + id + '/open'), and stripping the trailing slash off
that base leaves `/api/components`, which really is GET-only. A literal ending
in "/" is a base, and is counted apart from the paths now. Checked the same
way, by putting `fetch("/api/live/start")` - a GET at a POST route - into a
page and watching it name the line.

What it does not see is written into it: under the two weaker rules, a renamed
sibling. If `/api/requests/approve` became `/api/requests/allow`,
`reqpanel.js` would still match through `/api/requests/recent`. And the
classifier knows only the verbs in use today; a new helper name would leave
its calls unclassified rather than wrong, which is why the floor counts
classified calls and not just paths. Nothing builds a path from a variable
today: the `BASE + path` in the runners and the `fetch(url, ...)` helpers in
the panels both receive a literal from their call site.

## A counter nobody reads, sending the whole state five times over (2026-09-13)

**The state feed sends only when something a window shows has changed - and a
counter that climbs on its own quietly turns that off.** `_change_key` is the
whole snapshot minus the few things that move by themselves, and `chat.py`'s
snapshot carried `total`, a count of every message ever received, which ticks
on every line of chat.

Measured on the rig rather than argued, in three timed windows:

| phase | sends in 10 s | rate |
|---|---|---|
| idle, no chat | 5 | one per 2.00 s |
| connected, a message every 250 ms | 25 | one per 0.41 s |
| connected, joined but silent | 5 | one per 2.00 s |

Five times the traffic, and the third row is what makes it an answer rather
than a coincidence: connected-but-quiet returns to the heartbeat, so it is the
messages and not the connection. Every one of them made the server serialize
the entire state - components, scenes, captions, fonts, all of it - and push it
to every open window, for a number no page draws. It is the flood the gate was
built to stop: "Sending the whole state 2.5 times a second regardless had every
window parsing and re-checking it for nothing."

`alerts.total`, `alerts.dropped`, `commands.ran` and `commands.refused` are the
same shape. `requests.queued` and `requests.refused` are too, though that path
already calls `HUB.broadcast()` outright at server.py:1285, so they cost nothing
today - they are dropped with the rest so that a later tidy-up of that explicit
call cannot bring the fault back.

The fix follows a precedent already inside the function: `captions.level` and
`spotify_queue.age` are stripped from the key and still sent. These are now
too, so the numbers stay on `/api/state` for anyone debugging and simply stop
being a reason to send. After: one per 2.04 s while busy against 2.00 s idle,
5.0x down to 1.0x, with the same 39 messages going through.

Why nothing caught it: no test touches `_change_key`, and none cheaply can -
importing `server.py` runs `load_config()` and builds a SceneStore over the
user's real data directory. It is a rate rather than a value, so it belongs on
the rig: `tools/ui/keyleak.js`, registered in `uirun.sh`, 7 of 7, no browser
needed. It counts `HUB.sends` from `/api/debug/mem` across the three windows
above, and before them it samples `/api/state` every two seconds with the app
sitting still and insists nothing moved. That wider check is the point: fixing
`chat.total` fixed chat, and would have done nothing about the next counter
added to any of the other thirty-four fields.

Two details in it were worth getting right. It takes out exactly what
`_change_key` takes out - the clock, the three playing positions, the caption
meter, the queue's age - by field rather than by object: dropping all of
`spotify` or all of `captions` would leave a sixth of the payload unguarded,
which is where the next counter would land. And it samples rather than
comparing two reads, because a field that goes A to B and back between them
looks like it never moved. Measured by hand first at two seconds for thirty:
across all 34 remaining fields, nothing moves at rest.

What it does not cover, said plainly: Spotify's poller only runs while the
queue window is open (`spotify_api.py:82`), and opening it would put real calls
on the user's account, so drift under Spotify polling is untested.

Four other fields were suspected and cleared, which is worth writing down so
the next reader does not repeat the search. `live.snapshot_status()` carries
only state, error, has_key, url, preset and reconnects - its own docstring
promises "nothing that changes every second", and it keeps the promise.
`VOICE.tick()` runs on every pump cycle but calls `on_change` only when
`speaking` actually flips. `_lyrics_info` is recomputed but cached against the
track key. And `windows[*].rect` does move whenever a window is dragged or
resized - but the deck reads `rect.w` and `rect.h` to keep its size fields
live (`deck.js:2650`, `deck.js:2900`), so that one is a broadcast something
actually wants.

Two of the seven exist only so the other five cannot pass for the wrong
reason: one asserts the adapter really counted the messages (39 of 39), and
the drift check refuses to pass on fewer than 25 fields, so a failed fetch
reads as a failure rather than as "nothing moved". A probe that green-lights
an empty run is this repo's most repeated failure.

The three snapshot docstrings say so now as well. `chat.py`'s read "what changes
rarely", which `total` had never done; the next counter added there will find
the rule written beside it.

## Forty-three controls that said the wrong thing, and a scan wrong twice (2026-09-13)

**`title` is the last step of the accessible-name algorithm, not a fallback that
always fires.** Text content outranks it. So a button with a glyph in it never
reaches its title at all: the glyph wins and the title is thrown away.

Twelve window buttons - the identical `minBtn`/`closeBtn` pair on captions,
frame, lyrics, nowplaying, queue and scene - held `&minus;` and `&times;` over
titles reading "Hide - find it on the taskbar" and "Close (also Alt+F4)", and
spoke as "minus" and "times". Seventeen reset dots on the deck held `&#8635;`
over "Reset to theme". That is worse than having no name, because every check
that asks whether a label is *present* passes them. `windowctl.js` only binds
the clicks at 99-101, so the markup was the only source of a name.

Forty-three in all: seven transport buttons and five form controls on the deck,
the twelve window buttons, the seventeen reset dots, and two buttons `deck.js`
builds - the delete on an asset cell (1834) and the remove on a watched folder
(2048). Eleven other generated sites already carried `aria-label` over their
glyph, so those two were outliers against a settled house pattern rather than a
judgement call. Both now take the item's own name.

Nothing in the suite could have caught it. `tools/ui/inkcenter.js:131` records a
mark's label as `aria-label || title` - the one probe that measures these very
buttons treats the two as the same thing, which is the exact confusion at fault.

**The scan written to find them was wrong twice, in opposite directions, and
that is the part worth keeping.** It first reported 153 faults on `deck.html`:
it had no `<label>` support, so every color input wrapped in its own label
looked nameless, and its flat element list let text bleed from closed nodes into
later ones. Rebuilt as a real tree, it then reported 0 - because it skipped
anything with a `hidden` ancestor. But `hidden` on a container is just a panel
waiting its turn, and the controls inside are reached the moment a script shows
it. Only `hidden` on the control itself means inert. A page with 351 controls
reporting zero faults deserved the same suspicion as one reporting 153.

Three things it flagged are correct as they stand: four file inputs on
`canvas.html` are `hidden` and fired by styled buttons, so a name on them would
be dead weight; `chatpanel`'s `cp-new` is empty in the template and named by
`paintNew()` at 109 on the same path that unhides it; and the swatch buttons
whose title genuinely is the name (a color value, "Theme from X").

It ships as `tests/test_accnames.py` rather than staying a scratch script,
because the reason these rotted through the whole build is that nothing enforced
them. Three rules: no control may be nameless or named by a glyph; a
glyph-bodied button written by a script carries an `aria-label`; and the scan
must still be examining at least 350 controls, so it cannot go green by seeing
nothing. Checked by putting both defects back and watching it fail on each, then
restoring - a regression test that has not been seen to fail is not one yet.

266 Python tests pass, one skipped. `ctlgate` stays 11 of 11, so the window
buttons still drag, resize, hint and close with the labels on them.

One more shape was checked and left alone. Twenty-one bare `<span>` elements sit
immediately before a form control on the deck, which looks like this same defect
and is not: each sits inside a wrapping `<label>`, so the span's own text is the
control's name. Measured rather than eyeballed - of 155 form controls on
`deck.html`, 140 are named by a wrapping label, 13 by an `aria-label`, two by a
title, and none are nameless. The two on titles are `savedThemes`, announcing
"Apply one of your saved looks" beside a visible "Looks" - the visible word is
contained in the name, so a speech-input user saying it still matches - and
`spDevice`, "Where Spotify is playing", which has no visible label to disagree
with. Nothing in `tests/` or `tools/` touches either, and both stay.

A spelling sweep rode along, against the project's US-spelling rule, and it
took four passes because each pattern only ever found what it was shaped like.
`colour`, `behaviour` and `centre` first, in comments across `icons.js`,
`livepanel.js`, `liveview.css`, `liveview.js`, `reqpanel.js`, `chat.py`,
`canvastools.js`, `scene.js`, `canvas.css`, `canvas.js`, `deck.css`,
`spotify_api.py` and both docs. Then `grey`, `labelled` and `travelling`, which
none of those patterns could match. Then `centring`, which does not contain
`centre` and had therefore survived every pass so far. Then `tools/`, a whole
directory the earlier passes were never pointed at: six more in
`pickertest.js`, `p8test.js`, `chatui.js`, `onstream.js` and `voicetrig.js`.
`analyser` stays - it names WebAudio's own `AnalyserNode` - as do
`aria-labelledby` and the `_cancelled` identifiers. The substitutions had to
run in order, `centred` before `centre`, or the first would have left "centerd"
behind. One of them was user-facing rather than a comment:
`announce('Cancelled')` in `canvastools.js`, which a screen reader says out
loud.

## S18 - the build's exit code, and a list that named six of forty-eight (2026-09-13)

**The entry's own warning was half right, and the half it got wrong explains
the whole thing.** It said `rebuild.ps1` "already exits 0" and might be stale.
It does - on two of its three paths. `-CheckOnly` exits 0 at line 78 and
`-NoLaunch` at line 134; the full run fell off the end at 146 with no `exit` at
all, and `robocopy` sets `$LASTEXITCODE` to 1 for an ordinary copy that copied
something. Since robocopy is step 7 and the `-NoLaunch` exit is step 9, a
`-NoLaunch` run sees exactly what the entry describes - robocopy returning 1,
the script still exiting 0 - while a full run hands that 1 back to whoever
called it. That is almost certainly the six fake failures and the two clean
observations, the same script, different flags. Inference from the control
flow rather than proof of which flags were used, but it fits both halves.

Fixed by saying so: `exit 0` at the end of the full path. Every real failure
above throws, so reaching that line means it worked.

**The "what went in" report named six files; the pages load forty-eight.** The
entry flagged `audiopanel.js`. Measured, it is worse: also `chatpanel.js` from
S11, `liveview.css` and `liveview.js` from S9, and `cmdpanel.js`, `reqpanel.js`
and `pollpanel.js` from S12, S13 and S14 - none of which existed when that list
was written. Adding them by hand would put it back in the same place by S19.

So the check changed kind rather than contents: it now reads the pages that
actually shipped, collects every `src=`/`href=` to a `.js` or `.css`, and
**throws** on anything missing. Throwing is the point. The try-out below it
cannot catch this at all - `/deck.html` answers 200 perfectly well while the
page throws on a script that is not there, which is precisely the failure the
old list looked like it was guarding against and was not.

What it does not cover, stated so nobody assumes otherwise: `url()` inside a
stylesheet, and `/fonts.css`, which the server makes rather than ships - the
try-out already fetches that one over HTTP.

**Tested in both directions, because a check that cannot fail is worth
nothing** - S17 had one of those sitting green for a full cycle. Positive,
against the repo's own `web/`: 12 pages, 48 distinct js/css, no dangling
reference. Negative, against a fixture: with a referenced file absent it names
it, with the file restored it clears, and it skips an absolute URL rather than
looking for `https://...` on disk.

Then the block itself rather than the idea of it: the exact code from step 2,
run against a mock `_internal\web` holding the real pages - clean at 12 pages
and 48 assets, throwing and naming `chatpanel.js` when that file is taken out,
clean again when it is put back. What that still does not reach is a real build
producing that layout, though `_internal\web\...` is the path the old
hand-written list already used, which is evidence rather than proof.

**Then run, with `-CheckOnly`** (2026-09-13), once the app was confirmed idle:
it builds into staging, tries the result on port 8797 and exits at line 78
without touching the install. `BUILD EXIT 0` in 48s; step 2 read the pages that
shipped and reported **12 pages, 48 js/css, 0 missing**, the same figures as the
repo; the five non-web essentials all present; every try-out URL 200, export and
import included. So the guess above about `_internal\web` is not a guess any
more - the real build puts them exactly there.

Worth more than the check itself: **the app packages.** Everything else this
plan did was verified against the rig, which runs `server.py` from source, so
nothing until now could have caught a Group C module PyInstaller cannot trace -
`chat.py`, `commands.py`, `songreq.py`, `alerts.py`, `polls.py`, `tiktok_live`.
It traces them all.

**Still not exercised, and not to be read as covered:** `-CheckOnly` exits
before steps 4 to 9 - the safety copy, quitting the app, the robocopy swap, the
model and cuBLAS seeding, the relaunch. The `exit 0` added at the end of the
full path is in that untouched stretch, so the one fix this step made to the
exit code is the one thing a `-CheckOnly` run cannot show working.

A full run was then attempted, with the app confirmed idle and the build already
through its try-out, and the permission classifier blocked it - reasonably, since
it quits the running app and mirrors program files over the install. It was not
retried by another route. So the exit code stays unverified until someone runs
`rebuild.ps1` by hand, and that is the check to watch when they do: robocopy
returns 1 on a normal copy, and the question is whether the script still hands
back 0.

The Spotify token in commit 62e2105 is still there, and is still yours to
revoke.

## S17 - a way back to straight, and five wrong ways to hear a double-click (2026-09-13)

Three things were listed. One was a fault and is built; two turned out to be
decisions, and are written down below rather than quietly settled.

**The fault was narrower than the entry says.** Rotation already snaps: the
single-layer branch of `stepRotate` puts the angle on the nearest quarter turn
within 3 degrees whenever snapping is on. And 357.4 cannot be a stored value at
all - `normDeg` maps to (-180, 180], so that reading is -2.6. What was actually
missing was two things: the *multi-selection* branch had only Shift's 15 degree
stepping and no cardinal snap, and nothing anywhere put a layer back to
straight. `straighten(ids)` now does, turning each layer about its own center
through the existing `pointOf`/`placeAt`, so the box does not walk across the
canvas - which is exactly what typing 0 into the inspector's Rotation field
does, and the reason that field was never the answer to "how do I get this
straight again". It is on the layer menu (grayed out when nothing is turned), on
a double-click of the knob, in the knob's tooltip and in the canvas's
screen-reader description.

**Then the double-click, which took five attempts, and the interesting part is
why the first four were wrong.**

1. A `dblclick` listener matching `e.target`. Wrong, and caught while writing
   the test rather than by running it: the HUD is rebuilt on pointerdown, so
   the two clicks land on different elements.
2. The same listener using `elementFromPoint`, to survive that. Also wrong, and
   this is the one worth keeping: a capture-phase listener on `window` saw
   **zero click and zero dblclick events** while the same press-and-drag
   rotated the layer perfectly well. The browser fires neither on a handle,
   because the mousedown target is detached before the mouseup and a detached
   target has no ancestor left in the document to carry a click. No way of
   resolving the target could have worked - the event does not exist. The
   existing "double-click into a group" handler survives only because a press
   on the canvas surface lands on something that is not repainted underneath
   it.
3. Detection moved to pointerdown, on time and place. Worked on its own, and
   P8 then caught it misfiring: two deliberate turns in quick succession at the
   same spot read as one double-click and straightened instead of turning.
4. Disarm inside `stepRotate`. This broke the double-click outright, because
   `stepRotate` runs again on release, at the press point.
5. Disarm gated on distance. Still wrong: two degrees at a fit zoom moves the
   pointer about two pixels, under any threshold worth having - including
   `DRAG_PX`, which was the tidier constant I had been about to reach for.

What works is disarming when a **pointermove arrives while a rotate gesture is
live**. Deliberately narrow: a real double-click jitters between its presses, so
"any movement" would have broken it for every actual user while passing every
test here.

**The tests were wrong three times over, and hid the code's fault for a whole
cycle.** The worst was a false pass: "a two degree wobble snaps back to no turn,
and costs no step" reads identically whether the snap did its job or the knob
was never taken hold of at all - and for one full run, both turns were doing
nothing. `turn()` now samples `Editor.gesture()` mid-drag and the check demands
`kind === 'rotate'`. Two more: assertions written against absolute angles turned
one failure into four knock-ons, so they assert the *turn* now (`d360`); and
`enabled.indexOf('Straighten')` returning -1 arrowed nowhere and pressed Enter
on whatever had focus, which recorded `delete 2 layers`. A test that can blind
Enter into a destructive menu item is wrong however green it is.

**Two forks, and the calls made on them.** These were left open at first and
handed back three times, which was the wrong instinct: the plan's own method is
"where a step has a real fork in it I pick the one written here and say why".
Both come out as leave it alone, which is a decision and not a dodge - and both
are one edit to reverse.

*Text that does not grow with its box.* `props.fit` is exposed already, as
"Shrink to fit" (`inspectors.js` 219) - I claimed it was unreachable, from
grepping `canvas.js`, which is not where the inspector lives. The name is
honest: it shrinks from `props.size` and never grows past it, and `stepResize`
only ever writes `w`/`h`/`x`/`y`, never `props`. Three ways to go: leave it,
since the case that bites on stream is overflow; make fit two-way and rename it
"Fit to box"; or scale the type on a corner drag, which is what a design tool
does and the largest change - it has to write `props.size` from a gesture,
survive the one-undo-step rule, and decide what multi-select scaling means.

**Decided: leave it.** Two-way fit sounds like the cheap win and is not one -
it would change every scene that has already opted in. Text sized deliberately,
shrinking only when it overflows, would start growing to fill its box the next
time the scene loaded. That is an edit to saved work dressed up as a setting.
"Shrink to fit" says what it does and keeps doing it; if filling is wanted it
belongs beside that box as its own option, named for what it is, which is a
deliberate change and not one to slip in at the end of a plan.

*The wheel.* The canvas is the only place in the app that hijacks it
unconditionally: `deck.js` guards its one hijack on two conditions and falls
through to native scrolling, `studio.js` only stops propagation, and everything
else uses wheel passively. `canvas.js` 374 calls `preventDefault()` on every
wheel event while 376 acts on `deltaY` alone, so a horizontal swipe is swallowed
and does nothing. I first wrote that not swallowing what it does not
act on was worth doing whatever else was decided. Retracted, on a second look:
Chrome can turn horizontal overscroll into history navigation, so that blanket
`preventDefault` is most likely what stops a sideways trackpad swipe from
walking out of the editor mid-edit. Letting it through buys nothing - the canvas
has nothing to scroll - and could cost that. Nothing to fix here after all.

What is left is a real taste call and only that: whether plain wheel should zoom
(mouse-friendly, and what it does now) or pan with Ctrl to zoom (better from a
trackpad).

**Decided: leave it.** This is a one-monitor desktop driven by a mouse - the
trackpad case the Figma convention exists for does not arise here. Wheel-to-zoom
is the convenient binding for the device actually in use, and retuning something
touched every day to suit a device that is not in play would be a regression
wearing the clothes of a convention. If this ever moves to a laptop the argument
flips, and the change is four lines.

**Seen once and unexplained:** `ReferenceError: paintHud is not defined`, in one
probe run, never again in three later runs including one against a pristine
`canvastools.js`. `canvas.html` loads `canvas.js` before `canvastools.js`, and
`applyView()` ends in `paintHud()` while being bound to `resize` - so a resize
landing between the two scripts would do it. That is a mechanism, not a proof.

Chased at the end of the plan and narrowed, but still not caught. There are two
resize listeners: `canvas.js` 1281 guards its call with `if (store.scene &&
!pan)`, so it cannot fire in the boot window, while `canvas.js` 371 is
`() => applyView()` with no guard at all - the only path that reaches
`paintHud` before `canvastools.js` has run. Boot itself is clear: the IIFE's
first statement awaits `fetch('/api/config')`, so everything after it happens
long after both scripts. A probe then opened the page twelve times with the
cache disabled and a device-metrics resize fired immediately, and got 0 of 12.

Then caught, by stopping racing it. `Fetch.requestPaused` holds the
`canvastools.js` response while boot carries on, and that throws every round -
0 of 12 became 3 of 3. And the stack named a path that was not the one supposed:

    ReferenceError: paintHud is not defined
      at applyView (canvas.js:346)
      at zoomFit   (canvas.js:355)
      at loadScene (canvas.js:229)
      at async     canvas.js:1275

No resize in it anywhere. **Boot is the hazard**, and the paragraph above saying
it was "clear" because the IIFE awaits `fetch('/api/config')` first was wrong:
that only holds while a script tag beats a localhost fetch, and nothing
guarantees it. Deleting the unguarded listener at 371 changed the count not at
all, which is how the misdiagnosis came to light.

Fixed where the race is. The boot IIFE waits for `DOMContentLoaded`, which no
classic script tag can precede, so every file loaded after this one has run
before `loadScene()` calls into any of them. That is worth more than guarding
`paintHud`: `canvas.js` is loaded first and calls into all seven files below it,
so the whole class is covered rather than the one function that happened to
surface. (`deck.html` orders the other way - `deck.js` last - and never had it.)

Line 371 stays deleted, but on its own merit as duplication of the guarded 1281,
not as the cure.

Then the same question asked of everything else, because finding one by accident
is not a search. `canvas.js` calls exactly two functions defined in files loaded
after it: `paintHud` (`canvastools.js` 550) and `openNewDialog` (`newscene.js`
75). The second is reached only from a click and a `<select>`'s change, so it
cannot run early. `renderTree`, `renderInspector`, `paintScenePick` and
`paintLive` are all defined in `canvas.js` itself - I had suspected `renderAll()`
was reaching across files as well, and it is not. Of the forty-odd listeners
registered at the top level, three are not user-gated: the resize above,
`beforeunload`, and the scene iframe's `load`, which calls `pushPreview` - local,
and touching nothing but `postMessage`.

So it is one crossing, now fixed, rather than a class wanting guards scattered
through the file. Worth recording as a negative result: the next person to see
this entry should not have to re-map it, or over-correct.

Verified: 3 of 3 throwing before, 0 of 3 after with the script still held in
every round - so the window was exercised, not merely missed. Then P8 61 of 61
and P9 72 of 72 with the ten goldens at 0.00%, because deferring boot changes
the timing of every page that loads `canvas.js`. And `chatui` 30 of 30 after
that, which is the pointed one: it mounts the chat panel inside `canvas.html`
and reports nothing thrown there - the page the fix is in, by the one path P8
and P9 never take.

Verified: P8 61 of 61, up from 57 at the low point, with the five new checks
covering the knob double-click, the menu entry's rule, the wobble that must not
turn, the near-quarter that must snap, and straightening several at once - each
also held to exactly one undo step. Plus a probe A/B against the pristine file,
where the same double-press leaves the layer at 30 degrees and mine puts it
back to 0. And P9 afterwards, 72 of 72 with all ten goldens at 0.00% - read
this time rather than inferred: the rotation work and the screen-reader line
moved no pixels.

## S17b - the harnesses that truncate their own URLs (2026-09-13)

The step asks one thing: check the assumption before trusting it. The
assumption was that `p7` through `p12` only ever open single-parameter URLs, so
`encodeURI` leaving `&` alone cannot bite them.

**The assumption holds.** Those suites open `scene.html?id=X`,
`canvas.html?scene=X`, `deck.html` or `remote.html` - one parameter or none -
and the values are `secrets.token_hex(4)`, eight lowercase hex characters, or a
template key like `music_lyrics`. There is no `&`, `=`, `#` or space for
`encodeURI` to pass through. Nothing in p7-p12 was loading a truncated URL.

**The fault was live anyway, in a suite the plan's list does not name.**
`tools/p6/shotpage.js` interpolated the URL with no encoder at all, and
`p6run.sh` hands it `frame.html?kind=camera&preview=1`. Two parameters.

Measured rather than argued, by opening the same page three ways and asking it
what it received:

| handed to `/json/new?` | the page saw | `preview` |
|---|---|---|
| raw (`shotpage.js`) | `?kind=camera` | false |
| `encodeURI` (p7-p12) | `?kind=camera` | false |
| `encodeURIComponent` | `?kind=camera&preview=1` | **true** |

On a single-parameter URL the last two are identical, which is what made
converting the other suites a no-op rather than a rewrite.

**What it cost.** `frame.js` reads `STANDALONE = !PREVIEW && !EMBED`, so the
lost parameter did not merely drop a CSS class - it flipped the page into
standalone mode. That wired window controls, POSTed the headless 480x480
viewport to `/api/components/camframe/metrics`, and drew the first-open "drag
to move" hint pill. `frame_camera.png` - P6's reference picture of the deck's
*preview* - was a standalone window with a hint banner across the top.

I had reasoned the difference would be invisible: `.handles` sits at
`opacity: 0` until `:hover`, and a headless capture never hovers. The
photograph said otherwise. `windowctl.js` adds `show-hint` for 4000 ms on first
open and `frame.css` lifts the pill for it, while `shotpage.js` waits 3500 ms
before capturing. The fault is visible by five hundred milliseconds. Half a
second the other way and it would have left no trace in the picture at all,
leaving only the silent write - `report_metrics` is in-memory (`overlay.py` 84),
never persisted, and `server.py` 2769 deliberately skips `HUB.broadcast()` for
metrics, so nothing announces it. Worth saying plainly: reasoning said
cosmetic-and-inert, the image said otherwise, and the image was right.

**Fixed** in `shotpage.js`, with the other eight `encodeURI` sites converted
alongside it now the probe has shown that safe. `encodeURI(` no longer appears
anywhere in `tools/`.

**`tests/test_harness_urls.py`** keeps it that way, with two rules: a `.js` file
naming `/json/new` must use `encodeURIComponent`, and a shell harness, having
nothing to encode with, must open a single-parameter URL. Its first run failed
on its own documentation - the explanation in `shotpage.js` spells out the
`/json/new?<url>` shape. Fixed by skipping comment lines rather than by
narrowing the rule to `fetch(`, which would have let a call split over two lines
through in silence.

**The step's other claim also holds.** After S5's fix, "no other shell script in
`tools/` hands non-ASCII to curl": the only non-ASCII in any `.sh` or `.ps1`
under `tools/` is in `p6run.sh` - one comment, and the heredoc that goes over
stdin. The rig's stored config read back `"bl": "✨"` intact, which is that fix
working.

Verified: the three-way probe on the rig; before and after photographs of the
camera frame, the hint pill present in one and gone in the other; 5 of 5 unit
tests; and P9 72 of 72 as a regression check. Only p8 and p9 had been
re-run when this was written, so calling that a check on "the converted call
sites" was generous about the other six. All eight were exercised afterwards, at
the end of the plan: p7 17/17 (after fixing a stale check of its own), p8 61/61,
p9 72/72, p10 24/24, p11 24/24, p12 30/30, p12live 7/7, and `latprobe.js`
through `latrun.sh` - which `p7run.sh` does not invoke, and which asserts
nothing, so all it shows is that the page opened and the measurements came out.
And `shotpage.js`, the fix this step began with, through `p6run.sh` rather than
the one-off re-shoot: 21 of 21 and 22 of 22, with the camera frame drawn in
preview mode this time. Checked by looking at the picture, not the log - "shot
written, no console errors" was exactly as true while it was photographing the
wrong thing. That total is the whole of what I can claim from the last one - I
piped the run through `tail -40` and discarded the ten per-image golden
percentages, so "all ten matched" is an inference from the total, not
something I read.

## S16 - the inspector's type, and ten goldens rewritten (2026-09-13)

The step exists because P9 photographs the inspector and compares it pixel for
pixel, failing on any size difference at all - so growing its headings moves the
clip height of all ten reference images at once. Deferred twice for that reason.
Done here, where rewriting them is the point rather than a side effect.

**The size was not mine to choose.** This file already records the left panel's
headings going "from 10.4 px in the dimmest token to 11.5 px a step lighter", so
the inspector's follow it exactly: `.74em` to `.82em` - 11.48 px, which is what
`.pane-h` already is - and `--dim` to `--label`. Both halves. Reading that entry
is the only reason the color changed at all: I had inferred the size from
`.pane-h` and would have shipped the wrong half of a fix the project had already
made next door.

`.insp h3` and `.cb-right .sec > summary` moved together. They are the same role
- plain section headings and folding ones - and moving one alone would have left
the inspector with two heading sizes.

**What made a global `update` safe.** The warning is in this file already: a
global update "blesses every image including any drift you did not mean", and
Group C had touched `inspectors.js` twice. So the order was a clean baseline
first (72 of 72, all ten at 0.00%), proving there was nothing to absorb; then
the change; then `update`; then a clean verification (72 of 72, all ten at
0.00%). Worth saying plainly: the middle run's "72 of 72" counts ten *writes*,
not ten comparisons, and proves nothing on its own. The pass that matters is the
one after it.

| The ten | before | after |  | | before | after |
|---|---|---|---|---|---|---|
| scene | 878 | 884 | | cam | 2524 | 2535 |
| bg | 2252 | 2263 | | lyrics | 2590 | 2603 |
| pic | 2278 | 2289 | | screen | 2686 | 2697 |
| box | 2303 | 2314 | | face | 2722 | 2733 |
| title | 3321 | 3333 | | np | 3620 | 3632 |

Every width unchanged at 300. My estimate before the run was around 28 px of
growth; it is 6 to 13, so these panels carry far fewer headings than I supposed.
`np` at 3632 leaves 568 px under the 4200 viewport, so S6's blind-bottom fault
does not come back.

**The scrollbar suppression is insurance, and the step's premise had gone
stale.** It is in `HIDE_DYNAMIC` as the plan asks and it is right to have - but
it removed nothing visible. The clip is `min(panel height, content + 12)`, and
np's came out at 3632, the *content* figure rather than a panel cap: at the
capture viewport `#inspector` does not overflow, so there is no bar in frame to
catch. S1 found one when the panel was shorter than its content; S6 then raised
the viewport to 4200 to fix np's blind bottom and incidentally took the bar out
of shot. The uniform deltas settle it - freeing ten pixels of content width
would have rewrapped text and moved the heights irregularly, not by a flat
1.1 px per heading. What the suppression buys is that lowering that viewport
again can never silently break the suite.

**Left alone, deliberately.** `.nd-group h3` (`canvas.css` 550) carries the
identical declaration, but it belongs to the new-scene dialog rather than the
inspector and no golden photographs it. Widening the step to catch it would have
been scope the plan did not ask for; saying nothing would have been worse.

**No *Checked by* clause**, which is consistent rather than an omission. Every
clause in the plan belongs to a step that builds something, and S16's
correctness *is* the golden comparison - a clause promising "the goldens match"
would be circular. Group D carries none.

**Against a standing rule, and flagged too late.** The plan's own rules say the
goldens are "regenerated deliberately, one file at a time, never with a blanket
`update`". This step used a blanket `update`. The order above - a clean run
first proving there was no drift to bless, the change, the `update`, then a
clean run - was built to remove exactly the risk that rule guards, and the
result is verified on both sides. But the rule says never; the deviation was not
raised when it was made; and read back, the paragraph above reads as though a
global update were simply one of the options. Redoing the ten one at a time
would change nothing: they are already correct, verified at 0.00% on both
sides, and regenerating them individually would write identical bytes. So it
is not outstanding work and is not offered as any - the rule's purpose was met
by other means, its letter was not, and the deviation is recorded here rather
than carried around as a pending fix. If the letter matters, the repair is not
a re-run but a change to the rule, to say what the clean-baseline-first order
buys and when it may stand in.

Verified: P9 72 of 72 three times - clean before, writing during, clean after -
with the ten at 0.00% on either side of the rewrite.

## S14 - polls, and one vote each (2026-09-13)

Group C's last step, and taken last on purpose: S15 first meant polls arrived on
a bus that already existed rather than cutting a private path to the canvas for
that step to replace.

**Votes do not go through S12's engine.** Nobody is going to register `!1` to
`!9` as commands, and the engine's model - a role gate and a cooldown - is the
wrong shape for voting, where the rule is one each. So `polls.py` takes its own
watcher on the chat hub, beside the command engine rather than behind it;
`chat.py` already parses `!1` centrally as the command `1`, so there is no
second parser anywhere. *Opening* and *closing* a poll do go through the engine,
because those are the streamer's and the gate is exactly the point.

**First vote wins.** Letting people change their mind sounds kinder and is worse
on a stream: the total stops matching the number of people who voted, and "you
can change it" is a rule nobody watching can see. Later votes are ignored, which
is the rule that fits in one sentence said out loud.

**The whole tally, never a delta.** What reaches the canvas is the entire count
each time, so a page that joined halfway through is right at the very next vote
instead of adding up what it missed. It is coalesced with a trailing timer, so a
busy poll does not put an event on the bus per vote and the last vote of a burst
still arrives.

| Found while building | |
|---|---|
| `TYPES.poll` has to declare an `alert` hook | `needsAlerts()` only opens the socket for types that have one, so a scene holding nothing but a poll layer would have opened nothing and never heard a thing - S15's lazy socket working against me. |
| `identity()` needed a poll case | The layer holds the tally it is drawing. Rebuilt on a scene switch it would blank in the middle of a poll and stay blank until the next vote. |
| `motion.js` stops animations, not transitions | The bar eases on every tally, which is the endless redrawing Ultra exists to stop, so that transition is gated on `:root.ultra`. |
| Two layers of one type share an identity key | It sounded like a collision - but S15's run had two alert layers in one scene, both drawing, so the Stage keys by id and uses identity only across scenes. Evidence from a passing test rather than a guess. |

**The check that had to be written one particular way.** The bars are measured
with `getBoundingClientRect()`: 884 and 436 pixels of a 1320-wide track, 67% and
33%, matching a 2:1 split. Counting elements and watching transforms change is
precisely how S7's microphone layer passed "24 bars", "30 different shapes" and
"24 above the floor" while every bar had flexed to zero width.

**Two things about my own work, recorded rather than tidied away.** The syntax
gate caught `const label` declared twice in `onair.js` before either rig cycle
ran - the `&&` chain short-circuited and the mistake cost nothing, which is the
argument for the gate. And a gap found by re-reading rather than by any test:
the `poll` action added to `commands.py` had no coverage at all at either level,
because the probes open polls through the panel and the API and never through a
chat `!poll`. Six tests cover it now.

Verified: 20 unit tests for `polls.py`, 6 more for the engine's poll action, the
full Python suite 251 of 251 (1 skipped, up from 225), `tools/ui/onstream.js` 13
of 13 and `tools/ui/onair.js` 40 of 40.

With this, **Group C is complete**: S9 through S15.

## S15 - alerts, and the bus they arrive on (2026-09-13)

Taken before S14, against the plan's own order. S15 *is* the bus, and it already
had two producers waiting in S12's commands and S13's requests; built the other
way round, S14's poll layer would have invented a private path to the canvas
that this step then replaced.

**An event is not state.** `/ws/events` fans out whole snapshots, so an alert
carried on it would make every page in the app rebuild its model each time
somebody typed - the reason the chat messages were kept off it, and the same
reason here. `feeds.serve_ws_feed` is already generic over the hub, so a third
feed cost one route and no new endpoint code. The state feed carries how many
have fired and never the events themselves.

**One socket per page, and none when nothing wants one.** The obvious wrong
build gives a scene with three alert layers three sockets. The house already had
the answer: `needsVoice()` asks whether any layer in the scene wants voice
before taking the lease, so `needsAlerts()` mirrors it and the page opens
`/ws/alerts` only when a scene has a layer listening. A scene that wants nothing
costs nothing - checked outright, being exactly the sort of claim that quietly
stops being true.

| Found while building | |
|---|---|
| `applyBox` writes `el.style.opacity` inline on every layer | So the show and hide could not live on the layer box: an inline style beats a stylesheet rule, and the alert would simply have been on screen always. It lives on an inner card instead. |
| `identity()` keys only layers whose media costs something to reopen | An alert layer holds no device - but it holds an alert part way through showing, and a queue of ones waiting. With no case of its own, a scene switch drops both silently. Added, and checked by switching scenes mid-alert. |
| Chat's queue depth, carried forward before it could bite | S11 learned the hard way that a dropped event is gone rather than superseded, at 12 messages of 40. The bus took 256 from the start instead of the state feed's 8. |
| **The card drew in serif** | Found by looking, a fourth time this run of steps. `props.font` was the only thing setting a face, so an alert with no font chosen fell through to the browser default. Comparing against how the text layer does it (`scene.js` 120) then turned up a second fault the picture could not have shown: the family was applied unquoted and without fallbacks, so a name with spaces in it would never have applied at all. |

**Two limits, stated rather than left implied by a green run.** The kind filter
is shown to *reject* - a request-only layer ignores a command - and is never
shown to *accept*, though the accept path is the same code the unfiltered case
exercises. And the font-quoting half of that last fix is verified by reading
only: the probe uses no custom font, so nothing on the rig touches it.

Verified: 16 unit tests for `alerts.py`, the full Python suite 225 of 225 (1
skipped), and `tools/ui/onstream.js` 8 of 8 - a real scene page, with a
`!command` off S10's fake IRC server traveling the whole way through the real
parser, the real engine and the real bus to be drawn on the canvas.

## S13 - !queue, and a one-way door (2026-09-13)

The first thing hanging off S12's spine, and the first step whose testing could
have touched a real account. It does not: Spotify is injected into the store the
way the scene switcher is injected into the command engine, and the rig fakes it
at a seam refused on the real port. Verifying my own code is not a reason to put
songs in somebody's queue.

**Two things the existing Spotify layer already knew.** I raised a worry that
appending would force everyone to authorise again, and then withdrew it:
`SCOPES` has held `user-modify-playback-state` all along, and search needs no
user scope at all, so nobody reconnects. But `_fetch_queue`'s docstring has
recorded since P0 that the Web API "can read this queue and append to it, but
there is no endpoint to reorder or remove items". That is the shape of the whole
step: **appending is a one-way door.** It is why the pending list is the app's
own rather than a view of Spotify's, why approval is the irreversible press, and
why moderation is on by default. Worth saying plainly as well: appending is
Premium-only - `_explain` already answers a 403 with "Spotify allows this only
on Premium accounts", so on a free account this step's whole point cannot work.

**Where each decision is made.** Who may ask and how often stays in S12's
engine; only the song is decided here. Asking the same question in two places is
how the two answers drift apart - and a test pins it down: a viewer refused by
the role gate costs no Spotify call at all, which is how an app avoids rate
limiting itself on people it was never going to serve.

| Guard rail | The case it is for |
|---|---|
| Length cap | Named in the refusal ("longer than the 7m 0s limit") rather than a bare no. |
| Block list, checked against the request **and** against what came back | Someone asking for "never gonna give you up" walks past a list that only knows the artist. |
| The blocked word is never repeated back | Echoing it puts the thing on screen that the list exists to keep off it. |
| The parked list is bounded | A queue nobody drains must not grow without end. |
| Spotify's own words survive | 404 means nothing is playing and 403 means not Premium; both are more use than "that did not work". |

**A passing check that proved nothing, caught before it was believed.** The rig
run set `moderated: true` through `/api/config` and watched a request park - but
`true` is also the construction-time default, so every one of those 34 checks
would have passed identically had the `REQUESTS.configure(...)` wiring never
landed. The test that bites is the opposite direction: turn moderation **off**
through config and show the next request goes straight through. It does, and the
store's own rules now read `moderated: false` in the evidence. Said before the
run rather than discovered after.

Found by looking, a fourth time: the history rows put five children into a
four-column grid, so the reason fell to a second line under the timestamp and
read as a stray fragment. It is placed deliberately now, aligned under the title
it explains.

Verified: 23 unit tests for `songreq.py` and 6 more for the engine's `queue`
action, the full Python suite 209 of 209 (1 skipped, up from 180),
`tools/ui/onair.js` 35 of 35, and `tools/ui/chatui.js` 30 of 30. No test, on the
rig or off it, reached a Spotify account.

## S12 - the command engine (2026-09-13)

Taken straight after S9 because S12's own text puts the editor in the Live
view, so S9 blocked it exactly as S10 blocked S9's chat.

**"What it says back" could not mean what it sounds like, and that was settled
before any code.** This app cannot speak in chat. S10 signs in anonymously as
`justinfan` so it holds no credential, and the adapter has no PRIVMSG-out in it
at all - the only things it ever sends are the `CAP`/`NICK`/`JOIN` handshake and
the `PONG`. Checked in the source, not assumed. So a response is recorded and
shown: in the log the editor reads, and at S15 on the canvas, which is the step
that exists for it. Posting a reply into Twitch needs an account and an OAuth
token - the same class of decision as TikTok's connector, and the user's to
take. The editor says so in its own footer, because a "what it says back" box
that silently reaches nobody would be a lie told in a text field.

**Roles are a ladder, not a set.** `everyone < subscriber < vip < mod <
broadcaster`, and a gate of `mod` is passed by the broadcaster. Comparing badge
strings would have been the easy wrong answer, so the ladder is what the tests
push on: a broadcaster through a `mod` gate, a mod through a `subscriber` gate,
a founder not left below a subscriber, an unknown badge ignored rather than
promoted.

**Two cooldowns, because they answer different questions.** The per-command one
stops a command filling the stream however many people ask; the per-user one
stops one person holding it. Separate clocks, proved separate by a second
viewer running the command inside the first's window and getting it. And a
refusal does not start either clock - being turned away must not also put you
on cooldown for something you never got.

**An unknown `!word` does nothing and is not logged.** Every stream has people
typing `!` at things that do not exist; a log full of "no such command" is a log
nobody reads.

| Decision | Why |
|---|---|
| The registry is in config, not a store of its own | `scenes.py` exists for documents with revisions and backups. Commands are settings a person edits. |
| Not under `chat` | S14 starts a poll "from the Live view or by a command from you" - a command is not chat's property. |
| A watcher on `ChatHub`, not a subscriber | The engine is the app reacting to its own messages, not a feed to a browser. Pages are served first, then watchers, each guarded and none under the lock: a watcher that throws must not stop the fan-out, and one that took the lock would wedge the next message. |
| A command names a scene, and `set_live_scene` wants an id | A config file full of ids is unusable by hand. Names are matched first, then the string is tried as an id. Names are **not** unique - the rig has two scenes called "P5 stress" - so the first in list order wins: predictable beats refusing to switch mid-show. |

**A known limit, recorded rather than fixed.** The editor is not a live view of
config: change the list elsewhere and its rows are stale until it is reopened -
visible in the screenshot, where it says "1 command" while the server holds two.
The only thing that edits commands is this panel, so staleness needs an
out-of-band writer, and a refresh path would introduce a way to throw away what
somebody is halfway through typing. That trade is worth naming, not papering
over.

Verified: 26 unit tests (`tests/test_commands.py`, all of it arithmetic over one
message shape, with the clock injected rather than slept through), the full
Python suite 180 of 180 (1 skipped, up from 154), `tools/ui/onair.js` 26 of 26
including the one rig check the clause asked for - a message off S10's fake IRC
server, through the real parser and the real hub, firing a command and appearing
in the log the editor shows - and `tools/ui/chatui.js` 30 of 30 as the
regression check for changing `ChatHub.post()`.

Found by looking, twice more. The outcome pills are color-coded - `ran` green,
`denied` red - and nothing asserts that; the log's whole purpose is seeing what
did *not* happen as easily as what did. And the Live view's own shot caught S11
and S12 joined in one frame: `!hello` and `!modonly` sitting in the chat dock
with S11's command highlight on them, being the very messages S12 then ran and
refused.

## S9 - the desk you run it from (2026-09-13)

Taken last of Group C rather than first, and the detour paid: S9's own text
makes chat a constituent of the view rather than an addition, so building it
before S10 and S11 would have meant assembling four things that already work
around a hole. Done in this order it is assembly, and nothing had to be
unpicked.

**A window, not a component.** `components.py` registers neither the editor nor
the remote; both are `launch_deck(url, w, h)` - a Chrome app window on the deck
profile. The Live view is the same: components are overlays that go *on* the
stream, and this is the desk you run it from. `/api/live/view/open`, opened
from a button on the deck and on the Canvas Builder.

**The panels are the panels, not copies.** `mount()` now takes a host element.
Docked, a panel is always open, which makes `close()` a no-op - and since
Escape, click-away and the x all go through `close()`, one guard there covers
every way out instead of three patches. Docked, the Sound panel therefore holds
the voice lease for as long as the window lives, which is right for a meter you
are watching while you stream. So there is one chat panel and one Sound panel
in the app to keep working, and S11's own probe is the regression test for
having taught them to dock.

**Two sources, and the split is the point.** The state feed carries the scenes,
which one is on air, the stream's state and which windows are open: it costs
nothing to listen to and arrives the moment anything changes in the deck, the
editor or the remote. The health numbers are polled from `/api/live/status`,
and only while the window is visible, because `LIVE.snapshot_status()` drops
`stats` deliberately - its comment reads "nothing that changes every second".
Putting kbps and frame rate on the feed would make the whole-state hub
broadcast once a second to every page in the app. The six tiles use the LIVE
panel's own formulas (Mb/s from `kbps`, `native.fps` before `vfps`, dropped
summed across engine and native, `rtt_ms` before `delay_ms`) so the two places
that show those numbers can never disagree about them.

The program monitor asks for a picture only when the feed says the live output
window is open: `/api/live/program.png` answers 404 until it exists, and a 404
a second is a poor way to say "not open".

**The clause was amended before the check was written, not after.** It promised
the output window's own picture; proving that needs a real Win32 window, and
this machine reports one monitor, where test windows do not go. So it proves
the shut half outright - the message, the button asking the server, and *not
one request made* for a picture that would 404 - and the open half by the
request the page makes rather than by pixels. Narrowing a spec to fit a
convenient test is only honest said out loud.

| Found by looking, not by any assertion | |
|---|---|
| "SOUND" over "Sound", "CHAT" over "Chat" | Two components each assuming they were the only thing naming the section. The Sound dock's head holds nothing else once the x is hidden, so it goes; chat keeps its head for the channel pill. |
| Then the channel pill fell to the left | Self-inflicted by that fix: `.lp-head` is a flex row and the `h2` carried `flex: 1 1 auto`, so the title had been doubling as the spacer holding the pill right. Predicted before the re-run, and it happened. |

Verified: `tools/ui/onair.js` 20 of 20 (three times, across two fixes),
`tools/ui/chatui.js` 30 of 30 twice as the regression check for docking, and
the Python suite 154 of 154 (1 skipped). Run headless against the rig with
S10's fake IRC server: `node tools/ui/onair.js <devtools port> 8799
<.rig>/uishots`, the runner scratch as the other `tools/ui` probes' are.
Every one of the three risks written down before the first run - that
`/api/live/scene` might not be what writes `canvas.live`, that a remembered
output window would both fail the no-404 check and put a window on the user's
screen, and that the docked panels might not open through a re-entrant
`mount()` - came back clean.

## S11 - the chat panel (2026-09-13)

The plan says "chat in the Live view". S9's Live view does not exist - and S9
says it shows "the chat from S11". Rather than build half a page to hold this,
it is a shared panel exactly as LivePanel and AudioPanel are: any page mounts it
once and opens it from a button beside Sound. S9 will place it rather than own
it, so nothing has to be unpicked when it arrives. Said before building it.

**What it is.** One merged list with the service marked on every line, badges
and the sender's color kept, commands and mentions marked, pause-on-scroll with
a count of what arrived while you were reading back, Hide for a line and Block
for a person. Read-only: there is no box to type in, because replying needs the
account and the OAuth that S10 deliberately did without.

Kept and not kept, on purpose. Hiding one message lasts as long as the panel is
open - the hub keeps 300 and they age out, so a saved list of ids could only
ever grow. Blocking goes into `chat.blocked` in config, so both pages agree and
it survives a restart; it is local in the plan's sense, in that nothing is sent
to the service and nobody is banned, they just stop appearing here. The socket
is held only while the panel is open, and `feeds.serve_ws_feed` sends nothing at
all on connect - which is what makes `/api/chat/recent` load-bearing rather than
a nicety, and why the page names itself in the query (a WebSocket has no
Referer).

**Four things the first run found, and only one of them was the panel.**

| Found | By | What it was |
|---|---|---|
| A burst of 40 lines reached the page as 12 | the probe, counting rows | `chat.py` had taken the state feed's `QUEUE_DEPTH = 8`. That hub fans out whole snapshots, where a dropped one is superseded by the next; a dropped chat message is simply gone, and a burst is exactly the busy moment when it matters. Now 512, still bounded. |
| The log would not scroll, so pause-on-scroll had nothing to hold | the same run | Both were the first fault's shadow: twelve rows do not overflow. |
| A shut page held its feed for up to 15 s | the probe, asking `/api/feeds` | `serve_ws_feed` waits in `q.get(timeout=15)`; the reader thread sets `gone`, but the sender does not look until the timeout. It now pushes a sentinel, so the release happens when the page hangs up. Shared with `/ws/events`, so every page gains it. |
| **The connected pill was red** | the screenshot, and nothing else | `joined` was mapped onto the LIVE panel's `live` state, whose red means *the internet can see you*. Chat borrowing the on-air color said the wrong thing, loudly, and no assertion could see it. |

**A claim wider than its check, caught before it shipped.** The first probe
opened `deck.html` only, while the panel was being described as shared by both
pages. It opens `canvas.html` too now - which, because `canvas.js` holds
`/ws/events`, is also the real regression test for the sentinel above. P6 could
not be: `deck.html` is on SSE, and the sentinel never touches that path.

Verified: `tools/ui/chatui.js` 30 of 30 across both pages (21 of 25 first, then
the four above), P6 21 of 21 and 22 of 22 after the feed change, and the Python
suite 154 of 154 (1 skipped, 15 files). Run against a throwaway IRC server on
localhost with the rig's own adapter aimed at it, so every message asserted on
came off a socket through the real parser, the real hub and the real feed:
`node tools/ui/chatui.js <devtools port> 8799 <.rig>/uishots`, with the rig
restarted and a headless Chrome on that port. The runner is scratch, as the
other `tools/ui` probes' runners are.

Not changed, and noted rather than swept in: `_sse` has the same fifteen-second
lag the WebSocket path just lost, and no reader thread at all - it learns a
client is gone when it next writes. SSE writes fail fast on a dead socket, so it
corrects itself on the next payload or ping. Two shared feed paths in one change
is one too many.

## The tools could not find each other (2026-09-13)

Filed during S5 as two files with a wrong path. It was six files and thirteen
references, with a second fault underneath and twelve more found by the check
written for it.

**What the runners do, and what the Python tools never learned.** Every runner
`.sh` sets two anchors:

    N="$(cd "$(dirname "$0")" && pwd)"        # the tool's own folder, in the repo
    O="$(cd "$N/../../.." && pwd)/.rig"       # the rig and its scratch, beside the repo

The Python rig tools have only `S = dirname(__file__)` and use it for both. So
`wgc.py`, `windiag2.py`, `cdp.js` and `cpuby.ps1` were looked for beside the
caller when they live in `tools/p0`, and `testrig/`, `live/`, `apps/`, `prof-*`
and `rig.log` were looked for beside the caller when they live in `.rig`. Not a
typo: the same idiom against a layout that moved under it. "After P12: the rig
beside the repo" records the move - the runners were switched to the two
anchors and `cpuby.ps1` and `wins.py` copied into `tools/p5` so the P5 scripts
kept working; the Python tools were not looked at.

**Why nothing said so.** Python against a file that is not there exits 2 and
writes to stderr. Every one of these callers reads `.stdout` only, so it gets
an empty string, and an empty string reads as "no frames" rather than "no such
file". `p5rig.py` never got that far: it opens `live/p5rig.log` at import, so
it died on line 14 before the capture path mattered.

| Fixed | |
|---|---|
| `p2rig.py` | `windiag2.py`, `wgc.py` x2, `apps/`, `testrig/` |
| `p3rig.py` | `windiag2.py`, `wgc.py` x2, `cdp.js`, `cpuby.ps1` x2, `apps/`, `prof-*` x2 |
| `p5rig.py` | `wgc.py`, `live/` x3, `prof-*` x2, `rig.log` |
| `p5switch.py` | `cdp.js`, `prof-p5` |
| `p5min.py`, `p5park.py` | `wgc.py`, `live/` |

`cpuby.ps1` stays on `S` in the P5 scripts: that copy is deliberate, and the
two differ only in four comment lines.

**The check that would have caught it** (`tests/test_tools.py`): every helper
script a tool hands to python, node or powershell has to be a file that exists,
and no tool may name this repo by absolute path. The last one found twelve I
had not - eight `sys.path.insert(0, r"C:\Users\ghamp\streaming stuff\music-deck")`
across p1/p4/p5, and `.build-env` written out in `p5recover.py` and
`p12run.sh`. Each breaks the next time the repo moves, and it has moved once
already. All twelve now work themselves out from the script; `p12run.sh`'s new
value was checked to be identical to the literal it replaced, because
`p12test.js` spawns it. The two path checks were then proved by breaking one
Python and one shell reference on purpose and watching them go red - without
that they had only ever seen green, which is also what a check that is not
looking does.

**Still open, and named rather than swept up.** About fourteen other tools
(`p4/audiomem.py`, `p4/videomem.py`, `p4/p4soak.py`, `p5/comptest.py`,
`p5/p5native.py`, `p5/p5nthreads.py`, `p5/p5onair.py`, `p5/p5recover.py`,
`p5/p5stress.py`, `p5/p5threads.py`, `p5/tearcheck.py`, `p5/optrun.py`,
`p5/framenative.py`) still write scratch to `S/live` or read `S/testrig`. The
guard covers scripts, not directories. They need a rig, a GPU and ffmpeg to
exercise, so they are listed for whoever next runs one rather than swept in
blind.

**Also found, not changed.** Eight runner scripts and `rigrestart.ps1` decide
what to kill with `-notlike '*streaming stuff\music-deck*'` on the process
command line. That is what stops a rig teardown from killing the user's real
app on 8713 - and it stops protecting it, silently, if the repo folder is ever
renamed. Destructive code that cannot be tested safely from here, so it is
reported rather than touched.

Verified: the full Python suite 154 of 154 (1 skipped, 15 files); the guard
3 of 3, red on purpose, green again; every edited file compiles with
SyntaxWarning fatal, which also cleared two invalid `\c` escapes in `p5min.py`
and `p5park.py` that had been warning on every run. Nothing here was run
against a rig: this is the tools' paths, not their results.

## S10 - chat, ingested (2026-09-13)

Taken before S9 on the user's instruction, and it was the right order: S9's own
text makes chat a constituent of the Live view rather than an addition, so
building the view first would have meant assembling four things that already
work around a hole, then reopening it.

**One shape, one adapter per service.** `chat.py` holds a single message -
service, channel, id, time, user (id, login, display name, color), badges,
text, and the command if the line starts with one - and an adapter's whole job
is to produce it. Nothing downstream learns what Twitch is. A fourth service is
a new adapter and nothing else, which is what the plan asked for.

`!command` is parsed centrally rather than per adapter, so `!queue` means the
same thing whichever service it arrived from. That is the seam S12 hangs off.

**Two departures from the plan's wording, both deliberate.**

- **TLS IRC, not WebSocket.** The plan says "IRC over websocket", which is right
  for a browser. This runs in the server, and the app's `WebSocket` (`live.py`
  448) is explicitly *the server side*: `send()` writes `0x80 | opcode` with no
  mask bit and never makes a masking key, while RFC 6455 requires
  client-to-server frames to be masked. So "IRC over websocket" here would mean
  writing the client half of a WebSocket in order to wrap a protocol that does
  not need wrapping. `irc.chat.twitch.tv:6697` speaks the same thing directly.
  The class stays exactly right for the outbound `/ws/chat` feed to pages.
- **Anonymous read, so no new secret.** A `justinfan` nick joins a public
  channel with no OAuth at all, so this module holds no credential - in a
  project that keeps a stream key under DPAPI and still has a leaked token to
  revoke, that is worth stating. A test asserts it by scanning the module for
  `oauth:`, `password`, `client_secret` and `access_token`.

**The chat feed is the state feed's endpoint with a different hub.**
`ChatHub` offers `subscribe()` / `unsubscribe(q)` exactly as `Hub` does, so
`/ws/chat` is `feeds.serve_ws_feed(self, CHAT, FEEDS)` - the same function,
unchanged. That was the payoff for copying the existing contract instead of
inventing a similar one. Subscribers get `queue.Queue(maxsize=8)` and a full
queue **drops**, counted, rather than growing: a page that cannot keep up misses
messages instead of eating memory.

Messages never ride the state snapshot. `Hub.broadcast()` serialises the whole
state and exists to send rarely (`_change_key` suppresses unchanged sends); a
message per broadcast would defeat both. The snapshot carries only which
services are connected. A page opening mid-stream backfills from
`/api/chat/recent`, off a 300-message ring.

**One test hook, and the only one in the app that is refused on the real
thing.** `/api/debug/chat-endpoint` points the adapter at another host so the
rig can stand a plain IRC server on localhost. `/api/voice/override` next to it
is ungated, and rightly - saying "speaking" on the real app is harmless.
Telling a network client where to dial is not, so this one answers only when
`CONFIG["port"]` is not 8713.

That hook is what makes the rig check real rather than mocked: a fake server
speaking Twitch's own handshake, with the adapter's actual socket, reading loop,
PING answer and reconnect exercised. Mocking the socket would have exercised the
mock, and those four are where this kind of code breaks. It also caught the
thing worth catching: the override only survives because `connect()` builds a
fresh adapter each time and `host`/`port`/`tls` are set on the *class*.

Verified: 34 unit tests (the IRCv3 parser - the five escapes, valueless tags,
and the trailing parameter that a naive split loses when a message contains a
URL - the message shape, `/me`, command extraction, and the hub's
drop-rather-than-grow) and 14 on the rig, end to end. The drop check passed on
`reconnects: 1` while already back to `joined`: it did not merely notice the
connection go, it had reconnected and re-joined inside a second and a half,
with its count intact.

### Two red tests found on the way, neither of them S10's

The full Python suite had not been run in a while - the rig suites were being
run instead, and for P6 those are two different things with one name. Running
all of it turned up two failures:

- **`test_p6.py` had been red since S5**, when the two frames moved from the
  "sharing" group into "legacy" so the canvas would be the obvious home for
  them. The assertion still expected "sharing". Corrected to match the change
  S5 made on purpose. What is worth noting is how long it went unseen: every
  time this work "ran P6" it ran `tools/p6/p6run.sh` on the rig (21/21, 22/22)
  and never `tests/test_p6.py`. Two suites, one name, and an assumption.
- **`test_p11.py`'s stream-key guard had been red since `a024091`** - across two
  commits, on a security-relevant assertion, with nothing surfacing it. The code
  is not at fault: the only two `.key` reads in `livepanel.js` are the TikTok
  tab's Show and Copy, both user-initiated, both through
  `POST /api/tiktok/reveal`, with `maskKey()` putting it back behind dots. The
  *guard* was written before that tab existed and said flatly "nothing reads
  .key", which cannot tell a deliberate press from a key riding the status poll.
  It is sharper now rather than looser: every `.key` read must have a reveal
  call above it, so a key arriving unasked still fails. `live.py`'s `status()`
  is still checked for carrying no key at all.

Both are the same lesson this session keeps producing in different costumes: a
check that is not looking at what it claims to. S1's goldens contained a
scrollbar, S6's `p9_np.png` could not see the bottom of its own inspector, S8's
chevron passed by landing under a tolerance, and here two tests were simply
never run.

**Still to come, and one of them is not mine to decide.** YouTube is second, and
its Live Chat API is official and quota'd. TikTok has no official read API at
this tier, so it needs an unofficial connector carrying the same account risk as
the stream-key work - the plan calls it "a decision, not a step", and it stays
that way: the cost and the risk get laid out for the user, who decides. It will
not be quietly built in.

## S8 - the whole flow, gone through button by button (2026-09-13)

The step the walk-through was for. Sixty-two numbered complaints, and this is
the pass that answers all of them: closed, handed to a step that owns them, or
deferred here with the reason written down. Nothing is dropped, and three of
them turn out to have been wrong.

### The Canvas Builder, as it is meant to be used

Written down so the next change has something to disagree with. The order is
the order of the job, not the order of the screen.

**1. Make a scene.** The picker at the top left lists them; New scene starts
one, horizontal or phone. A new scene is empty, and an empty scene now says what
a scene *is*: a picture built out of layers, which becomes a window on this
computer, and that window is what the people watching you see. That sentence is
the whole model and everything below is a consequence of it.

**2. Put something in it.** The left panel is three tabs in the order they are
needed: **Layers** (what is in this scene), **Add** (put something in),
**Pictures** (files you brought). Add is a grid of kinds, with "You, talking"
across the top. A window or screen comes from the picker below it. Adding
anything ends on the Layers list - you should always see what you just made.

**3. Arrange it.** Drag to move, a corner to resize, the knob to turn; what
Shift, Alt and Ctrl do is drawn under the canvas while you drag. The Layers list
*is* the stacking order, and says so once there are two things to order.

**4. Change how it looks.** The inspector, one folded section per kind of thing.
A window from the deck either uses the design it already has or takes a copy for
this scene - you are never sent elsewhere to recolor what you are looking at.

**5. See what is going out.** "What's on air" shows the live output's picture.

**6. Put it on stream - two different things.** *Open output* gives this scene a
window on this computer to add in TikTok Studio or OBS. *Off air* opens the LIVE
panel and streams from this app. Neither implies the other, and both say so
where you press them. *Take* swaps which scene is live.

**7. Saving.** There is none to do, and if a save fails you are told out loud.

**The rules underneath.** Plain words over our own vocabulary. Marks are drawn,
never typed characters. A control that is off should say why. And the empty
state is where the teaching goes, because it is the only moment nothing is in
the way.

### What changed here

- **An empty canvas explains itself** (G1, F7). A panel with the model in three
  sentences and the three steps, each with a way into it. It goes the moment the
  first layer lands, so it is never in the way.
- **The three ways to make it real now say how they differ** (F5, F6, F9). "Off
  air" was a pill that read as a status and was a button: it has a hand, a hover
  and a drawn disclosure mark. "Studio" - the one panel that shows what viewers
  see, behind a word naming a mode rather than the thing - is **"What's on
  air"**.
- **Every mark in the layer list is drawn** (B4), which S6 deferred here by
  name: nine kinds, no typed characters left. Undo and redo too (B1), the
  folding marker (B8), and the inspector's reset dots (B7).
- **Plainer tabs** (G2): Sources and Assets were our filing. Layers / Add /
  Pictures. The ids are unchanged, so nothing that addresses them breaks.
- **Small ones:** the grid size no longer vanishes when the grid is off (E7);
  the zoom readout is no longer the dimmest thing in the bar (E4); a failed
  autosave says so out loud instead of as a red word in a corner (F3); the
  layer list says the top is the front, once there are two layers (D1).

### Three the walk-through got wrong

Recorded as corrections rather than fixed, the way B6 was in an earlier slice.
Each was mis-scored the same way - reading one surface and inferring behavior.

- **F4: "the newer version replaces your work silently, with no dialog".** It
  does not. `onConflict` raises a toast naming exactly what happened, plus an
  `announce()` for screen readers. What *is* true, and is deferred: the conflict
  clears the undo history, so the overwritten work has no way back. That is a
  question about keeping a copy, not about a label.
- **G10: "dead CSS suggesting a removed color-preset feature".** The swatches
  are alive in the deck (`deck.html` 210 and 332, `deck.js` 2014-2020). The one
  `.cb-right .swatches { display: none }` is the editor suppressing a cloned
  deck control, like the others in `cleanPane`.
- **B7 was right, and an earlier pass of mine was wrong to clear it.** The dot
  is `<button class="reset-dot" ...>&#8635;</button>` - a typed character. The
  deck hides it and paints a mask; the editor clones those nodes and does not
  load `deck.css`. Measured in the editor: 8 dots, 12.32 px text, no `::before`,
  no accessible name. The earlier pass photographed the *deck's* dots and
  cleared the complaint. Right about the deck, wrong about the surface the
  walk-through actually used.

### And one shipped in S7

`icons.js`'s `STROKED` never got `mic` when that glyph was added, so `svgIcon`
painted a path drawn as outlines with `fill="currentColor"`: every microphone
layer's row mark was a filled blob. `soundpanel.js` checked the layer's bars and
never its row. The probe reads the rendered `fill`/`stroke` now, so the whole
class fails a test rather than waiting for an eye.

### Two introduced here and caught here

The layering hint read "the top of this list is the front" on an empty canvas
with no list - true, useless, and sitting above a second hint saying the scene
was empty. And "Off air" got a disclosure caret written as a typed U+25BE, in
the same pass that removed typed U+25B8/U+25BE from the section summaries for
being font-dependent. Both fixed before the run.

### The ledger

**A (window capture) - all closed** by the picker and `holePreview` work.
A2 is closed with a note: the `.source-note` cannot use `var(--z)`, because that
variable lives on the editor's document and the note lives inside the iframe.

**B (icons)** - B1, B2, B3, B4, B5, B7, B8 closed; B6 withdrawn (roving tabindex
is correct for a tree); **B9 deferred** - "every explanation is a `title=`" is a
whole-app convention, not a control.

**C (drag and handles)** - C1, C3, C5 closed. **C4, C6, C7, C8, C9 are S17's**
(rotation back to straight, text boxes stretching, marquee, Space-to-pan,
wheel-to-zoom). **C2, C10-C14 deferred**: nine targets on a small layer is
inherent to eight-way resize plus rotate, and the snapping language (lines,
guides, drop targets) wants settling in one piece rather than four.

**D (layering)** - D1 closed, D4 part closed by it. **D2, D3, D5 deferred**:
front/back on bracket keys and the grouping story belong together, and a
99999x99999 background layer is a scene-format question.

**E (size and contrast)** - E3, E4, E7 closed. E1 is half closed and half
**S16's** (the inspector's headings move all ten goldens, so they belong to the
step that rewrites them). **E2, E5, E6, E8 deferred**: a type scale, a UI scale
control, the brand that hides below 1700 px (which already carries its reason -
the window's own title says Canvas Builder), and disabled controls that do not
say why - which needs a reason per control.

**F (saving and purpose)** - F1, F2, F3, F5, F6, F7 closed; F4 corrected; F8 and
F9 part closed. **F8's remainder is deferred**: decoupling the monitor from
Studio would drag Studio's editing semantics with it.

**G (discovery)** - G1, G2, G3, G9 closed; G10 corrected. **G4, G5, G6, G7, G8
deferred**: the shortcuts dialog, expression fields, right-click discovery,
layer names defaulting to their type, and safe zones being unexplained *and*
grayed with no reason - which this step's own screenshot caught, and which is
the same fix as E8.

Verified: P9 72 of 72, P8 56 of 56, P6 21 of 21 and 22 of 22, and the empty
canvas 7 of 7 (`tools/ui` probes for the glyphs and the first-run panel). The
ten goldens are regenerated: the summary marker is a drawn chevron now, which
moved every inspector by 0.22-0.35% of its pixels - under the 1% threshold, so
they *passed* first. Left alone, that is a third of a percent of known drift
baked into every reference and a smaller budget for the next change, which is
the accumulating blind spot S1 and S6 both wrote up.

## S7 - the mixer with the door left open (2026-09-13)

`live.py` has mixed the microphone and the desktop into the stream since P4,
and the only way to see any of it was to open the LIVE panel - where the hint
said, accurately, "the meters move while you are LIVE". So the mixer existed
and was invisible unless you were streaming. There is a Sound panel now, in the
deck and in the editor, built as `LivePanel`'s twin (`mount`/`open`/`close`/
`toggle`, an anchored popover, Escape and outside-click): both channels with
device, gain, mute and a meter, hearing yourself, and the talking threshold as
one number rather than a second copy.

**The meter needed a lease, and nothing but a scene ever took one.** `voice.py`
opens the microphone only while a page holds a renewable lease, and the only
holder in the app was `scene.js` (`holdVoice`, when a scene has a reactive layer
or any trigger). The inspector's meter free-rides on that, which is why its own
note says "the microphone opens while a scene uses your voice". A panel someone
opens *to look at their microphone* cannot free-ride on anything: it takes its
own lease and gives it back on close. Without that the meter is a painted-on
zero at exactly the moment it matters. The test pins it as `off -> monitor ->
off`, which works whether or not the machine has a microphone: `_reconcile`
reports `source: "monitor"` as soon as a lease exists, even where the device
fails to open.

**One meter is honest about being dead.** The microphone's level is available
any time, from the voice monitor. The desktop's is not: Windows hands the app
the mixed desktop sound only through the native mixer, and that runs only while
streaming. Rather than a bar that never moves, the panel says so.

**Hearing yourself is done in the page**, with `getUserMedia` into an `<audio>`
element and its own volume, off by default behind a headphones warning. The
alternative was a render path in `audio.py` for something the browser already
does, with the same feedback risk either way.

**The microphone layer reads its own level.** The feed carries `speaking` but no
level, and a meter wants thirty readings a second - an absurd thing to poll a
server for when the page can listen to the same device, which is what the camera
layer already does. Bars, one bar, or a waveform, from a WebAudio analyser.
It copies the camera's device discipline exactly: `visible` inside the
`mediaKey`, so hiding the layer releases the microphone; an `entry.gone` guard
for the race where the layer is deleted while Windows is still deciding; and an
`identity()` entry so a scene switch adopts it instead of closing and re-opening
the device. No server change was needed at all - `scenes.py` line 98 keeps any
layer type string, checked rather than assumed.

Four defects in the new code, all mine, and how each was caught:

| Defect | Caught by | Why it mattered |
|---|---|---|
| The `AudioContext` was never resumed | reading the runners and noticing `--autoplay-policy` | A page nobody clicked starts it suspended, and a scene output window is opened by the app - so the *normal* case was a meter permanently at zero, which I would have blamed on the rig having no sound |
| The draw loop rescheduled itself before testing Ultra | re-reading my own loop | It woke 165 times a second to return early - the exact waste `motion.js` exists to prevent |
| A gain slider's value was clobbered mid-edit | the test: mic gain stayed 1 while system took 0.8 | `paint()` rewrites every unfocused slider from the server's copy every 150 ms, so a reply landing inside the 80 ms debounce reset the slider and the debounce then sent that reset value. `system` survived by luck of timing. The inspector's threshold already had this guard; the gains did not |
| **`gap: 6%` gave every bar zero width** | the screenshot, and nothing else | 23 gaps of 86 px in a 1440 px box is more gap than box. Every bar flexed to nothing while its transform went on changing, so "24 bars", "30 different shapes" and "24 above the floor" all passed against a layer that rendered a black rectangle |

That last one is the one worth keeping. Reading `style.transform` from the DOM
cannot see that nothing was laid out, so the fix is not only the gap (scaled
from the bar count now): `soundpanel.js` measures `getBoundingClientRect()` and
requires real width - 24 bars, 52 px each, 1242 px across. The same shape of
fault as `p9_np.png` passing because it could not see the bottom of its own
inspector.

**What the test does not prove.** Chrome's fake device plays a pure tone, whose
energy sits in one low bin, so the picture shows the first bars tall and the
rest at the floor - correct for that input, and no evidence at all about how the
spread looks on speech. And there is no keyboard shortcut, on purpose:
Ctrl+Shift+A is Chrome's own tab search, so whether the page ever receives it
depends on the kind of window, and a headless test would pass either way and
tell me nothing.

Verified: `tools/ui/soundpanel.js` 20 of 20, P9 72 of 72, P6 21 of 21 and 22 of
22.

## S6 - the PNGtuber found, and triggers that mean something (2026-09-13)

Two things were asked for: a picture of you that changes when you talk, and the
camera frame lighting up while you speak. The first already existed and could
not be found. The second did not exist. Between them sat five actions and three
moments, of which two moments said the same thing twice and one action worked
with exactly one moment.

**Found.** The `reactive` layer is "You, talking" everywhere it is named, and it
leads the Add list across the full width with its own drawn glyph and the word
PNGtuber in the sub-line - "reactive image" being our word for it and nobody
else's. Its mark in the layer list was a smiling-face emoji, which is precisely
what icons.js's opening paragraph forbids; it is a stroked glyph now, like the
eye and the padlock it sits beside. The other seven type marks are geometric
symbols rather than emoji and go under S8's pass with everything else. Its
setup was already one screen and stayed one screen.

**Two moments, four actions, and the coupling gone.** While I talk holds; when I
start talking does the same thing once, for a beat. That beat is what "pop"
was - an action welded to one moment - which is why the editor had to keep the
two dropdowns in step behind your back: choosing pop moved the when, and moving
the when put the action back to "show it". Every action takes either moment
now, and the three lines that shoved the fields about are deleted. "While I'm
quiet" was the same sentence inverted and is gone; "add a style" asked for the
name of a CSS rule that had to exist somewhere else and is gone.

The glow is a `drop-shadow`, not an outline or a box-shadow, because
drop-shadow follows what is actually drawn: a round camera or a frame's ring
lights up on its own shape rather than inside a rectangle. The beat's classes
are kept separate from the held ones, because a layer diff landing mid-beat
would otherwise clear the class and cut it short.

**Old files come forward, and one case deliberately does not.** Scene version 2
migrates on load: silent+show becomes speaking+hide and silent+hide becomes
speaking+show, pop becomes a one-shot bounce, "add a style" is dropped. But
**bouncing while quiet has no equivalent and is dropped rather than inverted** -
the blanket "silent -> speaking" rewrite everybody reaches for first would have
turned it into its exact opposite. Two unit tests hold that, since it is pure
logic and costs nothing to pin down.

Two bugs fell out of the vocabulary work, both older than it:

| Bug | What it meant |
|---|---|
| `--bounce` fell back to `0px`, and only the PNGtuber layer ever sets it | A "bounce" trigger on a text, camera, shape or frame layer added the class and animated a movement of zero. The second-most-useful action did nothing on every layer type but one. |
| The Add list built the layer with `bounce: true` | `px()` is `Math.round(Number(n))`, so that is `1px` - a one-pixel bounce, on a slider offering sixty. (Predicted as the invalid `truepx`; reading `px` rather than assuming corrected that.) |

**And a golden that passed by not looking.** Eight of the ten goldens moved by
86 px - the trigger hint grew, and that section is in every inspector - and
`p9_face.png` by 164. `p9_np.png` matched at 0.00%. It should not have: Now
Playing carries the same section. The clip is `min(panel height, content + 12)`,
and measuring the live DOM gave panel 3351, content 3624, trigger section at
3359..3624 - **273 px of it outside the picture, and the whole section at that.**
That golden has never contained the trigger UI since the day it was written, and
an 86 px change to that very section left it matching perfectly. The goldens are
shot in a taller viewport now: np went 3351 -> 3620, the other nine matched at
0.00% (their clips were content-sized already, so a taller panel changes
nothing), and P9 is 72 of 72. The lesson belongs with S16 alongside S1's
scrollbar finding: a golden can pass because it cannot see, and only measuring
the clip against the content will say which.

**What was not built, on purpose.** The plan lists "swap picture" among the
actions. It is not one. Swapping a picture on your voice is what the "You,
talking" layer does properly - two assets, a blink, a bounce and a threshold
with a live meter - and a second, weaker swap living in a trigger row would
duplicate it badly. The triggers panel says so and points at the layer.

Two faults in the new test, both mine, both caught by reading its output rather
than its exit code. The bounce check read `translate` and asked whether the
string started with `0px` - but a vertical bob is `"0px -8px"`, so it always
does, and the check called a moving layer still while printing the very numbers
that proved it moved. And the first screenshot framed only the middle of the
scene: no device metrics were set, so the page centered an unscaled 1920x1080
inside a 1258x702 window. The DOM checks did not care, which is exactly how a
useless picture survives.

Verified: `tools/ui/voicetrig.js` 16 of 16, P9 72 of 72, P8 56 of 56, P10 24 of
24, the scene tests 16 of 16.

## S5 - frames belong to the canvas (2026-09-12)

Screen frame and Camera frame were windows with settings of their own, which is
exactly why they appeared not to work while a scene was being set up: nothing
done in the Canvas Builder touched them. They are layers now. `shape: frame`
already cut the hole; what it lacked was everything around the hole, so the edge
styles, the hole's shape and mode, the title plate, the four corner badges and
the decor loop moved across and are read from layer props. The pop-out pages
still work for anyone driving them through LIVE Studio, and their deck cards
moved to a "Windows of their own" group so the canvas is the obvious home.

**Lettering comes from the layer, not the viewport.** `frame.html` sizes its
text at `3.4vmin`, which is right for a window that *is* the viewport and wrong
inside a scene, where every frame would be lettered identically whatever size it
was drawn at. `frameDressing` works `--frame-em` out from the layer's own
transform instead - 3.4% of its short side, floored at 12px. Two frames on one
scene prove it: 16px on the 480x480 one, 24px on the 1200x700 one.

**What was broken in the pop-out, found on the way.** `.badge` was a fixed 26px
circle, so a badge reading LIVE spilled straight out of it. Pre-existing, and
invisible until a layer drew the same badge beside it. `min-width` with padding
and a 999px radius fixes both at once, and a one-character badge stays round.

Three defects introduced in this step and caught before it shipped:

| Defect | Caught by | Fix |
|---|---|---|
| The frame panel showed for every shape, box and line included | re-reading my own edit | `data-show` on the `<details>`, through a new fourth argument to `section()` |
| Badges placed off `--ring-inset` and `--decor-px` | the picture - they floated inside the ring instead of sitting on it | those are different quantities, and `--decor-px` is not set until `applyDecor` runs; back to `pad + bw/2`, and `pad + 15%` on a circle |
| `frameDressing`'s fourth argument changed meaning; its callers did not | re-reading the edit before running it | signature and calls put back in step |

**The inspector's section list, and why the expectation stayed at five.** P9
reads `Editor.inspector().secs`, which counted every `details.sec` in the DOM.
The frame panel sits in the DOM for every shape and is shown only for a Frame,
so a Box read six sections and the row failed. Adding `frame-edge` to the Box
expectation was the small change and the wrong one: it documents a panel the
user cannot see, and it would go on passing if the `data-show` broke and the
panel appeared for everything. `secs` filters on `hidden` now, and `p9test.js`
306 asserts the panel *arrives* when the shape becomes a Frame - `frame panel
true`. Nine rows unchanged, Box still five, and a broken `data-show` now fails
the suite. `frame-edge` is the only section carrying a `data-show`, so nothing
else moved.

`p9_box.png` was nearly deleted on the assumption that a new section must move
the golden. It does not: a hidden `<details>` takes no layout at all. Deleting a
reference image to fix a failure it had no part in would have thrown away the
only record of what that inspector used to look like. Left alone, it compared
clean.

**The `?` badge: a claim withdrawn, then reinstated.** Earlier the `?` in the
camera frame's corner was called a failed glyph, then withdrawn as "the user's
own text". It was neither the user's text nor a font failure. `p6run.sh` sets
that badge to a sparkle and holds real UTF-8 for it, but `curl.exe` reads the
ANSI command line, where that character has no cp1252 form - so the server was
handed `?` and stored `?`. Proven without the app in the loop: a throwaway echo
server recorded `b'{"bl": "?"}'` from a `-d` payload, while the same bytes
through a pipe arrived whole. The payload goes over stdin now, the stored value
reads `✨`, and the shot draws the sparkle. The app was never at fault - the
deck posts config with `fetch` + `JSON.stringify`, UTF-8 by definition - and no
other shell script in `tools/` hands non-ASCII to curl.

**The check this step was to be judged by has not been run.** The plan asks for
the frame layer around a *native capture hole*, captured by WGC and compared
against the pop-out page. What was run is page-side: `tools/ui/framelayer.js` 13
of 13, and the layer photographed beside `frame_camera.png` and
`frame_screen.png`. A CDP screenshot photographs Chrome's rendering, not what
the native compositor keys into the stream, so it is structurally unable to see
the divergence that check exists to catch. Running it needs a visible, composed
window (WGC delivers nothing while DWM is idle) on a one-monitor machine, and
`p5native.py` records the microphone and system audio into a file it leaves
behind. It is the user's to run, and it is listed for them rather than quietly
swapped for something easier.

Unrun is not unchecked, though. It was written against S5's server and S9 to
S18 moved a great deal of that, so every call it makes was read against the
server as it stands: the ten endpoints all still answer - the component and
scene ones through the routers at `server.py:2800` and `2633` rather than as
literal paths, which is why a first grep for them said they were gone -
`live_start` still returns `path="native"`, `NATIVE.status()` still carries
`sources[].frames` with `fps` and `dropped`, `overlay.open()` still returns
`hosted: true`, and every frame prop it sets is one `scene.js` reads. Its
ffmpeg is where `FF` points, RTMP 1935 is free, and `frame_camera.png` is
there to compare against.

One trap, found by reading rather than running: `overlay.open()` answers
`{"ok": true, "already": true}` with no `hosted` key when the window is
already up, so a run that was interrupted leaves the live output open and the
next run fails its first check for that alone. Close the live output first.

Verified: P9 72 of 72, P10 24 of 24, P6 21 of 21 and 22 of 22, pickertest 19 of
19, `framelayer.js` 13 of 13 twice.

(Also found here, filed on its own: `p5min.py` and `p5park.py` look for `wgc.py`
in their own folder, while the only copy in the repo is in `tools/p0/`. Done -
and it was six files and thirteen references rather than two: see "The tools
could not find each other".)

## S4 - the cards (2026-09-12)

"The buttons here look bad." They did, for two reasons neither of which was the
one written in the plan - which said the three buttons were crammed in a row
beside the size. They were not: `deck.css` 1079-1080 already wrapped the scene
card's footer and gave the size a row of its own. Photographing the strip first
was what found the real faults, and it is the only reason this entry is right.

| What the picture showed | Why |
|---|---|
| "Edit" stranded alone on a second row beside a block of dead space, the three buttons all different widths | Three buttons do not fit one 226 px row, so the wrapping flex broke them 2 + 1 |
| Six Open buttons at four different heights along the bar | Component descriptions wrap to one or two lines, and the footer followed the text down |
| "CLOSED" as bare gray capitals in a corner | It was a label, not a state |
| Eighteen solid accent buttons with a glow, all shouting equally | One primary is a call to action; a strip of them is wallpaper |

All four fixed in CSS alone, so the markup - and with it the paint contract -
is untouched: `paintSceneCards` and `paintCardState` still find `.wc-state`,
`[data-act="scene-open"]` and `[data-act="scene-live"]` by selector and rewrite
their text. The scene footer is a two-column grid with the main action spanning
both and the other two sharing the row beneath; `.wc-foot` gets `margin-top:
auto`; `.wc-state` becomes a pill; and the primary inside a card is
accent-tinted rather than solid with a glow, `.btn-primary` being left alone
everywhere else in the deck.

**A regression introduced here and fixed here.** `margin-top: auto` is right
for a component card and wrong for a scene card. Every card in the strip
stretches to the tallest, and a scene card has no description to fill the
difference - so the slack that used to sit harmlessly at the bottom opened as a
hole between the name and the buttons, on all twelve. Twelve cards with a hole
in them is worse than the ragged wrap it replaced. The pinning is scoped to
component cards now; scene cards all share one shape and line up with each
other anyway, and the two groups sit in separate labeled sections where their
footers were never meant to align.

Verified: component-card buttons at `tops [324 x6], spread 0px` (four different
heights before), the paint hooks still writing (`stateText "closed"`,
`openText "Open output"`, `liveText "Go LIVE"`), the head row not wrapping at
1000 px or 820 px with the chip's new padding, and P6 22 of 22 with no console
errors. Before and after pictures at 2x and 4x, which is how both the original
faults and the hole were found.

**And the S2 leftover, closed.** The deck's reset dots were never broken:
photographed at 3x they draw a crisp centered arrow, exactly as the mask at
`deck.css` 703-712 intends. Every reading against them was `inkcenter.js`
filtering out elements at negative coordinates but not ones below the fold - so
their clips fell outside the viewport and photographed nothing, which the sweep
reported as "nothing drawn in it". There are 17 of them, not the 8 that happened
to be measurable in one run. The viewport filter is fixed.

The method note worth keeping: this step photographed the thing before changing
it, and the pictures corrected the plan twice - once about what was wrong, once
about what the fix broke. The measuring in S2 did neither.

## S3 - the output window you can move and shut (2026-09-12)

The complaint: open a scene's output and there is no way to drag it anywhere or
close it. True, and the reason is deliberate - `hostwin.py` 25-34 builds these
windows `WS_POPUP` with **no `WS_CAPTION`**, borderless on purpose, because a
title bar would be captured into the stream.

**But the answer to that was already written.** `windowctl.js` opens by saying
it: "They have no title bar, so moving and resizing happen by forwarding
pointer deltas to the server, which drives the host window with Win32 calls."
It gives whole-window drag, eight-way resize, minimize and close, batching
deltas at 25 Hz. The four component pop-outs and both frame windows have used
it since they were written. `scene.html` **loads that script** (line 20) and
never called `attachWindowControls`. The one window a scene actually goes out
of was the one window with no controls.

So this step is a port, not a design. What differs from `frame.html`, which is
otherwise the model:

- **The overlay is a sibling of `#root`.** `fit()` (`scene.js` 810-819) gives
  `#root` a `transform: scale(k)` and computed `left`/`top`; anything inside it
  would scale with the picture and miss the window's real corners. `frame.js`
  never met this because its stage is not transformed.
- **Hover keys off the body, not the stage.** `frame.css` uses
  `.stage:hover .handles`, which only works because its handles sit inside the
  stage. With the overlay outside, that selector can never match - so the body
  is the drag surface, which also gives the first-open hint's class somewhere
  the stylesheet can see it.
- **Off unless switched on.** The CSS hides `.handles` outright and `scene.js`
  adds `has-winctl`; a scene that renders without its script cannot put buttons
  on a stream. Gated on `!PREVIEW && !window.EMBED`.
- `--frame-color` does not exist on a scene page, so the hover tints it drove
  are literals here rather than a variable resolving to nothing.

The backend needed no work: `canvas.outputs` is keyed `"scene:<id>"`,
`scene.js` already computes `API = '/api/components/scene:<id>'`, and
`window_action` serves nudge, edge, minimize and close for any component.

Measured against a real window, opened **parked** (off every screen - there is
one monitor here and it is the user's):

| Asked | Got |
|---|---|
| `nudge` (40, 25) | x 60,60 -> 100,85. Moved by exactly (40, 25) |
| `edge` (30, 20) from `br` | 1920x1080 -> 1950x1100 |
| `close` | shut, `open` false |

Front end: `tools/ui/ctlgate.js`, 11 of 11 - nothing switched on in the
preview, the overlay shown but `pointer-events: none` in a standalone output
with `auto` on both buttons and all eight edges, the overlay outside the scaled
box, and the hint appearing and clearing itself. Then P10 24 of 24, P9 72 of 72
and `pickertest` 19 of 19, all three of which load `scene.html` as the editor's
preview and would have caught buttons appearing over it.

**Two mistakes worth keeping.** The first probe of the backend asked a scene
output to nudge with no window open, got `{"ok": false, "rect": null}`, and the
control built to catch that - the same call against a component that has always
worked - returned the same thing. It proved only that neither can move a window
that is not there. Open the window first.

The second cost more. `ctlgate` first reported the controls switched on in the
editor's preview, which looked like the exact regression this step could cause.
It was the harness: every CDP tool here opens a page with
`fetch('/json/new?' + encodeURI(url))`, and `encodeURI` leaves `&` alone, so
`scene.html?id=X&preview=1` reaches `/json/new` as two parameters and the page
loads as `scene.html?id=X` with the flag stripped. Reordering to
`?preview=1&id=X` passed, which is what gave it away. The tools written in this
plan use `encodeURIComponent` now; the project's own suites still do not, and
are booked at S17b rather than rewritten mid-step.

And a correction: this session twice claimed `scene.html` does not load
`windowctl.js`. It does, line 20. The claim rested on an S1 grep for
`rel="stylesheet"`, which could never have shown a `<script>` tag - a search
that could not have found the thing it was cited as ruling out.

## S2 - the centering bug that was not there (2026-09-12)

The ask was to check every error mark is centered in its button. It is. The
step is worth writing down anyway, because most of it was spent proving a
premise wrong.

**Why it needed measuring at all.** Comparing the icon's rect to the button's
rect only catches layout, and would call the warning emoji perfectly centered:
a glyph sits inside a line box that is itself centered, while the ink inside
that box need not be. So `tools/ui/inkcenter.js` measures ink - each mark is
screenshotted, the dominant color taken as its own fill, everything far enough
from that counted as ink, and the middle of the ink compared with the middle of
the box. There is no imaging library here (`capture._png` writes PNGs by hand),
so it carries a small PNG decoder over node's zlib.

**The first version reported 21 of 21 centered, and that was a false
all-clear.** It selected `button, [role="button"], summary` - but the two marks
the step exists for are a `<div class="zone-badge">` and a
`<span class="row-warn">`, neither of which is a button, and both of which only
exist on a *phone* scene with a layer under TikTok's comments. The reset dots
were sealed in a collapsed `<details>`, and the align bar needs a layer
selected. It measured whatever happened to be on screen and passed. Rewritten
to choose marks by shape (a lone `<svg>`, or one or two characters that are not
words), to arrange the page so the marks exist, and to print coverage - a
narrow sweep must not be able to look like a pass.

**The first calibration was also worthless.** It "nudged" the badge with
padding on a fixed 20x20 grid box, which moves nothing; the measurement came
back identical three times, which was the tell. Done properly with synthetic
controls - a 6 px dot placed by hand at (0,0), (3,2), (-4,0) and (0,-3) - the
tool returned each offset exactly. It works.

**The answer: 36 of 36 marks centered within 1 px.** Nothing in the deck or the
editor is off center. The codebase had already solved this properly at
`deck.css` 703-712, where the reset dot's mark is a mask cropped to the icon's
own bounds rather than a typed glyph, with a comment saying exactly why: "a
glyph sits wherever its font puts it, which is rarely the middle."

**So the only real change is the two warning emoji.** `icons.js` opens by
warning against emoji - they render differently on every machine and look by
turns childish and broken - and then `canvas.js` and `canvastools.js` used one.
They are `svgIcon('warn')` now. The glyph is filled with the mark punched out
rather than stroked, because at 13 px on an amber chip an outlined triangle
holding a separate exclamation turns to mush; that needed a small `EVENODD` set
in `svgIcon`, added the way `STROKED` was rather than special-cased.

Verified: P10 24 of 24 (it counts `.zone-badge` elements and tests for
`.row-warn`, never the character, so it proves the swap kept working), P9 72 of
72 with no golden moved - `.row-warn` is in the layer tree and `.zone-badge` on
the canvas overlay, while P9 clips to `#inspector` - `pickertest` 19 of 19, and
the sweep 36 of 36, where both marks now read as `svg` rather than
`glyph "⚠"`.

**Left unresolved, and honestly so.** The deck's eight `.reset-dot` buttons.
Two probes found them absent from the page entirely; the sweep finds all eight
present and painting nothing, at ink thresholds of 40, 20 and 10. In the same
run, a `::before`-with-mask control of my own rendered and measured perfectly,
so `Page.captureScreenshot` handles the technique. The observations contradict
each other, which makes the measurement unreliable rather than the button
broken. It is deck-side, pre-existing, and untouched by anything here, so it is
booked at S4 rather than guessed at a sixth time.

The toast at `newscene.js:215` still says "marked ⚠" in its text. That is
prose, not a control, and stays.

## S1 - scrollbars, and what they were hiding in the goldens (2026-09-12)

First step of the Stream Deck plan (`docs/STREAM_DECK_PLAN.md`). The Canvas
Builder was showing Chrome's own Windows scrollbar - pale track, arrow buttons -
in a near-black panel, looking like a piece of another program showing through.

`deck.css` had styled them from the beginning and nothing else had. There is no
shared stylesheet in `web/`, so the rule moved to a new `base.css`, linked
*before* each page's own sheet so a page can still override it - the deck hides
the bar on its window strip exactly that way, and that override still works
because `deck.css` comes second.

Three pages link it: the deck, the Canvas Builder and the scene remote
(`remote.css` `.rm-list` scrolls and had nothing either - the next place you
would have hit it). The LIVE panel scrolls too and belongs to both the deck and
the editor, so it came along. `scene.html` and every overlay page are
`overflow: hidden` throughout and render onto the stream, where a scrollbar
would be a visible defect: deliberately left alone, checked rather than assumed.

Two decisions worth keeping:

- **The `::-webkit-` properties only.** Chrome supports the standard
  `scrollbar-width` / `scrollbar-color` as well, and when both are set the
  standard pair wins and quietly replaces the 10 px thumb with a hairline. The
  app ships its own Chrome.
- **The deck's colors unchanged to the byte.** The thumb is faint and could
  stand to be more visible, but P6 photographs the deck and there was no reason
  yet to believe those shots were safe. Checked afterwards: `p6test.js` captures
  to its output folder and never compares (same as P8), so the visibility tweak
  is a known-safe follow-up rather than a gamble.

**What it turned up, which is the useful part.** P9 came back 71 of 72: the Now
Playing inspector's golden no longer matched. Two explanations were wrong before
the right one. First: taller content reflowing the clip - no, every golden is
the same size to the pixel, `np` included (300x3351). Second, from that: no
reflow at all, so something else must have changed - also wrong.

Measured instead of guessed (a stdlib PNG differ; there is no imaging library
here, `capture._png` writes PNGs by hand). 6.51% of pixels differ against a 1%
threshold, in two parts:

| Where | Why |
|---|---|
| x 285-298, on **every** one of 3351 rows | The scrollbar is *inside* the shot. `#inspector` is 300 px wide including its bar, and the clip is that whole width, so Chrome's 15 px default was in the picture and our 10 px thumb replaced it. |
| Scattered from x 15 rightward | The narrower bar handed the content five more pixels, so every `width: 100%` control shifted sideways. Their heights do not depend on five pixels, which is why the height never moved and the size check waved it through. |

Both are the intended change, so `p9_np.png` was regenerated - that one only,
the other nine left under comparison, and P9 is back to 72 of 72.

The finding that outlives this step: **the goldens contain the inspector's
scrollbar**, so any future scrollbar change silently breaks the suite with no
size difference to warn anyone. `HIDE_DYNAMIC` already hides the live note, the
meters and the save state for stable shots; the bar belongs in that list. That
means rewriting all ten, so it is booked for S16, which has to rewrite them
anyway for the inspector's type.

Verified: `tools/ui/scrollprobe.js`, 12 of 12 - on each of the three pages,
`base.css` is linked, a synthetic `overflow: scroll` element measures 10 px
rather than Chrome's 15-17 (which works whether or not the page happens to
overflow just then), and `--fg` resolves, because `base.css` paints the thumb
with `color-mix(... var(--fg) ...)` and on a page that never defines it the
whole declaration would be invalid and the thumb would quietly revert.

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
changed in the slice before this one (relabeled control, the native-mode hint
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
confirmation was the word "Saved" at 12 px in gray in a corner - which reads,
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
