import { element, button } from "../dom.mjs";
import { namespacePath } from "./list.mjs";
import { ensureCredentialOperateBinding } from "./credential-access.mjs";
import { createSecretReferenceField, secretBinding, secretIdForBinding } from "./secret-picker.mjs";

export const SLACK_SECRET_BINDINGS = [
  { key: "SLACK_APP_TOKEN", label: "Slack app token", secretName: "Slack app token" },
  { key: "SLACK_BOT_TOKEN", label: "Slack bot token", secretName: "Slack bot token" },
];
function slackEnabled(values) {
  const slack = values?.channels?.slack;
  return (
    slack !== null && typeof slack === "object" && !Array.isArray(slack) && slack.enabled !== false
  );
}

// Named accounts must not use the standard keys: OpenClaw reads SLACK_APP_TOKEN and
// SLACK_BOT_TOKEN as an extra implicit default account. For them, require exactly the
// environment keys the native document references; null means the default account only.
function namedSlackAccountKeys(values) {
  const slack = values?.channels?.slack;
  if (slack?.accounts === undefined && slack?.account === undefined) {
    return null;
  }
  const accounts =
    slack.accounts !== null && typeof slack.accounts === "object" ? slack.accounts : {};
  const keys = new Set();
  for (const account of [slack, ...Object.values(accounts)]) {
    for (const ref of [account?.appToken, account?.botToken]) {
      if (ref?.source === "env" && typeof ref.id === "string") {
        keys.add(ref.id);
      }
    }
  }
  return [...keys].sort();
}

function teamsEnabled(values) {
  const teams = values?.channels?.msteams;
  return (
    teams !== null && typeof teams === "object" && !Array.isArray(teams) && teams.enabled !== false
  );
}

function servicePrincipalId(agent) {
  return typeof agent?.servicePrincipalId === "string" && agent.servicePrincipalId.trim().length
    ? agent.servicePrincipalId
    : null;
}

export { secretBinding, secretIdForBinding };

function hasSlackBindings(configuration) {
  return SLACK_SECRET_BINDINGS.every((binding) =>
    secretIdForBinding(configuration?.secretBindings?.[binding.key]),
  );
}

function slackBindingState(configuration, binding) {
  return secretIdForBinding(configuration?.secretBindings?.[binding.key]) === null
    ? "missing"
    : "bound";
}

export function channelCredentialBlockReason(values) {
  return teamsEnabled(values)
    ? "Microsoft Teams credentials and readiness are operator-managed and cannot be confirmed by this Credentials tab. Use the operator deployment workflow for Teams, or disable Teams through the Configuration API to deploy here."
    : null;
}

export function missingChannelCredentialGroups(values, configuration) {
  if (!slackEnabled(values)) {
    return [];
  }
  const named = namedSlackAccountKeys(values);
  if (named === null) {
    return hasSlackBindings(configuration) ? [] : ["Slack Secret bindings"];
  }
  const unbound = named.filter((key) => !secretIdForBinding(configuration?.secretBindings?.[key]));
  return unbound.length ? [`Slack Secret bindings (${unbound.join(", ")})`] : [];
}

export function hasRequiredChannelCredentials(values, configuration) {
  return (
    channelCredentialBlockReason(values) === null &&
    missingChannelCredentialGroups(values, configuration).length === 0
  );
}

function credentialError(error, mutation = false) {
  let text;
  if (error.status === 403) {
    text = "Access denied. You do not have permission for this credential operation.";
  } else if (error.status === 409) {
    text = "Credential metadata conflicts with the saved Agent state or selected Secrets.";
  } else if (error.status === 400) {
    text = "Check the selected Secrets and reload this Agent.";
  } else if (error.status === 429) {
    text = "Too many requests. Wait before trying again.";
  } else if (error.status === 404) {
    text = "Credential metadata is unavailable for this Agent. Check the ID and your access.";
  } else if (mutation) {
    text = "Outcome unknown. Reload this Agent to confirm the saved Secret bindings.";
  } else {
    text = "Credential metadata unavailable. Reload this Agent before trying again.";
  }
  return text + (error.requestId ? ` Request ID: ${error.requestId}` : "");
}

function isDefinitiveRejection(error) {
  return [400, 403, 404, 409, 429].includes(error.status);
}

