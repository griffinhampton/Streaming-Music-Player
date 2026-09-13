"""
TikTok's Server URL and Stream key, through Streamlabs.

TikTok hands a stream key to LIVE Studio, not to you; Streamlabs' desktop app
is allowed to ask for one on your behalf, and this asks the same way it does.
You sign in to Streamlabs once (or the token is read from the Streamlabs app
already installed on this PC), and from then on Go LIVE asks Streamlabs to open
a TikTok live session and hands back the RTMP address and key the deck streams
to. End Live closes that session at TikTok's end, not just ours.

The request shapes here - every URL, header, field name and the way each answer
is read - are the ones the standalone key generator used, moved across
unchanged. What did change is the plumbing around them, twice, and both for the
same reason: this app already has somewhere better to put a secret.

  * The token is kept in cache/tiktok.json, encrypted to this Windows user with
    DPAPI through live._dpapi, the way the stream key already is. The original
    wrote it in clear text into config.json beside the window position.
  * Nothing here ever prints or logs the token, and /api/tiktok/* never returns
    it to the page - only whether one is held. The original printed it to
    stdout on every sign-in.

Standard library only, like the rest of the app: urllib rather than requests,
including the multipart body that /stream/start wants.
"""

import base64
import glob
import hashlib
import json
import os
import platform
import re
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

import live

API = "https://streamlabs.com/api/v5/slobs"
AUTH_DATA_URL = "https://streamlabs.com/api/v5/slobs/auth/data"
LOGIN_URL = "https://streamlabs.com/slobs/login"

# Streamlabs answers its desktop app, so we introduce ourselves as it does.
UA_STREAM = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
             "StreamlabsDesktop/1.17.0 Chrome/122.0.6261.156 Electron/29.3.1 Safari/537.36")
UA_AUTH = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
           "StreamlabsDesktop/1.20.4 Chrome/122.0.6261.156 Electron/29.3.1 Safari/537.36")

TIMEOUT = 30
LOGIN_TIMEOUT = 300          # how long the browser tab has to come back


def _json_request(req):
    """The answer as JSON, whatever the status.

    requests hands back the body on a 4xx or 5xx and leaves it to the caller;
    urllib raises instead. Streamlabs says what went wrong in that body - a
    category name too long comes back as a 500 with a reason in it - so the
    error is read the same way the success is."""
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read()
    except urllib.error.HTTPError as err:
        raw = err.read()
    return json.loads(raw.decode("utf-8", "replace") or "{}")


# ------------------------------------------------------------------ the vault

class TokenVault:
    """The Streamlabs token, encrypted to this Windows user. Like live.Vault,
    it will say whether it holds one but never hand it back to a page."""

    def __init__(self, cache_dir):
        self.path = os.path.join(cache_dir, "tiktok.json")

    def _read(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def save(self, token):
        if not (token or "").strip():
            return {"ok": False, "error": "no token"}
        data = self._read()
        data["token"] = base64.b64encode(
            live._dpapi("protect", token.strip().encode("utf-8"))).decode()
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, self.path)
        return {"ok": True, "has_token": True}

    def load(self):
        data = self._read()
        if not data.get("token"):
            return None
        try:
            return live._dpapi("unprotect", base64.b64decode(data["token"])).decode("utf-8")
        except Exception:
            return None

    def has_token(self):
        return bool(self._read().get("token"))

    def forget(self):
        try:
            os.remove(self.path)
        except OSError:
            pass
        return {"ok": True, "has_token": False}


# ------------------------------------------------------------------ the session

class Stream:
    """One Streamlabs session, and the TikTok live it can open and close."""

    def __init__(self, token):
        self.token = token
        self.id = None
        self._headers = {"user-agent": UA_STREAM, "authorization": f"Bearer {token}"}

    def _get(self, url):
        return _json_request(urllib.request.Request(url, headers=self._headers))

    def _post(self, url, body=b"", content_type=None):
        headers = dict(self._headers)
        if content_type:
            headers["content-type"] = content_type
        return _json_request(urllib.request.Request(url, data=body, headers=headers, method="POST"))

    @staticmethod
    def _multipart(fields):
        """The body requests builds from files=(...): one part per field, no
        filename and no per-part content type, which is what the API expects."""
        boundary = "----StreamDeck" + os.urandom(16).hex()
        out = []
        for name, value in fields:
            out.append(f"--{boundary}\r\n"
                       f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                       f"{value}\r\n")
        out.append(f"--{boundary}--\r\n")
        return "".join(out).encode("utf-8"), f"multipart/form-data; boundary={boundary}"

    def search(self, game):
        if not game:
            return []
        game = game[:25]  # If the game name exceeds 25 characters, the API will return error 500
        url = f"{API}/tiktok/info?category={urllib.parse.quote(game)}"
        info = self._get(url)
        info["categories"].append({"full_name": "Other", "game_mask_id": ""})
        return info["categories"]

    def start(self, title, category, audience_type="0"):
        body, content_type = self._multipart((
            ("title", title),
            ("device_platform", "win32"),
            ("category", category),
            ("audience_type", audience_type),
        ))
        response = self._post(f"{API}/tiktok/stream/start", body, content_type)
        try:
            self.id = response["id"]
            return response["rtmp"], response["key"]
        except KeyError:
            # The answer, minus anything key-shaped: this is the one place a
            # failure is worth reading, and the log must stay safe to paste.
            raise TikTokError(_redact(response))

    def end(self):
        response = self._post(f"{API}/tiktok/stream/{self.id}/end")
        return response["success"]

    def get_info(self):
        return self._get(f"{API}/tiktok/info")


