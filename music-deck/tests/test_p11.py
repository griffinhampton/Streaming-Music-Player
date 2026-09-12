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
        # never receives one: nothing it reads carries it.
        js = read("web", "livepanel.js")
        self.assertNotRegex(js, r"\b(d|st|status|res|r)\.key\b")
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
