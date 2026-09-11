# Canvas Builder - build plan

A separate, connected page where you compose the deck's components and new
sources into full stream layouts: a **horizontal canvas** (1920x1080, full
screen) and a **phone canvas** (1080x1920, TikTok LIVE portrait). It works
like OBS (sources, scenes, a live output window you capture) crossed with
Photoshop (layers, transforms, effects, snapping). It adds text, GIFs,
backgrounds, images that change when you speak, a camera, screen share, and
frames for streamed content. It is built on a component registry, so new
components can keep being added later.

**How to use this file:** run the prompts below **one at a time, in order**
(P0, P1, ...). Paste a prompt into Claude Code as written. Each one builds on
the ones before it and ends with a commit, so the app works after every step.
Tick the box when a step has landed.

| # | Step | Status |
|---|------|--------|
| P0 | Groundwork: verify capture, permissions, limits; write the decisions | [ ] |
| P1 | Component registry + scrollable components row | [ ] |
| P2 | Embed mode for components + one shared state feed | [ ] |
| P3 | Scene model, storage, asset library, API | [ ] |
| P4 | Scene renderer + output windows (horizontal and phone) | [ ] |
| P5 | Canvas Builder editor shell (its own connected page) | [ ] |
| P6 | Canvas tools: transform, snapping, guides, groups, shortcuts | [ ] |
| P7 | Layer types: text, image/GIF/video, backgrounds, shapes, effects | [ ] |
| P8 | Component layers inside scenes | [ ] |
| P9 | Mic activation: voice state + reactive images and triggers | [ ] |
| P10 | Screen share and camera: frames tab + live sources | [ ] |
| P11 | Phone canvas: TikTok safe zones + starter templates | [ ] |
| P12 | Scenes, live switching, transitions, deck quick controls | [ ] |
| P13 | Hardening: performance, QA, docs, build, release | [ ] |

---

## Standing rules (every prompt includes these by reference)

- Local-first: the server binds `127.0.0.1` only. No audio or video leaves
  the PC. Nothing downloads without an explicit press, and none of these
  steps need a download.
- US spelling in code and UI. Match the surrounding code's style and comment
  density.
- Test on the isolated copy (`scratchpad/testrig`, port 8799,
  `server.py --no-open`), never on the real app. Take headless-Chrome
  screenshots over CDP for visual checks. Window geometry must pass the
  DPI-aware `windiag2.py` check.
- Performance is a feature. The user's target is about 5% total CPU on a
  16-thread laptop with a 165 Hz screen. Measure every new animated or live
  element on a real window (`chrometype.ps1`, and an A/B like `abtest.ps1`).
  Endless animation runs at 30 fps (motion.js), Ultra optimized stops all
  motion, and nothing ticks while hidden.
- Never pop topmost windows open while the user may be gaming.
- Don't use multi-agent Workflow runs unless absolutely needed. Self-review
  and rig tests are the default.
- Never commit `config.json`, `cache/` or tokens. Secret-scan before pushing.
  Commit and push at the end of each step, and watch CI.
- Keep every existing feature working: the four pop-outs, captions (CPU and
  GPU), Spotify, lyrics, ultra mode and the deck preview.

## Architecture at a glance

```
deck.html (control room)      canvas.html (Canvas Builder editor)
   |  components row (registry-driven, scrollable)   |  layers / sources / inspector
   |                                                  |
   +----------- server.py (127.0.0.1:8713) -----------+
         COMPONENTS registry   SCENES store   ASSET store   VOICE state
         /api/events (one SSE per page)       /api/scenes/*  /api/assets/*
                           |
                 scene.html?id=...  (output: renders a scene)
                 opened as a hosted pop-out window like the others,
                 captured by TikTok LIVE Studio
                 - component layers = component pages in embed mode (iframes),
                   fed by the scene page over postMessage (no SSE of their own)
```

## Key risks and the decisions they force (P0 settles them)

1. **Browser connection cap.** Chrome allows 6 HTTP/1.1 connections per host.
   Every page holds one SSE stream (`/api/events`), so a scene with four
   component iframes plus itself would starve other requests. Decision:
   embedded components never open their own SSE. The scene page relays state
   to them by `postMessage`, building on the preview mechanism that already
   exists.
