"""Unit tests for the TikTok tab's plumbing (tiktok_live.py).

The request shapes came across from the standalone key generator unchanged;
what is new is the library carrying them, so what is tested here is the
translation and nothing else - the multipart body /stream/start wants, reading
an error body the way requests did, and never letting a key reach a log.

The calls out to Streamlabs and the DPAPI vault are not exercised: one needs
the internet, the other needs Windows.

    python -m unittest discover -s music-deck/tests -v
"""
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import tiktok_live


class Multipart(unittest.TestCase):
    """The body requests built from files=(...), built by hand."""

    FIELDS = (("title", "My stream"), ("device_platform", "win32"),
              ("category", "7241"), ("audience_type", "0"))

    def setUp(self):
        self.body, self.content_type = tiktok_live.Stream._multipart(self.FIELDS)
        self.text = self.body.decode("utf-8")
        self.boundary = self.content_type.split("boundary=")[1]

    def test_content_type_names_the_boundary(self):
        self.assertTrue(self.content_type.startswith("multipart/form-data; boundary="))
        self.assertIn(self.boundary, self.text)

    def test_one_part_per_field_in_order(self):
        names = [line.split('name="')[1].rstrip('"')
                 for line in self.text.splitlines() if "Content-Disposition" in line]
        self.assertEqual(names, [n for n, _ in self.FIELDS])

    def test_no_filename_and_no_part_content_type(self):
        # files=((name, (None, value)),) sends neither; the API expects neither.
        self.assertNotIn("filename=", self.text)
        self.assertNotIn("Content-Type:", self.text)

    def test_values_survive_and_the_body_closes(self):
        for _name, value in self.FIELDS:
            self.assertIn(f"\r\n\r\n{value}\r\n", self.text)
        self.assertTrue(self.text.endswith(f"--{self.boundary}--\r\n"))

    def test_a_value_with_quotes_and_newlines_does_not_break_a_part(self):
        body, ct = tiktok_live.Stream._multipart((("title", 'a "quoted"\nline'),))
        boundary = ct.split("boundary=")[1]
        self.assertEqual(body.decode().count(f"--{boundary}"), 2)   # one part, one close


class ErrorBodies(unittest.TestCase):
    """urllib raises where requests returned the body; the body is what says
    what went wrong, so it is read either way."""

    def _request(self, status, payload):
        raw = json.dumps(payload).encode()
        if status == 200:
            ok = mock.MagicMock()
            ok.read.return_value = raw
            ok.__enter__.return_value = ok
            return mock.patch.object(tiktok_live.urllib.request, "urlopen", return_value=ok)
        err = urllib.error.HTTPError("u", status, "err", {}, io.BytesIO(raw))
        return mock.patch.object(tiktok_live.urllib.request, "urlopen", side_effect=err)

    def test_a_200_is_parsed(self):
        with self._request(200, {"ok": True}):
            self.assertEqual(tiktok_live._json_request(mock.Mock()), {"ok": True})

    def test_a_500_is_parsed_rather_than_raised(self):
        with self._request(500, {"message": "category too long"}):
            got = tiktok_live._json_request(mock.Mock())
        self.assertEqual(got["message"], "category too long")

    def test_start_without_a_stream_says_why(self):
        stream = tiktok_live.Stream("t")
        with mock.patch.object(stream, "_post", return_value={"message": "not eligible"}):
            with self.assertRaises(tiktok_live.TikTokError) as caught:
                stream.start("t", "c")
        self.assertIn("not eligible", str(caught.exception))


class Redaction(unittest.TestCase):
    """A failure is worth reading and worth pasting; it must carry no key."""

    def test_key_rtmp_and_token_are_hidden(self):
        out = tiktok_live._redact({"key": "SECRETKEY", "rtmp": "rtmp://ingest/x",
                                   "token": "abc123", "message": "kept"})
        for secret in ("SECRETKEY", "rtmp://ingest/x", "abc123"):
            self.assertNotIn(secret, out)
        self.assertIn("kept", out)

    def test_something_unserialisable_still_redacts(self):
        self.assertIsInstance(tiktok_live._redact(object()), str)

    def test_it_stays_short_enough_to_show(self):
        self.assertLessEqual(len(tiktok_live._redact({"message": "x" * 2000})), 400)


class Searching(unittest.TestCase):
    def test_other_is_offered_and_long_names_are_cut(self):
        stream = tiktok_live.Stream("t")
        seen = {}

        def fake_get(url):
            seen["url"] = url
            return {"categories": [{"full_name": "A Game", "game_mask_id": "1"}]}

        with mock.patch.object(stream, "_get", fake_get):
            cats = stream.search("x" * 40)
        # 25 characters, or the API answers 500.
        self.assertIn("category=" + "x" * 25, seen["url"])
        self.assertEqual(cats[-1], {"full_name": "Other", "game_mask_id": ""})

    def test_no_game_asks_nothing(self):
        stream = tiktok_live.Stream("t")
        with mock.patch.object(stream, "_get", side_effect=AssertionError("should not ask")):
            self.assertEqual(stream.search(""), [])


class Session(unittest.TestCase):
    """The Server URL and key come back together when the live opens, and that
    is the only place either exists - the token kept on this PC holds neither.
    So: kept while the live is open, gone when it ends, never on a status poll.

    The vault is not touched here; a session is put in by hand, which is what
    lets this run anywhere rather than only on Windows."""

    URL, KEY = "rtmp://ingest.tiktok/live", "SECRETKEY"

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.bridge = tiktok_live.TikTokBridge(tmp.name)
        stream = tiktok_live.Stream("t")
        stream.start = lambda *_a, **_k: (self.URL, self.KEY)
        stream.end = lambda: True
        stream.id = "42"
        self.bridge._stream = stream
        self.bridge.category_id = lambda _name: ""

    def test_start_keeps_both_halves_of_the_payload(self):
        res = self.bridge.start("My stream", "")
        self.assertEqual((res["url"], res["key"]), (self.URL, self.KEY))
        self.assertEqual(self.bridge.reveal(), {"ok": True, "url": self.URL, "key": self.KEY})

    def test_status_carries_the_address_but_never_the_key(self):
        self.bridge.start("My stream", "")
        status = self.bridge.status()
        self.assertEqual(status["url"], self.URL)
        self.assertTrue(status["has_session_key"])
        self.assertNotIn(self.KEY, json.dumps(status))

    def test_ending_the_live_wipes_the_pair(self):
        self.bridge.start("My stream", "")
        self.bridge.end()
        self.assertFalse(self.bridge.reveal()["ok"])
        self.assertEqual(self.bridge.status()["url"], "")
        self.assertFalse(self.bridge.status()["has_session_key"])

    def test_forgetting_the_token_takes_the_pair_with_it(self):
        self.bridge.start("My stream", "")
        self.bridge.forget()
        self.assertFalse(self.bridge.reveal()["ok"])

    def test_nothing_to_reveal_before_a_live_opens(self):
        self.assertFalse(self.bridge.reveal()["ok"])


if __name__ == "__main__":
    unittest.main()
