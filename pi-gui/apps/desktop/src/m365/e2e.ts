/**
 * End-to-end fixture for the ported M365 Copilot proxy, replacing the vendored
 * Python `m365copilotproxy/e2e.py` subprocess harness.
 *
 * Everything runs in-process: a `ProxyApplication` behind `createHttpServer`, a
 * hand-rolled RFC 6455 server standing in for the Chathub socket, and a local
 * `node:http` fixture for the substrate UploadFile endpoint. No browser and no
 * sign-in: the loopback `M365_WS_URL` plus `M365_TEST_ACCESS_TOKEN` covers the
 * token path, and `M365_AGENT_ID` short-circuits the Dataverse bootstrap, so
 * the only network in play is the fixtures below. Turns are driven by what the
 * fixtures answer, never by wall-clock waits.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Duplex } from "node:stream";

import * as authModule from "./auth.js";
import * as catalogModule from "./catalog.js";
import { asRecord, isRecord, messageOf } from "./guards.js";
import { RS, STOP_FRAME } from "./m365.js";
import { ProxyApplication, createHttpServer } from "./server.js";

const OID = "11111111-1111-4111-8111-111111111111";
const TID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "fixture-agent";
const UPLOAD_PATH = "/m365Copilot/UploadFile";

const PASS_LINE =
  "E2E PASS: models, hosted-shell routing, image upload, Chat/Responses tool loops, reuse/SSE, retries, priority fallback/exhaustion";

/** Safety nets only: the fixtures answer turns, so nothing waits on the clock. */
const TURN_TIMEOUT_MS = 30_000;
const STOP_FRAME_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Fixture state (e2e.py's module-level RECORDS / UPLOAD_RECORDS)
// ---------------------------------------------------------------------------

interface TurnRecord {
  conversationId: string;
  isStart: boolean;
  prompt: string;
  tone: string | null;
  scenario: string;
  agentId: string | null;
  optionsSets: readonly unknown[];
  messageAnnotations: readonly unknown[] | null;
  /** The exact stop-frame text the proxy sent, when the turn was intercepted. */
  stopText: string | null;
}

interface UploadRecord {
  path: string;
  /** Header names exactly as the client spelled them; node lowercases req.headers. */
  headers: ReadonlyMap<string, string>;
  body: string;
}

interface ChatLoopBaseline {
  /** The first tool call, replayed verbatim to drive the tool-result turn. */
  readonly call: Json;
  readonly conversationId: string;
}

const records: TurnRecord[] = [];
const disengagedSeen = new Set<string>();
const uploads: UploadRecord[] = [];

// ---------------------------------------------------------------------------
// JSON narrowing (the assertions read untyped round-tripped JSON)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Fixture view of round-tripped JSON: a record, or an empty one. */
function asJson(value: unknown): Json {
  return asRecord(value) ?? {};
}

function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function check(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`E2E FAIL: ${message}`);
  }
}

function same(actual: unknown, expected: unknown, message: string): void {
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(
      `E2E FAIL: ${message}: expected ${canonical(expected)}, got ${canonical(actual)}`,
    );
  }
}

/** Canonical form for the deep-equality assertions; key order is ignored. */
function canonical(value: unknown): string {
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function lastRecord(): TurnRecord {
  const record = records.at(-1);
  if (record === undefined) {
    throw new Error("E2E FAIL: the Chathub fixture recorded no turn");
  }
  return record;
}

function lastUpload(): UploadRecord {
  const upload = uploads.at(-1);
  if (upload === undefined) {
    throw new Error("E2E FAIL: the UploadFile fixture recorded no request");
  }
  return upload;
}

/** The `X-M365-Conversation-ID` header steering the proxy's conversation key. */
function conversationHeaders(key: string): Readonly<Record<string, string>> {
  return { "X-M365-Conversation-ID": key };
}

/** `choices[0].message` of a chat completion payload. */
function chatMessage(payload: unknown): Json {
  return asJson(asJson(asList(asJson(payload)["choices"])[0])["message"]);
}

/** The tool call the proxy parsed out of a chat completion payload. */
function toolCallOf(payload: unknown): Json {
  return asJson(asList(chatMessage(payload)["tool_calls"])[0]);
}

function toolName(call: Json): string {
  return asText(asJson(call["function"])["name"]);
}

function toolArguments(call: Json): unknown {
  const response: unknown = JSON.parse(asText(asJson(call["function"])["arguments"]));
  return response;
}

/** The `data:` payloads of an SSE body in arrival order, `[DONE]` excluded. */
function sseData(body: string): unknown[] {
  const payloads: unknown[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") {
      continue;
    }
    const payload: unknown = JSON.parse(trimmed.slice("data: ".length));
    payloads.push(payload);
  }
  return payloads;
}

interface SseChunk {
  readonly content: string;
  readonly finishReason: string | null;
}

function chatChunks(body: string): SseChunk[] {
  return sseData(body).map((payload) => {
    const choice = asJson(asList(asJson(payload)["choices"])[0]);
    const finish = choice["finish_reason"];
    return {
      content: asText(asJson(choice["delta"])["content"]),
      finishReason: typeof finish === "string" ? finish : null,
    };
  });
}

/** The RS-delimited SignalR frames of one WebSocket message; junk is skipped. */
function framesOf(raw: string): Json[] {
  const frames: Json[] = [];
  for (const chunk of raw.split(RS)) {
    if (chunk.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      continue;
    }
    frames.push(asJson(parsed));
  }
  return frames;
}

