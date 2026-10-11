import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { CustomProviderConfig, M365CopilotStatus } from "../../../contracts/ipc";

/**
 * One-click Microsoft 365 Copilot setup for people who never touch a terminal:
 * Connect starts the bundled local proxy, waits for the Edge sign-in, registers
 * Copilot as a pi model and makes it the default.
 */

const POLL_MS = 2000;

function logFailure(error: unknown): void {
  console.error("[settings] Microsoft 365 Copilot", error);
}

const STATE_LABEL: Record<M365CopilotStatus["state"], string> = {
  stopped: "Not connected",
  starting: "Starting…",
  "waiting-for-sign-in": "Waiting for sign-in",
  ready: "Connected",
  error: "Problem",
};

export function SettingsM365CopilotSection({
  runtime,
  onSaveCustomProvider,
  onSetDefaultModel,
}: {
  readonly runtime?: RuntimeSnapshot;
  readonly onSaveCustomProvider: (config: CustomProviderConfig) => Promise<string | undefined>;
  readonly onSetDefaultModel: (provider: string, modelId: string) => void;
}) {
  const [status, setStatus] = useState<M365CopilotStatus | undefined>();
  const [connecting, setConnecting] = useState(false);
  const [setupError, setSetupError] = useState<string | undefined>();
  const registeringRef = useRef(false);

  const isDefault =
    !!status &&
    runtime?.settings.defaultProvider === status.providerId &&
    runtime?.settings.defaultModelId === status.modelId;

  const refresh = useCallback(async () => {
    const api = window.piApp;
    if (!api) return undefined;
    const next = await api.getM365CopilotStatus();
    setStatus(next);
    return next;
  }, []);

  const adoptCopilot = useCallback(
    async (ready: M365CopilotStatus) => {
      if (registeringRef.current) return;
      registeringRef.current = true;
      try {
        const error = await onSaveCustomProvider({
          providerId: ready.providerId,
          baseUrl: ready.baseUrl,
          apiKey: "m365-local-proxy",
          models: [{ id: ready.modelId, contextWindow: ready.contextWindow }],
        });
        if (error) {
          setSetupError(error);
          return;
        }
        setSetupError(undefined);
        onSetDefaultModel(ready.providerId, ready.modelId);
      } finally {
        registeringRef.current = false;
      }
    },
    [onSaveCustomProvider, onSetDefaultModel],
  );

  useEffect(() => {
    refresh().catch(logFailure);
  }, [refresh]);

  // While connecting, poll until the proxy has a signed-in token, then finish setup once.
  useEffect(() => {
    if (!connecting) return;
    const timer = window.setInterval(() => {
      refresh()
        .then(async (next) => {
          if (next?.state === "ready") {
            setConnecting(false);
            await adoptCopilot(next);
          } else if (next?.state === "error") {
            setConnecting(false);
          }
        })
        .catch(logFailure);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [connecting, refresh, adoptCopilot]);

  const connect = useCallback(async () => {
    const api = window.piApp;
    if (!api) return;
    setSetupError(undefined);
    const next = await api.startM365Copilot();
    setStatus(next);
    if (next.state === "ready") {
      await adoptCopilot(next);
    } else if (next.state !== "error") {
      setConnecting(true);
    }
  }, [adoptCopilot]);

  const disconnect = useCallback(async () => {
    const api = window.piApp;
    if (!api) return;
    setConnecting(false);
    setStatus(await api.stopM365Copilot());
  }, []);

  const state = status?.state ?? "stopped";
  return (
    <section className="settings-section" data-testid="settings-m365-copilot">
      <h3 className="settings-section__title">Microsoft 365 Copilot</h3>
      <p className="settings-section__description">
        Use your work Copilot as pi’s model. pi opens an Edge window once so you can sign in with
        your normal work account; nothing else to install or configure.
      </p>
      <div className="settings-group">
        <div className="settings-row">
          <div className="settings-row__label">
            <div className="settings-row__title">
              Status{" "}
              <span className={`m365-status m365-status--${state}`} data-testid="m365-status">
                {STATE_LABEL[state]}
              </span>
            </div>
            <div className="settings-row__description">
              {state === "ready"
                ? isDefault
                  ? "New threads use Microsoft 365 Copilot."
                  : "Copilot is connected but is not the default model yet."
                : (status?.detail ?? "Click Connect to sign in and start using Copilot.")}
              {state === "ready" && status?.minutesLeft !== undefined
                ? ` Sign-in refreshes automatically (${status.minutesLeft} min left on the current token).`
                : null}
            </div>
            {setupError ? <div className="settings-row__description">{setupError}</div> : null}
          </div>
          <div className="settings-row__actions">
            {state === "ready" ? (
              isDefault ? null : (
                <button
                  className="button button--primary m365-primary"
                  type="button"
                  onClick={() => {
                    if (status) adoptCopilot(status).catch(logFailure);
                  }}
                >
                  Use for new threads
                </button>
              )
            ) : (
              <button
                className="button button--primary m365-primary"
                data-testid="m365-connect"
                disabled={connecting || state === "starting"}
                type="button"
                onClick={() => {
                  connect().catch(logFailure);
                }}
              >
                {connecting ? "Connecting…" : "Connect"}
              </button>
            )}
            {status?.managed ? (
              <button
                className="button button--secondary"
                type="button"
                onClick={() => {
                  disconnect().catch(logFailure);
                }}
              >
                Disconnect
              </button>
            ) : null}
          </div>
        </div>
        {status?.log?.length ? (
          <div className="settings-row">
            <pre className="m365-log">{status.log.join("\n")}</pre>
          </div>
        ) : null}
      </div>    </section>
  );
}
