"""Unit tests for P12: a scene as one .zip (sceneio.py) - out and back in,
and everything an import refuses or leaves out - and the scene store's way
with a file that cannot be read. Plain unittest, temporary folders only.

    python -m unittest discover -s music-deck/tests -v
"""
import base64
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import assets    # noqa: E402
import fonts     # noqa: E402
import scenes    # noqa: E402
import sceneio   # noqa: E402

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
PNG2 = PNG + b"\x00"                    # other bytes, so another name; still starts like a PNG
JPG = b"\xff\xd8\xff\xe0" + bytes(40)
TTF = b"\x00\x01\x00\x00" + bytes(60)   # no name table: the family comes from the file name
TTF2 = b"\x00\x01\x00\x00" + bytes(61)


def zip_of(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, body in files.items():
            zf.writestr(name, body if isinstance(body, bytes) else json.dumps(body))
    return buf.getvalue()


class Stores(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="deck-p12-")
        self.a = assets.AssetStore(os.path.join(self.dir, "a1"))
        self.f = fonts.FontStore(os.path.join(self.dir, "f1"))
        # a second PC, the one the scene is passed on to
        self.a2 = assets.AssetStore(os.path.join(self.dir, "a2"))
        self.f2 = fonts.FontStore(os.path.join(self.dir, "f2"))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def put(self, name, raw, thumb=None):
        res = self.a.save_bytes(name, raw, thumb)
        self.assertTrue(res["ok"], res)
        return res["id"]

    def scene(self, aid, aid2, family="Comic Zine"):
        s = scenes.new_scene("Share me", "horizontal")
        s["layers"] = [
            scenes.new_layer("image", "Pic", src=aid),
            scenes.new_layer("reactive", "Face", idle=aid2, talking="/asset/" + aid),
            scenes.new_layer("text", "Title", text="hi", font=family),
            scenes.new_layer("image", "Shipped", src="builtin:sakura.png"),
        ]
        s["background"].update(mode="image", image=aid2)
        return scenes.validate(s)


class RoundTrip(Stores):
    def test_out_and_back_in_on_another_pc(self):
        aid, aid2 = self.put("cat.png", PNG), self.put("dog.png", PNG2, thumb=JPG)
        unused = self.put("unused.png", PNG + b"xx")
        fid = self.f.save_bytes("Comic Zine-Regular.ttf", TTF)["id"]
        self.f.save_bytes("Other-Regular.ttf", TTF2)
        scene = self.scene(aid, aid2)

        data, filename, manifest = sceneio.export_zip(scene, self.a, self.f)
        self.assertEqual(filename, "Share me.zip")
        names = set(zipfile.ZipFile(io.BytesIO(data)).namelist())
        self.assertEqual(names, {"scene.json", "manifest.json", "assets/" + aid, "assets/" + aid2,
                                 "assets/" + aid2 + ".thumb.jpg", "fonts/" + fid})
        self.assertNotIn("assets/" + unused, names)
        self.assertEqual(manifest["builtin"], ["sakura.png"])
        self.assertEqual({a["name"] for a in manifest["assets"]}, {"cat.png", "dog.png"})

        got, report = sceneio.import_zip(data, self.a2, self.f2)
        self.assertEqual((report["assets"], report["fonts"], report["skipped"], report["missing"]),
                         (2, 1, [], []))
        self.assertEqual(report["builtin_missing"], ["sakura.png"])     # this PC has no shipped art
        self.assertEqual(got["id"], "")
        self.assertEqual([l["props"] for l in got["layers"]], [l["props"] for l in scene["layers"]])
        self.assertEqual(got["background"]["image"], aid2)
        self.assertTrue(self.a2.path(aid) and self.a2.path(aid2))
        self.assertTrue(os.path.isfile(self.a2.path(aid2) + ".thumb.jpg"))
        self.assertEqual(self.f2.families(), ["Comic Zine"])
        stored = scenes.SceneStore(os.path.join(self.dir, "scenes")).add(got)
        self.assertTrue(stored["id"] and stored["rev"] == 1)

    def test_a_new_name_and_a_newer_file(self):
        aid = self.put("cat.png", PNG)
        data, _, _ = sceneio.export_zip(self.scene(aid, aid), self.a, self.f)
        got, _ = sceneio.import_zip(data, self.a2, self.f2, name="  Renamed  ")
        self.assertEqual(got["name"], "Renamed")
        man = {"format": sceneio.FORMAT, "version": sceneio.VERSION + 1}
        got, report = sceneio.import_zip(zip_of({"scene.json": self.scene(aid, aid), "manifest.json": man,
                                                 "assets/" + aid: PNG}), self.a2, self.f2)
        self.assertTrue(report["newer"])
        self.assertEqual(len(got["layers"]), 4)

    def test_saved_to_a_folder_never_over_another(self):
        aid = self.put("cat.png", PNG)
        out = os.path.join(self.dir, "out")
        one = sceneio.save_export(self.scene(aid, aid), self.a, self.f, out)
        two = sceneio.save_export(self.scene(aid, aid), self.a, self.f, out)
        self.assertEqual((one["file"], two["file"]), ("Share me.zip", "Share me (2).zip"))
        self.assertTrue(os.path.isfile(two["path"]) and two["bytes"] > 0)
        self.assertEqual(sorted(os.listdir(out)), ["Share me (2).zip", "Share me.zip"])

    def test_a_deleted_picture_is_listed_not_packed(self):
        aid, aid2 = self.put("cat.png", PNG), self.put("dog.png", PNG2)
        self.a.delete(aid2)
        data, _, manifest = sceneio.export_zip(self.scene(aid, aid2), self.a, self.f)
        self.assertEqual(manifest["missing"], [aid2])
        _, report = sceneio.import_zip(data, self.a2, self.f2)
        self.assertEqual(report["missing"], [aid2])

    def test_downloads_folder_is_a_real_path(self):
        self.assertTrue(os.path.isabs(sceneio.downloads_dir()))


class Refused(Stores):
    def refused(self, raw, words):
        with self.assertRaises(sceneio.ImportRefused) as ctx:
            sceneio.import_zip(raw, self.a2, self.f2)
        self.assertIn(words, str(ctx.exception))

    def test_what_is_not_a_scene(self):
        good = scenes.new_scene("x")
        self.refused(b"", "empty")
        self.refused(b"hello, not a zip", "not a .zip")
        self.refused(zip_of({"notes.txt": b"hi"}), "no scene")
        self.refused(zip_of({"scene.json": good, "manifest.json": {"format": "something else"}}),
                     "not a scene exported")
        self.refused(zip_of({"scene.json": b"{ nope"}), "damaged")
        self.refused(zip_of({"scene.json": [1, 2, 3]}), "does not hold a scene")
        self.refused(zip_of({"scene.json": {"layers": "lots"}}), "does not hold a scene")
        self.refused(zip_of({"scene.json": b'"' + b"x" * (sceneio.MAX_JSON + 10) + b'"'}), "larger than")
        with mock.patch.object(sceneio, "MAX_MEMBERS", 3):
            self.refused(zip_of({f"f{i}": b"x" for i in range(5)}), "more than 3 files")
        with mock.patch.object(sceneio, "MAX_TOTAL", 100):
            self.refused(zip_of({"scene.json": good, "assets/a.png": bytes(200)}), "unpacks to more than")
        with mock.patch.object(sceneio, "MAX_ZIP", 10):
            self.refused(zip_of({"scene.json": good}), "larger than")

    def test_what_is_left_out(self):
        aid = self.put("cat.png", PNG)
        fake = "0123456789abcdef.png"         # the scene names it, but the file is no PNG
        scene = self.scene(aid, fake, family="Comic Zine")
        stray = "fedcba9876543210.png"
        data = zip_of({"scene.json": scene, "assets/" + aid: PNG, "assets/" + fake: b"notapng" * 10,
                       "assets/" + stray: PNG2, "../evil.png": PNG, "readme.txt": b"hello",
                       "fonts/" + "a" * 16 + ".ttf": TTF2, "fonts/" + "b" * 16 + ".ttf": b"not a font"})
        got, report = sceneio.import_zip(data, self.a2, self.f2)
        skipped = " | ".join(report["skipped"])
        for words in (fake + " is not a PNG file", stray + ": the scene does not use it",
                      "../evil.png: not a file name", "readme.txt: not part of a scene",
                      "a" * 16 + ".ttf: the scene does not use it", "b" * 16 + ".ttf is not a TTF font"):
            self.assertIn(words, skipped)
        self.assertEqual(report["assets"], 1)
        self.assertEqual(report["missing"], [fake])
        self.assertEqual([a["id"] for a in self.a2.list()], [aid])
        self.assertEqual(self.f2.list(), [])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "evil.png")))

    def test_each_file_is_read_with_a_cap(self):
        aid = self.put("cat.png", PNG)
        self.a2.MAX_BYTES = 50                # this PC's limit, for the test
        big = PNG + bytes(500)
        data = zip_of({"scene.json": self.scene(aid, aid), "assets/" + aid: big})
        got, report = sceneio.import_zip(data, self.a2, self.f2)
        self.assertIn("larger than", " ".join(report["skipped"]))
        self.assertEqual(report["assets"], 0)
        self.assertEqual(report["missing"], [aid])

    def test_content_that_changed_is_stored_under_its_own_name(self):
        aid = self.put("cat.png", PNG)
        real = self.a2.save_bytes("probe.png", PNG2)["id"]      # PNG2's own name
        self.a2.delete(real)
        data = zip_of({"scene.json": self.scene(aid, aid), "assets/" + aid: PNG2})
        got, report = sceneio.import_zip(data, self.a2, self.f2)
        self.assertEqual(report["assets"], 1)
        self.assertIsNone(self.a2.path(aid))
        self.assertTrue(self.a2.path(real))
        props = [l["props"] for l in got["layers"]]
        self.assertEqual(props[0]["src"], real)
        self.assertEqual(props[1]["talking"], "/asset/" + real)
        self.assertEqual(got["background"]["image"], real)


