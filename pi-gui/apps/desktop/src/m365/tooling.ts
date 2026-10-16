/**
 * Ports m365copilotproxy/tooling.py — renders the fenced tool-block prompt the Copilot
 * relay expects (formatToolDefinitions / formatMessages / formatDelta) and parses
 * fenced tool blocks back into OpenAI-shaped tool calls (parseToolCalls).
 *
 * Fidelity notes, all enforced by the helpers below:
 *  - CPython's `re` `\s` for str patterns is Unicode-aware and additionally covers the
 *    C0 separators 0x1c-0x1f, so every ported pattern is built through `pyRegexp()`,
 *    which maps `\s` to that exact class while leaving the `[\s\S]` "any char" idiom
 *    intact (never JS `[^]`).
 *  - Python `str.splitlines()` breaks on \n, \r, \r\n, \v, \f, 0x1c, 0x1d, 0x1e, 0x85,
 *    U+2028 and U+2029; `String.prototype.split` only handles the first three.
 *  - `str.strip()` / `str.isspace()` / `x or y` follow Python truthiness, which differs
 *    from JS for empty containers, "" and 0.
 *  - Where the Python calls `.get()` on a non-dict (an AttributeError), the port raises
 *    `InvalidRequestError` rather than silently skipping the entry.
 */
import { isRecord } from "./guards.js";
import { InvalidRequestError } from "./types.js";

const BODY_NAMES: readonly string[] = ["command", "content", "code", "body", "script", "text", "query", "input", "patch", "cmd", "data", "contents"];
const SEARCH_NAMES: readonly string[] = ["old", "search", "find", "old_str", "old_string", "target"];
const REPLACE_NAMES: readonly string[] = ["new", "replace", "replacement", "new_str", "new_string"];
const SHELL_LANGS: readonly string[] = [
  "bash", "sh", "shell", "zsh", "console", "shell-session", "shellsession", "shsession",
  "container.exec", "container.run", "container.bash", "powershell", "pwsh", "ps1", "posh",
  "cmd", "bat", "batch", "dosbatch",
];
const TRUE_WORDS: readonly string[] = ["true", "yes", "y", "1", "on"];
const FALSE_WORDS: readonly string[] = ["false", "no", "n", "0", "off"];
const SUMMARY_KEYS: readonly string[] = ["command", "cmd", "script", "path", "file", "filename", "query"];
const YAML_BLOCK_TAGS: readonly string[] = ["|", ">", "|-", ">-", "|+", ">+"];
const RELAY_VARIANTS: readonly string[] = ["relay", "relay_batch"];
const SHELL_NAME_PATTERN = "^(bash|sh|shell|zsh|run|exec|execute|command|cmd|terminal|run_command|run_terminal_cmd|execute_command|execute_bash|shell_exec|system|powershell|pwsh|ps1|posh)$";

/** Property names that make a single-property tool count as the shell tool. */
const SHELL_PROP_KEYS: Record<string, true> = { command: true, cmd: true, script: true, input: true };

/** CPython's `str.splitlines()` boundary characters, keyed for `Object.hasOwn`. */
const LINE_BREAK_CHARS: Record<string, true> = {
  "\n": true, "\r": true, "\x0b": true, "\x0c": true, "\x1c": true,
  "\x1d": true, "\x1e": true, "\x85": true, "\u2028": true, "\u2029": true,
};

/** The relay's tool-result tag, built from pieces so no literal markup is needed. */
const TAG_NAME = "tool_response";
const wrapTag = (body: string): string => `<${body}>`;
/** As the tag is referenced inside the prompt prose. */
const TOOL_RESPONSE_TAG = wrapTag(TAG_NAME);
/** As the tag closes a block the port emits. */
const TOOL_RESPONSE_CLOSE = wrapTag(`/${TAG_NAME}`);

/** Result of `parseToolCalls`: the extracted calls plus the remaining prose text. */
export interface ParsedToolCalls {
  readonly toolCalls: readonly Record<string, unknown>[];
  readonly text: string;
}

