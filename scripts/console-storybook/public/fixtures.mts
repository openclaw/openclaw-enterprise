import { createNetworkPolicyFixture } from "./network-policy-fixture.mts";
import { createPresetFixtures } from "./preset-fixture.mts";
import type {
  AgentPluginCredentialSlot,
  CredentialSourceMetadata,
  CredentialSourceReference,
  SecretMetadata,
  AgentRuntimeContainerStatus,
  AgentRuntimePodStatus,
  AgentRuntimeEvent,
  HarnessAuthBinding,
  OpenClawConfigurationDocument,
  RepositoryOption,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import type { StoredConfiguration } from "./configuration-store.mts";
import { createConfigurationStore } from "./configuration-store.mts";
import { candidateDeploymentError } from "./deployment-fixture.mts";
import { createAgentLifecycle } from "./agent-lifecycle.mts";
import { installationDriverConfigurations, installationFixture } from "./installation-fixture.mts";
import { configurationValues } from "./configuration-fixture.mts";
import { serveChannelDirectory } from "./channel-directory-fixture.mts";
import { servePluginDiscovery } from "./plugin-discovery-fixture.mts";
import {
  createFixtureFetch,
  fixtureError as error,
  fixtureResponse as response,
} from "./preview-rules.mts";

type FixtureScenario = Parameters<typeof createConfigurationStore>[0] &
  Parameters<typeof createAgentLifecycle>[0] &
  Parameters<typeof configurationValues>[0] &
  Parameters<typeof createPresetFixtures>[0] &
  Parameters<typeof createNetworkPolicyFixture>[0] &
  Omit<
    Parameters<typeof installationFixture>[0],
    "pluginCapabilities" | "pluginDiscoveryCredential"
  > &
  Parameters<typeof installationDriverConfigurations>[0] & {
    namespaceRechecks?: readonly (string | number)[];
    namespaceName?: string;
    namespaceStatus?: string;
    sessionUser?: unknown;
    extraSecrets?: readonly { id: string; name: string }[];
    slackBindings?: boolean | "app" | readonly string[];
    slackGrantMissing?: string;
    auth?: null | string;
    namespaceDeleteOutcome?: string;
    observabilityUrl?: string;
    repositoryOptions?: readonly RepositoryOption[];
    credentialRegistrationOutcome?: string;
    pluginDiscovery?: Parameters<typeof servePluginDiscovery>[0];
    pluginCapabilities?: Omit<
      NonNullable<Parameters<typeof installationFixture>[0]["pluginCapabilities"]>,
      "policyScopeByPlugin" | "credentialSlots"
    > & {
      credentialSlots?: readonly (Omit<AgentPluginCredentialSlot, "toolDiscovery"> & {
        toolDiscovery?: boolean;
      })[];
      policyScopeByPlugin?: Readonly<Record<string, string>>;
    };
    pluginDiscoveryCredential?: string;
    agentPermissionSummary?: unknown;
    nativeAdmin?: string;
    nativeAdminUrl?: string;
    harness?: unknown;
    runtimeImages?: unknown;
    runtimePod?: string;
    diagnosticsState?: string;
    secretOperateDenied?: readonly string[];
    unreadableSecretId?: string;
    secretCallerPermissions?: { update?: boolean; delete?: boolean };
    secretConsumers?: {
      agents: readonly string[];
      configurations: readonly string[];
      credentialSources: readonly string[];
      provisioningRequests: readonly string[];
      unreadable: number;
      truncated: boolean;
    };
    rules?: Parameters<typeof createFixtureFetch>[0];
    signedOut?: boolean;
    pendingGithubAttempt?: boolean;
    expiredSession?: boolean;
    pendingGoogleAttempt?: boolean;
    emptyNamespaces?: boolean;
    emptyBackends?: boolean;
    harnessGrantMissing?: boolean;
    githubEnabled?: boolean;
    googleEnabled?: boolean;
    passwordRecoveryOnly?: boolean;
    namespaceDeleteDenied?: boolean;
    namespaceDeleteRestricted?: boolean;
    observabilityDenied?: boolean;
    oauthExpired?: boolean;
    oauthPending?: boolean;
    serviceAccountsEmpty?: boolean;
    repositoryDescriptionsPending?: boolean;
    repositoryNotConfigured?: boolean;
    emptyPresets?: boolean;
    readOnlyPermissionSummary?: boolean;
    agentCreateRestricted?: boolean;
    secretCreateNotPermitted?: boolean;
    bootstrapRuntime?: boolean;
    runtimeLogDownloadNoPod?: boolean;
    denySecretCreate?: boolean;
    emptySecrets?: boolean;
  };

type FixtureEvidence = Parameters<typeof serveChannelDirectory>[2] & {
  ready: boolean;
  requests: Parameters<typeof createFixtureFetch>[1];
  unhandled: { method: string; path: string }[];
};

// Only the fields this fixture consumes have concrete types. POST bodies and
// intentionally partial replies are not asserted to be complete API records.
type StoredIdentity = { id: string; response: object };
// Only identity and lifecycle fields are consumed. Extra request fields survive
// in the response object without becoming a dynamic mutable storage contract.
type StoredCredentialSource = Pick<
  CredentialSourceMetadata,
  "id" | "namespaceId" | "ref" | "state"
> & {
  config: unknown;
  driverId: string;
  createdAt: string;
};
type DeviceLogin = {
  session: SecretReference;
  status: "pending" | "ready";
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  intervalSeconds: number;
  source?: CredentialSourceReference;
};
function storedIdentity<T extends { id: string }>(response: T): StoredIdentity {
  return { id: response.id, response };
}
type FixturePod = Omit<AgentRuntimePodStatus, "events"> & {
  events: readonly (Omit<AgentRuntimeEvent, "container"> & { container?: string })[];
};

// The remaining JavaScript catalog widens these literal strings. Check only
// that boundary before passing its values to the typed Installation fixture.
function installationCapabilities(
  value: NonNullable<FixtureScenario["pluginCapabilities"]>,
): value is NonNullable<Parameters<typeof installationFixture>[0]["pluginCapabilities"]> {
  return (
    (value.policyScopeByPlugin === undefined ||
      Object.values(value.policyScopeByPlugin).every((scope) => scope === "enablement_only")) &&
    (value.credentialSlots === undefined ||
      value.credentialSlots.every(
        (slot) => slot.toolDiscovery === undefined || slot.toolDiscovery === true,
      ))
  );
}
function installationScenario(
  scenario: FixtureScenario,
): Parameters<typeof installationFixture>[0] {
  const { pluginCapabilities, pluginDiscoveryCredential, ...rest } = scenario;
  if (
    pluginDiscoveryCredential !== undefined &&
    pluginDiscoveryCredential !== "required" &&
    pluginDiscoveryCredential !== "none"
  ) {
    throw new TypeError("Invalid preview plugin discovery credential mode");
  }
  if (pluginCapabilities !== undefined && !installationCapabilities(pluginCapabilities)) {
    throw new TypeError("Invalid preview plugin capabilities");
  }
  return {
    ...rest,
    ...(pluginDiscoveryCredential === undefined ? {} : { pluginDiscoveryCredential }),
    ...(pluginCapabilities === undefined ? {} : { pluginCapabilities }),
  };
}

const createdAt = "2026-09-01T12:00:00.000Z";
const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const candidateRevisionId = "rev_00000000-0000-4000-8000-000000000007";
const secretRef = (id: string): SecretReference => ({ kind: "secret", namespaceId, id });
const auth: HarnessAuthBinding = { method: "api_key", source: secretRef("sec_demo_model") };

// This is a presentation fixture, not a controller implementation or backend test double.
// Every request stays inside this frame. Unsupported requests fail visibly, never go live.
export function installFixture(scenario: FixtureScenario, evidence: FixtureEvidence) {
  const namespaceRechecks = [...(scenario.namespaceRechecks ?? [])];
  let podRolloverStatusReads = 0;
  let signedIn = !scenario.signedOut;
  let repositoryDescriptionRequests = 0;
  if (scenario.pendingGithubAttempt) {
    // Simulates returning from a GitHub callback started in this tab.
    sessionStorage.setItem("occ.console.githubAttempt", "a".repeat(43));
  }
  // Preview frames share tab storage, so every scenario sets the signed-in mark itself: only
  // one whose tab had a session before it expired keeps it; a first visit has none.
  if (scenario.expiredSession) {
    sessionStorage.setItem("occ.console.signedIn", "1");
  } else {
    sessionStorage.removeItem("occ.console.signedIn");
  }
  if (scenario.pendingGoogleAttempt) {
    // Simulates returning from a Google callback started in this tab.
    sessionStorage.setItem("occ.console.googleAttempt", "a".repeat(43));
  }
  let serial = 100;
  const nextId = (prefix: string) =>
    `${prefix}_00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`;
  const configurationStore = createConfigurationStore(scenario, namespaceId, createdAt, nextId);
  const { configs } = configurationStore;
  const credentials: Parameters<typeof createAgentLifecycle>[1]["credentials"] = new Map();
  const credentialSources = new Map<string, StoredCredentialSource>();
  let credentialRegistrationFailed = false;
  const deviceLogins = new Map<string, DeviceLogin>();
  const secrets = new Map<string, ReturnType<typeof secretMetadata>>();
  const roles: StoredIdentity[] = [];
  const bindings: StoredIdentity[] = [];
  const session = {
    authenticated: true,
    sessionKey: "storybook-session",
    user: scenario.sessionUser ?? {
      id: "storybook-operator",
      name: "Demo Operator",
      email: "operator@example.com",
    },
  };
  const namespaces: { id: string; name: string; status: string; createdAt: string }[] =
    scenario.emptyNamespaces
      ? []
      : [
          {
            id: namespaceId,
            name: scenario.namespaceName ?? "Engineering",
            status: scenario.namespaceStatus ?? "ready",
            createdAt,
          },
          {
            id: "ns_00000000-0000-4000-8000-000000000002",
            name: "Research",
            status: "provisioning",
            createdAt,
          },
        ];
  const namespaceDeletionReads = new Map<string, number>();
  const backends = scenario.emptyBackends
    ? []
    : [{ id: "chatgpt-demo", name: "ChatGPT", type: "chatgpt" }];
  const secretMetadata = (id: string, name: string): SecretMetadata => ({
    id,
    namespaceId,
    name,
    ref: secretRef(id),
  });
  for (const secret of [
    secretMetadata("sec_demo_model", "Demo model API key (simulated)"),
    secretMetadata("sec_demo_service_account", "Demo Service Accounts token (simulated)"),
    secretMetadata("sec_demo_slack_app_token", "Slack app token (simulated)"),
    secretMetadata("sec_demo_slack_bot_token", "Slack bot token (simulated)"),
    secretMetadata("sec_demo_slack_backup_token", "Slack backup token (simulated)"),
    ...(scenario.extraSecrets ?? []).map((secret) => secretMetadata(secret.id, secret.name)),
  ]) {
    secrets.set(secret.id, secret);
  }
  const accounts = [
    {
      id: "sa_demo",
      name: "Research service",
      credential: { kind: "access_token" },
      backendId: "chatgpt-demo",
      status: "active",
      createdAt,
    },
  ];
  const config: StoredConfiguration & {
    values: ReturnType<typeof configurationValues>;
    secretBindings: Record<string, OpenClawConfigurationDocument>;
  } = {
    id: "cfg_00000000-0000-4000-8000-000000000001",
    namespaceId,
    kind: "agent",
    generation: 1,
    createdAt,
    values: configurationValues(scenario),
    secretBindings: {},
  };
  if (scenario.candidateDeploymentStatus) {
    config.generation = 2;
    config.values.agents.defaults.model = "codex/gpt-5.1";
  }
  if (scenario.slack && scenario.slackBindings !== false) {
    const keys =
      typeof scenario.slackBindings === "object"
        ? scenario.slackBindings
        : scenario.slackBindings === "app"
          ? ["SLACK_APP_TOKEN"]
          : ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"];
    for (const key of keys) {
      config.secretBindings[key] = {
        source: { ...secretRef(`sec_demo_${key.toLowerCase()}`) },
        delivery: { type: "env" },
      };
    }
    // The demo Agent was granted the Slack Secrets it binds, unless the scenario left one out:
    // an administrator's console reads these grants (finding 1920).
    roles.push(
      storedIdentity({
        id: "role_demo_secret_operate",
        namespaceId,
        name: "Agent Secret operate",
        permissions: [{ action: "operate", resourceKind: "secret" }],
      }),
    );
    for (const key of keys.filter((name) => name !== scenario.slackGrantMissing)) {
      bindings.push(
        storedIdentity({
          id: `binding_demo_${key.toLowerCase()}`,
          namespaceId,
          subjectKind: "identity",
          subjectId: "identity_demo_agent",
          roleId: "role_demo_secret_operate",
          resourceKind: "secret",
          resourceId: `sec_demo_${key.toLowerCase()}`,
        }),
      );
    }
  }
  configs.set(config.id, config);
  const selectedAuth: HarnessAuthBinding | null =
    scenario.auth === null
      ? null
      : scenario.auth === "runtime"
        ? { method: "runtime" }
        : scenario.auth === "service"
          ? { method: "codex_pat", source: { kind: "service_account", namespaceId, id: "sa_demo" } }
          : scenario.auth === "codex_pat"
            ? { method: "codex_pat", source: secretRef("sec_demo_service_account") }
            : scenario.auth === "oauth"
              ? { method: "credential_source", sourceId: "cs_00000000-0000-4000-8000-000000000010" }
              : auth;
  // The demo Agent was granted its harness authentication Secret or credential source, unless the
  // scenario left it out: an administrator's Credentials tab reads this grant (finding 2260).
  const harnessCredential =
    selectedAuth?.method === "credential_source"
      ? { kind: "credential_source", id: selectedAuth.sourceId }
      : selectedAuth && "source" in selectedAuth && selectedAuth.source.kind === "secret"
        ? { kind: "secret", id: selectedAuth.source.id }
        : null;
  if (harnessCredential && !scenario.harnessGrantMissing) {
    const roleId = `role_demo_${harnessCredential.kind}_operate`;
    if (!roles.some((role) => role.id === roleId)) {
      roles.push(
        storedIdentity({
          id: roleId,
          namespaceId,
          name:
            harnessCredential.kind === "secret"
              ? "Agent Secret operate"
              : "Agent Credential Source operate",
          permissions: [{ action: "operate", resourceKind: harnessCredential.kind }],
        }),
      );
    }
    bindings.push(
      storedIdentity({
        id: "binding_demo_harness_auth",
        namespaceId,
        subjectKind: "identity",
        subjectId: "identity_demo_agent",
        roleId,
        resourceKind: harnessCredential.kind,
        resourceId: harnessCredential.id,
      }),
    );
  }
  const lifecycle = createAgentLifecycle(scenario, {
    namespaceId,
    createdAt,
    nextId,
    configs,
    config,
    selectedAuth,
    credentials,
    deploymentError: (checkedAt) => candidateDeploymentError(scenario, checkedAt),
  });
  const presets = createPresetFixtures(scenario, namespaceId, auth);
  const networkPolicy = createNetworkPolicyFixture(scenario, {
    namespaceId,
    createdAt,
    candidateRevisionId,
    seedAgent: () => lifecycle.seedAgent(),
  });
  const answer = async (url: URL, method: string, body: unknown): Promise<Response> => {
    const path = url.pathname;
    if (path === "/api/auth/providers" && method === "GET") {
      return response({
        github: scenario.githubEnabled === true,
        google: scenario.googleEnabled === true,
        password: scenario.passwordRecoveryOnly !== true,
        sessionBinding: scenario.githubEnabled === true || scenario.googleEnabled === true,
      });
    }
    if (
      (path === "/api/auth/providers/github/start" ||
        path === "/api/auth/providers/google/start") &&
      method === "POST"
    ) {
      // Keep the preview local; provider navigation needs real backend verification.
      return error(503);
    }
    if (
      (path === "/api/auth/providers/github/result" ||
        path === "/api/auth/providers/google/result") &&
      method === "POST"
    ) {
      return response({ sessionKey: session.sessionKey });
    }
    if (path === "/api/auth/session") {
      return response(signedIn ? session : null);
    }
    if (path === "/api/auth/sign-in/email" && method === "POST") {
      signedIn = true;
      return response({ authenticated: true, sessionKey: session.sessionKey });
    }
    if (path === "/api/auth/sign-out" && method === "POST") {
      signedIn = false;
      return response({});
    }
    if (path === "/installation/driver-configurations" && method === "GET") {
      return response(installationDriverConfigurations(scenario));
    }
    if (path === "/installation" && method === "GET") {
      return response(installationFixture(installationScenario(scenario), createdAt));
    }
    if (path === "/namespaces" && method === "POST") {
      if (
        body === null ||
        typeof body !== "object" ||
        !("name" in body) ||
        typeof body.name !== "string"
      ) {
        return error(400, "INVALID_REQUEST", "The preview requires a string Namespace name.");
      }
      if (namespaces.some((item) => item.name === body.name)) {
        return error(409, "RESOURCE_CONFLICT");
      }
      const created = {
        id: nextId("ns"),
        name: body.name,
        status: "provisioning",
        createdAt,
      };
      namespaces.push(created);
      return response(created, 201);
    }
    if (path === "/namespaces" && method === "GET") {
      // Once the story's actions ran, each read takes the next recheck answer: a status for the
      // story's Namespace, "missing" to leave it out of the list, or an HTTP status to fail
      // with. The last one repeats.
      if (evidence.ready && namespaceRechecks.length) {
        const next =
          namespaceRechecks.length > 1 ? namespaceRechecks.shift() : namespaceRechecks[0];
        if (typeof next === "number") {
          return error(next);
        }
        if (next === "missing") {
          return response(namespaces.slice(1));
        }
        const first = namespaces[0];
        if (!first || next === undefined) {
          throw new TypeError("Missing preview Namespace recheck");
        }
        first.status = next;
      }
      return response(namespaces);
    }
    const namespaceMatch = path.match(/^\/namespaces\/([^/]+)$/);
    if (namespaceMatch) {
      const item = namespaces.find((namespace) => namespace.id === namespaceMatch[1]);
      if (!item) {
        return error(404, "NOT_FOUND");
      }
      if (method === "DELETE") {
        if (scenario.namespaceDeleteOutcome === "blocked") {
          return response(
            null,
            409,
            "NAMESPACE_NOT_EMPTY",
            {},
            "The requested Namespace is not empty. It still contains Agents, Configurations and Secrets.",
            undefined,
            [
              { kind: "Agents", count: 1, ids: ["agt_00000000-0000-4000-8000-000000000003"] },
              {
                kind: "Configurations",
                count: 3,
                ids: ["cfg_00000000-0000-4000-8000-000000000004"],
              },
              // The caller cannot read this Secret, so the API counts it without its ID.
              { kind: "Secrets", count: 1, ids: [] },
            ],
          );
        }
        if (scenario.namespaceDeleteOutcome === "forbidden") {
          return error(
            403,
            "FORBIDDEN",
            "Not authorized: Namespace delete is required on this Namespace.",
          );
        }
        item.status = "deleting";
        namespaceDeletionReads.set(item.id, 0);
        if (scenario.namespaceDeleteOutcome === "pending") {
          await new Promise((resolve) => setTimeout(resolve, 20000));
        }
        if (scenario.namespaceDeleteOutcome === "unknown") {
          return error(503, "DEPENDENCY_UNAVAILABLE");
        }
        return response(item, 202);
      }
      if (method === "GET") {
        if (item.status === "deleting" && scenario.namespaceDeleteOutcome === "complete") {
          const reads = (namespaceDeletionReads.get(item.id) ?? 0) + 1;
          namespaceDeletionReads.set(item.id, reads);
          if (reads > 1) {
            namespaces.splice(namespaces.indexOf(item), 1);
            return error(404, "NOT_FOUND");
          }
        }
        return response(item);
      }
    }
    if (path === "/backends" && method === "GET") {
      return response(backends);
    }
    if (path === "/observability" && method === "GET") {
      return scenario.observabilityDenied
        ? error(403)
        : response({ url: scenario.observabilityUrl ?? null });
    }
    const match = path.match(/^\/namespaces\/([^/]+)\/(.*)$/);
    if (match) {
      const [, ns, resource = ""] = match;
      if (ns !== namespaceId) {
        if (resource === "permissions" && namespaces.some((item) => item.id === ns)) {
          return response({
            delete: !scenario.namespaceDeleteDenied && !scenario.namespaceDeleteRestricted,
            agents: { create: true },
            secrets: { create: true },
            // A member refused delete is no Installation administrator; an administrator is
            // refused it only by a Restriction.
            installation: {
              administer: !scenario.observabilityDenied && !scenario.namespaceDeleteDenied,
            },
          });
        }
        return response([]);
      }
      const deviceLogin = resource.match(
        /^agents(?:\/[^/]+)?\/device-authorizations(?:\/([^/]+)(\/poll)?)?$/,
      );
      if (deviceLogin) {
        const [, id, poll] = deviceLogin;
        if (!id && method === "POST") {
          const session = secretRef(nextId("sec"));
          const login: DeviceLogin = {
            session,
            status: "pending",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "DEMO-1234",
            expiresAt: new Date(Date.now() + (scenario.oauthExpired ? -1 : 600_000)).toISOString(),
            intervalSeconds: 1,
          };
          deviceLogins.set(session.id, login);
          return response(login);
        }
        const login = deviceLogins.get(id ?? "");
        if (!login) {
          return error(404);
        }
        if (poll && method === "POST") {
          if (!scenario.oauthPending) {
            login.status = "ready";
            login.source ??= { kind: "credential_source", namespaceId, id: nextId("cs") };
          }
          return response(login);
        }
        if (!poll && method === "DELETE") {
          deviceLogins.delete(id ?? "");
          secrets.delete(id ?? "");
          return new Response(null, { status: 204 });
        }
      }
      if (resource === "service-accounts" && method === "GET") {
        return response(scenario.serviceAccountsEmpty ? [] : accounts);
      }
      if (
        (resource === "agents/repository-options" ||
          /^agents\/[^/]+\/repository-options$/.test(resource)) &&
        method === "GET"
      ) {
        const options = scenario.repositoryOptions ?? [
          {
            repositoryRef: "application",
            displayName: "example/application",
            description: "The application and services used by the team.",
            allowedProfiles: ["git-read", "git-write", "git-full"],
          },
          {
            repositoryRef: "handbook",
            displayName: "example/handbook",
            description: "Guides and operating practices for the team.",
            allowedProfiles: ["git-read"],
          },
        ];
        const requestedDescriptions = new Set(
          url.searchParams.get("descriptionRefs")?.split(",") ?? [],
        );
        const descriptionsPending =
          requestedDescriptions.size > 0 &&
          scenario.repositoryDescriptionsPending &&
          repositoryDescriptionRequests++ === 0;
        return response(
          options.map(({ description, ...option }) =>
            requestedDescriptions.has(option.repositoryRef) && !descriptionsPending && description
              ? { ...option, description }
              : option,
          ),
          200,
          undefined,
          {
            ...(descriptionsPending ? { descriptionsPending: true } : {}),
            ...(scenario.repositoryNotConfigured ? { notConfigured: true } : {}),
          },
        );
      }
      if (resource === "presets" && method === "GET") {
        // Lists carry summaries; the template stays on the exact Preset read.
        return response(
          scenario.emptyPresets
            ? []
            : presets.map(({ id, namespaceId, name, createdAt }) => ({
                id,
                namespaceId,
                name,
                createdAt,
              })),
        );
      }
      if (resource.startsWith("presets/") && method === "GET") {
        const selectedPreset = presets.find((item) => item.id === resource.split("/")[1]);
        return selectedPreset ? response(selectedPreset) : error(404);
      }
      if (resource === "agents/plugins" && method === "POST" && scenario.pluginDiscovery) {
        return servePluginDiscovery(scenario.pluginDiscovery, "catalog", body, response, error);
      }
      if (resource === "agents/plugins/details" && method === "POST" && scenario.pluginDiscovery) {
        return servePluginDiscovery(scenario.pluginDiscovery, "details", body, response, error);
      }
      if (resource === "channel-directory/lookup" && method === "POST") {
        return serveChannelDirectory(body, secrets, evidence);
      }
      if (resource === "credential-sources") {
        if (method === "GET") {
          return response([...credentialSources.values()]);
        }
        if (method === "POST") {
          if (
            scenario.credentialRegistrationOutcome === "invalid-config" &&
            !credentialRegistrationFailed
          ) {
            credentialRegistrationFailed = true;
            return error(
              400,
              "INVALID_REQUEST",
              "Credential destination authorization must match the Installation model provider.",
            );
          }
          if (body === null || body === undefined) {
            return error(
              400,
              "INVALID_REQUEST",
              "The preview requires a Credential Source registration body.",
            );
          }
          // Preserve the legacy opaque spread, including partial registrations.
          // Only config's existing nullish default is interpreted here.
          const input: object = Object(body);
          const uncertain = scenario.credentialRegistrationOutcome && !credentialRegistrationFailed;
          const id = nextId("csr");
          const saved: StoredCredentialSource = {
            ...input,
            id,
            config: "config" in input ? (input.config ?? {}) : {},
            ref: { kind: "credential_source", namespaceId, id },
            namespaceId,
            driverId: "credential-gateway-storybook",
            state:
              uncertain && scenario.credentialRegistrationOutcome === "deleting"
                ? "deleting"
                : "ready",
            createdAt,
          };
          credentialSources.set(saved.id, saved);
          if (uncertain) {
            // Preserve the server-owned registration after an uncertain response;
            // recovery operates on the saved source, never another model Secret.
            credentialRegistrationFailed = true;
            if (scenario.credentialRegistrationOutcome === "different-source") {
              const otherId = nextId("csr");
              const other = {
                ...saved,
                id: otherId,
                name: "Another model registration",
                ref: { ...saved.ref, id: otherId },
              };
              credentialSources.set(other.id, other);
              return response(other, 201);
            }
            return error(503, "DEPENDENCY_UNAVAILABLE");
          }
          return response(saved, 201);
        }
      }
      if (resource.startsWith("credential-sources/")) {
        const id = resource.split("/")[1] ?? "";
        const source = credentialSources.get(id);
        if (!source) {
          return error(404, "NOT_FOUND");
        }
        if (method === "GET") {
          return response(source);
        }
        if (method === "DELETE") {
          credentialSources.delete(id);
          return new Response(null, { status: 204 });
        }
      }
      const configurationReply = configurationStore.serve(resource, method, body);
      if (configurationReply !== undefined) {
        return configurationReply;
      }
      if (resource === "permissions" && method === "GET") {
        return response({
          delete: !scenario.namespaceDeleteDenied && !scenario.namespaceDeleteRestricted,
          agents: {
            create: !scenario.readOnlyPermissionSummary && !scenario.agentCreateRestricted,
          },
          secrets: { create: !scenario.secretCreateNotPermitted },
          // A read-only member is no Installation administrator either, nor is a member refused
          // Namespace delete.
          installation: {
            administer:
              !scenario.readOnlyPermissionSummary &&
              !scenario.observabilityDenied &&
              !scenario.namespaceDeleteDenied,
          },
        });
      }
      if (resource === "permissions/secrets" && method === "GET") {
        return response({ operateDenied: scenario.secretOperateDenied ?? [] });
      }
      if (
        resource === "agents" ||
        resource === "agents/validate" ||
        /^agents\/[^/]+\/deletion-status$/.test(resource) ||
        resource.startsWith("agents/provision")
      ) {
        const reply = await lifecycle.serve(resource, method, body, url);
        if (reply !== undefined) {
          return reply;
        }
      }
      const agentMatch = resource.match(/^agents\/([^/]+)(.*)$/);
      if (agentMatch) {
        const [, id = "", suffix = ""] = agentMatch;
        const saved = lifecycle.lookupAgent(id);
        if (!saved) {
          return error(404);
        }
        const policyReply = networkPolicy.serve(id, suffix, method, body, url);
        if (policyReply !== undefined) {
          return policyReply;
        }
        if (suffix === "/plugins/capabilities" && method === "GET" && scenario.pluginCapabilities) {
          return response({
            ...scenario.pluginCapabilities,
            discoveryCredential: scenario.pluginDiscoveryCredential ?? "required",
          });
        }
        if (suffix === "/plugins" && method === "POST" && scenario.pluginDiscovery) {
          return servePluginDiscovery(scenario.pluginDiscovery, "catalog", body, response, error);
        }
        if (suffix === "/plugins/details" && method === "POST" && scenario.pluginDiscovery) {
          return servePluginDiscovery(scenario.pluginDiscovery, "details", body, response, error);
        }
        if (suffix === "/permissions" && method === "GET") {
          const allowed = !scenario.readOnlyPermissionSummary;
          return response(
            scenario.agentPermissionSummary ?? {
              update: allowed,
              deploy: allowed,
              operate: allowed,
              delete: allowed,
              administer: allowed,
              configurationUpdate: allowed,
              configurationRead: true,
              configurationSecretsOperate: allowed,
              configurationSecretsOperateDeniedBindings: [],
              agentSourcesOperate: allowed,
              sandboxPolicyRead: allowed,
              readLogs: allowed,
            },
          );
        }
        if (suffix === "/permissions/secrets" && method === "GET") {
          return response({ operateDenied: scenario.secretOperateDenied ?? [] });
        }
        if (suffix === "/native-admin" && method === "GET") {
          return response({
            status: scenario.nativeAdmin ?? "disabled",
            url:
              (id === lifecycle.seedAgent().id ? scenario.nativeAdminUrl : undefined) ??
              "/storybook-fixtures/native-admin.html",
          });
        }
        if (suffix === "/harness-status" && method === "GET") {
          // A scenario's harness answers for the current version, as OCC reads it.
          return response(
            scenario.harness === undefined || !saved.activeRevisionId
              ? { status: "unobserved" }
              : {
                  status: "observed",
                  revisionId: saved.activeRevisionId,
                  harness: scenario.harness,
                },
          );
        }
        if (suffix === "/runtime-images" && method === "GET") {
          return response(scenario.runtimeImages ?? { status: "unsupported", images: [] });
        }
        if (suffix === "/runtime-credentials") {
          if (method === "POST") {
            credentials.set(id, { transportConfigured: true });
          }
          if (["GET", "POST"].includes(method)) {
            return response(credentials.get(id) ?? { transportConfigured: true });
          }
        }
        if (suffix.startsWith("/deployments/") && suffix.endsWith("/runtime") && method === "GET") {
          const revisionId = suffix.split("/")[2] ?? "";
          if (!lifecycle.hasAgentRevision(id, revisionId)) {
            return error(404, "NOT_FOUND", "The requested platform resource was not found.");
          }
          lifecycle.recordRuntimeStatusRead();
          if (scenario.bootstrapRuntime) {
            const terminated = (
              name: string,
              reason: string,
              exitCode: number,
            ): AgentRuntimeContainerStatus => ({
              name,
              state: "terminated",
              reason,
              ready: false,
              restartCount: 0,
              startedAt: createdAt,
              lastTermination: { reason, exitCode, finishedAt: createdAt },
            });
            const pod = {
              role: "agent",
              cluster: "control",
              name: "oauth-bootstrap-demo-pod",
              uid: "bootstrap-demo-uid",
              phase: "Failed",
              ready: false,
              createdAt,
              events: [],
              containers: [
                terminated("prepare-oauth-home", "Completed", 0),
                terminated("oauth-bootstrap", "Error", 1),
              ],
            };
            return response({
              revisionId,
              observedAt: createdAt,
              pods: [pod],
              sources: [
                {
                  id: "agent",
                  kind: "container",
                  available: true,
                  retention: "Output disappears after cleanup.",
                  pods: ["oauth-bootstrap", "prepare-oauth-home"].map((container) => ({
                    name: pod.name,
                    uid: pod.uid,
                    container,
                    restartCount: 0,
                  })),
                },
              ],
            });
          }
          const startup = scenario.runtimePod === "startupWarnings";
          const pod: FixturePod = {
            role: "gateway",
            cluster: "control",
            name: "gateway-7d9f8c-x2k4q",
            uid: "0f3b6c1e-7d52-4f4b-9a2e-5c6d7e8f9a01",
            phase: "Running",
            ready: true,
            createdAt: "2026-09-27T10:00:00.000Z",
            containers: [
              {
                name: "gateway",
                state: "running",
                reason: null,
                ready: true,
                restartCount: startup ? 0 : 1,
                startedAt: "2026-09-27T11:40:00.000Z",
                lastTermination: startup
                  ? null
                  : {
                      reason: "OOMKilled",
                      exitCode: 137,
                      finishedAt: "2026-09-27T11:39:58.000Z",
                    },
              },
            ],
            // A healthy first deploy: readiness probes failed while the Gateway started.
            events: startup
              ? [
                  {
                    type: "Warning",
                    container: "gateway",
                    reason: "Unhealthy",
                    message: "Readiness probe failed: Gateway /readyz unavailable: ECONNREFUSED",
                    count: 8,
                    lastObservedAt: "2026-09-27T11:40:20.000Z",
                  },
                ]
              : [
                  {
                    type: "Warning",
                    reason: "BackOff",
                    message: "Back-off restarting failed container gateway",
                    count: 2,
                    lastObservedAt: "2026-09-27T11:39:59.000Z",
                  },
                ],
          };
          const pods = [pod];
          if (scenario.runtimePod === "dedicatedPair") {
            // A dedicated Agent: a Harness Pod beside the Gateway, both with the generated long
            // names and completed init containers a real install shows. This story is about the
            // Pod cards; its Agent (Harness) source reads the same simulated Gateway output.
            const completed = (name: string): AgentRuntimeContainerStatus => ({
              name,
              state: "terminated",
              reason: "Completed",
              ready: false,
              restartCount: 0,
              startedAt: "2026-09-27T10:00:02.000Z",
              lastTermination: {
                reason: "Completed",
                exitCode: 0,
                finishedAt: "2026-09-27T10:00:04.000Z",
              },
            });
            const running = (name: string): AgentRuntimeContainerStatus => ({
              name,
              state: "running",
              reason: null,
              ready: true,
              restartCount: 0,
              startedAt: "2026-09-27T10:00:05.000Z",
              lastTermination: null,
            });
            pods.splice(
              0,
              1,
              {
                ...pod,
                role: "agent",
                name: "agent-9194e1800111-rev-997042d6ce64-6b5bbd9699-v5rcp",
                uid: "8d6b1c2e-3f4a-4b5c-9d6e-7f8a9b0c1d2e",
                containers: [
                  running("agent"),
                  completed("prepare-private-state"),
                  completed("initialize-workspace"),
                ],
                events: [],
              },
              {
                ...pod,
                name: "gateway-9194e1800111-65579dc888-j2czd",
                containers: [running("gateway"), completed("prepare-private-state")],
                events: [],
              },
            );
          }
          if (
            scenario.runtimePod === "none" ||
            (scenario.runtimePod === "replaced" && revisionId !== saved.activeRevisionId)
          ) {
            // A version whose Pods are gone, such as an older one: nothing runs to read. Under
            // "replaced" only the version selected for service still runs.
            pods.length = 0;
          }
          if (scenario.runtimePod === "rollover") {
            const retiring = podRolloverStatusReads++ === 0;
            pods.push({
              ...pod,
              name: retiring ? "gateway-retiring" : "gateway-standby",
              uid: pod.uid.slice(0, -1) + (retiring ? "2" : "3"),
            });
          }
          return response({
            revisionId,
            observedAt: "2026-09-27T12:00:00.000Z",
            pods,
            sources: [
              {
                id: "gateway",
                kind: "container",
                pods: pods
                  .filter(({ role }) => role === "gateway")
                  .map(({ name, uid, containers }) => ({
                    name,
                    uid,
                    container: "gateway",
                    // The Gateway container's own count: a Pod that never restarted has no
                    // previous instance to read (finding 2944).
                    restartCount:
                      containers?.find((item) => item.name === "gateway")?.restartCount ?? 1,
                  })),
                available: pods.length > 0,
                ...(pods.length > 0 ? {} : { unavailableCode: "NO_POD" }),
                retention:
                  "Kubernetes keeps only the current and the previous instance of each container; older output and output from deleted Pods is gone.",
              },
              ...pods
                .filter(({ role }) => role === "agent")
                .map(({ name, uid }) => ({
                  id: "agent",
                  kind: "container",
                  pods: [{ name, uid, container: "agent", restartCount: 0 }],
                  available: true,
                  retention: "Kubernetes keeps the current and the previous instance.",
                })),
              // Dedicated sources remain listed even when their current Pod is absent.
              ...(scenario.runtimePod === "missingAgent"
                ? [
                    {
                      id: "agent",
                      kind: "container",
                      pods: [],
                      available: false,
                      unavailableCode: "NO_POD",
                      retention: "Kubernetes keeps the current and the previous instance.",
                    },
                  ]
                : []),
            ],
          });
        }
        if (
          suffix.startsWith("/deployments/") &&
          suffix.endsWith("/runtime/logs") &&
          method === "GET"
        ) {
          lifecycle.recordRuntimeLogRead();
          const revisionId = suffix.split("/")[2] ?? "";
          if (url.searchParams.get("download") === "true") {
            // Downloads are a text/plain attachment, not a JSON envelope.
            if (scenario.runtimeLogDownloadNoPod) {
              return new Response(
                `# agent=${id} revision=${revisionId} source=${url.searchParams.get("source")} observedAt=2026-09-27T11:41:10.000Z withheld=0\n`,
                {
                  status: 200,
                  headers: {
                    "content-type": "text/plain; charset=utf-8",
                    "content-disposition": `attachment; filename="${id}-${revisionId}-${url.searchParams.get("source")}-no-pod.log"`,
                  },
                },
              );
            }
            return new Response(
              [
                "2026-09-27T11:40:01.120Z info wrapper runtime.startup_phase container=gateway phase=config outcome=ok ms=12",
                "2026-09-27T11:40:03.400Z info openclaw [gateway] gateway listening",
                "2026-09-27T11:41:10.000Z warn openclaw [channels/slack] slack socket reconnect with token=[redacted:key-value]",
                "",
              ].join("\n"),
              {
                status: 200,
                headers: {
                  "content-type": "text/plain; charset=utf-8",
                  "content-disposition": `attachment; filename="${revisionId}-gateway.log"`,
                },
              },
            );
          }
          if (scenario.bootstrapRuntime) {
            const container = url.searchParams.get("container") ?? "oauth-bootstrap";
            const stream = {
              source: "agent",
              pod: "oauth-bootstrap-demo-pod",
              podUid: "bootstrap-demo-uid",
              container,
              restartCount: 0,
            };
            return response({
              revisionId,
              source: "agent",
              stream,
              observedAt: createdAt,
              withheld: 0,
              truncated: false,
              cursor: null,
              records: [
                {
                  type: "line",
                  time: createdAt,
                  stream,
                  contentClass: "operational",
                  kind: "text",
                  level: "unknown",
                  message:
                    container === "oauth-bootstrap"
                      ? "Credential file initialization failed."
                      : "Private directory initialization completed.",
                },
              ],
            });
          }
          const pod = url.searchParams.get("pod") ?? "gateway-7d9f8c-x2k4q";
          const podSuffix =
            pod === "gateway-retiring" ? "2" : pod === "gateway-standby" ? "3" : "1";
          const stream = {
            source: "gateway",
            pod,
            podUid: "0f3b6c1e-7d52-4f4b-9a2e-5c6d7e8f9a0" + podSuffix,
            container: "gateway",
            restartCount: 1,
          };
          const listeningMessage =
            scenario.runtimePod === "rollover" ? `${pod} ready for requests` : "gateway listening";
          const line = (
            time: string,
            kind: string,
            level: string,
            message: string,
            extra: { fields?: Record<string, string | number>; subsystem?: string } = {},
          ) => ({
            type: "line",
            time,
            stream,
            contentClass: "operational",
            kind,
            level,
            message,
            ...extra,
          });
          return response({
            revisionId,
            source: "gateway",
            stream,
            observedAt: "2026-09-27T12:00:00.000Z",
            records: [
              line("2026-09-27T11:40:01.120Z", "wrapper", "info", "runtime.startup_phase", {
                fields: { container: "gateway", phase: "config", outcome: "ok", ms: 12 },
              }),
              line("2026-09-27T11:40:03.400Z", "openclaw", "info", listeningMessage, {
                subsystem: "gateway",
              }),
              {
                type: "withheld",
                time: "2026-09-27T11:40:04.000Z",
                stream,
                count: 3,
                reason: "unrecognised_structured",
              },
              line(
                "2026-09-27T11:41:10.000Z",
                "openclaw",
                "warn",
                "slack socket reconnect with token=[redacted:key-value]",
                { subsystem: "channels/slack" },
              ),
            ],
            withheld: 3,
            truncated: false,
            cursor: `v1.${"a".repeat(40)}.${"b".repeat(43)}`,
          });
        }
        if (
          suffix.startsWith("/deployments/") &&
          suffix.endsWith("/diagnostics") &&
          method === "POST"
        ) {
          const revisionId = suffix.split("/")[2] ?? "";
          if (!lifecycle.hasAgentRevision(id, revisionId)) {
            return error(404, "NOT_FOUND", "The requested platform resource was not found.");
          }
          if (scenario.diagnosticsState === "noSlack") {
            // The gateway's answer for a version with no Slack channel.
            return response({
              revisionId,
              observedAt: "2026-09-27T12:00:00.000Z",
              checks: [
                ["configuration", "failed", "NOT_CONFIGURED"],
                ["authentication", "unknown"],
                ["connectivity", "unknown"],
              ].map(([check, state, code]) => ({
                component: "gateway",
                check,
                state,
                checkedAt: "2026-09-27T11:59:59.000Z",
                ...(code ? { code } : {}),
              })),
            });
          }
          return response({
            revisionId,
            observedAt: "2026-09-27T12:00:00.000Z",
            checks:
              scenario.diagnosticsState === "unknown"
                ? [
                    {
                      component: "gateway",
                      check: "configuration",
                      state: "succeeded",
                      checkedAt: "2026-09-27T11:59:59.000Z",
                    },
                    {
                      component: "gateway",
                      check: "authentication",
                      state: "unknown",
                      checkedAt: "2026-09-27T11:59:59.000Z",
                      code: "PROBE_FAILED",
                    },
                    {
                      component: "gateway",
                      check: "connectivity",
                      state: "unknown",
                      checkedAt: "2026-09-27T11:59:59.000Z",
                      code: "INCOMPATIBLE_RESPONSE",
                    },
                  ]
                : [
                    {
                      component: "gateway",
                      check: "configuration",
                      state: "succeeded",
                      checkedAt: "2026-09-27T11:59:59.000Z",
                    },
                    {
                      component: "gateway",
                      check: "authentication",
                      state: "succeeded",
                      checkedAt: "2026-09-27T11:59:59.000Z",
                    },
                    {
                      component: "gateway",
                      check: "connectivity",
                      state: "succeeded",
                      checkedAt: "2026-09-27T11:59:59.000Z",
                    },
                  ],
          });
        }
        const reply = await lifecycle.serve(resource, method, body, url);
        if (reply !== undefined) {
          return reply;
        }
      }
      if (resource === "iam/roles") {
        if (method === "GET") {
          return response(roles.map((role) => role.response));
        }
        if (method === "POST") {
          const input: object = Object(body);
          const role = { ...input, id: `role_${serial++}`, namespaceId };
          roles.push(storedIdentity(role));
          return response(role, 201);
        }
      }
      if (resource === "iam/access-bindings") {
        if (method === "GET") {
          return response(bindings.map((binding) => binding.response));
        }
        if (method === "POST") {
          const input: object = Object(body);
          const binding = { ...input, id: `binding_${serial++}`, namespaceId };
          bindings.push(storedIdentity(binding));
          return response(binding, 201);
        }
      }
      const bindingMatch = resource.match(/^iam\/access-bindings\/([^/]+)$/);
      if (bindingMatch && method === "DELETE") {
        const index = bindings.findIndex((binding) => binding.id === bindingMatch[1]);
        if (index < 0) {
          return error(404);
        }
        bindings.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      if (resource === "secrets") {
        if (method === "POST" && scenario.denySecretCreate) {
          return response(undefined, 403, "FORBIDDEN");
        }
        if (method === "GET") {
          return response(
            scenario.emptySecrets
              ? []
              : [...secrets.values()]
                  .filter(({ id }) => id !== scenario.unreadableSecretId)
                  .map((secret) => structuredClone(secret)),
          );
        }
        if (method === "POST") {
          if (
            body === null ||
            typeof body !== "object" ||
            !("name" in body) ||
            typeof body.name !== "string"
          ) {
            return error(400, "INVALID_REQUEST", "The preview requires a string Secret name.");
          }
          const name = body.name;
          if ([...secrets.values()].some((secret) => secret.name === name.trim())) {
            return response(undefined, 409, "RESOURCE_CONFLICT");
          }
          const id = nextId("sec");
          const secret = secretMetadata(id, name);
          secrets.set(secret.id, secret);
          return response(structuredClone(secret), 201);
        }
      }
      if (resource.startsWith("secrets/")) {
        const id = resource.split("/")[1] ?? "";
        const secret = secrets.get(id);
        if (!secret || id === scenario.unreadableSecretId) {
          return error(404);
        }
        if (method === "GET") {
          return response({
            ...structuredClone(secret),
            consumers: structuredClone(
              scenario.secretConsumers ?? {
                agents: [],
                configurations: [],
                credentialSources: [],
                provisioningRequests: [],
                unreadable: 0,
                truncated: false,
              },
            ),
            callerPermissions: { update: true, delete: true, ...scenario.secretCallerPermissions },
          });
        }
        if (method === "PATCH") {
          const updated = { ...secret };
          secrets.set(id, updated);
          return response(structuredClone(updated));
        }
        if (method === "DELETE") {
          const consumers = scenario.secretConsumers;
          if (
            consumers &&
            (consumers.unreadable ||
              consumers.truncated ||
              [
                consumers.agents,
                consumers.configurations,
                consumers.credentialSources,
                consumers.provisioningRequests,
              ].some((ids) => ids.length))
          ) {
            return response(undefined, 409, "RESOURCE_CONFLICT");
          }
          secrets.delete(id ?? "");
          return new Response(null, { status: 204 });
        }
      }
    }
    evidence.unhandled.push({ method, path });
    console.error(`Unconfigured story request: ${method} ${path}`);
    return error(501);
  };
  window.fetch = createFixtureFetch(scenario.rules ?? [], evidence.requests, answer);
}
