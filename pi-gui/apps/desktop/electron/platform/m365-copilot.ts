import { type Server } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { M365CopilotStatus } from "../../contracts/ipc";
import {
  M365_COPILOT_CONTEXT_WINDOW,
  M365_COPILOT_MODEL_ID,
  M365_COPILOT_PROVIDER_ID,
} from "../../contracts/ipc";
import { AuthenticationError, login, signOut as clearTokenCache } from "../../src/m365/auth.js";
import { MODEL_IDS } from "../../src/m365/catalog.js";
import { asRecord, isRecord, messageOf } from "../../src/m365/guards.js";
import { ProxyApplication, createHttpServer } from "../../src/m365/server.js";

/**
 * Hosts the Microsoft 365 Copilot proxy in-process.
 *
 * The proxy used to be a vendored Python package (`resources/m365-copilot-proxy`)
 * launched as a child process next to a bundled CPython 3.14. It is now a
 * TypeScript module in `src/m365`, so the app starts an `node:http` server bound
 * to 127.0.0.1 in this process: no interpreter, no subprocess supervision, no
 * "runtime missing" state, and a smaller installer.
 *
 * The proxy signs in with a dedicated Edge profile, captures the Copilot web
 * token, and serves an OpenAI-compatible API that pi uses as the `m365-copilot`
 * provider. It also routes fenced ```bash / ```powershell blocks to the harness's
 * shell tool, so M365 can drive real tool loops.
 *
 * A proxy the person already runs on the same URL is detected and used as is.
 */

const DEFAULT_PORT = 8000;

export interface M365CopilotConnectorOptions {
  /** Folder that holds the proxy's token cache and sign-in browser profile. */
  readonly dataDir: string;
  /** Overrides the proxy URL, e.g. for a proxy run by hand on another port. */
  readonly baseUrl?: string;
}

/** What a probe of the proxy URL found. */
type ProxyHealth =
  | {
      readonly kind: "token";
      readonly valid: boolean;
      readonly refreshable: boolean;
      readonly minutesLeft?: number;
      readonly account?: string;
    }
  | { readonly kind: "openai" }
  | { readonly kind: "error"; readonly detail: string }
  | { readonly kind: "none" };

export class M365CopilotConnector {
  private server: Server | undefined;
  private starting: Promise<M365CopilotStatus> | undefined;
  private signingIn: Promise<void> | undefined;
  private signInAbort: AbortController | undefined;
  private signInError: string | undefined;
  /** True while the port is being bound, so a concurrent status() reports `starting`. */
  private binding = false;
  private generation = 0;
  readonly baseUrl: string;

  constructor(private readonly options: M365CopilotConnectorOptions) {
    this.baseUrl = (options.baseUrl ?? `http://127.0.0.1:${DEFAULT_PORT}/v1`).replace(/\/+$/, "");
    // The token provider reads this seam when it first touches the cache, so the
    // credentials live under the app's userData instead of %LOCALAPPDATA%.
    process.env["M365_CACHE_FILE"] ??= join(options.dataDir, "token-cache.json");
  }

  async status(): Promise<M365CopilotStatus> {
    return this.statusFrom(await this.probe());
  }

  /**
   * Connect. Binds the port if needed and, unless `signIn: false`, starts a
   * sign-in when the token is unusable — so a click after a failed sign-in, an
   * Edge timeout or an expired token retries instead of only re-reading status.
   */
  start(options: { readonly signIn?: boolean } = {}): Promise<M365CopilotStatus> {
    const signIn = options.signIn !== false;
    // Concurrent Connect clicks share one launch instead of binding the port twice.
    const launched = (this.starting ??= this.launch().finally(() => {
      this.starting = undefined;
    }));
    return signIn ? launched.then(() => this.signInIfNeeded()) : launched;
  }

  /**
   * Opens Edge to sign the account in. Connect must not block on it: the renderer
   * polls the status until the token lands.
   */
  private beginSignIn(): void {
    if (this.signingIn !== undefined) {
      return;
    }
    const controller = new AbortController();
    this.signInAbort = controller;
    const pending = login({ signal: controller.signal })
      .then(() => {
        this.signInError = undefined;
      })
      .catch((error: unknown) => {
        // stop() aborts the sign-in on purpose; that is not a failure to report.
        if (controller.signal.aborted) {
          return;
        }
        // AuthenticationError.message is already a plain sentence ending in the next
        // action; `.detail` is the raw AADSTS/browser text that only a support log wants.
        if (error instanceof AuthenticationError) {
          this.signInError = error.message;
          console.error("[m365] Microsoft sign-in failed", error.detail ?? error.message);
          return;
        }
        // Without this the renderer would poll "Connecting…" forever.
        this.signInError = `Microsoft sign-in did not finish (${messageOf(error)}). Click Connect to try again.`;
        console.error("[m365] Microsoft sign-in failed", error);
      })
      .finally(() => {
        if (this.signInAbort === controller) {
          this.signInAbort = undefined;
          this.signingIn = undefined;
        }
      });
    this.signingIn = pending;
  }