/** CPython's `\s` class for str patterns: 0x09-0x0d, 0x1c-0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000-0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000. */
const PY_WS_SOURCE = "\\t\\n\\x0b\\f\\r \\x1c\\x1d\\x1e\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/**
 * Builds a RegExp whose `\s` matches CPython's whitespace set and whose `[\s\S]`
 * stays the "any character" idiom. The idiom is masked first so the two rewrites
 * cannot interfere with each other.
 */
function pyRegexp(source: string, flags = ""): RegExp {
  const ANY_CHAR = "\u0000";
  const masked = source.split("[\\s\\S]").join(ANY_CHAR);
  const withPythonWs = masked.split("\\s").join(`[${PY_WS_SOURCE}]`);
  return new RegExp(withPythonWs.split(ANY_CHAR).join("[\\s\\S]"), flags);
}

const SHELL_NAME = pyRegexp(SHELL_NAME_PATTERN, "i");
const FENCE = pyRegexp("```([A-Za-z0-9_.-]+)[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?```", "g");
const TOOL_NAME = pyRegexp("^[A-Za-z0-9_.-]+$");
const HEADER_LINE = pyRegexp("^([A-Za-z0-9_]+):[ \\t]?(.*)$");
const MAP_KEY = pyRegexp("^[^:]+:\\s*");
const ENTRY_KEY = pyRegexp("^\\s*([^:]+):(?:\\s+(.*)|\\s*)$");
const EDIT_BLOCK = pyRegexp("(?:^|\\n)<<<<<<< SEARCH\\r?\\n([\\s\\S]*?)\\r?\\n=======\\r?\\n([\\s\\S]*?)\\r?\\n>>>>>>> REPLACE(?:\\r?\\n|$)");
const JSON_TOOL_CALL = pyRegexp('\\{\\s*"tool"\\s*:\\s*"([^"\\\\]+)"\\s*,\\s*"arguments"\\s*:\\s*(\\{[\\s\\S]*?\\})\\s*\\}', "g");
const FAKE_TOOL_TAG = pyRegexp("<tool_(?:response|result)\\b", "i");
const WHITESPACE_RUN = pyRegexp("\\s+", "g");
const CONFIDENCE_JSON = pyRegexp('\\{\\s*"confidence"\\s*:\\s*-?[0-9.]+\\s*\\}', "g");
const FINAL_FULL = pyRegexp('^\\s*\\{\\s*"final"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*\\}\\s*$', "s");
const FINAL_JSON = pyRegexp('\\{\\s*"final"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"\\s*\\}', "g");
const LEADING_WS = pyRegexp(`^[${PY_WS_SOURCE}]+`);
const TRAILING_WS = pyRegexp(`[${PY_WS_SOURCE}]+$`);
const BLANK_LINE = pyRegexp(`^[${PY_WS_SOURCE}]*$`);
const SPACE_CHAR = pyRegexp(`^[${PY_WS_SOURCE}]$`);
/** Python's `float()` spelling: underscores allowed between digits, plus inf/nan forms. */
const PY_FLOAT = pyRegexp("^[+-]?(?:[0-9](?:_?[0-9])*(?:\\.[0-9](?:_?[0-9])*)?|\\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$");

/** Python `char.isspace()` on a single character. */
function isSpace(char: string): boolean {
  return SPACE_CHAR.test(char);
}

/** Python `str.strip()`. */
function pyStrip(text: string): string {
  return text.replace(TRAILING_WS, "").replace(LEADING_WS, "");
}

/** `if line.strip():` — true when the line carries at least one non-whitespace character. */
function hasContent(line: string): boolean {
  return !BLANK_LINE.test(line);
}

/** `len(line) - len(line.lstrip())`. */
function indentWidth(line: string): number {
  let index = 0;
  while (index < line.length && isSpace(line.charAt(index))) index += 1;
  return index;
}

/** Python `str.splitlines()` over the full CPython boundary set. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (!Object.hasOwn(LINE_BREAK_CHARS, char)) {
      current += char;
      continue;
    }
    lines.push(current);
    current = "";
    if (char === "\r" && text.charAt(index + 1) === "\n") index += 1;
  }
  // A terminating boundary yields no trailing empty element, but "" yields no lines at all.
  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}

/** Python truthiness for JSON-shaped values: empty containers, "" and 0 are falsy. */
function pyFalsy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return true;
  if (value === true) return false;
  if (typeof value === "string") return value.length === 0;
  if (typeof value === "number") return value === 0 || Number.isNaN(value);
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

