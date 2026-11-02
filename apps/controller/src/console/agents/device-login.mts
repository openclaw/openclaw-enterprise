import type {
  CredentialSourceDeviceAuthorization,
  CredentialSourceReference,
  InstallationCapabilities,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import { button, element, setUnavailable } from "../dom.mjs";
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

// A start needs a selected Credential Gateway that lists one refresh source type with a Codex
// device login, and a selected Credential Refresh Driver (packages/occ/src/index.ts). The
// Installation's capabilities list the Gateway's source types only while one is selected, so a
// list without that type means every start is refused with 501 (finding 2991). They do not say
// whether a Refresh Driver is selected: true can still be refused, and that 501 names why.
export function deviceLoginOffered(capabilities: InstallationCapabilities | undefined) {
  return (capabilities?.credentialSources?.types ?? []).some(
    (type) => type.rotation === "refresh" && type.deviceAuthorization?.harnessId === "codex",
  );
}

const NOT_OFFERED =
  "ChatGPT sign-in needs a Credential Gateway that offers ChatGPT device login and a Credential Refresh Driver, and this Installation's Drivers do not offer it. Choose another authentication method.";

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
  onStartSettled,
  hint,
}: {
  context: AgentAccessContext;
  agentId?: string | undefined;
  initial?: DeviceLogin | null | undefined;
  onChange?(source: CredentialSourceReference | null): void;
  // Called once a start's outcome is settled, so a form no longer shown can record it.
  onStartSettled?(): void;
  hint: string;
}) {
  const base = `${namespacePath(context.namespaceId)}/agents${agentId ? `/${encodeURIComponent(agentId)}` : ""}/device-authorizations`;
  let login = initial ?? null;
  let active = true;
  let disabled = false;
  let busy = false;
  let timer: number | undefined;
  let error = "";
  // Why this Installation cannot start a device login: its capabilities say so, or a start was
  // refused with 501. Sign in then stays unavailable, described by this reason (finding 2991).
  let refusal: string | null = null;
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
    // Sign in and Cancel login replace each other in place. Pressing one hides it, so focus moves
    // to the one shown instead of falling to the page (finding 2992, as 1905).
    const focused = document.activeElement;
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
              : (refusal ?? "Sign in to connect your ChatGPT account."));
    const left = [start, cancel].find((control) => control === focused && control.hidden);
    if (active && left) {
      const shown = left === start ? cancel : start;
      shown.disabled = false;
      shown.focus();
    }
    // A focused control stays focused while a request runs (setUnavailable); an unconfirmed start
    // or a refusal keeps Sign in in the Tab order, described by the status that says why.
    const refused = !challenge && !busy && (unconfirmed || refusal !== null);
    for (const control of [start, cancel]) {
      setUnavailable(
        control,
        disabled || busy || unconfirmed || (control === start && refusal !== null),
        control === start && refused ? status : null,
      );
    }
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
              ? // The API names which Driver the Installation lacks (finding 2991).
                `ChatGPT sign-in is unavailable for this Installation. ${failure.serverMessage ? `${failure.serverMessage} ` : ""}Choose another authentication method.`
              : !login && failure.status === 503 && failure.code === "DEPENDENCY_UNAVAILABLE"
                ? // Starting reaches the sign-in service from the API; its reply names the cause.
                  `Codex sign-in failed. ${failure.serverMessage ?? "A required service is unavailable. Try again."}`
                : `Codex login could not be completed. ${message(cause)} ${login ? "Cancel this login and sign in again." : "Try signing in again."}`;
    }
  }

  async function begin() {
    if (busy || disabled || login || refusal !== null || !active) {
      return;
    }
    // Navigation captures the draft before aborting the view's requests. Retain the
    // attempt now, because a committed start may lose its response when the view leaves.
    login = { status: "start_unconfirmed" };
    busy = true;
    error = "";
    update();
    // A reply that lands after the reader left this Agent tab still settles the start: a kept
    // tab shows it on return (finding 2980), and the draft records it for a rebuilt tab (finding
    // 2981). Leaving the page drops the reply.
    const settles = () => context.isPageCurrent?.() ?? context.isCurrent();
    try {
      const result = await context.request(base, {
        method: "POST",
        body: { harnessId: "codex" },
        keepsTab: true,
      });
      if (settles()) {
        accept(result);
      }
    } catch (failure) {
      if (settles()) {
        const { status } = requestFailure(failure);
        if (status === undefined || (status >= 200 && status < 300)) {
          // A lost or unusable successful reply can follow a committed start. Never repeat it.
          login = { status: "start_unconfirmed" };
          onChange?.(null);
        } else {
          login = null;
          fail(failure, "start");
          // Every later start is refused the same way until the Installation's Drivers change.
          if (status === 501) {
            refusal = error;
            error = "";
          }
        }
      }
    } finally {
      busy = false;
      if (settles()) {
        update();
        onStartSettled?.();
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
        showsOutcome: true,
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
        showsOutcome: true,
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
    // Whether the Installation's Drivers offer a device login (deviceLoginOffered); undefined
    // when unknown. A start's 501 reason is kept over the generic one.
    setOffered(value: boolean | undefined) {
      if (value === false) {
        refusal ??= NOT_OFFERED;
      } else if (refusal === NOT_OFFERED) {
        refusal = null;
      }
      update();
    },
  };
}
