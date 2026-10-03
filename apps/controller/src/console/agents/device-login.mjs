import { button, element } from "../dom.mjs";
import { message, namespacePath } from "./list.mjs";

export function createDeviceLogin({ context, agentId, initial, onChange, hint }) {
  const base = `${namespacePath(context.namespaceId)}/agents${agentId ? `/${encodeURIComponent(agentId)}` : ""}/device-authorizations`;
  let login = initial ?? null;
  let active = true;
  let disabled = false;
  let busy = false;
  let timer;
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
      "Codex OAuth is intended for trying a first deployment. Reconnects, later revisions, and credential recovery have known limitations.",
    ),
    element("p", { className: "hint" }, hint),
    instructions,
    status,
    element("div", { className: "form-actions" }, start, cancel),
  );

  function update() {
    clearTimeout(timer);
    section.hidden = !active;
    instructions.hidden = login?.status !== "pending";
    code.textContent = login?.userCode ?? "";
    // The selected provider returns its fixed device authorization URL, never a tokenized link.
    if (login?.verificationUrl === "https://auth.openai.com/codex/device") {
      signIn.href = login.verificationUrl;
    } else {
      signIn.removeAttribute("href");
    }
    start.hidden = Boolean(login);
    cancel.hidden = !login;
    cancel.textContent = login?.status === "ready" ? "Discard staged login" : "Cancel login";
    for (const control of [start, cancel]) {
      control.disabled = disabled || busy;
    }
    status.textContent =
      error ||
      (busy
        ? "Checking Codex login…"
        : login?.status === "ready"
          ? "ChatGPT login ready. Credentials are stored on the server."
          : login
            ? "Waiting for you to complete sign-in in the other tab…"
            : "Sign in to connect your ChatGPT account.");
    if (active && !disabled && !busy && !error && login?.status === "pending") {
      timer = setTimeout(() => void poll(), Math.max(1, login.intervalSeconds) * 1_000);
    }
  }

  function accept(result) {
    login = result;
    error = "";
    onChange?.(login.status === "ready" ? login.source : null);
  }

  function fail(failure) {
    if (failure.status === 401) {
      context.onExpired();
    } else {
      error =
        failure.status === 403
          ? "Access denied. Ask an administrator for permission to manage this Agent's login."
          : failure.status === 410
            ? "This login expired. Cancel it and start a new login."
            : failure.status === 501
              ? "ChatGPT sign-in is unavailable for this Installation. Choose another authentication method."
              : !login && failure.status === 503 && failure.code === "DEPENDENCY_UNAVAILABLE"
                ? // Starting reaches the sign-in service from the API; its reply names the cause.
                  `Codex sign-in failed. ${failure.serverMessage ?? "A required service is unavailable. Try again."}`
                : `Codex login could not be completed. ${message(failure)} ${login ? "Cancel this login and sign in again." : "Try signing in again."}`;
    }
  }

  async function begin() {
    if (busy || disabled || login || !active) {
      return;
    }
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
        fail(failure);
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
      const result = await context.request(`${base}/${encodeURIComponent(login.source.id)}/poll`, {
        method: "POST",
        body: {},
      });
      if (context.isCurrent()) {
        accept(result);
      }
    } catch (failure) {
      if (context.isCurrent()) {
        fail(failure);
      }
    } finally {
      busy = false;
      update();
    }
  }

  async function discard() {
    if (busy || disabled || !login) {
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
      await context.request(`${base}/${encodeURIComponent(discarded.source.id)}`, {
        method: "DELETE",
        expectedStatus: 204,
      });
    } catch (failure) {
      login = discarded;
      onChange?.(discarded.status === "ready" ? discarded.source : null);
      fail(failure);
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
    setActive(value) {
      active = value;
      update();
    },
    setDisabled(value) {
      disabled = value;
      update();
    },
  };
}
