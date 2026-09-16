"""The asset store: what it will keep, how big, and what it calls things.

Written with the audio class (T3), because nothing here was covered before and
the audio work touches all three of the store's decisions at once - which
extensions are allowed, which size cap applies, and what `kind` the pages are
told. That last one is not cosmetic: `renderAssetGrid` filters on it, and an
unlisted kind is a file the picker will not offer. That is exactly how every
animated GIF in the app came to be invisible in every picture picker.

Two halves, and they are checked in different places on purpose:

  An **upload** is allowed by extension and size only. `save_bytes` does not
  look inside the file. That is the behaviour for pictures too, and this
  records it rather than implying otherwise.

  An **import** is checked byte by byte, because a scene .zip comes from
  somebody else: `sceneio.MAGIC` has to recognise a real file and refuse one
  wearing the wrong extension. Those validators are tested here with a
  negative control each, since a validator that returns True for everything
  passes an import of anything.
"""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DECK = os.path.dirname(HERE)
sys.path.insert(0, DECK)

import assets  # noqa: E402
import sceneio  # noqa: E402

MB = 1024 * 1024
STORE = assets.AssetStore

# Just enough of a real file for the magic checks, and one impostor each.
REAL = {
    ".mp3": b"ID3\x03\x00\x00\x00" + b"\x00" * 32,
    ".ogg": b"OggS\x00\x02" + b"\x00" * 32,
    ".wav": b"RIFF\x24\x00\x00\x00WAVEfmt ",
    ".m4a": b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 16,
}
IMPOSTOR = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


class WhatItCallsThings(unittest.TestCase):
    def test_sound_is_its_own_kind(self):
        for ext in STORE.AUDIO_EXT:
            self.assertEqual(STORE.kind_of("x" + ext), "audio", ext)

    def test_the_other_kinds_did_not_move(self):
        """The control. "audio" was inserted ahead of the video test, so this
        is what notices if it swallowed one of the others."""
        self.assertEqual(STORE.kind_of("x.mp4"), "video")
        self.assertEqual(STORE.kind_of("x.webm"), "video")
        self.assertEqual(STORE.kind_of("x.png"), "image")
        self.assertEqual(STORE.kind_of("x.gif", True), "gif")
        self.assertEqual(STORE.kind_of("x.gif", False), "image")

    def test_every_audio_extension_has_a_type_to_serve_it_as(self):
        """`/asset` now takes the type from this table rather than from the
        OS, so a missing entry would serve a clip as something else."""
        for ext in STORE.AUDIO_EXT:
            self.assertTrue(STORE.OK_EXT.get(ext, "").startswith("audio/"),
                            f"{ext} -> {STORE.OK_EXT.get(ext)!r}")


class HowBigItMayBe(unittest.TestCase):
    def test_sound_has_a_cap_of_its_own_between_the_other_two(self):
        """A minute of wav is about 10 MB, so the picture cap would refuse
        ordinary clips; the video cap would let somebody park an album here."""
        self.assertGreater(STORE.MAX_AUDIO_BYTES, STORE.MAX_BYTES)
        self.assertLess(STORE.MAX_AUDIO_BYTES, STORE.MAX_VIDEO_BYTES)

    def test_a_clip_bigger_than_a_picture_may_be_is_still_kept(self):
        """The point of the new cap, and the case the old code refused."""
        with tempfile.TemporaryDirectory() as tmp:
            store = STORE(tmp)
            raw = REAL[".mp3"] + b"\x00" * (STORE.MAX_BYTES + MB)
            res = store.save_bytes("clip.mp3", raw)
            self.assertTrue(res.get("ok"), res.get("reason"))

    def test_but_not_one_over_its_own_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = STORE(tmp)
            raw = b"\x00" * (STORE.MAX_AUDIO_BYTES + 1)
            res = store.save_bytes("huge.mp3", raw)
            self.assertFalse(res.get("ok"))
            self.assertIn("larger than", res.get("reason", ""))

    def test_a_file_type_it_does_not_keep_is_refused_by_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            res = STORE(tmp).save_bytes("notes.txt", b"hello")
            self.assertFalse(res.get("ok"))
            self.assertIn(".txt", res.get("reason", ""))


class WhatAnImportWillAccept(unittest.TestCase):
    """Uploads are checked by extension; imports are checked byte by byte,
    because the .zip came from somebody else."""

    def test_a_real_header_is_recognised(self):
        for ext, raw in REAL.items():
            self.assertTrue(sceneio.MAGIC[ext](raw), ext)

    def test_an_mp3_may_also_open_on_a_frame_sync(self):
        """Not every mp3 carries an ID3 tag."""
        self.assertTrue(sceneio.MAGIC[".mp3"](b"\xff\xfb\x90\x00"))

    def test_a_file_wearing_the_wrong_extension_is_refused(self):
        """The control. Without this, a validator that answered True to
        everything would let an import carry anything at all."""
        for ext in REAL:
            self.assertFalse(sceneio.MAGIC[ext](IMPOSTOR), ext)

    def test_a_truncated_file_is_refused_rather_than_throwing(self):
        """An upload cut short must read as "not that file type", not as an
        IndexError inside an import that was checking it."""
        for ext in REAL:
            for raw in (b"", b"\xff", b"OG"):
                self.assertFalse(sceneio.MAGIC[ext](raw), f"{ext} {raw!r}")

    def test_an_imported_scene_may_carry_sound(self):
        """The id and file patterns gate what an import will even look at, so
        sound has to be in them or a shared scene arrives without its clips."""
        self.assertTrue(sceneio.ASSET_ID.match("0123456789abcdef.mp3"))
        self.assertTrue(sceneio.ASSET_FILE.match("assets/0123456789abcdef.wav"))
        self.assertFalse(sceneio.ASSET_ID.match("0123456789abcdef.exe"))


if __name__ == "__main__":
    unittest.main()
