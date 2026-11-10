import { isDeepStrictEqual } from "node:util";
import type { AgentRevision, ProxyPlan } from "@openclaw-enterprise/contracts";
import { SandboxRevisionUnsupportedError } from "@openclaw-enterprise/occ";
import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";
import type { OpenShellProxyOptions } from "../egress-proxy/openshell.ts";
import { isOpenShellRequestHost } from "../egress-proxy/openshell-http-request.ts";
import { wirePolicy } from "../egress-proxy/openshell-wire-policy.ts";
import { OPEN_SHELL_CODEX_BINARIES } from "./openshell-codex-artifacts.ts";
import {
  matchesOpenShellGatewayAssertionGrant,
  OPEN_SHELL_GATEWAY_ASSERTION_GRANT_TYPE,
  openShellProfileEndpoint,
  type OpenShellProviderProfile,
  type OpenShellStoredProviderProfile,
} from "./openshell-gateway-client.ts";
import { sameOpenShellPolicy } from "./openshell-policy.ts";

function unsupported(message: string): never {
  throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", message);
}

export function modelRequestProviderName(revisionId: string): string {
  return "oce-model-" + sha256Hex(revisionId, 32);
}

/** One admitted binding owns the only credentialed model route and its empty provider. */
export function openShellModelRequestPolicy(
  plan: ProxyPlan,
  options: OpenShellProxyOptions,
  revision?: Readonly<
    Pick<AgentRevision, "id" | "namespaceId" | "agentId"> & {
      readonly harness: Pick<AgentRevision["harness"], "id" | "mode">;
    }
  >,
) {
  if (plan.authorization !== "online-request") {
    return undefined;
  }
  const registration = options.requestCredentials;
  // The native worker and its authentication probe use Node as the actual
  // network executable. OpenShell does not authorize from script arguments.
  const native =
    revision?.harness.id === "openclaw" && registration?.assertionSource === "openshell_gateway";
  const route = plan.routes[0];
  if (
    !registration ||
    !revision ||
    (revision.harness.id !== "codex" && !native) ||
    revision.harness.mode !== "dedicated" ||
    revision.id !== plan.execution.revisionId ||
    revision.namespaceId !== plan.execution.namespaceId ||
    revision.agentId !== plan.execution.agentId ||
    plan.routes.length !== 1 ||
    !route ||
    route.binding.grant.kind !== "inference" ||
    (native && route.binding.grant.providerTools !== "none") ||
    route.method !== "POST" ||
    route.path !== "/v1/responses"
  ) {
    unsupported("Online model authorization requires one dedicated Harness Responses binding.");
  }
  const origin = new URL(route.origin);
  const host = origin.hostname;
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (native && origin.port !== "") ||
    !isOpenShellRequestHost(host) ||
    /(?:^|\.)github\.com$/.test(host)
  ) {
    unsupported("The model route must be an exact HTTPS DNS origin disjoint from protected Git.");
  }
  const bindingId = route.binding.binding.id;
  const fields = {
    binding_id: bindingId,
    namespace_id: revision.namespaceId,
    agent_id: revision.agentId,
    revision_id: revision.id,
  };
  const middlewares = {
    "oce-model": {
      name: "oce-model",
      middleware: options.middlewareName,
      config: {
        fields: Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [key, { stringValue: value }]),
        ),
      },
      on_error: "fail_closed",
      endpoints: { include: [host] },
      // Protected Git owns INT32_MAX and has a disjoint, exact host selector.
      order: 2_147_483_646,
    },
  };
  const name = modelRequestProviderName(revision.id);
  const tokenGrant: NonNullable<OpenShellProviderProfile["credentials"][number]["tokenGrant"]> = {
    token_endpoint: registration.tokenEndpoint,
    audience: bindingId,
    cache_ttl: { seconds: 0, nanos: 0 },
    ...(registration.assertionSource === "openshell_gateway"
      ? { grant_type: OPEN_SHELL_GATEWAY_ASSERTION_GRANT_TYPE }
      : {
          jwt_svid_audience: registration.tokenEndpoint,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        }),
  };
  const profile = {
    id: name,
    displayName: "Request-authorized model access",
    category: "PROVIDER_PROFILE_CATEGORY_OTHER",
    credentials: [
      {
        name: "access_token",
        envVars: [],
        required: false,
        authStyle: "bearer",
        headerName: "Authorization",
        tokenGrant,
      },
    ],
    endpoints: [
      {
        host,
        port: Number(origin.port || 443),
        path: route.path,
        protocol: "rest",
        rules: [{ allow: { method: "POST", path: route.path } }],
      },
    ],
    binaries: native ? ["/usr/local/bin/node"] : OPEN_SHELL_CODEX_BINARIES,
    inferenceCapable: false,
  } satisfies Omit<OpenShellProviderProfile, "annotations">;
  return {
    middlewares,
    provider: { name, profile },
    environment: { OPENAI_API_KEY: "oce:request-authorized:model" },
    host,
    registration: { name: options.middlewareName, ...registration },
  };
}

type ModelRequestPolicy = NonNullable<ReturnType<typeof openShellModelRequestPolicy>>;

