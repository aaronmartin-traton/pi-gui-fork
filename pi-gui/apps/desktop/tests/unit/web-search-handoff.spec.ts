import { expect, test } from "@playwright/test";
import { formatWebSearchResults, parseDuckDuckGoHtml } from "../../electron/assistant/web-search";
import {
  formatHandoffPrompt,
  handoffMessagesFromTranscript,
} from "../../electron/assistant/handoff";

const FIXTURE = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Example A</a>
  <a class="result__snippet" href="x">First <b>snippet</b>.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://example.org/b">Example B</a>
  <a class="result__snippet">Second snippet.</a>
</div>`;

test("parses DuckDuckGo HTML into results with unwrapped URLs", () => {
  const results = parseDuckDuckGoHtml(FIXTURE);
  expect(results).toHaveLength(2);
  expect(results[0]).toEqual({
    title: "Example A",
    url: "https://example.com/a",
    snippet: "First snippet.",
  });
  expect(results[1]).toEqual({
    title: "Example B",
    url: "https://example.org/b",
    snippet: "Second snippet.",
  });
});

test("formats results, and the empty case", () => {
  const text = formatWebSearchResults("cats", parseDuckDuckGoHtml(FIXTURE));
  expect(text).toContain("Web results for “cats”");
  expect(text).toContain("https://example.com/a");
  expect(formatWebSearchResults("cats", [])).toContain("No web results");
});

test("handoff prompt carries the transcript and trims from the front", () => {
  const messages = handoffMessagesFromTranscript([
    { role: "user", content: "do X" },
    { role: "assistant", content: [{ type: "text", text: "did X" }] },
    { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
    "garbage",
    { role: "user", content: "" },
  ]);
  const prompt = formatHandoffPrompt(messages);
  expect(prompt).toContain("User: do X");
  expect(prompt).toContain("Assistant: did X");
  expect(prompt).toContain("Continue the work");

  const long = formatHandoffPrompt([{ role: "user", text: "y".repeat(20_000) }]);
  expect(long).toContain("earlier messages trimmed");
  expect(long).toContain("Continue the work");
  expect(long.length).toBeLessThan(20_000);
});
