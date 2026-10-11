/**
 * Port of `m365copilotproxy/server.py`: the ProxyApplication (conversation
 * bookkeeping, retry / priority-fallback / exhaustion logic) plus the HTTP
 * surface exposed through node:http `createServer` and a small router.
 *
 * Routes (identical to the Python handler):
 *   GET  /v1/models
 *   POST /v1/chat/completions   (SSE when "stream" is true, else single JSON)
 *   POST /v1/responses          (SSE when "stream" is true, else single JSON)
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { InvalidRequestError, UpstreamError } from "./types.js";
import type { TurnResult } from "./types.js";
import { getOrCreateAgent } from "./agent.js";
import { AuthenticationError, FileTokenProvider, SIGN_IN_REQUIRED } from "./auth.js";
import {
  METERED_BUDGETS,
  defaultFraming,
  modelsResponse,
  routingForModel,
  toneForModel,
  usesAgent,
} from "./catalog.js";
import { imagesFromMessages, prepareImageAttachments } from "./images.js";
import { sendTurn } from "./m365.js";
import {
  contentText,
  findShellTool,
  formatDelta,
  formatMessages,
  parseToolCalls,
  toolSpec,
} from "./tooling.js";
import { asRecord, isRecord, messageOf } from "./guards.js";

export const MAX_BODY = 2 * 1024 * 1024;
export const MAX_CONVERSATIONS = 128;
export const IDLE_SECONDS = 30 * 60;
export const PRIORITY_ACCESS =
  /(?:you.?ve|you have)\s+used\s+(?:up\s+)?(?:all\s+of\s+)?your\s+(?:available\s+)?priority access(?:\s+to\s+the\s+([\w.\- ]{1,32}?)\s+model)?\s+for\s+(?:the\s+)?(today|day|week|this\s+week)\b/i;
export const FRAMING_VARIANTS: Readonly<Record<string, true>> = {
  baseline: true,
  relay: true,
  relay_batch: true,
};
export const CHAT_ROLES: Readonly<Record<string, true>> = {
  system: true,
  developer: true,
  user: true,
  assistant: true,
  tool: true,
};
export const RESPONSE_ROLES: Readonly<Record<string, true>> = {
  system: true,
  developer: true,
  user: true,
  assistant: true,
};
export const CONTENT_PART_TYPES: Readonly<Record<string, true>> = {
  input_text: true,
  output_text: true,
  text: true,
};
export const TOOL_CHOICE_KEYWORDS: Readonly<Record<string, true>> = {
  auto: true,
  none: true,
  required: true,
};
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  "127.0.0.1": true,
  localhost: true,
  "::1": true,
};
const OUT_OF_CREDITS_WINDOW = /\bweek|monday\b/i;
const NOT_FOUND_BODY: Record<string, unknown> = {
  error: { message: "Not found", type: "invalid_request_error", param: null, code: "not_found" },
};
const PRIORITY_GATES: readonly string[] = [
  "you've used your available priority access",
  "you've used up all of your priority access",
  "you have used your available priority access",
  "you have used up all of your priority access",
];

/** Minimal provider contract server.py relies on: scoped token acquisition. */
type TokenSource = {
  /** `interactive` is false on the request path, so a turn never opens a browser. */
  token(scopes?: readonly string[], interactive?: boolean): Promise<string>;
  /** Cache-only state for `/healthz`; must not refresh or prompt. */
  tokenStatus(scopes?: readonly string[]): Promise<TokenStatus>;
};

export interface TokenStatus {
  readonly valid: boolean;
  readonly refreshable: boolean;
  readonly secondsRemaining: number | null;
  readonly username: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const item of value) {
    if (isRecord(item)) {
      out.push(item);
    }
  }
  return out;
}

function envValue(name: string): string | null {
  const value = process.env[name];
  return value === undefined ? null : value;
}

function nonEmptyEnv(name: string): string | null {
  const value = envValue(name);
  return value !== null && value.length > 0 ? value : null;
}

function monotonic(): number {
  return performance.now();
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function newId(): string {
  return randomUUID().replaceAll("-", "");
}

function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEquals(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every(
        (key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEquals(a[key], b[key]),
      )
    );
  }
  return false;
}

export function chunkText(text: string, size = 48): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    chunks.push(text.slice(offset, offset + size));
  }
  return chunks;
}

function safeWrite(res: ServerResponse, chunk: string): boolean {
  if (res.destroyed || res.writableEnded) {
    return false;
  }
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

/** Python's ValueError/TypeError/KeyError validation family. */
function isValidationError(error: unknown): error is Error {
  return (
    error instanceof InvalidRequestError ||
    error instanceof UpstreamError ||
    error instanceof TypeError
  );
}

// ---------------------------------------------------------------------------
// ApiError
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  readonly message: string;
  readonly code: string;
  readonly errorType: string;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    message: string,
    code: string,
    errorType?: string,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.message = message;
    this.code = code;
    this.errorType =
      errorType !== undefined && errorType.length > 0
        ? errorType
        : status === 429
          ? "rate_limit_error"
          : status < 500
            ? "invalid_request_error"
            : "server_error";
    this.headers = headers ?? {};
  }

  body(): Record<string, unknown> {
    return { error: { message: this.message, type: this.errorType, param: null, code: this.code } };
  }
}

// ---------------------------------------------------------------------------
// Serialization lock (Python's per-conversation threading.RLock, JS edition)
// ---------------------------------------------------------------------------

class SerialLock {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous
      .then(() => task())
      .finally(() => {
        release();
      });
  }
}

// ---------------------------------------------------------------------------
// Conversation / ChatResult
// ---------------------------------------------------------------------------

export class Conversation {
  readonly key: string;
  conversationId: string = newId();
  sessionId: string = newId();
  sentCount = 0;
  turnCount = 0;
  model: string | null = null;
  touched: number = monotonic();
  responseHistory: Record<string, unknown>[] = [];
  readonly guard = new SerialLock();

