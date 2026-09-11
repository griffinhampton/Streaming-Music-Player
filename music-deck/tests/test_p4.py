"""The Go LIVE engine (P4): presets, the FLV/AMF bits, the queue policy,
reconnect and the rotated-key case - no network, no devices."""
import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import live   # noqa: E402

try:
    import audio   # noqa: E402
except OSError:    # no Media Foundation on this machine
    audio = None


def wait_for(pred, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


class FakeClient:
    """Stands in for RtmpClient: each connect does what `plan` says next."""
    plan = []
    made = []

    def __init__(self, url, key, log=None):
        self.url, self.key = url, key
        self.alive = False
        self.error = ""
        self.bytes_out = 0
        FakeClient.made.append(self)

    def connect_publish(self, timeout=10):
        step = FakeClient.plan.pop(0) if FakeClient.plan else "ok"
        if step != "ok":
            raise live.RtmpError(step)
        self.alive = True

    def send_metadata(self, meta):
        self.bytes_out += 10

    def send_video(self, ts, body):
        self.bytes_out += len(body)

    def send_audio(self, ts, body):
        self.bytes_out += len(body)

    def tcp_info(self):
        return None

    def close(self, polite=True):
        self.alive = False


class Presets(unittest.TestCase):
    def test_table_matches_live_studio_shape(self):
        order = ["1080p60", "1080p30", "720p60", "720p30", "480p30"]
        self.assertEqual(list(live.PRESETS), order)
        last = None
        for key in order:
            p = live.PRESETS[key]
            self.assertEqual(set(p), {"width", "height", "fps", "kbps", "hevc_kbps"})
            self.assertAlmostEqual(p["width"] / p["height"], 16 / 9, places=1, msg=key)
            self.assertIn(p["fps"], (30, 60))
            self.assertGreater(p["kbps"], p["hevc_kbps"], "HEVC needs fewer bits")
            if last is not None:
                self.assertGreaterEqual(last, p["kbps"], "lower presets do not cost more")
            last = p["kbps"]
        self.assertEqual(live.AUDIO_KBPS, 128)


class Wire(unittest.TestCase):
    def test_amf0_round_trip(self):
        payload = (live.amf_encode("connect") + live.amf_encode(1) + live.amf_encode({"app": "live", "n": 2.5})
                   + live.amf_encode(None) + live.amf_encode(True) + live.amf_encode(["a", 3])
                   + live.amf_encode(live.EcmaArray({"width": 1920})))
        self.assertEqual(live.amf_decode(payload),
                         ["connect", 1.0, {"app": "live", "n": 2.5}, None, True, ["a", 3.0], {"width": 1920.0}])

    def test_flv_tag_bodies(self):
        self.assertEqual(live.video_tag(True, 1, b"nal"), b"\x17\x01\x00\x00\x00nal")
        self.assertEqual(live.video_tag(False, 1, b"nal")[0], 0x27)
        self.assertEqual(live.video_tag(True, 0, b"avcC")[:2], b"\x17\x00")
        self.assertEqual(live.audio_tag(1, b"aac"), b"\xaf\x01aac")
        self.assertEqual(live.audio_tag(0, b"\x11\x90"), b"\xaf\x00\x11\x90")

    def test_audio_specific_config(self):
        self.assertEqual(live.audio_specific_config(48000, 2), bytes.fromhex("1190"))
        self.assertEqual(live.audio_specific_config(44100, 2), bytes.fromhex("1210"))
        self.assertEqual(live.audio_specific_config(48000, 1), bytes.fromhex("1188"))

    def test_fatal_errors_are_the_ones_a_retry_cannot_fix(self):
        for text in ("NetStream.Publish.BadName", "NetStream.Publish.Rejected", "Unauthorized",
                     "the server refused the stream", "no stream key", "not an RTMP server"):
            self.assertTrue(live._is_fatal(text), text)
        for text in ("connection lost", "the server closed the connection", "timed out",
                     "[WinError 10061] No connection could be made because the target machine actively refused it"):
            self.assertFalse(live._is_fatal(text), text)


class Engine(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="deck-p4-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_needs_a_url_and_a_key(self):
        eng = live.LiveEngine(self.dir)
        res = eng.start("", "")
        self.assertFalse(res["ok"])
        self.assertIn("needed", res["error"])
        self.assertEqual(eng.state, "idle")
        self.assertFalse(eng.status()["has_key"])

    def test_queue_drops_a_plain_video_frame_before_anything_else(self):
        eng = live.LiveEngine(self.dir)
        eng.push(live.K_AUDIO, 0, 0, b"a")
        for i in range(live.QUEUE_MAX - 1):
            eng.push(live.K_VIDEO, i, 0, b"v")
        eng.push(live.K_VIDEO, 999, 1, b"key")
        self.assertEqual(eng.stats["dropped"], 1)
        self.assertEqual(eng.status()["stats"]["queue"], live.QUEUE_MAX)
        self.assertEqual(eng._q[0], (live.K_AUDIO, 0, 0, b"a"), "audio is never the first to go")
        self.assertEqual(eng._q[-1][3], b"key")

    def test_meta_merges_from_video_and_audio_senders(self):
        eng = live.LiveEngine(self.dir)
        eng.push(live.K_META, 0, 0, b'{"width": 1920, "framerate": 30}')
        eng.push(live.K_META, 0, 0, b'{"audiocodecid": 10}')
        self.assertEqual(eng.meta, {"width": 1920, "framerate": 30, "audiocodecid": 10})

    def test_reconnect_forces_a_keyframe_and_a_rotated_key_is_final(self):
        with mock.patch.object(live, "RtmpClient", FakeClient):
            FakeClient.plan = ["ok", "ok", "NetStream.Publish.BadName"]
            FakeClient.made = []
            eng = live.LiveEngine(self.dir)
            forced = []
            eng.on_reconnect = lambda: forced.append(1)
            self.assertTrue(eng.start("rtmp://example.invalid/live", "secret-key", preset="1080p30")["ok"])
            self.assertEqual(eng.preset, "1080p30")
            self.assertTrue(wait_for(lambda: eng.state == "live"), eng.state)
            self.assertEqual(forced, [], "no keyframe forced on the first connect")
            # The server drops us: back on the air after one retry, keyframe forced.
            FakeClient.made[-1].error = "connection lost"
            FakeClient.made[-1].alive = False
            self.assertTrue(wait_for(lambda: eng.state == "live" and eng.stats["reconnects"] == 1), eng.state)
            self.assertEqual(forced, [1])
            self.assertEqual(len(FakeClient.made), 2)
            # Dropped again, and this time the key is refused: final, with the hint.
            FakeClient.made[-1].alive = False
            self.assertTrue(wait_for(lambda: eng.state == "failed"), eng.state)
            self.assertTrue(eng.error.startswith(live.KEY_ROTATED_HINT), eng.error)
            self.assertIn("BadName", eng.error)
            for report in (eng.status(), eng.snapshot_status()):
                self.assertNotIn("key", report)
                self.assertNotIn("secret-key", str(report))
            eng.stop()
            self.assertEqual(eng.state, "idle")


@unittest.skipIf(audio is None, "Media Foundation is not available here")
class Mixer(unittest.TestCase):
    def test_gain_and_mute_are_clamped_and_reported(self):
        mix = audio.AudioMixer(engine=None, mic=True, system=False)
        mix.set("mic", gain=9)
        mix.set("system", gain=-1, mute=True)
        mix.set("nope", gain=2)
        st = mix.status()
        self.assertFalse(st["running"])
        self.assertEqual(st["gain"], {"mic": 4.0, "system": 0.0})
        self.assertEqual(st["mute"], {"mic": False, "system": True})
        self.assertEqual(st["kbps"], 128)


if __name__ == "__main__":
    unittest.main()
