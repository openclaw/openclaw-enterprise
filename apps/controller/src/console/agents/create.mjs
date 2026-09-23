import { element, button } from "../dom.mjs";
import { WORKSPACE_DEFAULTS, WORKSPACE_DEFAULTS_ID } from "../workspace-defaults.mjs";
import { harnessAuthDescription } from "./harness-auth.mjs";
import { ensureSecretOperateBinding } from "./secret-access.mjs";
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

function configurationTemplate(mode, nativeProvider, providerModel) {
  const harnessId = mode === "dedicated" ? "codex" : "openclaw";
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
      controlUi: { enabled: false },
      auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
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
  const model = element("input", {
    id: "agent-model",
    required: true,
    autocomplete: "off",
    pattern: "[^\\/\\s]+",
  });
  model.value = initialModel?.split("/").slice(1).join("/") || defaultAgentModel;
  const apiKey = element("input", {
    id: "provider-api-key",
    type: "password",
    required: !binding,
    autocomplete: "off",
    spellcheck: "false",
  });
  const authSection = element(
    "fieldset",
    { className: "harness-auth-fields" },
    element("legend", {}, "Model provider"),
    field("Provider", nativeProvider),
    element(
      "p",
      {},
      binding
        ? `Preset authentication: ${harnessAuthDescription(binding)}`
        : "Authentication method: API key",
    ),
    binding
      ? element(
          "p",
          { className: "hint" },
          "This Preset's saved authentication source is preserved.",
        )
      : field(
          "API key",
          apiKey,
          "Stored as a Secret for this Agent. The key is never included in Configuration JSON.",
        ),
    field("Model", model, "Enter the model ID available to your API account."),
  );
  name.value = agent.name ?? "";
  mode.value = agent.executionMode ?? "dedicated";
  if (nativeProvider.value === "anthropic") {
    mode.value = "embedded";
  }
  const currentTemplate = () =>
    JSON.stringify(
      configurationTemplate(mode.value, nativeProvider.value, model.value.trim()),
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
    configuration.value = currentTemplate();
    configuration.setCustomValidity("");
    feedback.textContent = "";
    renderChannelEditor();
  });
  function updateModelConfiguration() {
    const values = parseObject(configuration);
    if (values === undefined) {
      return;
    }
    const next = configurationTemplate(mode.value, nativeProvider.value, model.value.trim());
    const previous = values.agents?.defaults?.model;
    const previousModel = typeof previous === "string" ? previous : previous?.primary;
    const modelSettings = { ...values.agents?.defaults?.models };
    const selectedSettings = {
      ...modelSettings[previousModel],
      ...next.agents.defaults.models[next.agents.defaults.model],
    };
    delete modelSettings[previousModel];
    values.agents = {
      ...values.agents,
      defaults: {
        ...values.agents?.defaults,
        model:
          typeof previous === "object" && previous !== null
            ? { ...previous, primary: next.agents.defaults.model }
            : next.agents.defaults.model,
        models: { ...modelSettings, [next.agents.defaults.model]: selectedSettings },
      },
    };
    const providers = { ...values.models?.providers };
    delete providers.openai;
    delete providers.anthropic;
    delete providers.codex;
    values.models = { ...values.models, providers: { ...providers, ...next.models.providers } };
    if (next.plugins) {
      values.plugins = {
        ...values.plugins,
        allow: [...new Set([...(values.plugins?.allow ?? []), ...next.plugins.allow])],
        entries: { ...values.plugins?.entries, ...next.plugins.entries },
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
    model.value = nativeProvider.value === "anthropic" ? "claude-sonnet-4-6" : defaultAgentModel;
    if (nativeProvider.value === "anthropic") {
      mode.value = "embedded";
    }
    updateModelConfiguration();
  });
  model.addEventListener("change", updateModelConfiguration);
  mode.addEventListener("change", updateModelConfiguration);
  configuration.addEventListener("input", () => {
    configuration.setCustomValidity("");
    feedback.textContent = "";
    const values = parseObject(configuration);
    const selected = values?.agents?.defaults?.model;
    const ref = typeof selected === "string" ? selected : selected?.primary;
    if (typeof ref === "string" && /^(openai|anthropic|codex)\//.test(ref)) {
      if (!savedSecret) {
        nativeProvider.value = ref.startsWith("anthropic/") ? "anthropic" : "openai";
      }
      model.value = ref.slice(ref.indexOf("/") + 1);
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
  let pending = false;
  let outcomeUnknown = false;
  let savedSecret;
  let savedConfiguration;
  let savedAgent;
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
  const actions = element(
    "div",
    { className: "form-actions" },
    button("Cancel", () => context.navigate("agents")),
    startOver,
    submit,
  );
  const channelEditor = element("div", { className: "create-channels" });
  const form = element(
    "form",
    { id: formId, className: "agent-form agent-card" },
    field("Agent name", name, "Unique within this Namespace."),
    authSection,
    field(
      "Execution mode",
      mode,
      "Anthropic uses Embedded execution. Slack requires Dedicated execution with OpenAI.",
    ),
    field(
      "Configuration JSON",
      configuration,
      "Provider and model selections update this JSON. After creation, use the Agent Credentials tab for transport and Slack credentials.",
    ),
    reset,
    field(
      "Secret bindings JSON",
      secretBindings,
      "Map environment names to existing Secret references in this Namespace. Do not enter credentials.",
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
          "Channel settings apply to this form’s Configuration JSON. After creation, use the Agent Credentials tab for Slack credentials.",
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
  const updateControls = () => {
    const saved = Boolean(savedConfiguration || savedAgent);
    for (const node of form.querySelectorAll("button, input, select, textarea")) {
      node.disabled = pending || Boolean(savedAgent) || outcomeUnknown;
    }
    // Unsaved Agent fields remain editable after a known rejection; reuse the saved Configuration.
    for (const node of [configuration, secretBindings, nativeProvider, model, mode, reset]) {
      node.disabled ||= Boolean(savedConfiguration);
    }
    for (const node of actions.querySelectorAll("button")) {
      node.disabled = pending;
    }
    channelEditor.toggleAttribute("inert", pending || saved || outcomeUnknown);
    channelEditor.setAttribute("aria-busy", pending ? "true" : "false");
    mode.disabled ||= nativeProvider.value === "anthropic";
    nativeProvider.disabled ||= Boolean(savedSecret);
    apiKey.disabled ||= Boolean(savedSecret);
    startOver.disabled = pending || outcomeUnknown || saved || Boolean(savedSecret);
    submit.disabled = pending || outcomeUnknown;
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
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || outcomeUnknown || !form.reportValidity()) {
      return;
    }
    const values = parseObject(configuration, true);
    const desiredPlugins = parseObject(plugins, true);
    const bindings = parseObject(secretBindings, true);
    if (values === undefined || desiredPlugins === undefined || bindings === undefined) {
      return;
    }
    const selected = values.agents?.defaults?.model;
    const primaryModel = typeof selected === "string" ? selected : selected?.primary;
    const prefix = mode.value === "dedicated" ? "codex" : nativeProvider.value;
    if (!binding && primaryModel !== `${prefix}/${model.value.trim()}`) {
      feedback.textContent =
        "Configuration must use the selected provider and model. Update the JSON or reset the template before saving.";
      return;
    }
    const fallbackPrefixes =
      mode.value === "dedicated" ? ["openai/", "codex/"] : [`${nativeProvider.value}/`];
    if (
      (!binding || binding.method === "api_key") &&
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
    if (nativeProvider.value === "anthropic" && mode.value !== "embedded") {
      feedback.textContent =
        "Anthropic requires Embedded execution. Update the execution mode or choose OpenAI.";
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
      body.harnessAuth = binding ?? { method: "api_key", source: savedSecret.ref };
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
      if (savedSecret) {
        // Grant retries first reread exact bindings, so an uncertain grant never recreates the Agent.
        mutationStarted = false;
        await ensureSecretOperateBinding(context, savedAgent, savedSecret);
      }
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
        ? `The Agent was created, but credential access is not confirmed. ${message(error)} Retry credential access, or open the saved Agent and ask an administrator to grant it access to Secret ${savedSecret.id}.`
        : error.status === 409 && savedConfiguration
          ? "Agent creation conflicts with the saved state. Check the Agent name and selections, then try again."
          : message(error, mutationStarted);
      outcomeUnknown = mutationStarted && ![400, 403, 404, 409, 429].includes(error.status);
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
      "Save a Configuration and an Agent in this Namespace. Creation does not deploy it or create an AgentRevision.",
    ),
    form,
    channelEditor,
    savedStatus,
    feedback,
    actions,
  );
}
