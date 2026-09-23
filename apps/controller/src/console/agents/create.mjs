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
  const auth = createHarnessAuthFields(context, agent.harnessAuth ?? null);
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
  const providerStatus = element("p", { className: "hint", role: "status" }, "Loading Providers…");
  let providersLoaded = false;
  let pending = false;
  let outcomeUnknown = false;
  let savedConfiguration;
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
    field(
      "Execution mode",
      mode,
      "Slack requires Dedicated execution. Changing the mode keeps any edited JSON; use Reset template to start again.",
    ),
    field("Provider (optional)", provider),
    providerStatus,
    auth.section,
    field(
      "Configuration JSON",
      configuration,
      "Starter template applied. Edit the sample model and settings before saving. After creation, use the Agent Credentials tab for transport and Slack credentials.",
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
    configuration.readOnly = Boolean(savedConfiguration);
    secretBindings.readOnly = Boolean(savedConfiguration);
    submit.disabled = pending || outcomeUnknown;
  };
  renderChannelEditor();
  request("/providers")
    .then((items) => {
      if (!context.isCurrent()) {
        return;
      }
      const modelProviders = items.filter((item) => item.type === "chatgpt");
      provider.append(
        ...modelProviders
          .filter((item) => item.id !== providerId)
          .map((item) => element("option", { value: item.id }, `${item.id} · ${item.type}`)),
      );
      providersLoaded = true;
      providerStatus.textContent = modelProviders.length
        ? "Choose an installed Provider."
        : "No Providers configured.";
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
      }
    });
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
      mutationStarted = true;
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
      const detail =
        error.status === 409 && savedConfiguration
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
