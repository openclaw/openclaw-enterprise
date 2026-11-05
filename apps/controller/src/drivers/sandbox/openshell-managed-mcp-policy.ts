import type { AgentRevision, HarnessWorkloadRequirements } from "@openclaw-enterprise/contracts";
import { SandboxRevisionUnsupportedError } from "@openclaw-enterprise/occ";
import { asRecord, numericLastLabel } from "@openclaw-enterprise/utils";
import { openShellProviderName, revisionProviderSourceId } from "../../backends/openshell.ts";
import {
  type ManagedMcpInstall,
  managedMcpCredentialBinding,
  managedMcpInstalls,
} from "../plugin/managed-catalog.ts";
import { googleCredentialEndpoints } from "../plugin/google-workspace/operations.ts";
import { openShellProfileEndpoint } from "./openshell-gateway-client.ts";
import { sameOpenShellPolicy } from "./openshell-policy.ts";

function managedMcpNetworkName(install: ManagedMcpInstall): string {
  return `oce-${install.runtimeName}-mcp`;
}

/** The profile contributes credential custody and a single harmless method.
 * Keep the same endpoint and MCP options on the Sandbox's revision rule. */
export function managedMcpProviderEndpoint(install: ManagedMcpInstall) {
  return {
    ...install.endpoint,
    protocol: "mcp",
    mcp: { strict_tool_names: true, versions: install.mcpVersions },
    rules: [{ allow: { method: "ping" } }],
  } as const;
}

function unsupported(message: string): never {
  throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", message);
}

export function managedMcpNetwork(install: ManagedMcpInstall, toolNames: readonly string[]) {
  const methods = toolNames.length
    ? ["ping", "initialize", "notifications/initialized", "tools/list"]
    : ["ping"];
  const { port, ...endpoint } = openShellProfileEndpoint(managedMcpProviderEndpoint(install));
  return {
    name: managedMcpNetworkName(install),
    binaries: [{ path: install.binaryPath }],
    endpoints: [
      {
        ...endpoint,
        ports: [port],
        rules: [
          ...methods.map((method) => ({ allow: { method } })),
          ...toolNames.map((name) => ({
            allow: { method: "tools/call", params: { name: { glob: name } } },
          })),
        ],
      },
    ],
  };
}

function openShellManagedMcpPolicy(
  install: ManagedMcpInstall,
  revision: Readonly<AgentRevision>,
  requirements: HarnessWorkloadRequirements,
  installationProviders: readonly string[],
) {
  const binding = managedMcpCredentialBinding(revision.plugins?.plugins, install);
  const { host, port, path } = install.endpoint;
  const attached = requirements.credentialAttachments.filter(
    ({ sourceId, requestScope }) =>
      sourceId === binding?.sourceId ||
      (requestScope &&
        googleCredentialEndpoints(requestScope).some((ep) => ep.host === host && ep.port === port)),
  );
  const selected = attached[0];
  // Compute drops withdrawn sources from the dispatch even when the immutable revision names one.
  if (
    !selected &&
    (!binding || revision.credentialSources?.some(({ sourceId }) => sourceId === binding.sourceId))
  ) {
    return undefined;
  }
  if (
    attached.length !== 1 ||
    !selected ||
    selected.ref !== openShellProviderName(revisionProviderSourceId(revision, selected.sourceId)) ||
    !selected.requestScope ||
    "kind" in selected.requestScope ||
    selected.requestScope.host !== host ||
    selected.requestScope.port !== port ||
    selected.requestScope.path !== path ||
    requirements.proxyWiring ||
    revision.egressPlan ||
    installationProviders.length ||
    (binding &&
      (revision.plugins?.driver.implementation !== "occ/openclaw-plugin" ||
        revision.harness.id !== "openclaw" ||
        revision.harness.mode !== "dedicated" ||
        binding.sourceId !== selected.sourceId))
  ) {
    unsupported(
      "A managed MCP credential requires its reviewed OpenShell provider and an isolated endpoint.",
    );
  }
  return {
    install,
    provider: {
      name: "_provider_" + selected.ref.replaceAll("-", "_"),
      binaries: [{ path: install.binaryPath }],
      endpoints: [
        {
          ...openShellProfileEndpoint(managedMcpProviderEndpoint(install)),
          provider_credentialed: true,
        },
      ],
    },
    network: managedMcpNetwork(install, binding?.toolNames ?? []),
  };
}