class UnreadableScenes(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="deck-p12s-")
        scenes.SceneStore.backup_every = 0

    def tearDown(self):
        scenes.SceneStore.backup_every = 60.0
        shutil.rmtree(self.dir, ignore_errors=True)

    def made(self):
        store = scenes.SceneStore(self.dir)
        s = store.create("Keep me")
        store.save(dict(s, name="Keep me too"))                 # a backup of the first version
        return s["id"]

    def test_a_damaged_file_comes_back_from_its_backup(self):
        sid = self.made()
        main = os.path.join(self.dir, sid + ".json")
        with open(main, "w", encoding="utf-8") as f:
            f.write('{"name": "half a sce')
        store = scenes.SceneStore(self.dir)
        self.assertEqual(store.get(sid)["name"], "Keep me")
        self.assertEqual(store.unreadable, [])
        with open(main, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["name"], "Keep me")   # the file is whole again
        self.assertTrue(os.path.isfile(main + ".corrupt"))        # and the damaged one kept aside

    def test_a_file_with_no_good_copy_is_set_aside_and_reported(self):
        sid = self.made()
        for name in os.listdir(self.dir):
            with open(os.path.join(self.dir, name), "w", encoding="utf-8") as f:
                f.write("garbage")
        store = scenes.SceneStore(self.dir)
        self.assertEqual(store.list(), [])
        self.assertEqual(store.unreadable, [{"id": sid, "file": sid + ".json", "kept_as": sid + ".json.corrupt"}])
        self.assertFalse(os.path.exists(os.path.join(self.dir, sid + ".json")))
        self.assertEqual(scenes.SceneStore(self.dir).unreadable, [])   # reported once, then left alone

    def test_restoring_a_damaged_backup_says_no(self):
        sid = self.made()
        with open(os.path.join(self.dir, sid + ".json.1"), "w", encoding="utf-8") as f:
            f.write("garbage")
        store = scenes.SceneStore(self.dir)
        self.assertIsNone(store.restore(sid, 1))
        self.assertEqual(store.get(sid)["name"], "Keep me too")


