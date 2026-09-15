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
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))     # test_webcast's frame builders

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

    def test_it_never_asks_chrome_for_port_0(self):
        """Launched with --remote-debugging-port=0, TikTok's real live page
        never entered the room - no webcast socket, no chat drawn - while the
        same Chrome with a fixed port read it (2026-09-15). The first version
        asked for port 0 and read nothing on any real live; the fixture could
        never have shown it. So the reader picks a free port itself."""
        with open(tt.__file__, encoding="utf-8") as f:
            src = f.read()
        self.assertIn('f"--remote-debugging-port={port}"', src)
        self.assertIn("port = free_port()", src)
        self.assertNotIn('"--remote-debugging-port=0"', src)
        p = tt.free_port()
        self.assertTrue(1024 <= p <= 65535, p)

    def test_a_running_window_is_found_by_its_port_file(self):
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

    def test_it_follows_the_real_page_as_recorded(self):
        """Checked against TikTok's real room page on 2026-09-15
        (tools/ui/ttreal.js): the list under live-chat-container, the words
        found by structure after the name's row, and signed-out shown by a
        Log in button - button#header-login-button on one room, a plain button
        with only the words on the next. Each was a fault in the first version,
        found only by looking at the real thing."""
        o = tt.OBSERVER
        self.assertIn('[data-e2e="live-chat-container"]', o)
        self.assertIn("all.find((x) => x.querySelector(MSG))", o)
        self.assertIn("while (row.parentElement && row.parentElement !== m && !row.nextElementSibling)", o)
        self.assertIn("#header-login-button", o)
        # And measured again against the room socket: the first break-words
        # holds the name too, so the words are the last one that does not.
        self.assertIn("[...m.querySelectorAll('.break-words')].filter((b) => !who || !b.contains(who))", o)
        self.assertIn("/^log ?in$/i.test((b.textContent || '').trim())", o)

    def test_what_it_asks_of_devtools_only_reads(self):
        """T6 added network watching. Everything the reader sends DevTools is
        on this list: turning on events, one binding, OBSERVER, and a single
        navigation - to live_url(), which only allows www.tiktok.com/@you/live.
        It never asks for cookies (the sign-in is in them), a response body,
        storage, or to stop or rewrite a request."""
        with open(tt.__file__, encoding="utf-8") as f:
            src = f.read()
        asked = set(re.findall(r'\("([A-Z][A-Za-z]+\.[A-Za-z]+)",', src))
        self.assertEqual(asked, {"Runtime.enable", "Page.enable", "Network.enable", "Runtime.addBinding",
                                 "Page.addScriptToEvaluateOnNewDocument", "Page.navigate",
                                 "Emulation.setEmulatedMedia"})
        self.assertIn('("Page.navigate", {"url": url})', src)
        self.assertIn("url = self.live_url()", src)
        for never in ("Cookies", "Storage.", "getResponseBody", "setRequestInterception", "Fetch.",
                      "Input.", "Runtime.callFunctionOn", "sendMessageToTarget"):
            self.assertNotIn(never, src, never)

    def test_a_gift_from_the_page_reaches_post_gift_as_text(self):
        """The DevTools events, in the order a page sends them, through the
        adapter - and a name with a direction override comes out without it."""
        import base64
        from test_webcast import gift_payload, push, user, wrap
        got = []
        old = tt.TikTokAdapter.on_gift
        self.addCleanup(setattr, tt.TikTokAdapter, "on_gift", old)
        tt.TikTokAdapter.on_gift = got.append
        a = tt.TikTokAdapter("probe", lambda m: None)
        a._event("Page.frameNavigated", {"frame": {"id": "main", "url": "https://www.tiktok.com/@probe/live"}})
        room = "wss://webcast-ws.us.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/"
        name = "Ev" + chr(0x202E) + "il"
        frame = push([wrap("WebcastGiftMessage", gift_payload(streak=False, frm=user(7, name, "evil")))])
        a._event("Network.webSocketFrameReceived", {"requestId": "9", "response": {
            "opcode": 2, "payloadData": base64.b64encode(frame).decode()}})
        self.assertEqual(got, [], "a frame from a socket it never saw open")
        a._event("Network.webSocketCreated", {"requestId": "9", "url": room})
        a._event("Network.webSocketFrameReceived", {"requestId": "9", "response": {
            "opcode": 2, "payloadData": base64.b64encode(frame).decode()}})
        self.assertEqual([(g["user"], g["gift"], g["coins"]) for g in got], [("Evil", "Rose", 1)])
        self.assertEqual(a.status()["page"]["gifts"], 1)
        self.assertTrue(a.status()["page"]["socket"])

    def socket_adapter(self):
        import base64
        got = []
        a = tt.TikTokAdapter("probe", got.append)
        a._event("Page.frameNavigated", {"frame": {"id": "main", "url": "https://www.tiktok.com/@probe/live"}})
        a._event("Network.webSocketCreated", {"requestId": "9", "url":
                 "wss://webcast-ws.us.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/"})

        def say(frame):
            a._event("Network.webSocketFrameReceived", {"requestId": "9", "response": {
                "opcode": 2, "payloadData": base64.b64encode(frame).decode()}})
        return a, got, say

    def test_the_streamer_is_the_broadcaster_by_handle_from_the_room_socket(self):
        """The room socket gives every line its sender's @handle, which TikTok
        sets and nobody can copy - so the streamer's own lines are theirs, and
        a viewer who takes the streamer's display name is still nobody."""
        from test_webcast import chat_frame, user
        a, got, say = self.socket_adapter()
        say(chat_frame(text="!mine", frm=user(1, "Whatever I Call Myself", "probe")))
        say(chat_frame(text="!mine", frm=user(2, "probe", "copycat")))
        self.assertEqual([(m["user"]["name"], m["user"]["login"], chat_rank(m)) for m in got],
                         [("Whatever I Call Myself", "probe", "broadcaster"), ("probe", "copycat", "everyone")])
        self.assertEqual(got[0]["command"], "mine")

    def test_a_moderator_by_tiktoks_own_flag(self):
        from test_webcast import chat_frame, user
        a, got, say = self.socket_adapter()
        say(chat_frame(text="hi", frm=user(3, "Mo", "mo"), flags=(1, 2, 3, 4, 5)))
        say(chat_frame(text="hi", frm=user(4, "Su", "su"), flags=(1, 2, 3)))
        self.assertEqual([chat_rank(m) for m in got], ["mod", "everyone"])

    def test_a_follower_by_tiktoks_own_flag(self):
        from test_webcast import chat_frame, user
        a, got, say = self.socket_adapter()
        say(chat_frame(text="hi", frm=user(5, "Fan", "fan"), flags=(4,)))
        say(chat_frame(text="hi", frm=user(6, "Gifter", "gifter"), flags=(1, 2, 3)))
        say(chat_frame(text="hi", frm=user(7, "ModFan", "modfan"), flags=(4, 5)))
        self.assertEqual([chat_rank(m) for m in got], ["follower", "everyone", "mod"])

    def test_the_pages_drawing_is_only_the_fallback(self):
        """Chat comes from the room socket. The page's own drawing is used only
        when no room socket is heard - never in the first PAGE_WAIT seconds,
        when TikTok draws the backlog before its socket is up."""
        import json
        import time
        got = []
        a = tt.TikTokAdapter("probe", got.append)
        a._event("Page.frameNavigated", {"frame": {"id": "main", "url": "https://www.tiktok.com/@probe/live"}})
        line = json.dumps({"t": "chat", "name": "Amy", "text": "hello"})
        a._payload(line)
        self.assertEqual(got, [], "in the first seconds after the page opens")
        a._opened = time.monotonic() - tt.PAGE_WAIT - 1
        a._payload(line)
        self.assertEqual(len(got), 1, "no room socket, after the wait: the fallback")
        self.assertEqual(a.status()["page"]["chat_from"], "page")
        a.room.opened("9", "wss://webcast-ws.us.tiktok.com/webcast/im/x/")
        a._payload(line)
        self.assertEqual(len(got), 1, "the room socket is heard from: the page's copy is not sent")
        self.assertEqual(a.status()["page"]["chat_from"], "socket")

    def test_it_asks_for_reduced_motion_and_nothing_heavier(self):
        """Measured on real lives, side by side (DECISIONS, "What the reader
        costs"): reduced motion took the reader's Chrome from about half a core
        to a third or less. Chrome's CPU throttling did the opposite - over a
        whole core - and, with the others, stopped the chat; pausing every
        animation saved as much but would freeze a sign-in dialog mid-fade.
        So: the one, and neither of the others."""
        with open(tt.__file__, encoding="utf-8") as f:
            src = f.read()
        self.assertIn('{"name": "prefers-reduced-motion", "value": "reduce"}', src)
        for never in ("setCPUThrottlingRate", "Animation.setPlaybackRate", "setWebLifecycleState"):
            self.assertNotIn(never, src, never)

    def test_only_the_streamers_own_live_is_read(self):
        """TikTok's live page offers other lives, and an ended one can move on
        to another. Read from there, a stranger's gifts would go on this stream
        and their chat would run commands and be read aloud. So nothing counts
        unless the window's page itself is at /@<channel>/live."""
        import base64
        import json
        import time
        from test_webcast import chat_frame, gift_frame
        gifts, lines = [], []
        old = tt.TikTokAdapter.on_gift
        self.addCleanup(setattr, tt.TikTokAdapter, "on_gift", old)
        tt.TikTokAdapter.on_gift = gifts.append
        a = tt.TikTokAdapter("probe", lines.append)
        a._event("Network.webSocketCreated", {"requestId": "9", "url":
                 "wss://webcast-ws.us.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/"})

        def say(frame):
            a._event("Network.webSocketFrameReceived", {"requestId": "9", "response": {
                "opcode": 2, "payloadData": base64.b64encode(frame).decode()}})

        def go(url, within=False):
            if within:
                a._event("Page.navigatedWithinDocument", {"frameId": "main", "url": url})
            else:
                a._event("Page.frameNavigated", {"frame": {"id": "main", "url": url}})

        say(gift_frame(streak=False))
        self.assertEqual(gifts, [], "before the page has been anywhere")
        go("https://www.tiktok.com/@probe/live")
        say(gift_frame(streak=False))
        say(chat_frame(text="hi"))
        self.assertEqual((len(gifts), len(lines)), (1, 1))
        self.assertTrue(a.status()["page"]["own"])
        go("https://www.tiktok.com/@someoneelse/live", within=True)     # TikTok moving within its page
        decoded = a.room.frames
        say(gift_frame(streak=False))
        say(chat_frame(text="from another live"))
        self.assertEqual((len(gifts), len(lines)), (1, 1))
        self.assertEqual(a.room.frames, decoded, "not even decoded")
        self.assertFalse(a.status()["page"]["own"])
        # A frame inside the page is not the page.
        a._event("Page.frameNavigated", {"frame": {"id": "ad", "parentId": "main",
                                                   "url": "https://www.tiktok.com/@probe/live"}})
        self.assertFalse(a.status()["page"]["own"])
        go("https://www.tiktok.com/@Probe/live/?enter_from=x", within=True)   # the same page, spelled another way
        say(gift_frame(streak=False))
        self.assertEqual(len(gifts), 2)
        go("https://www.tiktok.com/@someoneelse/live")                  # a full load of another live
        say(gift_frame(streak=False))
        self.assertEqual(len(gifts), 2)
        # The page's drawing is held to the same rule.
        b = tt.TikTokAdapter("probe", lines.append)
        b._opened = time.monotonic() - tt.PAGE_WAIT - 1
        b._event("Page.frameNavigated", {"frame": {"id": "m", "url": "https://www.tiktok.com/@someoneelse/live"}})
        before = len(lines)
        b._payload(json.dumps({"t": "chat", "name": "Amy", "text": "hello"}))
        self.assertEqual(len(lines), before)

    def test_the_devtools_port_is_this_pcs_alone(self):
        self.assertFalse(any(f.startswith("--remote-debugging-address") for f in tt.FLAGS))


if __name__ == "__main__":
    unittest.main()