/** Presence of cache_ttl matters: omission permits the token server's lease to become a cache. */
export function verifyModelRequestProfile(
  stored: OpenShellStoredProviderProfile | undefined,
  expected: ModelRequestPolicy["provider"]["profile"],
  workspace: string,
): void {
  const definition = stored?.definition;
  const credentials = definition?.credentials;
  const credential =
    Array.isArray(credentials) && credentials.length === 1 ? asRecord(credentials[0]) : undefined;
  const actual = asRecord(credential?.token_grant);
  const ttl = asRecord(actual?.cache_ttl);
  const grant = expected.credentials[0]!.tokenGrant;
  const gatewayAssertion = grant.grant_type === OPEN_SHELL_GATEWAY_ASSERTION_GRANT_TYPE;
  if (
    stored?.id !== expected.id ||
    definition?.scope !== "workspace" ||
    !actual ||
    !ttl ||
    Number(ttl.seconds ?? 0) !== 0 ||
    Number(ttl.nanos ?? 0) !== 0 ||
    actual.token_endpoint !== grant.token_endpoint ||
    actual.audience !== grant.audience ||
    (gatewayAssertion
      ? !matchesOpenShellGatewayAssertionGrant(actual, grant.token_endpoint, grant.audience)
      : actual.jwt_svid_audience !== grant.jwt_svid_audience ||
        actual.client_assertion_type !== grant.client_assertion_type ||
        (actual.grant_type !== undefined && actual.grant_type !== 0 && actual.grant_type !== 1)) ||
    actual.subject_token != null ||
    actual.requested_token_type ||
    (Array.isArray(actual.audience_overrides) && actual.audience_overrides.length) ||
    (Array.isArray(actual.scopes) && actual.scopes.length) ||
    credential?.name !== "access_token" ||
    credential.auth_style !== "bearer" ||
    credential.header_name !== "Authorization" ||
    credential.refresh != null ||
    credential.required ||
    credential.stable_placeholder ||
    (Array.isArray(credential.env_vars) && credential.env_vars.length) ||
    definition.inference_capable ||
    (Array.isArray(definition.files) && definition.files.length) ||
    !sameOpenShellPolicy(
      definition.binaries,
      expected.binaries.map((path) => ({ path })),
    ) ||
    !sameOpenShellPolicy(definition.endpoints, expected.endpoints.map(openShellProfileEndpoint))
  ) {
    unsupported(
      "OpenShell has not retained the exact zero-cache model token grant in Workspace " +
        workspace +
        ".",
    );
  }
}

/** Inspect actual admission and provider-derived routes, not merely the desired profile. */
export function verifyModelRequestPolicy(
  config: Readonly<Record<string, unknown>> | undefined,
  expected: ModelRequestPolicy,
  workspace: string,
): void {
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
    !registration.bindings.includes(1) ||
    typeof registration.grpc_endpoint !== "string" ||
    !registration.grpc_endpoint.startsWith("https://")
  ) {
    unsupported("OpenShell has not admitted the required authenticated model request middleware.");
  }
  const policy = asRecord(config.policy);
  const middlewares = asRecord(policy?.network_middlewares);
  if (
    !isDeepStrictEqual(
      wirePolicy(middlewares?.["oce-model"]),
      wirePolicy(expected.middlewares["oce-model"]),
    )
  ) {
    unsupported("OpenShell model request authority differs from its admitted binding.");
  }
  const { name, profile } = expected.provider;
  const ruleName = "_provider_" + name.replaceAll("-", "_");
  const rules = asRecord(policy?.network_policies);
  const owners = asRecord(config.tokenGrantOwners)?.[ruleName];
  if (
    !Array.isArray(owners) ||
    owners.length !== 1 ||
    typeof owners[0] !== "string" ||
    !/^grant-owner:v1:[a-f0-9]{64}$/.test(owners[0]) ||
    !sameOpenShellPolicy(rules?.[ruleName], {
      name: ruleName,
      binaries: profile.binaries.map((path) => ({ path })),
      endpoints: profile.endpoints.map((endpoint) => ({
        ...openShellProfileEndpoint(endpoint),
        provider_credentialed: true,
      })),
    })
  ) {
    unsupported("OpenShell has not bound the exact model endpoint to its token grant provider.");
  }
  for (const [name, value] of Object.entries(middlewares ?? {})) {
    const middleware = asRecord(value);
    if (
      name === "oce-model" ||
      Number(middleware?.order) < expected.middlewares["oce-model"].order
    ) {
      continue;
    }
    const hosts = asRecord(middleware?.endpoints)?.include;
    if (
      !Array.isArray(hosts) ||
      !hosts.length ||
      hosts.some(
        (host) =>
          typeof host !== "string" ||
          !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host) ||
          host === expected.host,
      )
    ) {
      unsupported("Another middleware can change an approved model request.");
    }
  }
  for (const [name, value] of Object.entries(rules ?? {})) {
    if (name === ruleName) {
      continue;
    }
    const endpoints = asRecord(value)?.endpoints;
    if (!Array.isArray(endpoints)) {
      continue;
    }
    for (const value of endpoints) {
      const endpoint = asRecord(value);
      const host = endpoint?.host;
      if (
        typeof host !== "string" ||
        !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host) ||
        host.toLowerCase() === expected.host
      ) {
        unsupported("Another OpenShell rule overlaps the protected model endpoint.");
      }
    }
  }
}
