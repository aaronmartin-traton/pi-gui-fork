/**
 * Ports m365copilotproxy/auth.py: OAuth 2.0 authorization-code flow with a
 * Chrome DevTools Protocol sign-in browser, plus the JSON token cache
 * (per-scope access tokens and refresh-token rotation).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { asRecord, isRecord, messageOf } from "./guards.js";

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

/**
 * What a chat request says when there is no usable sign-in. A request must never
 * start a sign-in, so it names the one action that fixes it.
 */
export const SIGN_IN_REQUIRED =
  "Your Microsoft 365 sign-in expired. Open Settings → Microsoft 365 Copilot and click Connect.";

/**
 * A sign-in failure. `message` is what the co-worker reads, so it stays plain
 * language with a next step; `detail` carries the raw browser/OAuth text for a
 * support log and is never shown as the message.
 */
export class AuthenticationError extends Error {
  readonly detail: string | null;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "AuthenticationError";
    this.detail = detail === undefined || detail.length === 0 ? null : detail;
  }
}

/** Plain-language text for the OAuth error codes Microsoft's sign-in returns. */
const OAUTH_ERROR_TEXT: Readonly<Record<string, string>> = {
  access_denied: "You cancelled the Microsoft 365 sign-in. Click Connect when you are ready to try again.",
  consent_required: "Microsoft 365 needs your permission before pi can use it. Click Connect and accept the prompt.",
  interaction_required: "Microsoft 365 needs you to sign in again. Click Connect and follow the prompts.",
  invalid_client: "This PC is not set up for Microsoft 365 sign-in. Ask your IT team for help.",
  invalid_grant: "Your Microsoft 365 sign-in has expired. Click Connect to sign in again.",
  login_required: "Microsoft 365 needs you to sign in again. Click Connect and follow the prompts.",
  unauthorized_client: "Your organization does not allow pi to sign in to Microsoft 365. Ask your IT team to approve it.",
};

/** A cancelled sign-in: `login()`'s callers recognise the `AbortError` name. */
function abortError(): Error {
  return new DOMException("The sign-in was cancelled", "AbortError");
}

/**
 * The text every browser-side problem shows. Edge being busy, missing or wedged
 * all end the same way for the co-worker, so one string keeps them consistent.
 */
const BROWSER_TROUBLE =
  "Microsoft sign-in could not start. Close any Microsoft Edge windows, then click Connect again.";
const BROWSER_CLOSED =
  "The sign-in window closed before sign-in finished. Click Connect to try again.";
const SIGN_IN_TIMED_OUT =
  "Microsoft 365 sign-in was not completed in time. Click Connect to try again.";
/** Fallback when Microsoft reports a failure we cannot map to a specific fix. */
const SIGN_IN_FAILED =
  "Microsoft 365 did not finish signing you in. Click Connect to try again.";

