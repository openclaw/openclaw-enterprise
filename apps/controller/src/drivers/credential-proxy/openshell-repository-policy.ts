import { isDeepStrictEqual } from "node:util";

import {
  isCanonicalRepositoryGrantList,
  type AgentRevision,
  type DeploymentRequestMatch,
  type RepositoryNetworkGrant,
} from "@openclaw-enterprise/contracts";

import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";

import {
  OPEN_SHELL_PROXY_CREDENTIAL_RULE_PREFIX,
  type OpenShellCredentialRoute,
} from "../sandbox/openshell-credential-policy.ts";
import {
  openShellAgentNetworkRules,
  openShellNetworkRouteMayOverlap,
} from "../sandbox/openshell-policy.ts";
import { stagedCredentialPolicies } from "../sandbox/openshell-staged-credential-policy.ts";
import { OPEN_SHELL_GIT_CREDENTIAL_BINARIES } from "../sandbox/openshell-git-network-policy.ts";

function checkedGrants(
  grants: readonly RepositoryNetworkGrant[],
): readonly RepositoryNetworkGrant[] {
  if (
    !isCanonicalRepositoryGrantList(grants) ||
    grants.length === 0 ||
    grants.some(
      ({ apiLimits }) =>
        (apiLimits?.issues !== undefined && apiLimits.issues !== "none") ||
        (apiLimits?.pull_requests !== undefined && apiLimits.pull_requests !== "none"),
    )
  ) {
    throw new Error("Expected finite canonical Git-only repository grants.");
  }
  return grants;
}

/** Generic admission bounds. Exact Git service-query narrowing remains owned by this Proxy. */
export function openShellRepositoryCredentialRequests(
  grants: readonly RepositoryNetworkGrant[],
): readonly DeploymentRequestMatch[] {
  return checkedGrants(grants).flatMap(({ repository, access }) => {
    const root = `/${repository}.git`;
    return OPEN_SHELL_GIT_CREDENTIAL_BINARIES.flatMap((binary) =>
      [
        { method: "GET", path: `${root}/info/refs` },
        { method: "POST", path: `${root}/git-upload-pack` },
        ...(access === "write" ? [{ method: "POST", path: `${root}/git-receive-pack` }] : []),
      ].map(({ method, path }) => ({
        binary,
        host: "github.com",
        ports: [{ from: 443, to: 443 }],
        requestPolicy: { type: "http" as const, method, path },
      })),
    );
  });
}

/** Narrow admitted method/path bounds using the frozen Agent repository grants. */
export function narrowOpenShellRepositoryRoutes(
  revision: Readonly<AgentRevision>,
  routes: readonly OpenShellCredentialRoute[],
): readonly OpenShellCredentialRoute[] {
  const deployment = revision.credentialDeployment;
  const bindings =
    deployment?.bindings.filter(({ consumer }) => consumer.kind === "repository") ?? [];
  if (bindings.length === 0) {
    return routes;
  }
  const binding = bindings[0]!;
  const grants = revision.sandboxPolicy?.repositoryNetworkPolicy?.grants;
  const injection = deployment!.injectionPolicies.find(
    ({ bindingRef }) => bindingRef === binding.bindingRef,
  );
  if (
    bindings.length !== 1 ||
    binding.bindingRef !== "repository" ||
    binding.projection.presentation !== "github_repository" ||
    binding.projection.environment !== "GITHUB_TOKEN" ||
    !grants ||
    !isDeepStrictEqual(injection?.allowedRequests, openShellRepositoryCredentialRequests(grants))
  ) {
    throw new Error("The admitted repository credential policy is unsupported.");
  }
  const byRoot = new Map(checkedGrants(grants).map((grant) => [`/${grant.repository}.git`, grant]));
  return routes.map((route) => {
    if (route.binding.bindingRef !== binding.bindingRef) {
      return route;
    }
    if (route.protocol !== "rest") {
      throw new Error("The repository credential needs a REST network rule.");
    }
    const root = route.path.slice(0, route.path.lastIndexOf("/"));
    const discoveryRoot = route.path.endsWith("/info/refs")
      ? route.path.slice(0, -"/info/refs".length)
      : undefined;
    const grant = byRoot.get(discoveryRoot ?? root);
    if (!grant || route.host !== "github.com" || route.port !== 443 || route.rules.length !== 1) {
      throw new Error("The repository route differs from its admitted grant.");
    }
    const rule = route.rules[0]!;
    if (
      discoveryRoot !== undefined &&
      rule.allow.method === "GET" &&
      rule.allow.path === route.path
    ) {
      const services =
        grant.access === "write" ? ["git-upload-pack", "git-receive-pack"] : ["git-upload-pack"];
      return {
        ...route,
        rules: services.map((service) => ({
          allow: { method: "GET", path: route.path, query: { service: { glob: service } } },
        })),
      };
    }
    if (
      rule.allow.method !== "POST" ||
      rule.allow.path !== route.path ||
      (route.path !== `${root}/git-upload-pack` &&
        !(grant.access === "write" && route.path === `${root}/git-receive-pack`))
    ) {
      throw new Error("The repository operation differs from its admitted grant.");
    }
    return route;
  });
}

/** Compose the Proxy's exact Repository rules with the Sandbox-owned baseline and other bindings. */
export function openShellRepositoryDeploymentPolicy(
  revision: Readonly<AgentRevision>,
  baseline: Readonly<Record<string, unknown>>,
  routes: readonly OpenShellCredentialRoute[],
): {
  readonly idle: Readonly<Record<string, unknown>>;
  readonly generic: Readonly<Record<string, unknown>>;
  readonly combined: Readonly<Record<string, unknown>>;
} {
  const snapshot = revision.sandboxPolicy;
  const repositoryRoutes = routes.filter(({ binding }) => binding.consumer.kind === "repository");
  if (!snapshot || repositoryRoutes.length === 0) {
    throw new Error("The admitted Repository policy is unavailable.");
  }
  const additions = openShellAgentNetworkRules(snapshot.additions);
  if (repositoryRoutes.some((route) => openShellNetworkRouteMayOverlap(additions, route))) {
    throw new Error("A generic network grant overlaps the Repository credential route.");
  }
  const activeBindingRefs = new Set(routes.map(({ binding }) => binding.bindingRef));
  const { idle, admitted: generic } = stagedCredentialPolicies(
    baseline,
    revision,
    snapshot,
    activeBindingRefs,
  );
  const genericNetworks = asRecord(generic.network_policies);
  if (!genericNetworks) {
    throw new Error("The admitted Sandbox network policy is unavailable.");
  }
  const networks = { ...genericNetworks };
  for (const route of repositoryRoutes) {
    const name = `${OPEN_SHELL_PROXY_CREDENTIAL_RULE_PREFIX}${sha256Hex(JSON.stringify([route.binary, route.host, route.port, route.path, route.provider]), 16)}`;
    if (Object.hasOwn(networks, name)) {
      throw new Error("The Repository credential rule collides with another policy rule.");
    }
    networks[name] = {
      name,
      binaries: [{ path: route.binary }],
      endpoints: [
        {
          host: route.host,
          ports: [route.port],
          path: route.endpointPath,
          protocol: "rest",
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          rules: route.rules,
          credential_binding: { provider: route.provider },
        },
      ],
    };
  }
  return { idle, generic, combined: { ...generic, network_policies: networks } };
}
