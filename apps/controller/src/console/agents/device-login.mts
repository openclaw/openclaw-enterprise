import type {
  CredentialSourceDeviceAuthorization,
  CredentialSourceReference,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import { button, element } from "../dom.mjs";
import type { AgentAccessContext } from "./credential-access.mjs";
import { askAdministratorTo, notIncluded } from "./access-reasons.mjs";
import { message, namespacePath } from "./list.mjs";

// The Console retains the public challenge and reference, never the provider's private state.
type DeviceChallenge = Pick<
  CredentialSourceDeviceAuthorization,
  "verificationUrl" | "userCode" | "expiresAt" | "intervalSeconds"
> & { session: SecretReference } & (
    { status: "pending" } | { status: "ready"; source: CredentialSourceReference }
  );

// Without a confirmed session reference, the Console can neither poll nor cancel that start.
// Keep this outcome in the form draft so restoring it does not offer a duplicate sign-in.
export type DeviceLogin = DeviceChallenge | { status: "start_unconfirmed" };

function readLogin(
  value: unknown,
  namespaceId: string,
  expectedSessionId: string | undefined,
): DeviceChallenge {
  const { status, userCode, intervalSeconds, expiresAt, verificationUrl, session, source } =
    responseFields(value);
  const { kind, id, namespaceId: sessionNamespace } = responseFields(session);
  if (
    kind !== "secret" ||
    typeof id !== "string" ||
    sessionNamespace !== namespaceId ||
    (expectedSessionId !== undefined && id !== expectedSessionId) ||
    typeof userCode !== "string" ||
    typeof intervalSeconds !== "number" ||
    !Number.isSafeInteger(intervalSeconds) ||
    intervalSeconds < 1 ||
    typeof verificationUrl !== "string" ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new Error("Invalid device authorization response");
  }
  const challenge = { userCode, verificationUrl, intervalSeconds, expiresAt };
  const reference: SecretReference = { kind, id, namespaceId };
  if (status === "pending") {
    return { ...challenge, session: reference, status };
  }
  const credential = responseFields(source);
  if (
    status !== "ready" ||
    credential.kind !== "credential_source" ||
    credential.namespaceId !== namespaceId ||
    typeof credential.id !== "string"
  ) {
    throw new Error("Invalid device authorization source");
  }
  return {
    ...challenge,
    session: reference,
    status,
    source: { kind: credential.kind, id: credential.id, namespaceId },
  };
}

// What each device-authorization request checks (packages/occ/src/index.ts), so a 403 names it
// (finding 2577). Every start creates a Secret and a credential source, and Namespace Roles cannot
// grant create, so only an Installation administrator can start one. Create Agent's requests also
// check Agent create; Agent detail's check Agent read and update on that Agent. Poll and cancel
// check Secret operate on the login's Secret, and poll operate on its credential source too.
type DeviceLoginStep = "start" | "poll" | "cancel";
const START_REMEDY =
  "which only an Installation administrator holds: choose another authentication method, or ask one to set up this sign-in.";

function deviceLoginDenied(step: DeviceLoginStep, agentScoped: boolean) {
  if (step === "start") {
    return agentScoped
      ? `Your access does not include starting a device login for this Agent. It needs Agent read and update on it, plus Secret create and credential source create in this Namespace, ${START_REMEDY}`
      : `Your access does not include starting a device login in this Namespace. It needs Agent create, Secret create and credential source create here, ${START_REMEDY}`;
  }
  const task = step === "poll" ? "finishing this device login" : "cancelling this device login";
  const login =
    step === "poll"
      ? "Secret operate on the login's Secret and credential source operate on its credential source"
      : "Secret operate on the login's Secret";
  return agentScoped
    ? notIncluded(task, `Agent read and update on this Agent, plus ${login}`)
    : `Your access does not include ${task}. It needs Agent create in this Namespace, which only an Installation administrator holds, plus ${login}. ${askAdministratorTo("check your access")}`;
}

export function createDeviceLogin({
  context,
  agentId,
  initial,
  onChange,
  hint,
}: {
  context: AgentAccessContext;
  agentId?: string | undefined;
  initial?: DeviceLogin | null | undefined;
  onChange?(source: CredentialSourceReference | null): void;
  hint: string;
}) {
  const base = `${namespacePath(context.namespaceId)}/agents${agentId ? `/${encodeURIComponent(agentId)}` : ""}/device-authorizations`;
  let login = initial ?? null;
  let active = true;
  let disabled = false;
  let busy = false;
  let timer: number | undefined;
  let error = "";
  const status = element("p", { role: "status", className: "hint" });
  const code = element("code", { className: "device-login-code" });
  const signIn = element(
    "a",
    { target: "_blank", rel: "noopener noreferrer" },
    "Open Codex sign-in",
  );
  const instructions = element(
    "div",
    {},
    element("p", {}, "Open Codex sign-in and enter this code: ", code),
    signIn,
  );
  const start = button("Sign in with OAuth", () => void begin());
  const cancel = button("Cancel login", () => void discard());
  const section = element(
    "div",
    { className: "device-login form-field" },
    element(
      "p",
      { className: "hint" },
      element("strong", {}, "Experimental. "),
      "ChatGPT sign-in, plugin access, deployment, and credential recovery may not work as expected.",
    ),
    element("p", { className: "hint" }, hint),
    instructions,
    status,
    element("div", { className: "form-actions" }, start, cancel),
  );

  function update() {
    clearTimeout(timer);
    const challenge = login && "session" in login ? login : null;
    const unconfirmed = login?.status === "start_unconfirmed";
    section.hidden = !active;
    instructions.hidden = challenge?.status !== "pending";
    code.textContent = challenge?.userCode ?? "";
    // The selected provider returns its fixed device authorization URL, never a tokenized link.
    if (challenge?.verificationUrl === "https://auth.openai.com/codex/device") {
      signIn.href = challenge.verificationUrl;
    } else {
      signIn.removeAttribute("href");
    }
    start.hidden = Boolean(challenge);
    cancel.hidden = !challenge;
    cancel.textContent = challenge?.status === "ready" ? "Clear selection" : "Cancel login";
    for (const control of [start, cancel]) {
      control.disabled = disabled || busy || unconfirmed;
    }
    status.textContent =
      error ||
      (busy
        ? "Checking Codex login…"
        : unconfirmed
          ? "Sign-in may have started, but the Console could not confirm it. Do not start another sign-in until an Installation administrator investigates the pending attempt."
          : challenge?.status === "ready"
            ? "ChatGPT login ready. Clearing this selection leaves the saved credential source available."
            : challenge
              ? "Waiting for you to complete sign-in in the other tab…"
              : "Sign in to connect your ChatGPT account.");
    if (active && !disabled && !busy && !error && login?.status === "pending") {
      timer = window.setTimeout(() => void poll(), login.intervalSeconds * 1_000);
    }
  }

  function accept(result: unknown) {
    const sessionId = login?.status === "pending" ? login.session.id : undefined;
    login = readLogin(result, context.namespaceId, sessionId);
    error = "";
    onChange?.(login.status === "ready" ? login.source : null);
  }

  function fail(cause: unknown, step: DeviceLoginStep) {
    const failure = requestFailure(cause);
    if (failure.status === 401) {
      context.onExpired();
    } else {
      error =
        failure.status === 403
          ? deviceLoginDenied(step, agentId !== undefined)
          : failure.status === 410
            ? "This login expired. Cancel it and start a new login."
            : failure.status === 501
              ? "ChatGPT sign-in is unavailable for this Installation. Choose another authentication method."
              : !login && failure.status === 503 && failure.code === "DEPENDENCY_UNAVAILABLE"
                ? // Starting reaches the sign-in service from the API; its reply names the cause.
                  `Codex sign-in failed. ${failure.serverMessage ?? "A required service is unavailable. Try again."}`
                : `Codex login could not be completed. ${message(cause)} ${login ? "Cancel this login and sign in again." : "Try signing in again."}`;
    }
  }

  async function begin() {
    if (busy || disabled || login || !active) {
      return;
    }
    // Navigation captures the draft before aborting the view's requests. Retain the
    // attempt now, because a committed start may lose its response when the view leaves.
    login = { status: "start_unconfirmed" };
    busy = true;
    error = "";
    update();
    try {
      const result = await context.request(base, { method: "POST", body: { harnessId: "codex" } });
      if (context.isCurrent()) {
        accept(result);
      }
    } catch (failure) {
      if (context.isCurrent()) {
        const { status } = requestFailure(failure);
        if (status === undefined || (status >= 200 && status < 300)) {
          // A lost or unusable successful reply can follow a committed start. Never repeat it.
          login = { status: "start_unconfirmed" };
          onChange?.(null);
        } else {
          login = null;
          fail(failure, "start");
        }
      }
    } finally {
      busy = false;
      if (context.isCurrent()) {
        update();
      }
    }
  }

  async function poll() {
    if (busy || disabled || !active || login?.status !== "pending") {
      return;
    }
    if (Date.parse(login.expiresAt) <= Date.now()) {
      error = "This login expired. Cancel it and start a new login.";
      update();
      return;
    }
    if (!context.isCurrent()) {
      // Retained tabs resume without rendering. Keep the timer until expiry, but do not poll
      // the server while this view is hidden.
      update();
      return;
    }
    busy = true;
    error = "";
    update();
    try {
      const result = await context.request(`${base}/${encodeURIComponent(login.session.id)}/poll`, {
        method: "POST",
        body: {},
      });
      if (context.isCurrent()) {
        accept(result);
      }
    } catch (failure) {
      if (context.isCurrent()) {
        fail(failure, "poll");
      }
    } finally {
      busy = false;
      update();
    }
  }

  async function discard() {
    if (busy || disabled || !login || login.status === "start_unconfirmed") {
      return;
    }
    // Withdraw the source before the request so a concurrent save cannot submit it.
    const discarded = login;
    login = null;
    onChange?.(null);
    busy = true;
    error = "";
    update();
    try {
      await context.request(`${base}/${encodeURIComponent(discarded.session.id)}`, {
        method: "DELETE",
        expectedStatus: 204,
      });
    } catch (failure) {
      login = discarded;
      onChange?.(discarded.status === "ready" ? discarded.source : null);
      fail(failure, "cancel");
    } finally {
      busy = false;
      if (context.isCurrent()) {
        update();
      }
    }
  }

  update();
  return {
    section,
    capture: () => login,
    get source() {
      return login?.status === "ready" ? login.source : null;
    },
    setActive(value: boolean) {
      active = value;
      update();
    },
    setDisabled(value: boolean) {
      disabled = value;
      update();
    },
  };
}