  constructor(key: string) {
    this.key = key;
  }

  reset(): void {
    this.conversationId = newId();
    this.sessionId = newId();
    this.sentCount = 0;
    this.turnCount = 0;
    this.model = null;
    this.responseHistory.length = 0;
  }
}

export class ChatResult {
  constructor(
    readonly id: string,
    readonly created: number,
    readonly model: string,
    readonly text: string,
    readonly toolCalls: readonly Record<string, unknown>[],
    readonly finishReason: string,
    readonly conversation: Conversation,
  ) {}

  body(): Record<string, unknown> {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: this.text.length > 0 ? this.text : null,
    };
    if (this.toolCalls.length > 0) {
      message.tool_calls = [...this.toolCalls];
    }
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, message, finish_reason: this.finishReason }],
    };
  }
}

export interface ExhaustionEntry {
  readonly window: string;
  readonly resetsAt: number;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// ProxyApplication
// ---------------------------------------------------------------------------

export class ProxyApplication {
  readonly conversations = new Map<string, Conversation>();
  readonly responseSessions = new Map<string, string>();
  private tokenProvider: TokenSource | null = null;
  private agentId: string | null = null;
  private agentLoaded = false;
  private readonly deadAgentTones = new Set<string>();
  private readonly aliveAgentTones = new Set<string>();
  private readonly exhaustions = new Map<string, ExhaustionEntry>();

  models(): Record<string, unknown> {
    return modelsResponse();
  }

  private conversation(key: string): Conversation {
    const now = monotonic();
    for (const [existingKey, state] of [...this.conversations]) {
      if (now - state.touched > IDLE_SECONDS) {
        this.conversations.delete(existingKey);
        for (const [responseId, mappedKey] of [...this.responseSessions]) {
          if (mappedKey === existingKey) {
            this.responseSessions.delete(responseId);
          }
        }
      }
    }
    let state = this.conversations.get(key);
    if (state === undefined) {
      if (this.conversations.size >= MAX_CONVERSATIONS) {
        let oldest: Conversation | null = null;
        for (const candidate of this.conversations.values()) {
          if (oldest === null || candidate.touched < oldest.touched) {
            oldest = candidate;
          }
        }
        if (oldest !== null) {
          this.conversations.delete(oldest.key);
          for (const [responseId, mappedKey] of [...this.responseSessions]) {
            if (mappedKey === oldest.key) {
              this.responseSessions.delete(responseId);
            }
          }
        }
      }
      state = new Conversation(key);
      this.conversations.set(key, state);
    }
    state.touched = now;
    return state;
  }

  private async token(): Promise<string> {
    const fixture = nonEmptyEnv("M365_TEST_ACCESS_TOKEN");
    if (fixture !== null) {
      const rawEndpoint = envValue("M365_WS_URL") ?? "";
      let hostname: string | null = null;
      try {
        hostname = new URL(rawEndpoint).hostname.replace(/^\[|\]$/g, "");
      } catch {
        hostname = null;
      }
      if (hostname === null || hostname.length === 0 || !Object.hasOwn(LOOPBACK_HOSTS, hostname)) {
        throw new ApiError(
          500,
          "M365_TEST_ACCESS_TOKEN is only allowed with a loopback M365_WS_URL",
          "invalid_test_configuration",
        );
      }
      return fixture;
    }
    const provider = this.tokenProvider ?? (this.tokenProvider = new FileTokenProvider());
    try {
      // Never interactive here: a chat turn that opened Edge would sit on the
      // provider lock for minutes while the reply spins. A missing sign-in is the
      // one case the co-worker fixes from Settings, so it returns a plain 401.
      return await provider.token(undefined, false);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        process.stderr.write(
          `Microsoft 365 sign-in unavailable: ${error.detail ?? messageOf(error)}\n`,
        );
        throw new ApiError(
          401,
          SIGN_IN_REQUIRED,
          "m365_authentication_failed",
          "authentication_error",
        );
      }
      throw error;
    }
  }

  /**
   * Cache-only token state for the connector's status probe. Never refreshes and
   * never opens a browser — `/healthz` is polled every couple of seconds.
   */
  async health(): Promise<{
    readonly token: {
      readonly valid: boolean;
      readonly refreshable: boolean;
      readonly seconds_remaining: number | null;
      readonly username: string | null;
    };
  }> {
    if (nonEmptyEnv("M365_TEST_ACCESS_TOKEN") !== null) {
      // An injected token has nothing on disk to refresh; it is valid but not refreshable.
      return { token: { valid: true, refreshable: false, seconds_remaining: null, username: null } };
    }
    const provider = this.tokenProvider ?? (this.tokenProvider = new FileTokenProvider());
    const status: TokenStatus = await provider.tokenStatus();
    return {
      token: {
        valid: status.valid,
        refreshable: status.refreshable,
        seconds_remaining: status.secondsRemaining,
        username: status.username,
      },
    };
  }

  private async agentFor(model: string, hasTools: boolean): Promise<string | null> {
    const force = envValue("M365_FORCE_AGENT");
    const tone = toneForModel(model);
    if (force === "0" || (!hasTools && !usesAgent(model, false))) {
      return null;
    }
    if (hasTools && force !== "1" && !usesAgent(model, true)) {
      return null;
    }
    if (this.deadAgentTones.has(tone) && force !== "1") {
      return null;
    }
    if (!this.agentLoaded) {
      this.agentLoaded = true;
      if (nonEmptyEnv("M365_TEST_ACCESS_TOKEN") !== null) {
        this.agentId = envValue("M365_AGENT_ID");
      } else {
        const provider =
          this.tokenProvider ?? (this.tokenProvider = new FileTokenProvider());
        this.agentId = await getOrCreateAgent(provider);
      }
    }
    return this.agentId;
  }

