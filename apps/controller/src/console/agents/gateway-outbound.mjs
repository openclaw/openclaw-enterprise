import { button, element } from "../dom.mjs";
import { assertReadableConfiguration, rejectionMessage } from "./list.mjs";

const labels = {
  channelsOnly: "Required channels only",
  restricted: "Required channels and selected hosts",
  publicHttps: "General public HTTPS",
};
const hostPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const normalize = (selection) => selection ?? { mode: "channelsOnly" };

export function renderGatewayOutbound(
  context,
  { agent, snapshot, draft, executionMode, path, onState, onSaved, onReload },
) {
  const section = element("section", { className: "agent-card gateway-outbound" });
  const required = element("div");
  const status = element("p", { role: "status", className: "muted" });
  const feedback = element("p", { role: "status", className: "muted" });
  const retained = draft ? context.drafts.get("gatewayOutbound") : null;
  const initial = retained?.initial ?? normalize(agent.gatewayOutbound);
  const mode = element(
    "select",
    { id: "gateway-outbound-mode" },
    ...Object.entries(labels).map(([value, label]) => element("option", { value }, label)),
  );
  mode.value = retained?.mode ?? initial.mode;
  const hosts = element("textarea", {
    id: "gateway-outbound-hosts",
    rows: "4",
    spellcheck: "false",
  });
  hosts.value = retained?.hosts ?? (initial.mode === "restricted" ? initial.hosts.join("\n") : "");
  const hostField = element(
    "div",
    { className: "form-field" },
    element("label", { for: hosts.id }, "Additional HTTPS hosts"),
    hosts,
    element(
      "p",
      { className: "muted" },
      "One exact lowercase DNS name per line, up to 64. No schemes, paths, wildcards, IP addresses, or duplicate names. Channel destinations are added separately.",
    ),
  );
  let capability;
  let pending = false;
  let outcomeUnknown = retained?.outcomeUnknown ?? false;
  let reloadRequired = retained?.reloadRequired ?? false;
  function selection() {
    return mode.value === "restricted"
      ? { mode: "restricted", hosts: hosts.value.split(/\s+/).filter(Boolean) }
      : { mode: mode.value };
  }
  function dirty() {
    return JSON.stringify(selection()) !== JSON.stringify(initial);
  }
  function retain() {
    if (draft) {
      context.drafts.track("gatewayOutbound", () => ({
        initial,
        mode: mode.value,
        hosts: hosts.value,
        dirty: dirty(),
        outcomeUnknown,
        reloadRequired,
      }));
    }
  }
  function update() {
    hostField.hidden = mode.value !== "restricted";
    const enabled =
      draft &&
      executionMode === "dedicated" &&
      capability?.canConfigure &&
      !pending &&
      !outcomeUnknown &&
      !reloadRequired;
    mode.disabled = !enabled;
    hosts.disabled = !enabled || capability?.restricted !== true;
    mode.querySelector('[value="restricted"]').disabled = capability?.restricted !== true;
    mode.querySelector('[value="publicHttps"]').disabled = capability?.publicHttps !== true;
    save.disabled =
      !enabled || !dirty() || (mode.value !== "channelsOnly" && capability?.restricted !== true);
    cancel.disabled = pending || outcomeUnknown || reloadRequired || !dirty();
    onState?.({ dirty: draft && dirty(), saving: pending, outcomeUnknown, reloadRequired });
  }
  function renderRequired(requirements) {
    required.replaceChildren(element("h3", {}, "Required channel destinations"));
    if (requirements === undefined) {
      required.append(
        element(
          "p",
          { className: "muted" },
          "Required destinations are unavailable. Read access to the saved Configuration is required.",
        ),
      );
      return;
    }
    required.append(
      requirements.length === 0
        ? element("p", {}, "No supported channel currently requires outbound HTTPS.")
        : element(
            "ul",
            {},
            ...requirements.map((requirement) =>
              element(
                "li",
                {},
                `${requirement.source}: ${requirement.destinations.map((destination) => (destination.includeSubdomains ? `${destination.host} and subdomains` : destination.host)).join(", ")}`,
              ),
            ),
          ),
    );
  }
  const save = button("Save network access", async () => {
    const next = selection();
    if (
      next.mode === "restricted" &&
      (next.hosts.length === 0 ||
        next.hosts.length > 64 ||
        new Set(next.hosts).size !== next.hosts.length ||
        next.hosts.some((host) => host.length > 253 || !hostPattern.test(host)))
    ) {
      feedback.textContent = "Enter 1–64 unique lowercase DNS names.";
      return;
    }
    pending = true;
    feedback.textContent = "Checking the saved Agent…";
    update();
    let submitted = false;
    let saved = false;
    try {
      const fresh = await context.request(path);
      if (!context.isCurrent()) {
        return;
      }
      assertReadableConfiguration(fresh);
      if (
        fresh.configurationId !== agent.configurationId ||
        fresh.executionMode !== agent.executionMode ||
        JSON.stringify(normalize(fresh.gatewayOutbound)) !== JSON.stringify(initial)
      ) {
        reloadRequired = true;
        feedback.textContent = "Agent settings changed. Reload before saving network access.";
        return;
      }
      submitted = true;
      await context.request(path, {
        method: "PATCH",
        body: { configurationId: agent.configurationId, gatewayOutbound: next },
      });
      saved = true;
      context.drafts.forget("gatewayOutbound");
      onState?.({ dirty: false, saving: false, outcomeUnknown: false, reloadRequired: false });
      onSaved();
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      outcomeUnknown = submitted && (error.status === undefined || error.status >= 500);
      feedback.textContent = outcomeUnknown
        ? "Save outcome unknown. Reload this Agent before retrying or deploying."
        : rejectionMessage(error, submitted);
    } finally {
      pending = false;
      if (!saved && context.isCurrent() && section.isConnected) {
        retain();
        update();
      }
    }
  });
  const cancel = button("Cancel changes", () => {
    mode.value = initial.mode;
    hosts.value = initial.mode === "restricted" ? initial.hosts.join("\n") : "";
    context.drafts.forget("gatewayOutbound");
    feedback.textContent = "";
    update();
  });
  const reload = button("Reload Agent", onReload);
  const shown = draft
    ? normalize(agent.gatewayOutbound)
    : normalize(snapshot.gatewayOutbound?.selection);
  section.append(
    element("h2", {}, "Gateway network access"),
    element(
      "p",
      {},
      executionMode === "dedicated"
        ? "Enabled supported channels add their required HTTPS destinations automatically. Additional access applies to every trusted plugin in the dedicated Gateway. Private networks and metadata endpoints remain blocked."
        : "Embedded Agents keep their existing Compute networking. Additional Gateway outbound access applies to dedicated execution.",
    ),
    element("p", {}, `${draft ? "Saved draft" : "Admitted selection"}: ${labels[shown.mode]}`),
    required,
  );
  if (!draft) {
    renderRequired(snapshot.gatewayOutbound?.requirements ?? []);
    if (shown.mode === "restricted") {
      section.append(element("pre", {}, shown.hosts.join("\n")));
    }
    section.append(
      element(
        "p",
        { className: "muted" },
        "This version is immutable. Edit the draft and deploy a new version to change its access.",
      ),
    );
    return section;
  }
  const selectedVersion = element(
    "p",
    { className: "muted" },
    agent.activeRevisionId
      ? "Selected version network access: loading…"
      : "Selected version: none.",
  );
  section.append(selectedVersion);
  if (agent.activeRevisionId) {
    void context
      .request(`${path}/revisions/${encodeURIComponent(agent.activeRevisionId)}`)
      .then((revision) => {
        if (!context.isCurrent()) {
          return;
        }
        const selected = normalize(revision.gatewayOutbound?.selection);
        selectedVersion.textContent = `Selected version network access: ${labels[selected.mode]}${selected.mode === "restricted" ? ` (${selected.hosts.join(", ")})` : ""}. Deployment readiness is reported above.`;
      })
      .catch((error) => {
        if (!context.isCurrent()) {
          return;
        }
        if (error.status === 401) {
          context.onExpired();
          return;
        }
        selectedVersion.textContent =
          "Selected version network access is unavailable. Version read access is required.";
      });
  }
  section.append(
    element(
      "div",
      { className: "form-field" },
      element("label", { for: mode.id }, "Additional Gateway access"),
      mode,
    ),
    hostField,
    status,
    element(
      "p",
      { className: "muted" },
      "Saving changes the draft. Deploy a new version to apply it. Installation restrictions are enforced again at deployment.",
    ),
    element("div", { className: "form-actions" }, save, cancel, reload),
    feedback,
  );
  for (const input of [mode, hosts]) {
    input.addEventListener("input", () => {
      retain();
      update();
    });
  }
  status.textContent = "Checking available network access…";
  update();
  void context
    .request(`${path}/gateway-outbound/capabilities`)
    .then((result) => {
      if (!context.isCurrent()) {
        return;
      }
      capability = result;
      renderRequired(result.requirements);
      status.textContent =
        executionMode !== "dedicated"
          ? "Additional Gateway access is available for dedicated Agents. Embedded networking is unchanged."
          : !result.canConfigure
            ? "Changing Gateway access requires update and administer permission on this Agent."
            : !result.restricted
              ? "Managed Gateway outbound access is disabled for this Installation."
              : !result.publicHttps
                ? "The Installation permits selected hosts. General public HTTPS is disabled."
                : "The Installation permits selected hosts and general public HTTPS.";
      if (outcomeUnknown || reloadRequired) {
        feedback.textContent = "Reload this Agent before editing or deploying.";
      }
      update();
    })
    .catch((error) => {
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      status.textContent =
        "Network access capabilities could not be loaded. Reload this Agent to try again.";
      update();
    });
  return section;
}
