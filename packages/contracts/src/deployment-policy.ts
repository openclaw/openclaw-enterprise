import {
  requestCovered,
  disjointRequests,
  hostCovered,
  intersectPorts,
  portsCovered,
  validateMatches,
} from "./deployment-request-match.ts";
import { isIP } from "node:net";
import { publicCaBundle } from "@openclaw-enterprise/utils";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ErrorDetail } from "./api/common.ts";
import type {
  CredentialInjectionPolicy,
  CredentialProxyRouting,
  DeploymentCredentialBinding,
  DeploymentRequestMatch,
  DeploymentRequestPolicy,
  NetworkAccessPolicy,
} from "./credential-deployment.ts";
import {
  type SandboxNetworkGrant,
  validDnsHost,
  SandboxNetworkGrantSchema,
} from "./sandbox-policy.ts";

// Drivers must qualify the entire match, including its path semantics and evaluator pin.
// The currently implemented Sandbox network-policy facet has transport rules only.
interface RequestPolicyCapabilities {
  /** Only reviewed evaluators present in this enforcing runtime, with the exact revision pin. */
  readonly evaluators?: readonly { readonly id: string; readonly digest: string }[];
}

// Capability checks are trusted Driver code. Keep an unavailable Driver's exception out of admission errors.
function supported(check: () => boolean | undefined): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

function evaluatorAvailable(
  policy: DeploymentRequestPolicy | undefined,
  capabilities: RequestPolicyCapabilities,
): boolean {
  return (
    policy?.type !== "evaluator" ||
    capabilities.evaluators?.some((pin) => pin.id === policy.id && pin.digest === policy.digest) ===
      true
  );
}

/** A selected Sandbox offering these capabilities enforces executable, destination and port. */
export interface NetworkPolicyCapabilities extends RequestPolicyCapabilities {
  readonly wildcards: boolean;
  readonly portRanges: boolean;
  /** Qualifies the effective policy as a whole, including default routes and executable/port isolation. */
  readonly supportsNetworkPolicy: (policy: NetworkAccessPolicy) => boolean;
}

export function sandboxNetworkGrantsWithinCeiling(
  grants: readonly DeploymentRequestMatch[],
  ceiling: readonly DeploymentRequestMatch[],
): boolean {
  return grants.every((grant) => requestCovered(grant, ceiling));
}

/** Existing Agent grants have already passed SandboxNetworkGrantSchema and the Sandbox transport contract.
 * A request restriction always requires explicit support from the enforcing Sandbox. */
export function networkGrantAdmissionDetails(
  grants: readonly DeploymentRequestMatch[],
  ceiling: readonly DeploymentRequestMatch[],
  capabilities: Pick<NetworkPolicyCapabilities, "wildcards" | "portRanges"> &
    Partial<NetworkPolicyCapabilities>,
  pointer: string,
): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  grants.forEach((grant, index) => {
    const path = `${pointer}/${index}`;
    if (!requestCovered(grant, ceiling)) {
      details.push({
        path,
        code: "OUTSIDE_CEILING",
        message: "The grant exceeds the Installation delegation ceiling.",
      });
    }
    if (
      (!capabilities.wildcards && grant.host.startsWith("*.")) ||
      (!capabilities.portRanges && grant.ports.some(({ from, to }) => from !== to))
    ) {
      details.push({
        path,
        code: "INVALID_VALUE",
        message: "The Driver does not support the requested wildcard or port range.",
      });
    }
    if (
      grant.requestPolicy &&
      (!capabilities.supportsNetworkPolicy ||
        !evaluatorAvailable(grant.requestPolicy, capabilities))
    ) {
      details.push(
        invalid(path, "The Sandbox cannot enforce this complete network request match."),
      );
    }
  });
  if (
    !details.length &&
    capabilities.supportsNetworkPolicy &&
    !supported(() => capabilities.supportsNetworkPolicy?.({ allowed: grants }))
  ) {
    details.push(
      invalid(pointer, "The Sandbox cannot enforce the complete effective network policy."),
    );
  }
  return details;
}

function deploymentNetworkAccessDetails(
  policy: NetworkAccessPolicy,
  ceiling: readonly DeploymentRequestMatch[],
  capabilities: NetworkPolicyCapabilities,
): ErrorDetail[] {
  const pointer = "/networkAccessPolicy/allowed";
  if (
    !policy ||
    !Array.isArray(policy.allowed) ||
    Object.keys(policy).some((key) => key !== "allowed")
  ) {
    return [
      { path: pointer, code: "INVALID_VALUE", message: "Supply the network access allowlist." },
    ];
  }
  const details = validateMatches(policy.allowed, pointer);
  if (details.length) {
    return details;
  }
  if (typeof capabilities?.supportsNetworkPolicy !== "function") {
    return [invalid(pointer, "The selected Sandbox has no qualified network enforcement.")];
  }
  return networkGrantAdmissionDetails(policy.allowed, ceiling, capabilities, pointer);
}

