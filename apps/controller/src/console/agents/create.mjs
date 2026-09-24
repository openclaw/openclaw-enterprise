import { element, button } from "../dom.mjs";
import { WORKSPACE_DEFAULTS, WORKSPACE_DEFAULTS_ID } from "../workspace-defaults.mjs";
import { harnessAuthDescription } from "./harness-auth.mjs";
import { createRepositoryFields } from "./repositories.mjs";
import { ensureSecretOperateBinding } from "./secret-access.mjs";
import { createPresetFields } from "./presets.mjs";
import { renderChannels } from "../channels.mjs";
import { link, message, namespacePath } from "./list.mjs";

// TODO: This starter list is intentionally hardcoded for the initial Console release.
// Revisit catalog refresh and credential-aware discovery after the basic creation flow ships.
const MODEL_CHOICES = {
  openai: [
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ],
  // Non-retired models as of 2026-09-24, including earlier and access-restricted releases.
  // Source: https://platform.claude.com/docs/en/about-claude/model-deprecations
  anthropic: [
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "claude-opus-5",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-mythos-preview",
  ],
};

function field(label, input, hint) {
  return element(
    "div",
    { className: "form-field" },
    element("label", { for: input.id }, label),
    input,
    hint ? element("p", { className: "hint", id: `${input.id}-hint` }, hint) : null,
  );
}

