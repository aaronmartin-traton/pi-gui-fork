import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

const cardResponse = [
  "Here is the summary you asked for.",
  "",
  "```openui-lang",
  'root = Card("Expense summary", [stats, chart, tip, todo, next])',
  'stats = Row([Stat("Total", "$4,210"), Stat("Top category", "Travel", "58% of spend")])',
  'chart = BarChart("By category", ["Travel", "Meals", "Software"], [2440, 980, 790], " USD")',
  'tip = Callout("warning", "Two receipts are missing", "Upload them before Friday.")',
  'todo = Checklist(["Upload receipts", "Submit report"])',
  'next = Row([FollowUp("Show details", "List every travel expense over $200")])',
  "```",
].join("\n");

const proofDir = process.env.PI_APP_GENERATIVE_UI_PROOF_DIR?.trim();

test("renders openui-lang fences as cards and fills the composer from follow-ups", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("generative-ui-workspace");
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let workspaceId = "";
  let sessionId = "";
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Generative UI thread");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
  } finally {
    await firstRun.close();
  }

  const sessionFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  await appendMessagesToSessionFile(sessionFilePath, [
    { role: "user", text: "Summarize my expenses." },
    { role: "assistant", text: cardResponse },
  ]);

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    const card = window.getByTestId("generative-ui");
    await expect(card).toBeVisible();
    await expect(card.locator(".genui-card__title")).toHaveText("Expense summary");
    await expect(card.locator(".genui-stat__value")).toHaveText(["$4,210", "Travel"]);
    await expect(card.locator(".genui-bars__row")).toHaveCount(3);
    await expect(card.locator(".genui-callout--warning")).toContainText("Two receipts are missing");
    // The raw fence never shows as code.
    await expect(window.locator(".timeline-item--assistant")).not.toContainText("openui-lang");

    const firstTodo = card.locator(".genui-checklist input").first();
    await firstTodo.check();
    await expect(firstTodo).toBeChecked();

    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await window.screenshot({ path: join(proofDir, "generative-ui-card.png") });
    }

    await card.getByTestId("generative-ui-follow-up").click();
    await expect(window.getByTestId("composer")).toHaveText("List every travel expense over $200");
  } finally {
    await secondRun.close();
  }
});

test("Microsoft 365 Copilot settings page offers Connect", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("m365-settings-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    // Point at a closed port so a proxy running on this machine cannot change the result.
    envOverrides: { PI_GUI_M365_PROXY_URL: "http://127.0.0.1:9/v1" },
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Microsoft 365 Copilot", exact: true }).click();
    const section = window.getByTestId("settings-m365-copilot");
    await expect(section).toBeVisible();
    await expect(section.getByTestId("m365-status")).toHaveText("Not connected");
    await expect(section.getByTestId("m365-connect")).toBeEnabled();
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await window.screenshot({ path: join(proofDir, "m365-copilot-settings.png") });
    }
  } finally {
    await harness.close();
  }
});

test("starter prompts fill the new thread composer and hide once there is text", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("starter-prompts-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window
      .locator(".sidebar")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    const starters = window.getByTestId("starter-prompts");
    await expect(starters).toBeVisible();
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await window.screenshot({ path: join(proofDir, "starter-prompts.png") });
    }
    await starters.getByRole("button", { name: "Summarize this folder" }).click();
    await expect(window.getByLabel("New thread prompt", { exact: true })).toHaveValue(
      /short, plain-language summary/,
    );
    await expect(starters).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
