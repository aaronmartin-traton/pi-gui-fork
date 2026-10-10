import { expect, test } from "@playwright/test";
import { formatWebSearchResults, parseDuckDuckGoHtml } from "../../electron/assistant/web-search";
import {
  branchMessages,
  formatHandoffPrompt,
  handoffMessagesFromTranscript,
} from "../../electron/assistant/handoff";

const FIXTURE = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Example &#x27;A&#x27;</a>
  <a class="result__snippet" href="x">First <b>snippet</b> &amp; more.</a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="https://example.org/b">Example B</a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="https://example.net/c?uddg=keepme">Example C</a>
  <a class="result__snippet">Third snippet.</a>
</div>
<div class="result result--ad">
  <a rel="nofollow" class="result__a" href="https://ads.example/spam">Ad</a>
</div>`;

test("parses per block: each title keeps its own snippet, entities decode, non-DDG uddg is kept, ads are dropped", () => {
  const results = parseDuckDuckGoHtml(FIXTURE);
  expect(results).toEqual([
    { title: "Example 'A'", url: "https://example.com/a", snippet: "First snippet & more." },
    { title: "Example B", url: "https://example.org/b", snippet: "" },
    { title: "Example C", url: "https://example.net/c?uddg=keepme", snippet: "Third snippet." },
  ]);
});

test("formats results, and the empty case", () => {
  const text = formatWebSearchResults("cats", parseDuckDuckGoHtml(FIXTURE));
  expect(text).toContain("Web results for “cats”");
  expect(text).toContain("https://example.com/a");
  expect(formatWebSearchResults("cats", [])).toContain("No web results");
});

test("handoff prompt carries the transcript, drops tool noise, and trims from the front", () => {
  const messages = handoffMessagesFromTranscript([
    { role: "user", content: "do X" },
    { role: "assistant", content: [{ type: "text", text: "did X" }] },
    { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
    { role: "bashExecution", content: "ls" },
    "garbage",
    { role: "user", content: "" },
  ]);
  expect(messages).toEqual([
    { role: "user", text: "do X" },
    { role: "assistant", text: "did X" },
  ]);
  const prompt = formatHandoffPrompt(messages);
  expect(prompt).toContain("User: do X");
  expect(prompt).toContain("Assistant: did X");
  expect(prompt).not.toContain("tool output");
  expect(prompt).toContain("Continue the work");

  const long = formatHandoffPrompt([{ role: "user", text: "y".repeat(20_000) }]);
  expect(long).toContain("earlier messages trimmed");
  expect(long).toContain("Continue the work");
  expect(long.length).toBeLessThan(20_000);
});

test("branchMessages keeps only message entries", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "model_change", provider: "p", modelId: "m" },
    { type: "message", message: { role: "assistant", content: "ok" } },
  ];
  expect(branchMessages(branch)).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
  ]);
});
