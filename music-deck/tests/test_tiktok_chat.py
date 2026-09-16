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

    def test_a_line_without_a_handle_can_never_be_taken_for_one(self):
        """A line read from the page's drawing has no handle; its login is made
        from the display name and marked, so a stranger calling themselves Bob
        is never @bob - whose coins and gifts are counted by handle."""
        m = tt.to_message("probe", {"name": "Bob", "login": "", "text": "hi"})
        self.assertEqual(m["user"]["login"], "~bob")
        self.assertIsNone(tt.webcast.HANDLE.match(m["user"]["login"]))
        self.assertEqual(tt.to_message("probe", {"name": "Bob", "login": "bob", "text": "hi"})["user"]["login"], "bob")

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
                                 "Emulation.setEmulatedMedia",
                                 # Only ever to the reader's own Chrome, to quit (close_browser)
                                 "Browser.close"})
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
        say(chat_frame(text="hi", frm=user(4, "Su", "su"), flags=(2, 3)))
        self.assertEqual([chat_rank(m) for m in got], ["mod", "everyone"])

    def test_a_follower_by_tiktoks_own_flag(self):
        from test_webcast import chat_frame, user
        a, got, say = self.socket_adapter()
        say(chat_frame(text="hi", frm=user(5, "Fan", "fan"), flags=(4,)))
        say(chat_frame(text="hi", frm=user(6, "Sub", "sub"), flags=(2, 3)))       # neither follows nor gifted
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

    def test_a_page_with_no_live_on_it_is_opened_again_later(self):
        """Opened before the streamer goes live, the page shows the live has
        ended and opens no room socket; whether TikTok's page moves on to the
        live by itself was not seen, so the reader looks again - later each
        time, never under someone typing, never on someone else's page, and
        never once there is a live."""
        import time
        a = tt.TikTokAdapter("probe", lambda m: None)
        a._event("Page.frameNavigated", {"frame": {"id": "main", "url": "https://www.tiktok.com/@probe/live"}})
        now, first = time.monotonic(), tt.TikTokAdapter.reopen_first
        a._loaded_at = now - first + 5
        self.assertFalse(a._reopen_due(now), "not yet")
        a._loaded_at = now - first
        self.assertTrue(a._reopen_due(now), "the first look")
        self.assertFalse(a._reopen_due(now), "the page loaded again, and the wait has doubled")
        a._loaded_at = now - 2 * first
        self.assertTrue(a._reopen_due(now))
        for _ in range(8):
            a._loaded_at = now - tt.REOPEN_MAX
            a._reopen_due(now)
        self.assertEqual(a._wait, tt.REOPEN_MAX, "never longer than REOPEN_MAX")
        self.assertEqual(a.looks, 2 + 8)
        a.page["typing"] = True
        a._loaded_at = now - 10 * tt.REOPEN_MAX
        self.assertFalse(a._reopen_due(now), "never while the streamer is typing in the window")
        a.page["typing"] = False
        a._loaded_at = now - 10
        a.room.opened("9", "wss://webcast-ws.us.tiktok.com/webcast/im/x/")
        # A live still being heard: never. One heard once and quiet ever since
        # is opened again - test_a_live_gone_quiet_is_opened_again says why.
        self.assertFalse(a._reopen_due(now + 5), "a live still being heard: never")
        self.assertEqual(a._wait, first, "and the wait starts over")
        self.assertTrue(a.status()["page"]["live"])
        self.assertFalse(a.status()["page"]["waiting"])
        b = tt.TikTokAdapter("probe", lambda m: None)
        b._event("Page.frameNavigated", {"frame": {"id": "m", "url": "https://www.tiktok.com/@someoneelse/live"}})
        self.assertFalse(b._reopen_due(time.monotonic() + 10 * tt.REOPEN_MAX), "someone else's page: never")

    def test_a_live_gone_quiet_is_opened_again(self):
        """Measured on a real live: the room socket stopped delivering and the
        reader sat there for 28 minutes still saying there was a live, reading
        nothing - gifts arrive on that socket and no other. Silence for
        SILENT is now a reason to open the page again, with the same wait."""
        import time
        a = tt.TikTokAdapter("probe", lambda m: None)
        a._event("Page.frameNavigated", {"frame": {"id": "main", "url": "https://www.tiktok.com/@probe/live"}})
        now, first = time.monotonic(), tt.TikTokAdapter.reopen_first
        a.room.opened("9", "wss://webcast-ws.us.tiktok.com/webcast/im/x/")
        a._loaded_at = now - 600                      # the page loaded ten minutes ago
        a.room.heard = now - 10                       # and its socket spoke ten seconds ago
        self.assertFalse(a._reopen_due(now), "still being heard: never")
        a.room.heard = now - tt.SILENT - 1            # now it has said nothing for that long
        self.assertTrue(a._reopen_due(now), "quiet that long: the page is opened again")
        self.assertTrue(a.status()["page"]["live"], "the page did show a live; it has gone quiet")
        self.assertGreaterEqual(a.status()["page"]["quiet"], tt.SILENT)
        a._loaded_at = now                            # the page it has just opened again
        self.assertFalse(a._reopen_due(now + 5), "and the wait has doubled")
        self.assertTrue(a._reopen_due(now + 2 * first + 1), "still quiet after twice the wait")

    def test_how_long_it_may_be_quiet_is_the_rigs_to_shorten(self):
        import time
        a = tt.TikTokAdapter("probe", lambda m: None)
        a._event("Page.frameNavigated", {"frame": {"id": "main", "url": "https://www.tiktok.com/@probe/live"}})
        now = time.monotonic()
        a.room.opened("9", "wss://webcast-ws.us.tiktok.com/webcast/im/x/")
        a.room.heard = now - 20
        a._loaded_at = now - tt.TikTokAdapter.reopen_first
        self.assertFalse(a._reopen_due(now), "twenty seconds is nothing")
        # Set on the class, as the rig's hook sets it (server.py): a reader
        # already running picks it up, which is what a probe needs.
        was = tt.TikTokAdapter.silent_after
        self.addCleanup(setattr, tt.TikTokAdapter, "silent_after", was)
        tt.TikTokAdapter.silent_after = 5
        self.assertTrue(a._reopen_due(now))

    def test_a_socket_never_heard_says_so(self):
        a = tt.TikTokAdapter("probe", lambda m: None)
        self.assertIsNone(a.status()["page"]["quiet"])

    def test_the_page_script_says_only_whether_a_field_has_focus(self):
        """For the reopening's sake the page reports that the streamer is
        typing - which element has focus, never what is in it."""
        o = tt.OBSERVER
        self.assertIn("const f = document.activeElement;", o)
        for never in (".value", "innerText", "selectionStart"):
            self.assertNotIn(never, o, never)

    def test_the_hubs_snapshot_carries_what_the_reader_works_out(self):
        """The chat panel draws from the hub's snapshot. It once copied only
        the page script's facts, so where chat came from, the streamer's own
        page and whether a live was there never reached the panel. And it
        must not carry a counter that ticks per gift."""
        hub = chat.ChatHub()
        a = tt.TikTokAdapter("probe", lambda m: None)
        hub._adapters["tiktok"] = a
        a._event("Page.frameNavigated", {"frame": {"id": "main", "url": "https://www.tiktok.com/@probe/live"}})
        page = hub.snapshot()["services"][0]["page"]
        for key in ("own", "live", "waiting", "chat_from", "socket", "room", "signed_in"):
            self.assertIn(key, page, key)
        self.assertTrue(page["own"])
        self.assertNotIn("gifts", page, "a counter that ticks per gift would put the state on the wire per gift")

    def test_a_gifter_by_tiktoks_flag_or_by_this_streams_ledger(self):
        """Who has gifted: TikTok's own flag, or a coin in the ledger under the
        chatter's @handle - never their display name, which anybody can copy."""
        from test_webcast import chat_frame, user
        ledger = {"giver": 25}
        old = tt.TikTokAdapter.gifted
        self.addCleanup(setattr, tt.TikTokAdapter, "gifted", old)
        tt.TikTokAdapter.gifted = lambda handle: ledger.get(handle, 0)
        a, got, say = self.socket_adapter()
        say(chat_frame(text="hi", frm=user(1, "Giver", "giver")))                 # the ledger
        say(chat_frame(text="hi", frm=user(2, "Flagged", "flagged"), flags=(1,)))  # TikTok's flag
        say(chat_frame(text="hi", frm=user(3, "Giver", "copycat")))              # the name, not the handle
        say(chat_frame(text="hi", frm=user(4, "Nobody", "nobody")))
        self.assertEqual([chat_rank(m) for m in got], ["follower", "follower", "everyone", "everyone"])
        tt.TikTokAdapter.gifted = lambda handle: 1 / 0                            # a ledger that fails
        say(chat_frame(text="hi", frm=user(1, "Giver", "giver")))
        self.assertEqual(chat_rank(got[-1]), "everyone", "a failing ledger gives nobody a rung")

    def test_no_log_in_button_is_not_proof_of_signed_in(self):
        """On 2026-09-15 one real room in six drew no Log in control at all to
        a signed-out reader, and the page reported signed in. Signed in now
        needs this page to have shown the button and taken it away."""
        o = tt.OBSERVER
        self.assertIn("if (signedOut) sawLogin = true;", o)
        self.assertIn("signedIn: signedOut ? false : sawLogin ? true : null", o)
        self.assertNotIn("room ? true : null", o)

    def test_the_devtools_port_is_this_pcs_alone(self):
        self.assertFalse(any(f.startswith("--remote-debugging-address") for f in tt.FLAGS))


