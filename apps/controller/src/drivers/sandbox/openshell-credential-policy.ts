import type {
  DeploymentCredentialBinding,
  DeploymentPolicy,
  DeploymentRequestMatch,
} from "@openclaw-enterprise/contracts";
import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";

import { openShellProviderName } from "../../backends/openshell.ts";
import { OpenShellSandboxConfigurationFailure } from "./openshell-sandbox-errors.ts";

export interface OpenShellCredentialRoute {
  readonly binding: DeploymentCredentialBinding;
  readonly provider: string;
  readonly binary: string;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly endpointPath?: string;
  readonly rules: readonly { readonly allow: { readonly method: string; readonly path: string } }[];
}

export function openShellProjectedCredentialProviderName(sourceId: string, environment: string) {
  return `${openShellProviderName(sourceId)}-${sha256Hex(environment, 24)}`;
}

export function openShellCredentialProviderName(binding: DeploymentCredentialBinding): string {
  // Keep the deployed model Provider identity so retained revisions can still be observed and removed.
  if (binding.consumer.kind === "model" && binding.bindingRef === "model") {
    return openShellProviderName(binding.sourceRef.id);
  }
  return openShellProjectedCredentialProviderName(
    binding.sourceRef.id,
    binding.projection.environment,
  );
}

export function credentialPolicyFailure(): never {
  throw new OpenShellSandboxConfigurationFailure(
    "The staged native credential policy is unsupported.",
  );
}

function pathCovers(allowed: string, requested: string): boolean {
  if (allowed === requested || allowed === "/**") {
    return true;
  }
  if (!allowed.endsWith("/**")) {
    return false;
  }
  const base = allowed.slice(0, -3);
  return requested === base || requested.startsWith(`${base}/`);
}

