"""The event bus (S15): one shape, a bounded ring, and a page that cannot keep
up dropping rather than growing.

All of it is arithmetic over one dict, so all of it is tested here with no
network and no rig.
"""
import json
import os
import queue
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import alerts  # noqa: E402


class Shape(unittest.TestCase):
    def test_one_shape_whatever_made_it(self):
        for kind in alerts.KINDS:
            ev = alerts.event(kind, "something happened")
            self.assertEqual(sorted(ev), ["at", "detail", "id", "kind", "text", "title", "user"])
            self.assertEqual(ev["kind"], kind)

    def test_an_unknown_kind_becomes_a_note_rather_than_being_passed_on(self):
        # A scene decides what to draw from `kind`; an unknown one arriving
        # would be a layer with nothing to show and no way to say why.
        self.assertEqual(alerts.event("whatever", "hi")["kind"], "note")

    def test_stop_is_a_kind_of_its_own(self):
        """T10. scene.js takes a stop off the stream by its kind, and an
        unknown kind is quietly turned into a note - which a layer listening
        for everything would show as a blank card, and which clears nothing.
        The failure would be silent, so it is pinned."""
        self.assertEqual(alerts.event("stop", "")["kind"], "stop")

    def test_effect_is_a_kind_of_its_own(self):
        """T11: a layer's own command. Coerced to a note, it would reach no
        layer at all - the addressing rides in detail, but the kind is what
        says it is addressed."""
        self.assertEqual(alerts.event("effect", "", detail={"layer": "horn"})["kind"], "effect")

    def test_ids_are_not_shared(self):
        ids = {alerts.event("note", "x")["id"] for _ in range(200)}
        self.assertEqual(len(ids), 200)

    def test_long_text_is_cut_rather_than_carried(self):
        ev = alerts.event("note", "x" * 5000)
        self.assertEqual(len(ev["text"]), alerts.MAX_TEXT)

    def test_detail_is_a_dict_or_nothing(self):
        self.assertEqual(alerts.event("note", "x", detail="not a dict")["detail"], {})
        self.assertEqual(alerts.event("note", "x", detail={"a": 1})["detail"], {"a": 1})

    def test_it_is_json(self):
        # It goes down a WebSocket as text; anything unserialisable here would
        # only be discovered by a page that stopped receiving.
        json.dumps(alerts.event("command", "hi", user="Amy", title="!queue", detail={"n": 1}))


class Fanning(unittest.TestCase):
    def setUp(self):
        self.hub = alerts.AlertHub()

    def test_a_subscriber_gets_what_is_posted(self):
        q = self.hub.subscribe()
        self.hub.say("command", "Amy ran !hello")
        got = json.loads(q.get_nowait())
        self.assertEqual(got["text"], "Amy ran !hello")

    def test_everyone_listening_gets_it(self):
        qs = [self.hub.subscribe() for _ in range(3)]
        self.hub.say("note", "one")
        self.assertEqual([json.loads(q.get_nowait())["text"] for q in qs], ["one"] * 3)

    def test_unsubscribing_stops_it(self):
        q = self.hub.subscribe()
        self.hub.unsubscribe(q)
        self.hub.say("note", "one")
        with self.assertRaises(queue.Empty):
            q.get_nowait()

    def test_a_page_that_cannot_keep_up_drops_rather_than_grows(self):
        self.hub.subscribe()                       # never drained
        for i in range(alerts.QUEUE_DEPTH + 17):
            self.hub.say("note", str(i))
        self.assertEqual(self.hub.dropped, 17)
        self.assertEqual(self.hub.total, alerts.QUEUE_DEPTH + 17)

    def test_rubbish_is_ignored_rather_than_posted(self):
        # post() is reached from the chat reading loop by way of the command
        # engine: a bad event must not become an exception there.
        for bad in (None, "a string", {}, {"no": "id"}):
            self.assertIsNone(self.hub.post(bad))
        self.assertEqual(self.hub.total, 0)


class Keeping(unittest.TestCase):
    def setUp(self):
        self.hub = alerts.AlertHub()

    def test_the_ring_is_bounded(self):
        for i in range(alerts.KEEP + 30):
            self.hub.say("note", str(i))
        kept = self.hub.recent(alerts.KEEP)
        self.assertEqual(len(kept), alerts.KEEP)
        self.assertEqual(kept[-1]["text"], str(alerts.KEEP + 29))     # the newest survives

    def test_recent_cannot_be_asked_for_more_than_it_keeps(self):
        for i in range(10):
            self.hub.say("note", str(i))
        self.assertEqual(len(self.hub.recent(10_000)), 10)

    def test_the_snapshot_carries_counts_and_never_the_events(self):
        # The whole reason this hub exists: an event on the state feed would
        # make every page rebuild its model each time somebody typed.
        self.hub.say("command", "Amy ran !hello")
        snap = self.hub.snapshot()
        self.assertEqual(sorted(snap), ["dropped", "total"])
        self.assertNotIn("Amy", json.dumps(snap))

    def test_status_counts_what_is_listening(self):
        self.hub.subscribe()
        self.hub.say("note", "x")
        st = self.hub.status()
        self.assertEqual((st["total"], st["subscribers"], st["kept"]), (1, 1, 1))

    def test_the_module_holds_no_credential(self):
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "alerts.py"), encoding="utf-8") as f:
            src = f.read().lower()
        for word in ("oauth:", "password", "client_secret", "access_token"):
            self.assertNotIn(word, src, word)


if __name__ == "__main__":
    unittest.main()
