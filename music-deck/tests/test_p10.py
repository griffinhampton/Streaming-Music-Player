"""The phone canvas (P10): TikTok's controls on a phone scene, the template
gallery, and a scene laid out again for the other format - never a layer
off the canvas."""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import scenes  # noqa: E402


def other(fmt):
    return "phone" if fmt == "horizontal" else "horizontal"


class Inside:
    def assert_inside(self, s, why=""):
        for l in s["layers"]:
            x, y, w, h = scenes.bounds(l["transform"])
            self.assertTrue(x >= -0.01 and y >= -0.01 and x + w <= s["width"] + 0.01 and y + h <= s["height"] + 0.01,
                            f"{why}: {l['name']} at {x:.1f},{y:.1f} {w:.1f}x{h:.1f} on {s['width']}x{s['height']}")


class Conversion(unittest.TestCase, Inside):
    def test_every_template_both_ways_keeps_every_layer_inside(self):
        for key, (_name, fmt, make) in scenes.TEMPLATES.items():
            src = make()
            out = scenes.convert(src, other(fmt))
            self.assertEqual((out["format"], out["width"], out["height"]), (other(fmt), *scenes.FORMATS[other(fmt)]))
            self.assertEqual([(l["id"], l["type"], l["name"]) for l in out["layers"]],
                             [(l["id"], l["type"], l["name"]) for l in src["layers"]], "same layers, same order")
            self.assert_inside(out, key)
            self.assert_inside(scenes.convert(out, fmt), key + " and back")

    def test_horizontal_templates_land_clear_of_tiktok(self):
        for key, (_name, fmt, make) in scenes.TEMPLATES.items():
            if fmt != "horizontal":
                continue
            out = scenes.convert(make(), "phone")
            hits = {l["name"]: scenes.zone_hits(out, l) for l in out["layers"] if scenes.zone_hits(out, l)}
            self.assertEqual(hits, {}, key)

    def test_random_scenes_stay_inside(self):
        rnd = random.Random(10)
        for n in range(60):
            fmt = rnd.choice(list(scenes.FORMATS))
            s = scenes.new_scene("random", fmt)
            for i in range(rnd.randint(1, 12)):
                w, h = rnd.randint(1, 4000), rnd.randint(1, 3000)
                layer = scenes.new_layer(rnd.choice(["text", "shape", "image", "camera", "capture", "component"]), f"L{i}")
                layer["transform"].update(x=rnd.randint(-3000, 4000), y=rnd.randint(-3000, 4000), w=w, h=h,
                                          rotation=rnd.choice([0, 0, 0, 15, 45, 90, -30, 180]),
                                          anchor=rnd.choice(scenes.ANCHORS))
                layer["group"] = rnd.choice(["", "", "g1", "g2"])
                s["layers"].append(layer)
            s = scenes.validate(s)
            self.assert_inside(scenes.convert(s, other(fmt)), f"random scene {n}")
            self.assert_inside(scenes.convert(s, fmt), f"random scene {n}, same format")

    def test_a_camera_keeps_its_frame(self):
        out = scenes.convert(scenes.from_template("just_chatting"), "phone")
        frame = next(l for l in out["layers"] if l["name"] == "Camera frame")["transform"]
        cam = next(l for l in out["layers"] if l["name"] == "Camera")["transform"]
        self.assertTrue(frame["x"] <= cam["x"] and cam["x"] + cam["w"] <= frame["x"] + frame["w"] + 1
                        and frame["y"] <= cam["y"] and cam["y"] + cam["h"] <= frame["y"] + frame["h"] + 1,
                        f"camera {cam} inside its frame {frame}")

    def test_a_group_moves_as_one(self):
        s = scenes.new_scene("g", "horizontal")
        a, b = scenes.new_layer("shape", "A"), scenes.new_layer("shape", "B")
        a["transform"].update(x=100, y=700, w=200, h=100)
        b["transform"].update(x=500, y=900, w=200, h=100)
        a["group"] = b["group"] = "g1"
        s["layers"] = [a, b]
        out = scenes.convert(scenes.validate(s), "phone")
        ta, tb = out["layers"][0]["transform"], out["layers"][1]["transform"]
        sc = ta["w"] / 200
        self.assertAlmostEqual(tb["x"] - ta["x"], 400 * sc, delta=1.5)
        self.assertAlmostEqual(tb["y"] - ta["y"], 200 * sc, delta=1.5)

    def test_the_game_goes_across_the_top_and_backgrounds_fill(self):
        s = scenes.from_template("gaming_landscape")
        bg = scenes.new_layer("background", "Bg")
        bg["transform"].update(x=0, y=0, w=1920, h=1080)
        s["layers"].insert(0, bg)
        out = scenes.convert(scenes.validate(s), "phone")
        game = next(l for l in out["layers"] if l["name"] == "Game")["transform"]
        self.assertEqual((game["x"], game["y"], game["w"], game["h"]), (0, 230, 1080, 608))
        b = out["layers"][0]["transform"]
        self.assertEqual((b["x"], b["y"], b["w"], b["h"]), (0, 0, 1080, 1920))

    def test_text_shrinks_with_its_box(self):
        s = scenes.new_scene("t", "phone")
        t = scenes.new_layer("text", "Wide", text="hi", size=100)
        t["transform"].update(x=0, y=300, w=1080, h=200)
        s["layers"] = [t]
        out = scenes.convert(scenes.validate(s), "horizontal")
        lt = out["layers"][0]
        self.assertAlmostEqual(lt["props"]["size"], 100 * lt["transform"]["w"] / 1080, delta=0.6)


