"""The overlays never put server text in front of an audience.

Written after two of them did. `captions.js` had "Captions are off - press
Start in the deck" as its whole off-state status, and then, one branch below,
`el.status.textContent = c.error` - whatever the engine threw. Neither was
theoretical: handed a model folder with no weights in it, faster-whisper says

    Unable to open file 'model.bin' in model 'C:\\Users\\<name>\\...\\cache\\models\\small.en'

and `captions_whisper.py:440` sends that on as "Whisper could not load: ...".
130 characters against this machine's own store, 63 of them the path to it,
drawn on stream at overlay size.
The tamer branch is `captions.py:130`, which is fixed text, and no better in
front of an audience: "press Download on the Captions tab" is an instruction
to whoever is holding a deck the audience has not got.

Both were fixed at the overlay rather than at the producer, and that choice is
what this file guards. The deck renders the same `c.error` in full at
`deck.js:3214`, which is private, and is the one surface where the path is the
useful part - it is how somebody fixes their own setup. Capping the text where
it is made would blind the deck and still leak, since the path starts well
inside the first 160 characters. So the rule is about the audience, not about
the string: private surfaces may say anything, on-stream surfaces may not.

Which pages are on-stream is read from `components.py`, not listed here. A
seventh overlay added to that registry is policed the day it is added; a list
kept in this file would have to be remembered instead.

`scene.js` is the documented exception, and it doubles as this file's positive
control. Its banner deliberately shows exception text on the canvas - "a black
window that looks fine from the outside is the worst way to find out" - which
is a real tradeoff, weighed in writing, and not one to overturn from here. It
also means the scan has something it must find: if `scene.js` ever stops
matching, the rule has broken rather than the code having got cleaner. Without
that, a rule that matched nothing at all would pass this file forever.
"""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DECK = os.path.dirname(HERE)
WEB = os.path.join(DECK, "web")
COMPONENTS = os.path.join(DECK, "components.py")

# Component("captions", "Captions", "captions.html", "captions", (900, 200), ...)
COMPONENT = re.compile(r'Component\(\s*"([^"]+)"\s*,\s*"[^"]*"\s*,\s*"([^"]+)"')
SCRIPT = re.compile(r'<script src="([^"]+)"')

# Where text lands on screen, and text that came from the server or from an
# exception. Both halves have to be on the same statement to count.
SINK = re.compile(r'\b(?:textContent|innerHTML|innerText)\b')
FROM_SERVER = re.compile(r'\.error\b|\.message\b|\breason\b|\bexc\b')

# The one place this is deliberate, with the reason kept next to it.
ALLOWED = {
    "scene.js": "its error banner is a weighed decision (scene.js:26-29): a "
                "black window that looks fine from the outside is the worst "
                "way to find out",
}

# Seen today: 7 components, 6 pages, 16 modules, 4,997 code lines, and one
# module flagged - scene.js, at three lines. A scan that suddenly reads a
# handful of them has lost its way rather than found the overlays clean.
FLOOR_PAGES = 5
FLOOR_MODULES = 12
FLOOR_LINES = 4000


def on_stream_pages():
    """The pages the app itself puts on stream, from the component registry."""
    with open(COMPONENTS, encoding="utf-8") as fh:
        src = fh.read()
    pages = set()
    for _cid, page in COMPONENT.findall(src):
        name = page.split("?")[0]
        if name.endswith(".html"):
            pages.add(name)
    return sorted(pages)


def modules_on(pages):
    """Every script those pages load - shared ones too. A shared module that
    printed an error onto an overlay would be on stream exactly the same."""
    mods = set()
    for page in pages:
        full = os.path.join(WEB, page)
        if not os.path.exists(full):
            continue
        with open(full, encoding="utf-8", errors="replace") as fh:
            for src in SCRIPT.findall(fh.read()):
                if src.endswith(".js"):
                    mods.add(os.path.basename(src.split("?")[0]))
    return sorted(mods)


def shows_server_text(name, text):
    """Lines in one module that put server or exception text on screen."""
    hits = []
    for i, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if s.startswith(("//", "*", "/*")):
            continue                       # prose, including this rule's own
        if SINK.search(s) and FROM_SERVER.search(s):
            hits.append(f"{name}:{i}: {s[:100]}")
    return hits


def scan():
    """Every on-stream module, and what it draws. Returns (hits, lines)."""
    pages = on_stream_pages()
    found, lines = {}, 0
    for mod in modules_on(pages):
        full = os.path.join(WEB, mod)
        if not os.path.exists(full):
            continue
        with open(full, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        lines += len(text.splitlines())
        hits = shows_server_text(mod, text)
        if hits:
            found[mod] = hits
    return found, lines


class OverlaysSayNothingTheAudienceCannotUse(unittest.TestCase):
    def test_no_overlay_draws_server_or_exception_text(self):
        found, _ = scan()
        wrong = [h for mod, hits in sorted(found.items())
                 if mod not in ALLOWED for h in hits]
        self.assertEqual(wrong, [], "\non stream, in front of an audience:\n"
                                    + "\n".join(wrong))

    def test_the_documented_exception_is_still_found(self):
        """The positive control, and the reason this file is not vacuous. A
        rule that matched nothing would pass the test above forever."""
        found, _ = scan()
        for mod, why in ALLOWED.items():
            self.assertIn(
                mod, found,
                f"{mod} no longer matches, so the rule has stopped working - "
                f"it is allowed only because {why}")

    def test_the_rule_can_actually_fail(self):
        """The negative control. Fed the line that started this, the scan has
        to report it; fed the line that replaced it, it has to stay quiet."""
        before = shows_server_text("x.js", "el.status.textContent = c.error || 'Captions unavailable';")
        after = shows_server_text("x.js", "el.status.textContent = 'Captions unavailable';")
        self.assertEqual(len(before), 1, "the scan cannot see the bug it was written for")
        self.assertEqual(after, [], "the scan flags the fix as though it were the bug")

    def test_the_captions_overlay_still_says_a_fixed_thing(self):
        """The regression itself, named. The rule above would catch a return
        to `c.error`, but not somebody reaching for `c.note` or `c.recognizer`
        instead - the point is that this branch says one settled sentence."""
        with open(os.path.join(WEB, "captions.js"), encoding="utf-8") as fh:
            body = fh.read()
        at = body.index("c.state === 'unavailable'")
        branch = [l.strip() for l in body[at:at + 1400].splitlines()
                  if l.strip() and not l.strip().startswith(("//", "*", "/*"))][:5]
        drawn = [l for l in branch if "status.textContent" in l]
        self.assertEqual(
            drawn, ["el.status.textContent = 'Captions unavailable';"],
            "the unavailable branch no longer draws a fixed sentence: " + str(branch))

    def test_the_scan_actually_looked(self):
        """The other way a green can be empty: reading almost nothing. The
        pages come from the registry, so a parse that quietly stopped matching
        `Component(` would police an empty set and pass."""
        pages = on_stream_pages()
        mods = modules_on(pages)
        _, lines = scan()
        self.assertGreaterEqual(len(pages), FLOOR_PAGES,
                                f"only {len(pages)} on-stream pages found in components.py")
        self.assertGreaterEqual(len(mods), FLOOR_MODULES,
                                f"only {len(mods)} modules reached from those pages")
        self.assertGreaterEqual(lines, FLOOR_LINES,
                                f"only {lines} lines scanned, under the {FLOOR_LINES} floor")


if __name__ == "__main__":
    unittest.main()
