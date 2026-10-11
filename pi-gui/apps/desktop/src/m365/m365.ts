/**
 * Port of m365copilotproxy/m365.py — the M365 Copilot Chathub (SignalR) client.
 *
 * Frames are delimited by RS (U+001E), so one WebSocket message can carry
 * several of them. A turn: connect, replay the SignalR JSON handshake, send the
 * `chat` invocation next to the `Metrics` frame, then fold the streamed
 * `update`/`item` frames into a single TurnResult.
 */

import { randomUUID } from "node:crypto";
import { routingForModel, toneForModel } from "./catalog.js";
import { asRecord, isRecord, messageOf } from "./guards.js";
import type { TurnResult } from "./types.js";

export const RS = "\u001e";
export const WS_ENDPOINT = "wss://substrate.office.com/m365Copilot/Chathub";
export const STOP_FRAME = '{"arguments":[{}],"invocationId":"1","target":"stop","type":1}' + RS;
export const VARIANTS = [
  "EnableMcpServerWidgets",
  "feature.EnableMcpServerWidgets",
  "feature.EnableLuForChatCIQ",
  "feature.enableChatCIQPlugin",
  "EnableRequestPlugins",
  "feature.EnableSensitivityLabels",
  "EnableUnsupportedUrlDetector",
  "feature.IsCustomEngineCopilotEnabled",
  "feature.bizchatfluxv3",
  "feature.enablechatpages",
  "feature.enableCodeCanvas",
  "feature.turnOnWorkTabRecommendation",
  "turnOffWorkTabUpsellFromClient",
  "feature.turnOnDARecommendation",
  "feature.IsStreamingModeInChatRequestEnabled",
  "IncludeSourceAttributionsConcise",
  "SkipPublishEmptyMessage",
  "feature.EnableDeduplicatingSourceAttributions",
  "Enable3PActionProgressMessages",
  "feature.enableClientWebRtc",
  "feature.EnableMeetingRecapOfSeriesMeetingWithCiq",
  "feature.EnableReferencesListCompleteSignal",
  "feature.StorageMessageSplitDisabled",
  "feature.EnableCuaTakeControlApi",
  "feature.cwcallowedos",
  "feature.disabledisallowedmsgs",
  "feature.enableCitationsForSynthesisData",
  "feature.enableGenerateGraphicArtOptionsSet",
  "cdximagen",
  "feature.EnableUpdatedUXForConfirmationDialog",
  "feature.EnableClientFileURLSupportForOfficeWebPaidCopilot",
  "feature.EnableDesignEditorImageGrounding",
  "feature.EnableDesignerEditor",
  "feature.OfficeWebToHelix",
  "feature.OfficeDesktopToHelix",
  "feature.M365TeamsHubToHelix",
  "feature.OwaHubToHelix",
  "feature.MonarchHubToHelix",
  "feature.Win32OutlookHubToHelix",
  "feature.MacOutlookHubToHelix",
  "Agt_bizchat_enableGpt5ForHelix",
].join(",");
export const CODE_INTERPRETER_OPTIONS: readonly string[] = [
  "cwc_code_interpreter",
  "cwc_code_interpreter_amsfix",
  "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts",
  "code_interpreter_matplotlib_patching",
];
export const ALLOWED_MESSAGE_TYPES: readonly string[] = [
  "Chat",
  "Suggestion",
  "InternalSearchQuery",
  "Disengaged",
  "InternalLoaderMessage",
  "Progress",
  "RenderCardRequest",
  "SemanticSerp",
  "GenerateContentQuery",
  "SearchQuery",
  "ConfirmationCard",
  "DeveloperLogs",
  "EndOfRequest",
  "ReferencesListComplete",
  "GeneratedCode",
];
// Sent with an image upload and on the chat turn that carries the attachment.
export const UPLOAD_OPTIONS_SETS: readonly string[] = [
  "cwcgptvsan",
  "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
  "gptvnorm2048",
];
export const IMAGE_CHAT_OPTIONS_SETS: readonly string[] = [
  ...UPLOAD_OPTIONS_SETS,
  "cwc_fileupload_odb",
];

/** WebSocket.connect(..., timeout=30): the bound covers the opening handshake. */
const CONNECT_TIMEOUT_MS = 30_000;
/** Matches re.fullmatch on both the oid and the tid claim. */
const GUID = /^[0-9a-fA-F-]{36}$/;

export function tokenClaims(token: string): readonly [string, string] {
  const claims = _claims(token);
  const oid = claims?.["oid"];
  const tid = claims?.["tid"];
  if (typeof oid !== "string" || typeof tid !== "string" || !GUID.test(oid) || !GUID.test(tid)) {
    throw new Error("M365 access token is missing valid oid/tid claims");
  }
  return [oid, tid];
}

