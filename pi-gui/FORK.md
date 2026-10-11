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

1. Install the app (the `pi-gui-Setup-*.exe` someone shares with you). It carries its own
   Python, so there is nothing else to install — no Python, no `pip`, no admin rights.
2. Open the app, pick a folder, and click **Connect Microsoft 365 Copilot** on the banner
   (or Settings → Microsoft 365 Copilot → **Connect**).
3. An Edge window opens. Sign in with your normal work account. The status turns
   **Connected** and new threads use Copilot.
4. Start from one of the suggestions under the message box, or just ask.

pi asks before it edits a file or runs a command (**Ask before changes**). Turn that off in
Settings → Skills and extensions if you prefer.

## What changed

### Microsoft 365 Copilot, built in

- The proxy (`resources/m365-copilot-proxy`, the `m365copilotproxy` package) ships inside the
  app and is **stdlib-only** — no `pip`, no third-party packages (see its `NOTICE.md`). It needs
  no Azure app registration or admin consent: it signs in through a dedicated Edge profile, the
  same way the Copilot web app does.
- The installer also carries its own CPython (`resources/python`, fetched by
  `scripts/fetch-python-runtime.mjs` at package time), so nothing has to be installed on the
  host. A system Python 3.12+ is only a dev fallback.
- `electron/platform/m365-copilot.ts` starts the proxy with the bundled interpreter, keeps its
  token file under the app's userData folder, health-checks `/healthz`, shows plain-language
  states (starting, waiting for sign-in, connected, runtime missing, port busy), and stops it
  on quit. A proxy you already run is detected and reused.
- On **Connect**, the settings page registers pi provider `m365-copilot` (OpenAI-compatible,
  32K context so pi compacts early) and makes it the default model.
- `PI_GUI_M365_PROXY_URL` points the app at a different proxy, for example
  [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) on
  `http://127.0.0.1:4141/v1`, which emulates tool calling.

**Limitation:** M365 Copilot has no native tool calling. With the bundled proxy, Copilot
answers and produces rich cards but does not drive pi's file and command tools. For agentic
work, use cramt's proxy (it needs a TOTP seed or interactive approval and Node 24) or another
provider in Settings → Providers.

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

## Verification status

On Linux (Xvfb, Electron 37): format, lint, typecheck, architecture guards (114/114) and desktop
unit tests (344 + 3 new) all pass. In the full core Electron lane, 277 pass, 6 are skipped and
the remaining tests split into two groups:

- 10 notification, window-focus and maximize specs fail the same way on the unmodified upstream
  import in this environment, which has no window manager.
- `composer-draft-sync` "explicit editor text replacements" failed once under three parallel
  workers, then passed twice on rerun.

## Not yet verified

- **Windows.** All checks ran on Linux under Xvfb. The proxy launch path (`py -3`, Edge sign-in,
  token capture) and the NSIS installer were not run on Windows here. Use the repo's
  `testing-windows-desktop` skill or the `desktop-package-windows` CI job once this folder is its
  own repository. GitHub only runs workflows from a repository's root `.github`.
- **A real Copilot conversation.** The proxy was started and probed locally (health, models,
  token state), but no M365 account was available to sign in.