/** Python `float(value)`; non-numeric spellings return NaN, matching a failed conversion. */
function pyFloat(value: string): number {
  const text = pyStrip(value);
  const lowered = text.toLowerCase();
  if (lowered === "inf" || lowered === "infinity" || lowered === "+inf" || lowered === "+infinity") return Number.POSITIVE_INFINITY;
  if (lowered === "-inf" || lowered === "-infinity") return Number.NEGATIVE_INFINITY;
  if (lowered === "nan" || lowered === "+nan" || lowered === "-nan") return Number.NaN;
  return PY_FLOAT.test(text) ? Number(text.split("_").join("")) : Number.NaN;
}

/** Python `text[:count]` — slices by code point, not UTF-16 code unit. */
function sliceCodePoints(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("");
}

/** Python `html.escape(value, quote=True)`; `&` must be replaced first. */
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** `json.dumps(value, ensure_ascii=False)` with CPython's default ", " and ": " separators. */
function jsonDumps(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(jsonDumps).join(", ")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}: ${jsonDumps(entry)}`);
    return `{${entries.join(", ")}}`;
  }
  return "null";
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Python `repr()` of a JSON value; CPython prefers single quotes for str reprs. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const escaped = value
      .split("\\").join("\\\\")
      .split("\n").join("\\n")
      .split("\r").join("\\r")
      .split("\t").join("\\t");
    return escaped.includes("'") && !escaped.includes('"') ? `"${escaped}"` : `'${escaped}'`;
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, entry]) => `${pyRepr(key)}: ${pyRepr(entry)}`);
    return entries.length === 0 ? "{}" : `{${entries.join(", ")}}`;
  }
  return String(value);
}

/** Python `str(value)`: strings pass through untouched, everything else becomes its repr. */
function pyStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}

/** `"call_" + uuid.uuid4().hex[:24]` — 24 lowercase hex characters from a random UUID4. */
function newCallId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Python `==` on JSON data, where a missing key and an explicit null are both `None`. */
function pyEquals(left: unknown, right: unknown): boolean {
  return (left === undefined ? null : left) === (right === undefined ? null : right);
}

/** Reads a string field from decoded JSON, defaulting to "" the way `.get(key, "")` does. */
function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/** `call.get("function") or {}`; a truthy non-object is what makes Python raise. */
function callFunction(call: Record<string, unknown>): Record<string, unknown> {
  const raw = call.function;
  if (pyFalsy(raw)) return {};
  if (!isRecord(raw)) throw new InvalidRequestError("tool call function must be an object");
  return raw;
}

// ---------------------------------------------------------------------------
// Normalised tool description
// ---------------------------------------------------------------------------

/**
 * `_spec()`'s output: how one tool's fenced call is laid out. Declared as a type alias
 * rather than an interface so it stays assignable to `Record<string, unknown>` for
 * validation callers that only need to know `toolSpec()` did not throw.
 */
export type ToolSpec = {
  readonly name: string;
  readonly description: string;
  readonly props: Record<string, unknown>;
  readonly headers: readonly string[];
  readonly body: string | null;
  readonly edit: readonly [string, string] | null;
};

export function contentText(message: Record<string, unknown>): string {
  const content = message.content;
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let text = "";
    for (const part of content) {
      if (!isRecord(part)) continue;
      const value = part.text;
      if (typeof value === "string") text += value;
    }
    return text;
  }
  throw new InvalidRequestError("message content must be a string, array, or null");
}

function functionObject(tool: Record<string, unknown>): Record<string, unknown> {
  const fn = tool.function;
  const kind = tool.type === undefined ? "function" : tool.type;
  if (kind !== "function" || !isRecord(fn)) {
    throw new InvalidRequestError("only function tools are supported");
  }
  const name = fn.name;
  if (typeof name !== "string" || !name || !TOOL_NAME.test(name)) {
    throw new InvalidRequestError("tool function name is invalid");
  }
  return fn;
}

function propertySchema(tool: Record<string, unknown>): Record<string, unknown> {
  const rawSchema = functionObject(tool).parameters;
  const schema = pyFalsy(rawSchema) ? {} : rawSchema;
  if (!isRecord(schema)) {
    throw new InvalidRequestError("tool parameters must be an object schema");
  }
  const rawProps = schema.properties;
  const props = pyFalsy(rawProps) ? {} : rawProps;
  if (!isRecord(props)) {
    throw new InvalidRequestError("tool parameters.properties must be an object");
  }
  for (const value of Object.values(props)) {
    if (!isRecord(value)) {
      throw new InvalidRequestError("tool parameters.properties must be an object");
    }
  }
  return props;
}

export function findShellTool(tools: readonly Record<string, unknown>[]): Record<string, unknown> | null {
  for (const tool of tools) {
    if (SHELL_NAME.test(stringField(functionObject(tool), "name"))) return tool;
  }
  for (const tool of tools) {
    const keys = Object.keys(propertySchema(tool));
    if (keys.length === 1 && Object.hasOwn(SHELL_PROP_KEYS, (keys[0] ?? "").toLowerCase())) return tool;
  }
  return null;
}

export function toolSpec(tool: Record<string, unknown>): ToolSpec {
  const fn = functionObject(tool);
  const props = propertySchema(tool);
  const keys = Object.keys(props);
  const name = stringField(fn, "name");
  const description = stringField(fn, "description");
  let search: string | null = null;
  for (const key of keys) {
    if (SEARCH_NAMES.indexOf(key) !== -1) {
      search = key;
      break;
    }
  }
  let replace: string | null = null;
  for (const key of keys) {
    if (REPLACE_NAMES.indexOf(key) !== -1) {
      replace = key;
      break;
    }
  }
  if (search !== null && replace !== null) {
    return {
      name,
      description,
      props,
      headers: keys.filter((key) => key !== search && key !== replace),
      body: null,
      edit: [search, replace],
    };
  }
  let body: string | null = null;
  for (const key of keys) {
    if (BODY_NAMES.indexOf(key) !== -1) {
      body = key;
      break;
    }
  }
  if (body === null && keys.length === 1) body = keys[0] ?? null;
  return {
    name,
    description,
    props,
    headers: keys.filter((key) => key !== body),
    body,
    edit: null,
  };
}

function specMap(tools: readonly Record<string, unknown>[]): Map<string, ToolSpec> {
  const specs = new Map<string, ToolSpec>();
  for (const tool of tools) {
    specs.set(stringField(functionObject(tool), "name"), toolSpec(tool));
  }
  const shell = tools.length > 0 ? findShellTool(tools) : null;
  if (shell !== null) {
    const shellSpec = specs.get(stringField(functionObject(shell), "name"));
    if (shellSpec !== undefined) {
      for (const alias of SHELL_LANGS) {
        if (!specs.has(alias)) specs.set(alias, shellSpec);
      }
    }
  }
  return specs;
}

function renderCall(spec: ToolSpec, args: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const key of spec.headers) {
    if (!(key in args)) continue;
    const value = args[key];
    lines.push(`${key}: ${typeof value === "string" ? value : jsonDumps(value)}`);
  }
  if (spec.edit !== null) {
    const old = spec.edit[0];
    const updated = spec.edit[1];
    lines.push("<<<<<<< SEARCH", pyStr(args[old] ?? ""), "=======", pyStr(args[updated] ?? ""), ">>>>>>> REPLACE");
  } else if (spec.body !== null && spec.body.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(pyStr(args[spec.body] ?? ""));
  }
  return templateFence(spec.name, lines);
}

function renderTemplate(spec: ToolSpec): string {
  const lines: string[] = spec.headers.map((key) => `${key}: <${key}>`);
  if (spec.edit !== null) {
    const old = spec.edit[0];
    const updated = spec.edit[1];
    lines.push("<<<<<<< SEARCH", `<${old}>`, "=======", `<${updated}>`, ">>>>>>> REPLACE");
  } else if (spec.body !== null && spec.body.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`<${spec.body}>`);
  }
  const title = spec.description !== "" ? `${spec.name} — ${spec.description}` : spec.name;
  return `${title}\n${templateFence(spec.name, lines)}`;
}

/** `FENCE + name + "\n" + lines + "\n" + FENCE`, the shape shared by both renderers. */
function templateFence(name: string, lines: readonly string[]): string {
  return `\`\`\`${name}\n${lines.join("\n")}\n\`\`\``;
}

