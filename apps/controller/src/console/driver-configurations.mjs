import { button, element } from "./dom.mjs";
import { renderAgentSandboxPolicy } from "./agents/sandbox-policy.mjs";

const owners = {
  "sandbox-policy": (context, options, descriptor) =>
    renderAgentSandboxPolicy(context, { ...options, descriptor }),
};

export function renderAgentDriverConfigurations(context, options) {
  const section = element(
    "section",
    {},
    element("p", { role: "status" }, "Loading Driver configurations…"),
  );
  let discoveryGeneration = 0;
  async function load() {
    const generation = ++discoveryGeneration;
    const active = {
      ...context,
      isCurrent: () => context.isCurrent() && generation === discoveryGeneration,
    };
    try {
      const { agent } = options;
      const result = await context.request(
        `/namespaces/${encodeURIComponent(agent.namespaceId)}/agents/${encodeURIComponent(agent.id)}/driver-configurations`,
      );
      if (!active.isCurrent()) {
        return;
      }
      section.replaceChildren();
      if (result.configurations.length === 0) {
        // Sandbox logs have independent read_logs authority, even when no policy owner is readable.
        section.append(renderAgentSandboxPolicy(active, options));
        section.append(
          element(
            "p",
            {},
            "No Driver configurations are available to this account for this Agent.",
          ),
        );
      }
      for (const descriptor of result.configurations) {
        const render = Object.hasOwn(owners, descriptor.binding)
          ? owners[descriptor.binding]
          : undefined;
        section.append(
          render
            ? render(active, options, descriptor)
            : element("p", {}, "This configuration owner is not supported by this console."),
        );
      }
    } catch {
      if (active.isCurrent()) {
        section.replaceChildren(
          renderAgentSandboxPolicy(active, options),
          element("p", { role: "alert" }, "Driver configurations could not be read."),
          button("Retry discovery", () => void load()),
        );
      }
    }
  }
  void load();
  return section;
}

export function renderInstallationConfigurations(context) {
  const section = element(
    "section",
    {},
    element("h2", {}, "Installation Driver configuration"),
    element("p", { role: "status" }, "Loading schemas…"),
  );
  void context
    .request("/installation/driver-configurations")
    .then(({ configurations }) => {
      if (!context.isCurrent()) {
        return;
      }
      section.replaceChildren(
        element("h2", {}, "Installation Driver configuration"),
        element(
          "p",
          {},
          "Inspect startup settings accepted by the selected Drivers. Change values in the operator-managed startup configuration and restart the control plane.",
        ),
      );
      for (const descriptor of configurations) {
        section.append(
          element(
            "details",
            {},
            element(
              "summary",
              {},
              `${descriptor.capability} · ${descriptor.driverId} · ${descriptor.key}`,
            ),
            element("pre", {}, JSON.stringify(descriptor.configurationSchema, null, 2)),
          ),
        );
      }
      if (!configurations.length) {
        section.append(element("p", {}, "No Driver configuration schemas are available."));
      }
    })
    .catch(() => {
      if (context.isCurrent()) {
        section.replaceChildren(
          element(
            "p",
            { role: "alert" },
            "Installation Driver schemas require Installation administration and an available control plane.",
          ),
        );
      }
    });
  return section;
}
