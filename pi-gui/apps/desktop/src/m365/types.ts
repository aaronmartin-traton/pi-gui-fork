export interface TurnResult {
  text: string;
  result: Record<string, unknown> | null;
  metering: Record<string, number>;
  messageType: string | null;
  error: string | null;
  errorCode: string | null;
  rawItem: Record<string, unknown> | null;
}
export class InvalidRequestError extends Error {}
export class UpstreamError extends Error {}