  /** Starts a sign-in when the proxy is up, its token is unusable and none is running. */
  private async signInIfNeeded(): Promise<M365CopilotStatus> {
    const health = await this.probe();
    if (
      health.kind === "token" &&
      !health.valid &&
      !health.refreshable &&
      this.signingIn === undefined
    ) {
      this.signInError = undefined;
      this.beginSignIn();
    }
    return this.statusFrom(health);
  }

  /** Stops the proxy we started and cancels an in-flight sign-in. */
  stop(): void {
    this.generation += 1;
    this.abortSignIn();
    this.signInError = undefined;
    const server = this.server;
    this.server = undefined;
    server?.close();
  }

  /**
   * Cancel: aborts an in-flight sign-in and stops the status poll, without
   * closing the proxy port. A Copilot that is already registered keeps working —
   * the next Connect starts a sign-in again instead of finding a dead port.
   */
  async cancelSignIn(): Promise<M365CopilotStatus> {
    this.abortSignIn();
    this.signInError = undefined;
    return this.statusFrom(await this.probe());
  }

  /**
   * Forgets the stored Microsoft account, so the next Connect can sign another
   * one in. The proxy keeps running: it reports `waiting-for-sign-in` until then.
   */
  async signOut(): Promise<void> {
    this.abortSignIn();
    try {
      await clearTokenCache();
      this.signInError = undefined;
    } catch (error) {
      // AuthenticationError.message is already a plain sentence with the next step.
      this.signInError =
        error instanceof AuthenticationError
          ? error.message
          : `Microsoft sign-out did not finish (${messageOf(error)}). Click Connect to sign in again.`;
      console.error("[m365] Microsoft sign-out failed", error);
    }
  }

  /**
   * An in-flight sign-in holds an Edge window open for minutes; a person who
   * asked to cancel, disconnect or switch account must not be left waiting on it.
   */
  private abortSignIn(): void {
    this.signInAbort?.abort();
    this.signInAbort = undefined;
    this.signingIn = undefined;
  }

  private async launch(): Promise<M365CopilotStatus> {
    const port = portFromBaseUrl(this.baseUrl);
    try {
      const current = await this.probe();
      // An external proxy is used as is, and a port we already bound needs nothing.
      if (current.kind === "openai" || this.server !== undefined) {
        return this.statusFrom(current);
      }
      this.signInError = undefined;
      try {
        await mkdir(this.options.dataDir, { recursive: true });
      } catch (error) {
        return {
          ...this.baseStatus(),
          state: "error",
          detail: `pi could not save your Microsoft 365 sign-in on this computer (${messageOf(error)}). Check that the disk is not full, then click Connect again.`,
        };
      }
      const generation = this.generation;
      // A fresh application per launch: a reused one would carry the previous
      // account's conversations, exhaustion records and cached token provider
      // across Disconnect/sign-out/Connect.
      const server = createHttpServer(new ProxyApplication());
      this.server = server;
      this.binding = true;
      let failure: unknown;
      try {
        await new Promise<void>((resolve, reject) => {
          onError(server, reject);
          server.listen(port, "127.0.0.1", () => resolve());
        });
      } catch (error) {
        failure = error;
      } finally {
        this.binding = false;
      }
      if (failure !== undefined) {
        // A failed listen must not leave a half-started server behind.
        if (this.server === server) {
          this.server = undefined;
        }
        if (generation !== this.generation) {
          return this.statusFrom({ kind: "none" });
        }
        return { ...this.baseStatus(), state: "error", detail: startFailureDetail(failure, port) };
      }
      if (generation !== this.generation && this.server === undefined) {
        // stop() closed the port while we were binding.
        return this.statusFrom({ kind: "none" });
      }
      return this.statusFrom(await this.probe());
    } catch (error) {
      return { ...this.baseStatus(), state: "error", detail: startFailureDetail(error, port) };
    }
  }

  /** Fields every state shares, so a failed start still carries the provider wiring. */
  private baseStatus(): Omit<M365CopilotStatus, "state"> {
    return {
      baseUrl: this.baseUrl,
      providerId: M365_COPILOT_PROVIDER_ID,
      modelId: M365_COPILOT_MODEL_ID,
      contextWindow: M365_COPILOT_CONTEXT_WINDOW,
      // Only a proxy this connector started is stopped on quit; an external one is left alone.
      managed: this.server !== undefined,
      // The proxy maps model ids to M365 tones/scenarios; register the whole catalog
      // so the picker offers them instead of the single "m365-copilot" alias.
      models: MODEL_IDS,
    };
  }

