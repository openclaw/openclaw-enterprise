import type {
  PluginApprovalMode,
  PluginApprovers,
  PluginCatalogEntry,
  PluginCatalogPage,
  PluginDesiredSelection,
  PluginPolicyCapabilities,
  PluginReviewer,
  PluginToolCatalogEntry,
  PluginToolPolicy,
} from "@openclaw-enterprise/contracts";
import { element, button, dismissOnBackdrop, setText } from "../dom.mjs";

export type CatalogDirection = "search" | "refresh" | "next" | "previous";
export type CatalogEntry = PluginCatalogEntry & {
  toolStatus?: "loading" | "loaded" | undefined;
  toolError?: string | undefined;
};

export type PluginFieldCatalog = (
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: readonly CatalogEntry[] }
) & {
  nextCursor?: string | null;
  setup?: PluginCatalogPage["setup"];
  entries?: readonly CatalogEntry[];
  knownEntries?: readonly CatalogEntry[];
  pageNumber?: number;
  hasPrevious?: boolean;
  canLoad?: boolean;
  message?: string;
};

export interface ApproverFieldOptions {
  label: string;
  getValue(): PluginApprovers | undefined;
  onChange(value: PluginApprovers | undefined): void;
  inheritedLabel: string;
  lazyNames?: boolean;
}

export interface PluginFieldsOptions {
  input: HTMLTextAreaElement;
  catalog?: PluginFieldCatalog | null;
  capabilities?: PluginPolicyCapabilities | null;
  onLoadPlugins?: ((direction: CatalogDirection, query: string) => void) | null;
  onCancelDiscovery?: (() => void) | null;
  onLoadTools?: ((id: string) => void) | null;
  saveHint?: string;
  createApproverField?: (options: ApproverFieldOptions) => HTMLElement & {
    refreshNames?(): void;
    pauseNames?(): void;
  };
}

// The editor changes a freshly parsed copy; API contracts remain read-only.
type Editable<T> = { -readonly [Key in keyof T]: T[Key] };
type EditableSelection = Editable<PluginDesiredSelection>;
type Selections = Record<string, EditableSelection>;
type PolicyScope = "tools" | "toolDefaults";
type WritePolicy = <Key extends keyof PluginToolPolicy>(
  key: Key,
  value: PluginToolPolicy[Key],
) => void;
type Choice<Value extends string = string> = readonly [
  value: Value,
  label: string,
  disabled?: boolean,
];

interface PluginTabState {
  activeId: string | null;
  query: string;
  toolQuery: string;
  expanded: Set<string>;
}

const approvalOptions = [
  ["provider_default", "Provider default"],
  ["all_actions", "Every action"],
  ["write_actions", "Write actions"],
  ["none", "No additional approval"],
] as const satisfies readonly Choice<PluginApprovalMode>[];
const reviewerOptions = [
  ["human", "Human"],
  ["auto", "Automatic review"],
] as const satisfies readonly Choice<PluginReviewer>[];
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validApprovers = (value: unknown): value is PluginApprovers =>
  Array.isArray(value) &&
  value.every(
    (entry) => isObject(entry) && typeof entry.channel === "string" && typeof entry.id === "string",
  );
function validToolPolicy(value: unknown, allowApprovers = false): value is PluginToolPolicy {
  return (
    isObject(value) &&
    (value.enabled === undefined || typeof value.enabled === "boolean") &&
    (value.approval === undefined || approvalOptions.some(([mode]) => mode === value.approval)) &&
    (value.reviewer === undefined || reviewerOptions.some(([mode]) => mode === value.reviewer)) &&
    (value.approvers === undefined || (allowApprovers && validApprovers(value.approvers)))
  );
}

function isEditableSelection(item: unknown): item is EditableSelection {
  return (
    isObject(item) &&
    typeof item.enabled === "boolean" &&
    (item.approvers === undefined || validApprovers(item.approvers)) &&
    (item.driverPolicy === undefined || isObject(item.driverPolicy)) &&
    (item.toolDefaults === undefined || validToolPolicy(item.toolDefaults)) &&
    (item.tools === undefined ||
      (isObject(item.tools) &&
        Object.values(item.tools).every((policy) => validToolPolicy(policy, true))))
  );
}

export function isPluginSelections(value: unknown): value is Selections {
  return isObject(value) && Object.values(value).every(isEditableSelection);
}

function pluginIdentity(entry: CatalogEntry, heading = false) {
  const logo = element(
    "span",
    { className: "plugin-logo", "aria-hidden": "true" },
    entry.name.slice(0, 1).toUpperCase(),
  );
  if (entry.logoUrl) {
    const image = element("img", {
      alt: "",
      referrerpolicy: "no-referrer",
      decoding: "async",
      loading: "lazy",
    });
    image.addEventListener("error", () => image.remove(), { once: true });
    image.src = entry.logoUrl;
    logo.append(image);
  }
  return element(
    heading ? "div" : "span",
    { className: "plugin-identity" },
    logo,
    heading ? element("h3", { tabindex: "-1" }, entry.name) : element("span", {}, entry.name),
  );
}

