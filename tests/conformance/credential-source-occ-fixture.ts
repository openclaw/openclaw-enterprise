import type {
  Agent,
  AuditEvent,
  ComputeDriver,
  CredentialGatewayDriver,
  CredentialRefreshDriver,
  CredentialRefreshInput,
  CredentialRefreshStatus,
  CredentialSourceContext,
  CredentialSourceInput,
  CredentialSourceMetadata,
  CredentialSourceStatus,
  Namespace,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver, type NativeIAMState } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.ts";
import { permissionsFor } from "../helpers/iam-grants.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";

export const administrator = "principal-source-administrator";
export const deployer = "principal-source-deployer";
export const zeroGrant = "principal-source-zero-grant";
export const updater = "principal-source-updater";
export const editor = "principal-agent-editor";
export const installation = Object.freeze({
  id: "installation-credential-source-occ",
  name: "Credential source OCC conformance",
  createdAt: "2026-09-26T00:00:00.000Z",
});

/**
 * Test-only Credential Gateway: records what OCC hands it. These cases prove OCC admission,
 * authorization, and lifecycle; injection itself is proved by the real OpenShell integration.
 */
type DriverCall =
  | {
      operation: "registerSource";
      sourceId: string;
      namespaceName: string;
      input: CredentialSourceInput;
    }
  | { operation: "updateSource"; sourceId: string; input: CredentialSourceInput }
  | { operation: "removeSource" | "removeRefresh" | "refreshStatus"; sourceId: string }
  | { operation: "configureRefresh"; sourceId: string; input: CredentialRefreshInput }
  | { operation: "rotate"; sourceId: string; requestId: string };

export interface GatewayOptions {
  registerError?: Error;
  registerStatus?: CredentialSourceStatus;
  lateCreate?: boolean;
  replyError?: Error;
  updateError?: Error;
  updateStatus?: CredentialSourceStatus;
  sourceStatus?: CredentialSourceStatus;
  removeError?: () => Error | undefined;
}

type RecordingGateway = CredentialGatewayDriver & {
  calls: DriverCall[];
  stored: Map<string, CredentialSourceInput["secrets"]>;
  completeLateCreates(): void;
};

export function createTestCredentialGateway(options: GatewayOptions = {}): RecordingGateway {
  const calls: DriverCall[] = [];
  const stored = new Map<string, CredentialSourceInput["secrets"]>();
  const lateCreates: (() => void)[] = [];
  return {
    id: "credential-gateway-test",
    capability: "credential_gateway",
    implementation: "test-recording-gateway",
    calls,
    stored,
    completeLateCreates() {
      for (const create of lateCreates.splice(0)) {
        create();
      }
    },
    validateSourceConfig() {},
    async listSourceTypes() {
      return [
        {
          type: "openai",
          config: [],
          secrets: [{ name: "api_key", required: true }],
          rotation: "none",
          harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
        },
        {
          type: "registry",
          config: [{ name: "host", required: true }],
          secrets: [],
          rotation: "none",
        },
        {
          type: "oauth-client",
          config: [{ name: "client_id", required: true }],
          secrets: [{ name: "client_secret", required: true }],
          rotation: "refresh",
        },
        {
          // A rotating refresh token: the issuer replaces it each time the gateway uses it.
          type: "oauth-user",
          config: [{ name: "client_id", required: true }],
          secrets: [
            { name: "refresh_token", required: true, issuerRotated: true },
            { name: "client_secret", required: false },
          ],
          rotation: "refresh",
        },
      ];
    },
    async registerSource(context, input) {
      calls.push({
        operation: "registerSource",
        sourceId: context.source.id,
        namespaceName: context.namespace.name,
        input,
      });
      if (options.registerError !== undefined) {
        throw options.registerError;
      }
      if (options.registerStatus !== undefined) {
        return options.registerStatus;
      }
      // Models a timed-out create that the gateway applies only after OCC's cleanup ran.
      if (options.lateCreate === true) {
        lateCreates.push(() => stored.set(context.source.id, input.secrets));
        throw new Error("registration timed out");
      }
      stored.set(context.source.id, input.secrets);
      // Models a gateway that stored the copy but whose reply was lost.
      if (options.replyError !== undefined) {
        throw options.replyError;
      }
      return { state: "ready" };
    },
    async updateSource(context, input) {
      calls.push({ operation: "updateSource", sourceId: context.source.id, input });
      if (options.updateError !== undefined) {
        throw options.updateError;
      }
      if (options.updateStatus !== undefined) {
        return options.updateStatus;
      }
      if (!stored.has(context.source.id)) {
        return { state: "absent" };
      }
      stored.set(context.source.id, input.secrets);
      return { state: "ready" };
    },
    async sourceStatus(context) {
      if (options.sourceStatus !== undefined && stored.has(context.source.id)) {
        return options.sourceStatus;
      }
      return stored.has(context.source.id) ? { state: "ready" } : { state: "absent" };
    },
    async removeSource(context) {
      calls.push({ operation: "removeSource", sourceId: context.source.id });
      if (options.removeError?.() !== undefined) {
        throw options.removeError();
      }
      stored.delete(context.source.id);
    },
    async attachForRevision(context) {
      return context.sources.map((source) => ({ sourceId: source.id, ref: `ref-${source.id}` }));
    },
    async attachmentStatus(context) {
      return context.sources.map((source) => ({ sourceId: source.id, state: "ready" }));
    },
    async withdraw() {
      throw new Error("not exercised");
    },
  };
}

