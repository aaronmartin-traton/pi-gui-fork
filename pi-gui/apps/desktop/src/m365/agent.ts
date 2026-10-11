/**
 * Port of `m365copilotproxy/agent.py`.
 *
 * Boots the Power Platform side of the Copilot Studio agent used for tool
 * calling: looks for an existing bot by name, otherwise creates one from
 * `createBody()`, publishes it, and caches the resulting
 * `<titleId>.<botId>.gpt.default` agent id on disk. Any failure degrades to
 * agent-less routing instead of breaking the chat connection.
 *
 * The BAP and Power Platform scope strings are imported from `auth.ts`, which
 * owns them verbatim. `agent.py` fetches one token per resource, so the
 * provider is typed by the scoped call it must support.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { BAP_SCOPES, POWERPLATFORM_SCOPES } from "./auth.js";

/**
 * The scoped token call `agent.py` needs to reach BAP and Power Platform.
 *
 * This is deliberately structural: `auth.py`'s provider exposes only
 * `token(scopes)` and carries no `oid`/`tid` (those describe the token claims,
 * not the provider), and a scope-free `token()` satisfies it too, since a
 * function that takes fewer arguments is assignable to the wider signature.
 */
export interface ScopedTokenProvider {
  token(scopes: readonly string[]): Promise<string>;
}

export const BAP_API = "https://api.bap.microsoft.com";
export const API_VERSION = "2022-03-01-preview";
export const BOT_NAME = "m365-tool-agent";
export const BOT_DESCRIPTION = "Auto-created agent for tool calling";
export const ICON =
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAB3RJTUUH6AMbAAAoLbOJEAAAABl0RVh0Q29tbWVudABDcmVhdGVkIHdpdGggR0lNUFeBDhcAAAAoSURBVFjD7cExAQAAAMKg9U9tDB+gAAAAAAAAAAAAAAAAAAAAAAAA/BgwMAAB/0LuMgAAAABJRU5ErkJggg==";
export const INSTRUCTIONS = `You are the execution core of an automated agent. Your output is parsed by a program.

When the incoming message contains a <tools> block, act by outputting ONLY one Markdown code fence whose info-string is the exact tool name. Put scalar arguments in \`key: value\` header lines and a free-form body argument after a blank line. A fenced block is an action the runtime executes against the user's machine, not an example. The runtime returns the real result in a <tool_response> block. Emit one tool call per turn and wait for its result.

When the message has no <tools> block, respond normally in natural language.`;
export const INSTRUCTIONS_HASH = createHash("sha256")
  .update(INSTRUCTIONS, "utf8")
  .digest("hex")
  .slice(0, 8);
export const AGENT_NAME = `${BOT_NAME}-${INSTRUCTIONS_HASH}`;

export function environmentUrl(name: string): string {
  const env_id = name.startsWith("Default-") ? name.slice("Default-".length) : name;
  const normalized = env_id.replaceAll("-", "").toLowerCase();
  if (normalized.length < 3 || !/^[a-z0-9]+$/.test(normalized)) {
    throw new Error("BAP returned an invalid environment name");
  }
  return `https://default${normalized.slice(0, -2)}.${normalized.slice(-2)}.environment.api.powerplatform.com`;
}

interface RequestOptions {
  /** Serialized as the JSON request body when present. */
  readonly json?: unknown;
  /** Whole-request timeout in seconds; Python's `urlopen` default is 30. */
  readonly timeout?: number;
}

async function request(
  method: string,
  url: string,
  token: string,
  options: RequestOptions = {},
): Promise<HttpResponse> {
  const { json: json_body, timeout = 30 } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)",
  };
  const resp = await fetch(url, {
    method,
    headers,
    body: json_body === undefined ? null : JSON.stringify(json_body),
    signal: AbortSignal.timeout(timeout * 1000),
  });
  if (!resp.ok) {
    throw new Error(`${method} ${url} failed: HTTP ${resp.status} ${resp.statusText}`);
  }
  return new HttpResponse(resp);
}

/** Minimal response wrapper exposing .json() as callers require. */
class HttpResponse {
  private readonly _resp: Response;
  private _body: unknown;

  constructor(resp: Response) {
    this._resp = resp;
    this._body = null;
  }

  async json(): Promise<unknown> {
    if (this._body === null) {
      this._body = await this._resp.json();
    }
    return this._body;
  }
}