function catalogLink(label: string, url: string) {
  return element("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, label);
}

function unavailableMessage(entry: CatalogEntry) {
  return element(
    "p",
    { className: "hint plugin-unavailable" },
    entry.unavailableReason ?? "This plugin cannot be enabled by the selected Driver.",
    entry.unavailableHelp
      ? element(
          "span",
          {},
          " ",
          catalogLink(entry.unavailableHelp.label, entry.unavailableHelp.url),
        )
      : null,
  );
}

function setupContent(setup: NonNullable<PluginCatalogPage["setup"]>) {
  return [
    element("p", { className: "hint" }, setup.message),
    element(
      "div",
      { className: "plugin-external-links" },
      ...setup.links.map(({ label, url }) => catalogLink(label, url)),
    ),
  ];
}

export function createPluginFields({
  input,
  catalog = null,
  capabilities = null,
  onLoadPlugins = null,
  onCancelDiscovery = null,
  onLoadTools = null,
  saveHint = "Changes are saved when you create the Agent.",
  createApproverField,
}: PluginFieldsOptions) {
  let disabled = false;
  let configuredOnly = false;
  let capabilitiesUnread = false;
  const tabs = [newTabState(), newTabState()] as const;
  let renderedTab: PluginTabState | null = null;
  let renderedPlugin: string | null = null;

  function newTabState(): PluginTabState {
    return { activeId: null, query: "", toolQuery: "", expanded: new Set() };
  }

  function tabState() {
    return tabs[configuredOnly ? 1 : 0];
  }

  function clearDetails(state: PluginTabState) {
    state.activeId = null;
    state.toolQuery = "";
    state.expanded.clear();
  }

  function rememberExpandedTools() {
    if (renderedTab && renderedPlugin === renderedTab.activeId) {
      renderedTab.expanded = new Set(
        Array.from(
          detail.querySelectorAll<HTMLDetailsElement>("details[data-tool][open]"),
          (node) => node.dataset.tool,
        ).filter((id) => id !== undefined),
      );
    }
  }
  let waitingForCatalog = false;
  const search = element("input", {
    type: "search",
    id: "plugin-search",
    placeholder: "Search plugins",
    maxLength: 1024,
  });
  const searchLabel = element("label", { for: search.id }, "Search plugins");
  const status = element("p", { className: "hint", role: "status" });
  const feedback = element("p", { className: "status", "data-tone": "danger", role: "alert" });
  const policyStatus = element("p", { className: "hint", role: "status" });
  const summary = element("p", { className: "hint" });
  const list = element("div", { className: "plugin-list" });
  const detail = element("div", { className: "plugin-detail" });
  const loadPlugins = button("Load plugins", () => loadPage("refresh"), { size: "sm" });
  loadPlugins.hidden = !onLoadPlugins;
  const previous = button("Previous page", () => loadPage("previous"));
  const next = button("Next page", () => loadPage("next"));
  const pagination = element("div", { className: "plugin-pagination" }, previous, next);
  const available = button("Available plugins", () => showConfigured(false));
  const configured = button("Configured plugins", () => showConfigured(true));
  available.setAttribute("aria-label", "Available plugins");
  available.textContent = "Available";
  configured.setAttribute("aria-label", "Configured plugins");
  configured.textContent = "Configured";
  const browser = element(
    "div",
    { className: "plugin-browser" },
    element("div", { className: "plugin-tabs" }, available, configured),
    element("div", { className: "form-field" }, searchLabel, search),
    element("div", { className: "plugin-browser-status" }, status, loadPlugins),
    list,
    pagination,
  );
  const workspace = element("div", { className: "plugin-workspace" }, browser, detail);
  const dialog = element("dialog", {
    className: "dialog dialog--wide plugin-dialog",
    "aria-labelledby": "plugin-dialog-title",
  });
  dismissOnBackdrop(dialog);
  const configure = button("Configure plugins", () => {
    if (disabled) {
      return;
    }
    if (!catalog?.canLoad && Object.keys(selections() ?? {}).length) {
      showConfigured(true);
    }
    dialog.showModal();
    search.focus();
    if (catalog?.status === "idle" && catalog.canLoad) {
      loadPage("refresh");
    } else if (catalog?.status === "idle") {
      waitingForCatalog = true;
    }
  });
  const setupInstructions = element("div", { className: "plugin-access-instructions" });
  const accessHelp = element(
    "div",
    { className: "plugin-access-help" },
    element(
      "p",
      { className: "hint" },
      "Catalog availability does not verify app connections or grant access. Configure credentials and app access before deployment.",
    ),
    element(
      "details",
      { className: "plugin-access-details" },
      element("summary", {}, "Access and credential setup"),
      setupInstructions,
    ),
  );
  const setupReminder = element("details", { className: "plugin-setup-reminder" });
  dialog.append(
    element(
      "div",
      { className: "plugin-dialog-header" },
      element("h2", { id: "plugin-dialog-title" }, "Configure plugins"),
      button("Done", () => dialog.close()),
    ),
    element("p", { className: "hint" }, saveHint),
    accessHelp,
    policyStatus,
    feedback,
    workspace,
  );
  dialog.addEventListener("close", () => {
    waitingForCatalog = false;
    onCancelDiscovery?.();
    configure.focus();
  });
  // A search Enter must not submit a surrounding form.
  dialog.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      event.target instanceof HTMLInputElement &&
      event.target.type === "search"
    ) {
      event.preventDefault();
      if (event.target === search && !configuredOnly) {
        loadPage("refresh");
      }
    }
  });
  const json = element(
    "details",
    { className: "plugin-json" },
    element("summary", { id: `${input.id}-label` }, "Plugin selections JSON"),
    input,
  );
  input.setAttribute("aria-labelledby", `${input.id}-label`);
  const section = element(
    "section",
    { className: "plugin-fields", "aria-labelledby": "plugin-heading" },
    element("h2", { id: "plugin-heading" }, "Plugins"),
    summary,
    configure,
    setupReminder,
    json,
    dialog,
  );

  function loadPage(direction: CatalogDirection) {
    clearDetails(tabs[0]);
    onLoadPlugins?.(direction, tabs[0].query);
  }

  function showConfigured(value: boolean) {
    waitingForCatalog = false;
    rememberExpandedTools();
    configuredOnly = value;
    search.value = tabState().query;
    if (value) {
      onCancelDiscovery?.();
    }
    render();
  }

  function showPlugin(entry: CatalogEntry) {
    if (tabState().activeId !== entry.id) {
      clearDetails(tabState());
      tabState().activeId = entry.id;
    }
    render();
    detail.querySelector("h3")?.focus();
    if (
      entry.remoteId &&
      entry.tools === null &&
      entry.toolStatus !== "loaded" &&
      !entry.toolError &&
      catalog?.canLoad
    ) {
      onLoadTools?.(entry.id);
    }
  }

  function selections() {
    try {
      const value: unknown = JSON.parse(input.value);
      // Keep the original object, including Driver-specific and unrecognized fields.
      return isPluginSelections(value) ? value : null;
    } catch {
      return null;
    }
  }

  function update(change: (values: Selections) => void) {
    const values = selections();
    if (disabled || values === null) {
      return;
    }
    change(values);
    input.value = JSON.stringify(values, null, 2);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Look up the current selection on edit; discovery and the raw JSON editor can change it.
  function updateSelection(pluginId: string, change: (selection: EditableSelection) => void) {
    update((all) => {
      const selection = all[pluginId];
      if (selection) {
        change(selection);
      }
    });
  }

  function writeToolPolicy<Key extends keyof PluginToolPolicy>(
    pluginId: string,
    key: Key,
    value: PluginToolPolicy[Key],
    toolId?: string,
  ) {
    updateSelection(pluginId, (selection) => {
      const policy: Editable<PluginToolPolicy> = {
        ...(toolId === undefined ? selection.toolDefaults : selection.tools?.[toolId]),
      };
      if (value === undefined) {
        delete policy[key];
      } else {
        policy[key] = value;
      }
      const hasPolicy = Object.keys(policy).length > 0;
      if (toolId === undefined) {
        if (hasPolicy) {
          selection.toolDefaults = policy;
        } else {
          delete selection.toolDefaults;
        }
        return;
      }

      const tools = { ...selection.tools, [toolId]: policy };
      if (!hasPolicy) {
        delete tools[toolId];
      }
      if (Object.keys(tools).length) {
        selection.tools = tools;
      } else {
        delete selection.tools;
      }
    });
  }

  function select<Value extends string>(
    label: string,
    value: Value,
    options: readonly Choice<Value>[],
    onChange: (value: Value) => void,
    supported = true,
  ) {
    const control = element(
      "select",
      { "aria-label": label },
      ...options.map(([key, text, disabled = false]) =>
        element("option", { value: key, disabled }, disabled ? `${text} (unsupported)` : text),
      ),
    );
    if (!options.some(([key]) => key === value)) {
      control.append(element("option", { value, disabled: true }, `${value} (unsupported)`));
    }
    control.dataset.policyUnsupported = String(!supported);
    control.value = value;
    control.addEventListener("change", () => {
      const choice = options.find(([key]) => key === control.value);
      if (choice && !choice[2]) {
        onChange(choice[0]);
      }
    });
    return element("label", { className: "plugin-control" }, label, control);
  }

  function approvalSelect(
    name: string,
    value: PluginApprovalMode | undefined,
    scope: PolicyScope,
    onChange: (value: PluginApprovalMode | "") => void,
  ) {
    const modes = capabilities?.[scope].approval ?? [];
    const options = approvalOptions.map(
      ([mode, label]) => [mode, label, !modes.includes(mode)] as const,
    );
    const field = select(
      "Require approval for",
      value ?? "",
      [["", scope === "tools" ? "Inherit plugin policy" : "Inherit default policy"], ...options],
      onChange,
      modes.length > 0,
    );
    field.querySelector("select")?.setAttribute("aria-label", `${name} require approval for`);
    return field;
  }

  function approvalHint(value: PluginApprovalMode | undefined, scope: PolicyScope) {
    const modes = capabilities?.[scope].approval ?? [];
    const unsupported = approvalOptions
      .filter(([mode]) => !modes.includes(mode))
      .map(([, label]) => label);
    if (capabilities && unsupported.length) {
      return element(
        "p",
        { className: "hint" },
        `This plugin provider does not support: ${unsupported.join(", ")}.`,
      );
    }
    return value === "write_actions" && modes.includes(value)
      ? element(
          "p",
          { className: "hint" },
          "Write actions include creating, changing, or deleting data. Actions without read-only metadata also require approval.",
        )
      : null;
  }

  function toolPolicyFields(
    name: string,
    policy: PluginToolPolicy,
    scope: PolicyScope,
    reviewers: readonly Choice<PluginReviewer>[],
    writePolicy: WritePolicy,
  ) {
    const defaults = scope === "toolDefaults";
    const canSelectReviewer = reviewers.length > 0 || policy.reviewer !== undefined;
    const reviewer =
      defaults || canSelectReviewer
        ? select(
            defaults ? `${name} default reviewer` : `${name} reviewer`,
            policy.reviewer ?? "",
            [
              ["", defaults ? "Inherit Harness reviewer" : "Inherit plugin or Harness reviewer"],
              ...reviewers,
            ],
            (value) => writePolicy("reviewer", value || undefined),
            Boolean(capabilities) && canSelectReviewer,
          )
        : null;
    return {
      controls: element(
        "div",
        { className: "plugin-controls" },
        select(
          defaults ? `${name} tools enabled by default` : `Enable ${name}`,
          policy.enabled === undefined ? "" : String(policy.enabled),
          [
            ["", defaults ? "Inherit default policy" : "Inherit plugin policy"],
            ["true", "Enabled"],
            ["false", "Disabled"],
          ],
          (value) => writePolicy("enabled", value === "" ? undefined : value === "true"),
          capabilities?.[scope].enabled === true,
        ),
        approvalSelect(name, policy.approval, scope, (value) =>
          writePolicy("approval", value || undefined),
        ),
        reviewer,
      ),
      hint: approvalHint(policy.approval, scope),
      reviewer,
    };
  }

  function updateDetailDisabled(invalidSelection: boolean) {
    for (const node of detail.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >("input, select, button")) {
      node.disabled =
        disabled ||
        (invalidSelection && node.dataset.discovery !== "true") ||
        node.dataset.policyUnsupported === "true";
    }
  }

  function renderPluginList(
    values: Selections | null,
    entries: ReadonlyMap<string, CatalogEntry>,
    catalogLoading: boolean,
  ) {
    list.setAttribute("aria-busy", String(catalogLoading));
    const query = configuredOnly || !onLoadPlugins ? search.value.trim().toLowerCase() : "";
    const candidates = configuredOnly
      ? Object.keys(values ?? {})
          .map((id) => entries.get(id))
          .filter((entry) => entry !== undefined)
      : (catalog?.entries ?? []);
    const visible = candidates
      .filter((entry) =>
        [entry.name, entry.id, entry.description ?? ""].some((text) =>
          text.toLowerCase().includes(query),
        ),
      )
      .sort(
        (a, b) =>
          Number(a.available === false) - Number(b.available === false) ||
          a.name.localeCompare(b.name),
      );
    const rows = visible.map((entry, index) => {
      const selected = values?.[entry.id];
      const item = button(pluginIdentity(entry), () => showPlugin(entry), {
        className: "plugin-list-item",
        "aria-label": entry.name,
        "aria-current": String(tabState().activeId === entry.id),
      });
      item.append(
        element(
          "span",
          { className: "badge" },
          entry.available === false
            ? "Unavailable"
            : selected
              ? selected.enabled
                ? "Enabled"
                : "Disabled"
              : "Not selected",
        ),
      );
      const reasonId = `${input.id}-plugin-unavailable-${index}`;
      if (entry.available === false) {
        item.setAttribute("aria-describedby", reasonId);
      }
      return element(
        "div",
        { className: "plugin-list-row", "data-plugin-id": entry.id },
        item,
        entry.available === false
          ? element(
              "button",
              {
                type: "button",
                className: "plugin-unavailable-trigger",
                "aria-label": `Why ${entry.name} is unavailable`,
                popovertarget: reasonId,
              },
              element("span", { "aria-hidden": "true" }, "i"),
            )
          : null,
        entry.available === false
          ? element(
              "div",
              { id: reasonId, className: "plugin-unavailable-popover", popover: "auto" },
              unavailableMessage(entry),
            )
          : null,
      );
    });
    const focused = document.activeElement;
    const focusedRow = focused?.closest<HTMLElement>(".plugin-list-row");
    const focusedSelector = [".plugin-list-item", ".plugin-unavailable-trigger"].find((selector) =>
      focused?.matches(selector),
    );
    const focusedId = focusedRow?.parentElement === list ? focusedRow.dataset.pluginId : null;
    list.replaceChildren(...rows);
    if (focusedId !== null && focusedSelector) {
      rows
        .find((row) => row.dataset.pluginId === focusedId)
        ?.querySelector<HTMLButtonElement>(focusedSelector)
        ?.focus({ preventScroll: true });
    }
    if (!visible.length && !catalogLoading) {
      list.append(
        element(
          "p",
          { className: "muted" },
          query
            ? "No matching plugins on this page."
            : configuredOnly
              ? "No plugins configured. Choose Available plugins to add one."
              : catalog?.status === "ready"
                ? "No plugins were returned."
                : !catalog?.canLoad
                  ? "To add a plugin by ID, choose Done and edit Plugin selections JSON."
                  : "Load plugins to browse available choices.",
        ),
      );
    }
  }

  function render() {
    rememberExpandedTools();
    const active = document.activeElement;
    const focused = active?.getAttribute("aria-label");
    const focusedSelection =
      focused === "Filter tools" && active instanceof HTMLInputElement
        ? ([active.selectionStart, active.selectionEnd] as const)
        : null;
    const focusedPlugin = active?.closest<HTMLElement>(".plugin-card")?.dataset.plugin;
    const focusedTool = active?.closest<HTMLElement>("[data-tool]")?.dataset.tool;
    const focusedHeading = active?.matches(".plugin-detail h3");
    const values = selections();
    const catalogLoading = !configuredOnly && catalog?.status === "loading";
    // Live regions are written only when their text changes, so a redraw (tool details arriving)
    // does not make screen readers announce the same words again (finding 1890).
    setText(
      policyStatus,
      capabilities || capabilitiesUnread
        ? ""
        : "This installation does not support plugin policy editing. You can browse plugins; existing settings are preserved.",
    );
    const defaultReviewers = reviewerOptions.filter(([mode]) =>
      capabilities?.toolDefaults.reviewer?.includes(mode),
    );
    const toolReviewers = reviewerOptions.filter(([mode]) =>
      capabilities?.tools.reviewer?.includes(mode),
    );
    setText(
      feedback,
      values === null
        ? "Fix Plugin selections JSON to use the controls. Check plugin enablement and tool policies. Your JSON has been kept."
        : "",
    );
    if (values === null) {
      json.open = true;
    }
    const entries = new Map(
      (catalog?.knownEntries ?? catalog?.entries ?? []).map((entry) => [entry.id, entry]),
    );
    for (const id of Object.keys(values ?? {})) {
      if (!entries.has(id)) {
        entries.set(id, { id, name: id, tools: null });
      }
    }
    const availableIds = new Set(
      (catalog?.status === "ready"
        ? catalog.entries
        : (catalog?.knownEntries ?? catalog?.entries ?? [])
      ).map((entry) => entry.id),
    );
    if (tabs[0].activeId && !availableIds.has(tabs[0].activeId)) {
      clearDetails(tabs[0]);
    }
    if (tabs[1].activeId && !Object.hasOwn(values ?? {}, tabs[1].activeId)) {
      clearDetails(tabs[1]);
    }
    renderedTab = tabState();
    renderedPlugin = renderedTab.activeId;
    const open = renderedTab.expanded;
    let statusText =
      catalog?.message ??
      "Enter a service account token with the Codex harness to discover plugins. Existing selections remain in JSON.";
    status.classList.toggle("plugin-loading", catalogLoading);
    if (catalogLoading) {
      statusText = tabs[0].query.trim() ? "Searching plugins…" : "Loading available plugins…";
    } else if (catalog?.status === "ready") {
      statusText = `Page ${catalog.pageNumber ?? 1} · ${catalog.entries.length} plugins`;
    }
    loadPlugins.textContent = catalog?.status === "loading" ? "Loading plugins…" : "Load plugins";
    loadPlugins.disabled = disabled || !catalog?.canLoad || catalog?.status === "loading";
    loadPlugins.hidden = configuredOnly || !onLoadPlugins;
    pagination.hidden = configuredOnly || !onLoadPlugins;
    previous.disabled =
      disabled || !catalog?.canLoad || !catalog?.hasPrevious || catalog?.status === "loading";
    next.disabled =
      disabled || !catalog?.canLoad || !catalog?.nextCursor || catalog?.status === "loading";
    available.setAttribute("aria-pressed", String(!configuredOnly));
    configured.setAttribute("aria-pressed", String(configuredOnly));
    const count = Object.keys(values ?? {}).length;
    accessHelp.hidden = !catalog?.setup;
    setupReminder.hidden = !catalog?.setup || count === 0;
    setupInstructions.replaceChildren(...(catalog?.setup ? setupContent(catalog.setup) : []));
    setupReminder.replaceChildren(
      element("summary", {}, "Check plugin access and credentials before deployment"),
      ...(catalog?.setup ? setupContent(catalog.setup) : []),
    );
    summary.textContent = `${count} plugin${count === 1 ? "" : "s"} configured. Select plugins and set their tool policies.`;
    searchLabel.textContent = configuredOnly ? "Filter configured plugins" : "Search plugins";
    search.placeholder = searchLabel.textContent;
    if (configuredOnly) {
      statusText = `${count} configured plugin${count === 1 ? "" : "s"}`;
    }
    setText(status, statusText);
    workspace.dataset.showDetails = String(tabState().activeId !== null);
    renderPluginList(values, entries, catalogLoading);
    const activeId = tabState().activeId;
    const entry = activeId === null ? undefined : entries.get(activeId);
    if (entry) {
      const selected = values?.[entry.id];
      let defaultReviewer: HTMLLabelElement | null = null;
      const details = element(
        "div",
        { className: "plugin-card", "data-plugin": entry.id },
        button(
          "Back to plugins",
          () => {
            clearDetails(tabState());
            render();
            search.focus();
          },
          { className: "plugin-back" },
        ),
        element(
          "div",
          { className: "plugin-detail-header" },
          pluginIdentity(entry, true),
          element(
            "span",
            { className: "badge" },
            entry.available === false
              ? "Unavailable"
              : selected
                ? selected.enabled
                  ? "Enabled"
                  : "Disabled"
                : "Not selected",
          ),
        ),
        element("p", { className: "hint plugin-id" }, entry.id),
        entry.description ? element("p", { className: "hint" }, entry.description) : null,
        element(
          "div",
          { className: "plugin-external-links" },
          entry.websiteUrl ? catalogLink("Website", entry.websiteUrl) : null,
          entry.privacyPolicyUrl ? catalogLink("Privacy policy", entry.privacyPolicyUrl) : null,
          entry.termsOfServiceUrl ? catalogLink("Terms of service", entry.termsOfServiceUrl) : null,
        ),
        entry.available === false ? unavailableMessage(entry) : null,
      );
      if (selected) {
        const enabled = element("input", {
          type: "checkbox",
          checked: selected.enabled,
          "aria-label": `Enable ${entry.name}`,
        });
        enabled.addEventListener("change", () =>
          updateSelection(entry.id, (selection) => {
            selection.enabled = enabled.checked;
          }),
        );
        details.append(
          element(
            "div",
            { className: "plugin-controls" },
            element("label", { className: "plugin-toggle" }, enabled, "Enable plugin"),
            button(`Remove ${entry.name}`, () =>
              update((all) => {
                delete all[entry.id];
              }),
            ),
          ),
        );
        const defaults = selected.toolDefaults ?? {};
        const writeDefault: WritePolicy = (key, value) => writeToolPolicy(entry.id, key, value);
        const fields = toolPolicyFields(
          entry.name,
          defaults,
          "toolDefaults",
          defaultReviewers,
          writeDefault,
        );
        defaultReviewer = fields.reviewer;
        details.append(
          element(
            "fieldset",
            { className: "plugin-tool", disabled: !selected.enabled },
            element("legend", {}, "Plugin policies"),
            element(
              "p",
              { className: "hint" },
              "Approval applies to current and future actions unless a tool overrides it. Reviewer selects who reviews; automatic review may deny a call.",
            ),
            fields.controls,
            fields.hint,
          ),
        );
        if (createApproverField && capabilities?.approvers?.plugin === true) {
          details.append(
            createApproverField({
              label: `${entry.name} plugin approvers`,
              getValue: () => selections()?.[entry.id]?.approvers,
              onChange: (approvers) =>
                updateSelection(entry.id, (selection) => {
                  if (approvers === undefined) {
                    delete selection.approvers;
                  } else {
                    selection.approvers = approvers;
                  }
                }),
              inheritedLabel: "Inherit Agent default approvers",
            }),
          );
        }
        const driverFields = [];
        for (const [key, schema] of Object.entries(
          capabilities?.driverPolicySchema.properties ?? {},
        )) {
          if (!isObject(schema)) {
            continue;
          }
          let options: Choice[];
          if (schema.type === "boolean") {
            options = [
              ["true", "Enabled"],
              ["false", "Disabled"],
            ];
          } else if (
            schema.type === "string" &&
            Array.isArray(schema.enum) &&
            schema.enum.every((value) => typeof value === "string")
          ) {
            options = schema.enum.map((value) => [value, value.replaceAll("_", " ")]);
          } else {
            continue;
          }
          const current = selected.driverPolicy?.[key];
          driverFields.push(
            select(
              `${entry.name} ${schema.title ?? key}`,
              current === undefined ? "" : String(current),
              [["", "Inherit default policy"], ...options],
              (value) =>
                updateSelection(entry.id, (selection) => {
                  const driverPolicy = { ...selection.driverPolicy };
                  if (value === "") {
                    delete driverPolicy[key];
                  } else {
                    driverPolicy[key] = schema.type === "boolean" ? value === "true" : value;
                  }
                  if (Object.keys(driverPolicy).length) {
                    selection.driverPolicy = driverPolicy;
                  } else {
                    delete selection.driverPolicy;
                  }
                }),
            ),
          );
        }
        if (driverFields.length) {
          details.append(
            element(
              "fieldset",
              { className: "plugin-tool", disabled: !selected.enabled },
              element("legend", {}, "Driver policy"),
              element("div", { className: "plugin-controls" }, ...driverFields),
            ),
          );
        }
      } else {
        const add = button(`Add ${entry.name}`, () =>
          update((all) => {
            all[entry.id] = { enabled: true };
          }),
        );
        add.dataset.policyUnsupported = String(
          !capabilities ||
            entry.available === false ||
            (entry.remoteId &&
              entry.tools === null &&
              !(entry.selectableWithoutTools && entry.toolStatus === "loaded")),
        );
        details.append(add);
      }
      // An override can outlive the tool in the Driver catalog. Show its saved ID in either case.
      type Tool = Omit<PluginToolCatalogEntry, "ownerId"> & { ownerId?: string };
      const tools = new Map<string, Tool>((entry.tools ?? []).map((tool) => [tool.id, tool]));
      for (const id of Object.keys(selected?.tools ?? {})) {
        if (!tools.has(id)) {
          tools.set(id, { id, name: id });
        }
      }
      if (entry.toolStatus === "loading") {
        details.append(
          element("p", { className: "hint plugin-loading", role: "status" }, "Loading tools…"),
        );
      } else if (entry.tools === null) {
        details.append(
          element(
            "p",
            { className: "hint" },
            "Tool list unavailable. Existing tool overrides are preserved; this does not mean the plugin has no tools.",
          ),
        );
        if (entry.selectableWithoutTools && entry.toolStatus === "loaded") {
          details.append(
            element(
              "p",
              { className: "hint" },
              "This catalog does not list tools. Runtime startup checks the selected plugin and its access.",
            ),
          );
        } else if (onLoadTools && entry.remoteId) {
          details.append(
            element(
              "p",
              { className: "hint" },
              "Load tools to check this plugin before selecting it.",
            ),
          );
          const load = button(
            entry.toolError ? `Retry tools for ${entry.name}` : `Load tools for ${entry.name}`,
            () => onLoadTools(entry.id),
          );
          load.dataset.discovery = "true";
          load.dataset.policyUnsupported = String(
            !catalog?.canLoad || catalog?.status === "loading",
          );
          details.append(load);
        }
      } else if (tools.size === 0) {
        details.append(element("p", { className: "hint" }, "No tools listed for this plugin."));
      }
      if (entry.toolError) {
        details.append(
          element(
            "p",
            // A status, not an alert: the pane is rebuilt on every redraw (search typing, say),
            // and an alert would be announced again each time.
            { className: "status", "data-tone": "danger", role: "status" },
            entry.toolError,
          ),
        );
      }
      const toolRows: [Tool, HTMLDetailsElement][] = [];
      const filterTools = () => {
        const query = tabState().toolQuery.toLowerCase();
        for (const [tool, row] of toolRows) {
          row.hidden = ![tool.name, tool.description ?? "", tool.id].some((value) =>
            value.toLowerCase().includes(query),
          );
        }
      };
      if (tools.size) {
        const filter = element("input", {
          type: "search",
          "aria-label": "Filter tools",
          placeholder: "Filter tools",
          value: tabState().toolQuery,
        });
        filter.addEventListener("input", () => {
          tabState().toolQuery = filter.value;
          filterTools();
        });
        details.append(
          element("h4", {}, `Tools (${tools.size})`),
          element(
            "p",
            { className: "hint" },
            "A dash inherits plugin enablement. Use Tool policy to set approval overrides or restore inheritance.",
          ),
          element("div", { className: "form-field" }, filter),
        );
      }
      for (const tool of tools.values()) {
        const policy = selected?.tools?.[tool.id] ?? {};
        const writeTool: WritePolicy = (key, value) =>
          writeToolPolicy(entry.id, key, value, tool.id);
        const fields = toolPolicyFields(tool.name, policy, "tools", toolReviewers, writeTool);
        if (!fields.reviewer && selected && defaultReviewers.length > 0) {
          fields.controls.append(
            button("Set reviewer for all tools", () =>
              defaultReviewer?.querySelector("select")?.focus(),
            ),
          );
        }
        const row = element(
          "fieldset",
          {
            className: "plugin-tool",
            "data-tool": tool.id,
            disabled: !selected || !selected.enabled || tool.available === false,
          },
          element("legend", {}, tool.name),
          tool.description ? element("p", { className: "hint" }, tool.description) : null,
          tool.available === false
            ? element(
                "p",
                { className: "hint" },
                tool.unavailableReason ?? "This tool is unavailable to this service account.",
              )
            : null,
          tool.ownerId ? element("p", { className: "hint" }, `Provided by ${tool.ownerId}`) : null,
          fields.controls,
          fields.hint,
        );
        const toolApprovers =
          createApproverField && capabilities?.approvers?.tools === true
            ? createApproverField({
                label: `${tool.name} tool approvers`,
                getValue: () => selections()?.[entry.id]?.tools?.[tool.id]?.approvers,
                onChange: (approvers) => writeTool("approvers", approvers),
                inheritedLabel: "Inherit plugin approvers",
                lazyNames: true,
              })
            : null;
        if (toolApprovers) {
          row.append(toolApprovers);
        }
        const enabledOverride = element("input", {
          type: "checkbox",
          className: "plugin-tool-switch",
          "aria-label": `${tool.name} enabled override`,
          title: "Tool enabled override: a dash inherits plugin policy",
          checked: policy.enabled === true,
        });
        enabledOverride.indeterminate = policy.enabled === undefined;
        enabledOverride.dataset.policyUnsupported = String(
          !selected?.enabled || tool.available === false || !capabilities?.tools.enabled,
        );
        enabledOverride.addEventListener("click", (event) => event.stopPropagation());
        enabledOverride.addEventListener("change", () =>
          writeTool("enabled", enabledOverride.checked),
        );
        const toolDetails = element(
          "details",
          { className: "plugin-tool-row", "data-tool": tool.id },
          element(
            "summary",
            {},
            element(
              "span",
              { className: "plugin-tool-heading" },
              element("strong", {}, tool.name),
              element(
                "span",
                { className: "badge" },
                tool.available === false
                  ? "Unavailable"
                  : Object.keys(policy).length
                    ? "Overrides"
                    : "Inherits defaults",
              ),
            ),
            tool.name === tool.id
              ? null
              : element("code", { className: "hint plugin-id" }, tool.id),
            tool.description
              ? element("span", { className: "hint plugin-tool-description" }, tool.description)
              : null,
            element(
              "span",
              { className: "plugin-tool-actions" },
              element(
                "span",
                { className: "button button--sm plugin-tool-policy-action" },
                "Tool policy",
              ),
              enabledOverride,
            ),
          ),
          row,
        );
        toolDetails.open = open.has(tool.id);
        toolDetails.addEventListener("toggle", () => {
          if (toolDetails.open) {
            toolApprovers?.refreshNames?.();
          } else {
            toolApprovers?.pauseNames?.();
          }
        });
        if (toolDetails.open) {
          toolApprovers?.refreshNames?.();
        }
        if (capabilities && !toolReviewers.length && defaultReviewers.length > 0) {
          row.append(
            element(
              "p",
              { className: "hint" },
              "Reviewer selection applies to every tool in this plugin.",
            ),
          );
        }
        toolRows.push([tool, toolDetails]);
        details.append(toolDetails);
      }
      filterTools();
      detail.replaceChildren(details);
    } else {
      detail.replaceChildren(
        element(
          "p",
          { className: "muted plugin-detail-empty" },
          "Choose a plugin to configure its policies and tools.",
        ),
      );
    }
    updateDetailDisabled(values === null);
    // Detail refreshes replace focused controls; keep the search caret in place.
    if (focusedHeading && focusedPlugin === tabState().activeId) {
      detail.querySelector("h3")?.focus();
    } else if (focused) {
      const control = [...detail.querySelectorAll<HTMLElement>("[aria-label]")].find(
        (node) =>
          node.getAttribute("aria-label") === focused &&
          node.closest<HTMLElement>(".plugin-card")?.dataset.plugin === focusedPlugin &&
          node.closest<HTMLElement>("[data-tool]")?.dataset.tool === focusedTool,
      );
      control?.focus();
      if (focusedSelection && control instanceof HTMLInputElement && control.type === "search") {
        control.setSelectionRange(...focusedSelection);
      }
    }
  }
  input.addEventListener("input", render);
  search.addEventListener("input", () => {
    tabState().query = search.value;
    if (configuredOnly || !onLoadPlugins) {
      render();
      return;
    }
    loadPage("search");
  });
  render();
  return {
    section,
    setDisabled(value: boolean) {
      disabled = value;
      // The selections JSON stays readable, focusable and copyable; the rest goes inert.
      for (const child of section.children) {
        if (child !== json) {
          child.toggleAttribute("inert", value);
        }
      }
      input.readOnly = value;
      configure.disabled = value;
      loadPlugins.disabled = value || !catalog?.canLoad || catalog?.status === "loading";
      previous.disabled =
        value || !catalog?.canLoad || !catalog?.hasPrevious || catalog?.status === "loading";
      next.disabled =
        value || !catalog?.canLoad || !catalog?.nextCursor || catalog?.status === "loading";
      updateDetailDisabled(selections() === null);
    },
    resetSearch() {
      // Discovery calls this when credentials or the provider change.
      for (const state of tabs) {
        clearDetails(state);
        state.query = "";
      }
      search.value = "";
      render();
    },
    // `unread` says the capabilities read failed, so nothing is known about Installation support;
    // the owner shows why (finding 2538).
    setCapabilities(value: PluginPolicyCapabilities | null, unread = false) {
      capabilities = value;
      capabilitiesUnread = value === null && unread;
      render();
    },
    setCatalog(value: PluginFieldCatalog) {
      const load = waitingForCatalog && dialog.open && value.canLoad && value.status === "idle";
      catalog = value;
      if (load) {
        waitingForCatalog = false;
        showConfigured(false);
        loadPage("refresh");
      } else {
        render();
      }
    },
  };
}
