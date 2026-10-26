import type { DriverConfigurationDescriptor } from "@openclaw-enterprise/contracts";
import { button, element } from "./dom.mjs";
import { renderAgentSandboxPolicy } from "./agents/sandbox-policy.mjs";
import { readFailure } from "./agents/list.mjs";
import { INSTALLATION_ADMINISTRATION, refusedAsNonAdministrator } from "./api-client.mjs";

// The Agent's contributions authorize Agent read on it; the Installation's schemas, Installation
// administer. A failed read says which, or how long to wait (finding 2538).
const AGENT_CONFIGURATIONS_NEED = {
  task: "reading this Agent's Driver configurations",
  grant: "Agent read on it",
};
const INSTALLATION_SCHEMAS_NEED = {
  task: "reading the Installation's Driver schemas",
  grant: "Installation administer",
};

type ConfigurationContext = Parameters<typeof renderAgentSandboxPolicy>[0];
type AgentOptions = Omit<Parameters<typeof renderAgentSandboxPolicy>[1], "descriptor">;

async function discover(
  { request }: ConfigurationContext,
  path: string,
  options?: typeof INSTALLATION_ADMINISTRATION,
) {
  const { configurations } = (await request(path, options)) as {
    configurations: readonly DriverConfigurationDescriptor[];
  };
  return configurations;
}

export function renderAgentDriverConfigurations(
  context: ConfigurationContext,
  options: AgentOptions,
) {
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
      const configurations = await discover(
        context,
        `/namespaces/${encodeURIComponent(agent.namespaceId)}/agents/${encodeURIComponent(agent.id)}/driver-configurations`,
      );
      if (!active.isCurrent()) {
        return;
      }
      section.replaceChildren();
      if (configurations.length === 0) {
        // Sandbox logs have independent read_logs authority, even when no policy owner is readable.
        // The policy card already says what the reader's access does not include, so an internal
        // "no Driver configurations" sentence would only repeat it in other words (finding 2549).
        section.append(renderAgentSandboxPolicy(active, options));
      }
      for (const descriptor of configurations) {
        section.append(
          descriptor.binding === "sandbox-policy"
            ? renderAgentSandboxPolicy(active, { ...options, descriptor })
            : element("p", {}, "This configuration owner is not supported by this console."),
        );
      }
    } catch (cause) {
      if (active.isCurrent()) {
        section.replaceChildren(
          renderAgentSandboxPolicy(active, options),
          element(
            "p",
            { role: "alert" },
            readFailure("Driver configurations", cause, AGENT_CONFIGURATIONS_NEED),
          ),
          button("Retry discovery", () => void load()),
        );
      }
    }
  }
  void load();
  return section;
}

export function renderInstallationConfigurations(context: ConfigurationContext) {
  const section = element(
    "section",
    {},
    element("h2", {}, "Installation Driver configuration"),
    element("p", { role: "status" }, "Loading schemas…"),
  );
  void discover(context, "/installation/driver-configurations", INSTALLATION_ADMINISTRATION)
    .then((configurations) => {
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
    .catch((cause: unknown) => {
      if (context.isCurrent() && refusedAsNonAdministrator(cause)) {
        // The refusal settled that the caller does not administer the Installation, whose
        // administrators alone get this section: leave it out, as for any member (finding D760).
        section.remove();
      } else if (context.isCurrent()) {
        section.replaceChildren(
          element("h2", {}, "Installation Driver configuration"),
          element(
            "p",
            { role: "alert" },
            readFailure("Installation Driver schemas", cause, INSTALLATION_SCHEMAS_NEED),
          ),
        );
      }
    });
  return section;
}
