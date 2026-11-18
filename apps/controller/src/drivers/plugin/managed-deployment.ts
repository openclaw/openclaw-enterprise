import type {
  PluginDeploymentContract,
  PluginDeploymentDescription,
  PluginDeploymentNetworkRequirement,
  PluginDeploymentTool,
} from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import {
  googleActionPath,
  googleCatalog,
  googleDiscoveryRoutes,
  googleSourcePathMatches,
} from "./google-workspace/operations.ts";
import {
  managedCredentialBinding,
  managedMcpCredentialBinding,
  managedMcpRequests,
  type ManagedCliInstall,
  type ManagedMcpInstall,
} from "./managed-catalog.ts";

const googleDiscovery = googleDiscoveryRoutes().map(({ host, path }) => ({
  host,
  path,
  method: "GET",
}));

const googleActions = Object.values(googleCatalog.operations).map((operation) => {
  const { origin, method } = operation;
  const host = new URL(origin).hostname;
  const path = googleActionPath(operation);
  if (
    origin !== `https://${host}` ||
    googleDiscovery.some(
      (route) => route.host === host && googleSourcePathMatches(path, route.path),
    )
  ) {
    throw new Error("Google action endpoints must be HTTPS and separate from public discovery.");
  }
  return { host, method, path };
});

function googleNetworks(
  install: ManagedCliInstall,
  purpose: "action" | "discovery",
): PluginDeploymentNetworkRequirement[] {
  const routes = purpose === "action" ? googleActions : googleDiscovery;
  const rules = new Map<string, PluginDeploymentNetworkRequirement>();
  for (const { host, method, path } of routes) {
    const id = `${purpose}:${host}:${method}:${path}`;
    rules.set(id, {
      id,
      toolId: install.executable,
      purpose: "invocation",
      match: {
        binary: install.binaryPath,
        host,
        ports: [{ from: 443, to: 443 }],
        requestPolicy: { type: "http", method, path },
      },
    });
  }
  return [...rules.values()];
}

function mcpNetworks(
  install: ManagedMcpInstall,
  toolNames: readonly string[],
): PluginDeploymentNetworkRequirement[] {
  const { host, port, path } = install.endpoint;
  return managedMcpRequests(toolNames).map(({ method, toolName }) => ({
    id: toolName === undefined ? method : `${method}:${toolName}`,
    toolId: install.server,
    purpose: "invocation",
    match: {
      binary: install.binaryPath,
      host,
      ports: [{ from: port, to: port }],
      requestPolicy: { type: "mcp", path, method, ...(toolName === undefined ? {} : { toolName }) },
    },
  }));
}

export function describeManagedDeployment(
  install: ManagedCliInstall | ManagedMcpInstall,
  input: Parameters<PluginDeploymentContract["describeDeployment"]>[0],
): PluginDeploymentDescription {
  // Released packages currently project one account onto one fixed worker environment variable.
  const [requirement, slot] = Object.entries(install.credentials)[0]!;
  const selections = { [install.id]: input.selection };
  const mcp = install.kind === "mcp" ? managedMcpCredentialBinding(selections, install) : undefined;
  const binding = install.kind === "cli" ? managedCredentialBinding(selections, install) : mcp;
  const accounts = input.connections[requirement] ?? {};
  const sourceRef = accounts.default;
  if (
    Object.keys(input.connections).some((key) => key !== requirement) ||
    Object.keys(accounts).some((key) => key !== "default") ||
    sourceRef?.id !== binding?.sourceId ||
    (sourceRef !== undefined && (sourceRef.kind !== "credential_source" || !sourceRef.namespaceId))
  ) {
    throw new ConfigurationHarnessError(
      `Select the attached account for the ${install.entry.name} credential slot.`,
    );
  }

  if (!input.selection.enabled) {
    return {
      tools: [],
      workloadRequirements: [],
      networkRequirements: [],
      credentials: { [requirement]: {} },
    };
  }

  let consumer: PluginDeploymentTool;
  const imageDirectory = `/usr/local/lib/oce/plugin-catalog/${install.packageName}`;
  const tools: PluginDeploymentTool[] = [];
  let credentialRules: PluginDeploymentNetworkRequirement[] = [];
  let publicRules: PluginDeploymentNetworkRequirement[] = [];
  if (install.kind === "cli") {
    if (install.packageName !== "oce-google-workspace") {
      throw new ConfigurationHarnessError("The selected CLI has no reviewed deployment policy.");
    }
    tools.push({
      kind: "installation",
      id: install.skill,
      role: "gateway",
      installation: {
        kind: "image-skill",
        path: `${imageDirectory}/skills/${install.skill}/SKILL.md`,
        sha256: install.skillSha256,
      },
      selectedTools: [],
    });
    consumer = {
      kind: "installation",
      id: install.executable,
      role: "harness",
      installation: {
        kind: "image-executable",
        path: install.binaryPath,
        binarySha256ByPlatform: install.binarySha256ByPlatform,
      },
      selectedTools: [install.executable],
    };
    if (sourceRef) {
      credentialRules = googleNetworks(install, "action");
      publicRules = googleNetworks(install, "discovery");
    }
  } else {
    const selectedTools = mcp?.toolNames ?? [];
    consumer = {
      kind: "installation",
      id: install.server,
      role: "harness",
      installation: {
        kind: "hosted-mcp",
        endpoint: install.url,
        configuration: {
          kind: "image-manifest",
          path: `${imageDirectory}/mcp.json`,
          sha256: install.manifestSha256,
          server: install.server,
        },
      },
      selectedTools,
    };
    if (sourceRef) {
      credentialRules = mcpNetworks(install, selectedTools);
    }
  }
  tools.push(consumer);

  const account = sourceRef && {
    sourceRef,
    projection: { environment: slot.delivery.env, presentation: slot.delivery.presentation },
    toolIds: [consumer.id],
    networkRequirementIds: credentialRules.map(({ id }) => id),
  };
  return {
    releaseSha256: install.releaseSha256,
    tools,
    workloadRequirements: [],
    networkRequirements: [...credentialRules, ...publicRules],
    credentials: { [requirement]: account ? { default: account } : {} },
  };
}
