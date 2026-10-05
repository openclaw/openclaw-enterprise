import defaultCodexPreset from "../default-codex-preset.mjs";
import { element, button } from "../dom.mjs";
import { WORKSPACE_DEFAULTS, WORKSPACE_DEFAULTS_ID } from "../workspace-defaults.mjs";
import { configuredHarnessId, harnessAuthDescription } from "./harness-auth.mjs";
import { createDeviceLogin } from "./device-login.mjs";
import { createRepositoryFields } from "./repositories.mjs";
import { ensureSecretOperateBinding } from "./secret-access.mjs";
import { createSecretReferenceField } from "./secret-picker.mjs";
import { createPresetFields } from "./presets.mjs";
import { createPluginDiscovery } from "./plugin-discovery.mjs";
import { createSlackApproverField } from "./slack-approvers.mjs";
import { renderChannels } from "../channels.mjs";
import { link, message, namespacePath, rejectionMessage } from "./list.mjs";

// The API's duplicate-name sentence. Other Agent conflicts reach the client as generic text,
// so only this one is shown as sent.
const AGENT_NAME_CONFLICT =
  "An Agent with this name already exists in this Namespace. Choose a different name.";
// The API's text for a conflict whose reason it does not name.
const GENERIC_CONFLICT = "The requested platform resource already exists.";
// The API's Agent name limit, in characters (code points).
const AGENT_NAME_MAX_CHARACTERS = 200;

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
      models: [
        {
          id: providerModel,
          name: providerModel,
          ...(harnessId === "openclaw" && nativeProvider === "openai"
            ? {
                contextWindow: 128000,
                maxTokens: 8192,
                reasoning: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              }
            : {}),
        },
      ],
    },
  };

  const { plugins, ...base } = structuredClone(defaultCodexPreset.template.configuration.values);
  return {
    ...base,
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
    // Codex model transport must use its authenticated app server, never direct HTTP.
    ...(harnessId === "codex" ? { plugins } : {}),
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
      return "Provisioning finished. Opening Agent details…";
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

// Failed provisioning codes that a retry of the same job cannot fix: the worker rejected
// the request (a taken name, a scope or authorization rejection, a Namespace or Agent
// lifecycle change) or the job was cancelled. Every other code, including the worker's
// PROVISIONING_FAILED and PROVISIONING_WORK_NOT_FOUND, keeps Retry.
const PERMANENT_PROVISIONING_CODES = new Set(["PROVISIONING_REJECTED", "PROVISIONING_CANCELLED"]);

function canRetryFailedProvisioning(job) {
  // A rejection after the job created its Agent (stopped, no versions) still owns that name;
  // only the job's retry can finish it.
  return (
    !PERMANENT_PROVISIONING_CODES.has(job.error?.code) ||
    (job.error?.code === "PROVISIONING_REJECTED" && typeof job.agentId === "string")
  );
}

async function waitForProvisioning({ request, status, first }) {
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
    error.provisioningFailed = current?.status === "failed";
    error.canRetryProvisioning = error.provisioningFailed && canRetryFailedProvisioning(current);
    error.provisioningUrl = current?.url ?? jobUrl;
    throw error;
  }
  if (typeof current.agentId !== "string" || !current.agentId) {
    throw new Error("Provisioning status did not include an Agent.");
  }
  if (typeof current.revisionId !== "string" || !current.revisionId) {
    throw new Error("Provisioning status did not include an AgentRevision.");
  }
  return { agentId: current.agentId, revisionId: current.revisionId };
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
    first: provisioned,
  });
}

export function renderCreateAgent(context, draft) {
  context.setTitle("Create Agent");
  if (draft) {
    renderAgentForm(context, draft.rendered, draft.presetOptions, draft);
    return;
  }
  context.setDiscardOnExit(false);
  context.setDraftCapture(null);
  const presets = createPresetFields(context, (rendered, options, draft) =>
    renderAgentForm(context, rendered, options, draft),
  );
  context.view.replaceChildren(
    link("← Agents", "agents", context),
    element(
      "section",
      { className: "launch-intro agent-card" },
      element("h2", {}, "Your next teammate"),
      element(
        "p",
        { className: "muted" },
        "Choose a model, connect repositories, and give your Agent a place to work.",
      ),
      element(
        "div",
        { className: "launch-actions" },
        presets.startDefault,
        button("Start without Preset", () =>
          renderAgentForm(context, {}, {}, { discardOnExit: true }),
        ),
      ),
    ),
    element(
      "section",
      { className: "agent-card launch-preset" },
      element("h2", {}, "Use a saved setup"),
      element(
        "p",
        { className: "muted" },
        "Start from a Preset to reuse your team's configuration.",
      ),
      presets.section,
    ),
  );
}

