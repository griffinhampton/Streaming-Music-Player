# Music Deck

A local "now playing" rig for streaming. It binds to `127.0.0.1` only, so
nobody on your network can even see it, and it works fully offline out of the
box. Two things can reach the internet, both optional and both off unless you
turn them on: lyric lookup (a checkbox) and connecting your Spotify account
(a setup you have to go through on purpose).

Three windows:

- **Music Deck** – the control room. Library, playback, Spotify controls, and
  every design setting with a live preview. Its player card follows whatever is
  actually playing, local or Spotify, and its transport, seek bar and volume
  drive that source.
- **Music Deck - Now Playing** – the pop-out you add to TikTok Studio. Borderless,
  any size or shape.
- **Music Deck - Lyrics** – a pop-out that scrolls the words in time with the
  song. Optional.
- **Music Deck - Queue** – a pop-out listing what Spotify plays next. Optional,
  and needs the Spotify account connected.

Two sources, picked automatically or by hand:

- **Your own files** – mp3, flac, m4a, wav, ogg, opus. Point it at a folder.
- **Spotify** – two ways, and you can use either:
  - **Straight from Windows** (default, nothing to set up): the media session
    the volume pop-up reads. Title, artist, album art, progress, transport.
    Needs the Spotify desktop app playing on this PC.
  - **Your Spotify account** (optional, see below): also sees playback on your
    phone, the web player or a Connect speaker, and can control it from there.

## Start it

- **From the .exe** – double-click `Music Deck.exe`. First launch takes a few
  seconds while it unpacks. The deck window opens on its own. **Quit** in the
  top-right stops everything.
- **From source** – double-click `Start Music Deck.bat` (needs Python 3.10+).
  Close the black window to stop.

Chrome or Edge has to be installed (Edge always is on Windows 10/11).

## Put it on stream (TikTok Studio)

1. In the deck, click **Open on-screen window**.
2. TikTok Studio → **Add source → Window** → pick **Music Deck - Now Playing**.
3. Size and place it on your canvas like any other source.
4. Want lyrics or the queue? **Lyrics tab** / **Queue tab → Open window**, then
   add **Music Deck - Lyrics** or **Music Deck - Queue** the same way.

The windows do not need to stay visible on your desktop – window capture reads
the window itself, even behind a fullscreen game.

Audio: music from your files plays out of the deck window, which is Chrome.
Capture desktop audio, or add Chrome as an application audio source. Spotify's
audio is Spotify's as usual.

## Move, resize, reshape

- Drag a pop-out by its body to move it. Hover it for the close button.
- Grab the **bottom-right corner** of a pop-out and stretch it any way you like.
  With layout on **Auto**, the card re-arranges itself for the shape: wide
  becomes a bar, square becomes a stacked card, a thin strip goes compact.
- **Window tab** has shape presets (horizontal, wide strip, square, portrait,
  slim), exact width and height, snap-to-corner, and always-on-top.

Sizes are in real screen pixels, and the preview shows the pop-out at the
size it actually has on screen.

## Make it yours

Everything in the **Design** panel changes the pop-out live in the preview.

- **Theme** – one click restyles the deck *and* the pop-out. Watercolour
  Blossom, Hanami, Cutecore, Bloom, Sakura Night, Red Moon, Embers, Midnight,
  Minimal, Dark, Light, Neon Arcade, Vaporwave, Terminal.
- **Background → Artwork** – generated scenes: watercolour blossoms, cherry
  blossoms, cute doodles, red moon, embers. Three colours, motif size, density,
  tile size and a shuffle button, so no two setups look alike. Nothing is
  downloaded; the art is drawn on the fly.
- **Layout / Text / Art & bar** – fonts, sizes, colours, gradients, dropped-in
  images, corner radius, glow, card fill and its opacity, progress bar style.
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
  Emoticons next to the label.
- **Stickers** – drop PNGs onto the preview, then drag them into place. Size,
  rotation, opacity, flip, in front of or behind the card.
- **Lyrics** – text size, lines shown, alignment, timing nudge, whether it
  matches the pop-out's look.
- **Queue** – heading, album art, artist, track length, and whether to include
  the track playing right now. It shows **as many tracks as fit**: text size
  follows the window's width, so making the window taller adds more of the queue
  rather than enlarging what is already there. The tracks setting is just a
  ceiling.
- **App look** – restyle the deck itself: colours, font, density, a wallpaper
  from the same generated artwork or your own image, a frame, an emoticon.

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

Needed for the queue view, search and device switching, and for playback on your
phone or the web player to show up at all. Without it the deck still reads the
Spotify desktop app through Windows, which covers the common case.

It uses the PKCE flow, so there is no client secret to keep safe. Tokens are
stored in `cache/spotify_token.json` on your PC and go nowhere else.

1. Spotify panel → **Connect account…**
2. Open **developer.spotify.com/dashboard** → **Create app**. Any name.
3. In **Redirect URIs** paste exactly what the deck shows:
   `http://127.0.0.1:8713/spotify/callback`
4. Copy the app's **Client ID** into the deck and press **Connect Spotify**.
   Spotify's approval page opens in its own window; approve there and it closes
   itself. The deck shows *waiting for approval…* until it lands, and offers a
   plain link as a fallback if the window cannot open.

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

Run `build.bat` once. It produces `..\dist\Music Deck.exe` – a single file.
Send that. Their side:

1. Windows 10 or 11, with Chrome or Edge.
2. Double-click it. SmartScreen says "Windows protected your PC" because the
   file is not code-signed: **More info → Run anyway**. That is a one-time
   prompt.
3. Their settings and any images they add are saved next to the .exe
   (`config.json` and a `cache` folder), so put it in its own folder.

Nothing about your setup travels with the file – they start from the defaults.

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
  web/               the deck and the pop-outs (plain HTML/CSS/JS, no build step)
    scenes.js        the generated artwork
    decor.js         the edge frames
  config.json        your settings (created on first run)
  cache/             library index, album art, lyrics, uploads, Chrome profiles
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
