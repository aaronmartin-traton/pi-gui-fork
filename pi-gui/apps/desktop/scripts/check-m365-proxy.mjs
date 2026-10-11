/**
 * Runs the vendored M365 proxy's end-to-end fixture.
 *
 * The proxy is stdlib-only Python, so this is the only thing that exercises it —
 * the Electron lane never starts it (it needs a Microsoft account). Skips with a
 * note when the host has no Python 3.12+, so the core lane still runs on hosts
 * that only have the app's bundled runtime.
 */

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const proxyDir = join(desktopDir, "resources", "m365-copilot-proxy");

const CANDIDATES = [
  { command: "python3", prefix: [] },
  { command: "python", prefix: [] },
  { command: "py", prefix: ["-3"] },
];

async function isSupported({ command, prefix }) {
  try {
    const { stdout } = await run(
      command,
      [...prefix, "-c", "import sys; print(int(sys.version_info >= (3, 12)))"],
      { timeout: 10_000, windowsHide: true },
    );
    return stdout.trim() === "1";
  } catch {
    return false;
  }
}

let interpreter;
for (const candidate of CANDIDATES) {
  if (await isSupported(candidate)) {
    interpreter = candidate;
    break;
  }
}

if (!interpreter) {
  console.log("m365 proxy e2e: skipped (no Python 3.12+ on PATH)");
  process.exit(0);
}

try {
  const { stdout } = await run(
    interpreter.command,
    [...interpreter.prefix, "-m", "m365copilotproxy", "e2e"],
    {
      cwd: proxyDir,
      env: { ...process.env, PYTHONPATH: proxyDir, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 180_000,
      windowsHide: true,
    },
  );
  console.log(stdout.trim().split("\n").at(-1) ?? "m365 proxy e2e: passed");
} catch (error) {
  process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}`);
  console.error(`m365 proxy e2e failed (exit ${error.code ?? "?"})`);
  process.exit(1);
}
