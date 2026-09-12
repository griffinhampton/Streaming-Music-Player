"""Unit tests for the Canvas Builder backend (P2): scenes, assets, the
component registry, feed accounting and voice leases. Plain unittest, no
server process, nothing touches the network or a microphone.

    python -m unittest discover -s music-deck/tests -v
"""
import base64
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import assets       # noqa: E402
import components   # noqa: E402
import feeds        # noqa: E402
import scenes       # noqa: E402
import voice        # noqa: E402

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")


class Temp(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="deck-p2-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class SceneSchema(Temp):
    def test_new_scene_has_every_field(self):
        s = scenes.new_scene("Chat", "phone")
        self.assertEqual((s["width"], s["height"]), (1080, 1920))
        for key in ("id", "name", "format", "background", "transparency", "key_color",
                    "layers", "guides", "rev", "created", "updated", "version"):
            self.assertIn(key, s)

    def test_validate_clamps_and_keeps_unknown(self):
        raw = {"id": "abc", "name": "x" * 200, "format": "custom", "width": 99999, "height": -5,
               "transparency": "nonsense", "future_field": {"kept": True},
               "layers": [{"type": "text", "transform": {"x": "nan", "w": 0, "rotation": 725},
                           "style": {"opacity": 4, "blend": "weird", "crop": {"t": 2}},
                           "props": {"text": "hi"}, "extra": 1,
                           "triggers": [{"on": "speaking"}, {"bad": 1}]},
                          {"type": "image", "id": "dup"}, {"type": "image", "id": "dup"}, "junk"]}
        s = scenes.validate(raw)
        self.assertEqual(len(s["name"]), 80)
        self.assertEqual((s["width"], s["height"]), (7680, 16))
        self.assertEqual(s["transparency"], "opaque")
        self.assertEqual(s["future_field"], {"kept": True})
        self.assertEqual(len(s["layers"]), 3)
        t = s["layers"][0]
        self.assertEqual(t["transform"]["x"], 0)
        self.assertEqual(t["transform"]["w"], 1)
        self.assertAlmostEqual(t["transform"]["rotation"], 5.0)
        self.assertEqual(t["style"]["opacity"], 1)
        self.assertEqual(t["style"]["blend"], "normal")
        self.assertEqual(t["style"]["crop"]["t"], 0.99)
        self.assertEqual(t["extra"], 1)
        self.assertEqual(len(t["triggers"]), 1)
        ids = [l["id"] for l in s["layers"]]
        self.assertEqual(len(ids), len(set(ids)), "duplicate layer ids must be regenerated")

    def test_migrate_old_shape(self):
        s = scenes.migrate({"name": "old", "size": [640, 360], "items": [{"type": "text"}]})
        self.assertEqual(s["version"], scenes.VERSION)
        self.assertEqual((s["width"], s["height"]), (640, 360))
        self.assertEqual(s["layers"][0]["type"], "text")


class SceneStoreTests(Temp):
    def test_create_save_backup_conflict_restore(self):
        events = []
        store = scenes.SceneStore(self.dir, on_change=lambda: events.append(1))
        s = store.create("First", "horizontal")
        self.assertEqual(s["rev"], 1)
        self.assertTrue(os.path.isfile(os.path.join(self.dir, s["id"] + ".json")))
        # six saves: five backups kept, oldest dropped
        for i in range(6):
            s["name"] = f"First v{i}"
            s = store.save(s)
        self.assertEqual(s["rev"], 7)
        names = sorted(os.listdir(self.dir))
        self.assertEqual([n for n in names if n.startswith(s["id"])],
                         [s["id"] + ".json"] + [f"{s['id']}.json.{n}" for n in range(1, 6)])
        self.assertFalse(any(n.endswith(".tmp") for n in names))
        self.assertEqual(len(store.backups(s["id"])), 5)
        # a stale editor is refused
        with self.assertRaises(scenes.Conflict):
            store.save(dict(s, name="stale"), expect_rev=3)
        store.save(dict(s, name="fresh"), expect_rev=7)
        self.assertEqual(store.get(s["id"])["name"], "fresh")
        # backup 1 is the version before "fresh"
        restored = store.restore(s["id"], 1)
        self.assertEqual(restored["name"], "First v5")
        self.assertEqual(restored["rev"], 9)
        self.assertGreaterEqual(len(events), 9)

    def test_reload_and_corrupt_file_falls_back(self):
        store = scenes.SceneStore(self.dir)
        s = store.create("A", "phone")
        s = store.save(dict(s, name="B"))
        with open(os.path.join(self.dir, s["id"] + ".json"), "w") as f:
            f.write("{not json")
        again = scenes.SceneStore(self.dir)
        self.assertEqual(again.get(s["id"])["name"], "A", "the backup must be used")

    def test_duplicate_and_delete(self):
        store = scenes.SceneStore(self.dir)
        s = store.create("Orig")
        copy = store.duplicate(s["id"])
        self.assertNotEqual(copy["id"], s["id"])
        self.assertEqual(copy["name"], "Orig copy")
        self.assertEqual(len(store.list()), 2)
        self.assertTrue(store.delete(s["id"]))
        self.assertFalse(store.delete(s["id"]))
        self.assertEqual([x["id"] for x in store.list()], [copy["id"]])
        self.assertEqual(store.revisions(), {copy["id"]: 1})


class AssetTests(Temp):
    def data_url(self, raw, mime="image/png"):
        return f"data:{mime};base64," + base64.b64encode(raw).decode()

    def test_dedupe_kinds_thumb_and_usage(self):
        store = assets.AssetStore(self.dir)
        one = store.save("cat.png", self.data_url(PNG_1PX), thumb=self.data_url(PNG_1PX))
        two = store.save("same cat.png", self.data_url(PNG_1PX))
        self.assertTrue(one["ok"] and two["ok"])
        self.assertEqual(one["id"], two["id"])
        self.assertFalse(one["duplicate"])
        self.assertTrue(two["duplicate"])
        self.assertEqual(one["kind"], "image")
        listing = store.list()
        self.assertEqual(len(listing), 1)
        self.assertTrue(listing[0]["thumb"].endswith(".thumb.jpg"))
        self.assertEqual(store.save("clip.mp4", self.data_url(b"\x00" * 100, "video/mp4"))["kind"], "video")
        self.assertEqual([a["kind"] for a in store.list(kind="video")], ["video"])
        self.assertFalse(store.save("big.png", self.data_url(b"x" * (assets.AssetStore.MAX_BYTES + 1)))["ok"])
        self.assertFalse(store.save("note.txt", self.data_url(b"hi"))["ok"])
        scene = scenes.new_scene("uses cat")
        scene["layers"].append(scenes.new_layer("image", src="/asset/" + one["id"]))
        self.assertEqual(store.used_by(one["id"], [scene]), ["scene: uses cat"])
        refused = store.remove(one["id"], [scene])
        self.assertFalse(refused["ok"])
        self.assertIn("uses cat", refused["reason"])
        self.assertTrue(store.remove(one["id"], [scene], force=True)["ok"])
        self.assertFalse(os.path.exists(os.path.join(self.dir, one["id"] + ".thumb.jpg")))


class RegistryTests(Temp):
    def test_builtin_and_aliases(self):
        reg = components.builtin(self.dir)
        # P6 added the two Screen sharing frames to the built-ins.
        self.assertEqual(reg.ids(), ["np", "lyrics", "queue", "captions", "screenframe", "camframe", "live"])
        self.assertIs(reg.resolve("window"), reg.get("np"))
        self.assertIs(reg.resolve("captions/window"), reg.get("captions"))
        self.assertIs(reg.resolve("queue"), reg.get("queue"))
        self.assertIsNone(reg.resolve("nope"))
        d = reg.get("np").describe()
        self.assertEqual(d["page"], "nowplaying.html")
        self.assertEqual(d["host_title"], "Awesome Streaming Deck - Now Playing")
        self.assertEqual(reg.get("np").page_title, "Awesome Streaming Deck - Now Playing (source)")
        cfg = {}
        self.assertIs(reg.get("np").config(cfg), cfg["nowplaying"])

    def test_scene_components_follow_scenes(self):
        reg = components.builtin(self.dir)
        reg.sync_scenes([{"id": "ab12", "name": "Chat", "width": 1080, "height": 1920}])
        comp = reg.get("scene:ab12")
        self.assertEqual(comp.page, "scene.html?id=ab12")
        self.assertEqual(comp.size, (1080, 1920))
        self.assertEqual(comp.page_title, "Awesome Streaming Deck - Canvas ab12 (source)")
        cfg = {}
        self.assertEqual(comp.config(cfg)["height"], 1920)
        self.assertIn("scene:ab12", cfg["canvas"]["outputs"])
        reg.sync_scenes([{"id": "ab12", "name": "Chat 2", "width": 1080, "height": 1920}])
        self.assertEqual(reg.get("scene:ab12").label, "Canvas: Chat 2")
        reg.sync_scenes([])
        self.assertIsNone(reg.get("scene:ab12"))
        self.assertEqual(len(reg.describe_all()), 7)     # the four, the two frames (P6), the live output

    def test_permission_seed_is_idempotent(self):
        profile = os.path.join(self.dir, "chrome-windows")
        self.assertTrue(components.seed_media_permissions(profile, 8799))
        self.assertFalse(components.seed_media_permissions(profile, 8799))
        with open(os.path.join(profile, "Default", "Preferences")) as f:
            prefs = json.load(f)
        ex = prefs["profile"]["content_settings"]["exceptions"]
        self.assertEqual(ex["media_stream_mic"]["http://127.0.0.1:8799,*"]["setting"], 1)
        self.assertTrue(components.seed_media_permissions(profile, 8713), "another port is another origin")


class FeedTests(unittest.TestCase):
    def test_budget_warning(self):
        lines = []
        f = feeds.Feeds(log=lines.append)
        tokens = [f.track("sse", "nowplaying.html") for _ in range(5)]
        self.assertEqual(lines, [])
        tokens.append(f.track("sse", "lyrics.html"))
        self.assertEqual(len(lines), 1, "the sixth pop-out feed is the moment to shout")
        f.track("sse", "deck.html")
        f.track("ws", "scene.html")
        self.assertEqual(len(lines), 1)
        self.assertEqual(f.counts(), {"windows_sse": 6, "windows_ws": 1, "deck": 1, "limit": 6})
        for t in tokens:
            f.release(t)
        self.assertEqual(f.counts()["windows_sse"], 0)
        f.track("sse", "queue.html")
        self.assertEqual(len(lines), 1)

    def test_page_and_group(self):
        self.assertEqual(feeds.Feeds.group_of("deck.html"), "deck")
        self.assertEqual(feeds.Feeds.group_of("scene.html"), "windows")


class VoiceTests(unittest.TestCase):
    class FakeCaptions:
        def __init__(self, on, state, audio, level):
            self.data = {"on": on, "state": state, "audio": audio, "level": level}

        def get(self):
            return self.data

    def test_follows_captions_when_listening(self):
        v = voice.Voice(self.FakeCaptions(True, "listening", "speech", 0.42))
        self.assertEqual(v.status(), {"level": 0.42, "speaking": True, "source": "captions", "error": ""})
        self.assertEqual(v.snapshot()["source"], "captions")

    def test_off_without_leases(self):
        v = voice.Voice(self.FakeCaptions(False, "off", "", 0))
        self.assertEqual(v.status()["source"], "off")
        v.tick()
        self.assertEqual(v.snapshot()["leases"], 0)


if __name__ == "__main__":
    unittest.main()