2. **Transparency on capture.** Window capture usually drops per-pixel alpha.
   A scene is therefore composed inside our canvas, as one window: camera and
   screen share are sources in the scene. Areas meant to show something from
   LIVE Studio underneath use a key color (chroma key) or, if LIVE Studio
   supports a web/link source, real transparency. P0 checks which.
3. **Portrait size.** 1080x1920 is taller than the 1440 px screen. P0 checks
   whether Windows Graphics Capture takes a window larger than, or partly off,
   the screen. The fallback is rendering at a lower size such as 720x1280.
4. **Camera and screen permissions.** Local Chrome app windows are secure
   contexts. P0 checks that permission persists per profile, and whether
   `getDisplayMedia` needs the picker every time.
5. **CPU.** Composing many live things is exactly what the user wants to keep
   cheap. Each step has a measured budget. Rendering prefers CSS transforms
   and pre-rendered sprites, and draws live video only when present.

---

## P0 - Groundwork: verify capture, permissions, limits; write the decisions

```text
We're starting the Canvas Builder described in music-deck/docs/CANVAS_BUILDER_PLAN.md (read it first, including
the Standing rules and "Key risks"). This step is research and measurement only - no feature code.

Find out, with evidence (web sources for TikTok LIVE Studio, small local experiments on the 8799 rig for the rest):
1. TikTok LIVE Studio's source types today: window capture (does it keep per-pixel alpha?), a web/link/browser
   source (does it render transparency?), chroma key availability and on which sources, image/text sources,
   canvas sizes for landscape and portrait.
2. Can a hosted pop-out window at 1080x1920 (taller than this 2560x1440 @150% screen) or partly off-screen be
   window-captured whole? Test with our own HostWindow + Chrome app window and Windows Graphics Capture
   (e.g. a small Python/WinRT or PowerShell capture test) - report what we get.
3. In a Chrome --app window on http://127.0.0.1:8713: getUserMedia (camera + mic) and getDisplayMedia
   behavior - permission prompts, whether the choice persists in the chrome-windows profile, relevant flags
   (e.g. --auto-select-desktop-capture-source), and CPU cost of showing a 1080p camera in a <video> in a hosted
   window (measure with scratchpad chrometype.ps1).
4. The SSE connection cap: confirm 6 per host in our shared Chrome profile, and what happens with 5+ SSE pages.
5. Baseline CPU of the current app with Now Playing + Captions open (so later steps can be compared).

Write music-deck/docs/canvas-builder/DECISIONS.md: each question, the evidence, and the decision (how scenes are
output and captured, how transparency is delivered, portrait output size, camera/screen approach, state relay,
CPU budgets per scene). Update the "Key risks" section of the plan if a decision changes it. Commit and push.
```

## P1 - Component registry + scrollable components row

```text
Canvas Builder step P1 (see music-deck/docs/CANVAS_BUILDER_PLAN.md and docs/canvas-builder/DECISIONS.md).
Goal: make "a component" a declared thing so new ones can be added without touching five places, and make the
deck's "Pick a window to put on stream" row scroll so it holds more than four. No visible behavior change otherwise.

- server.py: replace the four hardcoded Overlay objects and per-window routes (/api/window, /api/lyrics/window,
  /api/queue/window, /api/captions/window) with a COMPONENTS registry: id, label, page, config section,
  default size, host title, capabilities (e.g. needs Spotify). Keep the old URLs working as aliases (the deck,
  scratchpad scripts and rebuild.ps1 use them). Route /api/components/<id>/<action> through window_action.
  Expose the registry in the state snapshot.
- web/deck.html + deck.js: render the component cards from the registry instead of hardcoded markup. Keep the
  same look, keyboard access and aria. The row becomes a horizontally scrollable strip with scroll snapping,
  edge fades, arrow buttons, wheel-to-scroll and focus-scroll-into-view. It also works at narrow widths.
- Keep every existing flow working: open/close/snap/resize/heal, the preview, the designer tabs per component.
- Tests on the rig: all four components open and align (windiag2.py), screenshots of the row at 1400 and 700 px
  wide with 4 and with 8 dummy components, and no console errors. Commit and push.
```

## P2 - Embed mode for components + one shared state feed

