import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { M365CopilotStatus } from "../../contracts/ipc";
import { M365CopilotConnector } from "../../electron/platform/m365-copilot";
import { CHAT_SCOPES, scopeKey } from "../../src/m365/auth";

/**
 * The connector's state mapping, driven against real loopback HTTP servers but
 * never a browser: `start({ signIn: false })` takes the listen-only path, so a
 * run can never open Edge. Two shipped bugs live in exactly this mapping and had
 * no coverage:
 *   - a `/healthz` that reported `valid: false` for an expired access token even
 *     though a refresh token was on disk, so the UI said "waiting for sign-in"
 *     for an hour after a successful sign-in; and
 *   - a proxy that was already listening refusing to restart, so "Click Connect
 *     to try again" did nothing.
 * The proxy's own fixture (`src/m365/e2e.ts`) covers the HTTP contract but not
 * the connector's state mapping.
 */

const ACCESS_KEY = scopeKey(CHAT_SCOPES);

interface Stub {
  readonly port: number;
  readonly origin: string;
  close(): Promise<void>;
}

/** Binds a one-answer HTTP server on an ephemeral port and returns it. */
async function startStub(
  respond: (pathname: string) => { status: number; body?: string },
): Promise<Stub> {
  const server: Server = createServer((req, res) => {
    const { status, body } = respond(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body ?? "");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("stub server did not bind a TCP port");
  }
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** A free loopback port with nothing listening, for a connector that binds it itself. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address === null || typeof address === "string" ? 0 : address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Runs `body` with a throwaway temp dir and a clean token-cache seam, then
 * restores both. `M365_TEST_ACCESS_TOKEN` is cleared so the proxy answers from
 * the cache on disk rather than an injected fixture token.
 */
async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "m365-connector-"));
  const previousCache = process.env["M365_CACHE_FILE"];
  const previousToken = process.env["M365_TEST_ACCESS_TOKEN"];
  delete process.env["M365_TEST_ACCESS_TOKEN"];
  try {
    await body(dir);
  } finally {
    if (previousCache === undefined) {
      delete process.env["M365_CACHE_FILE"];
    } else {
      process.env["M365_CACHE_FILE"] = previousCache;
    }
    if (previousToken === undefined) {
      delete process.env["M365_TEST_ACCESS_TOKEN"];
    } else {
      process.env["M365_TEST_ACCESS_TOKEN"] = previousToken;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/** Writes the token cache the proxy's `/healthz` reads, and points the seam at it. */
async function writeCache(dir: string, cache: Record<string, unknown>): Promise<void> {
  const file = join(dir, "token-cache.json");
  await writeFile(file, JSON.stringify(cache), "utf8");
  process.env["M365_CACHE_FILE"] = file;
}

/** Starts the connector on a free port so it hosts the proxy it reports on. */
async function startOwned(
  dir: string,
): Promise<{ connector: M365CopilotConnector; status: M365CopilotStatus }> {
  const port = await freePort();
  const connector = new M365CopilotConnector({
    dataDir: dir,
    baseUrl: `http://127.0.0.1:${port}/v1`,
  });
  const status = await connector.start({ signIn: false });
  return { connector, status };
}

test("a valid cached token reports ready with the account and a countdown", async () => {
  await withTempDir(async (dir) => {
    await writeCache(dir, {
      username: "user@contoso.com",
      access: { [ACCESS_KEY]: { token: "fixture-access", expires_at: Date.now() / 1000 + 2400 } },
    });
    const { connector, status } = await startOwned(dir);
    try {
      expect(status.state).toBe("ready");
      expect(status.account).toBe("user@contoso.com");
      expect(status.minutesLeft).toBeGreaterThan(0);
      expect(status.managed).toBe(true);
      expect(status.models.length).toBeGreaterThan(0);
      expect(status.models).toContain("m365-copilot");
      expect(status.refreshable).toBe(false);
    } finally {
      connector.stop();
    }
  });
});

test("an expired access token with a refresh token on disk still reports ready", async () => {
  await withTempDir(async (dir) => {
    await writeCache(dir, {
      refresh_token: "fixture-refresh",
      username: "user@contoso.com",
      access: { [ACCESS_KEY]: { token: "expired-access", expires_at: Date.now() / 1000 - 10 } },
    });
    const { connector, status } = await startOwned(dir);
    try {
      // The regression: a refresh token means the next request works, so this must
      // NOT be "waiting-for-sign-in" for the hour the access token is already gone.
      expect(status.state).toBe("ready");
      expect(status.refreshable).toBe(true);
      expect(status.account).toBe("user@contoso.com");
      // The expired access token has no usable window left; no live countdown.
      expect(status.minutesLeft ?? 0).toBe(0);
    } finally {
      connector.stop();
    }
  });
});

test("no usable token reports waiting-for-sign-in with the next action", async () => {
  await withTempDir(async (dir) => {
    // No cache file at all — a signed-out proxy.
    process.env["M365_CACHE_FILE"] = join(dir, "token-cache.json");
    const { connector, status } = await startOwned(dir);
    try {
      expect(status.state).toBe("waiting-for-sign-in");
      expect(status.managed).toBe(true);
      expect(status.detail).toBeDefined();
      expect(status.detail).toMatch(/Click Connect/i);
    } finally {
      connector.stop();
    }
  });
});

test("nothing listening on the port reports stopped", async () => {
  await withTempDir(async (dir) => {
    const port = await freePort();
    const connector = new M365CopilotConnector({
      dataDir: dir,
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    const status = await connector.status();
    expect(status.state).toBe("stopped");
    expect(status.managed).toBe(false);
  });
});

test("a port already in use reports an error naming the port instead of rejecting", async () => {
  await withTempDir(async (dir) => {
    // A foreign listener that answers neither /healthz nor /models, so the launch
    // must try to bind the port itself and hit EADDRINUSE.
    const occupied = await startStub(() => ({ status: 404 }));
    try {
      const connector = new M365CopilotConnector({
        dataDir: dir,
        baseUrl: `${occupied.origin}/v1`,
      });
      const status = await connector.start({ signIn: false });
      expect(status.state).toBe("error");
      expect(status.detail).toBeDefined();
      expect(status.detail).toContain(String(occupied.port));
    } finally {
      await occupied.close();
    }
  });
});

test("a managed proxy whose own health check fails reports error, not an external ready", async () => {
  await withTempDir(async (dir) => {
    // The connector hosts the proxy, so a failing `/healthz` is its own sign-in
    // problem. Point the token cache under a path whose parent is a file so the
    // proxy's own `/healthz` cannot read its state and answers 500 — its
    // `/v1/models` would still answer 200, which is why falling through to the
    // "already running" probe must not happen.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    process.env["M365_CACHE_FILE"] = join(blocker, "token-cache.json");
    const { connector, status } = await startOwned(dir);
    try {
      expect(status.managed).toBe(true);
      expect(status.state).toBe("error");
      expect(status.detail).toBeDefined();
      expect(status.detail).toMatch(/connection check failed/i);
    } finally {
      connector.stop();
    }
  });
});
