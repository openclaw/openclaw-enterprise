import type {
  Agent,
  SavedAgentPluginCredentialSlot,
  AgentRevision,
  Configuration,
  InstallationCapabilities,
  PluginApprovers,
  PluginDeploymentWarning,
  PluginDriver,
} from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import { sameValue } from "../carry.mjs";
import type { createDraftStore } from "../drafts.mjs";
import {
  button,
  element,
  focusSaveOutcome,
  jsonObjectDiagnostic,
  revealStatus,
  setHidden,
  setUnavailable,
  statusBlock,
  validateFields,
} from "../dom.mjs";
import { type PluginDiscoveryContext, createPluginDiscovery } from "./plugin-discovery.mjs";
import {
  pluginConnectionControl,
  type PluginAccountSlot,
  type SlotConnection,
} from "./plugin-connection.mjs";
import { isPluginSelections } from "./plugin-fields.mjs";
import { createSlackApproverField } from "./slack-approvers.mjs";
import {
  SAVE_REFUSALS,
  assertReadableConfiguration,
  describeFailure,
  readFailure,
  rejectionMessage,
} from "./list.mjs";
import { configuredHarnessId } from "./harness-auth.mjs";

type PluginAgent = Pick<
  Agent,
  "id" | "configurationId" | "executionMode" | "harnessAuth" | "plugins" | "pluginApprovers"
>;
type PluginCapabilities = NonNullable<
  InstallationCapabilities["pluginCatalogs"]
>[number]["pluginPolicies"] & {
  discoveryCredential: NonNullable<PluginDriver["discoveryCredential"]>;
  hostedCredential?: "codex_account" | "api_key";
  credentialSlots?: readonly SavedAgentPluginCredentialSlot[];
};

// The saved-Agent GET can change source eligibility without changing the Driver or its policy.
function recheckedCredentialSlots(original: PluginCapabilities["credentialSlots"], fresh: unknown) {
  if (!original || !Array.isArray(fresh) || fresh.length !== original.length) {
    return;
  }
  const slots: SavedAgentPluginCredentialSlot[] = [];
  for (const [index, originalSlot] of original.entries()) {
    const { sources: _originalSources, boundSourceId: _originalBound, ...binding } = originalSlot;
    const { sources, boundSourceId, ...freshBinding } = responseFields(fresh[index]);
    if (
      !sameValue(binding, freshBinding) ||
      !Array.isArray(sources) ||
      (boundSourceId !== undefined &&
        (typeof boundSourceId !== "string" ||
          !boundSourceId ||
          boundSourceId.trim() !== boundSourceId))
    ) {
      return;
    }
    const choices = new Map<string, string>();
    for (const source of sources) {
      const { id, name } = responseFields(source);
      if (
        typeof id !== "string" ||
        !id ||
        id.trim() !== id ||
        typeof name !== "string" ||
        !name.trim() ||
        choices.has(id)
      ) {
        return;
      }
      choices.set(id, name);
    }
    slots.push({
      ...binding,
      ...(boundSourceId === undefined ? {} : { boundSourceId }),
      sources: [...choices].map(([id, name]) => ({ id, name })),
    });
  }
  return slots;
}

interface PluginDraft {
  dirty: boolean;
  text: string;
  initialText: string;
  initialApprovers: PluginApprovers | undefined;
  pluginApprovers: PluginApprovers | undefined;
  baseline: Pick<PluginAgent, "configurationId"> & {
    plugins: PluginAgent["plugins"];
    pluginApprovers: PluginAgent["pluginApprovers"];
  };
  outcomeUnknown: boolean;
  reloadRequired: boolean;
}

type DraftScope = ReturnType<ReturnType<typeof createDraftStore>["scope"]>;

