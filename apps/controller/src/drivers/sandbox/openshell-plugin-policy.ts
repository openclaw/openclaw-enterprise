import type { AgentRevision, HarnessWorkloadRequirements } from "@openclaw-enterprise/contracts";
import { SandboxRevisionUnsupportedError } from "@openclaw-enterprise/occ";
import { asRecord, numericLastLabel } from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";
import { openShellProviderName } from "../../backends/openshell.ts";
import { openShellProfileEndpoint } from "./openshell-gateway-client.ts";
import { wirePolicy } from "../egress-proxy/openshell-wire-policy.ts";
import {
  managedCredentialBinding,
  managedGoogleInstall,
  managedPluginMiddleware,
  managedPluginMiddlewareAudience,
  type ManagedCredentialSlot,
} from "../plugin/managed-catalog.ts";

export const managedGoogleCredentialEnvironment = "OPENCLAW_MANAGED_GOOGLE_CREDENTIAL_ENV";

function unsupported(message: string): never {
  throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", message);
}

export function openShellPluginPolicy(
  revision: Readonly<AgentRevision>,
  requirements: HarnessWorkloadRequirements,
  endpoint: string | undefined,
  installationProviders: readonly string[],
) {
  const binding = managedCredentialBinding(revision.plugins?.plugins);
  if (!binding) {
    return undefined;
  }
  const model =
    revision.harnessAuth?.method === "credential_source" && revision.harnessAuth.sourceId;
  const expected = [binding.sourceId, ...(model ? [model] : [])];
  const attachments = requirements.credentialAttachments;
  if (
    revision.plugins?.driver.implementation !== "occ/openclaw-plugin" ||
    revision.harness.id !== "openclaw" ||
    revision.harness.mode !== "dedicated" ||
    revision.repositoryCredentials ||
    requirements.proxyWiring ||
    revision.egressPlan ||
    installationProviders.length ||
    !endpoint ||
    model === binding.sourceId ||
    attachments.length !== expected.length ||
    !expected.every((id) =>
      attachments.some((a) => a.sourceId === id && a.ref === openShellProviderName(id)),
    )
  ) {
    unsupported(
      "This Google account requires its selected OpenShell provider, the dedicated OpenClaw worker and the registered OCE plugin request guard.",
    );
  }
  // The ready source authorizes a single host and path. Verify the Gateway actually composed
  // that provider without extra destinations or binaries, even on adoption.
  const target = new URL(binding.credential.requests[0]!.url);
  const provider = "_provider_" + openShellProviderName(binding.sourceId).replaceAll("-", "_");
  const providerRule = {
    name: provider,
    binaries: [{ path: managedGoogleInstall.binaryPath }],
    endpoints: [
      {
        ...openShellProfileEndpoint({
          host: target.hostname,
          port: Number(target.port || 443),
          path: target.pathname,
          protocol: "rest",
        }),
        provider_credentialed: true,
      },
    ],
  };
  return { ...googleRequestPolicy(binding.credential), endpoint, providerRule };
}

export function googleRequestPolicy(credential: ManagedCredentialSlot) {
  const requests = [...credential.requests, ...managedGoogleInstall.publicRequests];
  const hosts = [...new Set(requests.map(({ url }) => new URL(url).hostname))];
  const middlewares = {
    [managedPluginMiddleware]: {
      name: managedPluginMiddleware,
      middleware: managedPluginMiddleware,
      config: { fields: { binding_id: { stringValue: managedGoogleInstall.releaseSha256 } } },
      on_error: "fail_closed",
      endpoints: { include: hosts },
      order: 2_147_483_647,
    },
  };
  const name = "oce-google-requests";
  const networks = {
    [name]: {
      name,
      binaries: [{ path: managedGoogleInstall.binaryPath }],
      endpoints: requests.map((request) => {
        const url = new URL(request.url);
        return {
          host: url.hostname,
          ports: [Number(url.port || 443)],
          protocol: "rest",
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          rules: [
            {
              allow: {
                method: request.method,
                path: url.pathname,
                ...(request.query && {
                  query: Object.fromEntries(
                    Object.entries(request.query).map(([k, v]) => [k, { glob: v }]),
                  ),
                }),
              },
            },
          ],
        };
      }),
    },
  };
  return { hosts, middlewares, networks, environment: credential.delivery.env };
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
  assertPluginRequestPolicy(config.policy, expected);
  const routes = asRecord(asRecord(config.policy)?.network_policies);
  if (
    !isDeepStrictEqual(
      wirePolicy(routes?.[expected.providerRule.name]),
      wirePolicy(expected.providerRule),
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
      wirePolicy(networks["oce-google-requests"]),
      wirePolicy(expected.networks["oce-google-requests"]),
    )
  ) {
    unsupported("OpenShell has not admitted the pinned Google request routes.");
  }
  assertPluginNetworkInspection(networks, expected.hosts);
}