```text
Canvas Builder step P2 (read the plan and DECISIONS.md). Goal: each component page can run embedded inside another
page (a scene) - transparent where the user wants, sized by its box, fed by its parent instead of its own SSE.

- nowplaying/lyrics/queue/captions pages: add ?embed=1. In embed mode: no window handles or drag areas, no
  /api/events connection. State and design arrive by postMessage from the parent in the same shape the SSE
  snapshot has (reuse the existing preview message path). The body background is transparent, and the page
  fills its iframe box with ResizeObserver-driven sizing.
- Per-component transparency options, stored per embed instance: card background on/off, background opacity,
  card border/shadow on/off, plus hiding individual parts (art, progress, transport, label...).
- A small shared helper web/embedhost.js for parents: creates component iframes, keeps ONE SSE connection, and
  relays snapshots and design changes to all children, throttled to changes only. Children ack readiness.
- Standalone pop-outs and the deck preview must behave exactly as before.
- Tests: a scratch page embedding all four components over a checkerboard proves transparency; count
  /api/events connections (must be 1 for the parent); run the existing screenshot scripts for the standalone
  pages. Commit and push.
```

## P3 - Scene model, storage, asset library, API

```text
Canvas Builder step P3 (read the plan and DECISIONS.md). Goal: the data layer for scenes, with no UI yet.

- Scene JSON schema (versioned): id, name, format (horizontal 1920x1080 | phone <size from DECISIONS> |
  custom w x h), background, key color and transparency mode, and an ordered layers list. Each layer has
  id, type, name, visible, locked, group id, transform (x, y, w, h, rotation, anchor), style (opacity, blend mode,
  radius, border, shadow, blur, crop/mask), type-specific props, and optional triggers (e.g. "while speaking").
- Store scenes as files in cache/scenes/<id>.json. Write atomically, keep a small rolling backup (last 5
  versions), validate on load (unknown fields kept, bad values clamped), and migrate by version.
- Asset library v2 on top of the existing AssetStore: images (png/jpg/webp/svg), GIFs, short videos
  (webm/mp4), with size limits, hash dedupe, thumbnails, usage counts (don't delete an asset a scene uses),
  and listing by type.
- API: GET/POST /api/scenes (list, create from a format or template), GET/PUT/DELETE /api/scenes/<id>,
  POST /api/scenes/<id>/duplicate, the asset routes, and a per-scene revision number on the state broadcast so
  outputs and editors refresh cheaply. Every route stays behind the existing _trusted() check.
- Python unit tests for schema validation, migration, atomic writes and asset dedupe (plain unittest, run with
  the build env). Commit and push.
```

## P4 - Scene renderer + output windows (horizontal and phone)

```text
Canvas Builder step P4 (read the plan and DECISIONS.md). Goal: web/scene.html?id=<scene> renders a scene exactly,
and opens as a capturable pop-out window like the other components.

- Renderer: a layer-type registry (renderLayer(type) -> element + update(props)). Start with background, image,
  text and component (the P2 embed iframes, via embedhost.js). The scene is laid out at its native resolution
  and scaled to the window with one transform. Areas without content show the key color or real transparency,
  per DECISIONS.md.
- Output windows: register "Canvas: <scene name>" as dynamic components (P1 registry) using overlay.Overlay /
  HostWindow at the scene's output size, including the portrait size decided in P0. Remember position and size,
  and pass windiag2.py alignment.
- Live updates: re-render only the changed layers when the scene revision changes; never rebuild everything.
- Performance: no per-frame script; motion follows motion.js; Ultra optimized stills everything; hidden = idle.
  Budget: an idle static scene near 0% CPU. Measure a horizontal scene with Now Playing + Captions embedded
  against the same two as separate pop-outs (A/B on real windows).
- Tests: rig screenshots of both formats, geometry check, CPU numbers in the commit message. Commit and push.
```

## P5 - Canvas Builder editor shell (its own connected page)

```text
Canvas Builder step P5 (read the plan and DECISIONS.md). Goal: web/canvas.html - the editor - as a separate page
connected to the deck, opened in its own Chrome app window like the deck, from a "Canvas Builder" button in
the deck (plus a card in the components row listing your scenes).

- Layout (industry-grade, keyboard friendly, dark UI consistent with the deck's theme tokens):
  top bar (scene picker, format switcher, undo/redo, zoom, "Open output window", live status), left panel with
  tabs Layers | Sources | Assets, center canvas (zoom to fit / 100% / wheel zoom around the cursor, space-drag pan,
  checkerboard for transparent areas, format frame), and a right inspector for the selected layer.
- Editor state: one store, and every change is a command (do/undo/merge), so undo/redo covers everything.
  Autosave is a debounced PUT to /api/scenes/<id> with revision checks (refuse a stale save and reload).
  Changes appear in the open output window within ~100 ms.
- Layers panel: reorder by drag, visibility and lock toggles, rename, and multi-select. Sources panel: "Add"
  menu from the layer-type registry.
- Accessibility: focus order, visible focus, aria for panels and tree, and shortcuts listed in a help overlay.
- Tests: headless screenshots at 1600x900 and 1280x720, undo/redo round-trips, autosave conflict test.
  Commit and push.
```

