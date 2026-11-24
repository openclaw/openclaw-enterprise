import {
  pathCovered,
  validRequestPath,
  type DeploymentCredentialBinding,
  type DeploymentPolicy,
  type DeploymentRequestMatch,
} from "@openclaw-enterprise/contracts";
import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";

import { openShellProviderName } from "../../backends/openshell.ts";
import { managedMcpInstalls } from "../plugin/managed-catalog.ts";
import { managedMcpRule } from "./openshell-managed-mcp-policy.ts";
import { OpenShellSandboxConfigurationFailure } from "./openshell-sandbox-errors.ts";
import { openShellNetworkRouteMayOverlap } from "./openshell-policy.ts";

interface OpenShellCredentialRouteBase {
  readonly binding: DeploymentCredentialBinding;
  readonly provider: string;
  readonly binary: string;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly endpointPath?: string;
}

type RestRule = { allow: { method: string; path: string } };
type McpRule = ReturnType<typeof managedMcpRule>;
type RestCredentialRoute = OpenShellCredentialRouteBase & {
  readonly protocol: "rest";
  readonly rules: readonly RestRule[];
};
type McpCredentialRoute = OpenShellCredentialRouteBase & {
  readonly protocol: "mcp";
  readonly mcp: { readonly strict_tool_names: true; readonly versions: readonly string[] };
  readonly rules: readonly McpRule[];
};

export type OpenShellCredentialRoute = RestCredentialRoute | McpCredentialRoute;
type MutableCredentialRoute =
  | (Omit<RestCredentialRoute, "rules"> & { rules: RestRule[] })
  | (Omit<McpCredentialRoute, "rules"> & { rules: McpRule[] });

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

