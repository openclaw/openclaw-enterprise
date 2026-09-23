import { element, button } from "../dom.mjs";
import { WORKSPACE_DEFAULTS, WORKSPACE_DEFAULTS_ID } from "../workspace-defaults.mjs";
import { createHarnessAuthFields } from "./harness-auth.mjs";
import { createPresetFields } from "./presets.mjs";
import { defaultAgentModel } from "./starter-model.mjs";
import { renderChannels } from "../channels.mjs";
import { link, message, namespacePath } from "./list.mjs";

function field(label, input, hint) {
  return element(
    "div",
    { className: "form-field" },
    element("label", { for: input.id }, label),
    input,
    hint ? element("p", { className: "hint", id: `${input.id}-hint` }, hint) : null,
  );
}

function configurationTemplate(mode) {
  const harnessId = mode === "dedicated" ? "codex" : "openclaw";
  const providerModel = defaultAgentModel;
  const modelReference = `${harnessId === "codex" ? "codex" : "openai"}/${providerModel}`;
  const provider =
    harnessId === "codex"
      ? {
          codex: {
            baseUrl: "http://127.0.0.1:9",
            api: "openai-responses",
            models: [{ id: providerModel, name: providerModel }],
          },
        }
      : {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            models: [{ id: providerModel, name: providerModel }],
          },
        };

  return {
    gateway: {
      mode: "local",
      bind: "lan",
      controlUi: {
        enabled: true,
        allowedOrigins: ["http://127.0.0.1:18789", "http://localhost:18789"],
      },
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
    agents: {
      defaults: {
        model: modelReference,
        models: { [modelReference]: { agentRuntime: { id: harnessId } } },
      },
    },
    models: { providers: provider },
    ...(harnessId === "codex"
      ? {
          // Codex model transport must use its authenticated app server, never direct HTTP.
          plugins: {
            allow: ["codex"],
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    mode: "guardian",
                    approvalPolicy: "on-request",
                    sandbox: "read-only",
                    transport: "websocket",
                    url: "${APP_SERVER_URL}",
                    authToken: "${APP_SERVER_TOKEN}",
                  },
                },
              },
            },
          },
        }
      : {}),
  };
}

function createClientRequestId() {
  return `req_${crypto.randomUUID()}`;
}

function isEnvName(value) {
  return /^[A-Z_][A-Z0-9_]*$/.test(value);
}

function parseJsonValue(input, reportInvalid = false) {
  try {
    return JSON.parse(input.value);
  } catch {
    if (reportInvalid) {
      input.setCustomValidity("Enter valid JSON.");
      input.reportValidity();
    }
    return undefined;
  }
}

function parseObject(input, reportInvalid = false) {
  const values = parseJsonValue(input, reportInvalid);
  if (
    values !== undefined &&
    (values === null || Array.isArray(values) || typeof values !== "object")
  ) {
    if (reportInvalid) {
      input.setCustomValidity("Enter a valid JSON object.");
      input.reportValidity();
    }
    return undefined;
  }
  return values;
}

function newSecretNamesFromBindings(bindings) {
  const names = new Set();
  for (const binding of Object.values(bindings ?? {})) {
    const source = binding?.source;
    if (source?.kind === "new-secret" && typeof source.name === "string") {
      names.add(source.name);
    }
  }
  return names;
}

function newSecretNameFromAuth(binding) {
  return binding?.method === "api_key" && binding.source?.kind === "new-secret"
    ? binding.source.name
    : null;
}

function addDefaultNewSecretBindings(bindings, secrets, harnessAuth) {
  const next = { ...(bindings ?? {}) };
  const authSecretName = newSecretNameFromAuth(harnessAuth);
  for (const secret of secrets) {
    if (
      secret.name !== authSecretName &&
      isEnvName(secret.name) &&
      next[secret.name] === undefined
    ) {
      next[secret.name] = {
        source: { kind: "new-secret", name: secret.name },
        delivery: { type: "env" },
      };
    }
  }
  return next;
}

function validateNewSecretReferences(secrets, bindings, harnessAuth) {
  const available = new Set(secrets.map((secret) => secret.name));
  const used = newSecretNamesFromBindings(bindings);
  const authSecret = newSecretNameFromAuth(harnessAuth);
  if (authSecret) {
    used.add(authSecret);
  }
  for (const name of used) {
    if (!available.has(name)) {
      return `New Secret ${name} is referenced but has no value in Secrets.`;
    }
  }
  for (const secret of secrets) {
    if (!used.has(secret.name)) {
      return `New Secret ${secret.name} is not referenced by harness authentication or Secret bindings.`;
    }
  }
  return null;
}