  private budget(model: string): string | null {
    const lowered = model.toLowerCase();
    const routing = routingForModel(model);
    const scenario = routing[0];
    if (scenario !== "OfficeWebPaidCopilot") {
      return null;
    }
    if (
      toneForModel(model) === "Claude_Opus" &&
      !lowered.startsWith("claude-opus-4.5") &&
      !lowered.startsWith("claude-opus-4-5")
    ) {
      return "opus";
    }
    if (lowered.includes("sonnet-5.5") || lowered.includes("sonnet-5-5")) {
      return "sonnet-5.5";
    }
    return null;
  }

  private activeExhaustion(key: string): ExhaustionEntry | null {
    const entry = this.exhaustions.get(key);
    if (entry !== undefined && entry.resetsAt <= Date.now()) {
      this.exhaustions.delete(key);
      return null;
    }
    return entry ?? null;
  }

  private recordExhaustion(key: string, window: string, message: string): ExhaustionEntry {
    const now = new Date();
    const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let resetsAt: number;
    if (window === "week") {
      const weekday = (now.getUTCDay() + 6) % 7;
      const days = (7 - weekday) % 7 || 7;
      resetsAt = midnightUtc + days * 86400000;
    } else {
      resetsAt = midnightUtc + 86400000;
    }
    const entry: ExhaustionEntry = { window, resetsAt, message };
    const previous = this.exhaustions.get(key);
    if (previous === undefined || entry.resetsAt > previous.resetsAt) {
      this.exhaustions.set(key, entry);
      return entry;
    }
    return previous;
  }

  private priorityExhaustion(result: TurnResult, model: string): ExhaustionEntry | null {
    const record = asRecord(result.result);
    let message: string;
    const rawMessage = record === null ? undefined : record.message;
    if (rawMessage !== undefined && rawMessage !== null && rawMessage !== "") {
      message = String(rawMessage);
    } else if (result.text.length > 0) {
      message = result.text;
    } else {
      message = "";
    }
    message = message.trim();
    const match = PRIORITY_ACCESS.exec(message);
    if (match !== null) {
      const window = (match[2] ?? "").toLowerCase().includes("week") ? "week" : "day";
      return this.recordExhaustion(this.budget(model) ?? model, window, message);
    }
    if (record !== null && record.value === "OutOfCredits") {
      const window = OUT_OF_CREDITS_WINDOW.test(message) ? "week" : "day";
      return this.recordExhaustion(
        this.budget(model) ?? model,
        window,
        message.length > 0 ? message : "OutOfCredits",
      );
    }
    return null;
  }

  private rememberMetering(result: TurnResult, model: string): void {
    if (Object.keys(result.metering).length === 0) {
      return;
    }
    const budget = this.budget(model);
    if (budget === null) {
      return;
    }
    const budgets = METERED_BUDGETS[budget];
    if (budgets === undefined) {
      throw new TypeError(`Unknown metered budget: ${budget}`);
    }
    const daily = result.metering[budgets[0]];
    const weekly = result.metering[budgets[1]];
    if (daily !== undefined && daily <= 0 && weekly !== undefined && weekly <= 0) {
      this.recordExhaustion(budget, "week", "Priority access weekly allowance exhausted");
    } else if (daily !== undefined && daily <= 0) {
      this.recordExhaustion(budget, "day", "Priority access daily allowance exhausted");
    } else if (weekly !== undefined && weekly <= 0) {
      this.recordExhaustion(budget, "week", "Priority access weekly allowance exhausted");
    }
  }

  private priorityError(exhaustion: ExhaustionEntry, model: string): ApiError {
    const seconds = Math.max(1, Math.floor((exhaustion.resetsAt - Date.now()) / 1000 + 0.999));
    // Local time, because "resets at midnight UTC" means nothing to the reader.
    const reset = new Date(exhaustion.resetsAt).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    // Microsoft's own wording stays in the log for support; the reply gets the
    // one sentence the co-worker can act on.
    process.stderr.write(`Priority access exhausted for ${model}: ${exhaustion.message}\n`);
    const message = `You have used up your priority access to ${model} until ${reset}. Pick a different model, or send the message again after that time.`;
    return new ApiError(429, message, "priority_access_exhausted", undefined, {
      "Retry-After": String(seconds),
    });
  }

  /**
   * A dropped connection to Microsoft 365. The transport's own text is a socket
   * or fetch message, so it goes to the log and the reply names the next step.
   */
  private transportError(result: TurnResult): ApiError {
    process.stderr.write(`Microsoft 365 transport failed: ${result.error ?? "no detail"}\n`);
    return new ApiError(
      502,
      "pi lost its connection to Microsoft 365. Check your internet connection, then send your message again.",
      "m365_transport_error",
    );
  }

  private framingVariant(model: string): string {
    const configured = nonEmptyEnv("M365_FRAMING_VARIANT");
    const fallback = defaultFraming(model);
    const variant = configured ?? fallback;
    return Object.hasOwn(FRAMING_VARIANTS, variant) ? variant : fallback;
  }

