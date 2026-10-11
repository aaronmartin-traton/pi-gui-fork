export interface TurnResult {
  text: string;
  result: Record<string, unknown> | null;
  metering: Record<string, number>;
  messageType: string | null;
  error: string | null;
  errorCode: string | null;
  turnCount: number | null;
  rawItem: Record<string, unknown> | null;
}
export interface TokenProvider {
  token(): Promise<string>;
  readonly oid: string;
  readonly tid: string;
}
export type ChatRole = "system" | "user" | "assistant" | "tool";
export interface ContentPart { readonly type: string; readonly [k: string]: unknown }
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string | readonly ContentPart[];
  readonly tool_call_id?: string;
  readonly name?: string;
}
export interface ChatTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
  };
}
export class InvalidRequestError extends Error {}
export class UpstreamError extends Error {}