/** Rejects as soon as `signal` aborts, without waiting for `promise` itself. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

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
        if (!isRecord(parsed)) {
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
      this.fail(
        new AuthenticationError(
          BROWSER_TROUBLE,
          "The sign-in browser connection failed (CDP WebSocket error)",
        ),
      );
    });
    this.socket.addEventListener("close", () => {
      this.fail(
        new AuthenticationError(BROWSER_CLOSED, "The sign-in browser closed the connection"),
      );
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
        reject(
          new AuthenticationError(
            BROWSER_TROUBLE,
            `Timed out starting the sign-in browser (${timeoutMs} ms)`,
          ),
        );
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
    throw new AuthenticationError(
      "The browser set up for Microsoft 365 sign-in is missing. Ask your IT team to check the CHROMIUM_PATH setting.",
      `CHROMIUM_PATH does not point to a browser executable: ${configured}`,
    );
  }
  const roots = [
    process.env["PROGRAMFILES"] ?? "",
    process.env["PROGRAMFILES(X86)"] ?? "",
    process.env["LOCALAPPDATA"] ?? "",
  ];
  // Edge ships with Windows 10 and 11, so it is both the reliable choice and the
  // one whose saved profile makes a repeat sign-in silent; Chrome is the fallback.
  const browsers = [
    "Microsoft/Edge/Application/msedge.exe",
    "Google/Chrome/Application/chrome.exe",
  ];
  for (const browser of browsers) {
    for (const root of roots) {
      const candidate = join(root, browser);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  throw new AuthenticationError(
    "Microsoft Edge is not installed on this PC. Install Microsoft Edge, or ask your IT team for help.",
    "Chrome or Edge was not found; set CHROMIUM_PATH to its executable",
  );
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
        throw new AuthenticationError(
          BROWSER_TROUBLE,
          `Browser authorization setup failed: CDP ${method} returned ${JSON.stringify(message.error)}`,
        );
      }
      const result = message.result;
      return asRecord(result) ?? {};
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
  const params = asRecord(message.params);
  if (params === null) {
    return null;
  }
  const request = asRecord(params["request"]);
  if (request === null) {
    return null;
  }
  const requestUrl = request["url"];
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
      reject(new AuthenticationError(BROWSER_TROUBLE, "Could not reserve a debugging port"));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new AuthenticationError(BROWSER_TROUBLE, "Could not reserve a debugging port"));
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
  signal?: AbortSignal,
): Promise<AuthorizationResponse> {
  if (signal?.aborted) {
    throw abortError();
  }
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
    throw new AuthenticationError(
      BROWSER_TROUBLE,
      `Could not start the sign-in browser: ${browser}`,
    );
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
  // An aborted sign-in closes Edge at once, so Connect can be clicked again.
  const onAbort = (): void => {
    void terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const launchDeadline = performance.now() + 20_000;
    let debuggerUrl: string | null = null;
    while (true) {
      if (exited()) {
        throw new AuthenticationError(
          BROWSER_CLOSED,
          "Browser closed before Microsoft sign-in started",
        );
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const info = asRecord(await response.json());
        if (info === null) {
          throw new Error("Not a JSON object");
        }
        const webSocketDebuggerUrl = info["webSocketDebuggerUrl"];
        if (typeof webSocketDebuggerUrl !== "string") {
          throw new Error("Missing webSocketDebuggerUrl");
        }
        debuggerUrl = webSocketDebuggerUrl;
        break;
      } catch {
        if (performance.now() >= launchDeadline) {
          throw new AuthenticationError(
            BROWSER_TROUBLE,
            "Timed out starting the sign-in browser (20 s)",
          );
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
        throw new AuthenticationError(
          BROWSER_TROUBLE,
          "Browser authorization setup failed: Target.createTarget returned no targetId",
        );
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
        throw new AuthenticationError(
          BROWSER_TROUBLE,
          "Browser authorization setup failed: Target.attachToTarget returned no sessionId",
        );
      }
      await cdpCall(socket, counter, "Network.enable", {}, sessionId, events);
      await cdpCall(socket, counter, "Page.enable", {}, sessionId, events);
      await cdpCall(socket, counter, "Page.navigate", { url: authUri }, sessionId, events);
      const deadline = performance.now() + 300_000;
      while (true) {
        if (events.length > 0) {
          const response = events.shift();
          if (response === undefined) {
            throw new AuthenticationError(
              SIGN_IN_TIMED_OUT,
              "Timed out waiting for Microsoft sign-in (300 s)",
            );
          }
          return response;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new AuthenticationError(
            SIGN_IN_TIMED_OUT,
            "Timed out waiting for Microsoft sign-in (300 s)",
          );
        }
        let message: CdpMessage;
        try {
          message = await socket.recv(remaining);
        } catch (error) {
          if (error instanceof WebSocketTimeout) {
            throw new AuthenticationError(
              SIGN_IN_TIMED_OUT,
              "Timed out waiting for Microsoft sign-in (300 s)",
            );
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
    signal?.removeEventListener("abort", onAbort);
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
  let record: Record<string, unknown> | null = null;
  try {
    record = asRecord(JSON.parse(text));
  } catch {
    record = null;
  }
  if (record === null) {
    if (!response.ok) {
      throw new AuthenticationError(
        "Microsoft's sign-in service could not be reached. Check your internet connection, then click Connect again.",
        `Microsoft token request failed: HTTP ${response.status}`,
      );
    }
    throw new AuthenticationError(
      "Microsoft's sign-in service sent an unexpected reply. Click Connect to try again.",
      "Microsoft token endpoint returned an unreadable response",
    );
  }
  return record;
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

/**
 * The sign-in failure for one token response: the OAuth code picks the plain
 * text, and the raw description (with its AADSTS code) rides along as `detail`.
 */