function _claims(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (payload === undefined) {
      return null;
    }
    const padding = (4 - (payload.length % 4)) % 4;
    const decoded: unknown = JSON.parse(
      Buffer.from(payload + "=".repeat(padding), "base64url").toString("utf8"),
    );
    return asRecord(decoded);
  } catch {
    return null;
  }
}

function _query(
  token: string,
  oid: string,
  tid: string,
  conversationId: string,
  sessionId: string,
  requestId: string,
  model: string,
): string {
  const [scenario, licenseType] = routingForModel(model);
  const params: Record<string, string> = {
    chatsessionid: requestId,
    clientrequestid: requestId,
    "X-SessionId": sessionId,
    ConversationId: conversationId,
    access_token: token,
    variants: VARIANTS,
    source: '"officeweb"',
    product: "Office",
    agentHost: "Bizchat.FullScreen",
    licenseType: licenseType,
    agent: "web",
    scenario: scenario,
    disableMemory: "1",
  };
  const base = process.env.M365_WS_URL ?? `${WS_ENDPOINT}/${oid}@${tid}`;
  // urlencode: percent-escape, then spaces as "+" (Python's quote_plus).
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const escapedKey = encodeURIComponent(key).replace(/%20/g, "+");
    const escapedValue = encodeURIComponent(value).replace(/%20/g, "+");
    pairs.push(`${escapedKey}=${escapedValue}`);
  }
  return base + (base.includes("?") ? "&" : "?") + pairs.join("&");
}

function _chatArgs(
  text: string,
  model: string,
  sessionId: string,
  requestId: string,
  agentId: string | null,
  isStart: boolean,
  toolTurn = false,
  annotations: readonly Record<string, unknown>[] | null = null,
): Record<string, unknown> {
  const tone = toneForModel(model);
  const attachments = annotations !== null && annotations.length > 0 ? annotations : null;
  const baseOptions =
    agentId || toolTurn || process.env.M365_NO_CODE_INTERPRETER === "1"
      ? []
      : CODE_INTERPRETER_OPTIONS;
  const options = attachments === null ? baseOptions : [...baseOptions, ...IMAGE_CHAT_OPTIONS_SETS];
  const args: Record<string, unknown> = {
    source: "officeweb",
    clientCorrelationId: requestId,
    sessionId: sessionId,
    optionsSets: options,
    streamingMode: "ConciseWithPadding",
    spokenTextMode: "None",
    options: {},
    extraExtensionParameters: {},
    allowedMessageTypes: ALLOWED_MESSAGE_TYPES,
    sliceIds: [],
    threadLevelGptId: agentId ? { id: agentId, source: "MOS3" } : {},
    traceId: requestId,
    isStartOfSession: isStart,
    clientInfo: {
      clientPlatform: "mcmcopilot-web",
      clientAppName: "Office",
      clientEntrypoint: "mcmcopilot-officeweb",
      clientSessionId: sessionId,
      clientAppType: "Web",
      deviceOS: "Linux",
      deviceType: "Desktop",
    },
    message: {
      author: "user",
      inputMethod: "Keyboard",
      text: text,
      entityAnnotationTypes: ["People", "File", "Event", "Email", "TeamsMessage"],
      requestId: requestId,
      locationInfo: { timeZoneOffset: 1, timeZone: "Europe/Copenhagen" },
      locale: "en-gb",
      messageType: "Chat",
      experienceType: "Default",
      adaptiveCards: [],
      clientPreferences: {},
      ...(attachments === null
        ? {}
        : { messageAnnotations: attachments, connectedFederatedConnections: ["dummyId"] }),
    },
    plugins: agentId ? [] : [{ Id: "BingWebSearch", Source: "BuiltIn" }],
    isSbsSupported: true,
    tone: tone,
    renderReferencesBehindEOS: true,
    disconnectBehavior: "continue",
  };
  if (agentId) {
    args["gpts"] = [
      {
        id: agentId,
        source: "MOS3",
        version: "1.0.0",
        clientOverrides: {
          capabilities: [],
          "deepResearchModels@odata.type": "Collection(String)",
        },
      },
    ];
  }
  return args;
}

/** The dict frames carried by one WebSocket message; junk is skipped. */
function _parseFrames(raw: string): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  for (const chunk of raw.split(RS)) {
    if (!chunk) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (isRecord(parsed)) {
      frames.push(parsed);
    }
  }
  return frames;
}

function _textFromMessages(messages: unknown): readonly [string, string | null] {
  const texts: string[] = [];
  let messageType: string | null = null;
  if (!Array.isArray(messages)) {
    return ["", null];
  }
  for (const message of messages) {
    const item = _object(message);
    if (item["author"] !== "bot") {
      continue;
    }
    const messageTypeValue = item["messageType"];
    if (messageTypeValue) {
      messageType = _errorText(messageTypeValue);
    }
    const text = item["text"];
    if (typeof text === "string" && text && !messageTypeValue) {
      texts.push(text);
    }
  }
  return [texts.join("\n\n"), messageType];
}

