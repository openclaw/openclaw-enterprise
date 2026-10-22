import type {
  Agent,
  Configuration,
  OpenClawConfigurationDocument,
  SecretBindings,
  SecretMetadata,
} from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import { sameValue } from "../carry.mjs";
import { element, button, focusSaveOutcome, setStatusTone, validateFields } from "../dom.mjs";
import {
  configurationConflictMessage,
  isStaleGeneration,
  namespacePath,
  SAVE_REFUSALS,
} from "./list.mjs";
import { ensureCredentialOperateBinding, type AgentAccessContext } from "./credential-access.mjs";
import { createSecretReferenceField, secretBinding, secretIdForBinding } from "./secret-picker.mjs";

export const SLACK_SECRET_BINDINGS = [
  { key: "SLACK_APP_TOKEN", label: "Slack app token", secretName: "Slack app token" },
  { key: "SLACK_BOT_TOKEN", label: "Slack bot token", secretName: "Slack bot token" },
];
function channelPolicy(values: unknown, provider: string) {
  return responseFields(responseFields(values).channels)[provider];
}

function channelEnabled(values: unknown, provider: string) {
  const policy = channelPolicy(values, provider);
  return (
    policy !== null &&
    typeof policy === "object" &&
    !Array.isArray(policy) &&
    responseFields(policy).enabled !== false
  );
}

// Named accounts must not use the standard keys: OpenClaw reads SLACK_APP_TOKEN and
// SLACK_BOT_TOKEN as an extra implicit default account. For them, require exactly the
// environment keys the native document references; null means the default account only.
function namedSlackAccountKeys(values: unknown) {
  const slack = responseFields(channelPolicy(values, "slack"));
  if (slack.accounts === undefined && slack.account === undefined) {
    return null;
  }
  const accounts = responseFields(slack.accounts);
  const keys = new Set<string>();
  for (const account of [slack, ...Object.values(accounts)]) {
    const { appToken, botToken } = responseFields(account);
    for (const token of [appToken, botToken]) {
      const { source, id } = responseFields(token);
      if (source === "env" && typeof id === "string") {
        keys.add(id);
      }
    }
  }
  return [...keys].sort();
}

function servicePrincipalId(agent: Pick<Agent, "servicePrincipalId">) {
  return typeof agent?.servicePrincipalId === "string" && agent.servicePrincipalId.trim().length
    ? agent.servicePrincipalId
    : null;
}

export { secretBinding, secretIdForBinding };

type ChannelBindings = Pick<Configuration, "secretBindings">;

function hasSlackBindings(configuration: ChannelBindings) {
  return SLACK_SECRET_BINDINGS.every((binding) =>
    secretIdForBinding(configuration?.secretBindings?.[binding.key]),
  );
}

export function channelCredentialBlockReason(values: unknown) {
  return channelEnabled(values, "msteams")
    ? "Microsoft Teams credentials and readiness are operator-managed and cannot be confirmed by this Credentials tab. Use the operator deployment workflow for Teams, or disable Teams through the Configuration API to deploy here."
    : null;
}

export function missingChannelCredentialGroups(values: unknown, configuration: ChannelBindings) {
  if (!channelEnabled(values, "slack")) {
    return [];
  }
  const named = namedSlackAccountKeys(values);
  if (named === null) {
    return hasSlackBindings(configuration) ? [] : ["Slack Secret bindings"];
  }
  const unbound = named.filter((key) => !secretIdForBinding(configuration?.secretBindings?.[key]));
  return unbound.length ? [`Slack Secret bindings (${unbound.join(", ")})`] : [];
}

export function hasRequiredChannelCredentials(values: unknown, configuration: ChannelBindings) {
  return (
    channelCredentialBlockReason(values) === null &&
    missingChannelCredentialGroups(values, configuration).length === 0
  );
}

type SaveFailure = ReturnType<typeof requestFailure> & {
  step: "configuration" | "preflight" | "grant";
};

