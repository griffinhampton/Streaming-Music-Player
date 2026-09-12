# Awesome Streaming Deck

A local overlay deck for streaming: now playing, lyrics, the Spotify queue,
and live captions of what you say. It binds to `127.0.0.1` only, so nobody on
your network can even see it, and it works fully offline out of the box.
A few things can reach the internet, all optional and all off unless you ask:
lyric lookup (a checkbox), connecting your Spotify account (a setup you have
to go through on purpose), and two one-time downloads for captions, each a
button: the Whisper model, and NVIDIA's cuBLAS library if you want Whisper on
your graphics card. Your voice never leaves the PC - captions are recognized
right here.

Five windows:

- **Awesome Streaming Deck** – the control room. Library, playback, Spotify controls, and
  every design setting with a live preview. Its player card follows whatever is
  actually playing, local or Spotify, and its transport, seek bar and volume
  drive that source.
- **Awesome Streaming Deck - Now Playing** – the pop-out you add to TikTok Studio. Borderless,
  any size or shape.
- **Awesome Streaming Deck - Lyrics** – a pop-out that scrolls the words in time with the
  song. Optional.
- **Awesome Streaming Deck - Queue** – a pop-out listing what Spotify plays next. Optional,
  and needs the Spotify account connected.
- **Awesome Streaming Deck - Captions** – a pop-out that turns what you say into your
  microphone into closed captions, live. Optional, off until you press Start.

And the **Canvas Builder**, which lays all of that out into scenes - with text,
pictures, your camera and your game - and can go LIVE on TikTok by itself,
with no other streaming app. See [The Canvas Builder](#the-canvas-builder) and
[Going LIVE from the app](#going-live-from-the-app).

## Live captions

Press **Start** on the Captions tab and the deck listens to your microphone
and writes what you say, live: the phrase being spoken shows as it forms,
settles into a finished line when you pause, and finished lines fade out
after a few seconds so the box empties between things said. English only.

Two engines, both entirely on this PC - no audio is ever sent anywhere:

- **Whisper** (the default) - OpenAI's Whisper speech model, run on your CPU
  through [faster-whisper](https://github.com/SYSTRAN/faster-whisper). Far
  more accurate: on a noisy test recording it got 98% of words right where
  Windows' engine got 71%. It needs its model once - press **Download** (Base,
  about 150 MB, from Hugging Face; checked against the published hashes) and
  it works offline from then on. To stay fast it reads each phrase in a
  window sized to the phrase, not Whisper's usual 30 seconds. **Small** is the
  most accurate on paper, but it is roughly three times the work of Base and
  falls behind if you talk without pausing - on a laptop, Base is the one to
  use live.
- **Windows** - Windows' built-in dictation engine. Nothing to download and
  very light, but it guesses a lot.

**Names and words to expect** takes your username, the game, regulars in chat
- Whisper leans toward those spellings, which is most of the difference on
names. Pick a specific **Microphone** if the Windows default isn't the one you
stream with; the level meter next to the status shows it's hearing you.
Captions stay off until you start them, and the deck remembers the choice
across restarts.

Captions are the one part of the app that works hard, so they keep to a
budget: while you talk, the live line updates about once a second and uses
at most about half of one CPU core on average, however long you talk
without a pause - a long run of talk just updates a little less often. The
budget only ever slows that live line; finished lines are never held back.
The live line is read on a single CPU thread, so it never takes more than one
core at a time; finished lines get two, so they are not held up either.
Turn off **Show words while I'm still talking** (Listening tab) and each line
appears once you pause instead, for a fraction of that.

### On the graphics card

With an NVIDIA graphics card, **Run Whisper on: Graphics card** (Listening tab)
takes almost all of that work off the processor. It needs one library from
NVIDIA first, cuBLAS - press **Download** under the switch. That fetches
NVIDIA's own `nvidia-cublas-cu12` 12.9.2.10 package from PyPI (553 MB, checked
against the hash PyPI publishes for it), keeps just its two DLLs in
`cache/cuda` (about 770 MB) and deletes the rest. Nothing else is needed - no
CUDA toolkit, no cuDNN - just a current NVIDIA driver. Your voice still never
leaves the PC; the graphics card is part of it.

On an RTX 3080 laptop with the card otherwise idle, a Whisper read takes
about 0.12 s on the graphics card instead of about 1.2 s on two processor
cores, and costs the processor about a tenth of a core-second instead of two
and a half. Talking non-stop, captions used 13% of one processor core instead
of 59%, and the first words showed up in half the time. A game sharing the
card makes each read slower, and the live line then updates a little less
often.

Only Whisper moves to the NVIDIA card. The app's windows stay on whichever
graphics chip Windows gives them - on a laptop usually the built-in one,
which is the right place for drawing a few overlays.

If the card can't run Whisper (an old driver, a card switched off, no
memory left), Whisper runs on the processor instead and the Listening tab
says why; if the card fails mid-stream, captions carry on on the processor
until the app restarts. Until the download finishes, Whisper runs on the
processor too. Once Whisper has used the card, the card stays awake until
the app closes, even if you switch back to Processor. The very first start
on a card newer than the Whisper engine itself can take a few minutes while
the card prepares; captions run on the processor meanwhile, and stopping and
starting listening once it's done moves them onto the card. After that it's
quick. NVIDIA's license for cuBLAS (kept next to it as
`License.txt`) applies.

