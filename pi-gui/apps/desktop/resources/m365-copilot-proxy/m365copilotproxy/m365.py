from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import urlencode

import websockets

from .catalog import routing_for_model, tone_for_model

RS = "\x1e"
WS_ENDPOINT = "wss://substrate.office.com/m365Copilot/Chathub"
STOP_FRAME = '{"arguments":[{}],"invocationId":"1","target":"stop","type":1}' + RS
VARIANTS = ",".join((
    "EnableMcpServerWidgets", "feature.EnableMcpServerWidgets", "feature.EnableLuForChatCIQ",
    "feature.enableChatCIQPlugin", "EnableRequestPlugins", "feature.EnableSensitivityLabels",
    "EnableUnsupportedUrlDetector", "feature.IsCustomEngineCopilotEnabled", "feature.bizchatfluxv3",
    "feature.enablechatpages", "feature.enableCodeCanvas", "feature.turnOnWorkTabRecommendation",
    "turnOffWorkTabUpsellFromClient", "feature.turnOnDARecommendation", "feature.IsStreamingModeInChatRequestEnabled",
    "IncludeSourceAttributionsConcise", "SkipPublishEmptyMessage", "feature.EnableDeduplicatingSourceAttributions",
    "Enable3PActionProgressMessages", "feature.enableClientWebRtc", "feature.EnableMeetingRecapOfSeriesMeetingWithCiq",
    "feature.EnableReferencesListCompleteSignal", "feature.StorageMessageSplitDisabled", "feature.EnableCuaTakeControlApi",
    "feature.cwcallowedos", "feature.disabledisallowedmsgs", "feature.enableCitationsForSynthesisData",
    "feature.enableGenerateGraphicArtOptionsSet", "cdximagen", "feature.EnableUpdatedUXForConfirmationDialog",
    "feature.EnableClientFileURLSupportForOfficeWebPaidCopilot", "feature.EnableDesignEditorImageGrounding",
    "feature.EnableDesignerEditor", "feature.OfficeWebToHelix", "feature.OfficeDesktopToHelix",
    "feature.M365TeamsHubToHelix", "feature.OwaHubToHelix", "feature.MonarchHubToHelix",
    "feature.Win32OutlookHubToHelix", "feature.MacOutlookHubToHelix", "Agt_bizchat_enableGpt5ForHelix",
))
CODE_INTERPRETER_OPTIONS = [
    "cwc_code_interpreter", "cwc_code_interpreter_amsfix", "cwc_code_interpreter_citation_fix",
    "code_interpreter_interactive_charts", "code_interpreter_matplotlib_patching",
]
ALLOWED_MESSAGE_TYPES = [
    "Chat", "Suggestion", "InternalSearchQuery", "Disengaged", "InternalLoaderMessage", "Progress",
    "RenderCardRequest", "SemanticSerp", "GenerateContentQuery", "SearchQuery", "ConfirmationCard",
    "DeveloperLogs", "EndOfRequest", "ReferencesListComplete", "GeneratedCode",
]


@dataclass
class TurnResult:
    text: str = ""
    result: dict | None = None
    metering: dict[str, float] = field(default_factory=dict)
    message_type: str | None = None
    error: str | None = None
    error_code: str | None = None
    turn_count: int | None = None
    raw_item: dict | None = None


def token_claims(token: str) -> tuple[str, str]:
    try:
        payload = token.split(".")[1]
        import base64
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        oid, tid = claims.get("oid"), claims.get("tid")
        if not isinstance(oid, str) or not isinstance(tid, str):
            raise ValueError
        if not re.fullmatch(r"[0-9a-fA-F-]{36}", oid) or not re.fullmatch(r"[0-9a-fA-F-]{36}", tid):
            raise ValueError
        return oid, tid
    except (IndexError, ValueError, json.JSONDecodeError, TypeError):
        raise RuntimeError("M365 access token is missing valid oid/tid claims") from None


def _query(token: str, oid: str, tid: str, conversation_id: str, session_id: str, request_id: str,
           model: str, agent_id: str | None) -> str:
    scenario, license_type = routing_for_model(model)
    params = {
        "chatsessionid": request_id,
        "clientrequestid": request_id,
        "X-SessionId": session_id,
        "ConversationId": conversation_id,
        "access_token": token,
        "variants": VARIANTS,
        "source": '"officeweb"',
        "product": "Office",
        "agentHost": "Bizchat.FullScreen",
        "licenseType": license_type,
        "agent": "web",
        "scenario": scenario,
        "disableMemory": "1",
    }
    base = os.environ.get("M365_WS_URL", f"{WS_ENDPOINT}/{oid}@{tid}")
    return base + ("&" if "?" in base else "?") + urlencode(params)


