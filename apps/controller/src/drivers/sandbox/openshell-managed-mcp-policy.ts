import type { AgentRevision, HarnessWorkloadRequirements } from "@openclaw-enterprise/contracts";
import { SandboxRevisionUnsupportedError } from "@openclaw-enterprise/occ";
import { asRecord, numericLastLabel } from "@openclaw-enterprise/utils";
import { openShellProviderName } from "../../backends/openshell.ts";
import {
  type ManagedMcpInstall,
  managedMcpCredentialBinding,
  managedMcpCredentialEnvironment,
  managedMcpInstalls,
} from "../plugin/managed-catalog.ts";
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
  const selected = new Set(binding?.sourceIds);
  const attached = requirements.credentialAttachments.filter(
    ({ sourceId, requestScope }) =>
      selected.has(sourceId) || (requestScope?.host === host && requestScope.port === port),
  );
  // Compute omits withdrawn providers while the immutable revision retains their IDs.
  for (const id of selected) {
    if (
      !attached.some(({ sourceId }) => sourceId === id) &&
      !revision.credentialSources?.some(({ sourceId }) => sourceId === id)
    ) {
      unsupported("The selected managed MCP credential is missing from the revision.");
    }
  }
  if (!attached.length) {
    return undefined;
  }
  if (
    attached.some(
      ({ sourceId, ref, requestScope }) =>
        ref !== openShellProviderName(sourceId) ||
        requestScope?.host !== host ||
        requestScope.port !== port ||
        requestScope.path !== path ||
        (binding && !selected.has(sourceId)),
    ) ||
    (!binding && !install.repeatable && attached.length !== 1) ||
    requirements.proxyWiring ||
    revision.egressPlan ||
    installationProviders.length ||
    (binding &&
      (revision.plugins?.driver.implementation !== "occ/openclaw-plugin" ||
        revision.harness.id !== "openclaw" ||
        revision.harness.mode !== "dedicated"))
  ) {
    unsupported(
      "A managed MCP credential requires its reviewed OpenShell provider and an isolated endpoint.",
    );
  }
  return {
    install,
    credentialEnvironments: attached.map(({ sourceId }) =>
      managedMcpCredentialEnvironment(install, sourceId),
    ),
    providers: attached.map(({ ref }) => ({
      name: "_provider_" + ref.replaceAll("-", "_"),
      binaries: [{ path: install.binaryPath }],
      endpoints: [
        {
          ...openShellProfileEndpoint(managedMcpProviderEndpoint(install)),
          provider_credentialed: true,
        },
      ],
    })),
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
    ...expected.providers,
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
