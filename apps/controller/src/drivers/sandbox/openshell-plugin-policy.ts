import { openShellMiddlewareConfigFits } from "../egress-proxy/openshell-online-authority.ts";
import type { AgentRevision, HarnessWorkloadRequirements } from "@openclaw-enterprise/contracts";
import { SandboxRevisionUnsupportedError } from "@openclaw-enterprise/occ";
import { asRecord, numericLastLabel } from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";
import { openShellProviderName } from "../../backends/openshell.ts";
import {
  openShellProfileEndpoint,
  type OpenShellGatewayClient,
} from "./openshell-gateway-client.ts";
import {
  eligibleGoogleOperations,
  googleDiscoveryRequests,
  googleAccountScopes,
  googleAccountScopeConfig,
  type GoogleRequestScope,
} from "../plugin/google-workspace/operations.ts";
import { managedPluginGuardVersion } from "../plugin/managed-request-policies.ts";
import { wirePolicy } from "../egress-proxy/openshell-wire-policy.ts";
import {
  managedSlotBinding,
  managedPluginMiddleware,
  managedPluginMiddlewareAudience,
  managedPluginMiddlewareImplementation,
} from "../plugin/managed-catalog.ts";
import { managedGoogleInstall } from "../plugin/google-workspace/install.ts";

const googleRequestRuleName = "oce-google-requests";

function unsupported(message: string): never {
  throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", message);
}

/** The gateway negotiated this service's Describe at startup. Check it before creating any
 * credential-bearing Sandbox or reconciling its source profiles. GetSandboxConfig then proves
 * the exact endpoint and effective policy for the created Sandbox. */
export async function verifyManagedPluginRegistration(
  client: OpenShellGatewayClient,
  signal: AbortSignal,
): Promise<void> {
  const extensions = (await client.getGatewayInfo?.(signal))?.extensions;
  const services = Array.isArray(extensions)
    ? extensions
        .map(asRecord)
        .filter((service) => service?.configured_name === managedPluginMiddleware)
    : [];
  const service = services[0];
  const capabilities = ["openshell.supervisor-middleware.contract"];
  if (
    services.length !== 1 ||
    service?.kind !== 4 ||
    service.protocol_major !== 1 ||
    (service.protocol_minor ?? 0) !== 0 ||
    service.implementation_name !== managedPluginMiddlewareImplementation ||
    service.implementation_version !== managedPluginGuardVersion ||
    !isDeepStrictEqual(service.supported_capabilities, capabilities) ||
    !isDeepStrictEqual(service.required_capabilities, capabilities)
  ) {
    unsupported(
      "OpenShell has not negotiated the OCE plugin request guard for the selected release.",
    );
  }
}

export function openShellPluginPolicy(
  revision: Readonly<AgentRevision>,
  requirements: HarnessWorkloadRequirements,
  endpoint: string | undefined,
  installationProviders: readonly string[],
) {
  const binding = managedSlotBinding(revision.plugins?.plugins, managedGoogleInstall);
  if (!binding) {
    return undefined;
  }
  const model =
    revision.harnessAuth?.method === "credential_source" && revision.harnessAuth.sourceId;
  const attachments = requirements.credentialAttachments;
  const selected = attachments.filter(({ sourceId }) => binding.sourceIds.includes(sourceId));
  // Compute omits withdrawn sources while the immutable revision retains their references.
  if (
    binding.sourceIds.some(
      (id) =>
        !selected.some((item) => item.sourceId === id) &&
        !revision.credentialSources?.some(({ sourceId }) => id === sourceId),
    )
  ) {
    unsupported("The managed Google account requires its selected OpenShell provider.");
  }
  if (!selected.length) {
    return undefined;
  }
  if (
    revision.plugins?.driver.implementation !== "occ/openclaw-plugin" ||
    revision.harness.id !== "openclaw" ||
    revision.harness.mode !== "dedicated" ||
    revision.repositoryCredentials ||
    requirements.proxyWiring ||
    revision.egressPlan ||
    installationProviders.length ||
    !endpoint ||
    selected.some(
      (item) => item.sourceId === model || item.ref !== openShellProviderName(item.sourceId),
    ) ||
    (model &&
      !attachments.some((a) => a.sourceId === model && a.ref === openShellProviderName(model)))
  ) {
    unsupported(
      "This Google account requires its selected OpenShell provider, the dedicated OpenClaw worker and the registered OCE plugin request guard.",
    );
  }
  const accounts = Object.fromEntries(
    selected.map(({ sourceId, requestScope: scope }) => {
      if (!scope) {
        unsupported("The managed Google account requires its admitted endpoint and OAuth scopes.");
      }
      return [sourceId, scope] as const;
    }),
  );
  const providerRules = Object.entries(accounts).map(([sourceId, scope]) => ({
    name: "_provider_" + openShellProviderName(sourceId).replaceAll("-", "_"),
    binaries: [{ path: managedGoogleInstall.binaryPath }],
    endpoints: [
      {
        ...openShellProfileEndpoint({
          host: scope.host,
          port: scope.port,
          path: scope.path,
          protocol: "rest",
        }),
        provider_credentialed: true,
      },
    ],
  }));
  return { ...googleRequestPolicy(accounts), endpoint, providerRules };
}