function credentialSaveError(error: SaveFailure) {
  let text;
  if (error.status === 403) {
    // A refused Configuration update names the grants it needs (finding 1839).
    text = SAVE_REFUSALS.configuration;
  } else if (error.status === 409) {
    text =
      configurationConflictMessage(error, true) ??
      "Credential metadata conflicts with the saved Agent state or selected Secrets.";
  } else if (error.status === 400) {
    text = "Check the selected Secrets and reload this Agent.";
  } else if (error.status === 429) {
    text = "Too many requests. Wait before trying again.";
  } else if (error.status === 404) {
    text = "Credential metadata is unavailable for this Agent. Check the ID and your access.";
  } else {
    text = "Outcome unknown. Reload this Agent to confirm the saved Secret bindings.";
  }
  return text + (error.requestId ? ` Request ID: ${error.requestId}` : "");
}

interface SecretDraft {
  secretBindings: SecretBindings;
  changedSecrets: Record<string, SecretMetadata>;
}

export interface CarriedChannelSecrets extends SecretDraft {
  configurationId: string;
  initialSecretBindings: SecretBindings;
}

interface ChannelState {
  agent: Pick<Agent, "name" | "id" | "servicePrincipalId">;
  configuration: Configuration;
  values: OpenClawConfigurationDocument;
  saving: boolean;
  saveError: SaveFailure | null;
  saveMessage: string;
  saveGrantWarning: string;
  pendingSecretGrants: Record<string, SecretMetadata>;
  outcomeUnknown: boolean;
  reloadRequired: boolean;
  draftSeed: SecretDraft | null;
  unsavedSecrets: boolean;
  carried: CarriedChannelSecrets | null;
  carriedNote: string;
}

// The update stores the submitted values unchanged. Its response must confirm the new
// generation and every binding before we grant the Agent access to any selected Secret.
function confirmedConfiguration(
  result: unknown,
  previous: Configuration,
  values: OpenClawConfigurationDocument,
  secretBindings: SecretBindings,
): Configuration {
  const saved = responseFields(result);
  const { generation } = saved;
  if (
    saved.id !== previous.id ||
    saved.namespaceId !== previous.namespaceId ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation <= previous.generation ||
    !sameValue(saved.values, values) ||
    !sameValue(saved.secretBindings, secretBindings)
  ) {
    // A successful but unrecognizable response cannot justify another write.
    throw new Error("The save response did not confirm the submitted Secret bindings.");
  }
  return { ...previous, generation, values, secretBindings };
}

