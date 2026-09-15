"""NEVER GO LIVE by accident (2026-09-15).

The user has a real TikTok stream key now, and said so in capitals. The test
rig must not be able to go live anywhere but this PC, however it is asked -
and the wiring that makes that true is spread over four files, any one of which
could lose its half quietly. So each half is pinned here.

The engine's half is tested for real. The rest is read out of the source,
because the alternative - starting a server - is exactly the kind of test that
has no business being near a stream key.
"""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import live  # noqa: E402


def src(*parts):
    with open(os.path.join(HERE, *parts), encoding="utf-8") as f:
        return f.read()


class WhatCountsAsThisPC(unittest.TestCase):
    def test_local_addresses(self):
        for url in ("rtmp://127.0.0.1:1935/live", "rtmp://localhost/live", "rtmp://[::1]:1935/live"):
            self.assertTrue(live.is_local_url(url), url)

    def test_everything_else(self):
        """The control, and the list that matters: TikTok's ingest, a host that
        merely starts with 127, an address with 127.0.0.1 hidden in it, and
        nonsense."""
        for url in ("rtmp://push.tiktok.example/live", "rtmp://127.0.0.1.evil.example/live",
                    "rtmp://evil.example/127.0.0.1", "rtmp://user@evil.example/live",
                    "", None, "not a url", "rtmp://10.0.0.5/live"):
            self.assertFalse(live.is_local_url(url), repr(url))


class TheEngine(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.eng = live.LiveEngine(self.dir)

    def test_it_is_off_unless_the_rig_turns_it_on(self):
        """The user's app must be able to stream: the default is not local-only."""
        self.assertFalse(self.eng.local_only)

    def test_local_only_refuses_a_remote_address(self):
        self.eng.local_only = True
        res = self.eng.start("rtmp://push.tiktok.example/live", "a-key")
        self.assertFalse(res["ok"])
        self.assertTrue(res.get("refused"))
        self.assertEqual(self.eng.state, "idle")
        self.assertIsNone(self.eng._sender)                 # nothing was ever started

    @unittest.skipUnless(os.name == "nt", "the vault is DPAPI, which is Windows'")
    def test_and_a_remote_address_that_came_out_of_the_vault(self):
        """The gap this closes: start() with no address falls back to the one
        saved. A guard on the request alone would wave that straight through."""
        self.eng.vault.save("rtmp://push.tiktok.example/live", "a-saved-key")
        self.eng.local_only = True
        res = self.eng.start()
        self.assertFalse(res["ok"])
        self.assertTrue(res.get("refused"))
        self.assertIsNone(self.eng._sender)


class TheWiring(unittest.TestCase):
    """The halves outside the engine, read from the files that hold them."""

    def test_the_server_turns_it_on_from_the_rig_flag_and_nothing_else(self):
        s = src("server.py")
        self.assertIn('TEST_RIG = CONFIG.get("test_rig") is True', s)
        self.assertIn("LIVE.local_only = TEST_RIG", s)

    def test_the_server_refuses_the_tiktok_routes_on_the_rig(self):
        s = src("server.py")
        self.assertIn('if TEST_RIG and path in ("/api/tiktok/token", "/api/tiktok/start"):', s)
        # And that check comes before the routes it guards, or it guards nothing.
        self.assertLess(s.index("if TEST_RIG and path in"), s.index('if path == "/api/tiktok/token":'))
        self.assertLess(s.index("if TEST_RIG and path in"), s.index('if path == "/api/tiktok/start":'))

    def test_the_rig_is_stamped_and_checked_on_every_restart(self):
        r = src("tools", "rig", "rigrestart.ps1")
        self.assertIn('"test_rig": true', r)                 # a new rig
        self.assertIn("c['test_rig']=True", r)                # an old one, every time
        self.assertIn("refusing to start it", r)              # and a rig without it does not start

    def test_a_rebuild_will_not_end_a_stream(self):
        b = src("tools", "rig", "rebuild.ps1")
        self.assertIn("the app is LIVE right now", b)
        # Before the step that quits the app, or it is a warning after the fact.
        self.assertLess(b.index("the app is LIVE right now"), b.index("# 6. quit the app"))


if __name__ == "__main__":
    unittest.main()