  private statusFrom(health: ProxyHealth): M365CopilotStatus {
    const base = this.baseStatus();
    if (this.binding) {
      return {
        ...base,
        state: "starting",
        detail: "Starting the Microsoft 365 Copilot connection…",
      };
    }
    if (health.kind === "error") {
      return { ...base, state: "error", detail: health.detail };
    }
    if (health.kind === "token") {
      const token: Omit<M365CopilotStatus, "state"> = {
        ...base,
        refreshable: health.refreshable,
        ...(health.account === undefined ? {} : { account: health.account }),
      };
      // A refresh token is enough: the proxy renews the access token on the next request.
      if (health.valid || health.refreshable) {
        return {
          ...token,
          state: "ready",
          ...(health.minutesLeft === undefined ? {} : { minutesLeft: health.minutesLeft }),
        };
      }
      if (this.signingIn !== undefined) {
        return {
          ...token,
          state: "signing-in",
          detail: "Sign in to Microsoft 365 in the Edge window that is open, then come back to pi.",
        };
      }
      if (this.signInError !== undefined) {
        return { ...token, state: "error", detail: this.signInError };
      }
      return {
        ...token,
        state: "waiting-for-sign-in",
        detail: "Click Connect, then sign in to Microsoft 365 in the Edge window that opens.",
      };
    }
    if (health.kind === "openai") {
      return {
        ...base,
        state: "ready",
        detail:
          "Microsoft 365 Copilot is already running on this computer, started outside pi — pi cannot tell whether it is signed in. If replies fail, sign in there.",
      };
    }
    return { ...base, state: "stopped" };
  }

  private async probe(): Promise<ProxyHealth> {
    const origin = this.baseUrl.replace(/\/v1$/, "");
    try {
      // Plain fetch, not Electron's net: loopback traffic must not go through a corporate proxy.
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const token = tokenState(await response.json());
        if (token !== null) {
          return {
            kind: "token",
            valid: token.valid,
            refreshable: token.refreshable,
            ...(token.secondsRemaining === null
              ? {}
              : { minutesLeft: Math.floor(token.secondsRemaining / 60) }),
            ...(token.username === null ? {} : { account: token.username }),
          };
        }
      } else if (this.server !== undefined) {
        // We started this proxy, so its own /healthz failing is a real
        // sign-in/token-cache problem. Falling through to /models would report an
        // unmanaged "already running" proxy and hide the failure.
        const reason = await healthFailureDetail(response);
        return {
          kind: "error",
          detail: `The Microsoft 365 Copilot connection check failed: ${reason} Click Connect to try again.`,
        };
      } else {
        await response.body?.cancel();
      }
      // Another OpenAI-compatible M365 proxy without a JSON /healthz.
      const models = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
      if (models.ok) {
        return { kind: "openai" };
      }
      await models.body?.cancel();
      return { kind: "none" };
    } catch {
      return { kind: "none" };
    }
  }
}

/** Reads `{ token: { valid, refreshable, seconds_remaining, username } }` from a `/healthz` body. */
function tokenState(body: unknown): {
  readonly valid: boolean;
  readonly refreshable: boolean;
  readonly secondsRemaining: number | null;
  readonly username: string | null;
} | null {
  if (!isRecord(body) || !("token" in body)) {
    return null;
  }
  const token: unknown = body.token;
  if (!isRecord(token)) {
    return null;
  }
  const valid = "valid" in token && token.valid === true;
  const refreshable = "refreshable" in token && token.refreshable === true;
  const secondsRemaining =
    "seconds_remaining" in token && typeof token.seconds_remaining === "number"
      ? token.seconds_remaining
      : null;
  const username =
    "username" in token && typeof token.username === "string" ? token.username : null;
  return { valid, refreshable, secondsRemaining, username };
}

/** Resolves once `listening` fires, or rejects on the first socket error. */
function onError(server: Server, reject: (reason: unknown) => void): void {
  const onErr = (error: unknown) => reject(error);
  server.once("error", onErr);
  server.once("listening", () => server.removeListener("error", onErr));
}

/** The reason a managed proxy's own `/healthz` failed: its JSON error, or the status. */
async function healthFailureDetail(response: Response): Promise<string> {
  try {
    const error = asRecord(asRecord(await response.json())?.["error"]);
    const message = error?.["message"];
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  } catch {
    // Not JSON; fall through to the status line.
  }
  return `HTTP ${response.status}.`;
}

/** What to tell a coworker when the port never opened. */
function startFailureDetail(error: unknown, port: number): string {
  const code = errorCode(error);
  const reason = messageOf(error);
  if (code === "EADDRINUSE" || reason.includes("EADDRINUSE")) {
    return `Port ${port} is already in use, so Microsoft 365 Copilot cannot start. Close the program using it (or the other copy of pi) and click Connect again.`;
  }
  return `Microsoft 365 Copilot could not start (${reason}). Click Connect to try again.`;
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error) || !("code" in error)) {
    return undefined;
  }
  const code: unknown = error.code;
  return typeof code === "string" ? code : undefined;
}

function portFromBaseUrl(baseUrl: string): number {
  try {
    const port = Number(new URL(baseUrl).port);
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}
