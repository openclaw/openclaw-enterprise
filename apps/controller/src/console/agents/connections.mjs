import {
  CONNECTION_CHANNEL,
  rememberRedirectConnection,
  takeLandedOutcome,
} from "../connection-outcome.mjs";
import { button, element, statusBlock } from "../dom.mjs";
import { message, namespacePath } from "./list.mjs";

const POPUP_NAME = "oce-agent-connection";
const WITHDRAWAL_POLL_MS = 5000;

// Fixed sentences for the callback's safe reason codes (http/connections.ts). Unknown codes get
// the generic sentence; none of them carries provider text.
const RETRY_FROM_AGENT =
  "The consent response did not match a connection you started in this session. Connect again from this Agent.";
const FAILURE_TEXT = {
  consent_denied: "You declined access on the consent page. Nothing was connected.",
  provider_error:
    "The provider returned an error instead of granting access. Connect again; if it repeats, ask an administrator to check the connection template.",
  session_used_or_expired: "The consent session expired or was already used. Connect again.",
  session_required:
    "Your console session ended before consent finished. Sign in, then connect again.",
  missing_state: RETRY_FROM_AGENT,
  missing_code: RETRY_FROM_AGENT,
  unknown_session: RETRY_FROM_AGENT,
  invalid_session: RETRY_FROM_AGENT,
  state_mismatch: RETRY_FROM_AGENT,
  grant_refused: "The provider refused the authorization code. Connect again.",
  client_refused:
    "The provider refused this Installation's OAuth client. Ask an administrator to check the client ID and secret.",
  no_refresh_token:
    "The provider granted access without a refresh token, so the connection could not stay signed in. Ask an administrator to check the template's authorization parameters.",
  exchange_refused:
    "The provider's token endpoint refused the exchange. Ask an administrator to check the connection template.",
  issuer_unavailable: "The provider's token endpoint did not answer. Connect again later.",
  reserved_authorization_parameter:
    "The connection template sets an authorization parameter that OCC controls. Ask an administrator to correct the template.",
};
const GENERIC_FAILURE =
  "The connection could not be completed. Connect again later; if it repeats, ask an administrator.";

export function connectionFailureText(reason) {
  return FAILURE_TEXT[reason] ?? GENERIC_FAILURE;
}

function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function endpointText(endpoint) {
  const port = endpoint.port && endpoint.port !== 443 ? `:${endpoint.port}` : "";
  return `https://${endpoint.host}${port}${endpoint.path}`;
}

/**
 * The Agent's connected accounts (RFC-0023). Connecting needs this signed-in session, so it is a
 * console action: the owner reads a consent warning, approves on the provider's page in a popup
 * (or this tab when popups are blocked), and deploys a new version so the Agent receives the
 * account. While an account is connected, or its withdrawal is pending, the Agent is personal.
 * `deployLink` returns a link to the draft's Deploy new version.
 */
