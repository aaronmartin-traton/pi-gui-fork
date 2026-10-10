from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import socket
from urllib.request import urlopen

import msal
import websockets

CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1"
AUTHORITY = "https://login.microsoftonline.com/common"
REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient"
CHAT_SCOPES = [
    "https://substrate.office.com/sydney/M365Chat.Read",
    "https://substrate.office.com/sydney/sydney.readwrite",
]
BAP_SCOPES = ["https://api.bap.microsoft.com/.default"]
POWERPLATFORM_SCOPES = ["https://api.powerplatform.com/.default"]


class AuthenticationError(RuntimeError):
    pass


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


async def _cdp_call(websocket, counter: list[int], method: str, params: dict, session_id: str, events: list[dict]) -> dict:
    counter[0] += 1
    command_id = counter[0]
    command = {"id": command_id, "method": method, "params": params}
    if session_id:
        command["sessionId"] = session_id
    await websocket.send(json.dumps(command))
    while True:
        message = json.loads(await websocket.recv())
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


async def _capture_authorization_response(auth_uri: str, profile_dir: str) -> dict:
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
                await asyncio.sleep(0.1)
        endpoint = browser_info["webSocketDebuggerUrl"].replace("localhost", "127.0.0.1", 1)
        async with websockets.connect(endpoint, origin=None, max_size=None) as websocket:
            counter = [0]
            events: list[dict] = []
            try:
                target = await _cdp_call(websocket, counter, "Target.createTarget", {"url": "about:blank"}, "", events)
                attached = await _cdp_call(
                    websocket, counter, "Target.attachToTarget",
                    {"targetId": target["targetId"], "flatten": True}, "", events,
                )
                session_id = attached["sessionId"]
                await _cdp_call(websocket, counter, "Network.enable", {}, session_id, events)
                await _cdp_call(websocket, counter, "Page.enable", {}, session_id, events)
                await _cdp_call(websocket, counter, "Page.navigate", {"url": auth_uri}, session_id, events)
                deadline = time.monotonic() + 300
                while True:
                    if events:
                        return events.pop(0)
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise AuthenticationError("Timed out waiting for Microsoft sign-in")
                    try:
                        message = json.loads(await asyncio.wait_for(websocket.recv(), remaining))
                    except asyncio.TimeoutError:
                        raise AuthenticationError("Timed out waiting for Microsoft sign-in") from None
                    auth_response = _authorization_response(message)
                    if auth_response:
                        events.append(auth_response)
            finally:
                try:
                    await asyncio.wait_for(
                        _cdp_call(websocket, counter, "Browser.close", {}, "", events), 3,
                    )
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



class TokenProvider:
    def __init__(self) -> None:
        root = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "M365CopilotProxy"
        root.mkdir(parents=True, exist_ok=True)
        self.cache_path = Path(os.environ.get("M365_CACHE_FILE", root / "msal-cache.json"))
        self.cache = msal.SerializableTokenCache()
        if self.cache_path.exists():
            try:
                self.cache.deserialize(self.cache_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                raise AuthenticationError(f"Unreadable MSAL cache: {self.cache_path}") from None
        self.client = msal.PublicClientApplication(
            CLIENT_ID, authority=AUTHORITY, token_cache=self.cache
        )
        self._lock = threading.Lock()

    def _save(self) -> None:
        if self.cache.has_state_changed:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(self.cache.serialize(), encoding="utf-8")

    def _interactive_token(self, scopes: list[str], has_account: bool) -> dict:
        flow = self.client.initiate_auth_code_flow(
            scopes=scopes,
            redirect_uri=REDIRECT_URI,
            prompt=None if has_account else "select_account",
        )
        auth_uri = flow.get("auth_uri")
        if not auth_uri:
            raise AuthenticationError(flow.get("error_description") or flow.get("error") or "Could not start Microsoft sign-in")
        print("Complete Microsoft sign-in in the opened browser window.", flush=True)
        with tempfile.TemporaryDirectory(prefix="m365-copilot-auth-") as profile_dir:
            auth_response = asyncio.run(_capture_authorization_response(auth_uri, profile_dir))
        if auth_response.get("error"):
            raise AuthenticationError(f"Microsoft sign-in failed: {auth_response['error']}")
        try:
            return self.client.acquire_token_by_auth_code_flow(flow, auth_response)
        except ValueError as exc:
            raise AuthenticationError(str(exc)) from None

    def token(self, scopes: list[str], *, interactive: bool = True) -> str:
        with self._lock:
            accounts = self.client.get_accounts()
            result = None
            if accounts:
                result = self.client.acquire_token_silent(scopes, account=accounts[0])
            if not result and interactive:
                result = self._interactive_token(scopes, bool(accounts))
            self._save()
            if not result or "access_token" not in result:
                detail = (result or {}).get("error_description") or (result or {}).get("error")
                raise AuthenticationError(detail or "Microsoft sign-in did not return an access token")
            return result["access_token"]


def login() -> str:
    provider = TokenProvider()
    provider.token(CHAT_SCOPES, interactive=True)
    accounts = provider.client.get_accounts()
    return accounts[0].get("username", "Microsoft account") if accounts else "Microsoft account"