function renderAgentForm(context, rendered, presetOptions = {}, draft = {}) {
  const { view, request, namespaceId } = context;
  const agent = rendered.agent ?? {};
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const workspaceFileNames = Object.keys(WORKSPACE_DEFAULTS);
  const initialWorkspaceFiles = isObject(agent.initialWorkspaceFiles)
    ? agent.initialWorkspaceFiles
    : {};
  const hasRenderableWorkspaceFiles =
    agent.initialWorkspaceFiles === undefined ||
    (isObject(agent.initialWorkspaceFiles) &&
      Object.keys(agent.initialWorkspaceFiles).every((filename) =>
        workspaceFileNames.includes(filename),
      ));
  if (
    (agent.name !== undefined && typeof agent.name !== "string") ||
    (agent.executionMode !== undefined &&
      !["embedded", "dedicated"].includes(agent.executionMode)) ||
    (agent.backendId != null && typeof agent.backendId !== "string") ||
    (agent.plugins !== undefined && !isObject(agent.plugins)) ||
    (agent.pluginApprovers !== undefined &&
      (!Array.isArray(agent.pluginApprovers) ||
        !agent.pluginApprovers.every(
          (entry) =>
            isObject(entry) && typeof entry.channel === "string" && typeof entry.id === "string",
        ))) ||
    !hasRenderableWorkspaceFiles ||
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
  const presetModelSecret = presetOptions.modelSecret;
  const presetExistingSecret =
    presetModelSecret?.kind === "existing" ? presetModelSecret.secret : undefined;
  const authDefault =
    !passwordAuth &&
    isObject(agent.harnessAuth) &&
    Object.keys(agent.harnessAuth).length === 1 &&
    ["api_key", "codex_pat"].includes(agent.harnessAuth.method)
      ? agent.harnessAuth.method
      : undefined;
  const binding = passwordAuth || authDefault ? undefined : agent.harnessAuth;
  const hasBoundModelCredential = ["api_key", "codex_pat"].includes(binding?.method);
  if (
    presetExistingSecret &&
    (presetExistingSecret.namespaceId !== namespaceId ||
      presetExistingSecret.ref?.kind !== "secret" ||
      presetExistingSecret.ref.namespaceId !== namespaceId ||
      presetExistingSecret.ref.id !== presetExistingSecret.id ||
      binding?.source?.kind !== "secret" ||
      binding.source.namespaceId !== namespaceId ||
      binding.source.id !== presetExistingSecret.id)
  ) {
    throw new Error("Rendered Preset selected a Secret outside this Namespace.");
  }
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
  // No maxlength: it counts UTF-16 code units, so an emoji would count twice. The API
  // counts characters (code points), and so does this check.
  const name = element("input", {
    id: "agent-name",
    name: "name",
    required: "",
    autocomplete: "off",
  });
  const checkNameLength = () =>
    name.setCustomValidity(
      Array.from(name.value.trim()).length > AGENT_NAME_MAX_CHARACTERS
        ? `Use at most ${AGENT_NAME_MAX_CHARACTERS} characters.`
        : "",
    );
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
  const nativeHarnessWarning = element(
    "p",
    { className: "notice", role: "status", hidden: true },
    "Experimental: Dedicated OpenClaw requires a runtime build with native worker-inference support. Released OpenClaw images may not include it yet.",
  );
  // Admission refuses dedicated OpenClaw unless the Installation reports native worker support.
  const nativeWorkersUnavailable = element(
    "p",
    { className: "error", role: "alert", hidden: true },
    "Dedicated OpenClaw is unavailable: this installation's OpenClaw runtime lacks native worker support. Choose Embedded execution or the Codex harness.",
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
    required: Boolean(passwordAuth),
    autocomplete: "off",
    spellcheck: "false",
  });
  const authMethod = element(
    "select",
    { id: "agent-auth-method" },
    element("option", { value: "api_key" }, "OpenAI API key"),
    element("option", { value: "codex_pat" }, "Service Accounts"),
    element("option", { value: "oauth" }, "ChatGPT OAuth (Experimental)"),
  );
  authMethod.value = passwordAuth?.method ?? authDefault ?? binding?.method ?? "api_key";
  if (passwordAuth) {
    apiKey.value = passwordAuth.secret;
    delete passwordAuth.secret;
    // The retained template must not turn a cleared password into an invalid saved binding.
    delete agent.harnessAuth;
  }
  let modelCredentialSource = draft.modelCredentialSource;
  let modelCredentialSecret = draft.modelCredentialSecret;
  const authMethodField = field("Authentication method", authMethod);
  const credentialLabel = element("label", { for: apiKey.id }, "API key");
  const credentialHelp = element("p", { className: "hint", id: "provider-credential-help" });
  apiKey.setAttribute("aria-describedby", credentialHelp.id);
  let manualModel = !useModelChoices;
  let pendingModelSettings = draft.pendingModelSettings;
  let pendingProviderModel = draft.pendingProviderModel;
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
  const modelCredentialPicker = createSecretReferenceField({
    context,
    id: "provider-credential-secret",
    label: "Model credential Secret",
    getCurrentSource: () => modelCredentialSource,
    onSecretSelected(secret) {
      modelCredentialSource = secret.ref;
      modelCredentialSecret = secret;
      resetPluginDiscovery();
      feedback.textContent = "";
      updateControls();
    },
    createSecretName: () => {
      const agentName = name.value.trim();
      return `${agentName || "Agent"} model credential`;
    },
    createDialogTitle: "Create model credential Secret",
    metadataLabel: "View model credential Secret metadata",
    noSecretLabel: "Choose a model credential Secret",
    stagedHint: "Secret selected. Create Agent binds it.",
    required: !binding && !passwordAuth,
    disabled: Boolean(binding || passwordAuth),
  });
  const modelCredentialField = modelCredentialPicker.field;
  const oauthLogin = createDeviceLogin({
    context,
    initial: draft.oauthLogin,
    hint: "Sign in for this dedicated Codex Agent. You can browse plugins before deployment. Deployment transfers the login to the Agent; later plugin edits use a separate login.",
    onChange(source) {
      if (authMethod.value === "oauth") {
        modelCredentialSource = source;
        modelCredentialSecret = source;
        resetPluginDiscovery();
        updateControls();
      }
    },
  });
  const transientCredentialField = element(
    "div",
    { className: "form-field" },
    credentialLabel,
    apiKey,
    credentialHelp,
    element(
      "p",
      { className: "hint" },
      passwordAuth
        ? "Stored as a Secret for this Agent. Credentials are never included in Configuration JSON."
        : "If no Secret is selected, enter a service account token to preview plugins. Agent creation uses the selected Secret; its value stays on the server.",
    ),
  );
  const pluginDiscoveryTokenDetails = element(
    "details",
    { id: "plugin-discovery-token", className: "form-field" },
    element("summary", {}, "Plugin discovery token (optional)"),
    transientCredentialField,
  );
  const authSection = element(
    "fieldset",
    { className: "harness-auth-fields" },
    element("legend", {}, "Model provider"),
    field("Provider", nativeProvider),
    field("Harness", harness),
    harnessHint,
    nativeHarnessWarning,
    nativeWorkersUnavailable,
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
      : null,
    ...(!binding
      ? [
          modelCredentialField,
          oauthLogin.section,
          passwordAuth ? transientCredentialField : pluginDiscoveryTokenDetails,
        ]
      : []),
    modelSection,
  );
  name.value = agent.name ?? "";
  mode.value = agent.executionMode ?? "dedicated";
  // Partial Presets keep the form default until they select a model Harness.
  harness.value =
    configuredHarnessId(rendered.configuration?.values) ??
    (mode.value === "dedicated" ? "codex" : "openclaw");
  if (["codex_pat", "oauth"].includes(authMethod.value)) {
    nativeProvider.value = "openai";
    harness.value = "codex";
    mode.value = "dedicated";
  } else if (nativeProvider.value === "anthropic" || binding?.method === "runtime") {
    harness.value = "openclaw";
    mode.value = "embedded";
  }
  if (harness.value === "codex") {
    mode.value = "dedicated";
  }
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
  let edited = draft.edited ?? false;
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
      const providerId = harness.value === "codex" ? "codex" : nativeProvider.value;
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
  function clearModelCredential() {
    apiKey.value = "";
    modelCredentialSource = null;
    modelCredentialSecret = undefined;
    modelCredentialPicker.refresh();
  }
  nativeProvider.addEventListener("change", () => {
    // Operator-managed Presets retain the embedded harness required by their fixed binding.
    harness.value =
      nativeProvider.value === "anthropic" || binding?.method === "runtime" ? "openclaw" : "codex";
    mode.value = harness.value === "codex" ? "dedicated" : "embedded";
    // A provider change must not send the previous provider's key to a different service.
    clearModelCredential();
    if (!binding) {
      authMethod.value = "api_key";
      resetModelChoices(true);
    } else {
      updateModelConfiguration(true);
    }
  });
  authMethod.addEventListener("change", () => {
    clearModelCredential();
    resetModelChoices();
  });
  model.addEventListener("change", () => updateModelConfiguration());
  harness.addEventListener("change", () => {
    // Embedded is OpenClaw's default because dedicated OpenClaw needs a provisioning
    // Sandbox Driver; operators opt into it through Execution mode.
    mode.value = harness.value === "codex" ? "dedicated" : "embedded";
    // Service account tokens cannot authenticate OpenClaw; require a new API key.
    if (
      !binding &&
      harness.value === "openclaw" &&
      ["codex_pat", "oauth"].includes(authMethod.value)
    ) {
      authMethod.value = "api_key";
      clearModelCredential();
      resetModelChoices(true);
    } else {
      updateModelConfiguration(true);
    }
    updateControls();
  });
  mode.addEventListener("change", () => {
    const previousHarness = harness.value;
    if (mode.value === "embedded") {
      harness.value = "openclaw";
    }
    // Topology alone does not change the model policy or provider transport.
    if (harness.value !== previousHarness) {
      updateModelConfiguration(true);
    } else {
      renderChannelEditor();
    }
    updateControls();
  });
  configuration.addEventListener("input", () => {
    const previousProvider = nativeProvider.value;
    const previousHarness = harness.value;
    configuration.setCustomValidity("");
    feedback.textContent = "";
    const values = parseObject(configuration);
    const selected = values?.agents?.defaults?.model;
    const ref = typeof selected === "string" ? selected : selected?.primary;
    const selectedHarness = values && configuredHarnessId(values);
    if (typeof ref === "string" && selectedHarness) {
      harness.value = selectedHarness;
      if (selectedHarness === "codex") {
        mode.value = "dedicated";
      }
    }
    if (typeof ref === "string" && /^(openai|anthropic|codex)\//.test(ref)) {
      if (!savedSecret && !hasBoundModelCredential) {
        const selectedProvider = ref.startsWith("anthropic/") ? "anthropic" : "openai";
        if (
          !binding &&
          (selectedProvider !== nativeProvider.value ||
            (harness.value === "openclaw" && authMethod.value === "codex_pat"))
        ) {
          authMethod.value = "api_key";
          clearModelCredential();
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
    if (previousProvider !== nativeProvider.value || previousHarness !== harness.value) {
      resetPluginDiscovery();
    }
    renderChannelEditor();
  });

  const plugins = element("textarea", { id: "agent-plugins", rows: "4", spellcheck: "false" });
  plugins.value = JSON.stringify(agent.plugins ?? {}, null, 2);
  let pluginDiscoveryCredential = null;
  // Codex serves curated plugins only to ChatGPT logins; API-key Agents get them disabled.
  const apiKeyCodex = () =>
    harness.value === "codex" && (binding?.method ?? authMethod.value) === "api_key";
  function discoveryCredential() {
    if (apiKeyCodex()) {
      return null;
    }
    if (harness.value === "codex" && pluginDiscoveryCredential === "none") {
      return {};
    }
    if (
      nativeProvider.value !== "openai" ||
      harness.value !== "codex" ||
      !["codex_pat", "oauth"].includes(binding?.method ?? authMethod.value)
    ) {
      return null;
    }
    const secretRef = binding?.source ?? modelCredentialSource;
    if (secretRef?.kind === "secret") {
      return (binding?.method ?? authMethod.value) === "oauth"
        ? { oauthLogin: secretRef }
        : { secretRef };
    }
    return apiKey.value.trim() ? { accessToken: apiKey.value } : null;
  }
  let configurationSecretBindings = structuredClone(
    draft.configurationSecretBindings ?? rendered.configuration?.secretBindings ?? {},
  );
  const getSlackBotSecretId = () => {
    const source = configurationSecretBindings.SLACK_BOT_TOKEN?.source;
    return source?.kind === "secret" && source.namespaceId === namespaceId ? source.id : null;
  };
  const pluginDiscovery = createPluginDiscovery({
    context,
    input: plugins,
    canDiscover: () => Boolean(discoveryCredential()),
    canPrefetch: () =>
      pluginDiscoveryCredential !== null &&
      ["codex_pat", "oauth"].includes(binding?.method ?? authMethod.value) &&
      Boolean(binding?.source ?? modelCredentialSource ?? apiKey.value.trim()),
    isPending: () => pending,
    requestBody: (body) => ({ ...discoveryCredential(), ...body }),
    unavailableMessage: () =>
      apiKeyCodex()
        ? "Codex plugins need a ChatGPT login. With an OpenAI API key, each selected plugin is disabled when the Agent deploys (PLUGIN_AUTH_REQUIRED). Choose Service Accounts or ChatGPT OAuth to browse and use plugins."
        : pluginDiscoveryCredential === "none"
          ? "Choose the Codex harness to browse this Installation's curated plugin catalog."
          : "For discovery, choose ChatGPT OAuth (Experimental) and sign in, or choose Service Accounts with the Codex harness and select a Secret or enter a preview token.",
    availableMessage: () =>
      pluginDiscoveryCredential === "none"
        ? "Load the installation's curated plugin catalog. Access and tool availability are checked separately."
        : "Load plugins available to the selected credential. Your plugin selections stay unchanged.",
    createApproverField: (options) =>
      createSlackApproverField({
        context,
        getSecretId: getSlackBotSecretId,
        ...options,
      }),
  });
  const pluginFields = pluginDiscovery.fields;
  const updatePluginDiscovery = pluginDiscovery.update;
  const resetPluginDiscovery = pluginDiscovery.reset;
  apiKey.addEventListener("input", resetPluginDiscovery);
  for (const control of [nativeProvider, authMethod, harness]) {
    control.addEventListener("change", resetPluginDiscovery);
  }
  let pluginApprovers = structuredClone(
    Object.hasOwn(draft, "pluginApprovers") ? draft.pluginApprovers : agent.pluginApprovers,
  );
  const defaultApprovers = createSlackApproverField({
    context,
    label: "Default plugin approvers",
    getSecretId: getSlackBotSecretId,
    getValue: () => pluginApprovers,
    onChange: (value) => {
      pluginApprovers = value;
      edited = true;
    },
    inheritedLabel: "Existing OpenClaw approval routing (no Agent default set)",
    lazyNames: true,
  });
  defaultApprovers.hidden = true;
  pluginFields.section.insertBefore(
    defaultApprovers,
    pluginFields.section.querySelector(".plugin-json"),
  );
  const workspaceInputs = Object.entries(WORKSPACE_DEFAULTS).map(([filename, content]) => {
    const input = element("textarea", {
      id: `workspace-${filename.replace(".", "-")}`,
      rows: "8",
      spellcheck: "false",
    });
    input.value = initialWorkspaceFiles[filename] ?? content;
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
  let nativeWorkersAvailable = false;
  let provisioningRequestId = createClientRequestId();
  // The API admitted (or may have admitted) a job under provisioningRequestId. Create Agent
  // must then resend the same plan: the API answers an edited one with 409 "different plan".
  let requestAdmitted = false;
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
  let stagedChannelSecrets = draft.stagedChannelSecrets ?? [];
  const feedback = element("p", { className: "error", role: "alert" });
  const savedStatus = element("p", { className: "hint", role: "status" });
  const submit = element(
    "button",
    { type: "submit", form: formId, className: "primary" },
    "Create Agent",
  );
  const startOver = button("Start over", () => {
    if (window.confirm("Discard this draft and start again?")) {
      context.drafts.forget("channels");
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
      context.drafts.forget("channels");
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
  // The collapsed Runtime details still name the selected execution mode.
  const runtimeModeSummary = element("span", { className: "muted" });
  let repositories;
  const form = element(
    "form",
    { id: formId, className: "agent-form agent-card" },
    field("Agent name", name, "Unique within this Namespace."),
    authSection,
    capabilityStatus,
    retryCapabilityDiscovery,
    element(
      "details",
      { className: "launch-runtime" },
      element("summary", {}, "Runtime details", runtimeModeSummary),
      field(
        "Execution mode",
        mode,
        "Codex uses Dedicated execution. OpenClaw supports Dedicated or Embedded execution. Slack requires Dedicated execution.",
      ),
    ),
    (repositories = createRepositoryFields(
      context,
      (changed) => {
        if (changed) {
          edited = true;
        }
        feedback.textContent = "";
        updateControls();
      },
      { ...agent, ...(draft.repositoryAccess ? { repositoryAccess: draft.repositoryAccess } : {}) },
    )).section,
    pluginFields.section,
    element(
      "details",
      { className: "launch-advanced" },
      element("summary", {}, "Advanced settings"),
      element(
        "p",
        { className: "hint" },
        "Defaults are ready to use. Customize configuration or initial workspace files when needed.",
      ),
      field(
        "Configuration JSON",
        configuration,
        "Provider and model selections update this JSON. Supported Dedicated runtimes provision and deploy from this form. Embedded and unsupported runtimes save a draft for later deployment. Slack token Secrets can be selected or created from the channel editor.",
      ),
      reset,
      workspaceSection,
    ),
  );
  form.addEventListener(
    "invalid",
    (event) => {
      const details = event.target.closest("details");
      if (details) {
        details.open = true;
      }
    },
    true,
  );
  form.addEventListener("input", (event) => {
    edited = true;
    event.target.setCustomValidity?.("");
    if (event.target === name) {
      checkNameLength();
    }
  });
  form.addEventListener("change", () => {
    edited = true;
  });
  const draftInputs = {
    name,
    mode,
    harness,
    nativeProvider,
    authMethod,
    model,
    modelChoice,
    configuration,
    plugins,
    ...Object.fromEntries(workspaceInputs),
  };
  if (draft.inputs && useModelChoices) {
    modelChoice.replaceChildren(
      element("option", { value: "" }, "Choose a model"),
      ...MODEL_CHOICES[draft.inputs.nativeProvider].map((id) =>
        element("option", { value: id }, id),
      ),
    );
  }
  for (const [key, input] of Object.entries(draftInputs)) {
    if (Object.hasOwn(draft.inputs ?? {}, key)) {
      input.value = draft.inputs[key];
    }
  }
  manualModel = draft.manualModel ?? manualModel;
  const captureDraft = () => ({
    discardOnExit: Boolean(draft.discardOnExit),
    rendered,
    presetOptions,
    // Keep raw editor text, including invalid JSON. Password controls are deliberately excluded.
    inputs: Object.fromEntries(
      Object.entries(draftInputs).map(([key, input]) => [key, input.value]),
    ),
    manualModel,
    pluginApprovers,
    edited,
    pendingModelSettings,
    pendingProviderModel,
    configurationSecretBindings,
    stagedChannelSecrets,
    modelCredentialSource,
    modelCredentialSecret,
    oauthLogin: oauthLogin.capture(),
    repositoryAccess: repositories.access(),
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
        const details = input.closest("details");
        if (details) {
          details.open = true;
        }
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
    const channels = renderChannels({
      values,
      executionMode: mode.value,
      readOnly: Boolean(savedConfiguration),
      drawerContext: {
        drafts: context.drafts,
        baseline: JSON.stringify([values, configurationSecretBindings]),
        namespaceId,
        request,
        agentName: () => name.value,
        creating: true,
        secretBindings: configurationSecretBindings,
        isCurrent: context.isCurrent,
        onExpired: context.onExpired,
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
        context.drafts.forget("channels");
        edited = true;
        configuration.value = JSON.stringify(updatedValues, null, 2);
        if (options.secretBindings !== undefined) {
          configurationSecretBindings = structuredClone(options.secretBindings);
          stagedChannelSecrets = [...stagedChannelSecrets, ...(options.changedSecrets ?? [])];
          defaultApprovers.refreshValue();
          pluginDiscovery.update();
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
            "Channels require Dedicated execution. Select Dedicated under Runtime details or disable configured channels before creating the Agent.",
          )
        : null;
    channelEditor.replaceChildren(...[channels, modeWarning].filter(Boolean));
    updateControls();
  }
  const shouldProvision = () =>
    mode.value === "dedicated" && provisionableExecutionModes.has(mode.value);
  const updateControls = () => {
    const saved = Boolean(savedConfiguration || savedAgent || provisioningAttempt);
    const planLocked =
      pending ||
      Boolean(savedAgent) ||
      Boolean(provisioningAttempt) ||
      outcomeUnknown ||
      requestAdmitted;
    for (const node of form.querySelectorAll("button, input, select, textarea")) {
      if (repositories?.section.contains(node)) {
        continue;
      }
      node.disabled = planLocked;
    }
    // Unsaved Agent fields remain editable after a known rejection; reuse the saved Configuration.
    for (const node of [
      configuration,
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
    updatePluginDiscovery();
    pluginFields.setDisabled(planLocked);
    channelEditor.toggleAttribute("inert", planLocked || saved);
    channelEditor.setAttribute("aria-busy", pending ? "true" : "false");
    const usesPat = (binding?.method ?? authMethod.value) === "codex_pat";
    const usesOAuth = (binding?.method ?? authMethod.value) === "oauth";
    if (usesOAuth && !binding) {
      modelCredentialSource = oauthLogin.source;
      modelCredentialSecret = oauthLogin.source;
    }
    oauthLogin.setActive(usesOAuth && !binding);
    oauthLogin.setDisabled(planLocked || saved);
    mode.disabled ||=
      harness.value === "codex" ||
      nativeProvider.value === "anthropic" ||
      binding?.method === "runtime";
    harness.disabled ||=
      binding?.method === "runtime" || (usesPat && Boolean(binding || savedSecret));
    const nativeRefused =
      capabilityDiscoveryDone && !nativeWorkersAvailable && harness.value === "openclaw";
    mode.querySelector('[value="dedicated"]').disabled = nativeRefused;
    nativeWorkersUnavailable.hidden = !nativeRefused || mode.value !== "dedicated";
    runtimeModeSummary.textContent = ` · ${mode.value === "dedicated" ? "Dedicated" : "Embedded"}`;
    const modeHint = form.querySelector("#execution-mode-hint");
    if (modeHint) {
      modeHint.textContent = nativeRefused
        ? "Codex uses Dedicated execution. Dedicated OpenClaw is unavailable because this installation's OpenClaw runtime lacks native worker support, so OpenClaw uses Embedded execution. Slack requires Codex."
        : "Codex uses Dedicated execution. OpenClaw supports Dedicated or Embedded execution. Slack requires Dedicated execution.";
    }
    if (capabilityDiscoveryDone) {
      const nextStatus = shouldProvision()
        ? "Dedicated Agents are provisioned and deployed when created."
        : mode.value === "embedded"
          ? "Embedded Agents are saved as drafts. Deploy them from the Agent page after creation."
          : "This installation creates draft Agents for later deployment.";
      if (capabilityStatus.textContent !== nextStatus) {
        capabilityStatus.textContent = nextStatus;
      }
    }
    nativeHarnessWarning.hidden =
      harness.value !== "openclaw" || mode.value !== "dedicated" || nativeRefused;
    const codexOption = harness.querySelector('[value="codex"]');
    codexOption.hidden = nativeProvider.value === "anthropic";
    codexOption.disabled = nativeProvider.value === "anthropic";
    harnessHint.textContent =
      harness.disabled && usesPat
        ? "This saved service account token requires Codex. Create a new draft without a Preset to use OpenClaw with an API key."
        : nativeRefused
          ? "OpenClaw is available for both providers. This installation runs OpenClaw with Embedded execution only; choose Codex for Dedicated execution."
          : "OpenClaw is available for both providers. With OpenAI it supports Dedicated or Embedded execution; Anthropic uses Embedded OpenClaw.";
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
    const oauthOption = authMethod.querySelector('[value="oauth"]');
    oauthOption.hidden = harness.value !== "codex";
    oauthOption.disabled = harness.value !== "codex";
    credentialLabel.textContent = passwordAuth
      ? usesPat
        ? "Service account token"
        : "API key"
      : "Token for plugin discovery";
    modelCredentialField.hidden = Boolean(binding || passwordAuth || usesOAuth);
    transientCredentialField.hidden = usesOAuth;
    pluginDiscoveryTokenDetails.hidden = Boolean(
      binding || passwordAuth || !usesPat || pluginDiscoveryCredential === "none",
    );
    if (pluginDiscoveryTokenDetails.hidden) {
      pluginDiscoveryTokenDetails.open = false;
    }
    modelCredentialField.querySelector("label").textContent = usesPat
      ? "Service account token Secret"
      : "API key Secret";
    modelCredentialPicker.setRequired(!binding && !passwordAuth && !usesOAuth);
    modelCredentialPicker.setDisabled(
      planLocked || Boolean(binding || passwordAuth || usesOAuth || savedConfiguration),
    );
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
    apiKey.required = Boolean(passwordAuth && !usesOAuth);
    apiKey.disabled ||= Boolean(savedSecret || binding || usesOAuth || (!passwordAuth && !usesPat));
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
    repositories.setDisabled(planLocked || repositoryRetryLocked());
    submit.disabled =
      (!savedAgent &&
        (repositoryRetryLocked() ||
          (requiresRepositories() && !repositories.hasValidSelection()) ||
          !repositories.isSettled() ||
          repositories.blocksCreate())) ||
      pending ||
      outcomeUnknown ||
      !capabilityDiscoveryDone ||
      !nativeWorkersUnavailable.hidden ||
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
      pluginDiscoveryCredential =
        installation.capabilities?.pluginDiscovery?.credential ?? "required";
      pluginFields.setCapabilities(installation.capabilities?.pluginPolicies ?? null);
      defaultApprovers.hidden =
        installation.capabilities?.pluginPolicies?.approvers?.agent !== true;
      if (!defaultApprovers.hidden) {
        defaultApprovers.refreshNames();
      }
      nativeWorkersAvailable = installation.capabilities?.nativeWorkers !== undefined;
      provisionableExecutionModes.clear();
      for (const executionMode of installation.capabilities?.agentProvisioning?.executionModes ??
        []) {
        provisionableExecutionModes.add(executionMode);
      }
      capabilityDiscoveryDone = true;
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
    // A retry of a job known to have failed. Read before the request: an admitted first
    // attempt also gains a retry URL, and after an unknown outcome the job may have
    // succeeded (recovering), so a refusal there must keep the request ID to recover it.
    const viaRetry = attempt.retryUrl !== undefined;
    const retrying = viaRetry && !outcomeUnknown;
    const recovering = viaRetry && outcomeUnknown;
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
      repositories.recordSuccessfulSave();
      context.navigate(`agents/${agentId}?revision=${revisionId}&tab=configuration`);
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
      // The API refuses to retry a job whose Namespace or Agent lifecycle changed, that was
      // cancelled or handed off, or whose Secret was deleted; that job can never finish. A
      // refusal that names its reason is shown as sent; a race in the store can still
      // answer with the generic conflict text, which keeps the fixed sentence.
      const retryRefused = retrying && error.status === 409;
      const retryRefusal =
        error.serverMessage !== undefined && error.serverMessage !== GENERIC_CONFLICT
          ? error.serverMessage
          : "The provisioning job can no longer be retried.";
      const detail =
        outcomeUnknown && attempt.acknowledged
          ? "Outcome unknown after provisioning admission. Retry resumes the accepted provisioning job, or retries it if it failed. If the API refuses because the job finished, select Create Agent to resend the same request ID."
          : outcomeUnknown
            ? "Outcome unknown. Retry resubmits the same request ID and saved references."
            : error.provisioningTerminal && error.canRetryProvisioning
              ? `${error.message} Retry uses the accepted provisioning job.`
              : error.provisioningFailed
                ? `${error.message} Select Create Agent to submit a new request.`
                : retryRefused
                  ? `${retryRefusal} Select Create Agent to submit a new request.`
                  : error.status === undefined && error.message
                    ? error.message
                    : recovering && error.status === 409
                      ? "The provisioning job can no longer be retried; it may have finished. Select Create Agent to resend the same request ID and open its result."
                      : rejectionMessage(error, mutationStarted);
      feedback.textContent = detail + (error.requestId ? ` Request ID: ${error.requestId}` : "");
      // A 400 to an unacknowledged request means the API never admitted it: a resend of
      // an admitted request returns that job before validation.
      requestAdmitted =
        attempt.acknowledged || outcomeUnknown || (requestAdmitted && error.status !== 400);
      if (error.provisioningTerminal && error.canRetryProvisioning) {
        provisioningAttempt = {
          ...attempt,
          retryUrl: error.provisioningUrl ? `${error.provisioningUrl}/retry` : attempt.retryUrl,
        };
      } else if (!outcomeUnknown) {
        provisioningAttempt = null;
        if (error.provisioningFailed || retryRefused) {
          // The failed job keeps this request ID; an edited form needs a new one.
          provisioningRequestId = createClientRequestId();
          requestAdmitted = false;
        }
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
    // A restored draft sets the name without an input event.
    checkNameLength();
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
    const bindings = configurationSecretBindings;
    if (values === undefined || desiredPlugins === undefined) {
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
      harness.value === "codex" ? ["openai/", "codex/"] : [`${nativeProvider.value}/`];
    // Bound Codex Presets may use either supported provider prefix; OpenClaw keeps its provider.
    const primaryPrefixes = hasBoundModelCredential
      ? fallbackPrefixes
      : [harness.value === "codex" ? "codex/" : `${nativeProvider.value}/`];
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
      ["codex_pat", "oauth"].includes(binding?.method ?? authMethod.value) &&
      (nativeProvider.value !== "openai" || harness.value !== "codex" || mode.value !== "dedicated")
    ) {
      feedback.textContent =
        "Service account tokens and ChatGPT OAuth (Experimental) require OpenAI with the Codex harness and Dedicated execution. Update the Configuration JSON or reset the template before saving.";
      return;
    }
    if (nativeProvider.value === "anthropic" && mode.value !== "embedded") {
      feedback.textContent =
        "Anthropic requires Embedded execution. Update the execution mode or choose OpenAI.";
      return;
    }
    if (mode.value === "embedded" && hasEnabledChannel(values)) {
      feedback.textContent =
        "Channels require Dedicated execution. Select Dedicated under Runtime details or disable configured channels before creating the Agent.";
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
      repositoryAccess: repositories.access(),
      ...(Object.keys(desiredPlugins).length ? { plugins: desiredPlugins } : {}),
      ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
      ...(agent.backendId ? { backendId: agent.backendId } : {}),
    };
    const usesOAuth = (binding?.method ?? authMethod.value) === "oauth";
    if (!binding && (!passwordAuth || usesOAuth) && modelCredentialSource?.kind !== "secret") {
      feedback.textContent = usesOAuth
        ? "Complete ChatGPT sign-in before creating the Agent."
        : "Choose a model credential Secret before creating the Agent.";
      return;
    }
    context.setDraftCapture(null);
    pending = true;
    updateControls();
    feedback.textContent = "";
    let mutationStarted = false;
    let creatingSecret = false;
    try {
      if (passwordAuth && !usesOAuth && !savedSecret) {
        mutationStarted = true;
        creatingSecret = true;
        savedSecret = await request(`${namespacePath(namespaceId)}/secrets`, {
          method: "POST",
          body: { name: body.name, value: apiKey.value },
        });
        creatingSecret = false;
        apiKey.value = "";
        apiKey.required = false;
        if (!context.isCurrent()) {
          return;
        }
        showSavedStatus();
      }
      const selectedCredentialSource =
        passwordAuth && !usesOAuth ? savedSecret?.ref : modelCredentialSource;
      body.harnessAuth = binding ?? { method: authMethod.value, source: selectedCredentialSource };
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
        repositories.recordSuccessfulSave();
        if (!context.isCurrent()) {
          return;
        }
        showSavedStatus();
      }
      // Grant retries reread exact bindings, so uncertain model or channel grants never recreate the Agent.
      mutationStarted = false;
      const modelSecret =
        savedSecret ??
        modelCredentialSecret ??
        presetExistingSecret ??
        (hasBoundModelCredential ? binding.source : undefined);
      if (modelSecret) {
        await ensureSecretOperateBinding(context, savedAgent, modelSecret);
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
        : error.status === 409 && creatingSecret && error.code !== "NAMESPACE_NOT_READY"
          ? `A Secret named "${body.name}" already exists in this Namespace, possibly from an earlier Agent with this name. Choose another Agent name, delete that Secret, or select Start over, choose the Preset again, and set its Secret source to Use existing Secret.`
          : error.status === 409 && savedConfiguration && error.code !== "NAMESPACE_NOT_READY"
            ? error.serverMessage === AGENT_NAME_CONFLICT
              ? AGENT_NAME_CONFLICT
              : "Agent creation conflicts with the saved state. Check the Agent name and selections, then try again."
            : rejectionMessage(error, mutationStarted);
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
      "Choose a model and repository access. Add Slack when you want this Agent to work with your team.",
    ),
    form,
    channelEditor,
    savedStatus,
    feedback,
    recovery,
    actions,
  );
  context.setDraftCapture(captureDraft);
  context.drafts.forget("preset");
  context.setDiscardOnExit(Boolean(draft.discardOnExit));
}
