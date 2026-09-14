"""Song requests (S13): the guard rails, the parking, and the one-way door.

Spotify is injected, so none of this reaches an account and nothing is ever put
into anybody's real queue. Verifying my own code is not a reason to queue songs
on someone's stream.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import chat  # noqa: E402
import songreq  # noqa: E402

TRACK = {"uri": "spotify:track:1", "title": "Sabotage", "artist": "Beastie Boys", "duration": 178.0}
LONG = {"uri": "spotify:track:2", "title": "Echoes", "artist": "Pink Floyd", "duration": 1430.0}


def ask_msg(text, login="amy"):
    return chat.message("twitch", "somechannel", "!queue " + text,
                        user={"id": "1", "login": login, "name": login.title()})


class Fake:
    """Stands in for spotify_api's search/add_to_queue pair."""

    def __init__(self, track=TRACK, ok=True, reason="queued"):
        self.track, self.ok, self.reason = track, ok, reason
        self.searched, self.queued = [], []

    def find(self, text):
        self.searched.append(text)
        return (True, self.track) if self.track else (False, "nothing found for that")

    def enqueue(self, uri):
        self.queued.append(uri)
        return self.ok, self.reason


def store(rules=None, fake=None):
    fake = fake or Fake()
    return songreq.Store(find=fake.find, enqueue=fake.enqueue, rules=rules or {}), fake


class Rules(unittest.TestCase):
    def test_moderation_is_on_unless_it_is_turned_off(self):
        # The default matters: appending cannot be undone, so the safe default
        # is the one that asks first.
        self.assertTrue(songreq.clean_rules({})["moderated"])
        self.assertFalse(songreq.clean_rules({"moderated": False})["moderated"])

    def test_a_nonsense_cap_falls_back_rather_than_disabling_the_rule(self):
        self.assertEqual(songreq.clean_rules({"max_seconds": "ages"})["max_seconds"], 420)
        self.assertEqual(songreq.clean_rules({"max_seconds": -1})["max_seconds"], 0)
        self.assertEqual(songreq.clean_rules({"max_seconds": 99999})["max_seconds"], 3600)

    def test_the_block_list_is_normalised(self):
        self.assertEqual(songreq.clean_rules({"blocked": [" Rick ", "", "ASTLEY"]})["blocked"],
                         ["rick", "astley"])


class Asking(unittest.TestCase):
    def test_an_empty_request_is_refused_and_says_how(self):
        st, fake = store()
        e = st.ask(ask_msg(""))
        self.assertEqual(e["state"], "refused")
        self.assertIn("!queue", e["reason"])
        self.assertEqual(fake.searched, [])          # not even looked up

    def test_a_found_track_is_parked_when_moderated(self):
        st, fake = store()
        e = st.ask(ask_msg("sabotage"))
        self.assertEqual(e["state"], "pending")
        self.assertEqual(fake.queued, [])            # nothing sent to Spotify yet
        self.assertEqual([p["id"] for p in st.pending()], [e["id"]])

    def test_unmoderated_it_goes_straight_through(self):
        st, fake = store({"moderated": False})
        e = st.ask(ask_msg("sabotage"))
        self.assertEqual(e["state"], "queued")
        self.assertEqual(fake.queued, ["spotify:track:1"])
        self.assertEqual(st.pending(), [])

    def test_a_track_over_the_cap_is_refused_and_the_cap_is_named(self):
        st, fake = store({"max_seconds": 420}, Fake(track=LONG))
        e = st.ask(ask_msg("echoes"))
        self.assertEqual(e["state"], "refused")
        self.assertIn("7m", e["reason"])
        self.assertEqual(fake.queued, [])

    def test_a_blocked_word_in_the_request_is_refused_before_any_search(self):
        st, fake = store({"blocked": ["rick"]})
        e = st.ask(ask_msg("Rick Astley please"))
        self.assertEqual(e["state"], "refused")
        self.assertEqual(fake.searched, [])

    def test_a_blocked_word_in_what_was_found_is_refused_too(self):
        # Someone asking for "never gonna give you up" gets past a list that
        # only knows the artist's name, unless what came back is checked.
        st, fake = store({"blocked": ["beastie"]})
        e = st.ask(ask_msg("sabotage"))
        self.assertEqual(e["state"], "refused")
        self.assertEqual(fake.queued, [])

    def test_the_blocked_word_is_not_repeated_back(self):
        # Echoing it would put the thing on screen that the list exists to
        # keep off it.
        st, _ = store({"blocked": ["rick"]})
        self.assertNotIn("rick", store({"blocked": ["rick"]})[0].ask(ask_msg("rick"))["reason"].lower())

    def test_nothing_found_is_a_refusal_with_a_reason(self):
        st, _ = store(None, Fake(track=None))
        e = st.ask(ask_msg("asdfghjkl"))
        self.assertEqual(e["state"], "refused")
        self.assertIn("nothing found", e["reason"])

    def test_a_search_that_throws_is_recorded_not_raised(self):
        # This runs on the chat reading loop; an exception would take the
        # connection down with it.
        st = songreq.Store(find=lambda t: (_ for _ in ()).throw(RuntimeError("boom")), enqueue=lambda u: (True, ""))
        e = st.ask(ask_msg("anything"))
        self.assertEqual(e["state"], "refused")
        self.assertIn("boom", e["reason"])

    def test_the_parked_list_does_not_grow_without_end(self):
        st, _ = store()
        for _ in range(songreq.MAX_PENDING + 5):
            st.ask(ask_msg("sabotage"))
        self.assertEqual(len(st.pending()), songreq.MAX_PENDING)
        self.assertEqual(st.ask(ask_msg("sabotage"))["state"], "refused")


