"""The command engine (S12): the registry, who may run what, the two clocks,
and the log.

All of it is arithmetic over one message shape, so all of it is tested here
with no network and no rig. The clock is injected rather than slept through -
a cooldown test that sleeps is a slow test that still only proves one point.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import chat  # noqa: E402
import commands  # noqa: E402


def msg(text, badges=(), login="viewer", channel="somechannel"):
    """A real message, built by chat.py rather than hand-written here: the
    engine must work on what the parser actually produces, including its
    central `!command` split."""
    return chat.message("twitch", channel, text,
                        user={"id": "1", "login": login, "name": login.title()},
                        badges=list(badges))


class Ladder(unittest.TestCase):
    def test_badges_map_onto_the_ladder(self):
        self.assertEqual(commands.rank_of([]), commands.RANK["everyone"])
        self.assertEqual(commands.rank_of(["subscriber/12"]), commands.RANK["subscriber"])
        self.assertEqual(commands.rank_of(["vip/1"]), commands.RANK["vip"])
        self.assertEqual(commands.rank_of(["moderator/1"]), commands.RANK["mod"])
        self.assertEqual(commands.rank_of(["broadcaster/1"]), commands.RANK["broadcaster"])

    def test_a_follower_sits_between_everyone_and_a_subscriber(self):
        """TikTok's reader says who follows (webcast.chat); Twitch never does,
        so on Twitch a followers-only gate lets in subscribers and up."""
        self.assertEqual(commands.rank_of(["follower/1"]), commands.RANK["follower"])
        self.assertLess(commands.RANK["everyone"], commands.RANK["follower"])
        self.assertLess(commands.RANK["follower"], commands.RANK["subscriber"])

    def test_a_gifter_stands_on_the_followers_rung(self):
        """As asked: commands for the people who follow you or have gifted you."""
        self.assertEqual(commands.rank_of(["gifter/1"]), commands.RANK["follower"])
        self.assertEqual(commands.rank_of(["gifter/1", "moderator/1"]), commands.RANK["mod"])

    def test_a_founder_is_not_left_below_a_subscriber(self):
        self.assertEqual(commands.rank_of(["founder/0"]), commands.RANK["subscriber"])

    def test_the_highest_badge_wins(self):
        self.assertEqual(commands.rank_of(["subscriber/1", "moderator/1"]), commands.RANK["mod"])

    def test_an_unknown_badge_is_ignored_not_promoted(self):
        self.assertEqual(commands.rank_of(["turbo/1", "glhf-pledge/1"]), commands.RANK["everyone"])


class Cleaning(unittest.TestCase):
    def test_a_name_is_normalised_and_the_bang_dropped(self):
        self.assertEqual(commands.clean({"name": "!Hello"})["name"], "hello")

    def test_whatever_symbol_was_typed_in_front_of_a_name_is_dropped(self):
        """A stored name has never carried the symbol, which is what lets the
        symbol change without orphaning a single saved command. clean() strips
        the whole class rather than "!" alone, because NAME_RE wants a letter,
        digit or underscore first - so anything before that is somebody typing
        the symbol into the box out of habit, whichever one they use."""
        for typed in ("!gif", "/gif", "@gif", "#gif", "~gif", "!!gif", "/@gif", "gif"):
            self.assertEqual(commands.clean({"name": typed})["name"], "gif", typed)

    def test_a_name_that_is_nothing_but_symbols_is_still_refused(self):
        """The control for the stripping above: strip everything and what is
        left must be refused, not kept as a command with an empty name."""
        for bad in ("!", "//", "@@@", "!/@"):
            self.assertIsNone(commands.clean({"name": bad}), bad)

    def test_unusable_entries_are_dropped_rather_than_half_kept(self):
        for bad in ({"name": ""}, {"name": "with space"}, {"name": "x" * 40},
                    {"name": "ok", "action": "rm -rf"}, "not a dict", None):
            self.assertIsNone(commands.clean(bad), repr(bad))

    def test_an_unknown_role_falls_back_to_everyone_rather_than_locking_it(self):
        self.assertEqual(commands.clean({"name": "a", "role": "wizard"})["role"], "everyone")

    def test_cooldowns_are_clamped_and_survive_nonsense(self):
        self.assertEqual(commands.clean({"name": "a", "cooldown": -5})["cooldown"], 0)
        self.assertEqual(commands.clean({"name": "a", "cooldown": 99999})["cooldown"], 3600)
        self.assertEqual(commands.clean({"name": "a", "cooldown": "soon"})["cooldown"], 0)


class Running(unittest.TestCase):
    def setUp(self):
        self.now = [1000.0]
        self.eng = commands.Engine(clock=lambda: self.now[0])
        self.eng.load([
            {"name": "hello", "action": "say", "response": "hi {user}"},
            {"name": "modonly", "action": "say", "role": "mod", "response": "ok"},
            {"name": "slow", "action": "say", "response": "x", "cooldown": 30},
            {"name": "mine", "action": "say", "response": "x", "user_cooldown": 30},
            {"name": "off", "action": "say", "response": "x", "enabled": False},
        ])

    def test_a_command_runs_and_is_logged(self):
        entry = self.eng.handle(msg("!hello"))
        self.assertEqual(entry["outcome"], "ran")
        self.assertEqual(entry["response"], "hi Viewer")
        self.assertEqual(len(self.eng.recent()), 1)

    def test_an_unknown_word_does_nothing_and_is_not_logged(self):
        # Every stream has people typing ! at things that do not exist. A log
        # full of "no such command" is a log nobody reads.
        self.assertIsNone(self.eng.handle(msg("!nosuchthing")))
        self.assertIsNone(self.eng.handle(msg("just talking")))
        self.assertEqual(self.eng.recent(), [])

    def test_a_disabled_command_is_as_if_it_were_not_there(self):
        self.assertIsNone(self.eng.handle(msg("!off")))
        self.assertEqual(self.eng.recent(), [])

    def test_a_gate_refuses_and_says_so_rather_than_dropping_it(self):
        entry = self.eng.handle(msg("!modonly"))
        self.assertEqual(entry["outcome"], "denied")
        self.assertIn("mod", entry["response"])
        self.assertEqual(self.eng.status()["refused"], 1)

    def test_the_broadcaster_passes_a_mod_gate(self):
        # Roles are a ladder, not a set of equals: the obvious reading, and the
        # one that is easy to get wrong by comparing badge strings.
        entry = self.eng.handle(msg("!modonly", badges=["broadcaster/1"], login="me"))
        self.assertEqual(entry["outcome"], "ran")

    def test_a_mod_passes_a_subscriber_gate(self):
        self.eng.load([{"name": "subs", "action": "say", "role": "subscriber", "response": "x"}])
        self.assertEqual(self.eng.handle(msg("!subs", badges=["moderator/1"]))["outcome"], "ran")

    def test_a_price_in_coins_gifted_this_stream(self):
        """A command can ask for coins gifted this stream (gifts.py). Below it
        is a refusal that says what was asked and what they have; the streamer
        and their mods never pay; 0 is no price; a ledger that fails is a price
        nobody has paid."""
        ledger = {"rich": 1000, "poor": 5}
        eng = commands.Engine(coins=lambda m: ledger.get((m.get("user") or {}).get("login"), 0), clock=lambda: 0)
        eng.load([{"name": "big", "action": "say", "response": "x", "coins": 100},
                  {"name": "free", "action": "say", "response": "x", "coins": 0}])
        self.assertEqual(eng.handle(msg("!big", login="rich"))["outcome"], "ran")
        poor = eng.handle(msg("!big", login="poor"))
        self.assertEqual(poor["outcome"], "denied")
        self.assertIn("needs 100 coins", poor["response"])
        self.assertIn("you have 5", poor["response"])
        self.assertEqual(eng.handle(msg("!big", login="nobody"))["outcome"], "denied")
        self.assertEqual(eng.handle(msg("!big", badges=["moderator/1"], login="mod"))["outcome"], "ran")
        self.assertEqual(eng.handle(msg("!big", badges=["broadcaster/1"], login="me"))["outcome"], "ran")
        self.assertEqual(eng.handle(msg("!free", login="nobody"))["outcome"], "ran")
        broken = commands.Engine(coins=lambda m: 1 / 0, clock=lambda: 0)
        broken.load([{"name": "big", "action": "say", "response": "x", "coins": 100}])
        self.assertEqual(broken.handle(msg("!big", login="rich"))["outcome"], "denied")

    def test_a_price_is_cleaned_like_everything_else(self):
        for given, kept in ((100, 100), ("250", 250), (-5, 0), ("lots", 0), (None, 0), (10 ** 9, commands.MAX_COINS)):
            self.assertEqual(commands.clean({"name": "x", "coins": given})["coins"], kept, given)
        layer = {"id": "L1", "type": "speak", "props": {"command": "tts", "coins": 50}}
        self.assertEqual(commands.layer_command(layer)["coins"], 50, "a layer's command can carry a price too")

    def test_the_floor_is_under_every_command(self):
        """"Commands are for": set to followers and gifters, a plain viewer runs
        nothing, a follower or a gifter runs what their rung allows, and a
        command asking more than the floor still asks it."""
        self.eng.load([{"name": "hi", "action": "say", "response": "x"},
                       {"name": "subs", "action": "say", "role": "subscriber", "response": "x"}])
        self.assertEqual(self.eng.set_floor("follower"), "follower")
        entry = self.eng.handle(msg("!hi", login="amy"))
        self.assertEqual(entry["outcome"], "denied")
        self.assertIn("followers and gifters", entry["response"])
        self.assertEqual(self.eng.handle(msg("!hi", badges=["follower/1"], login="bob"))["outcome"], "ran")
        self.assertEqual(self.eng.handle(msg("!hi", badges=["gifter/1"], login="cy"))["outcome"], "ran")
        self.assertEqual(self.eng.handle(msg("!subs", badges=["gifter/1"], login="dee"))["outcome"], "denied")
        self.assertEqual(self.eng.handle(msg("!subs", badges=["subscriber/1"], login="eve"))["outcome"], "ran")
        self.assertEqual(self.eng.set_floor("nonsense"), "everyone", "an unknown rung is no floor, not a lock")
        self.assertEqual(self.eng.handle(msg("!hi", login="fay"))["outcome"], "ran")

    def test_a_followers_gate(self):
        """The rung TikTok's follower flag reaches - and everything above it."""
        self.eng.load([{"name": "fans", "action": "say", "role": "follower", "response": "x"}])
        self.assertEqual(self.eng.handle(msg("!fans", login="amy"))["outcome"], "denied")
        self.assertEqual(self.eng.handle(msg("!fans", badges=["follower/1"], login="bob"))["outcome"], "ran")
        self.assertEqual(self.eng.handle(msg("!fans", badges=["subscriber/1"], login="cy"))["outcome"], "ran")

    def test_the_command_cooldown_holds_for_everyone(self):
        self.assertEqual(self.eng.handle(msg("!slow", login="amy"))["outcome"], "ran")
        self.now[0] += 5
        self.assertEqual(self.eng.handle(msg("!slow", login="bob"))["outcome"], "cooling")
        self.now[0] += 30
        self.assertEqual(self.eng.handle(msg("!slow", login="bob"))["outcome"], "ran")

    def test_the_user_cooldown_is_a_separate_clock(self):
        # The point of two clocks: one person holding a command must not make
        # everybody else wait out their turn.
        self.assertEqual(self.eng.handle(msg("!mine", login="amy"))["outcome"], "ran")
        self.now[0] += 5
        self.assertEqual(self.eng.handle(msg("!mine", login="amy"))["outcome"], "cooling")
        self.assertEqual(self.eng.handle(msg("!mine", login="bob"))["outcome"], "ran")

    def test_a_refusal_does_not_start_the_clock(self):
        # Being refused must not count as having run it, or a denied viewer
        # would also be put on cooldown for something they never got.
        self.eng.handle(msg("!modonly"))
        self.assertEqual(self.eng.handle(msg("!modonly", badges=["moderator/1"]))["outcome"], "ran")

    def test_the_placeholders_are_filled_and_nothing_else_is(self):
        self.eng.load([{"name": "p", "action": "say", "response": "{user}/{args}/{channel}/{nope}"}])
        entry = self.eng.handle(msg("!p some args here", login="amy"))
        self.assertEqual(entry["response"], "Amy/some args here/somechannel/{nope}")

    def test_the_log_is_a_bounded_ring(self):
        for _ in range(commands.LOG_KEEP + 25):
            self.eng.handle(msg("!hello"))
        self.assertEqual(len(self.eng.recent(commands.LOG_KEEP)), commands.LOG_KEEP)
        self.assertEqual(self.eng.status()["ran"], commands.LOG_KEEP + 25)


