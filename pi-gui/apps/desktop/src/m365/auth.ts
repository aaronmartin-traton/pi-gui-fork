/**
 * Ports m365copilotproxy/auth.py: OAuth 2.0 authorization-code flow with a
 * Chrome DevTools Protocol sign-in browser, plus the JSON token cache
 * (per-scope access tokens and refresh-token rotation).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { asRecord } from "./guards.js";

export const CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
export const AUTHORITY = "https://login.microsoftonline.com/common";
export const AUTHORIZE_ENDPOINT = `${AUTHORITY}/oauth2/v2.0/authorize`;
export const TOKEN_ENDPOINT = `${AUTHORITY}/oauth2/v2.0/token`;
export const REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient";
export const CHAT_SCOPES = [
  "https://substrate.office.com/sydney/M365Chat.Read",
  "https://substrate.office.com/sydney/sydney.readwrite",
] as const;
export const BAP_SCOPES = ["https://api.bap.microsoft.com/.default"] as const;
export const POWERPLATFORM_SCOPES = ["https://api.powerplatform.com/.default"] as const;

export class AuthenticationError extends Error {}

/** A redirect captured from the sign-in browser: either an error or a code. */
export type AuthorizationResponse =
  | { readonly error: string }
  | { readonly code: string; readonly state: string };

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly sessionId?: string;
}

interface CdpCounter {
  value: number;
}

/** Raised by {@link CdpSocket.recv} when no message arrives before the timeout. */
class WebSocketTimeout extends Error {}

/**
 * A minimal async facade over the GLOBAL WebSocket for the CDP session:
 * messages queue up and `recv` waits for the next one, with an optional
 * timeout, mirroring the blocking `recv(timeout=...)` of the Python client.
 */
class CdpSocket {
  private readonly socket: WebSocket;
  private readonly pending: CdpMessage[] = [];
  private readonly waiters: Array<(message: CdpMessage | null) => void> = [];
  private failure: Error | null = null;
  private readonly opened: Promise<void>;
  private resolveOpen!: () => void;
  private rejectOpen!: (error: Error) => void;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    this.socket.addEventListener("open", () => {
      this.resolveOpen();
    });
    this.socket.addEventListener("message", (event) => {
      const data: unknown = event.data;
      if (typeof data !== "string") {
        return;
      }
      let message: CdpMessage;
      try {
        const parsed: unknown = JSON.parse(data);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return;
        }
        message = parsed as CdpMessage;
      } catch {
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter(message);
      } else {
        this.pending.push(message);
      }
    });
    this.socket.addEventListener("error", () => {
      this.fail(new Error("The sign-in browser connection failed"));
    });
    this.socket.addEventListener("close", () => {
      this.fail(new Error("The sign-in browser closed the connection"));
    });
  }

  private fail(error: Error): void {
    if (this.failure === null) {
      this.failure = error;
    }
    this.rejectOpen(error);
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiters) {
      waiter(null);
    }
  }

  async ready(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AuthenticationError("Timed out starting the sign-in browser"));
      }, timeoutMs);
      this.opened.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  send(payload: string): void {
    this.socket.send(payload);
  }

  async recv(timeoutMs?: number): Promise<CdpMessage> {
    const pending = this.pending.shift();
    if (pending !== undefined) {
      return pending;
    }
    if (this.failure !== null) {
      throw this.failure;
    }
    return new Promise<CdpMessage>((resolve, reject) => {
      const waiter = (message: CdpMessage | null): void => {
        if (message === null) {
          reject(this.failure ?? new Error("The sign-in browser closed the connection"));
          return;
        }
        resolve(message);
      };
      this.waiters.push(waiter);
      if (timeoutMs === undefined) {
        return;
      }
      // A one-shot timer: if the waiter already resolved, the later reject is a
      // no-op and the failed splice simply finds nothing to remove.
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new WebSocketTimeout("Timed out waiting for a browser message"));
      }, timeoutMs);
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // The connection may already be gone.
    }
  }
}

// --- sign-in browser (Chrome DevTools Protocol) ----------------------------

