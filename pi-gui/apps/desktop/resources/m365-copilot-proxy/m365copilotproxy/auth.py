from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

from .wsclient import WebSocket, WebSocketTimeout

CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1"
AUTHORITY = "https://login.microsoftonline.com/common"
AUTHORIZE_ENDPOINT = AUTHORITY + "/oauth2/v2.0/authorize"
TOKEN_ENDPOINT = AUTHORITY + "/oauth2/v2.0/token"
REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient"
CHAT_SCOPES = [
    "https://substrate.office.com/sydney/M365Chat.Read",
    "https://substrate.office.com/sydney/sydney.readwrite",
]
BAP_SCOPES = ["https://api.bap.microsoft.com/.default"]
POWERPLATFORM_SCOPES = ["https://api.powerplatform.com/.default"]


class AuthenticationError(RuntimeError):
    pass


# --- sign-in browser (Chrome DevTools Protocol) ----------------------------

def _browser_executable() -> str:
    configured = os.environ.get("CHROMIUM_PATH")
    if configured:
        if Path(configured).is_file():
            return configured
        raise AuthenticationError("CHROMIUM_PATH does not point to a browser executable")
    roots = [
        Path(os.environ.get("PROGRAMFILES", "")),
        Path(os.environ.get("PROGRAMFILES(X86)", "")),
        Path(os.environ.get("LOCALAPPDATA", "")),
    ]
    browsers = (
        Path("Google/Chrome/Application/chrome.exe"),
        Path("Microsoft/Edge/Application/msedge.exe"),
    )
    for root in roots:
        for browser in browsers:
            candidate = root / browser
            if candidate.is_file():
                return str(candidate)
    raise AuthenticationError("Chrome or Edge was not found; set CHROMIUM_PATH to its executable")


def _cdp_call(ws: WebSocket, counter: list[int], method: str, params: dict, session_id: str,
              events: list[dict], timeout: float | None = None) -> dict:
    counter[0] += 1
    command_id = counter[0]
    command = {"id": command_id, "method": method, "params": params}
    if session_id:
        command["sessionId"] = session_id
    ws.send(json.dumps(command))
    while True:
        message = json.loads(ws.recv(timeout=timeout))
        if message.get("id") == command_id:
            if "error" in message:
                raise AuthenticationError("Browser authorization setup failed")
            return message.get("result", {})
        auth_response = _authorization_response(message)
        if auth_response:
            events.append(auth_response)


def _authorization_response(message: dict) -> dict | None:
    if message.get("method") != "Network.requestWillBeSent":
        return None
    request_url = message.get("params", {}).get("request", {}).get("url", "")
    parsed = urlsplit(request_url)
    if parsed.hostname != "login.microsoftonline.com" or parsed.path.rstrip("/") != "/common/oauth2/nativeclient":
        return None
    query = parse_qs(parsed.query)
    if "error" in query:
        return {"error": query["error"][0]}
    if "code" in query:
        return {"code": query["code"][0], "state": query.get("state", [""])[0]}
    return None


def _capture_authorization_response(auth_uri: str, profile_dir: str) -> dict:
    browser = _browser_executable()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    try:
        process = subprocess.Popen([
            browser,
            "--remote-debugging-address=127.0.0.1",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        raise AuthenticationError("Could not start the sign-in browser") from None
    try:
        deadline = time.monotonic() + 20
        while True:
            if process.poll() is not None:
                raise AuthenticationError("Browser closed before Microsoft sign-in started")
            try:
                with urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1) as response:
                    browser_info = json.load(response)
                break
            except (OSError, ValueError):
                if time.monotonic() >= deadline:
                    raise AuthenticationError("Timed out starting the sign-in browser") from None
                time.sleep(0.1)
        endpoint = browser_info["webSocketDebuggerUrl"].replace("localhost", "127.0.0.1", 1)
        with WebSocket.connect(endpoint, timeout=30) as ws:
            counter = [0]
            events: list[dict] = []
            try:
                target = _cdp_call(ws, counter, "Target.createTarget", {"url": "about:blank"}, "", events)
                attached = _cdp_call(
                    ws, counter, "Target.attachToTarget",
                    {"targetId": target["targetId"], "flatten": True}, "", events,
                )
                session_id = attached["sessionId"]
                _cdp_call(ws, counter, "Network.enable", {}, session_id, events)
                _cdp_call(ws, counter, "Page.enable", {}, session_id, events)
                _cdp_call(ws, counter, "Page.navigate", {"url": auth_uri}, session_id, events)
                deadline = time.monotonic() + 300
                while True:
                    if events:
                        return events.pop(0)
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise AuthenticationError("Timed out waiting for Microsoft sign-in")
                    try:
                        message = json.loads(ws.recv(timeout=remaining))
                    except WebSocketTimeout:
                        raise AuthenticationError("Timed out waiting for Microsoft sign-in") from None
                    auth_response = _authorization_response(message)
                    if auth_response:
                        events.append(auth_response)
            finally:
                try:
                    _cdp_call(ws, counter, "Browser.close", {}, "", events, timeout=3)
                except Exception:
                    pass
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


# --- OAuth 2.0 authorization-code flow (stdlib) ----------------------------

def _scope_key(scopes: list[str]) -> str:
    return " ".join(sorted(scopes))


def _pkce() -> tuple[str, str]:
    """A PKCE verifier and its S256 challenge (RFC 7636)."""
    verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode("ascii")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=")
    return verifier, challenge.decode("ascii")


def _authorize_url(scopes: list[str], challenge: str, state: str, prompt: str | None) -> str:
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "response_mode": "query",
        "scope": " ".join([*scopes, "offline_access", "openid", "profile"]),
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "client_info": "1",
    }
    if prompt:
        params["prompt"] = prompt
    return AUTHORIZE_ENDPOINT + "?" + urlencode(params)


