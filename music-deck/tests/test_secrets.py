"""Nothing that identifies whoever runs this leaves the repository.

Written because something already did. Commit 62e2105 added
`dist/Music Deck.exe` and a folder of `__pycache__/*.pyc` - among them
`spotify_api.cpython-313.pyc` - and a Spotify credential rode out inside a
build artifact rather than in any config file. That token is in git history for
good and has to be revoked at Spotify's end; what is left to do here is make
sure the same road stays shut.

Two halves, because the incident had two.

The road. `.gitignore` is the only thing standing between a build artifact and
git history, and it is a file anyone can shorten by one line without noticing -
the line that would have prevented this one is `dist/`. Every pattern that
keeps a credential or a build artifact out is asserted here by name, so
removing one fails a test instead of passing quietly.

The cargo. `spotify_api.py` legitimately holds an OAuth token: it is the OAuth
client, and `tok["access_token"]` appears in it because that is its job. So the
`test_the_module_holds_no_credential` shape that `alerts.py`, `commands.py`,
`polls.py` and `songreq.py` carry would be wrong here, and weakening it until
it passed would be worse than not having it. The question for a module that is
supposed to hold a secret is whether the secret can get out. This seeds a fake
one and looks for it in everything the module hands to anyone else - which
matters because two of those, peek_queue() and peek_devices(), ride the state
broadcast to every open window.

What this does not cover: git history, which cannot be changed by a test, and
whatever a build tool decides to bundle. It guards the road and the cargo, not
the whole journey.
"""
import json
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DECK = os.path.dirname(HERE)
REPO = os.path.dirname(DECK)
IGNORE = os.path.join(REPO, ".gitignore")

sys.path.insert(0, DECK)

import spotify_api  # noqa: E402

# Every one of these is load-bearing, and the reason is worth keeping next to
# it - a pattern with no stated reason is the one somebody deletes.
REQUIRED = {
    "cache/": "holds the Spotify OAuth token and four Chrome profiles",
    "config.json": "the running copy of somebody's settings",
    "*.token.json": "belt and braces for any token file that appears",
    "spotify_token.json": "the file the OAuth token is actually written to",
    ".env": "the usual home for a secret",
    "*.pem": "a private key",
    "*.key": "a private key",
    "dist/": "the build output 62e2105 committed, credential and all",
    "dist-staging/": "the same, mid-build",
    ".rig/": "the test rig, which runs a real copy of the app",
    "__pycache__/": "compiled modules - 62e2105 committed nine of them",
    "*.pyc": "the same, one file at a time",
}
# A .gitignore that lost most of itself would still satisfy a lenient check.
FLOOR = 12

FAKE_REFRESH = "AQD-fake-refresh-token-for-this-test-only-0123456789"
FAKE_ACCESS = "BQC-fake-access-token-for-this-test-only-9876543210"


def patterns():
    with open(IGNORE, encoding="utf-8") as fh:
        lines = [l.strip() for l in fh.read().splitlines()]
    return [l for l in lines if l and not l.startswith("#")]


def seeded_account(cache_dir):
    """A SpotifyAccount that believes it is signed in, against a temp folder.
    Its constructor touches no network, and _load() shrugs at a missing file."""
    acct = spotify_api.SpotifyAccount(cache_dir, "http://127.0.0.1:8713/spotify/callback")
    acct.configure("a-client-id-that-is-not-secret")
    acct._token = {"refresh_token": FAKE_REFRESH, "access_token": FAKE_ACCESS,
                   "expires_at": time.time() + 3600}
    return acct


class TheRoadStaysShut(unittest.TestCase):
    def test_every_pattern_that_keeps_a_secret_out_is_still_there(self):
        have = set(patterns())
        missing = [f"{pat}  ({why})" for pat, why in sorted(REQUIRED.items()) if pat not in have]
        self.assertEqual(missing, [], "\n.gitignore no longer excludes:\n" + "\n".join(missing))

    def test_the_ignore_file_was_not_gutted(self):
        """A file trimmed to a couple of lines would pass a per-pattern check
        that only looked for what it expected to find."""
        found = patterns()
        self.assertGreaterEqual(
            len(found), FLOOR,
            f".gitignore carries only {len(found)} patterns, under the {FLOOR} floor")

    def test_that_check_can_actually_fail(self):
        """The control. If a pattern nobody wrote reads as present, the test
        above is agreeing with itself rather than reading the file."""
        self.assertNotIn("definitely-not-a-real-ignore-pattern-xyz/", set(patterns()))


class TheCargoStaysIn(unittest.TestCase):
    def test_no_spotify_token_escapes_what_the_module_hands_out(self):
        """peek_queue() and peek_devices() ride the state broadcast to every
        open window, so a token in either would be on every page at once."""
        with tempfile.TemporaryDirectory() as tmp:
            acct = seeded_account(tmp)
            # Anti-vacuity: prove the token really is in there, or "not found
            # in the outputs" would be true of an empty object too.
            self.assertTrue(acct.connected(), "the fake token did not take")
            self.assertIn(FAKE_REFRESH, json.dumps(acct._token))

            surfaces = {
                "peek_queue()": acct.peek_queue(),
                "peek_devices()": acct.peek_devices(),
                "queue()": acct.queue(),
                "devices()": acct.devices(),
                "connected()": acct.connected(),
                "cooling_for()": acct.cooling_for(),
                "cooling_reason()": acct.cooling_reason(),
                "repr()": repr(acct),
            }
            leaked = sorted({name for name, value in surfaces.items()
                             if any(secret in json.dumps(value, default=str)
                                    for secret in (FAKE_REFRESH, FAKE_ACCESS))})
            # Named, never quoted. assertNotIn prints the needle and the
            # haystack, so on the day this catches a real token it would paste
            # that token into the terminal and into any log the run is kept in.
            # A test against exposure must not be the thing that exposes.
            self.assertEqual(leaked, [],
                             "these hand the token out: " + ", ".join(leaked))

    def test_the_token_is_written_only_inside_its_own_cache_folder(self):
        """The path the file takes matters as much as its contents: written
        somewhere the repository can see, .gitignore would never get a say."""
        with tempfile.TemporaryDirectory() as tmp:
            acct = seeded_account(tmp)
            self.assertTrue(os.path.abspath(acct.token_path).startswith(os.path.abspath(tmp)))
            self.assertEqual(os.path.basename(acct.token_path), "spotify_token.json")
            acct._save()
            self.assertTrue(os.path.exists(acct.token_path))
            # And the name it lands under is one .gitignore already refuses.
            self.assertIn("spotify_token.json", set(patterns()))


if __name__ == "__main__":
    unittest.main()
