import type {
  CredentialInjectionPolicy,
  NetworkAccessPolicy,
  PluginDeploymentNetworkRequirement,
  PluginDeploymentTool,
} from "@openclaw-enterprise/contracts";

// A hosted app can rely on its defaults without selecting individual tools or installing a package.
const hostedApp = {
  kind: "codex-hosted-app",
  id: "documents",
  role: "harness",
  appId: "documents-connector",
  enabled: true,
  toolDefaults: { approval: "write_actions" },
} satisfies PluginDeploymentTool;

// @ts-expect-error Only the Harness consumes a Codex hosted app.
const _gatewayApp: PluginDeploymentTool = { ...hostedApp, role: "gateway" };
const _selectedTool: PluginDeploymentTool = {
  ...hostedApp,
  toolDefaults: { enabled: false },
  tools: { "documents-connector/read": { enabled: true } },
};
const filtered = { ...hostedApp, destructiveEnabled: false } satisfies PluginDeploymentTool;
// @ts-expect-error The native tool default would bypass the destructive-tool filter.
const _conflictingDefaults: PluginDeploymentTool = { ...filtered, toolDefaults: { enabled: true } };
const bundle = {
  kind: "codex-marketplace-selection",
  marketplaceName: "catalog",
  nativePluginId: "documents",
} as const;
const mixed = { ...hostedApp, installation: bundle };
// @ts-expect-error A bundle needs a separate installation entry.
const _appWithInstallation: PluginDeploymentTool = mixed;

const evaluator = {
  binary: "/usr/local/bin/gog",
  host: "calendar.googleapis.com",
  ports: [{ from: 443, to: 443 }],
  requestPolicy: { type: "evaluator", id: "google-workspace", digest: "a".repeat(64) },
} satisfies PluginDeploymentNetworkRequirement["match"];

const admitted = {
  ...evaluator,
  requestPolicy: {
    ...evaluator.requestPolicy,
    admittedSource: {
      bindingRef: "work-calendar",
      host: "calendar.googleapis.com",
      port: 443,
      path: "/calendar/**",
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    },
  },
} satisfies NetworkAccessPolicy["allowed"][number];

const _injection: CredentialInjectionPolicy = {
  bindingRef: "work-calendar",
  allowedRequests: [admitted],
};
// @ts-expect-error An evaluator reference alone cannot authorize sandbox network access.
const _missingNetworkScope: NetworkAccessPolicy = { allowed: [evaluator] };
const _missingInjectionScope: CredentialInjectionPolicy = {
  bindingRef: "work-calendar",
  // @ts-expect-error An evaluator reference alone cannot authorize credential injection.
  allowedRequests: [evaluator],
};
// @ts-expect-error Even a previously constructed value cannot supply source admission from a Plugin.
const _pluginOwnsAdmission: PluginDeploymentNetworkRequirement["match"] = admitted;
