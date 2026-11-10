import { inferenceKeyDestination, type AgentRevision } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { openShellProviderName } from "../../backends/openshell.ts";
import { savedModelProvider } from "../compute/model-provider.ts";
import {
  type OpenShellPolicyStatus,
  openShellProfileEndpoint,
} from "./openshell-gateway-client.ts";
import { AGENT_POLICY_PREFIX, sameOpenShellPolicy } from "./openshell-policy.ts";

export const PRIVATE_INFERENCE_HOLD = "oce-private-inference-hold";
export const PRIVATE_INFERENCE_READY = "/tmp/.oce-private-inference-ready";

// The source and its placeholder are present at startup. This fail-closed L7 denial spans
// every binary and matching endpoint, including the source-generated provider profile.
export function privateInferenceHold(revision: Readonly<AgentRevision>) {
  const peer = revision.harness.privateInferencePeer;
  if (!peer || revision.egressPlan) {
    return undefined;
  }
  const provider = savedModelProvider(revision.harness.configuration);
  if (!provider) {
    throw new Error("The private inference revision has no admitted model endpoint.");
  }
  const { host, port, method, path } = inferenceKeyDestination(provider.baseUrl, provider.protocol);
  return {
    name: PRIVATE_INFERENCE_HOLD,
    binaries: [{ path: "/**" }],
    endpoints: [
      {
        host,
        ports: [port],
        protocol: "rest",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        allowed_ips: [peer.address],
        rules: [{ allow: { method, path } }],
        deny_rules: [{ method, path }],
      },
    ],
  };
}

// OpenShell chooses the first matching endpoint for its SSRF allowlist. An independent
// allow (including wildcard or IP-only rules) cannot share the private credential's route.
function privateHostMatches(host: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return host === pattern;
  }
  if (pattern === "*") {
    return !host.includes(".");
  }
  const leadingWildcard = /^(\*{1,2})(\.[a-z0-9.-]+)$/.exec(pattern);
  if (!leadingWildcard) {
    return true;
  }
  const [, wildcard, suffix] = leadingWildcard;
  if (!host.endsWith(suffix!)) {
    return false;
  }
  const prefix = host.slice(0, -suffix!.length);
  return prefix.length > 0 && (wildcard === "**" || !prefix.includes("."));
}

export function assertExclusiveInferenceEndpoint(
  policies: unknown,
  destination: { host: string; ports: number[] },
  permitted: readonly string[],
) {
  const network = asRecord(policies);
  if (!network) {
    throw new Error("The private inference network policy is unavailable.");
  }
  for (const [name, rule] of Object.entries(network)) {
    if (permitted.includes(name)) {
      continue;
    }
    const endpoints = asRecord(rule)?.endpoints;
    if (!Array.isArray(endpoints)) {
      continue;
    }
    for (const field of endpoints) {
      const endpoint = asRecord(field);
      const ports =
        Array.isArray(endpoint?.ports) && endpoint.ports.length ? endpoint.ports : [endpoint?.port];
      if (!ports.includes(destination.ports[0])) {
        continue;
      }
      const host = typeof endpoint?.host === "string" ? endpoint.host.toLowerCase() : "";
      // The stock rule matcher supports literal hosts, DNS globs and hostless IP grants.
      const matches = !host
        ? Array.isArray(endpoint?.allowed_ips) && endpoint.allowed_ips.length > 0
        : privateHostMatches(destination.host, host);
      if (matches) {
        throw new Error(
          "An independent OpenShell network rule overlaps the private inference endpoint.",
        );
      }
    }
  }
}

export function verifyEffectivePrivateInferencePolicy(
  revision: Readonly<AgentRevision>,
  workspace: string,
  config: Readonly<Record<string, unknown>> | undefined,
  hold: NonNullable<ReturnType<typeof privateInferenceHold>>,
  held: boolean,
) {
  if (
    config?.workspace !== workspace ||
    config.policy_source !== 1 ||
    config.global_policy_version ||
    config.configuration_admitted !== true ||
    config.configuration_error ||
    config.policy_validation_failure_mode !== "fail_closed" ||
    revision.harnessAuth.method !== "credential_source"
  ) {
    throw new Error("OpenShell has not admitted the private inference provider policy.");
  }
  const destination = hold.endpoints[0]!;
  const policies = asRecord(asRecord(config.policy)?.network_policies);
  const name =
    "_provider_" + openShellProviderName(revision.harnessAuth.sourceId).replaceAll("-", "_");
  const expected = {
    ...openShellProfileEndpoint({
      host: destination.host,
      port: destination.ports[0]!,
      path: destination.rules[0]!.allow.path,
      protocol: "rest",
      allowedIps: destination.allowed_ips,
      rules: destination.rules,
    }),
    provider_credentialed: true,
  };
  if (
    !sameOpenShellPolicy(asRecord(policies?.[name])?.endpoints, [expected]) ||
    Object.hasOwn(policies ?? {}, PRIVATE_INFERENCE_HOLD) !== held
  ) {
    throw new Error("OpenShell has not loaded the exact private credential route.");
  }
  assertExclusiveInferenceEndpoint(
    policies,
    destination,
    held ? [name, PRIVATE_INFERENCE_HOLD] : [name],
  );
}

export function privateInferenceReleasedPolicy(policy: Readonly<Record<string, unknown>>) {
  const networks = asRecord(policy.network_policies);
  if (!networks) {
    throw new Error("The private inference policy is missing.");
  }
  const { [PRIVATE_INFERENCE_HOLD]: _hold, ...released } = networks;
  return { ...policy, network_policies: released };
}

export function verifiedPrivateInferencePolicyBase(
  revision: Readonly<AgentRevision>,
  baseline: Readonly<Record<string, unknown>>,
  status: OpenShellPolicyStatus,
) {
  const expectedHold = privateInferenceHold(revision);
  if (!expectedHold) {
    return baseline;
  }
  const networks = asRecord(baseline.network_policies);
  const current = asRecord(status.policy.network_policies);
  if (
    !networks ||
    !current ||
    !sameOpenShellPolicy(networks[PRIVATE_INFERENCE_HOLD], expectedHold)
  ) {
    throw new Error("The immutable Sandbox has no matching private inference hold.");
  }
  if (Object.hasOwn(current, PRIVATE_INFERENCE_HOLD)) {
    if (status.version !== 1 || !sameOpenShellPolicy(status.policy, baseline)) {
      throw new Error(
        "The loaded private inference policy differs from the immutable startup policy.",
      );
    }
    return baseline;
  }
  const released = privateInferenceReleasedPolicy(baseline);
  if (
    status.version === 2 &&
    status.privateInferenceRevisionId === revision.id &&
    sameOpenShellPolicy(status.policy, released)
  ) {
    return released;
  }
  // Later OCE live policy writes can replace only its Agent grants. The native revision
  // records their OCE revision ID. Every other source-policy field must still match.
  const fixedPolicy = (policy: Readonly<Record<string, unknown>>) => ({
    ...policy,
    network_policies: Object.fromEntries(
      Object.entries(asRecord(policy.network_policies) ?? {}).filter(
        ([name]) => !name.startsWith(AGENT_POLICY_PREFIX),
      ),
    ),
  });
  if (
    status.version > 2 &&
    status.privateInferenceRevisionId === revision.id &&
    sameOpenShellPolicy(fixedPolicy(status.policy), fixedPolicy(released))
  ) {
    return released;
  }
  throw new Error(
    "OpenShell did not load the expected private inference policy for this revision.",
  );
}