/** From the selected enforcing implementation. Source, Plugin and workload input cannot declare capabilities. */
export interface CredentialInjectionCapabilities extends RequestPolicyCapabilities {
  readonly distinguishesExecutable: boolean;
  readonly distinguishesPort: boolean;
  readonly rejectsStaleAndMisplacedPlaceholders: boolean;
  /** Checks the exact presentation and request in the combined deployment, including other bindings
   * and the source-specific inputs to any pinned evaluator. */
  readonly supportsBindingRequest: (
    binding: DeploymentCredentialBinding,
    match: DeploymentRequestMatch,
    deployment: Pick<
      CredentialPolicyAdmission,
      "networkAccessPolicy" | "injectionPolicies" | "bindings"
    >,
  ) => boolean;
}

// If the proxy cannot observe a dimension, inspect every caller the Sandbox can send
// there. A credentialless allowance for a second executable can invalidate the pair.
function safelyComposed(
  rule: DeploymentRequestMatch,
  bindingRules: readonly DeploymentRequestMatch[],
  network: NetworkAccessPolicy,
  proxy: CredentialInjectionCapabilities,
): boolean {
  if (proxy.distinguishesExecutable === true && proxy.distinguishesPort === true) {
    return true;
  }
  return network.allowed.every((reachable) => {
    if (
      (proxy.distinguishesExecutable === true && reachable.binary !== rule.binary) ||
      disjointRequests(rule.requestPolicy, reachable.requestPolicy)
    ) {
      return true;
    }
    const ruleCoversReachableHost = hostCovered(reachable.host, rule.host);
    if (!ruleCoversReachableHost && !hostCovered(rule.host, reachable.host)) {
      return true;
    }
    const ports =
      proxy.distinguishesPort === true
        ? intersectPorts(reachable.ports, rule.ports)
        : reachable.ports;
    const requestPolicy = rule.requestPolicy ?? reachable.requestPolicy;
    return (
      !ports.length ||
      requestCovered(
        {
          ...rule,
          binary: reachable.binary,
          host: ruleCoversReachableHost ? reachable.host : rule.host,
          ports,
          ...(requestPolicy && { requestPolicy }),
        },
        bindingRules,
      )
    );
  });
}

function invalid(path: string, message: string): ErrorDetail {
  return { path, code: "INVALID_VALUE", message };
}

const reviewedPresentations = {
  plugin: ["bearer"],
  model: ["bearer", "x-api-key"],
  repository: ["repository_git", "github_installation", "github_repository"],
} satisfies Record<
  DeploymentCredentialBinding["consumer"]["kind"],
  readonly DeploymentCredentialBinding["projection"]["presentation"][]
>;

export interface CredentialPolicyAdmission {
  readonly networkAccessPolicy: NetworkAccessPolicy;
  readonly ceiling: readonly SandboxNetworkGrant[];
  readonly sandbox: NetworkPolicyCapabilities;
  /** OCC authorizes source use; each consumer supplies its reviewed projection and request rules.
   * Plugin input must use the named connection's networkRequirementIds, not all rules on that host. */
  readonly bindings: readonly DeploymentCredentialBinding[];
  readonly injectionPolicies: readonly CredentialInjectionPolicy[];
  /** False only for a target known to have no issued placeholders. Retain the guard through withdrawal. */
  readonly targetMayHoldPlaceholders: boolean;
  readonly proxy?: CredentialInjectionCapabilities;
}

