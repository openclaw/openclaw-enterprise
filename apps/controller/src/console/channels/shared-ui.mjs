import { element, button } from "../dom.mjs";

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
export const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const uniqueList = (items) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];
const refText = (ref) =>
  isRecord(ref)
    ? `${ref.source ?? "unknown"} / ${ref.provider ?? "unknown"} / ${ref.id ?? "unknown"}`
    : "env / default";
export const refsEqual = (left, right) =>
  isRecord(left) &&
  left.source === right.source &&
  left.provider === right.provider &&
  left.id === right.id;

export function field(label, control, hint) {
  return element(
    "div",
    { className: "channel-field" },
    element("label", { for: control.id }, label),
    control,
    hint ? element("p", { className: "hint", id: `${control.id}-hint` }, hint) : null,
  );
}

export function refField(label, ref) {
  return element(
    "div",
    { className: "channel-field" },
    element("span", { className: "channel-label" }, label),
    element("code", {}, refText(ref)),
  );
}

export function checkbox(id, label, checked, disabled = false) {
  return element(
    "label",
    { className: "channel-check" },
    element("input", {
      id,
      type: "checkbox",
      ...(checked ? { checked: "" } : {}),
      ...(disabled ? { disabled: "" } : {}),
    }),
    label,
  );
}

function nativeDocument(label, value) {
  return element(
    "details",
    { className: "native-document channel-native" },
    element("summary", {}, label),
    element("pre", { tabindex: "0" }, JSON.stringify(value ?? null, null, 2)),
  );
}

function channelRoot(values) {
  return isRecord(values?.channels) ? values.channels : {};
}

export function providerConfig(values, provider) {
  const config = channelRoot(values)[provider];
  return config === undefined ? undefined : config;
}

function statusOf(config) {
  if (config === undefined) {
    return { label: "Not configured", enabled: false };
  }
  if (isRecord(config) && config.enabled === false) {
    return { label: "Disabled", enabled: false };
  }
  return { label: "Configured (enabled)", enabled: true };
}

function pluginBlockReason(values, provider) {
  const plugins = values?.plugins;
  if (plugins === undefined) {
    return null;
  }
  if (!isRecord(plugins)) {
    return "Plugin configuration is not an object.";
  }
  if (plugins.enabled === false) {
    return "Native plugins are disabled. Enable them through the Configuration API before configuring channels.";
  }
  for (const key of ["deny"]) {
    const list = plugins[key];
    if (Array.isArray(list) && list.includes(provider.plugin)) {
      return `${provider.name} is explicitly blocked in native plugin configuration.`;
    }
  }
  if (plugins.allow !== undefined && !Array.isArray(plugins.allow)) {
    return "Plugin allow configuration is not an array.";
  }
  if (plugins.entries !== undefined && !isRecord(plugins.entries)) {
    return "Plugin entries configuration is not an object.";
  }
  const entry = plugins.entries?.[provider.plugin];
  if (entry !== undefined && !isRecord(entry)) {
    return `${provider.name} plugin entry is not an object.`;
  }
  return null;
}

export function arrayOfStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function withProvider(values, provider, config) {
  const next = clone(values) ?? {};
  const channels = isRecord(next.channels) ? { ...next.channels } : {};
  channels[provider] = config;
  next.channels = channels;
  return next;
}

function withPlugin(values, provider) {
  const next = clone(values) ?? {};
  if (providerConfig(next, provider.id)?.enabled === false) {
    return next;
  }
  const plugin = provider.plugin;
  const plugins = isRecord(next.plugins) ? { ...next.plugins } : {};
  const entries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
  const entry = isRecord(entries[plugin]) ? { ...entries[plugin] } : {};
  // An omitted allowlist must stay omitted; introducing one can exclude another Harness plugin.
  if (Array.isArray(plugins.allow)) {
    plugins.allow = [...new Set([...plugins.allow, plugin])];
  }
  entries[plugin] = { ...entry, enabled: true };
  plugins.entries = entries;
  next.plugins = plugins;
  return next;
}

