"""T10's stop, on the canvas: which layers it reaches.

A stop is handed to every layer type that defines one method, whatever that
type is. So the method's name is the whole contract, and the first version got
it wrong: it called the method `stop`, which the microphone layer already had,
meaning "tear down my analyser and release the device". Pressing Stop effects
would have frozen a meter on stream until the page was reloaded.

The rig probe (tools/ui/fxflood.js) catches that by watching a meter keep
moving after a stop. This catches the cause, cheaply and without a browser:
the name must be defined by the types that hold events and by nothing else, so
the next type to grow a method of that name has to come here and say so.
"""
import os
import re
import unittest

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
HOOK = "takeDown"
# The layers that hold something an event put on screen - T7's voice among them.
HOLDERS = {"alert", "effect", "speak", "gift"}
# T7's Skip travels the same way, by its own name, and only a voice has one.
SKIPPERS = {"speak"}


def types_in(src):
    """{type name: its body} for every `TYPES.x = { ... };` in scene.js."""
    out = {}
    for m in re.finditer(r"^TYPES\.(\w+) = \{\n(.*?)^\};", src, re.M | re.S):
        out[m.group(1)] = m.group(2)
    return out


class TheStopHook(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(WEB, "scene.js"), encoding="utf-8") as f:
            cls.src = f.read()
        cls.types = types_in(cls.src)

    def test_the_parse_found_the_types(self):
        """The floor: a regex that matched nothing would pass every check
        below. scene.js has twelve types today; fewer than ten means the
        parse broke, not that types went away."""
        self.assertGreaterEqual(len(self.types), 10, sorted(self.types))
        self.assertTrue(HOLDERS <= set(self.types), sorted(self.types))

    def test_only_the_layers_that_hold_events_define_it(self):
        defining = {name for name, body in self.types.items()
                    if re.search(r"^  %s\(entry\)" % HOOK, body, re.M)}
        self.assertEqual(defining, HOLDERS)

    def test_the_stop_is_dispatched_by_that_name(self):
        """And not by `stop`, which is the name that collided."""
        branch = re.search(r"ev\.kind === 'stop'\) \{(.*?)return;", self.src, re.S)
        self.assertIsNotNone(branch, "the stop branch in Stage.alert was not found")
        self.assertIn("t.%s(entry)" % HOOK, branch.group(1))
        self.assertNotIn("t.stop", branch.group(1))

    def test_only_a_voice_defines_the_skip(self):
        defining = {name for name, body in self.types.items()
                    if re.search(r"^  skipCurrent\(entry\)", body, re.M)}
        self.assertEqual(defining, SKIPPERS)

    def test_the_skip_is_dispatched_by_that_name(self):
        branch = re.search(r"ev\.kind === 'skip'\) \{(.*?)return;", self.src, re.S)
        self.assertIsNotNone(branch, "the skip branch in Stage.alert was not found")
        self.assertIn("t.skipCurrent(entry)", branch.group(1))

    def test_the_microphone_still_has_the_stop_it_always_had(self):
        """The control, and the collision's other half: the mic layer's own
        stop() is real and used (its update() calls it to reopen the device),
        so renaming that one would have been the wrong fix."""
        self.assertRegex(self.types["mic"], r"(?m)^  stop\(entry\)")
        self.assertIn("this.stop(entry)", self.types["mic"])


if __name__ == "__main__":
    unittest.main()