class SceneAction(unittest.TestCase):
    def test_it_calls_out_through_the_injected_switcher(self):
        seen = []
        eng = commands.Engine(run_scene=lambda t: (seen.append(t) or (True, f"on air: {t}")))
        eng.load([{"name": "gaming", "action": "scene", "target": "Gaming"}])
        entry = eng.handle(msg("!gaming", badges=["broadcaster/1"]))
        self.assertEqual(seen, ["Gaming"])
        self.assertEqual(entry["outcome"], "ran")

    def test_with_no_target_it_uses_what_was_typed(self):
        seen = []
        eng = commands.Engine(run_scene=lambda t: (seen.append(t) or (True, "")))
        eng.load([{"name": "scene", "action": "scene"}])
        eng.handle(msg("!scene Just chatting"))
        self.assertEqual(seen, ["Just chatting"])

    def test_a_switcher_that_throws_is_recorded_not_raised(self):
        # This runs on the chat reading loop. An exception here would take the
        # connection down with it.
        def boom(_):
            raise RuntimeError("no such scene")
        eng = commands.Engine(run_scene=boom)
        eng.load([{"name": "x", "action": "scene", "target": "nope"}])
        entry = eng.handle(msg("!x"))
        self.assertEqual(entry["outcome"], "failed")
        self.assertIn("no such scene", entry["response"])

    def test_with_no_switcher_wired_it_says_so(self):
        eng = commands.Engine()
        eng.load([{"name": "x", "action": "scene", "target": "a"}])
        self.assertEqual(eng.handle(msg("!x"))["outcome"], "failed")