function errorText(error) {
  return error?.message + (error?.requestId ? ` Request ID: ${error.requestId}` : "");
}

function renderCard(section, state, provider) {
  const status = statusOf(providerConfig(state.values, provider.id));
  const support = provider.support(state.values);
  const blockReason = pluginBlockReason(state.values, provider);
  const disabledByMode = state.executionMode === "embedded" && !status.enabled;
  const canOpen =
    !state.readOnly &&
    !state.outcomeUnknown &&
    !disabledByMode &&
    !blockReason &&
    support.supported;
  const canDisable =
    !state.readOnly &&
    !state.outcomeUnknown &&
    status.enabled &&
    isRecord(providerConfig(state.values, provider.id));
  const action =
    status.label === "Not configured" ? `Configure ${provider.name}` : `Edit ${provider.name}`;
  const actionAttrs = canOpen ? {} : { disabled: "" };
  const card = element(
    "section",
    { className: "agent-card channel-card" },
    element(
      "div",
      { className: "channel-card-row" },
      element(
        "div",
        {},
        element("h2", {}, provider.name, element("span", { className: "badge" }, status.label)),
        element(
          "p",
          {},
          support.supported ? provider.summary(support.config, status) : provider.description,
        ),
        element("p", { className: "hint" }, provider.setup),
      ),
      element(
        "div",
        { className: "channel-actions" },
        state.readOnly
          ? null
          : button(action, () => openDrawer(section, state, provider), actionAttrs),
        canDisable
          ? button(`Disable ${provider.name}`, () => void disableProvider(state, provider), {
              className: "danger",
            })
          : null,
      ),
    ),
  );
  if (state.readOnly) {
    card.append(
      element(
        "p",
        { className: "hint" },
        state.copy.readOnlyCardMessage ?? "Read-only AgentRevision values cannot be edited.",
      ),
    );
  } else if (disabledByMode) {
    card.append(
      element(
        "p",
        { className: "error" },
        "Channels require Dedicated execution. Embedded Agents can only keep channels disabled.",
      ),
    );
  } else if (blockReason) {
    card.append(element("p", { className: "error" }, blockReason));
  } else if (!support.supported) {
    card.append(
      element("p", { className: "error" }, support.reason),
      nativeDocument(`${provider.name} native configuration`, support.config),
    );
  }
  return card;
}

async function disableProvider(state, provider) {
  state.error.replaceChildren();
  const current = providerConfig(state.values, provider.id);
  if (!isRecord(current)) {
    return;
  }
  const config = { ...current, enabled: false };
  await save(state, withProvider(state.values, provider.id, config));
}

async function save(state, values, dialog, targetError) {
  if (state.pending || state.outcomeUnknown) {
    return;
  }
  state.pending = true;
  const controlsRoot = dialog ?? state.section;
  const errorNode = targetError ?? state.error;
  errorNode.replaceChildren();
  if (!dialog) {
    state.error.replaceChildren();
  }
  for (const node of controlsRoot.querySelectorAll("button, input, select")) {
    node.disabled = true;
  }
  let succeeded = false;
  try {
    await state.onSave(values);
    succeeded = true;
    dialog?.close();
    dialog?.remove();
  } catch (error) {
    state.outcomeUnknown = Boolean(error.outcomeUnknown);
    (state.outcomeUnknown ? state.error : errorNode).replaceChildren(
      element("p", { className: "error", role: "alert" }, errorText(error)),
    );
    if (state.outcomeUnknown) {
      dialog?.close();
      dialog?.remove();
    }
  } finally {
    state.pending = false;
    if (succeeded || !dialog || state.outcomeUnknown) {
      state.rerender();
    } else {
      for (const node of controlsRoot.querySelectorAll("button, input, select")) {
        node.disabled = false;
      }
    }
  }
}

export function input(id, value, attrs = {}) {
  return element("input", { id, value: value ?? "", autocomplete: "off", ...attrs });
}

