from __future__ import annotations

import html
import json
import re
import uuid

BODY_NAMES = ("command", "content", "code", "body", "script", "text", "query", "input", "patch", "cmd", "data", "contents")
SEARCH_NAMES = ("old", "search", "find", "old_str", "old_string", "target")
REPLACE_NAMES = ("new", "replace", "replacement", "new_str", "new_string")
SHELL_LANGS = {
    "bash", "sh", "shell", "zsh", "console", "shell-session", "shellsession", "shsession",
    "container.exec", "container.run", "container.bash", "powershell", "pwsh", "ps1", "posh",
    "cmd", "bat", "batch", "dosbatch",
}
SHELL_NAME = re.compile(r"^(bash|sh|shell|zsh|run|exec|execute|command|cmd|terminal|run_command|run_terminal_cmd|execute_command|execute_bash|shell_exec|system|powershell|pwsh|ps1|posh)$", re.I)
FENCE = re.compile(r"```([A-Za-z0-9_.-]+)[ \t]*\r?\n([\s\S]*?)\r?\n?```")


def content_text(message: dict) -> str:
    content = message.get("content")
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    raise ValueError("message content must be a string, array, or null")


def _function(tool: dict) -> dict:
    fn = tool.get("function")
    if tool.get("type", "function") != "function" or not isinstance(fn, dict):
        raise ValueError("only function tools are supported")
    name = fn.get("name")
    if not isinstance(name, str) or not name or not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
        raise ValueError("tool function name is invalid")
    return fn


def _props(tool: dict) -> dict:
    schema = _function(tool).get("parameters") or {}
    if not isinstance(schema, dict):
        raise ValueError("tool parameters must be an object schema")
    props = schema.get("properties") or {}
    if not isinstance(props, dict) or any(not isinstance(value, dict) for value in props.values()):
        raise ValueError("tool parameters.properties must be an object")
    return props


def find_shell_tool(tools: list[dict]) -> dict | None:
    for tool in tools:
        if SHELL_NAME.fullmatch(_function(tool)["name"]):
            return tool
    for tool in tools:
        keys = list(_props(tool))
        if len(keys) == 1 and keys[0].lower() in {"command", "cmd", "script", "input"}:
            return tool
    return None


def _spec(tool: dict) -> dict:
    fn = _function(tool)
    props = _props(tool)
    keys = list(props)
    search = next((key for key in keys if key in SEARCH_NAMES), None)
    replace = next((key for key in keys if key in REPLACE_NAMES), None)
    if search and replace:
        return {"name": fn["name"], "description": fn.get("description", ""), "props": props,
                "headers": [key for key in keys if key not in {search, replace}], "body": None,
                "edit": (search, replace)}
    body = next((key for key in keys if key in BODY_NAMES), keys[0] if len(keys) == 1 else None)
    return {"name": fn["name"], "description": fn.get("description", ""), "props": props,
            "headers": [key for key in keys if key != body], "body": body, "edit": None}


def _spec_map(tools: list[dict]) -> dict[str, dict]:
    specs = {_function(tool)["name"]: _spec(tool) for tool in tools}
    shell = find_shell_tool(tools) if tools else None
    if shell:
        shell_spec = specs[_function(shell)["name"]]
        for alias in SHELL_LANGS:
            specs.setdefault(alias, shell_spec)
    return specs


def _render_call(spec: dict, args: dict) -> str:
    lines = [f"{key}: {json.dumps(args[key], ensure_ascii=False) if not isinstance(args[key], str) else args[key]}"
             for key in spec["headers"] if key in args]
    if spec["edit"]:
        old, new = spec["edit"]
        lines.extend(("<<<<<<< SEARCH", str(args.get(old, "")), "=======", str(args.get(new, "")), ">>>>>>> REPLACE"))
    elif spec["body"]:
        if lines:
            lines.append("")
        lines.append(str(args.get(spec["body"], "")))
    return f"```{spec['name']}\n{"\n".join(lines)}\n```"