export function openShellManagedMcpPolicies(
  revision: Readonly<AgentRevision>,
  requirements: HarnessWorkloadRequirements,
  installationProviders: readonly string[],
) {
  return managedMcpInstalls.flatMap((install) => {
    const policy = openShellManagedMcpPolicy(
      install,
      revision,
      requirements,
      installationProviders,
    );
    return policy ? [policy] : [];
  });
}

/** Matching OpenShell allowances compose. A second route must not permit
 * uninspected traffic or grant another operation against the credentialed host. */
export function assertNoManagedMcpRouteOverlap(
  policies: unknown,
  install: ManagedMcpInstall,
  exactRoutes: readonly string[] = [],
): void {
  const network = asRecord(policies);
  if (!network) {
    unsupported("OpenShell could not verify the managed MCP network policy.");
  }
  const { host, port } = install.endpoint;
  for (const [name, rule] of Object.entries(network)) {
    if (exactRoutes.includes(name)) {
      continue;
    }
    if (name === managedMcpNetworkName(install)) {
      unsupported("The managed MCP network rule name is reserved.");
    }
    const endpoints = asRecord(rule)?.endpoints;
    if (endpoints === undefined) {
      // OpenShell emits an endpointless provider for its runtime files.
      continue;
    }
    if (!Array.isArray(endpoints)) {
      unsupported("OpenShell could not verify an endpoint against the managed MCP network policy.");
    }
    for (const entry of endpoints) {
      const endpoint = asRecord(entry);
      if (typeof endpoint?.host !== "string") {
        unsupported(
          "OpenShell could not verify a destination against the managed MCP network policy.",
        );
      }
      const ports =
        Array.isArray(endpoint.ports) && endpoint.ports.length
          ? endpoint.ports
          : typeof endpoint.port === "number" && endpoint.port > 0
            ? [endpoint.port]
            : [port];
      if (!ports.includes(port)) {
        continue;
      }
      const candidate = endpoint.host.toLowerCase().replace(/\.$/, "");
      const wildcard = /^\*{1,2}\.[a-z0-9.-]+$/.test(candidate);
      if (
        (!wildcard && !/^[a-z0-9.-]+$/.test(candidate)) ||
        numericLastLabel(candidate) ||
        candidate === host ||
        (wildcard && host.endsWith(candidate.slice(candidate.indexOf("."))))
      ) {
        unsupported("An OpenShell network route overlaps the credentialed managed MCP endpoint.");
      }
    }
  }
}

export function verifyManagedMcpPolicy(
  config: Readonly<Record<string, unknown>> | undefined,
  expected: NonNullable<ReturnType<typeof openShellManagedMcpPolicy>>,
  workspace: string,
): void {
  if (
    config?.workspace !== workspace ||
    config.policy_source !== 1 ||
    config.global_policy_version ||
    config.configuration_admitted !== true ||
    config.configuration_error ||
    config.policy_validation_failure_mode !== "fail_closed"
  ) {
    unsupported("OpenShell has not admitted the fail-closed managed MCP network policy.");
  }
  const policies = asRecord(asRecord(config.policy)?.network_policies);
  const network = expected.network;
  const exact = [
    expected.provider,
    {
      ...network,
      endpoints: network.endpoints.map((endpoint) => ({
        ...endpoint,
        provider_credentialed: true,
      })),
    },
  ];
  for (const rule of exact) {
    if (!sameOpenShellPolicy(policies?.[rule.name], rule)) {
      unsupported("OpenShell has not admitted the exact credentialed managed MCP rules.");
    }
  }
  assertNoManagedMcpRouteOverlap(
    policies,
    expected.install,
    exact.map(({ name }) => name),
  );
}
