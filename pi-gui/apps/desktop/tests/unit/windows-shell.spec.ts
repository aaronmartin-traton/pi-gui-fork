import { expect, test } from "@playwright/test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWindowsShellExtension } from "../../electron/assistant/windows-shell";

/** Run the extension against a fake pi and return the `setActiveTools` calls it made. */
function runSession(platform: NodeJS.Platform, tools: string[]): string[][] {
  const calls: string[][] = [];
  let start: (() => void) | undefined;
  const pi = {
    on: (event: string, handler: () => void) => {
      if (event === "session_start") start = handler;
      return () => {};
    },
    getActiveTools: () => tools,
    setActiveTools: (next: string[]) => calls.push(next),
  };
  createWindowsShellExtension(platform)(pi as unknown as ExtensionAPI);
  start?.();
  return calls;
}

test("adds pi's powershell tool on Windows", () => {
  expect(runSession("win32", ["read", "bash", "edit", "write"])).toEqual([
    ["read", "bash", "edit", "write", "powershell"],
  ]);
});

test("does nothing on other platforms", () => {
  expect(runSession("linux", ["read", "bash", "edit", "write"])).toEqual([]);
  expect(runSession("darwin", ["read", "bash", "edit", "write"])).toEqual([]);
});

test("is idempotent when powershell is already active", () => {
  expect(runSession("win32", ["read", "bash", "edit", "write", "powershell"])).toEqual([]);
});