function validHttpPath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("//")) {
    return false;
  }
  const base = path.endsWith("/**") ? path.slice(0, -3) : path;
  if (!/^(?:[A-Za-z0-9._~!$&'()+,:=@/-]|%20|%[89A-F][0-9A-F])*$/.test(base)) {
    return false;
  }
  try {
    return decodeURIComponent(base)
      .split("/")
      .every((segment) => {
        const normalized = segment.normalize("NFKC");
        return normalized !== "." && normalized !== ".." && !/[/%\\?#;*\p{Cc}]/u.test(normalized);
      });
  } catch {
    return false;
  }
}

/** Only exact and terminal subtree selectors can establish that Source routes are disjoint. */
export function openShellCredentialPathsOverlap(left: string, right: string): boolean {
  return (
    !validHttpPath(left) ||
    !validHttpPath(right) ||
    pathCovers(left, right) ||
    pathCovers(right, left)
  );
}

/** Retain opaque endpoints and paths that can overlap the selected credential. */
export function openShellNetworksOverlappingCredentialPath(
  networks: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(networks).map(([name, value]) => {
      const rule = asRecord(value);
      if (!rule || !Array.isArray(rule.endpoints)) {
        return [name, value];
      }
      return [
        name,
        {
          ...rule,
          endpoints: rule.endpoints.filter((endpoint) => {
            const endpointPath = asRecord(endpoint)?.path;
            return (
              typeof endpointPath !== "string" ||
              openShellCredentialPathsOverlap(endpointPath, path)
            );
          }),
        },
      ];
    }),
  );
}

function inheritSubtreeRules(
  routes: readonly {
    readonly binary: string;
    readonly host: string;
    readonly port: number;
    readonly path: string;
    readonly provider?: string;
    readonly rules: { allow: { method: string; path: string } }[];
  }[],
): void {
  for (const route of routes) {
    for (const ancestor of routes) {
      if (
        route !== ancestor &&
        route.binary === ancestor.binary &&
        route.host.toLowerCase() === ancestor.host.toLowerCase() &&
        route.port === ancestor.port &&
        route.provider === ancestor.provider &&
        pathCovers(ancestor.path, route.path)
      ) {
        for (const rule of ancestor.rules) {
          if (
            !route.rules.some(
              ({ allow }) => allow.method === rule.allow.method && allow.path === rule.allow.path,
            )
          ) {
            route.rules.push(rule);
          }
        }
      }
    }
  }
}

function requestPaths(path: string): readonly string[] {
  return path.endsWith("/**") ? [path.slice(0, -3) || "/", path] : [path];
}

function checkedHttpRequest(request: DeploymentRequestMatch): {
  readonly method: string;
  readonly path: string;
  readonly port: number;
} {
  const selector = request.requestPolicy;
  const port = request.ports[0]?.from;
  const path = selector?.path;
  if (
    selector?.type !== "http" ||
    !request.binary.startsWith("/") ||
    /[\0*?[\]]/.test(request.binary) ||
    request.binary.split("/").includes("..") ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(request.host) ||
    !/[a-z]/i.test(request.host) ||
    request.ports.length !== 1 ||
    !Number.isInteger(port) ||
    !port ||
    port > 65535 ||
    request.ports[0]?.to !== port ||
    !/^[!#$%&'*+.^_`|~0-9A-Z-]{1,16}$/.test(selector.method) ||
    typeof path !== "string" ||
    !validHttpPath(path)
  ) {
    credentialPolicyFailure();
  }
  return { method: selector.method, path, port };
}

function networkCoversRequest(
  network: DeploymentRequestMatch,
  request: DeploymentRequestMatch,
): boolean {
  if (
    network.binary !== request.binary ||
    network.host.toLowerCase() !== request.host.toLowerCase() ||
    !request.ports.every((port) =>
      network.ports.some((allowed) => allowed.from <= port.from && allowed.to >= port.to),
    )
  ) {
    return false;
  }
  const selector = network.requestPolicy;
  return (
    selector === undefined ||
    (selector.type === "http" &&
      request.requestPolicy?.type === "http" &&
      selector.method === request.requestPolicy.method &&
      pathCovers(selector.path, request.requestPolicy.path))
  );
}

/** Compile only the admitted HTTP credential selectors; the Provider resolver also uses endpoint paths. */
export function compileOpenShellCredentialPolicy(policy: DeploymentPolicy): {
  readonly credentialRoutes: readonly OpenShellCredentialRoute[];
  readonly publicRoutes: readonly OpenShellPublicRoute[];
} {
  if (policy.bindings.length < 1 || policy.injectionPolicies.length !== policy.bindings.length) {
    credentialPolicyFailure();
  }
  const refs = new Set<string>();
  const environments = new Set<string>();
  const routes = new Map<
    string,
    {
      binding: DeploymentCredentialBinding;
      provider: string;
      binary: string;
      host: string;
      port: number;
      path: string;
      rules: { allow: { method: string; path: string } }[];
    }
  >();
  for (const network of policy.networkAccessPolicy.allowed) {
    if (network.requestPolicy !== undefined) {
      checkedHttpRequest(network);
    }
  }
  for (const binding of policy.bindings) {
    const environment = binding.projection.environment;
    if (
      !binding.bindingRef ||
      refs.has(binding.bindingRef) ||
      (binding.consumer.kind !== "model" && binding.consumer.kind !== "plugin") ||
      binding.sourceRef.kind !== "credential_source" ||
      !binding.sourceRef.id ||
      !binding.sourceRef.namespaceId ||
      binding.projection.presentation !== "bearer" ||
      !/^[A-Z][A-Z0-9_]*$/.test(environment) ||
      environments.has(environment)
    ) {
      credentialPolicyFailure();
    }
    refs.add(binding.bindingRef);
    environments.add(environment);
    const provider = openShellCredentialProviderName(binding);
    const injections = policy.injectionPolicies.filter(
      (value) => value.bindingRef === binding.bindingRef,
    );
    if (injections.length !== 1 || injections[0]!.allowedRequests.length < 1) {
      credentialPolicyFailure();
    }
    for (const request of injections[0]!.allowedRequests) {
      const { method, path, port } = checkedHttpRequest(request);
      if (
        !policy.networkAccessPolicy.allowed.some((network) =>
          networkCoversRequest(network, request),
        )
      ) {
        credentialPolicyFailure();
      }
      for (const route of routes.values()) {
        if (
          route.host.toLowerCase() === request.host.toLowerCase() &&
          route.port === port &&
          (route.binding.bindingRef !== binding.bindingRef || route.binary !== request.binary) &&
          openShellCredentialPathsOverlap(route.path, path)
        ) {
          // OpenShell's Source resolver distinguishes endpoint paths, but not HTTP methods or executables.
          credentialPolicyFailure();
        }
      }
      const key = JSON.stringify([
        binding.bindingRef,
        request.binary,
        request.host.toLowerCase(),
        port,
        path,
      ]);
      let route = routes.get(key);
      if (!route) {
        route = {
          binding,
          provider,
          binary: request.binary,
          host: request.host,
          port,
          path,
          rules: [],
        };
        routes.set(key, route);
      }
      for (const allowedPath of requestPaths(path)) {
        if (
          !route.rules.some(({ allow }) => allow.method === method && allow.path === allowedPath)
        ) {
          route.rules.push({ allow: { method, path: allowedPath } });
        }
      }
    }
  }
  const credentialRoutes = [...routes.values()];
  // OpenShell selects the most specific endpoint path before it evaluates REST rules.
  inheritSubtreeRules(credentialRoutes);
  const publicRoutes = openShellPublicRoutes(policy, credentialRoutes);
  const httpRoutes = [...credentialRoutes, ...publicRoutes];
  for (const grant of policy.networkAccessPolicy.allowed) {
    if (grant.requestPolicy !== undefined) {
      continue;
    }
    for (const route of httpRoutes) {
      if (
        route.host.toLowerCase() !== grant.host.toLowerCase() ||
        !grant.ports.some(({ from, to }) => from <= route.port && route.port <= to)
      ) {
        continue;
      }
      // The established model route replaces its saved L4 grant with one approved inference request.
      // New credential-free grants must not be silently narrowed by that replacement mechanism.
      const model = credentialRoutes.find(
        (candidate) =>
          candidate.binding.consumer.kind === "model" &&
          candidate.binary === grant.binary &&
          candidate.host.toLowerCase() === grant.host.toLowerCase() &&
          candidate.port === route.port,
      );
      if (
        !model ||
        (route !== model && route.binary === grant.binary) ||
        policy.networkAccessPolicy.allowed.filter(
          (candidate) =>
            candidate.requestPolicy === undefined &&
            candidate.host.toLowerCase() === model.host.toLowerCase() &&
            candidate.ports.some(({ from, to }) => from <= model.port && model.port <= to),
        ).length !== 1
      ) {
        credentialPolicyFailure();
      }
    }
  }
  // Keep the established single-model endpoint shape. Aggregate routes need endpoint
  // paths so OpenShell can select the correct Provider before evaluating REST rules.
  const singleModel =
    credentialRoutes.length === 1 &&
    publicRoutes.length === 0 &&
    credentialRoutes[0]!.binding.consumer.kind === "model";
  return {
    credentialRoutes: credentialRoutes.map((route) =>
      singleModel ? route : { ...route, endpointPath: route.path },
    ),
    publicRoutes,
  };
}

interface OpenShellPublicRoute {
  readonly binary: string;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly rules: readonly { readonly allow: { readonly method: string; readonly path: string } }[];
}

function openShellPublicRoutes(
  policy: DeploymentPolicy,
  routes: readonly OpenShellCredentialRoute[],
): readonly OpenShellPublicRoute[] {
  const credentialRequests = policy.injectionPolicies.flatMap(
    (injection) => injection.allowedRequests,
  );
  const networkOnly = policy.networkAccessPolicy.allowed.filter(
    (request) =>
      request.requestPolicy !== undefined &&
      !credentialRequests.some(
        (credential) =>
          networkCoversRequest(credential, request) && networkCoversRequest(request, credential),
      ),
  );
  const publicRoutes = new Map<
    string,
    {
      binary: string;
      host: string;
      port: number;
      path: string;
      rules: { allow: { method: string; path: string } }[];
    }
  >();
  for (const request of networkOnly) {
    const { method, path, port } = checkedHttpRequest(request);
    if (
      routes.some(
        (route) =>
          route.host.toLowerCase() === request.host.toLowerCase() &&
          route.port === port &&
          openShellCredentialPathsOverlap(route.path, path),
      )
    ) {
      credentialPolicyFailure();
    }
    const key = JSON.stringify([request.binary, request.host.toLowerCase(), port, path]);
    let route = publicRoutes.get(key);
    if (!route) {
      route = { binary: request.binary, host: request.host, port, path, rules: [] };
      publicRoutes.set(key, route);
    }
    for (const allowedPath of requestPaths(path)) {
      if (!route.rules.some(({ allow }) => allow.method === method && allow.path === allowedPath)) {
        route.rules.push({ allow: { method, path: allowedPath } });
      }
    }
  }
  const compiled = [...publicRoutes.values()];
  inheritSubtreeRules(compiled);
  return compiled;
}
