import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { generativeUiSystemPrompt } from "../../contracts/generative-ui";

/**
 * Small built-in pi extensions aimed at non-technical coworkers and small-context
 * models such as Microsoft 365 Copilot. Each one is a pi-gui built-in, so people
 * can switch it off in Settings → Skills and extensions.
 */

/** Teaches the model the ```openui-lang card language the transcript renders. */
export function createGenerativeUiExtension(): ExtensionFactory {
  const section = generativeUiSystemPrompt();
  return (pi) => {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${section}`,
    }));
  };
}

/** Tools that only read; everything else changes files or runs commands. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/**
 * Codex's "suggest" approval mode (as in open-codex): pi asks before every tool that can
 * change something, and the change is skipped if the person says no. Without a UI (for
 * example a scheduled background run) calls are allowed so unattended work is not stuck.
 */
export function createAskBeforeChangesExtension(
  isActive: () => boolean = () => true,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      if (
        !isActive() ||
        READ_ONLY_TOOLS.has(event.toolName) ||
        event.parentToolCallId ||
        !ctx.hasUI
      ) {
        return undefined;
      }
      const allowed = await ctx.ui.confirm(
        approvalTitle(event.toolName),
        describeToolCall(event.toolName, event.input),
      );
      return allowed
        ? undefined
        : { block: true, reason: "The user declined this change. Ask how they want to proceed." };
    });
  };
}

function approvalTitle(toolName: string): string {
  switch (toolName) {
    case "write":
      return "Allow pi to create or overwrite a file?";
    case "edit":
      return "Allow pi to edit a file?";
    case "bash":
    case "powershell":
      return "Allow pi to run a command?";
    default:
      return `Allow pi to use “${toolName}”?`;
  }
}

export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  const path = typeof input.path === "string" ? input.path : undefined;
  const command = typeof input.command === "string" ? input.command : undefined;
  if (command) {
    return truncate(command, 600);
  }
  if (path) {
    return `File: ${path}`;
  }
  return truncate(JSON.stringify(input), 600);
}

/** Tool results older than this many tool results are trimmed before each model call. */
export const KEEP_RECENT_TOOL_RESULTS = 6;
/** Older tool results longer than this are cut down to a head and tail. */
export const PRUNE_THRESHOLD_CHARS = 1_500;
const PRUNE_KEEP_CHARS = 400;

/**
 * open-codex's content pruning: the model gets short versions of old, large tool results
 * (file reads, command output). The session file keeps the full text; only the request
 * sent to the model shrinks, which keeps small-context models such as M365 Copilot usable
 * over longer threads.
 */
export function createContextTrimExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event) => {
      const pruned = pruneOldToolResults(event.messages);
      return pruned === event.messages ? undefined : { messages: pruned };
    });
  };
}

interface PrunableMessage {
  readonly role?: unknown;
  readonly content?: unknown;
}

export function pruneOldToolResults<T extends PrunableMessage>(messages: readonly T[]): T[] {
  let seen = 0;
  let changed = false;
  const result = messages.slice();
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index];
    if (message?.role !== "toolResult" || !Array.isArray(message.content)) {
      continue;
    }
    seen += 1;
    if (seen <= KEEP_RECENT_TOOL_RESULTS) {
      continue;
    }
    let messageChanged = false;
    const content = message.content.map((part: unknown) => {
      if (!isTextPart(part) || part.text.length <= PRUNE_THRESHOLD_CHARS) {
        return part;
      }
      messageChanged = true;
      const omitted = part.text.length - PRUNE_KEEP_CHARS * 2;
      return {
        ...part,
        text: `${part.text.slice(0, PRUNE_KEEP_CHARS)}\n… [${omitted} characters of older output trimmed to save context] …\n${part.text.slice(-PRUNE_KEEP_CHARS)}`,
      };
    });
    if (messageChanged) {
      changed = true;
      result[index] = { ...message, content };
    }
  }
  return changed ? result : (messages as T[]);
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return (
    !!part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
