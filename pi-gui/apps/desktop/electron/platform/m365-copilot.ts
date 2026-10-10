import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { M365CopilotStatus } from "../../contracts/ipc";
import {
  M365_COPILOT_CONTEXT_WINDOW,
  M365_COPILOT_MODEL_ID,
  M365_COPILOT_PROVIDER_ID,
} from "../../contracts/ipc";

/**
 * Starts and watches the bundled Microsoft 365 Copilot proxy
 * (resources/m365-copilot-proxy, the `m365copilotproxy` Python package). The proxy
 * opens a dedicated Edge/Chrome window for sign-in, captures the Copilot web token,
 * and serves an OpenAI-compatible API on 127.0.0.1 that pi uses as the `m365-copilot`
 * provider. It also routes fenced ```bash / ```powershell blocks to the harness's
 * shell tool, so M365 can drive real tool loops.
 *
 * A proxy the person already runs on the same URL is detected and used as is.
 */

const DEFAULT_PORT = 8000;
const LOG_LINES = 40;

export interface M365CopilotConnectorOptions {
  /** Folder that contains the `m365copilotproxy` package. */
  readonly proxyDir: string;
  /** Writable folder for the proxy's MSAL token cache. */
  readonly dataDir: string;
  readonly platform: NodeJS.Platform;
  /** Overrides the proxy URL, e.g. for a proxy run by hand on another port. */
  readonly baseUrl?: string;
}

interface PythonCommand {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export class M365CopilotConnector {
  private child: ChildProcess | undefined;
  private lastError: string | undefined;
  private python: PythonCommand | null | undefined;
  private starting: Promise<M365CopilotStatus> | undefined;
  private readonly log: string[] = [];
  private generation = 0;
  private readonly pending = { stdout: "", stderr: "" };
  readonly baseUrl: string;

  constructor(private readonly options: M365CopilotConnectorOptions) {
    this.baseUrl = (options.baseUrl ?? `http://127.0.0.1:${DEFAULT_PORT}/v1`).replace(/\/+$/, "");
  }

  async status(): Promise<M365CopilotStatus> {
    const base = {
      baseUrl: this.baseUrl,
      providerId: M365_COPILOT_PROVIDER_ID,
      modelId: M365_COPILOT_MODEL_ID,
      contextWindow: M365_COPILOT_CONTEXT_WINDOW,
      managed: this.isChildRunning(),
    };
    const health = await this.probe();
    if (health.kind === "token") {
      return health.valid
        ? {
            ...base,
            state: "ready",
            ...(health.minutesLeft !== undefined ? { minutesLeft: health.minutesLeft } : {}),
          }
        : {
            ...base,
            state: "waiting-for-sign-in",
            detail:
              "Sign in to Microsoft 365 Copilot in the Edge window that opened. If it is already signed in, click the Copilot message box and type one character.",
          };
    }
    if (health.kind === "openai") {
      return { ...base, state: "ready" };
    }
    if (this.isChildRunning()) {
      return { ...base, state: "starting", detail: "Starting the Copilot connection…" };
    }
    if (this.python === null) {
      return {
        ...base,
        state: "python-missing",
        detail:
          "The Copilot connection needs Python 3.14 or newer. Click Get Python (a free Microsoft Store install, no admin rights needed), then click Connect again.",
      };
    }
    if (this.lastError) {
      return { ...base, state: "error", detail: this.lastError, log: this.log.slice() };
    }
    return { ...base, state: "stopped" };
  }

