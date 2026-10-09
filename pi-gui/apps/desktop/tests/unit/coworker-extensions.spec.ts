import { expect, test } from "@playwright/test";
import {
  KEEP_RECENT_TOOL_RESULTS,
  PRUNE_THRESHOLD_CHARS,
  pruneOldToolResults,
} from "../../electron/assistant/coworker-extensions";
import { generativeUiSystemPrompt } from "../../contracts/generative-ui";

function toolResult(text: string) {
  return { role: "toolResult", content: [{ type: "text", text }] };
}

test("trims only large tool results older than the most recent ones", () => {
  const big = "x".repeat(PRUNE_THRESHOLD_CHARS + 500);
  const messages = [
    toolResult(big),
    toolResult("small"),
    ...Array.from({ length: KEEP_RECENT_TOOL_RESULTS }, () => toolResult(big)),
  ];
  const pruned = pruneOldToolResults(messages);
  const text = (index: number) => (pruned[index]?.content[0] as { text: string }).text;
  expect(text(0)).toContain("trimmed to save context");
  expect(text(0).length).toBeLessThan(big.length);
  expect(text(1)).toBe("small");
  for (let index = 2; index < pruned.length; index += 1) {
    expect(text(index)).toBe(big);
  }
  // The original transcript is never mutated.
  expect((messages[0]?.content[0] as { text: string }).text).toBe(big);
});

test("returns the same array when nothing needs trimming", () => {
  const messages = [{ role: "user", content: "hi" }, toolResult("short")];
  expect(pruneOldToolResults(messages)).toBe(messages);
});

test("the generative UI prompt lists every catalog component in inline mode", () => {
  const prompt = generativeUiSystemPrompt();
  for (const name of ["Card(", "Stat(", "BarChart(", "Checklist(", "FollowUp("]) {
    expect(prompt).toContain(name);
  }
  expect(prompt).toContain("```openui-lang");
});
