import {
  requestCovered,
  requestPolicyCovered,
  disjointRequests,
  hostCovered,
  intersectPorts,
  pathCovered,
  portsCovered,
  validateMatches,
} from "./deployment-request-match.ts";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { publicCaBundle } from "@openclaw-enterprise/utils";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ErrorDetail } from "./api/common.ts";
import type { ConnectionEndpoint } from "./connection-templates.ts";
import type {
  CredentialInjectionPolicy,
  CredentialProxyRouting,
  DeploymentCredentialBinding,
  DeploymentRequestMatch,
  NetworkAccessPolicy,
} from "./credential-deployment.ts";
import {
  type SandboxNetworkGrant,
  validDnsHost,
  SandboxNetworkGrantSchema,
} from "./sandbox-policy.ts";

// Capability checks are trusted Driver code. Keep an unavailable Driver's exception out of admission errors.
function supported(check: () => boolean | undefined): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

/** A selected Sandbox offering these capabilities enforces executable, destination and port. */
export interface NetworkPolicyCapabilities {
  readonly wildcards: boolean;
  readonly portRanges: boolean;
  /** Qualifies the complete allowlist, including default routes, request restrictions and executable/port isolation. */
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
    if (grant.requestPolicy && !capabilities.supportsNetworkPolicy) {
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
export interface CredentialInjectionCapabilities {
  readonly distinguishesExecutable: boolean;
  readonly distinguishesPort: boolean;
  readonly rejectsStaleAndMisplacedPlaceholders: boolean;
  /** Qualifies the complete request and presentation for the binding identified by the placeholder. */
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
    const requestPolicy = requestPolicyCovered(reachable.requestPolicy, rule.requestPolicy)
      ? reachable.requestPolicy
      : rule.requestPolicy;
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

function sourceCoversRequest(
  destinations: readonly ConnectionEndpoint[],
  rule: DeploymentRequestMatch,
): boolean {
  // A transport-only grant can reach any path. An exact source host and all requested
  // ports must authorize that reach, even if network access was independently approved.
  if (!validDnsHost(rule.host)) {
    return false;
  }
  const path = rule.requestPolicy?.path ?? "/**";
  const routes = destinations
    .filter(
      (endpoint) =>
        endpoint?.host === rule.host &&
        Number.isInteger(endpoint.port) &&
        pathCovered(path, endpoint.path),
    )
    .map(({ host, port }) => ({ host, ports: [{ from: port, to: port }] }));
  return portsCovered(rule.ports, routes);
}

const reviewedPresentations = {
  plugin: ["bearer"],
  model: ["bearer", "x-api-key"],
  repository: ["repository_git", "github_installation", "github_repository"],
} satisfies Record<
  DeploymentCredentialBinding["consumer"]["kind"],
  readonly DeploymentCredentialBinding["projection"]["presentation"][]
>;

interface BindingAuthority {
  /** Permitted HTTPS endpoints from the current source or its effective connection template. */
  readonly destinations: readonly ConnectionEndpoint[];
  /** Reviewed requests for the named Plugin connection or admitted model/repository profile. */
  readonly allowedRequests: readonly DeploymentRequestMatch[];
  readonly projection: DeploymentCredentialBinding["projection"];
}

export interface CredentialPolicyAdmission {
  readonly networkAccessPolicy: NetworkAccessPolicy;
  readonly ceiling: readonly SandboxNetworkGrant[];
  readonly sandbox: NetworkPolicyCapabilities;
  /** OCC authorizes source use; each consumer supplies its reviewed projection and request rules.
   * Plugin input must use the named connection's networkRequirementIds, not all rules on that host. */
  readonly bindings: readonly DeploymentCredentialBinding[];
  /** OCC resolves independent source and consumer authority for this identity at revision admission. */
  readonly authorityForBinding?: (
    identity: Pick<
      DeploymentCredentialBinding,
      "bindingRef" | "sourceRef" | "driverId" | "consumer"
    >,
  ) => BindingAuthority | undefined;
  readonly injectionPolicies: readonly CredentialInjectionPolicy[];
  /** False only for a target known to have no issued placeholders. Retain the guard through withdrawal. */
  readonly targetMayHoldPlaceholders: boolean;
  readonly proxy?: CredentialInjectionCapabilities;
}

export function deploymentPolicyAdmissionDetails(input: CredentialPolicyAdmission): ErrorDetail[] {
  const { networkAccessPolicy, proxy } = input;
  const bindings = new Map<
    string,
    { binding: DeploymentCredentialBinding; authority: BindingAuthority }
  >();
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
    const consumer = binding.consumer;
    const kind = consumer?.kind;
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
    const { bindingRef, sourceRef, driverId } = binding;
    let authority: BindingAuthority | undefined;
    try {
      authority = input.authorityForBinding?.({ bindingRef, sourceRef, driverId, consumer });
    } catch {
      return [invalid(path, "The binding's current authority is unavailable.")];
    }
    if (
      !authority ||
      !isDeepStrictEqual(authority.projection, projection, { skipPrototype: true }) ||
      !Array.isArray(authority.destinations) ||
      !authority.destinations.length ||
      !Array.isArray(authority.allowedRequests) ||
      !authority.allowedRequests.length ||
      validateMatches(authority.allowedRequests, path).length
    ) {
      return [
        invalid(
          path,
          "The binding needs current source destinations, reviewed requests and a matching credential projection.",
        ),
      ];
    }
    bindings.set(bindingRef, { binding, authority });
    environments.add(projection.environment);
  }
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
  for (const [index, policy] of input.injectionPolicies.entries()) {
    const path = `/injectionPolicies/${index}`;
    const resolved = bindings.get(policy?.bindingRef);
    if (
      !resolved ||
      !Array.isArray(policy.allowedRequests) ||
      !policy.allowedRequests.length ||
      Object.keys(policy).some((key) => key !== "bindingRef" && key !== "allowedRequests")
    ) {
      return [invalid(path, "Supply one nonempty injection policy for each admitted binding.")];
    }
    const { binding, authority } = resolved;
    bindings.delete(binding.bindingRef);
    if (proxy?.rejectsStaleAndMisplacedPlaceholders !== true || !proxy.supportsBindingRequest) {
      return [
        invalid(
          path,
          "The selected proxy must reject stale and misplaced placeholders before forwarding.",
        ),
      ];
    }
    const allowedRequests: readonly DeploymentRequestMatch[] = policy.allowedRequests;
    const issues = validateMatches(allowedRequests, path + "/allowedRequests");
    if (issues.length) {
      return issues;
    }
    for (const [i, rule] of allowedRequests.entries()) {
      const pointer = `${path}/allowedRequests/${i}`;
      if (
        !sourceCoversRequest(authority.destinations, rule) ||
        !requestCovered(rule, authority.allowedRequests)
      ) {
        return [
          invalid(
            pointer,
            "The request exceeds the source destinations or reviewed requests for this binding.",
          ),
        ];
      }
      if (!requestCovered(rule, networkAccessPolicy.allowed)) {
        return [
          invalid(
            pointer,
            "Credential injection requires an independent network allowance for the complete request.",
          ),
        ];
      }
      if (
        !supported(() => proxy.supportsBindingRequest(binding, rule, input)) ||
        !safelyComposed(rule, allowedRequests, networkAccessPolicy, proxy)
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