class QueueAction(unittest.TestCase):
    """S13's action, and only the seam: the engine decides who may ask and how
    often, songreq.py decides about the song itself."""

    def test_the_whole_message_goes_to_the_request_store(self):
        seen = []
        eng = commands.Engine(run_request=lambda m: (seen.append(m) or (True, "queued Sabotage")))
        eng.load([{"name": "queue", "action": "queue"}])
        entry = eng.handle(msg("!queue sabotage", login="amy"))
        self.assertEqual(entry["outcome"], "ran")
        self.assertEqual(entry["response"], "queued Sabotage")
        # The message, not just the text: songreq has to know who asked.
        self.assertEqual(seen[0]["args"], "sabotage")
        self.assertEqual(seen[0]["user"]["login"], "amy")

    def test_a_refused_song_is_a_failed_command_carrying_the_reason(self):
        eng = commands.Engine(run_request=lambda m: (False, "that one is on the block list"))
        eng.load([{"name": "queue", "action": "queue"}])
        entry = eng.handle(msg("!queue something"))
        self.assertEqual(entry["outcome"], "failed")
        self.assertEqual(entry["response"], "that one is on the block list")

    def test_the_role_gate_runs_before_the_song_is_looked_up(self):
        # Otherwise somebody who may not request still costs a Spotify call,
        # and enough of those is how an app gets itself rate limited.
        seen = []
        eng = commands.Engine(run_request=lambda m: (seen.append(m) or (True, "")))
        eng.load([{"name": "queue", "action": "queue", "role": "subscriber"}])
        self.assertEqual(eng.handle(msg("!queue x"))["outcome"], "denied")
        self.assertEqual(seen, [])

    def test_the_cooldown_runs_before_it_as_well(self):
        seen, now = [], [100.0]
        eng = commands.Engine(run_request=lambda m: (seen.append(m) or (True, "")), clock=lambda: now[0])
        eng.load([{"name": "queue", "action": "queue", "cooldown": 30}])
        eng.handle(msg("!queue one", login="amy"))
        eng.handle(msg("!queue two", login="bob"))
        self.assertEqual(len(seen), 1)

    def test_with_no_store_wired_it_says_so(self):
        eng = commands.Engine()
        eng.load([{"name": "queue", "action": "queue"}])
        self.assertEqual(eng.handle(msg("!queue x"))["outcome"], "failed")

    def test_a_store_that_throws_is_recorded_not_raised(self):
        def boom(_):
            raise RuntimeError("spotify exploded")
        eng = commands.Engine(run_request=boom)
        eng.load([{"name": "queue", "action": "queue"}])
        entry = eng.handle(msg("!queue x"))
        self.assertEqual(entry["outcome"], "failed")
        self.assertIn("spotify exploded", entry["response"])


