"""
Live captions with Whisper.

Windows' built-in dictation engine is quick but guesses a lot. This runs
OpenAI's Whisper instead - through faster-whisper, int8 on the CPU - which is
far more accurate and still never sends a sound anywhere: the model sits in
cache/models and everything happens on this machine.

Whisper reads a clip and writes what was said; it does not stream. So the
streaming is done here, around it:

  * the microphone is read in 32 ms blocks at 16 kHz;
  * Silero VAD (it ships inside faster-whisper) scores each block for speech;
  * while someone talks, the phrase so far is re-read every half second with
    the quick greedy decoder - that is the live, still-changing line;
  * a pause ends the phrase: it is read once more with the careful beam
    decoder and becomes a finished line;
  * someone who never pauses still gets finished lines: once a phrase runs
    long, every sentence Whisper has closed except the last is committed and
    the audio behind it let go.

It speaks the Windows helper's little protocol - ready / partial / final /
audio messages - so nothing downstream can tell the two engines apart.
"""

import collections
import math
import os
import queue
import re
import sys
import time
import types

RATE = 16000
BLOCK = 512                    # Silero's window at 16 kHz: 32 ms
BLOCK_S = BLOCK / RATE

SPEECH_ON = 0.5                # VAD score that starts a phrase
SPEECH_OFF = 0.35              # ...and below which a block counts as quiet
PRE_ROLL_S = 0.3               # audio kept from just before speech starts
END_SILENCE_S = 0.5            # a pause this long ends the phrase
MIN_VOICED_S = 0.25            # shorter than this is a cough or a click
PARTIAL_EVERY_S = 1.0          # how often the live line is re-read
COMMIT_AFTER_S = 7.0           # long phrases start committing sentences
FORCE_AFTER_S = 14.0           # ...and are cut outright if Whisper never closes one
TAIL_PAD_S = 0.2               # quiet left on the end of a finished phrase
DEAD_MIC_S = 3.0               # this long of digital silence means a muted mic
NO_AUDIO_S = 2.0               # this long with no audio at all: say so
REOPEN_AFTER_S = 5.0           # ...and after this long, open the microphone again

# Speed. Whisper's encoder is built for 30 s windows and costs the same
# whatever is in them, so a three-second phrase is 90% padding: 0.86 s per
# read on a Ryzen 9 laptop at 4 threads. Sizing the window to the phrase
# brings a read down to ~0.2 s. Measured on a noisy test stream: windows cut
# tighter than 10 s start looping and dropping punctuation (9% word errors);
# 10 s with 2 s of quiet after the phrase matched the full 30 s window's 2%,
# with first words on screen in 0.74 s instead of 1.74 s.
SHORT_WINDOW = True
WINDOW_PAD_S = 2.0
WINDOW_MIN_S = 10.0
FINAL_BEAM = 5                 # beam width for finished lines; 1 = greedy

# CPU. Measured on non-stop speech (the worst case), share of a 16-thread
# CPU: 6 threads re-reading every 0.4 s took 25.5%; letting idle threads
# sleep instead of spin took that to 15%; 2 threads to 8%; re-reading once
# a second to 5.3% - with no change at all in accuracy. Finished lines only
# (no live words) is 1.7%.
THREADS = 2                    # CPU threads for Whisper; 0 = pick from the machine
# Live re-reads (the words shown while you still talk) run on a one-thread copy
# of the model. Base.en barely speeds up on a second thread, so one thread does
# the same work at half the peak, and the budget then affords more re-reads -
# live words came sooner. Finished lines keep THREADS, where beam search does
# use them. 0 = one model for everything.
LIVE_THREADS = 1
LIVE_PARTIALS = True           # default for re-reading the phrase while it is spoken
# Real conversation barely pauses, so every re-read covers a long stretch and
# costs more than the test recording's short sentences: measured live at 9%
# of the CPU with a fixed one-second pace. Instead the live line may use this
# many cores on average - a read that took longer pushes the next one out.
LIVE_BUDGET_CORES = 0.45
_window = {"full": False}      # set while a stuck read is retried at 30 s


