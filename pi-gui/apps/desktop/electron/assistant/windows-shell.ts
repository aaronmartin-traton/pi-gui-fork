import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * pi's default tools are `read`, `write`, `edit`, `bash`. Windows ships no `bash.exe`
 * unless Git Bash or WSL is installed, so pi's `bash` tool fails there and the model
 * cannot run anything. This adds pi's built-in `powershell` tool to the active set on
 * Windows so fenced tool loops work.
 *
 * Additive on purpose: a new file, so it does not conflict with upstream pi-gui.
 */
export function createWindowsShellExtension(
  platform: NodeJS.Platform = process.platform,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    if (platform !== "win32") return;
    pi.on("session_start", () => {
      const tools = pi.getActiveTools();
      if (!tools.includes("powershell")) {
        pi.setActiveTools([...tools, "powershell"]);
      }
    });
  };
}