class PollAction(unittest.TestCase):
    """S14's action: the streamer's way to open or close a poll. Voting is a
    different path entirely - polls.py watches the hub for `!1` itself, because
    a vote wants neither a role gate nor a cooldown."""

    def test_the_target_and_the_message_both_reach_the_runner(self):
        seen = []
        eng = commands.Engine(run_poll=lambda t, m: (seen.append((t, m)) or (True, "poll open")))
        eng.load([{"name": "poll", "action": "poll", "target": "Which? | a | b"}])
        entry = eng.handle(msg("!poll", badges=["broadcaster/1"]))
        self.assertEqual(entry["outcome"], "ran")
        self.assertEqual(seen[0][0], "Which? | a | b")
        self.assertEqual(seen[0][1]["command"], "poll")

    def test_with_no_target_what_was_typed_is_used(self):
        seen = []
        eng = commands.Engine(run_poll=lambda t, m: (seen.append(t) or (True, "")))
        eng.load([{"name": "poll", "action": "poll"}])
        eng.handle(msg("!poll Which one? | Sabotage | Intergalactic"))
        self.assertEqual(seen, ["Which one? | Sabotage | Intergalactic"])

    def test_a_refusal_is_a_failed_command_carrying_the_reason(self):
        eng = commands.Engine(run_poll=lambda t, m: (False, "a poll needs at least two things"))
        eng.load([{"name": "poll", "action": "poll"}])
        entry = eng.handle(msg("!poll nonsense"))
        self.assertEqual(entry["outcome"], "failed")
        self.assertIn("two things", entry["response"])

    def test_the_role_gate_still_applies(self):
        # Opening a poll is the streamer's, not everybody's - the gate is the
        # whole reason this goes through the engine rather than beside it.
        seen = []
        eng = commands.Engine(run_poll=lambda t, m: (seen.append(t) or (True, "")))
        eng.load([{"name": "poll", "action": "poll", "role": "mod"}])
        self.assertEqual(eng.handle(msg("!poll x | a | b"))["outcome"], "denied")
        self.assertEqual(seen, [])

    def test_with_nothing_wired_it_says_so(self):
        eng = commands.Engine()
        eng.load([{"name": "poll", "action": "poll"}])
        self.assertEqual(eng.handle(msg("!poll x"))["outcome"], "failed")

    def test_a_runner_that_throws_is_recorded_not_raised(self):
        def boom(_t, _m):
            raise RuntimeError("poll engine gone")
        eng = commands.Engine(run_poll=boom)
        eng.load([{"name": "poll", "action": "poll"}])
        entry = eng.handle(msg("!poll x"))
        self.assertEqual(entry["outcome"], "failed")
        self.assertIn("poll engine gone", entry["response"])