def _looks_stuck(segs, dur):
    """Has Whisper gone round in a loop? A window cut to the phrase very
    occasionally sends it off repeating one word ("today today today..."),
    a failure a full window almost never shows."""
    words = [w.strip(".,!?;:\"'").lower() for w in " ".join(s.text for s in segs).split()]
    if len(words) > 6 * dur + 8:            # nobody says six words a second
        return True
    run = 1
    for a, b in zip(words, words[1:]):
        run = run + 1 if a == b else 1
        if run >= 4:
            return True
    # ...or starts a sentence over ("how far we can climb. Today we are going
    # to try the new ranked"): the same five words twice in one breath.
    grams = [tuple(words[i:i + 5]) for i in range(len(words) - 4)]
    if len(grams) != len(set(grams)):
        return True
    return any(s.compression_ratio > 2.2 for s in segs)

# Whisper's well-known inventions on noise and music. Only whole lines that
# are nothing but one of these are dropped; real speech is never filtered.
JUNK = re.compile(
    r"^\W*(?:\[[^\]]*\]|\([^)]*\)|[♪♫\s]+|"
    r"(?:subtitles?|captions?|transcri(?:bed|ption)) by\b.*|.*\bamara\.org\b.*|"
    r"thanks? for watching[.!]*)\W*$",
    re.I)


def load_whisper():
    """Import faster-whisper, leaving PyAV out.

    faster-whisper imports PyAV at the top of its audio module, to decode
    files. Live captions hand it raw samples and never decode anything, so
    the build leaves PyAV's 60 MB of FFmpeg out and a stand-in satisfies the
    import. From source, a real PyAV is used if one is installed.
    """
    # CTranslate2's OpenMP threads spin for 200 ms after every read by
    # default, burning a core each while there is nothing to do. It has to be
    # set before the runtime loads, which is the import just below.
    os.environ.setdefault("KMP_BLOCKTIME", "0")
    if "av" not in sys.modules:
        try:
            import av  # noqa: F401
        except ImportError:
            sys.modules["av"] = types.ModuleType("av")
    from faster_whisper import WhisperModel
    from faster_whisper.vad import get_vad_model
    import faster_whisper.transcribe as fwt
    if SHORT_WINDOW and not getattr(fwt, "_deck_short_window", False):
        # faster-whisper pads every clip's features to 3000 frames (30 s)
        # before encoding. Pad to the phrase instead; the encoder takes any
        # even length up to 3000.
        full = fwt.pad_or_trim

        def pad_to_phrase(array, length=3000, axis=-1):
            if _window["full"]:
                return full(array, length=length, axis=axis)
            frames = array.shape[axis]
            want = min(length, max(int(WINDOW_MIN_S * 100), frames + int(WINDOW_PAD_S * 100)))
            return full(array, length=want + want % 2, axis=axis)

        fwt.pad_or_trim = pad_to_phrase
        fwt._deck_short_window = True
    return WhisperModel, get_vad_model


def clean_words(words):
    """The expected-words hint, tidied: one line, commas spaced, bounded."""
    return " ".join((words or "").replace(",", ", ").split())[:300]


def _input_devices():
    """(index, name) of each microphone, once - through MME, which lists every
    device exactly once and resamples to 16 kHz inside Windows itself."""
    import sounddevice as sd
    mme = next((i for i, h in enumerate(sd.query_hostapis()) if h["name"] == "MME"), None)
    out, seen = [], set()
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] < 1:
            continue
        if mme is not None and d["hostapi"] != mme:
            continue
        name = d["name"].strip()
        if not name or name in seen or "Sound Mapper" in name:
            continue
        seen.add(name)
        out.append((i, name))
    return out


def list_microphones():
    try:
        return [name for _, name in _input_devices()]
    except Exception:
        return []