function toolBlock(tools: readonly Record<string, unknown>[]): string {
  return "<tools>\n" + tools.map((tool) => renderTemplate(toolSpec(tool))).join("\n\n") + "\n</tools>";
}

function shellPrompt(tools: readonly Record<string, unknown>[]): string {
  const shell = findShellTool(tools);
  if (shell === null) return "";
  const name = stringField(functionObject(shell), "name");
  return `\n\nTHE WAY YOU DO ANYTHING IS BY WRITING A SHELL SCRIPT. The \`${name}\` tool runs commands against the user's real working directory. For each action, emit one fenced tool call whose info-string is exactly \`${name}\`; the harness executes it and returns the result as a ${TOOL_RESPONSE_TAG}. A fenced block is an action, not an illustration.`;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

export function formatToolDefinitions(tools: readonly Record<string, unknown>[], variant: string): string {
  const block = toolBlock(tools);
  const shell = findShellTool(tools);
  const prompt = shellPrompt(tools);
  let result: string;
  if (variant === "relay_batch") {
    result = ("Before the task, a note on how we'll work: please guide me through this from my terminal. "
      + "Your built-in tools run in a separate cloud sandbox, not on my machine. For each action, "
      + `reply with one fenced tool block and wait for the real ${TOOL_RESPONSE_TAG}. Each round trip `
      + "takes time, so put as much as fits into one block. When complete, answer in a sentence.\n\n"
      + block);
  } else if (variant === "relay") {
    result = ("Before the task, a note on how we'll work: please guide me through this from my terminal. "
      + "Your built-in tools run in a separate cloud sandbox, not on my machine. For each action, "
      + `reply with one fenced tool block and wait for the real ${TOOL_RESPONSE_TAG}. When complete, `
      + "answer in a sentence.\n\n"
      + block);
  } else {
    result = ("You are the execution core of an automated agent, not a chat assistant. Your output is parsed by a program."
      + prompt
      + "\n\nPerform the task with tools when a tool can make progress. Emit only one fenced tool call per turn; "
      + `wait for its real ${TOOL_RESPONSE_TAG} before continuing. Never claim a command ran without that result.\n\n`
      + block);
  }
  if (shell !== null && isWindows()) {
    const name = stringField(functionObject(shell), "name");
    result += (`\n\nHOST PLATFORM: Windows. The \`${name}\` tool runs on a real Windows machine, not Linux. `
      + "Use PowerShell syntax: Get-Content/Get-ChildItem/Select-String to inspect, Set-Content to write, "
      + "and Get-Location for the working directory. Do not use POSIX heredocs, sed, ls, or grep.");
  }
  return result;
}

function toolChoiceText(toolChoice: unknown): string {
  if (toolChoice === undefined || toolChoice === null || toolChoice === "auto") return "";
  if (toolChoice === "none") return "\nDo NOT call tools. Text only.";
  if (toolChoice === "required") return "\nYou MUST call at least one tool.";
  if (isRecord(toolChoice)) {
    const rawFn = toolChoice.function;
    const fn = pyFalsy(rawFn) ? {} : rawFn;
    if (isRecord(fn)) {
      const name = fn.name;
      if (typeof name === "string") return `\nYou MUST call "${name}".`;
    }
  }
  return "";
}

function messageCallNameMap(messages: readonly Record<string, unknown>[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const toolCalls = message.tool_calls;
    if (pyFalsy(toolCalls) || !Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      // `isinstance(call, dict)` is an explicit guard here, so non-dicts are skipped.
      if (!isRecord(call)) continue;
      const id = call.id;
      if (pyFalsy(id) || typeof id !== "string") continue;
      const fn = callFunction(call);
      if (typeof fn.name === "string") names.set(id, fn.name);
    }
  }
  return names;
}

function callArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return {};
  const parsed = tryParseJson(raw.length > 0 ? raw : "{}");
  return parsed.ok && isRecord(parsed.value) ? parsed.value : {};
}