class Watching(unittest.TestCase):
    """The seam: chat.py parses `!command` centrally, and the engine consumes
    that parse rather than doing its own."""

    def test_a_hub_message_reaches_the_engine_through_watch(self):
        eng = commands.Engine()
        eng.load([{"name": "hello", "action": "say", "response": "hi"}])
        hub = chat.ChatHub()
        hub.watch(eng.handle)
        hub.post(msg("!hello"))
        self.assertEqual([e["command"] for e in eng.recent()], ["hello"])

    def test_a_watcher_that_throws_does_not_stop_the_fan_out(self):
        hub = chat.ChatHub()
        seen = []
        hub.watch(lambda m: (_ for _ in ()).throw(RuntimeError("bad watcher")))
        hub.watch(seen.append)
        q = hub.subscribe()
        hub.post(msg("!hello"))
        self.assertEqual(len(seen), 1)          # the second watcher still ran
        self.assertFalse(q.empty())             # and the page still got it

    def test_the_module_holds_no_credential(self):
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "commands.py"), encoding="utf-8") as f:
            src = f.read()
        for word in ("oauth:", "password", "client_secret", "access_token"):
            self.assertNotIn(word, src.lower(), word)


class TheGifAction(unittest.TestCase):
    """T2: a command that puts a picture on the canvas.

    What is *not* tested here, because it cannot be honestly: that
    `server.py`'s `command_gif` answers with no text. Injecting a double that
    returns "" and then asserting it returned "" would test the double. The
    real claim - one command produces one alert, of kind "gif", rather than a
    picture and a card beside it - is about the server, and is checked on the
    rig where both halves exist.
    """

    def test_it_is_an_action_a_saved_command_may_use(self):
        cmd = commands.clean({"name": "pic", "action": "gif", "target": "abc123.gif"})
        self.assertEqual((cmd["action"], cmd["target"]), ("gif", "abc123.gif"))

    def test_unwired_it_refuses_rather_than_throwing(self):
        """Every outward action says so when nothing is wired to it: the chat
        reading loop has to survive a command whose handler is missing."""
        eng = commands.Engine(clock=lambda: 1000.0)
        eng.load([{"name": "pic", "action": "gif", "target": "abc123.gif"}])
        entry = eng.handle(msg("!pic"))
        self.assertEqual(entry["outcome"], "failed")
        self.assertIn("not set up", entry["response"])

    def test_it_is_handed_the_picture_and_the_message(self):
        """The picture belongs to the command, which is what lets one effect
        layer serve every gif command instead of needing one layer each."""
        seen = []

        def run_gif(asset, message):
            seen.append((asset, message.get("command"), (message.get("user") or {}).get("name")))
            return True, ""

        eng = commands.Engine(run_gif=run_gif, clock=lambda: 1000.0)
        eng.load([{"name": "pic", "action": "gif", "target": "abc123.gif"}])
        entry = eng.handle(msg("!pic"))
        self.assertEqual(entry["outcome"], "ran")
        self.assertEqual(seen, [("abc123.gif", "pic", "Viewer")])

    def test_sound_is_its_own_action_beside_gif(self):
        """"Show this" and "play this" are different things to a viewer, so
        they are different actions rather than two fields on one - a streamer
        setting up either should not have to think about the other."""
        cmd = commands.clean({"name": "airhorn", "action": "sound", "target": "abc123.mp3"})
        self.assertEqual((cmd["action"], cmd["target"]), ("sound", "abc123.mp3"))

    def test_sound_unwired_refuses_rather_than_throwing(self):
        eng = commands.Engine(clock=lambda: 1000.0)
        eng.load([{"name": "airhorn", "action": "sound", "target": "abc123.mp3"}])
        entry = eng.handle(msg("!airhorn"))
        self.assertEqual(entry["outcome"], "failed")
        self.assertIn("not set up", entry["response"])

    def test_sound_is_handed_the_clip_and_the_message(self):
        seen = []

        def run_sound(asset, message):
            seen.append((asset, message.get("command")))
            return True, ""

        eng = commands.Engine(run_sound=run_sound, clock=lambda: 1000.0)
        eng.load([{"name": "airhorn", "action": "sound", "target": "abc123.mp3"}])
        self.assertEqual(eng.handle(msg("!airhorn"))["outcome"], "ran")
        self.assertEqual(seen, [("abc123.mp3", "airhorn")])

    def test_the_two_asset_actions_do_not_answer_for_each_other(self):
        """The control. Both take an asset id in `target`, so a branch written
        into the wrong one would look right in every other test here."""
        gifs, sounds = [], []
        eng = commands.Engine(run_gif=lambda a, m: (gifs.append(a), (True, ""))[1],
                              run_sound=lambda a, m: (sounds.append(a), (True, ""))[1],
                              clock=lambda: 1000.0)
        eng.load([{"name": "pic", "action": "gif", "target": "a.gif"},
                  {"name": "snd", "action": "sound", "target": "b.mp3"}])
        eng.handle(msg("!pic"))
        eng.handle(msg("!snd"))
        self.assertEqual((gifs, sounds), (["a.gif"], ["b.mp3"]))

    def test_a_gif_command_obeys_the_same_gates_as_any_other(self):
        """The roles and the clocks are the engine's, not the action's, and
        for a picture the cooldown is the half that matters: without one, a
        single viewer can make a stream unwatchable. So both are pinned here,
        not just the role.

        The outcome words are the engine's own - "denied" for a role, "cooling"
        for either clock - and were read out of it after "refused" turned out
        to be the name of the counter rather than the outcome.
        """
        now = [1000.0]
        eng = commands.Engine(run_gif=lambda a, m: (True, ""), clock=lambda: now[0])
        eng.load([{"name": "pic", "action": "gif", "target": "a.gif", "role": "mod"},
                  {"name": "slowpic", "action": "gif", "target": "a.gif", "cooldown": 30}])
        self.assertEqual(eng.handle(msg("!pic"))["outcome"], "denied")
        self.assertEqual(eng.handle(msg("!pic", badges=["moderator"]))["outcome"], "ran")
        self.assertEqual(eng.handle(msg("!slowpic"))["outcome"], "ran")
        self.assertEqual(eng.handle(msg("!slowpic"))["outcome"], "cooling")
        now[0] += 31
        self.assertEqual(eng.handle(msg("!slowpic"))["outcome"], "ran")