/**
 * Test-only Credential Refresh Driver: records OCC's calls in the gateway's call log, so cases
 * can assert ordering across both roles. Real minting is proved against OpenShell and Keycloak.
 */
interface RefreshOptions {
  rotateStatus?: CredentialRefreshStatus;
}

type RecordingRefresh = CredentialRefreshDriver & {
  configured: Map<string, CredentialRefreshInput["secrets"]>;
  nextRotate: ((context: CredentialSourceContext) => Promise<CredentialRefreshStatus>) | undefined;
};

export function createTestCredentialRefresh(
  calls: DriverCall[],
  options: RefreshOptions = {},
): RecordingRefresh {
  const configured = new Map<string, CredentialRefreshInput["secrets"]>();
  return {
    id: "credential-refresh-test",
    capability: "credential_refresh",
    implementation: "test-recording-refresh",
    configured,
    async configureRefresh(context, input) {
      calls.push({ operation: "configureRefresh", sourceId: context.source.id, input });
      configured.set(context.source.id, input.secrets);
      return { state: "pending" };
    },
    // A case sets it to hold or fail the next forced mints, as a slow or refusing issuer would.
    nextRotate: undefined,
    async rotate(context, requestId) {
      calls.push({ operation: "rotate", sourceId: context.source.id, requestId });
      if (this.nextRotate !== undefined) {
        return this.nextRotate(context);
      }
      return (
        options.rotateStatus ?? { state: "ready", lastRefreshAt: "2026-09-27T12:00:00.000000000Z" }
      );
    },
    async refreshStatus(context) {
      calls.push({ operation: "refreshStatus", sourceId: context.source.id });
      return { state: "ready", expiresAt: "2026-09-27T13:00:00.000000000Z" };
    },
    async removeRefresh(context) {
      calls.push({ operation: "removeRefresh", sourceId: context.source.id });
      configured.delete(context.source.id);
    },
  };
}

export function createTestSandbox(): SandboxDriver {
  return {
    id: "sandbox-test",
    capability: "sandbox",
    implementation: "test-sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async cleanup() {},
  };
}

interface FixtureOptions {
  gateway?: GatewayOptions;
  refresh?: RefreshOptions;
  withoutGateway?: boolean;
  withoutRefresh?: boolean;
  withoutSandbox?: boolean;
}

type FixtureIAMState = { -readonly [Key in keyof NativeIAMState]: NativeIAMState[Key][number][] };

