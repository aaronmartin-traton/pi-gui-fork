// Explicit permission, mis-commands, quote wrapping. Drives the real factory.
import { expect, test } from "@playwright/test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createDestructiveCommandGuardExtension,
  findCommandWrappingProblem,
  normalizeShellCommand,
  type DestructiveApproval,
} from "../../electron/assistant/coworker-extensions";

interface ToolCallEvent {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

interface ToolCallContext {
  readonly hasUI: boolean;
}

type Decision = { block: boolean; reason?: string } | undefined;

function shellCall(command: string): ToolCallEvent {
  return { toolName: "bash", input: { command } };
}

async function decide(
  factory: ReturnType<typeof createDestructiveCommandGuardExtension>,
  event: ToolCallEvent,
  { hasUI = true }: { hasUI?: boolean } = {},
): Promise<Decision> {
  let handler: ((e: ToolCallEvent, c: ToolCallContext) => unknown) | undefined;

  const pi = {
    on: (name: string, registered: (e: ToolCallEvent, c: ToolCallContext) => unknown) => {
      if (name === "tool_call") handler = registered;
    },
  } as unknown as ExtensionAPI;

  await factory(pi);

  expect(handler, "guard registered no tool_call handler").toBeDefined();

  return (await handler!(event, { hasUI })) as Decision;
}

/** A guard whose approval channel always answers `answer`. */
function guard(
  answer: boolean,
  asked: string[] = [],
): {
  factory: ReturnType<typeof createDestructiveCommandGuardExtension>;
  asked: string[];
} {
  const approval: DestructiveApproval = {
    confirmDestructive: async (command) => {
      asked.push(command);
      return answer;
    },
  };

  return { factory: createDestructiveCommandGuardExtension(() => true, approval), asked };
}

// --- 1. explicit permission --------------------------------------------------

test("an explicit yes lets exactly that one command through", async () => {
  const yes = guard(true);

  expect(await decide(yes.factory, shellCall("rm -rf ./build"))).toBeUndefined();
  expect(yes.asked).toEqual(["rm -rf ./build"]);
});

test("declining leaves the command blocked", async () => {
  const no = guard(false);
  const decision = await decide(no.factory, shellCall("rm -rf ./build"));

  expect(decision?.block).toBe(true);
  expect(decision?.reason).toContain("blocked");
});

test("permission is never remembered: a second command is asked about again", async () => {
  const yes = guard(true);

  await decide(yes.factory, shellCall("rm -rf ./build"));
  await decide(yes.factory, shellCall("rm -rf ./dist"));

  expect(yes.asked).toEqual(["rm -rf ./build", "rm -rf ./dist"]);
});

test("with no UI — a scheduled run — the block is unconditional", async () => {
  const yes = guard(true);
  const decision = await decide(yes.factory, shellCall("rm -rf ./build"), { hasUI: false });

  expect(decision?.block).toBe(true);
  expect(yes.asked).toEqual([]);
});

test("without an approval channel the guard is a hard block", async () => {
  const hard = createDestructiveCommandGuardExtension(() => true);

  expect((await decide(hard, shellCall("rm -rf /")))?.block).toBe(true);
});

test("permission does not unlock commands the person never saw", async () => {
  const yes = guard(true);
  await decide(yes.factory, shellCall("rm -rf ./build"));

  // A guarded pattern the approval answer does not reach, because it is a
  // different command: it gets its own question.
  await decide(yes.factory, shellCall("mkfs.ext4 /dev/sda1"));

  expect(yes.asked).toEqual(["rm -rf ./build", "mkfs.ext4 /dev/sda1"]);
});

// --- 2 & 3. quote wrapping and mis-commands ----------------------------------

test("a quoted or typographically-quoted rm -rf is still caught", async () => {
  const hard = createDestructiveCommandGuardExtension(() => true);

  for (const command of ['"rm -rf /"', "'rm -rf /'", "“rm -rf /”", "rm -rf / ", "rm –rf /"]) {
    const decision = await decide(hard, shellCall(command));
    expect(decision?.block, `not blocked: ${command}`).toBe(true);
  }
});

test("normalizeShellCommand folds typography and unwraps only a whole-command quote", async () => {
  expect(normalizeShellCommand("“rm -rf x”")).toBe("rm -rf x");
  expect(normalizeShellCommand("  'ls -la'  ")).toBe("ls -la");
  expect(normalizeShellCommand(`ls "my dir"`)).toBe(`ls "my dir"`);
  expect(normalizeShellCommand(`"ls -la`)).toBe(`"ls -la`);
});

test("a command that cannot run as written is refused with the reason", async () => {
  const hard = createDestructiveCommandGuardExtension(() => true);

  const unclosed = await decide(hard, shellCall(`echo "unterminated`));
  expect(unclosed?.block).toBe(true);
  expect(unclosed?.reason).toContain("no closing");

  const typographic = await decide(hard, shellCall("grep “word” file.txt"));
  expect(typographic?.block).toBe(true);
  expect(typographic?.reason).toContain("typographic");

  const prompt = await decide(hard, shellCall("$ git status"));
  expect(prompt?.block).toBe(true);
  expect(prompt?.reason).toContain("$");
});

test("a well-formed ordinary command is left alone", async () => {
  const hard = createDestructiveCommandGuardExtension(() => true);

  expect(await decide(hard, shellCall("git status"))).toBeUndefined();
  expect(await decide(hard, shellCall(`grep "two words" file.txt`))).toBeUndefined();
  expect(await decide(hard, shellCall("ls 'my dir'"))).toBeUndefined();
});

test("findCommandWrappingProblem only reports what it is sure about", () => {
  expect(findCommandWrappingProblem("rm -rf x")).toBeNull();
  expect(findCommandWrappingProblem(`echo "a" && echo 'b'`)).toBeNull();
  expect(findCommandWrappingProblem("")).not.toBeNull();
  expect(findCommandWrappingProblem(`echo "a`)).not.toBeNull();
});
