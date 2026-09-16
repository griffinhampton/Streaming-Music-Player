"""Running a show (P11). The panel, studio mode and the remote are tested in
a browser against a real stream (tools/p11); here: what has to stay in step
between the pages and the server."""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import live  # noqa: E402


def read(*parts):
    with open(os.path.join(HERE, *parts), encoding="utf-8") as f:
        return f.read()


class InStep(unittest.TestCase):
    def test_the_remote_window_is_found_by_its_title(self):
        title = re.search(r"<title>(.*?)</title>", read("web", "remote.html")).group(1)
        self.assertIn(f'REMOTE_TITLE = "{title}"', read("server.py"))

    def test_the_panel_recognizes_a_rotated_key(self):
        # The panel tells "TikTok gave you a new key" apart by this phrase.
        self.assertRegex(read("web", "livepanel.js"), r"refused the stream key")
        self.assertIn("refused the stream key", live.KEY_ROTATED_HINT)

    def test_both_pages_load_the_panel_before_they_use_it(self):
        for page, user in (("deck.html", "deck.js"), ("canvas.html", "studio.js")):
            html = read("web", page)
            scripts = re.findall(r'<script src="([^"]+)"', html)
            self.assertLess(scripts.index("livepanel.js"), scripts.index(user), page)
            self.assertIn('href="livepanel.css"', html, page)

    def test_the_key_never_comes_back_to_the_page(self):
        # The page may hold a key you paste (masked) until it is saved; it
        # never receives one unasked.
        #
        # This guard used to be a flat "nothing reads .key", which was right
        # until the TikTok tab arrived: that tab shows and copies the key of
        # the live it just opened, by an explicit press, through
        # /api/tiktok/reveal - and the flat rule could not tell that from a key
        # riding the status poll, so it had been failing since a024091.
        # Sharper, not looser: every .key read must be downstream of a reveal.
        # A key arriving on the poll would have no reveal above it and fail.
        # By function, not by proximity: a first attempt measured 800 characters
        # back from each read, which failed on the second one because the text
        # between the two handlers pushed its own reveal call out of range. The
        # rule is structural - a key may be read only where it was fetched - so
        # the check should be too.
        js = read("web", "livepanel.js")
        bodies = re.split(r"\n  (?=(?:async )?function |\$\(|/\* )", js)
        reads = [b for b in bodies if re.search(r"\b(?:d|st|status|res|r|shown)\.key\b", b)]
        self.assertTrue(reads, "the reveal path should still be here")
        for body in reads:
            self.assertIn("/api/tiktok/reveal", body,
                          "a .key read where nothing revealed it: a key the page did not ask for")
        self.assertIn('type="password"', js)
        self.assertRegex(js, r"\[data-lp=\"key\"\]'\)\.value = '';\s+// never kept on the page")
        live_py = read("live.py")
        status = re.search(r"def status\(self\):.*?return (\{.*?\})", live_py, re.S).group(1)
        self.assertNotIn('"key"', status, "the status the pages read has no key in it")

    def test_every_remote_control_is_a_button(self):
        html = read("web", "remote.html")
        for tag in re.findall(r"<button[^>]*>", html):
            self.assertIn('type="button"', tag)


if __name__ == "__main__":
    unittest.main()
