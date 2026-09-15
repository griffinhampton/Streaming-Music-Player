"""T6: TikTok gifts, from the live page's own websocket (webcast.py).

The frames here are built by hand, field by field, in the shape a real live
page received on 2026-09-15 - the same field numbers webcast.py reads, checked
then against real frames. No real frame is kept in the repository: they carry
other people's names and messages.
"""
import base64
import gzip
import itertools
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import webcast  # noqa: E402


def vint(n):
    out = bytearray()
    while True:
        b, n = n & 0x7F, n >> 7
        out.append(b | 0x80 if n else b)
        if not n:
            return bytes(out)


def I(f, n):
    return vint(f << 3) + vint(n)


def B(f, v):
    v = v.encode("utf-8") if isinstance(v, str) else v
    return vint(f << 3 | 2) + vint(len(v)) + v


def M(*parts):
    return b"".join(parts)


def user(uid, name, handle=""):
    return M(I(1, uid), B(3, name), B(38, handle) if handle else b"")


AMY = user(101, "Amy", "amy")


def gift_payload(gid=5655, name="Rose", coins=1, streak=True, count=1, end=False, group=11, frm=AMY, to=None):
    return M(B(1, M(B(1, "WebcastGiftMessage"))), I(2, gid), I(5, count), B(7, frm),
             B(8, to) if to else b"", I(9, 1) if end else b"", I(11, group) if group else b"",
             B(15, M(I(5, gid), I(11, 1 if streak else 0), I(12, coins), B(16, name))))


_ids = itertools.count(7000)


def wrap(method, payload, history=False, mid=None):
    return M(B(1, method), B(2, payload), I(3, next(_ids) if mid is None else mid), I(6, 1) if history else b"")


def push(msgs, kind="msg", gz=True):
    body = M(*[B(1, m) for m in msgs])
    return M(I(1, 1), B(5, M(B(1, "compress_type"), B(2, "gzip"))), B(6, "pb"), B(7, kind),
             B(8, gzip.compress(body) if gz else body))


def gift_frame(history=False, mid=None, **kw):
    return push([wrap(webcast.GIFT, gift_payload(**kw), history=history, mid=mid)])


def b64(raw):
    return base64.b64encode(raw).decode()


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class TheWire(unittest.TestCase):
    def test_what_it_reads(self):
        raw = M(I(1, 300), B(2, "hi"), vint(3 << 3 | 5) + (7).to_bytes(4, "little"),
                vint(4 << 3 | 1) + (9).to_bytes(8, "little"))
        self.assertEqual(webcast.fields(raw), [(1, 0, 300), (2, 2, b"hi"), (3, 5, 7), (4, 1, 9)])

    def test_anything_malformed_is_refused(self):
        for bad in (bytes([0x08]),                         # a number with no bytes
                    bytes([0x08] + [0xFF] * 11),            # a number of eleven bytes
                    B(1, "abc")[:-1],                       # a length past the end
                    bytes([0x0B]), bytes([0x0C]),           # group wire types
                    bytes([0x07]), bytes([0x00, 0x00]),     # field 0
                    bytes([0x0D, 1, 2])):                   # a fixed32 cut short
            with self.assertRaises(webcast.Bad, msg=bad):
                webcast.fields(bad)

    def test_random_and_damaged_bytes_never_get_past_bad(self):
        """The bytes come off the network. Whatever they are, the only way out
        of the decoder is an answer or Bad - never another exception, which
        would end the reader."""
        rnd = random.Random(1509)
        good = gift_frame(count=3, end=True)
        plain = push([wrap(webcast.GIFT, gift_payload())], gz=False)
        for i in range(3000):
            if i % 3 == 0:
                raw = bytes(rnd.randrange(256) for _ in range(rnd.randrange(80)))
            else:
                raw = bytearray(good if i % 3 == 1 else plain)
                for _ in range(rnd.randrange(1, 6)):
                    raw[rnd.randrange(len(raw))] = rnd.randrange(256)
                raw = bytes(raw[:rnd.randrange(1, len(raw) + 1)] if i % 7 == 0 else raw)
            try:
                for method, payload, _mid, _history in webcast.messages(raw):
                    if method == webcast.GIFT:
                        webcast.gift(payload)
            except webcast.Bad:
                pass

    def test_a_gzip_bomb_is_refused(self):
        bomb = gzip.compress(bytes(webcast.MAX_INFLATED + 1))
        self.assertLess(len(bomb), 10000)
        with self.assertRaises(webcast.Bad):
            webcast.messages(M(B(7, "msg"), B(8, bomb)))