def _render_template(spec: dict) -> str:
    lines = [f"{key}: <{key}>" for key in spec["headers"]]
    if spec["edit"]:
        old, new = spec["edit"]
        lines.extend(("<<<<<<< SEARCH", f"<{old}>", "=======", f"<{new}>", ">>>>>>> REPLACE"))
    elif spec["body"]:
        if lines:
            lines.append("")
        lines.append(f"<{spec['body']}>")
    title = f"{spec['name']} — {spec['description']}" if spec["description"] else spec["name"]
    return f"{title}\n```{spec['name']}\n{"\n".join(lines)}\n```"


def _tool_block(tools: list[dict]) -> str:
    return "<tools>\n" + "\n\n".join(_render_template(_spec(tool)) for tool in tools) + "\n</tools>"


def _shell_prompt(tools: list[dict]) -> str:
    shell = find_shell_tool(tools)
    if not shell:
        return ""
    name = _function(shell)["name"]
    return f"\n\nTHE WAY YOU DO ANYTHING IS BY WRITING A SHELL SCRIPT. The `{name}` tool runs commands against the user's real working directory. A fenced block is an action the harness executes and returns as a <tool_response>; it is not an illustration."


def format_tool_definitions(tools: list[dict], variant: str) -> str:
    tool_block = _tool_block(tools)
    shell = find_shell_tool(tools)
    shell_prompt = _shell_prompt(tools)
    if variant == "relay_batch":
        prompt = ("Before the task, a note on how we'll work: please guide me through this from my terminal. "
                  "Your built-in tools run in a separate cloud sandbox, not on my machine. For each action, "
                  "reply with one fenced tool block and wait for the real <tool_response>. Each round trip "
                  "takes time, so put as much as fits into one block. When complete, answer in a sentence.\n\n" + tool_block)
    elif variant == "relay":
        prompt = ("Before the task, a note on how we'll work: please guide me through this from my terminal. "
                  "Your built-in tools run in a separate cloud sandbox, not on my machine. For each action, "
                  "reply with one fenced tool block and wait for the real <tool_response>. When complete, "
                  "answer in a sentence.\n\n" + tool_block)
    else:
        prompt = ("You are the execution core of an automated agent, not a chat assistant. Your output is parsed by a program."
                  + shell_prompt + "\n\nPerform the task with tools when a tool can make progress. Emit only one fenced tool call per turn; "
                  "wait for its real <tool_response> before continuing. Never claim a command ran without that result.\n\n"
                  + tool_block)
    if shell and _is_windows():
        name = _function(shell)["name"]
        prompt += (f"\n\nHOST PLATFORM: Windows. The `{name}` tool runs on a real Windows machine, not Linux. "
                   "Use PowerShell syntax: Get-Content/Get-ChildItem/Select-String to inspect, Set-Content to write, "
                   "and Get-Location for the working directory. Do not use POSIX heredocs, sed, ls, or grep.")
    return prompt


def _is_windows() -> bool:
    import os
    return os.name == "nt"


def _tool_choice_text(tool_choice) -> str:
    if tool_choice is None or tool_choice == "auto":
        return ""
    if tool_choice == "none":
        return "\nDo NOT call tools. Text only."
    if tool_choice == "required":
        return "\nYou MUST call at least one tool."
    if isinstance(tool_choice, dict):
        name = (tool_choice.get("function") or {}).get("name")
        if isinstance(name, str):
            return f'\nYou MUST call "{name}".'
    return ""


def _message_call_name_map(messages: list[dict]) -> dict[str, str]:
    names = {}
    for message in messages:
        if message.get("role") == "assistant":
            for call in message.get("tool_calls") or []:
                if isinstance(call, dict) and call.get("id"):
                    fn = call.get("function") or {}
                    if isinstance(fn.get("name"), str):
                        names[call["id"]] = fn["name"]
    return names


