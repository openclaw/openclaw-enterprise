import { element, button } from "../dom.mjs";
import { message } from "./list.mjs";

function slackEnabled(values) {
  const slack = values?.channels?.slack;
  return (
    slack !== null && typeof slack === "object" && !Array.isArray(slack) && slack.enabled !== false
  );
}

function teamsEnabled(values) {
  const teams = values?.channels?.msteams;
  return (
    teams !== null && typeof teams === "object" && !Array.isArray(teams) && teams.enabled !== false
  );
}

export function runtimeCredentialBlockReason(values) {
  return teamsEnabled(values)
    ? "Microsoft Teams credentials and readiness are operator-managed and cannot be confirmed by this Credentials tab. Use the operator deployment workflow for Teams, or disable Teams to deploy here."
    : null;
}

export function requiredRuntimeCredentialGroups(values) {
  return [
    { id: "transport", label: "Transport", key: "transportConfigured" },
    { id: "model", label: "Model", key: "modelConfigured" },
    ...(slackEnabled(values) ? [{ id: "slack", label: "Slack", key: "slackConfigured" }] : []),
  ];
}

export function missingRuntimeCredentialGroups(status, values) {
  return requiredRuntimeCredentialGroups(values)
    .filter((group) => status?.[group.key] !== true)
    .map((group) => group.label);
}

export function hasRequiredRuntimeCredentials(status, values) {
  return (
    runtimeCredentialBlockReason(values) === null &&
    missingRuntimeCredentialGroups(status, values).length === 0
  );
}

function normalizedStatus(data) {
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.transportConfigured !== "boolean" ||
    typeof data.modelConfigured !== "boolean" ||
    typeof data.slackConfigured !== "boolean"
  )
    throw new Error("Invalid credential status response");
  return {
    transportConfigured: data.transportConfigured,
    modelConfigured: data.modelConfigured,
    slackConfigured: data.slackConfigured,
  };
}

function groupStatus(status, key) {
  return status?.[key] === true ? "Stored" : "Missing";
}

function credentialError(error, mutation = false) {
  let text;
  if (error.status === 403)
    text = "Access denied. You do not have permission for this credential operation.";
  else if (error.status === 409)
    text =
      "Credential metadata conflicts with the saved Agent state or is unsupported for this draft.";
  else if (error.status === 400) text = "Check the entered credential fields and refresh status.";
  else if (error.status === 429) text = "Too many requests. Wait before trying again.";
  else if (error.status === 404)
    text = "Credential metadata is unavailable for this Agent. Check the ID and your access.";
  else if (error.status === 503 || mutation)
    text =
      "Outcome unknown. Credential storage could not be confirmed. Refresh status before trying again.";
  else text = "Credential metadata unavailable. Refresh status before trying again.";
  return text + (error.requestId ? ` Request ID: ${error.requestId}` : "");
}

