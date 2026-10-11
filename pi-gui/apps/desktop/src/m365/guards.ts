/**
 * Canonical runtime type guards for the m365 copilot proxy port.
 *
 * Network, JSON, and env payloads arrive as `unknown`; every module narrows
 * them through these two guards instead of redefining local copies.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `isRecord` with a nullable result, for optional-property access chains. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** The readable text of a thrown value, for logs and error messages. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