class LettingThrough(unittest.TestCase):
    def setUp(self):
        self.st, self.fake = store()
        self.entry = self.st.ask(ask_msg("sabotage"))

    def test_approve_sends_it_exactly_once(self):
        res = self.st.approve(self.entry["id"])
        self.assertTrue(res["ok"])
        self.assertEqual(self.fake.queued, ["spotify:track:1"])
        self.assertEqual(self.st.pending(), [])
        # And it cannot be sent twice: it has left the parked list.
        self.assertFalse(self.st.approve(self.entry["id"])["ok"])
        self.assertEqual(self.fake.queued, ["spotify:track:1"])

    def test_skip_never_calls_spotify(self):
        res = self.st.skip(self.entry["id"])
        self.assertTrue(res["ok"])
        self.assertEqual(res["request"]["state"], "skipped")
        self.assertEqual(self.fake.queued, [])

    def test_an_unknown_id_is_refused_rather_than_guessed_at(self):
        self.assertFalse(self.st.approve("nope")["ok"])
        self.assertFalse(self.st.skip("nope")["ok"])

    def test_spotifys_own_words_survive_the_trip(self):
        # The two failures that actually happen: nothing playing, and not
        # Premium. Flattening them to "that did not work" would waste the only
        # useful thing Spotify said.
        for reason in ("Spotify has no active device - start playing something first.",
                       "Spotify allows this only on Premium accounts."):
            st, _ = store(None, Fake(ok=False, reason=reason))
            e = st.ask(ask_msg("sabotage"))
            done = st.approve(e["id"])
            self.assertFalse(done["ok"])
            self.assertEqual(done["request"]["reason"], reason)

    def test_an_enqueue_that_throws_is_recorded_not_raised(self):
        st = songreq.Store(find=lambda t: (True, TRACK),
                           enqueue=lambda u: (_ for _ in ()).throw(RuntimeError("socket gone")))
        e = st.ask(ask_msg("sabotage"))
        done = st.approve(e["id"])
        self.assertFalse(done["ok"])
        self.assertIn("socket gone", done["request"]["reason"])

    def test_with_no_spotify_wired_it_says_so(self):
        st = songreq.Store()
        self.assertEqual(st.ask(ask_msg("sabotage"))["state"], "refused")


class Bookkeeping(unittest.TestCase):
    def test_history_shows_one_row_per_request_not_one_per_state(self):
        st, _ = store()
        e = st.ask(ask_msg("sabotage"))
        st.approve(e["id"])
        rows = [r for r in st.recent() if r["id"] == e["id"]]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["state"], "queued")

    def test_the_history_is_a_bounded_ring(self):
        st, _ = store({"moderated": False})
        for _ in range(songreq.KEEP + 20):
            st.ask(ask_msg("sabotage"))
        self.assertEqual(len(st.recent(songreq.KEEP)), songreq.KEEP)

    def test_the_counts_and_the_snapshot_agree(self):
        st, _ = store()
        a = st.ask(ask_msg("sabotage"))
        st.ask(ask_msg(""))                       # refused
        st.approve(a["id"])
        self.assertEqual(st.status()["queued"], 1)
        self.assertEqual(st.snapshot()["queued"], 1)
        self.assertEqual(st.snapshot()["pending"], 0)

    def test_the_module_holds_no_credential(self):
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "songreq.py"), encoding="utf-8") as f:
            src = f.read().lower()
        for word in ("oauth:", "password", "client_secret", "access_token"):
            self.assertNotIn(word, src, word)


if __name__ == "__main__":
    unittest.main()
