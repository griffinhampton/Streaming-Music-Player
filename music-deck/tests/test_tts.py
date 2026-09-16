"""Text to speech (T7): what may be read out, and the helper that reads it.

clean_text() is arithmetic over a string, so it is tested exhaustively here.
The process handling is tested against a stand-in helper - a few lines of
Python speaking the same JSON-lines protocol as tts.ps1 - because the part
worth testing is what Voice does when a helper hangs, dies or answers with
nothing, and the real one cannot be made to do those on demand. The real one
is exercised too, last, and skipped only on a machine with no voice at all.
"""
import base64
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tts  # noqa: E402

FAKE = r'''
import sys, json, base64
print(json.dumps({"ok": True, "ready": True}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if req.get("op") == "voices":
        print(json.dumps({"ok": True, "op": "voices", "voices": [{"name": "Stand-in", "culture": "en-US"}]}), flush=True)
        continue
    t = req.get("text", "")
    if t == "hang":
        continue                                   # never answers
    if t == "die":
        sys.exit(1)
    wav = b"junk" if t == "junk" else b"RIFF\0\0\0\0WAVEfmt " + t.encode() + b"\0" * 64
    print(json.dumps({"ok": True, "op": "say", "id": req["id"], "wav": base64.b64encode(wav).decode()}), flush=True)
'''


class WhatMayBeReadOut(unittest.TestCase):
    def test_plain_text_passes_untouched(self):
        self.assertEqual(tts.clean_text("hello there"), ("hello there", ""))

    def test_nothing_to_say_is_refused(self):
        for t in ("", "   ", None, "\x00\x01\n\t"):
            text, why = tts.clean_text(t)
            self.assertIsNone(text, repr(t))
            self.assertTrue(why)

    def test_a_link_is_read_as_a_link(self):
        """Nobody on stream wants a URL spelled out, and a link read aloud is
        an advert whoever posted it."""
        self.assertEqual(tts.clean_text("go to https://evil.example/x?y=1 now")[0], "go to a link now")
        self.assertEqual(tts.clean_text("www.evil.example is great")[0], "a link is great")

    def test_stretched_letters_are_flattened(self):
        self.assertEqual(tts.clean_text("noooooooo")[0], "nooo")
        self.assertEqual(tts.clean_text("!!!!!!!!!!")[0], "!!!")

    def test_the_length_cap_cuts_at_a_word(self):
        text, _ = tts.clean_text("word " * 100, maxlen=30)
        self.assertLessEqual(len(text), 30)
        self.assertFalse(text.endswith("wor"))            # never half a word
        self.assertTrue(text.endswith("word"))

    def test_the_cap_is_clamped_and_survives_nonsense(self):
        """Exact lengths, on text with no repeated letter and no space. The
        first version used "x" * 900, which the stretch rule rightly squashes
        to "xxx" before the cap is ever reached - so "at most 500" passed on a
        three-letter string, and only "at least 20" noticed."""
        long = "abcdefghij" * 90
        self.assertEqual(len(tts.clean_text(long, maxlen=99999)[0]), 500)
        self.assertEqual(len(tts.clean_text(long, maxlen=1)[0]), 20)
        self.assertEqual(len(tts.clean_text(long, maxlen="lots")[0]), tts.MAXLEN)

    def test_a_blocked_word_refuses_the_whole_message(self):
        text, why = tts.clean_text("you are a Badword today", blocked="badword")
        self.assertIsNone(text)
        self.assertIn("blocked", why)

    def test_stretching_a_blocked_word_does_not_get_it_past(self):
        self.assertIsNone(tts.clean_text("baaaadword", blocked="badword")[0])

    def test_phrases_and_both_separators(self):
        self.assertIsNone(tts.clean_text("please buy now", blocked="spam, buy now")[0])
        self.assertIsNone(tts.clean_text("so spammy spam", blocked="nope\nspam")[0])

    def test_a_blocked_word_inside_another_word_is_not_a_match(self):
        """The control. "ass" must not refuse "class", or the list becomes a
        reason nobody's messages get read."""
        self.assertEqual(tts.clean_text("a class act", blocked="ass")[0], "a class act")

    def test_the_list_is_normalised(self):
        self.assertEqual(tts.blocked_words(" One , two\n\nONE,  three  words "), ["one", "two", "three words"])


