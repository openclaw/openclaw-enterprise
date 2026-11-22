import type {
  CredentialInjectionPolicy,
  NetworkAccessPolicy,
  PluginDeploymentContract,
  PluginDeploymentTool,
  TokenServiceDriver,
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

// Resolution can return an unversioned credential; push delivery must reject it at runtime.
const _resolved: Awaited<ReturnType<TokenServiceDriver["resolveCredential"]>> = {
  credential: "synthetic-value",
};

// Discovery is network-only; Calendar access and injection share the admitted subtree.
const calendar = {
  binary: "/usr/local/bin/gog",
  host: "calendar.googleapis.com",
  ports: [{ from: 443, to: 443 }],
  requestPolicy: { type: "http", method: "GET", path: "/calendar/**" },
} satisfies NetworkAccessPolicy["allowed"][number];
const _network: NetworkAccessPolicy = {
  allowed: [
    calendar,
    {
      binary: "/usr/local/bin/gog",
      host: "calendar.googleapis.com",
      ports: [{ from: 443, to: 443 }],
      requestPolicy: { type: "http", method: "GET", path: "/$discovery/rest" },
    },
  ],
};
const _injection: CredentialInjectionPolicy = {
  bindingRef: "work-calendar",
  allowedRequests: [calendar],
};