export async function fixture(options: FixtureOptions = {}) {
  const iamState: FixtureIAMState = {
    identities: [administrator, deployer, zeroGrant, updater, editor].map((id) => ({
      kind: "principal" as const,
      id,
      issuer: "credential-source-occ",
      subject: id,
    })),
    groups: [],
    memberships: [],
    roles: [
      {
        id: "source-administrator-role",
        permissions: [
          { action: "administer", resourceKind: "installation" },
          ...permissionsFor({ namespace: ["create", "read", "delete"] }),
          ...permissionsFor({ configuration: ["create", "read", "update", "delete"] }),
          ...permissionsFor({ secret: ["create", "read", "update", "delete", "operate"] }),
          ...permissionsFor({
            credential_source: ["create", "read", "update", "delete", "operate"],
          }),
          ...permissionsFor({ agent: ["create", "read", "update", "delete", "deploy", "operate"] }),
          { action: "read", resourceKind: "agent_revision" },
        ],
      },
      {
        // May create sources and deploy, but may not operate on the Secret material.
        id: "source-deployer-role",
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "create", resourceKind: "credential_source" },
          { action: "read", resourceKind: "credential_source" },
        ],
      },
      {
        id: "source-agent-role",
        permissions: [{ action: "operate", resourceKind: "credential_source" }],
      },
      {
        // May edit Agents but may not operate on any credential source.
        id: "agent-editor-role",
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "read", resourceKind: "configuration" },
          { action: "read", resourceKind: "agent" },
          { action: "update", resourceKind: "agent" },
        ],
      },
      {
        // May update sources but may not operate on the Secret material an update reads.
        id: "source-updater-role",
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "read", resourceKind: "credential_source" },
          { action: "update", resourceKind: "credential_source" },
        ],
      },
    ],
    bindings: [
      {
        id: "source-administrator-binding",
        subjectKind: "identity",
        subjectId: administrator,
        roleId: "source-administrator-role",
      },
      {
        id: "source-deployer-binding",
        subjectKind: "identity",
        subjectId: deployer,
        roleId: "source-deployer-role",
      },
      {
        id: "agent-editor-binding",
        subjectKind: "identity",
        subjectId: editor,
        roleId: "agent-editor-role",
      },
      {
        id: "source-updater-binding",
        subjectKind: "identity",
        subjectId: updater,
        roleId: "source-updater-role",
      },
    ],
    restrictions: [],
  };
  const iam = new NativeIAMDriver(
    { loadNativeIAMState: async () => iamState },
    { id: "credential-source-iam" },
  );
  let now = Date.parse("2026-09-27T12:00:00.000Z");
  const state = new InMemoryPlatformState();
  const controller = new OpenClawController(installation, {
    state,
    now: () => new Date(now),
  });
  // Deletion is final only once no timed-out registration could still create a gateway copy.
  function passRegistrationFence() {
    now += 71_000;
  }
  function advanceClock(milliseconds: number) {
    now += milliseconds;
  }
  const secretDriver = createTestSecretDriver();
  const gateway = createTestCredentialGateway(options.gateway);
  const refresh = createTestCredentialRefresh(gateway.calls, options.refresh);
  // Compute owns runtime placement; the gateway must see the same name as the paired Sandbox.
  const compute = {
    ...createDevelopmentComputeDriver(),
    async resolveSandboxNamespace(namespace) {
      return { ...namespace, name: `placed-${namespace.id.slice(-12)}` };
    },
  } satisfies ComputeDriver;
  const drivers = [
    iam,
    compute,
    createTestConfigurationDriver({ id: "credential-source-configuration" }),
    secretDriver,
    ...(options.withoutGateway ? [] : [gateway]),
    ...(options.withoutRefresh || options.withoutGateway ? [] : [refresh]),
    ...(options.withoutSandbox ? [] : [createTestSandbox()]),
  ];
  for (const driver of drivers) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const namespace = await controller.createNamespace(administrator, { name: "Source tenant" });

  async function makeReady() {
    await controller.handleNamespaceLifecycle(administrator, namespace.id, "ready");
  }

  async function modelSecret() {
    return createSecret({ controller, namespace }, "model-key", "synthetic-model-key");
  }

  async function dedicatedAgent() {
    const configuration = await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values: {
        agents: {
          defaults: {
            model: "codex/gpt-5.6-sol",
            models: { "codex/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
      },
    });
    return controller.createAgent(administrator, {
      namespaceId: namespace.id,
      name: `dedicated-${crypto.randomUUID()}`,
      configurationId: configuration.id,
      executionMode: "dedicated",
    });
  }

  function grantAgentSourceOperate(
    agent: Pick<Agent, "id" | "namespaceId" | "servicePrincipalId">,
    source: Pick<CredentialSourceMetadata, "id">,
    suffix?: string,
  ) {
    if (!iamState.identities.some(({ id }) => id === agent.servicePrincipalId)) {
      iamState.identities.push({
        kind: "service_principal",
        id: agent.servicePrincipalId,
        namespaceId: agent.namespaceId,
        agentId: agent.id,
      });
    }
    iamState.bindings.push({
      id: `source-agent-binding-${agent.id}${suffix === undefined ? "" : `-${suffix}`}`,
      namespaceId: agent.namespaceId,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: "source-agent-role",
      resourceKind: "credential_source",
      resourceId: source.id,
    });
  }

  return {
    advanceClock,
    controller,
    dedicatedAgent,
    gateway,
    grantAgentSourceOperate,
    iamState,
    makeReady,
    modelSecret,
    namespace,
    passRegistrationFence,
    refresh,
    secretDriver,
    state,
  };
}

export async function createSecret(
  context: { controller: OpenClawController; namespace: Pick<Namespace, "id"> },
  name: string,
  value: string,
) {
  return context.controller.createSecret(administrator, {
    namespaceId: context.namespace.id,
    name: `${name}-${crypto.randomUUID()}`,
    value,
  });
}

export function auditEvent(namespaceId: string, id: string, action: string): AuditEvent {
  return {
    id: `aud_${crypto.randomUUID()}`,
    installationId: installation.id,
    namespaceId,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId: administrator,
    source: "occ",
    action,
    resource: { kind: "credential_source", id, namespaceId },
    outcome: "success",
  };
}

export async function auditActions(controller: OpenClawController) {
  return (await controller.transact((unit) => unit.audit.list()))
    .map(({ action }) => action)
    .filter((action) => action.startsWith("openclaw.credential_sources."));
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function refreshSource(context: Fixture, name = "oauth-client") {
  const secret = await createSecret(context, "client-secret", "synthetic-client-secret");
  const source = await context.controller.createCredentialSource(administrator, {
    namespaceId: context.namespace.id,
    name,
    type: "oauth-client",
    config: { client_id: "occ-tools" },
    secrets: { client_secret: secret.ref },
  });
  return { secret, source };
}