function configurationTemplate(harnessId, nativeProvider, providerModel) {
  const providerId = harnessId === "codex" ? "codex" : nativeProvider;
  const modelReference = `${providerId}/${providerModel}`;
  let baseUrl =
    nativeProvider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
  if (harnessId === "codex") {
    baseUrl = "http://127.0.0.1:9";
  }
  const provider = {
    [providerId]: {
      baseUrl,
      api: nativeProvider === "anthropic" ? "anthropic-messages" : "openai-responses",
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
    ...(providerModel
      ? {
          agents: {
            defaults: {
              model: modelReference,
              models: { [modelReference]: { agentRuntime: { id: harnessId } } },
            },
          },
          models: { providers: provider },
        }
      : {}),
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
  const passwordAuth =
    isObject(agent.harnessAuth) && Object.hasOwn(agent.harnessAuth, "secret")
      ? agent.harnessAuth
      : undefined;
  if (
    passwordAuth &&
    (!["api_key", "codex_pat"].includes(passwordAuth.method) ||
      typeof passwordAuth.secret !== "string" ||
      Object.keys(passwordAuth).some((key) => !["method", "secret"].includes(key)))
  ) {
    throw new Error("Rendered Preset contains invalid password authentication.");
  }
  const binding = passwordAuth ? undefined : agent.harnessAuth;
  const hasBoundModelCredential = ["api_key", "codex_pat"].includes(binding?.method);
  if (
    binding != null &&
    (!isObject(binding) ||
      !["runtime", "api_key", "codex_pat", "chatgpt_service_account"].includes(binding.method) ||
      (binding.method === "chatgpt_service_account" &&
        typeof binding.serviceAccountId !== "string") ||
      (["api_key", "codex_pat"].includes(binding.method) &&
        (binding.source?.kind !== "secret" ||
          binding.source.namespaceId !== namespaceId ||
          typeof binding.source.id !== "string")))
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
  const harness = element(
    "select",
    { id: "agent-harness", "aria-describedby": "agent-harness-hint" },
    element("option", { value: "codex" }, "Codex"),
    element("option", { value: "openclaw" }, "OpenClaw"),
  );
  const harnessHint = element("p", { id: "agent-harness-hint", className: "hint" });
  const configuration = element("textarea", {
    id: "configuration-json",
    name: "configuration",
    required: "",
    rows: "18",
    className: "configuration-editor",
    spellcheck: "false",
    "aria-describedby": "configuration-json-hint",
  });
  const primary = rendered.configuration?.values?.agents?.defaults?.model;
  const initialModel = typeof primary === "string" ? primary : primary?.primary;
  const nativeProvider = element(
    "select",
    { id: "model-provider" },
    element("option", { value: "openai" }, "OpenAI"),
    element("option", { value: "anthropic" }, "Anthropic"),
  );
  nativeProvider.value = initialModel?.startsWith("anthropic/") ? "anthropic" : "openai";
  const useModelChoices = !binding && typeof initialModel !== "string";
  const model = element("input", {
    id: useModelChoices ? "agent-model-manual" : "agent-model",
    required: !useModelChoices,
    autocomplete: "off",
    pattern: "\\S+",
  });
  model.value = initialModel?.split("/").slice(1).join("/") || "";
  const apiKey = element("input", {
    id: "provider-api-key",
    type: "password",
    required: !binding,
    autocomplete: "off",
    spellcheck: "false",
  });
  const authMethod = element(
    "select",
    { id: "agent-auth-method" },
    element("option", { value: "api_key" }, "OpenAI API key"),
    element("option", { value: "codex_pat" }, "Service Accounts"),
  );
  authMethod.value = passwordAuth?.method ?? binding?.method ?? "api_key";
  if (passwordAuth) {
    apiKey.value = passwordAuth.secret;
    delete passwordAuth.secret;
  }
  const authMethodField = field("Authentication method", authMethod);
  const credentialLabel = element("label", { for: apiKey.id }, "API key");
  const credentialHelp = element("p", { className: "hint", id: "provider-credential-help" });
  apiKey.setAttribute("aria-describedby", credentialHelp.id);
  let manualModel = !useModelChoices;
  let pendingModelSettings;
  let pendingProviderModel;
  const modelChoice = element(
    "select",
    { id: "agent-model" },
    element("option", { value: "" }, "Choose a model"),
    ...MODEL_CHOICES[nativeProvider.value].map((id) => element("option", { value: id }, id)),
  );
  const enterModel = button("Enter model ID manually", () => {
    manualModel = true;
    model.value = "";
    modelChoice.value = "";
    updateModelConfiguration();
    updateControls();
    model.focus();
  });
  const modelField = field("Model ID", model, "Enter a model ID available to this credential.");
  const choiceField = field(
    "Model",
    modelChoice,
    "Choose a model your credential can access, or enter another model ID manually.",
  );
  const modelSection = element(
    "section",
    { className: "model-selection" },
    ...(useModelChoices ? [choiceField, enterModel] : []),
    modelField,
  );
  function resetModelChoices(resetTransport = false) {
    manualModel = !useModelChoices;
    model.value = "";
    modelChoice.replaceChildren(
      element("option", { value: "" }, "Choose a model"),
      ...MODEL_CHOICES[nativeProvider.value].map((id) => element("option", { value: id }, id)),
    );
    updateModelConfiguration(resetTransport);
    updateControls();
  }
  if (useModelChoices) {
    modelChoice.addEventListener("change", () => {
      manualModel = false;
      model.value = modelChoice.value;
      updateModelConfiguration();
    });
  }
  const authSection = element(
    "fieldset",
    { className: "harness-auth-fields" },
    element("legend", {}, "Model provider"),
    field("Provider", nativeProvider),
    field("Harness", harness),
    harnessHint,
    binding
      ? element("p", {}, `Preset authentication: ${harnessAuthDescription(binding)}`)
      : authMethodField,
    binding
      ? element(
          "p",
          { className: "hint" },
          hasBoundModelCredential
            ? "This Preset's saved credential and provider are fixed. Start without a Preset to use a different provider."
            : "This Preset's saved authentication source is preserved.",
        )
      : element(
          "div",
          { className: "form-field" },
          credentialLabel,
          apiKey,
          credentialHelp,
          element(
            "p",
            { className: "hint" },
            "Stored as a Secret for this Agent. Credentials are never included in Configuration JSON.",
          ),
        ),
    modelSection,
  );
  name.value = agent.name ?? "";
  mode.value = agent.executionMode ?? "dedicated";
  if (authMethod.value === "codex_pat") {
    nativeProvider.value = "openai";
    mode.value = "dedicated";
  } else if (nativeProvider.value === "anthropic" || binding?.method === "runtime") {
    mode.value = "embedded";
  }
  harness.value = mode.value === "dedicated" ? "codex" : "openclaw";
  const currentTemplate = () =>
    JSON.stringify(
      configurationTemplate(harness.value, nativeProvider.value, model.value.trim()),
      null,
      2,
    );
  configuration.value =
    rendered.configuration?.values === undefined
      ? currentTemplate()
      : JSON.stringify(rendered.configuration.values, null, 2);
  let edited = false;
  const confirmDiscard = () => !edited || window.confirm("Discard your edited launch settings?");
  const reset = button("Reset template", () => {
    if (!confirmDiscard()) {
      return;
    }
    pendingModelSettings = undefined;
    pendingProviderModel = undefined;
    configuration.value = currentTemplate();
    configuration.setCustomValidity("");
    feedback.textContent = "";
    renderChannelEditor();
  });
  function updateModelConfiguration(resetTransport = false) {
    const values = parseObject(configuration);
    if (values === undefined) {
      return;
    }
    const next = configurationTemplate(harness.value, nativeProvider.value, model.value.trim());
    const previous = values.agents?.defaults?.model;
    const previousModel = typeof previous === "string" ? previous : previous?.primary;
    const modelSettings = { ...values.agents?.defaults?.models };
    const selectedModel = next.agents?.defaults.model;
    const selectedSettings = {
      ...(modelSettings[selectedModel] ?? modelSettings[previousModel] ?? pendingModelSettings),
      ...(selectedModel ? next.agents.defaults.models[selectedModel] : {}),
    };
    pendingModelSettings = selectedModel ? undefined : selectedSettings;
    delete modelSettings[previousModel];
    const nextModel =
      typeof previous === "object" && previous !== null
        ? { ...previous, primary: selectedModel }
        : selectedModel;
    values.agents = {
      ...values.agents,
      defaults: {
        ...values.agents?.defaults,
        model: nextModel,
        models: {
          ...modelSettings,
          ...(selectedModel ? { [selectedModel]: selectedSettings } : {}),
        },
      },
    };
    const providers = { ...values.models?.providers };
    const previousId =
      typeof previousModel === "string"
        ? previousModel.slice(previousModel.indexOf("/") + 1)
        : pendingProviderModel;
    // Keep transport and model metadata while switching to manual entry clears the model.
    pendingProviderModel = selectedModel || resetTransport ? undefined : previousId;
    if (resetTransport) {
      delete providers.openai;
      delete providers.anthropic;
      delete providers.codex;
      Object.assign(providers, next.models?.providers);
    } else if (selectedModel) {
      const providerId = mode.value === "dedicated" ? "codex" : nativeProvider.value;
      const templateProvider = next.models.providers[providerId];
      const existingProvider = providers[providerId] ?? templateProvider;
      const existingModels = existingProvider.models ?? [];
      const selectedId = model.value.trim();
      if (!existingModels.some((entry) => entry.id === selectedId)) {
        const previousEntry = existingModels.find((entry) => entry.id === previousId);
        const selectedEntry = {
          ...(previousEntry ?? templateProvider.models[0]),
          id: selectedId,
          name:
            previousEntry?.name && previousEntry.name !== previousId
              ? previousEntry.name
              : selectedId,
        };
        providers[providerId] = {
          ...existingProvider,
          models: previousEntry
            ? existingModels.map((entry) => (entry === previousEntry ? selectedEntry : entry))
            : [...existingModels, selectedEntry],
        };
      } else {
        providers[providerId] = existingProvider;
      }
    }
    values.models = { ...values.models, providers };
    if (next.plugins) {
      values.plugins = {
        ...values.plugins,
        allow: [...new Set([...(values.plugins?.allow ?? []), ...next.plugins.allow])],
        entries: {
          ...values.plugins?.entries,
          codex: resetTransport
            ? next.plugins.entries.codex
            : (values.plugins?.entries?.codex ?? next.plugins.entries.codex),
        },
      };
    } else if (values.plugins?.entries?.codex) {
      delete values.plugins.entries.codex;
      if (Array.isArray(values.plugins.allow)) {
        values.plugins.allow = values.plugins.allow.filter((id) => id !== "codex");
      }
    }
    configuration.value = JSON.stringify(values, null, 2);
    configuration.setCustomValidity("");
    feedback.textContent = "";
    renderChannelEditor();
  }
  nativeProvider.addEventListener("change", () => {
    // Operator-managed Presets retain the embedded harness required by their fixed binding.
    harness.value =
      nativeProvider.value === "anthropic" || binding?.method === "runtime" ? "openclaw" : "codex";
    mode.value = harness.value === "codex" ? "dedicated" : "embedded";
    // A provider change must not send the previous provider's key to a different service.
    apiKey.value = "";
    if (!binding) {
      authMethod.value = "api_key";
      resetModelChoices(true);
    } else {
      updateModelConfiguration(true);
    }
  });
  authMethod.addEventListener("change", () => {
    apiKey.value = "";
    resetModelChoices();
  });
  model.addEventListener("change", () => updateModelConfiguration());
  harness.addEventListener("change", () => {
    mode.value = harness.value === "codex" ? "dedicated" : "embedded";
    // Service account tokens cannot authenticate OpenClaw; require a new API key.
    if (!binding && harness.value === "openclaw" && authMethod.value === "codex_pat") {
      authMethod.value = "api_key";
      apiKey.value = "";
      resetModelChoices(true);
    } else {
      updateModelConfiguration(true);
    }
    updateControls();
  });
  configuration.addEventListener("input", () => {
    configuration.setCustomValidity("");
    feedback.textContent = "";
    const values = parseObject(configuration);
    const selected = values?.agents?.defaults?.model;
    const ref = typeof selected === "string" ? selected : selected?.primary;
    if (typeof ref === "string" && /^(openai|anthropic|codex)\//.test(ref)) {
      if (!savedSecret && !hasBoundModelCredential) {
        const selectedProvider = ref.startsWith("anthropic/") ? "anthropic" : "openai";
        if (selectedProvider !== nativeProvider.value && !binding) {
          apiKey.value = "";
          authMethod.value = "api_key";
        }
        nativeProvider.value = selectedProvider;
        if (selectedProvider === "anthropic") {
          harness.value = "openclaw";
          mode.value = "embedded";
        }
      }
      model.value = ref.slice(ref.indexOf("/") + 1);
      if (useModelChoices) {
        manualModel = true;
        modelChoice.value = "";
      }
    }
    renderChannelEditor();
  });

  const plugins = element("textarea", { id: "agent-plugins", rows: "4", spellcheck: "false" });
  plugins.value = JSON.stringify(agent.plugins ?? {}, null, 2);
  const secretBindings = element("textarea", {
    id: "configuration-secret-bindings",
    rows: "4",
    spellcheck: "false",
  });
  secretBindings.value = JSON.stringify(rendered.configuration?.secretBindings ?? {}, null, 2);
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
  let capabilityDiscoveryDone = false;
  let capabilityDiscoveryFailed = false;
  const provisionableExecutionModes = new Set();
  const provisioningRequestId = createClientRequestId();
  let provisioningAttempt = null;
  const capabilityStatus = element(
    "p",
    { className: "hint", role: "status" },
    "Checking installation capabilities…",
  );
  let pending = false;
  let outcomeUnknown = false;
  let rejectedAgentAttempt;
  let savedSecret;
  let savedConfiguration;
  let savedAgent;
  let stagedChannelSecrets = [];
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
  const recoveryMessage = element("p", { className: "muted" });
  const requireRepositoryReload = () => {
    rejectedAgentAttempt = { kind: "repository-scoped", repositoryPolicy: "reload-required" };
  };
  const repositoryRetryLocked = () =>
    rejectedAgentAttempt?.kind === "repository-scoped" &&
    rejectedAgentAttempt.repositoryPolicy !== "current";
  const requiresRepositories = () => rejectedAgentAttempt?.kind === "repository-scoped";
  const reloadRepositories = button("Reload repository choices", async () => {
    if (rejectedAgentAttempt?.kind !== "repository-scoped") {
      return;
    }
    pending = true;
    rejectedAgentAttempt = { kind: "repository-scoped", repositoryPolicy: "reloading" };
    updateControls();
    feedback.textContent = "";
    try {
      const outcome = await repositories.reload();
      switch (outcome.kind) {
        case "obsolete":
        case "expired":
          return;
        case "success":
          rejectedAgentAttempt = { kind: "repository-scoped", repositoryPolicy: "current" };
          recovery.hidden = false;
          recoveryMessage.textContent =
            "Select at least one current repository and an authorization level to retry this Agent. To continue without repository access, start a new draft; the saved Configuration will remain available.";
          savedStatus.textContent = `Repository choices reloaded. Configuration ${savedConfiguration.id} remains saved and will be reused if you retry Agent creation.`;
          return;
        case "denied":
          requireRepositoryReload();
          recovery.hidden = false;
          feedback.textContent = `Repository choices could not be reloaded because Agent creation is denied. Configuration ${savedConfiguration.id} remains saved. Retry the reload or start a new draft.`;
          return;
        case "conflict":
          requireRepositoryReload();
          recovery.hidden = false;
          feedback.textContent = `Repository choices could not be reloaded because this Namespace no longer accepts new Agents. Configuration ${savedConfiguration.id} remains saved. Start a new draft only after the Namespace can accept Agents again.`;
          return;
        case "unavailable":
          requireRepositoryReload();
          recovery.hidden = false;
          feedback.textContent = `Repository choices could not be reloaded. Configuration ${savedConfiguration.id} remains saved. Retry the reload or start a new draft.`;
          return;
      }
    } finally {
      if (context.isCurrent()) {
        pending = false;
        updateControls();
      }
    }
  });
  const startNewDraft = button("Start a new draft", () => {
    if (
      window.confirm(
        `Configuration ${savedConfiguration.id} will remain saved. Start a new Agent draft?`,
      )
    ) {
      renderCreateAgent(context);
    }
  });
  const recovery = element(
    "section",
    { className: "agent-card", hidden: true, "aria-labelledby": "create-recovery-title" },
    element("h2", { id: "create-recovery-title" }, "Recover from a rejected Agent save"),
    recoveryMessage,
    element("div", { className: "form-actions" }, reloadRepositories, startNewDraft),
  );
  const actions = element(
    "div",
    { className: "form-actions" },
    button("Cancel", () => context.navigate("agents")),
    startOver,
    retryProvisioning,
    submit,
  );
  const channelEditor = element("div", { className: "create-channels" });
  let repositories;
  const form = element(
    "form",
    { id: formId, className: "agent-form agent-card" },
    field("Agent name", name, "Unique within this Namespace."),
    authSection,
    capabilityStatus,
    retryCapabilityDiscovery,
    field(
      "Execution mode",
      mode,
      "Set by the harness: Codex uses Dedicated execution; OpenClaw uses Embedded execution. Slack requires Codex.",
    ),
    (repositories = createRepositoryFields(context, (changed) => {
      if (changed) {
        edited = true;
      }
      feedback.textContent = "";
      updateControls();
    })).section,
    field(
      "Configuration JSON",
      configuration,
      "Provider and model selections update this JSON. Supported Dedicated runtimes provision and deploy from this form. Embedded and unsupported runtimes save a draft for later deployment. Slack token Secrets can be selected or created from the channel editor.",
    ),
    reset,
    element(
      "div",
      { hidden: true },
      field(
        "Secret bindings JSON",
        secretBindings,
        "Map environment names to existing Secret references in this Namespace. Do not enter credentials.",
      ),
    ),
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
  function parseObject(input, reportInvalid = false) {
    try {
      const values = JSON.parse(input.value);
      if (values === null || Array.isArray(values) || typeof values !== "object") {
        throw new Error();
      }
      return values;
    } catch {
      if (reportInvalid) {
        input.setCustomValidity("Enter a valid JSON object.");
        input.reportValidity();
      }
      return undefined;
    }
  }
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
  async function grantConfigurationSecretAccess(agent, secrets) {
    const bindings = Object.values(savedConfiguration.secretBindings ?? {});
    const seen = new Set();
    for (const secret of secrets) {
      if (
        secret.namespaceId !== namespaceId ||
        seen.has(secret.id) ||
        !bindings.some(
          (binding) =>
            binding?.source?.kind === "secret" &&
            binding.source.namespaceId === namespaceId &&
            binding.source.id === secret.id &&
            binding.delivery?.type === "env",
        )
      ) {
        continue;
      }
      seen.add(secret.id);
      if (!context.isCurrent()) {
        throw new Error("This view has changed. Reopen Agent creation before binding Secrets.");
      }
      await ensureSecretOperateBinding(context, agent, secret);
    }
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
    const parsedSecretBindings = parseObject(secretBindings) ?? {};
    const channels = renderChannels({
      values,
      executionMode: mode.value,
      readOnly: Boolean(savedConfiguration),
      drawerContext: {
        namespaceId,
        request,
        agentName: () => name.value,
        secretBindings: parsedSecretBindings,
      },
      copy: {
        editableDescription:
          "Stage Slack settings into this Configuration JSON. They are saved when you create the Agent.",
        drawerNotice:
          "Channel and Secret binding settings apply to this form’s Configuration JSON.",
        drawerFootnote:
          "Channel settings and selected bindings are not persisted until you create the Agent. Secrets created from the modal are stored immediately in the Namespace.",
        saveLabel: "Apply channel settings",
        readOnlyDescription:
          "This saved initial Configuration is fixed for this create form. Retrying Agent creation will reuse these channel settings.",
        readOnlyCardMessage: "This saved initial Configuration cannot be edited from this form.",
      },
      onSave: async (updatedValues, options = {}) => {
        if (!context.isCurrent() || pending || outcomeUnknown || savedConfiguration) {
          throw new Error("This view has changed. Reopen Agent creation before applying channels.");
        }
        edited = true;
        configuration.value = JSON.stringify(updatedValues, null, 2);
        if (options.secretBindings !== undefined) {
          secretBindings.value = JSON.stringify(options.secretBindings, null, 2);
          secretBindings.setCustomValidity("");
          stagedChannelSecrets = [...stagedChannelSecrets, ...(options.changedSecrets ?? [])];
        }
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
            "Channels require Dedicated execution. Select OpenAI with the Codex harness or disable configured channels before creating the Agent.",
          )
        : null;
    channelEditor.replaceChildren(...[channels, modeWarning].filter(Boolean));
    updateControls();
  }
  const shouldProvision = () =>
    mode.value === "dedicated" &&
    provisionableExecutionModes.has(mode.value) &&
    !repositories.draftOnly();
  const updateControls = () => {
    const saved = Boolean(savedConfiguration || savedAgent || provisioningAttempt);
    for (const node of form.querySelectorAll("button, input, select, textarea")) {
      node.disabled =
        pending || Boolean(savedAgent) || Boolean(provisioningAttempt) || outcomeUnknown;
    }
    // Unsaved Agent fields remain editable after a known rejection; reuse the saved Configuration.
    for (const node of [
      configuration,
      secretBindings,
      nativeProvider,
      authMethod,
      model,
      modelChoice,
      harness,
      mode,
      reset,
    ]) {
      node.disabled ||= Boolean(savedConfiguration);
    }
    for (const node of actions.querySelectorAll("button")) {
      node.disabled = pending;
    }
    channelEditor.toggleAttribute("inert", pending || saved || outcomeUnknown);
    channelEditor.setAttribute("aria-busy", pending ? "true" : "false");
    const usesPat = (binding?.method ?? authMethod.value) === "codex_pat";
    mode.disabled = true;
    harness.disabled ||=
      binding?.method === "runtime" || (usesPat && Boolean(binding || savedSecret));
    const codexOption = harness.querySelector('[value="codex"]');
    codexOption.hidden = nativeProvider.value === "anthropic";
    codexOption.disabled = nativeProvider.value === "anthropic";
    harnessHint.textContent =
      harness.disabled && usesPat
        ? "This saved service account token requires Codex. Create a new draft without a Preset to use OpenClaw with an API key."
        : "OpenClaw is available for both providers. OpenAI defaults to Codex; Anthropic uses OpenClaw.";
    if (binding?.method === "runtime") {
      harnessHint.textContent =
        "This Preset's operator-managed credentials require the OpenClaw harness.";
    }
    nativeProvider.disabled ||= Boolean(savedSecret) || hasBoundModelCredential;
    authMethod.disabled ||= Boolean(savedSecret) || nativeProvider.value === "anthropic";
    authMethod.querySelector('[value="api_key"]').textContent =
      nativeProvider.value === "anthropic" ? "Anthropic API key" : "OpenAI API key";
    const patOption = authMethod.querySelector('[value="codex_pat"]');
    patOption.hidden = harness.value !== "codex";
    patOption.disabled = harness.value !== "codex";
    credentialLabel.textContent = usesPat ? "Service account token" : "API key";
    if (usesPat) {
      apiKey.placeholder = "at-…";
      credentialHelp.replaceChildren(
        "Use a workspace service account token for dedicated Codex. In ",
        element(
          "a",
          { href: "https://admin.openai.com/", target: "_blank", rel: "noopener noreferrer" },
          "OpenAI admin",
        ),
        ", choose your workspace, open Service accounts, and create a token with Codex scope.",
      );
    } else if (nativeProvider.value === "openai") {
      apiKey.placeholder = "sk-…";
      credentialHelp.replaceChildren(
        "Use an OpenAI API key with API billing. ",
        element(
          "a",
          {
            href: "https://platform.openai.com/api-keys",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Create an API key",
        ),
        ".",
      );
    } else {
      apiKey.placeholder = "sk-ant-…";
      credentialHelp.textContent = "Use an Anthropic API key for embedded OpenClaw.";
    }
    apiKey.disabled ||= Boolean(savedSecret);
    startOver.disabled = pending || outcomeUnknown || saved || Boolean(savedSecret);
    if (useModelChoices) {
      choiceField.hidden = manualModel;
      modelField.hidden = !manualModel;
      model.required = manualModel;
      modelChoice.required = !manualModel;
      enterModel.disabled ||= Boolean(savedConfiguration);
    }
    reloadRepositories.disabled = pending || outcomeUnknown;
    startNewDraft.disabled = pending || outcomeUnknown;
    repositories.setDisabled(
      pending ||
        outcomeUnknown ||
        Boolean(savedAgent) ||
        Boolean(provisioningAttempt) ||
        repositoryRetryLocked(),
    );
    submit.disabled =
      (!savedAgent &&
        (repositoryRetryLocked() ||
          (requiresRepositories() && !repositories.hasValidSelection()) ||
          !repositories.isSettled() ||
          repositories.blocksCreate())) ||
      pending ||
      outcomeUnknown ||
      !capabilityDiscoveryDone ||
      Boolean(provisioningAttempt);
    retryProvisioning.hidden = !provisioningAttempt;
    retryProvisioning.disabled = pending || !provisioningAttempt;
    retryCapabilityDiscovery.hidden = !capabilityDiscoveryFailed;
    retryCapabilityDiscovery.disabled = pending;
    submit.textContent = savedAgent ? "Retry credential access" : "Create Agent";
  };
  function showSavedStatus() {
    savedStatus.replaceChildren(
      ...[
        [
          savedSecret ? `Secret saved: ${savedSecret.id}.` : "",
          savedConfiguration ? `Configuration saved: ${savedConfiguration.id}.` : "",
          savedAgent ? `Agent saved: ${savedAgent.id}.` : "",
          "Retries reuse these resources. Saved provider and Configuration settings are fixed.",
        ]
          .filter(Boolean)
          .join(" "),
        savedAgent
          ? link(" Open saved Agent", `agents/${savedAgent.id}?revision=draft`, context)
          : null,
      ].filter(Boolean),
    );
  }
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
      for (const executionMode of installation.capabilities?.agentProvisioning?.executionModes ??
        []) {
        provisionableExecutionModes.add(executionMode);
      }
      capabilityDiscoveryDone = true;
      capabilityStatus.textContent = provisionableExecutionModes.has("dedicated")
        ? "Dedicated Agents are provisioned and deployed when created."
        : "This installation creates draft Agents for later deployment.";
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      capabilityDiscoveryFailed = true;
      capabilityStatus.textContent = `Installation capabilities unavailable. ${message(error)} Retry before creating an Agent.`;
    } finally {
      if (context.isCurrent()) {
        updateControls();
      }
    }
  }
  void loadInstallationCapabilities();
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
    if (
      pending ||
      outcomeUnknown ||
      provisioningAttempt ||
      (!savedAgent && repositoryRetryLocked()) ||
      !capabilityDiscoveryDone ||
      !form.reportValidity()
    ) {
      return;
    }
    const values = parseObject(configuration, true);
    const desiredPlugins = parseObject(plugins, true);
    const bindings = parseObject(secretBindings, true);
    if (values === undefined || desiredPlugins === undefined || bindings === undefined) {
      return;
    }
    if (!savedAgent && !repositories.validate({ required: requiresRepositories() })) {
      return;
    }
    if (!model.value.trim()) {
      feedback.textContent =
        "Choose an available model or enter a model ID before creating the Agent.";
      return;
    }
    const selected = values.agents?.defaults?.model;
    const primaryModel = typeof selected === "string" ? selected : selected?.primary;
    const fallbackPrefixes =
      mode.value === "dedicated" ? ["openai/", "codex/"] : [`${nativeProvider.value}/`];
    // Bound credentials must keep their provider; dedicated Presets support both native prefixes.
    const primaryPrefixes = hasBoundModelCredential
      ? fallbackPrefixes
      : [mode.value === "dedicated" ? "codex/" : `${nativeProvider.value}/`];
    if (
      (!binding || hasBoundModelCredential) &&
      !primaryPrefixes.some((prefix) => primaryModel === `${prefix}${model.value.trim()}`)
    ) {
      feedback.textContent =
        "Configuration must use the selected provider and model. Update the JSON or reset the template before saving.";
      return;
    }
    if (
      (!binding || hasBoundModelCredential) &&
      Array.isArray(selected?.fallbacks) &&
      selected.fallbacks.some(
        (ref) =>
          typeof ref !== "string" ||
          !fallbackPrefixes.some((value) => ref.startsWith(value) && ref.length > value.length),
      )
    ) {
      feedback.textContent =
        "Fallback models must use the selected provider and execution mode. Update the Configuration JSON or reset the template before saving.";
      return;
    }
    if (
      (binding?.method ?? authMethod.value) === "codex_pat" &&
      (nativeProvider.value !== "openai" || mode.value !== "dedicated")
    ) {
      feedback.textContent =
        "Service account tokens require OpenAI with Dedicated execution. Update the Configuration JSON or reset the template before saving.";
      return;
    }
    if (nativeProvider.value === "anthropic" && mode.value !== "embedded") {
      feedback.textContent =
        "Anthropic requires Embedded execution. Update the execution mode or choose OpenAI.";
      return;
    }
    if (mode.value === "embedded" && hasEnabledChannel(values)) {
      feedback.textContent =
        "Channels require Dedicated execution. Select OpenAI with the Codex harness or disable configured channels before creating the Agent.";
      return;
    }
    const repositoryBindings = repositories.bindings();
    const body = {
      name: name.value.trim(),
      executionMode: mode.value,
      initialWorkspaceFiles: Object.fromEntries(
        workspaceInputs.map(([filename, input]) => [filename, input.value]),
      ),
      workspaceDefaultsId: WORKSPACE_DEFAULTS_ID,
      ...(repositoryBindings.length ? { repositoryBindings } : {}),
      ...(Object.keys(desiredPlugins).length ? { plugins: desiredPlugins } : {}),
      ...(agent.providerId ? { providerId: agent.providerId } : {}),
    };
    pending = true;
    updateControls();
    feedback.textContent = "";
    let mutationStarted = false;
    try {
      if (!binding && !savedSecret) {
        mutationStarted = true;
        savedSecret = await request(`${namespacePath(namespaceId)}/secrets`, {
          method: "POST",
          body: { name: body.name, value: apiKey.value },
        });
        apiKey.value = "";
        apiKey.required = false;
        if (!context.isCurrent()) {
          return;
        }
        showSavedStatus();
      }
      body.harnessAuth = binding ?? { method: authMethod.value, source: savedSecret.ref };
      if (shouldProvision()) {
        provisioningAttempt = {
          acknowledged: false,
          body: {
            requestId: provisioningRequestId,
            ...body,
            configuration: {
              kind: "agent",
              values,
              ...(Object.keys(bindings).length ? { secretBindings: bindings } : {}),
            },
          },
        };
        await submitProvisioningAttempt(provisioningAttempt);
        return;
      }
      if (!savedConfiguration) {
        mutationStarted = true;
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
        showSavedStatus();
        renderChannelEditor();
      }
      if (!savedAgent) {
        mutationStarted = true;
        savedAgent = await request(`${namespacePath(namespaceId)}/agents`, {
          method: "POST",
          body: { ...body, configurationId: savedConfiguration.id },
        });
        if (!context.isCurrent()) {
          return;
        }
        showSavedStatus();
      }
      // Grant retries reread exact bindings, so uncertain model or channel grants never recreate the Agent.
      mutationStarted = false;
      if (savedSecret) {
        await ensureSecretOperateBinding(context, savedAgent, savedSecret);
      }
      await grantConfigurationSecretAccess(savedAgent, stagedChannelSecrets);
      if (context.isCurrent()) {
        context.navigate(`agents/${savedAgent.id}?revision=draft`);
      }
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      const detail = savedAgent
        ? `The Agent was created, but credential access is not confirmed. ${message(error)} Retry credential access, or open the saved Agent and ask an administrator to check access to its saved model and channel Secrets.`
        : error.status === 409 && savedConfiguration
          ? "Agent creation conflicts with the saved state. Check the Agent name and selections, then try again."
          : message(error, mutationStarted);
      outcomeUnknown = mutationStarted && ![400, 403, 404, 409, 429].includes(error.status);
      const knownRejection = [400, 403, 404, 409, 429].includes(error.status);
      if (!savedAgent && savedConfiguration && knownRejection) {
        if (repositoryBindings.length) {
          requireRepositoryReload();
        } else {
          rejectedAgentAttempt = { kind: "ordinary" };
        }
        if (rejectedAgentAttempt.kind === "repository-scoped") {
          recoveryMessage.textContent = `Repository-scoped Agent creation returned a known rejection. Configuration ${savedConfiguration.id} remains saved. Reload current repository choices to refresh policy before retrying, or start a new draft. Starting a new draft does not delete this Configuration.`;
          recovery.hidden = false;
        } else {
          recovery.hidden = true;
        }
      } else if (outcomeUnknown) {
        rejectedAgentAttempt = undefined;
        recovery.hidden = true;
      }
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
      "Create an Agent in this Namespace. Supported Dedicated runtimes provision and deploy automatically; Embedded and unsupported runtimes save a draft for later deployment.",
    ),
    form,
    channelEditor,
    savedStatus,
    feedback,
    recovery,
    actions,
  );
}