def _chat_args(text: str, model: str, session_id: str,
               request_id: str, agent_id: str | None, is_start: bool,
               tool_turn: bool = False) -> dict:
    tone = tone_for_model(model)
    options = [] if agent_id or tool_turn or os.environ.get("M365_NO_CODE_INTERPRETER") == "1" else CODE_INTERPRETER_OPTIONS
    args = {
        "source": "officeweb", "clientCorrelationId": request_id, "sessionId": session_id,
        "optionsSets": options, "streamingMode": "ConciseWithPadding", "spokenTextMode": "None",
        "options": {}, "extraExtensionParameters": {}, "allowedMessageTypes": ALLOWED_MESSAGE_TYPES,
        "sliceIds": [], "threadLevelGptId": {"id": agent_id, "source": "MOS3"} if agent_id else {},
        "traceId": request_id, "isStartOfSession": is_start,
        "clientInfo": {
            "clientPlatform": "mcmcopilot-web", "clientAppName": "Office",
            "clientEntrypoint": "mcmcopilot-officeweb", "clientSessionId": session_id,
            "clientAppType": "Web", "deviceOS": "Linux", "deviceType": "Desktop",
        },
        "message": {
            "author": "user", "inputMethod": "Keyboard", "text": text, "entityAnnotationTypes": [
                "People", "File", "Event", "Email", "TeamsMessage",
            ], "requestId": request_id, "locationInfo": {"timeZoneOffset": 1, "timeZone": "Europe/Copenhagen"},
            "locale": "en-gb", "messageType": "Chat", "experienceType": "Default",
            "adaptiveCards": [], "clientPreferences": {},
        },
        "plugins": [] if agent_id else [{"Id": "BingWebSearch", "Source": "BuiltIn"}],
        "isSbsSupported": True, "tone": tone, "renderReferencesBehindEOS": True,
        "disconnectBehavior": "continue",
    }
    if agent_id:
        args["gpts"] = [{"id": agent_id, "source": "MOS3", "version": "1.0.0",
                          "clientOverrides": {"capabilities": [], "deepResearchModels@odata.type": "Collection(String)"}}]
    return args


def _parse_frames(raw: str):
    for chunk in raw.split(RS):
        if not chunk:
            continue
        try:
            yield json.loads(chunk)
        except json.JSONDecodeError:
            continue


def _text_from_messages(messages) -> tuple[str, str | None, int | None]:
    texts, message_type, turn_count = [], None, None
    if not isinstance(messages, list):
        return "", None, None
    for message in messages:
        if not isinstance(message, dict) or message.get("author") != "bot":
            continue
        if message.get("messageType"):
            message_type = message["messageType"]
        if isinstance(message.get("turnCount"), int):
            turn_count = message["turnCount"]
        text = message.get("text")
        if isinstance(text, str) and text and not message.get("messageType"):
            texts.append(text)
    return "\n\n".join(texts), message_type, turn_count


def _hosted_shell_command(messages: list) -> str | None:
    for message in messages:
        if not isinstance(message, dict):
            continue
        if message.get("messageType") != "Progress" or message.get("contentType") != "Code":
            continue
        hidden_text = message.get("hiddenText")
        if isinstance(hidden_text, str):
            match = re.match(r"^bash\s+-lc\s+([\s\S]+)$", hidden_text)
            if match:
                return match.group(1)
    return None