  async chat(
    body: Record<string, unknown>,
    sessionKey: string,
    onDelta?: (value: string) => void,
  ): Promise<ChatResult> {
    const messages = asRecords(body.messages);
    if (messages.length === 0) {
      throw new ApiError(
        400,
        "messages must contain at least one message",
        "invalid_request_error",
      );
    }
    const state = this.conversation(sessionKey);
    return state.guard.run(async () => {
      state.touched = monotonic();
      if (messages.length < state.sentCount) {
        state.reset();
      }
      const requestedModel = "model" in body ? body.model : "m365-copilot";
      if (typeof requestedModel !== "string" || requestedModel.length === 0) {
        throw new ApiError(400, "model must be a non-empty string", "invalid_request_error");
      }
      const tools = asRecords(body.tools);
      const toolChoice = body.tool_choice;
      const hasTools = tools.length > 0 && toolChoice !== "none";
      const shellTool = hasTools ? findShellTool(tools) : null;
      let shellToolName: string | null = null;
      if (shellTool !== null) {
        const fn = asRecord(shellTool.function);
        const name = fn === null ? undefined : fn.name;
        if (typeof name === "string") {
          shellToolName = name;
        }
      }
      let chosenTool: string | null = null;
      if (isRecord(toolChoice)) {
        const fn = asRecord(toolChoice.function);
        const name = fn === null ? undefined : fn.name;
        if (typeof name === "string") {
          chosenTool = name;
        }
      }
      const interceptHostedShell = Boolean(
        shellToolName !== null && (chosenTool === null || chosenTool === shellToolName),
      );
      const requestedBudget = this.budget(requestedModel);
      const exhaustionKey = requestedBudget ?? requestedModel;
      const known = this.activeExhaustion(exhaustionKey);
      const fallbackSetting =
        requestedBudget === "opus" ? "M365_OPUS_FALLBACK_MODEL" : "M365_SONNET_FALLBACK_MODEL";
      let fallback: string | null = null;
      if (known !== null && requestedBudget !== null) {
        fallback = nonEmptyEnv(fallbackSetting);
      }
      if (known !== null && fallback === null) {
        throw this.priorityError(known, requestedModel);
      }
      let model = fallback ?? requestedModel;
      if (state.model !== null && state.model !== model) {
        state.reset();
      }
      let prompt: string;
      if (state.sentCount === 0) {
        prompt = formatMessages(
          messages,
          tools,
          toolChoice,
          state.conversationId,
          this.framingVariant(model),
        );
      } else {
        const deltaMessages = messages.slice(state.sentCount);
        prompt = deltaMessages.length > 0 ? formatDelta(deltaMessages, messages) : "";
        if (prompt.length === 0) {
          prompt = "Please continue.";
        }
      }
      const token = await this.token();
      let agentId = await this.agentFor(model, hasTools);
      const newMessages = state.sentCount === 0 ? messages : messages.slice(state.sentCount);
      let annotations: readonly Record<string, unknown>[] | null = null;
      try {
        const images = await imagesFromMessages(newMessages);
        annotations = await prepareImageAttachments(
          token,
          state.conversationId,
          images,
        );
      } catch (error) {
        if (error instanceof InvalidRequestError) {
          throw new ApiError(400, error.message, "invalid_request_error");
        }
        if (error instanceof UpstreamError) {
          // The upstream text is a raw HTTP body slice; the log keeps it, the
          // reply keeps the next step.
          process.stderr.write(`Microsoft 365 image upload failed: ${error.message}\n`);
          throw new ApiError(
            502,
            "pi could not send the attached image to Microsoft 365. Send the message without the image, or try again in a moment.",
            "m365_image_upload_failed",
          );
        }
        throw error;
      }
      const streamDelta =
        Boolean(body.stream) && !hasTools && requestedBudget === null ? (onDelta ?? null) : null;
      let result = await sendTurn(
        token,
        prompt,
        model,
        state.conversationId,
        state.sessionId,
        agentId,
        state.turnCount === 0,
        streamDelta,
        hasTools,
        interceptHostedShell,
        annotations,
      );
      const tone = toneForModel(model);
      if (
        agentId !== null &&
        asRecord(result.result)?.value === "InternalError" &&
        result.text.length === 0 &&
        (tone === "Gpt_6_Sol_Reasoning" || tone === "Gpt_61_Sol_Reasoning") &&
        !this.aliveAgentTones.has(tone) &&
        envValue("M365_FORCE_AGENT") !== "1"
      ) {
        this.deadAgentTones.add(tone);
        state.reset();
        prompt = formatMessages(
          messages,
          tools,
          toolChoice,
          state.conversationId,
          this.framingVariant(model),
        );
        result = await sendTurn(
          token,
          prompt,
          model,
          state.conversationId,
          state.sessionId,
          null,
          true,
          streamDelta,
          hasTools,
          interceptHostedShell,
          annotations,
        );
      }
      if (result.errorCode === "M365TransportError") {
        throw this.transportError(result);
      }
      this.rememberMetering(result, model);
      const exhausted = this.priorityExhaustion(result, model);
      if (exhausted !== null) {
        const fallbackModel = requestedBudget !== null ? nonEmptyEnv(fallbackSetting) : null;
        if (fallbackModel !== null && model === requestedModel) {
          state.reset();
          model = fallbackModel;
          agentId = await this.agentFor(model, hasTools);
          prompt = formatMessages(
            messages,
            tools,
            toolChoice,
            state.conversationId,
            this.framingVariant(model),
          );
          result = await sendTurn(
            token,
            prompt,
            model,
            state.conversationId,
            state.sessionId,
            agentId,
            true,
            streamDelta,
            hasTools,
            interceptHostedShell,
            annotations,
          );
          if (result.errorCode === "M365TransportError") {
            throw this.transportError(result);
          }
          this.rememberMetering(result, model);
          const fallbackExhaustion = this.priorityExhaustion(result, model);
          if (fallbackExhaustion !== null) {
            throw this.priorityError(fallbackExhaustion, model);
          }
        } else {
          throw this.priorityError(exhausted, requestedModel);
        }
      }
      if (
        asRecord(result.result)?.value === "Throttled" ||
        result.errorCode === "PerUserThrottled"
      ) {
        if (result.error !== null && result.error.length > 0) {
          process.stderr.write(`Microsoft 365 throttled this conversation: ${result.error}\n`);
        }
        throw new ApiError(
          429,
          "Microsoft 365 is limiting how fast pi can send messages right now. Wait about a minute, then send your message again.",
          "m365_throttled",
          undefined,
          { "Retry-After": "60" },
        );
      }
      if (result.messageType === "Disengaged") {
        state.reset();
        let variant = this.framingVariant(model);
        if (variant === "baseline") {
          variant = "relay";
        }
        prompt = formatMessages(
          messages,
          tools,
          toolChoice,
          state.conversationId,
          variant,
        );
        result = await sendTurn(
          token,
          prompt,
          model,
          state.conversationId,
          state.sessionId,
          agentId,
          true,
          streamDelta,
          hasTools,
          interceptHostedShell,
          null,
        );
        if (result.messageType === "Disengaged") {
          throw new ApiError(
            502,
            "Microsoft 365 stopped answering this conversation. Send your message again to start a fresh one.",
            "m365_disengaged",
          );
        }
      }
      if (result.error !== null && result.error.length > 0) {
        // Microsoft's wording (often an internal error name) is for the log only.
        process.stderr.write(`Microsoft 365 turn failed: ${result.error}\n`);
        throw new ApiError(
          502,
          "Microsoft 365 returned an error instead of a reply. Send your message again.",
          result.errorCode ?? "m365_error",
        );
      }
      if (result.text.length === 0) {
        throw new ApiError(
          502,
          "Microsoft 365 sent an empty reply. Send your message again.",
          "m365_empty_turn",
        );
      }
      let toolCalls: readonly Record<string, unknown>[] = [];
      let text: string;
      if (tools.length > 0 && toolChoice !== "none") {
        const parsed = parseToolCalls(result.text, tools);
        toolCalls = parsed.toolCalls;
        text = parsed.text;
      } else {
        text = result.text.trim();
      }
      state.sentCount = messages.length;
      state.turnCount += 1;
      state.model = model;
      state.touched = monotonic();
      if (agentId !== null && result.text.length > 0) {
        this.aliveAgentTones.add(toneForModel(model));
      }
      return new ChatResult(
        `chatcmpl-${newId()}`,
        unixSeconds(),
        model,
        text,
        toolCalls,
        toolCalls.length > 0 ? "tool_calls" : "stop",
        state,
      );
    });
  }