class TikTokError(Exception):
    """Streamlabs answered, but not with a stream to go out on."""


def _redact(response):
    """Whatever went wrong, said without the key if one slipped into it."""
    try:
        text = json.dumps(response)
    except Exception:
        text = str(response)
    text = re.sub(r'("(?:key|rtmp|token)"\s*:\s*")[^"]+', r"\1[hidden]", text)
    return text[:400]


# ------------------------------------------------------------------ the token

def find_local_token():
    """The token the Streamlabs desktop app has already stored on this PC.

    It lives in Chromium's LevelDB log beside the rest of that app's local
    storage; the newest file that holds one wins."""
    if platform.system() == "Windows":
        path_pattern = os.path.expandvars(r"%appdata%\slobs-client\Local Storage\leveldb\*.log")
    elif platform.system() == "Darwin":
        path_pattern = os.path.expanduser(
            "~/Library/Application Support/slobs-client/Local Storage/leveldb/*.log")
    else:
        return None

    files = sorted(glob.glob(path_pattern), key=os.path.getmtime, reverse=True)
    token_pattern = re.compile(r'"apiToken":"([a-f0-9]+)"', re.IGNORECASE)

    for file in files:
        try:
            with open(file, "rb") as f:
                content = f.read().decode("utf-8", errors="ignore")
            content = re.sub(r"[\x00]", "", content)
            matches = token_pattern.findall(content)
            if matches:
                return matches[-1]
        except Exception:
            continue          # a locked or half-written log is not worth a word
    return None


class TokenRetriever:
    """Streamlabs' own sign-in, in the browser, answered on a local port.

    PKCE, so nothing but this process can trade the code it gets back for a
    token: the verifier never leaves here and the challenge is all Streamlabs
    is told."""

    def __init__(self):
        self.code_verifier = os.urandom(64).hex()
        digest = hashlib.sha256(self.code_verifier.encode()).digest()
        self.code_challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
        self._auth_code = None
        self._done = threading.Event()

    @staticmethod
    def _free_port():
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def _handler(self):
        retriever = self

        class _CallbackHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                ok = params.get("success", [""])[0] == "true" and "code" in params
                if ok:
                    retriever._auth_code = params["code"][0]
                body = (b"<h2>Signed in. You can close this tab and go back to the deck.</h2>"
                        if ok else b"<h2>That sign-in did not go through. Try again.</h2>")
                self.send_response(200 if ok else 400)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                retriever._done.set()

            def log_message(self, *_args):
                pass

        return _CallbackHandler

    def retrieve_token(self, timeout=LOGIN_TIMEOUT):
        """Open the sign-in page, wait for the browser to come back, and trade
        the code for a token. None if the tab was abandoned."""
        port = self._free_port()
        auth_url = (f"{LOGIN_URL}?skip_splash=true&external=electron&tiktok&force_verify"
                    f"&origin=slobs&port={port}"
                    f"&code_challenge={self.code_challenge}&code_flow=true")
        server = HTTPServer(("127.0.0.1", port), self._handler())
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            webbrowser.open(auth_url)
            if not self._done.wait(timeout=timeout) or not self._auth_code:
                return None
            return self._exchange(self._auth_code)
        finally:
            threading.Thread(target=server.shutdown, daemon=True).start()

    def _exchange(self, code):
        query = urllib.parse.urlencode({"code_verifier": self.code_verifier, "code": code})
        req = urllib.request.Request(f"{AUTH_DATA_URL}?{query}", headers={
            "User-Agent": UA_AUTH,
            "Accept": "*/*",
            "Accept-Language": "en-US",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
        })
        try:
            data = _json_request(req)
        except (urllib.error.URLError, ValueError):
            return None
        if not data.get("success"):
            return None
        return (data.get("data") or {}).get("oauth_token")


# ------------------------------------------------------------------ the bridge

