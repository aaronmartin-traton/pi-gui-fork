import { expect, test } from "@playwright/test";
import { runE2E } from "../../src/m365/e2e";

// In-process fixture: a loopback ProxyApplication plus hand-rolled Chathub and
// UploadFile servers, so the proxy's full HTTP/WebSocket contract is exercised
// without a browser, a subprocess, or a Microsoft account. The fixture prints a
// single pass line; keep that signal in the lane log.
test("proxies an M365 Copilot turn end to end", async () => {
  const line = await runE2E();
  console.log(line);
  expect(line).toContain(
    "E2E PASS: models, hosted-shell routing, image upload, Chat/Responses tool loops, reuse/SSE, retries, priority fallback/exhaustion",
  );
});
