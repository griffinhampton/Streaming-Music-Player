"""Unit tests for chat ingestion (chat.py).

The translation and nothing else, in the shape test_tiktok.py established: the
IRCv3 line parser, a real Twitch PRIVMSG becoming one internal message, and the
hub's fan-out. No network is touched - the adapter's socket work is exercised
by feeding it lines, which is where the bugs actually live.

    python tests/test_chat.py -v
"""
import os
import queue
import sys
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import chat


class Tags(unittest.TestCase):
    """IRCv3 escapes: ; space \\ CR LF, and a stray one."""

    def test_the_five_escapes(self):
        self.assertEqual(chat.unescape_tag(r"a\sb"), "a b")
        self.assertEqual(chat.unescape_tag(r"a\:b"), "a;b")
        self.assertEqual(chat.unescape_tag(r"a\\b"), "a\\b")
        self.assertEqual(chat.unescape_tag(r"a\rb"), "a\rb")
        self.assertEqual(chat.unescape_tag(r"a\nb"), "a\nb")

    def test_untouched_when_there_is_nothing_to_undo(self):
        self.assertEqual(chat.unescape_tag("plain"), "plain")

    def test_a_trailing_backslash_is_dropped(self):
        self.assertEqual(chat.unescape_tag("oops\\"), "oops")


class Lines(unittest.TestCase):
    def test_tags_prefix_command_and_params(self):
        tags, prefix, cmd, params = chat.parse_line(
            "@id=abc;color=#FF0000 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hello")
        self.assertEqual(tags["id"], "abc")
        self.assertEqual(tags["color"], "#FF0000")
        self.assertEqual(prefix, "bob!bob@bob.tmi.twitch.tv")
        self.assertEqual(cmd, "PRIVMSG")
        self.assertEqual(params, ["#chan", "hello"])

    def test_the_trailing_parameter_keeps_its_colons_and_spaces(self):
        """Where a naive split falls over: a message with a URL in it."""
        _, _, _, params = chat.parse_line(
            ":bob!b@b PRIVMSG #chan :look: https://example.com/a:b c")
        self.assertEqual(params[-1], "look: https://example.com/a:b c")

    def test_a_tag_with_no_value(self):
        tags, _, _, _ = chat.parse_line("@mod;subscriber=0 :x PRIVMSG #c :hi")
        self.assertEqual(tags["mod"], "")
        self.assertEqual(tags["subscriber"], "0")

    def test_no_tags_and_no_prefix(self):
        tags, prefix, cmd, params = chat.parse_line("PING :tmi.twitch.tv")
        self.assertEqual((tags, prefix, cmd), ({}, "", "PING"))
        self.assertEqual(params, ["tmi.twitch.tv"])

    def test_an_empty_line_says_nothing_rather_than_throwing(self):
        self.assertEqual(chat.parse_line(""), ({}, "", "", []))
        self.assertEqual(chat.parse_line(None), ({}, "", "", []))


class TwitchMessages(unittest.TestCase):
    LINE = ("@badge-info=subscriber/13;badges=moderator/1,subscriber/12;color=#1E90FF;"
            "display-name=Bob;id=msg-1;tmi-sent-ts=1690000000000;user-id=99 "
            ":bob!bob@bob.tmi.twitch.tv PRIVMSG #somechannel :hello there")

    def one(self, line):
        tags, prefix, _cmd, params = chat.parse_line(line)
        return chat.twitch_message(tags, prefix, params)

    def test_a_privmsg_becomes_one_message(self):
        m = self.one(self.LINE)
        self.assertEqual(m["service"], "twitch")
        self.assertEqual(m["channel"], "somechannel")
        self.assertEqual(m["text"], "hello there")
        self.assertEqual(m["id"], "msg-1")
        self.assertEqual(m["user"], {"id": "99", "login": "bob", "name": "Bob", "color": "#1E90FF"})
        self.assertEqual(m["badges"], ["moderator/1", "subscriber/12"])
        self.assertFalse(m["action"])

    def test_the_timestamp_comes_from_twitch_in_seconds(self):
        self.assertAlmostEqual(self.one(self.LINE)["at"], 1690000000.0, places=3)

    def test_a_display_name_is_optional(self):
        m = self.one(":bob!b@b PRIVMSG #c :hi")
        self.assertEqual(m["user"]["name"], "bob")

    def test_me_is_unwrapped_and_marked(self):
        m = self.one(":bob!b@b PRIVMSG #c :\x01ACTION waves\x01")
        self.assertEqual(m["text"], "waves")
        self.assertTrue(m["action"])

    def test_text_is_capped(self):
        m = self.one(":bob!b@b PRIVMSG #c :" + "x" * 900)
        self.assertEqual(len(m["text"]), chat.MAX_TEXT)


