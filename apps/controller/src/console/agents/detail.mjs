import { element, button } from "../dom.mjs";
import { createHarnessAuthFields, harnessAuthDescription } from "./harness-auth.mjs";
import { renderNativeAdminAccess } from "./native-admin.mjs";
import { createAgentDeletion } from "./deletion.mjs";
import { createAgentStop } from "./stop.mjs";
import { repositoryProfile, repositoryWriteAccessHelp } from "./repository-profiles.mjs";
import { renderChannels } from "../channels.mjs";
import { renderWorkspaceFiles } from "./workspace.mjs";
import { displayDate, shortId, namespacePath, link, message } from "./list.mjs";
import {
  createRuntimeCredentialsPanel,
  hasRequiredRuntimeCredentials,
  runtimeCredentialBlockReason,
} from "./credentials.mjs";
import { ensureSecretOperateBinding } from "./secret-access.mjs";

function errorPanel(error, context, retry) {
  if (error.status === 401) {
    context.onExpired();
    return element("div");
  }
  return element(
    "section",
    { className: "state-panel", role: "alert" },
    element("h2", {}, "Configuration unavailable"),
    element("p", {}, message(error)),
    error.requestId
      ? element("p", { className: "request-id" }, `Request ID: ${error.requestId}`)
      : null,
    button("Retry", retry),
  );
}

function summary(values, details) {
  const model = values?.agents?.defaults?.model;
  const primary = typeof model === "string" ? model : model?.primary;
  const list = element("dl", { className: "configuration-summary" });
  for (const [name, value] of [["Model", primary ?? "Not specified"], ...details]) {
    list.append(element("dt", {}, name), element("dd", {}, value ?? "None"));
  }
  return list;
}