/** Builds the bot definition posted to the minimalBots API. */
function createBody(): Record<string, unknown> {
  const zero = "00000000-0000-0000-0000-000000000000";
  const instructions = {
    $kind: "TemplateLine",
    segments: [{ $kind: "TextSegment", value: INSTRUCTIONS, diagnostics: [] }],
    diagnostics: [],
  };
  const metadata = {
    tools: [],
    conversationStarters: [],
    diagnostics: [],
    instructions,
    knowledgeSources: { diagnostics: [], $kind: "SearchAllKnowledgeSources" },
    $kind: "GptComponentMetadata",
    gptCapabilities: {
      diagnostics: [],
      $kind: "GptCapabilities",
      codeInterpreter: false,
      generateImages: false,
      webBrowsing: false,
      searchOneDriveAndSharePoint: false,
      searchTeams: false,
      searchMeetings: false,
      searchEmails: false,
      searchPeople: false,
    },
    aISettings: { diagnostics: [], $kind: "AISettings", useModelKnowledge: true },
  };
  const component = {
    diagnostics: [],
    displayName: AGENT_NAME,
    id: zero,
    metadata,
    schemaName: `${zero}.gpt.default`,
    $kind: "GptComponent",
    description: BOT_DESCRIPTION,
  };
  return {
    botComponentChanges: [{ component, $kind: "BotComponentInsert" }],
    cloudFlowDefinitionChanges: [],
    connectorDefinitionChanges: [],
    environmentVariableChanges: [],
    connectionReferenceChanges: [],
    aIPluginOperationChanges: [],
    componentCollectionChanges: [],
    dataverseTableSearchChanges: [],
    dataverseTableSearchEntityConfigurationChanges: [],
    dataverseTableSearchGlossaryConfigurationChanges: [],
    dataverseTableSearchEntityColumnSynonymChanges: [],
    aIModelChanges: [],
    connectedAgentDefinitionChanges: [],
    bot: {
      authorizedSecurityGroupIds: [],
      supportedLanguages: [],
      diagnostics: [],
      displayName: AGENT_NAME,
      language: 1033,
      schemaName: zero,
      template: "gpt-1.1.0",
      $kind: "BotEntity",
      iconBase64: ICON,
    },
  };
}

export async function getOrCreateAgent(provider: ScopedTokenProvider): Promise<string | null> {
  const explicit = process.env["M365_AGENT_ID"];
  if (explicit) {
    return explicit;
  }
  const root = join(process.env["LOCALAPPDATA"] ?? homedir(), "M365CopilotProxy");
  const cache_path = join(root, "agent-id.json");
  if (existsSync(cache_path)) {
    try {
      const cached = asRecord(JSON.parse(await readFile(cache_path, "utf-8")));
      const agentId = nonEmptyString(cached?.["agentId"]);
      if (cached?.["instructionsHash"] === INSTRUCTIONS_HASH && agentId !== null) {
        return agentId;
      }
    } catch {
      console.error("Ignoring unreadable tool-agent cache");
    }
  }
  try {
    const bap_token = await provider.token(BAP_SCOPES);
    const pp_token = await provider.token(POWERPLATFORM_SCOPES);
    const env_resp = await request(
      "GET",
      `${BAP_API}/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01`,
      bap_token,
    );
    const env_name = nonEmptyString(asRecord(await env_resp.json())?.["name"]);
    if (env_name === null) {
      throw new Error("BAP environment response omitted name");
    }
    const env_url = environmentUrl(env_name);
    const bots_url = `${env_url}/copilotstudio/minimalBots/api?api-version=${API_VERSION}`;
    const bots = await (await request("GET", bots_url, pp_token)).json();
    const existing = Array.isArray(bots)
      ? bots.find((bot) => asRecord(bot)?.["shortBotName"] === AGENT_NAME)
      : null;
    let bot_id: string | null = null;
    if (existing) {
      bot_id = nonEmptyString(asRecord(existing)?.["botId"]);
      if (bot_id === null) {
        throw new Error("Power Platform bot list response omitted botId");
      }
    } else {
      const created_resp = await request("POST", bots_url, pp_token, { json: createBody() });
      const bot = asRecord(asRecord(await created_resp.json())?.["bot"]) ?? {};
      bot_id = nonEmptyString(bot["schemaName"]) ?? nonEmptyString(bot["cdsBotId"]);
      if (bot_id === null) {
        throw new Error("Power Platform create response omitted bot ID");
      }
    }
    const publish_resp = await request(
      "POST",
      `${env_url}/copilotstudio/minimalBots/api/${bot_id}/publish?api-version=${API_VERSION}`,
      pp_token,
    );
    const published = await publish_resp.json();
    const title_id = nonEmptyString(asRecord(published)?.["TitleId"]);
    if (title_id === null) {
      throw new Error("Power Platform publish response omitted TitleId");
    }
    const agent_id = `${title_id}.${bot_id}.gpt.default`;
    await mkdir(root, { recursive: true });
    const payload = { agentId: agent_id, botId: bot_id, instructionsHash: INSTRUCTIONS_HASH };
    await writeFile(cache_path, JSON.stringify(payload, null, 2), "utf-8");
    return agent_id;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Tool agent unavailable; using agent-less routing: ${detail}`);
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
