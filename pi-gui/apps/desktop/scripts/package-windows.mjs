import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runElectronBuilder } from "./run-electron-builder.mjs";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const electronBuilderArgs = process.argv.slice(2);
if (electronBuilderArgs.length === 0) {
  throw new Error("Usage: package-windows.mjs <electron-builder args...>");
}

// The installer carries its own CPython, so fetch it before electron-builder copies
// resources/. Cached: the script no-ops when resources/python already exists.
await run(process.execPath, [join(here, "fetch-python-runtime.mjs"), "--platform", "win32"], {
  stdio: "inherit",
});

process.exit(await runElectronBuilder(electronBuilderArgs));
