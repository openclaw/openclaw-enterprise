import { isDeepStrictEqual } from "node:util";
import { wirePolicy } from "../egress-proxy/openshell-wire-policy.ts";
import { savedAccountBindingId, type AgentRevision } from "@openclaw-enterprise/contracts";
import { SandboxRevisionUnsupportedError } from "@openclaw-enterprise/occ";
import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";
import {
  openShellProfileEndpoint,
  type OpenShellProviderProfile,
  type OpenShellProviderProfileEndpoint,
  type OpenShellStoredProviderProfile,
} from "./openshell-gateway-client.ts";
import {
  managedInstalls,
  managedCredentialBinding,
  managedMcpCredentialBinding,
} from "../plugin/managed-catalog.ts";
import {
  googleWorkspaceDestinations,
  googleCatalog,
  publicGoogleDiscoveryRequests,
} from "../plugin/google-workspace/operations.ts";
import { managedMcpNetwork } from "./openshell-managed-mcp-policy.ts";
import { managedCredentialEnvironment } from "./openshell-plugin-runtime.ts";
import { assertPluginNetworkInspection } from "./openshell-plugin-policy.ts";
import { managedGoogleInstall } from "../plugin/google-workspace/install.ts";
import { sameOpenShellPolicy } from "./openshell-policy.ts";

// Stock GetSandboxConfig uses sandbox.proto's SupervisorMiddlewareBinding enum.
const httpRequestPreCredentials = 1;
// Public discovery gets a network rule but no dynamic credential endpoint.
const googleDiscoveryRoutes = Array.from(
  new Map(
    publicGoogleDiscoveryRequests(Object.keys(googleCatalog.operations)).map(({ host, path }) => [
      host + path,
      { host, path },
    ]),
  ).values(),
);
const googleHosts = [
  ...new Set([...googleWorkspaceDestinations, ...googleDiscoveryRoutes].map((row) => row.host)),
];

function unsupported(message: string): never {
  throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", message);
}

export interface OpenShellCredentialMiddlewareRegistration {
  readonly name: string;
  readonly audience: string;
  readonly tokenEndpoint: string;
}

export function savedAccountProviderPrefix(revisionId: string): string {
  return "oce-oauth-" + sha256Hex(revisionId, 20) + "-";
}

/** Additional inspected Installation routes can already admit the managed CLI at
 * an MCP host. Preserve exactly that REST access on the reviewed MCP path. */
function admittedMcpRestAccess(defaults: unknown, host: string, port: number) {
  const presets = [
    "NETWORK_ACCESS_PRESET_READ_ONLY",
    "NETWORK_ACCESS_PRESET_READ_WRITE",
    "NETWORK_ACCESS_PRESET_FULL",
  ] as const;
  const ranks: number[] = [];
  for (const rule of Object.values(asRecord(defaults) ?? {})) {
    const policy = asRecord(rule);
    if (
      !isDeepStrictEqual(wirePolicy(policy?.binaries), [
        { path: managedGoogleInstall.binaryPath },
      ]) ||
      !Array.isArray(policy?.endpoints)
    ) {
      continue;
    }
    for (const value of policy.endpoints) {
      const endpoint = asRecord(value);
      if (
        String(endpoint?.host).toLowerCase().replace(/\.$/, "") === host &&
        Array.isArray(endpoint?.ports) &&
        endpoint.ports.includes(port) &&
        endpoint.protocol === "rest" &&
        !endpoint.path &&
        !endpoint.rules &&
        !endpoint.deny_rules
      ) {
        // Installation policy endpoints express a host, ports and one access preset.
        ranks.push(presets.findIndex((preset) => endpoint.access === preset));
      }
    }
  }
  return presets[Math.max(-1, ...ranks)];
}

