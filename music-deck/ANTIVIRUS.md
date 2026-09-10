# Why Windows warns about this, and what actually fixes it

Short version: **there is no build flag, packer setting or trick that removes
the SmartScreen warning. Only a code signing certificate does that.** Everything
else on this page reduces false positives from *antivirus* engines, which is a
different problem with a different answer. Anyone who tells you otherwise is
describing evasion, which is both wrong and counter-productive — the techniques
that hide a binary from a scanner are the exact techniques scanners look for.

There are two separate things that go wrong, and they get confused constantly.

---

## 1. "Windows protected your PC" — SmartScreen

This blue dialog is **not** antivirus. It is a reputation check. SmartScreen asks
"have I seen this exact file, signed by this exact publisher, enough times to
trust it?" A brand-new unsigned file has no reputation, so it gets stopped.

**What fixes it:** signing the executable with a code signing certificate, so
reputation accrues to the *publisher* rather than to each individual file.

**What does not fix it:** anything about how the file is built. An unsigned
binary is unsigned no matter how it is packaged, and it will keep warning
until enough people download it for reputation to build on its own — which for
a small tool may be never.

### Getting a certificate

The build already runs on GitHub Actions (`.github/workflows/build.yml`), which
is the prerequisite SignPath cares about most: it signs artifacts produced by a
pipeline anyone can read, never files uploaded from a desktop. That is what
makes a signature evidence rather than decoration.


| Route | Cost | Notes |
|---|---|---|
| **SignPath Foundation** | Free | For OSS projects. Signs from your CI, key never touches your machine. Requires a public repo, an OSI licence and a reproducible build. This is the right answer for this project. |
| **Certum Open Source** | ~€30/yr | Cheapest real certificate. Hardware token posted to you. Identity verification required. |
| Standard OV certificate | ~£150–300/yr | Reputation still builds gradually after signing. |
| EV certificate | ~£250–400/yr | Instant SmartScreen reputation. Hardware token. Usually needs a registered company. |

For an open-source streaming tool, **SignPath Foundation** is the one to apply
for. It is free, it is designed for exactly this, and it does not require you to
handle a private key.

Until then, the honest thing is to say so on the download page — which
`INSTALL-NOTES.txt` does — rather than pretend the warning means nothing.

---

## 2. An antivirus calls it a trojan

This one is a genuine false positive, and it *is* mostly fixable.

The cause is PyInstaller, not this app. A `--onefile` build is a single
executable that unpacks a Python runtime into a temp folder and executes what it
just wrote. That behaviour is indistinguishable, to a heuristic scanner, from a
dropper. Worse, the PyInstaller bootloader ships pre-compiled and identical for
everyone, so once one piece of malware is built with it, that exact byte pattern
lands in signature databases and every innocent app built the same way inherits
the detection.

### What this project already does about it

- **Builds `--onedir`, not `--onefile`.** Nothing self-extracts, nothing writes
  and then executes. This is the single biggest reduction in false positives,
  and it is why the app ships as a folder with an installer rather than one
  loose `.exe`.
- **Carries a version resource** (`version.txt`) — company, description,
  version, licence. Unsigned *and* blank-metadata is a combination heuristics
  weight against; there is no reason to look like that.
- **Ships an icon and an installer**, for the same reason.
- **Publishes SHA-256 checksums** with every build, so a download can be checked
  against what was actually published.

### If you still get flagged

1. **Report it as a false positive.** This genuinely works and usually turns
   around in a day or two.
   - Microsoft Defender: <https://www.microsoft.com/wdsi/filesubmission>
   - Others: search "<vendor> false positive submission".
   Quote the SHA-256 from `SHA256SUMS.txt` and link the source.

2. **Check it properly first.** Upload to <https://virustotal.com>. Two or three
   obscure engines flagging it is the normal false-positive pattern. Fifteen
   engines including the majors means something is actually wrong — investigate
   rather than reporting.

3. **Build the PyInstaller bootloader from source.** This gives you a bootloader
   that is uniquely yours and therefore matches nobody's signature database. It
   is a documented, supported PyInstaller step — not a trick:

   ```
   pip download --no-binary :all: --no-deps pyinstaller
   tar -xf pyinstaller-*.tar.gz && cd pyinstaller-*/bootloader
   python ./waf all
   cd .. && pip install .
   ```

   Do this in `.build-env` and rebuild. It needs a C compiler.

---

## Verifying a download

Every build writes `dist/SHA256SUMS.txt`. To check a file matches:

```powershell
Get-FileHash ".\Awesome Music Streaming Deck.exe" -Algorithm SHA256
```

Compare against the value published with the release. If they differ, do not run
it — and tell me, because that would mean something is wrong upstream.

---

## Building it yourself

The most convincing answer to "is this safe" is not to take anyone's word:

```
git clone https://github.com/griffinhampton/Streaming-Music-Player
cd Streaming-Music-Player/music-deck
build.bat
```

It needs Python 3.10+. Everything the app does is in plain Python and plain
HTML/CSS/JS in this repository — there is no build step for the front end and
nothing minified. `server.py` binds to `127.0.0.1` and nowhere else; that is one
line, and you can read it.