function tokenResultError(result: Record<string, unknown>): AuthenticationError {
  const code = result["error"];
  const mapped = typeof code === "string" ? OAUTH_ERROR_TEXT[code] : undefined;
  return new AuthenticationError(mapped ?? SIGN_IN_FAILED, errorText(result));
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
  const record = asRecord(claims);
  if (record === null) {
    return null;
  }
  for (const name of ["preferred_username", "upn", "email", "name"]) {
    const value = record[name];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return null;
}


/** The access token cached under `key` with its absolute expiry, or null. */
function accessEntry(
  cache: Record<string, unknown>,
  key: string,
): { readonly token: string; readonly expiresAt: number } | null {
  const access = asRecord(cache["access"]);
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

/**
 * The per-user location the proxy used before the host app owned the cache; only
 * the one-time migration below reads it.
 */
function legacyTokenCacheFile(): string {
  return join(process.env["LOCALAPPDATA"] ?? homedir(), "M365CopilotProxy", "token-cache.json");
}

/**
 * The JSON token cache. The host app points `M365_CACHE_FILE` at its own userData
 * folder; otherwise the per-user application-data folder is used.
 */
export function tokenCacheFile(): string {
  const override = process.env["M365_CACHE_FILE"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return legacyTokenCacheFile();
}

/**
 * An install that predates the app owning its cache keeps the token file under
 * `%LOCALAPPDATA%\M365CopilotProxy`. Copy it once, so upgrading does not sign the
 * person out: the copy is exactly the JSON the proxy writes, and a stale or
 * unreadable file is ignored by the reader like any other.
 */
async function adoptLegacyTokenCache(cachePath: string): Promise<void> {
  const legacy = legacyTokenCacheFile();
  if (legacy === cachePath || existsSync(cachePath)) {
    return;
  }
  try {
    await writeFile(cachePath, await readFile(legacy, "utf8"), "utf8");
  } catch {
    // No legacy sign-in to adopt.
  }
}

/**
 * The sign-in browser's dedicated profile. It persists on purpose: Microsoft's
 * session cookies live here, so a repeat sign-in (after the token cache expired
 * or was revoked) completes without asking again. Kept beside the token cache —
 * `M365_PROFILE_DIR` overrides it — so both move with the host app's userData.
 */
function signInProfileDir(): string {
  const override = process.env["M365_PROFILE_DIR"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return join(dirname(tokenCacheFile()), "browser-profile");
}

/**
 * Every provider that has read the cache, so `signOut()` can clear the in-memory
 * copies too. Without this the running proxy keeps answering with the tokens it
 * already loaded and Sign out does nothing until pi restarts.
 */
const liveProviders = new Set<FileTokenProvider>();

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
    this.cachePath = tokenCacheFile();
    await mkdir(dirname(this.cachePath), { recursive: true });
    await adoptLegacyTokenCache(this.cachePath);
    liveProviders.add(this);
    this.cache = await this.load();
  }

  /** Forgets the cached tokens so the next call re-reads (a now empty) disk. */
  forget(): void {
    this.initialized = null;
    this.cache = {};
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
    return asRecord(parsed) ?? {};
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, JSON.stringify(this.cache), "utf8");
    } catch (error) {
      const detail = messageOf(error);
      throw new AuthenticationError(
        "pi could not save your Microsoft 365 sign-in. Ask your IT team to check that the app folder is writable.",
        `Could not write the token cache: ${detail}`,
      );
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
    let entries = asRecord(this.cache["access"]);
    if (entries === null) {
      entries = {};
      this.cache["access"] = entries;
    }
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

  private cached(key: string): string | null {
    const entry = accessEntry(this.cache, key);
    if (entry === null) {
      return null;
    }
    return entry.expiresAt > Date.now() / 1000 + 60 ? entry.token : null;
  }

  /**
   * Re-reads the cache file. `login()` and the proxy hold separate provider
   * instances, so a token one of them stored is invisible to the other until the
   * file is read again — the reference proxy re-reads its cache for the same reason.
   */
  private async reloadFromDisk(): Promise<void> {
    const loaded = await this.load();
    if (Object.keys(loaded).length > 0) {
      this.cache = loaded;
    }
  }

  private async interactive(
    scopes: readonly string[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const hasAccount = Boolean(this.cache["refresh_token"]);
    const [verifier, challenge] = pkce();
    const state = randomBytes(16).toString("base64url");
    const authUri = authorizeUrl(scopes, challenge, state, hasAccount ? null : "select_account");
    console.log("Complete Microsoft sign-in in the opened browser window.");
    // A persistent profile is the point: Edge keeps the Microsoft cookies, so the
    // next Connect (after a revoked token, say) completes without asking again.
    const profileDir = signInProfileDir();
    await mkdir(profileDir, { recursive: true });
    const authResponse = await raceAbort(
      captureAuthorizationResponse(authUri, profileDir, signal),
      signal,
    );
    if (signal?.aborted) {
      throw abortError();
    }
    if ("error" in authResponse) {
      throw new AuthenticationError(
        OAUTH_ERROR_TEXT[authResponse.error] ?? SIGN_IN_FAILED,
        `Microsoft sign-in failed: ${authResponse.error}`,
      );
    }
    if (authResponse.state !== state) {
      throw new AuthenticationError(
        "Microsoft sign-in could not be verified. Click Connect to try again.",
        "Microsoft sign-in returned an unexpected state",
      );
    }
    const result = await raceAbort(
      tokenRequest({
        client_id: CLIENT_ID,
        grant_type: "authorization_code",
        code: authResponse.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        scope: scopes.join(" "),
      }),
      signal,
    );
    if (typeof result["access_token"] !== "string") {
      throw tokenResultError(result);
    }
    return result;
  }

  /**
   * Cache-only token state for the `/healthz` probe: never refreshes, never opens
   * a browser, so a status check cannot start a sign-in.
   */
  async tokenStatus(scopes: readonly string[] = CHAT_SCOPES): Promise<{
    readonly valid: boolean;
    readonly refreshable: boolean;
    readonly secondsRemaining: number | null;
    readonly username: string | null;
  }> {
    await this.ready();
    // Read the file rather than the in-memory copy: the sign-in that just ran used
    // a different instance, and this is what makes the status leave "signing in".
    const cache = await this.load();
    const entry = accessEntry(cache, scopeKey(scopes));
    const username: unknown = cache["username"];
    // A refresh token on disk means the next request can silently refresh, even
    // while the cached access token's own window is nearly up.
    const refresh = cache["refresh_token"];
    return {
      valid: entry !== null && entry.expiresAt > Date.now() / 1000 + 60,
      refreshable: typeof refresh === "string" && refresh.length > 0,
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

  /**
   * A usable access token. `interactive` decides what happens without one: a chat
   * request passes `false` so it can never open a browser mid-turn, while Connect
   * passes `true` to run the sign-in.
   */
  async token(
    scopes: readonly string[] = CHAT_SCOPES,
    interactive = true,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.withLock(async () => {
      await this.ready();
      const key = scopeKey(scopes);
      let cached = this.cached(key);
      if (cached === null) {
        // `login()` runs on its own provider instance; pick up what it stored.
        await this.reloadFromDisk();
        cached = this.cached(key);
      }
      if (cached !== null) {
        return cached;
      }
      const refresh = this.cache["refresh_token"];
      if (typeof refresh === "string" && refresh) {
        const refreshed = await tokenRequest({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refresh,
          scope: scopes.join(" "),
        });
        const accessToken = refreshed["access_token"];
        if (typeof accessToken === "string") {
          await this.store(refreshed, key);
          return accessToken;
        }
        // The refresh token was revoked or expired; only a sign-in can fix it.
        if (!interactive) {
          throw tokenResultError(refreshed);
        }
      } else if (!interactive) {
        throw new AuthenticationError(SIGN_IN_REQUIRED, "No cached sign-in on disk to refresh");
      }
      const result = await this.interactive(scopes, signal);
      await this.store(result, key);
      const accessToken = result["access_token"];
      if (typeof accessToken !== "string") {
        throw tokenResultError(result);
      }
      return accessToken;
    });
  }
}

/**
 * Signs in, opening the sign-in browser when Microsoft needs it. Matches the
 * Python proxy's `login`; the caller only cares that it finishes or rejects.
 */
export async function login(options?: { readonly signal?: AbortSignal }): Promise<void> {
  const provider = new FileTokenProvider();
  await provider.token(CHAT_SCOPES, true, options?.signal);
}

/**
 * Signs out everywhere: the cached tokens, the cache file, and the dedicated
 * Edge profile whose cookies would otherwise sign the same account straight back
 * in. Live providers forget their copies so the running proxy stops answering.
 */
export async function signOut(): Promise<void> {
  for (const provider of liveProviders) {
    provider.forget();
  }
  await rm(tokenCacheFile(), { force: true });
  await rm(signInProfileDir(), { recursive: true, force: true });
}
