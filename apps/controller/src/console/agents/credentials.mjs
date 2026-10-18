import { element, button, focusSaveOutcome } from "../dom.mjs";
import {
  configurationConflictMessage,
  isStaleGeneration,
  namespacePath,
  refusedSave,
} from "./list.mjs";
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
    // A refused Configuration update names the grants it needs (finding 1839).
    text =
      error.refusal ?? "Access denied. You do not have permission for this credential operation.";
  } else if (error.status === 409) {
    text =
      configurationConflictMessage(error, mutation) ??
      "Credential metadata conflicts with the saved Agent state or selected Secrets.";
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

// Reapplies the Secret choices a save conflict carried over the reread bindings, when they were
// made on this Configuration. A choice another browser also changed is named (finding 1512).
function applyCarriedSecrets(state, carried) {
  if (!carried) {
    return;
  }
  if (carried.configurationId !== state.configuration.id) {
    state.carriedNote =
      "Your channel Secret choices were not reapplied: this Agent now uses another Configuration.";
    return;
  }
  // No Slack token form renders for these, so the note shows in the section instead
  // (finding 1525).
  if (!slackEnabled(state.values)) {
    state.carriedNote =
      "Your channel Secret choices were not reapplied: Slack is off in the reloaded Configuration.";
    return;
  }
  if (namedSlackAccountKeys(state.values) !== null) {
    state.carriedNote =
      "Your channel Secret choices were not reapplied: the reloaded Configuration uses named Slack accounts.";
    return;
  }
  const saved = state.configuration.secretBindings ?? {};
  const sameSecret = (left, right) => secretIdForBinding(left) === secretIdForBinding(right);
  const keys = SLACK_SECRET_BINDINGS.map((binding) => binding.key).filter(
    (key) =>
      carried.changedSecrets?.[key] &&
      !sameSecret(carried.secretBindings?.[key], carried.initialSecretBindings?.[key]) &&
      !sameSecret(carried.secretBindings?.[key], saved[key]),
  );
  if (!keys.length) {
    state.carriedNote = "The reloaded bindings already include your Secret choices.";
    return;
  }
  state.draftSeed = {
    secretBindings: {
      ...saved,
      ...Object.fromEntries(keys.map((key) => [key, carried.secretBindings[key]])),
    },
    changedSecrets: Object.fromEntries(keys.map((key) => [key, carried.changedSecrets[key]])),
  };
  const names = keys.map((key) => {
    const label = SLACK_SECRET_BINDINGS.find((binding) => binding.key === key).label;
    return sameSecret(saved[key], carried.initialSecretBindings?.[key])
      ? label
      : `${label} (also changed in another browser)`;
  });
  state.carriedNote = `Your Secret choices are applied over the reloaded bindings: ${names.join(", ")}. Review them, then save.`;
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
  carried = null,
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
    saveErrorStep: null,
    saveMessage: "",
    saveGrantWarning: "",
    pendingSecretGrants: {},
    outcomeUnknown: false,
    reloadRequired: false,
    // Unsaved Secret choices the form reopens with, and what a save conflict carries.
    draftSeed: null,
    // The form shows a Secret choice the saved bindings do not have (finding 1640).
    unsavedSecrets: false,
    carried: null,
    carriedNote: "",
  };
  applyCarriedSecrets(state, carried);
  const section = element("section", { className: "agent-card channel-secrets" });

  function saveErrorText() {
    const { saveError, saveErrorStep, saveGrantWarning } = state;
    if (saveErrorStep === "grant" && saveGrantWarning) {
      return saveGrantWarning;
    }
    const message =
      saveErrorStep === "preflight"
        ? "Could not check the saved Configuration. Try again before saving channel Secrets." +
          (saveError.requestId ? ` Request ID: ${saveError.requestId}` : "")
        : credentialError(saveError, true);
    // Report this failed save first. A grant can still be outstanding from an earlier save.
    return saveGrantWarning
      ? `${message} Access to a previously saved Secret is still unconfirmed.`
      : message;
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
      !state.unsavedSecrets &&
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
    if (state.unsavedSecrets) {
      // A member who cannot read a saved Secret cannot pick it again: the picker offers the
      // unreadable binding only while the draft still holds it (finding 1649). A page reload
      // drops unsaved choices for every reader, with the page's other unsaved edits.
      return "Save the channel Secret choices before deploying, or reload the page to discard unsaved changes.";
    }
    return "Ready to deploy.";
  }

  // The last render's save outcome and next-step controls, for focus after a save.
  const shown = {};

  function renderChannelForm(error) {
    state.unsavedSecrets = false;
    if (!slackEnabled(state.values)) {
      return null;
    }
    if (namedSlackAccountKeys(state.values) !== null) {
      return element(
        "div",
        {},
        element(
          "p",
          { className: "hint" },
          "Named Slack accounts use their own token keys. Bind them through the Configuration API.",
        ),
        state.carriedNote
          ? element("p", { className: "hint", role: "status" }, state.carriedNote)
          : null,
      );
    }
    const formId = "runtime-channel-secrets-form";
    const draft = {
      secretBindings: { ...(state.configuration.secretBindings ?? {}) },
      changedSecrets: {},
      ...structuredClone(state.draftSeed ?? {}),
    };
    // Reopen the form with its unsaved choices after a refused write or a draft reload.
    state.draftSeed = null;
    const pickers = [];
    const status = element(
      "p",
      { className: "hint", role: "status" },
      state.saveMessage || state.carriedNote,
    );
    const save = element(
      "button",
      { type: "submit", form: formId, className: "primary" },
      "Save channel Secrets",
    );
    shown.status = status;
    shown.save = save;
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
          state.carriedNote = "";
          updateGrantWarning();
          error.textContent = state.saveGrantWarning;
          status.textContent = "";
          updateControls();
          onChange();
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
    const canSaveChannelSecrets = () =>
      canEnterChannelCredentials() &&
      SLACK_SECRET_BINDINGS.every(
        (binding) => secretIdForBinding(draft.secretBindings[binding.key]) !== null,
      ) &&
      (Object.values(draft.changedSecrets).length > 0 || pendingSecretGrants().length > 0);
    const updateControls = () => {
      // Deploy delivers the saved bindings, so a choice shown here but not saved blocks it, as
      // an unsaved authentication source does.
      state.unsavedSecrets = SLACK_SECRET_BINDINGS.some(
        (binding) =>
          secretIdForBinding(draft.secretBindings[binding.key]) !==
          secretIdForBinding(state.configuration.secretBindings?.[binding.key]),
      );
      for (const { picker } of pickers) {
        picker.setDisabled(state.saving || !canEnterChannelCredentials());
        picker.setRequired(true);
      }
      save.disabled = !canSaveChannelSecrets();
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
      if (!canEnterChannelCredentials()) {
        return;
      }
      if (!form.reportValidity()) {
        return;
      }
      if (!canSaveChannelSecrets()) {
        return;
      }
      state.saving = true;
      state.saveError = null;
      state.saveErrorStep = null;
      state.saveMessage = "";
      state.carriedNote = "";
      state.saveGrantWarning = "";
      status.textContent = "Saving channel Secret bindings...";
      error.textContent = "";
      updateControls();
      onChange();
      let mutationStarted = false;
      let configurationSaved = false;
      // A conflict keeps these choices for Reload draft instead of dropping them (finding 1512).
      const carryChoices = () => {
        state.reloadRequired = true;
        state.draftSeed = structuredClone(draft);
        state.carried = {
          configurationId: state.configuration.id,
          initialSecretBindings: structuredClone(state.configuration.secretBindings ?? {}),
          ...structuredClone(draft),
        };
      };
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
          carryChoices();
          return;
        }
        // A write from another browser after the preflight is refused with 409 (finding 1505).
        mutationStarted = true;
        state.configuration = await context.request(
          `${namespacePath(context.namespaceId)}/configurations/${encodeURIComponent(
            state.configuration.id,
          )}`,
          {
            method: "PATCH",
            body: {
              values: state.values,
              secretBindings: draft.secretBindings,
              expectedGeneration: state.configuration.generation,
            },
          },
        );
        configurationSaved = true;
        state.draftSeed = null;
        state.carriedNote = "";
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
        if (isStaleGeneration(cause) && mutationStarted && !configurationSaved) {
          carryChoices();
          return;
        }
        if (
          mutationStarted &&
          !configurationSaved &&
          cause.status === 409 &&
          cause.code === "RESOURCE_CONFLICT"
        ) {
          // The write was refused. Keep the choices in this form, without requesting a reload.
          state.draftSeed = draft;
        }
        if (mutationStarted && !configurationSaved) {
          refusedSave(cause, "configuration", true);
        }
        state.saveError = cause;
        state.saveErrorStep = configurationSaved
          ? "grant"
          : mutationStarted
            ? "configuration"
            : "preflight";
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
          // The rebuilt section replaced the pressed button: focus the next step, described
          // by the outcome, or the outcome itself (finding 1481).
          focusSaveOutcome(section, [shown.reload, shown.save], shown.outcome);
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
    const reloadMessage = state.reloadRequired
      ? element(
          "p",
          { className: "error", role: "status" },
          "Configuration changed. Reload this draft before saving channel Secrets.",
        )
      : null;
    const unknownMessage =
      state.outcomeUnknown && (!state.saveError || isDefinitiveRejection(state.saveError))
        ? element(
            "p",
            { className: "error", role: "status" },
            "Credential changes may have been saved. Reload this draft and inspect the saved state before deploying.",
          )
        : null;
    const reload =
      state.outcomeUnknown || state.reloadRequired
        ? button("Reload draft", (event) => {
            // The page rebuilds this section from the reread draft, with the Secret choices a
            // save conflict kept applied over it.
            event.currentTarget.disabled = true;
            void onReload(state.reloadRequired && !state.outcomeUnknown ? state.carried : null);
          })
        : null;
    shown.save = null;
    shown.status = null;
    const form = renderChannelForm(error);
    shown.reload = reload;
    shown.outcome = state.saveError
      ? error
      : (reloadMessage ?? unknownMessage ?? (shown.status?.textContent ? shown.status : null));
    if (!slackEnabled(state.values) && state.carriedNote) {
      // Shown only to say carried Secret choices were not reapplied (finding 1525).
      section.replaceChildren(
        element("h2", {}, "Channel Secrets"),
        element("p", { className: "hint", role: "status" }, state.carriedNote),
      );
      return;
    }
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
        reloadMessage,
        unknownMessage,
        reload ? element("div", { className: "form-actions credential-actions" }, reload) : null,
        renderUnavailableReason(),
        form,
      ].filter(Boolean),
    );
  }

  render();
  return {
    section: slackEnabled(values) || state.carriedNote ? section : null,
    canDeploy,
    deployGateMessage,
    isSaving: () => state.saving,
    mutationPending: () => state.saving || state.outcomeUnknown || state.reloadRequired,
  };
}