export function deploymentPolicyAdmissionDetails(input: CredentialPolicyAdmission): ErrorDetail[] {
  const { networkAccessPolicy, proxy } = input;
  const details = deploymentNetworkAccessDetails(networkAccessPolicy, input.ceiling, input.sandbox);
  if (details.length) {
    return details;
  }
  if (
    input.targetMayHoldPlaceholders !== false &&
    networkAccessPolicy.allowed.length &&
    proxy?.rejectsStaleAndMisplacedPlaceholders !== true
  ) {
    return [
      invalid(
        "/injectionPolicies",
        "Withdrawal requires the proxy to reject previously issued placeholders on the remaining network routes.",
      ),
    ];
  }
  const bindings = new Map<string, DeploymentCredentialBinding>();
  const environments = new Set<string>();
  for (const [index, binding] of input.bindings.entries()) {
    const path = `/bindings/${index}`;
    if (
      typeof binding?.bindingRef !== "string" ||
      !binding.bindingRef.length ||
      bindings.has(binding.bindingRef)
    ) {
      return [invalid(path, "Each deployment binding needs a distinct identity.")];
    }
    const projection = binding.projection;
    if (
      !projection ||
      typeof projection.environment !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(projection.environment) ||
      environments.has(projection.environment)
    ) {
      return [invalid(path, "Each binding needs a distinct environment variable.")];
    }
    const kind = binding.consumer?.kind;
    if (
      !Object.hasOwn(reviewedPresentations, kind) ||
      !reviewedPresentations[kind].some(
        (presentation) => presentation === projection.presentation,
      ) ||
      Object.keys(projection).some((key) => key !== "environment" && key !== "presentation")
    ) {
      return [
        invalid(
          path,
          "The reviewed credential presentation is missing or incompatible with the consumer.",
        ),
      ];
    }
    bindings.set(binding.bindingRef, binding);
    environments.add(projection.environment);
  }
  for (const [index, policy] of input.injectionPolicies.entries()) {
    const path = `/injectionPolicies/${index}`;
    const binding = bindings.get(policy?.bindingRef);
    if (
      !binding ||
      !Array.isArray(policy.allowedRequests) ||
      !policy.allowedRequests.length ||
      Object.keys(policy).some((key) => key !== "bindingRef" && key !== "allowedRequests")
    ) {
      return [invalid(path, "Supply one nonempty injection policy for each admitted binding.")];
    }
    bindings.delete(binding.bindingRef);
    if (proxy?.rejectsStaleAndMisplacedPlaceholders !== true || !proxy.supportsBindingRequest) {
      return [
        invalid(
          path,
          "The selected proxy must reject stale and misplaced placeholders before forwarding.",
        ),
      ];
    }
    const issues = validateMatches(policy.allowedRequests, path + "/allowedRequests");
    if (issues.length) {
      return issues;
    }
    for (const [i, rule] of policy.allowedRequests.entries()) {
      const pointer = `${path}/allowedRequests/${i}`;
      if (!requestCovered(rule, networkAccessPolicy.allowed)) {
        return [
          invalid(
            pointer,
            "Credential injection requires an independent network allowance for the complete request.",
          ),
        ];
      }
      if (
        !evaluatorAvailable(rule.requestPolicy, proxy) ||
        !supported(() => proxy.supportsBindingRequest(binding, rule, input)) ||
        !safelyComposed(rule, policy.allowedRequests, networkAccessPolicy, proxy)
      ) {
        return [
          invalid(
            pointer,
            "The selected Sandbox and proxy cannot enforce this binding's complete request and presentation.",
          ),
        ];
      }
    }
  }
  if (bindings.size) {
    return [invalid("/injectionPolicies", "An admitted binding is missing its injection policy.")];
  }
  return [];
}

const strict = { additionalProperties: false } as const;
const { host, ports } = SandboxNetworkGrantSchema.properties;
const destinationSchema = Type.Object({ host, ports }, strict);
const routingSchema = Type.Object(
  {
    endpoint: Type.Object(
      { host: Type.String(), port: Type.Integer({ minimum: 1, maximum: 65535 }) },
      strict,
    ),
    destinations: Type.Array(destinationSchema),
    publicTrustBundlePem: Type.Optional(Type.String()),
  },
  strict,
);

/** For a standalone proxy, before Sandbox creation. Routing never creates a network grant. */
export function credentialProxyRoutingDetails(
  network: NetworkAccessPolicy,
  routing: CredentialProxyRouting,
  canEnforceRouting: (routing: CredentialProxyRouting, policy: NetworkAccessPolicy) => boolean,
): ErrorDetail[] {
  const pointer = "/proxyRouting";
  if (
    !Check(routingSchema, routing) ||
    !(isIP(routing.endpoint.host) || validDnsHost(routing.endpoint.host))
  ) {
    return [invalid(pointer, "Supply an exact proxy endpoint and its mandatory destinations.")];
  }
  for (const destination of routing.destinations) {
    if (
      !validDnsHost(destination.host.replace(/^\*\./, "")) ||
      destination.ports.some(({ from, to }) => from > to)
    ) {
      return [
        invalid(pointer + "/destinations", "Supply valid proxy destination hosts and port ranges."),
      ];
    }
  }
  if (routing.publicTrustBundlePem !== undefined) {
    try {
      publicCaBundle(routing.publicTrustBundlePem);
    } catch {
      return [invalid(pointer + "/publicTrustBundlePem", "Supply only public CA certificates.")];
    }
  }
  // A misplaced placeholder can be sent on a credentialless connection. Route all
  // allowed destinations through the guard, even after a single binding is withdrawn.
  for (const grant of network.allowed) {
    if (
      !portsCovered(
        grant.ports,
        routing.destinations.filter((route) => hostCovered(grant.host, route.host)),
      )
    ) {
      return [
        invalid(
          pointer + "/destinations",
          "The mandatory proxy routes must cover every allowed destination and port.",
        ),
      ];
    }
  }
  if (!supported(() => canEnforceRouting(routing, network))) {
    return [
      invalid(
        pointer,
        "The Sandbox cannot install the required trust and prevent direct access before launch.",
      ),
    ];
  }
  return [];
}
