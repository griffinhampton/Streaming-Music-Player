"""Gift senders' pictures (avatars.py): fetched from TikTok's image servers
and nowhere else, once, as a picture, and kept in a cache that forgets.

A local HTTP server stands in for TikTok's (the cache's allow_local, the rig's
switch) - and for everything the cache must refuse: a redirect, a page that
calls itself a PNG, a picture too big.
"""
import http.server
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import avatars  # noqa: E402

PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b"the rest of a png"
JPG = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + b"the rest of a jpeg"


class Fixture(http.server.BaseHTTPRequestHandler):
    hits = []

    def do_GET(self):
        path = self.path.split("?")[0]
        Fixture.hits.append(path)
        if path == "/r.png":
            self.send_response(302)
            self.send_header("Location", "/redirected.png")
            self.end_headers()
            return
        body = {"/page.png": b"<html>not a picture</html>", "/big.png": PNG + bytes(avatars.MAX_BYTES),
                "/face.jpg": JPG}.get(path, PNG if path.startswith("/face") or path == "/redirected.png" else None)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class TheCache(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.c = avatars.AvatarCache(self.dir, allow_local=True)
        Fixture.hits.clear()

    def test_a_picture_is_fetched_once_and_kept(self):
        """TikTok's links carry a signature that expires; the path is the
        picture. Asked for twice, under two links, it is fetched once."""
        a = self.c.get(self.base + "/face.png?x-expires=1&x-signature=a")
        self.assertRegex(a, avatars.ID_RE)
        self.assertTrue(self.c.path(a))
        self.assertEqual(self.c.get(self.base + "/face.png?x-expires=2&x-signature=b"), a)
        self.assertEqual(Fixture.hits, ["/face.png"])

    def test_the_type_is_the_files_own(self):
        self.assertEqual(self.c.get(self.base + "/page.png"), "", "a page that calls itself a PNG")
        self.assertTrue(self.c.get(self.base + "/face.jpg").endswith(".jpg"))

    def test_a_redirect_is_never_followed(self):
        self.assertEqual(self.c.get(self.base + "/r.png"), "")
        self.assertNotIn("/redirected.png", Fixture.hits)
        self.assertEqual(Fixture.hits, ["/r.png"])

    def test_a_picture_too_big_is_refused(self):
        self.assertEqual(self.c.get(self.base + "/big.png"), "")
        self.assertEqual(os.listdir(self.dir), [])

    def test_only_tiktoks_image_servers(self):
        for url, ok in (("https://p16-common-sign.tiktokcdn-us.com/tos/a~tplv.jpeg?x-expires=1", True),
                        ("https://p19-common-sign.tiktokcdn-eu.com/tos/a.webp", True),
                        ("https://p16-sign-va.tiktokcdn.com/a.jpeg", True),
                        ("http://p16-common-sign.tiktokcdn-us.com/a.jpeg", False),
                        ("https://tiktokcdn-us.com/a.jpeg", False),
                        ("https://p16.tiktokcdn-us.com.evil.example/a", False),
                        ("https://p16.tiktokcdn-us.com:8443/a", False),
                        ("https://user:pw@p16.tiktokcdn-us.com/a", False),
                        ("https://p16.tiktokcdn.evil/a", False),
                        ("https://a.b.tiktokcdn.com/a", False),
                        ("http://127.0.0.1/a.png", False), ("", False), ("javascript:alert(1)", False)):
            self.assertEqual(avatars.allowed(url), ok, url)
        self.assertTrue(avatars.allowed("http://127.0.0.1:1/a.png", allow_local=True))
        self.assertFalse(avatars.allowed("http://10.0.0.1/a.png", allow_local=True))

    def test_a_host_it_may_not_use_is_never_asked(self):
        """The control for the local fixture: without the rig's switch, the
        same address is refused before any request is made."""
        c = avatars.AvatarCache(self.dir)
        self.assertEqual(c.get(self.base + "/face.png"), "")
        self.assertEqual(Fixture.hits, [])

    def test_only_ids_of_its_own_shape_are_files(self):
        self.c.get(self.base + "/face.png")
        for bad in ("../index.json", "abc.png", "0123456789abcdef.exe", "0123456789ABCDEF.png", "", None):
            self.assertIsNone(self.c.path(bad), bad)

    def test_only_the_newest_are_kept(self):
        """Other people's pictures, kept only as long as they are useful."""
        old = avatars.KEEP
        self.addCleanup(setattr, avatars, "KEEP", old)
        avatars.KEEP = 3
        got = []
        for n in range(5):
            got.append(self.c.get(f"{self.base}/face{n}.png"))
            time.sleep(0.05)
        self.assertEqual(sorted(os.listdir(self.dir)), sorted(got[2:]))


class Slow:
    """A cache whose fetch takes a while."""
    log = staticmethod(lambda *_: None)

    def get(self, url):
        time.sleep(0.3)
        return "0123456789abcdef.png"


class ThePoster(unittest.TestCase):
    def test_gifts_wait_for_their_picture_in_order(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        cache = avatars.AvatarCache(d)            # refuses the local address: no picture
        posted = []
        p = avatars.Poster(cache, lambda g, aid: posted.append((g["n"], aid)))
        for n, url in ((1, "https://p16.tiktokcdn-us.com.evil.example/a"), (2, ""), (3, "http://127.0.0.1/a.png")):
            p.put({"n": n, "avatar_url": url})
        p.idle()
        self.assertEqual(posted, [(1, ""), (2, ""), (3, "")])
        p.close()

    def test_a_full_queue_posts_at_once_without_the_picture(self):
        posted = []
        p = avatars.Poster(Slow(), lambda g, aid: posted.append((g["n"], aid)), depth=1)
        for n in (1, 2, 3):
            p.put({"n": n, "avatar_url": "x"})
        time.sleep(0.05)
        self.assertIn((3, ""), posted, "the third found the queue full")
        p.idle(3)
        time.sleep(0.4)
        p.close()


if __name__ == "__main__":
    unittest.main()