  async responses(
    body: Record<string, unknown>,
    sessionKey: string | null,
  ): Promise<Record<string, unknown>> {
    const inputMessages = responseInput("input" in body ? body.input : "");
    if (inputMessages.length === 0) {
      throw new ApiError(400, "input must contain at least one message", "invalid_request_error");
    }
    const previousRaw = body.previous_response_id;
    const previousTruthy =
      previousRaw !== undefined &&
      previousRaw !== null &&
      previousRaw !== "" &&
      previousRaw !== 0 &&
      previousRaw !== false;
    const previous = typeof previousRaw === "string" && previousRaw.length > 0 ? previousRaw : null;
    const previousKey = previous === null ? undefined : this.responseSessions.get(previous);
    if (previousTruthy && previousKey === undefined) {
      throw new ApiError(
        404,
        "previous_response_id is unknown or expired",
        "previous_response_not_found",
      );
    }
    const conversationKey = previousKey ?? sessionKey ?? `responses:${newId()}`;
    const state = this.conversation(conversationKey);
    const existing = [...state.responseHistory];
    let messages: Record<string, unknown>[];
    if (previous !== null) {
      messages = [...existing, ...inputMessages];
    } else if (sessionKey !== null && existing.length > 0) {
      messages = jsonEquals(inputMessages.slice(0, existing.length), existing)
        ? [...inputMessages]
        : [...existing, ...inputMessages];
    } else {
      messages = [...inputMessages];
    }
    const instructions = body.instructions;
    if (
      typeof instructions === "string" &&
      instructions.length > 0 &&
      existing.length === 0 &&
      previous === null
    ) {
      messages.splice(0, 0, { role: "system", content: instructions });
    }
    const chatBody: Record<string, unknown> = {
      model: "model" in body ? body.model : "m365-copilot",
      messages,
      tools: responseTools(body.tools),
      tool_choice: responseToolChoice(body.tool_choice),
      stream: body.stream === true,
    };
    const completed = await this.chat(validateChat(chatBody), conversationKey);
    const assistant: Record<string, unknown> = {
      role: "assistant",
      content: completed.text.length > 0 ? completed.text : null,
    };
    if (completed.toolCalls.length > 0) {
      assistant.tool_calls = [...completed.toolCalls];
    }
    state.responseHistory = [...messages, assistant];
    state.touched = monotonic();
    const responseId = `resp_${newId()}`;
    const response = responseObject(responseId, completed);
    this.responseSessions.set(responseId, conversationKey);
    return response;
  }
}

// ---------------------------------------------------------------------------
// Request validation / translation helpers (Python's module-level _* functions)
// ---------------------------------------------------------------------------