class StreamingVAD:
    """Silero, one 32 ms block at a time, keeping its memory between blocks.

    faster-whisper's own wrapper scores a whole file at once and starts from
    a blank state every call; a live stream has to carry the state across."""

    def __init__(self, get_vad_model):
        import numpy as np
        self.np = np
        self.session = get_vad_model().session
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros((1, 1, 128), dtype=np.float32)
        self.context = np.zeros(64, dtype=np.float32)

    def __call__(self, block):
        np = self.np
        x = np.concatenate([self.context, block])[None, :]
        out, self.h, self.c = self.session.run(
            None, {"input": x, "h": self.h, "c": self.c})
        self.context = block[-64:]
        return float(np.asarray(out).reshape(-1)[-1])


class WhisperListener:
    """One listening session: load, open the microphone, caption until told
    to stop. `emit` receives the same messages captions.ps1 prints."""

    def __init__(self, model_dir, emit, mic="", words="", threads=0, label="Whisper", live=None):
        self.model_dir = model_dir
        self.emit = emit
        self.mic = mic or ""
        # Names and words it should expect - usernames, games, slang. Whisper
        # takes them as a hint, which is most of the difference on names.
        self.words = clean_words(words)
        # Half the machine at most, and never all of it: there is a game and
        # an encoder running too. 16 threads -> 6, 8 -> 3, 4 -> 2.
        self.threads = threads or THREADS or max(2, min(6, (os.cpu_count() or 4) // 2 - 1))
        self.live_threads = LIVE_THREADS if 0 < LIVE_THREADS < self.threads else 0
        self.label = label
        self.context = ""            # what was just said: a prompt for the next line
        # Live words: re-read the phrase while it is spoken. Off, a line is
        # read once, when you pause - about a third of the CPU.
        self.live = LIVE_PARTIALS if live is None else bool(live)
        self._partial_every = PARTIAL_EVERY_S     # stretched to stay inside the budget

    def set_words(self, words):
        """Takes effect from the next read; no restart, no reload."""
        self.words = clean_words(words)

    def set_live(self, on):
        self.live = bool(on)

    # ------------------------------------------------------------- setup

    def load(self):
        import numpy as np
        WhisperModel, get_vad_model = load_whisper()
        self.np = np
        self.model = WhisperModel(self.model_dir, device="cpu", compute_type="int8",
                                  cpu_threads=self.threads, num_workers=1)
        self.live_model = self.model
        if self.live_threads:
            self.live_model = WhisperModel(self.model_dir, device="cpu", compute_type="int8",
                                           cpu_threads=self.live_threads, num_workers=1)
        self._use = self.model
        self.vad = StreamingVAD(get_vad_model)
        # The first decode pays for setting everything up. Pay it now, not
        # on the first thing someone says.
        self._decode(np.zeros(RATE, dtype=np.float32), final=False)
        if self.live_model is not self.model:
            self._decode(np.zeros(RATE, dtype=np.float32), final=True)

    def open_source(self, q):
        """Start the microphone feeding 16 kHz mono float blocks into q."""
        import sounddevice as sd
        device = None
        if self.mic:
            device = next((i for i, name in _input_devices() if name == self.mic), None)

        def callback(indata, frames, when, status):
            q.put(indata[:, 0].copy())

        stream = sd.InputStream(samplerate=RATE, blocksize=BLOCK, channels=1,
                                dtype="float32", device=device, callback=callback)
        stream.start()
        return stream

    def run(self, stop):
        """Caption until stop is set. False means it could not start at all."""
        try:
            self.load()
        except Exception as exc:
            self.emit({"ok": False, "error": f"Whisper could not load: {exc}"})
            return False
        while not stop.is_set():
            q = queue.Queue()
            try:
                stream = self.open_source(q)
            except Exception as exc:
                self.emit({"ok": False, "error": f"Could not open the microphone: {exc}"})
                return False
            self.emit({"ok": True, "ready": True, "recognizer": self.label})
            self.emit({"t": "audio", "state": "silence"})
            try:
                lost = self._loop(q, stop)
            finally:
                try:
                    stream.stop()
                    stream.close()
                except Exception:
                    pass
            if not lost:
                break
            # The microphone stopped delivering sound altogether. Open it
            # again - the model stays loaded - rather than sit "listening" to
            # nothing with the last thing it heard frozen on the deck.
            stop.wait(1.0)
        return True

    # ------------------------------------------------------------- listening

    def _loop(self, q, stop):
        np = self.np
        pending = np.zeros(0, dtype=np.float32)
        preroll = collections.deque(maxlen=max(1, int(PRE_ROLL_S / BLOCK_S)))
        utt = []                 # blocks of the phrase in progress
        speaking = False
        quiet = voiced = since_partial = 0
        dead = 0                 # blocks of pure digital silence in a row
        mic_dead = False
        level_at = 0.0
        last_audio = time.monotonic()
        no_audio = False

        while not stop.is_set():
            try:
                chunk = q.get(timeout=0.1)
            except queue.Empty:
                # Not quiet - nothing at all: the device went away, or Windows
                # stopped delivering it. Say so at once, and after a few
                # seconds hand back to run(), which opens the microphone again.
                gap = time.monotonic() - last_audio
                if gap > NO_AUDIO_S and not no_audio:
                    no_audio = True
                    self.emit({"t": "audio", "state": "stopped"})
                if gap > REOPEN_AFTER_S:
                    return True
                continue
            last_audio = time.monotonic()
            if no_audio:
                no_audio = False
                self.emit({"t": "audio", "state": "silence"})
            pending = np.concatenate([pending, chunk]) if pending.size else chunk

            while pending.size >= BLOCK:
                block, pending = pending[:BLOCK], pending[BLOCK:]
                rms = float(np.sqrt(np.mean(block * block)))

                # A muted or unplugged microphone delivers exact zeros.
                dead = dead + 1 if rms < 1e-7 else 0
                if (dead * BLOCK_S >= DEAD_MIC_S) != mic_dead:
                    mic_dead = not mic_dead
                    self.emit({"t": "audio", "state": "stopped" if mic_dead else "silence"})

                now = time.monotonic()
                if now - level_at >= 0.15:
                    level_at = now
                    db = 20 * math.log10(rms + 1e-9)
                    self.emit({"t": "level", "value": round(min(1.0, max(0.0, (db + 60) / 50)), 2)})

                p = self.vad(block)
                if not speaking:
                    preroll.append(block)
                    if p >= SPEECH_ON:
                        speaking = True
                        utt = list(preroll)
                        preroll.clear()
                        quiet, voiced, since_partial = 0, 1, 0
                        self.emit({"t": "audio", "state": "speech"})
                    continue

                utt.append(block)
                since_partial += 1
                if p >= SPEECH_ON:
                    voiced += 1
                quiet = quiet + 1 if p < SPEECH_OFF else 0

                if quiet * BLOCK_S >= END_SILENCE_S:
                    # The phrase is over: read it carefully, once.
                    keep = len(utt) - quiet + int(TAIL_PAD_S / BLOCK_S)
                    if voiced * BLOCK_S >= MIN_VOICED_S:
                        self._finish(np.concatenate(utt[:max(1, keep)]))
                    else:
                        self.emit({"t": "partial", "text": ""})
                    speaking, utt, quiet, voiced = False, [], 0, 0
                    self.emit({"t": "audio", "state": "silence"})

            # Caught up with the microphone? Then refresh the live line. When
            # a decode runs long the queue fills; this skips partials until
            # the audio is drained, so the captions never fall behind.
            # Without live words a phrase is only read when it ends - or, if it
            # runs on, often enough to commit its finished sentences. The CPU
            # budget only ever slows the live line, never those commits: with
            # a model too slow for the budget (small.en on a laptop) it spaced
            # reads 30 s apart, so phrases grew, each read got slower still,
            # and a minute of non-stop talk committed a single line.
            every = min(self._partial_every, COMMIT_AFTER_S) if self.live else COMMIT_AFTER_S
            if speaking and utt and since_partial * BLOCK_S >= every and q.empty():
                since_partial = 0
                utt = self._live(utt)
        return False

    def _live(self, utt):
        """Re-read the phrase so far; commit what is settled. Returns the
        audio still in play."""
        np = self.np
        audio = np.concatenate(utt)
        dur = audio.size / RATE
        long = dur >= COMMIT_AFTER_S
        # Word timings are only needed to find where to cut a long phrase.
        started = time.monotonic()
        segs = self._decode(audio, final=False, words=long)
        spent = time.monotonic() - started
        # Keep live words inside their CPU budget: the next re-read waits
        # until this one's cost, spread over the wait, fits it.
        self._partial_every = max(PARTIAL_EVERY_S, spent * (self.live_threads or self.threads) / LIVE_BUDGET_CORES)
        if long:
            words = [w for s in segs for w in (s.words or [])]
            ends = [i for i, w in enumerate(words[:-1])
                    if w.word.strip().endswith((".", "!", "?"))]
            if ends:
                # Long and still going: every sentence Whisper has closed
                # except the one in progress is as good as final. Commit them,
                # and keep the audio from the middle of the pause after the
                # last one - Whisper's segments are too coarse to cut on.
                i = ends[-1]
                self._final("".join(w.word for w in words[:i + 1]).strip(), segs)
                cut = int((words[i].end + words[i + 1].start) / 2 * RATE)
                rest = audio[cut:]
                self.emit({"t": "partial", "text": "".join(w.word for w in words[i + 1:]).strip()})
                return [rest] if rest.size else []
        if dur >= FORCE_AFTER_S:
            # No sentence break to cut at: take it all, carefully, and go on.
            self._finish(audio)
            return []
        self.emit({"t": "partial", "text": self._text(segs)})
        return [audio]

    # ------------------------------------------------------------- decoding

    def _read(self, audio, opts, full_window=False):
        _window["full"] = full_window
        try:
            segments, _info = self._use.transcribe(audio, **opts)
            return list(segments)
        finally:
            _window["full"] = False

    def _decode(self, audio, final, words=False):
        dur = audio.size / RATE
        opts = dict(language="en", task="transcribe", vad_filter=False,
                    condition_on_previous_text=False,
                    without_timestamps=not words, word_timestamps=words,
                    initial_prompt=self.context or None,
                    hotwords=self.words or None, suppress_blank=True,
                    # Speech runs to three or four tokens a second. A read past
                    # seven is looping, and capping it caps the wait.
                    max_new_tokens=int(dur * 7) + 12)
        if final:
            # Careful: a wider search, and a warmer retry if the first read
            # looks like nonsense (the thresholds are Whisper's own).
            opts.update(beam_size=FINAL_BEAM, best_of=1, temperature=[0.0, 0.2, 0.4])
        else:
            opts.update(beam_size=1, best_of=1, temperature=0.0)
        self._use = self.model if final else self.live_model
        segments = self._read(audio, opts)
        if SHORT_WINDOW and _looks_stuck(segments, dur):
            # Read that phrase again the standard way, over a full window. That
            # read is the heavy one, so it gets every thread even when a live
            # re-read started it: on one thread it held up the next finished
            # line by several seconds.
            self._use = self.model
            segments = self._read(audio, opts, full_window=True)
        keep = []
        for s in segments:
            text = s.text.strip()
            if not text:
                continue
            if s.no_speech_prob > 0.6 and s.avg_logprob < -1.0:
                continue            # Whisper itself thinks nobody spoke
            if JUNK.match(text):
                continue
            keep.append(s)
        return keep

    @staticmethod
    def _text(segs):
        return " ".join(" ".join(s.text.split()) for s in segs).strip()

    def _finish(self, audio):
        segs = self._decode(audio, final=True)
        self._final(self._text(segs), segs)

    def _final(self, text, segs):
        if not text:
            self.emit({"t": "partial", "text": ""})
            return
        logprobs = [s.avg_logprob for s in segs] or [-1.0]
        conf = round(min(1.0, math.exp(sum(logprobs) / len(logprobs))), 2)
        if len(text.split()) <= 2 and conf < 0.45:
            # A lone "So" or "you" that Whisper itself barely believes is it
            # filling a quiet tail, not something said; real one-word replies
            # read far more confidently than this.
            self.emit({"t": "partial", "text": ""})
            return
        self.emit({"t": "final", "text": text, "conf": conf})
        self.context = (self.context + " " + text).strip()[-220:]