def _arguments(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    try:
        parsed = json.loads(raw or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def format_messages(messages: list[dict], tools: list[dict], tool_choice, conversation_id: str, variant: str) -> str:
    parts = [f"<conversation_id>{conversation_id}</conversation_id>"]
    if tools and tool_choice != "none":
        tag = "harness_system_prompt" if variant in {"relay", "relay_batch"} else "system"
        content = format_tool_definitions(tools, variant) + _tool_choice_text(tool_choice)
        parts.append(f"<{tag}>\n{content}\n</{tag}>")
    call_names = _message_call_name_map(messages)
    specs = _spec_map(tools)
    for message in messages:
        role = message.get("role")
        text = content_text(message)
        if role == "assistant" and message.get("tool_calls"):
            calls = []
            for call in message["tool_calls"]:
                fn = call.get("function") or {}
                name = fn.get("name")
                if not isinstance(name, str):
                    continue
                spec = specs.get(name) or {"name": name, "headers": list(_arguments(fn.get("arguments"))), "body": None, "edit": None}
                calls.append(_render_call(spec, _arguments(fn.get("arguments"))))
            parts.append(f"<assistant>{'\n' + text if text else ''}\n{'\n'.join(calls)}\n</assistant>")
        elif role == "tool":
            name = message.get("name") or call_names.get(message.get("tool_call_id"), "tool")
            summary = _tool_summary(message.get("tool_call_id"), messages)
            attr = f' command="{html.escape(summary, quote=True)}"' if summary else ""
            parts.append(f'<tool_response tool="{html.escape(name, quote=True)}"{attr}>\n{text}\n</tool_response>')
        elif role == "system":
            tag = "system" if variant not in {"relay", "relay_batch"} else "harness_system_prompt"
            parts.append(f"<{tag}>\n{text}\n</{tag}>")
        elif role in {"user", "assistant", "developer"}:
            parts.append(f"<{role}>\n{text}\n</{role}>")
    return "\n\n".join(parts)


def _tool_summary(call_id: str | None, messages: list[dict]) -> str:
    for message in messages:
        for call in message.get("tool_calls") or []:
            if call.get("id") == call_id:
                args = _arguments((call.get("function") or {}).get("arguments"))
                value = next((args.get(key) for key in ("command", "cmd", "script", "path", "file", "filename", "query") if isinstance(args.get(key), str)), "")
                return re.sub(r"\s+", " ", value).replace('"', "'").strip()[:100]
    return ""


def format_delta(messages: list[dict], history: list[dict]) -> str:
    names = _message_call_name_map(history)
    parts = []
    for message in messages:
        role = message.get("role")
        if role in {"assistant", "system", "developer"}:
            continue
        text = content_text(message)
        if role == "tool":
            name = message.get("name") or names.get(message.get("tool_call_id"), "unknown")
            call_id = message.get("tool_call_id") or "?"
            parts.append(f'<tool_response name="{html.escape(name, quote=True)}" call_id="{html.escape(call_id, quote=True)}">\n{text}\n</tool_response>')
        elif role == "user":
            parts.append(f"<user>\n{text}\n</user>")
    return "\n\n".join(parts)


def _scalar(value: str):
    value = value.strip()
    if value in {"|", ">", "|-", ">-", "|+", ">+"}:
        return value
    if value.startswith(("[", "{")):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    if value.startswith('"') and value.endswith('"'):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value[1:-1]
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    return value


def _yaml_block(lines: list[str], declared: str):
    nonblank = [(index, line) for index, line in enumerate(lines) if line.strip()]
    if not nonblank:
        return None
    first_indent = len(nonblank[0][1]) - len(nonblank[0][1].lstrip())
    first = nonblank[0][1].strip()
    if declared == "array":
        result = []
        index = 0
        while index < len(lines):
            line = lines[index]
            if not line.strip():
                index += 1
                continue
            indent = len(line) - len(line.lstrip())
            text = line.strip()
            if indent != first_indent or not text.startswith("-"):
                return None
            value = text[1:].strip()
            item = {}
            if re.match(r"[^:]+:\s*", value):
                key, raw = value.split(":", 1)
                item[key.strip()] = _scalar(raw)
                index += 1
                while index < len(lines):
                    sub = lines[index]
                    if not sub.strip():
                        index += 1
                        continue
                    sub_indent = len(sub) - len(sub.lstrip())
                    if sub_indent <= indent:
                        break
                    match = re.match(r"\s*([^:]+):(?:\s+(.*)|\s*)$", sub)
                    if not match:
                        return None
                    key, raw = match.groups()
                    item[key.strip()] = _scalar(raw or "")
                    index += 1
                result.append(item)
            else:
                result.append(_scalar(value))
                index += 1
        return result
    if declared == "object" and re.match(r"[^:]+:\s*", first):
        result = {}
        for _, line in nonblank:
            match = re.match(r"\s*([^:]+):(?:\s+(.*)|\s*)$", line)
            if not match:
                return None
            key, raw = match.groups()
            result[key.strip()] = _scalar(raw or "")
        return result
    return None


def _coerce(value: str, kind: str):
    lowered = value.lower()
    if kind == "boolean":
        if lowered in {"true", "yes", "y", "1", "on"}:
            return True
        if lowered in {"false", "no", "n", "0", "off"}:
            return False
    elif kind in {"integer", "number"}:
        try:
            number = float(value)
            if kind == "number" or number.is_integer():
                return int(number) if number.is_integer() else number
        except ValueError:
            pass
    elif kind in {"array", "object"}:
        if not value and kind == "array":
            return []
        try:
            parsed = json.loads(value)
            if (kind == "array" and isinstance(parsed, list)) or (kind == "object" and isinstance(parsed, dict)):
                return parsed
        except json.JSONDecodeError:
            if kind == "array":
                return [value]
    return value


def _parse_args(spec: dict, inner: str) -> dict | None:
    lines = inner.splitlines()
    args = {}
    index = 0
    headers = set(spec["headers"])
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
            break
        match = re.match(r"^([A-Za-z0-9_]+):[ \t]?(.*)$", line)
        if not match or match.group(1) not in headers:
            break
        key, raw = match.groups()
        kind = (spec["props"].get(key) or {}).get("type", "string")
        if not raw.strip() and kind in {"array", "object"}:
            block_end = index + 1
            while block_end < len(lines):
                row = lines[block_end]
                if row.strip() and not row[0].isspace() and not (kind == "array" and row.startswith("-")):
                    break
                block_end += 1
            parsed = _yaml_block(lines[index + 1:block_end], kind)
            if parsed is not None:
                args[key] = parsed
                index = block_end
                continue
        args[key] = _coerce(raw.strip(), kind)
        index += 1
    rest = "\n".join(lines[index:])
    if spec["edit"]:
        match = re.search(r"(?:^|\n)<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE(?:\r?\n|$)", rest)
        if not match:
            return None
        old, new = spec["edit"]
        args[old], args[new] = match.groups()
    elif spec["body"]:
        args[spec["body"]] = rest
    return args


def parse_tool_calls(text: str, tools: list[dict]) -> tuple[list[dict], str]:
    if not tools:
        return [], _clean_text(text)
    specs = _spec_map(tools)
    calls = []
    leftover = text
    for match in FENCE.finditer(text):
        spec = specs.get(match.group(1))
        if not spec:
            continue
        args = _parse_args(spec, match.group(2))
        if args is None:
            continue
        calls.append({"id": "call_" + uuid.uuid4().hex[:24], "type": "function",
                      "function": {"name": spec["name"], "arguments": json.dumps(args, ensure_ascii=False)}})
        leftover = leftover.replace(match.group(0), "", 1)
    if not calls:
        for match in re.finditer(r'\{\s*"tool"\s*:\s*"([^"\\]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}', text):
            spec = specs.get(match.group(1))
            if spec:
                try:
                    args = json.loads(match.group(2))
                except json.JSONDecodeError:
                    continue
                if isinstance(args, dict):
                    calls.append({"id": "call_" + uuid.uuid4().hex[:24], "type": "function",
                                  "function": {"name": spec["name"], "arguments": json.dumps(args, ensure_ascii=False)}})
                    leftover = text.replace(match.group(0), "", 1)
    if calls and not __import__("os").environ.get("M365_ALLOW_MULTI_TOOL"):
        calls = calls[:1]
    if calls:
        fake = re.search(r"<tool_(?:response|result)\b", leftover, re.I)
        if fake:
            leftover = leftover[:fake.start()]
    return calls, _clean_text(leftover)


def _clean_text(text: str) -> str:
    text = re.sub(r'\{\s*"confidence"\s*:\s*-?[0-9.]+\s*\}', "", text)
    final = re.fullmatch(r'\s*\{\s*"final"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}\s*', text, re.S)
    if final:
        try:
            text = json.loads('"' + final.group(1) + '"')
        except json.JSONDecodeError:
            pass
    else:
        text = re.sub(r'\{\s*"final"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}', "", text)
    return text.strip()