export function validateChat(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new ApiError(400, "request body must be a JSON object", "invalid_request_error");
  }
  const model = "model" in body ? body.model : "m365-copilot";
  if (typeof model !== "string" || model.length === 0) {
    throw new ApiError(400, "model must be a non-empty string", "invalid_request_error");
  }
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    throw new ApiError(400, "messages must be an array", "invalid_request_error");
  }
  messages.forEach((message, index) => {
    if (
      !isRecord(message) ||
      typeof message.role !== "string" ||
      !Object.hasOwn(CHAT_ROLES, message.role)
    ) {
      throw new ApiError(400, `messages[${index}] has an invalid role`, "invalid_request_error");
    }
    try {
      contentText(message);
    } catch (error) {
      if (error instanceof InvalidRequestError || error instanceof UpstreamError) {
        throw new ApiError(400, `messages[${index}]: ${error.message}`, "invalid_request_error");
      }
      throw error;
    }
    if (message.tool_calls != null && !Array.isArray(message.tool_calls)) {
      throw new ApiError(
        400,
        `messages[${index}].tool_calls must be an array`,
        "invalid_request_error",
      );
    }
  });
  const toolsValue = "tools" in body ? body.tools : [];
  if (!Array.isArray(toolsValue) || toolsValue.length > 128) {
    throw new ApiError(
      400,
      "tools must be an array with at most 128 entries",
      "invalid_request_error",
    );
  }
  for (const tool of toolsValue) {
    if (!isRecord(tool)) {
      // Python: _function(tool) raises AttributeError, which is not one of the
      // caught validation errors and therefore surfaces as a 500.
      throw new TypeError("tool must be an object");
    }
    try {
      toolSpec(tool);
    } catch (error) {
      if (isValidationError(error)) {
        throw new ApiError(
          400,
          `invalid tool definition: ${error.message}`,
          "invalid_request_error",
        );
      }
      throw error;
    }
  }
  const toolChoice = "tool_choice" in body ? body.tool_choice : undefined;
  if (
    toolChoice !== undefined &&
    toolChoice !== null &&
    typeof toolChoice !== "string" &&
    !isRecord(toolChoice)
  ) {
    throw new ApiError(400, "tool_choice is invalid", "invalid_request_error");
  }
  if (typeof toolChoice === "string" && !Object.hasOwn(TOOL_CHOICE_KEYWORDS, toolChoice)) {
    throw new ApiError(400, "tool_choice is invalid", "invalid_request_error");
  }
  if (isRecord(toolChoice)) {
    if (toolChoice.type !== "function") {
      throw new ApiError(400, "tool_choice function selector is invalid", "invalid_request_error");
    }
    const fn = asRecord(toolChoice.function);
    const name = fn === null ? undefined : fn.name;
    if (typeof name !== "string") {
      throw new ApiError(400, "tool_choice function selector is invalid", "invalid_request_error");
    }
  }
  if ("stream" in body && typeof body.stream !== "boolean") {
    throw new ApiError(400, "stream must be a boolean", "invalid_request_error");
  }
  body.model = model;
  body.messages = messages;
  body.tools = toolsValue;
  return body;
}

export function responseInput(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") {
    return value.length > 0 ? [{ role: "user", content: value }] : [];
  }
  if (!Array.isArray(value)) {
    throw new ApiError(400, "input must be a string or array", "invalid_request_error");
  }
  const messages: Record<string, unknown>[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new ApiError(400, `input[${index}] must be an object`, "invalid_request_error");
    }
    const kind = "type" in item ? item.type : "message";
    if (kind === "function_call") {
      const name = item.name;
      const callId = item.call_id ?? item.id;
      if (typeof name !== "string" || typeof callId !== "string") {
        throw new ApiError(
          400,
          `input[${index}] function_call requires name and call_id`,
          "invalid_request_error",
        );
      }
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: { name, arguments: "arguments" in item ? item.arguments : "{}" },
          },
        ],
      });
    } else if (kind === "function_call_output") {
      const callId = item.call_id;
      if (typeof callId !== "string") {
        throw new ApiError(
          400,
          `input[${index}] function_call_output requires call_id`,
          "invalid_request_error",
        );
      }
      let output: unknown = "output" in item ? item.output : "";
      if (typeof output !== "string") {
        output = JSON.stringify(output);
      }
      messages.push({ role: "tool", tool_call_id: callId, content: output });
    } else if (
      kind === "message" ||
      kind === "input_text" ||
      kind === "output_text" ||
      Boolean(item.role)
    ) {
      const role = "role" in item ? item.role : "user";
      if (typeof role !== "string" || !Object.hasOwn(RESPONSE_ROLES, role)) {
        throw new ApiError(400, `input[${index}] has an invalid role`, "invalid_request_error");
      }
      let content: unknown = "content" in item ? item.content : "";
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const part of content) {
          if (
            !isRecord(part) ||
            typeof part.type !== "string" ||
            !Object.hasOwn(CONTENT_PART_TYPES, part.type)
          ) {
            throw new ApiError(
              400,
              `input[${index}] contains unsupported content`,
              "invalid_request_error",
            );
          }
          parts.push(typeof part.text === "string" ? part.text : "");
        }
        content = parts.join("");
      }
      if (typeof content !== "string") {
        throw new ApiError(400, `input[${index}].content must be text`, "invalid_request_error");
      }
      messages.push({ role, content });
    } else {
      throw new ApiError(
        400,
        `input[${index}] has unsupported type '${String(kind)}'`,
        "invalid_request_error",
      );
    }
  });
  return messages;
}

export function responseTools(tools: unknown): Record<string, unknown>[] {
  if (tools === undefined || tools === null) {
    return [];
  }
  if (!Array.isArray(tools) || tools.length > 128) {
    throw new ApiError(
      400,
      "tools must be an array with at most 128 entries",
      "invalid_request_error",
    );
  }
  const result: Record<string, unknown>[] = [];
  tools.forEach((tool, index) => {
    if (!isRecord(tool) || tool.type !== "function") {
      throw new ApiError(400, `tools[${index}] must be a function tool`, "invalid_request_error");
    }
    if (isRecord(tool.function)) {
      result.push(tool);
      return;
    }
    const functionObject: Record<string, unknown> = {};
    for (const key of ["name", "description", "parameters"]) {
      if (key in tool) {
        functionObject[key] = tool[key];
      }
    }
    result.push({ type: "function", function: functionObject });
  });
  return result;
}

export function responseToolChoice(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string" && Object.hasOwn(TOOL_CHOICE_KEYWORDS, value)) {
    return value;
  }
  if (isRecord(value)) {
    if (value.type === "function" && typeof value.name === "string") {
      return { type: "function", function: { name: value.name } };
    }
    if (value.type === "function" && isRecord(value.function)) {
      return value;
    }
  }
  throw new ApiError(400, "tool_choice is invalid", "invalid_request_error");
}