## P6 - Canvas tools: transform, snapping, guides, groups, shortcuts

```text
Canvas Builder step P6 (read the plan). Goal: Photoshop/Figma-grade direct manipulation in canvas.html.

- Select, marquee multi-select, shift/ctrl add; move with 8 resize handles plus rotate; shift keeps aspect
  ratio, alt resizes from the center, and arrows / shift+arrows nudge.
- Snapping, with a toggle and a hold-alt override: canvas edges and centers, other layers' edges and centers,
  equal spacing, rulers' guides, and safe zones. Smart guides show distances while dragging.
- Rulers with draggable guides (saved per scene); grid overlay and grid snapping; pixel-exact inspector
  fields (x, y, w, h, rotation) that accept math ("+20", "*2").
- Align/distribute, bring forward/back, group/ungroup (groups transform together), lock, and
  copy/paste/duplicate across scenes. Right-click context menus.
- Every tool action is one undoable command. Pointer handling works at any zoom and on the deck's DPI.
- Tests: scripted CDP drags check positions and snapping; undo after each. Commit and push.
```

## P7 - Layer types: text, image/GIF/video, backgrounds, shapes, effects

```text
Canvas Builder step P7 (read the plan). Goal: the core creative layer types, each with an inspector section, in
both the renderer (scene.html) and the editor.

- Text: any font from FontStore (and "Add font..."); size, weight, letter/line spacing, alignment, fill
  (solid/gradient), stroke, shadow/glow, background pill, auto-fit to box, and live variables such as {title}
  {artist} {album} {time} bound to the state feed.
- Image / GIF / video: from the asset library (drag-drop onto the canvas uploads and places it), with fit
  (cover/contain/stretch), crop, flip, loop/mute for video, and Ultra optimized freezing GIFs (stillOf) and
  pausing video.
- Backgrounds: solid, gradient (linear/radial, angle, stops), image with blur/dim, and the generative scenes
  from scenes.js.
- Shapes: rectangle, rounded rectangle, ellipse, line; fill/stroke; plus a "frame" shape with a cut-out hole.
- Effects on any layer: opacity, blend mode, corner radius, border, drop shadow, blur, and the decorative border
  loop from decor.js (reuse the canvas loop). Enter animations (fade/slide/pop, one-shot) and at most a few
  cheap loop animations, all 30 fps and ultra-aware.
- Tests: a golden-screenshot scene per type; CPU A/B for a scene with a GIF, a video and the border loop.
  Commit and push.
```

## P8 - Component layers inside scenes

```text
Canvas Builder step P8 (read the plan). Goal: Now Playing, Lyrics, Queue and Captions (and any registry
component) as first-class layers.

- "Add > Component" lists the registry. A component layer embeds the component (P2 embed mode) at the layer's
  box. Its inspector has "Use my <component> design" (linked to the global design) or "Customize for this
  scene" (a per-layer design override edited with the same controls as the deck's designer tabs, reused, not
  copied).
- Transparency controls from P2 appear in the inspector (card background on/off, opacity, parts to hide).
- One state feed for the whole scene (embedhost.js). Captions layers must not start the microphone
  themselves; they show the captions state the server already has.
- Tests: a scene with all four components embedded, one customized and one linked; a design change in the
  deck updates the linked one live; connection count stays 1; CPU A/B against the same components as
  pop-outs. Commit and push.
```

## P9 - Mic activation: voice state + reactive images and triggers

