# Vendored: m365copilotproxy

This folder contains `m365copilotproxy`, the Python port of the Microsoft 365
Copilot OpenAI-compatible proxy from
<https://github.com/aaronmartin-traton/m365-copilot-proxy> (`packages/python-proxy`),
itself a fork of <https://github.com/cramt/m365-copilot-proxy>.

It differs from the earlier vendored `m365_copilot_openai_proxy` in one way that
matters: it emits and parses **fenced tool calls** and routes them to the
harness's shell tool, so M365 Copilot can drive real tool loops. It also frames
the **Windows** shell (`powershell`/`pwsh`/`cmd`), not just POSIX.

pi-gui starts it as a local child process
(`python -m m365copilotproxy serve --port <port>`) so Microsoft 365 Copilot can
be used as a pi model. It is unofficial and talks to the same browser-facing API
as the M365 Copilot web app, so it can break without notice. `LICENSE` in this
folder is the upstream license; the desktop app around it stays MIT.

Runtime dependencies (`requirements.txt`: `msal`, `websockets`, `cryptography`)
install into `%LOCALAPPDATA%\M365CopilotProxy\Python314\site-packages` via
`install-deps.ps1`. Python **3.12 or newer** is required (3.10/3.11 fail on
PEP 701 nested-quote f-strings; 3.12–3.14 pass the e2e).

Licensed **MIT**, inherited from
<https://github.com/cramt/m365-copilot-proxy> (Copyright 2026 Alexandra
Østermark) — the same license as the desktop app around it.

Local changes from upstream: `tooling.py` `SHELL_NAME` now matches
`powershell`/`pwsh`/`ps1`/`posh` so Windows shell routing works; `images.py`
adds image input (upload to the substrate `UploadFile` endpoint + a
`messageAnnotations` reference on the chat turn); `e2e.py` gained regression
cases for both.