interface HttpResponse {
  readonly status: number;
  readonly contentType: string;
  readonly retryAfter: string | null;
  readonly body: string;
}

async function http(
  method: string,
  url: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<HttpResponse> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    retryAfter: response.headers.get("retry-after"),
    body: await response.text(),
  };
}

// ---------------------------------------------------------------------------
// Minimal RFC 6455 plumbing (e2e.py leaned on wsclient.py's server side)
// ---------------------------------------------------------------------------

const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Encodes one server frame; server-to-client payloads are never masked. */
function encodeFrame(opcode: number, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = payload.length;
  } else if (payload.length < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/** Incremental reader for the masked client frames the proxy sends. */
class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /** Next complete frame, or null while the rest of one is still in flight. */
  take(): { opcode: number; text: string } | null {
    const buffer = this.buffer;
    if (buffer.length < 2) {
      return null;
    }
    const masked = ((buffer[1] ?? 0) & 0x80) !== 0;
    let length = (buffer[1] ?? 0) & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) {
        return null;
      }
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) {
        return null;
      }
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const maskOffset = offset;
    offset += masked ? 4 : 0;
    if (buffer.length < offset + length) {
      return null;
    }
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      }
    }
    this.buffer = buffer.subarray(offset + length);
    return { opcode: (buffer[0] ?? 0) & 0x0f, text: payload.toString("utf8") };
  }
}

