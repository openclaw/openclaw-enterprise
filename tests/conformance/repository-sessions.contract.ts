import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type {
  Agent,
  AgentRevision,
  HarnessAuthBinding,
  HarnessExecutionMode,
  Namespace,
  RepositoryRevisionState,
  Secret,
} from "@openclaw-enterprise/contracts";
import type { RepositorySessionRepository } from "../../packages/occ/src/ports/repository-sessions.ts";
import type {
  ConfigurationOwnership,
  PlatformStateStore,
} from "../../packages/occ/src/state/platform-state.ts";
import { verifyRepositorySessionCases } from "./repository-session-state-cases.ts";
import { repositoryCredentials } from "../fixtures/repository-credentials/session-state.ts";

type CreateAttemptInput = Parameters<RepositorySessionRepository["createAttempt"]>[0];

interface SeedOptions {
  readonly createdAt?: string | undefined;
  readonly namespaceId?: string | undefined;
  readonly executionMode?: HarnessExecutionMode | undefined;
}

type SessionRevision = Pick<AgentRevision, "id" | "namespaceId" | "agentId" | "createdAt"> & {
  readonly repositoryCredentials: Pick<RepositoryRevisionState, "deadlineWallMs">;
};

export async function seedSessionRevision(
  store: PlatformStateStore,
  credentials: RepositoryRevisionState = repositoryCredentials(),
  options: SeedOptions = {},
) {
  const createdAt = options.createdAt ?? "2030-03-17T17:46:40.000Z";
  const executionMode = options.executionMode ?? "embedded";
  const namespace = {
    id: options.namespaceId ?? `ns_${randomUUID()}`,
    name: `Repository session ${randomUUID()}`,
    status: "ready",
    createdAt,
  } satisfies Namespace;
  const configuration = {
    id: `cfg_${randomUUID()}`,
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt,
  } satisfies ConfigurationOwnership;
  const secret = {
    id: `sec_${randomUUID()}`,
    namespaceId: namespace.id,
    name: `model-key-${randomUUID()}`,
    driverId: "kubernetes-secret",
    backendRef: {
      namespaceName: `ns-${randomUUID().slice(0, 8)}`,
      name: `agent-${randomUUID().slice(0, 8)}.credentials`,
      key: "value",
      uid: randomUUID(),
    },
    createdAt,
  } satisfies Secret;
  const harnessAuth = {
    method: "api_key",
    source: { kind: "secret", namespaceId: namespace.id, id: secret.id },
  } satisfies HarnessAuthBinding;
  const agent = {
    id: `agt_${randomUUID()}`,
    namespaceId: namespace.id,
    name: `Session owner ${randomUUID()}`,
    configurationId: configuration.id,
    backendId: null,
    harnessAuth,
    executionMode,
    gatewayManagedMode: true,
    servicePrincipalId: `service-agent-${randomUUID()}`,
    repositoryBindings: credentials.bindings.map(({ repositoryRef, profile }) => ({
      repositoryRef,
      profile,
    })),
    createdAt,
  } satisfies Omit<Agent, "desiredRuntimeState" | "status">;
  const revision = {
    executionAdmission: { version: 2, mode: "unprotected" },
    id: `rev_${randomUUID()}`,
    namespaceId: namespace.id,
    agentId: agent.id,
    revision: 1,
    configurationId: configuration.id,
    configurationKind: "agent",
    configurationGeneration: 1,
    gatewayManagedMode: agent.gatewayManagedMode,
    backendId: null,
    harnessAuth: { ...harnessAuth, secretDriverId: secret.driverId },
    configuration: { agents: { defaults: { model: "openai/gpt-fixture" } } },
    harness: {
      id: "openclaw",
      version: "1.0.0",
      mode: executionMode,
      overrides: {},
      configuration: {},
    },
    compute: { id: "compute-test", implementation: "deterministic-test" },
    servicePrincipalId: agent.servicePrincipalId,
    repositoryCredentials: credentials,
    createdAt,
  } satisfies AgentRevision;
  await store.transact(async (unit) => {
    if ((await unit.installations.getInstallation()) === undefined) {
      await unit.installations.createInstallation({
        id: `ins_${randomUUID()}`,
        name: "Repository session State contract",
        createdAt,
      });
    }
    // A ready Namespace and admitted revision represent a runtime that may open sessions.
    await unit.namespaces.createNamespace(namespace);
    await unit.configurations.createConfiguration(configuration);
    await unit.secrets.createSecret(secret);
    await unit.agents.createAgent({ ...agent, desiredRuntimeState: "stopped", status: "active" });
    await unit.revisions.createRevision(revision);
    await unit.agents.transitionAgentDesiredRuntimeState(
      namespace.id,
      agent.id,
      "stopped",
      "running",
    );
  });
  return { namespace, configuration, agent, revision };
}

export function sessionAttempt(
  revision: SessionRevision,
  overrides: Partial<CreateAttemptInput> = {},
) {
  return {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
    repositoryRef: "source",
    admissionId: `admission-${randomUUID()}`,
    durationSeconds: 60,
    deadlineWallMs: revision.repositoryCredentials.deadlineWallMs,
    createdAt: revision.createdAt,
    ...overrides,
  } satisfies CreateAttemptInput;
}

export async function verifyRepositorySessions(t: TestContext, store: PlatformStateStore) {
  await verifyRepositorySessionCases(t, store, { seedSessionRevision, sessionAttempt });
}
