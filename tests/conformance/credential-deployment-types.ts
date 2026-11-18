import type {
  CredentialDeploymentConfiguration,
  CredentialInjectionPolicy,
  CredentialProxyDeploymentContract,
  DeploymentCredentialBinding,
  NetworkAccessPolicy,
  PluginDeploymentContract,
  PluginDeploymentNetworkRequirement,
  PluginDeploymentTool,
  SavedConnection,
  TokenServiceDriver,
  VersionedCredential,
} from "@openclaw-enterprise/contracts";

type DescribeInput = Parameters<PluginDeploymentContract["describeDeployment"]>[0];
const hostedPlugin = {
  catalog: "codex-hosted",
  pluginId: "codex-plugin:documents@openai-curated-remote",
  remotePluginId: "documents",
  requiresSkillBundle: false,
} as const;
const _defaultOnlySelection = {
  plugin: { ...hostedPlugin, appIds: ["document-index", "document-reader"] },
  selection: { enabled: true, toolDefaults: { enabled: true } },
  connections: {},
} satisfies DescribeInput;
// @ts-expect-error A hosted plugin ID alone does not supply its connector mapping.
const _unmapped: DescribeInput["plugin"] = hostedPlugin;

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

type EvaluatorAuthority = NonNullable<DeploymentCredentialBinding["evaluatorAuthority"]>;
declare const consent: SavedConnection;
// @ts-expect-error OCC must supply resolved evaluator authority separately from the saved consent.
const _consentAsAuthority: EvaluatorAuthority = consent;

type ReadVersion = NonNullable<TokenServiceDriver["getPushVersion"]>;
declare const pushedSource: Parameters<ReadVersion>[0];
const _nativeVersionRead: Parameters<ReadVersion>[0] = {
  ...pushedSource,
  // @ts-expect-error The native owner reports provider readiness through its own delivery path.
  registration: { delivery: "native", backendRef: {} },
};

type StatusInput = Parameters<CredentialProxyDeploymentContract["getDeploymentStatus"]>[0];
declare const target: CredentialDeploymentConfiguration;
declare const ownerVersion: Awaited<ReturnType<ReadVersion>>;
if (ownerVersion !== undefined) {
  const _expected: StatusInput = {
    ...target,
    expectedPushVersions: { "work-calendar": ownerVersion },
  };
}
// @ts-expect-error The desired configuration alone cannot identify a missed source update.
const _withoutOwnerVersions: StatusInput = target;
declare const material: VersionedCredential;
const _materialInStatus: StatusInput = {
  ...target,
  // @ts-expect-error Readiness takes a nonsecret version identifier for each pushed binding.
  expectedPushVersions: { "work-calendar": material },
};