```text
Canvas Builder step P9 (read the plan). Goal: images that change when you talk (PNGtuber style), and "while
speaking" triggers for any layer.

- server.py: a VOICE state {level, speaking}. While captions run it comes from the caption engine (Whisper's
  level + VAD, or the Windows engine's). Otherwise a tiny on-demand MicLevel monitor (sounddevice, 50 ms blocks,
  RMS with attack/hold/release) runs only while an open output window uses voice. Broadcast only changes of
  "speaking" (plus the level at a low rate, only while the editor's meter is visible). The mic stays on this
  PC, and the monitor stops when nothing needs it.
- Layer type "Reactive image": idle image, talking image, optional blink image/interval and bounce on speech;
  threshold and hold set in the inspector with a live level meter.
- Trigger system for any layer: show/hide/swap asset/animate "while speaking" or "on speech start".
- Tests: a synthetic voice source on the rig (feed audio like the caption bench does); latency from speech
  start to image swap (target under 150 ms); CPU with the monitor running (target under 1% of one core).
  Commit and push.
```

## P10 - Screen share and camera: frames tab + live sources

```text
Canvas Builder step P10 (read the plan and DECISIONS.md). Goal: frame your streamed content and camera, both as
standalone components and as scene sources.

- Deck: the components row gains a "Screen share" group with new registry components - "Screen frame" (a
  decorative frame with a key-color or transparent hole where the game or screen capture shows in LIVE
  Studio: border styles, the border loop, corner badges, title text, scene backgrounds) and "Camera frame"
  (the same for a face cam: shapes like circle, rounded or blob). Each gets designer tabs like the other
  components.
- Scene sources per DECISIONS.md: Camera (getUserMedia, device picker, resolution/fps caps, mirror, crop, shape
  mask, optional background blur only if measured cheap) and Screen/Window capture (getDisplayMedia, with the
  picker flow and persistence found in P0). Video elements render only while visible.
- Privacy: nothing records or uploads, and there's a clear "live" indicator in the editor while a camera or
  screen is in use.
- Tests: frames align in real windows (windiag2.py); camera in a scene at 720p30 - measure CPU; screen capture
  of one window in a scene - measure CPU. Commit and push.
```

## P11 - Phone canvas: TikTok safe zones + starter templates

```text
Canvas Builder step P11 (read the plan and DECISIONS.md). Goal: make the phone canvas great for TikTok LIVE and
give both formats a head start.

- Safe-zone overlays for the portrait canvas (the areas TikTok's UI covers: top bar, comments, gifts, side
  buttons), editor-only and toggleable. Snapping targets for them; a warning badge when a layer sits under
  TikTok UI.
- Starter templates (JSON + bundled assets) for both formats, e.g. "Just chatting", "Music + lyrics",
  "Gaming portrait (screen frame + cam)", "Gaming landscape". A template gallery with thumbnails in the "New
  scene" dialog.
- Format conversion: "Make a phone version" re-lays out a horizontal scene with anchored rules, then lets you
  fix it by hand.
- Tests: screenshots of each template in its format; conversion keeps every layer inside the canvas. Commit and
  push.
```

## P12 - Scenes, live switching, transitions, deck quick controls

```text
Canvas Builder step P12 (read the plan). Goal: run a show - switch scenes live, cleanly and cheaply.

- An output window can follow "the live scene" (not a fixed id). Switching live scenes swaps content in place
  with a cut or a fade (a CSS opacity crossfade, a fixed short duration, stepped at 30 fps) - no window
  re-open, so LIVE Studio's capture never breaks.
- Studio mode in the editor: edit a preview scene while another is live, then "Take" it live.
- Deck quick controls: a compact scene switcher strip in the deck and an optional small always-on-top
  "scene remote" window. Keyboard shortcuts while the deck or editor has focus. No global hotkeys yet.
- Tests: switch 20 times while capturing CPU and checking no window flicker (geometry stays aligned); memory
  stays flat. Commit and push.
```

## P13 - Hardening: performance, QA, docs, build, release

```text
Canvas Builder step P13 (read the plan). Goal: ship it.

- Performance pass: measure every template scene live (chrometype.ps1 A/B), fix the top costs, and confirm
  Ultra optimized and hidden windows go idle. Stress test: 60 layers, 4 components, 1 camera.
- QA pass: every inspector field, undo/redo everywhere, autosave conflicts, deleting an asset in use, missing
  fonts, a corrupted scene file (backup restore), DPI 100/150%, the deck at narrow widths, and the editor with
  only a keyboard.
- Import/export a scene as one .zip (JSON + its assets), validated on import.
- README sections (Canvas Builder, capturing in TikTok LIVE Studio, camera/screen privacy), updated
  memories/notes, PyInstaller build check (new web files and cache/scenes), rebuild the user's app with
  scratchpad rebuild.ps1 when they're not gaming, and tag a release if they want one.
- Commit and push; watch CI.
```