// A draft shows its Configuration values; a version shows its immutable plugin snapshot.
interface PluginEditorOptions {
  agent: PluginAgent;
  snapshot: Partial<
    Pick<Configuration, "values"> &
      Pick<AgentRevision, "plugins" | "pluginApprovers" | "secretBindings">
  >;
  draft: boolean;
  path: string;
  onState(
    state: Pick<PluginDraft, "dirty" | "outcomeUnknown" | "reloadRequired"> & { saving: boolean },
  ): void;
  /** Receives the confirmed PATCH response. */
  onSaved(savedAgent: Readonly<Record<string, unknown>>): void;
  onReload(): void;
  savedNotice?: string;
  cancelAnnouncement(status: Element): void;
  /** Why the permission answer refuses a save (Agent update, or its source grants). */
  saveDenied?: Promise<string | undefined> | null;
  /** Updates only the explanation while the save remains refused. */
  followSaveReason?(apply: (reason: string | undefined) => void): void;
}

// A caller who may not update the Agent reads its plugin selections (finding 2436).
const PLUGINS_READ_ONLY =
  "These are the version draft's plugin selections, read-only with your access. The next deployment uses them as saved.";

export const API_KEY_PLUGIN_MESSAGE =
  "Codex plugins need a ChatGPT login. This Agent uses an API key, so each selected plugin is disabled when it deploys (PLUGIN_AUTH_REQUIRED). Change its Harness authentication under Credentials to use plugins.";

// The policy capabilities read authorizes Agent update on the Agent.
const PLUGIN_CAPABILITIES_NEED = {
  task: "reading this Agent's plugin policy controls",
  grant: "Agent update on it",
};

const PLUGIN_WARNING_EXPLANATIONS = Object.freeze({
  PLUGIN_AUTH_REQUIRED:
    "was disabled for this startup because it is not authenticated: Codex plugins need a ChatGPT login rather than an API key, and some also need their app connected to that account.",
  PLUGIN_INSTALL_FAILED:
    "was disabled for this startup because it could not be installed. Check the Agent's runtime logs.",
});

// Agent default approvers as text when the editor is unavailable or the view is read-only.
function approverSummary(
  approvers: PluginApprovers | undefined,
  notes: { inherited: string; empty: string; listed: string },
) {
  return [
    element("h3", {}, "Default plugin approvers"),
    element(
      "p",
      { className: "muted" },
      approvers === undefined
        ? notes.inherited
        : approvers.length === 0
          ? notes.empty
          : notes.listed,
    ),
    ...(approvers?.length
      ? [
          element(
            "ul",
            {},
            ...approvers.map((entry) =>
              element("li", {}, element("code", {}, `${entry.channel}: ${entry.id}`)),
            ),
          ),
        ]
      : []),
  ];
}

/**
 * One sentence per deployment startup warning, keeping its code for lookup. A code this console
 * does not know still gets a sentence and a next step, not the code alone (finding 2538).
 */
export function pluginWarningText(warning: PluginDeploymentWarning) {
  const explanation = Object.hasOwn(PLUGIN_WARNING_EXPLANATIONS, warning.code)
    ? PLUGIN_WARNING_EXPLANATIONS[warning.code]
    : "reported a startup warning this console does not describe. Check the Agent's runtime logs.";
  return `${warning.pluginId} ${explanation} (${warning.code})`;
}