export function responseObject(responseId: string, completed: ChatResult): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  if (completed.text.length > 0) {
    output.push({
      id: `msg_${newId()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: completed.text, annotations: [] }],
    });
  }
  for (const call of completed.toolCalls) {
    const fn = asRecord(call.function);
    output.push({
      id: `fc_${newId()}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: fn?.name,
      arguments: fn?.arguments,
    });
  }
  const text = completed.toolCalls.length === 0 ? completed.text : null;
  return {
    id: responseId,
    object: "response",
    created_at: completed.created,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: completed.model,
    output,
    output_text: text,
    usage: null,
  };
}

export function responsesSse(
  response: Record<string, unknown>,
): Array<[string, Record<string, unknown>]> {
  const events: Array<[string, Record<string, unknown>]> = [];
  const inProgress: Record<string, unknown> = { ...response, status: "in_progress", output: [] };
  events.push(["response.created", { type: "response.created", response: inProgress }]);
  events.push(["response.in_progress", { type: "response.in_progress", response: inProgress }]);
  const output = Array.isArray(response.output) ? response.output : [];
  output.forEach((rawItem, index) => {
    if (!isRecord(rawItem)) {
      return;
    }
    const item = rawItem;
    events.push([
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: index,
        item: { ...item, status: "in_progress" },
      },
    ]);
    if (item.type === "message") {
      const part = { type: "output_text", text: "", annotations: [] };
      const content = Array.isArray(item.content) ? item.content : [];
      const first = content.length > 0 ? asRecord(content[0]) : null;
      events.push([
        "response.content_part.added",
        {
          type: "response.content_part.added",
          item_id: item.id,
          output_index: index,
          content_index: 0,
          part,
        },
      ]);
      const text = typeof first?.text === "string" ? first.text : "";
      for (const delta of chunkText(text)) {
        events.push([
          "response.output_text.delta",
          {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: index,
            content_index: 0,
            delta,
          },
        ]);
      }
      events.push([
        "response.output_text.done",
        {
          type: "response.output_text.done",
          item_id: item.id,
          output_index: index,
          content_index: 0,
          text,
        },
      ]);
      events.push([
        "response.content_part.done",
        {
          type: "response.content_part.done",
          item_id: item.id,
          output_index: index,
          content_index: 0,
          part: first ?? part,
        },
      ]);
    } else {
      const args = typeof item.arguments === "string" ? item.arguments : "";
      for (const delta of chunkText(args)) {
        events.push([
          "response.function_call_arguments.delta",
          {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: index,
            delta,
          },
        ]);
      }
      events.push([
        "response.function_call_arguments.done",
        {
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: index,
          arguments: args,
        },
      ]);
    }
    events.push([
      "response.output_item.done",
      { type: "response.output_item.done", output_index: index, item },
    ]);
  });
  events.push(["response.completed", { type: "response.completed", response }]);
  return events;
}

// ---------------------------------------------------------------------------
// Chat Streamer (SSE)
// ---------------------------------------------------------------------------

export class ChatStreamer {
  model: string;
  private buffer = "";
  private sentText = "";
  private started = false;
  private closed = false;

  constructor(
    private readonly res: ServerResponse,
    model: string,
    private readonly completionId: string,
    private readonly created: number,
  ) {
    this.model = model;
    res.on("error", () => {
      this.closed = true;
    });
    res.on("close", () => {
      this.closed = true;
    });
  }

  private send(value: unknown): void {
    if (this.closed) {
      return;
    }
    if (!safeWrite(this.res, `data: ${JSON.stringify(value)}\n\n`)) {
      this.closed = true;
    }
  }

  private start(): void {
    if (this.started) {
      return;
    }
    this.res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "close",
      "X-Accel-Buffering": "no",
    });
    this.started = true;
    this.send({
      id: this.completionId,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  }

  delta(value: string): void {
    if (this.closed) {
      return;
    }
    this.buffer += value;
    if (!this.started) {
      const normalized = this.buffer
        .replaceAll("\u2018", "'")
        .replaceAll("\u2019", "'")
        .trimStart()
        .toLowerCase();
      if (
        PRIORITY_GATES.some((gate) => gate.startsWith(normalized) || normalized.startsWith(gate))
      ) {
        return;
      }
      this.start();
    }
    this.emit(this.buffer);
    this.buffer = "";
  }

  private emit(text: string): void {
    for (const chunk of chunkText(text)) {
      this.send({
        id: this.completionId,
        object: "chat.completion.chunk",
        created: this.created,
        model: this.model,
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      });
      this.sentText += chunk;
    }
  }

  complete(result: ChatResult): void {
    if (!this.started) {
      this.start();
    }
    if (result.text.startsWith(this.sentText)) {
      this.emit(result.text.slice(this.sentText.length));
    }
    result.toolCalls.forEach((call, index) => {
      this.send({
        id: this.completionId,
        object: "chat.completion.chunk",
        created: this.created,
        model: result.model,
        choices: [{ index: 0, delta: { tool_calls: [{ index, ...call }] }, finish_reason: null }],
      });
    });
    this.send({
      id: this.completionId,
      object: "chat.completion.chunk",
      created: this.created,
      model: result.model,
      choices: [{ index: 0, delta: {}, finish_reason: result.finishReason }],
    });
    if (!this.closed) {
      if (safeWrite(this.res, "data: [DONE]\n\n")) {
        this.res.end();
      } else {
        this.closed = true;
      }
    }
  }

  fail(error: ApiError): boolean {
    if (!this.started) {
      return false;
    }
    this.send(error.body());
    if (!this.closed) {
      if (safeWrite(this.res, "data: [DONE]\n\n")) {
        this.res.end();
      } else {
        this.closed = true;
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function routePath(rawUrl: string): string {
  try {
    return new URL(rawUrl, "http://127.0.0.1").pathname.replace(/\/+$/, "");
  } catch {
    return rawUrl.replace(/\/+$/, "");
  }
}

function contentLengthHeader(raw: string | string[] | undefined): number {
  if (raw === undefined) {
    return -1;
  }
  const value = Array.isArray(raw) ? (raw[0] ?? "") : raw;
  if (!/^\s*[+-]?\d+\s*$/.test(value)) {
    // Python's int() raises ValueError here, which the outer handler turns
    // into a 500 "Internal proxy error".
    throw new TypeError("Invalid Content-Length");
  }
  return Number.parseInt(value, 10);
}

function readFixed(req: IncomingMessage, length: number): Promise<Buffer> {
  if (length === 0) {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("close", onEnd);
      req.off("error", onError);
    };
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).subarray(0, length));
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    function onData(chunk: Buffer): void {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= length) {
        finish();
      }
    }
    function onEnd(): void {
      finish();
    }
    function onError(error: Error): void {
      fail(error);
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("close", onEnd);
    req.on("error", onError);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const length = contentLengthHeader(req.headers["content-length"]);
  if (length < 0) {
    throw new ApiError(411, "Content-Length is required", "length_required");
  }
  if (length > MAX_BODY) {
    throw new ApiError(413, "Request body exceeds 2 MiB", "request_too_large");
  }
  const raw = await readFixed(req, length);
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "Request body is not valid JSON", "invalid_json");
  }
}

