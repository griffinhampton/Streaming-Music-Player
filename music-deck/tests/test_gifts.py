"""The coin ledger (gifts.py): what was gifted, by whom, kept by @handle."""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gifts  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


class TheLedger(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.path = os.path.join(self.dir, "gift-ledger.json")
        self.clock = Clock()
        self.led = gifts.GiftLedger(self.path, clock=self.clock)

    def test_coins_add_up_per_sender_and_in_all(self):
        self.assertEqual(self.led.record("amy", "Amy", 5, 5), 5)
        self.assertEqual(self.led.record("bob", "Bob", 1000), 1000)
        self.assertEqual(self.led.record("Amy", "Amy", 3), 8, "one sender, however the handle is written")
        snap = self.led.snapshot()
        self.assertEqual((snap["coins"], snap["gifts"], snap["senders"]), (1008, 7, 2))
        self.assertEqual([(t["handle"], t["coins"], t["gifts"]) for t in snap["top"]], [("bob", 1000, 1), ("amy", 8, 6)])
        self.assertEqual(self.led.coins_from("AMY"), 8)
        self.assertEqual(self.led.coins_from("nobody"), 0)

    def test_a_display_name_is_not_a_key(self):
        """Two people calling themselves the same are two senders; one person
        who renames themselves is one."""
        self.led.record("amy1", "Amy", 5)
        self.led.record("amy2", "Amy", 7)
        self.led.record("amy1", "Amelia", 1)
        top = {t["handle"]: t for t in self.led.snapshot()["top"]}
        self.assertEqual((top["amy1"]["coins"], top["amy1"]["name"], top["amy2"]["coins"]), (6, "Amelia", 7))

    def test_a_gift_with_no_handle_counts_toward_the_stream_only(self):
        self.assertEqual(self.led.record("", "Someone", 10), 0)
        self.assertEqual((self.led.snapshot()["coins"], self.led.snapshot()["senders"]), (10, 0))

    def test_nonsense_is_not_counted(self):
        for coins, count in (("lots", 1), (None, None), (-5, 1)):
            self.led.record("x", "X", coins, count)
        self.assertEqual(self.led.snapshot()["coins"], 0)

    def test_ties_go_to_the_latest(self):
        self.led.record("a", "A", 5)
        self.clock.t += 1
        self.led.record("b", "B", 5)
        self.assertEqual([t["handle"] for t in self.led.snapshot()["top"]], ["b", "a"])

    def test_a_restart_keeps_the_totals_and_reset_clears_them(self):
        self.led.record("amy", "Amy", 5)
        self.led.save()
        again = gifts.GiftLedger(self.path, clock=self.clock)
        self.assertEqual((again.snapshot()["coins"], again.coins_from("amy")), (5, 5))
        again.reset()
        third = gifts.GiftLedger(self.path, clock=self.clock)
        self.assertEqual((third.snapshot()["coins"], third.coins_from("amy")), (0, 0))

    def test_saves_are_spaced_but_never_lost(self):
        self.led.record("a", "A", 1)                   # first save
        self.led.record("b", "B", 1)                   # too soon: not yet written
        with open(self.path, encoding="utf-8") as f:
            self.assertNotIn("b", json.load(f)["senders"])
        self.clock.t += gifts.SAVE_EVERY
        self.assertTrue(self.led.save(force=False))
        with open(self.path, encoding="utf-8") as f:
            self.assertIn("b", json.load(f)["senders"])

    def test_a_damaged_file_starts_clean(self):
        for text in ("{not json", "[1, 2]", '{"coins": "x"}', '{"senders": {"a": {"coins": "many"}}}'):
            with open(self.path, "w", encoding="utf-8") as f:
                f.write(text)
            led = gifts.GiftLedger(self.path, clock=self.clock)
            self.assertEqual((led.snapshot()["coins"], led.snapshot()["senders"]), (0, 0), text)

    LIVE1, LIVE2 = "7000000000000000001", "7000000000000000002"

    def test_a_new_live_starts_a_new_count_and_keeps_the_last(self):
        """TikTok gives every live a room id of its own (19 digits, seen on real
        lives); a different one than the count is for is a new live."""
        self.assertTrue(self.led.begin(self.LIVE1))
        self.led.record("amy", "Amy", 5)
        self.led.record("bob", "Bob", 20)
        self.assertFalse(self.led.begin(self.LIVE1), "the same live: nothing changes")
        self.assertEqual(self.led.snapshot()["coins"], 25)
        started = self.clock.t
        self.clock.t += 3600
        self.assertTrue(self.led.begin(self.LIVE2))
        snap = self.led.snapshot()
        self.assertEqual((snap["coins"], snap["gifts"], snap["senders"], self.led.coins_from("amy")), (0, 0, 0, 0))
        self.assertEqual((snap["since"], snap["live"]), (self.clock.t, True))
        last = snap["last"]
        self.assertEqual((last["coins"], last["gifts"], last["senders"], last["since"], last["until"]),
                         (25, 2, 2, started, self.clock.t))
        self.assertEqual([t["handle"] for t in last["top"]], ["bob", "amy"])

    def test_nothing_counted_leaves_no_last_stream(self):
        self.led.begin(self.LIVE1)
        self.led.begin(self.LIVE2)
        self.assertIsNone(self.led.snapshot()["last"])

    def test_a_restart_mid_live_keeps_counting(self):
        self.led.begin(self.LIVE1)
        self.led.record("amy", "Amy", 5)
        self.led.save()
        again = gifts.GiftLedger(self.path, clock=self.clock)
        self.assertFalse(again.begin(self.LIVE1), "the same live, found again after a restart")
        self.assertEqual((again.coins_from("amy"), again.snapshot()["live"]), (5, True))

    def test_the_last_stream_is_kept_across_a_restart(self):
        self.led.begin(self.LIVE1)
        self.led.record("amy", "Amy", 5)
        self.led.begin(self.LIVE2)
        again = gifts.GiftLedger(self.path, clock=self.clock)
        self.assertEqual(again.snapshot()["last"]["coins"], 5)

    def test_only_a_room_id_is_taken(self):
        for bad in ("", None, "abc", "70000000000000000a1", "1" * (gifts.ROOM_MAX + 1), " 7000"):
            self.assertFalse(self.led.begin(bad), repr(bad))
        self.assertFalse(self.led.snapshot()["live"])

    def test_reset_by_hand_keeps_the_live(self):
        self.led.begin(self.LIVE1)
        self.led.record("amy", "Amy", 5)
        self.led.reset()
        self.assertFalse(self.led.begin(self.LIVE1), "still this live: found again, it is not a new one")
        self.assertEqual((self.led.snapshot()["coins"], self.led.snapshot()["last"]), (0, None))

    def test_a_damaged_room_or_last_stream_is_dropped_and_the_rest_kept(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump({"coins": 3, "gifts": 1, "room": "not an id", "last": {"coins": "many"}}, f)
        led = gifts.GiftLedger(self.path, clock=self.clock)
        snap = led.snapshot()
        self.assertEqual((snap["coins"], snap["live"], snap["last"]), (3, False, None))

    def test_senders_are_bounded_but_the_total_is_not(self):
        old = gifts.MAX_SENDERS
        self.addCleanup(setattr, gifts, "MAX_SENDERS", old)
        gifts.MAX_SENDERS = 3
        for n in range(5):
            self.led.record(f"u{n}", "U", 1)
        snap = self.led.snapshot()
        self.assertEqual((snap["senders"], snap["coins"]), (3, 5))


if __name__ == "__main__":
    unittest.main()
