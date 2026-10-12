// YOLO on must not disarm the destructive guard. Only the separate opt-out may.
import { expect, test } from "@playwright/test";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  createAskBeforeChangesExtension,
  createDestructiveCommandGuardExtension,
} from "../../electron/assistant/coworker-extensions";

/** The slice of a `tool_call` the two factories read. */
interface ToolCallEvent {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly parentToolCallId?: string;
}

/** The slice of a tool-call context the factories read. */
interface ToolCallContext {
  readonly hasUI: boolean;
  readonly ui: { confirm: (title: string, body: string) => Promise<boolean> };
}

/** What a factory decided to do with one tool call. */
type Decision = { block: boolean; reason?: string } | undefined;

/** A `bash` call running `command`. */
function shellCall(command: string): ToolCallEvent {
  return { toolName: "bash", input: { command } };
}

/**
 * Runs `factory` against one tool call and returns its decision. The factory's
 * own registered handler is invoked, so this fails if that logic changes.
 */
async function decide(
  factory: ExtensionFactory,
  event: ToolCallEvent,
  ctx: Partial<ToolCallContext> = {},
): Promise<Decision> {
  const context: ToolCallContext = {
    hasUI: true,
    ui: { confirm: async () => true },
    ...ctx,
  };

  let handler: ((e: ToolCallEvent, c: ToolCallContext) => unknown) | undefined;

  const pi = {
    on: (name: string, registered: (e: ToolCallEvent, c: ToolCallContext) => unknown) => {
      if (name === "tool_call") handler = registered;
    },
  } as unknown as ExtensionAPI;

  await factory(pi);

  expect(handler, "factory registered no tool_call handler").toBeDefined();

  return (await handler!(event, context)) as Decision;
}

const ALWAYS_ON = () => true;

test("yolo mode stops the approval prompt", async () => {
  const approve = createAskBeforeChangesExtension(ALWAYS_ON);
  const asked: string[] = [];
  const ctx: Partial<ToolCallContext> = {
    ui: {
      confirm: async (title) => {
        asked.push(title);
        return true;
      },
    },
  };

  const blocking = await decide(approve, { toolName: "write", input: { path: "a.ts" } }, ctx);

  expect(asked).toHaveLength(1);
  expect(blocking).toBeUndefined();

  const yolo = createAskBeforeChangesExtension(() => false);
  const silent = await decide(yolo, { toolName: "write", input: { path: "a.ts" } }, ctx);

  expect(asked).toHaveLength(1);
  expect(silent).toBeUndefined();
});

test("yolo mode leaves the destructive-command guard armed", async () => {
  const guard = createDestructiveCommandGuardExtension(ALWAYS_ON);

  const blocked = await decide(guard, shellCall("rm -rf /"));

  expect(blocked?.block).toBe(true);
  expect(blocked?.reason).toContain("destroy data");
});

test("yolo mode still allows ordinary commands", async () => {
  const guard = createDestructiveCommandGuardExtension(ALWAYS_ON);

  expect(await decide(guard, shellCall("git status"))).toBeUndefined();
  expect(await decide(guard, shellCall("Get-ChildItem"))).toBeUndefined();
});

test("only the explicit opt-out disarms the guard", async () => {
  const disarmed = createDestructiveCommandGuardExtension(() => false);

  expect(await decide(disarmed, shellCall("rm -rf /"))).toBeUndefined();
});