export function renderAgentPlugins(
  context: PluginDiscoveryContext & {
    agentId: string;
    drafts: Pick<DraftScope, "get" | "track" | "forget">;
  },
  {
    agent,
    snapshot,
    draft,
    path,
    onState,
    onSaved,
    onReload,
    savedNotice = "",
    cancelAnnouncement,
    saveDenied = null,
    followSaveReason,
  }: PluginEditorOptions,
) {
  if (!draft) {
    return element(
      "section",
      { className: "agent-card" },
      element("h2", {}, "Plugin selections snapshot"),
      element(
        "p",
        { className: "muted" },
        "This version's plugin selections are immutable. Select Create new version to change them for a future deployment.",
      ),
      element("pre", { tabindex: "0" }, JSON.stringify(snapshot.plugins?.plugins ?? {}, null, 2)),
      ...approverSummary(snapshot.pluginApprovers, {
        inherited:
          "No Agent default was set when this version was created; the existing OpenClaw approval routing applies.",
        empty: "Explicit empty list: no Slack user can approve plugins in this version by default.",
        listed: "This version's Agent default approvers are immutable.",
      }),
    );
  }

  // This in-memory key is written only by the capture below.
  const retained = context.drafts.get("plugins") as PluginDraft | undefined;
  let initialText = retained?.initialText ?? JSON.stringify(agent.plugins ?? {}, null, 2);
  const initialApprovers = retained ? retained.initialApprovers : agent.pluginApprovers;
  let pluginApprovers = retained ? retained.pluginApprovers : structuredClone(initialApprovers);
  const approversChanged = () =>
    JSON.stringify(pluginApprovers) !== JSON.stringify(initialApprovers);
  const baseline = retained?.baseline ?? {
    configurationId: agent.configurationId,
    plugins: agent.plugins ?? {},
    pluginApprovers: agent.pluginApprovers,
  };
  let pending = false;
  let outcomeUnknown = retained?.outcomeUnknown ?? false;
  let reloadRequired = retained?.reloadRequired ?? false;
  // Set when the caller's permission answer denies Agent update (finding 1530).
  let updateDenied = false;
  const input = element("textarea", {
    id: "agent-plugins",
    rows: "4",
    spellcheck: "false",
  });
  input.value = retained?.text ?? initialText;
  let catalogCredential: PluginCapabilities["discoveryCredential"] | null = null;
  let catalogCapabilityChecked = false;
  let initialCapabilities: PluginCapabilities | undefined;
  // The failed capabilities read's reason, shown once under the policy controls.
  let catalogCapabilityError: "missing" | "unreadable" | undefined;
  const codex = configuredHarnessId(snapshot.values) === "codex";
  // The saved capabilities already resolve the OpenClaw Harness, including the default.
  let openClawDriver = false;
  // Codex serves curated plugins only to ChatGPT logins; an API-key Agent gets each
  // selected plugin disabled at deployment with PLUGIN_AUTH_REQUIRED.
  const apiKeyAuth = () =>
    codex &&
    (agent.harnessAuth?.method === "api_key" ||
      initialCapabilities?.hostedCredential === "api_key");
  const hasCodexAccount = () => initialCapabilities?.hostedCredential === "codex_account";
  const sourceNotice = statusBlock(
    "info",
    null,
    "Plugin browsing uses this Agent's saved credential source.",
    [],
    { role: null },
  );
  const apiKeyNotice = statusBlock("warning", null, API_KEY_PLUGIN_MESSAGE, [], { role: null });
  sourceNotice.hidden = true;
  apiKeyNotice.hidden = !apiKeyAuth();
  const getSlackBotSourceId = () => {
    const source = snapshot.secretBindings?.SLACK_BOT_TOKEN?.source;
    return source?.kind === "credential_source" && source.namespaceId === context.namespaceId
      ? source.id
      : null;
  };
  let connectionNotice:
    { pluginId: string; slotId: string; message: string; retry?: boolean } | undefined;
  const slotConnection: SlotConnection = {
    feedback: (slot) =>
      connectionNotice?.pluginId === slot.pluginId && connectionNotice.slotId === slot.id
        ? connectionNotice
        : undefined,
    report(slot, message, retry) {
      connectionNotice = {
        pluginId: slot.pluginId,
        slotId: slot.id,
        message,
        ...(retry ? { retry } : {}),
      };
      discovery.fields.refresh();
    },
    unavailable() {
      if (updateDenied || pending || outcomeUnknown || reloadRequired) {
        return "Reload this Agent and check your update access before connecting an account.";
      }
      return undefined;
    },
    async refreshSlot(slot) {
      const capabilities = (await context.request(
        `${path}/plugins/capabilities`,
      )) as PluginCapabilities;
      initialCapabilities = capabilities;
      discovery.fields.setCapabilities(capabilities);
      return capabilities.credentialSlots?.find(
        (candidate) =>
          candidate.pluginId === slot.pluginId &&
          candidate.id === slot.id &&
          candidate.releaseSha256 === slot.releaseSha256,
      ) as PluginAccountSlot | undefined;
    },
    async attach(slot, sourceId, stage) {
      const draft = jsonObjectDiagnostic(input.value);
      if (
        !agent.plugins?.[slot.pluginId]?.enabled ||
        draft.kind !== "valid" ||
        !sameValue(draft.value[slot.pluginId], agent.plugins[slot.pluginId])
      ) {
        connectionNotice = {
          pluginId: slot.pluginId,
          slotId: slot.id,
          message: "Account connected. Save plugin selections to grant this Agent access.",
        };
        if (!stage(sourceId)) {
          return "The account was saved, but this plugin selection changed. Choose the account again.";
        }
        return connectionNotice.message;
      }
      const fresh = responseFields(await context.request(path));
      const savedPlugins = fresh.plugins;
      if (
        fresh.id !== agent.id ||
        fresh.namespaceId !== context.namespaceId ||
        fresh.configurationId !== baseline.configurationId ||
        !isPluginSelections(savedPlugins) ||
        !sameValue(savedPlugins, baseline.plugins) ||
        !sameValue(fresh.pluginApprovers, baseline.pluginApprovers)
      ) {
        reloadRequired = true;
        updateState();
        return "The account was saved, but the Agent changed. Reload its plugin selections before attaching it.";
      }
      const selection = savedPlugins[slot.pluginId];
      if (
        !selection?.enabled ||
        (selection.driverPolicy?.releaseSha256 !== undefined &&
          selection.driverPolicy.releaseSha256 !== slot.releaseSha256)
      ) {
        return "The account was saved, but the plugin release changed. Reload its plugin selections.";
      }
      const policy: Record<string, unknown> = {
        ...selection.driverPolicy,
        releaseSha256: slot.releaseSha256,
      };
      const credentials = responseFields(policy.credentials);
      const attachedSelection = { ...selection };
      if (slot.toolDiscovery && credentials[slot.id] !== sourceId) {
        delete policy.toolNames;
        delete attachedSelection.tools;
      }
      const plugins = {
        ...savedPlugins,
        [slot.pluginId]: {
          ...attachedSelection,
          driverPolicy: { ...policy, credentials: { ...credentials, [slot.id]: sourceId } },
        },
      };
      pending = true;
      updateState();
      let patchAccepted = false;
      try {
        await context.request(path, {
          method: "PATCH",
          body: { configurationId: baseline.configurationId, plugins },
        });
        patchAccepted = true;
        const confirmed = responseFields(await context.request(path));
        const confirmedPlugins = confirmed.plugins;
        if (
          confirmed.id !== agent.id ||
          confirmed.namespaceId !== context.namespaceId ||
          confirmed.configurationId !== baseline.configurationId ||
          !isPluginSelections(confirmedPlugins) ||
          !sameValue(confirmedPlugins, plugins)
        ) {
          outcomeUnknown = true;
          return "The account was saved, but its Agent binding could not be confirmed. Reload the saved state before retrying.";
        }
        connectionNotice = {
          pluginId: slot.pluginId,
          slotId: slot.id,
          message: "Account attached.",
        };
        pending = false;
        updateState();
        if (!stage(sourceId)) {
          reloadRequired = true;
          return "Account attached. Reload plugin selections to reconcile your draft.";
        }
        baseline.plugins = confirmedPlugins;
        initialText = JSON.stringify(confirmedPlugins, null, 2);
        agent = { ...agent, plugins: confirmedPlugins };
        return connectionNotice.message;
      } catch (cause) {
        const { status } = requestFailure(cause);
        outcomeUnknown = patchAccepted || ![400, 403, 404, 409, 429, 501].includes(status ?? 0);
        return outcomeUnknown
          ? "The account was saved, but its Agent binding could not be confirmed. Reload the saved state before retrying."
          : "The account was saved, but OCE could not attach it. Choose the saved account and save the plugin selections to retry.";
      } finally {
        pending = false;
        updateState();
      }
    },
  };
  const discovery = createPluginDiscovery({
    context,
    input,
    savedAgent: true,
    catalogPath: `${path}/plugins`,
    requestBody: (body) => body,
    renderAccountConnection: (slot, stage) =>
      pluginConnectionControl(context, slot, slotConnection, stage),
    canDiscover: () =>
      !updateDenied &&
      (openClawDriver
        ? agent.executionMode === "dedicated" && catalogCredential === "none"
        : codex &&
          !apiKeyAuth() &&
          (catalogCredential === "none" ||
            (catalogCredential === "required" && hasCodexAccount()))),
    canPrefetch: () => openClawDriver || hasCodexAccount(),
    applyRecheckedCapabilities,
    isPending: () => pending,
    unavailableMessage: () =>
      // A caller who may not update the Agent is not told to edit its selections (finding 2436).
      updateDenied
        ? "Plugin browsing needs Agent update access."
        : !catalogCapabilityChecked
          ? "Checking plugin catalog availability…"
          : catalogCapabilityError === "unreadable"
            ? "Plugin browsing needs the plugin capabilities, which could not be read. Refresh this page, or edit existing plugin selections."
            : catalogCapabilityError === "missing" || !codex || openClawDriver
              ? "The selected Plugin Driver does not offer a catalog for this harness and execution mode. You can still edit existing plugin selections."
              : // Only the Codex Plugin Driver's catalog depends on Codex auth (finding 2791).
                apiKeyAuth()
                ? "Plugin browsing is unavailable with API-key authentication."
                : "Hosted plugin browsing requires a TokenService account Source. Sign in with ChatGPT or re-enroll a service account token as a Source.",
    saveHint: "Changes are saved when you choose Save plugin selections.",
    deniedMessage:
      "Check Agent edit access. Hosted browsing also requires that both you and this Agent can use its bound credential. Saved selections can still be edited.",
    unsupportedMessage:
      "Plugin browsing is unavailable. Select a catalog-capable Driver; hosted catalogs require a TokenService account Source.",
    availableMessage: () =>
      catalogCredential === "none"
        ? "Load the Installation's curated plugin catalog. Access and tool availability are checked separately."
        : "Load plugins using this Agent's saved credential. Your plugin selections stay unchanged.",
    createApproverField: (options) =>
      createSlackApproverField({
        context,
        agentId: agent.id,
        getSourceId: getSlackBotSourceId,
        ...options,
      }),
  });
  const feedback = element("p", { className: "hint", role: "status" });
  // Refusals read as errors, as on Configuration saves, not in the muted status (finding 1864).
  const saveError = statusBlock("danger", null, null);
  const defaultApprovers = createSlackApproverField({
    context,
    label: "Default plugin approvers",
    agentId: agent.id,
    getSourceId: getSlackBotSourceId,
    getValue: () => pluginApprovers,
    onChange: (value) => {
      pluginApprovers = value;
      onEdit();
    },
    inheritedLabel: "Existing OpenClaw approval routing (no Agent default set)",
    allowInherit: true,
    lazyNames: true,
  });
  defaultApprovers.hidden = true;
  discovery.fields.section.insertBefore(
    defaultApprovers,
    discovery.fields.section.querySelector(".plugin-json"),
  );
  const pendingApprovers = element("div", { hidden: true });
  const capabilitiesStatus = element("p", { className: "hint", role: "status" });
  const save = button("Save plugin selections", () => void savePlugins(), {
    tone: "primary",
  });
  const discard = button("Discard changes", () => {
    input.value = initialText;
    pluginApprovers = structuredClone(initialApprovers);
    defaultApprovers.refreshValue();
    input.setCustomValidity("");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const reload = button("Reload plugin selections", () => {
    reload.disabled = true;
    void onReload();
  });
  const intro = element(
    "p",
    { className: "muted" },
    "Save selections on this Agent, then deploy a new version to apply them.",
  );
  const section = element(
    "section",
    { className: "agent-card" },
    intro,
    sourceNotice,
    apiKeyNotice,
    discovery.fields.section,
    pendingApprovers,
    capabilitiesStatus,
    element("div", { className: "form-actions" }, save, discard, reload),
    feedback,
    saveError,
  );

  context.drafts.track("plugins", (): PluginDraft | undefined => {
    const dirty = input.value !== initialText || approversChanged();
    return dirty || pending || outcomeUnknown || reloadRequired
      ? {
          dirty,
          text: input.value,
          initialText,
          initialApprovers,
          pluginApprovers,
          baseline,
          outcomeUnknown: outcomeUnknown || pending,
          reloadRequired,
        }
      : undefined;
  });

  let saveUnavailable = true;
  let discardUnavailable = true;
  function renderPendingApprovers() {
    const hidden = !catalogCapabilityChecked || !defaultApprovers.hidden || !approversChanged();
    if (pendingApprovers.hidden === hidden) {
      return;
    }
    pendingApprovers.hidden = hidden;
    pendingApprovers.replaceChildren(
      ...(hidden
        ? []
        : approverSummary(pluginApprovers, {
            inherited: "Existing OpenClaw approval routing is still selected in your draft.",
            empty: "No Slack approvers. This choice is still in your draft.",
            listed: "These approvers are still in your draft.",
          })),
    );
  }

  function updateState() {
    const dirty = input.value !== initialText || approversChanged();
    renderPendingApprovers();
    onState({ dirty, saving: pending, outcomeUnknown, reloadRequired });
    saveUnavailable = updateDenied || !dirty || pending || outcomeUnknown || reloadRequired;
    discardUnavailable = !dirty || pending || outcomeUnknown || reloadRequired;
    reload.hidden = !outcomeUnknown && !reloadRequired;
    // Edits that cannot be saved would only block leaving the tab (finding 1539).
    discovery.fields.setDisabled(updateDenied || pending || outcomeUnknown || reloadRequired);
    if (outcomeUnknown) {
      feedback.textContent =
        "Outcome unknown. Plugin selections may have been saved. Reload this Agent before trying again.";
    } else if (reloadRequired) {
      feedback.textContent = "Plugin selections changed. Reload this Agent before saving again.";
    } else if (!dirty && !pending) {
      // A caller who may not save reads the selections; nothing addresses an editor.
      feedback.textContent = updateDenied ? "" : "No plugin changes to save.";
    }
    describeControls();
  }

  // Unavailable Save and Discard are described by the feedback line that says why, such as "No
  // plugin changes to save." (finding D793), and stay in the Tab order while it shows (finding
  // 2878). Called wherever that line or the controls change.
  function describeControls() {
    setUnavailable(save, saveUnavailable, feedback);
    setUnavailable(discard, discardUnavailable, feedback);
  }

  function onEdit() {
    cancelAnnouncement(feedback);
    feedback.textContent = "";
    saveError.textContent = "";
    updateState();
  }

  input.addEventListener("input", () => {
    input.setCustomValidity("");
    onEdit();
  });

  async function savePlugins() {
    if (
      updateDenied ||
      pending ||
      outcomeUnknown ||
      reloadRequired ||
      (input.value === initialText &&
        JSON.stringify(pluginApprovers) === JSON.stringify(initialApprovers))
    ) {
      return;
    }
    const diagnostic = jsonObjectDiagnostic(input.value);
    if (diagnostic.kind !== "valid") {
      input.setCustomValidity(
        diagnostic.kind === "number-range"
          ? diagnostic.message
          : "Enter a valid Plugin selections JSON object.",
      );
      // The error goes under the field, opening its section, without the browser's bubble; the
      // status line does not repeat it.
      validateFields([input]);
      feedback.textContent = "";
      return;
    }
    const plugins = diagnostic.value;
    pending = true;
    saveError.textContent = "";
    feedback.textContent = "Checking saved plugin selections…";
    updateState();
    // The route identifies the Agent; a Configuration and its plugin policy can be shared.
    const matchesAgent = (response: Record<string, unknown>) =>
      response.id === context.agentId &&
      response.namespaceId === context.namespaceId &&
      response.configurationId === baseline.configurationId;
    let mutationStarted = false;
    let saved = false;
    try {
      const freshAgent = responseFields(await context.request(path));
      if (!context.isCurrent()) {
        return;
      }
      assertReadableConfiguration(freshAgent);
      if (
        !matchesAgent(freshAgent) ||
        !sameValue(freshAgent.plugins ?? {}, baseline.plugins) ||
        !sameValue(freshAgent.pluginApprovers, baseline.pluginApprovers)
      ) {
        reloadRequired = true;
        return;
      }
      const submittedApprovers = pluginApprovers;
      mutationStarted = true;
      const savedAgent = responseFields(
        await context.request(path, {
          method: "PATCH",
          body: {
            configurationId: baseline.configurationId,
            plugins,
            ...(submittedApprovers === undefined
              ? initialApprovers === undefined
                ? {}
                : { pluginApprovers: null }
              : { pluginApprovers: submittedApprovers }),
          },
        }),
      );
      // PATCH returns the saved map (including {}). Clearing approvers omits that field; []
      // is an explicit empty list. JSON object key order can change in PostgreSQL.
      const savedPlugins = savedAgent.plugins;
      if (
        !matchesAgent(savedAgent) ||
        savedAgent.configurationReadError !== undefined ||
        !isPluginSelections(savedPlugins) ||
        !sameValue(savedPlugins, plugins) ||
        !sameValue(savedAgent.pluginApprovers, submittedApprovers)
      ) {
        outcomeUnknown = true;
        return;
      }
      saved = true;
      if (context.isCurrent()) {
        // The controls stay disabled until the owner rebuilds this tab from the saved Agent.
        feedback.textContent = "Plugin selections saved.";
        describeControls();
        context.drafts.forget("plugins");
        void onSaved(savedAgent);
      }
    } catch (cause) {
      if (!context.isCurrent()) {
        return;
      }
      const error = requestFailure(cause);
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      outcomeUnknown =
        mutationStarted && ![400, 403, 404, 409, 429, 501].includes(error.status ?? 0);
      // An unknown outcome is a status that updateState keeps in the feedback line.
      feedback.textContent = "";
      saveError.textContent = outcomeUnknown
        ? ""
        : error.status === 403
          ? mutationStarted
            ? SAVE_REFUSALS.agent
            : SAVE_REFUSALS.read
          : error.status === 400 && !saved && error.serverMessage !== undefined
            ? rejectionMessage(cause, mutationStarted)
            : error.status === 400
              ? "Plugin selections were rejected. Check plugin IDs and policy JSON, then retry."
              : error.status === 501
                ? "This Installation has no compatible Plugin Driver for these selections. Ask an operator to select or configure one, then retry."
                : // A typed 409 names the setting or state that refused the save.
                  describeFailure(cause, {
                    mutation: mutationStarted,
                    conflict: "Plugin changes conflict with the current Agent state.",
                    next: "Refresh this Agent before retrying.",
                  });
      // Save disables while it runs, which dropped focus to the page. Focus the reader moved
      // anywhere else while the save ran, in this section too, stays there (finding 1978).
      revealStatus(saveError, save);
    } finally {
      if (context.isCurrent() && !saved) {
        pending = false;
        updateState();
        if (outcomeUnknown || reloadRequired) {
          // updateState shows the outcome and its Reload, which takes focus unless the reader
          // moved it off Save (findings 1978, 1998).
          focusSaveOutcome(save, [reload], feedback);
        }
      }
    }
  }

  updateState();
  if (savedNotice) {
    feedback.textContent = savedNotice;
    describeControls();
  }
  function applyRecheckedCapabilities(response: unknown) {
    if (!initialCapabilities) {
      return false;
    }
    const { credentialSlots: original, ...policy } = initialCapabilities;
    const { credentialSlots: fresh, ...freshPolicy } = responseFields(response);
    // Source choices can be unusable even when the approval policy is confirmed.
    const policyConfirmed = sameValue(policy, freshPolicy);
    setHidden(defaultApprovers, !policyConfirmed || policy.approvers?.agent !== true);
    renderPendingApprovers();
    const credentialSlots = policyConfirmed && recheckedCredentialSlots(original, fresh);
    if (!credentialSlots) {
      return false;
    }
    discovery.fields.setCapabilities({ ...policy, credentialSlots });
    return true;
  }

  function readCapabilities() {
    void context.request(`${path}/plugins/capabilities`).then(
      (response) => {
        if (context.isCurrent()) {
          const capabilities = response as PluginCapabilities;
          initialCapabilities = capabilities;
          catalogCredential = capabilities.discoveryCredential;
          openClawDriver = capabilities.driver?.implementation === "occ/openclaw-plugin";
          catalogCapabilityChecked = true;
          sourceNotice.hidden = !hasCodexAccount();
          apiKeyNotice.hidden = !apiKeyAuth();
          discovery.fields.setCapabilities(capabilities);
          discovery.update();
          defaultApprovers.hidden = capabilities.approvers?.agent !== true;
          if (!defaultApprovers.hidden) {
            defaultApprovers.refreshNames();
          }
          renderPendingApprovers();
        }
      },
      (cause: unknown) => {
        if (!context.isCurrent()) {
          return;
        }
        const status = requestFailure(cause).status;
        if (status === 401) {
          context.onExpired();
        } else {
          catalogCapabilityError = status === 501 ? "missing" : "unreadable";
          catalogCapabilityChecked = true;
          discovery.fields.setCapabilities(null, true);
          discovery.update();
          // A removed catalog can leave saved defaults that must be cleared with its selections.
          if (status === 501 && initialApprovers?.length) {
            defaultApprovers.hidden = false;
          }
          renderPendingApprovers();
          // A refusal names the grant this read checks, an outage who to ask (finding 2538).
          capabilitiesStatus.textContent = `${readFailure(
            "Plugin policy controls",
            cause,
            PLUGIN_CAPABILITIES_NEED,
          )} Plugin selections JSON remains editable.`;
        }
      },
    );
  }
  // An answer already settled applies before this section is first painted. Reading the policy
  // capabilities needs Agent update: a caller the answer denies it reads the saved selections
  // and is not sent a read that answers 403. An unknown answer still reads them (finding 2436).
  // A caller missing only the source grants a save checks is not sent it either: no save could
  // keep a policy edit (finding 2441).
  const saveReason = element("p", { className: "muted", role: "status" });
  followSaveReason?.((reason) => {
    if (updateDenied && reason !== undefined) {
      saveReason.textContent = reason;
    }
  });
  void Promise.resolve(saveDenied).then((reason) => {
    if (!context.isCurrent()) {
      return;
    }
    if (reason === undefined) {
      readCapabilities();
      return;
    }
    updateDenied = true;
    // An unsaved edit kept from an earlier visit can be neither saved nor discarded from the
    // summary, and kept Deploy on "Save or discard plugin changes" (finding 2463): the summary
    // shows the Agent as read, so the kept edit is dropped and the tab reports a clean state.
    context.drafts.forget("plugins");
    input.value = initialText;
    pluginApprovers = structuredClone(initialApprovers);
    outcomeUnknown = false;
    reloadRequired = false;
    updateState();
    // The saved selections and default approvers show as a summary, like a version snapshot's:
    // the editor's disabled Configure, Save and Discard controls and its instructions addressed
    // an editor this caller is not (findings 2447, 2455). The approver field waits for the
    // capabilities read, which this caller is not sent, so the approvers show as text too.
    const selections = Object.keys(agent.plugins ?? {});
    saveReason.textContent = reason;
    section.replaceChildren(
      element("h2", {}, "Plugin selections"),
      element("p", { className: "muted" }, PLUGINS_READ_ONLY),
      selections.length
        ? element("pre", { tabindex: "0" }, JSON.stringify(agent.plugins, null, 2))
        : element("p", {}, "No plugins are selected."),
      element(
        "div",
        { className: "plugin-approvers-saved" },
        ...approverSummary(agent.pluginApprovers, {
          inherited: "No Agent default is set; the existing OpenClaw approval routing applies.",
          empty: "Explicit empty list: no Slack user can approve plugins by default.",
          listed: "The next deployment uses these Agent default approvers.",
        }),
      ),
      saveReason,
    );
  });
  return section;
}
