"""
Time-synced lyrics for whatever is on screen.

Sources, in order:
  1. an .lrc file sitting next to a local track (same name, .lrc extension) -
     fully offline
  2. lrclib.net, a free lyrics database that needs no account or key - only
     when "online lookup" is switched on in the deck

Every lookup runs on its own thread and the answer is cached on disk, so the
server never stalls and a song is only ever looked up once.
"""

import hashlib
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request

LRC_STAMP = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
USER_AGENT = "StreamingDeck/1.0 (local streaming overlay)"
LRCLIB = "https://lrclib.net/api"


def parse_lrc(text):
    """'[01:23.45] words' lines -> [{t: seconds, text}] sorted by time."""
    lines = []
    for raw in (text or "").splitlines():
        stamps = LRC_STAMP.findall(raw)
        if not stamps:
            continue
        body = LRC_STAMP.sub("", raw).strip()
        for minutes, seconds in stamps:
            lines.append({"t": round(int(minutes) * 60 + float(seconds), 2), "text": body})
    lines.sort(key=lambda line: line["t"])
    return lines


def _norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())


class Lyrics:
    def __init__(self, cache_dir):
        self.folder = os.path.join(cache_dir, "lyrics")
        os.makedirs(self.folder, exist_ok=True)
        self._mem = {}
        self._inflight = set()
        self._lock = threading.Lock()

    # ------------------------------------------------------------- keys

    @staticmethod
    def key_for(title, artist, duration):
        base = f"{_norm(artist)}|{_norm(title)}|{int(round(duration or 0))}"
        return hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]

    def _cache_path(self, key):
        return os.path.join(self.folder, key + ".json")

    # ------------------------------------------------------------- public

    def get(self, title, artist, album="", duration=0, path=None, online=True):
        """Current answer for this track. Kicks off a lookup if there is none
        yet and reports 'loading' until it lands."""
        if not title:
            return {"status": "none", "reason": "nothing playing"}
        key = self.key_for(title, artist, duration)

        with self._lock:
            hit = self._mem.get(key)
        if hit is None:
            hit = self._load_disk(key)
            if hit:
                with self._lock:
                    self._mem[key] = hit
        if hit:
            # A "none" answer found while offline should be retried once
            # online lookup is enabled.
            if not (hit.get("status") == "none" and online and hit.get("offline")):
                return dict(hit, key=key)

        with self._lock:
            if key in self._inflight:
                return {"status": "loading", "key": key}
            self._inflight.add(key)
        threading.Thread(target=self._lookup, daemon=True,
                         args=(key, title, artist, album, duration, path, online)).start()
        return {"status": "loading", "key": key}

    # ------------------------------------------------------------- lookup

    def _lookup(self, key, title, artist, album, duration, path, online):
        result = None
        try:
            result = self._from_file(path)
            if result is None and online:
                result = self._from_lrclib(title, artist, album, duration)
            if result is None:
                result = {"status": "none", "reason": "no lyrics found",
                          "offline": not online}
        except Exception as exc:
            result = {"status": "none", "reason": f"lookup failed: {exc}",
                      "offline": not online}
        result["title"] = title
        result["artist"] = artist
        result["fetched"] = time.time()
        with self._lock:
            self._mem[key] = result
            self._inflight.discard(key)
        self._save_disk(key, result)

    def _from_file(self, path):
        if not path:
            return None
        stem = os.path.splitext(path)[0]
        for candidate in (stem + ".lrc", stem + ".LRC"):
            if os.path.isfile(candidate):
                with open(candidate, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()
                lines = parse_lrc(text)
                if lines:
                    return {"status": "synced", "source": "file", "lines": lines}
                plain = "\n".join(l for l in text.splitlines() if l.strip())
                if plain:
                    return {"status": "plain", "source": "file", "plain": plain}
        return None

    def _from_lrclib(self, title, artist, album, duration):
        def fetch(url):
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=8) as r:
                return json.loads(r.read().decode("utf-8"))

        query = {"track_name": title, "artist_name": artist}
        if album:
            query["album_name"] = album
        if duration:
            query["duration"] = int(round(duration))

        record = None
        try:
            record = fetch(f"{LRCLIB}/get?" + urllib.parse.urlencode(query))
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
        if record is None:
            # Loosen up: same title and artist, any album or length.
            hits = fetch(f"{LRCLIB}/search?" + urllib.parse.urlencode(
                {"track_name": title, "artist_name": artist}))
            hits = [h for h in hits if h.get("syncedLyrics") or h.get("plainLyrics")]
            if not hits:
                return None
            # Prefer synced, and the closest running time.
            hits.sort(key=lambda h: (0 if h.get("syncedLyrics") else 1,
                                     abs((h.get("duration") or 0) - (duration or 0))))
            record = hits[0]

        if record.get("instrumental"):
            return {"status": "instrumental", "source": "lrclib"}
        synced = parse_lrc(record.get("syncedLyrics") or "")
        if synced:
            return {"status": "synced", "source": "lrclib", "lines": synced}
        plain = (record.get("plainLyrics") or "").strip()
        if plain:
            return {"status": "plain", "source": "lrclib", "plain": plain}
        return None

    # ------------------------------------------------------------- disk

    def _load_disk(self, key):
        try:
            with open(self._cache_path(key), "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def _save_disk(self, key, result):
        try:
            with open(self._cache_path(key), "w", encoding="utf-8") as f:
                json.dump(result, f)
        except Exception:
            pass

    def forget(self, key):
        """Drop a cached answer so the next request looks it up again."""
        with self._lock:
            self._mem.pop(key, None)
        try:
            os.remove(self._cache_path(key))
        except Exception:
            pass