class TheLimits(unittest.TestCase):
    """T10: the effects budget over every command, and the stop.

    Every clock here is injected, like the rest of this file. A budget test
    that slept through its window would take thirty seconds to prove what
    arithmetic proves at once.
    """

    def setUp(self):
        self.now = [1000.0]
        self.shown, self.stops = [], []
        self.eng = commands.Engine(
            run_gif=lambda a, m: (self.shown.append(a), (True, ""))[1],
            run_sound=lambda a, m: (self.shown.append(a), (True, ""))[1],
            run_stop=lambda t, m: (self.stops.append(t), (True, ""))[1],
            clock=lambda: self.now[0])
        self.eng.load([
            {"name": "a", "action": "gif", "target": "a.gif"},
            {"name": "b", "action": "gif", "target": "b.gif"},
            {"name": "horn", "action": "sound", "target": "h.mp3"},
            {"name": "hello", "action": "say", "response": "hi"},
            {"name": "hush", "action": "stop", "role": "mod"},
            {"name": "unhush", "action": "stop", "target": "resume", "role": "mod"},
        ])
        self.eng.set_budget({"count": 3, "seconds": 30})

    def outcomes(self, *texts, **kw):
        return [self.eng.handle(msg(t, **kw))["outcome"] for t in texts]

    # -- the budget
    def test_it_counts_effects_across_every_command(self):
        """The reason it exists: no single command here is over any limit of
        its own, and together they are a flood."""
        got = self.outcomes("!a", "!b", "!horn", "!a", "!b")
        self.assertEqual(got, ["ran", "ran", "ran", "held", "held"])
        self.assertEqual(self.shown, ["a.gif", "b.gif", "h.mp3"])

    def test_held_is_its_own_word_and_says_which_limit(self):
        self.outcomes("!a", "!a", "!a")
        entry = self.eng.handle(msg("!b"))
        self.assertEqual(entry["outcome"], "held")
        self.assertIn("3 every 30 s", entry["response"])

    def test_it_frees_up_as_the_window_moves(self):
        self.outcomes("!a", "!a", "!a")
        self.now[0] += 29.9
        self.assertEqual(self.outcomes("!a"), ["held"])
        self.now[0] += 0.2
        self.assertEqual(self.outcomes("!a"), ["ran"])

    def test_words_are_not_effects(self):
        """The control: a spent budget must not reach a command that puts
        nothing on screen, or it would be a limit on talking."""
        self.outcomes("!a", "!a", "!a")
        self.assertEqual(self.outcomes("!hello", "!hello"), ["ran", "ran"])

    def test_a_held_effect_starts_none_of_its_clocks(self):
        """Held is a refusal, and a refusal starts no clock (see Running): a
        viewer turned away by the budget is not then made to wait out a
        cooldown for something that never happened."""
        self.eng.load([{"name": "c", "action": "gif", "target": "c.gif", "user_cooldown": 60},
                       {"name": "a", "action": "gif", "target": "a.gif"}])
        self.outcomes("!a", "!a", "!a")
        self.assertEqual(self.outcomes("!c"), ["held"])
        self.now[0] += 31
        self.assertEqual(self.outcomes("!c"), ["ran"])

    def test_an_effect_that_fails_hands_its_place_back(self):
        eng = commands.Engine(run_gif=lambda a, m: (False, "no such picture"), clock=lambda: 1000.0)
        eng.load([{"name": "a", "action": "gif", "target": "gone.gif"}])
        eng.set_budget({"count": 1, "seconds": 30})
        self.assertEqual([eng.handle(msg("!a"))["outcome"] for _ in range(3)],
                         ["failed", "failed", "failed"])

    def test_no_seconds_means_no_budget(self):
        self.eng.set_budget({"count": 1, "seconds": 0})
        self.assertEqual(self.outcomes("!a", "!b", "!a", "!b"), ["ran"] * 4)

    def test_the_setting_is_clamped_and_survives_nonsense(self):
        self.assertEqual(commands.clean_budget(None),
                         {"count": commands.BUDGET_COUNT, "seconds": commands.BUDGET_SECONDS})
        self.assertEqual(commands.clean_budget({"count": 0, "seconds": -4}), {"count": 1, "seconds": 0})
        self.assertEqual(commands.clean_budget({"count": 999, "seconds": 99999}), {"count": 60, "seconds": 600})
        self.assertEqual(commands.clean_budget({"count": "lots", "seconds": None}),
                         {"count": commands.BUDGET_COUNT, "seconds": commands.BUDGET_SECONDS})

    # -- the stop
    def test_paused_refuses_every_command(self):
        self.eng.set_paused(True)
        self.assertEqual(self.outcomes("!a", "!hello"), ["paused", "paused"])
        self.assertEqual(self.shown, [])

    def test_paused_still_ignores_words_that_are_not_commands(self):
        """A paused stream is not a reason to start logging every "!lol"."""
        self.eng.set_paused(True)
        self.assertIsNone(self.eng.handle(msg("!nosuchthing")))

    def test_a_stop_command_gets_through_a_pause(self):
        """Or a moderator's resume could never work."""
        self.eng.set_paused(True)
        self.assertEqual(self.outcomes("!unhush", badges=["moderator/1"]), ["ran"])
        self.assertEqual(self.stops, ["resume"])

    def test_but_not_past_its_role_gate(self):
        """The control for the exemption above: getting past the pause is not
        getting past the gate, or any viewer could resume what a mod stopped."""
        self.eng.set_paused(True)
        self.assertEqual(self.outcomes("!unhush"), ["denied"])
        self.assertEqual(self.stops, [])

    def test_the_stop_is_handed_its_target(self):
        self.outcomes("!hush", "!unhush", badges=["moderator/1"])
        self.assertEqual(self.stops, ["", "resume"])

    def test_a_stop_is_not_an_effect(self):
        self.outcomes("!a", "!a", "!a")
        self.assertEqual(self.outcomes("!hush", badges=["moderator/1"]), ["ran"])

    def test_unwired_a_stop_says_so(self):
        eng = commands.Engine(clock=lambda: 1000.0)
        eng.load([{"name": "hush", "action": "stop"}])
        entry = eng.handle(msg("!hush"))
        self.assertEqual(entry["outcome"], "failed")
        self.assertIn("not set up", entry["response"])

    def test_a_layer_command_counts_against_the_budget_too(self):
        """T11's commands are effects: they go straight on screen."""
        self.assertIn(commands.LAYER_ACTION, commands.EFFECTS)

    def test_paused_rides_the_state_feed(self):
        """It changes when a person presses something, so every window with a
        stop button has to hear about it at once."""
        self.assertIs(self.eng.snapshot()["paused"], False)
        self.eng.set_paused(True)
        self.assertIs(self.eng.snapshot()["paused"], True)