// Reapplies the Secret choices a save conflict carried over the reread bindings, when they were
// made on this Configuration. A choice another browser also changed is named (finding 1512).
function applyCarriedSecrets(state: ChannelState, carried: CarriedChannelSecrets | null) {
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
  if (!channelEnabled(state.values, "slack")) {
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
  const secretBindings = { ...saved };
  const changedSecrets: SecretDraft["changedSecrets"] = {};
  const names: string[] = [];
  for (const { key, label } of SLACK_SECRET_BINDINGS) {
    const choice = carried.secretBindings[key];
    const secret = carried.changedSecrets[key];
    const initial = secretIdForBinding(carried.initialSecretBindings[key]);
    const current = secretIdForBinding(saved[key]);
    const selected = secretIdForBinding(choice);
    if (
      secret &&
      choice &&
      selected === secret.id &&
      selected !== initial &&
      selected !== current
    ) {
      secretBindings[key] = choice;
      changedSecrets[key] = secret;
      names.push(current === initial ? label : `${label} (also changed in another browser)`);
    }
  }
  if (!names.length) {
    state.carriedNote = "The reloaded bindings already include your Secret choices.";
    return;
  }
  state.draftSeed = { secretBindings, changedSecrets };
  state.carriedNote = `Your Secret choices are applied over the reloaded bindings: ${names.join(", ")}. Review them, then save.`;
}

function renderSlackBindings(state: ChannelState) {
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
          { className: "badge", "data-tone": stored ? "success" : "danger" },
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
}: {
  context: AgentAccessContext;
  path: string;
  agent: ChannelState["agent"];
  configuration: Configuration;
  values: OpenClawConfigurationDocument;
  revisionsLoaded: boolean;
  carried?: CarriedChannelSecrets | null;
  onConfigurationChange?(configuration: Configuration): void;
  onChange(): void;
  onReload(carried: CarriedChannelSecrets | null): void;
}) {
  const state: ChannelState = {
    agent,
    configuration,
    values,
    saving: false,
    saveError: null,
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
    const { saveError, saveGrantWarning } = state;
    if (!saveError || saveError.step === "grant") {
      return saveGrantWarning;
    }
    const message =
      saveError.step === "preflight"
        ? "Could not check the saved Configuration. Try again before saving channel Secrets." +
          (saveError.requestId ? ` Request ID: ${saveError.requestId}` : "")
        : credentialSaveError(saveError);
    // Report this failed save first. A grant can still be outstanding from an earlier save.
    return saveGrantWarning
      ? `${message} Access to a previously saved Secret is still unconfirmed.`
      : message;
  }

  // A refused save is danger. Secret grants left unconfirmed after a save are a warning, from
  // the failed grant on: the Configuration itself saved (finding 2003).
  function saveErrorTone() {
    return state.saveError && state.saveError.step !== "grant" ? "danger" : "warning";
  }

  function canEnterChannelCredentials() {
    return (
      revisionsLoaded &&
      !state.saving &&
      !state.outcomeUnknown &&
      !state.reloadRequired &&
      channelEnabled(state.values, "slack") &&
      servicePrincipalId(state.agent) !== null
    );
  }

  function grantWarning() {
    return "Configuration saved, but Secret access grants could not be confirmed. Ask a Namespace administrator to grant this Agent access to the saved Secret.";
  }

  function referencedSecretIds(secretBindings: SecretBindings) {
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

  function secretGrantTargets({ secretBindings, changedSecrets }: SecretDraft) {
    prunePendingSecretGrants(secretBindings);
    for (const binding of SLACK_SECRET_BINDINGS) {
      const secret = changedSecrets[binding.key];
      if (secret?.id && secretIdForBinding(secretBindings?.[binding.key]) === secret.id) {
        state.pendingSecretGrants[secret.id] = secret;
      }
    }
    return Object.values(state.pendingSecretGrants);
  }

  // Channel credentials are saved and complete: the next-step card's credentials step (UX spec
  // 3.7). Deploy also needs the version history.
  function credentialsReady() {
    return (
      !state.saving &&
      !state.outcomeUnknown &&
      !state.reloadRequired &&
      !state.saveGrantWarning &&
      !state.unsavedSecrets &&
      hasRequiredChannelCredentials(state.values, state.configuration)
    );
  }

  function canDeploy() {
    return revisionsLoaded && credentialsReady();
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
  const shown: {
    status?: HTMLElement | null;
    save?: HTMLButtonElement | null;
    reload?: HTMLButtonElement | null;
    outcome?: HTMLElement | null;
  } = {};

  function renderChannelForm(error: HTMLElement) {
    shown.save = null;
    shown.status = null;
    state.unsavedSecrets = false;
    if (!channelEnabled(state.values, "slack")) {
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
    const draft: SecretDraft = {
      secretBindings: { ...(state.configuration.secretBindings ?? {}) },
      changedSecrets: {},
      ...structuredClone(state.draftSeed ?? {}),
    };
    // Reopen the form with its unsaved choices after a refused write or a draft reload.
    state.draftSeed = null;
    const pickers: ReturnType<typeof createSecretReferenceField>[] = [];
    const status = element(
      "p",
      { className: "hint", role: "status" },
      state.saveMessage || state.carriedNote,
    );
    const save = element(
      "button",
      { type: "submit", form: formId, className: "button button--primary" },
      "Save channel Secrets",
    );
    shown.status = status;
    shown.save = save;
    function createTokenPicker(binding: (typeof SLACK_SECRET_BINDINGS)[number]) {
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
          setStatusTone(error, "warning");
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
      pickers.push(picker);
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
      for (const picker of pickers) {
        picker.setDisabled(state.saving || !canEnterChannelCredentials());
        picker.setRequired(true);
      }
      save.disabled = !canSaveChannelSecrets();
    };
    const form = element(
      "form",
      { id: formId, className: "credential-form", novalidate: "" },
      ...SLACK_SECRET_BINDINGS.map((binding) => createTokenPicker(binding)),
      status,
      element("div", { className: "form-actions" }, save),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!canEnterChannelCredentials()) {
        return;
      }
      // The console's own errors under each field, not the browser's bubble (UX plan C3).
      if (!validateFields([...form.elements])) {
        return;
      }
      if (!canSaveChannelSecrets()) {
        return;
      }
      state.saving = true;
      state.saveError = null;
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
          context.request(path).then(responseFields),
          context.request(configurationPath).then(responseFields),
        ]);
        if (!context.isCurrent()) {
          return;
        }
        if (
          freshAgent.id !== state.agent.id ||
          freshAgent.servicePrincipalId !== state.agent.servicePrincipalId ||
          freshAgent.namespaceId !== context.namespaceId ||
          freshAgent.configurationId !== state.configuration.id ||
          freshConfiguration.id !== state.configuration.id ||
          freshConfiguration.namespaceId !== context.namespaceId ||
          freshConfiguration.generation !== state.configuration.generation
        ) {
          carryChoices();
          return;
        }
        // A write from another browser after the preflight is refused with 409 (finding 1505).
        mutationStarted = true;
        const result = await context.request(configurationPath, {
          method: "PATCH",
          expectedStatus: 200,
          body: {
            values: state.values,
            secretBindings: draft.secretBindings,
            expectedGeneration: state.configuration.generation,
          },
        });
        if (!context.isCurrent()) {
          return;
        }
        state.configuration = confirmedConfiguration(
          result,
          state.configuration,
          state.values,
          draft.secretBindings,
        );
        configurationSaved = true;
        state.draftSeed = null;
        state.carriedNote = "";
        onConfigurationChange?.(state.configuration);
        const grantTargets = secretGrantTargets(draft);
        for (const secret of grantTargets) {
          if (!context.isCurrent()) {
            return;
          }
          await ensureCredentialOperateBinding(context, state.agent, secret);
          delete state.pendingSecretGrants[secret.id];
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
        const failure = requestFailure(cause);
        if (failure.status === 401) {
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
          failure.status === 409 &&
          failure.code === "RESOURCE_CONFLICT"
        ) {
          // The write was refused. Keep the choices in this form, without requesting a reload.
          state.draftSeed = draft;
        }
        const step = configurationSaved ? "grant" : mutationStarted ? "configuration" : "preflight";
        state.saveError = { ...failure, step };
        state.saveMessage = "";
        state.outcomeUnknown =
          step === "configuration" &&
          (failure.status === undefined || ![400, 403, 404, 409, 429].includes(failure.status));
        updateGrantWarning(state.configuration.secretBindings);
        status.textContent = "";
        setStatusTone(error, saveErrorTone());
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
    if (channelEnabled(state.values, "slack") && servicePrincipalId(state.agent) === null) {
      return element(
        "p",
        { className: "status", "data-tone": "danger", role: "alert" },
        "The API did not return this Agent's service principal, so the console cannot bind Secrets.",
      );
    }
    return null;
  }

  function render() {
    const error = element(
      "p",
      { className: "status", "data-tone": saveErrorTone(), role: "alert" },
      saveErrorText(),
    );
    const reloadMessage = state.reloadRequired
      ? element(
          "p",
          { className: "status", "data-tone": "danger", role: "alert" },
          "Configuration changed. Reload this draft before saving channel Secrets.",
        )
      : null;
    // An unknown outcome always comes with its save error, which the error line above shows as a
    // danger alert ("Outcome unknown…"); the deploy gate names it too (finding 2014).
    const reload =
      state.outcomeUnknown || state.reloadRequired
        ? button("Reload draft", (event) => {
            // The page rebuilds this section from the reread draft, with the Secret choices a
            // save conflict kept applied over it.
            if (event.currentTarget instanceof HTMLButtonElement) {
              event.currentTarget.disabled = true;
            }
            void onReload(state.reloadRequired && !state.outcomeUnknown ? state.carried : null);
          })
        : null;
    const form = renderChannelForm(error);
    shown.reload = reload;
    shown.outcome = state.saveError
      ? error
      : (reloadMessage ?? (shown.status?.textContent ? shown.status : null));
    if (!channelEnabled(state.values, "slack") && state.carriedNote) {
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
        reload ? element("div", { className: "form-actions credential-actions" }, reload) : null,
        renderUnavailableReason(),
        form,
      ].filter((node) => node !== null),
    );
  }

  render();
  return {
    section: channelEnabled(values, "slack") || state.carriedNote ? section : null,
    canDeploy,
    credentialsReady,
    deployGateMessage,
    isSaving: () => state.saving,
    mutationPending: () => state.saving || state.outcomeUnknown || state.reloadRequired,
  };
}