class TikTokBridge:
    """What the deck talks to: the token, the account behind it, and the live
    session Go LIVE opens and End Live closes.

    The deck's own Start and Stop drive the RTMP engine; this drives TikTok's
    side of the same show. server.live_stop closes both together, so ending a
    stream from anywhere - the panel, the deck strip, the remote - also ends
    the session at TikTok rather than leaving it open with nothing arriving."""

    def __init__(self, cache_dir, log=lambda _msg: None):
        self.vault = TokenVault(cache_dir)
        self.log = log
        self._lock = threading.Lock()
        self._stream = None
        self.error = ""
        self.live_id = None
        self.signing_in = False
        # What this live is going out on. Streamlabs hands the address and the
        # key back together when the live opens - the only place either exists,
        # the token kept on this PC holding neither - so both are kept here for
        # as long as the live is open, and go when it closes. Nothing new is
        # written to disk: live.Vault already keeps the key encrypted.
        self.url = ""
        self._key = ""

    # -- the token ---------------------------------------------------------

    def _session(self):
        """A Stream on the stored token, made once and kept."""
        with self._lock:
            if self._stream is None:
                token = self.vault.load()
                if not token:
                    return None
                self._stream = Stream(token)
                self._stream.id = self.live_id
            return self._stream

    def use_token(self, token):
        res = self.vault.save(token)
        if res.get("ok"):
            with self._lock:
                self._stream = None       # the next call picks the new one up
            self.error = ""
        return res

    def load_local(self):
        token = find_local_token()
        if not token:
            return {"ok": False, "error": "No Streamlabs token on this PC. Install Streamlabs, "
                                          "sign in to it with TikTok, and try again."}
        return self.use_token(token)

    def sign_in(self):
        """Open Streamlabs' sign-in page and return at once: the browser can
        take minutes, and no request is held waiting for it. The panel watches
        signing_in and picks the token up when it lands."""
        if self.signing_in:
            return {"ok": True, "signing_in": True}
        self.signing_in = True
        self.error = ""

        def wait():
            try:
                token = TokenRetriever().retrieve_token()
                if token:
                    self.use_token(token)
                else:
                    self.error = "That sign-in did not finish."
            except Exception as exc:
                self.error = str(exc)
            finally:
                self.signing_in = False

        threading.Thread(target=wait, name="tiktok sign-in", daemon=True).start()
        return {"ok": True, "signing_in": True}

    def forget(self):
        with self._lock:
            self._stream = None
        self.live_id = None
        self.error = ""
        self._forget_session()
        return self.vault.forget()

    # -- the account -------------------------------------------------------

    def info(self):
        s = self._session()
        if not s:
            return {"ok": False, "has_token": False, "error": "Sign in to Streamlabs first."}
        try:
            raw = s.get_info()
        except Exception as exc:
            self.error = str(exc)
            return {"ok": False, "has_token": True, "error": str(exc)}
        user = raw.get("user") or {}
        return {"ok": True, "has_token": True,
                "username": user.get("username", ""),
                "status": (raw.get("application_status") or {}).get("status", ""),
                "can_be_live": bool(raw.get("can_be_live", False)),
                "live_id": self.live_id}

    def search(self, game):
        s = self._session()
        if not s:
            return {"ok": False, "categories": []}
        try:
            return {"ok": True, "categories": s.search(game)}
        except Exception as exc:
            return {"ok": False, "categories": [], "error": str(exc)}

    def category_id(self, name):
        """The id behind a category the deck shows by name, '' for Other."""
        if not name:
            return ""
        for cat in self.search(name).get("categories", []):
            if cat.get("full_name") == name:
                return cat.get("game_mask_id", "")
        return ""

    # -- the live session --------------------------------------------------

    def start(self, title, category, mature=False):
        """Open the TikTok live and hand back what to stream to."""
        s = self._session()
        if not s:
            return {"ok": False, "error": "Sign in to Streamlabs first."}
        try:
            url, key = s.start(title or "", self.category_id(category), "1" if mature else "0")
        except TikTokError as exc:
            self.error = str(exc)
            return {"ok": False, "error": f"TikTok would not open a live: {exc}"}
        except Exception as exc:
            self.error = str(exc)
            return {"ok": False, "error": str(exc)}
        self.live_id = s.id
        self.url = url
        self._key = key
        self.error = ""
        self.log("tiktok: live session open")      # the pair itself is never logged
        return {"ok": True, "url": url, "key": key, "live_id": self.live_id}

    def end(self):
        """Close the TikTok live. Safe to call when none is open - the deck's
        Stop calls it every time rather than remembering which path started."""
        s = self._session()
        if not s or not self.live_id:
            return {"ok": True, "ended": False}
        try:
            ok = s.end()
        except Exception as exc:
            self.error = str(exc)
            self.log(f"tiktok: the live would not close ({exc})")
            return {"ok": False, "ended": False, "error": str(exc)}
        self.live_id = None
        s.id = None
        self._forget_session()
        self.log("tiktok: live session closed")
        return {"ok": bool(ok), "ended": bool(ok)}

    def _forget_session(self):
        """The pair the live went out on, gone from memory with the live."""
        self.url = ""
        self._key = ""

    def reveal(self):
        """The Server URL and stream key this live is going out on, for the one
        place that asks for them: Show and Copy on the panel.

        Asked for by hand rather than carried on every poll. The address is
        TikTok's ingest and no secret - live.Vault says as much - but the key is
        one, and it has no business in a request the panel makes twice a second
        while you are live."""
        if not self._key:
            return {"ok": False, "error": "No live is open, so there is no key yet."}
        return {"ok": True, "url": self.url, "key": self._key}

    def status(self):
        return {"has_token": self.vault.has_token(),
                "signing_in": self.signing_in,
                "live_id": self.live_id,
                # The address is safe to carry every poll; whether there is a
                # key to show is all the panel needs to decide what to draw.
                "url": self.url,
                "has_session_key": bool(self._key),
                "error": self.error}
