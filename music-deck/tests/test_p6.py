"""Deck integration (P6): the registry the deck's components row is drawn
from - the groups, the card lines, the two frames - and scene outputs
that come and go with their scenes."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import components  # noqa: E402  (imports overlay, which drives Win32 windows)
except (ImportError, AttributeError, OSError):
    components = None


@unittest.skipIf(components is None, "Windows only")
class RowRegistry(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.reg = components.builtin(self.tmp)

    def by_id(self):
        return {c["id"]: c for c in self.reg.describe_all()}

    def test_groups_the_row_is_drawn_from(self):
        d = self.by_id()
        self.assertEqual([i for i, c in d.items() if c["group"] == "music"], ["np", "lyrics", "queue", "captions"])
        self.assertEqual([i for i, c in d.items() if c["group"] == "sharing"], ["screenframe", "camframe"])
        self.assertEqual(d["live"]["group"], "canvas")

    def test_every_card_has_a_line_and_a_page(self):
        for cid, c in self.by_id().items():
            self.assertTrue(c["sub"], cid)
            self.assertTrue(c["page"], cid)
        d = self.by_id()
        self.assertEqual(d["screenframe"]["page"], "frame.html?kind=screen")
        self.assertEqual(d["camframe"]["page"], "frame.html?kind=camera")
        self.assertIn("designer", d["camframe"]["capabilities"])

    def test_frames_keep_their_own_config_sections(self):
        root = {}
        self.reg.get("screenframe").config(root)["width"] = 1280
        self.reg.get("camframe").config(root)["width"] = 480
        self.assertEqual(root["screenframe"]["width"], 1280)
        self.assertEqual(root["camframe"]["width"], 480)

    def test_scene_cards_follow_the_scenes(self):
        self.reg.sync_scenes([{"id": "a1", "name": "Chat", "width": 1080, "height": 1920},
                              {"id": "b2", "name": "Game", "width": 1920, "height": 1080}])
        d = self.by_id()
        self.assertEqual(d["scene:a1"]["sub"], "1080 x 1920")
        self.assertEqual(d["scene:b2"]["group"], "canvas")
        self.reg.sync_scenes([{"id": "b2", "name": "Game", "width": 1920, "height": 1080}])
        self.assertNotIn("scene:a1", self.by_id())

    def test_old_route_names_still_resolve(self):
        self.assertEqual(self.reg.resolve("window").id, "np")
        self.assertEqual(self.reg.resolve("captions/window").id, "captions")


if __name__ == "__main__":
    unittest.main()