function nativeDocument(values, label) {
  return element(
    "details",
    { className: "native-document" },
    element("summary", {}, label),
    element("pre", { tabindex: "0" }, JSON.stringify(values, null, 2)),
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deploymentFailure(error) {
  if (!error) {
    return element("p", { className: "muted" }, "No persisted startup failure.");
  }
  const runtimeFailure = error.data?.runtimeFailure;
  return element(
    "div",
    {},
    element("p", { className: "error", role: "alert" }, `${error.code}: ${error.message}`),
    runtimeFailure && typeof runtimeFailure === "object"
      ? element(
          "dl",
          { className: "credential-status-list" },
          element("dt", {}, "Runtime component"),
          element("dd", {}, runtimeFailure.component ?? "Unknown"),
          element("dt", {}, "Check"),
          element("dd", {}, runtimeFailure.check ?? "Unknown"),
          element("dt", {}, "Code"),
          element("dd", {}, runtimeFailure.code ?? "Unknown"),
          element("dt", {}, "Checked"),
          element("dd", {}, displayDate(runtimeFailure.checkedAt)),
        )
      : null,
  );
}

function createDeploymentStatusPanel(context, path, revisionId) {
  const section = element("section", { className: "agent-card deployment-status" });
  const state = { loading: false, status: null, error: null };

  async function loadStatus() {
    if (state.loading || !context.isCurrent()) {
      return;
    }
    state.loading = true;
    state.error = null;
    render();
    try {
      state.status = await context.request(`${path}/deployments/${encodeURIComponent(revisionId)}`);
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      state.error = error;
      state.status = null;
    } finally {
      if (context.isCurrent()) {
        state.loading = false;
        render();
      }
    }
  }

  function renderStatus() {
    if (state.error) {
      return element("p", { className: "error", role: "alert" }, message(state.error));
    }
    if (!state.status) {
      return element("p", { className: "muted" }, "Deployment status has not loaded.");
    }
    return element(
      "div",
      {},
      element(
        "dl",
        { className: "credential-status-list" },
        element("dt", {}, "Status"),
        element("dd", {}, state.status.status),
        element("dt", {}, "Deployment"),
        element("dd", {}, state.status.deploymentId),
      ),
      deploymentFailure(state.status.error),
    );
  }

  function render() {
    section.replaceChildren(
      element("h2", {}, "Deployment status"),
      element(
        "p",
        { className: "muted" },
        "Startup evidence is read from the durable deployment record.",
      ),
      renderStatus(),
      element(
        "div",
        { className: "form-actions credential-actions" },
        button(state.loading ? "Refreshing..." : "Refresh deployment", () => void loadStatus(), {
          disabled: state.loading,
        }),
      ),
    );
  }

  render();
  void loadStatus();
  return section;
}

export async function renderAgentDetail(context) {
  const { view, namespaceId, agentId, request, url } = context;
  const path = `${namespacePath(namespaceId)}/agents/${encodeURIComponent(agentId)}`;
  const agent = await request(path);
  if (!context.isCurrent()) {
    return;
  }
  context.setTitle(agent.name);
  let deleting = agent.status === "deleting";
  const selected = url.searchParams.get("revision") ?? agent.activeRevisionId ?? "draft";
  const tab = url.searchParams.get("tab");
  const tabsForSelection = [
    "configuration",
    "channels",
    ...(selected === "draft" ? ["credentials"] : []),
    "workspace",
  ];
  let selectedTab = tabsForSelection.includes(tab) ? tab : "configuration";
  const target = (revision = selected, tab = selectedTab) =>
    `agents/${agentId}?revision=${encodeURIComponent(revision)}&tab=${tab}`;
  const change = (revision, tab) => {
    if (draftEditorBlocksNavigation()) {
      showDraftEditorNavigationBlock();
      return;
    }
    context.navigate(target(revision, tab));
  };
  const header = element(
    "div",
    { className: "agent-toolbar" },
    link("← Agents", "agents", context),
    element(
      "span",
      { className: "badge" },
      agent.activeRevisionId
        ? `Selected revision · ${shortId(agent.activeRevisionId)}`
        : "No selected revision",
    ),
  );
  const identity = element("p", { className: "resource-id" }, agent.id);
  const stop = createAgentStop(context, path, agent, showDeleting, () =>
    context.navigate(target(selected, selectedTab), namespaceId, true),
  );
  const deletion = createAgentDeletion(context, path, agent, showDeleting);
  function showDeleting() {
    deleting = true;
    header.lastChild.textContent = "Deleting";
    view.replaceChildren(header, identity, deletion);
  }
  if (deleting) {
    showDeleting();
    return;
  }
  const selector = element("section", { className: "agent-card revision-selector" });
  const content = element("div");
  const tabControls = new Map();
  const revisionControls = new Map();
  let draftEditorNavigationBlock = null;
  let showDraftEditorNavigationBlock = () => {};
  function draftEditorBlocksNavigation() {
    return selected === "draft" && selectedTab === "configuration" && draftEditorNavigationBlock;
  }
  function trackRevisionControl(control) {
    revisionControls.set(control, control.disabled);
  }
  function updateNavigationControls() {
    const blocked = Boolean(draftEditorBlocksNavigation());
    for (const [id, control] of tabControls) {
      control.disabled = blocked && id !== selectedTab;
    }
    for (const [control, originallyDisabled] of revisionControls) {
      control.disabled = blocked || originallyDisabled;
    }
  }
  const tabs = element("nav", {
    className: "agent-tabs",
    "aria-label": "Agent configuration views",
  });
  for (const [id, label] of [
    ["configuration", "Configuration"],
    ["channels", "Channels"],
    ...(selected === "draft" ? [["credentials", "Credentials"]] : []),
    ["workspace", "Workspace files"],
  ]) {
    const control = button(
      label,
      () => {
        if (id === selectedTab) {
          return;
        }
        if (draftEditorBlocksNavigation()) {
          showDraftEditorNavigationBlock();
          return;
        }
        change(selected, id);
      },
      {
        ...(id === selectedTab ? { "aria-current": "page" } : {}),
      },
    );
    tabControls.set(id, control);
    tabs.append(control);
  }
  const deploymentStatus =
    selected === "draft" ? [] : [createDeploymentStatusPanel(context, path, selected)];
  view.replaceChildren(
    header,
    identity,
    ...deploymentStatus,
    renderNativeAdminAccess(context, path),
    selector,
    tabs,
    content,
  );
  let details;
  let tabGeneration = 0;

  async function loadDetails() {
    const results = await Promise.allSettled([
      request(`${path}/revisions`),
      request(
        selected === "draft"
          ? `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(agent.configurationId)}`
          : `${path}/revisions/${encodeURIComponent(selected)}`,
      ),
    ]);
    if (!context.isCurrent() || deleting) {
      return;
    }
    if (results.some((result) => result.status === "rejected" && result.reason.status === 401)) {
      context.onExpired();
      return;
    }
    const revisionResult = results[0];
    const revisions =
      revisionResult.status === "fulfilled"
        ? [...revisionResult.value].sort((a, b) => b.revision - a.revision)
        : [];
    let snapshot = results[1].status === "fulfilled" ? results[1].value : null;
    const activeRevision = revisions.find((revision) => revision.id === agent.activeRevisionId);
    if (activeRevision) {
      header.lastChild.textContent = `Selected revision · v${activeRevision.revision}`;
    }
    const chooser = element(
      "select",
      { id: "revision-selector", "aria-label": "AgentRevision" },
      element("option", { value: "draft" }, "New revision · editable Configuration"),
    );
    for (const revision of revisions) {
      chooser.append(
        element(
          "option",
          { value: revision.id },
          `v${revision.revision} · ${displayDate(revision.createdAt)} · ${revision.id === agent.activeRevisionId ? "Selected by Agent" : "Not selected by Agent"}`,
        ),
      );
    }
    if (selected !== "draft" && !revisions.some((revision) => revision.id === selected)) {
      chooser.append(
        element(
          "option",
          { value: selected },
          snapshot ? `v${snapshot.revision} · Viewed snapshot` : "Viewed snapshot unavailable",
        ),
      );
    }
    chooser.value = selected;
    chooser.addEventListener("change", () => {
      const nextRevision = chooser.value;
      if (draftEditorBlocksNavigation()) {
        chooser.value = selected;
        showDraftEditorNavigationBlock();
        return;
      }
      change(nextRevision);
    });
    trackRevisionControl(chooser);
    const position = revisions.findIndex((revision) => revision.id === selected);
    const older = button("Older revision", () => change(revisions[position + 1].id));
    older.disabled = position < 0 || position >= revisions.length - 1;
    trackRevisionControl(older);
    const newer = button("Newer revision", () => change(revisions[position - 1].id));
    newer.disabled = position <= 0;
    trackRevisionControl(newer);
    const newRevision = button("New revision", () => change("draft"));
    trackRevisionControl(newRevision);
    const currentRevision = agent.activeRevisionId
      ? button("View current revision", () => change(agent.activeRevisionId))
      : null;
    if (currentRevision) {
      trackRevisionControl(currentRevision);
    }
    selector.append(
      ...[
        element(
          "h2",
          {},
          selected === "draft"
            ? "New revision"
            : snapshot
              ? `AgentRevision v${snapshot.revision}`
              : "AgentRevision unavailable",
        ),
        revisions.length || selected !== "draft"
          ? element("label", { for: "revision-selector" }, "AgentRevision")
          : null,
        revisions.length || selected !== "draft" ? chooser : null,
        element(
          "div",
          { className: "form-actions" },
          selected !== "draft" && revisions.length > 1 ? older : null,
          selected !== "draft" && revisions.length > 1 ? newer : null,
          selected !== "draft" ? newRevision : null,
          agent.activeRevisionId && selected !== agent.activeRevisionId ? currentRevision : null,
        ),
      ].filter(Boolean),
    );
    if (revisionResult.status === "rejected") {
      selector.append(
        element(
          "p",
          { className: "error", role: "alert" },
          `Revision history unavailable. ${message(revisionResult.reason)}`,
        ),
      );
    } else if (!revisions.length) {
      selector.append(
        element(
          "p",
          { className: "muted" },
          "No readable AgentRevisions. Creation alone does not create a revision.",
        ),
      );
    }
    if (!snapshot) {
      return { error: results[1].reason };
    }
    const draft = selected === "draft";
    let values = draft ? snapshot.values : snapshot.configuration;
    const executionMode = draft ? agent.executionMode : snapshot.harness.mode;
    let deploy;
    let deployPending = false;
    let deployStatus;
    const draftEditorState = {
      dirty: false,
      saving: false,
      outcomeUnknown: false,
      reloadRequired: false,
    };
    const runtimeAuth = agent.harnessAuth?.method === "runtime";
    const credentials =
      draft && !runtimeAuth
        ? createRuntimeCredentialsPanel({
            context,
            path,
            agent,
            configuration: snapshot,
            values,
            revisionsLoaded: revisionResult.status === "fulfilled",
            revisionCount: revisions.length,
            onStatusChange: updateDeployControls,
            onConfigurationChange(configuration) {
              snapshot = configuration;
              values = configuration.values;
            },
          })
        : null;
    function updateDeployControls() {
      if (!deploy || !deployStatus) {
        return;
      }
      deploy.disabled =
        deployPending ||
        draftEditorState.dirty ||
        draftEditorState.saving ||
        draftEditorState.outcomeUnknown ||
        draftEditorState.reloadRequired ||
        !agent.harnessAuth ||
        revisionResult.status !== "fulfilled" ||
        (!runtimeAuth && !credentials?.canDeploy());
      if (!deployPending) {
        if (draftEditorState.outcomeUnknown) {
          deployStatus.textContent =
            "Refresh this draft before deploying because the last Configuration save outcome is unknown.";
        } else if (draftEditorState.reloadRequired) {
          deployStatus.textContent = "Reload this draft before deploying.";
        } else if (draftEditorState.saving) {
          deployStatus.textContent = "Wait for Configuration save to finish before deploying.";
        } else if (draftEditorState.dirty) {
          deployStatus.textContent = "Save or cancel Configuration edits before deploying.";
        } else if (revisionResult.status !== "fulfilled") {
          deployStatus.textContent =
            "Revision history is required before deploying this new revision.";
        } else if (runtimeAuth) {
          deployStatus.textContent =
            "Configured on the runtime host; not validated by OCC. Gateway readiness does not confirm model access.";
        } else {
          deployStatus.textContent = agent.harnessAuth
            ? credentials.deployGateMessage()
            : "Select a harness authentication source in Credentials before deployment.";
        }
      }
    }
    if (draft) {
      deployStatus = element("p", { className: "muted", role: "status" });
      deploy = button("Deploy new revision", async () => {
        deploy.disabled = true;
        deployPending = true;
        deployStatus.textContent = "Checking Configuration…";
        let submitted = false;
        try {
          const [freshAgent, freshConfig, freshCredentials] = await Promise.all([
            request(path),
            request(
              `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(snapshot.id)}`,
            ),
            runtimeAuth ? Promise.resolve(null) : request(`${path}/runtime-credentials`),
          ]);
          if (!context.isCurrent()) {
            return;
          }
          if (
            freshAgent.configurationId !== snapshot.id ||
            JSON.stringify(freshAgent.harnessAuth) !== JSON.stringify(agent.harnessAuth) ||
            freshConfig.generation !== snapshot.generation
          ) {
            deployStatus.textContent = "The Configuration changed. Refresh before deploying.";
            return;
          }
          const credentialBlockReason = runtimeCredentialBlockReason(freshConfig.values);
          if (credentialBlockReason !== null) {
            deployStatus.textContent = credentialBlockReason;
            return;
          }
          if (
            !runtimeAuth &&
            !hasRequiredRuntimeCredentials(freshCredentials, freshConfig.values, freshConfig)
          ) {
            deployStatus.textContent =
              "Runtime credential metadata changed. Refresh status before deploying.";
            return;
          }
          submitted = true;
          deployStatus.textContent = "Requesting deployment…";
          const revision = await request(`${path}/deploy`, { method: "POST" });
          if (context.isCurrent()) {
            change(revision.id, "workspace");
          }
        } catch (error) {
          if (!context.isCurrent()) {
            return;
          }
          if (error.status === 401) {
            context.onExpired();
            return;
          }
          deployStatus.textContent = message(error, submitted);
          if (!submitted || [400, 403, 404, 409, 429].includes(error.status)) {
            deployPending = false;
          }
        } finally {
          if (context.isCurrent()) {
            if (!submitted) {
              deployPending = false;
            }
            updateDeployControls();
          }
        }
      });
      updateDeployControls();
      if (credentials) {
        void credentials.loadStatus();
      }
      selector.append(
        element(
          "p",
          { className: "muted" },
          "Deploy the saved Configuration to create an immutable revision. Workspace files become available when its gateway is ready.",
        ),
        deploy,
        deployStatus,
      );
    }
    if (!draft) {
      selector.append(element("p", { className: "resource-id" }, snapshot.id));
    }
    selector.append(
      element(
        "p",
        { className: "muted" },
        `${draft ? "Configuration" : "Source Configuration"} ${draft ? snapshot.id : snapshot.configurationId} · generation ${draft ? snapshot.generation : snapshot.configurationGeneration}`,
      ),
    );
    return {
      get snapshot() {
        return snapshot;
      },
      get values() {
        return values;
      },
      draft,
      executionMode,
      credentials,
      setDraftEditorState(nextState) {
        Object.assign(draftEditorState, nextState);
        draftEditorNavigationBlock = draftEditorState.outcomeUnknown
          ? "Outcome unknown. Reload this draft before leaving the editor."
          : draftEditorState.reloadRequired
            ? "Reload this draft before leaving the editor."
            : draftEditorState.saving
              ? "Wait for Configuration save to finish before leaving the editor."
              : draftEditorState.dirty
                ? "Save or cancel Configuration edits before leaving this tab."
                : null;
        updateNavigationControls();
        updateDeployControls();
      },
    };
  }

  async function renderTab() {
    const activeTab = ++tabGeneration;
    const tabContext = {
      ...context,
      isCurrent: () => context.isCurrent() && activeTab === tabGeneration,
    };
    const tab = selectedTab;
    for (const [index, id] of tabsForSelection.entries()) {
      const control = tabs.children[index];
      if (id === tab) {
        control.setAttribute("aria-current", "page");
      } else {
        control.removeAttribute("aria-current");
      }
    }
    content.querySelectorAll('input[type="password"]').forEach((input) => {
      input.value = "";
    });
    // Retain the panel's height during reads so loading does not jump the scroll position.
    content.style.minHeight = `${content.getBoundingClientRect().height}px`;
    content.replaceChildren();
    if (tab === "workspace") {
      content.append(renderWorkspaceFiles(tabContext, agent, path));
      content.style.minHeight = "";
      return;
    }
    content.append(element("p", { role: "status" }, "Loading configuration…"));
    const data = await (details ??= loadDetails());
    if (!tabContext.isCurrent() || deleting) {
      return;
    }
    content.replaceChildren();
    if (data?.error) {
      content.append(errorPanel(data.error, tabContext, () => change(selected)));
    } else if (data) {
      renderConfigurationTab(tabContext, tab, data);
    }
    content.style.minHeight = "";
  }

  function renderConfigurationTab(context, selectedTab, data) {
    const { snapshot, values, draft, executionMode, credentials } = data;
    content.append(
      element(
        "p",
        { className: "notice", role: "status" },
        draft
          ? "New revision. Changes affect future deployments using this Configuration. Admitted AgentRevisions stay unchanged."
          : selected === agent.activeRevisionId
            ? "Selected AgentRevision · read-only admitted snapshot. Selection does not confirm that this revision is serving."
            : "Unselected AgentRevision · read-only admitted snapshot. Browsing this snapshot does not change the Agent's selected revision.",
      ),
    );
    if (selectedTab === "channels") {
      const channels = renderChannels({
        values,
        executionMode,
        readOnly: !draft,
        drawerContext: {
          namespaceId,
          request,
          agentName: agent.name,
          secretBindings: snapshot.secretBindings,
          credentialsHref: context.pageUrl(
            `agents/${agent.id}?revision=draft&tab=credentials`,
            namespaceId,
          ),
        },
        onSave: async (updatedValues, options = {}) => {
          let mutationStarted = false;
          let configurationSaved = false;
          try {
            const [freshAgent, freshConfig] = await Promise.all([
              request(path),
              request(
                `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(snapshot.id)}`,
              ),
            ]);
            if (!context.isCurrent()) {
              throw new Error("This view has changed. Reopen the Configuration before saving.");
            }
            if (
              freshAgent.configurationId !== snapshot.id ||
              freshConfig.generation !== snapshot.generation
            ) {
              throw new Error(
                "The saved Configuration changed while you were editing. Close this editor and refresh before saving.",
              );
            }
            mutationStarted = true;
            const nextSecretBindings = options.secretBindings;
            await request(
              `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(snapshot.id)}`,
              {
                method: "PATCH",
                body: {
                  values: updatedValues,
                  ...(nextSecretBindings === undefined
                    ? {}
                    : { secretBindings: nextSecretBindings }),
                },
              },
            );
            configurationSaved = true;
            details = null;
            try {
              if (options.changedSecrets !== undefined) {
                for (const secret of options.changedSecrets) {
                  await ensureSecretOperateBinding(context, freshAgent, secret);
                }
              }
            } catch (error) {
              error.message =
                "Configuration saved, but Secret access grants could not be confirmed. Open Agent Credentials to inspect saved bindings, then ask a Namespace administrator to grant this Agent access to the saved Secret.";
              error.outcomeUnknown = true;
              throw error;
            }
            if (context.isCurrent()) {
              change("draft", "channels");
            }
          } catch (error) {
            if (!context.isCurrent()) {
              throw error;
            }
            if (error.status === 401) {
              context.onExpired();
              throw new Error("Your session has expired.");
            }
            if (
              error.status !== undefined ||
              error.name === "TimeoutError" ||
              error.name === "TypeError"
            ) {
              if (!configurationSaved) {
                error.message = message(error, mutationStarted);
              }
            }
            error.outcomeUnknown =
              error.outcomeUnknown ??
              (mutationStarted && ![400, 403, 404, 409, 429].includes(error.status));
            throw error;
          }
        },
      });
      content.append(channels);
    } else if (selectedTab === "credentials" && draft) {
      const auth = createHarnessAuthFields(context, agent.harnessAuth, agent.executionMode);
      const feedback = element("p", { role: "status", className: "hint" });
      const save = element(
        "button",
        { type: "submit", className: "primary" },
        "Save authentication source",
      );
      const form = element("form", { className: "agent-card" }, auth.section, save, feedback);
      let outcomeUnknown = false;
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity() || save.disabled) {
          return;
        }
        save.disabled = true;
        auth.setDisabled(true);
        let mutationStarted = false;
        try {
          const harnessAuth = await auth.readBinding();
          const current = await request(path);
          if (!context.isCurrent()) {
            return;
          }
          if (
            current.configurationId !== agent.configurationId ||
            JSON.stringify(current.harnessAuth) !== JSON.stringify(agent.harnessAuth)
          ) {
            feedback.textContent =
              "The Configuration changed. Refresh before saving authentication.";
            return;
          }
          mutationStarted = true;
          await request(path, {
            method: "PATCH",
            body: { configurationId: agent.configurationId, harnessAuth },
          });
          if (context.isCurrent()) {
            change("draft", "credentials");
          }
        } catch (error) {
          if (!context.isCurrent()) {
            return;
          }
          if (error.status === 401) {
            context.onExpired();
          } else {
            feedback.textContent = message(error, mutationStarted);
            outcomeUnknown = mutationStarted && ![400, 403, 404, 409, 429].includes(error.status);
          }
        } finally {
          if (context.isCurrent()) {
            save.disabled = outcomeUnknown;
            auth.setDisabled(outcomeUnknown);
          }
        }
      });
      content.append(form);
      if (credentials) {
        content.append(credentials.section);
      }
    } else {
      const repositoryBindings = draft
        ? agent.repositoryBindings
        : snapshot.repositoryCredentials?.bindings;
      const details = [
        ["Execution mode", executionMode === "dedicated" ? "Dedicated" : "Embedded"],
        ["Backend (experimental)", draft ? agent.backendId : snapshot.backendId],
        [
          "Repository access",
          repositoryBindings
            ?.map(
              (binding) =>
                `${binding.repositoryRef} · ${repositoryProfile(binding.profile)?.label ?? "Unknown access level"}`,
            )
            .join(", ") ?? "None",
        ],
        [
          "Harness authentication",
          harnessAuthDescription(draft ? agent.harnessAuth : snapshot.harnessAuth),
        ],
        ["Created", displayDate(snapshot.createdAt)],
      ];
      if (!draft) {
        details.push(
          ["Harness", `${snapshot.harness.id} · ${snapshot.harness.version}`],
          ["Compute", `${snapshot.compute.id} · ${snapshot.compute.implementation}`],
        );
      }
      content.append(
        element(
          "section",
          { className: "agent-card" },
          element("h2", {}, draft ? "Configuration draft" : "Configuration snapshot"),
          summary(values, details),
          repositoryBindings?.some((binding) => repositoryProfile(binding.profile)?.writes)
            ? element("p", { className: "hint repository-write-access" }, repositoryWriteAccessHelp)
            : null,
          draft
            ? renderDraftConfigurationEditor(context, data)
            : element(
                "div",
                {},
                element(
                  "div",
                  { className: "form-actions" },
                  button("Edit current Configuration", () => change("draft", "configuration")),
                ),
                nativeDocument(values, "View admitted native configuration"),
              ),
        ),
      );
    }
  }

  function renderDraftConfigurationEditor(context, data) {
    const { snapshot, values, setDraftEditorState } = data;
    const container = element("div", { className: "configuration-draft-editor" });
    let editing = false;
    let pending = false;
    let outcomeUnknown = false;
    let reloadRequired = false;
    const initialText = JSON.stringify(values, null, 2);
    const editor = element("textarea", {
      id: "configuration-json",
      name: "configuration",
      required: "",
      rows: "18",
      className: "configuration-editor",
      spellcheck: "false",
      "aria-describedby": "configuration-json-hint",
    });
    editor.value = initialText;
    const feedback = element("p", { className: "hint", role: "status" });
    let feedbackLocked = false;
    const edit = button("Edit Configuration", () => {
      editing = true;
      render();
    });
    const save = button("Save Configuration", () => void saveConfiguration(), {
      className: "primary",
    });
    const cancel = button("Cancel", () => {
      editing = false;
      editor.value = initialText;
      editor.setCustomValidity("");
      feedback.textContent = "";
      reloadRequired = false;
      setDraftEditorState({
        dirty: false,
        saving: false,
        outcomeUnknown: false,
        reloadRequired: false,
      });
      render();
    });
    const reload = button("Reload draft", () => {
      context.navigate(target("draft", "configuration"), namespaceId, true);
    });

    function currentDirty() {
      return editor.value !== initialText;
    }

    function parseEditor(reportInvalid = false) {
      try {
        const parsed = JSON.parse(editor.value);
        if (!isPlainObject(parsed)) {
          throw new Error();
        }
        return parsed;
      } catch {
        if (reportInvalid) {
          editor.setCustomValidity("Enter a valid JSON object.");
          editor.reportValidity();
          feedback.textContent = "Enter a valid Configuration JSON object.";
          feedbackLocked = true;
        }
        return undefined;
      }
    }

    function updateState() {
      const dirty = editing && currentDirty();
      setDraftEditorState({
        dirty,
        saving: pending,
        outcomeUnknown,
        reloadRequired,
      });
      save.disabled = pending || outcomeUnknown || reloadRequired || !dirty;
      cancel.disabled = pending || outcomeUnknown || reloadRequired;
      edit.disabled = pending || outcomeUnknown;
      editor.readOnly = pending || outcomeUnknown || reloadRequired;
      if (outcomeUnknown) {
        feedback.textContent =
          "Outcome unknown. Configuration may have been saved. Reload this draft before saving again.";
        feedbackLocked = true;
      } else if (reloadRequired) {
        if (!feedbackLocked) {
          feedback.textContent = "Reload this draft before saving again.";
        }
        feedbackLocked = true;
      } else if (pending) {
        if (!feedbackLocked) {
          feedback.textContent = "Checking Configuration…";
        }
      } else if (dirty) {
        if (!feedbackLocked) {
          feedback.textContent = "Save or cancel these Configuration edits before deploying.";
        }
      } else if (!pending && editing) {
        if (!feedbackLocked) {
          feedback.textContent = "No Configuration changes to save.";
        }
      }
    }

    editor.addEventListener("input", () => {
      editor.setCustomValidity("");
      feedback.textContent = "";
      feedbackLocked = false;
      reloadRequired = false;
      updateState();
    });
    showDraftEditorNavigationBlock = () => {
      if (draftEditorNavigationBlock) {
        feedback.textContent = draftEditorNavigationBlock;
        feedbackLocked = true;
      }
    };

    async function saveConfiguration() {
      if (pending || outcomeUnknown || !currentDirty()) {
        return;
      }
      const nextValues = parseEditor(true);
      if (nextValues === undefined) {
        updateState();
        return;
      }
      pending = true;
      feedback.textContent = "Checking Configuration…";
      feedbackLocked = true;
      updateState();
      let mutationStarted = false;
      try {
        const [freshAgent, freshConfig] = await Promise.all([
          request(path),
          request(
            `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(snapshot.id)}`,
          ),
        ]);
        if (!context.isCurrent()) {
          return;
        }
        if (
          freshAgent.configurationId !== snapshot.id ||
          freshConfig.generation !== snapshot.generation
        ) {
          feedback.textContent =
            "The saved Configuration changed while you were editing. Reload this draft before saving.";
          feedbackLocked = true;
          reloadRequired = true;
          return;
        }
        mutationStarted = true;
        await request(
          `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(snapshot.id)}`,
          {
            method: "PATCH",
            body: { values: nextValues },
          },
        );
        if (context.isCurrent()) {
          context.navigate(target("draft", "configuration"), namespaceId, true);
        }
      } catch (error) {
        if (!context.isCurrent()) {
          return;
        }
        if (error.status === 401) {
          context.onExpired();
          return;
        }
        feedback.textContent = message(error, mutationStarted);
        feedbackLocked = true;
        outcomeUnknown = mutationStarted && ![400, 403, 404, 409, 429].includes(error.status);
      } finally {
        if (context.isCurrent()) {
          pending = false;
          updateState();
          render();
        }
      }
    }

    function render() {
      if (!editing) {
        container.replaceChildren(
          element("div", { className: "form-actions" }, edit),
          nativeDocument(values, "View native Configuration"),
        );
        return;
      }
      updateState();
      container.replaceChildren(
        element(
          "div",
          { className: "form-field" },
          element("label", { for: "configuration-json" }, "Configuration JSON"),
          editor,
          element(
            "p",
            { className: "hint", id: "configuration-json-hint" },
            "Edit native JSON values for future deployments. Secret bindings are preserved separately.",
          ),
        ),
        element(
          "div",
          { className: "form-actions" },
          save,
          cancel,
          outcomeUnknown || reloadRequired ? reload : null,
        ),
        feedback,
      );
    }

    render();
    return container;
  }

  view.append(stop, deletion);
  context.setTabNavigation((next) => {
    const nextRevision = next.searchParams.get("revision") ?? agent.activeRevisionId ?? "draft";
    const nextTab = tabsForSelection.includes(next.searchParams.get("tab"))
      ? next.searchParams.get("tab")
      : "configuration";
    if (
      !context.isCurrent() ||
      deleting ||
      next.pathname !== url.pathname ||
      next.searchParams.get("namespace") !== namespaceId ||
      (nextRevision === selected && nextTab === selectedTab)
    ) {
      return false;
    }
    if (draftEditorBlocksNavigation()) {
      history.replaceState(
        history.state,
        "",
        context.pageUrl(target(selected, selectedTab), namespaceId),
      );
      showDraftEditorNavigationBlock();
      return true;
    }
    if (nextRevision !== selected) {
      return false;
    }
    selectedTab = nextTab;
    void renderTab();
    return true;
  });
  await renderTab();
}
