import type { AgentRevision, HarnessWorkloadRequirements } from "@openclaw-enterprise/contracts";
import { SandboxRevisionUnsupportedError } from "@openclaw-enterprise/occ";
import { asRecord, numericLastLabel } from "@openclaw-enterprise/utils";
import { openShellProviderName } from "../../backends/openshell.ts";
import { managedSlackCredentialBinding, managedSlackInstall } from "../plugin/managed-catalog.ts";
import { openShellProfileEndpoint } from "./openshell-gateway-client.ts";
import { sameOpenShellPolicy } from "./openshell-policy.ts";

export const slackMcpNetworkName = "oce-slack-mcp";

/** The profile contributes credential custody and a single harmless method.
 * Keep the same endpoint and MCP options on the Sandbox's revision rule. */
export const slackMcpProviderEndpoint = {
  ...managedSlackInstall.endpoint,
  protocol: "mcp",
  mcp: { strict_tool_names: true, versions: managedSlackInstall.mcpVersions },
  rules: [{ allow: { method: "ping" } }],
} as const;

function unsupported(message: string): never {
  throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", message);
}

export function slackMcpNetwork(toolNames: readonly string[]) {
  const methods = toolNames.length
    ? ["ping", "initialize", "notifications/initialized", "tools/list"]
    : ["ping"];
  const { port, ...endpoint } = openShellProfileEndpoint(slackMcpProviderEndpoint);
  return {
    name: slackMcpNetworkName,
    binaries: [{ path: managedSlackInstall.binaryPath }],
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

export function openShellSlackMcpPolicy(
  revision: Readonly<AgentRevision>,
  requirements: HarnessWorkloadRequirements,
  installationProviders: readonly string[],
) {
  const binding = managedSlackCredentialBinding(revision.plugins?.plugins);
  const attachments = requirements.credentialAttachments;
  const attached = attachments.filter(
    (item) => item.requestScope?.host === managedSlackInstall.endpoint.host,
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
    selected.ref !== openShellProviderName(selected.sourceId) ||
    selected.requestScope?.port !== managedSlackInstall.endpoint.port ||
    selected.requestScope?.path !== managedSlackInstall.endpoint.path ||
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
      "The Slack MCP credential requires its reviewed OpenShell provider and an isolated endpoint.",
    );
  }
  return {
    provider: {
      name: "_provider_" + selected.ref.replaceAll("-", "_"),
      binaries: [{ path: managedSlackInstall.binaryPath }],
      endpoints: [
        { ...openShellProfileEndpoint(slackMcpProviderEndpoint), provider_credentialed: true },
      ],
    },
    network: slackMcpNetwork(binding?.toolNames ?? []),
  };
}

/** Matching OpenShell allowances compose. A second route must not permit
 * uninspected traffic or grant another operation against the credentialed host. */
export function assertNoSlackMcpRouteOverlap(
  policies: unknown,
  exactRoutes: readonly string[] = [],
): void {
  const network = asRecord(policies);
  if (!network) {
    unsupported("OpenShell could not verify the Slack MCP network policy.");
  }
  const { host, port } = managedSlackInstall.endpoint;
  for (const [name, rule] of Object.entries(network)) {
    if (exactRoutes.includes(name)) {
      continue;
    }
    if (name === slackMcpNetworkName) {
      unsupported("The Slack MCP network rule name is reserved.");
    }
    const endpoints = asRecord(rule)?.endpoints;
    if (endpoints === undefined) {
      // OpenShell emits an endpointless provider for its runtime files.
      continue;
    }
    if (!Array.isArray(endpoints)) {
      unsupported("OpenShell could not verify an endpoint against the Slack MCP network policy.");
    }
    for (const entry of endpoints) {
      const endpoint = asRecord(entry);
      if (typeof endpoint?.host !== "string") {
        unsupported(
          "OpenShell could not verify a destination against the Slack MCP network policy.",
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
        unsupported("An OpenShell network route overlaps the credentialed Slack MCP endpoint.");
      }
    }
  }
}

export function verifySlackMcpPolicy(
  config: Readonly<Record<string, unknown>> | undefined,
  expected: NonNullable<ReturnType<typeof openShellSlackMcpPolicy>>,
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
    unsupported("OpenShell has not admitted the fail-closed Slack MCP network policy.");
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
      unsupported("OpenShell has not admitted the exact credentialed Slack MCP rules.");
    }
  }
  assertNoSlackMcpRouteOverlap(
    policies,
    exact.map(({ name }) => name),
  );
}
