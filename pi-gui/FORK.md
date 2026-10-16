# pi-gui for coworkers: what this fork adds

This folder is a fork of [pi-gui](https://github.com/minghinmatthewlam/pi-gui) (MIT), imported
unmodified at `572c0c6` and then changed in small commits. The goal: a Windows-friendly desktop
agent that uses the company's **Microsoft 365 Copilot** as its model and is easy to use for
people who are not technical.

| Surface                                     | Screenshot (real Electron app)                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Rich answer card rendered from model output | [`docs/fork/generative-ui-card.png`](docs/fork/generative-ui-card.png)       |
| Settings → Microsoft 365 Copilot            | [`docs/fork/m365-copilot-settings.png`](docs/fork/m365-copilot-settings.png) |
| Starter prompts on New thread               | [`docs/fork/starter-prompts.png`](docs/fork/starter-prompts.png)             |

## For coworkers

1. Install the app (the `pi-gui-<version>-x64-setup.exe` someone shares with you). The Copilot
   proxy is built into the app, so there is nothing else to install — no Python, no
   `pip`, no admin rights.
   **If Windows shows "Windows protected your PC"**, choose **More info → Run anyway**: the
   installer is not code-signed. If a message says your organization blocked the app, ask IT to
   allow it.
2. Open the app, pick a folder, and click **Connect Microsoft 365 Copilot** on the banner
   (or Settings → Microsoft 365 Copilot → **Connect**).
3. An Edge window opens. Sign in with your normal work account. Finishing the sign-in can take a
   minute or two — the status says **Signing in** while that window is open — and then turns
   **Connected**. The sign-in refreshes itself, so this is a one-time step.
4. Start from one of the suggestions under the message box, or just ask.

If something goes wrong, the status line under **Settings → Microsoft 365 Copilot** says what to
do. The common ones:

| What you see                            | What to do                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| "Click Connect, then sign in …"         | Click **Connect**; the Edge window opens again.                                                                       |
| "Port 8000 is already in use"           | Another program (or a second copy of pi) holds the port. Close it and click **Connect** again.                        |
| "Your Microsoft 365 sign-in expired"    | Settings → Microsoft 365 Copilot → **Connect**.                                                                       |
| "Copilot is busy" or a throttle message | Wait about a minute and send the message again.                                                                       |
| Copilot stops answering in new threads  | Microsoft limits how many conversations you may start. Keep working in the same thread instead of starting a new one. |

pi asks before it edits a file or runs a command (**Ask before changes**). Turn that off in
Settings → Skills and extensions if you prefer, or use **YOLO mode** in Settings → General.
YOLO mode stops the asking but deliberately leaves the destructive-command guard armed —
disarming that is a second, separate switch you have to turn on deliberately.

## What changed

### Microsoft 365 Copilot, built in

- The proxy is TypeScript in `src/m365` — it used to be a vendored Python package plus a
  bundled CPython 3.14, and shipping an interpreter to run a plugin was never a good idea.
  It is now part of the app: no subprocess, no `pip`, no third-party packages, and it is
  covered by the repo's own fixture (`src/m365/e2e.ts`) instead of a Python one.
  It needs no Azure app registration or admin consent: it signs in through a dedicated
  Edge profile, the same way the Copilot web app does.
- `electron/platform/m365-copilot.ts` starts the proxy as an `node:http` server bound to
  127.0.0.1 inside the app, keeps its token file under the app's userData folder,
  health-checks `/healthz`, reports plain-language states (starting, waiting for sign-in,
  signing in, connected, port busy, error) each with a sentence saying what to do, and stops
  it on quit. A proxy you already run is detected and reused.
- On **Connect**, the settings page registers pi provider `m365-copilot` (OpenAI-compatible,
  32K context so pi compacts early) and makes it the default model.
- `PI_GUI_M365_PROXY_URL` points the app at a different proxy, for example
  [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) on
  `http://127.0.0.1:4141/v1`. At launch, pi-gui also aligns its saved M365 provider endpoint
  with this URL, so health checks and model requests reach the same standalone proxy.

**Tool calling is prompt-emulated.** M365 Copilot has no native tool-calling API, so the proxy
teaches it to answer with a fenced ` ```bash ` or ` ```powershell ` block; the proxy routes that
block to the pi tool whose name it matches, one call per turn. The tool must be in the request's
tool list and the model must name it exactly. On Windows, pi-gui orders its native PowerShell
tool ahead of Bash so the proxy describes the correct shell. Verified end to end on Windows:
Copilot wrote and read a file in the active workspace through a fenced PowerShell call.

### Generative UI: OpenUI

Options weighed: [OpenUI](https://github.com/thesysdev/openui),
[json-render](https://github.com/vercel-labs/json-render) and [A2UI](https://github.com/a2ui-project/a2ui).
OpenUI won because:

- **Token cost.** OpenUI Lang is a compact line-based language (the project reports up to 67%
  fewer tokens than JSON). That matters with Copilot's small context.
- **Streaming.** The parser is permissive and renders partial output, so a card grows while the
  answer streams. JSON specs are invalid until the closing brace arrives.
- **Plain text in, plain text out.** The model writes an ` ```openui-lang ` fence in a
  normal reply, so it works with chat-only models like Copilot. No tool calls are needed.
- **Small dependency.** Only `@openuidev/lang-core` (parser and prompt generator; it depends on
  `ci-info` alone). Rendering is our own ~250-line React component styled with pi-gui's
  tokens, not a second design system.

How it fits together:

- `contracts/generative-ui.ts` defines the catalog: Card, Row, Text, Heading, Callout, Stat,
  Table, BarChart, Steps, Checklist, FollowUp. Main and renderer share it.
- The **Rich answer cards** built-in appends the generated prompt (inline mode) on every turn.
- `MessageMarkdown` swaps `openui-lang` fences for `GenerativeUiBlock`. Invalid input falls
  back to showing the raw text, so no answer is lost.
- **FollowUp** buttons fill the composer; nothing is sent without the person pressing Send.

OpenUI's install-time telemetry is a `postinstall` script. pnpm here does not run dependency
scripts that are not allow-listed, and `setup-windows.ps1` also sets
`OPENUI_TELEMETRY_DISABLED=1`. Runtime telemetry is opt-in and stays off.

### Ideas from open-codex and other harnesses

Two small, cheap features, each a pi built-in extension (`electron/assistant/coworker-extensions.ts`)
that can be switched off in Settings → Skills and extensions:

- **Ask before changes:** Codex's "suggest" approval mode, as in
  [open-codex](https://github.com/ymichael/open-codex). Every non-read-only tool call (write, edit,
  bash, PowerShell, MCP tools…) asks first. Declining blocks the call and tells the model the user
  said no. Background runs with no UI are allowed through so they don't hang.
- **YOLO mode** (Settings → General): stops asking before each change. It is _not_ "approve
  everything": **Block destructive commands** stays on, so `rm -rf`, `format`, `del /f /s /q`,
  `Stop-Computer` and friends are still refused. A second switch, "Also block nothing", is the
  only thing that disarms the guard — it is worded that way because it is the dangerous one.
  Both flags persist and reload open threads so a change takes effect on the next tool call.
- **Trim old tool output:** open-codex's content pruning. Before each model call, tool results
  older than the six most recent are cut to a head and tail if they exceed 1,500 characters. This
  affects only the request; the session file keeps everything.
- **Starter prompts** (ChatGPT/Claude-style) on the New thread screen.
- The first-run banner offers **Connect Microsoft 365 Copilot** instead of a generic providers page.

## Developing

Same as upstream (see `README.md` / `apps/desktop/README.md`):

```sh
pnpm install
pnpm dev                       # run the app
pnpm --filter @pi-gui/desktop run package:win   # Windows installer (on Windows)
```

Tests added in this fork:

```sh
# unit
npx playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/unit/coworker-extensions.spec.ts
# Electron (fixture-backed; on Linux wrap with xvfb-run -a)
PI_APP_TEST_LANE=core PI_APP_REAL_AUTH=0 PI_APP_TEST_MODE=background \
  npx playwright test -c apps/desktop/playwright.config.ts \
  apps/desktop/tests/core/coworker-features.spec.ts apps/desktop/tests/core/ask-before-changes.spec.ts
```

Ask before changes is off under the e2e harness (`PI_APP_TEST_MODE`) so upstream specs with
scripted tools keep running unattended. A spec opts in with `PI_GUI_ASK_BEFORE_CHANGES=1`.
YOLO mode does not affect the harness either way.

The yolo contract is covered by `apps/desktop/tests/unit/yolo-mode.spec.ts`, which drives the
real extension factories: it fails if turning yolo on ever disarms the destructive guard.

## Verification status

On Linux (Xvfb, Electron 37): format, lint, typecheck, architecture guards (114/114), the desktop
unit tests, and the vendored proxy's own end-to-end fixture
(`pnpm --filter @pi-gui/desktop run verify:m365-proxy`) all pass.

The full core Electron lane (648 tests) is 638 passed, 6 skipped, 4 failed. None of the failures
is a regression from this fork's colleague-mode work — a build made before those changes fails the
same ones — and the failing set varies run to run because the lane runs three Electron apps side by
side. Two causes:

- **Missing example bundles (4).** `extension-github-view`, `extension-trace-view`,
  `extension-usage-view` and `extension-view-links` load `examples/desktop-extensions/<name>`,
  whose `dist/desktop.js` is a gitignored build artifact that the lane does not build. Build them
  once first — `pnpm --dir examples/desktop-extensions/github run build` (same for `trace`,
  `usage`) — and they pass.
- **Upstream spec drift / Xvfb (3-4).** `mentions-diff` expects the `@` menu to list "Trim old tool
  output", but `buildExtensionMentionOptions` caps that list at 8 alphabetically, so the fork's
  extra built-ins push it out; typing `@trim` still finds it. `composer-controls`,
  `side-panel-picker` and `settings-general` fail on keyboard shortcuts and focus in this
  environment.

## Windows verification (2026-10-11)

Run on a Windows 11 Enterprise VM, signed in with a real work account:

- The NSIS installer built by `pnpm --filter @pi-gui/desktop run package:win` installs, and the
  installed app launches.
- Settings → Microsoft 365 Copilot → **Connect** starts the in-app proxy and opens Edge; finishing
  the sign-in turns the status to **Connected** and shows the account and the minutes left on the
  token.
- A real conversation ran and Copilot **wrote a file into the user's Documents folder** through a
  fenced PowerShell tool call — the end-to-end proof that the built-in proxy drives pi's tools.
- Found and fixed by that run: the proxy read its token cache once and never re-read it, so a
  finished sign-in left the app on "Connecting…" forever. `FileTokenProvider` now re-reads the
  file, and a sign-in that fails reports why instead of polling.

Still open: the same path on an organization-managed PC with SmartScreen/AppLocker policy, and a
throttle/quota/disengage recovery run. CI note: GitHub only runs workflows from a repository's root
`.github`, so these workflows run only once this folder is its own repository — the `pi-gui/`
subdirectory's `.github/workflows` are inert while the fork's root has no `.github`.
