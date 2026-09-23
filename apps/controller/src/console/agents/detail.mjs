import { element, button } from "../dom.mjs";
import { createHarnessAuthFields, harnessAuthDescription } from "./harness-auth.mjs";
import { renderNativeAdminAccess } from "./native-admin.mjs";
import { createAgentDeletion } from "./deletion.mjs";
import { createAgentStop } from "./stop.mjs";
import { renderChannels } from "../channels.mjs";
import { renderWorkspaceFiles } from "./workspace.mjs";
import { displayDate, shortId, namespacePath, link, message } from "./list.mjs";
import {
  createRuntimeCredentialsPanel,
  hasRequiredRuntimeCredentials,
  runtimeCredentialBlockReason,
} from "./credentials.mjs";

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
  const change = (revision, tab) => context.navigate(target(revision, tab));
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
    tabs.append(
      button(
        label,
        () => {
          if (id !== selectedTab) {
            change(selected, id);
          }
        },
        {
          ...(id === selectedTab ? { "aria-current": "page" } : {}),
        },
      ),
    );
  }
  const deploymentStatus =
    selected === "draft" ? [] : [createDeploymentStatusPanel(context, path, selected)];
  view.replaceChildren(
    header,
    identity,
    ...deploymentStatus,
    stop,
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
    chooser.addEventListener("change", () => change(chooser.value));
    const position = revisions.findIndex((revision) => revision.id === selected);
    const older = button("Older revision", () => change(revisions[position + 1].id));
    older.disabled = position < 0 || position >= revisions.length - 1;
    const newer = button("Newer revision", () => change(revisions[position - 1].id));
    newer.disabled = position <= 0;
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
          selected !== "draft" ? button("New revision", () => change("draft")) : null,
          agent.activeRevisionId && selected !== agent.activeRevisionId
            ? button("View selected revision", () => change(agent.activeRevisionId))
            : null,
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
        !agent.harnessAuth ||
        revisionResult.status !== "fulfilled" ||
        (!runtimeAuth && !credentials?.canDeploy());
      if (!deployPending) {
        if (revisionResult.status !== "fulfilled") {
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
        onSave: async (updatedValues) => {
          let mutationStarted = false;
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
            await request(
              `${namespacePath(namespaceId)}/configurations/${encodeURIComponent(snapshot.id)}`,
              {
                method: "PATCH",
                body: { values: updatedValues },
              },
            );
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
              error.message = message(error, mutationStarted);
            }
            error.outcomeUnknown =
              mutationStarted && ![400, 403, 404, 409, 429].includes(error.status);
            throw error;
          }
        },
      });
      content.append(channels);
    } else if (selectedTab === "credentials" && draft) {
      const auth = createHarnessAuthFields(context, agent.harnessAuth);
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
      const details = [
        ["Execution mode", executionMode === "dedicated" ? "Dedicated" : "Embedded"],
        ["Provider", draft ? agent.providerId : snapshot.providerId],
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
          nativeDocument(
            values,
            draft ? "View native Configuration" : "View admitted native configuration",
          ),
        ),
      );
    }
  }
  view.append(deletion);
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
      nextRevision !== selected ||
      nextTab === selectedTab
    ) {
      return false;
    }
    selectedTab = nextTab;
    void renderTab();
    return true;
  });
  await renderTab();
}