/** Text-message queue over one accepted Chathub socket. */
class ChathubSocket {
  private readonly decoder = new FrameDecoder();
  private readonly queue: string[] = [];
  private readonly socket: Duplex;
  private wake: (() => void) | null = null;
  private closed = false;

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.close());
    socket.on("end", () => this.close());
    socket.on("close", () => this.close());
  }

  send(text: string): void {
    if (!this.closed) {
      this.socket.write(encodeFrame(OPCODE_TEXT, text));
    }
  }

  /** Next client message, or null once the socket ends. */
  async nextText(timeoutMs: number): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    if (this.closed) {
      return null;
    }
    return await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve(null);
      }, timeoutMs);
      timer.unref();
      this.wake = (): void => {
        clearTimeout(timer);
        resolve(this.queue.shift() ?? null);
      };
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const wake = this.wake;
    this.wake = null;
    wake?.();
    this.socket.end();
  }

  private onData(chunk: Buffer): void {
    this.decoder.push(chunk);
    for (;;) {
      const frame = this.decoder.take();
      if (frame === null) {
        return;
      }
      if (frame.opcode === OPCODE_PING) {
        this.socket.write(encodeFrame(OPCODE_PONG, frame.text));
      } else if (frame.opcode === OPCODE_CLOSE) {
        this.socket.write(encodeFrame(OPCODE_CLOSE, ""));
        this.close();
      } else if (frame.opcode === OPCODE_TEXT) {
        this.queue.push(frame.text);
        const wake = this.wake;
        this.wake = null;
        wake?.();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The fake M365 Chathub endpoint
// ---------------------------------------------------------------------------

/** Answers one turn the way the Python fixture's `_fake_m365` did. */
async function answerTurn(socket: ChathubSocket, requestPath: string): Promise<void> {
  const handshake = await socket.nextText(TURN_TIMEOUT_MS);
  if (
    handshake === null ||
    !framesOf(handshake).some((frame) => asText(frame["protocol"]) === "json")
  ) {
    return;
  }
  socket.send(`{}${RS}`);
  const invocation = await socket.nextText(TURN_TIMEOUT_MS);
  if (invocation === null) {
    return;
  }
  const chat = framesOf(invocation).find(
    (frame) => frame["type"] === 4 && frame["target"] === "chat",
  );
  if (chat === undefined) {
    return;
  }
  const args = asJson(asList(chat["arguments"])[0]);
  const message = asJson(args["message"]);
  const prompt = asText(message["text"]);
  const tone = asText(args["tone"]) || null;
  const agentId = asText(asJson(args["threadLevelGptId"])["id"]) || null;
  const annotations = message["messageAnnotations"];
  const query = new URLSearchParams(
    requestPath.includes("?") ? requestPath.slice(requestPath.indexOf("?") + 1) : "",
  );
  records.push({
    conversationId: query.get("ConversationId") ?? "",
    isStart: args["isStartOfSession"] === true,
    prompt,
    tone,
    scenario: query.get("scenario") ?? "",
    agentId,
    optionsSets: asList(args["optionsSets"]),
    messageAnnotations: Array.isArray(annotations) ? annotations : null,
    stopText: null,
  });

  const marker = prompt.includes("disengage-retry") ? "disengage-retry" : null;
  const disengaged = marker !== null && !disengagedSeen.has(marker);
  if (marker !== null && disengaged) {
    disengagedSeen.add(marker);
  }
  const quota =
    (prompt.includes("quota-exhaust") || prompt.includes("quota-fallback")) &&
    (tone === "Claude_Opus" || tone === "Claude_Sonnet");
  const hostedCommand = prompt.includes("hosted-shell-turn")
    ? "echo hosted-shell-e2e"
    : prompt.includes("hosted-shell-not-selected")
      ? "echo ignored-shell-e2e"
      : null;
  const modelName = tone === "Claude_Opus" ? "Opus" : "Sonnet";

  let text: string;
  let result: Json;
  let messageType: string | null = null;
  if (disengaged) {
    text = "";
    result = { value: "Success" };
    messageType = "Disengaged";
  } else if (quota) {
    text = `You've used your available priority access to the ${modelName} model for today.`;
    result = { value: "OutOfCredits", message: text };
  } else if (hostedCommand !== null) {
    text = prompt.includes("hosted-shell-not-selected") ? "M365 reply retained" : "";
    result = { value: "Success" };
  } else if (
    (tone === "Gpt_6_Sol_Reasoning" || tone === "Gpt_61_Sol_Reasoning") &&
    agentId !== null
  ) {
    text = "";
    result = { value: "InternalError", message: "agent route unavailable" };
  } else if (marker !== null) {
    text = "disengage recovered";
    result = { value: "Success" };
  } else if (prompt.includes("agent-route-recovery")) {
    text = "agentless route recovered";
    result = { value: "Success" };
  } else if (prompt.includes("quota-fallback")) {
    text = "fallback model response";
    result = { value: "Success" };
  } else if (prompt.includes("fixture-tool-turn")) {
    text = "```bash\necho e2e\n```";
    result = { value: "Success" };
  } else if (prompt.includes("powershell-tool-turn")) {
    text = "```bash\nGet-ChildItem\n```";
    result = { value: "Success" };
  } else if (prompt.includes("yaml-tool-turn")) {
    text = "```edit_files\npath: file.txt\nedits:\n  - oldText: before\n    newText: after\n```";
    result = { value: "Success" };
  } else if (prompt.includes("responses-tool-turn")) {
    text = "```bash\necho responses-e2e\n```";
    result = { value: "Success" };
  } else if (prompt.includes("responses first")) {
    text = "responses fixture first";
    result = { value: "Success" };
  } else if (prompt.includes("stream fixture")) {
    text = "stream fixture delivers chunks";
    result = { value: "Success" };
  } else if (prompt.includes("<tool_response")) {
    text = "tool result acknowledged";
    result = { value: "Success" };
  } else {
    text = "responses fixture followup";
    result = { value: "Success" };
  }

  if (hostedCommand !== null) {
    socket.send(
      JSON.stringify({
        type: 1,
        target: "update",
        arguments: [
          {
            messages: [
              {
                author: "bot",
                messageType: "Progress",
                contentType: "Code",
                hiddenText: `bash -lc ${hostedCommand}`,
              },
            ],
          },
        ],
      }) + RS,
    );
    if (!prompt.includes("hosted-shell-not-selected")) {
      const stopText = await socket.nextText(STOP_FRAME_TIMEOUT_MS);
      if (stopText !== null) {
        lastRecord().stopText = stopText;
      }
      socket.close();
      return;
    }
  }

  const streamed =
    !quota &&
    !disengaged &&
    hostedCommand === null &&
    agentId === null &&
    !prompt.includes("fixture-tool-turn") &&
    !prompt.includes("yaml-tool-turn") &&
    !prompt.includes("powershell-tool-turn");
  if (streamed) {
    for (const chunk of [text.slice(0, 7), text.slice(7, 17), text.slice(17)]) {
      if (chunk.length > 0) {
        socket.send(
          JSON.stringify({ type: 1, target: "update", arguments: [{ writeAtCursor: chunk }] }) + RS,
        );
      }
    }
  }

  const botMessage: Json = { author: "bot", text };
  if (messageType !== null) {
    botMessage["messageType"] = messageType;
  }
  let metering: Json = {};
  if (quota && tone === "Claude_Opus") {
    metering = {
      ClaudeOpusQueryDaily: { remainingAllowance: 0 },
      ClaudeOpusQuery75: { remainingAllowance: 9 },
    };
  } else if (quota) {
    metering = {
      ClaudeSonnet55QueryDaily: { remainingAllowance: 0 },
      ClaudeSonnet55QueryWeekly: { remainingAllowance: 9 },
    };
  }
  socket.send(
    JSON.stringify({
      type: 2,
      item: { messages: [botMessage], result, throttling: { metering } },
    }) + RS,
  );
  socket.send(JSON.stringify({ type: 3, invocationId: "0" }) + RS);
  socket.close();
}

/** Serves the fake Chathub endpoint; the proxy opens one socket per turn. */
function createChathubServer(): Server {
  const server = createServer((_request, response) => {
    response.writeHead(426, { "Content-Type": "text/plain" });
    response.end("the fixture only accepts WebSocket upgrades");
  });
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const connection = new ChathubSocket(socket);
    answerTurn(connection, request.url ?? "/").catch((error: unknown) => {
      const detail = messageOf(error);
      process.stderr.write(`fixture chathub turn failed: ${detail}\n`);
      connection.close();
    });
  });
  return server;
}

/** Serves the fake substrate UploadFile endpoint. */
function createUploadServer(): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      uploads.push({
        path: request.url ?? "",
        headers: exactHeaders(request),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const payload = JSON.stringify({
        result: { value: "Success" },
        docId: "doc-fixture-1",
        fileName: "image-1.png",
        fileType: "png",
      });
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload)),
      });
      response.end(payload);
    });
  });
}

/** Header names exactly as the client spelled them, for case assertions. */
function exactHeaders(request: IncomingMessage): Map<string, string> {
  const headers = new Map<string, string>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    if (name !== undefined) {
      headers.set(name, request.rawHeaders[index + 1] ?? "");
    }
  }
  return headers;
}