function renderSlackBindings(state) {
  const list = element("dl", { className: "credential-status-list" });
  const named = namedSlackAccountKeys(state.values);
  const bindings = named?.map((key) => ({ key, label: key })) ?? SLACK_SECRET_BINDINGS;
  for (const binding of bindings) {
    const stored = Boolean(secretIdForBinding(state.configuration.secretBindings?.[binding.key]));
    list.append(
      element("dt", {}, binding.label),
      element(
        "dd",
        {},
        element(
          "span",
          { className: `credential-status ${stored ? "stored" : "missing"}` },
          stored ? "Bound" : "Missing",
        ),
      ),
    );
  }
  return list;
}

export function createChannelSecretsPanel({
  context,
  path,
  agent,
  configuration,
  values,
  revisionsLoaded,
  onConfigurationChange,
  onChange,
  onReload,
}) {
  const state = {
    agent,
    configuration,
    values,
    saving: false,
    saveError: null,
    saveErrorBeforeWrite: false,
    saveMessage: "",
    saveGrantWarning: "",
    pendingSecretGrants: {},
    outcomeUnknown: false,
    reloadRequired: false,
  };
  const section = element("section", { className: "agent-card channel-secrets" });

  function saveErrorText() {
    if (state.saveErrorBeforeWrite) {
      return (
        "Could not check the saved Configuration. Try again before saving channel Secrets." +
        (state.saveError.requestId ? ` Request ID: ${state.saveError.requestId}` : "")
      );
    }
    return state.saveGrantWarning || credentialError(state.saveError, true);
  }

  function canEnterChannelCredentials() {
    return (
      revisionsLoaded &&
      !state.saving &&
      !state.outcomeUnknown &&
      !state.reloadRequired &&
      slackEnabled(state.values) &&
      servicePrincipalId(state.agent) !== null
    );
  }

  function grantWarning() {
    return "Configuration saved, but Secret access grants could not be confirmed. Ask a Namespace administrator to grant this Agent access to the saved Secret.";
  }

  function referencedSecretIds(secretBindings) {
    return new Set(
      SLACK_SECRET_BINDINGS.map((binding) =>
        secretIdForBinding(secretBindings?.[binding.key]),
      ).filter((id) => id !== null),
    );
  }

  function pendingSecretGrants(secretBindings = state.configuration.secretBindings ?? {}) {
    const referencedIds = referencedSecretIds(secretBindings);
    return Object.values(state.pendingSecretGrants).filter((secret) =>
      referencedIds.has(secret.id),
    );
  }

  function prunePendingSecretGrants(secretBindings = state.configuration.secretBindings ?? {}) {
    state.pendingSecretGrants = Object.fromEntries(
      pendingSecretGrants(secretBindings).map((secret) => [secret.id, secret]),
    );
  }

  function updateGrantWarning(secretBindings = state.configuration.secretBindings ?? {}) {
    prunePendingSecretGrants(secretBindings);
    state.saveGrantWarning = pendingSecretGrants(secretBindings).length ? grantWarning() : "";
  }

  function secretGrantTargets(secretBindings, changedSecrets) {
    prunePendingSecretGrants(secretBindings);
    for (const binding of SLACK_SECRET_BINDINGS) {
      const secret = changedSecrets[binding.key];
      if (secret?.id && secretIdForBinding(secretBindings?.[binding.key]) === secret.id) {
        state.pendingSecretGrants[secret.id] = secret;
      }
    }
    return Object.values(state.pendingSecretGrants);
  }

  function markSecretGrantConfirmed(secret) {
    delete state.pendingSecretGrants[secret.id];
  }

  function canDeploy() {
    return (
      revisionsLoaded &&
      !state.saving &&
      !state.outcomeUnknown &&
      !state.reloadRequired &&
      !state.saveGrantWarning &&
      hasRequiredChannelCredentials(state.values, state.configuration)
    );
  }

  function deployGateMessage() {
    if (state.saving) {
      return "Wait for the credential save to finish before deploying.";
    }
    if (state.outcomeUnknown) {
      return "Credential changes may have been saved. Reload this draft and inspect the saved state before deploying.";
    }
    if (state.reloadRequired) {
      return "Configuration changed. Reload this draft before deploying.";
    }
    if (!revisionsLoaded) {
      return "Version history is required before deploying this new version.";
    }
    if (state.saveGrantWarning) {
      return "Resolve the saved Secret access grant before deploying.";
    }
    const blockReason = channelCredentialBlockReason(state.values);
    if (blockReason !== null) {
      return blockReason;
    }
    const missing = missingChannelCredentialGroups(state.values, state.configuration);
    if (missing.length) {
      return `Complete these in Credentials before deploying: ${missing.join(", ")}.`;
    }
    return "Ready to deploy.";
  }

  function renderChannelForm(error) {
    if (!slackEnabled(state.values)) {
      return null;
    }
    if (namedSlackAccountKeys(state.values) !== null) {
      return element(
        "p",
        { className: "hint" },
        "Named Slack accounts use their own token keys. Bind them through the Configuration API.",
      );
    }
    const formId = "runtime-channel-secrets-form";
    const draft = {
      secretBindings: { ...(state.configuration.secretBindings ?? {}) },
      changedSecrets: {},
    };
    const pickers = [];
    const status = element("p", { className: "hint", role: "status" }, state.saveMessage);
    const save = element(
      "button",
      { type: "submit", form: formId, className: "primary" },
      "Save channel Secrets",
    );
    function createTokenPicker(binding) {
      const picker = createSecretReferenceField({
        context,
        id: `runtime-${binding.key.toLowerCase().replaceAll("_", "-")}`,
        label: binding.label,
        getCurrentSource: () => draft.secretBindings[binding.key]?.source,
        onSecretSelected(secret) {
          draft.secretBindings = {
            ...draft.secretBindings,
            [binding.key]: secretBinding(secret),
          };
          draft.changedSecrets = { ...draft.changedSecrets, [binding.key]: secret };
          state.saveError = null;
          state.saveMessage = "";
          updateGrantWarning();
          error.textContent = state.saveGrantWarning;
          status.textContent = "";
          updateControls();
        },
        createSecretName: () => `${state.agent.name} ${binding.secretName}`,
        createDialogTitle: `Create ${binding.label} Secret`,
        createFixedKey: {
          label: "Binding key",
          value: binding.key,
          hint: "This environment key is fixed for Slack Socket Mode.",
        },
        metadataLabel: `View ${binding.label.replace("Slack ", "")} Secret metadata`,
        required: true,
        disabled: !canEnterChannelCredentials(),
      });
      pickers.push({ binding, picker });
      return picker.field;
    }
    const updateControls = () => {
      const changedSecrets = Object.values(draft.changedSecrets);
      const pendingSecrets = pendingSecretGrants();
      const missing = SLACK_SECRET_BINDINGS.filter(
        (binding) =>
          slackBindingState({ secretBindings: draft.secretBindings }, binding) === "missing",
      );
      for (const { picker } of pickers) {
        picker.setDisabled(state.saving || !canEnterChannelCredentials());
        picker.setRequired(true);
      }
      save.disabled =
        state.saving ||
        !canEnterChannelCredentials() ||
        state.outcomeUnknown ||
        missing.length > 0 ||
        (changedSecrets.length === 0 && pendingSecrets.length === 0);
    };
    const form = element(
      "form",
      { id: formId, className: "credential-form" },
      ...SLACK_SECRET_BINDINGS.map((binding) => createTokenPicker(binding)),
      status,
      element("div", { className: "form-actions" }, save),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.saving || !canEnterChannelCredentials() || state.outcomeUnknown) {
        return;
      }
      if (!form.reportValidity()) {
        return;
      }
      const missing = SLACK_SECRET_BINDINGS.filter(
        (binding) =>
          slackBindingState({ secretBindings: draft.secretBindings }, binding) === "missing",
      );
      const changedSecrets = Object.values(draft.changedSecrets);
      const pendingSecrets = pendingSecretGrants();
      if (missing.length > 0 || (changedSecrets.length === 0 && pendingSecrets.length === 0)) {
        return;
      }
      state.saving = true;
      state.saveError = null;
      state.saveErrorBeforeWrite = false;
      state.saveMessage = "";
      state.saveGrantWarning = "";
      status.textContent = "Saving channel Secret bindings...";
      error.textContent = "";
      updateControls();
      onChange();
      let mutationStarted = false;
      let configurationSaved = false;
      try {
        const configurationPath = `${namespacePath(context.namespaceId)}/configurations/${encodeURIComponent(state.configuration.id)}`;
        const [freshAgent, freshConfiguration] = await Promise.all([
          context.request(path),
          context.request(configurationPath),
        ]);
        if (!context.isCurrent()) {
          return;
        }
        if (
          freshAgent.id !== state.agent.id ||
          freshAgent.configurationId !== state.configuration.id ||
          freshConfiguration.id !== state.configuration.id ||
          freshConfiguration.generation !== state.configuration.generation
        ) {
          state.reloadRequired = true;
          return;
        }
        // The preflight cannot prevent a concurrent write before this PATCH.
        mutationStarted = true;
        state.configuration = await context.request(
          `${namespacePath(context.namespaceId)}/configurations/${encodeURIComponent(
            state.configuration.id,
          )}`,
          {
            method: "PATCH",
            body: { values: state.values, secretBindings: draft.secretBindings },
          },
        );
        configurationSaved = true;
        state.values = state.configuration.values;
        onConfigurationChange?.(state.configuration);
        const grantTargets = secretGrantTargets(draft.secretBindings, draft.changedSecrets);
        for (const secret of grantTargets) {
          await ensureCredentialOperateBinding(context, state.agent, secret);
          markSecretGrantConfirmed(secret);
        }
        if (!context.isCurrent()) {
          return;
        }
        state.outcomeUnknown = false;
        state.saveGrantWarning = "";
        state.saveMessage =
          "Channel Secret bindings saved. Deploy the new version to deliver them.";
        status.textContent = state.saveMessage;
      } catch (cause) {
        if (!context.isCurrent()) {
          return;
        }
        if (cause.status === 401) {
          context.onExpired();
          return;
        }
        state.saveError = cause;
        state.saveErrorBeforeWrite = !mutationStarted;
        state.saveMessage = "";
        state.outcomeUnknown =
          mutationStarted && !configurationSaved && !isDefinitiveRejection(cause);
        updateGrantWarning(state.configuration.secretBindings);
        status.textContent = "";
        error.textContent = saveErrorText();
      } finally {
        if (context.isCurrent()) {
          state.saving = false;
          updateControls();
          render();
          onChange();
        }
      }
    });
    updateControls();
    return form;
  }

  function renderUnavailableReason() {
    if (!revisionsLoaded) {
      return element(
        "p",
        { className: "muted", role: "status" },
        "Credential entry requires readable version history.",
      );
    }
    if (slackEnabled(state.values) && servicePrincipalId(state.agent) === null) {
      return element(
        "p",
        { className: "error", role: "alert" },
        "The API did not return this Agent's service principal, so the console cannot bind Secrets.",
      );
    }
    return null;
  }

  function render() {
    const error = element(
      "p",
      { className: "error", role: "alert" },
      state.saveError ? saveErrorText() : state.saveGrantWarning,
    );
    section.replaceChildren(
      ...[
        element("h2", {}, "Channel Secrets"),
        element(
          "p",
          { className: "muted" },
          "Save Slack tokens as Secrets, then deploy a new version to apply them. Saved bindings do not confirm live channel readiness.",
        ),
        renderSlackBindings(state),
        error,
        state.reloadRequired
          ? element(
              "p",
              { className: "error", role: "status" },
              "Configuration changed. Reload this draft before saving channel Secrets.",
            )
          : null,
        state.outcomeUnknown && (!state.saveError || isDefinitiveRejection(state.saveError))
          ? element(
              "p",
              { className: "error", role: "status" },
              "Credential changes may have been saved. Reload this draft and inspect the saved state before deploying.",
            )
          : null,
        state.outcomeUnknown || state.reloadRequired
          ? element(
              "div",
              { className: "form-actions credential-actions" },
              button("Reload draft", onReload),
            )
          : null,
        renderUnavailableReason(),
        renderChannelForm(error),
      ].filter(Boolean),
    );
  }

  render();
  return {
    section: slackEnabled(values) ? section : null,
    canDeploy,
    deployGateMessage,
    isSaving: () => state.saving,
    mutationPending: () => state.saving || state.outcomeUnknown || state.reloadRequired,
  };
}