// The authenticated supervisor supplies the admitted destination and OAuth scopes for each
// selected source. Public discovery requests can serve more than one account.
export function googleRequestPolicy(accounts: Record<string, GoogleRequestScope>) {
  const allows = new Map<string, Map<string, { method: string; path: string }>>();
  function permit(host: string, method: string, path: string) {
    const rules = allows.get(host) ?? new Map();
    rules.set(method + " " + path, { method, path });
    allows.set(host, rules);
  }
  for (const scope of Object.values(accounts)) {
    const entries = eligibleGoogleOperations(scope);
    if (!entries.length) {
      unsupported("The Google account has no admitted plugin operations.");
    }
    for (const [, op] of entries) {
      const literal = op.path.split("{")[0]!;
      const inside =
        scope.path === "/**" ||
        (scope.path.endsWith("/**") && literal.startsWith(scope.path.slice(0, -2)));
      const path = inside ? op.path.replace(/\{\+?\w+\}/g, "*") : scope.path;
      permit(scope.host, op.method, path);
    }
    for (const { host, path } of googleDiscoveryRequests(scope, entries)) {
      permit(host, "GET", path);
    }
  }
  const hosts = [...allows.keys()];
  const middlewares = {
    [managedPluginMiddleware]: {
      name: managedPluginMiddleware,
      middleware: managedPluginMiddleware,
      config: {
        fields: {
          binding_id: { stringValue: managedGoogleInstall.releaseSha256 },
          request_scope: { stringValue: googleAccountScopeConfig(accounts) },
        },
      },
      on_error: "fail_closed",
      endpoints: { include: hosts },
      order: 2_147_483_647,
    },
  };
  const config = middlewares[managedPluginMiddleware].config;
  if (!openShellMiddlewareConfigFits(config)) {
    unsupported(
      "The combined Google account request policy exceeds OpenShell's 64 KiB middleware configuration limit.",
    );
  }
  const networks = {
    [googleRequestRuleName]: {
      name: googleRequestRuleName,
      binaries: [{ path: managedGoogleInstall.binaryPath }],
      endpoints: [...allows].map(([host, rules]) => ({
        host,
        ports: [443],
        protocol: "rest",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        rules: [...rules.values()].map((allow) => ({ allow })),
      })),
    },
  };
  return {
    hosts,
    accounts: googleAccountScopes(config.fields.request_scope.stringValue)!,
    middlewares,
    networks,
  };
}

export function googleRequestPolicyFromSandbox(policy: unknown) {
  const middlewares = asRecord(asRecord(policy)?.network_middlewares);
  if (!middlewares || !Object.hasOwn(middlewares, managedPluginMiddleware)) {
    return undefined;
  }
  const middleware = asRecord(middlewares[managedPluginMiddleware]);
  const fields = asRecord(asRecord(middleware?.config)?.fields);
  const scope = googleAccountScopes(asRecord(fields?.request_scope)?.stringValue);
  if (!scope || asRecord(fields?.binding_id)?.stringValue !== managedGoogleInstall.releaseSha256) {
    unsupported("OpenShell has a stale or malformed Google account request guard.");
  }
  const expected = googleRequestPolicy(scope);
  assertPluginRequestPolicy(policy, expected);
  return expected;
}

// An IP (including numeric URL spellings), overlapping wildcard or TLS-pass-through grant can
// send traffic to a protected destination outside HTTP inspection, regardless of its binary.
export function assertPluginNetworkInspection(rules: unknown, hosts: readonly string[]): void {
  const record = asRecord(rules);
  if (!record) {
    unsupported("OpenShell could not verify the managed plugin network policy.");
  }
  for (const value of Object.values(record)) {
    const rule = asRecord(value);
    const endpoints = rule?.endpoints;
    // Stock OpenShell emits a named, endpointless rule for the runtime-file provider.
    if (rule && endpoints === undefined) {
      continue;
    }
    if (!Array.isArray(endpoints)) {
      unsupported("OpenShell could not verify the managed plugin endpoints.");
    }
    for (const entry of endpoints) {
      const endpoint = asRecord(entry);
      if (!endpoint || typeof endpoint.host !== "string") {
        unsupported("OpenShell could not verify a managed plugin destination.");
      }
      if (Array.isArray(endpoint.ports) && endpoint.ports.length && !endpoint.ports.includes(443)) {
        continue;
      }
      const host = endpoint.host.toLowerCase().replace(/\.$/, "");
      const exact = hosts.includes(host);
      const wildcard = host.startsWith("*.") && hosts.some((h) => h.endsWith(host.slice(1)));
      if (
        !/^(?:\*\.)?[a-z0-9.-]+$/.test(host) ||
        numericLastLabel(host) ||
        wildcard ||
        (exact &&
          (!isDeepStrictEqual(wirePolicy(rule?.binaries), [
            { path: managedGoogleInstall.binaryPath },
          ]) ||
            endpoint.protocol !== "rest" ||
            (endpoint.tls !== undefined &&
              endpoint.tls !== 0 &&
              endpoint.tls !== "NETWORK_TLS_MODE_UNSPECIFIED") ||
            (endpoint.enforcement !== 1 &&
              endpoint.enforcement !== "NETWORK_ENFORCEMENT_MODE_ENFORCE")))
      ) {
        unsupported("An OpenShell network route can bypass the managed plugin HTTP request guard.");
      }
    }
  }
}

