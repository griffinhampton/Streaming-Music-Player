# Canvas Builder - build plan

A separate, connected page where you compose the deck's components and new
sources into full stream layouts: a **horizontal canvas** (1920x1080) and a
**phone canvas** (1080x1920, TikTok LIVE portrait). It works like OBS
(sources, scenes, live output) crossed with Photoshop (layers, transforms,
effects, snapping). It adds text, GIFs, video, backgrounds, images that
change when you speak, a camera, screen and window capture, frames for
streamed content - and it can go LIVE to TikTok straight from the app with
your stream key, no LIVE Studio or OBS in the loop. It is built on a
component registry, so new components keep being added later.

**Order of work (the user's rule):** backend, streaming engine, optimization
and architecture first, frontend last. **Models:** run P1-P5 and P12 with
**Fable** (architecture and backend), P6-P11 with **Opus** (frontend). Pick
the model in the app before pasting the prompt.

**How to use this file:** run the prompts below **one at a time, in order**.
Paste a prompt into Claude Code as written. Each builds on the ones before it
and ends with a commit, so the app works after every step. Tick the box when
a step has landed. P0's findings live in `docs/canvas-builder/DECISIONS.md`;
every later prompt reads it first.

| # | Step | Model | Status |
|---|------|-------|--------|
| P0 | Groundwork: capture, permissions, limits, encoders measured; decisions written | Fable | [x] 2026-09-11 |
| P1 | Streaming engine spike: capture -> encode -> RTMP, measured, go/no-go | Fable | [x] 2026-09-11 |
| P2 | Server architecture: registry, feeds + WebSocket, scene store, assets, outputs, capture sources, voice, key vault | Fable | [x] 2026-09-11 |
| P3 | Scene runtime: renderer engine, embed mode, live sources, reactive images, transitions, budgets | Fable | [x] 2026-09-11 |
| P4 | Go LIVE engine: encoder presets, audio, health, reconnect, scene switching API | Fable | [x] 2026-09-11 |
| P5 | Optimization and hardening of the backend | Fable (part 2 on Opus) | [x] 2026-09-12 |
| P6 | Deck integration: scrollable components row, screen-share group, Canvas Builder entry, LIVE strip | Opus | [x] 2026-09-12 |
| P7 | Canvas Builder editor shell | Opus | [x] 2026-09-12 |
| P8 | Canvas tools: transform, snapping, guides, groups, shortcuts | Opus | [x] 2026-09-12 |
| P9 | Inspectors for every layer type and source | Opus | [x] 2026-09-12 |
| P10 | Phone canvas: safe zones, templates gallery, format conversion | Opus | [x] 2026-09-12 |
| P11 | Go LIVE panel, studio mode, scene remote | Opus | [x] 2026-09-12 |
| P12 | Release: QA, import/export, docs, build | Fable, then Opus for UI fixes | [ ] |

---

## Standing rules (every prompt includes these by reference)

- Local-first: the server binds `127.0.0.1` only. No audio or video leaves
  the PC except the RTMP stream the user starts on purpose. Nothing
  downloads without an explicit press, and none of these steps need one.
- The stream key is a secret: stored DPAPI-encrypted in `cache/`, masked in
  the UI, never logged, never in a commit. Secret-scan before every push.
- US spelling in code and UI. Match the surrounding code's style and comment
  density.
- Test on the isolated copy (`scratchpad/testrig`, port 8799,
  `server.py --no-open`, started with the Bash tool's `run_in_background`),
  never on the real app. Headless-Chrome screenshots over CDP for visual
  checks; window geometry must pass the DPI-aware `tools/p0/windiag2.py`;
  capture checks with `tools/p0/wgc.py`; CPU with `tools/p0/cpuby.ps1` and
  the scratchpad `chrometype.ps1`/`abtest.ps1` on real windows.
- Performance is a feature: the target is about 5% total CPU on a 16-thread
  laptop with a 165 Hz screen. Endless motion runs at 30 fps (motion.js),
  Ultra optimized stops all motion, nothing ticks while hidden. Budgets are
  in DECISIONS.md; every step reports its numbers in the commit message.
- Never pop topmost windows open while the user may be gaming. Output
  windows may be parked off screen (proven to render and capture there).
- Don't use multi-agent Workflow runs unless absolutely needed. Self-review
  and rig tests are the default.
- Never commit `config.json`, `cache/` or tokens. Commit and push at the end
  of each step and watch CI.
- Keep every existing feature working: the four pop-outs, captions (CPU and
  GPU), Spotify, lyrics, Ultra mode and the deck preview.

## Architecture at a glance

```
deck.html (control room)             canvas.html (editor, P7+)
  components row (registry)            layers / sources / inspector / LIVE panel
        |                                     |
        +--------- server.py (127.0.0.1:8713) ---------+
          COMPONENTS registry   SCENES store   ASSETS   VOICE   CAPTURE sources (WGC)
          /api/events (SSE, one per page)   /ws (stdlib WebSocket: media + feeds)
          LIVE engine (live.py): FLV mux + RTMP client -> TikTok (Server URL + Stream key)
            video: capture.py (Windows Graphics Capture) -> mfenc.py (the GPU's own
                   H.264 encoder through Media Foundation) -> nativelive.py, no pixel on the CPU
            audio: the output page's AAC over /ws (P4 may move it native: WASAPI + MF AAC)
                                |
                     scene.html?id=...  (output window, any size, may sit off screen)
                       layers: components (embed mode, fed by postMessage), text,
                       images/GIF/video, backgrounds, shapes, effects, camera,
                       window/monitor capture (getDisplayMedia, auto-selected),
                       reactive images (VOICE)
                       when LIVE: the server captures this window natively (above)
             or captured by LIVE Studio (Window capture / Browser capture link)
```

## Settled in P0 (details and numbers in DECISIONS.md)

1. Chrome's 6-connections-per-host cap is real and SSE counts: one feed per
   page, embedded components over `postMessage`, WebSocket for media and
   extra feeds.
2. Window capture never carries alpha; see-through overlays for LIVE Studio
   go through its Browser capture (Link) source, key color as fallback.
3. A hosted window can be 1080x1920 and fully off screen and still renders
   and captures at 55 fps; size the host first, resize Chrome after adoption.
4. Camera/mic: the app seeds its Chrome profile's content settings for its
   own origin, so no prompts. Screen/window capture: auto-select flag, no
   picker.
5. Encoding: WebCodecs H.264/HEVC on the GPU and AAC are available in this
   Chrome; the machine has NVIDIA, AMD and Microsoft encoders.

## Settled in P1 (numbers in DECISIONS.md, "P1 - the streaming engine")

1. **The native path is the engine.** Chrome's own capture-and-encode
   (getDisplayMedia or tab self-capture -> WebCodecs) costs 37% of one core
   at 720p30 and 58% at 1080p30 whatever the capture method, because frames
   are copied between its processes. Capturing the output window with
   Windows Graphics Capture and encoding on the same GPU through Media
   Foundation (`capture.py`, `mfenc.py`, `nativelive.py`) costs ~10-14% of
   one core at either size, 30 fps, no drops. Audio comes from the page for
   now (~7-9% of one core in Chrome).
2. The encoder is the one on the adapter the desktop runs on (here the AMD
   integrated GPU, which takes RGB32 textures directly); the NVIDIA MFT
   refuses to activate in a process whose device is the other GPU. Chrome's
   WebCodecs stays as the fallback when no hardware MFT accepts the device.
3. `live.py` holds the FLV/RTMP publisher (handshake, publish, acks, pings,
   extended timestamps, clean unpublish, reconnect with backoff, key vault
   through DPAPI) and the stdlib WebSocket; TikTok's presets are the table.
4. Hosted output windows must be exactly the stream size: WGC trims a plain
   window's invisible 6 px borders, a frameless host has none.

---

## P1 - Streaming engine spike: capture -> encode -> RTMP (Fable)

```text
Canvas Builder step P1. Run with Fable. Read music-deck/docs/CANVAS_BUILDER_PLAN.md (Standing rules) and
docs/canvas-builder/DECISIONS.md first. Goal: prove, with numbers, that the app can go LIVE to TikTok by itself:
a page captures and encodes, the server muxes and pushes RTMP. No UI polish, no scene features - a spike that
becomes the seed of P4.

- web/stream-spike.html: grabs a source with getDisplayMedia (window auto-selected by title through the existing
  pop-out flags; also accept a <canvas> test pattern), MediaStreamTrackProcessor -> VideoEncoder (avc1.640028,
  annexb, latencyMode realtime, hardwareAcceleration prefer-hardware, keyframe every 2 s) at the LIVE Studio
  presets from DECISIONS.md (default 720p30 3400 kbps); mic via getUserMedia -> AudioEncoder mp4a.40.2 48 kHz
  128 kbps; optional system audio via getDisplayMedia audio. Chunks + codec descriptions go to the server over a
  WebSocket as binary frames with a tiny header (type, timestamp, keyframe).
- server.py: a stdlib WebSocket endpoint (RFC 6455 handshake, masked frames, ping/pong, close) on the same port
  behind _trusted(); an FLV muxer (AVC sequence header from SPS/PPS, AAC sequence header, tags with
  composition time); an RTMP client (handshake, connect, releaseStream/FCPublish/createStream/publish,
  chunking 4096, window ack, onStatus handling, clean unpublish) with reconnect and backoff; a stream-key vault
  (DPAPI via ctypes CryptProtectData, file in cache/, key never logged or broadcast).
- Tests on the rig: use the ffmpeg in Downloads as a local RTMP sink (`ffmpeg -listen 1 -f flv -i
  rtmp://127.0.0.1:1935/live/test -c copy out.flv`), stream 60 s at 720p30 and 1080p30, then ffprobe the file
  (fps, bitrate, keyframe interval, A/V sync). Measure CPU with tools/p0/cpuby.ps1: Chrome (capture + encode)
  and the server (mux + socket) separately, at 720p30 and 1080p30, 5 minutes each, memory flat. If the user
  wants, one real 2-minute LIVE with their key (they paste it; it is never printed).
- Write the numbers and the go/no-go into DECISIONS.md: Chrome path vs the native fallback (WGC textures +
  chroma-keyed overlay, NVENC via Media Foundation) - build the fallback only if the Chrome path misses the
  budget (<= 15% of one core total at 1080p30). Commit and push.
```

## P2 - Server architecture (Fable)

```text
Canvas Builder step P2. Run with Fable. Read the plan and DECISIONS.md. Goal: the backend every later step
stands on. No new UI beyond what keeps the deck working. server.py is already 2000 lines: split new work into
modules (components.py, feeds.py, scenes.py, assets.py, capture.py, voice.py, live.py) with server.py wiring them.

- COMPONENTS registry: id, label, page, config section, default size, host title, capabilities. Replace the four
  hardcoded Overlay objects and per-window routes with /api/components/<id>/<action> through window_action;
  keep the old URLs as aliases (deck, scratchpad scripts and rebuild.ps1 use them). Registry in the snapshot.
- Feeds: keep /api/events (SSE) for existing pages; add a WebSocket feed on /ws (from P1) that carries the same
  snapshot deltas, for output windows and anything past the cap; a per-page feed budget check with a clear log
  line when a page would be the 7th.
- Output-window manager: open any registered page or scene at any size (size the host first, resize Chrome after
  adoption - the P0 rule), remember position, allow parking off screen, heal/watchdog as today, windiag2 clean.
- Scene model (versioned JSON): id, name, format (horizontal 1920x1080 | phone 1080x1920 | custom), background,
  transparency mode (opaque | see-through | key color), ordered layers: id, type, name, visible, locked, group,
  transform (x, y, w, h, rotation, anchor), style (opacity, blend, radius, border, shadow, blur, crop), props,
  triggers. Store in cache/scenes/<id>.json, atomic writes, last-5 backups, validation with clamping, migration.
- Asset library v2 on AssetStore: images, GIFs, webm/mp4, size limits, hash dedupe, thumbnails, usage counts.
- Capture sources: extend capture.py (P1) - list windows and monitors (title, process, size), one-shot
  thumbnails on demand (a WGC frame read back once), never a running capture unless asked.
  /api/capture/sources. Live engine modules from P1 (live.py, nativelive.py, mfenc.py) get their routes here.
- Camera/mic self-grant: seed content_settings for the app's origin in the pop-out Chrome profile before the
  first output window opens (P0 method), idempotent, port-aware.
- VOICE state {level, speaking}: from the caption engine while it runs, else a tiny on-demand sounddevice level
  monitor (50 ms blocks, attack/hold/release) that runs only while a client asked for it; broadcast changes of
  speaking, level at a low rate only while a meter is open.
- API: scenes CRUD + duplicate, assets, capture sources, voice, live (status, start/stop stubs), all behind
  _trusted(). Python unittest for schema/migration/atomic writes/dedupe/registry/feeds, run in the build env.
- Rig: all four components open through the registry and align; snapshot unchanged for the deck. Commit and push.
```

## P3 - Scene runtime (Fable)

```text
Canvas Builder step P3. Run with Fable. Read the plan and DECISIONS.md (P2 lists the modules and routes you build
on: scenes.py schema and /api/scenes, /ws/events for the feed, components.py for outputs, capture.py sources,
voice.py). Goal: web/scene.html?id=<scene> (a placeholder today) renders any scene exactly and cheaply, as an
output window and as the thing that goes LIVE. Scenes are authored as JSON templates for now (no editor yet).

- Renderer engine: a layer-type registry (create(el, props) / update(props) / destroy), the scene laid out at
  native resolution and scaled with one transform, only changed layers re-rendered when the revision changes.
  Types: background (solid, gradient, image with blur/dim, scenes.js generative), text (FontStore fonts, fill/
  stroke/shadow, auto-fit, live variables {title} {artist} {album} {time} {caption}), image/GIF/video (fit, crop,
  flip, loop/mute, Ultra freezes GIFs via stillOf and pauses video), shapes (rect, rounded, ellipse, line, frame
  with a hole), effects (opacity, blend, radius, border, shadow, blur, the decor.js border loop), component
  (embed mode), camera, capture (window/monitor), reactive image.
- Embed mode for nowplaying/lyrics/queue/captions: ?embed=1 = no window handles, no feed of its own, state and
  design by postMessage from web/embedhost.js (one feed per scene, throttled, children ack); transparent body;
  per-instance options: card background on/off, opacity, border/shadow, hide parts. Standalone pages unchanged.
- Live sources inside a scene: camera (getUserMedia, device, resolution/fps caps, mirror, mask shape) and
  capture (getDisplayMedia with the auto-select flag driven from the capture.py source list), video elements
  exist only while the layer is visible, a "live" indicator flag in state. Measure both; if a window source
  through getDisplayMedia costs too much, P4 can composite it natively instead (WGC texture under the
  key-colored output window).
- Reactive image + triggers on VOICE: idle/talking/blink images, bounce, threshold and hold; show/hide/swap/
  animate "while speaking" and "on speech start" for any layer.
- Transitions and "the live scene": an output can follow the live scene id; switching swaps in place with a cut
  or a 30 fps stepped CSS crossfade, never a window re-open; motion.js rules and Ultra everywhere; hidden = idle.
- Templates: four starter scenes as JSON with bundled assets (just chatting, music + lyrics, gaming portrait,
  gaming landscape) and TikTok portrait safe-zone data in the scene format.
- Tests: rig screenshots of both formats and every layer type (golden shots), windiag2 on a 1080x1920 output,
  WGC capture of the output shows the whole scene, CPU A/B: Now Playing + Captions embedded vs as pop-outs
  (must not exceed), a 720p30 window source and a camera source measured, reactive image latency (< 150 ms with
  a synthetic voice source), 20 scene switches with no flicker. Commit and push with the numbers.
```

## P4 - Go LIVE engine (Fable)

```text
Canvas Builder step P4. Run with Fable. Read the plan, DECISIONS.md and the P1 numbers. Goal: turn the spike into
the app's LIVE engine, ready for a UI later.

- live.py: start/stop, state machine (idle, connecting, live, reconnecting, failed) broadcast in the snapshot
  (never the key), presets table (1080P60/1080P/720P60/720P/480P with the H.264 and HEVC bitrates from LIVE
  Studio), encoder choice with fallback (GPU H.264 -> software), keyframe interval 2 s, health stats (bitrate,
  encoded/dropped frames, queue depth, RTT), reconnect with backoff and the "stream key updated" case surfaced
  as an error the UI can show, clean stop that unpublishes.
- Audio: mic + optional system audio, per-source gain and mute, a simple mixer in the output page (AudioContext),
  meters at a low rate; nothing recorded.
- The output window goes LIVE through the native path from P1: the server captures the hosted window with
  Windows Graphics Capture and encodes on the GPU (nativelive.py); the page only supplies audio. Encoder choice
  per adapter (the desktop's GPU first, NVIDIA when the desktop runs on it, then Chrome's WebCodecs as the
  fallback), GOP and rate control through ICodecAPI (look the GUIDs up, the keyframe spacing hint on the media
  type is ignored by the AMD encoder), a forced keyframe after every reconnect, and the audio/video clock from
  P1 kept. Audio: measure a native WASAPI (mic + loopback) -> MF AAC path against the page's audio and keep the
  cheaper one. The slow server memory growth seen in P1's soak (~3 MB/min) must be found and fixed here.
  Scene switching while live keeps the encoder running.
- Key vault: paste once, DPAPI-encrypted, "forget key", masked in every response; server URL stored alongside.
- Scene remote API: /api/live/scene, next/previous, list; the deck's snapshot carries the live scene.
- Tests: 30-minute rig stream to the local ffmpeg sink at 720p30 with two scene switches and one forced
  disconnect (kill the sink and restart it) - the stream resumes; CPU and memory logged every minute and flat;
  ffprobe of the file clean. Commit and push with the numbers.
```

## P5 - Optimization and hardening of the backend (Fable)

```text
Canvas Builder step P5. Run with Fable. Read the plan and DECISIONS.md. Goal: the backend meets every budget
before any frontend is built on it.

- Measure on real windows (chrometype.ps1/abtest.ps1 pattern) each template scene idle, animated, with a camera,
  with a window source, and while LIVE at 720p30 and 1080p30; fix the top costs; confirm Ultra and hidden go
  idle; confirm the feed cap logic (deck + 4 pop-outs + 2 outputs).
- Scene switches (P3 measured ~66% of one core during a burst of switches every 1.2 s): keep embedded component
  iframes and camera/capture streams alive across a switch when the next scene uses the same ones, so a switch
  moves boxes instead of rebuilding pages.
- Stress: 60 layers, 4 components, 1 camera, 1 window source, LIVE, 2 hours - memory flat, no dropped frames.
- From P4: the encoder is fed NV12 from capture.Nv12Converter (a ring of three textures); check the ring holds
  at 60 fps (a torn frame would show as a flicker in the recording), and decide whether a software H.264
  fallback (Microsoft's MFT wants NV12 in system memory: one staging copy + Map per frame) is worth having for
  machines without a usable hardware encoder, or whether Chrome's WebCodecs page path stays the fallback.
- Recovery: an output window that dies is re-opened and re-joins the live scene; the server restart path
  restores outputs; corrupted scene files fall back to their backup.
- Security pass on the new routes (all behind _trusted(), no path traversal in assets/scenes, WebSocket origin
  check), logs never carry keys. Update DECISIONS.md with the final numbers. Commit and push.
```

## P6 - Deck integration (Opus)

```text
Canvas Builder step P6. Run with Opus. Read the plan and DECISIONS.md. Goal: the deck shows the new backend: no new
pages yet.

- Components row rendered from the COMPONENTS registry instead of hardcoded markup, same look, keyboard access
  and aria, now a horizontally scrollable strip (scroll snapping, edge fades, arrow buttons, wheel-to-scroll,
  focus scrolls into view, works at narrow widths). Groups: "Music and words" (the four), "Screen sharing"
  (Screen frame and Camera frame - decorative frames with a key-color or see-through hole where the game or
  camera shows, border styles, the border loop, corner badges, title text; each with designer tabs like the
  others), "Canvas" (one card per scene with Open output / Go LIVE / Edit).
- A "Canvas Builder" button that opens web/canvas.html in its own app window (the page itself lands in P7; a
  placeholder page is fine now), and a compact LIVE strip: status, live scene switcher, Start/Stop wired to
  /api/live (settings come in P11).
- Tests: rig screenshots of the row at 1400 and 700 px with 4 and with 10 components, no console errors, all
  four components still open/close/snap/heal. Commit and push.
```

## P7 - Canvas Builder editor shell (Opus)

```text
Canvas Builder step P7. Run with Opus. Read the plan and DECISIONS.md. Goal: web/canvas.html - the editor - a
separate page connected to the deck, dark UI on the deck's theme tokens, industry-grade and keyboard friendly.

- Layout: top bar (scene picker, format switcher, undo/redo, zoom, Open output window, live status), left panel
  with tabs Layers | Sources | Assets, center canvas (zoom to fit / 100% / wheel zoom around the cursor,
  space-drag pan, checkerboard for see-through areas, format frame), right inspector for the selection.
- Editor state: one store, every change a command (do/undo/merge), autosave as a debounced PUT with revision
  checks (refuse a stale save and reload), changes visible in an open output window within ~100 ms.
- Layers panel: drag reorder, visibility and lock, rename, multi-select, groups. Sources panel: Add menu from the
  layer-type registry, including capture sources listed from /api/capture/sources with thumbnails.
- Accessibility: focus order, visible focus, aria for panels and the tree, a shortcuts help overlay.
- Tests: headless screenshots at 1600x900 and 1280x720, undo/redo round-trips, an autosave conflict test.
  Commit and push.
```

## P8 - Canvas tools (Opus)

```text
Canvas Builder step P8. Run with Opus. Read the plan. Goal: Photoshop/Figma-grade direct manipulation.

- Select, marquee, shift/ctrl add; move with 8 resize handles plus rotate; shift keeps aspect, alt resizes from
  the center, arrows and shift+arrows nudge.
- Snapping with a toggle and hold-alt override: canvas edges and centers, other layers, equal spacing, guides,
  safe zones; smart guides with distances while dragging. Rulers with draggable guides saved per scene; grid
  overlay and grid snap; pixel-exact inspector fields that accept math ("+20", "*2").
- Align/distribute, bring forward/back, group/ungroup, lock, copy/paste/duplicate across scenes, right-click
  menus. Every action one undoable command; pointer math correct at any zoom and at the deck's DPI.
- Tests: scripted CDP drags check positions and snapping, undo after each. Commit and push.
```

## P9 - Inspectors for every layer type and source (Opus)

```text
Canvas Builder step P9. Run with Opus. Read the plan. Goal: an inspector section for each layer type the runtime
already renders (P3), reusing the deck's designer controls rather than copying them.

- Text (font picker with Add font, size, weight, spacing, alignment, fill/gradient, stroke, shadow/glow,
  background pill, auto-fit, live variables), image/GIF/video (asset picker with drag-drop upload, fit, crop,
  flip, loop/mute), backgrounds, shapes, effects (incl. the border loop), enter animations and the few cheap
  loops, component layers ("Use my design" vs "Customize for this scene" with the deck's own tabs, plus the
  transparency options), reactive image (idle/talking/blink, threshold with a live meter), camera (device,
  resolution, mirror, mask), capture (source picker with live thumbnails, cursor on/off), triggers.
- A clear "live" indicator whenever a camera or capture is active in the editor.
- Tests: golden screenshots per inspector, a scene with all four components (one customized, one linked; a deck
  design change updates the linked one live), connection count stays within the cap. Commit and push.
```

## P10 - Phone canvas: safe zones, templates gallery, format conversion (Opus)

```text
Canvas Builder step P10. Run with Opus. Read the plan. Goal: make the phone canvas great for TikTok LIVE.

- Editor-only safe-zone overlays for portrait (top bar, comments, gifts, side buttons) from the P3 data,
  toggleable, snapping targets, a warning badge on layers under TikTok UI.
- Template gallery with thumbnails in the New scene dialog (the P3 templates), "Make a phone version" that
  re-lays out a horizontal scene with anchored rules and then lets you fix it by hand.
- Tests: screenshots of each template in its format; conversion keeps every layer inside the canvas. Commit
  and push.
```

## P11 - Go LIVE panel, studio mode, scene remote (Opus)

```text
Canvas Builder step P11. Run with Opus. Read the plan. Goal: run a show from the app.

- LIVE panel in the editor and the deck strip: server URL + stream key entry (masked, paste, "forget"), preset
  picker with bitrate hints, audio sources with gains/mute/meters, Start/Stop, health (bitrate, dropped
  frames, reconnects, uptime) and the "key updated" error with a copy-new-key hint.
- Studio mode: edit a preview scene while another is live, "Take" with the transition; a small always-on-top
  scene remote window; in-app keyboard shortcuts (no global hotkeys yet).
- Tests: a rig stream to the local sink driven entirely from the UI, 20 switches, no flicker, all controls
  keyboard-reachable. Commit and push.
```

## P12 - Release (Fable, then Opus for UI fixes)

```text
Canvas Builder step P12. Run with Fable, then Opus for anything visual it flags. Read the plan. Goal: ship it.

- QA pass: every inspector field, undo/redo everywhere, autosave conflicts, deleting an asset in use, missing
  fonts, a corrupted scene file, DPI 100/150%, the deck at narrow widths, keyboard-only editing, LIVE start/
  stop/reconnect, the transparency test page in LIVE Studio.
- Import/export a scene as one .zip (JSON + assets), validated on import.
- README sections (Canvas Builder, going LIVE from the app, capturing in LIVE Studio, camera/capture privacy),
  updated memory notes, PyInstaller build check (new web files, tools, cache/scenes), rebuild the user's app
  with scratchpad rebuild.ps1 when they're not gaming, tag a release if they want one. Commit, push, watch CI.
```