export function createRuntimeCredentialsPanel({
  context,
  path,
  values,
  revisionsLoaded,
  revisionCount,
  onStatusChange,
}) {
  const endpoint = `${path}/runtime-credentials`;
  const requiredGroups = requiredRuntimeCredentialGroups(values);
  const needsSlack = slackEnabled(values);
  const state = {
    status: null,
    loaded: false,
    loading: false,
    error: null,
    saving: false,
    saveError: null,
    saveMessage: "",
    outcomeUnknown: false,
  };
  const section = element("section", { className: "agent-card runtime-credentials" });

  function canEnterCredentials() {
    return revisionsLoaded && revisionCount === 0 && state.loaded && state.error === null;
  }

  function canDeploy() {
    return (
      revisionsLoaded &&
      state.loaded &&
      state.error === null &&
      hasRequiredRuntimeCredentials(state.status, values)
    );
  }

  function deployGateMessage() {
    if (!revisionsLoaded) return "Revision history is required before deploying this saved draft.";
    if (state.loading || (!state.loaded && state.error === null))
      return "Loading runtime credential metadata before deployment.";
    if (state.error !== null)
      return "Credential metadata unavailable. Refresh status before deploying.";
    const blockReason = runtimeCredentialBlockReason(values);
    if (blockReason !== null) return blockReason;
    const missing = missingRuntimeCredentialGroups(state.status, values);
    if (missing.length)
      return `Deploy requires stored runtime credential metadata: ${missing.join(", ")}.`;
    return "Stored runtime credential metadata is present. This does not confirm live model or Slack readiness.";
  }

  async function loadStatus() {
    if (state.loading || !context.isCurrent()) return;
    state.loading = true;
    state.error = null;
    state.saveError = null;
    state.saveMessage = "";
    state.outcomeUnknown = false;
    render();
    onStatusChange();
    try {
      state.status = normalizedStatus(await context.request(endpoint));
      if (!context.isCurrent()) return;
      state.loaded = true;
    } catch (error) {
      if (!context.isCurrent()) return;
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      state.status = null;
      state.loaded = false;
      state.error = error;
    } finally {
      if (context.isCurrent()) {
        state.loading = false;
        render();
        onStatusChange();
      }
    }
  }

  function renderStatuses() {
    const list = element("dl", { className: "credential-status-list" });
    for (const group of requiredGroups) {
      const status = groupStatus(state.status, group.key);
      list.append(
        element("dt", {}, group.label),
        element(
          "dd",
          {},
          element("span", { className: `credential-status ${status.toLowerCase()}` }, status),
        ),
      );
    }
    return list;
  }

  function renderForm() {
    const formId = "runtime-credentials-form";
    const modelStored = state.status?.modelConfigured === true;
    const slackStored = state.status?.slackConfigured === true;
    const modelApiKey = element("input", {
      id: "runtime-model-api-key",
      name: "runtime-model-api-key",
      type: "password",
      autocomplete: "off",
      disabled: !canEnterCredentials() || modelStored,
      "aria-describedby": "runtime-model-api-key-hint",
    });
    const slackAppToken = element("input", {
      id: "runtime-slack-app-token",
      name: "runtime-slack-app-token",
      type: "password",
      autocomplete: "off",
      disabled: !canEnterCredentials() || slackStored,
      "aria-describedby": "runtime-slack-app-token-hint",
    });
    const slackBotToken = element("input", {
      id: "runtime-slack-bot-token",
      name: "runtime-slack-bot-token",
      type: "password",
      autocomplete: "off",
      disabled: !canEnterCredentials() || slackStored,
      "aria-describedby": "runtime-slack-bot-token-hint",
    });
    const status = element("p", { className: "hint", role: "status" }, state.saveMessage);
    const error = element(
      "p",
      { className: "error", role: "alert" },
      state.saveError === null ? "" : credentialError(state.saveError, true),
    );
    const save = element(
      "button",
      { type: "submit", form: formId, className: "primary" },
      "Save credentials",
    );
    const updateControls = () => {
      const transportMissing = state.status?.transportConfigured !== true;
      const modelMissing = state.status?.modelConfigured !== true;
      const slackMissing = needsSlack && state.status?.slackConfigured !== true;
      const modelEntered = modelApiKey.value.length > 0;
      const slackAppEntered = slackAppToken.value.length > 0;
      const slackBotEntered = slackBotToken.value.length > 0;
      const slackPartial = needsSlack && slackAppEntered !== slackBotEntered;
      const slackEntered = needsSlack && slackAppEntered && slackBotEntered;
      const missingRequiredInput =
        (modelMissing && !modelEntered) || (slackMissing && !slackEntered);
      slackAppToken.setCustomValidity(slackPartial ? "Enter both Slack tokens." : "");
      slackBotToken.setCustomValidity(slackPartial ? "Enter both Slack tokens." : "");
      save.disabled =
        state.saving ||
        !canEnterCredentials() ||
        state.outcomeUnknown ||
        slackPartial ||
        missingRequiredInput ||
        (!transportMissing && !modelEntered && !slackEntered);
    };
    for (const input of [modelApiKey, slackAppToken, slackBotToken])
      input.addEventListener("input", () => {
        state.saveError = null;
        state.saveMessage = "";
        error.textContent = "";
        status.textContent = "";
        updateControls();
      });
    const fields = [
      element(
        "div",
        { className: "form-field" },
        element("label", { for: modelApiKey.id }, "OpenAI API key"),
        modelApiKey,
        element(
          "p",
          { id: "runtime-model-api-key-hint", className: "hint" },
          modelStored ? "Model credential is stored." : "Stored as an Agent-owned Secret.",
        ),
      ),
      ...(needsSlack
        ? [
            element(
              "div",
              { className: "form-field" },
              element("label", { for: slackAppToken.id }, "Slack app token"),
              slackAppToken,
              element(
                "p",
                { id: "runtime-slack-app-token-hint", className: "hint" },
                slackStored ? "Slack credential metadata is stored." : "Socket Mode app token.",
              ),
            ),
            element(
              "div",
              { className: "form-field" },
              element("label", { for: slackBotToken.id }, "Slack bot token"),
              slackBotToken,
              element(
                "p",
                { id: "runtime-slack-bot-token-hint", className: "hint" },
                slackStored
                  ? "Slack credential metadata is stored."
                  : "Bot token for Slack replies.",
              ),
            ),
          ]
        : []),
    ];
    const form = element(
      "form",
      { id: formId, className: "credential-form" },
      ...fields,
      status,
      error,
      element("div", { className: "form-actions" }, save),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.saving || !canEnterCredentials() || state.outcomeUnknown) return;
      if (!form.reportValidity()) return;
      let payload = {};
      const slackApp = slackAppToken.value;
      const slackBot = slackBotToken.value;
      if (modelApiKey.value.length > 0) payload.modelApiKey = modelApiKey.value;
      if (needsSlack && slackApp.length > 0 && slackBot.length > 0) {
        payload.slack = { appToken: slackApp, botToken: slackBot };
      }
      state.saving = true;
      state.saveError = null;
      state.saveMessage = "";
      status.textContent = "Saving credentials…";
      error.textContent = "";
      updateControls();
      try {
        state.status = normalizedStatus(
          await context.request(endpoint, { method: "POST", body: payload }),
        );
        if (!context.isCurrent()) return;
        state.loaded = true;
        state.outcomeUnknown = false;
        state.saveMessage = "Credential metadata refreshed.";
        status.textContent = state.saveMessage;
      } catch (cause) {
        if (!context.isCurrent()) return;
        if (cause.status === 401) {
          context.onExpired();
          return;
        }
        state.saveError = cause;
        state.saveMessage = "";
        state.outcomeUnknown =
          cause.status === undefined || ![400, 403, 404, 409, 429].includes(cause.status);
        status.textContent = "";
        error.textContent = credentialError(cause, true);
      } finally {
        modelApiKey.value = "";
        slackAppToken.value = "";
        slackBotToken.value = "";
        payload = undefined;
        if (context.isCurrent()) {
          state.saving = false;
          updateControls();
          render();
          onStatusChange();
        }
      }
    });
    updateControls();
    return form;
  }

  function renderUnavailableReason() {
    if (!revisionsLoaded)
      return element(
        "p",
        { className: "muted", role: "status" },
        "Credential entry requires readable revision history.",
      );
    if (revisionCount > 0)
      return element(
        "p",
        { className: "muted", role: "status" },
        "Initial credentials are locked after the first AgentRevision exists.",
      );
    if (state.error !== null)
      return element(
        "p",
        { className: "error", role: "alert" },
        `Credential metadata unavailable. ${credentialError(state.error)}`,
      );
    return null;
  }

  function render() {
    section.replaceChildren(
      ...[
        element("h2", {}, "Runtime credentials"),
        element(
          "p",
          { className: "muted" },
          "Stored means the controller found Agent-owned Secrets. It does not test model or Slack connectivity.",
        ),
        renderStatuses(),
        element(
          "div",
          { className: "form-actions credential-actions" },
          button(state.loading ? "Refreshing…" : "Refresh status", () => void loadStatus(), {
            disabled: state.loading || state.saving,
          }),
        ),
        renderUnavailableReason(),
        renderForm(),
      ].filter(Boolean),
    );
  }

  render();
  return {
    section,
    loadStatus,
    canDeploy,
    deployGateMessage,
  };
}