export function verifyPluginRequestGuard(
  config: Readonly<Record<string, unknown>> | undefined,
  expected: NonNullable<ReturnType<typeof openShellPluginPolicy>>,
  workspace: string,
): void {
  const services = config?.supervisor_middleware_services;
  const service =
    Array.isArray(services) &&
    services.map(asRecord).filter((s) => s?.name === managedPluginMiddleware);
  const registration = service && service.length === 1 ? service[0] : undefined;
  if (
    config?.workspace !== workspace ||
    config.policy_source !== 1 ||
    config.global_policy_version ||
    config.configuration_admitted !== true ||
    config.configuration_error ||
    config.policy_validation_failure_mode !== "fail_closed" ||
    config.extension_authentication_enabled !== true ||
    !registration ||
    registration.grpc_endpoint !== expected.endpoint ||
    registration.allow_insecure_transport ||
    registration.audience !== managedPluginMiddlewareAudience
  ) {
    unsupported(
      "OpenShell has not admitted the authenticated, fail-closed OCE plugin request guard.",
    );
  }
  // OpenShell stamps every effective endpoint whose host, port and top-level path
  // are covered by a credential. Our operation paths live under rules; their
  // enclosing endpoint has path /**. Only a host-wide source covers that endpoint.
  const credentials = expected.providerRules.flatMap((rule) => rule.endpoints);
  const rule = expected.networks[googleRequestRuleName];
  const endpoints = rule.endpoints.map((endpoint) =>
    credentials.some(
      (credential) =>
        credential.path === "/**" &&
        endpoint.host === credential.host &&
        endpoint.ports.includes(credential.port),
    )
      ? { ...endpoint, provider_credentialed: true }
      : endpoint,
  );
  assertPluginRequestPolicy(config.policy, {
    ...expected,
    networks: { [googleRequestRuleName]: { ...rule, endpoints } },
  });
  const routes = asRecord(asRecord(config.policy)?.network_policies);
  for (const [name, value] of Object.entries(routes ?? {})) {
    if (
      expected.providerRules.some((rule) => name === rule.name) ||
      name === googleRequestRuleName
    ) {
      continue;
    }
    const endpoints = asRecord(value)?.endpoints;
    if (
      Array.isArray(endpoints) &&
      endpoints.some((entry) => {
        const ep = asRecord(entry);
        return ep?.provider_credentialed === true && expected.hosts.includes(String(ep.host));
      })
    ) {
      unsupported(
        "Another credential provider uses a guarded Google host. Configure distinct destinations for independent credentials.",
      );
    }
  }
  if (
    expected.providerRules.some(
      (rule) => !isDeepStrictEqual(wirePolicy(routes?.[rule.name]), wirePolicy(rule)),
    )
  ) {
    unsupported("OpenShell has not admitted the selected account’s exact Google provider route.");
  }
}

export function assertPluginRequestPolicy(
  value: unknown,
  expected: ReturnType<typeof googleRequestPolicy>,
): void {
  const policy = asRecord(value);
  if (
    !policy ||
    !isDeepStrictEqual(
      wirePolicy({ network_middlewares: policy.network_middlewares }),
      wirePolicy({ network_middlewares: expected.middlewares }),
    )
  ) {
    unsupported(
      "OpenShell has not admitted the authenticated, fail-closed OCE plugin request guard.",
    );
  }
  const networks = asRecord(policy.network_policies);
  if (
    !networks ||
    !isDeepStrictEqual(
      wirePolicy(networks[googleRequestRuleName]),
      wirePolicy(expected.networks[googleRequestRuleName]),
    )
  ) {
    unsupported("OpenShell has not admitted the pinned Google request routes.");
  }
  assertPluginNetworkInspection(networks, expected.hosts);
}