class Commands(unittest.TestCase):
    """Filled in centrally, so !queue means the same from any service."""

    def test_a_command_and_its_rest(self):
        m = chat.message("twitch", "c", "!queue some song name")
        self.assertEqual(m["command"], "queue")
        self.assertEqual(m["args"], "some song name")

    def test_case_is_flattened(self):
        self.assertEqual(chat.message("twitch", "c", "!QUEUE x")["command"], "queue")

    def test_a_bare_bang_is_not_a_command(self):
        self.assertEqual(chat.message("twitch", "c", "!")["command"], "")
        self.assertEqual(chat.message("twitch", "c", "! spaced")["command"], "")

    def test_ordinary_words_are_not_commands(self):
        self.assertEqual(chat.message("twitch", "c", "hello!")["command"], "")

    def test_a_command_with_nothing_after_it(self):
        m = chat.message("twitch", "c", "!songs")
        self.assertEqual((m["command"], m["args"]), ("songs", ""))


class TheCommandSymbol(unittest.TestCase):
    """What starts a command is a setting now, and this is the one place that
    reads it - polls.py says outright that it has no parser of its own, so a
    vote of "!1" follows the symbol along with everything else.

    These pass `symbols=` instead of calling set_symbols(), on purpose: that
    is module state, and a test which changed it would quietly change what
    every later test in the run parses. The class below exercises the real
    setter and puts it back.
    """

    def test_each_symbol_starts_a_command(self):
        for sym in ("!", "/", "@", "#", "$", "~", "?", "."):
            m = chat.message("twitch", "c", sym + "queue a song", symbols=sym)
            self.assertEqual((m["command"], m["args"]), ("queue", "a song"), "symbol " + sym)

    def test_the_symbol_not_in_force_is_only_text(self):
        """The half that proves the setting is doing the work: with "/" live,
        the old "!" has to stop meaning anything at all."""
        m = chat.message("twitch", "c", "!queue a song", symbols="/")
        self.assertEqual((m["command"], m["args"]), ("", ""))

    def test_several_symbols_can_be_live_at_once(self):
        """A week either side of a switch, both should work."""
        for sym in "!/":
            self.assertEqual(chat.message("twitch", "c", sym + "gif", symbols="!/")["command"], "gif")
        self.assertEqual(chat.message("twitch", "c", "@gif", symbols="!/")["command"], "")

    def test_the_awkward_shapes_answer_as_they_always_did(self):
        """The table is the point. Changing the symbol must not quietly change
        what any of these mean - the doubled one reads as a command named
        "/double", which NAME_RE then refuses, exactly as "!!x" always did."""
        cases = [("/", "", ""), ("/ spaced", "", ""), ("//double", "/double", ""),
                 ("hello/", "", ""), ("/UP here", "up", "here"), ("", "", "")]
        for text, cmd, args in cases:
            m = chat.message("twitch", "c", text, symbols="/")
            self.assertEqual((m["command"], m["args"]), (cmd, args), repr(text))


class TheSymbolSetting(unittest.TestCase):
    def setUp(self):
        self.addCleanup(chat.set_symbols, chat.SYMBOL_DEFAULT)

    def test_a_letter_or_a_digit_is_refused(self):
        """Why this validates at all: with "a" in force, "apple" would run the
        command "pple" and half of ordinary chat would be commands."""
        self.assertEqual(chat.set_symbols("a"), "!")
        self.assertEqual(chat.set_symbols("7"), "!")

    def test_nothing_usable_falls_back_instead_of_disabling_commands(self):
        for value in ("", "   ", None):
            self.assertEqual(chat.set_symbols(value), "!", repr(value))

    def test_what_it_keeps_is_what_it_returns(self):
        self.assertEqual(chat.set_symbols("/"), "/")
        self.assertEqual(chat.symbols(), "/")
        self.assertEqual(chat.set_symbols("!/@"), "!/@")

    def test_letters_and_repeats_are_dropped_from_a_mixed_string(self):
        self.assertEqual(chat.set_symbols("!!/a/"), "!/")

    def test_the_setting_actually_reaches_the_parser(self):
        """The two halves joined up: without this the setter could be perfect
        and parse nothing."""
        chat.set_symbols("@")
        self.assertEqual(chat.message("twitch", "c", "@queue x")["command"], "queue")
        self.assertEqual(chat.message("twitch", "c", "!queue x")["command"], "")


