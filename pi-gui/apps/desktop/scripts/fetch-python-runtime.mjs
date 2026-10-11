/**
 * Downloads the relocatable CPython that the packaged app carries, and copies the
 * bundled `m365copilotproxy` package inside it.
 *
 * The proxy is stdlib-only, so the embeddable distribution is enough: no pip, no
 * site-packages, nothing to install on the person's machine. `python.exe` plus the
 * proxy package in the same folder means `python.exe -m m365copilotproxy serve`
 * works with no `PYTHONPATH` (the embeddable `._pth` puts the exe folder on the path
 * and ignores `PYTHONPATH`).
 *
 * Usage: node scripts/fetch-python-runtime.mjs [--platform win32] [--force]
 * Output: resources/python/  (gitignored; built into the Windows installer)
 */

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const runtimeDir = join(desktopDir, "resources", "python");
const proxyDir = join(desktopDir, "resources", "m365-copilot-proxy");

const PYTHON_VERSION = "3.12.8";

function targetPlatform(argv) {
  const index = argv.indexOf("--platform");
  const value = index === -1 ? process.platform : argv[index + 1];
  if (value !== "win32") {
    throw new Error(`Only the Windows runtime is bundled (got ${value})`);
  }
  return value;
}

function downloadUrl(platform) {
  if (platform === "win32") {
    return `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
  }
  throw new Error(`No embeddable distribution for ${platform}`);
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

/** `unzip` on POSIX, PowerShell on Windows (neither ships everywhere else). */
async function extract(zipPath, destination) {
  if (process.platform === "win32") {
    await run("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destination}' -Force`,
    ]);
    return;
  }
  await run("unzip", ["-o", "-q", zipPath, "-d", destination]);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const platform = targetPlatform(process.argv.slice(2));
  const force = process.argv.includes("--force");
  const stamp = join(runtimeDir, "RUNTIME.json");
  if (!force && (await exists(stamp))) {
    console.log(`Python runtime already present at ${runtimeDir} (use --force to refetch)`);
    return;
  }
  const url = downloadUrl(platform);
  const zipPath = join(runtimeDir, "..", `python-${PYTHON_VERSION}-embed.zip`);
  await mkdir(dirname(zipPath), { recursive: true });
  console.log(`Downloading ${url}`);
  await download(url, zipPath);
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });
  await extract(zipPath, runtimeDir);
  await rm(zipPath, { force: true });

  const exe = join(runtimeDir, platform === "win32" ? "python.exe" : "python3");
  if (!(await exists(exe))) {
    throw new Error(`The archive did not contain ${exe}`);
  }
  // The embeddable `._pth` puts the exe folder on sys.path, so the package is
  // importable from beside `python.exe` with no PYTHONPATH.
  await cp(join(proxyDir, "m365copilotproxy"), join(runtimeDir, "m365copilotproxy"), {
    recursive: true,
    filter: (source) => !source.includes("__pycache__"),
  });
  await writeFile(
    stamp,
    `${JSON.stringify({ python: PYTHON_VERSION, source: url, platform }, null, 2)}\n`,
  );
  console.log(`Bundled CPython ${PYTHON_VERSION} + proxy package at ${runtimeDir}`);
}

await main();
