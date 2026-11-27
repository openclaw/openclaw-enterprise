import { isDeepStrictEqual } from "node:util";

import {
  isCanonicalRepositoryGrantList,
  type AgentRevision,
  type DeploymentRequestMatch,
  type RepositoryNetworkGrant,
} from "@openclaw-enterprise/contracts";

import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";

import { limitRepositoryApi } from "../repo/access/delivery.ts";
import { githubPullRequestCreationRequest } from "../repo/github/access/registry.ts";
import {
  OPEN_SHELL_PROXY_CREDENTIAL_RULE_PREFIX,
  type OpenShellCredentialRoute,
} from "../sandbox/openshell-credential-policy.ts";
import {
  openShellAgentNetworkRules,
  openShellNetworkRouteMayOverlap,
} from "../sandbox/openshell-policy.ts";
import { stagedCredentialPolicies } from "../sandbox/openshell-staged-credential-policy.ts";
import {
  OPEN_SHELL_GIT_CREDENTIAL_BINARIES,
  openShellGitServiceRules,
} from "../sandbox/openshell-git-network-policy.ts";

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
  return checkedGrants(grants).flatMap((grant) => {
    // Discovery may allow two service queries with the same generic method and path.
    const requests = new Map(
      openShellGitServiceRules(grant).map(({ allow }) => [allow.path, allow]),
    );
    return OPEN_SHELL_GIT_CREDENTIAL_BINARIES.flatMap((binary) =>
      [...requests.values()].map(({ method, path }) => ({
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
    !injection
  ) {
    throw new Error("The admitted repository credential policy is unsupported.");
  }
  // The Worker revalidates current Source authority. This boundary checks the frozen tuple.
  const publication = grants.flatMap(({ repository, access, apiLimits }) => {
    if (limitRepositoryApi(apiLimits, "pull_requests", true, access === "write") !== "write") {
      return [];
    }
    const request = githubPullRequestCreationRequest(repository);
    return injection.allowedRequests.some((allowed) => isDeepStrictEqual(request, allowed))
      ? [request]
      : [];
  });
  if (
    !isDeepStrictEqual(injection.allowedRequests, [
      ...openShellRepositoryCredentialRequests(grants),
      ...publication,
    ])
  ) {
    throw new Error("The admitted repository credential policy is unsupported.");
  }
  const rulesByPath = new Map<string, ReturnType<typeof openShellGitServiceRules>>();
  for (const rule of grants.flatMap(openShellGitServiceRules)) {
    const rules = rulesByPath.get(rule.allow.path);
    if (rules) {
      rules.push(rule);
    } else {
      rulesByPath.set(rule.allow.path, [rule]);
    }
  }
  return routes.map((route) => {
    if (route.binding.bindingRef !== binding.bindingRef) {
      return route;
    }
    if (route.protocol !== "rest") {
      throw new Error("The repository credential needs a REST network rule.");
    }
    const allowed = route.rules[0]?.allow;
    if (
      publication.some(
        ({ binary, host, requestPolicy }) =>
          route.binary === binary &&
          route.host === host &&
          route.port === 443 &&
          route.path === requestPolicy.path &&
          route.rules.length === 1 &&
          allowed?.method === requestPolicy.method &&
          allowed.path === requestPolicy.path,
      )
    ) {
      // TODO: Require HTTPS and the socket-opening executable when OpenShell supports them.
      return route;
    }
    const rules = rulesByPath.get(route.path);
    if (
      !rules ||
      route.host !== "github.com" ||
      route.port !== 443 ||
      route.rules.length !== 1 ||
      allowed?.method !== rules[0]?.allow.method ||
      allowed?.path !== route.path
    ) {
      throw new Error("The repository route differs from its admitted grant.");
    }
    return { ...route, rules };
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
