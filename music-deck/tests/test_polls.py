"""Polls (S14): opening, counting, closing, and what reaches the canvas.

Votes arrive as the message shape chat.py produces, so the engine is tested on
what the parser actually makes rather than on hand-written dicts.
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import chat  # noqa: E402
import polls  # noqa: E402


def said(text, login="amy"):
    return chat.message("twitch", "somechannel", text,
                        user={"id": "1", "login": login, "name": login.title()})


class Opening(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.p = polls.Polls(publish=self.sent.append)

    def test_a_poll_needs_a_question_and_two_choices(self):
        self.assertFalse(self.p.open("", ["a", "b"])["ok"])
        self.assertFalse(self.p.open("Which?", ["only one"])["ok"])
        self.assertFalse(self.p.open("Which?", [])["ok"])

    def test_opening_one_publishes_it_straight_away(self):
        res = self.p.open("Which song?", ["Sabotage", "Intergalactic"])
        self.assertTrue(res["ok"])
        self.assertEqual(self.sent[-1]["question"], "Which song?")
        self.assertEqual(self.sent[-1]["counts"], [0, 0])

    def test_choices_are_trimmed_and_capped(self):
        self.p.open("Q", ["  a  ", "", "b"] + [str(i) for i in range(20)])
        self.assertLessEqual(len(self.p.current()["choices"]), polls.MAX_CHOICES)
        self.assertEqual(self.p.current()["choices"][0], "a")

    def test_a_second_poll_closes_the_first(self):
        # Two at once would make !1 mean two different things, which is the
        # whole point of the numbering.
        self.p.open("First", ["a", "b"])
        self.p.vote("amy", 1)
        self.p.open("Second", ["c", "d"])
        self.assertEqual(self.p.current()["question"], "Second")
        self.assertEqual([r["question"] for r in self.p.recent()], ["First"])


class Counting(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.p = polls.Polls(publish=self.sent.append)
        self.p.open("Which?", ["one", "two", "three"])

    def test_a_vote_counts_once(self):
        self.assertTrue(self.p.vote("amy", 2))
        t = self.p.current()
        self.assertEqual(t["counts"], [0, 1, 0])
        self.assertEqual(t["total"], 1)

    def test_the_first_vote_wins_and_later_ones_are_ignored(self):
        # "First wins" is the rule that can be said out loud in one sentence;
        # letting people change stops the total matching the people.
        self.assertTrue(self.p.vote("amy", 1))
        self.assertFalse(self.p.vote("amy", 3))
        self.assertEqual(self.p.current()["counts"], [1, 0, 0])
        self.assertEqual(self.p.current()["total"], 1)

    def test_a_choice_that_does_not_exist_is_not_a_vote(self):
        for bad in (0, 4, -1, "nine", "", None):
            self.assertFalse(self.p.vote("someone" + str(bad), bad))
        self.assertEqual(self.p.current()["total"], 0)

    def test_votes_before_a_poll_and_after_it_are_ignored(self):
        fresh = polls.Polls()
        self.assertFalse(fresh.vote("amy", 1))          # nothing open
        self.p.close()
        self.assertFalse(self.p.vote("bob", 1))         # closed
        self.assertEqual(self.p.recent()[-1]["total"], 0)

    def test_the_tally_is_whole_and_carries_shares(self):
        for who, n in (("a", 1), ("b", 1), ("c", 2)):
            self.p.vote(who, n)
        t = self.p.current()
        self.assertEqual(t["counts"], [2, 1, 0])
        self.assertEqual(t["total"], 3)
        self.assertEqual(t["shares"], [round(2 / 3, 4), round(1 / 3, 4), 0.0])

    def test_no_votes_is_not_a_divide_by_zero(self):
        self.assertEqual(self.p.current()["shares"], [0.0, 0.0, 0.0])


class FromChat(unittest.TestCase):
    def setUp(self):
        self.p = polls.Polls()
        self.p.open("Which?", ["one", "two"])

    def test_a_bare_number_is_a_vote(self):
        self.p.handle(said("!1", "amy"))
        self.assertEqual(self.p.current()["counts"], [1, 0])

    def test_the_long_way_round_works_too(self):
        self.p.handle(said("!vote 2", "bob"))
        self.assertEqual(self.p.current()["counts"], [0, 1])

    def test_an_ordinary_command_is_not_a_vote(self):
        self.p.handle(said("!hello", "cat"))
        self.p.handle(said("just talking", "dan"))
        self.assertEqual(self.p.current()["total"], 0)


class Closing(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.p = polls.Polls(publish=self.sent.append)

    def test_closing_keeps_the_result(self):
        # The point of closing is to still have it afterwards.
        self.p.open("Which?", ["a", "b"])
        self.p.vote("amy", 1)
        res = self.p.close()
        self.assertTrue(res["ok"])
        self.assertEqual(res["poll"]["counts"], [1, 0])
        self.assertIsNone(self.p.current())
        self.assertEqual(self.p.recent()[-1]["counts"], [1, 0])

    def test_the_final_bars_are_published_after_it_shuts(self):
        # close() clears the open poll before publishing, so the tally has to
        # come from the one just put away - otherwise the canvas never settles
        # on the result, which is the moment it most needs to be right.
        self.p.open("Which?", ["a", "b"])
        self.p.vote("amy", 2)
        self.sent.clear()
        self.p.close()
        self.assertTrue(self.sent, "closing published nothing")
        self.assertEqual(self.sent[-1]["counts"], [0, 1])
        self.assertFalse(self.sent[-1]["open"])

    def test_closing_nothing_says_so(self):
        self.assertFalse(self.p.close()["ok"])


class ToTheCanvas(unittest.TestCase):
    def test_a_burst_is_coalesced_and_the_last_one_still_arrives(self):
        # Real time on purpose: the promise is about the actual timer, and a
        # faked clock would only test arithmetic about a fake.
        sent = []
        p = polls.Polls(publish=sent.append)
        p.open("Which?", ["a", "b"])
        sent.clear()
        for i in range(20):
            p.vote("voter%d" % i, 1 + (i % 2))
        self.assertLess(len(sent), 20, "every vote put an event on the bus")
        time.sleep(polls.COALESCE_S * 2)
        self.assertTrue(sent, "the last vote of the burst never arrived")
        self.assertEqual(sent[-1]["total"], 20)

    def test_a_publish_that_throws_does_not_stop_the_counting(self):
        def boom(_):
            raise RuntimeError("bus is down")
        p = polls.Polls(publish=boom)
        p.open("Which?", ["a", "b"])
        self.assertTrue(p.vote("amy", 1))
        self.assertEqual(p.current()["total"], 1)

    def test_the_snapshot_carries_no_counts(self):
        # Counts change on every vote; on the state feed that is a whole-state
        # broadcast per vote, which is what the bus exists to avoid.
        p = polls.Polls()
        p.open("Which?", ["a", "b"])
        p.vote("amy", 1)
        snap = p.snapshot()
        self.assertEqual(sorted(snap), ["id", "open", "question"])

    def test_the_module_holds_no_credential(self):
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "polls.py"), encoding="utf-8") as f:
            src = f.read().lower()
        for word in ("oauth:", "password", "client_secret", "access_token"):
            self.assertNotIn(word, src, word)


if __name__ == "__main__":
    unittest.main()
