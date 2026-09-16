"""Chat is text, and only ever text.

Asked for on 2026-09-15, in the user's words: "make sure the screen reader
cant run scripts or code chatters might text out to be malicious!"

A chatter's words go four places, and in none of them may they become code:

  * the reader in the user's TikTok page (tiktok_chat.OBSERVER) takes them as
    textContent and hands them over as a JSON string - never markup, never
    evaluated, and the only script ever run in that page is the fixed one;
  * the parser (chat.message) keeps markup as the characters it is and strips
    what can only mislead - direction overrides and control characters;
  * the voice (tts.ps1) reads them with the plain-text Speak(), never the
    markup one, and receives them as JSON on stdin, never on a command line;
  * every page that draws them - on stream and off - sets text or escapes.

Each of those is pinned here. tools/ui/tiktokchat.js then sends real attack
lines through a page shaped like TikTok's and checks that nothing runs.

The hidden characters in these tests are built with chr(), never typed or
escaped in the source. The first version of this file used \\u escapes, and
the editor that wrote it turned them into the real characters - so the source
itself carried direction overrides, the "Trojan Source" trick of code that
reads one way and runs another. The last test here keeps them out for good.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import chat  # noqa: E402
import tiktok_chat  # noqa: E402

RLO, LRI, PDI, BOM, ZWSP, ZWJ, BEL = chr(0x202E), chr(0x2066), chr(0x2069), chr(0xFEFF), chr(0x200B), chr(0x200D), chr(7)
# What must never be in this project's source: the direction overrides and
# isolates, the marks, zero-width space and a byte-order mark past the start.
HIDDEN = {0x200B, 0x200E, 0x200F, 0xFEFF, *range(0x202A, 0x202F), *range(0x2066, 0x206A)}


def src(*parts):
    with open(os.path.join(HERE, *parts), encoding="utf-8") as f:
        return f.read()


class TheParser(unittest.TestCase):
    def test_markup_is_kept_as_the_characters_it_is(self):
        """Not stripped, not mangled - shown. "<3" is a heart. The guarantee
        is that every page draws it as text, below."""
        m = chat.message("tiktok", "x", "<script>alert(1)</script> <3 <img src=x onerror=alert(1)>")
        self.assertEqual(m["text"], "<script>alert(1)</script> <3 <img src=x onerror=alert(1)>")

    def test_direction_overrides_and_controls_are_removed(self):
        m = chat.message("tiktok", "x", "abc" + RLO + "dcba" + BEL + LRI + "hid" + PDI + "den" + BOM + ZWSP)
        self.assertEqual(m["text"], "abcdcbahidden")

    def test_line_breaks_become_spaces(self):
        self.assertEqual(chat.message("tiktok", "x", "one\ntwo\r\nthree\tfour")["text"], "one two three four")

    def test_emoji_joiners_survive(self):
        """The control: stripping zero-width characters wholesale would break
        every family and skin-tone emoji, which are joined by U+200D."""
        family = chr(0x1F468) + ZWJ + chr(0x1F469) + ZWJ + chr(0x1F467)
        self.assertEqual(chat.message("tiktok", "x", family)["text"], family)

    def test_names_are_cleaned_the_same_way(self):
        m = chat.message("tiktok", "x", "hi", user={"login": "a" + RLO + "b", "name": "Evil" + RLO + LRI + "Name"})
        self.assertEqual((m["user"]["login"], m["user"]["name"]), ("ab", "EvilName"))

    def test_a_command_still_parses_after_cleaning(self):
        m = chat.message("tiktok", "x", "!tts" + RLO + " hello\nthere", symbols="!")
        self.assertEqual((m["command"], m["args"]), ("tts", "hello there"))


class WhereItIsDrawn(unittest.TestCase):
    def test_the_stream_cards_set_text(self):
        s = src("web", "scene.js")
        for line in (".alert-title').textContent = ev.title",
                     ".alert-text').textContent = ev.text",
                     ".speak-text').textContent = d.said || ev.text",
                     ".gift-who').textContent = who",
                     ".gift-what').textContent =",
                     ".poll-q').textContent = t.question"):
            self.assertIn(line, s)
        # The poll's rows are built first and the labels set as text after.
        self.assertIn("el.textContent = (t.choices || [])[i] || '';", s)

    def test_the_panels_escape(self):
        cp = src("web", "chatpanel.js")
        self.assertIn("<span class=\"cp-text\">${esc(m.text)}</span>", cp)
        self.assertIn("${esc((m.user && m.user.name) || login(m) || '?')}", cp)
        cmd = src("web", "cmdpanel.js")
        self.assertIn("${esc(e.response)}", cmd)
        self.assertIn("${esc(e.user)}", cmd)
        rq = src("web", "reqpanel.js")
        self.assertIn("asked by ${esc(r.user)}", rq)
        pp = src("web", "pollpanel.js")
        self.assertIn("n.textContent = (current.choices || [])[i] || '';", pp)


class TheReaderAndTheVoice(unittest.TestCase):
    def test_the_reader_takes_text_never_markup(self):
        o = tiktok_chat.OBSERVER
        self.assertIn("textContent", o)
        for bad in ("innerHTML", "outerHTML", "eval(", "Function(", "setTimeout('", 'setTimeout("'):
            self.assertNotIn(bad, o, bad)

    def test_what_it_hands_over_is_parsed_as_data(self):
        s = src("tiktok_chat.py")
        self.assertNotRegex(s, r"(?<![\w.])(eval|exec)\(")
        self.assertIn("p = json.loads(raw)", s)
        # And the only thing ever run in the user's page is the fixed script,
        # put there before the page loads (T6); nothing is evaluated after.
        self.assertNotIn('"Runtime.evaluate"', s)
        self.assertEqual(s.count('"Page.addScriptToEvaluateOnNewDocument"'), 1)
        self.assertIn('("Page.addScriptToEvaluateOnNewDocument", {"source": OBSERVER})', s)

    def test_the_voice_reads_plain_text(self):
        ps = src("tts.ps1")
        self.assertIn("$synth.Speak([string]$req.text)", ps)
        self.assertNotIn("$synth.SpeakSsml", ps)

    def test_the_voice_gets_its_words_as_data_not_a_command_line(self):
        py = src("tts.py")
        self.assertIn("self._proc.stdin.write(json.dumps(req) + \"\\n\")", py)
        self.assertIn('"-File", SCRIPT, str(os.getpid())]', py)


class TheSourceItself(unittest.TestCase):
    """Trojan Source: code that reads one way in an editor and runs another,
    because a direction override hides in it. Found in this project on the
    day this file was written, put there by accident - see the docstring."""

    def test_no_file_carries_a_hidden_direction_or_zero_width_character(self):
        found, scanned = [], 0
        for root, dirs, files in os.walk(HERE):
            dirs[:] = [d for d in dirs if d not in ("cache", ".git", "__pycache__", "node_modules", "dist", "build")]
            for name in files:
                if not name.endswith((".py", ".js", ".html", ".css", ".ps1", ".sh", ".md", ".bat", ".yml", ".iss")):
                    continue
                path = os.path.join(root, name)
                try:
                    with open(path, encoding="utf-8") as f:
                        text = f.read()
                except (UnicodeDecodeError, OSError):
                    continue
                scanned += 1
                body = text[1:] if text.startswith(BOM) else text      # a BOM at the very start is allowed
                for n, line in enumerate(body.splitlines(), 1):
                    if any(ord(c) in HIDDEN for c in line):
                        found.append(f"{os.path.relpath(path, HERE)}:{n}")
        self.assertGreater(scanned, 100)                   # the floor: it really looked
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
