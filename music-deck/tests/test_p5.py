"""Hardening (P5): who may talk to the server, no path out of the asset
and scene folders, a corrupted scene file falling back to its backup, the
feed accounting by page, and the stream key never reaching a log."""
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import assets   # noqa: E402
import feeds    # noqa: E402
import guard    # noqa: E402
import live     # noqa: E402
import scenes   # noqa: E402
try:
    import overlay  # noqa: E402  (Windows only: it drives Win32 windows)
except (ImportError, AttributeError, OSError):
    overlay = None


class Trust(unittest.TestCase):
    def test_own_pages_and_local_tools_pass(self):
        self.assertTrue(guard.trusted("127.0.0.1:8713", None, 8713))
        self.assertTrue(guard.trusted("localhost:8713", "http://localhost:8713", 8713))
        self.assertTrue(guard.trusted("127.0.0.1:8713", "http://127.0.0.1:8713", 8713))
        self.assertTrue(guard.trusted(" 127.0.0.1:8713 ", "HTTP://127.0.0.1:8713", 8713))

    def test_other_origins_hosts_and_ports_are_refused(self):
        self.assertFalse(guard.trusted("127.0.0.1:8713", "http://evil.example", 8713), "another site's page")
        self.assertFalse(guard.trusted("127.0.0.1:8713", "http://127.0.0.1:8799", 8713), "another port")
        self.assertFalse(guard.trusted("deck.attacker.example:8713", None, 8713), "DNS rebinding")
        self.assertFalse(guard.trusted("127.0.0.1:8799", None, 8713), "wrong port in Host")
        self.assertFalse(guard.trusted("", None, 8713))
        self.assertFalse(guard.trusted("127.0.0.1:8713", "null", 8713), "a sandboxed or file: page")


class AssetPaths(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="deck-p5-assets-")
        self.builtin = tempfile.mkdtemp(prefix="deck-p5-builtin-")
        with open(os.path.join(self.builtin, "art.png"), "wb") as f:
            f.write(b"\x89PNG")
        self.store = assets.AssetStore(self.dir, builtin=self.builtin)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)
        shutil.rmtree(self.builtin, ignore_errors=True)

    def test_no_path_leaves_the_folders(self):
        secret = os.path.join(os.path.dirname(self.dir), "secret.png")
        with open(secret, "wb") as f:
            f.write(b"x")
        try:
            for bad in ("../secret.png", "..%2Fsecret.png", "/secret.png", "..\\secret.png",
                        "builtin:../secret.png", "builtin:..%2Fsecret.png", "index.json", "builtin:", ""):
                self.assertIsNone(self.store.path(bad), bad)
        finally:
            os.remove(secret)
        self.assertTrue(self.store.path("builtin:art.png").startswith(self.builtin))
        self.assertIsNone(self.store.path("builtin:art.exe"))
        self.assertIsNone(self.store.path("nothing.png"))


