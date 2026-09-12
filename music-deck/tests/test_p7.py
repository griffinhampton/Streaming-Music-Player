"""The Canvas Builder (P7) saves a scene many times a minute. The scene
store's backups are for going back minutes, so they rotate at most once per
`backup_every` seconds instead of on every save."""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import scenes  # noqa: E402


class BackupThrottle(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.store = scenes.SceneStore(self.dir)
        self.store.backup_every = 3600
        self.sid = self.store.create("Throttle")["id"]

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def backup(self, n):
        path = os.path.join(self.dir, f"{self.sid}.json.{n}")
        if not os.path.isfile(path):
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def save(self, name):
        scene = self.store.get(self.sid)
        scene["name"] = name
        return self.store.save(scene, expect_rev=scene["rev"])

    def test_rapid_saves_do_not_push_the_backups_out(self):
        first = self.save("one")                     # makes backup 1 (there was none)
        kept = self.backup(1)
        for k in range(8):
            self.save(f"typing {k}")
        self.assertEqual(self.backup(1), kept, "backup 1 is still the one from before the burst")
        self.assertIsNone(self.backup(2), "no rotation inside the interval")
        self.assertEqual(self.store.get(self.sid)["rev"], first["rev"] + 8, "every save still lands")

    def test_an_old_backup_rotates_on_the_next_save(self):
        self.save("one")
        b1 = os.path.join(self.dir, f"{self.sid}.json.1")
        old = time.time() - 7200
        os.utime(b1, (old, old))
        before = self.store.get(self.sid)["rev"]
        self.save("two")
        self.assertEqual(self.backup(2)["rev"], self.backup(1)["rev"] - 1 if self.backup(1) else None)
        self.assertEqual(self.backup(1)["rev"], before, "the version just replaced is the newest backup")

    def test_zero_keeps_one_backup_per_save(self):
        self.store.backup_every = 0
        for k in range(3):
            self.save(f"save {k}")
        revs = [self.backup(n)["rev"] for n in (1, 2, 3)]
        self.assertEqual(revs, sorted(revs, reverse=True))
        self.assertEqual(revs[0], self.store.get(self.sid)["rev"] - 1)


if __name__ == "__main__":
    unittest.main()