async function listenOn(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("E2E FAIL: a fixture server did not bind to a TCP port");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Environment: the loopback/token/agent stubs, restored on the way out
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "M365_WS_URL",
  "M365_UPLOAD_URL",
  "M365_TEST_ACCESS_TOKEN",
  "M365_AGENT_ID",
  "M365_OPUS_FALLBACK_MODEL",
  "M365_SONNET_FALLBACK_MODEL",
  "M365_NO_CODE_INTERPRETER",
  "M365_FORCE_AGENT",
  "M365_FRAMING_VARIANT",
  "M365_ALLOW_MULTI_TOOL",
] as const;

function snapshotEnv(): Map<string, string | undefined> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    snapshot.set(key, process.env[key]);
  }
  return snapshot;
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function fixtureToken(): string {
  const payload = Buffer.from(JSON.stringify({ oid: OID, tid: TID }), "utf8").toString("base64url");
  return `e30.${payload}.fixture`;
}

/**
 * `M365_E2E_QUIET` keeps a hosted run's output to the pass line. The proxy logs
 * every request to stderr and the fixture has no seam into that path, so the
 * stream is muted for the run. The mute is lifted before `runE2E` settles, so a
 * failure still reports through the CLI entry.
 */
function muteStderr(): () => void {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (): boolean => true;
  return (): void => {
    process.stderr.write = write;
  };
}

// ---------------------------------------------------------------------------
// Request fixtures (the tool definitions the Python fixture posted)
// ---------------------------------------------------------------------------

function bashTool(): Json {
  return {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  };
}

function powershellTool(): Json {
  return {
    type: "function",
    function: {
      name: "powershell",
      description: "Run a PowerShell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, timeout: { type: "number" } },
        required: ["command"],
      },
    },
  };
}

