import { button, element } from "../dom.mjs";
import { createPluginDiscovery } from "./plugin-discovery.mjs";
import { createSlackApproverField } from "./slack-approvers.mjs";
import { assertReadableConfiguration, message } from "./list.mjs";
import { createDeviceLogin } from "./device-login.mjs";
import { configuredHarnessId } from "./harness-auth.mjs";

export const API_KEY_PLUGIN_MESSAGE =
  "Codex plugins need a ChatGPT login. This Agent uses an API key, so each selected plugin is disabled when it deploys (PLUGIN_AUTH_REQUIRED). Change its Harness authentication under Credentials to use plugins.";

const PLUGIN_WARNING_EXPLANATIONS = Object.freeze({
  PLUGIN_AUTH_REQUIRED:
    "was disabled for this startup because it is not authenticated: Codex plugins need a ChatGPT login rather than an API key, and some also need their app connected to that account.",
  PLUGIN_INSTALL_FAILED:
    "was disabled for this startup because it could not be installed. Check the Agent's runtime logs.",
});

/** One sentence per deployment startup warning, keeping its code for lookup. */
export function pluginWarningText(warning) {
  const explanation = Object.hasOwn(PLUGIN_WARNING_EXPLANATIONS, warning.code)
    ? PLUGIN_WARNING_EXPLANATIONS[warning.code]
    : "reported a startup warning.";
  return `${warning.pluginId} ${explanation} (${warning.code})`;
}

