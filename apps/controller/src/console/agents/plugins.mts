import type {
  Agent,
  AgentRevision,
  Configuration,
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
  revealStatus,
  statusBlock,
  validateFields,
} from "../dom.mjs";
import { type PluginDiscoveryContext, createPluginDiscovery } from "./plugin-discovery.mjs";
import { isPluginSelections } from "./plugin-fields.mjs";
import { createSlackApproverField } from "./slack-approvers.mjs";
import { SAVE_REFUSALS, assertReadableConfiguration, message, rejectionMessage } from "./list.mjs";
import { configuredHarnessId } from "./harness-auth.mjs";

type PluginAgent = Pick<
  Agent,
  "id" | "configurationId" | "harnessAuth" | "plugins" | "pluginApprovers"
>;
type PluginCapabilities = PluginDriver["policyCapabilities"] & {
  discoveryCredential: NonNullable<PluginDriver["discoveryCredential"]>;
};

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
  /** Why the permission answer refuses a save (Agent update, or its source grants). */
  saveDenied?: Promise<string | undefined> | null;
}

// A caller who may not update the Agent reads its plugin selections (finding 2436).
const PLUGINS_READ_ONLY =
  "These are the version draft's plugin selections, read-only with your access. The next deployment uses them as saved.";

export const API_KEY_PLUGIN_MESSAGE =
  "Codex plugins need a ChatGPT login. This Agent uses an API key, so each selected plugin is disabled when it deploys (PLUGIN_AUTH_REQUIRED). Change its Harness authentication under Credentials to use plugins.";

const PLUGIN_WARNING_EXPLANATIONS = Object.freeze({
  PLUGIN_AUTH_REQUIRED:
    "was disabled for this startup because it is not authenticated: Codex plugins need a ChatGPT login rather than an API key, and some also need their app connected to that account.",
  PLUGIN_INSTALL_FAILED:
    "was disabled for this startup because it could not be installed. Check the Agent's runtime logs.",
});

// The saved Agent default approvers as text: a version's snapshot and a reader's view of the
// draft, which has no field to edit them (finding 2447).
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

