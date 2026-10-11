/**
 * The Microsoft 365 Copilot backend, ported from the vendored Python
 * `m365copilotproxy` package so the app ships no CPython.
 *
 * This barrel exports the public surface only. Helpers that were module-private in
 * Python (leading underscore) are module-private here too and are not re-exported.
 *
 * The barrel is hand-curated: adding a symbol here is a public API decision, so it
 * needs a consumer that wants it. Do not regenerate it from module exports.
 */

// Shared contract + error types every module narrows through.
export type {
  ChatMessage,
  ChatRole,
  ChatTool,
  ContentPart,
  TokenProvider,
  TurnResult,
} from "./types.js";
export { InvalidRequestError, UpstreamError } from "./types.js";

// Runtime type guards used across the port.
export { asRecord, isRecord } from "./guards.js";

// Model catalogue: alias -> tone, paid/included routing, metered budgets.
export {
  INCLUDED_SCENARIO_MODELS,
  METERED_BUDGETS,
  MODEL_TONES,
  PAID_SCENARIO_MODELS,
  PAID_SCENARIO_TONES,
  defaultFraming,
  modelsResponse,
  routingForModel,
  toneForModel,
  usesAgent,
} from "./catalog.js";

// Fenced tool-call engine: shell detection, prompt framing, call parsing.
export type { ParsedToolCalls, ToolSpec } from "./tooling.js";
export {
  contentText,
  findShellTool,
  formatDelta,
  formatMessages,
  formatToolDefinitions,
  parseToolCalls,
  toolSpec,
} from "./tooling.js";

// Image attachments: decode, upload, annotation payloads.
export type { ImageInput } from "./images.js";
export {
  DEFAULT_UPLOAD_URL,
  SUPPORTED_MEDIA_TYPES,
  imageFromUrl,
  imagesFromMessages,
  prepareImageAttachments,
} from "./images.js";

// Dataverse agent bootstrap for tool calling. The HTTP helpers (`request`,
// `HttpResponse`) and the request-body builder stay private, as they were in Python.
export type { ScopedTokenProvider } from "./agent.js";
export {
  AGENT_NAME,
  API_VERSION,
  BAP_API,
  BOT_DESCRIPTION,
  BOT_NAME,
  ICON,
  INSTRUCTIONS,
  INSTRUCTIONS_HASH,
  environmentUrl,
  getOrCreateAgent,
} from "./agent.js";

// SignalR chat turn: WebSocket protocol, token claims, framing.
export {
  ALLOWED_MESSAGE_TYPES,
  CODE_INTERPRETER_OPTIONS,
  IMAGE_CHAT_OPTIONS_SETS,
  RS,
  STOP_FRAME,
  UPLOAD_OPTIONS_SETS,
  VARIANTS,
  WS_ENDPOINT,
  sendTurn,
  tokenClaims,
} from "./m365.js";

// Sign-in: OAuth 2.0 + PKCE, CDP browser capture, token cache. The CDP, PKCE and
// token-request helpers stay private, as their Python counterparts were.
export type { AuthorizationResponse } from "./auth.js";
export {
  AuthenticationError,
  AUTHORITY,
  AUTHORIZE_ENDPOINT,
  BAP_SCOPES,
  CHAT_SCOPES,
  CLIENT_ID,
  FileTokenProvider,
  POWERPLATFORM_SCOPES,
  REDIRECT_URI,
  TOKEN_ENDPOINT,
  login,
} from "./auth.js";

// OpenAI-compatible HTTP surface: the application object, the request validators
// and the SSE helpers a host may need to embed rather than serve over HTTP.
export type {
  ChatResult,
  ChatStreamer,
  Conversation,
  ExhaustionEntry,
  ProxyApplication,
  ProxyApplicationDeps,
} from "./server.js";
export {
  APPLICATION,
  ApiError,
  MAX_BODY,
  createHttpServer,
  responsesSse,
  validateChat,
} from "./server.js";
