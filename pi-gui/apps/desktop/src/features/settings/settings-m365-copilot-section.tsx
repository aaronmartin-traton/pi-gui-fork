import { useEffect, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { CustomProviderConfig, M365CopilotStatus } from "../../../contracts/ipc";

/**
 * One-click Microsoft 365 Copilot setup for people who never touch a terminal:
 * Connect starts the local proxy, waits for the Edge sign-in, registers Copilot
 * as a pi model and — only when nothing else is chosen yet — makes it the default.
 *
 * The setup state deliberately lives at module scope. A person who closes Settings
 * while the Edge window is open must still get a registered Copilot, so the poll
 * that waits for the sign-in, and the one-time provider registration, keep running
 * after this component unmounts and hand the outcome to the next mount.
 */

const POLL_MS = 2000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const WAITING_DETAIL = "Finish signing in in the Edge window — this can take up to 5 minutes.";

const STATE_LABEL: Record<M365CopilotStatus["state"], string> = {
  stopped: "Not connected",
  starting: "Starting…",
  "waiting-for-sign-in": "Waiting for sign-in",
  "signing-in": "Signing in",
  ready: "Connected",
  error: "Problem",
};

function logFailure(error: unknown): void {
  console.error("[settings] Microsoft 365 Copilot", error);
}

/** Plain wording for a startup failure a coworker can act on. */
function connectFailureMessage(): string {
  return "Copilot could not start. Click Connect to try again.";
}

interface M365SetupSnapshot {
  readonly status: M365CopilotStatus | undefined;
  readonly connecting: boolean;
  readonly setupError: string | undefined;
  /** When the in-flight Connect attempt gives up waiting for the sign-in. */
  readonly deadlineAt: number | undefined;
}

/** What the mounted section hands the module so adoption can outlive it. */
interface M365AdoptionTarget {
  readonly saveProvider: (config: CustomProviderConfig) => Promise<string | undefined>;
  readonly setDefaultModel: (provider: string, modelId: string) => void;
  readonly hasDefaultModel: () => boolean;
  readonly onError: (message: string) => void;
}

let snapshot: M365SetupSnapshot = {
  status: undefined,
  connecting: false,
  setupError: undefined,
  deadlineAt: undefined,
};
const listeners = new Set<(snapshot: M365SetupSnapshot) => void>();
let target: M365AdoptionTarget | undefined;
let pollTimer: number | undefined;
let adopting = false;

function emit(patch: Partial<M365SetupSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener(snapshot);
}

function subscribeM365Setup(listener: (next: M365SetupSnapshot) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function refreshStatus(): Promise<M365CopilotStatus | undefined> {
  const api = window.piApp;
  if (!api) return undefined;
  const next = await api.getM365CopilotStatus();
  emit({ status: next });
  return next;
}

/**
 * Registers the Copilot provider and — only when no default model is chosen —
 * makes it the default, so a later Connect never silently overrides a model the
 * person picked themselves. Safe to call again: registration is idempotent.
 */
async function adoptCopilot(status: M365CopilotStatus): Promise<void> {
  if (adopting || !target) return;
  adopting = true;
  const adoption = target;
  try {
    const error = await adoption.saveProvider({
      providerId: status.providerId,
      baseUrl: status.baseUrl,
      apiKey: "m365-local-proxy",
      models: status.models.map((id) => ({ id, contextWindow: status.contextWindow })),
    });
    if (error) {
      adoption.onError(error);
      return;
    }
    emit({ setupError: undefined });
    if (!adoption.hasDefaultModel()) {
      adoption.setDefaultModel(status.providerId, status.modelId);
    }
  } catch (error) {
    logFailure(error);
    adoption.onError(
      "Copilot signed in, but pi could not finish setting it up. Click “Use for new threads” to finish.",
    );
  } finally {
    adopting = false;
  }
}

function finishConnecting(next: M365CopilotStatus | undefined): void {
  if (!snapshot.connecting) return;
  if (next?.state === "ready") {
    stopPolling();
    emit({ connecting: false, deadlineAt: undefined });
    void adoptCopilot(next);
    return;
  }
  if (next?.state === "error") {
    stopPolling();
    emit({
      connecting: false,
      deadlineAt: undefined,
      setupError: next.detail ?? "Copilot ran into a problem. Click Connect to try again.",
    });
    return;
  }
  if (snapshot.deadlineAt !== undefined && Date.now() >= snapshot.deadlineAt) {
    stopPolling();
    emit({
      connecting: false,
      deadlineAt: undefined,
      setupError:
        "Copilot hasn’t finished signing in after 5 minutes. Finish signing in in the Edge window, then click Connect to check again.",
    });
  }
}

function startPolling(): void {
  stopPolling();
  emit({ deadlineAt: Date.now() + SIGN_IN_TIMEOUT_MS });
  pollTimer = window.setInterval(() => {
    refreshStatus().then(finishConnecting).catch(logFailure);
  }, POLL_MS);
}

/** One-shot status load for the first render; a failure just leaves the section idle. */
async function loadM365Status(): Promise<void> {
  try {
    await refreshStatus();
  } catch (error) {
    logFailure(error);
  }
}

async function startM365Connect(): Promise<void> {
  const api = window.piApp;
  if (!api) return;
  emit({ setupError: undefined });
  let next: M365CopilotStatus;
  try {
    next = await api.startM365Copilot();
  } catch (error) {
    logFailure(error);
    emit({ connecting: false, deadlineAt: undefined, setupError: connectFailureMessage() });
    return;
  }
  emit({ status: next });
  if (next.state === "ready") {
    await adoptCopilot(next);
    return;
  }
  if (next.state === "error") {
    emit({
      connecting: false,
      deadlineAt: undefined,
      setupError: next.detail ?? "Copilot ran into a problem. Click Connect to try again.",
    });
    return;
  }
  emit({ connecting: true });
  startPolling();
}

/**
 * Cancel: aborts an attempt in progress (the Edge window closes) and stops polling,
 * without touching a Copilot that was already registered.
 */
async function cancelM365Connect(): Promise<void> {
  stopPolling();
  emit({ connecting: false, deadlineAt: undefined });
  const api = window.piApp;
  if (!api) return;
  try {
    emit({ status: await api.cancelM365Copilot() });
  } catch (error) {
    logFailure(error);
  }
}

/** Disconnect: stops pi's proxy and forgets the provider, so onboarding can start over. */
async function disconnectM365Copilot(): Promise<void> {
  stopPolling();
  emit({ connecting: false, deadlineAt: undefined });
  const api = window.piApp;
  if (!api) return;
  try {
    emit({ status: await api.disconnectM365Copilot(), setupError: undefined });
  } catch (error) {
    logFailure(error);
    emit({ setupError: "Copilot could not disconnect. Try again in a moment." });
  }
}

/** Clears the local Microsoft sign-in so a different account can be used. */
async function signOutM365Copilot(): Promise<void> {
  const api = window.piApp;
  if (!api) return;
  try {
    emit({ status: await api.signOutM365Copilot(), setupError: undefined });
  } catch (error) {
    logFailure(error);
    emit({ setupError: "Copilot could not sign out. Try again in a moment." });
  }
}

function statusDescription(
  status: M365CopilotStatus | undefined,
  state: M365CopilotStatus["state"],
  isDefault: boolean,
  connecting: boolean,
  minutesLeftToSignIn: number | undefined,
): string {
  if (state === "ready" && status) {
    const account = status.account ? ` as ${status.account}` : "";
    const refresh =
      status.minutesLeft !== undefined
        ? ` Your sign-in refreshes automatically (${status.minutesLeft} minutes left).`
        : status.refreshable
          ? " Your sign-in refreshes automatically."
          : "";
    const external = status.managed
      ? ""
      : (status.detail ??
        " pi didn’t start this Copilot, so it can’t stop it or change its sign-in.");
    if (isDefault) {
      return `New threads use Microsoft 365 Copilot${account}.${refresh}${external}`;
    }
    return `Copilot is connected${account}, but new threads still use another model. Click “Use for new threads” to switch, or pick any model in Models.${refresh}${external}`;
  }
  const countdown =
    minutesLeftToSignIn !== undefined && minutesLeftToSignIn > 0
      ? ` About ${minutesLeftToSignIn} minutes left.`
      : "";
  if (state === "signing-in") {
    return `${WAITING_DETAIL}${countdown}`;
  }
  if (state === "waiting-for-sign-in") {
    return connecting
      ? `${WAITING_DETAIL}${countdown}`
      : (status?.detail ??
        "Click “Sign in” to open the Edge window and sign in with your work account.");
  }
  if (state === "starting") {
    return "Starting the local Copilot helper…";
  }
  if (state === "error") {
    return status?.detail ?? "Copilot ran into a problem. Click Connect to try again.";
  }
  return "Click Connect to sign in with your work account and start using Copilot.";
}

export function SettingsM365CopilotSection({
  runtime,
  onSaveCustomProvider,
  onSetDefaultModel,
}: {
  readonly runtime?: RuntimeSnapshot;
  readonly onSaveCustomProvider: (config: CustomProviderConfig) => Promise<string | undefined>;
  readonly onSetDefaultModel: (provider: string, modelId: string) => void;
}) {
  const [setup, setSetup] = useState<M365SetupSnapshot>(() => snapshot);

  useEffect(() => subscribeM365Setup(setSetup), []);

  useEffect(() => {
    void loadM365Status();
  }, []);

  // Adoption must survive unmount, so the module target is set but never cleared:
  // these callbacks stay valid (they close over App's setter), so a sign-in that
  // finishes after this page closes still registers Copilot.
  useEffect(() => {
    target = {
      saveProvider: onSaveCustomProvider,
      setDefaultModel: onSetDefaultModel,
      hasDefaultModel: () => Boolean(runtime?.settings.defaultProvider),
      onError: (message: string) => emit({ setupError: message }),
    };
  }, [runtime, onSaveCustomProvider, onSetDefaultModel]);

  const { status, connecting, setupError } = setup;
  const state = status?.state ?? "stopped";
  const isDefault =
    !!status &&
    runtime?.settings.defaultProvider === status.providerId &&
    runtime?.settings.defaultModelId === status.modelId;
  const minutesLeftToSignIn =
    setup.deadlineAt !== undefined
      ? Math.max(0, Math.ceil((setup.deadlineAt - Date.now()) / 60_000))
      : undefined;

  const busy = connecting || state === "starting" || state === "signing-in";
  const connectLabel =
    state === "starting"
      ? "Starting…"
      : state === "signing-in"
        ? "Signing in…"
        : connecting
          ? "Waiting for sign-in…"
          : state === "error"
            ? "Try again"
            : state === "waiting-for-sign-in"
              ? "Sign in"
              : "Connect";

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
              {statusDescription(status, state, isDefault, connecting, minutesLeftToSignIn)}
            </div>
            {setupError ? (
              <div className="settings-row__description" data-testid="m365-setup-error">
                {setupError}
              </div>
            ) : null}
          </div>
          <div className="settings-row__actions">
            {state !== "ready" ? (
              <button
                className="button button--primary m365-primary"
                data-testid="m365-connect"
                disabled={busy}
                type="button"
                onClick={() => {
                  void startM365Connect();
                }}
              >
                {connectLabel}
              </button>
            ) : null}
            {busy ? (
              <button
                className="button button--secondary"
                data-testid="m365-cancel"
                type="button"
                onClick={() => {
                  void cancelM365Connect();
                }}
              >
                Cancel
              </button>
            ) : null}
            {state === "ready" && !isDefault ? (
              <button
                className="button button--primary m365-primary"
                data-testid="m365-use-default"
                type="button"
                onClick={() => {
                  if (status) void adoptCopilot(status);
                }}
              >
                Use for new threads
              </button>
            ) : null}
            {state === "ready" && status?.managed ? (
              <button
                className="button button--secondary"
                data-testid="m365-switch-account"
                type="button"
                onClick={() => {
                  void signOutM365Copilot();
                }}
              >
                Switch account
              </button>
            ) : null}
            {state === "ready" ? (
              <button
                className="button button--secondary"
                data-testid="m365-disconnect"
                type="button"
                onClick={() => {
                  void disconnectM365Copilot();
                }}
              >
                Disconnect
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