function openDrawer(section, state, provider) {
  if (state.pending || state.outcomeUnknown) {
    return;
  }
  const support = provider.support(state.values);
  if (!support.supported || pluginBlockReason(state.values, provider)) {
    return;
  }
  section.querySelector("dialog")?.remove();
  const dialog = element("dialog", {
    className: "channel-dialog",
    "aria-label": `${statusOf(providerConfig(state.values, provider.id)).label === "Not configured" ? "Configure" : "Edit"} ${provider.name}`,
  });
  const config = isRecord(support.config) ? support.config : {};
  const enabled = checkbox(
    `${provider.id}-enabled`,
    `Enable ${provider.name}`,
    config.enabled !== false,
  );
  const body = element("form", { method: "dialog", className: "channel-drawer-form" });
  const feedback = element("div", { "aria-live": "polite" });
  const cancel = button("Cancel", () => {
    dialog.close();
    dialog.remove();
  });
  const submit = element(
    "button",
    { type: "submit", className: "primary" },
    state.copy.saveLabel ?? "Save configuration",
  );
  body.append(
    element(
      "div",
      { className: "channel-drawer-head" },
      element(
        "h2",
        {},
        `${statusOf(providerConfig(state.values, provider.id)).label === "Not configured" ? "Configure" : "Edit"} ${provider.name}`,
      ),
      button("Close", () => {
        dialog.close();
        dialog.remove();
      }),
    ),
    element(
      "p",
      { className: "notice", role: "status" },
      state.copy.drawerNotice ??
        "New revision. Changes affect future deployments using this Configuration. Use the Credentials tab for supported OpenAI and Slack credentials before first deploy.",
    ),
    enabled,
  );
  provider.appendFields(body, config);
  body.append(
    element(
      "p",
      { className: "muted" },
      state.copy.drawerFootnote ?? "This Configuration may be shared by other Agents.",
    ),
    feedback,
    element("div", { className: "form-actions" }, cancel, submit),
  );
  body.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.pending) {
      return;
    }
    if (
      state.executionMode === "embedded" &&
      body.querySelector(`#${provider.id}-enabled`).checked
    ) {
      feedback.replaceChildren(
        element(
          "p",
          { className: "error", role: "alert" },
          "Channels require Dedicated execution.",
        ),
      );
      return;
    }
    const validationError = provider.validate?.(body);
    if (validationError) {
      feedback.replaceChildren(
        element("p", { className: "error", role: "alert" }, validationError),
      );
      return;
    }
    const nextValues = provider.updatedValues(state.values, body);
    void save(state, withPlugin(nextValues, provider), dialog, feedback);
  });
  dialog.addEventListener("cancel", (event) => {
    if (state.pending) {
      event.preventDefault();
    }
  });
  dialog.append(body);
  section.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
  dialog.querySelector("input, button")?.focus();
}

export function renderChannelSection(
  { values, executionMode, readOnly, onSave, copy = {} },
  providers,
) {
  const section = element("section", { className: "channels-section" });
  const state = {
    values,
    executionMode,
    readOnly,
    onSave,
    section,
    copy,
    pending: false,
    outcomeUnknown: false,
    error: element("div", { "aria-live": "polite" }),
    rerender: () => render(),
  };
  function render() {
    section.replaceChildren(
      element(
        "div",
        { className: "channel-heading" },
        element(
          "div",
          {},
          element("h2", {}, "Channels"),
          element(
            "p",
            { className: "muted" },
            readOnly
              ? (copy.readOnlyDescription ??
                  "These are the viewed AgentRevision’s immutable channel settings.")
              : (copy.editableDescription ??
                  "Save and Disable update only the shared Configuration draft. They do not stop or disable a running Agent or change admitted revisions."),
          ),
        ),
      ),
      state.error,
      ...providers.map((provider) => renderCard(section, state, provider)),
    );
  }
  render();
  return section;
}