function browserExecutable(): string {
  const configured = process.env["CHROMIUM_PATH"];
  if (configured) {
    if (existsSync(configured)) {
      return configured;
    }
    throw new AuthenticationError("CHROMIUM_PATH does not point to a browser executable");
  }
  const roots = [
    process.env["PROGRAMFILES"] ?? "",
    process.env["PROGRAMFILES(X86)"] ?? "",
    process.env["LOCALAPPDATA"] ?? "",
  ];
  const browsers = [
    "Google/Chrome/Application/chrome.exe",
    "Microsoft/Edge/Application/msedge.exe",
  ];
  for (const root of roots) {
    for (const browser of browsers) {
      const candidate = join(root, browser);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  throw new AuthenticationError("Chrome or Edge was not found; set CHROMIUM_PATH to its executable");
}


async function cdpCall(
  socket: CdpSocket,
  counter: CdpCounter,
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
  events: AuthorizationResponse[],
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  counter.value += 1;
  const commandId = counter.value;
  const command: Record<string, unknown> = { id: commandId, method, params };
  if (sessionId) {
    command["sessionId"] = sessionId;
  }
  socket.send(JSON.stringify(command));
  while (true) {
    const message = await socket.recv(timeoutMs);
    if (message.id === commandId) {
      if ("error" in message) {
        throw new AuthenticationError("Browser authorization setup failed");
      }
      const result = message.result;
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        return {};
      }
      return result as Record<string, unknown>;
    }
    const authResponse = authorizationResponse(message);
    if (authResponse !== null) {
      events.push(authResponse);
    }
  }
}


function authorizationResponse(message: CdpMessage): AuthorizationResponse | null {
  if (message.method !== "Network.requestWillBeSent") {
    return null;
  }
  const params = message.params;
  if (params === null || typeof params !== "object") {
    return null;
  }
  const request = (params as Record<string, unknown>)["request"];
  if (request === null || typeof request !== "object") {
    return null;
  }
  const requestUrl = (request as Record<string, unknown>)["url"];
  if (typeof requestUrl !== "string") {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (parsed.hostname !== "login.microsoftonline.com") {
    return null;
  }
  if (parsed.pathname.replace(/\/+$/, "") !== "/common/oauth2/nativeclient") {
    return null;
  }
  const query = parsed.searchParams;
  const error = query.get("error");
  if (error) {
    return { error };
  }
  const code = query.get("code");
  if (code) {
    return { code, state: query.get("state") ?? "" };
  }
  return null;
}


async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(false);
    }, timeoutMs);
    child.once("exit", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Bind an ephemeral port on the loopback interface, then release it. */
async function reservePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => {
      reject(new AuthenticationError("Could not reserve a debugging port"));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new AuthenticationError("Could not reserve a debugging port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function captureAuthorizationResponse(
  authUri: string,
  profileDir: string,
): Promise<AuthorizationResponse> {
  const browser = browserExecutable();
  const port = await reservePort();
  let child: ChildProcess;
  try {
    child = spawn(
      browser,
      [
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
  } catch {
    throw new AuthenticationError("Could not start the sign-in browser");
  }
  let gone = false;
  child.on("error", () => {
    gone = true;
  });
  child.on("exit", () => {
    gone = true;
  });
  const exited = (): boolean =>
    gone || child.exitCode !== null || child.signalCode !== null;
  const terminate = async (): Promise<void> => {
    if (exited()) {
      return;
    }
    child.kill();
    if (await waitForExit(child, 10_000)) {
      return;
    }
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  };
  try {
    const launchDeadline = performance.now() + 20_000;
    let debuggerUrl: string | null = null;
    while (true) {
      if (exited()) {
        throw new AuthenticationError("Browser closed before Microsoft sign-in started");
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const info: unknown = await response.json();
        if (info === null || typeof info !== "object" || Array.isArray(info)) {
          throw new Error("Not a JSON object");
        }
        const webSocketDebuggerUrl = (info as Record<string, unknown>)[
          "webSocketDebuggerUrl"
        ];
        if (typeof webSocketDebuggerUrl !== "string") {
          throw new Error("Missing webSocketDebuggerUrl");
        }
        debuggerUrl = webSocketDebuggerUrl;
        break;
      } catch {
        if (performance.now() >= launchDeadline) {
          throw new AuthenticationError("Timed out starting the sign-in browser");
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
      }
    }
    const endpoint = debuggerUrl.replace("localhost", "127.0.0.1");
    const socket = new CdpSocket(endpoint);
    await socket.ready(30_000);
    const counter: CdpCounter = { value: 0 };
    const events: AuthorizationResponse[] = [];
    try {
      const target = await cdpCall(
        socket,
        counter,
        "Target.createTarget",
        { url: "about:blank" },
        "",
        events,
      );
      const targetId = target["targetId"];
      if (typeof targetId !== "string") {
        throw new AuthenticationError("Browser authorization setup failed");
      }
      const attached = await cdpCall(
        socket,
        counter,
        "Target.attachToTarget",
        { targetId, flatten: true },
        "",
        events,
      );
      const sessionId = attached["sessionId"];
      if (typeof sessionId !== "string") {
        throw new AuthenticationError("Browser authorization setup failed");
      }
      await cdpCall(socket, counter, "Network.enable", {}, sessionId, events);
      await cdpCall(socket, counter, "Page.enable", {}, sessionId, events);
      await cdpCall(socket, counter, "Page.navigate", { url: authUri }, sessionId, events);
      const deadline = performance.now() + 300_000;
      while (true) {
        if (events.length > 0) {
          const response = events.shift();
          if (response === undefined) {
            throw new AuthenticationError("Timed out waiting for Microsoft sign-in");
          }
          return response;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new AuthenticationError("Timed out waiting for Microsoft sign-in");
        }
        let message: CdpMessage;
        try {
          message = await socket.recv(remaining);
        } catch (error) {
          if (error instanceof WebSocketTimeout) {
            throw new AuthenticationError("Timed out waiting for Microsoft sign-in");
          }
          throw error;
        }
        const authResponse = authorizationResponse(message);
        if (authResponse !== null) {
          events.push(authResponse);
        }
      }
    } finally {
      try {
        await cdpCall(socket, counter, "Browser.close", {}, "", events, 3_000);
      } catch {
        // The browser may already be gone; ignore close failures.
      }
      socket.close();
    }
  } finally {
    await terminate();
  }
}


// --- OAuth 2.0 authorization-code flow --------------------------------------

export function scopeKey(scopes: readonly string[]): string {
  return [...scopes].sort().join(" ");
}


export function pkce(): [string, string] {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return [verifier, challenge];
}


export function authorizeUrl(
  scopes: readonly string[],
  challenge: string,
  state: string,
  prompt: string | null,
): string {
  const params = new URLSearchParams();
  params.set("client_id", CLIENT_ID);
  params.set("response_type", "code");
  params.set("redirect_uri", REDIRECT_URI);
  params.set("response_mode", "query");
  params.set("scope", [...scopes, "offline_access", "openid", "profile"].join(" "));
  params.set("code_challenge", challenge);
  params.set("code_challenge_method", "S256");
  params.set("state", state);
  params.set("client_info", "1");
  if (prompt) {
    params.set("prompt", prompt);
  }
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}


export async function tokenRequest(
  data: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(data).toString();
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let decoded = true;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    decoded = false;
  }
  if (!decoded || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (!response.ok) {
      throw new AuthenticationError(
        `Microsoft token request failed: HTTP ${response.status}`,
      );
    }
    throw new Error("Microsoft token endpoint returned an unreadable response");
  }
  return parsed as Record<string, unknown>;
}


function errorText(result: Record<string, unknown>): string {
  const description = result["error_description"];
  if (typeof description === "string" && description) {
    return description;
  }
  const error = result["error"];
  if (typeof error === "string" && error) {
    return error;
  }
  return "Microsoft sign-in did not return an access token";
}


export function preferredUsername(result: Record<string, unknown>): string | null {
  const token = result["id_token"];
  if (typeof token !== "string") {
    return null;
  }
  const payload = token.split(".")[1];
  if (payload === undefined) {
    return null;
  }
  const padded = `${payload}${"=".repeat((4 - (payload.length % 4)) % 4)}`;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    return null;
  }
  const record = claims as Record<string, unknown>;
  for (const name of ["preferred_username", "upn", "email", "name"]) {
    const value = record[name];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return null;
}


/** Caches one refresh token plus per-scope access tokens in a JSON file. */
export class FileTokenProvider {
  private cachePath = "";
  private cache: Record<string, unknown> = {};
  private initialized: Promise<void> | null = null;
  private lock: Promise<void> = Promise.resolve();

  private ready(): Promise<void> {
    if (this.initialized === null) {
      this.initialized = this.initialize();
    }
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    const root = join(process.env["LOCALAPPDATA"] ?? homedir(), "M365CopilotProxy");
    await mkdir(root, { recursive: true });
    this.cachePath = process.env["M365_CACHE_FILE"] ?? join(root, "token-cache.json");
    this.cache = await this.load();
  }

  private async load(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.cachePath, "utf8");
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {};
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, JSON.stringify(this.cache), "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AuthenticationError(`Could not write the token cache: ${detail}`);
    }
  }

  private async store(result: Record<string, unknown>, key: string): Promise<void> {
    await this.ready();
    const refreshToken = result["refresh_token"];
    if (typeof refreshToken === "string") {
      this.cache["refresh_token"] = refreshToken;
    }
    const username = preferredUsername(result);
    if (username) {
      this.cache["username"] = username;
    }
    let access = this.cache["access"];
    if (access === null || typeof access !== "object" || Array.isArray(access)) {
      access = {};
      this.cache["access"] = access;
    }
    const entries = access as Record<string, unknown>;
    const accessToken = result["access_token"];
    if (typeof accessToken === "string") {
      const expiresIn = result["expires_in"];
      let seconds = 3600;
      if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
        seconds = expiresIn;
      } else if (typeof expiresIn === "string") {
        const parsed = Number(expiresIn);
        if (Number.isFinite(parsed)) {
          seconds = parsed;
        }
      }
      entries[key] = { token: accessToken, expires_at: Date.now() / 1000 + seconds };
    }
    await this.save();
  }

  /** The cached access token for a scope key with its absolute expiry, or null. */
  private accessEntry(key: string): { readonly token: string; readonly expiresAt: number } | null {
    const access = asRecord(this.cache["access"]);
    if (access === null) {
      return null;
    }
    const entry = asRecord(access[key]);
    if (entry === null) {
      return null;
    }
    const token = entry["token"];
    const expiresAt = entry["expires_at"];
    if (typeof token !== "string" || typeof expiresAt !== "number") {
      return null;
    }
    return { token, expiresAt };
  }

  private cached(key: string): string | null {
    const entry = this.accessEntry(key);
    if (entry === null) {
      return null;
    }
    return entry.expiresAt > Date.now() / 1000 + 60 ? entry.token : null;
  }

  private async interactive(scopes: readonly string[]): Promise<Record<string, unknown>> {
    const hasAccount = Boolean(this.cache["refresh_token"]);
    const [verifier, challenge] = pkce();
    const state = randomBytes(16).toString("base64url");
    const authUri = authorizeUrl(scopes, challenge, state, hasAccount ? null : "select_account");
    console.log("Complete Microsoft sign-in in the opened browser window.");
    const profileDir = await mkdtemp(join(tmpdir(), "m365-copilot-auth-"));
    let authResponse: AuthorizationResponse;
    try {
      authResponse = await captureAuthorizationResponse(authUri, profileDir);
    } finally {
      try {
        await rm(profileDir, { recursive: true, force: true });
      } catch {
        // The profile directory is disposable; ignore cleanup failures.
      }
    }
    if ("error" in authResponse) {
      throw new AuthenticationError(`Microsoft sign-in failed: ${authResponse.error}`);
    }
    if (authResponse.state !== state) {
      throw new AuthenticationError("Microsoft sign-in returned an unexpected state");
    }
    const result = await tokenRequest({
      client_id: CLIENT_ID,
      grant_type: "authorization_code",
      code: authResponse.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      scope: scopes.join(" "),
    });
    if (typeof result["access_token"] !== "string") {
      throw new AuthenticationError(errorText(result));
    }
    return result;
  }

  async username(): Promise<string | null> {
    await this.ready();
    const value = this.cache["username"];
    return typeof value === "string" ? value : null;
  }

  /**
   * Cache-only token state for the `/healthz` probe: never refreshes, never opens
   * a browser, so a status check cannot start a sign-in.
   */
  async tokenStatus(scopes: readonly string[] = CHAT_SCOPES): Promise<{
    readonly valid: boolean;
    readonly secondsRemaining: number | null;
    readonly username: string | null;
  }> {
    await this.ready();
    const entry = this.accessEntry(scopeKey(scopes));
    const username: unknown = this.cache["username"];
    return {
      valid: entry !== null && entry.expiresAt > Date.now() / 1000 + 60,
      secondsRemaining:
        entry === null ? null : Math.max(0, Math.floor(entry.expiresAt - Date.now() / 1000)),
      username: typeof username === "string" ? username : null,
    };
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  async token(scopes: readonly string[] = CHAT_SCOPES, interactive = true): Promise<string> {
    return this.withLock(async () => {
      await this.ready();
      const key = scopeKey(scopes);
      const cached = this.cached(key);
      if (cached !== null) {
        return cached;
      }
      const refresh = this.cache["refresh_token"];
      if (typeof refresh === "string" && refresh) {
        const result = await tokenRequest({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refresh,
          scope: scopes.join(" "),
        });
        const accessToken = result["access_token"];
        if (typeof accessToken === "string") {
          await this.store(result, key);
          return accessToken;
        }
      }
      if (!interactive) {
        throw new AuthenticationError("No cached Microsoft sign-in for these permissions");
      }
      const result = await this.interactive(scopes);
      await this.store(result, key);
      const accessToken = result["access_token"];
      if (typeof accessToken !== "string") {
        throw new AuthenticationError(errorText(result));
      }
      return accessToken;
    });
  }
}


export async function login(): Promise<string> {
  const provider = new FileTokenProvider();
  await provider.token(CHAT_SCOPES, true);
  const username = await provider.username();
  return username ? username : "Microsoft account";
}
