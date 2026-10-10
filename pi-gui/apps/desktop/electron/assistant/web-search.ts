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
const SEARCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** Pure: turn the DuckDuckGo HTML results page into structured results. */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Split per result block so a title and its own snippet stay together, even
  // when a block has no snippet.
  const blocks = html.split(/<div[^>]*class="[^"]*?\bresult\b/).slice(1);
  for (const block of blocks) {
    if (/\bresult--ad\b/.test(block)) continue;
    const anchor = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const href = anchor?.[1];
    const rawTitle = anchor?.[2];
    if (!href || !rawTitle) continue;
    const url = decodeResultUrl(href);
    if (!url || /\/y\.js\b/.test(url)) continue;
    const title = decodeEntities(stripTags(rawTitle)).trim();
    if (!title) continue;
    const rawSnippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1];
    const snippet = rawSnippet
      ? decodeEntities(stripTags(rawSnippet)).trim().slice(0, MAX_SNIPPET)
      : "";
    results.push({ title, url, snippet });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

/** Unwrap DuckDuckGo's `//duckduckgo.com/l/?uddg=<encoded>` redirect links only. */
function decodeResultUrl(href: string): string {
  const decoded = href.replace(/&amp;/g, "&");
  const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    const url = new URL(absolute);
    if (url.hostname.endsWith("duckduckgo.com") && url.pathname === "/l/") {
      return url.searchParams.get("uddg") ?? absolute;
    }
    return absolute;
  } catch {
    return absolute;
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

/** Decode entities in one pass, so `&amp;quot;` never double-decodes to `"`. */
function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|quot|lt|gt|apos|nbsp|amp);/gi,
    (match, entity: string) => {
      const lower = entity.toLowerCase();
      switch (lower) {
        case "quot":
          return '"';
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "apos":
          return "'";
        case "nbsp":
          return " ";
        case "amp":
          return "&";
        default: {
          const code = lower.startsWith("#x")
            ? Number.parseInt(lower.slice(2), 16)
            : Number.parseInt(lower.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
      }
    },
  );
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
      },
    );
    if (!response.ok) {
      throw new Error(`web search failed with status ${response.status}`);
    }
    return parseDuckDuckGoHtml(await response.text());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

function queryFromParams(params: unknown): string {
  if (
    params &&
    typeof params === "object" &&
    "query" in params &&
    typeof params.query === "string"
  ) {
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