/** Each credentialed route belongs to one empty OpenShell provider and its admitted OCC slot. */
export function openShellSavedAccountPolicy(
  revision: Readonly<AgentRevision>,
  registration?: OpenShellCredentialMiddlewareRegistration,
  defaults: unknown = revision.sandboxPolicy?.defaults,
) {
  const saved = revision.plugins?.savedAccounts;
  if (!saved) {
    return undefined;
  }
  if (
    !registration ||
    revision.harness.id !== "openclaw" ||
    revision.harness.mode !== "dedicated" ||
    revision.plugins?.driver.implementation !== "occ/openclaw-plugin"
  ) {
    unsupported(
      "This revision requires the admitted saved-account Credential Proxy and dedicated OpenClaw worker.",
    );
  }
  const selections = revision.plugins.plugins;
  const middlewares: Record<string, Readonly<Record<string, unknown>>> = {};
  const networks: Record<string, Readonly<Record<string, unknown>>> = {};
  const providers: { name: string; profile: Omit<OpenShellProviderProfile, "annotations"> }[] = [];
  const environment: Record<string, string> = {};
  const sources = new Set<string>();
  const hosts = new Set<string>();
  for (const install of managedInstalls) {
    const mcp =
      install.kind === "mcp" ? managedMcpCredentialBinding(selections, install) : undefined;
    const cli = install.kind === "cli" ? managedCredentialBinding(selections, install) : undefined;
    const sourceId = mcp?.sourceId ?? cli?.sourceId;
    if (!sourceId || !saved.sourceIds.includes(sourceId)) {
      continue;
    }
    const slotId = install.kind === "mcp" ? install.slotId : cli!.slot;
    const destinationHosts = install.kind === "mcp" ? [install.endpoint.host] : googleHosts;
    if (destinationHosts.some((host) => hosts.has(host))) {
      unsupported(
        "Two saved OAuth slots select the same request host. OpenShell cannot determine which account to present.",
      );
    }
    for (const host of destinationHosts) {
      hosts.add(host);
    }
    sources.add(sourceId);
    const env = install.credentials[slotId]!.delivery.env;
    environment[env] = "oce:saved-account:" + env;
    if (cli) {
      environment[managedCredentialEnvironment] = env;
    }
    const name = "oce-oauth-" + install.runtimeName;
    const bindingId = savedAccountBindingId(revision.id, install.id, slotId, sourceId);
    const fields = {
      binding_id: bindingId,
      namespace_id: revision.namespaceId,
      agent_id: revision.agentId,
      revision_id: revision.id,
    };
    middlewares[name] = {
      name,
      middleware: registration.name,
      config: {
        fields: Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [key, { stringValue: value }]),
        ),
      },
      on_error: "fail_closed",
      endpoints: { include: destinationHosts },
      // The separately attached Google guard owns INT32_MAX. Stock requires unique
      // middleware orders; these disjoint slots take the positions immediately below it.
      order: 2_147_483_646 - Object.keys(middlewares).length,
    };
    let endpoints: readonly OpenShellProviderProfileEndpoint[];
    if (install.kind === "mcp") {
      const network = managedMcpNetwork(install, mcp!.toolNames);
      const endpoint = network.endpoints[0]!;
      endpoints = [
        {
          ...install.endpoint,
          protocol: "mcp",
          mcp: { strict_tool_names: true, versions: install.mcpVersions },
          rules: endpoint.rules,
        },
      ];
    } else {
      endpoints = googleWorkspaceDestinations.map(({ host, port, path }) => ({
        host,
        port,
        path,
        protocol: "rest",
        access: "NETWORK_ACCESS_PRESET_FULL",
      }));
      networks[name] = {
        name,
        binaries: [{ path: install.binaryPath }],
        endpoints: googleDiscoveryRoutes.map(({ host, path }) => ({
          host,
          ports: [443],
          // The endpoint selector itself must exclude every credentialed API path.
          path,
          protocol: "rest",
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          rules: [{ allow: { method: "GET", path } }],
        })),
      };
    }
    const provider = savedAccountProviderPrefix(revision.id) + bindingId.slice(0, 20);
    const profile = {
      id: provider,
      displayName: install.runtimeName + " saved account",
      category: "PROVIDER_PROFILE_CATEGORY_OTHER",
      credentials: [
        {
          name: "access_token",
          envVars: [],
          required: false,
          authStyle: "bearer",
          headerName: "Authorization",
          tokenGrant: {
            token_endpoint: registration.tokenEndpoint,
            jwt_svid_audience: registration.tokenEndpoint,
            audience: bindingId,
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            cache_ttl: { seconds: 0, nanos: 0 },
          },
        },
      ],
      endpoints,
      binaries: [install.binaryPath],
      inferenceCapable: false,
    } satisfies Omit<OpenShellProviderProfile, "annotations">;
    providers.push({ name: provider, profile });
    if (install.kind === "mcp") {
      const { host, port, path } = install.endpoint;
      const access = admittedMcpRestAccess(defaults, host, port);
      if (access) {
        const id = savedAccountProviderPrefix(revision.id) + sha256Hex(bindingId + ":rest", 20);
        providers.push({
          name: id,
          profile: {
            ...profile,
            id,
            binaries: [managedGoogleInstall.binaryPath],
            endpoints: [{ host, port, path, protocol: "rest", access }],
          },
        });
      }
    }
  }
  if (sources.size !== saved.sourceIds.length) {
    unsupported(
      "The selected OpenShell sender cannot enforce every saved OAuth slot on this revision.",
    );
  }
  return { middlewares, networks, environment, hosts, providers, registration };
}