/** One sentence per deployment startup warning, keeping its code for lookup. */
export function pluginWarningText(warning: PluginDeploymentWarning) {
  const explanation = Object.hasOwn(PLUGIN_WARNING_EXPLANATIONS, warning.code)
    ? PLUGIN_WARNING_EXPLANATIONS[warning.code]
    : "reported a startup warning.";
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
    saveDenied = null,
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
  const initialText = retained?.initialText ?? JSON.stringify(agent.plugins ?? {}, null, 2);
  const initialApprovers = retained ? retained.initialApprovers : agent.pluginApprovers;
  let pluginApprovers = retained ? retained.pluginApprovers : structuredClone(initialApprovers);
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
  let catalogCapabilityError = false;
  const hasBoundCredential =
    agent.harnessAuth?.method === "credential_source" ||
    (agent.harnessAuth?.method === "codex_pat" && agent.harnessAuth.source?.kind === "secret");
  const codex = configuredHarnessId(snapshot.values) === "codex";
  // Codex serves curated plugins only to ChatGPT logins; an API-key Agent gets each
  // selected plugin disabled at deployment with PLUGIN_AUTH_REQUIRED.
  const apiKeyAuth = codex && agent.harnessAuth?.method === "api_key";
  const getSlackBotSecretId = () => {
    const source = snapshot.secretBindings?.SLACK_BOT_TOKEN?.source;
    return source?.kind === "secret" && source.namespaceId === context.namespaceId
      ? source.id
      : null;
  };
  const discovery = createPluginDiscovery({
    context,
    input,
    catalogPath: `${path}/plugins`,
    requestBody: (body) => body,
    canDiscover: () =>
      !updateDenied &&
      codex &&
      !apiKeyAuth &&
      (catalogCredential === "none" || (catalogCredential === "required" && hasBoundCredential)),
    canPrefetch: () => !updateDenied && codex && !apiKeyAuth && hasBoundCredential,
    isPending: () => pending,
    unavailableMessage: () =>
      // A caller who may not update the Agent is not told to edit its selections (finding 2436).
      updateDenied
        ? "Plugin browsing needs Agent update access."
        : !codex
          ? "Plugin browsing requires the Codex harness. You can still edit existing plugin selections."
          : apiKeyAuth
            ? "Plugin browsing is unavailable with API-key authentication."
            : !catalogCapabilityChecked
              ? "Checking plugin catalog availability…"
              : catalogCapabilityError
                ? "Could not check plugin catalog availability. Refresh this page or edit existing plugin selections."
                : "Hosted plugin browsing requires a saved ChatGPT login or Service Accounts token Secret. Select it under Credentials, or edit existing plugin selections.",
    saveHint: "Changes are saved when you choose Save plugin selections.",
    deniedMessage:
      "Check Agent edit access. Hosted browsing also requires that both you and this Agent can use its bound credential. Saved selections can still be edited.",
    unsupportedMessage:
      "Plugin browsing is unavailable. Select a catalog-capable Driver; hosted catalogs also require a saved ChatGPT login or Service Accounts token Secret under Credentials.",
    availableMessage: () =>
      catalogCredential === "none"
        ? "Load the Installation's curated plugin catalog. Access and tool availability are checked separately."
        : "Load plugins using this Agent's saved credential. Your plugin selections stay unchanged.",
    createApproverField: (options) =>
      createSlackApproverField({
        context,
        agentId: agent.id,
        getSecretId: getSlackBotSecretId,
        ...options,
      }),
  });
  // Refusals read as errors, as on Configuration saves, not in the muted status (finding 1864).
  // Declared before the approver field, whose edits clear it.
  const saveError = statusBlock("danger", null, null);
  const defaultApprovers = createSlackApproverField({
    context,
    label: "Default plugin approvers",
    agentId: agent.id,
    getSecretId: getSlackBotSecretId,
    getValue: () => pluginApprovers,
    onChange: (value) => {
      pluginApprovers = value;
      saveError.textContent = "";
      updateState();
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
  const feedback = element("p", { className: "hint", role: "status" });
  const capabilitiesStatus = element("p", { className: "hint", role: "status" });
  const updateNote = element("p", { className: "muted", role: "status", hidden: true });
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
    ...(agent.harnessAuth?.method === "credential_source"
      ? [
          statusBlock(
            "info",
            null,
            "Plugin browsing uses this Agent's saved credential source.",
            [],
            { role: null },
          ),
        ]
      : []),
    ...(apiKeyAuth
      ? [statusBlock("warning", null, API_KEY_PLUGIN_MESSAGE, [], { role: null })]
      : []),
    discovery.fields.section,
    capabilitiesStatus,
    updateNote,
    element("div", { className: "form-actions" }, save, discard, reload),
    feedback,
    saveError,
  );

  context.drafts.track("plugins", (): PluginDraft | undefined => {
    const dirty =
      input.value !== initialText ||
      JSON.stringify(pluginApprovers) !== JSON.stringify(initialApprovers);
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

  function updateState() {
    const dirty =
      input.value !== initialText ||
      JSON.stringify(pluginApprovers) !== JSON.stringify(initialApprovers);
    onState({ dirty, saving: pending, outcomeUnknown, reloadRequired });
    save.disabled = updateDenied || !dirty || pending || outcomeUnknown || reloadRequired;
    discard.disabled = !dirty || pending || outcomeUnknown || reloadRequired;
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
  }

  input.addEventListener("input", () => {
    input.setCustomValidity("");
    feedback.textContent = "";
    saveError.textContent = "";
    updateState();
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
    let plugins: unknown;
    try {
      plugins = JSON.parse(input.value);
      if (plugins === null || typeof plugins !== "object" || Array.isArray(plugins)) {
        throw new Error();
      }
    } catch {
      input.setCustomValidity("Enter a valid Plugin selections JSON object.");
      // The error goes under the field, opening its section, without the browser's bubble; the
      // status line does not repeat it.
      validateFields([input]);
      feedback.textContent = "";
      return;
    }
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
              : error.status === 409
                ? "Plugin changes conflict with the current Agent state. Refresh this Agent before retrying."
                : error.status === 501
                  ? "This Installation has no compatible Plugin Driver for these selections. Ask an operator to select or configure one, then retry."
                  : message(cause, mutationStarted);
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
  }
  function readCapabilities() {
    void context.request(`${path}/plugins/capabilities`).then(
      (response) => {
        if (context.isCurrent()) {
          const capabilities = response as PluginCapabilities;
          catalogCredential = capabilities.discoveryCredential;
          catalogCapabilityChecked = true;
          discovery.fields.setCapabilities(capabilities);
          discovery.update();
          defaultApprovers.hidden = capabilities.approvers?.agent !== true;
          if (!defaultApprovers.hidden) {
            defaultApprovers.refreshNames();
          }
        }
      },
      (cause: unknown) => {
        if (!context.isCurrent()) {
          return;
        }
        if (requestFailure(cause).status === 401) {
          context.onExpired();
        } else {
          catalogCapabilityError = true;
          catalogCapabilityChecked = true;
          discovery.update();
          capabilitiesStatus.textContent =
            "Plugin policy controls could not be loaded. Plugin selections JSON remains editable.";
        }
      },
    );
  }
  // An answer already settled applies before this section is first painted. Reading the policy
  // capabilities needs Agent update: a caller the answer denies it reads the saved selections
  // and is not sent a read that answers 403. An unknown answer still reads them (finding 2436).
  // A caller missing only the source grants a save checks is not sent it either: no save could
  // keep a policy edit (finding 2441).
  void Promise.resolve(saveDenied).then((reason) => {
    if (!context.isCurrent()) {
      return;
    }
    if (reason === undefined) {
      readCapabilities();
      return;
    }
    updateDenied = true;
    intro.textContent = PLUGINS_READ_ONLY;
    updateNote.textContent = reason;
    updateNote.hidden = false;
    // The approver field waits for the capabilities read, which this caller is not sent, so the
    // saved default approvers, which the next deployment also uses, show as text (finding 2447).
    discovery.fields.section.insertBefore(
      element(
        "div",
        { className: "plugin-approvers-saved" },
        ...approverSummary(agent.pluginApprovers, {
          inherited: "No Agent default is set; the existing OpenClaw approval routing applies.",
          empty: "Explicit empty list: no Slack user can approve plugins by default.",
          listed: "The next deployment uses these Agent default approvers.",
        }),
      ),
      defaultApprovers,
    );
    // The selections stay in view while their fields are disabled.
    input.closest("details")?.setAttribute("open", "");
    updateState();
    discovery.update();
  });
  return section;
}