/** Only exact and terminal subtree selectors can establish that Source routes are disjoint. */
export function openShellCredentialPathsOverlap(left: string, right: string): boolean {
  return (
    !validRequestPath(left, true) ||
    !validRequestPath(right, true) ||
    pathCovered(right, left) ||
    pathCovered(left, right)
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
        pathCovered(route.path, ancestor.path)
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

type CheckedRequest =
  | {
      readonly protocol: "rest";
      readonly method: string;
      readonly path: string;
      readonly port: number;
    }
  | {
      readonly protocol: "mcp";
      readonly method: string;
      readonly toolName?: string;
      readonly path: string;
      readonly port: number;
    };

function checkedRequest(request: DeploymentRequestMatch): CheckedRequest {
  const selector = request.requestPolicy;
  const port = request.ports[0]?.from;
  const path = selector?.path;
  if (
    (selector?.type !== "http" && selector?.type !== "mcp") ||
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
    !validRequestPath(path, selector.type === "http")
  ) {
    credentialPolicyFailure();
  }
  if (selector.type === "http") {
    if (!/^[!#$%&'*+.^_`|~0-9A-Z-]{1,16}$/.test(selector.method)) {
      credentialPolicyFailure();
    }
    return { protocol: "rest", method: selector.method, path, port };
  }
  if (
    !/^[A-Za-z0-9_./-]{1,128}$/.test(selector.method) ||
    (selector.method === "tools/call") !== (selector.toolName !== undefined) ||
    (selector.toolName !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(selector.toolName))
  ) {
    credentialPolicyFailure();
  }
  return {
    protocol: "mcp",
    method: selector.method,
    ...(selector.toolName === undefined ? {} : { toolName: selector.toolName }),
    path,
    port,
  };
}

function checkedHttpRequest(request: DeploymentRequestMatch) {
  const checked = checkedRequest(request);
  if (checked.protocol !== "rest") {
    credentialPolicyFailure();
  }
  return checked;
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
  if (selector === undefined) {
    return true;
  }
  const requested = request.requestPolicy;
  if (selector.type === "http" && requested?.type === "http") {
    return selector.method === requested.method && pathCovered(requested.path, selector.path);
  }
  return (
    selector.type === "mcp" &&
    requested?.type === "mcp" &&
    selector.method === requested.method &&
    selector.path === requested.path &&
    selector.toolName === requested.toolName
  );
}

/** Compile admitted credential selectors; the Provider resolver also uses endpoint paths. */
export function compileOpenShellCredentialPolicy(
  policy: DeploymentPolicy,
  defaultNetworks?: Readonly<Record<string, unknown>>,
): {
  readonly credentialRoutes: readonly OpenShellCredentialRoute[];
  readonly publicRoutes: readonly OpenShellPublicRoute[];
} {
  const injections = new Map(
    policy.injectionPolicies.map(({ bindingRef, allowedRequests }) => [
      bindingRef,
      allowedRequests,
    ]),
  );
  if (
    policy.bindings.length < 1 ||
    injections.size !== policy.injectionPolicies.length ||
    injections.size !== policy.bindings.length
  ) {
    credentialPolicyFailure();
  }
  const environments = new Set<string>();
  const routes = new Map<string, MutableCredentialRoute>();
  for (const network of policy.networkAccessPolicy.allowed) {
    if (network.requestPolicy !== undefined) {
      checkedRequest(network);
    }
  }
  for (const binding of policy.bindings) {
    const environment = binding.projection.environment;
    const requests = injections.get(binding.bindingRef);
    if (
      !binding.bindingRef ||
      !requests?.length ||
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
    injections.delete(binding.bindingRef);
    environments.add(environment);
    const provider = openShellCredentialProviderName(binding);
    for (const request of requests) {
      const checked = checkedRequest(request);
      const { method, path, port, protocol } = checked;
      const pluginId = binding.consumer.kind === "plugin" ? binding.consumer.pluginId : undefined;
      const install =
        protocol === "mcp" ? managedMcpInstalls.find(({ id }) => id === pluginId) : undefined;
      if (protocol === "mcp") {
        if (
          !install ||
          install.binaryPath !== request.binary ||
          install.endpoint.host.toLowerCase() !== request.host.toLowerCase() ||
          install.endpoint.port !== port ||
          install.endpoint.path !== path ||
          install.credentialEnvironment !== environment
        ) {
          credentialPolicyFailure();
        }
        // TODO(strict MCP injection): remove the accepted SSE GET and unsolicited response-frame exceptions when native policy can restrict substitution to admitted RPC requests.
      }
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
          (route.binding.bindingRef !== binding.bindingRef ||
            route.binary !== request.binary ||
            route.protocol !== protocol) &&
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
        protocol,
      ]);
      let route = routes.get(key);
      if (!route) {
        const common = {
          binding,
          provider,
          binary: request.binary,
          host: request.host,
          port,
          path,
        };
        route =
          protocol === "rest"
            ? { ...common, protocol, rules: [] }
            : {
                ...common,
                protocol,
                mcp: { strict_tool_names: true, versions: install!.mcpVersions },
                rules: [],
              };
        routes.set(key, route);
      }
      if (route.protocol === "rest") {
        for (const allowedPath of requestPaths(path)) {
          if (
            !route.rules.some(({ allow }) => allow.method === method && allow.path === allowedPath)
          ) {
            route.rules.push({ allow: { method, path: allowedPath } });
          }
        }
      } else if (checked.protocol === "mcp") {
        const rule = managedMcpRule(checked);
        if (
          !route.rules.some(
            ({ allow }) => allow.method === method && allow.params?.name.glob === checked.toolName,
          )
        ) {
          route.rules.push(rule);
        }
      }
    }
  }
  const credentialRoutes = [...routes.values()];
  // OpenShell selects the most specific endpoint path before it evaluates REST rules.
  inheritSubtreeRules(
    credentialRoutes.filter(
      (route): route is Extract<MutableCredentialRoute, { protocol: "rest" }> =>
        route.protocol === "rest",
    ),
  );
  const publicRoutes = openShellPublicRoutes(policy, credentialRoutes);
  const stagedRoutes = [...credentialRoutes, ...publicRoutes];
  const modelRoutes = credentialRoutes.filter(
    ({ binding }) => binding.consumer.kind === "model" && binding.bindingRef === "model",
  );
  // Model staging already narrows its admitted destination. A new route cannot remove
  // installed network access at another destination.
  if (
    defaultNetworks !== undefined &&
    stagedRoutes.some(
      (route) =>
        !modelRoutes.some(
          (model) =>
            model.host.toLowerCase() === route.host.toLowerCase() && model.port === route.port,
        ) && openShellNetworkRouteMayOverlap(defaultNetworks, route),
    )
  ) {
    credentialPolicyFailure();
  }
  for (const grant of policy.networkAccessPolicy.allowed) {
    if (grant.requestPolicy !== undefined) {
      continue;
    }
    for (const route of stagedRoutes) {
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