class Hub(unittest.TestCase):
    def test_subscribers_get_every_message(self):
        hub = chat.ChatHub()
        q = hub.subscribe()
        hub.post(chat.message("twitch", "c", "one"))
        self.assertIn('"text": "one"', q.get_nowait())

    def test_a_page_that_cannot_keep_up_drops_rather_than_grows(self):
        hub = chat.ChatHub()
        hub.subscribe()                      # never read from
        for i in range(chat.QUEUE_DEPTH + 25):
            hub.post(chat.message("twitch", "c", "m%d" % i))
        self.assertEqual(hub.dropped, 25)
        self.assertEqual(hub.total, chat.QUEUE_DEPTH + 25)

    def test_unsubscribing_stops_the_flow(self):
        hub = chat.ChatHub()
        q = hub.subscribe()
        hub.unsubscribe(q)
        hub.post(chat.message("twitch", "c", "gone"))
        with self.assertRaises(queue.Empty):
            q.get_nowait()

    def test_recent_backfills_a_page_that_arrives_late(self):
        hub = chat.ChatHub()
        for i in range(5):
            hub.post(chat.message("twitch", "c", "m%d" % i))
        self.assertEqual([m["text"] for m in hub.recent(3)], ["m2", "m3", "m4"])

    def test_recent_is_bounded(self):
        hub = chat.ChatHub()
        for i in range(chat.RECENT + 50):
            hub.post(chat.message("twitch", "c", "m%d" % i))
        self.assertEqual(len(hub.recent(10_000)), chat.RECENT)

    def test_the_snapshot_never_carries_the_messages(self):
        hub = chat.ChatHub()
        hub.post(chat.message("twitch", "c", "secret-ish"))
        self.assertNotIn("secret-ish", repr(hub.snapshot()))

    def test_an_unknown_service_is_refused_by_name(self):
        hub = chat.ChatHub()
        r = hub.connect("myspace", "chan")
        self.assertFalse(r["ok"])
        self.assertIn("myspace", r["error"])

    def test_a_channel_is_required(self):
        self.assertFalse(chat.ChatHub().connect("twitch", "  ")["ok"])


class AdapterLines(unittest.TestCase):
    """The adapter's line handling, without a socket: what it answers, what it
    passes on, and what it refuses to retry."""

    class Sock:
        def __init__(self):
            self.sent = []

        def sendall(self, b):
            self.sent.append(b)

    def make(self):
        got = []
        ad = chat.TwitchAdapter("SomeChannel", got.append)
        return ad, got, self.Sock()

    def test_the_channel_is_normalised(self):
        ad, _, _ = self.make()
        self.assertEqual(ad.channel, "somechannel")

    def test_ping_is_answered_with_its_own_token(self):
        ad, got, sock = self.make()
        ad._line(sock, "PING :tmi.twitch.tv")
        self.assertEqual(sock.sent, [b"PONG :tmi.twitch.tv\r\n"])
        self.assertEqual(got, [])

    def test_a_privmsg_is_passed_on_and_counted(self):
        ad, got, sock = self.make()
        ad._line(sock, ":bob!b@b PRIVMSG #somechannel :hi")
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["text"], "hi")
        self.assertEqual(ad.messages, 1)

    def test_a_failed_login_is_fatal_rather_than_retried(self):
        ad, _, sock = self.make()
        with self.assertRaises(chat._Fatal):
            ad._line(sock, ":tmi.twitch.tv NOTICE * :Login authentication failed")

    def test_an_ordinary_notice_is_only_logged(self):
        said = []
        ad = chat.TwitchAdapter("c", lambda m: None, log=said.append)
        ad._line(self.Sock(), ":tmi.twitch.tv NOTICE #c :Now hosting someone.")
        self.assertTrue(any("Now hosting" in s for s in said))

    def test_status_before_anything_happens(self):
        ad, _, _ = self.make()
        self.assertEqual(ad.status()["state"], "idle")
        self.assertEqual(ad.status()["service"], "twitch")


class NoSecrets(unittest.TestCase):
    """Reading a public channel needs no account, and this module should make
    that impossible to get wrong by not having anywhere to put one."""

    def test_the_anonymous_nick_is_what_it_claims(self):
        self.assertRegex(chat._anon_nick(), r"^justinfan\d+$")

    def test_no_password_or_token_anywhere_in_the_module(self):
        with open(os.path.join(HERE, "chat.py"), encoding="utf-8") as f:
            src = f.read().lower()
        for word in ("oauth:", "password", "client_secret", "access_token"):
            self.assertNotIn(word, src, word + " has no business in here")


if __name__ == "__main__":
    unittest.main(verbosity=2)
