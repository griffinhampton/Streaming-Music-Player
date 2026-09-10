"""
Spotify through its own Web API - optional.

The Windows media-session bridge already covers the desktop app. This adds the
cases it cannot see - playback on a phone, the web player or a Spotify Connect
speaker - and lets the deck drive playback anywhere it is happening.

It uses the PKCE flow, so there is no client secret to protect: make a free app
at developer.spotify.com, give it the redirect URI the deck shows, paste the
Client ID, press Connect. Tokens live in cache/spotify_token.json on this PC
and nowhere else.
"""

import base64
import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API = "https://api.spotify.com/v1"
SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing"

# Album art is only ever fetched from Spotify's own image hosts.
ART_HOSTS = {"i.scdn.co", "mosaic.scdn.co", "image-cdn-ak.spotifycdn.com",
             "image-cdn-fa.spotifycdn.com", "lineup-images.scdn.co"}


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


class Cooling(Exception):
    """Raised instead of calling out while Spotify has told us to wait.

    Carries nothing: the handler that catches it has `self`, and so can ask
    cooling_for() for the authoritative number rather than trusting a copy
    taken when the exception was built.
    """


class SpotifyAccount:
    def __init__(self, cache_dir, redirect_uri):
        self.token_path = os.path.join(cache_dir, "spotify_token.json")
        self.redirect_uri = redirect_uri
        self.client_id = ""
        self._token = self._load()
        self._pending = {}            # state -> code verifier, while a sign-in is open
        self._lock = threading.Lock()
        self._raw = None              # last /me/player payload
        self._fetched_at = 0.0
        # Passive reads are cached so a burst of front-end requests - the deck
        # panel and the queue window asking at once, or the several triggers
        # that fire on a track change - costs Spotify one call, not several.
        self._queue_cache = None
        self._queue_at = 0.0
        self._devices_cache = None
        self._devices_at = 0.0
        self._last_track = None
        self._bridge_track = None
        self._error = ""
        self._backoff_until = 0.0
        # Set by the server: True while the Windows bridge is already telling
        # us what is playing, so this poller can take its time.
        self.bridge_has = False
        self._poke = threading.Event()
        self._stop = threading.Event()
        self._art = {}                # url -> (mime, bytes), a handful at most

    # ------------------------------------------------------------- tokens

    def _load(self):
        try:
            with open(self.token_path, "r", encoding="utf-8") as f:
                tok = json.load(f)
            return tok if tok.get("refresh_token") else None
        except Exception:
            return None

    def _save(self):
        try:
            os.makedirs(os.path.dirname(self.token_path), exist_ok=True)
            with open(self.token_path, "w", encoding="utf-8") as f:
                json.dump(self._token or {}, f)
        except Exception:
            pass

    def configure(self, client_id):
        self.client_id = (client_id or "").strip()

    def connected(self):
        return bool(self._token and self._token.get("refresh_token"))

    def _post_token(self, fields):
        data = urllib.parse.urlencode(fields).encode("utf-8")
        req = urllib.request.Request(
            TOKEN_URL, data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=12) as r:
            tok = json.loads(r.read().decode("utf-8"))
        tok["expires_at"] = time.time() + float(tok.get("expires_in", 3600)) - 45
        return tok

    def _access_token(self):
        with self._lock:
            tok = self._token
            if not tok:
                return None
            if time.time() < tok.get("expires_at", 0):
                return tok["access_token"]
            try:
                fresh = self._post_token({
                    "grant_type": "refresh_token",
                    "refresh_token": tok["refresh_token"],
                    "client_id": self.client_id,
                })
            except urllib.error.HTTPError as exc:
                # A revoked or expired refresh token comes back 400
                # (invalid_grant) or 401. Either way the saved login is dead and
                # the only fix is signing in again - say so, and clear it, rather
                # than surfacing a raw "Spotify error 400" every minute.
                if exc.code in (400, 401):
                    self._token = None
                    try:
                        os.remove(self.token_path)
                    except Exception:
                        pass
                    self._error = "Your Spotify sign-in has expired - press Connect to sign in again."
                    return None
                raise
            fresh.setdefault("refresh_token", tok["refresh_token"])
            self._token = fresh
            self._save()
            return fresh["access_token"]

    # ------------------------------------------------------------- sign in

    def begin(self):
        """Build the Spotify approval URL for a fresh PKCE sign-in."""
        if not self.client_id:
            return {"ok": False, "reason": "Paste your app's Client ID first."}
        verifier = _b64url(secrets.token_bytes(48))
        challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
        state = secrets.token_urlsafe(16)
        self._pending[state] = verifier
        url = AUTH_URL + "?" + urllib.parse.urlencode({
            "client_id": self.client_id,
            "response_type": "code",
            "redirect_uri": self.redirect_uri,
            "scope": SCOPES,
            "code_challenge_method": "S256",
            "code_challenge": challenge,
            "state": state,
        })
        return {"ok": True, "url": url}

    def finish(self, code, state):
        """Spotify sent the browser back with a code; trade it for tokens."""
        verifier = self._pending.pop(state or "", None)
        if not verifier:
            return False, "That sign-in link is stale. Press Connect again."
        try:
            tok = self._post_token({
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.redirect_uri,
                "client_id": self.client_id,
                "code_verifier": verifier,
            })
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:200]
            return False, f"Spotify refused the code ({exc.code}): {body}"
        except Exception as exc:
            return False, f"Could not reach Spotify: {exc}"
        with self._lock:
            self._token = tok
            self._save()
        self._error = ""
        self._raw = None
        self._poke.set()
        return True, ""

    def disconnect(self):
        with self._lock:
            self._token = None
        try:
            os.remove(self.token_path)
        except Exception:
            pass
        self._raw = None
        self._error = ""

    # ------------------------------------------------------------- polling

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while not self._stop.is_set():
            if self.connected() and self.client_id and time.time() >= self._backoff_until:
                try:
                    self._poll()
                except Cooling:
                    pass                      # still inside a Retry-After window
                except urllib.error.HTTPError as exc:
                    if exc.code == 429:
                        pass                  # _api recorded the wait for us
                    elif exc.code == 401:
                        self._error = "Spotify no longer accepts the login - press Connect again."
                        self.disconnect()
                    elif exc.code == 403:
                        self._error = "Spotify says this account may not use the API (is it on the app's user list?)."
                        self._backoff_until = time.time() + 30
                    else:
                        self._error = f"Spotify error {exc.code}"
                        self._backoff_until = time.time() + 10
                except Exception as exc:
                    self._error = f"Could not reach Spotify: {str(exc)[:80]}"
                    self._backoff_until = time.time() + 10
            # Everything here is a /me/* endpoint, and those trip Spotify's
            # limiter far sooner than the headline number - a burst of ten can
            # be enough. Windows already reports the playing track for free, so
            # the background poll only needs to notice a phone or speaker taking
            # over: at most once a minute. A button press or a track change
            # pokes us awake immediately either way.
            self._poke.wait(60)
            self._poke.clear()

    def _poll(self):
        if not self._access_token():
            return                            # nothing to poll with yet
        # Through _api like everything else: it is the one place that notices a
        # 429 and records how long Spotify wants us to wait. A hand-rolled
        # request here would be the single biggest source of calls quietly
        # exempting itself from that.
        self._raw = self._api("/me/player?additional_types=track,episode")  # None = idle
        self._fetched_at = time.time()
        self._error = ""
        # A new track means a new queue: drop the cached one so the next read
        # is fresh rather than waiting out the TTL.
        item = (self._raw or {}).get("item") or {}
        track = item.get("uri") or item.get("id")
        if track != self._last_track:
            self._last_track = track
            self._queue_cache = None

    def note_track(self, key):
        """Windows just reported a different track.

        That signal is free and immediate, so use it: forget the cached queue
        and wake the poller now, rather than waiting up to a minute for the
        next scheduled poll to notice the song moved on.
        """
        if key and key != self._bridge_track:
            self._bridge_track = key
            self._queue_cache = None
            self._poke.set()

    def get(self):
        """Current playback as the deck understands it."""
        if not self.connected():
            return {"connected": False, "has": False, "error": self._error,
                    "client_id_set": bool(self.client_id)}
        raw = self._raw
        base = {"connected": True, "has": False, "error": self._error,
                "client_id_set": bool(self.client_id),
                "device": ((raw or {}).get("device") or {}).get("name", "")}
        item = (raw or {}).get("item")
        if not item:
            return base

        if item.get("type") == "episode":
            artist = (item.get("show") or {}).get("name", "")
            album = (item.get("show") or {}).get("publisher", "")
            images = item.get("images") or (item.get("show") or {}).get("images") or []
        else:
            artist = ", ".join(a.get("name", "") for a in item.get("artists", []) if a.get("name"))
            album = (item.get("album") or {}).get("name", "")
            images = (item.get("album") or {}).get("images") or []
        art = ""
        if images:
            art = sorted(images, key=lambda im: abs((im.get("width") or 300) - 300))[0].get("url", "")

        # Honest about age. The poll runs once a minute and stops entirely
        # inside a rate-limit window, so this payload can be minutes old: a
        # track that ended long ago must not be reported as still playing with
        # a progress bar marching forward. Past STALE_AFTER (or while cooling)
        # the playing claim is dropped and position frozen; snapshot() then
        # defers to Windows, which knows what is actually playing right now.
        age = time.time() - self._fetched_at
        fresh = age < self.STALE_AFTER and not self.cooling_for()
        playing = bool(raw.get("is_playing")) and fresh
        position = float(raw.get("progress_ms") or 0) / 1000
        if playing:
            position += max(0.0, age)
        duration = float(item.get("duration_ms") or 0) / 1000
        if duration:
            position = min(position, duration)

        base.update({
            "has": True,
            "title": item.get("name", ""),
            "artist": artist,
            "album": album,
            "playing": playing,
            "position": round(position, 2),
            "duration": round(duration, 2),
            "art": art,
            "shuffle": bool(raw.get("shuffle_state")),
            "repeat": raw.get("repeat_state", "off"),
            "stale": not fresh,
        })
        return base

    # ------------------------------------------------------------- control

    def command(self, cmd):
        """play / pause / playpause / next / prev, wherever Spotify is playing."""
        if not self.connected():
            return {"ok": False, "reason": "not connected"}
        if cmd == "playpause":
            cmd = "pause" if (self._raw and self._raw.get("is_playing")) else "play"
        routes = {"play": ("PUT", "/me/player/play"), "pause": ("PUT", "/me/player/pause"),
                  "next": ("POST", "/me/player/next"), "prev": ("POST", "/me/player/previous")}
        if cmd not in routes:
            return {"ok": False, "reason": "unknown command"}
        method, path = routes[cmd]
        try:
            self._api(path, method)
        except Cooling:
            return {"ok": False, "reason": self.cooling_reason(),
                    "retry_in": round(self.cooling_for(), 1)}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "reason": self._explain(exc),
                    "retry_in": round(self.cooling_for(), 1)}
        except Exception as exc:
            return {"ok": False, "reason": f"Could not reach Spotify: {str(exc)[:80]}"}
        # Reflect the change straight away, then let the next poll confirm it.
        if self._raw and cmd in ("play", "pause"):
            self._raw["is_playing"] = cmd == "play"
        self._backoff_until = 0
        self._poke.set()
        return {"ok": True}

    # ------------------------------------------------------------- browsing

    def cooling_for(self):
        """Seconds left before Spotify will listen to us again, 0 when clear."""
        return max(0.0, self._backoff_until - time.time())

    def cooling_reason(self):
        """What to tell someone whose button press we just refused."""
        return ("Spotify is rate limiting this app — it will not answer for "
                "another " + self.human_wait(self.cooling_for())
                + ". Everything that reads from Windows still works.")

    @staticmethod
    def human_wait(seconds):
        """"11h 41m" rather than "42080 seconds" - Spotify's waits get long."""
        seconds = int(max(0, seconds))
        if seconds >= 3600:
            return "%dh %dm" % (seconds // 3600, (seconds % 3600) // 60)
        if seconds >= 60:
            return "%dm %ds" % (seconds // 60, seconds % 60)
        return "%ds" % seconds

    def _api(self, path, method="GET", body=None):
        """One authenticated call. Raises HTTPError so callers can explain.

        Refuses to go out at all while we are inside a Retry-After window:
        asking again during one is what keeps the window open.
        """
        if self.cooling_for():
            raise Cooling()
        token = self._access_token()
        if not token:
            raise RuntimeError("not connected")
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Authorization": "Bearer " + token}
        if data:
            headers["Content-Type"] = "application/json"
        elif method != "GET":
            headers["Content-Length"] = "0"
            data = b""
        req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                raw = r.read()
        except urllib.error.HTTPError as exc:
            # One 429 anywhere silences every call, not just this one.
            if exc.code == 429:
                wait = 5
                try:
                    wait = int(exc.headers.get("Retry-After", "5") or 5)
                except (TypeError, ValueError):
                    pass
                self._backoff_until = time.time() + max(2, wait)
            raise
        if method != "GET":
            # A write (queue a track, skip, move playback) changes what is
            # next and where; forget the cached answers so the next read asks.
            self._queue_cache = None
            self._devices_cache = None
        # The control endpoints answer 204 with an empty or non-JSON body, so a
        # parse failure here means "it worked, there was nothing to say".
        if not raw.strip():
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            return None

    @staticmethod
    def _track(item):
        """Trim a track or episode down to what the deck shows."""
        if not item:
            return None
        if item.get("type") == "episode":
            images = item.get("images") or (item.get("show") or {}).get("images") or []
            who = (item.get("show") or {}).get("name", "")
        else:
            images = (item.get("album") or {}).get("images") or []
            who = ", ".join(a.get("name", "") for a in item.get("artists", []) if a.get("name"))
        art = ""
        if images:
            art = sorted(images, key=lambda im: abs((im.get("width") or 300) - 120))[0].get("url", "")
        return {"uri": item.get("uri", ""), "title": item.get("name", ""),
                "artist": who, "art": art,
                "duration": round(float(item.get("duration_ms") or 0) / 1000, 1)}

    STALE_AFTER = 90.0    # a /me/player payload older than this is not "now"
    QUEUE_TTL = 55.0      # seconds a fetched queue is reused before asking again
    DEVICES_TTL = 120.0   # devices change rarely
    ERROR_TTL = 10.0      # a failed read is not retried faster than this

    def queue(self):
        """What Spotify will play next.

        Note: the Web API can read this queue and append to it, but there is no
        endpoint to reorder or remove items - only playlist tracks can be moved.

        Served from cache within QUEUE_TTL: however many front ends ask, Spotify
        is asked at most once per window. A write or a track change drops the
        cache so the next read is fresh instead of waiting the TTL out.
        """
        now = time.time()
        if self._queue_cache is not None:
            ttl = self.QUEUE_TTL if self._queue_cache.get("ok") else self.ERROR_TTL
            if now - self._queue_at < ttl:
                return self._queue_cache
        try:
            data = self._api("/me/player/queue") or {}
        except Cooling:
            result = {"ok": False, "reason": self.cooling_reason(),
                      "retry_in": round(self.cooling_for(), 1)}
        except urllib.error.HTTPError as exc:
            result = {"ok": False, "reason": self._explain(exc),
                      "retry_in": round(self.cooling_for(), 1)}
        except Exception as exc:
            result = {"ok": False, "reason": str(exc)[:80]}
        else:
            result = {
                "ok": True,
                "now": self._track(data.get("currently_playing")),
                "queue": [t for t in (self._track(i) for i in (data.get("queue") or [])[:30]) if t],
            }
        self._queue_cache, self._queue_at = result, now
        return result

    def devices(self):
        now = time.time()
        if self._devices_cache is not None:
            ttl = self.DEVICES_TTL if self._devices_cache.get("ok") else self.ERROR_TTL
            if now - self._devices_at < ttl:
                return self._devices_cache
        try:
            data = self._api("/me/player/devices") or {}
        except Cooling:
            result = {"ok": False, "reason": self.cooling_reason(),
                      "retry_in": round(self.cooling_for(), 1), "devices": []}
        except Exception as exc:
            result = {"ok": False, "reason": str(exc)[:80], "devices": []}
        else:
            result = {"ok": True, "devices": [
                {"id": d.get("id"), "name": d.get("name", ""), "type": d.get("type", ""),
                 "active": bool(d.get("is_active")), "volume": d.get("volume_percent")}
                for d in (data.get("devices") or [])]}
        self._devices_cache, self._devices_at = result, now
        return result

    def search(self, query, limit=10):
        query = (query or "").strip()
        if not query:
            return {"ok": True, "results": []}
        # The docs allow 50, but the live API rejects anything over 10 here
        # with "Invalid limit", so stay inside what it actually accepts.
        qs = urllib.parse.urlencode({"q": query, "type": "track", "limit": max(1, min(limit, 10))})
        try:
            data = self._api("/search?" + qs) or {}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "reason": self._explain(exc), "results": []}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)[:80], "results": []}
        items = ((data.get("tracks") or {}).get("items")) or []
        return {"ok": True, "results": [t for t in (self._track(i) for i in items) if t]}

    def enqueue(self, uri):
        if not uri:
            return {"ok": False, "reason": "no track given"}
        try:
            self._api("/me/player/queue?" + urllib.parse.urlencode({"uri": uri}), "POST")
        except urllib.error.HTTPError as exc:
            return {"ok": False, "reason": self._explain(exc)}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)[:80]}
        self._poke.set()
        return {"ok": True}

    def play_uri(self, uri):
        """Jump straight to something, instead of waiting for the queue."""
        body = {"uris": [uri]} if uri and ":track:" in uri else {"context_uri": uri}
        try:
            self._api("/me/player/play", "PUT", body)
        except urllib.error.HTTPError as exc:
            return {"ok": False, "reason": self._explain(exc)}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)[:80]}
        self._backoff_until = 0
        self._poke.set()
        return {"ok": True}

    def play_to_front(self, uri):
        """Play a track now and keep the rest of the queue behind it.

        Spotify has no endpoint to reorder a queue, but /play takes an explicit
        list of track URIs - so hand it the chosen track followed by everything
        currently queued. That is the same result as dragging it to the top.

        Playing a bare track URI instead replaces the whole context with one
        song, which leaves Spotify nothing to play afterwards: it just repeats.
        """
        if not uri:
            return {"ok": False, "reason": "no track given"}

        queue, dropped = [], 0
        try:
            data = self._api("/me/player/queue") or {}
            for item in (data.get("queue") or []):
                u = item.get("uri") or ""
                if u.startswith("spotify:track:"):
                    queue.append(u)
                elif u:
                    dropped += 1        # podcasts cannot ride in a uris list
        except Exception:
            pass

        if not uri.startswith("spotify:track:"):
            return self.play_uri(uri)   # albums, playlists: play as a context

        # Spotify caps the list; keep well inside it and drop any duplicate.
        uris = ([uri] + [u for u in queue if u != uri])[:90]
        try:
            self._api("/me/player/play", "PUT", {"uris": uris})
        except urllib.error.HTTPError as exc:
            return {"ok": False, "reason": self._explain(exc)}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)[:80]}
        self._backoff_until = 0
        self._poke.set()
        return {"ok": True, "kept": len(uris) - 1, "dropped": dropped}

    def skip_to(self, uri, index=None):
        """Play a track that is already queued, the way Spotify's own app does.

        There is no reorder or remove endpoint, so the only way to reach a
        queued track is to advance to it. Tracks ahead of it are consumed -
        exactly what happens when you click an item in Spotify's own queue.

        Rebuilding the context with a uris list was the alternative, but items
        added by hand stay in the queue regardless, so that duplicated them.
        """
        if index is None:
            try:
                data = self._api("/me/player/queue") or {}
                uris = [i.get("uri") for i in (data.get("queue") or [])]
                index = uris.index(uri)
            except Exception:
                return {"ok": False, "reason": "that track is no longer queued"}
        index = max(0, int(index))
        if index > 40:
            return {"ok": False, "reason": "that is too far down the queue to skip to"}

        # Firing next N times back to back does not work: Spotify applies them
        # asynchronously, so past a couple of hops the skips overtake its own
        # state and land somewhere else entirely. Step once, wait for the track
        # to actually change, then decide again.
        try:
            for step in range(index + 1):
                before = self._current_uri()
                self._api("/me/player/next", "POST")
                changed = self._await_change(before)
                if self._current_uri() == uri:
                    break                      # arrived early; stop skipping
                if not changed:
                    return {"ok": False, "skipped": step,
                            "reason": "Spotify stopped responding to skips"}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "reason": self._explain(exc)}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)[:80]}
        self._backoff_until = 0
        self._poke.set()
        return {"ok": True, "skipped": index}

    def _current_uri(self):
        try:
            data = self._api("/me/player/currently-playing") or {}
            return (data.get("item") or {}).get("uri")
        except Exception:
            return None

    def _await_change(self, before, timeout=2.5):
        """Wait until Spotify reports a different track, or give up."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.18)
            now = self._current_uri()
            if now and now != before:
                return True
        return False

    def seek(self, seconds):
        try:
            self._api("/me/player/seek?" + urllib.parse.urlencode(
                {"position_ms": max(0, int(float(seconds) * 1000))}), "PUT")
        except urllib.error.HTTPError as exc:
            return {"ok": False, "reason": self._explain(exc)}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)[:80]}
        self._backoff_until = 0
        self._poke.set()
        return {"ok": True}

    def set_volume(self, percent):
        try:
            self._api("/me/player/volume?" + urllib.parse.urlencode(
                {"volume_percent": max(0, min(100, int(percent)))}), "PUT")
        except urllib.error.HTTPError as exc:
            return {"ok": False, "reason": self._explain(exc)}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)[:80]}
        return {"ok": True}

    def transfer(self, device_id):
        try:
            self._api("/me/player", "PUT", {"device_ids": [device_id], "play": True})
        except urllib.error.HTTPError as exc:
            return {"ok": False, "reason": self._explain(exc)}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)[:80]}
        self._poke.set()
        return {"ok": True}

    def set_toggle(self, what, value):
        """shuffle -> bool, repeat -> off | context | track."""
        if what == "shuffle":
            qs = urllib.parse.urlencode({"state": "true" if value else "false"})
            path = "/me/player/shuffle?" + qs
        elif what == "repeat":
            if value not in ("off", "context", "track"):
                return {"ok": False, "reason": "bad repeat mode"}
            path = "/me/player/repeat?" + urllib.parse.urlencode({"state": value})
        else:
            return {"ok": False, "reason": "unknown toggle"}
        try:
            self._api(path, "PUT")
        except urllib.error.HTTPError as exc:
            return {"ok": False, "reason": self._explain(exc)}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)[:80]}
        self._poke.set()
        return {"ok": True}

    @staticmethod
    def _explain(exc):
        if exc.code == 403:
            return "Spotify allows this only on Premium accounts."
        if exc.code == 404:
            return "Spotify has no active device - start playing something first."
        if exc.code == 429:
            return "Spotify is rate limiting; it will pick up again on its own."
        if exc.code == 401:
            return "The Spotify login expired - press Connect again."
        return f"Spotify error {exc.code}"

    # ------------------------------------------------------------- art

    def fetch_art(self, url):
        """Album art bytes for one of Spotify's own image URLs, cached."""
        host = urllib.parse.urlparse(url).hostname or ""
        if host not in ART_HOSTS:
            return None
        hit = self._art.get(url)
        if hit:
            return hit
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "MusicDeck/1.0"})
            with urllib.request.urlopen(req, timeout=8) as r:
                mime = r.headers.get("Content-Type", "image/jpeg").split(";")[0]
                data = r.read()
        except Exception:
            return None
        if len(self._art) > 12:
            self._art.clear()
        self._art[url] = (mime, data)
        return self._art[url]
