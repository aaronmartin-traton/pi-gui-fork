import { type Server } from "node:http";
import { mkdir } from "node:fs/promises";
import type { M365CopilotStatus } from "../../contracts/ipc";
import {
  M365_COPILOT_CONTEXT_WINDOW,
  M365_COPILOT_MODEL_ID,
  M365_COPILOT_PROVIDER_ID,
} from "../../contracts/ipc";
import { login } from "../../src/m365/auth.js";
import { modelsResponse } from "../../src/m365/catalog.js";
import { createHttpServer } from "../../src/m365/server.js";

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
  /** Writable folder for the proxy's token cache. */
  readonly dataDir: string;
  /** Overrides the proxy URL, e.g. for a proxy run by hand on another port. */
  readonly baseUrl?: string;
}

export class M365CopilotConnector {
  private server: Server | undefined;
  private starting: Promise<M365CopilotStatus> | undefined;
  private signingIn: Promise<void> | undefined;
  private signInError: string | undefined;
  private generation = 0;
  readonly baseUrl: string;

  constructor(private readonly options: M365CopilotConnectorOptions) {
    this.baseUrl = (options.baseUrl ?? `http://127.0.0.1:${DEFAULT_PORT}/v1`).replace(/\/+$/, "");
  }

  async status(): Promise<M365CopilotStatus> {
    const health = await this.probe();
    const base = {
      baseUrl: this.baseUrl,
      providerId: M365_COPILOT_PROVIDER_ID,
      modelId: M365_COPILOT_MODEL_ID,
      contextWindow: M365_COPILOT_CONTEXT_WINDOW,
      // Only a proxy this connector started is stopped on quit; an external one is left alone.
      managed: this.server !== undefined,
      // The proxy maps model ids to M365 tones/scenarios; register the whole catalog
      // so the picker offers them instead of the single "m365-copilot" alias.
      models: modelsResponse().data.map((model) => model.id),
      ...(health.kind === "token" && health.account !== undefined
        ? { account: health.account }
        : {}),
    };
    if (health.kind === "token") {
      return health.valid
        ? {
            ...base,
            state: "ready",
            ...(health.minutesLeft !== undefined ? { minutesLeft: health.minutesLeft } : {}),
          }
        : {
            ...base,
            state: this.signInError === undefined ? "waiting-for-sign-in" : "error",
            detail:
              this.signInError === undefined
                ? "Sign in to Microsoft 365 Copilot in the Edge window that opened. If it is already signed in, click the Copilot message box and type one character."
                : `Microsoft sign-in did not finish (${this.signInError}). Click Connect to try again.`,
          };
    }
    if (health.kind === "openai") {
      return { ...base, state: "ready" };
    }
    return { ...base, state: "stopped" };
  }

  /** Concurrent Connect clicks share one launch instead of binding the port twice. */
  start(): Promise<M365CopilotStatus> {
    this.starting ??= this.launch().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async launch(): Promise<M365CopilotStatus> {
    const current = await this.probe();
    if (current.kind !== "none" || this.server) {
      return this.status();
    }
    this.signInError = undefined;
    await mkdir(this.options.dataDir, { recursive: true });
    const generation = this.generation;
    if (generation !== this.generation) {
      return this.status();
    }
    const port = portFromBaseUrl(this.baseUrl);
    const server = createHttpServer();
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      onError(server, reject);
      server.listen(port, "127.0.0.1", () => resolve());
    }).catch((error: unknown) => {
      // A failed listen must not leave a half-started server behind.
      if (this.server === server) this.server = undefined;
      throw error;
    });
    if (generation !== this.generation && !this.server) {
      return this.status();
    }
    const status = await this.status();
    if (status.state === "waiting-for-sign-in") {
      this.beginSignIn();
    }
    return status;
  }

  /**
   * Opens Edge to sign the account in. Connect must not block on it: the renderer
   * polls the status until the token lands.
   */
  private beginSignIn(): void {
    this.signingIn ??= login()
      .then(() => {
        this.signInError = undefined;
      })
      .catch((error: unknown) => {
        // Without this the renderer would poll "Connecting…" forever.
        this.signInError = error instanceof Error ? error.message : String(error);
        console.error("[m365] Microsoft sign-in failed", error);
      })
      .finally(() => {
        this.signingIn = undefined;
      });
  }

  stop(): void {
    this.generation += 1;
    const server = this.server;
    this.server = undefined;
    server?.close();
  }

  private async probe(): Promise<
    | {
        readonly kind: "token";
        readonly valid: boolean;
        readonly minutesLeft?: number;
        readonly account?: string;
      }
    | { readonly kind: "openai" }
    | { readonly kind: "none" }
  > {
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
            ...(token.secondsRemaining !== null
              ? { minutesLeft: Math.floor(token.secondsRemaining / 60) }
              : {}),
            ...(token.username !== null ? { account: token.username } : {}),
          };
        }
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

/** Reads `{ token: { valid, seconds_remaining, username } }` from a `/healthz` body. */
function tokenState(body: unknown): {
  readonly valid: boolean;
  readonly secondsRemaining: number | null;
  readonly username: string | null;
} | null {
  if (typeof body !== "object" || body === null || !("token" in body)) {
    return null;
  }
  const token: unknown = body.token;
  if (typeof token !== "object" || token === null) {
    return null;
  }
  const valid = "valid" in token && token.valid === true;
  const secondsRemaining =
    "seconds_remaining" in token && typeof token.seconds_remaining === "number"
      ? token.seconds_remaining
      : null;
  const username =
    "username" in token && typeof token.username === "string" ? token.username : null;
  return { valid, secondsRemaining, username };
}

/** Resolves once `listening` fires, or rejects on the first socket error. */
function onError(server: Server, reject: (reason: unknown) => void): void {
  const onErr = (error: unknown) => reject(error);
  server.once("error", onErr);
  server.once("listening", () => server.removeListener("error", onErr));
}

function portFromBaseUrl(baseUrl: string): number {
  try {
    const port = Number(new URL(baseUrl).port);
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}