function editFilesTool(): Json {
  return {
    type: "function",
    function: {
      name: "edit_files",
      description: "Apply edits",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: { oldText: { type: "string" }, newText: { type: "string" } },
            },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function checkModels(base: string): Promise<void> {
  const response = await http("GET", `${base}/v1/models`);
  check(response.status === 200, `GET /v1/models returned ${response.status}: ${response.body}`);
  const catalog: unknown = JSON.parse(response.body);
  same(asJson(catalog)["data"], catalogModule.modelsResponse().data, "models list");
  const ids = asList(asJson(catalog)["data"]).map((entry) => asText(asJson(entry)["id"]));
  check(
    ids.includes("gpt-6.1-sol") && ids.includes("claude-sonnet-5.5"),
    `models list is missing probed aliases: ${ids.join(", ")}`,
  );

  // The connector's status probe reads this: a fixture token counts as signed in.
  const health = await http("GET", `${base}/healthz`);
  check(health.status === 200, `GET /healthz returned ${health.status}: ${health.body}`);
  const healthBody: unknown = JSON.parse(health.body);
  const healthToken = asJson(asJson(healthBody)["token"]);
  same(
    Object.keys(healthToken).sort(),
    ["refreshable", "seconds_remaining", "username", "valid"],
    "/healthz token shape",
  );
  check(
    healthToken["valid"] === true,
    `/healthz should report the fixture token as valid: ${health.body}`,
  );
  check(
    healthToken["refreshable"] === false,
    `/healthz should report the injected fixture token as not refreshable: ${health.body}`,
  );
  check(
    healthToken["seconds_remaining"] === null && healthToken["username"] === null,
    `/healthz should report no expiry or account for the injected fixture token: ${health.body}`,
  );
}

/**
 * `/healthz`'s `refreshable` tracks the on-disk refresh token, independent of the
 * cached access token's own window: a refresh token means the next request can
 * silently refresh. This drives `FileTokenProvider.tokenStatus` through a throwaway
 * `M365_CACHE_FILE`, which also proves the env override is honored.
 */
async function checkTokenStatus(): Promise<void> {
  const previous = process.env.M365_CACHE_FILE;
  const directory = await mkdtemp(join(tmpdir(), "m365-e2e-cache-"));
  try {
    const now = Date.now() / 1000;
    const key = authModule.scopeKey(authModule.CHAT_SCOPES);

    // An expired access token plus a refresh token: not valid, but refreshable.
    const expiredFile = join(directory, "token-cache.json");
    await writeFile(
      expiredFile,
      JSON.stringify({
        refresh_token: "fixture-refresh-token",
        username: "fixture@example.com",
        access: { [key]: { token: "expired-access-token", expires_at: now - 10 } },
      }),
      "utf8",
    );
    process.env.M365_CACHE_FILE = expiredFile;
    const expired = await new authModule.FileTokenProvider().tokenStatus(authModule.CHAT_SCOPES);
    same(
      expired,
      {
        valid: false,
        refreshable: true,
        secondsRemaining: 0,
        username: "fixture@example.com",
      },
      "an expired token with a refresh token on disk",
    );

    // A fresh access token with no refresh token: valid, but not refreshable.
    const noRefreshFile = join(directory, "no-refresh.json");
    await writeFile(
      noRefreshFile,
      JSON.stringify({
        access: { [key]: { token: "fresh-access-token", expires_at: now + 3600 } },
      }),
      "utf8",
    );
    process.env.M365_CACHE_FILE = noRefreshFile;
    const fresh = await new authModule.FileTokenProvider().tokenStatus(authModule.CHAT_SCOPES);
    check(fresh.valid === true, "a fresh access token must be valid");
    check(fresh.refreshable === false, "no refresh token on disk means not refreshable");
    check(
      fresh.secondsRemaining !== null && fresh.secondsRemaining > 3500,
      `secondsRemaining should reflect the access token's expiry: ${fresh.secondsRemaining}`,
    );
    check(fresh.username === null, `no cached username must report null: ${fresh.username}`);
  } finally {
    if (previous === undefined) {
      delete process.env.M365_CACHE_FILE;
    } else {
      process.env.M365_CACHE_FILE = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function checkChatToolLoops(base: string): Promise<ChatLoopBaseline> {
  const toolLoop = await http(
    "POST",
    `${base}/v1/chat/completions`,
    {
      model: "m365-copilot",
      messages: [{ role: "user", content: "fixture-tool-turn" }],
      tools: [bashTool()],
    },
    conversationHeaders("e2e-chat"),
  );
  check(toolLoop.status === 200, `chat tool loop returned ${toolLoop.status}: ${toolLoop.body}`);
  const toolLoopBody: unknown = JSON.parse(toolLoop.body);
  const call = toolCallOf(toolLoopBody);
  check(toolName(call) === "bash", `chat tool loop picked ${toolName(call)}, expected bash`);
  same(toolArguments(call), { command: "echo e2e" }, "chat tool loop arguments");
  const first = lastRecord();
  check(first.isStart === true, "the first chat turn must start the session");

  const powershell = await http(
    "POST",
    `${base}/v1/chat/completions`,
    {
      model: "m365-copilot",
      messages: [{ role: "user", content: "powershell-tool-turn" }],
      tools: [powershellTool()],
    },
    conversationHeaders("e2e-powershell"),
  );
  check(
    powershell.status === 200,
    `powershell tool loop returned ${powershell.status}: ${powershell.body}`,
  );
  const powershellBody: unknown = JSON.parse(powershell.body);
  const powershellCall = toolCallOf(powershellBody);
  check(
    toolName(powershellCall) === "powershell",
    `powershell tool loop picked ${toolName(powershellCall)}, expected powershell`,
  );
  same(
    toolArguments(powershellCall),
    { command: "Get-ChildItem" },
    "powershell tool loop arguments",
  );
  const powershellPrompt = lastRecord().prompt;
  check(
    powershellPrompt.includes('info-string is exactly `powershell`'),
    `PowerShell prompt does not identify the callable fence: ${powershellPrompt}`,
  );

  return { call, conversationId: first.conversationId };
}

async function checkImageUpload(base: string): Promise<void> {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24),
  ]);
  const upload = await http(
    "POST",
    `${base}/v1/chat/completions`,
    {
      model: "m365-copilot",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this image?" },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
            },
          ],
        },
      ],
    },
    conversationHeaders("e2e-image"),
  );
  check(upload.status === 200, `image turn returned ${upload.status}: ${upload.body}`);
  const imageRecord = lastRecord();
  const annotations = asList(imageRecord.messageAnnotations);
  const annotation = asJson(annotations[0]);
  check(
    annotations.length > 0,
    `the image turn carried no annotations: ${JSON.stringify(imageRecord)}`,
  );
  same(annotation["messageAnnotationType"], "ImageFile", "image annotation type");
  same(annotation["id"], "doc-fixture-1", "image annotation doc id");
  same(
    asJson(annotation["messageAnnotationMetadata"])["fileType"],
    "png",
    "image annotation file type",
  );
  check(
    imageRecord.optionsSets.includes("cwc_fileupload_odb"),
    `image turn options sets were ${JSON.stringify(imageRecord.optionsSets)}`,
  );

  check(uploads.length > 0, "no upload request reached the fixture");
  const uploadRequest = lastUpload();
  check(
    uploadRequest.path === UPLOAD_PATH,
    `upload went to ${uploadRequest.path}, expected ${UPLOAD_PATH}`,
  );
  check(uploadRequest.body.includes("UploadImage"), "upload body lost the UploadImage scenario");
  check(uploadRequest.body.includes("FileBase64"), "upload body lost the FileBase64 field");
  const anchorMailbox = uploadRequest.headers.get("X-AnchorMailbox");
  check(
    anchorMailbox === `Oid:${OID}@${TID}`,
    `upload X-AnchorMailbox was ${anchorMailbox ?? "<missing>"}, ` +
      `spellings sent: ${[...uploadRequest.headers.keys()].join(", ")}`,
  );
  const fields = [...uploadRequest.body.matchAll(/name="([^"]*)"/g)].map((match) => match[1] ?? "");
  same(
    fields,
    ["scenario", "conversationId", "FileBase64", "optionsSets", "optionsSets", "optionsSets"],
    "upload multipart field order",
  );

  const unsupported = await http("POST", `${base}/v1/chat/completions`, {
    model: "m365-copilot",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/tiff;base64,AAAA" } }],
      },
    ],
  });
  check(
    unsupported.status === 400,
    `an unsupported image type returned ${unsupported.status}: ${unsupported.body}`,
  );
  const unsupportedBody: unknown = JSON.parse(unsupported.body);
  const unsupportedError = asJson(asJson(unsupportedBody)["error"]);
  check(
    asText(unsupportedError["message"]).includes("unsupported image type"),
    `unsupported image message was ${asText(unsupportedError["message"])}`,
  );
}