/** `message.get("name") or call_names.get(message.get("tool_call_id"), fallback)`. */
function resolveToolName(message: Record<string, unknown>, names: Map<string, string>, fallback: string): string {
  if (!pyFalsy(message.name)) return pyStr(message.name);
  const callId = message.tool_call_id;
  const resolved = typeof callId === "string" ? names.get(callId) : undefined;
  return resolved ?? fallback;
}

export function formatMessages(
  messages: readonly Record<string, unknown>[],
  tools: readonly Record<string, unknown>[],
  toolChoice: unknown,
  conversationId: string,
  variant: string,
): string {
  const parts: string[] = [`<conversation_id>${conversationId}</conversation_id>`];
  if (tools.length > 0 && toolChoice !== "none") {
    const tag = RELAY_VARIANTS.indexOf(variant) !== -1 ? "harness_system_prompt" : "system";
    const content = formatToolDefinitions(tools, variant) + toolChoiceText(toolChoice);
    parts.push(`<${tag}>\n${content}\n</${tag}>`);
  }
  const callNames = messageCallNameMap(messages);
  const specs = specMap(tools);
  for (const message of messages) {
    const role = message.role;
    const text = contentText(message);
    if (role === "assistant" && !pyFalsy(message.tool_calls)) {
      const calls: string[] = [];
      const toolCalls = message.tool_calls;
      // `for call in message["tool_calls"]` carries no guard, so a non-array is an error.
      if (!Array.isArray(toolCalls)) throw new InvalidRequestError("tool_calls must be an array");
      for (const call of toolCalls) {
        if (!isRecord(call)) throw new InvalidRequestError("tool call must be an object");
        const fn = callFunction(call);
        const name = fn.name;
        if (typeof name !== "string") continue;
        const args = callArguments(fn.arguments);
        const spec = specs.get(name) ?? {
          name,
          description: "",
          props: {},
          headers: Object.keys(args),
          body: null,
          edit: null,
        };
        calls.push(renderCall(spec, args));
      }
      parts.push(`<assistant>${text.length > 0 ? `\n${text}` : ""}\n${calls.join("\n")}\n</assistant>`);
    } else if (role === "tool") {
      const name = resolveToolName(message, callNames, "tool");
      const summary = toolSummary(message.tool_call_id, messages);
      const attr = summary.length > 0 ? ` command="${htmlEscape(summary)}"` : "";
      parts.push(`<tool_response tool="${htmlEscape(name)}"${attr}>\n${text}\n${TOOL_RESPONSE_CLOSE}`);
    } else if (role === "system") {
      const tag = RELAY_VARIANTS.indexOf(variant) === -1 ? "system" : "harness_system_prompt";
      parts.push(`<${tag}>\n${text}\n</${tag}>`);
    } else if (role === "user" || role === "assistant" || role === "developer") {
      parts.push(`<${role}>\n${text}\n</${role}>`);
    }
  }
  return parts.join("\n\n");
}

