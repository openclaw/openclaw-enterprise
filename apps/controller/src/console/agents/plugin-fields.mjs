import { element, button, dismissOnBackdrop, setText } from "../dom.mjs";

const approvalOptions = [
  ["provider_default", "Provider default"],
  ["all_actions", "Every action"],
  ["write_actions", "Write actions"],
  ["none", "No additional approval"],
];
const reviewerOptions = [
  ["human", "Human"],
  ["auto", "Automatic review"],
];
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validApprovers = (value) =>
  Array.isArray(value) &&
  value.every(
    (entry) => isObject(entry) && typeof entry.channel === "string" && typeof entry.id === "string",
  );
function validToolPolicy(value, allowApprovers = false) {
  return (
    isObject(value) &&
    (value.enabled === undefined || typeof value.enabled === "boolean") &&
    (value.approval === undefined || approvalOptions.some(([mode]) => mode === value.approval)) &&
    (value.reviewer === undefined || reviewerOptions.some(([mode]) => mode === value.reviewer)) &&
    (value.approvers === undefined || (allowApprovers && validApprovers(value.approvers)))
  );
}

function pluginIdentity(entry, heading = false) {
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

function catalogLink(label, url) {
  return element("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, label);
}

function unavailableMessage(entry) {
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

function setupContent(setup) {
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
}) {
  let disabled = false;
  let configuredOnly = false;
  const tabs = [newTabState(), newTabState()];
  let renderedTab = null;
  let renderedPlugin = null;

  function newTabState() {
    return { activeId: null, query: "", toolQuery: "", expanded: new Set() };
  }

  function tabState() {
    return tabs[Number(configuredOnly)];
  }

  function clearDetails(state) {
    state.activeId = null;
    state.toolQuery = "";
    state.expanded.clear();
  }

  function rememberExpandedTools() {
    if (renderedTab && renderedPlugin === renderedTab.activeId) {
      renderedTab.expanded = new Set(
        [...detail.querySelectorAll("details[data-tool][open]")].map((node) => node.dataset.tool),
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
    if (event.key === "Enter" && event.target.matches('input[type="search"]')) {
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

  function loadPage(direction) {
    clearDetails(tabs[0]);
    onLoadPlugins?.(direction, tabs[0].query);
  }

  function showConfigured(value) {
    waitingForCatalog = false;
    rememberExpandedTools();
    configuredOnly = value;
    search.value = tabState().query;
    if (value) {
      onCancelDiscovery?.();
    }
    render();
  }

  function showPlugin(entry) {
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
      const value = JSON.parse(input.value);
      if (!isObject(value)) {
        return null;
      }
      for (const item of Object.values(value)) {
        if (
          !isObject(item) ||
          typeof item.enabled !== "boolean" ||
          (item.approvers !== undefined && !validApprovers(item.approvers)) ||
          (item.toolDefaults !== undefined && !validToolPolicy(item.toolDefaults)) ||
          (item.tools !== undefined &&
            (!isObject(item.tools) ||
              !Object.values(item.tools).every((policy) => validToolPolicy(policy, true))))
        ) {
          return null;
        }
      }
      return value;
    } catch {
      return null;
    }
  }

  function update(change) {
    const values = selections();
    if (disabled || values === null) {
      return;
    }
    change(values);
    input.value = JSON.stringify(values, null, 2);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function writeToolPolicy(pluginId, scope, key, value, toolId) {
    update((all) => {
      const selection = all[pluginId];
      const policy = {
        ...(scope === "toolDefaults" ? selection.toolDefaults : selection.tools?.[toolId]),
        [key]: value,
      };
      if (value === undefined) {
        delete policy[key];
      }
      const updated = scope === "toolDefaults" ? policy : { ...selection.tools, [toolId]: policy };
      if (scope === "tools" && Object.keys(policy).length === 0) {
        delete updated[toolId];
      }
      if (Object.keys(updated).length === 0) {
        delete selection[scope];
      } else {
        selection[scope] = updated;
      }
    });
  }

  function select(label, value, options, onChange, supported = true) {
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
    control.addEventListener("change", () => onChange(control.value));
    return element("label", { className: "plugin-control" }, label, control);
  }

  function approvalSelect(name, value, scope, onChange) {
    const modes = capabilities?.[scope].approval ?? [];
    const options = approvalOptions.map(([mode, label]) => [mode, label, !modes.includes(mode)]);
    const field = select(
      "Require approval for",
      value ?? "",
      [["", scope === "tools" ? "Inherit plugin policy" : "Inherit default policy"], ...options],
      onChange,
      modes.length > 0,
    );
    field.querySelector("select").setAttribute("aria-label", `${name} require approval for`);
    return field;
  }

  function approvalHint(value, scope) {
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

  function toolPolicyFields(name, policy, scope, reviewers, writePolicy) {
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

  function updateDetailDisabled(invalidSelection) {
    for (const node of detail.querySelectorAll("input, select, button")) {
      node.disabled =
        disabled ||
        (invalidSelection && node.dataset.discovery !== "true") ||
        node.dataset.policyUnsupported === "true";
    }
  }

  function renderPluginList(values, entries, catalogLoading) {
    list.setAttribute("aria-busy", String(catalogLoading));
    const query = configuredOnly || !onLoadPlugins ? search.value.trim().toLowerCase() : "";
    const candidates = configuredOnly
      ? Object.keys(values ?? {}).map((id) => entries.get(id))
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
    const focusedRow = focused?.closest(".plugin-list-row");
    const focusedSelector = [".plugin-list-item", ".plugin-unavailable-trigger"].find((selector) =>
      focused?.matches(selector),
    );
    const focusedId = focusedRow?.parentElement === list ? focusedRow.dataset.pluginId : null;
    list.replaceChildren(...rows);
    if (focusedId !== null && focusedSelector) {
      rows
        .find((row) => row.dataset.pluginId === focusedId)
        ?.querySelector(focusedSelector)
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
    const focused = document.activeElement?.getAttribute("aria-label");
    const focusedSelection =
      focused === "Filter tools"
        ? [document.activeElement.selectionStart, document.activeElement.selectionEnd]
        : null;
    const focusedPlugin = document.activeElement?.closest(".plugin-card")?.dataset.plugin;
    const focusedTool = document.activeElement?.closest("[data-tool]")?.dataset.tool;
    const focusedHeading = document.activeElement?.matches(".plugin-detail h3");
    const values = selections();
    const catalogLoading = !configuredOnly && catalog?.status === "loading";
    // Live regions are written only when their text changes, so a redraw (tool details arriving)
    // does not make screen readers announce the same words again (finding 1890).
    setText(
      policyStatus,
      capabilities
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
    } else if (catalog?.status === "error") {
      statusText = catalog.message;
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
    detail.replaceChildren(
      ...[entries.get(tabState().activeId)].filter(Boolean).map((entry) => {
        const selected = values?.[entry.id];
        let defaultReviewer = null;
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
            entry.termsOfServiceUrl
              ? catalogLink("Terms of service", entry.termsOfServiceUrl)
              : null,
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
            update((all) => {
              all[entry.id].enabled = enabled.checked;
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
          const writeDefault = (key, value) =>
            writeToolPolicy(entry.id, "toolDefaults", key, value);
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
                  update((all) => {
                    if (approvers === undefined) {
                      delete all[entry.id].approvers;
                    } else {
                      all[entry.id].approvers = approvers;
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
            let options;
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
                  update((all) => {
                    const selection = all[entry.id];
                    selection.driverPolicy = { ...selection.driverPolicy };
                    if (value === "") {
                      delete selection.driverPolicy[key];
                    } else {
                      selection.driverPolicy[key] =
                        schema.type === "boolean" ? value === "true" : value;
                    }
                    if (!Object.keys(selection.driverPolicy).length) {
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
        const tools = new Map((entry.tools ?? []).map((tool) => [tool.id, tool]));
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
        const toolRows = [];
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
          const writeTool = (key, value) => writeToolPolicy(entry.id, "tools", key, value, tool.id);
          const fields = toolPolicyFields(tool.name, policy, "tools", toolReviewers, writeTool);
          if (!fields.reviewer && selected && defaultReviewers.length > 0) {
            fields.controls.append(
              button("Set reviewer for all tools", () =>
                defaultReviewer.querySelector("select")?.focus(),
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
            tool.ownerId
              ? element("p", { className: "hint" }, `Provided by ${tool.ownerId}`)
              : null,
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
        return details;
      }),
    );
    if (!tabState().activeId) {
      detail.append(
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
      const control = [...detail.querySelectorAll("[aria-label]")].find(
        (node) =>
          node.getAttribute("aria-label") === focused &&
          node.closest(".plugin-card")?.dataset.plugin === focusedPlugin &&
          node.closest("[data-tool]")?.dataset.tool === focusedTool,
      );
      control?.focus();
      if (focusedSelection && control?.matches('input[type="search"]')) {
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
    setDisabled(value) {
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
    setCapabilities(value) {
      capabilities = value;
      render();
    },
    setCatalog(value) {
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
