"""TikTok chat (T4, T5): the reader of the user's own logged-in live page.

The page half can only really be tested in a browser (tools/ui/tiktokchat.js
does that, against a fixture). What is tested here is everything around it:
the WebSocket framing the DevTools connection rides on, the turning of a page
line into chat.py's one shape - including who is and is not the broadcaster -
where the reader will and will not go, and that the script injected into the
user's signed-in TikTok page can only read. That last one is NEVER GO LIVE
(2026-09-15): a script that could click there could click Go LIVE.
"""
import os
import re
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import chat  # noqa: E402
import tiktok_chat as tt  # noqa: E402


def server_frame(payload, opcode=1, fin=True):
    """A frame as Chrome sends one: unmasked."""
    data = payload.encode() if isinstance(payload, str) else payload
    n = len(data)
    b0 = (0x80 if fin else 0) | opcode
    if n < 126:
        return bytes([b0, n]) + data
    if n < 65536:
        return bytes([b0, 126]) + struct.pack(">H", n) + data
    return bytes([b0, 127]) + struct.pack(">Q", n) + data


class TheFraming(unittest.TestCase):
    def test_a_client_frame_is_masked_and_round_trips(self):
        for n in (0, 5, 125, 126, 200, 65535, 65536, 70000):
            payload = ("x" * n).encode()
            raw = tt.frame(payload, mask=b"\x01\x02\x03\x04")
            self.assertTrue(raw[1] & 0x80, n)                  # a client must mask
            self.assertEqual(tt.frame_end(raw), len(raw), n)
            op, fin, data = tt.read_frame(raw)
            self.assertEqual((op, fin, data), (1, True, payload), n)

    def test_a_frame_that_is_not_all_there_is_not_consumed(self):
        """The whole point of frame_end: a read that times out half way through
        a frame must leave nothing half taken."""
        raw = server_frame("y" * 300)
        for cut in (0, 1, 3, 100, len(raw) - 1):
            self.assertIsNone(tt.frame_end(raw[:cut]), cut)
        self.assertEqual(tt.frame_end(raw + b"more"), len(raw))

    def test_an_absurd_length_is_refused(self):
        with self.assertRaises(OSError):
            tt.frame_end(bytes([0x81, 127]) + struct.pack(">Q", 1 << 40))


class TheLines(unittest.TestCase):
    def test_a_chat_line_becomes_the_one_shape(self):
        m = tt.to_message("probe", {"name": "Amy Lee", "login": "amylee", "text": "hello there"})
        self.assertEqual((m["service"], m["channel"], m["text"]), ("tiktok", "probe", "hello there"))
        self.assertEqual((m["user"]["login"], m["user"]["name"]), ("amylee", "Amy Lee"))

    def test_commands_parse_exactly_as_every_other_service(self):
        m = tt.to_message("probe", {"name": "Amy", "login": "amy", "text": "!tts read this out"})
        self.assertEqual((m["command"], m["args"]), ("tts", "read this out"))

    def test_badges_reach_the_ladder(self):
        mod = tt.to_message("probe", {"name": "Mo", "login": "mo", "text": "hi", "role": "moderator"})
        sub = tt.to_message("probe", {"name": "Su", "login": "su", "text": "hi", "role": "subscriber"})
        self.assertEqual(chat_rank(mod), "mod")
        self.assertEqual(chat_rank(sub), "subscriber")

    def test_the_streamer_is_the_broadcaster_by_their_profile_link(self):
        me = tt.to_message("probe", {"name": "Whatever I Call Myself", "login": "probe", "text": "hi"})
        self.assertEqual(chat_rank(me), "broadcaster")

    def test_a_display_name_copying_the_streamer_is_nobody(self):
        """The control, and a real attack: a display name is anybody's to set.
        Matched on the name, a viewer called "probe" would pass every gate."""
        fake = tt.to_message("probe", {"name": "probe", "login": "", "text": "hi"})
        other = tt.to_message("probe", {"name": "probe", "login": "someoneelse", "text": "hi"})
        self.assertEqual(chat_rank(fake), "everyone")
        self.assertEqual(chat_rank(other), "everyone")

    def test_empty_lines_are_not_messages(self):
        for p in ({"name": "", "text": "hi"}, {"name": "Amy", "text": "  "}, {}):
            self.assertIsNone(tt.to_message("probe", p), p)


