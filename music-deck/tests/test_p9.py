"""Inspectors (P9). The inspectors themselves are tested in a browser
(tools/p9); here: the voice threshold they set, the mouse pointer a capture
layer asks for reaching the native capture, the shared design controls
loaded where they are needed, and the runtime's entrances and loops."""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import scenes  # noqa: E402
import voice  # noqa: E402


def read(*parts):
    with open(os.path.join(HERE, *parts), encoding="utf-8") as f:
        return f.read()


class _Captions:
    def get(self):
        return {}


class VoiceThreshold(unittest.TestCase):
    def test_default_clamped_and_reported(self):
        v = voice.Voice(_Captions())
        self.assertEqual(v.threshold, voice.THRESHOLD)
        self.assertEqual(v.set_threshold(2), 0.9)
        self.assertEqual(v.set_threshold(0), 0.01)
        self.assertEqual(v.set_threshold("not a number"), 0.01, "a bad value leaves it as it was")
        self.assertEqual(v.set_threshold(0.2), 0.2)
        self.assertEqual(v.status()["threshold"], 0.2)

    def test_the_configured_threshold_is_used(self):
        self.assertEqual(voice.Voice(_Captions(), threshold=0.3).threshold, 0.3)

    def test_the_monitor_reads_it_live(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("numpy is not installed")
        level = {"t": 0.5}
        m = voice.MicMonitor(threshold=lambda: level["t"])
        block = np.full((800, 1), 0.05, dtype="float32")        # level 0.3 (rms * 6)
        for _ in range(3):
            m._block(block, 800, None, None)
        self.assertFalse(m.speaking, "0.3 is under a 0.5 threshold")
        level["t"] = 0.2
        for _ in range(3):
            m._block(block, 800, None, None)
        self.assertTrue(m.speaking, "the same sound counts once the threshold drops")


class CaptureCursor(unittest.TestCase):
    def layer(self, source, **props):
        return {"type": "capture", "visible": True, "transform": {"x": 0, "y": 0, "w": 640, "h": 360},
                "props": dict({"mode": "native", "source": source}, **props)}

    def test_the_pointer_is_left_out_unless_asked_for(self):
        out = scenes.native_sources({"layers": [
            self.layer({"kind": "window", "title": "Game"}, cursor=True),
            self.layer({"kind": "monitor", "monitor": 0}),
        ]})
        self.assertEqual([o["cursor"] for o in out], [True, False])


class SharedControls(unittest.TestCase):
    def scripts(self, page):
        return re.findall(r'<script src="([^"]+)"', read("web", page))

    def test_the_editor_loads_the_shared_controls_first(self):
        s = self.scripts("canvas.html")
        for dep in ("fonts.js", "scenes.js", "decor.js", "designer.js"):
            self.assertLess(s.index(dep), s.index("canvas.js"), dep)
        self.assertLess(s.index("canvastools.js"), s.index("inspectors.js"))

    def test_the_deck_uses_the_same_ones(self):
        s = self.scripts("deck.html")
        self.assertLess(s.index("designer.js"), s.index("deck.js"))
        deck = read("web", "deck.js")
        for name in ("readControl", "writeControl", "showOut", "bgEditorHTML", "readDataURL"):
            self.assertNotIn(f"function {name}(", deck, f"{name} lives in designer.js now")
            self.assertIn(f"function {name}(", read("web", "designer.js"))

    def test_the_deck_panes_the_inspectors_borrow_exist(self):
        deck_html = read("web", "deck.html")
        block = re.search(r"const DECK_PANES = \{(.*?)\n\};", read("web", "inspectors.js"), re.S).group(1)
        names = re.findall(r"\['([a-z-]+)', '[^']+'\]", block)
        self.assertGreaterEqual(len(names), 10)
        for n in names:
            self.assertIn(f'data-pane="{n}"', deck_html, n)


class Motion(unittest.TestCase):
    def test_every_entrance_and_loop_has_its_style(self):
        js, css = read("web", "scene.js"), read("web", "scene.css")
        for const, prefix in (("ENTERS", "enter-"), ("LOOPS", "loop-")):
            kinds = re.findall(r"'([a-z]+)'", re.search(rf"const {const} = \[(.*?)\];", js).group(1))
            self.assertTrue(kinds)
            for k in kinds:
                self.assertIn(f".{prefix}{k}", css, prefix + k)
                self.assertIn(f"@keyframes {prefix}{k}", css, prefix + k)

    def test_loops_are_endless_so_motion_js_steps_them(self):
        css = read("web", "scene.css")
        for rule in re.findall(r"\.loop-[a-z]+ \{ animation: ([^;]+);", css):
            self.assertIn("infinite", rule)


if __name__ == "__main__":
    unittest.main()