/** A gateway that dropped the token grant or the zero Duration would cache or misroute a bearer. */
export function verifySavedAccountProfile(
  stored: OpenShellStoredProviderProfile | undefined,
  expected: Omit<OpenShellProviderProfile, "annotations">,
  workspace: string,
): void {
  const definition = stored?.definition;
  const credentials = definition?.credentials;
  const credential =
    Array.isArray(credentials) && credentials.length === 1 ? asRecord(credentials[0]) : undefined;
  const actual = asRecord(credential?.token_grant);
  const ttl = asRecord(actual?.cache_ttl);
  const grant = expected.credentials[0]!.tokenGrant!;
  if (
    stored?.id !== expected.id ||
    definition?.scope !== "workspace" ||
    !actual ||
    !ttl ||
    Number(ttl.seconds ?? 0) !== 0 ||
    Number(ttl.nanos ?? 0) !== 0 ||
    actual.token_endpoint !== grant.token_endpoint ||
    actual.jwt_svid_audience !== grant.jwt_svid_audience ||
    actual.audience !== grant.audience ||
    actual.client_assertion_type !== grant.client_assertion_type ||
    (actual.grant_type !== undefined && actual.grant_type !== 0 && actual.grant_type !== 1) ||
    actual.subject_token != null ||
    actual.requested_token_type ||
    (Array.isArray(actual.audience_overrides) && actual.audience_overrides.length) ||
    (Array.isArray(actual.scopes) && actual.scopes.length) ||
    credential?.name !== "access_token" ||
    credential.auth_style !== "bearer" ||
    String(credential.header_name).toLowerCase() !== "authorization" ||
    credential.refresh != null
  ) {
    unsupported(
      "OpenShell has not retained the zero-cache saved account token grant in Workspace " +
        workspace +
        ".",
    );
  }
}