class Uploads(Stores):
    def test_an_upload_with_its_thumbnail_still_works(self):
        b64 = lambda raw: base64.b64encode(raw).decode()
        res = self.a.save("x.png", "data:image/png;base64," + b64(PNG), thumb="data:image/jpeg;base64," + b64(JPG))
        self.assertTrue(res["ok"], res)
        self.assertIn("assets", res)
        self.assertTrue(os.path.isfile(self.a.path(res["id"]) + ".thumb.jpg"))

    def test_used_by_says_where_in_words(self):
        aid = self.put("cat.png", PNG)
        self.assertEqual(self.a.used_by(aid, [], {"nowplaying": {"bg": {"image": aid}}}), ["the Now Playing window"])


class ServerWiring(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(HERE, "server.py"), encoding="utf-8") as f:
            self.src = f.read()

    def test_import_is_routed_before_the_per_scene_routes(self):
        self.assertLess(self.src.index('path == "/api/scenes/import"'),
                        self.src.index("(?:/(delete|duplicate|restore|convert|export))"))

    def test_an_svg_opened_alone_runs_no_script(self):
        block = self.src[self.src.index('asset.lower().endswith(".svg")'):][:200]
        self.assertIn("sandbox", block)
        self.assertIn("default-src 'none'", block)


if __name__ == "__main__":
    unittest.main()