  /** Concurrent Connect clicks share one launch instead of spawning two proxies. */
  start(): Promise<M365CopilotStatus> {
    this.starting ??= this.launch().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async launch(): Promise<M365CopilotStatus> {
    const current = await this.probe();
    if (current.kind !== "none" || this.isChildRunning()) {
      return this.status();
    }
    this.lastError = undefined;
    const generation = this.generation;
    this.python = await findPython(this.options.platform);
    if (!this.python || generation !== this.generation) {
      return this.status();
    }
    await mkdir(this.options.dataDir, { recursive: true });
    if (generation !== this.generation) {
      return this.status();
    }
    const port = portFromBaseUrl(this.baseUrl);
    const child = spawn(
      this.python.command,
      [...this.python.prefixArgs, "-m", "m365copilotproxy", "serve", "--port", port],
      {
        // The proxy keeps its MSAL token cache under dataDir.
        cwd: this.options.dataDir,
        env: {
          ...process.env,
          PYTHONPATH: this.options.proxyDir,
          PYTHONUNBUFFERED: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          M365_CACHE_FILE: join(this.options.dataDir, "msal-cache.json"),
          M365_TIME_ZONE:
            process.env.M365_TIME_ZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    this.pending.stdout = "";
    this.pending.stderr = "";
    const record = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const lines = (this.pending[stream] += chunk.toString("utf8")).split(/\r?\n/);
      this.pending[stream] = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) this.log.push(line);
      }
      this.log.splice(0, Math.max(0, this.log.length - LOG_LINES));
    };
    child.stdout?.on("data", record("stdout"));
    child.stderr?.on("data", record("stderr"));
    child.once("error", (error) => {
      this.lastError = `Could not start the Copilot connection: ${error.message}`;
    });
    // 'close' fires after stdio drains; 'exit' can fire before the last lines arrive.
    child.once("close", (code) => {
      if (this.child === child) this.child = undefined;
      if (!this.lastError && code !== 0 && code !== null) {
        this.lastError = describeExit(code, this.log, port);
      }
    });
    return this.status();
  }

  stop(): void {
    this.generation += 1;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.kill();
    }
  }

  private isChildRunning(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  private async probe(): Promise<
    | { readonly kind: "token"; readonly valid: boolean; readonly minutesLeft?: number }
    | { readonly kind: "openai" }
    | { readonly kind: "none" }
  > {
    const origin = this.baseUrl.replace(/\/v1$/, "");
    try {
      // Plain fetch, not Electron's net: loopback traffic must not go through a corporate proxy.
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        try {
          const body = (await response.json()) as {
            token?: { valid?: unknown; seconds_remaining?: unknown };
          };
          const seconds =
            typeof body.token?.seconds_remaining === "number"
              ? body.token.seconds_remaining
              : undefined;
          return {
            kind: "token",
            valid: body.token?.valid === true,
            ...(seconds !== undefined ? { minutesLeft: Math.floor(seconds / 60) } : {}),
          };
        } catch {
          // A non-JSON /healthz: fall through to the /models check below.
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

function describeExit(code: number, log: readonly string[], port: string): string {
  const output = log.join("\n");
  if (/msedge(\.exe)?/i.test(output) && /No such file|cannot find|not found/i.test(output)) {
    return "Microsoft Edge is needed to sign in to Copilot, but it was not found. Install Edge, then click Connect again.";
  }
  if (/Address already in use|Only one usage of each socket address/i.test(output)) {
    return `Another program is using the Copilot connection's port (${port}). Close it, or set PI_GUI_M365_PROXY_URL to a different address.`;
  }
  return `The Copilot connection stopped unexpectedly (exit code ${code}). Details are below.`;
}

function portFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).port || String(DEFAULT_PORT);
  } catch {
    return String(DEFAULT_PORT);
  }
}

/** Finds a Python 3.14+ interpreter: the `py` launcher first on Windows, then python/python3. */
async function findPython(platform: NodeJS.Platform): Promise<PythonCommand | null> {
  const candidates: PythonCommand[] =
    platform === "win32"
      ? [
          { command: "py", prefixArgs: ["-3.14"] },
          { command: "py", prefixArgs: ["-3"] },
          { command: "python", prefixArgs: [] },
          { command: "python3", prefixArgs: [] },
        ]
      : [
          { command: "python3.14", prefixArgs: [] },
          { command: "python3", prefixArgs: [] },
          { command: "python", prefixArgs: [] },
        ];
  for (const candidate of candidates) {
    if (await isSupportedPython(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isSupportedPython(candidate: PythonCommand): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      candidate.command,
      [...candidate.prefixArgs, "-c", "import sys; print(int(sys.version_info >= (3, 14)))"],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => resolve(!error && stdout.trim() === "1"),
    );
  });
}