## Ultra optimized

The **Ultra optimized** switch at the top of the deck runs everything at its
lightest, for streaming from a machine with no CPU to spare:

- nothing animates - no drifting decoration, no sliding titles (a long one
  ends in "..."), no equalizer, and animated stickers and backgrounds hold
  their first frame
- the progress bar and clocks move once a second
- captions show finished lines only, whatever the Listening tab says
- the Windows media bridge reads what is playing once a second instead of
  two and a half times

Turn it off and everything moves again straight away.

## Your own fonts

Every **Font** menu has an **Add font…** button, and font files dropped
anywhere on the deck are added too: `.ttf`, `.otf`, `.woff` or `.woff2`, such
as a download from Google Fonts. An added font is listed under *Your fonts* in
every Font menu - Now Playing, lyrics, the queue, captions and the app itself
- and every window updates without reopening. A Regular and a Bold of the
same family become one family with both weights, as installed fonts do. Added
fonts live in `cache/fonts`; the chip under a Font menu removes one.

Two sources, picked automatically or by hand:

- **Your own files** – mp3, flac, m4a, wav, ogg, opus. Point it at a folder.
- **Spotify** – two ways, and you can use either:
  - **Straight from Windows** (default, nothing to set up): the media session
    the volume pop-up reads. Title, artist, album art, progress, transport.
    Needs the Spotify desktop app playing on this PC.
  - **Your Spotify account** (optional, see below): also sees playback on your
    phone, the web player or a Connect speaker, and can control it from there.

## How the deck is laid out

Across the top sit the three windows you can put on stream, side by side. Each
card says whether that window is **live** or **closed**, what size it is, and
carries the button that opens or closes it — so there is one place to look and
one place to click.

Clicking a card also *selects* it. The preview underneath switches to that
window, and the settings on the right narrow to the ones that apply to it, so
you are never scrolling past lyrics settings to reach the pop-out's.