class TikTokControls(unittest.TestCase):
    def phone(self, *boxes):
        s = scenes.new_scene("z", "phone")
        for i, (x, y, w, h, kind) in enumerate(boxes):
            layer = scenes.new_layer(kind, f"L{i}")
            layer["transform"].update(x=x, y=y, w=w, h=h)
            s["layers"].append(layer)
        return scenes.validate(s)

    def test_which_controls_cover_a_layer(self):
        s = self.phone((60, 1400, 600, 200, "text"), (900, 1000, 150, 300, "image"), (100, 600, 400, 300, "shape"),
                       (0, 0, 1080, 1920, "image"), (0, 0, 1080, 1920, "background"))
        self.assertEqual([scenes.zone_hits(s, l) for l in s["layers"]],
                         [["Comments"], ["Side buttons"], [], [], []])

    def test_a_sliver_does_not_count(self):
        s = self.phone((100, 1300, 600, 400, "text"))       # 370 of its 400 px down under the comments
        self.assertEqual(scenes.zone_hits(s, s["layers"][0]), ["Comments"])
        s = self.phone((100, 1000, 600, 340, "text"))       # 10 of its 340 px: not enough to count
        self.assertEqual(scenes.zone_hits(s, s["layers"][0]), [])

    def test_horizontal_scenes_have_none(self):
        s = scenes.new_scene("h", "horizontal")
        layer = scenes.new_layer("text", "T")
        s["layers"] = [layer]
        self.assertEqual(scenes.zone_hits(scenes.validate(s), layer), [])

    def test_phone_templates_leave_tiktok_its_room(self):
        for key, (_name, fmt, make) in scenes.TEMPLATES.items():
            if fmt == "phone":
                s = make()
                self.assertEqual({l["name"]: scenes.zone_hits(s, l) for l in s["layers"] if scenes.zone_hits(s, l)}, {}, key)


class Gallery(unittest.TestCase):
    def test_previews_draw_every_template(self):
        prev = scenes.template_previews()
        self.assertEqual([p["id"] for p in prev], list(scenes.TEMPLATES))
        self.assertGreaterEqual(sum(p["format"] == "phone" for p in prev), 3)
        for p in prev:
            self.assertEqual((p["width"], p["height"]), scenes.FORMATS[p["format"]])
            self.assertTrue(p["layers"] and all("transform" in l and "type" in l for l in p["layers"]))


if __name__ == "__main__":
    unittest.main()