export function renderAgentPlugins(
  context,
  { agent, snapshot, draft, path, onState, onSaved, onReload },
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
      element("h3", {}, "Default plugin approvers"),
      element(
        "p",
        { className: "muted" },
        snapshot.pluginApprovers === undefined
          ? "No Agent default was set when this revision was admitted; the existing OpenClaw approval routing applies."
          : snapshot.pluginApprovers.length === 0
            ? "Explicit empty list: no Slack user can approve plugins in this revision by default."
            : "This revision's Agent default approvers are immutable.",
      ),
      ...(snapshot.pluginApprovers?.length
        ? [
            element(
              "ul",
              {},
              ...snapshot.pluginApprovers.map((entry) =>
                element("li", {}, element("code", {}, `${entry.channel}: ${entry.id}`)),
              ),
            ),
          ]
        : []),
    );
  }

  const retained = context.drafts.get("plugins");
  const initialText = retained?.initialText ?? JSON.stringify(agent.plugins ?? {}, null, 2);
  const initialApprovers = Object.hasOwn(retained ?? {}, "initialApprovers")
    ? retained.initialApprovers
    : agent.pluginApprovers;
  let pluginApprovers = Object.hasOwn(retained ?? {}, "pluginApprovers")
    ? retained.pluginApprovers
    : structuredClone(initialApprovers);
  const baseline = retained?.baseline ?? {
    configurationId: agent.configurationId,
    plugins: agent.plugins ?? {},
    pluginApprovers: agent.pluginApprovers,
  };
  let pending = false;
  let outcomeUnknown = retained?.outcomeUnknown ?? false;
  let reloadRequired = retained?.reloadRequired ?? false;
  const input = element("textarea", {
    id: "agent-plugins",
    rows: "4",
    spellcheck: "false",
  });
  input.value = retained?.text ?? initialText;
  let catalogCredential = null;
  let catalogCapabilityChecked = false;
  let catalogCapabilityError = false;
  const hasBoundCredential =
    agent.harnessAuth?.method === "codex_pat" && agent.harnessAuth.source?.kind === "secret";
  const codex = configuredHarnessId(snapshot.values) === "codex";
  // Codex serves curated plugins only to ChatGPT logins; an API-key Agent gets each
  // selected plugin disabled at deployment with PLUGIN_AUTH_REQUIRED.
  const apiKeyAuth = codex && agent.harnessAuth?.method === "api_key";
  const oauthLogin = createDeviceLogin({
    context,
    agentId: agent.id,
    initial: retained?.oauthLogin,
    hint: "Use a separate ChatGPT login to browse plugins for this revision. This does not replace or refresh the deployed Agent's credential. Discard this login when you finish.",
    onChange() {
      discovery.reset();
    },
  });
  oauthLogin.setActive(codex && agent.harnessAuth?.method === "oauth");
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
    requestBody: (body) => (oauthLogin.source ? { ...body, oauthLogin: oauthLogin.source } : body),
    canDiscover: () =>
      codex &&
      !apiKeyAuth &&
      (catalogCredential === "none" ||
        (catalogCredential === "required" && (hasBoundCredential || Boolean(oauthLogin.source)))),
    canPrefetch: () => codex && !apiKeyAuth && (hasBoundCredential || Boolean(oauthLogin.source)),
    isPending: () => pending,
    unavailableMessage: () =>
      !codex
        ? "Plugin browsing requires the Codex harness. You can still edit existing plugin selections."
        : apiKeyAuth
          ? "Plugin browsing is unavailable with API-key authentication."
          : !catalogCapabilityChecked
            ? "Checking plugin catalog availability…"
            : catalogCapabilityError
              ? "Could not check plugin catalog availability. Refresh this page or edit existing plugin selections."
              : agent.harnessAuth?.method === "oauth"
                ? "Use experimental ChatGPT OAuth below to browse plugins without changing the deployed Agent's login."
                : "Hosted plugin browsing requires a saved Service Accounts token Secret. Select it under Credentials, or edit existing plugin selections.",
    saveHint: "Changes are saved when you choose Save plugin selections.",
    deniedMessage:
      "Check Agent edit access. Hosted browsing also requires that both you and this Agent can use its bound Secret. Saved selections can still be edited.",
    unsupportedMessage:
      "Plugin browsing is unavailable. Select a catalog-capable Driver; hosted catalogs also require a saved Service Accounts token Secret under Credentials.",
    availableMessage: () =>
      catalogCredential === "none"
        ? "Load the Installation's curated plugin catalog. Access and tool availability are checked separately."
        : oauthLogin.source
          ? "Load plugins with the separate configuration login. The deployed Agent's credential stays unchanged."
          : "Load plugins using this Agent's saved Service Accounts token Secret. Your plugin selections stay unchanged.",
    createApproverField: (options) =>
      createSlackApproverField({
        context,
        agentId: agent.id,
        getSecretId: getSlackBotSecretId,
        ...options,
      }),
  });
  const defaultApprovers = createSlackApproverField({
    context,
    label: "Default plugin approvers",
    agentId: agent.id,
    getSecretId: getSlackBotSecretId,
    getValue: () => pluginApprovers,
    onChange: (value) => {
      pluginApprovers = value;
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
  const save = button("Save plugin selections", () => void savePlugins(), {
    className: "primary",
  });
  const discard = button("Discard changes", () => {
    input.value = initialText;
    pluginApprovers = structuredClone(initialApprovers);
    defaultApprovers.refreshValue();
    input.setCustomValidity("");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const reload = button("Reload plugin selections", onReload);
  const section = element(
    "section",
    { className: "agent-card" },
    element(
      "p",
      { className: "muted" },
      "Save selections on this Agent, then deploy a new version to apply them.",
    ),
    oauthLogin.section,
    ...(apiKeyAuth ? [element("p", { className: "notice" }, API_KEY_PLUGIN_MESSAGE)] : []),
    discovery.fields.section,
    capabilitiesStatus,
    element("div", { className: "form-actions" }, save, discard, reload),
    feedback,
  );

  context.drafts.track("plugins", () => {
    const dirty =
      input.value !== initialText ||
      JSON.stringify(pluginApprovers) !== JSON.stringify(initialApprovers);
    return dirty || pending || outcomeUnknown || reloadRequired || oauthLogin.capture()
      ? {
          dirty,
          text: input.value,
          initialText,
          initialApprovers,
          pluginApprovers,
          baseline,
          outcomeUnknown: outcomeUnknown || pending,
          reloadRequired,
          oauthLogin: oauthLogin.capture(),
        }
      : undefined;
  });

  function updateState() {
    const dirty =
      input.value !== initialText ||
      JSON.stringify(pluginApprovers) !== JSON.stringify(initialApprovers);
    onState({ dirty, saving: pending, outcomeUnknown, reloadRequired });
    save.disabled = !dirty || pending || outcomeUnknown || reloadRequired;
    discard.disabled = !dirty || pending || outcomeUnknown || reloadRequired;
    reload.hidden = !outcomeUnknown && !reloadRequired;
    discovery.fields.setDisabled(pending || outcomeUnknown || reloadRequired);
    oauthLogin.setDisabled(pending || outcomeUnknown || reloadRequired);
    if (outcomeUnknown) {
      feedback.textContent =
        "Outcome unknown. Plugin selections may have been saved. Reload this Agent before trying again.";
    } else if (reloadRequired) {
      feedback.textContent = "Plugin selections changed. Reload this Agent before saving again.";
    } else if (!dirty && !pending) {
      feedback.textContent = "No plugin changes to save.";
    }
  }

  input.addEventListener("input", () => {
    input.setCustomValidity("");
    feedback.textContent = "";
    updateState();
  });

  async function savePlugins() {
    if (
      pending ||
      outcomeUnknown ||
      reloadRequired ||
      (input.value === initialText &&
        JSON.stringify(pluginApprovers) === JSON.stringify(initialApprovers))
    ) {
      return;
    }
    let plugins;
    try {
      plugins = JSON.parse(input.value);
      if (plugins === null || typeof plugins !== "object" || Array.isArray(plugins)) {
        throw new Error();
      }
    } catch {
      input.setCustomValidity("Enter a valid Plugin selections JSON object.");
      input.closest("details").open = true;
      input.reportValidity();
      feedback.textContent = "Enter a valid Plugin selections JSON object.";
      return;
    }
    pending = true;
    feedback.textContent = "Checking saved plugin selections…";
    updateState();
    let mutationStarted = false;
    try {
      const freshAgent = await context.request(path);
      if (!context.isCurrent()) {
        return;
      }
      assertReadableConfiguration(freshAgent);
      if (
        freshAgent.configurationId !== baseline.configurationId ||
        JSON.stringify(freshAgent.plugins ?? {}) !== JSON.stringify(baseline.plugins) ||
        JSON.stringify(freshAgent.pluginApprovers) !== JSON.stringify(baseline.pluginApprovers)
      ) {
        reloadRequired = true;
        return;
      }
      mutationStarted = true;
      await context.request(path, {
        method: "PATCH",
        body: {
          configurationId: baseline.configurationId,
          plugins,
          ...(pluginApprovers === undefined
            ? initialApprovers === undefined
              ? {}
              : { pluginApprovers: null }
            : { pluginApprovers }),
        },
      });
      if (context.isCurrent()) {
        pending = false;
        updateState();
        context.drafts.forget("plugins");
        if (oauthLogin.capture()) {
          context.drafts.track("plugins", () => ({ oauthLogin: oauthLogin.capture() }));
        }
        onSaved();
      }
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      outcomeUnknown = mutationStarted && ![400, 403, 404, 409, 429, 501].includes(error.status);
      feedback.textContent =
        error.status === 403
          ? "Access denied. Check Agent update, Configuration read, and access to this Agent's bound Secrets or Service Account."
          : error.status === 400
            ? "Plugin selections were rejected. Check plugin IDs and policy JSON, then retry."
            : error.status === 409
              ? "Plugin changes conflict with the current Agent state. Refresh this Agent before retrying."
              : error.status === 501
                ? "This Installation has no compatible Plugin Driver for these selections. Ask an operator to select or configure one, then retry."
                : message(error, mutationStarted);
    } finally {
      if (context.isCurrent()) {
        pending = false;
        updateState();
      }
    }
  }

  updateState();
  void context.request(`${path}/plugins/capabilities`).then(
    (capabilities) => {
      if (context.isCurrent()) {
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
    (error) => {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
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
  return section;
}