function _hostedShellCommand(messages: unknown): string | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (const message of messages) {
    const item = _object(message);
    if (item["messageType"] !== "Progress" || item["contentType"] !== "Code") {
      continue;
    }
    const hiddenText = item["hiddenText"];
    if (typeof hiddenText !== "string") {
      continue;
    }
    const match = /^bash\s+-lc\s+([\s\S]+)$/.exec(hiddenText);
    if (match) {
      return match[1] ?? null;
    }
  }
  return null;
}

/** Merges a streamed snapshot into the text so far, ignoring repeats. */
function _fold(current: string, nextText: string): string {
  if (!nextText || nextText === current || current.startsWith(nextText)) {
    return current;
  }
  if (nextText.startsWith(current)) {
    return nextText;
  }
  const left = Array.from(current);
  const right = Array.from(nextText);
  let common = 0;
  while (common < left.length && common < right.length && left[common] === right[common]) {
    common += 1;
  }
  if (common >= Math.min(12, Math.floor(left.length / 2))) {
    return nextText;
  }
  return current + nextText;
}

/** The port's `_object`: a record view of `value`, or an empty one. */
function _object(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function _objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return (value as unknown[]).map((entry: unknown) => _object(entry));
}

/** str(value) for the protocol's string-ish fields; null-ish fields read "". */
function _errorText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

function _frameText(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return "";
}

/** The `message` on a socket error event, when the runtime's event carries one. */
function _errorMessage(event: unknown): string | undefined {
  if (!isRecord(event) || !("message" in event)) {
    return undefined;
  }
  const message: unknown = event.message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

/** Opens the Chathub socket, bounding only the opening handshake. */
async function _connect(uri: string): Promise<WebSocket> {
  const ws = new WebSocket(uri);
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      detach();
      resolve();
    };
    const onError = (event: unknown): void => {
      detach();
      reject(new Error(_errorMessage(event) ?? "M365 WebSocket connect failed"));
    };
    const onClose = (): void => {
      detach();
      reject(new Error("M365 WebSocket closed before the handshake"));
    };
    const detach = (): void => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const timer = setTimeout(() => {
      detach();
      ws.close();
      reject(new Error("M365 WebSocket connect timed out"));
    }, CONNECT_TIMEOUT_MS);
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
  return ws;
}

interface FrameStream {
  /** Next message, or a done step once the socket is gone. */
  next(): Promise<IteratorResult<string, void>>;
  /** Detaches the listeners; the stream cannot be resumed afterwards. */
  stop(): void;
}

/**
 * Delivers each WebSocket message as text while the socket lives. A close ends
 * the stream, the way the Python client turns a closed connection into
 * StopIteration; a transport failure is thrown for the caller to record.
 */