class SceneBackups(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="deck-p5-scenes-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_a_corrupted_file_falls_back_to_the_newest_good_backup(self):
        store = scenes.SceneStore(self.dir)
        s = store.add(scenes.from_template("just_chatting"))
        for n in range(3):
            s = store.get(s["id"])
            s["name"] = f"rev {n + 2}"
            store.save(s)
        sid = s["id"]
        self.assertEqual(store.get(sid)["rev"], 4)
        main = os.path.join(self.dir, f"{sid}.json")
        with open(main, "w", encoding="utf-8") as f:
            f.write('{"id": "' + sid + '", "layers": [')          # cut short mid-write
        with open(main + ".1", "w", encoding="utf-8") as f:
            f.write("not json at all")                             # and the newest backup is bad too
        seen = []
        again = scenes.SceneStore(self.dir, log=seen.append)
        back = again.get(sid)
        self.assertIsNotNone(back, "the scene came back")
        # .1 held rev 3 (bad now), .2 holds rev 2: the newest readable one.
        self.assertEqual(back["name"], "rev 2", "from backup 2, the newest readable one")
        self.assertTrue(any("restored from backup 2" in line for line in seen), seen)
        self.assertTrue(any("unreadable" in line for line in seen), seen)
        # Saving again writes a clean file and keeps the chain going.
        back["name"] = "healed"
        again.save(back)
        with open(main, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["name"], "healed")

    def test_restore_takes_a_backup_number_only(self):
        store = scenes.SceneStore(self.dir)
        s = store.add(scenes.from_template("gaming_landscape"))
        s = store.get(s["id"]); s["name"] = "second"; store.save(s)
        self.assertEqual(store.restore(s["id"], 1)["name"], "Gaming landscape")
        self.assertIsNone(store.restore(s["id"], 9))
        with self.assertRaises(ValueError):
            store.restore(s["id"], "../x")


class FakeHandler:
    def __init__(self, referer, path="/api/events"):
        self.headers = {"Referer": referer}
        self.path = path


class FeedPages(unittest.TestCase):
    def test_pages_are_told_apart_by_their_query(self):
        f = feeds.Feeds()
        live = feeds.Feeds.page_of(FakeHandler("http://127.0.0.1:8713/scene.html?follow=1"))
        out = feeds.Feeds.page_of(FakeHandler("http://127.0.0.1:8713/scene.html?id=abc"))
        self.assertEqual((live, out), ("scene.html?follow=1", "scene.html?id=abc"))
        # A WebSocket names its page in the URL (no Referer on an upgrade).
        named = feeds.Feeds.page_of(FakeHandler("", "/ws/events?page=scene.html%3Fid%3Dabc"))
        self.assertEqual(named, "scene.html?id=abc")
        self.assertEqual(feeds.Feeds.page_of(FakeHandler("", "/ws/events?page=..%2F..%2Fx")), "x")
        self.assertEqual(feeds.Feeds.group_of("deck.html?x=1"), "deck")
        self.assertEqual(feeds.Feeds.group_of("nowplaying.html?preview=1"), "deck", "the deck's preview iframe")
        self.assertEqual(feeds.Feeds.group_of("nowplaying.html"), "windows")
        self.assertEqual(feeds.Feeds.group_of(live), "windows")
        t = f.track("ws", live)
        self.assertTrue(f.has_page(live))
        self.assertFalse(f.has_page(out))
        f.release(t)
        self.assertFalse(f.has_page(live))


class NativeSources(unittest.TestCase):
    def test_only_native_layers_become_sources_in_layer_order(self):
        s = scenes.from_template("gaming_landscape")
        cam = next(l for l in s["layers"] if l["type"] == "camera")
        cap = next(l for l in s["layers"] if l["type"] == "capture")
        self.assertEqual(scenes.native_sources(s), [], "a browser camera and an unnamed capture are not sources")
        cap["props"]["source"] = {"kind": "window", "title": "Game"}
        cam["props"].update(mode="native", device="IR", width=640, height=480)
        out = scenes.native_sources(s)
        self.assertEqual([o["kind"] for o in out], ["window", "camera"])
        self.assertEqual(out[0]["title"], "Game")
        self.assertEqual(out[0]["rect"], [0, 0, 1920, 1080])
        self.assertEqual((out[1]["device"], out[1]["width"], out[1]["height"], out[1]["mirror"]), ("IR", 640, 480, True))
        cam["visible"] = False
        self.assertEqual([o["kind"] for o in scenes.native_sources(s)], ["window"], "hidden layers are left out")
        self.assertEqual(scenes.native_sources(None), [])

    def test_fit_maths_of_the_compositor(self):
        import capture
        # contain: a 4:3 source in a square box is letterboxed, no crop
        dest, uv = capture.Compositor._place((100, 50, 480, 480), (640, 480), "contain")
        self.assertEqual(dest, (100, 50 + 60, 580, 50 + 60 + 360))
        self.assertEqual(uv, (0.0, 0.0, 1.0, 1.0))
        # cover: the box is filled and the source cropped at the sides
        dest, uv = capture.Compositor._place((100, 50, 480, 480), (640, 480), "cover")
        self.assertEqual(dest, (100, 50, 580, 530))
        self.assertAlmostEqual(uv[0], 80 / 640)
        self.assertAlmostEqual(uv[2], 560 / 640)
        self.assertEqual((uv[1], uv[3]), (0.0, 1.0))
        # no size known yet: the whole box, whole picture
        self.assertEqual(capture.Compositor._place((1, 2, 3, 4), None, "cover"), ((1, 2, 4, 6), (0.0, 0.0, 1.0, 1.0)))


class FakeHost:
    """Stands in for a HostWindow: closing it reports back to its owner,
    synchronously when asked to, which is the worst case for a race."""
    def __init__(self, owner=None):
        self.owner = owner
        self.closed = 0

    def alive(self):
        return not self.closed

    def close(self):
        self.closed += 1
        if self.owner:
            self.owner._on_host_closed(self)


@unittest.skipIf(overlay is None, "Windows only")
class ClosedByHand(unittest.TestCase):
    """A window the user closes (Alt+F4, the taskbar) is told apart from
    the closes the app makes itself, so the watchdog never brings back a
    window the user closed."""
    def make(self):
        ov = overlay.Overlay.__new__(overlay.Overlay)
        ov.host, ov.child, ov._closing = None, None, None
        self.heard = []
        ov.on_user_closed = lambda: self.heard.append(1)
        return ov

    def test_closed_by_hand_is_reported(self):
        ov = self.make()
        h = FakeHost()
        ov.host = h
        ov._on_host_closed(h)
        self.assertEqual(self.heard, [1])
        self.assertIsNone(ov.host)

    def test_our_own_close_is_not_even_when_the_callback_races_it(self):
        ov = self.make()
        h = FakeHost(owner=ov)          # reports while close() is still running
        ov.host = h
        self.assertTrue(ov.close())
        self.assertEqual(self.heard, [])
        self.assertIsNone(ov.host)
        self.assertIsNone(ov._closing)

    def test_a_host_that_never_held_the_window_is_ignored(self):
        ov = self.make()
        current = FakeHost()
        ov.host = current
        stray = FakeHost()
        ov._on_host_closed(stray)                   # an old or never-adopted host
        self.assertEqual(self.heard, [])
        self.assertIs(ov.host, current)
        ov._closing = stray                         # a failed adoption, closed by us
        ov._on_host_closed(stray)
        self.assertEqual(self.heard, [])
        self.assertIsNone(ov._closing)
        self.assertIs(ov.host, current)


class KeyNeverLogged(unittest.TestCase):
    def test_the_client_masks_the_key_in_every_log_line(self):
        lines = []
        c = live.RtmpClient("rtmp://ingest.example/live", "abc123-secret-key", log=lines.append)
        c.log("rtmp: <- onStatus NetStream.Publish.BadName: abc123-secret-key is not valid")
        self.assertEqual(lines, ["rtmp: <- onStatus NetStream.Publish.BadName: *** is not valid"])


if __name__ == "__main__":
    unittest.main()