function readSessionHeader(req: IncomingMessage): string | null {
  const raw = req.headers["x-m365-conversation-id"];
  if (raw === undefined) {
    return null;
  }
  const value = Array.isArray(raw) ? raw.join(", ") : raw;
  if (value.length === 0 || value.length > 128 || !SESSION_ID_PATTERN.test(value)) {
    throw new ApiError(
      400,
      "X-M365-Conversation-ID must be 1-128 ASCII letters, digits, '.', '_', ':', or '-'",
      "invalid_conversation_id",
    );
  }
  return value;
}

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers?: Record<string, string>,
): void {
  if (res.headersSent || res.writableEnded) {
    return;
  }
  const data = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(data.length),
    Connection: "close",
    ...(headers ?? {}),
  });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent || res.writableEnded) {
    return;
  }
  const data = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": "text/html;charset=utf-8",
    "Content-Length": String(data.length),
    Connection: "close",
  });
  res.end(data);
}

function logRequest(req: IncomingMessage, res: ServerResponse): void {
  res.on("close", () => {
    const stamp = new Date().toISOString();
    const client = req.socket.remoteAddress ?? "-";
    process.stderr.write(
      `${stamp} ${client} ${req.method ?? "-"} ${req.url ?? "-"} ${res.statusCode}\n`,
    );
  });
}

async function handleChat(
  app: ProxyApplication,
  body: unknown,
  sessionHeader: string | null,
  res: ServerResponse,
): Promise<void> {
  const validated = validateChat(body);
  const key = sessionHeader ?? `request:${newId()}`;
  const stream = validated.stream === true;
  const model = typeof validated.model === "string" ? validated.model : "m365-copilot";
  const streamer = stream
    ? new ChatStreamer(res, model, `chatcmpl-${newId()}`, unixSeconds())
    : null;
  try {
    const result = await app.chat(
      validated,
      key,
      streamer === null ? undefined : (value) => streamer.delta(value),
    );
    if (streamer !== null) {
      streamer.model = result.model;
      streamer.complete(result);
    } else {
      sendJson(res, 200, result.body());
    }
  } catch (error) {
    if (error instanceof ApiError) {
      if (streamer !== null && streamer.fail(error)) {
        return;
      }
      sendJson(res, error.status, error.body(), error.headers);
      return;
    }
    throw error;
  }
}

async function handleResponses(
  app: ProxyApplication,
  body: unknown,
  sessionHeader: string | null,
  res: ServerResponse,
): Promise<void> {
  const record = asRecord(body);
  if (record === null) {
    throw new ApiError(400, "request body must be a JSON object", "invalid_request_error");
  }
  const streamValue = "stream" in record ? record.stream : false;
  if (typeof streamValue !== "boolean") {
    throw new ApiError(400, "stream must be a boolean", "invalid_request_error");
  }
  const response = await app.responses(record, sessionHeader);
  if (streamValue) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "close",
    });
    for (const [event, data] of responsesSse(response)) {
      if (!safeWrite(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
        return;
      }
    }
    if (safeWrite(res, "data: [DONE]\n\n")) {
      res.end();
    }
  } else {
    sendJson(res, 200, response);
  }
}

async function handleRequest(
  app: ProxyApplication,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.on("error", () => {
    // The client went away mid-response; nothing to report.
  });
  logRequest(req, res);
  const method = req.method ?? "GET";
  const path = routePath(req.url ?? "/");
  try {
    if (method === "GET") {
      if (path === "/v1/models") {
        sendJson(res, 200, app.models());
      } else if (path === "/healthz") {
        sendJson(res, 200, await app.health());
      } else {
        sendJson(res, 404, NOT_FOUND_BODY);
      }
      return;
    }
    if (method !== "POST") {
      sendText(res, 501, `Unsupported method ('${method}')`);
      return;
    }
    if (path !== "/v1/chat/completions" && path !== "/v1/responses") {
      sendJson(res, 404, NOT_FOUND_BODY);
      return;
    }
    const body = await readJsonBody(req);
    const sessionHeader = readSessionHeader(req);
    if (path === "/v1/chat/completions") {
      await handleChat(app, body, sessionHeader, res);
    } else {
      await handleResponses(app, body, sessionHeader, res);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(res, error.status, error.body(), error.headers);
      return;
    }
    process.stderr.write(`Unhandled proxy error: ${messageOf(error)}\n`);
    sendJson(res, 500, new ApiError(500, "Internal proxy error", "internal_error").body());
  }
}

export function createHttpServer(app: ProxyApplication): Server {
  const server = createServer((req, res) => {
    void handleRequest(app, req, res);
  });
  return server;
}