function _messages(ws: WebSocket): FrameStream {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let failure: Error | null = null;
  let closed = false;

  const notify = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const onMessage = (event: { readonly data: unknown }): void => {
    queue.push(_frameText(event.data));
    notify();
  };
  const onError = (): void => {
    failure ??= new Error("M365 WebSocket failed");
    closed = true;
    notify();
  };
  const onClose = (): void => {
    closed = true;
    notify();
  };
  const stop = (): void => {
    ws.removeEventListener("message", onMessage);
    ws.removeEventListener("error", onError);
    ws.removeEventListener("close", onClose);
  };

  ws.addEventListener("message", onMessage);
  ws.addEventListener("error", onError);
  ws.addEventListener("close", onClose);

  const next = async (): Promise<IteratorResult<string, void>> => {
    while (true) {
      while (queue.length > 0) {
        const message = queue.shift();
        if (message !== undefined) {
          return { value: message, done: false };
        }
      }
      const pending: Error | null = failure;
      if (pending !== null) {
        throw pending;
      }
      if (closed) {
        return { value: undefined, done: true };
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  return { next, stop };
}

export async function sendTurn(
  token: string,
  prompt: string,
  model: string,
  conversationId: string,
  sessionId: string,
  agentId: string | null,
  isStart: boolean,
  onDelta: ((delta: string) => void) | null = null,
  toolTurn = false,
  interceptHostedShell = false,
  annotations: readonly Record<string, unknown>[] | null = null,
): Promise<TurnResult> {
  const [oid, tid] = tokenClaims(token);
  const requestId = randomUUID();
  const uri = _query(token, oid, tid, conversationId, sessionId, requestId, model);
  const result: TurnResult = {
    text: "",
    result: null,
    metering: {},
    messageType: null,
    error: null,
    errorCode: null,
    rawItem: null,
  };
  let socket: WebSocket | null = null;
  let frames: FrameStream | null = null;
  try {
    const ws = await _connect(uri);
    socket = ws;
    frames = _messages(ws);
    ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
    let handshakeOk = false;
    for (;;) {
      const step = await frames.next();
      if (step.done) {
        break;
      }
      for (const msg of _parseFrames(step.value)) {
        const error = msg["error"];
        if (error) {
          throw new Error(`SignalR handshake failed: ${_errorText(error)}`);
        }
        if (Object.keys(msg).length === 0) {
          handshakeOk = true;
          break;
        }
      }
      if (handshakeOk) {
        break;
      }
    }
    if (!handshakeOk) {
      throw new Error("SignalR handshake ended before acknowledgement");
    }
    const chat = {
      arguments: [
        _chatArgs(prompt, model, sessionId, requestId, agentId, isStart, toolTurn, annotations),
      ],
      invocationId: "0",
      target: "chat",
      type: 4,
    };
    const now = new Date().toISOString();
    const metrics = {
      arguments: [
        {
          Timestamps: {
            ConnectionStart: now,
            UserInputStart: now,
            ConnectionEstablished: now,
            UserInputSubmit: now,
          },
        },
      ],
      target: "Metrics",
      type: 1,
    };
    ws.send(`${JSON.stringify(chat)}${RS}${JSON.stringify(metrics)}${RS}`);
    let currentText = "";
    let intercepted = false;
    for (;;) {
      const step = await frames.next();
      if (step.done) {
        break;
      }
      for (const msg of _parseFrames(step.value)) {
        const frameType = msg["type"];
        if (frameType === 6) {
          ws.send(JSON.stringify({ type: 6 }) + RS);
        } else if (frameType === 7) {
          const error = msg["error"];
          if (error) {
            result.error = _errorText(error);
          }
        } else if (frameType === 1 && msg["target"] === "update") {
          for (const arg of _objects(msg["arguments"])) {
            const writeAtCursor = arg["writeAtCursor"];
            if (typeof writeAtCursor === "string") {
              currentText += writeAtCursor;
            } else if (Array.isArray(arg["messages"])) {
              const command =
                interceptHostedShell && !agentId ? _hostedShellCommand(arg["messages"]) : null;
              if (command) {
                result.text = `\`\`\`bash\n${command}\n\`\`\``;
                ws.send(STOP_FRAME);
                // Let the server honour the stop frame before the socket closes.
                await new Promise<void>((resolve) => {
                  setTimeout(resolve, 500);
                });
                intercepted = true;
                break;
              }
              const [snapshot, messageType] = _textFromMessages(arg["messages"]);
              currentText = _fold(currentText, snapshot);
              result.messageType = messageType || result.messageType;
            }
            if (onDelta && currentText.length > result.text.length) {
              const delta = currentText.slice(result.text.length);
              result.text = currentText;
              onDelta(delta);
            }
          }
          if (intercepted) {
            break;
          }
        } else if (frameType === 2) {
          const item = _object(msg["item"]);
          result.rawItem = item;
          const [snapshot, messageType] = _textFromMessages(item["messages"]);
          if (snapshot) {
            currentText = _fold(currentText, snapshot);
          }
          result.messageType = messageType || result.messageType;
          const serverResult = item["result"];
          if (isRecord(serverResult)) {
            const payload = _object(serverResult);
            result.result = payload;
            const value = payload["value"];
            result.error =
              value === "Success" || value === "Completed" || value === null
                ? result.error
                : _errorText(payload["message"]);
            const errorCode = payload["errorCode"];
            result.errorCode = typeof errorCode === "string" ? errorCode : null;
          }
          const throttling = item["throttling"];
          if (isRecord(throttling)) {
            const metering = _object(throttling)["metering"];
            if (isRecord(metering)) {
              const allowances: Record<string, number> = {};
              for (const [key, entry] of Object.entries(metering)) {
                const remaining = _object(entry)["remainingAllowance"];
                if (typeof remaining === "number") {
                  allowances[key] = remaining;
                }
              }
              result.metering = allowances;
            }
          }
          if (onDelta && currentText.length > result.text.length) {
            onDelta(currentText.slice(result.text.length));
          }
          result.text = currentText;
          break;
        } else if (frameType === 3) {
          const error = msg["error"];
          if (error) {
            result.error = _errorText(error);
            result.errorCode = "SignalRInvocationError";
          }
        }
      }
      if (result.rawItem !== null || result.errorCode === "SignalRInvocationError" || intercepted) {
        break;
      }
    }
  } catch (error) {
    result.error = messageOf(error);
    result.errorCode = "M365TransportError";
  } finally {
    frames?.stop();
    if (socket !== null && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }
  }
  return result;
}