function toolSummary(callId: unknown, messages: readonly Record<string, unknown>[]): string {
  for (const message of messages) {
    const toolCalls = message.tool_calls;
    if (pyFalsy(toolCalls)) continue;
    if (!Array.isArray(toolCalls)) throw new InvalidRequestError("tool_calls must be an array");
    for (const call of toolCalls) {
      if (!isRecord(call)) throw new InvalidRequestError("tool call must be an object");
      if (!pyEquals(call.id, callId)) continue;
      const fn = callFunction(call);
      const args = callArguments(fn.arguments);
      let value = "";
      for (const key of SUMMARY_KEYS) {
        const candidate = args[key];
        if (typeof candidate === "string") {
          value = candidate;
          break;
        }
      }
      // `re.sub(r"\s+", " ", value).replace('"', "'").strip()[:100]`
      const collapsed = value.replace(WHITESPACE_RUN, " ");
      return sliceCodePoints(pyStrip(collapsed.split('"').join("'")), 100);
    }
  }
  return "";
}

export function formatDelta(
  messages: readonly Record<string, unknown>[],
  history: readonly Record<string, unknown>[],
): string {
  const names = messageCallNameMap(history);
  const parts: string[] = [];
  for (const message of messages) {
    const role = message.role;
    if (role === "assistant" || role === "system" || role === "developer") continue;
    const text = contentText(message);
    if (role === "tool") {
      const name = resolveToolName(message, names, "unknown");
      const rawCallId = message.tool_call_id;
      const callId = pyFalsy(rawCallId) ? "?" : pyStr(rawCallId);
      parts.push(`<tool_response name="${htmlEscape(name)}" call_id="${htmlEscape(callId)}">\n${text}\n${TOOL_RESPONSE_CLOSE}`);
    } else if (role === "user") {
      parts.push(`<user>\n${text}\n</user>`);
    }
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Fenced-call argument decoding
// ---------------------------------------------------------------------------

function scalar(value: string): unknown {
  const text = pyStrip(value);
  if (YAML_BLOCK_TAGS.indexOf(text) !== -1) return text;
  if (text.startsWith("[") || text.startsWith("{")) {
    const parsed = tryParseJson(text);
    return parsed.ok ? parsed.value : text;
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    const parsed = tryParseJson(text);
    return parsed.ok ? parsed.value : text.slice(1, -1);
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).split("''").join("'");
  return text;
}

function yamlBlock(lines: readonly string[], declared: string): unknown {
  const nonblank: Array<[number, string]> = [];
  lines.forEach((line, index) => {
    if (hasContent(line)) nonblank.push([index, line]);
  });
  if (nonblank.length === 0) return null;
  const firstLine = nonblank[0]?.[1] ?? "";
  const firstIndent = indentWidth(firstLine);
  const first = pyStrip(firstLine);
  if (declared === "array") {
    const result: unknown[] = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (!hasContent(line)) {
        index += 1;
        continue;
      }
      const indent = indentWidth(line);
      const text = pyStrip(line);
      if (indent !== firstIndent || !text.startsWith("-")) return null;
      const value = pyStrip(text.slice(1));
      if (!MAP_KEY.test(value)) {
        result.push(scalar(value));
        index += 1;
        continue;
      }
      const colon = value.indexOf(":");
      const item: Record<string, unknown> = {};
      item[pyStrip(value.slice(0, colon))] = scalar(value.slice(colon + 1));
      index += 1;
      while (index < lines.length) {
        const sub = lines[index] ?? "";
        if (!hasContent(sub)) {
          index += 1;
          continue;
        }
        if (indentWidth(sub) <= indent) break;
        const entry = ENTRY_KEY.exec(sub);
        if (entry === null) return null;
        item[pyStrip(entry[1] ?? "")] = scalar(entry[2] ?? "");
        index += 1;
      }
      result.push(item);
    }
    return result;
  }
  if (declared === "object" && MAP_KEY.test(first)) {
    const result: Record<string, unknown> = {};
    for (const [, line] of nonblank) {
      const entry = ENTRY_KEY.exec(line);
      if (entry === null) return null;
      result[pyStrip(entry[1] ?? "")] = scalar(entry[2] ?? "");
    }
    return result;
  }
  return null;
}

function coerce(value: string, kind: string): unknown {
  const lowered = value.toLowerCase();
  if (kind === "boolean") {
    if (TRUE_WORDS.indexOf(lowered) !== -1) return true;
    if (FALSE_WORDS.indexOf(lowered) !== -1) return false;
  } else if (kind === "integer" || kind === "number") {
    const number = pyFloat(value);
    // Matches `if kind == "number" or number.is_integer():` — NaN and infinities keep
    // their float identity for "number" and otherwise fall through to the raw text.
    if (kind === "number" || Number.isInteger(number)) {
      return Number.isInteger(number) ? Math.trunc(number) : number;
    }
  } else if (kind === "array" || kind === "object") {
    if (value.length === 0 && kind === "array") return [];
    const parsed = tryParseJson(value);
    if (parsed.ok) {
      if (kind === "array" && Array.isArray(parsed.value)) return parsed.value;
      if (kind === "object" && isRecord(parsed.value)) return parsed.value;
    } else if (kind === "array") {
      return [value];
    }
  }
  return value;
}

function parseArgs(spec: ToolSpec, inner: string): Record<string, unknown> | null {
  const lines = splitLines(inner);
  const args: Record<string, unknown> = {};
  const props = spec.props;
  const headers = new Set<string>(spec.headers);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!hasContent(line)) {
      index += 1;
      break;
    }
    const match = HEADER_LINE.exec(line);
    if (match === null || !headers.has(match[1] ?? "")) break;
    const key = match[1] ?? "";
    const raw = match[2] ?? "";
    const rawProp = props[key];
    const prop = pyFalsy(rawProp) ? {} : rawProp;
    const kind = isRecord(prop) && typeof prop.type === "string" ? prop.type : "string";
    if (pyStrip(raw).length === 0 && (kind === "array" || kind === "object")) {
      let blockEnd = index + 1;
      while (blockEnd < lines.length) {
        const row = lines[blockEnd] ?? "";
        const startsDash = kind === "array" && row.startsWith("-");
        if (hasContent(row) && !isSpace(row.charAt(0)) && !startsDash) break;
        blockEnd += 1;
      }
      const parsed = yamlBlock(lines.slice(index + 1, blockEnd), kind);
      if (parsed !== null) {
        args[key] = parsed;
        index = blockEnd;
        continue;
      }
    }
    args[key] = coerce(pyStrip(raw), kind);
    index += 1;
  }
  const rest = lines.slice(index).join("\n");
  if (spec.edit !== null) {
    const match = EDIT_BLOCK.exec(rest);
    if (match === null) return null;
    args[spec.edit[0]] = match[1] ?? "";
    args[spec.edit[1]] = match[2] ?? "";
  } else if (spec.body !== null && spec.body.length > 0) {
    args[spec.body] = rest;
  }
  return args;
}

