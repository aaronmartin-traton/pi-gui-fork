import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { OrchestrationRuntimeBridge } from "../orchestration/orchestration-runtime";

/**
 * `/handoff` — carry the current thread into a fresh child thread so a long or
 * stuck conversation can continue with a clean context. It reuses pi-gui's
 * thread orchestration, so the new thread shows up in the sidebar like any other.
 */

const MAX_TRANSCRIPT_CHARS = 12_000;

export interface HandoffMessage {
  readonly role: string;
  readonly text: string;
}

/** Pure: turn the session transcript into a self-contained handoff prompt. */
export function formatHandoffPrompt(messages: readonly HandoffMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const text = message.text.trim();
    if (!text) continue;
    lines.push(`${labelForRole(message.role)}: ${text}`);
  }
  let body = lines.join("\n\n");
  if (body.length > MAX_TRANSCRIPT_CHARS) {
    body = `…[earlier messages trimmed]…\n\n${body.slice(-MAX_TRANSCRIPT_CHARS)}`;
  }
  return (
    "You are taking over an in-progress session. Continue the work; do not restart it. " +
    `Here is the transcript so far:\n\n${body}\n\n` +
    "Pick up from where this left off and confirm your understanding before making changes."
  );
}

function labelForRole(role: string): string {
  if (role === "assistant") return "Assistant";
  if (role === "user") return "User";
  return role;
}

/** Extract plain text from pi's message transcript, dropping tool/attachment noise. */
export function handoffMessagesFromTranscript(messages: readonly unknown[]): HandoffMessage[] {
  const out: HandoffMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (!("role" in message) || typeof message.role !== "string") continue;
    const text = "content" in message ? contentToText(message.content) : "";
    if (text) out.push({ role: message.role, text });
  }
  return out;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(textOfPart).filter(Boolean).join("\n");
}

function textOfPart(part: unknown): string {
  if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
    return part.text;
  }
  return "";
}

export function createHandoffExtension(bridge: OrchestrationRuntimeBridge): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    let transcript: HandoffMessage[] = [];
    pi.on("context", (event) => {
      transcript = handoffMessagesFromTranscript(event.messages);
    });
    pi.registerCommand("handoff", {
      description: "Continue this thread in a new child thread, carrying the transcript",
      handler: async (_args, ctx) => {
        await bridge.createChildThread(ctx, {
          prompt: formatHandoffPrompt(transcript),
          toolCallId: `handoff-${Date.now()}`,
        });
      },
    });
  };
}
