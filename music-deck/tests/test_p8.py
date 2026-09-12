"""Canvas tools (P8). The pointer work is tested in a browser (tools/p8);
here: guides are the scene's own and survive a save, the editor page loads
the snapping math before the editor and the tools after it, and the snapping
math's own tests (tools/p8/snaptest.js) pass wherever node is installed."""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import scenes  # noqa: E402


class Guides(unittest.TestCase):
    def test_guides_are_kept_clamped_and_capped(self):
        s = scenes.validate({"name": "g", "format": "horizontal",
                             "guides": {"h": [300, 420.5, "x", 10 ** 9], "v": list(range(300))}})
        self.assertEqual(s["guides"]["h"][:2], [300, 420.5])
        self.assertLessEqual(max(s["guides"]["h"]), scenes.MAX_SIZE)
        self.assertEqual(len(s["guides"]["v"]), 200)

    def test_guides_survive_a_save(self):
        d = tempfile.mkdtemp()
        try:
            store = scenes.SceneStore(d)
            sid = store.create("Guides")["id"]
            scene = store.get(sid)
            scene["guides"] = {"h": [540], "v": [960, 1280]}
            store.save(scene, expect_rev=scene["rev"])
            self.assertEqual(store.get(sid)["guides"], {"h": [540], "v": [960, 1280]})
        finally:
            shutil.rmtree(d, ignore_errors=True)


class EditorPage(unittest.TestCase):
    def test_scripts_load_in_order(self):
        with open(os.path.join(HERE, "web", "canvas.html"), encoding="utf-8") as f:
            srcs = re.findall(r'<script src="([^"]+)"', f.read())
        self.assertLess(srcs.index("snap.js"), srcs.index("canvas.js"))
        self.assertLess(srcs.index("canvas.js"), srcs.index("canvastools.js"))
        for s in srcs:
            self.assertTrue(os.path.isfile(os.path.join(HERE, "web", s)), s)


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class SnapMath(unittest.TestCase):
    def test_snap_js(self):
        r = subprocess.run(["node", os.path.join(HERE, "tools", "p8", "snaptest.js")],
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("snap tests passed", r.stdout)


if __name__ == "__main__":
    unittest.main()