export function parseToolCalls(text: string, tools: readonly Record<string, unknown>[]): ParsedToolCalls {
  if (tools.length === 0) return { toolCalls: [], text: cleanText(text) };
  const specs = specMap(tools);
  const calls: Record<string, unknown>[] = [];
  let leftover = text;
  for (const match of text.matchAll(FENCE)) {
    const spec = specs.get(match[1] ?? "");
    if (spec === undefined) continue;
    const args = parseArgs(spec, match[2] ?? "");
    if (args === null) continue;
    calls.push({
      id: newCallId(),
      type: "function",
      function: { name: spec.name, arguments: jsonDumps(args) },
    });
    leftover = leftover.replace(match[0], "");
  }
  if (calls.length === 0) {
    for (const match of text.matchAll(JSON_TOOL_CALL)) {
      const spec = specs.get(match[1] ?? "");
      if (spec === undefined) continue;
      const parsed = tryParseJson(match[2] ?? "");
      if (!parsed.ok || !isRecord(parsed.value)) continue;
      calls.push({
        id: newCallId(),
        type: "function",
        function: { name: spec.name, arguments: jsonDumps(parsed.value) },
      });
      // Mirrors the Python's `leftover = text.replace(...)`, which restarts from the
      // original text on every JSON call instead of accumulating removals.
      leftover = text.replace(match[0], "");
    }
  }
  if (calls.length > 0 && !process.env.M365_ALLOW_MULTI_TOOL) {
    calls.length = 1;
  }
  if (calls.length > 0) {
    const fake = FAKE_TOOL_TAG.exec(leftover);
    if (fake !== null) leftover = leftover.slice(0, fake.index);
  }
  return { toolCalls: calls, text: cleanText(leftover) };
}

function cleanText(text: string): string {
  let result = text.replace(CONFIDENCE_JSON, "");
  const final = FINAL_FULL.exec(result);
  if (final !== null) {
    const parsed = tryParseJson(`"${final[1] ?? ""}"`);
    if (parsed.ok && typeof parsed.value === "string") result = parsed.value;
  } else {
    result = result.replace(FINAL_JSON, "");
  }
  return pyStrip(result);
}
