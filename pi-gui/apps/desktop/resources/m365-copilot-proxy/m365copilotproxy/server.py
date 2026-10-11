from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit

from . import agent as agent_module
from .auth import AuthenticationError, CHAT_SCOPES, TokenProvider
from .images import images_from_messages, prepare_image_attachments
from .catalog import METERED_BUDGETS, default_framing, models_response, routing_for_model, tone_for_model, uses_agent
from .m365 import TurnResult, send_turn
from .tooling import content_text, find_shell_tool, format_delta, format_messages, parse_tool_calls

MAX_BODY = 2 * 1024 * 1024
MAX_CONVERSATIONS = 128
IDLE_SECONDS = 30 * 60
PRIORITY_ACCESS = re.compile(r"(?:you.?ve|you have)\s+used\s+(?:up\s+)?(?:all\s+of\s+)?your\s+(?:available\s+)?priority access(?:\s+to\s+the\s+([\w.\- ]{1,32}?)\s+model)?\s+for\s+(?:the\s+)?(today|day|week|this\s+week)\b", re.I)


class ApiError(Exception):
    def __init__(self, status: int, message: str, code: str, error_type: str | None = None,
                 headers: dict[str, str] | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code
        self.error_type = error_type or ("rate_limit_error" if status == 429 else "invalid_request_error" if status < 500 else "server_error")
        self.headers = headers or {}

    def body(self) -> dict:
        return {"error": {"message": self.message, "type": self.error_type, "param": None, "code": self.code}}


@dataclass
class Conversation:
    key: str
    conversation_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    sent_count: int = 0
    turn_count: int = 0
    model: str | None = None
    touched: float = field(default_factory=time.monotonic)
    response_history: list[dict] = field(default_factory=list)
    lock: threading.RLock = field(default_factory=threading.RLock)

    def reset(self) -> None:
        self.conversation_id = str(uuid.uuid4())
        self.session_id = str(uuid.uuid4())
        self.sent_count = 0
        self.turn_count = 0
        self.model = None
        self.response_history.clear()


@dataclass
class ChatResult:
    id: str
    created: int
    model: str
    text: str
    tool_calls: list[dict]
    finish_reason: str
    conversation: Conversation

    def body(self) -> dict:
        message = {"role": "assistant", "content": self.text or None}
        if self.tool_calls:
            message["tool_calls"] = self.tool_calls
        return {
            "id": self.id,
            "object": "chat.completion",
            "created": self.created,
            "model": self.model,
            "choices": [{"index": 0, "message": message, "finish_reason": self.finish_reason}],
        }


class ProxyApplication:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.conversations: dict[str, Conversation] = {}
        self.response_sessions: dict[str, str] = {}
        self.token_provider: TokenProvider | None = None
        self.agent_id: str | None = None
        self.agent_loaded = False
        self.dead_agent_tones: set[str] = set()
        self.alive_agent_tones: set[str] = set()
        self.exhaustions: dict[str, dict] = {}
        self.metering: dict[str, float] = {}

    def clear(self) -> None:
        with self._lock:
            self.conversations.clear()
            self.response_sessions.clear()
            self.dead_agent_tones.clear()
            self.alive_agent_tones.clear()
            self.exhaustions.clear()
            self.metering.clear()

    def _conversation(self, key: str) -> Conversation:
        now = time.monotonic()
        with self._lock:
            stale = [k for k, state in self.conversations.items() if now - state.touched > IDLE_SECONDS]
            for stale_key in stale:
                del self.conversations[stale_key]
                for response_id, mapped_key in tuple(self.response_sessions.items()):
                    if mapped_key == stale_key:
                        del self.response_sessions[response_id]
            state = self.conversations.get(key)
            if state is None:
                if len(self.conversations) >= MAX_CONVERSATIONS:
                    oldest = min(self.conversations.values(), key=lambda item: item.touched)
                    del self.conversations[oldest.key]
                    for response_id, mapped_key in tuple(self.response_sessions.items()):
                        if mapped_key == oldest.key:
                            del self.response_sessions[response_id]
                state = Conversation(key)
                self.conversations[key] = state
            state.touched = now
            return state

    def _token(self) -> str:
        fixture = os.environ.get("M365_TEST_ACCESS_TOKEN")
        if fixture:
            endpoint = urlsplit(os.environ.get("M365_WS_URL", ""))
            if endpoint.hostname not in {"127.0.0.1", "localhost", "::1"}:
                raise ApiError(500, "M365_TEST_ACCESS_TOKEN is only allowed with a loopback M365_WS_URL", "invalid_test_configuration")
            return fixture
        if self.token_provider is None:
            self.token_provider = TokenProvider()
        try:
            return self.token_provider.token(CHAT_SCOPES)
        except AuthenticationError as exc:
            raise ApiError(401, str(exc), "m365_authentication_failed", "authentication_error") from None

    def _agent(self, model: str, has_tools: bool) -> str | None:
        force = os.environ.get("M365_FORCE_AGENT")
        tone = tone_for_model(model)
        if force == "0" or (not has_tools and not uses_agent(model, False)):
            return None
        if has_tools and force != "1" and not uses_agent(model, True):
            return None
        if tone in self.dead_agent_tones and force != "1":
            return None
        if not self.agent_loaded:
            self.agent_loaded = True
            if os.environ.get("M365_TEST_ACCESS_TOKEN"):
                self.agent_id = os.environ.get("M365_AGENT_ID")
            else:
                provider = self.token_provider or TokenProvider()
                self.token_provider = provider
                self.agent_id = agent_module.get_or_create_agent(provider)
        return self.agent_id

    def _budget(self, model: str) -> str | None:
        lowered = model.lower()
        scenario, _ = routing_for_model(model)
        if scenario != "OfficeWebPaidCopilot":
            return None
        if tone_for_model(model) == "Claude_Opus" and not lowered.startswith(("claude-opus-4.5", "claude-opus-4-5")):
            return "opus"
        if "sonnet-5.5" in lowered or "sonnet-5-5" in lowered:
            return "sonnet-5.5"
        return None

    def _active_exhaustion(self, key: str) -> dict | None:
        with self._lock:
            entry = self.exhaustions.get(key)
            if entry and entry["resets_at"] <= datetime.now(timezone.utc):
                self.exhaustions.pop(key, None)
                return None
            return entry

    def _record_exhaustion(self, key: str, window: str, message: str) -> dict:
        now = datetime.now(timezone.utc)
        if window == "week":
            days = ((7 - now.weekday()) % 7) or 7
            reset = datetime(now.year, now.month, now.day, tzinfo=timezone.utc) + timedelta(days=days)
        else:
            reset = datetime(now.year, now.month, now.day, tzinfo=timezone.utc) + timedelta(days=1)
        entry = {"window": window, "resets_at": reset, "message": message}
        with self._lock:
            previous = self.exhaustions.get(key)
            if previous is None or entry["resets_at"] > previous["resets_at"]:
                self.exhaustions[key] = entry
            else:
                entry = previous
        return entry

    def _priority_exhaustion(self, result: TurnResult, model: str) -> dict | None:
        message = str((result.result or {}).get("message") or result.text or "").strip()
        match = PRIORITY_ACCESS.search(message)
        if match:
            window = "week" if "week" in match.group(2).lower() else "day"
            key = self._budget(model) or model
            return self._record_exhaustion(key, window, message)
        if (result.result or {}).get("value") == "OutOfCredits":
            window = "week" if re.search(r"\bweek|monday\b", message, re.I) else "day"
            key = self._budget(model) or model
            return self._record_exhaustion(key, window, message or "OutOfCredits")
        return None

    def _remember_metering(self, result: TurnResult, model: str) -> None:
        if not result.metering:
            return
        self.metering.update(result.metering)
        budget = self._budget(model)
        if not budget:
            return
        daily_key, weekly_key = METERED_BUDGETS[budget]
        daily = result.metering.get(daily_key)
        weekly = result.metering.get(weekly_key)
        if daily is not None and daily <= 0 and weekly is not None and weekly <= 0:
            self._record_exhaustion(budget, "week", "Priority access weekly allowance exhausted")
        elif daily is not None and daily <= 0:
            self._record_exhaustion(budget, "day", "Priority access daily allowance exhausted")
        elif weekly is not None and weekly <= 0:
            self._record_exhaustion(budget, "week", "Priority access weekly allowance exhausted")

    def _priority_error(self, exhaustion: dict, model: str) -> ApiError:
        seconds = max(1, int((exhaustion["resets_at"] - datetime.now(timezone.utc)).total_seconds() + 0.999))
        reset = exhaustion["resets_at"].isoformat().replace("+00:00", "Z")
        message = f"Priority access for {model} is exhausted until {reset}. {exhaustion['message']}"
        return ApiError(429, message, "priority_access_exhausted", headers={"Retry-After": str(seconds)})

    def chat(self, body: dict, session_key: str, on_delta=None) -> ChatResult:
        messages = body["messages"]
        if not messages:
            raise ApiError(400, "messages must contain at least one message", "invalid_request_error")
        state = self._conversation(session_key)
        with state.lock:
            state.touched = time.monotonic()
            if len(messages) < state.sent_count:
                state.reset()
            requested_model = body.get("model", "m365-copilot")
            if not isinstance(requested_model, str) or not requested_model:
                raise ApiError(400, "model must be a non-empty string", "invalid_request_error")
            tools = body.get("tools") or []
            has_tools = bool(tools) and body.get("tool_choice") != "none"
            shell_tool = find_shell_tool(tools) if has_tools else None
            shell_tool_name = (shell_tool or {}).get("function", {}).get("name")
            tool_choice = body.get("tool_choice")
            chosen_tool = (tool_choice.get("function") or {}).get("name") if isinstance(tool_choice, dict) else None
            intercept_hosted_shell = bool(shell_tool_name and (chosen_tool is None or chosen_tool == shell_tool_name))
            requested_budget = self._budget(requested_model)
            exhaustion_key = requested_budget or requested_model
            known = self._active_exhaustion(exhaustion_key)
            fallback = None
            if known and requested_budget:
                fallback = os.environ.get("M365_OPUS_FALLBACK_MODEL" if requested_budget == "opus" else "M365_SONNET_FALLBACK_MODEL")
            if known and not fallback:
                raise self._priority_error(known, requested_model)
            model = fallback or requested_model
            if state.model and state.model != model:
                state.reset()
            if state.sent_count == 0:
                variant = os.environ.get("M365_FRAMING_VARIANT") or default_framing(model)
                if variant not in {"baseline", "relay", "relay_batch"}:
                    variant = default_framing(model)
                prompt = format_messages(messages, tools, body.get("tool_choice"), state.conversation_id, variant)
            else:
                delta_messages = messages[state.sent_count:]
                prompt = format_delta(delta_messages, messages) if delta_messages else ""
                if not prompt:
                    prompt = "Please continue."
            token = self._token()
            agent_id = self._agent(model, has_tools)
            new_messages = messages if state.sent_count == 0 else messages[state.sent_count:]
            try:
                images = images_from_messages(new_messages)
                annotations = prepare_image_attachments(token, state.conversation_id, images)
            except ValueError as error:
                raise ApiError(400, str(error), "invalid_request_error") from None
            except RuntimeError as error:
                raise ApiError(502, str(error), "m365_image_upload_failed") from None
            stream_delta = on_delta if body.get("stream") and not has_tools and not requested_budget else None
            result = send_turn(
                token, prompt, model, state.conversation_id, state.session_id, agent_id,
                state.turn_count == 0, stream_delta, tool_turn=has_tools,
                intercept_hosted_shell=intercept_hosted_shell, annotations=annotations,
            )
            tone = tone_for_model(model)
            if agent_id and (result.result or {}).get("value") == "InternalError" and not result.text \
                    and tone in {"Gpt_6_Sol_Reasoning", "Gpt_61_Sol_Reasoning"} \
                    and tone not in self.alive_agent_tones and os.environ.get("M365_FORCE_AGENT") != "1":
                self.dead_agent_tones.add(tone)
                state.reset()
                variant = os.environ.get("M365_FRAMING_VARIANT") or default_framing(model)
                prompt = format_messages(messages, tools, body.get("tool_choice"), state.conversation_id, variant)
                result = send_turn(
                    token, prompt, model, state.conversation_id, state.session_id, None, True, stream_delta,
                    tool_turn=has_tools, intercept_hosted_shell=intercept_hosted_shell, annotations=annotations,
                )
            if result.error_code == "M365TransportError":
                raise ApiError(502, result.error or "M365 transport failed", "m365_transport_error")
            self._remember_metering(result, model)
            exhausted = self._priority_exhaustion(result, model)
            if exhausted:
                fallback_setting = "M365_OPUS_FALLBACK_MODEL" if requested_budget == "opus" else "M365_SONNET_FALLBACK_MODEL"
                fallback_model = os.environ.get(fallback_setting) if requested_budget else None
                if fallback_model and model == requested_model:
                    state.reset()
                    model = fallback_model
                    agent_id = self._agent(model, has_tools)
                    variant = os.environ.get("M365_FRAMING_VARIANT") or default_framing(model)
                    if variant not in {"baseline", "relay", "relay_batch"}:
                        variant = default_framing(model)
                    prompt = format_messages(messages, tools, body.get("tool_choice"), state.conversation_id, variant)
                    result = send_turn(
                        token, prompt, model, state.conversation_id, state.session_id, agent_id, True, stream_delta,
                        tool_turn=has_tools, intercept_hosted_shell=intercept_hosted_shell, annotations=annotations,
                    )
                    if result.error_code == "M365TransportError":
                        raise ApiError(502, result.error or "M365 transport failed", "m365_transport_error")
                    self._remember_metering(result, model)
                    fallback_exhaustion = self._priority_exhaustion(result, model)
                    if fallback_exhaustion:
                        raise self._priority_error(fallback_exhaustion, model)
                else:
                    raise self._priority_error(exhausted, requested_model)
            if (result.result or {}).get("value") == "Throttled" or result.error_code == "PerUserThrottled":
                raise ApiError(429, result.error or "Microsoft 365 throttled this conversation", "m365_throttled", headers={"Retry-After": "60"})
            if result.message_type == "Disengaged":
                state.reset()
                variant = os.environ.get("M365_FRAMING_VARIANT") or default_framing(model)
                if variant == "baseline":
                    variant = "relay"
                prompt = format_messages(messages, tools, body.get("tool_choice"), state.conversation_id, variant)
                result = send_turn(
                    token, prompt, model, state.conversation_id, state.session_id, agent_id, True, stream_delta,
                    tool_turn=has_tools, intercept_hosted_shell=intercept_hosted_shell,
                )
                if result.message_type == "Disengaged":
                    raise ApiError(502, "M365 returned a Disengaged response", "m365_disengaged")
            if result.error:
                raise ApiError(502, result.error, result.error_code or "m365_error")
            if not result.text:
                raise ApiError(502, "M365 returned an empty turn without a Disengaged frame", "m365_empty_turn")
            if tools and body.get("tool_choice") != "none":
                tool_calls, text = parse_tool_calls(result.text, tools)
            else:
                tool_calls, text = [], result.text.strip()
            state.sent_count = len(messages)
            state.turn_count += 1
            state.model = model
            state.touched = time.monotonic()
            if agent_id and result.text:
                self.alive_agent_tones.add(tone_for_model(model))
            return ChatResult(
                id="chatcmpl-" + uuid.uuid4().hex,
                created=int(time.time()), model=model, text=text, tool_calls=tool_calls,
                finish_reason="tool_calls" if tool_calls else "stop", conversation=state,
            )

    def responses(self, body: dict, session_key: str | None) -> dict:
        input_messages = _response_input(body.get("input", ""))
        if not input_messages:
            raise ApiError(400, "input must contain at least one message", "invalid_request_error")
        previous = body.get("previous_response_id")
        with self._lock:
            previous_key = self.response_sessions.get(previous) if previous else None
        if previous and not previous_key:
            raise ApiError(404, "previous_response_id is unknown or expired", "previous_response_not_found")
        conversation_key = previous_key or session_key or "responses:" + uuid.uuid4().hex
        state = self._conversation(conversation_key)
        with state.lock:
            existing = list(state.response_history)
            if previous:
                messages = existing + input_messages
            elif session_key and existing:
                messages = input_messages if input_messages[:len(existing)] == existing else existing + input_messages
            else:
                messages = list(input_messages)
            instructions = body.get("instructions")
            if isinstance(instructions, str) and instructions and not existing and not previous:
                messages.insert(0, {"role": "system", "content": instructions})
        chat_body = {
            "model": body.get("model", "m365-copilot"), "messages": messages,
            "tools": _response_tools(body.get("tools")),
            "tool_choice": _response_tool_choice(body.get("tool_choice")),
            "stream": bool(body.get("stream")),
        }
        completed = self.chat(_validate_chat(chat_body), conversation_key)
        with state.lock:
            assistant = {"role": "assistant", "content": completed.text or None}
            if completed.tool_calls:
                assistant["tool_calls"] = completed.tool_calls
            state.response_history = list(messages) + [assistant]
            state.touched = time.monotonic()
        response_id = "resp_" + uuid.uuid4().hex
        response = _response_object(response_id, completed)
        with self._lock:
            self.response_sessions[response_id] = conversation_key
        return response


APPLICATION = ProxyApplication()


def _validate_chat(body) -> dict:
    if not isinstance(body, dict):
        raise ApiError(400, "request body must be a JSON object", "invalid_request_error")
    model = body.get("model", "m365-copilot")
    if not isinstance(model, str) or not model:
        raise ApiError(400, "model must be a non-empty string", "invalid_request_error")
    messages = body.get("messages")
    if not isinstance(messages, list):
        raise ApiError(400, "messages must be an array", "invalid_request_error")
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or message.get("role") not in {"system", "developer", "user", "assistant", "tool"}:
            raise ApiError(400, f"messages[{index}] has an invalid role", "invalid_request_error")
        try:
            content_text(message)
        except ValueError as exc:
            raise ApiError(400, f"messages[{index}]: {exc}", "invalid_request_error") from None
        if message.get("tool_calls") is not None and not isinstance(message["tool_calls"], list):
            raise ApiError(400, f"messages[{index}].tool_calls must be an array", "invalid_request_error")
    tools = body.get("tools", [])
    if not isinstance(tools, list) or len(tools) > 128:
        raise ApiError(400, "tools must be an array with at most 128 entries", "invalid_request_error")
    try:
        for tool in tools:
            from .tooling import _spec
            _spec(tool)
    except (ValueError, TypeError, KeyError) as exc:
        raise ApiError(400, f"invalid tool definition: {exc}", "invalid_request_error") from None
    tool_choice = body.get("tool_choice")
    if tool_choice not in (None, "auto", "none", "required") and not isinstance(tool_choice, dict):
        raise ApiError(400, "tool_choice is invalid", "invalid_request_error")
    if isinstance(tool_choice, dict) and (tool_choice.get("type") != "function" or not isinstance((tool_choice.get("function") or {}).get("name"), str)):
        raise ApiError(400, "tool_choice function selector is invalid", "invalid_request_error")
    if "stream" in body and not isinstance(body["stream"], bool):
        raise ApiError(400, "stream must be a boolean", "invalid_request_error")
    body["model"] = model
    body["messages"] = messages
    body["tools"] = tools
    return body


def _response_input(value) -> list[dict]:
    if isinstance(value, str):
        return [{"role": "user", "content": value}] if value else []
    if not isinstance(value, list):
        raise ApiError(400, "input must be a string or array", "invalid_request_error")
    messages = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ApiError(400, f"input[{index}] must be an object", "invalid_request_error")
        kind = item.get("type", "message")
        if kind == "function_call":
            name, call_id = item.get("name"), item.get("call_id") or item.get("id")
            if not isinstance(name, str) or not isinstance(call_id, str):
                raise ApiError(400, f"input[{index}] function_call requires name and call_id", "invalid_request_error")
            messages.append({"role": "assistant", "content": None, "tool_calls": [{"id": call_id, "type": "function",
                             "function": {"name": name, "arguments": item.get("arguments", "{}")}}]})
        elif kind == "function_call_output":
            call_id = item.get("call_id")
            if not isinstance(call_id, str):
                raise ApiError(400, f"input[{index}] function_call_output requires call_id", "invalid_request_error")
            output = item.get("output", "")
            if not isinstance(output, str):
                output = json.dumps(output, ensure_ascii=False)
            messages.append({"role": "tool", "tool_call_id": call_id, "content": output})
        elif kind in {"message", "input_text", "output_text"} or item.get("role"):
            role = item.get("role", "user")
            if role not in {"system", "developer", "user", "assistant"}:
                raise ApiError(400, f"input[{index}] has an invalid role", "invalid_request_error")
            content = item.get("content", "")
            if isinstance(content, list):
                text = []
                for part in content:
                    if not isinstance(part, dict) or part.get("type") not in {"input_text", "output_text", "text"}:
                        raise ApiError(400, f"input[{index}] contains unsupported content", "invalid_request_error")
                    text.append(part.get("text", ""))
                content = "".join(text)
            if not isinstance(content, str):
                raise ApiError(400, f"input[{index}].content must be text", "invalid_request_error")
            messages.append({"role": role, "content": content})
        else:
            raise ApiError(400, f"input[{index}] has unsupported type {kind!r}", "invalid_request_error")
    return messages


def _response_tools(tools) -> list[dict]:
    if tools is None:
        return []
    if not isinstance(tools, list) or len(tools) > 128:
        raise ApiError(400, "tools must be an array with at most 128 entries", "invalid_request_error")
    result = []
    for index, tool in enumerate(tools):
        if not isinstance(tool, dict) or tool.get("type") != "function":
            raise ApiError(400, f"tools[{index}] must be a function tool", "invalid_request_error")
        if isinstance(tool.get("function"), dict):
            result.append(tool)
        else:
            result.append({"type": "function", "function": {key: tool[key] for key in ("name", "description", "parameters") if key in tool}})
    return result


def _response_tool_choice(value):
    if value is None or (isinstance(value, str) and value in {"auto", "none", "required"}):
        return value
    if isinstance(value, dict):
        if value.get("type") == "function" and isinstance(value.get("name"), str):
            return {"type": "function", "function": {"name": value["name"]}}
        if value.get("type") == "function" and isinstance(value.get("function"), dict):
            return value
    raise ApiError(400, "tool_choice is invalid", "invalid_request_error")


def _response_object(response_id: str, completed: ChatResult) -> dict:
    output = []
    if completed.text:
        output.append({"id": "msg_" + uuid.uuid4().hex, "type": "message", "status": "completed", "role": "assistant",
                       "content": [{"type": "output_text", "text": completed.text, "annotations": []}]})
    for call in completed.tool_calls:
        fn = call["function"]
        output.append({"id": "fc_" + uuid.uuid4().hex, "type": "function_call", "status": "completed",
                       "call_id": call["id"], "name": fn["name"], "arguments": fn["arguments"]})
    text = completed.text if not completed.tool_calls else None
    return {"id": response_id, "object": "response", "created_at": completed.created,
            "status": "completed", "error": None, "incomplete_details": None, "model": completed.model,
            "output": output, "output_text": text, "usage": None}




def _chunk_text(text: str, size: int = 48):
    for offset in range(0, len(text), size):
        yield text[offset:offset + size]


class ChatStreamer:
    def __init__(self, handler: BaseHTTPRequestHandler, model: str, completion_id: str, created: int):
        self.handler = handler
        self.model = model
        self.completion_id = completion_id
        self.created = created
        self.buffer = ""
        self.sent_text = ""
        self.started = False
        self.closed = False

    def _send(self, value) -> None:
        if self.closed:
            return
        try:
            self.handler.wfile.write(("data: " + json.dumps(value, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.closed = True

    def _start(self) -> None:
        if self.started:
            return
        self.handler.send_response(200)
        self.handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.handler.send_header("Cache-Control", "no-cache")
        self.handler.send_header("Connection", "close")
        self.handler.send_header("X-Accel-Buffering", "no")
        self.handler.end_headers()
        self.started = True
        self._send({"id": self.completion_id, "object": "chat.completion.chunk", "created": self.created,
                    "model": self.model, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})

    def delta(self, value: str) -> None:
        if self.closed:
            return
        self.buffer += value
        if not self.started:
            normalized = self.buffer.replace("\u2018", "'").replace("\u2019", "'").lstrip().lower()
            gates = ("you've used your available priority access", "you've used up all of your priority access",
                     "you have used your available priority access", "you have used up all of your priority access")
            if any(gate.startswith(normalized) or normalized.startswith(gate) for gate in gates):
                return
            self._start()
        self._emit(self.buffer)
        self.buffer = ""

    def _emit(self, text: str) -> None:
        for chunk in _chunk_text(text):
            self._send({"id": self.completion_id, "object": "chat.completion.chunk", "created": self.created,
                        "model": self.model, "choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}]})
            self.sent_text += chunk

    def complete(self, result: ChatResult) -> None:
        if not self.started:
            self._start()
        if result.text.startswith(self.sent_text):
            self._emit(result.text[len(self.sent_text):])
        for index, call in enumerate(result.tool_calls):
            self._send({"id": self.completion_id, "object": "chat.completion.chunk", "created": self.created,
                        "model": result.model, "choices": [{"index": 0, "delta": {"tool_calls": [{
                            "index": index, **call,
                        }]}, "finish_reason": None}]})
        self._send({"id": self.completion_id, "object": "chat.completion.chunk", "created": self.created,
                    "model": result.model, "choices": [{"index": 0, "delta": {}, "finish_reason": result.finish_reason}]})
        if not self.closed:
            try:
                self.handler.wfile.write(b"data: [DONE]\n\n")
                self.handler.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                self.closed = True

    def fail(self, error: ApiError) -> bool:
        if not self.started:
            return False
        self._send(error.body())
        if not self.closed:
            try:
                self.handler.wfile.write(b"data: [DONE]\n\n")
                self.handler.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                self.closed = True
        return True


def _responses_sse(response: dict):
    yield "response.created", {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}}
    yield "response.in_progress", {"type": "response.in_progress", "response": {**response, "status": "in_progress", "output": []}}
    for index, item in enumerate(response["output"]):
        yield "response.output_item.added", {"type": "response.output_item.added", "output_index": index, "item": {**item, "status": "in_progress"}}
        if item["type"] == "message":
            part = {"type": "output_text", "text": "", "annotations": []}
            yield "response.content_part.added", {"type": "response.content_part.added", "item_id": item["id"], "output_index": index, "content_index": 0, "part": part}
            text = item["content"][0]["text"]
            for delta in _chunk_text(text):
                yield "response.output_text.delta", {"type": "response.output_text.delta", "item_id": item["id"], "output_index": index, "content_index": 0, "delta": delta}
            yield "response.output_text.done", {"type": "response.output_text.done", "item_id": item["id"], "output_index": index, "content_index": 0, "text": text}
            yield "response.content_part.done", {"type": "response.content_part.done", "item_id": item["id"], "output_index": index, "content_index": 0, "part": item["content"][0]}
        else:
            args = item["arguments"]
            for delta in _chunk_text(args):
                yield "response.function_call_arguments.delta", {"type": "response.function_call_arguments.delta", "item_id": item["id"], "output_index": index, "delta": delta}
            yield "response.function_call_arguments.done", {"type": "response.function_call_arguments.done", "item_id": item["id"], "output_index": index, "arguments": args}
        yield "response.output_item.done", {"type": "response.output_item.done", "output_index": index, "item": item}
    yield "response.completed", {"type": "response.completed", "response": response}


class ProxyHandler(BaseHTTPRequestHandler):
    server_version = "M365CopilotProxy/0.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.log_date_time_string()} {self.client_address[0]} {fmt % args}", file=sys.stderr)

    def _json(self, status: int, value: dict, headers: dict[str, str] | None = None) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        for key, val in (headers or {}).items():
            self.send_header(key, val)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path.rstrip("/")
        if path == "/v1/models":
            self._json(200, models_response())
        else:
            self._json(404, {"error": {"message": "Not found", "type": "invalid_request_error", "param": None, "code": "not_found"}})

    def do_POST(self) -> None:
        if urlsplit(self.path).path.rstrip("/") not in {"/v1/chat/completions", "/v1/responses"}:
            self._json(404, {"error": {"message": "Not found", "type": "invalid_request_error", "param": None, "code": "not_found"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
            if length < 0:
                raise ApiError(411, "Content-Length is required", "length_required")
            if length > MAX_BODY:
                raise ApiError(413, "Request body exceeds 2 MiB", "request_too_large")
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise ApiError(400, "Request body is not valid JSON", "invalid_json") from None
            path = urlsplit(self.path).path.rstrip("/")
            session_header = self.headers.get("X-M365-Conversation-ID")
            if session_header is not None and (not session_header or len(session_header) > 128 or not re.fullmatch(r"[A-Za-z0-9_.:-]+", session_header)):
                raise ApiError(400, "X-M365-Conversation-ID must be 1-128 ASCII letters, digits, '.', '_', ':', or '-'", "invalid_conversation_id")
            if path == "/v1/chat/completions":
                body = _validate_chat(body)
                key = session_header or "request:" + uuid.uuid4().hex
                stream = body.get("stream", False)
                streamer = ChatStreamer(self, body["model"], "chatcmpl-" + uuid.uuid4().hex, int(time.time())) if stream else None
                try:
                    result = APPLICATION.chat(body, key, on_delta=streamer.delta if streamer else None)
                except ApiError as exc:
                    if streamer and streamer.fail(exc):
                        return
                    self._json(exc.status, exc.body(), exc.headers)
                    return
                if streamer:
                    streamer.model = result.model
                    streamer.complete(result)
                else:
                    self._json(200, result.body())
            else:
                if not isinstance(body, dict):
                    raise ApiError(400, "request body must be a JSON object", "invalid_request_error")
                stream = body.get("stream", False)
                if not isinstance(stream, bool):
                    raise ApiError(400, "stream must be a boolean", "invalid_request_error")
                try:
                    response = APPLICATION.responses(body, session_header)
                except ApiError as exc:
                    self._json(exc.status, exc.body(), exc.headers)
                    return
                if stream:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for event, data in _responses_sse(response):
                        self.wfile.write(f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                else:
                    self._json(200, response)
        except ApiError as exc:
            self._json(exc.status, exc.body(), exc.headers)
        except Exception as exc:
            print(f"Unhandled proxy error: {exc}", file=sys.stderr)
            self._json(500, ApiError(500, "Internal proxy error", "internal_error").body())