function resolveSecretSource(source, savedSecrets) {
  if (source?.kind !== "new-secret") {
    return source;
  }
  const saved = savedSecrets.get(source.name);
  if (!saved?.ref) {
    throw new Error(`Save new Secret ${source.name} before creating the Agent.`);
  }
  return saved.ref;
}

function resolveNewSecretReferences(bindings, harnessAuth, savedSecrets) {
  const resolvedBindings = {};
  for (const [name, binding] of Object.entries(bindings ?? {})) {
    resolvedBindings[name] = {
      ...binding,
      source: resolveSecretSource(binding?.source, savedSecrets),
    };
  }
  const resolvedHarnessAuth =
    harnessAuth?.method === "api_key"
      ? {
          ...harnessAuth,
          source: resolveSecretSource(harnessAuth.source, savedSecrets),
        }
      : harnessAuth;
  return { bindings: resolvedBindings, harnessAuth: resolvedHarnessAuth };
}

function provisioningStatusText(status) {
  switch (status) {
    case "queued":
      return "Provisioning queued…";
    case "running":
      return "Provisioning Agent…";
    case "succeeded":
      return "Provisioning finished. Waiting for deployment activation…";
    case "failed":
      return "Provisioning failed.";
    case "cancelled":
      return "Provisioning was cancelled.";
    default:
      return "Provisioning Agent…";
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deploymentStatusPath(namespaceId, provisioning) {
  return typeof provisioning?.agentId === "string" &&
    provisioning.agentId.length > 0 &&
    typeof provisioning?.revisionId === "string" &&
    provisioning.revisionId.length > 0
    ? `${namespacePath(namespaceId)}/agents/${encodeURIComponent(provisioning.agentId)}/deployments/${encodeURIComponent(provisioning.revisionId)}`
    : null;
}

async function waitForProvisioning({ request, status, namespaceId, first }) {
  let current = first.provisioning ?? first;
  const jobUrl = current?.url;
  while (current?.status === "queued" || current?.status === "running") {
    status.textContent = provisioningStatusText(current.status);
    if (typeof current.url !== "string" || !current.url) {
      throw new Error("Provisioning status URL is unavailable.");
    }
    await wait(1_000);
    const next = await request(current.url);
    current = next.provisioning ?? next;
  }
  status.textContent = provisioningStatusText(current?.status);
  if (current?.status !== "succeeded") {
    const error = new Error(current?.error?.message ?? "Provisioning did not complete.");
    error.provisioningTerminal = true;
    error.canRetryProvisioning = current?.status === "failed";
    error.provisioningUrl = current?.url ?? jobUrl;
    throw error;
  }
  const deploymentPath = deploymentStatusPath(namespaceId, current);
  if (typeof current.agentId !== "string" || !current.agentId) {
    throw new Error("Provisioning status did not include an Agent.");
  }
  if (typeof current.revisionId !== "string" || !current.revisionId) {
    throw new Error("Provisioning status did not include an AgentRevision.");
  }
  if (!deploymentPath) {
    return { agentId: current.agentId, revisionId: current.revisionId };
  }
  let deployment = current.deployment;
  while (deployment?.status !== "succeeded") {
    if (deployment?.status === "failed" || deployment?.status === "cancelled") {
      const error = new Error(deployment.error?.message ?? "Deployment did not activate.");
      error.provisioningTerminal = true;
      throw error;
    }
    status.textContent = "Waiting for deployment activation…";
    await wait(1_000);
    deployment = await request(deploymentPath);
  }
  return { agentId: current.agentId, revisionId: deployment.revisionId ?? current.revisionId };
}

async function finishProvisioningAttempt({ request, status, namespaceId, attempt }) {
  status.textContent = "Submitting provisioning request…";
  const provisioned =
    attempt.retryUrl === undefined
      ? await request(`${namespacePath(namespaceId)}/agents/provision`, {
          method: "POST",
          body: attempt.body,
        })
      : await request(attempt.retryUrl, { method: "POST" });
  attempt.acknowledged = true;
  const accepted = provisioned.provisioning ?? provisioned;
  attempt.statusUrl = accepted.url ?? attempt.statusUrl;
  attempt.retryUrl =
    typeof attempt.statusUrl === "string" && attempt.statusUrl.length > 0
      ? `${attempt.statusUrl}/retry`
      : undefined;
  status.textContent = "Provisioning request accepted.";
  return waitForProvisioning({
    request,
    status,
    namespaceId,
    first: provisioned,
  });
}

function createSecretsEditor(context) {
  const rows = element("div", { className: "secret-save-rows" });
  const savedSecrets = new Map();
  let counter = 0;
  let saveOutcomeUnknown = false;
  let externallyDisabled = false;
  let saving = false;
  let savePromise = null;
  const saveFeedback = element("p", { className: "hint", role: "status" });
  let addButton;
  let saveButton;

  function addRow(name = "", value = "", savedSecret = null) {
    const index = counter++;
    const nameInput = element("input", {
      id: `secret-save-name-${index}`,
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "SLACK_APP_TOKEN",
      value: name,
    });
    const valueInput = element("input", {
      id: `secret-save-value-${index}`,
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      value,
    });
    const status = element("p", { className: "hint", role: "status" });
    const state = { nameInput, valueInput, status, savedSecret };
    if (savedSecret) {
      savedSecrets.set(savedSecret.name, savedSecret);
      nameInput.readOnly = true;
      valueInput.value = "";
      valueInput.disabled = true;
      status.textContent = `Saved as ${savedSecret.id}.`;
    }
    const row = element(
      "div",
      { className: "secret-save-row" },
      field("Secret name", nameInput),
      field("Secret value", valueInput),
      status,
      button("Remove from form", () => {
        if (state.savedSecret) {
          savedSecrets.delete(state.savedSecret.name);
        }
        row.remove();
        if (!rows.children.length) {
          addRow();
        }
      }),
    );
    row.secretState = state;
    rows.append(row);
  }

  function readSecrets() {
    const secrets = [];
    const names = new Set();
    for (const row of rows.children) {
      const { nameInput, valueInput, savedSecret } = row.secretState;
      const name = nameInput.value.trim();
      const value = valueInput.value;
      nameInput.setCustomValidity("");
      valueInput.setCustomValidity("");
      if (savedSecret) {
        if (names.has(savedSecret.name)) {
          nameInput.setCustomValidity("Secret names must be unique.");
          nameInput.reportValidity();
          return undefined;
        }
        names.add(savedSecret.name);
        secrets.push({ name: savedSecret.name, saved: savedSecret });
        continue;
      }
      if (!name && !value) {
        continue;
      }
      if (!name) {
        nameInput.setCustomValidity("Enter a Secret name.");
        nameInput.reportValidity();
        return undefined;
      }
      if (names.has(name)) {
        nameInput.setCustomValidity("Secret names must be unique.");
        nameInput.reportValidity();
        return undefined;
      }
      names.add(name);
      if (!value) {
        valueInput.setCustomValidity("Enter a Secret value.");
        valueInput.reportValidity();
        return undefined;
      }
      secrets.push({ name, value });
    }
    return secrets;
  }

  async function runSavePendingSecrets() {
    if (saveOutcomeUnknown) {
      throw new Error("Refresh or start over before saving after an unknown Secret save outcome.");
    }
    const secrets = readSecrets();
    if (secrets === undefined) {
      return undefined;
    }
    for (const secret of secrets) {
      if (secret.saved) {
        continue;
      }
      const row = [...rows.children].find(
        (entry) => entry.secretState.nameInput.value.trim() === secret.name,
      );
      let mutationStarted = false;
      try {
        mutationStarted = true;
        const saved = await context.request(`${namespacePath(context.namespaceId)}/secrets`, {
          method: "POST",
          body: { name: secret.name, value: secret.value },
        });
        row.secretState.savedSecret = saved;
        row.secretState.valueInput.value = "";
        row.secretState.valueInput.disabled = true;
        row.secretState.nameInput.readOnly = true;
        row.secretState.status.textContent = `Saved as ${saved.id}.`;
        savedSecrets.set(saved.name, saved);
        saveFeedback.textContent = `Saved ${saved.name} as ${saved.id}.`;
        if (!context.isCurrent()) {
          return undefined;
        }
      } catch (error) {
        if (!context.isCurrent()) {
          return undefined;
        }
        if (error.status === 401) {
          context.onExpired();
          return undefined;
        }
        saveOutcomeUnknown = mutationStarted && ![400, 403, 404, 409, 429].includes(error.status);
        if (saveOutcomeUnknown && row) {
          row.secretState.status.textContent =
            "Secret save outcome unknown. Refresh before retrying this value.";
        }
        throw error;
      }
    }
    return savedSecrets;
  }

  async function savePendingSecrets() {
    if (saving) {
      return savePromise ?? savedSecrets;
    }
    saving = true;
    applyDisabled();
    savePromise = runSavePendingSecrets();
    try {
      return await savePromise;
    } finally {
      saving = false;
      savePromise = null;
      if (context.isCurrent()) {
        applyDisabled();
      }
    }
  }
  async function saveFromButton() {
    if (saving || externallyDisabled) {
      return;
    }
    saveFeedback.className = "hint";
    saveFeedback.textContent = "Saving Secrets…";
    try {
      await savePendingSecrets();
      if (context.isCurrent() && !saveOutcomeUnknown) {
        saveFeedback.textContent ||= "Secrets saved.";
      }
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      saveFeedback.className = saveOutcomeUnknown ? "error" : "hint";
      saveFeedback.textContent =
        error.status === undefined && error.message ? error.message : message(error, true);
    }
  }

  function clear() {
    rows.replaceChildren();
    savedSecrets.clear();
    saveOutcomeUnknown = false;
    counter = 0;
    addRow();
  }

  function applyDisabled() {
    const disabled = externallyDisabled || saving;
    for (const row of rows.children) {
      const { nameInput, valueInput, savedSecret } = row.secretState;
      nameInput.disabled = disabled;
      valueInput.disabled = disabled || Boolean(savedSecret);
      for (const buttonNode of row.querySelectorAll("button")) {
        buttonNode.disabled = disabled;
      }
    }
    if (addButton) {
      addButton.disabled = disabled;
    }
    if (saveButton) {
      saveButton.disabled = disabled || saveOutcomeUnknown;
    }
  }

  function setDisabled(value) {
    externallyDisabled = value;
    applyDisabled();
  }

  addRow();
  addButton = button("Add Secret", () => addRow());
  saveButton = button("Save secrets", () => void saveFromButton());
  const section = element(
    "section",
    { className: "secret-save-section" },
    element("h2", {}, "Secrets"),
    element(
      "p",
      { className: "hint" },
      "Save generic namespace Secrets before provisioning. Saved references are reused if Agent creation fails.",
    ),
    rows,
    saveFeedback,
    element("div", { className: "form-actions" }, addButton, saveButton),
  );

  return {
    section,
    readSecrets,
    savePendingSecrets,
    savedSecrets,
    clear,
    setDisabled,
    hasUnknownSaveOutcome: () => saveOutcomeUnknown,
  };
}

export function renderCreateAgent(context) {
  context.setTitle("Create Agent");
  context.view.replaceChildren(
    link("← Agents", "agents", context),
    createPresetFields(context, (rendered) => renderAgentForm(context, rendered)),
    button("Start without Preset", () => renderAgentForm(context, {})),
  );
}

function renderAgentForm(context, rendered) {
  const { view, request, namespaceId } = context;
  const agent = rendered.agent ?? {};
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (
    (agent.name !== undefined && typeof agent.name !== "string") ||
    (agent.executionMode !== undefined &&
      !["embedded", "dedicated"].includes(agent.executionMode)) ||
    (agent.providerId != null && typeof agent.providerId !== "string") ||
    (agent.plugins !== undefined && !isObject(agent.plugins)) ||
    (rendered.configuration?.secretBindings !== undefined &&
      !isObject(rendered.configuration.secretBindings))
  ) {
    throw new Error("Rendered Preset contains invalid Agent fields or Secret bindings.");
  }
  const binding = agent.harnessAuth;
  if (
    binding != null &&
    (!isObject(binding) ||
      !["runtime", "api_key", "chatgpt_service_account"].includes(binding.method) ||
      (binding.method === "chatgpt_service_account" &&
        typeof binding.serviceAccountId !== "string") ||
      (binding.method === "api_key" &&
        !(
          (binding.source?.kind === "secret" &&
            binding.source.namespaceId === namespaceId &&
            typeof binding.source.id === "string") ||
          (binding.source?.kind === "new-secret" && typeof binding.source.name === "string")
        )))
  ) {
    throw new Error(
      "Rendered Preset contains an invalid authentication source for this Namespace.",
    );
  }

  const formId = "create-agent-form";
  const name = element("input", {
    id: "agent-name",
    name: "name",
    required: "",
    maxlength: "200",
    autocomplete: "off",
  });
  const mode = element(
    "select",
    { id: "execution-mode" },
    element("option", { value: "dedicated" }, "Dedicated"),
    element("option", { value: "embedded" }, "Embedded"),
  );
  const configuration = element("textarea", {
    id: "configuration-json",
    name: "configuration",
    required: "",
    rows: "18",
    className: "configuration-editor",
    spellcheck: "false",
    "aria-describedby": "configuration-json-hint",
  });
  name.value = agent.name ?? "";
  mode.value = agent.executionMode ?? "dedicated";
  let template = JSON.stringify(configurationTemplate(mode.value), null, 2);
  configuration.value =
    rendered.configuration?.values === undefined
      ? template
      : JSON.stringify(rendered.configuration.values, null, 2);
  let edited = false;
  const confirmDiscard = () => !edited || window.confirm("Discard your edited launch settings?");
  const reset = button("Reset template", () => {
    if (!confirmDiscard()) {
      return;
    }
    template = JSON.stringify(configurationTemplate(mode.value), null, 2);
    configuration.value = template;
    configuration.setCustomValidity("");
    feedback.textContent = "";
    renderChannelEditor();
  });
  mode.addEventListener("change", () => {
    const untouched = configuration.value === template;
    template = JSON.stringify(configurationTemplate(mode.value), null, 2);
    if (untouched) {
      configuration.value = template;
    }
    feedback.textContent = "";
    renderChannelEditor();
  });
  configuration.addEventListener("input", () => {
    configuration.setCustomValidity("");
    feedback.textContent = "";
    renderChannelEditor();
  });

  const provider = element(
    "select",
    { id: "provider-id", disabled: true },
    element("option", { value: "" }, "None"),
  );
  const providerId = agent.providerId ?? "";
  if (providerId) {
    provider.append(element("option", { value: providerId }, providerId));
    provider.value = providerId;
  }
  const auth = createHarnessAuthFields(context, agent.harnessAuth ?? null, {
    allowNewSecret: true,
  });
  const plugins = element("textarea", { id: "agent-plugins", rows: "4", spellcheck: "false" });
  plugins.value = JSON.stringify(agent.plugins ?? {}, null, 2);
  const secretBindings = element("textarea", {
    id: "configuration-secret-bindings",
    rows: "4",
    spellcheck: "false",
  });
  secretBindings.value = JSON.stringify(rendered.configuration?.secretBindings ?? {}, null, 2);
  const secretsEditor = createSecretsEditor(context);
  const workspaceInputs = Object.entries(WORKSPACE_DEFAULTS).map(([filename, content]) => {
    const input = element("textarea", {
      id: `workspace-${filename.replace(".", "-")}`,
      rows: "8",
      spellcheck: "false",
    });
    input.value = content;
    return [filename, input];
  });
  const workspaceSection = element(
    "section",
    {},
    element("h2", {}, "Workspace files"),
    element(
      "p",
      { className: "muted" },
      "Customize the OpenClaw defaults for this Agent. These files are applied before its first deployment runs. Clearing a field creates an empty file. After deployment, edit them in Workspace files on the Agent.",
    ),
    ...workspaceInputs.map(([filename, input]) => field(filename, input)),
  );
  const providerStatus = element("p", { className: "hint", role: "status" }, "Loading Providers…");
  let providersLoaded = false;
  let modelProviderCount = 0;
  let capabilityDiscoveryDone = false;
  let capabilityDiscoveryFailed = false;
  const provisionableExecutionModes = new Set();
  let pending = false;
  let outcomeUnknown = false;
  let savedConfiguration;
  let provisioningRequestId = createClientRequestId();
  let provisioningAttempt = null;
  const feedback = element("p", { className: "error", role: "alert" });
  const savedStatus = element("p", { className: "hint", role: "status" });
  const submit = element(
    "button",
    { type: "submit", form: formId, className: "primary" },
    "Create Agent",
  );
  const startOver = button("Start over", () => {
    if (window.confirm("Discard this draft and start again?")) {
      renderCreateAgent(context);
    }
  });
  const retryProvisioning = button("Retry provisioning request", () => {
    if (!provisioningAttempt || pending) {
      return;
    }
    void submitProvisioningAttempt(provisioningAttempt);
  });
  const retryCapabilityDiscovery = button("Retry capability check", () => {
    void loadInstallationCapabilities();
  });
  const actions = element(
    "div",
    { className: "form-actions" },
    button("Cancel", () => context.navigate("agents")),
    startOver,
    retryProvisioning,
    submit,
  );
  const channelEditor = element("div", { className: "create-channels" });
  const form = element(
    "form",
    { id: formId, className: "agent-form agent-card" },
    field("Agent name", name, "Unique within this Namespace."),
    field(
      "Execution mode",
      mode,
      "Slack requires Dedicated execution. Changing the mode keeps any edited JSON; use Reset template to start again.",
    ),
    field("Provider (optional)", provider),
    providerStatus,
    retryCapabilityDiscovery,
    auth.section,
    field(
      "Configuration JSON",
      configuration,
      "Starter template applied. Dedicated Agents are provisioned and deployed from this inline Configuration. Embedded Agents save a draft Configuration and Agent.",
    ),
    reset,
    field(
      "Secret bindings JSON",
      secretBindings,
      "Map environment names to existing Secret references or new Secret names from this form. Do not enter values here.",
    ),
    secretsEditor.section,
    field("Plugin selections JSON", plugins, "Desired plugin selections and policies."),
    workspaceSection,
  );
  form.addEventListener("input", (event) => {
    edited = true;
    event.target.setCustomValidity?.("");
  });
  form.addEventListener("change", () => {
    edited = true;
  });
  function hasEnabledChannel(values) {
    const channels = values?.channels;
    if (channels === null || typeof channels !== "object" || Array.isArray(channels)) {
      return false;
    }
    return ["slack", "msteams"].some((id) => {
      const config = channels[id];
      return (
        config !== null &&
        typeof config === "object" &&
        !Array.isArray(config) &&
        config.enabled !== false
      );
    });
  }
  function renderChannelEditor() {
    const values = parseObject(configuration);
    if (values === undefined) {
      channelEditor.replaceChildren(
        element(
          "section",
          { className: "channels-section" },
          element("div", { className: "channel-heading" }, element("h2", {}, "Channels")),
          element(
            "p",
            { className: "error" },
            "Enter a valid Configuration JSON object before configuring channels.",
          ),
        ),
      );
      return;
    }
    const channels = renderChannels({
      values,
      executionMode: mode.value,
      readOnly: Boolean(savedConfiguration),
      copy: {
        editableDescription:
          "Stage Slack settings into this Configuration JSON. They are saved when you create the Agent.",
        drawerNotice:
          "Channel settings apply to this form’s Configuration JSON. Provide matching Secret bindings before provisioning.",
        drawerFootnote: "These settings are not persisted until you create the Agent.",
        saveLabel: "Apply channel settings",
        readOnlyDescription:
          "This saved initial Configuration is fixed for this create form. Retrying Agent creation will reuse these channel settings.",
        readOnlyCardMessage: "This saved initial Configuration cannot be edited from this form.",
      },
      onSave: async (updatedValues) => {
        if (!context.isCurrent() || pending || outcomeUnknown || savedConfiguration) {
          throw new Error("This view has changed. Reopen Agent creation before applying channels.");
        }
        edited = true;
        configuration.value = JSON.stringify(updatedValues, null, 2);
        configuration.setCustomValidity("");
        setTimeout(() => {
          if (context.isCurrent()) {
            renderChannelEditor();
          }
        }, 0);
      },
    });
    const modeWarning =
      mode.value === "embedded" && hasEnabledChannel(values)
        ? element(
            "p",
            { className: "error" },
            "Channels require Dedicated execution. Select Dedicated or disable configured channels before creating the Agent.",
          )
        : null;
    channelEditor.replaceChildren(...[channels, modeWarning].filter(Boolean));
    updateControls();
  }
  const supportsProvisioning = () => provisionableExecutionModes.has(mode.value);
  const shouldProvision = () => mode.value === "dedicated" && supportsProvisioning();
  const addProvisionableExecutionModes = (executionModes) => {
    for (const executionMode of executionModes ?? []) {
      provisionableExecutionModes.add(executionMode);
    }
  };
  const updateProviderStatusText = () => {
    if (capabilityDiscoveryFailed) {
      return;
    }
    if (modelProviderCount > 0) {
      providerStatus.textContent = supportsProvisioning()
        ? "Choose an installed Provider. This runtime supports first-time Agent provisioning."
        : "Choose an installed Provider. This runtime creates draft Agents for later deployment.";
    } else if (providersLoaded) {
      providerStatus.textContent = "No Providers configured.";
    }
  };
  const updateControls = () => {
    for (const root of [form, actions]) {
      for (const node of root.querySelectorAll("button, input, select, textarea")) {
        node.disabled = pending;
      }
    }
    channelEditor.toggleAttribute("inert", pending);
    channelEditor.setAttribute("aria-busy", pending ? "true" : "false");
    provider.disabled = pending || !providersLoaded;
    auth.setDisabled(pending);
    reset.disabled = pending || Boolean(savedConfiguration);
    startOver.disabled = pending || outcomeUnknown || Boolean(savedConfiguration);
    mode.disabled = pending || Boolean(savedConfiguration);
    const provisionable = shouldProvision();
    secretsEditor.section.hidden = !provisionable;
    secretsEditor.setDisabled(pending);
    auth.setNewSecretAllowed(provisionable);
    configuration.readOnly = Boolean(savedConfiguration);
    secretBindings.readOnly = Boolean(savedConfiguration);
    submit.disabled =
      pending ||
      outcomeUnknown ||
      secretsEditor.hasUnknownSaveOutcome() ||
      !capabilityDiscoveryDone;
    retryProvisioning.hidden =
      (!outcomeUnknown && provisioningAttempt?.retryUrl === undefined) || !provisioningAttempt;
    retryProvisioning.disabled = pending || !provisioningAttempt;
    retryCapabilityDiscovery.hidden = !capabilityDiscoveryFailed;
    retryCapabilityDiscovery.disabled = pending;
  };
  renderChannelEditor();
  async function loadInstallationCapabilities() {
    capabilityDiscoveryDone = false;
    capabilityDiscoveryFailed = false;
    updateControls();
    try {
      const installation = await request("/installation");
      if (!context.isCurrent()) {
        return;
      }
      provisionableExecutionModes.clear();
      addProvisionableExecutionModes(installation.capabilities?.agentProvisioning?.executionModes);
      capabilityDiscoveryDone = true;
      updateProviderStatusText();
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      capabilityDiscoveryFailed = true;
      providerStatus.textContent = `Installation capabilities unavailable. ${message(error)} Retry before creating an Agent.`;
    } finally {
      if (context.isCurrent()) {
        updateControls();
      }
    }
  }
  void loadInstallationCapabilities();
  request("/providers")
    .then((items) => {
      if (!context.isCurrent()) {
        return;
      }
      const modelProviders = items.filter((item) => item.type === "chatgpt");
      modelProviderCount = modelProviders.length;
      provider.append(
        ...modelProviders
          .filter((item) => item.id !== providerId)
          .map((item) => element("option", { value: item.id }, `${item.id} · ${item.type}`)),
      );
      providersLoaded = true;
      updateProviderStatusText();
      updateControls();
    })
    .catch((error) => {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
      } else {
        providerStatus.textContent = `Providers unavailable. ${message(error)} You can continue with None.`;
        updateControls();
      }
    });
  async function submitProvisioningAttempt(attempt) {
    pending = true;
    outcomeUnknown = false;
    updateControls();
    feedback.textContent = "";
    let mutationStarted = false;
    try {
      mutationStarted = true;
      const { agentId, revisionId } = await finishProvisioningAttempt({
        request,
        status: savedStatus,
        namespaceId,
        attempt,
      });
      if (!context.isCurrent()) {
        return;
      }
      provisioningAttempt = null;
      context.navigate(`agents/${agentId}?revision=${revisionId}&tab=workspace`);
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      outcomeUnknown =
        mutationStarted &&
        !error.provisioningTerminal &&
        ![400, 403, 404, 409, 429].includes(error.status);
      const detail =
        outcomeUnknown && attempt.acknowledged
          ? "Outcome unknown after provisioning admission. Retry resubmits the same request ID and saved references so the API can recover the job."
          : outcomeUnknown
            ? "Outcome unknown. Retry resubmits the same request ID and saved references."
            : error.provisioningTerminal && error.canRetryProvisioning
              ? `${error.message} Retry uses the accepted provisioning job.`
              : error.status === undefined && error.message
                ? error.message
                : message(error, mutationStarted);
      feedback.textContent = detail + (error.requestId ? ` Request ID: ${error.requestId}` : "");
      if (error.provisioningTerminal && error.canRetryProvisioning) {
        provisioningAttempt = {
          ...attempt,
          retryUrl: error.provisioningUrl ? `${error.provisioningUrl}/retry` : attempt.retryUrl,
        };
      } else if (!outcomeUnknown) {
        provisioningAttempt = null;
      }
    } finally {
      if (context.isCurrent()) {
        pending = false;
        updateControls();
      }
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || outcomeUnknown || !form.reportValidity()) {
      return;
    }
    const values = parseObject(configuration, true);
    const desiredPlugins = parseObject(plugins, true);
    const bindings = parseObject(secretBindings, true);
    const provisionable = shouldProvision();
    const secrets = provisionable ? secretsEditor.readSecrets() : [];
    if (values === undefined || desiredPlugins === undefined || bindings === undefined) {
      return;
    }
    if (secrets === undefined) {
      return;
    }
    if (mode.value === "embedded" && hasEnabledChannel(values)) {
      feedback.textContent =
        "Channels require Dedicated execution. Select Dedicated or disable configured channels before creating the Agent.";
      return;
    }
    const body = {
      name: name.value.trim(),
      executionMode: mode.value,
      initialWorkspaceFiles: Object.fromEntries(
        workspaceInputs.map(([filename, input]) => [filename, input.value]),
      ),
      workspaceDefaultsId: WORKSPACE_DEFAULTS_ID,
      ...(Object.keys(desiredPlugins).length ? { plugins: desiredPlugins } : {}),
      ...(provider.value ? { providerId: provider.value } : {}),
    };
    pending = true;
    updateControls();
    feedback.textContent = "";
    let mutationStarted = false;
    try {
      body.harnessAuth = await auth.readBinding();
      if (!context.isCurrent()) {
        return;
      }
      if (
        !provisionable &&
        body.harnessAuth?.method === "api_key" &&
        body.harnessAuth.source?.kind === "new-secret"
      ) {
        feedback.textContent =
          "New Secret entries are only available when this runtime supports first-time Agent provisioning.";
        return;
      }
      mutationStarted = true;
      if (provisionable) {
        const finalBindings = addDefaultNewSecretBindings(bindings, secrets, body.harnessAuth);
        const invalidSecrets = validateNewSecretReferences(
          secrets,
          finalBindings,
          body.harnessAuth,
        );
        if (invalidSecrets) {
          feedback.textContent = invalidSecrets;
          return;
        }
        savedStatus.textContent = "Saving Secrets…";
        const savedSecrets = await secretsEditor.savePendingSecrets();
        if (savedSecrets === undefined) {
          return;
        }
        const resolved = resolveNewSecretReferences(finalBindings, body.harnessAuth, savedSecrets);
        provisioningAttempt = {
          acknowledged: false,
          body: {
            requestId: provisioningRequestId,
            ...body,
            harnessAuth: resolved.harnessAuth,
            configuration: {
              kind: "agent",
              values,
              ...(Object.keys(resolved.bindings).length
                ? { secretBindings: resolved.bindings }
                : {}),
            },
          },
        };
        const { agentId, revisionId } = await finishProvisioningAttempt({
          request,
          status: savedStatus,
          namespaceId,
          attempt: provisioningAttempt,
        });
        if (!context.isCurrent()) {
          return;
        }
        provisioningAttempt = null;
        if (context.isCurrent()) {
          context.navigate(`agents/${agentId}?revision=${revisionId}&tab=workspace`);
        }
        return;
      }
      if (!savedConfiguration) {
        savedConfiguration = await request(`${namespacePath(namespaceId)}/configurations`, {
          method: "POST",
          body: {
            kind: "agent",
            values,
            ...(Object.keys(bindings).length ? { secretBindings: bindings } : {}),
          },
        });
        if (!context.isCurrent()) {
          return;
        }
        savedStatus.textContent = `Configuration saved: ${savedConfiguration.id}. Its JSON, Secret bindings, and execution mode are now fixed for this form; retrying Agent creation will reuse it.`;
        renderChannelEditor();
      }
      const created = await request(`${namespacePath(namespaceId)}/agents`, {
        method: "POST",
        body: { ...body, configurationId: savedConfiguration.id },
      });
      if (context.isCurrent()) {
        context.navigate(`agents/${created.id}?revision=draft`);
      }
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      outcomeUnknown =
        mutationStarted &&
        !error.provisioningTerminal &&
        ![400, 403, 404, 409, 429].includes(error.status);
      const detail =
        outcomeUnknown && provisioningAttempt
          ? provisioningAttempt.acknowledged
            ? "Outcome unknown after provisioning admission. Retry resubmits the same request ID and saved references so the API can recover the job."
            : "Outcome unknown. Retry resubmits the same request ID and saved references."
          : secretsEditor.hasUnknownSaveOutcome()
            ? "A Secret save outcome is unknown. Saved Secrets are retained; refresh before retrying unsaved values."
            : error.status === undefined && error.message
              ? error.message
              : error.status === 409 && savedConfiguration
                ? "Agent creation conflicts with the saved state. Check the Agent name and selections, then try again."
                : message(error, mutationStarted);
      feedback.textContent = detail + (error.requestId ? ` Request ID: ${error.requestId}` : "");
    } finally {
      if (context.isCurrent()) {
        pending = false;
        updateControls();
      }
    }
  });
  view.replaceChildren(
    link("← Agents", "agents", context),
    element(
      "p",
      { className: "muted" },
      "Dedicated Agents are provisioned and deployed from this form. Embedded Agents save a Configuration and draft Agent for later deployment.",
    ),
    form,
    channelEditor,
    savedStatus,
    feedback,
    actions,
  );
}
