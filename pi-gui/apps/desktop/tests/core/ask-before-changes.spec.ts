import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

// A scripted provider: "make the file" asks Pi's real write tool for approved.txt once, then
// reports whether the tool result was an error (declined) or a success.
const providerExtension = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function askBeforeChangesFixture(pi) {
  pi.registerProvider("ask-before-changes-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "ask-before-changes-test",
    models: [{
      id: "scripted", name: "Scripted approval", reasoning: false,
      input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      const lastUser = context.messages.findLastIndex((message) => message.role === "user");
      const result = context.messages.slice(lastUser + 1).find((message) => message.role === "toolResult");
      const text = result ? (result.isError ? "The write was declined" : "The write went through") : "";
      const message = {
        role: "assistant",
        content: result
          ? [{ type: "text", text }]
          : [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "approved.txt", content: "ok\n" } }],
        api: model.api, provider: model.provider, model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: result ? "stop" : "toolUse", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (result) stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
}
`;

async function expectReply(window: Page, text: string): Promise<void> {
  await expect(
    window.locator(".timeline-item--assistant .message__content").filter({ hasText: text }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(window.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

test("Ask before changes blocks a declined write and allows a confirmed one", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("ask-before-changes");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "ask-before-changes-test",
      defaultModel: "scripted",
      enabledModels: ["ask-before-changes-test/scripted"],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await writeProjectExtension(workspacePath, "ask-before-changes.ts", providerExtension);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
    envOverrides: { PI_GUI_ASK_BEFORE_CHANGES: "1" },
  });
  const target = join(workspacePath, "approved.txt");
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window
      .locator(".sidebar")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window.getByLabel("New thread prompt", { exact: true }).fill("make the file");
    await window.getByRole("button", { name: "Start thread", exact: true }).click();

    const dialog = window.getByRole("dialog", { name: "Allow pi to create or overwrite a file?" });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toContainText("approved.txt");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectReply(window, "The write was declined");
    expect(await exists(target)).toBe(false);

    await window.getByTestId("composer").fill("make the file");
    await window.getByTestId("send").click();
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expectReply(window, "The write went through");
    expect(await exists(target)).toBe(true);
  } finally {
    await harness.close();
  }
});