async function checkHostedShellRouting(base: string, baseline: ChatLoopBaseline): Promise<void> {
  const hosted = await http(
    "POST",
    `${base}/v1/chat/completions`,
    {
      model: "gpt-6-think-deeper",
      messages: [{ role: "user", content: "hosted-shell-turn" }],
      tools: [bashTool()],
    },
    conversationHeaders("e2e-hosted-shell"),
  );
  check(hosted.status === 200, `hosted shell turn returned ${hosted.status}: ${hosted.body}`);
  const hostedBody: unknown = JSON.parse(hosted.body);
  const hostedCall = toolCallOf(hostedBody);
  check(
    toolName(hostedCall) === "bash",
    `hosted shell turn picked ${toolName(hostedCall)}, expected bash`,
  );
  same(toolArguments(hostedCall), { command: "echo hosted-shell-e2e" }, "hosted shell command");
  check(
    chatMessage(hostedBody)["content"] === null,
    "the intercepted hosted shell turn must leave no prose behind",
  );
  const hostedRecord = lastRecord();
  check(hostedRecord.agentId === null, "the hosted shell turn must not route through an agent");
  same(hostedRecord.optionsSets, [], "hosted shell options sets");
  check(
    hostedRecord.stopText === STOP_FRAME,
    `the hosted shell stop frame was ${JSON.stringify(hostedRecord.stopText)}`,
  );
  const stopFrames = framesOf(hostedRecord.stopText ?? "");
  check(stopFrames.length === 1, "the stop frame must arrive on its own");
  same(stopFrames[0]?.["target"], "stop", "hosted shell stop frame target");
  same(stopFrames[0]?.["invocationId"], "1", "hosted shell stop frame invocation id");

  const followup = await http(
    "POST",
    `${base}/v1/chat/completions`,
    {
      model: "m365-copilot",
      tools: [bashTool()],
      messages: [
        { role: "user", content: "fixture-tool-turn" },
        { role: "assistant", content: null, tool_calls: [baseline.call] },
        { role: "tool", tool_call_id: asText(baseline.call["id"]), content: "real e2e output" },
        { role: "user", content: "continue" },
      ],
    },
    conversationHeaders("e2e-chat"),
  );
  check(followup.status === 200, `chat follow-up returned ${followup.status}: ${followup.body}`);
  const followupBody: unknown = JSON.parse(followup.body);
  const second = lastRecord();
  check(
    second.conversationId === baseline.conversationId,
    "the follow-up must reuse the conversation id",
  );
  check(second.isStart === false, "the follow-up must continue the session");
  check(
    second.prompt.includes("real e2e output"),
    `the follow-up prompt lost the tool output: ${second.prompt}`,
  );
  same(chatMessage(followupBody)["content"], "tool result acknowledged", "chat follow-up reply");
}

async function checkToolChoiceRestriction(base: string): Promise<void> {
  const restricted = await http("POST", `${base}/v1/chat/completions`, {
    model: "gpt-6-think-deeper",
    messages: [{ role: "user", content: "hosted-shell-not-selected" }],
    tools: [bashTool(), editFilesTool()],
    tool_choice: { type: "function", function: { name: "edit_files" } },
  });
  check(
    restricted.status === 200,
    `restricted hosted shell turn returned ${restricted.status}: ${restricted.body}`,
  );
  const restrictedBody: unknown = JSON.parse(restricted.body);
  const restrictedMessage = chatMessage(restrictedBody);
  check(
    asList(restrictedMessage["tool_calls"]).length === 0,
    "a tool_choice outside the shell tool must not surface a tool call",
  );
  same(restrictedMessage["content"], "M365 reply retained", "restricted turn reply");
  check(
    lastRecord().stopText === null,
    "a tool_choice outside the shell tool must not stop the turn",
  );
}

async function checkEditFilesTurn(base: string): Promise<void> {
  const edit = await http("POST", `${base}/v1/chat/completions`, {
    model: "m365-copilot",
    messages: [{ role: "user", content: "yaml-tool-turn" }],
    tools: [editFilesTool()],
  });
  check(edit.status === 200, `yaml tool turn returned ${edit.status}: ${edit.body}`);
  const editBody: unknown = JSON.parse(edit.body);
  const editCall = toolCallOf(editBody);
  check(
    toolName(editCall) === "edit_files",
    `yaml tool turn picked ${toolName(editCall)}, expected edit_files`,
  );
  same(
    toolArguments(editCall),
    { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] },
    "edit_files arguments",
  );
}

async function checkRetries(base: string): Promise<void> {
  const disengage = await http("POST", `${base}/v1/chat/completions`, {
    model: "m365-copilot",
    messages: [{ role: "user", content: "disengage-retry" }],
  });
  check(
    disengage.status === 200 &&
      chatMessage(JSON.parse(disengage.body))["content"] === "disengage recovered",
    `the disengaged turn did not recover (${disengage.status}): ${disengage.body}`,
  );
  const disengageTurns = records.slice(-2);
  const [disengageFirst, disengageRetry] = disengageTurns;
  check(disengageTurns.length === 2, "a Disengaged turn must be retried exactly once");
  check(
    disengageFirst?.conversationId !== disengageRetry?.conversationId,
    "the Disengaged retry must open a new conversation",
  );
  check(
    disengageFirst?.isStart === true && disengageRetry?.isStart === true,
    "both Disengaged turns must start their session",
  );
  for (const turn of [disengageFirst, disengageRetry]) {
    check(
      asList(turn?.optionsSets).includes("cwc_code_interpreter"),
      `Disengaged turn lost the code interpreter options: ${JSON.stringify(turn?.optionsSets)}`,
    );
  }

  const agentRoute = await http(
    "POST",
    `${base}/v1/chat/completions`,
    {
      model: "gpt-6-sol",
      messages: [{ role: "user", content: "agent-route-recovery" }],
      tools: [bashTool()],
    },
    conversationHeaders("e2e-agent-route"),
  );
  check(
    agentRoute.status === 200 &&
      chatMessage(JSON.parse(agentRoute.body))["content"] === "agentless route recovered",
    `the agent route did not recover (${agentRoute.status}): ${agentRoute.body}`,
  );
  const agentTurns = records.slice(-2);
  const [agentFirst, agentRetry] = agentTurns;
  check(agentTurns.length === 2, "a dead agent route must be retried exactly once");
  check(
    agentFirst?.agentId === AGENT_ID && agentRetry?.agentId === null,
    `the agent retry must drop the agent id, saw ${agentFirst?.agentId} then ${agentRetry?.agentId}`,
  );
  check(
    agentFirst?.conversationId !== agentRetry?.conversationId,
    "the agent retry must open a new conversation",
  );
}