class TheHelper(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cls.fake = os.path.join(cls.dir, "fake_tts.py")
        with open(cls.fake, "w", encoding="utf-8") as f:
            f.write(FAKE)

    def spawn(self):
        return subprocess.Popen([sys.executable, self.fake], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)

    def voice(self, **kw):
        v = tts.Voice(spawn=self.spawn, say_timeout=kw.get("say_timeout", 5), start_timeout=10)
        self.addCleanup(v.close)
        return v

    def test_a_clip_is_made_and_kept_for_the_page(self):
        v = self.voice()
        ok, cid = v.say_and_wait("hello")
        self.assertTrue(ok, cid)
        self.assertEqual(v.clip(cid)[:4], b"RIFF")
        self.assertIsNone(v.clip("0000000000000000"))

    def test_the_voices_are_listed(self):
        self.assertEqual([x["name"] for x in self.voice().voices()], ["Stand-in"])

    def test_a_hung_helper_is_let_go_and_the_next_message_still_works(self):
        v = self.voice(say_timeout=1)
        ok, why = v.say_and_wait("hang")
        self.assertFalse(ok)
        self.assertIn("too long", why)
        self.assertTrue(v.say_and_wait("after")[0])        # a new helper, started for it

    def test_a_dead_helper_is_replaced(self):
        v = self.voice()
        self.assertFalse(v.say_and_wait("die")[0])
        self.assertTrue(v.say_and_wait("after")[0])

    def test_an_answer_that_is_not_sound_is_not_kept(self):
        v = self.voice()
        ok, why = v.say_and_wait("junk")
        self.assertFalse(ok)
        self.assertIn("no sound", why)

    def test_the_queue_refuses_past_its_depth(self):
        """The last line of defense against a flood the engine let through."""
        v = self.voice(say_timeout=2)
        old = tts.MAX_WAITING
        tts.MAX_WAITING = 2
        self.addCleanup(setattr, tts, "MAX_WAITING", old)
        self.assertTrue(v.say("hang")[0])
        self.assertTrue(v.say("hang")[0])
        ok, why = v.say("one too many")
        self.assertFalse(ok)
        self.assertIn("too much to say", why)

    def test_clips_are_kept_a_little_while_not_for_ever(self):
        v = self.voice()
        old = tts.KEEP_CLIPS
        tts.KEEP_CLIPS = 3
        self.addCleanup(setattr, tts, "KEEP_CLIPS", old)
        ids = [v.say_and_wait(f"clip {i}")[1] for i in range(4)]
        self.assertIsNone(v.clip(ids[0]))
        self.assertIsNotNone(v.clip(ids[3]))

    def test_a_helper_that_never_starts_says_so(self):
        v = tts.Voice(spawn=lambda: (_ for _ in ()).throw(OSError("no PowerShell here")), start_timeout=2)
        ok, why = v.say_and_wait("hello", timeout=10)
        self.assertFalse(ok)
        self.assertIn("PowerShell", why)


@unittest.skipUnless(os.name == "nt" and shutil.which("powershell"), "Windows' own voices, which need Windows")
class TheRealVoice(unittest.TestCase):
    """tts.ps1 itself: the protocol above, spoken by the real helper."""

    def test_it_makes_a_real_wav(self):
        v = tts.Voice()
        self.addCleanup(v.close)
        if not v.voices():
            self.skipTest("this machine has no voice installed")
        ok, cid = v.say_and_wait("Testing the voice", timeout=60)
        self.assertTrue(ok, cid)
        wav = v.clip(cid)
        self.assertEqual((wav[:4], wav[8:12]), (b"RIFF", b"WAVE"))
        self.assertGreater(len(wav), 4000)                 # a second of speech, not a header


if __name__ == "__main__":
    unittest.main()