import time  # noqa: E402
from unittest import mock  # noqa: E402


class Hidden(unittest.TestCase):
    """Hidden unless asked (DECISIONS, "The reader, hidden"): the reader starts
    headless, as every check on real lives ran it; shown, it is a window."""

    def own(self, a):
        a._event("Page.frameNavigated", {"frame": {"id": "main", "url": "https://www.tiktok.com/@probe/live"}})

    def profile(self, port, kind, bid="/devtools/browser/old"):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "DevToolsActivePort"), "w") as f:
            f.write(f"{port}\n")
        with open(os.path.join(d, tt.MODE_FILE), "w") as f:
            f.write(f"{kind}\n{bid}\n" if bid else kind)
        return d

    def adapter(self, hidden):
        a = tt.TikTokAdapter("probe", lambda m: None)
        a.headless = hidden
        return a

    def written(self, a):
        with open(os.path.join(a.profile, tt.MODE_FILE), encoding="utf-8") as f:
            return f.read().split()

    def test_status_says_which_kind_is_running(self):
        self.assertFalse(self.adapter(True).status()["page"]["shown"])
        self.assertTrue(self.adapter(False).status()["page"]["shown"])

    def test_each_reader_keeps_the_kind_it_was_started_as(self):
        """The window switch sets the kind for the next reader a moment before
        it starts one; the one being stopped is still what it was."""
        was = tt.TikTokAdapter.headless
        try:
            tt.TikTokAdapter.headless = True
            a = tt.TikTokAdapter("probe", lambda m: None)
            tt.TikTokAdapter.headless = False
            self.assertTrue(a.headless)
            self.assertFalse(a.status()["page"]["shown"])
        finally:
            tt.TikTokAdapter.headless = was

    def test_hidden_it_goes_back_to_the_streamers_page(self):
        """TikTok moves an ended live on to another, and nobody can steer a
        hidden reader back - so it goes back itself, after the wait, twice as
        long each time. A window on screen is still the streamer's to steer."""
        for hidden in (True, False):
            a = tt.TikTokAdapter("probe", lambda m: None)
            a.headless = hidden
            self.own(a)
            a.room.opened("9", "wss://webcast-ws.us.tiktok.com/webcast/im/x/")     # a live
            now, first = time.monotonic(), tt.TikTokAdapter.reopen_first
            a._event("Page.navigatedWithinDocument",
                     {"frameId": "main", "url": "https://www.tiktok.com/@someoneelse/live"})
            self.assertFalse(a._own())
            self.assertFalse(a._reopen_due(now + 1), "just left")
            self.assertEqual(a._reopen_due(now + first + 1), hidden, "after the wait: hidden goes back, shown never")
            if hidden:
                self.assertEqual(a.looks, 1)
                self.assertFalse(a._reopen_due(now + first + 2), "the next look waits twice as long")
                self.assertTrue(a._reopen_due(now + 3 * first + 2))

    def test_hidden_a_focused_field_does_not_hold_it_back(self):
        a = tt.TikTokAdapter("probe", lambda m: None)
        a.headless = True
        self.own(a)
        a.page["typing"] = True
        now = time.monotonic()
        a._loaded_at = now - 10 * tt.REOPEN_MAX
        self.assertTrue(a._reopen_due(now), "nobody types in a hidden window, and headless pages report focus")

    def test_only_the_chrome_it_started_is_known(self):
        """Each Chrome that starts gets a new browser id; the reader writes its
        own down, so a Chrome that later answers on the same port - someone
        else's - is never closed and never used."""
        self.assertIsNone(tt.reader_on(tempfile.mkdtemp()), "nothing started")
        d = self.profile(51000, "hidden")
        with mock.patch.object(tt, "_browser_id", lambda p: "/devtools/browser/old" if p == 51000 else ""):
            self.assertEqual(tt.reader_on(d), (51000, "hidden", "/devtools/browser/old"))
            self.assertEqual(tt.reader_on(self.profile(51000, "shown"))[1], "shown")
            self.assertEqual(tt.reader_on(self.profile(51000, "junk"))[1], "shown")
            self.assertIsNone(tt.reader_on(self.profile(51000, "hidden", bid="")), "no id written down: not known")
        with mock.patch.object(tt, "_browser_id", lambda p: "/devtools/browser/someone-elses"):
            self.assertIsNone(tt.reader_on(d), "another Chrome on that port")
        with mock.patch.object(tt, "_browser_id", lambda p: ""):
            self.assertIsNone(tt.reader_on(d), "nothing on that port")

    def test_a_hidden_reader_left_running_is_closed_and_a_window_is_not(self):
        asked = []
        with mock.patch.object(tt, "_browser_id", lambda p: "/devtools/browser/old"), \
                mock.patch.object(tt, "close_browser", lambda p, b: asked.append((p, b)) or True):
            self.assertFalse(tt.close_hidden(self.profile(51000, "shown")))
            self.assertEqual(asked, [], "a window on screen is the streamer's")
            self.assertTrue(tt.close_hidden(self.profile(51001, "hidden")))
            self.assertEqual(asked, [(51001, "/devtools/browser/old")])
        self.assertFalse(tt.close_hidden(tempfile.mkdtemp()), "nothing running, nothing to close")

    def launch(self, a, running, theirs=False):
        """_open, with Chrome faked: a Chrome of kind `running` on port 51002 -
        the reader's own, or with `theirs` someone else's that took the port -
        and a new one on 51003. What it asked to quit, what it started, and
        what it returned."""
        a.profile = self.profile(51002, running)
        closed, started = [], []

        class Proc:
            def poll(self):
                return None

        def alive(p):
            return p == 51003 or (p == 51002 and not closed)

        def browser_id(p):
            if p == 51003:
                return "/devtools/browser/new"
            if not alive(p):
                return ""
            return "/devtools/browser/someone-elses" if theirs else "/devtools/browser/old"

        def popen(args, **_k):
            started.append(args)
            return Proc()
        page = '{"webSocketDebuggerUrl": "ws://127.0.0.1:51002/devtools/page/t", "id": "t"}'
        with mock.patch.object(tt, "_alive", alive), mock.patch.object(tt, "_browser_id", browser_id), \
                mock.patch.object(tt, "close_browser", lambda p, b: closed.append((p, b)) or True), \
                mock.patch.object(tt, "free_port", lambda: 51003), \
                mock.patch.object(tt, "_http", lambda p, path, method="GET": page), \
                mock.patch.object(tt.subprocess, "Popen", popen), \
                mock.patch.object(tt.TikTokAdapter, "_page", lambda self, p: (f"ws://127.0.0.1:{p}/devtools/page/n", "n")):
            got = a._open()
        return got, closed, started

    def test_opening_never_reuses_a_hidden_chrome(self):
        a = self.adapter(True)
        got, closed, started = self.launch(a, "hidden")
        self.assertEqual(closed, [(51002, "/devtools/browser/old")], "the hidden one running is asked to quit")
        self.assertEqual(len(started), 1)
        self.assertIn("--headless=new", started[0])
        self.assertEqual(got[0], 51003)
        self.assertEqual(self.written(a), ["hidden", "/devtools/browser/new"], "the new one's kind and id")
        self.assertEqual(a._bid, "/devtools/browser/new")

    def test_a_window_is_reused_when_a_window_is_wanted(self):
        a = self.adapter(False)
        got, closed, started = self.launch(a, "shown")
        self.assertEqual((closed, started), ([], []), "a tab in the window already open")
        self.assertEqual(got[0], 51002)

    def test_the_other_kind_is_closed_and_the_kind_asked_for_started(self):
        for want_hidden, running in ((False, "hidden"), (True, "shown")):
            a = self.adapter(want_hidden)
            got, closed, started = self.launch(a, running)
            self.assertEqual(closed, [(51002, "/devtools/browser/old")])
            self.assertEqual("--headless=new" in started[0], want_hidden)
            self.assertEqual(self.written(a)[0], "hidden" if want_hidden else "shown")

    def test_someone_elses_chrome_is_never_closed_or_used(self):
        """A Chrome on the port the reader once wrote down that is not the one
        it started: left alone, and a new one started on a port of its own."""
        for hidden in (True, False):
            a = self.adapter(hidden)
            got, closed, started = self.launch(a, "hidden" if hidden else "shown", theirs=True)
            self.assertEqual(closed, [], "never asked to quit")
            self.assertEqual(len(started), 1, "never given a tab")
            self.assertEqual(got[0], 51003)

    def test_stopping_asks_chrome_to_quit_before_ending_it(self):
        """Chrome saves cookies now and then; ended outright moments after a
        sign-in, it could lose the sign-in."""
        for quits in (True, False):
            ended, asked = [], []

            class Proc:
                def poll(self):
                    return None

                def wait(self, t=None):
                    if not quits and not ended:
                        raise tt.subprocess.TimeoutExpired("chrome", t)

                def terminate(self):
                    ended.append("terminate")

                def kill(self):
                    ended.append("kill")

            a = tt.TikTokAdapter("probe", lambda m: None)
            a._proc, a._port, a._bid = Proc(), 51004, "/devtools/browser/b"
            with mock.patch.object(tt, "close_browser", lambda p, b: asked.append((p, b)) or True):
                a._close()
            self.assertEqual(asked, [(51004, "/devtools/browser/b")])
            self.assertEqual(ended, [] if quits else ["terminate"])

    def test_one_that_never_came_up_is_ended_at_once(self):
        """Stopped before its Chrome answered - no id, nothing to ask, nothing
        a sign-in could have saved in it: ended in half a second, not five."""
        waits, ended = [], []

        class Proc:
            def poll(self):
                return None

            def wait(self, t=None):
                waits.append(t)
                if not ended:
                    raise tt.subprocess.TimeoutExpired("chrome", t)

            def terminate(self):
                ended.append("terminate")

        a = tt.TikTokAdapter("probe", lambda m: None)
        a._proc, a._port, a._bid = Proc(), 51005, ""
        with mock.patch.object(tt, "_browser_id", lambda p: ""):
            a._close()
        self.assertEqual((waits, ended), ([0.5, 5], ["terminate"]))

    def test_nothing_is_started_once_stopping(self):
        """Found on the rig: stopped while the last reader's Chrome was still
        closing, it went on to start a new one - which then outlived the stop."""
        a = self.adapter(True)
        a.profile = tempfile.mkdtemp()
        a._stop.set()
        started = []
        with mock.patch.object(tt.subprocess, "Popen", lambda args, **_k: started.append(args)):
            with self.assertRaises(OSError):
                a._open()
        self.assertEqual(started, [])


