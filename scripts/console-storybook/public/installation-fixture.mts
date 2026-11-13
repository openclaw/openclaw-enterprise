import type {
  AgentPluginCredentialSlot,
  DriverConfigurationDescriptor,
  Installation,
  InstallationCapabilities,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";

type DriverConfigurationsScenario = {
  installationModelProvider?: boolean;
  installationNestedValues?: boolean;
  installationValuesUnavailable?: boolean;
};

type InstallationScenario = {
  nativeAdminSetup?: boolean;
  unsupportedProvisioning?: boolean;
  nativeWorkerSupport?: false | NonNullable<InstallationCapabilities["nativeWorkers"]>["support"];
  openclawExecutionModes?: NonNullable<InstallationCapabilities["openclaw"]>["executionModes"];
  openclawSettingRefusal?: string;
  sandboxDriverUnavailable?: boolean;
  credentialSourceTypes?: NonNullable<InstallationCapabilities["credentialSources"]>["types"];
  pluginCatalogs?: InstallationCapabilities["pluginCatalogs"];
  pluginCapabilities?: NonNullable<
    InstallationCapabilities["pluginCatalogs"]
  >[number]["pluginPolicies"] & {
    credentialSlots?: readonly AgentPluginCredentialSlot[];
  };
  pluginDiscoveryCredential?: "required" | "none";
};

export function installationDriverConfigurations(scenario: DriverConfigurationsScenario): {
  configurations: DriverConfigurationDescriptor[];
} {
  return {
    configurations: [
      ...(scenario.installationModelProvider
        ? ([
            {
              capability: "compute",
              driverId: "kubernetes-compute",
              implementation: "kubernetes",
              scope: "installation",
              key: "startup",
              binding: "installation-startup",
              configurationSchema: {
                type: "object",
                properties: {
                  runtime: {
                    type: "object",
                    properties: {
                      modelProvider: {
                        type: "object",
                        properties: {
                          protocol: { type: "string" },
                          baseUrl: { type: "string" },
                          supportsStandaloneWebSearch: { type: "boolean" },
                        },
                      },
                    },
                  },
                },
              },
              startupConfiguration: {
                runtime: {
                  modelProvider: {
                    protocol: "openai-responses",
                    baseUrl: "https://models.example.com/v1",
                    supportsStandaloneWebSearch: false,
                  },
                },
              },
              actions: {},
            },
          ] satisfies DriverConfigurationDescriptor[])
        : []),
      ...(scenario.installationNestedValues
        ? ([
            {
              capability: "configuration",
              driverId: "config-example-package",
              implementation: "example-configuration-driver",
              scope: "installation",
              key: "startup",
              binding: "installation-startup",
              configurationSchema: {
                type: "object",
                properties: { operatorResources: { writeOnly: true } },
              },
              startupConfiguration: {
                endpoint: "/configuration/read",
                optionalValues: {
                  enabled: false,
                  capacity: 0,
                  fallback: null,
                  emptyText: "",
                  list: [],
                  record: {},
                  ["customfield".repeat(8)]: "configurationvalue".repeat(20),
                  nested: Array.from({ length: 12 }).reduce<OpenClawConfigurationValue>(
                    (value, _, index) => ({ [`level${index + 1}`]: [value] }),
                    "Nested leaf",
                  ),
                },
                operatorResources: "[redacted]",
                workerGroups: Array.from({ length: 8 }, (_, index) => ({
                  name: `Group ${index + 1}`,
                  routes: ["/workspace/read", "/workspace/write"],
                  description:
                    index === 0 ? "<b>Literal configuration text</b>" : "Configured worker group",
                })),
              },
              actions: {},
            },
          ] satisfies DriverConfigurationDescriptor[])
        : []),
      {
        capability: "credential_gateway",
        driverId: "credential-gateway-openshell",
        implementation: "openshell",
        scope: "installation",
        key: "startup",
        binding: "installation-startup",
        configurationSchema: {
          type: "object",
          ...(scenario.installationValuesUnavailable ? { writeOnly: true } : {}),
          required: ["binaries"],
          additionalProperties: false,
          properties: {
            binaries: { type: "array", items: { type: "string" }, minItems: 1 },
            toolBinaries: { type: "array", items: { type: "string" }, minItems: 1 },
          },
        },
        ...(scenario.installationValuesUnavailable
          ? {}
          : {
              startupConfiguration: {
                binaries: ["/usr/bin/git", "/usr/bin/curl"],
                toolBinaries: ["/usr/bin/python3"],
              },
            }),
        actions: {},
      },
      {
        capability: "sandbox",
        driverId: "sandbox-openshell",
        implementation: "openshell",
        scope: "installation",
        key: "startup",
        binding: "installation-startup",
        configurationSchema: {
          type: "object",
          ...(scenario.installationValuesUnavailable ? { writeOnly: true } : {}),
          additionalProperties: false,
          properties: {
            gateway: {
              type: "object",
              properties: {
                workspaceMode: { type: "string" },
                operatorWorkspaceResources: { type: "array", writeOnly: true },
              },
            },
          },
        },
        ...(scenario.installationValuesUnavailable
          ? {}
          : {
              startupConfiguration: {
                gateway: {
                  workspaceMode: "operator",
                  operatorWorkspaceResources: "[redacted]",
                },
              },
            }),
        actions: {},
      },
      {
        capability: "iam",
        driverId: "native-iam",
        implementation: "native",
        scope: "installation",
        key: "startup",
        binding: "installation-startup",
        configurationSchema: {
          type: "object",
          ...(scenario.installationValuesUnavailable ? { writeOnly: true } : {}),
          additionalProperties: false,
          properties: {},
        },
        ...(scenario.installationValuesUnavailable ? {} : { startupConfiguration: {} }),
        actions: {},
      },
    ],
  };
}

function installationPluginPolicies({
  credentialSlots,
  ...policies
}: NonNullable<InstallationScenario["pluginCapabilities"]>) {
  return policies;
}

export function installationFixture(
  scenario: InstallationScenario,
  createdAt: Installation["createdAt"],
): Installation {
  return {
    id: "ins_00000000-0000-4000-8000-000000000001",
    name: "Demo installation",
    createdAt,
    capabilities: {
      ...(scenario.nativeAdminSetup ? { nativeAdmin: true } : {}),
      ...(scenario.unsupportedProvisioning === true
        ? {}
        : { agentProvisioning: { executionModes: ["dedicated"] } }),
      ...(scenario.nativeWorkerSupport === false
        ? {}
        : { nativeWorkers: { support: scenario.nativeWorkerSupport ?? "pinned-runtime" } }),
      ...(scenario.openclawExecutionModes === undefined
        ? {}
        : {
            openclaw: {
              executionModes: scenario.openclawExecutionModes,
              ...(scenario.openclawSettingRefusal
                ? { settingRefusals: { dedicated: scenario.openclawSettingRefusal } }
                : {}),
              ...(scenario.sandboxDriverUnavailable ? { sandboxDriverUnavailable: true } : {}),
            },
          }),
      ...(scenario.credentialSourceTypes !== undefined
        ? { credentialSources: { types: scenario.credentialSourceTypes } }
        : {}),
      pluginCatalogs:
        scenario.pluginCatalogs ??
        (scenario.pluginCapabilities
          ? [
              {
                harnessId:
                  scenario.pluginCapabilities.driver.implementation === "occ/openclaw-plugin"
                    ? "openclaw"
                    : "codex",
                pluginPolicies: installationPluginPolicies(scenario.pluginCapabilities),
                pluginDiscovery: { credential: scenario.pluginDiscoveryCredential ?? "required" },
              },
            ]
          : []),
    },
  };
}