def _token_request(data: dict) -> dict:
    """POST to the token endpoint. OAuth errors come back as JSON, not exceptions."""
    body = urlencode(data).encode("ascii")
    request = Request(TOKEN_ENDPOINT, data=body,
                      headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            return json.load(error)
        except (OSError, ValueError):
            raise AuthenticationError(f"Microsoft token request failed: HTTP {error.code}") from None


def _error_text(result: dict) -> str:
    return str(result.get("error_description") or result.get("error")
               or "Microsoft sign-in did not return an access token")


def _preferred_username(result: dict) -> str | None:
    token = result.get("id_token")
    if not isinstance(token, str):
        return None
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError, json.JSONDecodeError):
        return None
    for name in ("preferred_username", "upn", "email", "name"):
        value = claims.get(name)
        if isinstance(value, str) and value:
            return value
    return None


class TokenProvider:
    """Caches one refresh token plus per-scope access tokens in a JSON file."""

    def __init__(self) -> None:
        root = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "M365CopilotProxy"
        root.mkdir(parents=True, exist_ok=True)
        self.cache_path = Path(os.environ.get("M365_CACHE_FILE", root / "token-cache.json"))
        self._lock = threading.Lock()
        self._cache = self._load()

    def _load(self) -> dict:
        if not self.cache_path.exists():
            return {}
        try:
            data = json.loads(self.cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save(self) -> None:
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(json.dumps(self._cache), encoding="utf-8")
        except OSError as exc:
            raise AuthenticationError(f"Could not write the token cache: {exc}") from None

    def _store(self, result: dict, key: str) -> None:
        if isinstance(result.get("refresh_token"), str):
            self._cache["refresh_token"] = result["refresh_token"]
        username = _preferred_username(result)
        if username:
            self._cache["username"] = username
        access = self._cache.setdefault("access", {})
        if isinstance(result.get("access_token"), str):
            expires_in = result.get("expires_in", 3600)
            seconds = float(expires_in) if isinstance(expires_in, (int, float, str)) else 3600.0
            access[key] = {"token": result["access_token"], "expires_at": time.time() + seconds}
        self._save()

    def _cached(self, key: str) -> str | None:
        entry = (self._cache.get("access") or {}).get(key)
        if isinstance(entry, dict) and isinstance(entry.get("token"), str):
            if entry.get("expires_at", 0) > time.time() + 60:
                return entry["token"]
        return None

    def _interactive(self, scopes: list[str]) -> dict:
        has_account = bool(self._cache.get("refresh_token"))
        verifier, challenge = _pkce()
        state = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode("ascii")
        auth_uri = _authorize_url(scopes, challenge, state, None if has_account else "select_account")
        print("Complete Microsoft sign-in in the opened browser window.", flush=True)
        with tempfile.TemporaryDirectory(prefix="m365-copilot-auth-") as profile_dir:
            auth_response = _capture_authorization_response(auth_uri, profile_dir)
        if auth_response.get("error"):
            raise AuthenticationError(f"Microsoft sign-in failed: {auth_response['error']}")
        if auth_response.get("state") != state:
            raise AuthenticationError("Microsoft sign-in returned an unexpected state")
        result = _token_request({
            "client_id": CLIENT_ID,
            "grant_type": "authorization_code",
            "code": auth_response.get("code", ""),
            "redirect_uri": REDIRECT_URI,
            "code_verifier": verifier,
            "scope": " ".join(scopes),
        })
        if not isinstance(result.get("access_token"), str):
            raise AuthenticationError(_error_text(result))
        return result

    def username(self) -> str | None:
        value = self._cache.get("username")
        return value if isinstance(value, str) else None

    def token(self, scopes: list[str], *, interactive: bool = True) -> str:
        with self._lock:
            key = _scope_key(scopes)
            cached = self._cached(key)
            if cached:
                return cached
            refresh = self._cache.get("refresh_token")
            if isinstance(refresh, str) and refresh:
                result = _token_request({
                    "client_id": CLIENT_ID,
                    "grant_type": "refresh_token",
                    "refresh_token": refresh,
                    "scope": " ".join(scopes),
                })
                if isinstance(result.get("access_token"), str):
                    self._store(result, key)
                    return result["access_token"]
            if not interactive:
                raise AuthenticationError("No cached Microsoft sign-in for these permissions")
            result = self._interactive(scopes)
            self._store(result, key)
            return result["access_token"]


def login() -> str:
    provider = TokenProvider()
    provider.token(CHAT_SCOPES, interactive=True)
    return provider.username() or "Microsoft account"