def _fold(current: str, next_text: str) -> str:
    if not next_text or next_text == current or current.startswith(next_text):
        return current
    if next_text.startswith(current):
        return next_text
    common = 0
    for left, right in zip(current, next_text):
        if left != right:
            break
        common += 1
    if common >= min(12, len(current) // 2):
        return next_text
    return current + next_text


async def send_turn(token: str, prompt: str, model: str, conversation_id: str, session_id: str,
                    agent_id: str | None, is_start: bool, on_delta=None, tool_turn: bool = False,
                    intercept_hosted_shell: bool = False) -> TurnResult:
    oid, tid = token_claims(token)
    request_id = str(uuid.uuid4())
    uri = _query(token, oid, tid, conversation_id, session_id, request_id, model, agent_id)
    headers = {"Accept-Language": "en-GB,en;q=0.9", "Cache-Control": "no-cache", "Pragma": "no-cache"}
    result = TurnResult()
    try:
        async with websockets.connect(
            uri, origin="https://m365.cloud.microsoft",
            user_agent_header="Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0",
            additional_headers=headers, open_timeout=30, close_timeout=5, max_size=4 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps({"protocol": "json", "version": 1}) + RS)
            handshake_ok = False
            async for frame in ws:
                for msg in _parse_frames(frame):
                    if isinstance(msg, dict) and msg.get("error"):
                        raise RuntimeError(f"SignalR handshake failed: {msg['error']}")
                    if msg == {}:
                        handshake_ok = True
                        break
                if handshake_ok:
                    break
            if not handshake_ok:
                raise RuntimeError("SignalR handshake ended before acknowledgement")
            chat = {"arguments": [_chat_args(prompt, model, session_id, request_id, agent_id, is_start, tool_turn)],
                    "invocationId": "0", "target": "chat", "type": 4}
            now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            metrics = {"arguments": [{"Timestamps": {"ConnectionStart": now, "UserInputStart": now,
                        "ConnectionEstablished": now, "UserInputSubmit": now}}], "target": "Metrics", "type": 1}
            await ws.send(json.dumps(chat, separators=(",", ":")) + RS + json.dumps(metrics, separators=(",", ":")) + RS)
            current_text = ""
            intercepted = False
            async for frame in ws:
                for msg in _parse_frames(frame):
                    if not isinstance(msg, dict):
                        continue
                    frame_type = msg.get("type")
                    if frame_type == 6:
                        await ws.send(json.dumps({"type": 6}) + RS)
                    elif frame_type == 7:
                        if msg.get("error"):
                            result.error = str(msg["error"])
                    elif frame_type == 1 and msg.get("target") == "update":
                        for arg in msg.get("arguments", []):
                            if not isinstance(arg, dict):
                                continue
                            if isinstance(arg.get("writeAtCursor"), str):
                                current_text += arg["writeAtCursor"]
                            elif isinstance(arg.get("messages"), list):
                                command = _hosted_shell_command(arg["messages"]) if intercept_hosted_shell and not agent_id else None
                                if command:
                                    result.text = f"```bash\n{command}\n```"
                                    await ws.send(STOP_FRAME)
                                    await asyncio.sleep(0.5)
                                    intercepted = True
                                    break
                                snapshot, message_type, turn_count = _text_from_messages(arg["messages"])
                                current_text = _fold(current_text, snapshot)
                                result.message_type = message_type or result.message_type
                                result.turn_count = turn_count or result.turn_count
                            if on_delta and len(current_text) > len(result.text):
                                delta = current_text[len(result.text):]
                                result.text = current_text
                                on_delta(delta)
                        if intercepted:
                            break
                    elif frame_type == 2:
                        item = msg.get("item") or {}
                        result.raw_item = item
                        snapshot, message_type, turn_count = _text_from_messages(item.get("messages"))
                        if snapshot:
                            current_text = _fold(current_text, snapshot)
                        result.message_type = message_type or result.message_type
                        result.turn_count = turn_count or result.turn_count
                        server_result = item.get("result")
                        if isinstance(server_result, dict):
                            result.result = server_result
                            result.error = server_result.get("message") if server_result.get("value") not in {"Success", "Completed", None} else result.error
                            result.error_code = server_result.get("errorCode")
                        throttling = item.get("throttling") or {}
                        metering = throttling.get("metering") or {}
                        if isinstance(metering, dict):
                            result.metering = {
                                key: value["remainingAllowance"] for key, value in metering.items()
                                if isinstance(value, dict) and isinstance(value.get("remainingAllowance"), (int, float))
                            }
                        if on_delta and len(current_text) > len(result.text):
                            on_delta(current_text[len(result.text):])
                        result.text = current_text
                        break
                    elif frame_type == 3:
                        if msg.get("error"):
                            result.error = str(msg["error"])
                            result.error_code = "SignalRInvocationError"
                if result.raw_item is not None or result.error_code == "SignalRInvocationError" or intercepted:
                    break
    except Exception as exc:
        result.error = str(exc)
        result.error_code = "M365TransportError"
    return result