Below that: the preview and your library (or Spotify's queue) on the left, the
player and every design setting on the right.

## Start it

- **From the .exe** – double-click `Awesome Streaming Deck.exe`. First launch takes a few
  seconds while it unpacks. The deck window opens on its own. **Quit** in the
  top-right stops everything.
- **From source** – double-click `Start Awesome Streaming Deck.bat` (needs Python 3.10+).
  Close the black window to stop.

Chrome or Edge has to be installed (Edge always is on Windows 10/11). The pop-out
windows all share one Chrome, so opening another adds a page rather than a
whole new browser.

## Put it on stream (TikTok Studio)

1. In the deck, press **Open** on the **Now Playing** card at the top.
2. TikTok Studio → **Add source → Window capture** → pick **Awesome Streaming Deck - Now Playing**.
3. Size and place it on your canvas like any other source.
4. Want lyrics or the queue? Press **Open** on those cards too, then add
   **Awesome Streaming Deck - Lyrics** or **Awesome Streaming Deck - Queue** the same way.

The windows do not need to stay visible on your desktop – window capture reads
the window itself, even behind a fullscreen game.

Audio: music from your files plays out of the deck window, which is Chrome.
Capture desktop audio, or add Chrome as an application audio source. Spotify's
audio is Spotify's as usual.

## The Canvas Builder

Press **Canvas Builder** in the deck. A *scene* is a whole layout at the size
you stream: **Horizontal** (1920 × 1080) or **Phone** (1080 × 1920, TikTok's
own shape). Start one blank or from a template with **New scene**.

- **Layers** – text (including the song playing), shapes, pictures and videos,
  the Now Playing / Lyrics / Queue / Captions windows, your camera, a screen or
  a window (your game), a *reactive image* that talks when you do, and
  full-size backgrounds. Add them from the left panel; pick one on the canvas or
  in the list to change it on the right.
- **Moving things** – drag, resize from the handles, rotate from the top
  handle. Things snap to the canvas, the center and each other (hold **Alt** to
  place freely); rulers and guides are there if you want them. Number fields
  take math: `+20`, `*2`, `1920/3`.
- **Undo everything** – **Ctrl+Z**, **Ctrl+Shift+Z**. Scenes save themselves as
  you go. Press **?** for every shortcut; the whole editor works from the
  keyboard.
- **Phone scenes** show where TikTok's own buttons and comments cover your
  stream (**Safe zones**), and warn when something sits under them. **Make a
  phone version** lays a horizontal scene out again for a phone.
- **On stream** – every scene has its own window, **Open output**; the
  **Canvas (live)** window follows whichever scene is live.
- **Studio mode** (**Ctrl+Shift+P**) – change one scene while another is on air,
  then **Take** it live (**Ctrl+Enter**). The top bar's **Remote** opens a small
  scene remote with a big button per scene; number keys switch too.

### Share a scene

With nothing selected, the right panel shows the scene's own settings. Under
**Share**, **Export as a .zip** saves the scene as one file in your Downloads
folder, with the pictures it shows and any fonts you added for it inside. Give
it to a friend; they open it from **New scene → Import a .zip…**.

An import checks everything in the file before it keeps anything: it must be a
scene this app exported, each picture and font has to really be one, and only
what the scene uses is kept. Anything left out is said. A picture that did not
come with it is outlined in the editor, and on stream it simply shows nothing.

If a scene's file is ever damaged (a crash mid-save, a disk hiccup), the app
keeps its last five versions and comes back from the newest good one. A file
with no good copy is set aside as `<name>.json.corrupt` in `cache\scenes`, and
the Canvas Builder tells you once.

## Going LIVE from the app

The app can stream to TikTok itself: it captures the **Canvas (live)** window,
encodes it on your graphics card, and sends it straight to TikTok's server.
No TikTok LIVE Studio, no OBS.

1. On a computer, open TikTok's **LIVE Producer** (`livecenter.tiktok.com/producer`),
   fill in the title and topic and press **Save and Go LIVE**; a few seconds
   later it shows a **Server URL** and a **Stream Key**. TikTok unlocks this page
   only for some accounts - if it sends you somewhere else, yours isn't unlocked
   yet. The key is new for every LIVE.
2. Open the **LIVE panel**: **LIVE…** in the deck's top strip, or the LIVE
   button in the Canvas Builder's top bar (**Ctrl+Shift+L**).
3. Paste both and press **Save**. The key is shown as dots, and once saved the
   page never gets it back.
4. Pick the **quality** (it tells you how much upload speed it needs), the
   **scene**, and your **sound**: the microphone, what the PC plays, each with
   its own volume, mute and meter.
5. **Start**. The panel shows how long you have been live, the bitrate, frames
   per second, dropped frames and reconnects.

If your connection drops, the stream reconnects by itself and the panel says
*Reconnecting…* until it is back. **Stop** asks twice, so a stray click cannot
end your LIVE. TikTok issues a new stream key now and then; when it refuses
the old one, the panel says to copy the new one from LIVE Center.

## Capturing in TikTok LIVE Studio

Rather stream with LIVE Studio (or OBS)? Capture a scene's window instead:

1. In the Canvas Builder, press **Open output** (or **Open output** on the
   scene's card in the deck).
2. In LIVE Studio: **Add source → Window capture** → **Awesome Streaming Deck -
   Canvas: *your scene's name***. Or pick **Awesome Streaming Deck - Canvas
   (live)** to follow whichever scene is live, and switch scenes from the app.
3. The window keeps drawing when it is covered or behind a fullscreen game.
   Do not minimize a window you are capturing: a minimized window rests to
   save power, and the app will not minimize the one that is on air.

**See-through parts.** LIVE Studio's **Window capture** never keeps a window's
transparency: whatever should be see-through comes out solid. A **Link** source
does keep it - checked in LIVE Studio 1.35.2 with the app's test page. To see
it yourself, start the app, then **Add source → Link** with
`http://127.0.0.1:8713/transparency-test.html`: whatever is under it shows
through everywhere except the pink card, the cyan block, the yellow dot and the
words (delete the test source afterwards). A scene with see-through parts looks
right on stream when the app goes LIVE itself, since it draws the whole scene;
through a window capture, give such a scene a solid background.

## Camera, capture and privacy

- **Nothing is uploaded.** The app answers only this PC (`127.0.0.1`). The one
  thing that ever leaves it is a LIVE stream you start, to the server you
  pasted.
- **Your camera** opens only while a scene with a camera layer is showing, and
  closes when none is. The Canvas Builder shows a red badge in its top bar, on
  the layer and in its settings whenever the camera or a screen capture is
  live.
- **Screen and window capture** runs only while a scene shows it, and leaves
  out the mouse pointer unless the layer asks for it.
- **The microphone** opens for captions only when you press Start; for reactive
  images only while a scene uses your voice (and nothing but a level and a
  yes/no leaves the listening part). It goes into a LIVE stream only if
  **Microphone** is ticked in the LIVE panel; the same for what the PC plays.
- **The stream key** is encrypted with your Windows account (DPAPI) in
  `cache\live.json`: another account or another PC cannot read it. It is
  never written to a log or shown again. **Forget** in the LIVE panel removes
  it.
- **A scene export** holds the scene's pictures and fonts. Look at what is in a
  scene before you give it away.

## Move, resize, reshape

- Drag a pop-out by its body to move it. Hover it for the close button.
- Grab the **bottom-right corner** of a pop-out and stretch it any way you like.
  With layout on **Auto**, the card re-arranges itself for the shape: wide
  becomes a bar, square becomes a stacked card, a thin strip goes compact.
- **Size tab** has shape presets (horizontal, wide strip, square, portrait,
  slim), exact width and height, snap-to-corner, and always-on-top. The lyrics
  and queue windows have the same controls in their own **Settings** tab.
- Wherever you drag a window to, its card at the top keeps showing the real
  size.

Sizes are in real screen pixels, and the preview shows the pop-out at the
size it actually has on screen.

## Make it yours

Everything in the **Design** panel changes the pop-out live in the preview.

- **Theme** – one click restyles the deck *and* the pop-out. Watercolour
  Blossom, Hanami, Cutecore, Bloom, Sakura Night, Red Moon, Embers, Midnight,
  Minimal, Dark, Light, Neon Arcade, Vaporwave, Terminal.
- **Background** – one editor for all four surfaces. The switch at the top
  picks what you are dressing: the pop-out, the lyrics window, the queue window
  or **the app itself**. Each keeps its own settings, and all four get the same
  controls — the app's wallpaper used to be just "pick an image and darken it",
  and now has the modes, framing, fit, blur and generated artwork the pop-out
  always had. Choosing a window at the top of the deck points this editor at it.
- **Background → Customizable artwork** – drawn from your settings rather than
  downloaded: stippled stars, pooled goo, watercolour blossoms, cherry blossoms,
  cute doodles, red moon, embers. Three colours, motif size, density,
  tile size and a shuffle button, so no two setups look alike. Nothing is
  downloaded; the art is drawn on the fly.
- **Frame it…** – rather than guessing with two sliders, this shows the whole
  picture with the part that will actually be on screen held bright and
  draggable, cut to the exact shape of the window it is going into. Drag it
  where you want it, zoom in to crop tighter, and everything dimmed is what you
  are throwing away.
- **Recolour the picture** – print any picture in two colours of your choosing.
  It keeps its light and shade and takes your ink, so a photograph that clashed
  with your theme becomes part of it. Primary, secondary, the angle between them
  and how far to push it.
- **Theme from this** – read the colours a picture is actually made of and dress
  the whole deck and every window in them. The **Theme** tab has one of these for
  every picture you have, so you can try them like swatches. The picture goes
  behind that window exactly as it is — nothing blurred, darkened or recoloured
  — with the framing, blur, darken and two-colour controls right underneath.
  Every generated theme is checked for legibility: body text clears 4.5:1 and
  secondary text 3:1 against what it sits on. Where a picture would still fight
  the text, the app works out the darkening that would fix it and offers it as a
  button rather than applying it behind your back.
- **Background → Picture** – the artwork that ships with the app, plus anything
  you drop in yourself. **Across** and **Down** choose which part of a picture
  shows, **Fit** and **Blur** do the obvious, and **Darken** lays a veil over it
  so the text stays readable. Each surface keeps its own picture and its own
  framing, so one wide image can be cropped differently in each — or all four
  can show something different.
- **Theme colours** – text, secondary text, and lines/borders in one place.
  Everything else inherits them unless you have given that one thing a colour of
  its own, so changing one swatch carries through the pop-out, the lyrics and
  the queue at once. Picking a theme sets these three and leaves the per-element
  colours free, so you can recolour a theme straight away without hunting
  through every control; **Reset all colours to theme** hands back any overrides
  you did set. Tick *Match the pop-out's colours* under App look and the deck
  itself follows.
- **Theme / Text / Art & bar** – fonts, sizes, colours, gradients, dropped-in
  images, corner radius, glow, card fill and its opacity, progress bar style.
- **Progress bar** – choose what sits at each end: elapsed, remaining, total
  length, or nothing. The two ends are set separately.
- **Corners and margin** – the only reason a pop-out has a margin is its
  rounded corners (and any decor frame holding the card in), so you get both
  ways out:
  - **Corners: Square** – the card fills the window edge to edge and there is
    no margin at all.
  - **Margin colour** – pick anything: black (the default, so the window
    vanishes on a black canvas), white, a chroma swatch, or **Match the
    artwork**, which samples the colour behind the card so the margin blends in.
  Switch *Around the card* to **Theme background** if you would rather the
  artwork run right to the edges instead.
- **Decor** – a frame around the edge: hand-drawn cherry blossom, petals,
  waves, or characters (sparkles, stars, your own). Behind the card as a
  watermark or in front; the card can step in from it as much as you like.
  Pick which sides it runs along, how far apart the motifs sit, and how fast
  they drift — set to move, they circulate around the frame rather than sliding
  off the ends. Emoticons next to the label. Anything that keeps moving - the
  drifting frame, a long title sliding, the equalizer bars - steps 30 times a
  second, which is what a stream captures, instead of at your screen's refresh
  rate (165 times a second on many gaming laptops), and so do longer one-off
  movements like the lyrics gliding to the next line or a caption fading out.
  While the deck is behind
  other windows, the moving parts in its preview hold still until you click
  back into it; the pop-out windows keep moving.
- **Stickers** – drop pictures onto the preview, then drag them into place. PNG,
  JPEG, SVG, WebP and **animated GIF**. Size, rotation, opacity, flip, layer
  order, in front of or behind the card, and **Tint it** to redraw one as a
  single-colour silhouette that follows your theme (the shape survives, its own
  colours do not).

  Animated stickers keep playing: they are not rebuilt when the track changes or
  while you drag them, so a GIF runs continuously instead of restarting. The
  picker marks which of your pictures move. One caveat the app tells you about:
  tinting draws a sticker through a mask, and a mask only ever uses the first
  frame — so tinting an animation freezes it.
- **Lyrics** – text size, lines shown, alignment, timing nudge, whether it
  matches the pop-out's look.
- **Queue** – heading, album art, artist, track length, and whether to include
  the track playing right now. It shows **as many tracks as fit**: text size
  follows the window's width, so making the window taller adds more of the queue
  rather than enlarging what is already there. The tracks setting is just a
  ceiling.
- **App look** – restyle the deck itself: colours, font, density, a frame, an
  emoticon. Its wallpaper lives with every other background, under
  **Background → The app**; set that to **None** and the app's own background
  colour shows through.

- **Controls** – put transport buttons inside a window: back, play/pause, skip.
  On Now Playing they can line up with the whole window, the progress bar or
  the album art - centered under the bar usually looks best - and the nudge
  sliders fine-tune from there.
  They drive whatever is playing, Spotify or your own files, and each window has
  its own set. By default they only appear while your mouse is over the window,
  so they never land in the capture — they are for you to press, not for the
  audience to look at. Choose where they sit (with the text, over the artwork, or
  hanging off the corner), how they line up, round or square or bare, and how big.

### Clicking the windows themselves

Tick **Clickable** and the pop-outs stop being pictures:

- **Now Playing** – click anywhere on the progress bar to jump there.
- **Lyrics** – click a line to jump back (or ahead) to it.
- **Queue** – click a track to jump to it. (Not move it: Spotify has no
  reorder endpoint, so this advances to that track the way Spotify's own app
  does — see the limit noted further down.)

Leave it off and a window is inert, so a stray click cannot skip your track
mid-stream. Dragging the window around works either way.

### The artwork that comes with it

The **built in themes** folder next to the app is read on startup and its
pictures appear in every image picker, alongside anything you add. Drop your own
files in there and they show up next time you start. They cannot be deleted from
inside the app, so the shipped set and your own uploads never get mixed up.

## The left panel follows the source

The **Auto / My files / Spotify** switch at the top decides both what goes on
screen *and* what the deck shows you:

- **My files** — your music folders and library.
- **Spotify** — Spotify's own queue. If the account is not connected yet, the
  sign-in appears right there instead.
- **Auto** — follows whatever is actually playing: start a track in Spotify and
  its queue comes up, play a local file and your folders come back. Anything
  else making noise (a browser tab, say) leaves the panel where it is, and it
  never switches out from under you while you are typing in a search box.

In Spotify mode you get: what is playing, the next 20 or so tracks, a search box
(click a result to queue it, or **Play now** to jump straight to it), a device
picker to move playback between your PC, phone and speakers, and shuffle/repeat.

**One limit worth knowing:** Spotify's Web API lets apps *read* the queue and
*append* to it, but there is no endpoint to reorder or remove queued items — only
Spotify's own app can do that. So there is no drag-to-reorder here, because it
could not work. **Play now** advances to the track you picked, dropping the ones
above it and keeping everything below — exactly what Spotify's own app does when
you click something in its queue.

Reading the queue works on any account. Adding to it, skipping, moving playback
between devices and shuffle/repeat are **Spotify Premium** features — the deck
says so rather than failing silently if your account cannot do them.

## Connecting your Spotify account (optional)

Once connected, the app asks Spotify for anything only while the **Queue**
window is open - opening it reads the queue once, and it keeps up from there.
With the Queue window closed, Now Playing comes from Windows alone, and a
transport button you press goes through Windows when the music is on this
PC; the account is used for a press only when Spotify is playing somewhere
Windows cannot see, such as a phone.

Needed for the queue view, search and device switching, and for playback on your
phone or the web player to show up at all. Without it the deck still reads the
Spotify desktop app through Windows, which covers the common case.

It uses the PKCE flow, so there is no client secret to keep safe. Tokens are
stored in `cache/spotify_token.json` on your PC and go nowhere else.

Switch the source to **Spotify** and the whole walkthrough is in the left panel,
with a troubleshooting list for the errors Spotify's page can throw. The short
version:

1. Open **developer.spotify.com/dashboard**, log in with your normal Spotify
   account, press **Create app**. Name and description can be anything — nobody
   else sees them.
2. In **Redirect URIs** paste exactly what the deck shows --
   `http://127.0.0.1:8713/spotify/callback` — and press **Add**. It has to match
   character for character: `127.0.0.1` not `localhost`, `http` not `https`, no
   trailing slash. A mismatch is what *INVALID_CLIENT: Invalid redirect URI*
   means.
3. Tick **Web API** under *which API/SDKs are you planning to use*, agree to the
   terms, **Save**.
4. Open the app's **Settings** and copy the **Client ID** — the long string, not
   the secret. There is no secret to copy: the deck uses the flow that does not
   take one.
5. Paste it into the deck and press **Connect Spotify**. The approval page opens
   in its own window; approve there and it closes itself. The deck shows
   *waiting for approval…* until it lands, and offers a plain link as a
   fallback if the window cannot open.

If it connects but says nothing is playing, start a track first — Spotify only
reports a device that is actually playing — then press **Refresh** and pick the
right device in the dropdown.

Notes:

- Remote control (play/pause/skip) is a **Spotify Premium** feature; reading
  what is playing works on any account.
- Spotify apps start in development mode, so any *other* account has to be added
  to your app's user list. Friends are usually better off making their own app
  and pasting their own Client ID — it takes a minute and costs nothing.
- **Disconnect** in the same panel removes the tokens.
- When both the account and the Windows bridge know a track, the account wins.
  Untick *Prefer the account* to flip that.

## Lyrics

The lyrics window looks for words in this order:

1. an `.lrc` file next to a local track (same name, `.lrc` extension) – offline
2. **lrclib.net**, a free lyrics database with no account or key – only if
   *Look up online* is ticked in the Lyrics tab

Synced lyrics scroll line by line with the song; plain ones glide through in
proportion. Results are cached, so a song is only looked up once. Spotify
tracks can only get lyrics the online way, since nothing else on the PC has
them.

## Send it to friends

Run `build.bat`. It produces `..\dist\Awesome Streaming Deck\` — a folder
— and, if you have Inno Setup, an installer beside it.

A folder rather than one `.exe` on purpose. A single-file PyInstaller build
unpacks itself into a temp folder and runs what it just wrote, which is exactly
what a dropper does, so antivirus engines flag it constantly. A folder build has
nothing to unpack and is far less likely to be flagged — and it starts faster.

For the installer as well:

```
winget install JRSoftware.InnoSetup
```

Then run `build.bat` again. It installs per-user, so there is no administrator
prompt and nothing goes into Program Files.

Their side:

1. Windows 10 or 11, with Chrome or Edge.
2. Windows will still say *"Windows protected your PC"*, because the build is
   not code-signed: **More info → Run anyway**. Only a certificate removes
   that. [ANTIVIRUS.md](ANTIVIRUS.md) sets out the options honestly, including
   the free one for open-source projects, and what to do if a scanner objects.
3. Settings and any pictures they add are saved next to the app, so it keeps to
   its own folder.

Every build writes `dist/SHA256SUMS.txt` so a download can be checked against
what you actually published.

Nothing about your setup travels with the build — they start from the defaults.

## Where things live

```
music-deck/
  server.py          the app: local server, library, state, window control
  overlay.py         opens a pop-out and hides Chrome's title bar
  hostwin.py         the frameless host window (Win32 via ctypes)
  winwin.py          find / move / pin windows
  smtc.ps1, smtc.py  the Windows media-session bridge (Spotify etc.)
  spotify_api.py     optional Spotify account (PKCE OAuth, no secret)
  lyrics.py          .lrc files and lrclib.net, with a cache
  tags.py            reads ID3 / FLAC / MP4 / Ogg / WAV tags and cover art
  paths.py           where files live when running from source vs the .exe
  guard.py           only this PC's own pages may use the server
  components.py      the windows the app can open, and what each needs
  scenes.py          scenes: the store, checks, templates, the phone layout
  sceneio.py         a scene as one .zip, out and back in
  assets.py, fonts.py  the pictures and fonts people add
  capture.py         screen and window capture (Windows Graphics Capture)
  camera.py          the camera, read natively while LIVE
  voice.py           is the streamer talking (for reactive images)
  live.py            going LIVE: RTMP, quality presets, reconnects, the key vault
  mfenc.py, nativelive.py, audio.py   hardware H.264, the compositor, the sound
  web/               the deck and the pop-outs (plain HTML/CSS/JS, no build step)
    canvas.html      the Canvas Builder
    scene.html       a scene's output window
    remote.html      the scene remote
    scenes.js        the generated artwork
    decor.js         the edge frames
  config.json        your settings (created on first run)
  ../built in themes/  artwork shipped with the app; bundled into the .exe
  cache/             library index, album art, lyrics, pictures, fonts, scenes,
                     the stream key (encrypted), Chrome profiles
  build.bat          makes the .exe
```

## If something is off

- **"Port 8713 is busy"** – it is already running; launching again just opens
  the deck. To use another port, edit `"port"` in `config.json`.
- **Spotify shows "unavailable"** – the bridge runs a small PowerShell helper.
  It works with the default Windows security settings; if your machine blocks
  PowerShell scripts entirely, the local-files side still works.
- **Spotify shows nothing** – make sure the Spotify *desktop app* is playing on
  this PC. Playback on your phone or a web player does not show up in Windows.
- **No album art for a file** – the art has to be embedded in the file, or sit
  next to it as `cover.jpg` / `folder.jpg`.
- **Pop-out opened with a title bar** – the deck will say why (usually the
  window could not be measured in time). Close and reopen it.
- **Lyrics say "no lyrics found"** – lrclib.net does not have every song, and
  it matches on title and artist, so odd tags can miss. A `.lrc` file next to a
  local track always wins.
- **Spotify account says "no active device"** – Spotify needs something
  actually playing before it will take remote commands.
- **Spotify account says the account may not use the API** – add that account
  to your app's user list in the Spotify dashboard, or make a separate app.
- **Music on stream** – TikTok, like every platform, can mute or flag streams
  over copyrighted music. Your own files are only as safe as their licence.
- **"TikTok stopped accepting your stream key"** – TikTok has issued a new one.
  Copy it from LIVE Producer (`livecenter.tiktok.com/producer`), paste it in the
  LIVE panel and Save. A new LIVE always needs the new key.
- **The LIVE panel says Reconnecting…** – the connection to TikTok dropped. It
  keeps trying by itself; check your internet, or lower the quality if your
  upload is short.
- **A scene is missing after a crash** – look in `cache\scenes` for a
  `.corrupt` file: that scene could not be read, and no good backup of it was
  left. The Canvas Builder says which one when it starts.
- **An imported scene has an outlined empty box** – a picture it uses was not in
  the .zip. Pick another from **Assets**, or ask for the file.
