import type { AgentRevision, SandboxPolicySnapshot } from "@openclaw-enterprise/contracts";
import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";

import {
  compileOpenShellCredentialPolicy,
  credentialPolicyFailure,
  OPEN_SHELL_PROXY_CREDENTIAL_RULE_PREFIX,
} from "./openshell-credential-policy.ts";
import {
  AGENT_POLICY_PREFIX,
  OPEN_SHELL_STAGED_HTTP_RULE_PREFIX,
  openShellAgentNetworkRules,
  sameOpenShellPolicy,
} from "./openshell-policy.ts";
import { OpenShellSandboxConfigurationFailure } from "./openshell-sandbox-errors.ts";

export function stagedCredentialPolicies(
  policy: Readonly<Record<string, unknown>>,
  revision: Readonly<AgentRevision>,
  snapshot: SandboxPolicySnapshot,
  activeBindingRefs?: ReadonlySet<string>,
): {
  readonly idle: Readonly<Record<string, unknown>>;
  readonly admitted: Readonly<Record<string, unknown>>;
} {
  const deployment = revision.credentialDeployment;
  if (!deployment) {
    credentialPolicyFailure();
  }
  const { credentialRoutes: routes, publicRoutes } = compileOpenShellCredentialPolicy(
    deployment,
    snapshot.defaults,
  );
  const httpDestinations = [...routes, ...publicRoutes];
  const networks = asRecord(policy.network_policies);
  const defaults = asRecord(snapshot.defaults);
  if (!networks || !defaults) {
    credentialPolicyFailure();
  }
  const withoutHttpRoutes = (value: unknown): unknown => {
    const rule = asRecord(value);
    if (!rule || !Array.isArray(rule.endpoints)) {
      return value;
    }
    const endpoints = rule.endpoints.flatMap((value) => {
      const endpoint = asRecord(value);
      if (typeof endpoint?.host !== "string" || !Array.isArray(endpoint.ports)) {
        return [value];
      }
      const ports = endpoint.ports.filter(
        (port) =>
          !httpDestinations.some(
            (route) =>
              route.host.toLowerCase() === (endpoint.host as string).toLowerCase() &&
              route.port === port,
          ),
      );
      return ports.length === endpoint.ports.length
        ? [value]
        : ports.length === 0
          ? []
          : [{ ...endpoint, ports }];
    });
    return endpoints.length === 0 ? undefined : { ...rule, endpoints };
  };
  const desiredDefaults: Record<string, unknown> = {};
  for (const [name, rule] of Object.entries(defaults)) {
    const desired = withoutHttpRoutes(rule);
    if (
      !sameOpenShellPolicy(networks[name], rule) &&
      !sameOpenShellPolicy(networks[name], desired)
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "The staged Sandbox defaults differ from the admitted revision.",
      );
    }
    if (desired !== undefined) {
      desiredDefaults[name] = desired;
    }
  }
  const extraPrefix = "oce-staged-extra-";
  const trusted = Object.fromEntries(
    Object.entries(networks).filter(
      ([name]) =>
        !name.startsWith(AGENT_POLICY_PREFIX) &&
        !name.startsWith(extraPrefix) &&
        !name.startsWith(OPEN_SHELL_STAGED_HTTP_RULE_PREFIX) &&
        !name.startsWith(OPEN_SHELL_PROXY_CREDENTIAL_RULE_PREFIX) &&
        !Object.hasOwn(defaults, name),
    ),
  );
  const additions = openShellAgentNetworkRules(snapshot.additions) as Record<string, unknown>;
  const original = { ...additions };
  for (const [name, rule] of Object.entries(additions)) {
    const desired = withoutHttpRoutes(rule);
    if (sameOpenShellPolicy(rule, desired)) {
      continue;
    }
    delete additions[name];
    if (desired !== undefined) {
      const extraName = `${extraPrefix}${sha256Hex(name, 12)}`;
      if (Object.hasOwn(defaults, extraName) || Object.hasOwn(additions, extraName)) {
        credentialPolicyFailure();
      }
      additions[extraName] = { ...asRecord(desired), name: extraName };
    }
  }
  const idleNetworks = { ...trusted, ...desiredDefaults, ...additions };
  const admitted: Record<string, unknown> = { ...idleNetworks };
  const compiled: readonly ((typeof routes)[number] | (typeof publicRoutes)[number])[] = [
    ...routes,
    ...publicRoutes,
  ];
  for (const [index, route] of compiled.entries()) {
    // Repository delivery is compiled by the selected Proxy with exact Git query rules.
    if ("provider" in route && route.binding.consumer.kind === "repository") {
      continue;
    }
    if (
      "provider" in route &&
      activeBindingRefs !== undefined &&
      !activeBindingRefs.has(route.binding.bindingRef)
    ) {
      continue;
    }
    const matching = snapshot.additions.filter(
      (grant) =>
        grant.binary === route.binary &&
        grant.host.toLowerCase() === route.host.toLowerCase() &&
        grant.ports.some(({ from, to }) => from <= route.port && route.port <= to),
    );
    const originalName =
      matching.length === 1 ? `${AGENT_POLICY_PREFIX}${matching[0]!.id}` : undefined;
    const matchingRoutes =
      originalName === undefined
        ? []
        : compiled.filter(
            (candidate) =>
              candidate.binary === route.binary &&
              candidate.host.toLowerCase() === route.host.toLowerCase() &&
              matching[0]!.ports.some(
                ({ from, to }) => from <= candidate.port && candidate.port <= to,
              ),
          );
    const name =
      originalName !== undefined &&
      matchingRoutes.length === 1 &&
      Object.hasOwn(original, originalName)
        ? originalName
        : `${OPEN_SHELL_STAGED_HTTP_RULE_PREFIX}${sha256Hex(JSON.stringify([route.binary, route.host.toLowerCase(), route.port, route.path, "provider" in route ? route.provider : "public", index]), 16)}`;
    if (Object.hasOwn(admitted, name)) {
      credentialPolicyFailure();
    }
    const endpointPath = "provider" in route ? route.endpointPath : route.path;
    admitted[name] = {
      name,
      binaries: [{ path: route.binary }],
      endpoints: [
        {
          host: route.host,
          ports: [route.port],
          ...(endpointPath === undefined ? {} : { path: endpointPath }),
          protocol: "provider" in route ? route.protocol : "rest",
          ...("provider" in route && route.protocol === "mcp" ? { mcp: route.mcp } : {}),
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          rules: route.rules,
          ...("provider" in route ? { credential_binding: { provider: route.provider } } : {}),
        },
      ],
    };
  }
  return {
    idle: { ...policy, network_policies: idleNetworks },
    admitted: { ...policy, network_policies: admitted },
  };
}