class TheLive(unittest.TestCase):
    """Which live it is, passed on for the coin ledger (gifts.py begin)."""

    WS = "wss://webcast-ws.us.tiktok.com/webcast/im/ws_proxy/?aid=1988&room_id={}&x=1"

    def told(self, fn):
        was = tt.TikTokAdapter.on_room
        tt.TikTokAdapter.on_room = fn
        self.addCleanup(setattr, tt.TikTokAdapter, "on_room", was)

    def test_the_live_is_passed_on_once_and_only_from_the_streamers_page(self):
        told = []
        self.told(told.append)
        a = tt.TikTokAdapter("probe", lambda m: None)
        a._event("Page.frameNavigated", {"frame": {"id": "main", "url": "https://www.tiktok.com/@someoneelse/live"}})
        a._event("Network.webSocketCreated", {"requestId": "1", "url": self.WS.format("7000000000000000009")})
        self.assertEqual(told, [], "a stranger's live starts no new count")
        a._event("Page.frameNavigated", {"frame": {"id": "main", "url": "https://www.tiktok.com/@probe/live"}})
        a._event("Network.webSocketCreated", {"requestId": "2", "url": self.WS.format("7000000000000000001")})
        a._event("Network.webSocketCreated", {"requestId": "3", "url": self.WS.format("7000000000000000001")})
        self.assertEqual(told, ["7000000000000000001"], "once per live")
        a._event("Network.webSocketCreated", {"requestId": "4", "url": self.WS.format("7000000000000000002")})
        self.assertEqual(told[-1], "7000000000000000002")

    def test_a_follow_is_passed_on_with_its_name_as_text(self):
        """A follower's name is a name they chose, so it reaches the stream as
        characters and nothing else (chat.inert) - and only from the
        streamer's own page."""
        told = []
        was = tt.TikTokAdapter.on_follow
        tt.TikTokAdapter.on_follow = told.append
        self.addCleanup(setattr, tt.TikTokAdapter, "on_follow", was)
        a = tt.TikTokAdapter("probe", lambda m: None)
        follow = {"kind": "follow", "user": "A" + chr(0x202E) + "m", "handle": "amy", "avatar_url": ""}
        a._event("Page.frameNavigated", {"frame": {"id": "m", "url": "https://www.tiktok.com/@someoneelse/live"}})
        a._room_events([dict(follow)])
        self.assertEqual(told, [], "a stranger's live is not this stream's")
        a._event("Page.frameNavigated", {"frame": {"id": "m", "url": "https://www.tiktok.com/@probe/live"}})
        a._room_events([dict(follow)])
        self.assertEqual(len(told), 1)
        self.assertNotIn(chr(0x202E), told[0]["user"])
        self.assertEqual(told[0]["handle"], "amy")

    def test_a_failing_ledger_never_stops_the_reader(self):
        def fail(_rid):
            raise RuntimeError("no")
        self.told(fail)
        logged = []
        a = tt.TikTokAdapter("probe", lambda m: None, logged.append)
        a._event("Page.frameNavigated", {"frame": {"id": "main", "url": "https://www.tiktok.com/@probe/live"}})
        a._event("Network.webSocketCreated", {"requestId": "2", "url": self.WS.format("7000000000000000001")})
        self.assertTrue(a.room.sockets and logged)


if __name__ == "__main__":
    unittest.main()