def chat_rank(msg):
    import commands
    return commands.ROLES[commands.rank_of(msg["badges"])]


class WhereItGoes(unittest.TestCase):
    def adapter(self, name):
        return tt.TikTokAdapter(name, lambda m: None)

    def test_a_username_opens_its_live_page(self):
        self.assertEqual(self.adapter("@Some.User_1").live_url(), "https://www.tiktok.com/@some.user_1/live")

    def test_a_name_that_is_not_a_username_is_refused(self):
        for bad in ("", "a", "has space", "x" * 30, "../../evil", "name/live?x=1"):
            with self.assertRaises(ValueError, msg=bad):
                self.adapter(bad).live_url()

    def test_it_goes_nowhere_but_tiktok(self):
        """A base of anything else is refused unless the rig allowed a local
        one - and even then, only a local one."""
        a = self.adapter("probe")
        old = (tt.TikTokAdapter.base, tt.TikTokAdapter.allow_local_base)
        self.addCleanup(lambda: (setattr(tt.TikTokAdapter, "base", old[0]),
                                 setattr(tt.TikTokAdapter, "allow_local_base", old[1])))
        tt.TikTokAdapter.base = "https://evil.example"
        with self.assertRaises(ValueError):
            a.live_url()
        tt.TikTokAdapter.allow_local_base = True
        with self.assertRaises(ValueError):
            a.live_url()                                   # allowed local, and this is not local
        tt.TikTokAdapter.base = "http://127.0.0.1:6790"
        self.assertEqual(a.live_url(), "http://127.0.0.1:6790/@probe/live")

    def test_the_port_comes_from_the_file_chrome_writes(self):
        d = tempfile.mkdtemp()
        self.assertIsNone(tt.devtools_port(d))
        with open(os.path.join(d, "DevToolsActivePort"), "w") as f:
            f.write("51234\n/devtools/browser/abc\n")
        self.assertEqual(tt.devtools_port(d), 51234)

    def test_it_is_registered_beside_twitch(self):
        self.assertIs(chat.ADAPTERS.get("tiktok"), tt.TikTokAdapter)


class WhatItMayDoInThePage(unittest.TestCase):
    """The page is the user's, signed in as them. NEVER GO LIVE."""

    def test_the_injected_script_can_only_read(self):
        for forbidden in (".click(", "dispatchEvent", ".submit(", "location.href =", "location.assign",
                          "location.replace", "fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket(",
                          ".focus(", "execCommand", "window.open"):
            self.assertNotIn(forbidden, tt.OBSERVER, forbidden)

    def test_what_it_sends_goes_to_the_binding_alone(self):
        calls = set(re.findall(r"window\.(__\w+)\(", tt.OBSERVER))
        self.assertEqual(calls, {tt.BINDING})

    def test_the_backlog_is_history(self):
        """What is on screen at attach is marked seen, not offered - or a late
        reader replays old commands."""
        self.assertIn("each(r, (m) => { const x = read(m); if (x) fresh(x.key); });", tt.OBSERVER)

    def test_the_window_is_muted(self):
        """Or the live page plays your own stream back into Desktop sound."""
        self.assertIn("--mute-audio", tt.FLAGS)

    def test_the_devtools_port_is_this_pcs_alone(self):
        self.assertFalse(any(f.startswith("--remote-debugging-address") for f in tt.FLAGS))


if __name__ == "__main__":
    unittest.main()
