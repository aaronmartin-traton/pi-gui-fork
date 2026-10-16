/**
 * Runs the vendored M365 proxy's end-to-end fixture.
 *
 * The proxy is TypeScript (`src/m365`), so this bundles `src/m365/e2e.ts` with
 * esbuild — already a repo dependency, so a healthy check needs nothing beyond
 * Node — and runs the bundle. The Electron lane never starts the proxy itself
 * (it needs a Microsoft account), so this is the only automated exercise of the
 * chat turn, shell routing, uploads, retries and priority exhaustion.
 *
 * Nothing is skipped when a host lacks Python: there is no Python any more.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build as esbuildBuild } from "esbuild";

const run = promisify(execFile);
const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(desktopDir, "src", "m365", "e2e.ts");

/** Bundle the TypeScript fixture through esbuild's platform-aware JS API. */
async function bundle(output) {
  await esbuildBuild({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    logLevel: "warning",
  });
}

const temp = await mkdtemp(join(tmpdir(), "m365-e2e-"));
try {
  await bundle(join(temp, "e2e.mjs"));
  const { stdout } = await run(process.execPath, [join(temp, "e2e.mjs")], {
    timeout: 300_000,
    env: { ...process.env, M365_E2E_QUIET: "1" },
  });
  const line = stdout.trim().split("\n").at(-1) ?? "";
  if (!line.startsWith("E2E PASS")) {
    process.stderr.write(stdout);
    console.error(`m365 proxy e2e failed: ${line || "no output"}`);
    process.exit(1);
  }
  console.log(line);
} catch (error) {
  const detail = /** @type {{stdout?: string; stderr?: string; code?: number}} */ (error);
  process.stderr.write(detail?.stdout ?? "");
  process.stderr.write(detail?.stderr ?? "");
  console.error(`m365 proxy e2e failed (exit ${detail?.code ?? "?"})`);
  process.exit(1);
} finally {
  await rm(temp, { recursive: true, force: true });
}
