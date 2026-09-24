import { element, button } from "../dom.mjs";

const approvalOptions = [
  ["native", "Native behavior"],
  ["prompt", "Ask for approval"],
  ["approve", "Approve"],
];
const reviewerOptions = [
  ["human", "Human"],
  ["auto", "Automatic review"],
];
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function validToolPolicy(value) {
  return (
    isObject(value) &&
    (value.enabled === undefined || typeof value.enabled === "boolean") &&
    (value.approval === undefined || approvalOptions.some(([mode]) => mode === value.approval)) &&
    (value.reviewer === undefined || reviewerOptions.some(([mode]) => mode === value.reviewer))
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

function unavailableMessage(entry, id) {
  return element(
    "p",
    { className: "hint plugin-unavailable", ...(id ? { id } : {}) },
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
  onLoadTools = null,
}) {
  let disabled = false;
  let activeId = null;
  let configuredOnly = false;
  let toolQuery = "";
  const search = element("input", {
    type: "search",
    id: "plugin-search",
    placeholder: "Filter this page",
  });
  const searchLabel = element("label", { for: search.id }, "Filter this page");
  const status = element("p", { className: "hint", role: "status" });
  const feedback = element("p", { className: "error", role: "status" });
  const policyStatus = element("p", { className: "hint", role: "status" });
  const summary = element("p", { className: "hint" });
  const list = element("div", { className: "plugin-list" });
  const detail = element("div", { className: "plugin-detail" });
  const loadPlugins = button("Load plugins", () => loadPage("refresh"));
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
    className: "plugin-dialog",
    "aria-labelledby": "plugin-dialog-title",
  });
  const configure = button("Configure plugins", () => {
    if (disabled) {
      return;
    }
    if (!catalog?.canLoad && Object.keys(selections() ?? {}).length) {
      configuredOnly = true;
      render();
    }
    dialog.showModal();
    search.focus();
    if (catalog?.status === "idle" && catalog.canLoad) {
      loadPage("refresh");
    }
  });
  const accessHelp = element("div", { className: "plugin-access-help" });
  const setupReminder = element("details", { className: "plugin-setup-reminder" });
  dialog.append(
    element(
      "div",
      { className: "plugin-dialog-header" },
      element("h2", { id: "plugin-dialog-title" }, "Configure plugins"),
      button("Done", () => dialog.close()),
    ),
    element("p", { className: "hint" }, "Changes are saved when you create the Agent."),
    accessHelp,
    policyStatus,
    feedback,
    workspace,
  );
  dialog.addEventListener("close", () => configure.focus());
  // A search Enter must not submit the surrounding Create Agent form.
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches('input[type="search"]')) {
      event.preventDefault();
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
    activeId = null;
    search.value = "";
    onLoadPlugins?.(direction);
  }

  function showConfigured(value) {
    configuredOnly = value;
    search.value = "";
    activeId = null;
    render();
  }

  function showPlugin(entry) {
    activeId = entry.id;
    toolQuery = "";
    render();
    detail.querySelector("h3")?.focus();
    if (entry.remoteId && entry.tools === null && !entry.toolError && catalog?.canLoad) {
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
          (item.toolDefaults !== undefined && !validToolPolicy(item.toolDefaults)) ||
          (item.tools !== undefined &&
            (!isObject(item.tools) || !Object.values(item.tools).every(validToolPolicy)))
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

  function select(label, value, options, onChange, supported = true) {
    const control = element(
      "select",
      { "aria-label": label },
      ...options.map(([key, text]) => element("option", { value: key }, text)),
    );
    if (!options.some(([key]) => key === value)) {
      control.append(element("option", { value, disabled: true }, `${value} (unsupported)`));
    }
    control.dataset.policyUnsupported = String(!supported);
    control.value = value;
    control.addEventListener("change", () => onChange(control.value));
    return element("label", { className: "plugin-control" }, label, control);
  }

  function render() {
    const open = new Set(
      [...detail.querySelectorAll("details[data-tool][open]")].map((node) => node.dataset.tool),
    );
    const focused = document.activeElement?.getAttribute("aria-label");
    const focusedPlugin = document.activeElement?.closest(".plugin-card")?.dataset.plugin;
    const focusedTool = document.activeElement?.closest("[data-tool]")?.dataset.tool;
    const focusedHeading = document.activeElement?.matches(".plugin-detail h3");
    const values = selections();
    policyStatus.textContent = capabilities
      ? ""
      : "This installation does not support plugin policy editing. You can browse plugins; existing settings are preserved.";
    const defaultApprovals = approvalOptions.filter(([mode]) =>
      capabilities?.toolDefaults.approval.includes(mode),
    );
    const toolApprovals = approvalOptions.filter(([mode]) =>
      capabilities?.tools.approval.includes(mode),
    );
    const defaultReviewers = reviewerOptions.filter(([mode]) =>
      capabilities?.toolDefaults.reviewer?.includes(mode),
    );
    const toolReviewers = reviewerOptions.filter(([mode]) =>
      capabilities?.tools.reviewer?.includes(mode),
    );
    feedback.textContent =
      values === null
        ? "Fix Plugin selections JSON to use the controls. Check plugin enablement and tool policies. Your JSON has been kept."
        : "";
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
    if (activeId && !entries.has(activeId)) {
      activeId = null;
    }
    status.textContent =
      catalog?.message ??
      "Enter a service account token with the Codex harness to discover plugins. Existing selections remain in JSON.";
    if (catalog?.status === "loading") {
      status.textContent = "Loading available plugins…";
    } else if (catalog?.status === "error") {
      status.textContent = catalog.message;
    } else if (catalog?.status === "ready") {
      status.textContent = `Page ${catalog.pageNumber ?? 1} · ${catalog.entries.length} plugins`;
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
    accessHelp.replaceChildren(...(catalog?.setup ? setupContent(catalog.setup) : []));
    setupReminder.replaceChildren(
      element("summary", {}, "Check plugin access and credentials before deployment"),
      ...(catalog?.setup ? setupContent(catalog.setup) : []),
    );
    summary.textContent = `${count} plugin${count === 1 ? "" : "s"} configured. Select plugins and set their tool policies.`;
    searchLabel.textContent = configuredOnly ? "Filter configured plugins" : "Filter this page";
    search.placeholder = searchLabel.textContent;
    if (configuredOnly) {
      status.textContent = `${count} configured plugin${count === 1 ? "" : "s"}`;
    }
    browser.setAttribute("aria-busy", String(catalog?.status === "loading"));
    workspace.dataset.showDetails = String(activeId !== null);
    const query = search.value.trim().toLowerCase();
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
    list.replaceChildren(
      ...visible.map((entry, index) => {
        const selected = values?.[entry.id];
        const item = button(pluginIdentity(entry), () => showPlugin(entry), {
          className: "plugin-list-item",
          "aria-label": entry.name,
          "aria-current": String(activeId === entry.id),
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
        const reasonId = `plugin-unavailable-${index}`;
        if (entry.available === false) {
          item.setAttribute("aria-describedby", reasonId);
        }
        return element(
          "div",
          { className: "plugin-list-row" },
          item,
          entry.available === false ? unavailableMessage(entry, reasonId) : null,
        );
      }),
    );
    detail.replaceChildren(
      ...[entries.get(activeId)].filter(Boolean).map((entry) => {
        const selected = values?.[entry.id];
        const details = element(
          "div",
          { className: "plugin-card", "data-plugin": entry.id },
          button(
            "Back to plugins",
            () => {
              activeId = null;
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
            update((all) => {
              const selection = all[entry.id];
              selection.toolDefaults = { ...selection.toolDefaults, [key]: value };
              if (value === undefined) {
                delete selection.toolDefaults[key];
              }
              if (!Object.keys(selection.toolDefaults).length) {
                delete selection.toolDefaults;
              }
            });
          details.append(
            element(
              "fieldset",
              { className: "plugin-tool", disabled: !selected.enabled },
              element("legend", {}, "Plugin policies"),
              element(
                "p",
                { className: "hint" },
                "Approval controls when review is required. Reviewer selects who reviews; automatic review may deny a call.",
              ),
              element(
                "div",
                { className: "plugin-controls" },
                select(
                  `${entry.name} tools enabled by default`,
                  defaults.enabled === undefined ? "" : String(defaults.enabled),
                  [
                    ["", "Inherit default policy"],
                    ["true", "Enabled"],
                    ["false", "Disabled"],
                  ],
                  (value) => writeDefault("enabled", value === "" ? undefined : value === "true"),
                  capabilities?.toolDefaults.enabled === true,
                ),
                select(
                  `${entry.name} default approval`,
                  defaults.approval ?? "",
                  [["", "Inherit default policy"], ...defaultApprovals],
                  (value) => writeDefault("approval", value || undefined),
                  defaultApprovals.length > 0,
                ),
                select(
                  `${entry.name} default reviewer`,
                  defaults.reviewer ?? "",
                  [["", "Inherit Harness reviewer"], ...defaultReviewers],
                  (value) => writeDefault("reviewer", value || undefined),
                  Boolean(capabilities) &&
                    (defaultReviewers.length > 0 || defaults.reviewer !== undefined),
                ),
              ),
            ),
          );
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
            !capabilities || entry.available === false || (entry.remoteId && entry.tools === null),
          );
          details.append(add);
        }
        const tools = new Map((entry.tools ?? []).map((tool) => [tool.id, tool]));
        for (const id of Object.keys(selected?.tools ?? {})) {
          if (!tools.has(id)) {
            tools.set(id, { id, name: id });
          }
        }
        if (entry.tools === null) {
          details.append(
            element(
              "p",
              { className: "hint" },
              "Tool list unavailable. Existing tool overrides are preserved; this does not mean the plugin has no tools.",
            ),
          );
          if (onLoadTools && entry.remoteId) {
            details.append(
              element(
                "p",
                { className: "hint" },
                "Load tools to check this plugin before selecting it.",
              ),
            );
            const load = button(
              entry.toolStatus === "loading"
                ? "Loading tools…"
                : entry.toolError
                  ? `Retry tools for ${entry.name}`
                  : `Load tools for ${entry.name}`,
              () => onLoadTools(entry.id),
            );
            load.dataset.discovery = "true";
            load.dataset.policyUnsupported = String(
              !catalog?.canLoad || catalog?.status === "loading" || entry.toolStatus === "loading",
            );
            details.append(load);
          }
        } else if (tools.size === 0) {
          details.append(element("p", { className: "hint" }, "No tools listed for this plugin."));
        }
        if (entry.toolError) {
          details.append(element("p", { className: "error", role: "status" }, entry.toolError));
        }
        if (tools.size) {
          const filter = element("input", {
            type: "search",
            "aria-label": "Filter tools",
            placeholder: "Filter tools",
            value: toolQuery,
          });
          filter.addEventListener("input", () => {
            toolQuery = filter.value;
            render();
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
          if (
            toolQuery &&
            ![tool.name, tool.description ?? "", tool.id].some((value) =>
              value.toLowerCase().includes(toolQuery.toLowerCase()),
            )
          ) {
            continue;
          }
          const policy = selected?.tools?.[tool.id] ?? {};
          const writeTool = (key, value) =>
            update((all) => {
              const selection = all[entry.id];
              const next = { ...selection.tools?.[tool.id], [key]: value };
              if (value === undefined) {
                delete next[key];
              }
              selection.tools = { ...selection.tools, [tool.id]: next };
              if (Object.keys(next).length === 0) {
                delete selection.tools[tool.id];
              }
              if (Object.keys(selection.tools).length === 0) {
                delete selection.tools;
              }
            });
          const row = element(
            "fieldset",
            {
              className: "plugin-tool",
              "data-tool": tool.id,
              disabled: !selected || !selected.enabled || tool.available === false,
            },
            element("legend", {}, tool.name),
            element("code", { className: "plugin-id" }, tool.id),
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
            element(
              "div",
              { className: "plugin-controls" },
              select(
                `Enable ${tool.name}`,
                policy.enabled === undefined ? "" : String(policy.enabled),
                [
                  ["", "Inherit plugin policy"],
                  ["true", "Enabled"],
                  ["false", "Disabled"],
                ],
                (value) => writeTool("enabled", value === "" ? undefined : value === "true"),
                capabilities?.tools.enabled === true,
              ),
              select(
                `${tool.name} approval`,
                policy.approval ?? "",
                [["", "Inherit plugin policy"], ...toolApprovals],
                (value) => writeTool("approval", value || undefined),
                toolApprovals.length > 0,
              ),
              select(
                `${tool.name} reviewer`,
                policy.reviewer ?? "",
                [["", "Inherit plugin or Harness reviewer"], ...toolReviewers],
                (value) => writeTool("reviewer", value || undefined),
                Boolean(capabilities) &&
                  (toolReviewers.length > 0 || policy.reviewer !== undefined),
              ),
            ),
          );
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
              tool.description
                ? element("span", { className: "hint plugin-tool-description" }, tool.description)
                : null,
              element(
                "span",
                { className: "plugin-tool-actions" },
                element("span", { className: "plugin-tool-policy-action" }, "Tool policy"),
                enabledOverride,
              ),
            ),
            row,
          );
          toolDetails.open = open.has(tool.id);
          if (capabilities && !toolReviewers.length) {
            row.append(
              element(
                "p",
                { className: "hint" },
                "This Harness uses the plugin reviewer for all tools.",
              ),
            );
          }
          details.append(toolDetails);
        }
        return details;
      }),
    );
    if (!visible.length) {
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
                : "Load plugins to browse available choices.",
        ),
      );
    }
    if (!activeId) {
      detail.append(
        element(
          "p",
          { className: "muted plugin-detail-empty" },
          "Choose a plugin to configure its policies and tools.",
        ),
      );
    }
    for (const node of detail.querySelectorAll("input, select, button")) {
      node.disabled =
        disabled ||
        (values === null && node.dataset.discovery !== "true") ||
        node.dataset.policyUnsupported === "true";
    }
    // Loading details replaces the heading too; retain the keyboard entry point.
    if (focusedHeading && focusedPlugin === activeId) {
      detail.querySelector("h3")?.focus();
    } else if (focused) {
      [...detail.querySelectorAll("[aria-label]")]
        .find(
          (node) =>
            node.getAttribute("aria-label") === focused &&
            node.closest(".plugin-card")?.dataset.plugin === focusedPlugin &&
            node.closest("[data-tool]")?.dataset.tool === focusedTool,
        )
        ?.focus();
    }
  }
  input.addEventListener("input", render);
  search.addEventListener("input", render);
  render();
  return {
    section,
    setDisabled(value) {
      disabled = value;
      section.toggleAttribute("inert", value);
      configure.disabled = value;
      loadPlugins.disabled = value || !catalog?.canLoad || catalog?.status === "loading";
      previous.disabled =
        value || !catalog?.canLoad || !catalog?.hasPrevious || catalog?.status === "loading";
      next.disabled =
        value || !catalog?.canLoad || !catalog?.nextCursor || catalog?.status === "loading";
      const invalid = selections() === null;
      for (const node of detail.querySelectorAll("input, select, button")) {
        node.disabled =
          value ||
          (invalid && node.dataset.discovery !== "true") ||
          node.dataset.policyUnsupported === "true";
      }
    },
    setCapabilities(value) {
      capabilities = value;
      render();
    },
    setCatalog(value) {
      catalog = value;
      render();
    },
  };
}
