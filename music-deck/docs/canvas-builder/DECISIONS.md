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
| 4 | Capture engine for screen, window, game and camera | Windows Graphics Capture, the API OBS and Discord use. Proven from Python with ctypes alone at ~0% CPU (frames stay on the GPU). Inside scene pages, Chrome's `getDisplayMedia` (also WGC underneath) with `--auto-select-window-capture-source-by-title` opens the source with no picker. Default architecture: **Chrome captures, composes and encodes; Python muxes RTMP and controls.** P1 measures it end to end; the fallback is a native compositor (WGC textures + chroma-keyed Chrome overlay) if Chrome's path misses the budget. |
| 5 | Encoding | WebCodecs in Chrome: H.264 High (1080p60 and 1080x1920 portrait) and HEVC on the GPU, AAC-LC 48/44.1 kHz - all reported supported, and 60 frames of 1080p encoded in 1.1 s including setup. Presets copied from LIVE Studio's own table. No ffmpeg bundled (a GPL 94 MB build sits in Downloads; fine as a test sink, not shipped). |
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
