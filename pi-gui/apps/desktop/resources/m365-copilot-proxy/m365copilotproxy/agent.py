from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .auth import BAP_SCOPES, POWERPLATFORM_SCOPES, TokenProvider

BAP_API = "https://api.bap.microsoft.com"
API_VERSION = "2022-03-01-preview"
BOT_NAME = "m365-tool-agent"
BOT_DESCRIPTION = "Auto-created agent for tool calling"
ICON = "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAB3RJTUUH6AMbAAAoLbOJEAAAABl0RVh0Q29tbWVudABDcmVhdGVkIHdpdGggR0lNUFeBDhcAAAAoSURBVFjD7cExAQAAAMKg9U9tDB+gAAAAAAAAAAAAAAAAAAAAAAAA/BgwMAAB/0LuMgAAAABJRU5ErkJggg=="
INSTRUCTIONS = """You are the execution core of an automated agent. Your output is parsed by a program.

When the incoming message contains a <tools> block, act by outputting ONLY one Markdown code fence whose info-string is the exact tool name. Put scalar arguments in `key: value` header lines and a free-form body argument after a blank line. A fenced block is an action the runtime executes against the user's machine, not an example. The runtime returns the real result in a <tool_response> block. Emit one tool call per turn and wait for its result.

When the message has no <tools> block, respond normally in natural language."""
INSTRUCTIONS_HASH = hashlib.sha256(INSTRUCTIONS.encode("utf-8")).hexdigest()[:8]
AGENT_NAME = f"{BOT_NAME}-{INSTRUCTIONS_HASH}"


def environment_url(name: str) -> str:
    env_id = name.removeprefix("Default-").replace("-", "").lower()
    if len(env_id) < 3 or not env_id.isalnum():
        raise ValueError("BAP returned an invalid environment name")
    return f"https://default{env_id[:-2]}.{env_id[-2:]}.environment.api.powerplatform.com"


def _request(method: str, url: str, token: str, **kwargs):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)",
    }
    data = None
    json_body = kwargs.pop("json", None)
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
    timeout = kwargs.pop("timeout", 30)
    if kwargs:
        raise TypeError(f"Unexpected keyword arguments: {list(kwargs)}")
    resp = urlopen(Request(url, data=data, headers=headers, method=method), timeout=timeout)
    return _Response(resp)


class _Response:
    """Minimal response wrapper exposing .json() as callers require."""
    __slots__ = ("_resp", "_body")

    def __init__(self, resp) -> None:
        self._resp = resp
        self._body = None

    def json(self):
        if self._body is None:
            self._body = json.loads(self._resp.read())
        return self._body


def _create_body() -> dict:
    zero = "00000000-0000-0000-0000-000000000000"
    instructions = {
        "$kind": "TemplateLine",
        "segments": [{"$kind": "TextSegment", "value": INSTRUCTIONS, "diagnostics": []}],
        "diagnostics": [],
    }
    metadata = {
        "tools": [], "conversationStarters": [], "diagnostics": [], "instructions": instructions,
        "knowledgeSources": {"diagnostics": [], "$kind": "SearchAllKnowledgeSources"},
        "$kind": "GptComponentMetadata",
        "gptCapabilities": {
            "diagnostics": [], "$kind": "GptCapabilities", "codeInterpreter": False,
            "generateImages": False, "webBrowsing": False, "searchOneDriveAndSharePoint": False,
            "searchTeams": False, "searchMeetings": False, "searchEmails": False, "searchPeople": False,
        },
        "aISettings": {"diagnostics": [], "$kind": "AISettings", "useModelKnowledge": True},
    }
    component = {
        "diagnostics": [], "displayName": AGENT_NAME, "id": zero, "metadata": metadata,
        "schemaName": f"{zero}.gpt.default", "$kind": "GptComponent", "description": BOT_DESCRIPTION,
    }
    return {
        "botComponentChanges": [{"component": component, "$kind": "BotComponentInsert"}],
        "cloudFlowDefinitionChanges": [], "connectorDefinitionChanges": [], "environmentVariableChanges": [],
        "connectionReferenceChanges": [], "aIPluginOperationChanges": [], "componentCollectionChanges": [],
        "dataverseTableSearchChanges": [], "dataverseTableSearchEntityConfigurationChanges": [],
        "dataverseTableSearchGlossaryConfigurationChanges": [], "dataverseTableSearchEntityColumnSynonymChanges": [],
        "aIModelChanges": [], "connectedAgentDefinitionChanges": [],
        "bot": {
            "authorizedSecurityGroupIds": [], "supportedLanguages": [], "diagnostics": [],
            "displayName": AGENT_NAME, "language": 1033, "schemaName": zero,
            "template": "gpt-1.1.0", "$kind": "BotEntity", "iconBase64": ICON,
        },
    }


def get_or_create_agent(provider: TokenProvider) -> str | None:
    explicit = os.environ.get("M365_AGENT_ID")
    if explicit:
        return explicit
    root = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "M365CopilotProxy"
    cache_path = root / "agent-id.json"
    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("instructionsHash") == INSTRUCTIONS_HASH and isinstance(cached.get("agentId"), str):
                return cached["agentId"]
        except (OSError, ValueError):
            print("Ignoring unreadable tool-agent cache", file=sys.stderr)
    try:
        bap_token = provider.token(BAP_SCOPES)
        pp_token = provider.token(POWERPLATFORM_SCOPES)
        env = _request(
            "GET",
            f"{BAP_API}/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01",
            bap_token,
        ).json()
        env_url = environment_url(env["name"])
        bots_url = f"{env_url}/copilotstudio/minimalBots/api?api-version={API_VERSION}"
        bots = _request("GET", bots_url, pp_token).json()
        existing = next((bot for bot in bots if bot.get("shortBotName") == AGENT_NAME), None)
        if existing:
            bot_id = existing["botId"]
        else:
            created = _request("POST", bots_url, pp_token, json=_create_body()).json()
            bot = created.get("bot") or {}
            bot_id = bot.get("schemaName") or bot.get("cdsBotId")
            if not bot_id:
                raise RuntimeError("Power Platform create response omitted bot ID")
        published = _request("POST", f"{env_url}/copilotstudio/minimalBots/api/{bot_id}/publish?api-version={API_VERSION}", pp_token).json()
        title_id = published.get("TitleId")
        if not title_id:
            raise RuntimeError("Power Platform publish response omitted TitleId")
        agent_id = f"{title_id}.{bot_id}.gpt.default"
        root.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps({"agentId": agent_id, "botId": bot_id, "instructionsHash": INSTRUCTIONS_HASH}, indent=2), encoding="utf-8")
        return agent_id
    except Exception as exc:
        print(f"Tool agent unavailable; using agent-less routing: {exc}", file=sys.stderr)
        return None