def fx(lid, command, **props):
    """An effect layer as a scene holds one."""
    return {"id": lid, "type": "effect", "name": lid.title(), "visible": True,
            "props": dict(props, command=command)}


class TheLayerCommands(unittest.TestCase):
    """T11: a command that belongs to a layer on the canvas.

    The engine is handed a source of the live scene's layer commands, the way
    the server hands it one, and the scene is changed under it between
    messages - which is the case the server's revision cache exists for.
    """

    def setUp(self):
        self.now = [1000.0]
        self.fired, self.said = [], []
        self.scene = {"layers": [fx("horn", "boom"), fx("dup", "Boom"), fx("zapl", "!zap")]}
        self.eng = commands.Engine(
            run_effect=lambda t, m: (self.fired.append(t), (True, ""))[1],
            layers=lambda: commands.scene_commands(self.scene),
            clock=lambda: self.now[0])

    # -- reading one from a layer
    def test_an_effect_layer_with_a_name_is_a_command(self):
        c = commands.layer_command(fx("horn", "!AirHorn", role="mod", cooldown=10, user_cooldown=99999))
        self.assertEqual((c["name"], c["action"], c["target"], c["role"], c["cooldown"], c["user_cooldown"]),
                         ("airhorn", commands.LAYER_ACTION, "horn", "mod", 10, 3600))

    def test_what_is_not_one(self):
        for layer in (fx("a", ""), fx("b", "with space"), dict(fx("c", "ok"), visible=False),
                      dict(fx("d", "ok"), type="image"), fx("", "ok"), "nonsense", None):
            self.assertIsNone(commands.layer_command(layer), repr(layer))

    def test_the_panel_cannot_offer_it_and_config_cannot_hold_it(self):
        """A list entry pointing at a layer id would break the day the layer
        went. The action exists only where a layer made it."""
        self.assertNotIn(commands.LAYER_ACTION, commands.ACTIONS)
        self.assertIsNone(commands.clean({"name": "x", "action": commands.LAYER_ACTION, "target": "horn"}))

    def test_the_first_layer_to_take_a_name_keeps_it(self):
        cmds = commands.scene_commands(self.scene)
        self.assertEqual([(c["target"], c["name"], c["shadowed"]) for c in cmds],
                         [("horn", "boom", False), ("dup", "boom", True), ("zapl", "zap", False)])

    # -- running one
    def test_it_sets_off_its_own_layer(self):
        self.assertEqual(self.eng.handle(msg("!boom"))["outcome"], "ran")
        self.assertEqual(self.fired, ["horn"])

    def test_the_layer_that_came_second_stays_still(self):
        """Two layers, one name: exactly one answers, not both and not the
        last one saved."""
        self.eng.handle(msg("!boom"))
        self.assertNotIn("dup", self.fired)

    def test_the_list_answers_a_name_both_have(self):
        """The control on the order: with no list entry the layer answers
        (above); with one, the list does and the layer stays still."""
        self.eng.load([{"name": "zap", "action": "say", "response": "from the list"}])
        entry = self.eng.handle(msg("!zap"))
        self.assertEqual((entry["outcome"], entry["response"]), ("ran", "from the list"))
        self.assertEqual(self.fired, [])

    def test_the_conflicts_are_said_not_settled_quietly(self):
        self.eng.load([{"name": "zap", "action": "say", "response": "x"}])
        got = {c["target"]: c["conflict"] for c in self.eng.layer_list()}
        self.assertEqual(got, {"horn": "", "dup": "layer", "zapl": "list"})

    def test_it_follows_the_scene_as_it_is_now(self):
        """Delete the layer and its command is gone at the next message."""
        self.assertEqual(self.eng.handle(msg("!zap"))["outcome"], "ran")
        self.scene["layers"] = [fx("horn", "boom")]
        self.assertIsNone(self.eng.handle(msg("!zap")))

    def test_its_own_role_and_waits_apply(self):
        self.scene["layers"] = [fx("horn", "boom", role="mod", cooldown=30)]
        self.assertEqual(self.eng.handle(msg("!boom"))["outcome"], "denied")
        self.assertEqual(self.eng.handle(msg("!boom", badges=["moderator/1"]))["outcome"], "ran")
        self.assertEqual(self.eng.handle(msg("!boom", badges=["moderator/1"]))["outcome"], "cooling")

    def test_the_budget_and_the_pause_apply_as_to_any_other(self):
        self.eng.set_budget({"count": 1, "seconds": 30})
        self.assertEqual(self.eng.handle(msg("!boom"))["outcome"], "ran")
        self.assertEqual(self.eng.handle(msg("!zap"))["outcome"], "held")
        self.eng.set_paused(True)
        self.assertEqual(self.eng.handle(msg("!boom"))["outcome"], "paused")

    def test_a_source_that_throws_takes_nothing_down(self):
        """A scene the server cannot read must not stop the list's commands,
        nor the chat reader that calls this."""
        eng = commands.Engine(layers=lambda: 1 / 0, clock=lambda: 1000.0)
        eng.load([{"name": "hello", "action": "say", "response": "hi"}])
        self.assertIsNone(eng.handle(msg("!boom")))
        self.assertEqual(eng.handle(msg("!hello"))["outcome"], "ran")
        self.assertEqual(eng.layer_list(), [])

    def test_unwired_it_says_so(self):
        eng = commands.Engine(layers=lambda: commands.scene_commands(self.scene), clock=lambda: 1000.0)
        entry = eng.handle(msg("!boom"))
        self.assertEqual(entry["outcome"], "failed")
        self.assertIn("not set up", entry["response"])


if __name__ == "__main__":
    unittest.main()
