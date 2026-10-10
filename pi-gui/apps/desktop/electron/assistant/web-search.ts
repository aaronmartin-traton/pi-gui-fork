import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * A local `web_search` tool. `pi-web-search` is provider-native (it asks the
 * model's own API to search), which does not work through the M365 proxy — so
 * pi-gui does the search itself and hands the results back as a normal tool
 * result. No API key for v1: it reads the DuckDuckGo HTML endpoint.
 */

const MAX_RESULTS = 6;
const MAX_SNIPPET = 400;
const MAX_OUTPUT_CHARS = 8_000;

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** Pure: turn the DuckDuckGo HTML results page into structured results. */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockPattern = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(blockPattern)) {
    const href = match[1];
    const rawTitle = match[2];
    if (!href || !rawTitle) continue;
    const url = decodeResultUrl(href);
    const title = stripTags(rawTitle).trim();
    if (url && title) results.push({ title, url, snippet: "" });
    if (results.length >= MAX_RESULTS) break;
  }
  const snippetPattern = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let index = 0;
  for (const match of html.matchAll(snippetPattern)) {
    const existing = results[index];
    if (!existing) break;
    const snippet = stripTags(match[1] ?? "").trim().slice(0, MAX_SNIPPET);
    results[index] = { ...existing, snippet };
    index += 1;
  }
  return results;
}

/** DuckDuckGo wraps links as //duckduckgo.com/l/?uddg=<encoded>; unwrap them. */
function decodeResultUrl(href: string): string {
  const decoded = href.replace(/&amp;/g, "&");
  const encoded = /[?&]uddg=([^&]+)/.exec(decoded)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return decoded;
    }
  }
  return decoded.startsWith("//") ? `https:${decoded}` : decoded;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

export function formatWebSearchResults(query: string, results: readonly WebSearchResult[]): string {
  if (results.length === 0) {
    return `No web results for “${query}”. Try a different query.`;
  }
  const body = results
    .map((result, index) => {
      const snippet = result.snippet ? `\n   ${result.snippet}` : "";
      return `${index + 1}. ${result.title}\n   ${result.url}${snippet}`;
    })
    .join("\n\n");
  return `Web results for “${query}”:\n\n${body}`.slice(0, MAX_OUTPUT_CHARS);
}

async function fetchSearchResults(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    signal,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    },
  });
  if (!response.ok) {
    throw new Error(`web search failed with status ${response.status}`);
  }
  return parseDuckDuckGoHtml(await response.text());
}

function queryFromParams(params: unknown): string {
  if (params && typeof params === "object" && "query" in params && typeof params.query === "string") {
    return params.query.trim();
  }
  return "";
}

export function createWebSearchTool(): ToolDefinition<
  any,
  { query: string; results: readonly WebSearchResult[] }
> {
  return {
    name: "web_search",
    label: "Web search",
    description: "Search the web and return the top results (title, URL, snippet).",
    promptSnippet: "web_search: search the web for current or external information.",
    promptGuidelines: [
      "Use web_search when the answer depends on current events, versions, prices, or anything not in the repo.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params, signal) {
      const query = queryFromParams(params);
      if (!query) {
        throw new Error("web_search requires a non-empty query.");
      }
      const results = await fetchSearchResults(query, signal);
      return {
        content: [{ type: "text", text: formatWebSearchResults(query, results) }],
        details: { query, results },
      };
    },
  };
}

export function createWebSearchExtension(): ExtensionFactory {
  return (pi) => {
    pi.registerTool(createWebSearchTool());
  };
}
