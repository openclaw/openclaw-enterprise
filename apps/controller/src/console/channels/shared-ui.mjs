import { element, button, dismissOnBackdrop, focusSaveOutcome } from "../dom.mjs";
import { renderSecretReference } from "../agents/secret-picker.mjs";
import { carryList, carryValue } from "../carry.mjs";

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
export const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const uniqueList = (items) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];
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
    !state.reloadRequired &&
    !disabledByMode &&
    !blockReason &&
    support.supported;
  const canDisable =
    !state.readOnly &&
    !state.outcomeUnknown &&
    !state.reloadRequired &&
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
  const credentials = element("dl", { className: "configuration-summary" });
  for (const binding of provider.secretBindings ?? []) {
    credentials.append(
      element("dt", {}, `${binding.label} (${binding.key})`),
      element(
        "dd",
        {},
        renderSecretReference(
          state.drawerContext,
          state.drawerContext.secretBindings?.[binding.key]?.source,
        ),
      ),
    );
  }
  card.append(credentials);
  if (state.readOnly) {
    card.append(
      element(
        "p",
        { className: "hint" },
        state.copy.readOnlyCardMessage ?? "Values in a deployed version cannot be edited.",
      ),
    );
  } else if (disabledByMode) {
    card.append(
      // Informational: Embedded Agents simply do not offer channels; nothing is wrong yet.
      element(
        "p",
        { className: "hint" },
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
  await save(state, withProvider(state.values, provider.id, config), null, null, null, provider);
}

// The plain fields the reader changed from what the editor first showed (Secret and directory
// search boxes are not among them), and the Secrets they chose. A value the editor changed by
// itself, such as the DM user list a DM policy change clears, is not the reader's edit
// (finding 1509).
function draftChanges(draft) {
  const fields = Object.keys(draft?.initial ?? {}).filter((id) => {
    const field = draft.fields?.[id];
    const initial = draft.initial[id];
    return (
      field &&
      (draft.edited?.includes(id) ?? true) &&
      (field.value !== initial.value || field.checked !== initial.checked)
    );
  });
  // A Secret picked and then picked back is no change; carrying it would replace another
  // browser's binding with the old one.
  const secrets = Object.keys(draft?.changedSecrets ?? {}).filter(
    (key) =>
      !refsEqual(
        draft.secretBindings?.[key]?.source,
        draft.initialSecretBindings?.[key]?.source ?? {},
      ),
  );
  return { fields: Object.fromEntries(fields.map((id) => [id, draft.fields[id]])), secrets };
}

// A save conflict keeps the editor's changes: Reload draft reopens them over the reread
// settings instead of dropping them with the closed editor (finding 1504).
function carryDraft(state, dialog, provider) {
  const draft = dialog ? state.captureDraft?.() : undefined;
  const changes = draftChanges(draft);
  state.carriedDraft = null;
  if (
    draft?.provider !== provider?.id ||
    (!Object.keys(changes.fields).length && !changes.secrets.length)
  ) {
    state.drawerContext.drafts?.forget("channels");
    return;
  }
  const carried = { ...draft, carried: true, unresolved: false };
  state.carriedDraft = carried;
  state.drawerContext.drafts?.track("channels", () => carried);
}

function carriedNotice(draft, provider) {
  if (!draft) {
    return "";
  }
  const names = draftChanges(draft)
    .secrets.map((key) => draft.changedSecrets[key]?.name)
    .filter((name) => typeof name === "string" && name.length);
  const secrets = names.length
    ? `, including the ${names.length === 1 ? "Secret" : "Secrets"} ${names.map((name) => `“${name}”`).join(" and ")}`
    : "";
  return ` Reload draft reopens your ${provider.name} edits over the saved settings${secrets}.`;
}

async function save(state, values, dialog, targetError, secretBindingUpdate, provider) {
  if (state.pending || state.outcomeUnknown || state.reloadRequired) {
    return;
  }
  state.pending = true;
  // A later save's result replaces the previous save's notice.
  state.savedNotice = "";
  state.onStateChange({ pending: true, outcomeUnknown: false });
  const controlsRoot = dialog ?? state.section;
  const errorNode = targetError ?? state.error;
  errorNode.replaceChildren();
  if (!dialog) {
    state.error.replaceChildren();
  }
  const controls = [...controlsRoot.querySelectorAll("button, input, select")].map((node) => ({
    node,
    disabled: node.disabled,
  }));
  for (const { node } of controls) {
    node.disabled = true;
  }
  let succeeded = false;
  try {
    await state.onSave(values, secretBindingUpdate ?? {});
    succeeded = true;
    if (state.section.isConnected) {
      state.drawerContext.drafts?.forget("channels");
    }
    dialog?.close();
    dialog?.remove();
  } catch (error) {
    state.outcomeUnknown = Boolean(error.outcomeUnknown);
    // Another save moved the Configuration: every later save from this page fails the same
    // way, so the section offers Reload draft instead of the editor (finding 1480).
    state.reloadRequired = !state.outcomeUnknown && Boolean(error.reloadRequired && state.onReload);
    const sectionError = state.outcomeUnknown || state.reloadRequired;
    if (sectionError) {
      if (state.reloadRequired) {
        carryDraft(state, dialog, provider);
      }
      dialog?.close();
      dialog?.remove();
    }
    (sectionError ? state.error : errorNode).replaceChildren(
      element(
        "p",
        { className: "error", role: "alert" },
        errorText(error) +
          (state.reloadRequired ? carriedNotice(state.carriedDraft, provider) : ""),
      ),
    );
  } finally {
    state.pending = false;
    state.onStateChange({
      pending: false,
      outcomeUnknown: state.outcomeUnknown,
      reloadRequired: state.reloadRequired,
    });
    if (succeeded && state.onSaved) {
      // The owner rebuilds the section from the saved state and focuses this provider's
      // action; until then the section shows the state before the save, so keep it disabled.
      for (const node of state.section.querySelectorAll("button, input, select")) {
        node.disabled = true;
      }
      void state.onSaved(provider ? `Edit ${provider.name}` : null);
    } else if (succeeded || !dialog || state.outcomeUnknown || state.reloadRequired) {
      state.rerender();
      if (!succeeded) {
        focusSaveOutcome(
          state.section,
          [state.section.querySelector(".channel-reload")],
          state.error.firstElementChild,
        );
      }
    } else {
      for (const { node, disabled } of controls) {
        node.disabled = disabled;
      }
      // Disabling the pressed button while saving dropped focus out of the dialog (finding 1481).
      focusSaveOutcome(
        dialog,
        [dialog.querySelector('button[type="submit"]')],
        errorNode.firstElementChild,
      );
    }
  }
}

export function input(id, value, attrs = {}) {
  return element("input", { id, value: value ?? "", autocomplete: "off", ...attrs });
}

const listValues = (value) => uniqueList(value.split(","));
const sameSource = (left, right) =>
  left === undefined ? right === undefined : refsEqual(left, right ?? {});
const configurationOf = (baseline) => {
  try {
    return JSON.parse(baseline)?.[0];
  } catch {
    return undefined;
  }
};

// How a control's value reads in a notice: an option's label, on or off, or the text itself.
function shownValue(field, saved) {
  if (field.type === "checkbox") {
    return saved.checked ? "on" : "off";
  }
  const option = [...(field.options ?? [])].find((item) => item.value === saved.value);
  return `“${option?.textContent ?? saved.value}”`;
}

// Reapplies carried field edits over the reread settings the editor just rendered. Lists take
// the reader's added and removed entries; another value is reapplied, and when the other
// browser changed it too, the notice names the saved value as well (finding 1509).
function applyCarriedFields(provider, fields, carried, initial) {
  const applied = [];
  for (const field of fields) {
    const mine = carried.fields[field.id];
    const base = initial?.[field.id];
    if (!mine || !base) {
      continue;
    }
    const current = { value: field.value, checked: field.checked };
    const isList = provider.listFields?.includes(field.id);
    const list = isList
      ? carryList(listValues(base.value), listValues(mine.value), listValues(current.value))
      : null;
    if (
      isList
        ? list.value.join(",") === listValues(current.value).join(",")
        : current.value === mine.value && current.checked === mine.checked
    ) {
      continue;
    }
    if (field.disabled) {
      // The reloaded settings turn this field off (an Open DM policy, or Everyone in these
      // channels), so a save would ignore it: named as skipped, not applied.
      applied.push({ id: field.id, detail: "", skipped: true });
      continue;
    }
    let detail = "";
    if (isList) {
      field.value = list.value.join(", ");
      detail = [
        list.added.length ? `added ${list.added.join(", ")}` : "",
        list.removed.length ? `removed ${list.removed.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
    } else {
      if (carryValue(base, mine, current).conflict) {
        detail = `also changed in another browser, saved as ${shownValue(field, current)}`;
      }
      field.value = mine.value;
      field.checked = mine.checked;
    }
    field.dispatchEvent(new Event("input"));
    field.dispatchEvent(new Event("change"));
    applied.push({ id: field.id, detail });
  }
  return applied;
}

function openDrawer(section, state, provider, retained) {
  if (state.pending || state.outcomeUnknown || state.reloadRequired) {
    return false;
  }
  const support = provider.support(state.values);
  if (!support.supported || pluginBlockReason(state.values, provider)) {
    return false;
  }
  section.querySelector("dialog")?.remove();
  const dialog = element("dialog", {
    className: "channel-dialog",
    "aria-label": `${statusOf(providerConfig(state.values, provider.id)).label === "Not configured" ? "Configure" : "Edit"} ${provider.name}`,
  });
  const config = isRecord(support.config) ? support.config : {};
  const drawerContext = {
    ...state.drawerContext,
    isConfigured: providerConfig(state.values, provider.id) !== undefined,
    secretBindings:
      state.drawerContext.secretBindings === undefined
        ? undefined
        : structuredClone(state.drawerContext.secretBindings),
  };
  // A draft carried through a save conflict applies over the settings Reload draft rereads
  // (finding 1504). Reached any other way, it reopens like any retained draft.
  const carried = retained?.carried && retained.reloaded ? draftChanges(retained) : null;
  const stale = retained && !carried && retained.baseline !== state.drawerContext.baseline;
  const unresolved = retained?.unresolved;
  if (carried) {
    if (carried.secrets.length) {
      drawerContext.draftSecretBindings = {
        ...clone(state.drawerContext.secretBindings),
        ...Object.fromEntries(
          carried.secrets.map((key) => [key, clone(retained.secretBindings?.[key])]),
        ),
      };
      drawerContext.draftChangedSecrets = Object.fromEntries(
        carried.secrets.map((key) => [key, clone(retained.changedSecrets[key])]),
      );
    }
  } else if (retained) {
    drawerContext.draftSecretBindings = clone(retained.secretBindings);
    drawerContext.draftChangedSecrets = clone(retained.changedSecrets);
  }
  const enabled = checkbox(
    `${provider.id}-enabled`,
    `Enable ${provider.name}`,
    config.enabled !== false,
  );
  const body = element("form", { method: "dialog", className: "channel-drawer-form" });
  const carriedNote = carried
    ? element("p", { className: "hint", role: "status", id: `${provider.id}-carried-edits` })
    : null;
  const feedback = element("div", { "aria-live": "polite" });
  // An editor reopened by Reload draft has no opener left to return focus to.
  const keepFocus = () => {
    const active = globalThis.document.activeElement;
    if (!active || active === globalThis.document.body || !active.isConnected) {
      [...section.querySelectorAll(".channel-actions button")]
        .find((node) => node.textContent.endsWith(` ${provider.name}`) && !node.disabled)
        ?.focus();
    }
  };
  const discard = () => {
    state.drawerContext.drafts?.forget("channels");
    dialog.close();
    dialog.remove();
    keepFocus();
  };
  const cancel = button("Cancel", discard);
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
      button("Close", discard),
    ),
    element(
      "p",
      { className: "notice", role: "status" },
      state.copy.drawerNotice ??
        "New version. Changes affect future deployments using this Configuration. Configure model credentials in the Credentials tab before first deploy.",
    ),
    ...(carriedNote ? [carriedNote] : []),
    enabled,
  );
  provider.appendFields(body, config, drawerContext);
  // Only ordinary channel controls belong to this draft. New Secret dialogs own token bytes.
  const fields = [
    ...body.querySelectorAll("input[id]:not([type=password]), select[id], textarea[id]"),
  ];
  const fieldValues = (list) =>
    Object.fromEntries(
      list.map((field) => [field.id, { value: field.value, checked: field.checked }]),
    );
  // What the plain fields first showed, so a conflict carries only the reader's changes.
  const initial =
    retained && !carried
      ? retained.initial
      : fieldValues(fields.filter((field) => field.getAttribute("role") !== "combobox"));
  const initialSecretBindings =
    retained && !carried
      ? clone(retained.initialSecretBindings)
      : clone(state.drawerContext.secretBindings);
  // The fields the reader changed. The editor's own follow-on changes fire no input event, so
  // they stay out (finding 1509).
  const edited = new Set(retained && !carried ? (retained.edited ?? []) : []);
  let applied = [];
  if (carried) {
    applied = applyCarriedFields(provider, fields, carried, retained.initial);
    for (const { id, skipped } of applied) {
      if (!skipped) {
        edited.add(id);
      }
    }
  } else {
    for (const field of fields) {
      const saved = retained?.fields?.[field.id];
      if (saved) {
        field.value = saved.value;
        field.checked = saved.checked;
        field.dispatchEvent(new Event("input"));
        field.dispatchEvent(new Event("change"));
      }
    }
  }
  const markEdited = (event) => {
    if (fields.includes(event.target)) {
      edited.add(event.target.id);
    }
  };
  body.addEventListener("input", markEdited);
  body.addEventListener("change", markEdited);
  if (carriedNote) {
    // Name what was reapplied, so the reader can see what overrides the reread settings.
    const fieldName = ({ id, detail }) => {
      const field = fields.find((node) => node.id === id);
      // Directory-backed lists label their search box, not the hidden list input.
      const label =
        body.querySelector(`label[for="${id}"]`) ??
        body.querySelector(`label[for="${id}-search"]`) ??
        field?.closest("label");
      const name = label?.textContent.trim() || id;
      return detail ? `${name} (${detail})` : name;
    };
    const skipped = applied.filter((entry) => entry.skipped).map(fieldName);
    const names = [
      ...applied.filter((entry) => !entry.skipped).map(fieldName),
      ...carried.secrets.map((key) => {
        const label = provider.secretBindings?.find((binding) => binding.key === key)?.label ?? key;
        const saved = state.drawerContext.secretBindings?.[key]?.source;
        // Another browser bound a different Secret here too; the reader's choice is shown.
        return !sameSource(saved, retained.initialSecretBindings?.[key]?.source) &&
          !sameSource(saved, retained.secretBindings?.[key]?.source)
          ? `${label} (also changed in another browser)`
          : label;
      }),
    ];
    carriedNote.textContent =
      names.length || skipped.length
        ? [
            names.length
              ? `Your edits are applied over the reloaded settings: ${names.join(", ")}.`
              : "",
            skipped.length
              ? `Not applied, because the reloaded settings turn ${skipped.length === 1 ? "it" : "them"} off: ${skipped.join(", ")}.`
              : "",
            "Review them, then save.",
          ]
            .filter(Boolean)
            .join(" ")
        : "The reloaded settings already include your edits.";
    dialog.setAttribute("aria-describedby", carriedNote.id);
  }
  const captureDraft = () => ({
    provider: provider.id,
    baseline: (!carried && retained?.baseline) || state.drawerContext.baseline,
    initial,
    initialSecretBindings,
    edited: [...edited],
    fields: fieldValues(fields),
    secretBindings: clone(drawerContext.draftSecretBindings),
    changedSecrets: clone(drawerContext.draftChangedSecrets),
    unresolved: unresolved || state.pending || state.outcomeUnknown,
  });
  state.captureDraft = captureDraft;
  state.carriedDraft = null;
  state.drawerContext.drafts?.track("channels", captureDraft);
  if (stale || unresolved) {
    submit.disabled = true;
    feedback.append(
      element(
        "p",
        { className: "error", role: "alert" },
        unresolved
          ? "Outcome unknown. Cancel this editor and reload the page to inspect saved settings before saving again."
          : "The saved Configuration changed while you were editing. Cancel this editor to use current settings.",
      ),
    );
  }
  if (state.copy.drawerFootnote) {
    body.append(element("p", { className: "muted" }, state.copy.drawerFootnote));
  }
  body.append(feedback, element("div", { className: "form-actions" }, cancel, submit));
  body.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.pending || stale || unresolved) {
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
    const secretBindingUpdate = provider.updatedSecretBindings?.(drawerContext);
    void save(
      state,
      withPlugin(nextValues, provider),
      dialog,
      feedback,
      secretBindingUpdate,
      provider,
    );
  });
  dialog.addEventListener("cancel", (event) => {
    if (state.pending) {
      event.preventDefault();
    } else {
      state.drawerContext.drafts?.forget("channels");
    }
  });
  dialog.append(body);
  dismissOnBackdrop(dialog);
  section.append(dialog);
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      keepFocus();
    },
    { once: true },
  );
  dialog.showModal();
  dialog.querySelector("input, button")?.focus();
  return true;
}

export function renderChannelSection(
  {
    values,
    executionMode,
    readOnly,
    onSave,
    onStateChange = () => {},
    onReload,
    onSaved,
    savedNotice = "",
    copy = {},
    drawerContext = {},
  },
  providers,
) {
  const section = element("section", { className: "channels-section" });
  const state = {
    values,
    executionMode,
    readOnly,
    onSave,
    onStateChange,
    onReload,
    onSaved,
    savedNotice,
    section,
    copy,
    drawerContext,
    pending: false,
    outcomeUnknown: false,
    reloadRequired: false,
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
                  "These are the viewed version’s immutable channel settings.")
              : (copy.editableDescription ??
                  "Save and Disable update only the shared Configuration draft. They do not stop or disable a running Agent or change deployed versions."),
          ),
        ),
      ),
      ...(state.savedNotice
        ? [element("p", { className: "hint", role: "status" }, state.savedNotice)]
        : []),
      state.error,
      ...((state.outcomeUnknown || state.reloadRequired) && state.onReload
        ? [element("div", { className: "form-actions" }, reloadButton())]
        : []),
      ...providers.map((provider) => renderCard(section, state, provider)),
    );
  }
  function reloadButton() {
    const reload = button(
      "Reload draft",
      () => {
        reload.disabled = true;
        if (state.reloadRequired && state.carriedDraft) {
          // Only this reload applies the carried edits over the settings it rereads.
          state.carriedDraft.reloaded = true;
        } else {
          // Nothing carried: the reloaded section starts from the saved state.
          state.drawerContext.drafts?.forget("channels");
        }
        void state.onReload();
      },
      { className: "channel-reload" },
    );
    return reload;
  }
  render();
  const retained = drawerContext.drafts?.get("channels");
  if (retained && !readOnly) {
    queueMicrotask(() => {
      if (!section.isConnected) {
        return;
      }
      const provider = providers.find((item) => item.id === retained.provider);
      const carried = retained.carried && retained.reloaded;
      // Carried edits apply only to the Configuration they were made on: another browser may
      // have moved this Agent to one other Agents share (finding 1510).
      const moved =
        carried && configurationOf(retained.baseline) !== configurationOf(drawerContext.baseline);
      const opened = provider && !moved && openDrawer(section, state, provider, retained);
      if (carried && !opened) {
        // A declined carried draft would otherwise reopen on a later visit.
        drawerContext.drafts.forget("channels");
        state.error.replaceChildren(
          element(
            "p",
            { className: "hint", role: "status" },
            moved
              ? `Your ${provider?.name ?? "channel"} edits were not reapplied: this Agent now uses another Configuration.`
              : `Your ${provider?.name ?? "channel"} edits were not reapplied: the reloaded settings cannot be edited here.`,
          ),
        );
      }
    });
  }
  return section;
}