class TheFrames(unittest.TestCase):
    def test_a_frame_in_the_shape_the_real_page_received(self):
        raw = push([wrap("WebcastChatMessage", b"x"), wrap(webcast.GIFT, gift_payload(count=3, end=True), mid=42)])
        ms = webcast.messages(raw)
        self.assertEqual([m[0] for m in ms], ["WebcastChatMessage", webcast.GIFT])
        self.assertEqual((ms[1][2], ms[1][3]), (42, False))
        g = webcast.gift(ms[1][1])
        self.assertEqual((g["id"], g["name"], g["coins"], g["streak"], g["count"], g["end"], g["group"]),
                         (5655, "Rose", 1, True, 3, True, 11))
        self.assertEqual(g["user"], {"id": 101, "name": "Amy", "handle": "amy"})
        self.assertEqual(g["to"], "")

    def test_an_uncompressed_body_reads_the_same(self):
        ms = webcast.messages(push([wrap(webcast.GIFT, gift_payload())], gz=False))
        self.assertEqual(webcast.gift(ms[0][1])["name"], "Rose")

    def test_heartbeats_acks_and_the_join_reply_carry_nothing(self):
        for kind in ("hb", "ack", "im_enter_room_resp", ""):
            self.assertEqual(webcast.messages(gift_frame_kind(kind)), [], kind)

    def test_history_is_marked(self):
        ms = webcast.messages(push([wrap(webcast.GIFT, gift_payload(), history=True)]))
        self.assertTrue(ms[0][3])

    def test_a_handle_that_is_not_a_handle_is_dropped(self):
        for bad in ("Not A Handle", "x", "a" * 30, "<img>"):
            self.assertEqual(webcast.user(user(1, "Amy", bad))["handle"], "", bad)
        self.assertEqual(webcast.user(user(1, "Amy", "Some.User_1"))["handle"], "some.user_1")

    def test_a_gift_with_no_id_is_nothing(self):
        self.assertIsNone(webcast.gift(M(I(5, 3))))


def gift_frame_kind(kind):
    return push([wrap(webcast.GIFT, gift_payload(streak=False))], kind=kind)


