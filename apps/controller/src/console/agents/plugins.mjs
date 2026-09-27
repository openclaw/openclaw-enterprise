import { button, element } from "../dom.mjs";
import { createPluginDiscovery } from "./plugin-discovery.mjs";
import { message } from "./list.mjs";

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
    );
  }

  const retained = context.drafts.get("plugins");
  const initialText = retained?.initialText ?? JSON.stringify(agent.plugins ?? {}, null, 2);
  const baseline = retained?.baseline ?? {
    configurationId: agent.configurationId,
    plugins: agent.plugins ?? {},
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
  const discovery = createPluginDiscovery({
    context,
    input,
    catalogPath: `${path}/plugins`,
    requestBody: (body) => body,
    canDiscover: () =>
      agent.executionMode === "dedicated" &&
      (catalogCredential === "none" || (catalogCredential === "required" && hasBoundCredential)),
    isPending: () => pending,
    unavailableMessage: () =>
      agent.executionMode !== "dedicated"
        ? "Plugin browsing requires a dedicated Agent. You can still edit existing plugin selections."
        : !catalogCapabilityChecked
          ? "Checking plugin catalog availability…"
          : catalogCapabilityError
            ? "Could not check plugin catalog availability. Refresh this page or edit existing plugin selections."
            : "Hosted plugin browsing requires a saved Service Accounts token Secret. Select it under Credentials, or edit existing plugin selections.",
    saveHint: "Changes are saved when you choose Save plugin selections.",
    deniedMessage:
      "Check Agent edit access. Hosted browsing also requires that both you and this Agent can use its bound Secret. Saved selections can still be edited.",
    unsupportedMessage:
      "Plugin browsing is unavailable. Select a catalog-capable Driver; hosted catalogs also require a saved Service Accounts token Secret under Credentials.",
    availableMessage: () =>
      catalogCredential === "none"
        ? "Load the Installation's curated plugin catalog. Access and tool availability are checked separately."
        : "Load plugins using this Agent's saved Service Accounts token Secret. Your plugin selections stay unchanged.",
  });
  const feedback = element("p", { className: "hint", role: "status" });
  const capabilitiesStatus = element("p", { className: "hint", role: "status" });
  const save = button("Save plugin selections", () => void savePlugins(), {
    className: "primary",
  });
  const discard = button("Discard changes", () => {
    input.value = initialText;
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
    discovery.fields.section,
    capabilitiesStatus,
    element("div", { className: "form-actions" }, save, discard, reload),
    feedback,
  );

  context.drafts.track("plugins", () => {
    const dirty = input.value !== initialText;
    return dirty || pending || outcomeUnknown || reloadRequired
      ? {
          text: input.value,
          initialText,
          baseline,
          outcomeUnknown: outcomeUnknown || pending,
          reloadRequired,
        }
      : undefined;
  });

  function updateState() {
    const dirty = input.value !== initialText;
    onState({ dirty, saving: pending, outcomeUnknown, reloadRequired });
    save.disabled = !dirty || pending || outcomeUnknown || reloadRequired;
    discard.disabled = !dirty || pending || outcomeUnknown || reloadRequired;
    reload.hidden = !outcomeUnknown && !reloadRequired;
    discovery.fields.setDisabled(pending || outcomeUnknown || reloadRequired);
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
    if (pending || outcomeUnknown || reloadRequired || input.value === initialText) {
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
      if (
        freshAgent.configurationId !== baseline.configurationId ||
        JSON.stringify(freshAgent.plugins ?? {}) !== JSON.stringify(baseline.plugins)
      ) {
        reloadRequired = true;
        return;
      }
      mutationStarted = true;
      await context.request(path, {
        method: "PATCH",
        body: { configurationId: baseline.configurationId, plugins },
      });
      if (context.isCurrent()) {
        pending = false;
        updateState();
        context.drafts.forget("plugins");
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
