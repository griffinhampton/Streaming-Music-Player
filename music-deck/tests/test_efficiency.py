"""Efficiency pass (2026-09-12): the state snapshot asks every component
whether its window is open; those lookups share one pass over the desktop's
windows instead of one pass each."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import winwin  # noqa: E402


@unittest.skipUnless(winwin.available(), "Windows only")
class SharedEnumeration(unittest.TestCase):
    def setUp(self):
        self.calls = 0
        self.real = winwin._visible_windows
        winwin._WINDOWS = (0.0, [])

        def fake():
            self.calls += 1
            return [(101, "Awesome Streaming Deck - Now Playing", "Chrome_WidgetWin_1"),
                    (102, "Awesome Streaming Deck - Now Playing", "Notepad"),
                    (103, "Awesome Streaming Deck - Lyrics", "Chrome_WidgetWin_1")]
        winwin._visible_windows = fake

    def tearDown(self):
        winwin._visible_windows = self.real
        winwin._WINDOWS = (0.0, [])

    def test_lookups_within_max_age_share_one_pass(self):
        titles = ["Awesome Streaming Deck - Now Playing", "Awesome Streaming Deck - Lyrics", "Nope"] * 5
        found = [winwin.find_window(t, max_age=5) for t in titles]
        self.assertEqual(self.calls, 1)
        self.assertEqual(found[:3], [101, 103, None])

    def test_a_fresh_lookup_always_enumerates(self):
        winwin.find_window("Awesome Streaming Deck - Lyrics", max_age=5)
        winwin.find_window("Awesome Streaming Deck - Lyrics")
        winwin.find_window("Awesome Streaming Deck - Lyrics")
        self.assertEqual(self.calls, 3)

    def test_only_browser_windows_match(self):
        self.assertEqual(winwin.find_window("Awesome Streaming Deck - Now Playing", max_age=5), 101)
        self.assertEqual(winwin.find_window("Awesome Streaming Deck - Now Playing", classes=("Notepad",)), 102)


if __name__ == "__main__":
    unittest.main()
