import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * pi's default tools are `read`, `write`, `edit`, `bash`. Windows ships no `bash.exe`
 * unless Git Bash or WSL is installed, so pi's `bash` tool fails there and the model
 * cannot run anything. This adds pi's built-in `powershell` tool to the active set on
 * Windows so fenced tool loops work.
 *
 * Additive on purpose: a new file, so it does not conflict with upstream pi-gui.
 *
 * The display name is registered in main.ts as "Windows shell (PowerShell)". Settings →
 * Skills and extensions lists built-ins by display name and shows only the first six of a
 * group until you expand it, so a name that sorted earlier would push an existing built-in
 * out of the collapsed view (and out of the upstream spec that asserts it is there).
 */
export function createWindowsShellExtension(
  platform: NodeJS.Platform = process.platform,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    if (platform !== "win32") return;
    pi.on("session_start", () => {
      const tools = pi.getActiveTools();
      const powershellIndex = tools.indexOf("powershell");
      const bashIndex = tools.indexOf("bash");
      if (powershellIndex !== -1 && (bashIndex === -1 || powershellIndex < bashIndex)) {
        return;
      }

      const nextTools = tools.filter((tool) => tool !== "powershell");
      const nextBashIndex = nextTools.indexOf("bash");
      nextTools.splice(nextBashIndex === -1 ? nextTools.length : nextBashIndex, 0, "powershell");
      pi.setActiveTools(nextTools);
    });
  };
}