class TheStreaks(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.c = webcast.Combos(self.clock)

    def g(self, **kw):
        return webcast.gift(gift_payload(**kw))

    def test_a_streak_is_one_gift_at_its_end_with_its_total(self):
        for n in range(1, 6):
            self.assertEqual(self.c.add(self.g(count=n)), [], n)
        self.assertEqual([x["count"] for x in self.c.add(self.g(count=5, end=True))], [5])

    def test_the_streak_as_really_recorded(self):
        """2026-09-15: a Rose streak of one - a message with the total, then
        another with the same total and the end flag. One Rose, not two."""
        self.assertEqual(self.c.add(self.g(count=1)), [])
        self.assertEqual([x["count"] for x in self.c.add(self.g(count=1, end=True))], [1])

    def test_a_one_off_is_at_once(self):
        self.assertEqual(len(self.c.add(self.g(streak=False))), 1)

    def test_an_end_that_never_comes(self):
        for n in (1, 2, 3):
            self.c.add(self.g(count=n))
        self.clock.t += webcast.Combos.QUIET - 1
        self.assertEqual(self.c.due(), [])
        self.clock.t += 1.5
        self.assertEqual([x["count"] for x in self.c.due()], [3])
        self.assertEqual(self.c.due(), [])

    def test_a_late_message_after_the_end_is_not_a_second_gift(self):
        self.c.add(self.g(count=2))
        self.c.add(self.g(count=2, end=True))
        self.assertEqual(self.c.add(self.g(count=3)), [])
        self.clock.t += 60
        self.assertEqual(self.c.due(), [])

    def test_a_total_never_goes_back(self):
        self.c.add(self.g(count=4))
        self.assertEqual([x["count"] for x in self.c.add(self.g(count=2, end=True))], [4])

    def test_two_streaks_by_one_person_are_two_gifts(self):
        self.c.add(self.g(count=2, end=True, group=1))
        self.assertEqual(len(self.c.add(self.g(count=2, end=True, group=2))), 1)

    def test_without_a_streak_id_a_new_streak_is_not_mistaken_for_a_late_one(self):
        self.c.add(self.g(count=2, end=True, group=0))
        self.assertEqual(len(self.c.add(self.g(count=1, end=True, group=0))), 1)

    def test_too_many_open_streaks_finish_the_oldest(self):
        fired = []
        for grp in range(1, webcast.Combos.MAX_OPEN + 3):
            fired += self.c.add(self.g(count=1, group=grp))
        self.assertEqual([x["group"] for x in fired], [1, 2])
        self.assertEqual(len(self.c.open), webcast.Combos.MAX_OPEN)


class TheRoom(unittest.TestCase):
    WS = "wss://webcast-ws.us.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/?room=1"
    DM = "wss://im-ws.tiktok.com/ws/v2?x=1"

    def room(self):
        r = webcast.Room("probe", clock=Clock())
        r.opened("1", self.WS)
        r.opened("2", self.DM)
        return r

    def test_the_one_socket_it_reads(self):
        for url, ok in ((self.WS, True), ("wss://webcast16-ws-useast1a.tiktok.com/webcast/im/push/", True),
                        (self.DM, False), ("wss://webcast-ws.us.tiktok.com/ws/v2", False),
                        ("wss://webcast-ws.tiktok.com.evil.example/webcast/im/", False),
                        ("wss://evil.example/webcast/im/", False), ("wss://tiktok.com/webcast/im/", False),
                        ("ws://webcast-ws.us.tiktok.com/webcast/im/", False),
                        ("ws://127.0.0.1:6791/webcast/im/x", False), ("", False), ("nonsense", False),
                        ("wss://[::1/webcast/im/", False)):
            self.assertEqual(webcast.is_webcast(url), ok, url)
        self.assertTrue(webcast.is_webcast("ws://127.0.0.1:6791/webcast/im/x", allow_local=True))
        self.assertFalse(webcast.is_webcast("ws://10.0.0.2/webcast/im/x", allow_local=True))
        self.assertFalse(webcast.is_webcast("ws://127.0.0.1:6791/ws/v2", allow_local=True))

    def test_a_gift_on_the_room_socket_arrives_as_post_gift_takes_it(self):
        out = self.room().frame("1", 2, b64(gift_frame(streak=False, coins=5)))
        self.assertEqual(out, [{"user": "Amy", "handle": "amy", "gift": "Rose", "count": 1, "coins": 5}])

    def test_the_other_sockets_are_never_read(self):
        """The control. im-ws is TikTok's messaging socket: on a signed-in
        page, private messages. Its frames are not decoded at all."""
        r = self.room()
        self.assertEqual(r.frame("2", 2, b64(gift_frame(streak=False))), [])
        self.assertEqual(r.frame("never-opened", 2, b64(gift_frame(streak=False))), [])
        self.assertEqual((r.frames, r.bad, r.gifts), (0, 0, 0))

    def test_history_is_not_replayed(self):
        self.assertEqual(self.room().frame("1", 2, b64(gift_frame(streak=False, history=True))), [])

    def test_the_same_message_twice_is_one_gift(self):
        r = self.room()
        frame = b64(gift_frame(streak=False, mid=99))
        self.assertEqual(len(r.frame("1", 2, frame) + r.frame("1", 2, frame)), 1)

    def test_a_gift_to_a_guest_is_not_the_hosts(self):
        r = self.room()
        self.assertEqual(r.frame("1", 2, b64(gift_frame(streak=False, to=user(9, "Guest", "someguest")))), [])
        self.assertEqual(len(r.frame("1", 2, b64(gift_frame(streak=False, to=user(8, "Me", "probe"))))), 1)

    def test_bad_frames_are_counted_and_the_next_good_one_still_arrives(self):
        r = self.room()
        for opcode, data in ((2, "!!not base64"), (2, b64(bytes([0x0B, 1, 2]))), (1, "hello"),
                             (2, b64(M(B(7, "msg"), B(8, gzip.compress(bytes(webcast.MAX_INFLATED + 1))))))):
            self.assertEqual(r.frame("1", opcode, data), [])
        self.assertEqual(r.bad, 3)
        self.assertEqual(len(r.frame("1", 2, b64(gift_frame(streak=False)))), 1)

    def test_coins_are_the_total(self):
        r = self.room()
        r.frame("1", 2, b64(gift_frame(coins=5, count=9)))
        out = r.frame("1", 2, b64(gift_frame(coins=5, count=10, end=True)))
        self.assertEqual((out[0]["count"], out[0]["coins"]), (10, 50))

    def test_a_closed_socket_is_forgotten(self):
        r = self.room()
        r.closed("1")
        self.assertEqual(r.frame("1", 2, b64(gift_frame(streak=False))), [])


if __name__ == "__main__":
    unittest.main()
