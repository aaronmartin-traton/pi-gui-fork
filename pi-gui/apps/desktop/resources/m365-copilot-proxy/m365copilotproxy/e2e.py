from __future__ import annotations

import base64
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from .wsclient import WebSocketError, WebSocketServerConnection

RS = "\x1e"
RECORDS: list[dict] = []
DISENGAGED_SEEN: set[str] = set()
UPLOAD_RECORDS: list[dict] = []


class _UploadHandler(BaseHTTPRequestHandler):
    """Fixture for the substrate UploadFile endpoint."""

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8", "replace")
        UPLOAD_RECORDS.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
        payload = json.dumps({
            "result": {"value": "Success"}, "docId": "doc-fixture-1",
            "fileName": "image-1.png", "fileType": "png",
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args) -> None:
        pass


def _port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _serve_ws(port: int) -> socket.socket:
    """Serve the fake M365 SignalR endpoint, returning the listening socket.

    A daemon thread accepts connections; every connection gets its own daemon
    worker thread, because the proxy opens one WebSocket per turn and the fake
    drives each turn to completion inside the handler.
    """
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", port))
    listener.listen(16)

    def worker(sock: socket.socket) -> None:
        try:
            conn = WebSocketServerConnection.accept(sock)
        except (WebSocketError, OSError):
            sock.close()
            return
        try:
            _fake_m365(conn, conn.request_path)
        finally:
            conn.close()

    def accept_loop() -> None:
        while True:
            try:
                sock, _ = listener.accept()
            except OSError:
                return
            threading.Thread(target=worker, args=(sock,), daemon=True).start()

    threading.Thread(target=accept_loop, daemon=True).start()
    return listener


def _token() -> str:
    payload = {"oid": "11111111-1111-4111-8111-111111111111", "tid": "22222222-2222-4222-8222-222222222222"}
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return "e30." + encoded + ".fixture"


def _frames(raw: str) -> list[dict]:
    result = []
    for frame in raw.split(RS):
        if frame:
            try:
                result.append(json.loads(frame))
            except json.JSONDecodeError:
                pass
    return result


def _fake_m365(conn, path: str) -> None:
    try:
        handshake = _frames(conn.recv(timeout=30))
        if not handshake or handshake[0].get("protocol") != "json":
            return
        conn.send("{}" + RS)
        received = _frames(conn.recv(timeout=30))
        chat = next((frame for frame in received if frame.get("type") == 4 and frame.get("target") == "chat"), None)
        if not chat:
            return
        args = chat["arguments"][0]
        prompt = args["message"]["text"]
        query = parse_qs(urlsplit(path).query)
        agent_id = (args.get("threadLevelGptId") or {}).get("id")
        tone = args.get("tone")
        RECORDS.append({
            "conversation_id": query.get("ConversationId", [""])[0],
            "is_start": args.get("isStartOfSession"),
            "prompt": prompt,
            "tone": tone,
            "scenario": query.get("scenario", [""])[0],
            "agent_id": agent_id,
            "options_sets": args.get("optionsSets"),
            "message_annotations": (args.get("message") or {}).get("messageAnnotations"),
        })
        marker = "disengage-retry" if "disengage-retry" in prompt else None
        disengaged = marker is not None and marker not in DISENGAGED_SEEN
        if disengaged:
            DISENGAGED_SEEN.add(marker)
        quota = ("quota-exhaust" in prompt or "quota-fallback" in prompt) and tone in {"Claude_Opus", "Claude_Sonnet"}
        hosted_command = (
            "echo hosted-shell-e2e" if "hosted-shell-turn" in prompt
            else "echo ignored-shell-e2e" if "hosted-shell-not-selected" in prompt
            else None
        )
        message_type = None
        if disengaged:
            text, result, message_type = "", {"value": "Success"}, "Disengaged"
        elif quota:
            model_name = "Opus" if tone == "Claude_Opus" else "Sonnet"
            text = f"You've used your available priority access to the {model_name} model for today."
            result = {"value": "OutOfCredits", "message": text}
        elif hosted_command:
            text = "M365 reply retained" if "hosted-shell-not-selected" in prompt else ""
            result = {"value": "Success"}
        elif tone in {"Gpt_6_Sol_Reasoning", "Gpt_61_Sol_Reasoning"} and agent_id:
            text, result = "", {"value": "InternalError", "message": "agent route unavailable"}
        elif marker:
            text, result = "disengage recovered", {"value": "Success"}
        elif "agent-route-recovery" in prompt:
            text, result = "agentless route recovered", {"value": "Success"}
        elif "quota-fallback" in prompt:
            text, result = "fallback model response", {"value": "Success"}
        elif "fixture-tool-turn" in prompt:
            text, result = "```bash\necho e2e\n```", {"value": "Success"}
        elif "powershell-tool-turn" in prompt:
            text, result = "```bash\nGet-ChildItem\n```", {"value": "Success"}
        elif "yaml-tool-turn" in prompt:
            text = "```edit_files\npath: file.txt\nedits:\n  - oldText: before\n    newText: after\n```"
            result = {"value": "Success"}
        elif "responses-tool-turn" in prompt:
            text, result = "```bash\necho responses-e2e\n```", {"value": "Success"}
        elif "responses first" in prompt:
            text, result = "responses fixture first", {"value": "Success"}
        elif "stream fixture" in prompt:
            text, result = "stream fixture delivers chunks", {"value": "Success"}
        elif "<tool_response" in prompt:
            text, result = "tool result acknowledged", {"value": "Success"}
        else:
            text, result = "responses fixture followup", {"value": "Success"}
        if hosted_command:
            progress = {"type": 1, "target": "update", "arguments": [{"messages": [{
                "author": "bot", "messageType": "Progress", "contentType": "Code",
                "hiddenText": f"bash -lc {hosted_command}",
            }]}]}
            conn.send(json.dumps(progress) + RS)
            if "hosted-shell-not-selected" not in prompt:
                stop_frames = _frames(conn.recv(timeout=5))
                if stop_frames:
                    RECORDS[-1]["stop_frame"] = stop_frames[0]
                return
        if not quota and not disengaged and not hosted_command and "fixture-tool-turn" not in prompt and "yaml-tool-turn" not in prompt and "powershell-tool-turn" not in prompt and not agent_id:
            for chunk in (text[:7], text[7:17], text[17:]):
                if chunk:
                    update = {"type": 1, "target": "update", "arguments": [{"writeAtCursor": chunk}]}
                    conn.send(json.dumps(update) + RS)
                    time.sleep(0.005)
        bot_message = {"author": "bot", "text": text}
        if message_type:
            bot_message["messageType"] = message_type
        metering = {}
        if quota and tone == "Claude_Opus":
            metering = {"ClaudeOpusQueryDaily": {"remainingAllowance": 0}, "ClaudeOpusQuery75": {"remainingAllowance": 9}}
        elif quota:
            metering = {"ClaudeSonnet55QueryDaily": {"remainingAllowance": 0}, "ClaudeSonnet55QueryWeekly": {"remainingAllowance": 9}}
        item = {"messages": [bot_message], "result": result, "throttling": {"metering": metering}}
        conn.send(json.dumps({"type": 2, "item": item}) + RS)
        conn.send(json.dumps({"type": 3, "invocationId": "0"}) + RS)
    except (WebSocketError, KeyError, TypeError):
        return


def _http(method: str, url: str, body: dict | None = None, headers: dict | None = None) -> tuple[int, dict, bytes]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})}, method=method)
    try:
        with urlopen(request, timeout=30) as response:
            return response.status, dict(response.headers), response.read()
    except HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def _run() -> None:
    api_port, ws_port = _port(), _port()
    base = f"http://127.0.0.1:{api_port}"
    ws_url = f"ws://127.0.0.1:{ws_port}"
    env = os.environ.copy()
    package_root = os.path.dirname(os.path.dirname(__file__))
    env["PYTHONPATH"] = package_root + os.pathsep + env.get("PYTHONPATH", "")
    env["M365_WS_URL"] = ws_url
    env["M365_TEST_ACCESS_TOKEN"] = _token()
    env["M365_AGENT_ID"] = "fixture-agent"
    env["M365_OPUS_FALLBACK_MODEL"] = "m365-copilot"
    env.pop("M365_SONNET_FALLBACK_MODEL", None)
    env.pop("M365_NO_CODE_INTERPRETER", None)
    env.pop("M365_FORCE_AGENT", None)
    RECORDS.clear()
    DISENGAGED_SEEN.clear()
    UPLOAD_RECORDS.clear()
    upload_port = _port()
    upload_server = ThreadingHTTPServer(("127.0.0.1", upload_port), _UploadHandler)
    threading.Thread(target=upload_server.serve_forever, daemon=True).start()
    env["M365_UPLOAD_URL"] = f"http://127.0.0.1:{upload_port}/m365Copilot/UploadFile"
    ws_listener = _serve_ws(ws_port)
    process = subprocess.Popen([sys.executable, "-m", "m365copilotproxy", "--port", str(api_port)],
                               env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError("proxy exited before becoming ready: " + process.stderr.read().decode(errors="replace"))
            try:
                status, _, raw = _http("GET", base + "/v1/models")
                if status == 200:
                    break
            except (URLError, TimeoutError):
                time.sleep(0.05)
        else:
            raise RuntimeError("proxy did not become ready")

        catalog = json.loads(raw)
        model_ids = {entry["id"] for entry in catalog["data"]}
        assert "gpt-6.1-sol" in model_ids and "claude-sonnet-5.5" in model_ids

        tools = [{"type": "function", "function": {"name": "bash", "description": "Run a shell command",
                 "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}}]
        headers = {"X-M365-Conversation-ID": "e2e-chat"}
        status, _, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "m365-copilot", "messages": [{"role": "user", "content": "fixture-tool-turn"}], "tools": tools,
        }, headers)
        assert status == 200, raw
        first_chat = json.loads(raw)
        call = first_chat["choices"][0]["message"]["tool_calls"][0]
        assert call["function"]["name"] == "bash"
        assert json.loads(call["function"]["arguments"]) == {"command": "echo e2e"}
        first_record = RECORDS[-1]
        assert first_record["is_start"] is True

        powershell_tools = [{"type": "function", "function": {"name": "powershell", "description": "Run a PowerShell command",
                 "parameters": {"type": "object", "properties": {"command": {"type": "string"}, "timeout": {"type": "number"}}, "required": ["command"]}}}]
        status, _, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "m365-copilot", "messages": [{"role": "user", "content": "powershell-tool-turn"}], "tools": powershell_tools,
        }, {"X-M365-Conversation-ID": "e2e-powershell"})
        assert status == 200, raw
        ps_call = json.loads(raw)["choices"][0]["message"]["tool_calls"][0]
        assert ps_call["function"]["name"] == "powershell", ps_call
        assert json.loads(ps_call["function"]["arguments"]) == {"command": "Get-ChildItem"}

        image_data_url = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 24).decode()
        status, _, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "m365-copilot",
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "what is in this image?"},
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ]}],
        }, {"X-M365-Conversation-ID": "e2e-image"})
        assert status == 200, raw
        image_record = RECORDS[-1]
        annotations = image_record["message_annotations"]
        assert annotations, image_record
        assert annotations[0]["messageAnnotationType"] == "ImageFile", annotations
        assert annotations[0]["id"] == "doc-fixture-1", annotations
        assert annotations[0]["messageAnnotationMetadata"]["fileType"] == "png", annotations
        assert "cwc_fileupload_odb" in image_record["options_sets"], image_record["options_sets"]
        assert UPLOAD_RECORDS, "no upload request reached the fixture"
        upload = UPLOAD_RECORDS[-1]
        assert "UploadImage" in upload["body"], upload["body"][:200]
        assert "FileBase64" in upload["body"], upload["body"][:200]
        assert upload["headers"].get("x-anchormailbox", "").startswith("Oid:"), upload["headers"]

        status, _, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "m365-copilot",
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/tiff;base64,AAAA"}},
            ]}],
        })
        assert status == 400, raw
        assert "unsupported image type" in json.loads(raw)["error"]["message"], raw

        status, _, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "gpt-6-think-deeper",
            "messages": [{"role": "user", "content": "hosted-shell-turn"}], "tools": tools,
        }, {"X-M365-Conversation-ID": "e2e-hosted-shell"})
        assert status == 200, raw
        hosted_call = json.loads(raw)["choices"][0]["message"]["tool_calls"][0]
        assert hosted_call["function"]["name"] == "bash"
        assert json.loads(hosted_call["function"]["arguments"]) == {"command": "echo hosted-shell-e2e"}
        hosted_record = RECORDS[-1]
        assert hosted_record["agent_id"] is None
        assert hosted_record["options_sets"] == []
        assert hosted_record["stop_frame"]["target"] == "stop"
        assert hosted_record["stop_frame"]["invocationId"] == "1"

        followup = {"model": "m365-copilot", "tools": tools, "messages": [
            {"role": "user", "content": "fixture-tool-turn"},
            {"role": "assistant", "content": None, "tool_calls": [call]},
            {"role": "tool", "tool_call_id": call["id"], "content": "real e2e output"},
            {"role": "user", "content": "continue"},
        ]}
        status, _, raw = _http("POST", base + "/v1/chat/completions", followup, headers)
        assert status == 200, raw
        second_record = RECORDS[-1]
        assert second_record["conversation_id"] == first_record["conversation_id"]
        assert second_record["is_start"] is False
        assert "real e2e output" in second_record["prompt"]
        assert json.loads(raw)["choices"][0]["message"]["content"] == "tool result acknowledged"

        edit_tools = [{
            "type": "function",
            "function": {
                "name": "edit_files",
                "description": "Apply edits",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "edits": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "oldText": {"type": "string"},
                                    "newText": {"type": "string"},
                                },
                            },
                        },
                    },
                },
            },
        }]
        mixed_tools = tools + edit_tools
        status, _, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "gpt-6-think-deeper",
            "messages": [{"role": "user", "content": "hosted-shell-not-selected"}],
            "tools": mixed_tools,
            "tool_choice": {"type": "function", "function": {"name": "edit_files"}},
        })
        assert status == 200, raw
        restricted_message = json.loads(raw)["choices"][0]["message"]
        assert not restricted_message.get("tool_calls")
        assert restricted_message["content"] == "M365 reply retained"
        assert "stop_frame" not in RECORDS[-1]

        status, _, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "m365-copilot", "messages": [{"role": "user", "content": "yaml-tool-turn"}], "tools": edit_tools,
        })
        assert status == 200, raw
        edit_call = json.loads(raw)["choices"][0]["message"]["tool_calls"][0]
        assert json.loads(edit_call["function"]["arguments"]) == {
            "path": "file.txt", "edits": [{"oldText": "before", "newText": "after"}],
        }

        status, _, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "m365-copilot", "messages": [{"role": "user", "content": "disengage-retry"}],
        })
        assert status == 200 and json.loads(raw)["choices"][0]["message"]["content"] == "disengage recovered"
        disengage_first, disengage_retry = RECORDS[-2:]
        assert disengage_first["conversation_id"] != disengage_retry["conversation_id"]
        assert disengage_first["is_start"] is True and disengage_retry["is_start"] is True
        assert "cwc_code_interpreter" in disengage_first["options_sets"]
        assert "cwc_code_interpreter" in disengage_retry["options_sets"]

        status, _, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "gpt-6-sol", "messages": [{"role": "user", "content": "agent-route-recovery"}], "tools": tools,
        }, {"X-M365-Conversation-ID": "e2e-agent-route"})
        assert status == 200 and json.loads(raw)["choices"][0]["message"]["content"] == "agentless route recovered"
        agent_first, agent_retry = RECORDS[-2:]
        assert agent_first["agent_id"] == "fixture-agent" and agent_retry["agent_id"] is None
        assert agent_first["conversation_id"] != agent_retry["conversation_id"]
        status, response_headers, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "m365-copilot", "stream": True,
            "messages": [{"role": "user", "content": "stream fixture"}],
        })
        stream = raw.decode("utf-8")
        assert status == 200 and response_headers.get("Content-Type", "").startswith("text/event-stream")
        stream_chunks = [json.loads(line[6:]) for line in stream.splitlines() if line.startswith("data: {")]
        streamed_text = "".join(choice["delta"].get("content", "") for chunk in stream_chunks for choice in chunk.get("choices", []))
        assert streamed_text == "stream fixture delivers chunks" and "data: [DONE]" in stream

        status, _, raw = _http("POST", base + "/v1/responses", {
            "model": "m365-copilot", "input": "responses first",
        })
        assert status == 200, raw
        first_response = json.loads(raw)
        first_response_id = first_response["id"]
        assert first_response["output_text"] == "responses fixture first"
        first_response_record = RECORDS[-1]
        status, _, raw = _http("POST", base + "/v1/responses", {
            "model": "m365-copilot", "previous_response_id": first_response_id,
            "input": "responses continue",
        })
        assert status == 200, raw
        assert json.loads(raw)["output_text"] == "responses fixture followup"
        response_followup_record = RECORDS[-1]
        assert response_followup_record["conversation_id"] == first_response_record["conversation_id"]
        assert response_followup_record["is_start"] is False

        response_tools = [{
            "type": "function", "name": "bash", "description": "Run a shell command",
            "parameters": {"type": "object", "properties": {"command": {"type": "string"}}},
        }]
        status, _, raw = _http("POST", base + "/v1/responses", {
            "model": "m365-copilot", "input": "responses-tool-turn", "tools": response_tools,
        })
        assert status == 200, raw
        first_tool_response = json.loads(raw)
        response_call = first_tool_response["output"][0]
        assert response_call["type"] == "function_call" and response_call["name"] == "bash"
        response_call_record = RECORDS[-1]
        status, _, raw = _http("POST", base + "/v1/responses", {
            "model": "m365-copilot", "previous_response_id": first_tool_response["id"],
            "input": [{"type": "function_call_output", "call_id": response_call["call_id"], "output": "response loop output"}],
        })
        assert status == 200 and json.loads(raw)["output_text"] == "tool result acknowledged"
        response_tool_followup = RECORDS[-1]
        assert response_tool_followup["conversation_id"] == response_call_record["conversation_id"]
        assert "tool_response name=\"bash\"" in response_tool_followup["prompt"]
        assert "response loop output" in response_tool_followup["prompt"]
        status, response_headers, raw = _http("POST", base + "/v1/responses", {
            "model": "m365-copilot", "stream": True, "input": "stream fixture",
        })
        response_stream = raw.decode("utf-8")
        assert status == 200 and response_headers.get("Content-Type", "").startswith("text/event-stream")
        assert "event: response.output_text.delta" in response_stream
        assert "event: response.completed" in response_stream and "data: [DONE]" in response_stream

        status, _, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "claude-opus", "messages": [{"role": "user", "content": "quota-fallback"}],
        }, {"X-M365-Conversation-ID": "e2e-quota-fallback"})
        assert status == 200, raw
        fallback = json.loads(raw)
        assert fallback["model"] == "m365-copilot"
        assert fallback["choices"][0]["message"]["content"] == "fallback model response"
        opus_refusal, fallback_turn = RECORDS[-2:]
        assert opus_refusal["tone"] == "Claude_Opus" and fallback_turn["tone"] == "magic"
        assert opus_refusal["conversation_id"] != fallback_turn["conversation_id"]

        status, headers, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "claude-sonnet-5.5", "messages": [{"role": "user", "content": "quota-exhaust-sonnet"}],
        }, {"X-M365-Conversation-ID": "e2e-sonnet-quota"})
        assert status == 429, raw
        assert json.loads(raw)["error"]["code"] == "priority_access_exhausted"
        assert int(headers["Retry-After"]) > 0
        count_after_exhaustion = len(RECORDS)
        status, _, raw = _http("POST", base + "/v1/chat/completions", {
            "model": "claude-sonnet-5.5", "messages": [{"role": "user", "content": "must be blocked"}],
        })
        assert status == 429, raw
        assert len(RECORDS) == count_after_exhaustion, "exhausted budget must not start another M365 turn"

        print("E2E PASS: models, hosted-shell routing, image upload, Chat/Responses tool loops, reuse/SSE, retries, priority fallback/exhaustion")
    finally:
        ws_listener.close()
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        if process.returncode not in (0, -15, 1):
            stderr = process.stderr.read().decode(errors="replace")
            raise RuntimeError(f"proxy exited with {process.returncode}: {stderr}")


def main() -> int:
    _run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