export function renderAgentConnections(context, { path, agent, deployLink }) {
  const { namespaceId, agentId, request } = context;
  const connectionsPath = `${path}/connections`;
  const heading = element("h2", { id: "agent-connections-title" }, "Connections");
  const intro = element(
    "p",
    {},
    "Connected accounts let this Agent’s tools call a provider as you. Only you can deploy or use the Agent while it holds your account, and it cannot be shared or use channels.",
  );
  const status = element("p", { className: "hint", role: "status" }, "Loading connections…");
  const outcome = element("div", { className: "agent-connections-outcome" });
  const list = element("ul", { className: "agent-connections-list", role: "list" });
  const available = element("div", { className: "agent-connections-available" });
  const error = element("p", { className: "error", role: "alert" });
  const section = element(
    "section",
    {
      className: "agent-connections",
      "aria-labelledby": "agent-connections-title",
      hidden: true,
    },
    heading,
    intro,
    outcome,
    status,
    list,
    available,
    error,
  );

  let currentAgent = agent;
  let connections = [];
  let templates = [];
  let templatesDenied = false;
  let activeSources = new Set();
  // Per source: { state, withdrawalInProgress } while a disconnect waits for withdrawal.
  const withdrawals = new Map();
  const sourceStatus = new Map();
  let denied = false;
  // The first read uses the Agent the page already read; later reads follow a connect or
  // disconnect, which change the Agent's credential sources.
  let agentFresh = true;
  let pending = null;
  let pollTimer = null;
  // The connection in progress: { templateId, sourceId, replaces, popup, dialog, expiresAt }.
  let attempt = null;
  // Templates named by ?connect= after Create Agent; the first opens its consent warning.
  const requested = (context.url.searchParams.get("connect") ?? "")
    .split(",")
    .filter((id) => /^ctp_[0-9a-f-]+$/.test(id));
  if (context.url.searchParams.has("connect")) {
    // Asked once: a reload or Back does not reopen the consent warning.
    const shown = new URL(location.href);
    shown.searchParams.delete("connect");
    history.replaceState(history.state, "", `${shown.pathname}${shown.search}`);
  }

  const templateById = (id) => templates.find((template) => template.id === id);
  const savedOnAgent = (sourceId) =>
    (currentAgent.credentialSources ?? []).some((source) => source.sourceId === sourceId);

  function showOutcome(tone, label, body, actions = []) {
    outcome.replaceChildren(statusBlock(tone, label, body, actions));
  }

  function failure(code, error) {
    if (error?.status === 401) {
      context.onExpired();
      return;
    }
    showOutcome("danger", "Not connected", [
      code ? connectionFailureText(code) : message(error, true),
      ...(error?.serverMessage ? [error.serverMessage] : []),
      ...(error?.requestId ? [`Request ID: ${error.requestId}`] : []),
    ]);
  }

  async function readActiveSources() {
    if (!currentAgent.activeRevisionId) {
      return new Set();
    }
    try {
      const revision = await request(
        `${path}/revisions/${encodeURIComponent(currentAgent.activeRevisionId)}`,
      );
      return new Set((revision.credentialSources ?? []).map((source) => source.sourceId));
    } catch {
      // Unknown: no deploy prompt rather than a wrong one.
      return null;
    }
  }

  async function readSourceStatus(sourceId) {
    try {
      const source = await request(
        `${namespacePath(namespaceId)}/credential-sources/${encodeURIComponent(sourceId)}`,
      );
      sourceStatus.set(sourceId, source.status ?? null);
    } catch {
      sourceStatus.delete(sourceId);
    }
  }

  async function readWithdrawal(sourceId) {
    try {
      const withdrawal = await request(
        `${path}/credential-sources/${encodeURIComponent(sourceId)}/withdrawal`,
      );
      withdrawals.set(sourceId, withdrawal);
    } catch (cause) {
      // No withdrawal: the active version never held the source.
      withdrawals.set(sourceId, cause.status === 404 ? { state: "none" } : { state: "unknown" });
    }
  }

  async function load() {
    if (!context.isCurrent()) {
      return;
    }
    if (pending) {
      // A read already in flight may predate the change the caller expects; read once more.
      return pending.then(() => load());
    }
    pending = (async () => {
      try {
        const [freshAgent, freshConnections, usable] = await Promise.all([
          agentFresh ? currentAgent : request(path),
          request(connectionsPath),
          templatesDenied
            ? []
            : request(`${namespacePath(namespaceId)}/connection-templates`).catch((cause) => {
                if (cause.status !== 403) {
                  throw cause;
                }
                // Without template use the owner can still see and disconnect accounts.
                templatesDenied = true;
                return [];
              }),
        ]);
        if (!context.isCurrent()) {
          return;
        }
        agentFresh = false;
        currentAgent = freshAgent;
        connections = freshConnections;
        templates = usable;
        // Only connected accounts need the serving version's sources.
        const active = connections.length ? await readActiveSources() : new Set();
        await Promise.all(
          connections.map((connection) =>
            savedOnAgent(connection.credentialSourceId)
              ? readSourceStatus(connection.credentialSourceId)
              : readWithdrawal(connection.credentialSourceId),
          ),
        );
        if (!context.isCurrent()) {
          return;
        }
        activeSources = active;
        denied = false;
        error.textContent = "";
      } catch (cause) {
        if (!context.isCurrent()) {
          return;
        }
        if (cause.status === 401) {
          context.onExpired();
          return;
        }
        denied = cause.status === 403;
        error.textContent = denied ? "" : message(cause);
      } finally {
        pending = null;
        if (context.isCurrent()) {
          render();
        }
      }
    })();
    return pending;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    const waiting = connections.some(
      (connection) =>
        !savedOnAgent(connection.credentialSourceId) &&
        withdrawals.get(connection.credentialSourceId)?.state === "pending",
    );
    if (waiting && context.isCurrent()) {
      pollTimer = setTimeout(() => void load(), WITHDRAWAL_POLL_MS);
    }
  }

  function connectionRow(connection) {
    const template = templateById(connection.connectionTemplateId);
    const name = template?.displayName ?? connection.connectionTemplateId;
    const sourceId = connection.credentialSourceId;
    const notes = [];
    const actions = [];
    let state;
    if (savedOnAgent(sourceId)) {
      const refresh = sourceStatus.get(sourceId)?.refresh;
      const outdated = template && template.current.version > connection.connectionTemplateVersion;
      if (refresh?.recoveryAction === "reauthorize") {
        state = "Reconnect required";
        notes.push(
          statusBlock(
            "danger",
            null,
            `${hostOf(template?.current.issuer ?? "")} no longer accepts this connection. Reconnect, then deploy a new version.`,
            [],
            { role: null },
          ),
        );
      } else if (outdated) {
        state = "Connected";
        notes.push(
          statusBlock(
            "warning",
            null,
            "An administrator changed this connection. It keeps working as you approved it; reconnect to apply the changes.",
            [],
            { role: null },
          ),
        );
      } else {
        state = "Connected";
      }
      if (activeSources !== null && !activeSources.has(sourceId)) {
        notes.push(
          element(
            "p",
            { className: "hint" },
            "Not in the running version yet. ",
            deployLink("Deploy a new version"),
            " so the Agent can use this account.",
          ),
        );
      }
      // The Credential Refresh Driver keeps a healthy connection signed in, so Reconnect appears
      // only when consent must happen again: the provider stopped accepting the grant, or an
      // administrator changed the template.
      const reauthorize = refresh?.recoveryAction === "reauthorize";
      if (template && !templatesDenied && (reauthorize || outdated)) {
        actions.push(
          button(
            reauthorize ? "Reconnect" : "Reconnect to apply changes",
            (event) => openConsent(template, event.currentTarget, sourceId),
            { tone: "secondary", size: "sm" },
          ),
        );
      }
      actions.push(
        button("Disconnect", (event) => openDisconnect(connection, name, event.currentTarget), {
          tone: "ghost",
          size: "sm",
        }),
      );
    } else {
      const withdrawal = withdrawals.get(sourceId);
      state = "Disconnecting";
      notes.push(
        element(
          "p",
          { className: "hint" },
          withdrawal?.state === "pending"
            ? withdrawal.withdrawalInProgress
              ? "Removing this account from the running version. The Agent stays personal until it is gone."
              : "Waiting to remove this account from the running version. The Agent stays personal until it is gone."
            : "Removed from the Agent. Finish disconnecting to delete the stored account.",
        ),
      );
      actions.push(
        button("Finish disconnecting", () => void disconnect(connection, name), {
          tone: "secondary",
          size: "sm",
          disabled: withdrawal?.state === "pending",
        }),
      );
    }
    return element(
      "li",
      { className: "agent-connection", "data-source-id": sourceId },
      element(
        "div",
        { className: "agent-connection-heading" },
        element("strong", {}, name),
        element(
          "span",
          {
            className: "badge",
            "data-tone":
              state === "Connected" ? "success" : state === "Disconnecting" ? "warning" : "danger",
          },
          state,
        ),
      ),
      element(
        "p",
        { className: "hint" },
        `Approved version ${connection.connectionTemplateVersion} · connected ${new Date(connection.createdAt).toLocaleString()}`,
      ),
      ...notes,
      element("div", { className: "agent-connection-actions" }, ...actions),
    );
  }

  function render() {
    section.hidden =
      denied ||
      (!error.textContent &&
        connections.length === 0 &&
        templates.length === 0 &&
        !outcome.childElementCount);
    status.textContent =
      connections.length === 0 && templates.length > 0 ? "No accounts are connected." : "";
    list.replaceChildren(...connections.map(connectionRow));
    const connectedTemplates = new Set(
      connections
        .filter((connection) => savedOnAgent(connection.credentialSourceId))
        .map((connection) => connection.connectionTemplateId),
    );
    available.replaceChildren(
      ...templates
        .filter((template) => !connectedTemplates.has(template.id))
        .map((template) =>
          button(
            `Connect ${template.displayName}`,
            (event) => openConsent(template, event.currentTarget, null),
            { tone: "secondary", disabled: attempt !== null },
          ),
        ),
    );
    schedulePoll();
  }

  function consentDetails(template) {
    const version = template.current;
    return element(
      "dl",
      { className: "agent-connection-consent" },
      element("dt", {}, "Provider"),
      element("dd", {}, hostOf(version.issuer)),
      element("dt", {}, "Access you approve"),
      element(
        "dd",
        {},
        element(
          "ul",
          {},
          ...version.scopes.map((scope) => element("li", {}, element("code", {}, scope))),
        ),
      ),
      element("dt", {}, "Tools can call"),
      element("dd", {}, element("code", {}, endpointText(version.endpoint))),
    );
  }

  function openConsent(template, invoker, replaces) {
    if (attempt) {
      return;
    }
    const dialog = element("dialog", {
      className: "dialog agent-connection-dialog",
      "aria-labelledby": "agent-connection-dialog-title",
    });
    const provider = hostOf(template.current.issuer);
    const progress = element("p", { role: "status", "aria-live": "polite" });
    const refusal = element("p", { className: "error", role: "alert" });
    const cancel = button("Cancel", () => dialog.close());
    // Set once the API returns the consent URL; the primary button then reopens the window.
    let started = null;
    const proceed = button(
      `Continue to ${provider}`,
      () => (started ? showConsentWindow() : void start()),
      { tone: "primary" },
    );
    dialog.append(
      element(
        "h2",
        { id: "agent-connection-dialog-title" },
        replaces ? `Reconnect ${template.displayName}` : `Connect ${template.displayName}`,
      ),
      element("p", {}, "Agent: ", element("strong", {}, currentAgent.name)),
      consentDetails(template),
      statusBlock(
        "warning",
        "This Agent becomes personal",
        [
          "Anyone who can prompt this Agent could read this account’s data through its tools, so OCC lets only you deploy and use it. Sharing, Slack and other channels are refused while the account is connected.",
        ],
        [],
        { role: null },
      ),
      element(
        "p",
        { className: "hint" },
        replaces
          ? "After you approve, the new connection replaces the current one. Deploy a new version to apply it."
          : "After you approve, deploy a new version so the Agent can use the account.",
      ),
      progress,
      refusal,
      element("div", { className: "dialog-actions" }, cancel, proceed),
    );
    dialog.addEventListener("close", () => {
      if (attempt?.dialog === dialog) {
        abandon();
      }
      dialog.remove();
      if (invoker.isConnected && !invoker.disabled) {
        invoker.focus();
      }
    });

    async function start() {
      proceed.disabled = true;
      refusal.textContent = "";
      progress.textContent = `Opening ${provider}…`;
      // Opened inside the click, before the request, so popup blockers allow it.
      const popup = window.open("", POPUP_NAME, "popup,width=520,height=720");
      attempt = { templateId: template.id, replaces, popup, dialog, sourceId: null };
      render();
      try {
        started = await request(connectionsPath, {
          method: "POST",
          body: { connectionTemplateId: template.id },
        });
      } catch (cause) {
        popup?.close();
        attempt = null;
        if (!context.isCurrent()) {
          return;
        }
        if (cause.status === 401) {
          context.onExpired();
          return;
        }
        progress.textContent = "";
        refusal.textContent = [
          message(cause, true),
          cause.serverMessage,
          cause.requestId && `Request ID: ${cause.requestId}`,
        ]
          .filter(Boolean)
          .join(" ");
        proceed.disabled = false;
        render();
        return;
      }
      if (!context.isCurrent()) {
        popup?.close();
        return;
      }
      attempt.sourceId = started.credentialSourceId;
      attempt.expiresAt = Date.parse(started.expiresAt);
      if (!popup || popup.closed) {
        // Popups blocked: consent happens in this tab and the callback returns here.
        progress.textContent = `Redirecting to ${provider}…`;
        rememberRedirectConnection({ namespaceId, agentId, replaces });
        location.assign(started.authorizationUrl);
        return;
      }
      popup.location.href = started.authorizationUrl;
      progress.textContent = `Approve access in the ${provider} window. This page updates when you finish.`;
      proceed.textContent = "Show consent window";
      proceed.disabled = false;
      // Closing keeps the server session; it expires unused after ten minutes.
      cancel.textContent = "Stop waiting";
    }

    function showConsentWindow() {
      // A provider's opener policy can sever the first handle. Opening by name finds the window
      // when it can, or opens a new one on the same consent URL, which stays valid until used.
      const shown = window.open("", POPUP_NAME, "popup,width=520,height=720");
      try {
        if (shown && shown.location.href === "about:blank") {
          shown.location.href = started.authorizationUrl;
        }
      } catch {
        // Cross-origin: the window is still on the provider's page.
      }
      shown?.focus();
    }
    section.append(dialog);
    dialog.showModal();
    cancel.focus();
  }

  function abandon() {
    attempt = null;
    if (context.isCurrent()) {
      render();
    }
  }

  async function finishConnected(replaces, name) {
    await load();
    if (!context.isCurrent()) {
      return;
    }
    const link = deployLink("Deploy new version");
    showOutcome(
      "success",
      "Connected",
      [
        `${name ? `${name} is connected.` : "The account is connected."} Deploy a new version so the Agent can use it.`,
      ],
      [link],
    );
    if (replaces) {
      const old = connections.find((connection) => connection.credentialSourceId === replaces);
      if (old) {
        await disconnect(old, name, { quiet: true });
      }
    }
  }

  async function disconnect(connection, name, { quiet = false } = {}) {
    try {
      const result = await request(
        `${connectionsPath}/${encodeURIComponent(connection.credentialSourceId)}`,
        { method: "DELETE" },
      );
      if (!context.isCurrent()) {
        return;
      }
      if (!quiet) {
        showOutcome(
          result.deleted ? "success" : "info",
          result.deleted ? "Disconnected" : "Disconnecting",
          result.deleted
            ? `${name} is disconnected and its stored account is deleted.`
            : result.withdrawalRequested
              ? `${name} is removed from the Agent. OCC is withdrawing it from the running version; the Agent stays personal until that finishes.`
              : `${name} is removed from the Agent. OCC cannot delete the stored account yet: a new account must wait about a minute, and a pending deployment keeps it until that deployment ends. Choose Finish disconnecting later.`,
        );
      }
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      failure(null, cause);
    }
    await load();
  }

  function openDisconnect(connection, name, invoker) {
    const dialog = element("dialog", {
      className: "dialog agent-connection-dialog",
      "aria-labelledby": "agent-disconnect-title",
    });
    const cancel = button("Cancel", () => dialog.close());
    const confirm = button(
      "Disconnect",
      async () => {
        confirm.disabled = true;
        cancel.disabled = true;
        await disconnect(connection, name);
        dialog.close();
      },
      { tone: "danger" },
    );
    dialog.append(
      element("h2", { id: "agent-disconnect-title" }, `Disconnect ${name}?`),
      element(
        "p",
        {},
        "The Agent loses access to this account. A running version keeps it until OCC confirms withdrawal, and the Agent stays personal until then. Connecting again asks for consent again.",
      ),
      element("div", { className: "dialog-actions" }, cancel, confirm),
    );
    dialog.addEventListener("cancel", (event) => {
      if (confirm.disabled) {
        event.preventDefault();
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (invoker.isConnected) {
        invoker.focus();
      }
    });
    section.append(dialog);
    dialog.showModal();
    cancel.focus();
  }

  // The landed popup reports here. Only a tab with a popup attempt claims an outcome; a failure
  // carries no Agent, so it is matched to this tab's attempt.
  const channel =
    typeof BroadcastChannel === "function" ? new BroadcastChannel(CONNECTION_CHANNEL) : null;
  if (channel) {
    channel.onmessage = (event) => {
      const data = event.data;
      if (!context.isCurrent()) {
        channel.close();
        return;
      }
      if (data?.type !== "outcome" || !attempt?.sourceId) {
        return;
      }
      if (data.outcome === "connected" && data.agentId !== agentId) {
        return;
      }
      channel.postMessage({ type: "claimed", id: data.id });
      const { dialog, replaces, templateId } = attempt;
      attempt = null;
      dialog.close();
      if (data.outcome === "connected") {
        void finishConnected(replaces, templateById(templateId)?.displayName);
      } else {
        failure(data.reason ?? "unavailable");
        void load();
      }
    };
  }
  // A missed message (a closed channel, a browser without one): returning to this tab rereads,
  // and the started source showing up as a connection means consent finished.
  const onFocus = () => {
    if (!context.isCurrent()) {
      window.removeEventListener("focus", onFocus);
      return;
    }
    if (!attempt?.sourceId) {
      return;
    }
    if (Date.now() > attempt.expiresAt) {
      const { dialog } = attempt;
      attempt = null;
      dialog.close();
      failure("session_used_or_expired");
      return;
    }
    const sourceId = attempt.sourceId;
    void load().then(() => {
      if (
        attempt?.sourceId === sourceId &&
        connections.some((item) => item.credentialSourceId === sourceId)
      ) {
        const { dialog, replaces, templateId } = attempt;
        attempt = null;
        dialog.close();
        void finishConnected(replaces, templateById(templateId)?.displayName);
      }
    });
  };
  window.addEventListener("focus", onFocus);

  const landed = takeLandedOutcome(namespaceId, agentId);
  const ready = load().then(() => {
    if (!context.isCurrent()) {
      return;
    }
    if (landed?.outcome === "connected") {
      void finishConnected(landed.replaces, null);
    } else if (landed?.outcome === "failed") {
      failure(landed.reason ?? "unavailable");
      render();
    } else if (requested.length) {
      const template = templateById(requested[0]);
      if (template && !connections.some((item) => item.connectionTemplateId === template.id)) {
        openConsent(template, heading, null);
      }
    }
  });

  return {
    section,
    ready,
    refresh() {
      void load();
    },
  };
}

/**
 * Create Agent's choice of accounts to connect. Connecting needs the saved Agent, so the choice
 * travels to Agent details, which opens the first consent warning. Hidden when the caller may
 * use no template in this Namespace.
 */
export function createConnectionChoices(context, namespaceId, onChange) {
  const options = element("div", {
    className: "connection-choices",
    role: "group",
    "aria-labelledby": "connection-choices-heading",
  });
  const section = element(
    "section",
    {
      className: "connection-choice-fields",
      "aria-labelledby": "connection-choices-heading",
      hidden: true,
    },
    element("h2", { id: "connection-choices-heading" }, "Connections"),
    element(
      "p",
      { className: "hint" },
      "Connect your own account after the Agent is created. Connecting asks for your consent, and the Agent becomes personal: only you can deploy and use it, and it cannot be shared or use channels.",
    ),
    options,
  );
  const boxes = [];
  void context
    .request(`${namespacePath(namespaceId)}/connection-templates`)
    .then((templates) => {
      if (!context.isCurrent() || templates.length === 0) {
        return;
      }
      for (const template of templates) {
        const box = element("input", {
          type: "checkbox",
          id: `connect-${template.id}`,
          value: template.id,
        });
        box.addEventListener("change", onChange);
        boxes.push(box);
        options.append(
          element(
            "label",
            { className: "connection-choice", for: box.id },
            box,
            element("span", {}, template.displayName),
            element("span", { className: "muted" }, hostOf(template.current.issuer)),
          ),
        );
      }
      section.hidden = false;
    })
    // No template to offer (403 without use, or an unavailable read) leaves the form as it was.
    .catch(() => undefined);
  return {
    section,
    selected: () => boxes.filter((box) => box.checked).map((box) => box.value),
    setDisabled(disabled) {
      for (const box of boxes) {
        box.disabled = disabled;
      }
    },
  };
}
