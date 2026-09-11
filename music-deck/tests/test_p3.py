"""Scene templates and safe zones (P3)."""
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import scenes   # noqa: E402


class Templates(unittest.TestCase):
    def test_every_template_validates_and_fits_its_canvas(self):
        for key, (name, fmt, _fn) in scenes.TEMPLATES.items():
            s = scenes.from_template(key)
            self.assertEqual(s["name"], name)
            self.assertEqual(s["format"], fmt)
            self.assertEqual(scenes.validate(s), s, f"{key} must already be clean")
            self.assertTrue(s["layers"], f"{key} has layers")
            for layer in s["layers"]:
                t = layer["transform"]
                self.assertGreaterEqual(t["x"], 0, f"{key}/{layer['name']} inside the canvas")
                self.assertGreaterEqual(t["y"], 0)
                self.assertLessEqual(t["x"] + t["w"], s["width"], f"{key}/{layer['name']} inside the canvas")
                self.assertLessEqual(t["y"] + t["h"], s["height"], f"{key}/{layer['name']} inside the canvas")
                self.assertIn(layer["type"], ("background", "text", "image", "shape", "component",
                                              "camera", "capture", "reactive"))
        self.assertEqual([t["id"] for t in scenes.template_list()], list(scenes.TEMPLATES))

    def test_unknown_template(self):
        with self.assertRaises(KeyError):
            scenes.from_template("nope")

    def test_safe_zones_sit_inside_the_phone_canvas(self):
        w, h = scenes.FORMATS["phone"]
        for z in scenes.SAFE_ZONES["phone"]:
            self.assertLessEqual(z["x"] + z["w"], w)
            self.assertLessEqual(z["y"] + z["h"], h)

    def test_store_add_gives_a_fresh_id_and_rev_1(self):
        d = tempfile.mkdtemp(prefix="deck-p3-")
        try:
            store = scenes.SceneStore(d)
            a = store.add(scenes.from_template("gaming_portrait"))
            b = store.add(scenes.from_template("gaming_portrait"))
            self.assertNotEqual(a["id"], b["id"])
            self.assertEqual((a["rev"], b["rev"]), (1, 1))
            self.assertEqual(a["width"], 1080)
            self.assertEqual(len(store.list()), 2)
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
