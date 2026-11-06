import { isDeepStrictEqual } from "node:util";
import { wirePolicy } from "../egress-proxy/openshell-wire-policy.ts";
import { savedAccountBindingId, type AgentRevision } from "@openclaw-enterprise/contracts";
import { SandboxRevisionUnsupportedError } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";
import {
  managedInstalls,
  managedCredentialEnvironment,
  managedSlotBinding,
} from "../plugin/managed-catalog.ts";
import {
  googleWorkspaceDestinations,
  googleCatalog,
  publicGoogleDiscoveryRequests,
} from "../plugin/google-workspace/operations.ts";
import { managedMcpNetwork } from "./openshell-managed-mcp-policy.ts";
import { sameOpenShellPolicy } from "./openshell-policy.ts";

// GetSandboxConfig uses sandbox.proto's SupervisorMiddlewareBinding enum.
const httpRequestCredentialInjectionBinding = 4;
// Public GETs have their own network rules. Terminal authorization strips the workload
// Authorization header and checks the requested API/version before releasing these calls.
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

/** Nonsecret launch inputs. Each terminal middleware entry names one admitted release slot. */
export function openShellSavedAccountPolicy(
  revision: Readonly<AgentRevision>,
  registrationName?: string,
  installs: readonly (typeof managedInstalls)[number][] = managedInstalls,
) {
  const saved = revision.plugins?.savedAccounts;
  if (!saved) {
    return undefined;
  }
  if (
    !registrationName ||
    saved.registrationName !== registrationName ||
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
  const environment: Record<string, string> = {};
  const sources = new Set<string>();
  const hosts = new Set<string>();
  for (const install of installs) {
    const binding = managedSlotBinding(selections, install);
    if (!binding || !binding.sourceIds.some((id) => saved.sourceIds.includes(id))) {
      continue;
    }
    if (binding.sourceIds.some((id) => !saved.sourceIds.includes(id))) {
      unsupported(
        "A terminal OAuth route cannot also attach an OpenShell credential provider to its destination.",
      );
    }
    const slotId = install.slotId;
    const destinationHosts = install.kind === "mcp" ? [install.endpoint.host] : googleHosts;
    if (destinationHosts.some((host) => hosts.has(host))) {
      unsupported(
        "Two saved OAuth slots select the same request host. OpenShell cannot determine which account to present.",
      );
    }
    for (const host of destinationHosts) {
      hosts.add(host);
    }
    const bindingIds = binding.sourceIds.map((id) => {
      sources.add(id);
      const env = managedCredentialEnvironment(install, id);
      const bindingId = savedAccountBindingId(revision.id, install.id, slotId, id);
      environment[env] = "oce:saved-account:" + env + ":" + bindingId;
      return bindingId;
    });
    const name = "oce-oauth-" + install.runtimeName;
    const fields = {
      namespace_id: revision.namespaceId,
      agent_id: revision.agentId,
      revision_id: revision.id,
      plugin_id: install.id,
      slot_id: slotId,
    };
    middlewares[name] = {
      name,
      middleware: registrationName,
      config: {
        fields: {
          ...Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [key, { stringValue: value }]),
          ),
          ...(bindingIds.length === 1
            ? { binding_id: { stringValue: bindingIds[0] } }
            : {
                binding_ids: {
                  listValue: { values: bindingIds.map((stringValue) => ({ stringValue })) },
                },
              }),
        },
      },
      on_error: "fail_closed",
      endpoints: { include: destinationHosts },
      order: 2_147_483_640 - Object.keys(middlewares).length,
    };
    if (install.kind === "mcp") {
      const rule = managedMcpNetwork(install, binding.toolNames);
      networks[rule.name] = rule;
    } else {
      // OCC checks the current template rows and actual Google operation on each request.
      // The Sandbox independently limits transport to the service roots of the pinned release.
      networks[name] = {
        name,
        binaries: [{ path: install.binaryPath }],
        endpoints: [
          ...googleWorkspaceDestinations.map(({ host, port, path }) => ({
            host,
            ports: [port],
            path,
            protocol: "rest",
            enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
            access: "NETWORK_ACCESS_PRESET_FULL",
          })),
          ...googleDiscoveryRoutes.map(({ host, path }) => ({
            host,
            ports: [443],
            protocol: "rest",
            enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
            rules: [{ allow: { method: "GET", path } }],
          })),
        ],
      };
    }
  }
  if (sources.size !== saved.sourceIds.length) {
    unsupported(
      "The selected OpenShell sender cannot enforce every saved OAuth slot on this revision.",
    );
  }
  return { middlewares, networks, environment, hosts, registrationName, audience: saved.audience };
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
}

export function verifySavedAccountPolicy(
  config: Readonly<Record<string, unknown>> | undefined,
  expected: NonNullable<ReturnType<typeof openShellSavedAccountPolicy>>,
  workspace: string,
) {
  const registrations = Array.isArray(config?.supervisor_middleware_services)
    ? config.supervisor_middleware_services
        .map(asRecord)
        .filter((service) => service?.name === expected.registrationName)
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
    registration?.audience !== expected.audience ||
    (registration.binding_policy !== 2 && registration.binding_policy !== 3) ||
    !Array.isArray(registration.bindings) ||
    !registration.bindings.includes(httpRequestCredentialInjectionBinding) ||
    typeof registration.grpc_endpoint !== "string" ||
    !registration.grpc_endpoint.startsWith("https://")
  ) {
    unsupported(
      "OpenShell has not admitted the saved OAuth route and its authenticated request-time credential authority.",
    );
  }
  assertSavedAccountRules(config.policy, expected);
}