export function assertSavedAccountRules(
  policy: unknown,
  expected: NonNullable<ReturnType<typeof openShellSavedAccountPolicy>>,
) {
  const registered = asRecord(policy);
  const middlewares = asRecord(registered?.network_middlewares);
  const networks = asRecord(registered?.network_policies);
  if (
    !Object.entries(expected.middlewares).every(([key, middleware]) =>
      isDeepStrictEqual(wirePolicy(middlewares?.[key]), wirePolicy(middleware)),
    ) ||
    !Object.entries(expected.networks).every(([key, network]) =>
      sameOpenShellPolicy(networks?.[key], network),
    )
  ) {
    unsupported(
      "OpenShell has not retained the admitted saved OAuth routes and their request-time credential authority.",
    );
  }
  const expectedRules = new Set([
    ...Object.keys(expected.networks),
    ...expected.providers.map(({ name }) => "_provider_" + name.replaceAll("-", "_")),
  ]);
  const otherRules = Object.fromEntries(
    Object.entries(networks ?? {}).filter(([name]) => !expectedRules.has(name)),
  );
  assertPluginNetworkInspection(otherRules, [...expected.hosts]);
  for (const [name, rule] of Object.entries(otherRules)) {
    const endpoints = asRecord(rule)?.endpoints;
    if (!Array.isArray(endpoints)) {
      continue;
    }
    for (const value of endpoints) {
      const ep = asRecord(value);
      if (
        ep &&
        expected.hosts.has(String(ep.host).toLowerCase().replace(/\.$/, "")) &&
        (ep.request_body_credential_rewrite ||
          ep.credential_signing ||
          (name.startsWith("_provider_") && ep.provider_credentialed))
      ) {
        unsupported(
          "Another OpenShell rule can change the saved account request or supply a different credential.",
        );
      }
    }
  }
  const finalGuard = Object.entries(middlewares ?? {}).find(
    ([name, value]) =>
      !Object.hasOwn(expected.middlewares, name) && asRecord(value)?.order === 2_147_483_647,
  );
  if (finalGuard) {
    const hosts = asRecord(asRecord(finalGuard[1])?.endpoints)?.include;
    if (
      !Array.isArray(hosts) ||
      hosts.length === 0 ||
      hosts.some(
        (h) =>
          typeof h !== "string" ||
          !/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(h) ||
          expected.hosts.has(h),
      )
    ) {
      unsupported("A later request middleware can change an approved saved account request.");
    }
  }
}

export function verifySavedAccountPolicy(
  config: Readonly<Record<string, unknown>> | undefined,
  expected: NonNullable<ReturnType<typeof openShellSavedAccountPolicy>>,
  workspace: string,
) {
  const registrations = Array.isArray(config?.supervisor_middleware_services)
    ? config.supervisor_middleware_services
        .map(asRecord)
        .filter((service) => service?.name === expected.registration.name)
    : [];
  const [registration] = registrations;
  if (
    config?.workspace !== workspace ||
    config.policy_source !== 1 ||
    config.global_policy_version ||
    config.configuration_admitted !== true ||
    config.configuration_error ||
    config.policy_validation_failure_mode !== "fail_closed" ||
    config.extension_authentication_enabled !== true ||
    registrations.length !== 1 ||
    registration?.allow_insecure_transport ||
    registration?.audience !== expected.registration.audience ||
    (registration.binding_policy !== 2 && registration.binding_policy !== 3) ||
    !Array.isArray(registration.bindings) ||
    !registration.bindings.includes(httpRequestPreCredentials) ||
    typeof registration.grpc_endpoint !== "string" ||
    !registration.grpc_endpoint.startsWith("https://")
  ) {
    unsupported(
      "OpenShell has not admitted the saved OAuth route and its authenticated request-time credential authority.",
    );
  }
  const policy = asRecord(config.policy);
  const rules = asRecord(policy?.network_policies);
  const observedOwners = asRecord(config.tokenGrantOwners);
  const uniqueOwners = new Set<string>();
  for (const { name, profile } of expected.providers) {
    const ruleName = "_provider_" + name.replaceAll("-", "_");
    const expectedRule = {
      name: ruleName,
      binaries: profile.binaries.map((path) => ({ path })),
      endpoints: profile.endpoints.map((endpoint) => ({
        ...openShellProfileEndpoint(endpoint),
        provider_credentialed: true,
      })),
    };
    const owners = observedOwners?.[ruleName];
    if (!Array.isArray(owners) || owners.length !== profile.endpoints.length) {
      unsupported(
        "OpenShell has not bound the saved account to its provider's admitted endpoints.",
      );
    }
    for (const owner of owners) {
      if (
        typeof owner !== "string" ||
        !/^grant-owner:v1:[a-f0-9]{64}$/.test(owner) ||
        uniqueOwners.has(owner)
      ) {
        unsupported("OpenShell has not bound a unique grant owner to each saved account endpoint.");
      }
      uniqueOwners.add(owner);
    }
    if (!sameOpenShellPolicy(rules?.[ruleName], expectedRule)) {
      unsupported("OpenShell has not admitted the saved account's exact token grant routes.");
    }
  }
  assertSavedAccountRules(config.policy, expected);
}