async function checkChatStreaming(base: string): Promise<void> {
  const stream = await http("POST", `${base}/v1/chat/completions`, {
    model: "m365-copilot",
    stream: true,
    messages: [{ role: "user", content: "stream fixture" }],
  });
  check(stream.status === 200, `chat stream returned ${stream.status}: ${stream.body}`);
  check(
    stream.contentType.startsWith("text/event-stream"),
    `chat stream content type was ${stream.contentType}`,
  );
  check(stream.body.includes("data: [DONE]"), "the chat stream must end with [DONE]");
  const chunks = chatChunks(stream.body);
  const finalIndex = chunks.findIndex((chunk) => chunk.finishReason !== null);
  check(finalIndex >= 0, "the chat stream must finish with a final message");
  const deltas = chunks.slice(0, finalIndex);
  check(
    deltas.some((chunk) => chunk.content.length > 0),
    "chat deltas must arrive before the final message",
  );
  same(
    deltas.map((chunk) => chunk.content).join(""),
    "stream fixture delivers chunks",
    "streamed chat text",
  );
  check(finalIndex === chunks.length - 1, "the final message must close the chat stream");
}

async function checkResponses(base: string): Promise<void> {
  const first = await http("POST", `${base}/v1/responses`, {
    model: "m365-copilot",
    input: "responses first",
  });
  check(first.status === 200, `responses returned ${first.status}: ${first.body}`);
  const firstBody: unknown = JSON.parse(first.body);
  const firstResponse = asJson(firstBody);
  const firstResponseId = asText(firstResponse["id"]);
  check(firstResponseId.length > 0, "the responses reply carried no id");
  same(firstResponse["output_text"], "responses fixture first", "first responses text");
  const firstRecord = lastRecord();

  const continueResponse = await http("POST", `${base}/v1/responses`, {
    model: "m365-copilot",
    previous_response_id: firstResponseId,
    input: "responses continue",
  });
  check(
    continueResponse.status === 200,
    `responses follow-up returned ${continueResponse.status}: ${continueResponse.body}`,
  );
  const continueBody: unknown = JSON.parse(continueResponse.body);
  same(
    asJson(continueBody)["output_text"],
    "responses fixture followup",
    "responses follow-up text",
  );
  const continueRecord = lastRecord();
  check(
    continueRecord.conversationId === firstRecord.conversationId,
    "the responses follow-up must reuse the conversation id",
  );
  check(continueRecord.isStart === false, "the responses follow-up must continue the session");

  const tools = [
    {
      type: "function",
      name: "bash",
      description: "Run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  ];
  const toolResponse = await http("POST", `${base}/v1/responses`, {
    model: "m365-copilot",
    input: "responses-tool-turn",
    tools,
  });
  check(
    toolResponse.status === 200,
    `responses tool turn returned ${toolResponse.status}: ${toolResponse.body}`,
  );
  const toolResponseBody: unknown = JSON.parse(toolResponse.body);
  const call = asJson(asList(asJson(toolResponseBody)["output"])[0]);
  same([call["type"], call["name"]], ["function_call", "bash"], "responses tool loop call");
  const callId = asText(call["call_id"]);
  check(callId.length > 0, "the responses function_call carried no call id");
  const toolRecord = lastRecord();

  const toolResult = await http("POST", `${base}/v1/responses`, {
    model: "m365-copilot",
    previous_response_id: asText(asJson(toolResponseBody)["id"]),
    input: [{ type: "function_call_output", call_id: callId, output: "response loop output" }],
  });
  check(
    toolResult.status === 200 &&
      asJson(JSON.parse(toolResult.body))["output_text"] === "tool result acknowledged",
    `responses tool result returned ${toolResult.status}: ${toolResult.body}`,
  );
  const resultRecord = lastRecord();
  check(
    resultRecord.conversationId === toolRecord.conversationId,
    "the responses tool loop must reuse the conversation id",
  );
  check(
    resultRecord.prompt.includes('tool_response name="bash"'),
    `the tool response prompt lost the tool name: ${resultRecord.prompt}`,
  );
  check(
    resultRecord.prompt.includes("response loop output"),
    `the tool response prompt lost the output: ${resultRecord.prompt}`,
  );

  const stream = await http("POST", `${base}/v1/responses`, {
    model: "m365-copilot",
    stream: true,
    input: "stream fixture",
  });
  check(stream.status === 200, `responses stream returned ${stream.status}: ${stream.body}`);
  check(
    stream.contentType.startsWith("text/event-stream"),
    `responses stream content type was ${stream.contentType}`,
  );
  check(
    stream.body.includes("event: response.output_text.delta"),
    "the responses stream must emit output text deltas",
  );
  check(stream.body.includes("event: response.completed"), "the responses stream must complete");
  check(stream.body.includes("data: [DONE]"), "the responses stream must end with [DONE]");
}

async function checkPriorityAccess(base: string): Promise<void> {
  const fallback = await http(
    "POST",
    `${base}/v1/chat/completions`,
    { model: "claude-opus", messages: [{ role: "user", content: "quota-fallback" }] },
    conversationHeaders("e2e-quota-fallback"),
  );
  check(fallback.status === 200, `priority fallback returned ${fallback.status}: ${fallback.body}`);
  same(asJson(JSON.parse(fallback.body))["model"], "m365-copilot", "priority fallback model");
  same(
    chatMessage(JSON.parse(fallback.body))["content"],
    "fallback model response",
    "priority fallback reply",
  );
  const fallbackTurns = records.slice(-2);
  const [opusRefusal, fallbackTurn] = fallbackTurns;
  check(fallbackTurns.length === 2, "a refused priority turn must fall back exactly once");
  same(
    [opusRefusal?.tone, fallbackTurn?.tone],
    ["Claude_Opus", "magic"],
    "priority fallback tones",
  );
  check(
    opusRefusal?.conversationId !== fallbackTurn?.conversationId,
    "the priority fallback must open a new conversation",
  );

  const exhausted = await http(
    "POST",
    `${base}/v1/chat/completions`,
    {
      model: "claude-sonnet-5.5",
      messages: [{ role: "user", content: "quota-exhaust-sonnet" }],
    },
    conversationHeaders("e2e-sonnet-quota"),
  );
  check(
    exhausted.status === 429,
    `an exhausted sonnet budget returned ${exhausted.status}: ${exhausted.body}`,
  );
  const exhaustedBody: unknown = JSON.parse(exhausted.body);
  const exhaustedError = asJson(asJson(exhaustedBody)["error"]);
  same(exhaustedError["code"], "priority_access_exhausted", "priority exhaustion error code");
  const retryAfter = Number.parseInt(exhausted.retryAfter ?? "", 10);
  check(
    Number.isFinite(retryAfter) && retryAfter > 0,
    `an exhausted budget must advertise Retry-After, saw ${exhausted.retryAfter}`,
  );
  const turnsAfterExhaustion = records.length;
  const blocked = await http("POST", `${base}/v1/chat/completions`, {
    model: "claude-sonnet-5.5",
    messages: [{ role: "user", content: "must be blocked" }],
  });
  check(blocked.status === 429, `a blocked request returned ${blocked.status}: ${blocked.body}`);
  check(
    records.length === turnsAfterExhaustion,
    "an exhausted budget must not start another M365 turn",
  );
}

/**
 * Runs the whole fixture against a loopback ProxyApplication and returns the
 * pass line, or throws with the first failed assertion.
 */
export async function runE2E(): Promise<string> {
  records.length = 0;
  disengagedSeen.clear();
  uploads.length = 0;

  const env = snapshotEnv();
  const chathub = createChathubServer();
  const uploadServer = createUploadServer();
  const chathubPort = await listenOn(chathub);
  const uploadPort = await listenOn(uploadServer);

  process.env.M365_WS_URL = `ws://127.0.0.1:${chathubPort}`;
  process.env.M365_UPLOAD_URL = `http://127.0.0.1:${uploadPort}${UPLOAD_PATH}`;
  process.env.M365_TEST_ACCESS_TOKEN = fixtureToken();
  process.env.M365_AGENT_ID = AGENT_ID;
  process.env.M365_OPUS_FALLBACK_MODEL = "m365-copilot";
  delete process.env.M365_SONNET_FALLBACK_MODEL;
  delete process.env.M365_NO_CODE_INTERPRETER;
  delete process.env.M365_FORCE_AGENT;
  delete process.env.M365_FRAMING_VARIANT;
  delete process.env.M365_ALLOW_MULTI_TOOL;

  const app = new ProxyApplication();
  const api = createHttpServer(app);
  const apiPort = await listenOn(api);
  const base = `http://127.0.0.1:${apiPort}`;
  const restoreStderr = process.env.M365_E2E_QUIET ? muteStderr() : null;
  try {
    await checkModels(base);
    await checkTokenStatus();
    const chatBaseline = await checkChatToolLoops(base);
    await checkImageUpload(base);
    await checkHostedShellRouting(base, chatBaseline);
    await checkToolChoiceRestriction(base);
    await checkEditFilesTurn(base);
    await checkRetries(base);
    await checkChatStreaming(base);
    await checkResponses(base);
    await checkPriorityAccess(base);
    return PASS_LINE;
  } finally {
    restoreStderr?.();
    restoreEnv(env);
    await closeServer(chathub);
    await closeServer(uploadServer);
    await closeServer(api);
  }
}

/**
 * The fixture also runs standalone when invoked directly. Node cannot resolve
 * the repo's `./x.js` sibling specifiers through the `.ts` sources, so the
 * standalone path only comes into play for a compiled/bundled entry (the repo's
 * `check-m365-proxy.mjs` bundles this file with esbuild); the unit lane runs the
 * same `runE2E()` through Playwright's TypeScript loader.
 */
const invokedDirectly = basename(process.argv[1] ?? "").replace(/\.[^.]+$/, "") === "e2e";

if (invokedDirectly) {
  void runE2E().then(
    (line) => {
      process.stdout.write(`${line}\n`);
    },
    (error: unknown) => {
      const detail = messageOf(error);
      process.stderr.write(`${detail}\n`);
      process.exitCode = 1;
    },
  );
}
