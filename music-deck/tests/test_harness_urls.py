"""Every CDP harness opens its page through Chrome's `/json/new?<url>`, and
the URL has to be percent-encoded on the way in. `encodeURI` is not enough: it
leaves `&` alone, so a page URL with two query parameters arrives as a second
parameter *of `/json/new`* and the page loads without it.

Found twice, and blamed on the app both times. In S3, `scene.html?id=X&preview=1`
arrived as `scene.html?id=X`, which made a correctly-gated preview look like a
bug; reordering the parameters made it pass, which is how it was caught. In
S17b, `p6run.sh` asked `shotpage.js` - which encoded nothing at all - for
`frame.html?kind=camera&preview=1` and photographed `frame.html?kind=camera`.
That page is not a preview: `frame.js` reads `STANDALONE = !PREVIEW && !EMBED`,
so the shot wired window controls, POSTed the headless viewport to
`/api/components/camframe/metrics`, and drew the first-open "drag to move" hint
pill, which `windowctl.js` holds for 4000 ms against shotpage's 3500 ms wait.
The reference picture of the deck's *preview* was a standalone window.

Nothing said so, because of how it fails: the page loads, the harness runs, and
every assertion passes. It just tests something other than what it says.

Measured on the rig rather than argued (2026-09-13), by asking the page what it
actually received:

    raw                -> ?kind=camera             preview=false
    encodeURI          -> ?kind=camera             preview=false
    encodeURIComponent -> ?kind=camera&preview=1   preview=true

For a single-parameter URL the last two are identical, which is why converting
the p7-p12 suites was a no-op rather than a rewrite.

The helpers below are copied from `test_tools.py` rather than imported: `tests`
has no `__init__.py`, so a sibling import works under some runners and not
others, and eight lines of duplication is the cheaper of the two problems.
"""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DECK = os.path.dirname(HERE)
TOOLS = os.path.join(DECK, "tools")
REPO = os.path.dirname(DECK)

# Whatever follows /json/new? up to the closing quote or whitespace - the URL a
# shell harness hands straight to curl, where there is nothing to encode with.
SHELL_URL = re.compile(r'/json/new\?([^"\'\s]*)')


def sources(ext):
    for root, dirs, files in os.walk(TOOLS):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in sorted(files):
            if f.endswith(ext):
                path = os.path.join(root, f)
                with open(path, encoding="utf-8") as fh:
                    yield path, fh.read()


def rel(path):
    return os.path.relpath(path, REPO).replace("\\", "/")


class HarnessesEncodeTheUrlsTheyOpen(unittest.TestCase):
    def test_every_js_harness_encodes_the_whole_url(self):
        """One rule, no exemptions: if a .js file names /json/new, the URL on
        that line goes through encodeURIComponent. `encodeURI` is not a weaker
        pass, it is a fail - on a two-parameter URL it does nothing at all that
        the raw string did not already do."""
        wrong = []
        for path, src in sources(".js"):
            for line_no, line in enumerate(src.splitlines(), 1):
                stripped = line.strip()
                # Prose, not a call. This rule's own explanation in
                # shotpage.js spells out the `/json/new?<url>` shape, and the
                # first run of this test duly flagged it. Skipping comments
                # keeps the rule broad - a call in any shape is still caught -
                # where narrowing it to `fetch(` would have let a call split
                # over two lines through in silence.
                if stripped.startswith(("//", "*", "/*")):
                    continue
                if "/json/new?" in stripped and "encodeURIComponent" not in stripped:
                    wrong.append(f"{rel(path)}:{line_no}: {stripped[:100]}")
        self.assertEqual(wrong, [], "\n" + "\n".join(wrong))

    def test_no_shell_harness_opens_a_two_parameter_url(self):
        """bash and PowerShell have no encodeURIComponent, so they get the
        weaker rule that still holds: open a single-parameter URL, where the
        fault cannot bite. A second parameter in one of these is a real fault
        and has to move into a .js harness that can encode it."""
        wrong = []
        for ext in (".sh", ".ps1"):
            for path, src in sources(ext):
                for line_no, line in enumerate(src.splitlines(), 1):
                    found = SHELL_URL.search(line)
                    if found and "&" in found.group(1):
                        wrong.append(f"{rel(path)}:{line_no}: {line.strip()[:100]}")
        self.assertEqual(wrong, [], "\n" + "\n".join(wrong))


if __name__ == "__main__":
    unittest.main()
