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

const OAUTH_STATUS_POLL_MS = 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function oauthFailureMessage(reason) {
  if (reason === "denied") {
    return "Authorization was denied at the provider.";
  }
  if (reason === "expired") {
    return "Authorization expired. Start a new OAuth attempt to continue.";
  }
  if (reason === "cancelled") {
    return "Authorization was cancelled.";
  }
  if (reason === "account_mismatch") {
    return "The authorized provider account does not match this Agent binding.";
  }
  return "OAuth authorization is unavailable. Retry after the runtime is ready.";
}

function oauthVerificationLink(observation) {
  try {
    const url = new URL(observation.verificationUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return element("span", {}, observation.verificationUrl);
    }
    return element(
      "a",
      {
        href: url.toString(),
        target: "_blank",
        rel: "noreferrer noopener",
      },
      observation.verificationUrl,
    );
  } catch {
    return element("span", {}, observation.verificationUrl);
  }
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
  let oauthActivationGeneration = 0;
  function startOAuthActivationRun() {
    oauthActivationGeneration += 1;
    return oauthActivationGeneration;
  }
  function cancelOAuthActivationRun() {
    oauthActivationGeneration += 1;
  }
  function oauthActivationCurrent(generation) {
    return context.isCurrent() && generation === oauthActivationGeneration;
  }
  function onStoppedAgentChanged() {
    cancelOAuthActivationRun();
    context.navigate(target(selected, selectedTab), namespaceId, true);
  }
  let stop = createAgentStop(context, path, agent, showDeleting, onStoppedAgentChanged);
  function updateOAuthStopPanel(current) {
    const next = createAgentStop(context, path, current, showDeleting, onStoppedAgentChanged);
    stop.replaceWith(next);
    stop = next;
  }
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
    const oauthAuth = agent.harnessAuth?.method === "oauth";
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
        } else if (oauthAuth && credentials?.canDeploy()) {
          deployStatus.textContent =
            "Deploy prepares the Agent runtime, then starts OpenAI OAuth authorization. Stop the Agent to cancel or reconnect.";
        } else {
          deployStatus.textContent = agent.harnessAuth
            ? credentials.deployGateMessage()
            : "Select a harness authentication source in Credentials before deployment.";
        }
      }
    }
    if (draft) {
      deployStatus = element("p", { className: "muted", role: "status" });
      const oauthPanel = element("div", { className: "oauth-activation", hidden: true });

      function renderDeploymentFailure(status) {
        const detail = status.error?.message ?? "The deployment failed before activation.";
        oauthPanel.replaceChildren(
          element("h3", {}, "OAuth authorization unavailable"),
          element("p", { className: "error", role: "alert" }, detail),
        );
      }

      async function readDeploymentStatus(revisionId, generation) {
        if (!oauthActivationCurrent(generation)) {
          return null;
        }
        const status = await request(`${path}/deployments/${encodeURIComponent(revisionId)}`);
        if (!oauthActivationCurrent(generation)) {
          return null;
        }
        if (status.status === "failed") {
          renderDeploymentFailure(status);
          return null;
        }
        return status;
      }

      async function waitForDeployment(revisionId, target, generation) {
        while (oauthActivationCurrent(generation)) {
          const status = await readDeploymentStatus(revisionId, generation);
          if (status === null) {
            return null;
          }
          if (target === "runtime" && status.status !== "queued") {
            return status;
          }
          if (target === "succeeded" && status.status === "succeeded") {
            return status;
          }
          deployStatus.textContent =
            target === "runtime"
              ? "Waiting for the OAuth runtime to prepare…"
              : "OAuth committed. Waiting for deployment activation…";
          await delay(OAUTH_STATUS_POLL_MS);
        }
        return null;
      }

      async function stopOAuthActivation(onAccepted) {
        cancelOAuthActivationRun();
        deployStatus.textContent = "Stopping Agent to cancel OAuth authorization…";
        try {
          const stopped = await request(`${path}/stop`, { method: "POST" });
          if (context.isCurrent()) {
            updateOAuthStopPanel(stopped);
            deployPending = false;
            updateDeployControls();
            onAccepted();
          }
        } catch (error) {
          if (!context.isCurrent()) {
            return;
          }
          if (error.status === 401) {
            context.onExpired();
            return;
          }
          deployPending = false;
          updateDeployControls();
          deployStatus.textContent = `Agent stop request failed. ${message(error, true)}`;
        }
      }

      function renderOAuthObservation(observation, revisionId) {
        oauthPanel.hidden = false;
        if (observation.phase === "waiting") {
          oauthPanel.replaceChildren(
            element("h3", {}, "Authorize OpenAI"),
            element(
              "p",
              { className: "muted" },
              "Use this provider page and code to authorize the Agent. The Console keeps them only on this page.",
            ),
            element(
              "dl",
              { className: "oauth-code-list" },
              element("dt", {}, "Provider page"),
              element("dd", {}, oauthVerificationLink(observation)),
              element("dt", {}, "User code"),
              element("dd", {}, element("code", {}, observation.userCode)),
              element("dt", {}, "Expires"),
              element("dd", {}, displayDate(observation.expiresAt)),
            ),
            element(
              "div",
              { className: "form-actions credential-actions" },
              button("Stop Agent", () =>
                stopOAuthActivation(() => {
                  oauthPanel.replaceChildren(
                    element("h3", {}, "OAuth authorization cancelled"),
                    element(
                      "p",
                      { className: "muted" },
                      "The Agent stop request was accepted. Refresh deployment status before retrying.",
                    ),
                  );
                }),
              ),
            ),
          );
          return;
        }
        if (observation.phase === "failed") {
          oauthPanel.replaceChildren(
            element("h3", {}, "OAuth authorization failed"),
            element(
              "p",
              { className: "error", role: "alert" },
              oauthFailureMessage(observation.reason),
            ),
            element(
              "div",
              { className: "form-actions credential-actions" },
              button("Retry OAuth authorization", async () => {
                if (!context.isCurrent()) {
                  return;
                }
                const generation = startOAuthActivationRun();
                deployPending = true;
                updateDeployControls();
                await runOAuthActivation(revisionId, generation);
              }),
              button("Stop Agent", () =>
                stopOAuthActivation(() => {
                  deployStatus.textContent = "Agent stop request accepted.";
                }),
              ),
            ),
          );
          deployPending = false;
          updateDeployControls();
          return;
        }
        const text =
          observation.phase === "authorized"
            ? "Provider authorization completed. Committing the Agent-local profile…"
            : observation.phase === "committed"
              ? "OAuth profile committed. Waiting for deployment activation…"
              : "Preparing OAuth authorization…";
        oauthPanel.replaceChildren(
          element("h3", {}, "OAuth authorization"),
          element("p", {}, text),
        );
      }

      async function deploymentSucceededAfterAuthRace(revisionId, generation) {
        if (!oauthActivationCurrent(generation)) {
          return false;
        }
        try {
          const status = await request(`${path}/deployments/${encodeURIComponent(revisionId)}`);
          return oauthActivationCurrent(generation) && status.status === "succeeded";
        } catch {
          return false;
        }
      }

      async function oauthOperationOrAcceptActivated(revisionId, operation, generation) {
        if (!oauthActivationCurrent(generation)) {
          return { cancelled: true };
        }
        try {
          const observation = await operation();
          if (!oauthActivationCurrent(generation)) {
            return { cancelled: true };
          }
          return {
            activated: false,
            observation,
          };
        } catch (error) {
          if (!oauthActivationCurrent(generation)) {
            return { cancelled: true };
          }
          if (error.status === 401) {
            throw error;
          }
          if (await deploymentSucceededAfterAuthRace(revisionId, generation)) {
            return { activated: true };
          }
          throw error;
        }
      }

      async function startOAuthOrAcceptActivated(revisionId, generation) {
        return oauthOperationOrAcceptActivated(
          revisionId,
          () =>
            request(`${path}/deployments/${encodeURIComponent(revisionId)}/auth`, {
              method: "POST",
            }),
          generation,
        );
      }

      async function readOAuthOrAcceptActivated(revisionId, generation) {
        return oauthOperationOrAcceptActivated(
          revisionId,
          () => request(`${path}/deployments/${encodeURIComponent(revisionId)}/auth`),
          generation,
        );
      }

      async function completeOAuthOrAcceptActivated(revisionId, attemptId, generation) {
        return oauthOperationOrAcceptActivated(
          revisionId,
          () =>
            request(`${path}/deployments/${encodeURIComponent(revisionId)}/auth/complete`, {
              method: "POST",
              body: { attemptId },
            }),
          generation,
        );
      }

      async function checkOAuthDeploymentSucceeded(revisionId, generation) {
        const status = await readDeploymentStatus(revisionId, generation);
        if (status === null) {
          return { done: true, succeeded: false };
        }
        if (status.status === "succeeded") {
          return { done: true, succeeded: true };
        }
        return { done: false };
      }

      async function pollOAuthObservation(revisionId, initialObservation, generation) {
        let observation = initialObservation;
        while (oauthActivationCurrent(generation)) {
          renderOAuthObservation(observation, revisionId);
          if (observation.phase === "failed") {
            return false;
          }
          if (observation.phase === "committed") {
            const status = await waitForDeployment(revisionId, "succeeded", generation);
            return status !== null;
          }
          const deployment = await checkOAuthDeploymentSucceeded(revisionId, generation);
          if (deployment.done) {
            return deployment.succeeded;
          }
          if (observation.phase === "authorized") {
            if (!oauthActivationCurrent(generation)) {
              return false;
            }
            const completed = await completeOAuthOrAcceptActivated(
              revisionId,
              observation.attemptId,
              generation,
            );
            if (completed.cancelled) {
              return false;
            }
            if (completed.activated) {
              return true;
            }
            observation = completed.observation;
            continue;
          }
          await delay(OAUTH_STATUS_POLL_MS);
          if (!oauthActivationCurrent(generation)) {
            return false;
          }
          const current = await checkOAuthDeploymentSucceeded(revisionId, generation);
          if (current.done) {
            return current.succeeded;
          }
          if (observation.phase === "preparing") {
            const started = await startOAuthOrAcceptActivated(revisionId, generation);
            if (started.cancelled) {
              return false;
            }
            if (started.activated) {
              return true;
            }
            observation = started.observation;
          } else {
            const status = await readOAuthOrAcceptActivated(revisionId, generation);
            if (status.cancelled) {
              return false;
            }
            if (status.activated) {
              return true;
            }
            observation = status.observation;
          }
        }
        return false;
      }

      async function runOAuthActivation(revisionId, generation) {
        try {
          if (!oauthActivationCurrent(generation)) {
            return;
          }
          oauthPanel.hidden = false;
          oauthPanel.replaceChildren(
            element("h3", {}, "OAuth authorization"),
            element("p", {}, "Waiting for the OAuth runtime to prepare…"),
          );
          const ready = await waitForDeployment(revisionId, "runtime", generation);
          if (ready === null || !oauthActivationCurrent(generation)) {
            return;
          }
          if (ready.status === "succeeded") {
            change(revisionId, "workspace");
            return;
          }
          const started = await startOAuthOrAcceptActivated(revisionId, generation);
          if (started.cancelled) {
            return;
          }
          if (started.activated) {
            change(revisionId, "workspace");
            return;
          }
          const completed = await pollOAuthObservation(revisionId, started.observation, generation);
          if (completed && oauthActivationCurrent(generation)) {
            change(revisionId, "workspace");
          }
        } catch (error) {
          if (!oauthActivationCurrent(generation)) {
            return;
          }
          if (error.status === 401) {
            context.onExpired();
            return;
          }
          oauthPanel.hidden = false;
          oauthPanel.replaceChildren(
            element("h3", {}, "OAuth authorization unavailable"),
            element("p", { className: "error", role: "alert" }, message(error, true)),
          );
        } finally {
          if (oauthActivationCurrent(generation)) {
            deployPending = false;
            updateDeployControls();
          }
        }
      }

      deploy = button("Deploy new revision", async () => {
        deploy.disabled = true;
        deployPending = true;
        deployStatus.textContent = "Checking Configuration…";
        oauthPanel.hidden = true;
        oauthPanel.replaceChildren();
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
          if (oauthAuth) {
            const current = await request(path);
            if (!context.isCurrent()) {
              return;
            }
            updateOAuthStopPanel(current);
            const generation = startOAuthActivationRun();
            await runOAuthActivation(revision.id, generation);
            return;
          }
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
        oauthPanel,
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
        ["Provider", draft ? agent.providerId : snapshot.providerId],
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
