# Vendored: m365-copilot-openai-proxy

This folder is an unmodified copy of the `m365_copilot_openai_proxy` package from
<https://github.com/NicolaiLassen/m365-copilot-openai-proxy> at commit
`35fbe938f50fc154880f0a5f146355c0ca24896b`, itself a standard-library-only port of
<https://github.com/kuchris/m365-copilot-openai-proxy>.

It is licensed under the Apache License 2.0 (see `LICENSE` in this folder), separately
from the MIT-licensed desktop app around it.

pi-gui starts it as a local child process (`python -m m365_copilot_openai_proxy serve`)
so Microsoft 365 Copilot can be used as a pi model. It is unofficial and talks to the
same browser-facing API as the M365 Copilot web app, so it can break without notice.
