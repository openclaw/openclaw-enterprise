import type { DriverConfigurationDescriptor } from "@openclaw-enterprise/contracts";
import { button, element } from "./dom.mjs";
import { renderAgentSandboxPolicy } from "./agents/sandbox-policy.mjs";
import { readFailure } from "./agents/list.mjs";
import { INSTALLATION_ADMINISTRATION, refusedAsNonAdministrator } from "./api-client.mjs";

// The Agent's contributions authorize Agent read on it; the Installation's values, Installation
// administer. A failed read says which, or how long to wait (finding 2538).
const AGENT_CONFIGURATIONS_NEED = {
  task: "reading this Agent's Driver configurations",
  grant: "Agent read on it",
};
const INSTALLATION_CONFIGURATIONS_NEED = {
  task: "reading the Installation's Driver configuration",
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

function fieldLabel(key: string): string {
  const words = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  return words.length === 0
    ? "Empty key"
    : words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

function renderConfigurationValue(value: unknown): HTMLElement {
  if (value === "[redacted]") {
    return element("span", { className: "driver-value-redacted" }, "Hidden for security");
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? element("code", { className: "driver-value" }, "[]")
      : element(
          "ol",
          { className: "driver-value-list" },
          ...value.map((item) => element("li", {}, renderConfigurationValue(item))),
        );
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length === 0
      ? element("code", { className: "driver-value" }, "{}")
      : renderConfigurationFields(value);
  }
  return element(
    "code",
    { className: "driver-value" },
    typeof value === "string" && value !== "" ? value : JSON.stringify(value),
  );
}

function renderConfigurationFields(configuration: object): HTMLElement {
  return element(
    "dl",
    { className: "driver-configuration-fields" },
    ...Object.entries(configuration).map(([key, value]) =>
      element(
        "div",
        { className: "driver-configuration-field" },
        element(
          "dt",
          {},
          element("span", {}, fieldLabel(key)),
          element("code", { className: "driver-field-key" }, key === "" ? '""' : key),
        ),
        element("dd", {}, renderConfigurationValue(value)),
      ),
    ),
  );
}

export function renderInstallationConfigurations(context: ConfigurationContext) {
  const section = element(
    "section",
    { className: "driver-configurations" },
    element("h2", {}, "Installation Driver configuration"),
    element("p", { role: "status" }, "Loading Driver configuration…"),
  );
  void discover(context, "/installation/driver-configurations", INSTALLATION_ADMINISTRATION)
    .then((configurations) => {
      if (!context.isCurrent()) {
        return;
      }
      section.replaceChildren(
        element(
          "div",
          { className: "driver-configurations-heading" },
          element(
            "div",
            {},
            element("h2", {}, "Installation Driver configuration"),
            element("p", {}, "Inspect startup values accepted by the selected Drivers."),
          ),
          element("span", { className: "driver-read-only" }, "Read only"),
        ),
        element(
          "p",
          { className: "driver-configurations-help" },
          "To change these values, update the startup configuration and restart the control plane. Sensitive values stay hidden.",
        ),
      );
      const views: { fields: HTMLElement; json: HTMLElement }[] = [];
      const fieldsButton = button("Fields", () => showView("fields"), { "aria-pressed": "true" });
      const jsonButton = button("JSON", () => showView("json"), { "aria-pressed": "false" });
      function showView(view: "fields" | "json") {
        fieldsButton.setAttribute("aria-pressed", String(view === "fields"));
        jsonButton.setAttribute("aria-pressed", String(view === "json"));
        for (const panels of views) {
          panels.fields.hidden = view !== "fields";
          panels.json.hidden = view !== "json";
        }
      }
      if (configurations.length > 0) {
        section.append(
          element(
            "div",
            { className: "driver-configurations-toolbar" },
            element(
              "span",
              {},
              `${configurations.length} ${configurations.length === 1 ? "Driver" : "Drivers"} · Installation scope`,
            ),
            element(
              "div",
              {
                className: "driver-configuration-views",
                role: "group",
                "aria-label": "Configuration display",
              },
              fieldsButton,
              jsonButton,
            ),
          ),
        );
      }
      const titles: Partial<Record<DriverConfigurationDescriptor["capability"], string>> = {
        iam: "Identity and access",
        secret: "Secrets",
      };
      for (const descriptor of configurations) {
        const values = descriptor.startupConfiguration;
        const count = values === undefined ? 0 : Object.keys(values).length;
        let summary = "Values unavailable";
        const body = element("div", { className: "driver-configuration-body" });
        if (values === undefined) {
          body.append(element("p", {}, "Accepted startup values are unavailable for this Driver."));
        } else {
          summary =
            count === 0 ? "No visible fields" : `${count} ${count === 1 ? "field" : "fields"}`;
          const fields =
            count === 0
              ? element("p", {}, "No startup values to display.")
              : renderConfigurationFields(values);
          const json = element(
            "pre",
            { className: "driver-configuration-json", hidden: true },
            JSON.stringify(values, null, 2),
          );
          views.push({ fields, json });
          body.append(fields, json);
        }
        section.append(
          element(
            "details",
            { className: "driver-configuration" },
            element(
              "summary",
              {},
              element(
                "span",
                { className: "driver-configuration-identity" },
                element(
                  "span",
                  { className: "driver-configuration-title" },
                  titles[descriptor.capability] ?? fieldLabel(descriptor.capability),
                ),
                element(
                  "span",
                  { className: "driver-configuration-id" },
                  `${descriptor.driverId} · ${descriptor.key}`,
                ),
              ),
              element("span", { className: "driver-configuration-count" }, summary),
            ),
            body,
          ),
        );
      }
      if (!configurations.length) {
        section.append(element("p", {}, "No Driver configurations are available."));
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
            readFailure(
              "Installation Driver configuration",
              cause,
              INSTALLATION_CONFIGURATIONS_NEED,
            ),
          ),
        );
      }
    });
  return section;
}
