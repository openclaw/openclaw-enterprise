import { randomUUID } from "node:crypto";
import { verifyRepositorySessionCases } from "./repository-session-state-cases.ts";
import { repositoryCredentials } from "../fixtures/repository-credentials/session-state.mjs";

/**
 * @param {import("../../packages/occ/src/state/platform-state.ts").PlatformStateStore} store
 * @param {import("@openclaw-enterprise/contracts").RepositoryRevisionState} [credentials]
 * @param {{ createdAt?: string | undefined, namespaceId?: string | undefined, executionMode?: import("@openclaw-enterprise/contracts").HarnessExecutionMode | undefined }} [options]
 */
export async function seedSessionRevision(
  store,
  credentials = repositoryCredentials(),
  options = {},
) {
  const createdAt = options.createdAt ?? "2030-03-17T17:46:40.000Z";
  const executionMode = options.executionMode ?? "embedded";
  const namespace = {
    id: options.namespaceId ?? `ns_${randomUUID()}`,
    name: `Repository session ${randomUUID()}`,
    status: "ready",
    createdAt,
  };
  const configuration = {
    id: `cfg_${randomUUID()}`,
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt,
  };
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
  };
  /** @satisfies {import("@openclaw-enterprise/contracts").HarnessAuthBinding} */
  const harnessAuth = {
    method: "api_key",
    source: { kind: "secret", namespaceId: namespace.id, id: secret.id },
  };
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
  };
  /** @satisfies {import("@openclaw-enterprise/contracts").AgentRevision} */
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
  };
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
    await unit.agents.createAgent(agent);
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

export function sessionAttempt(revision, overrides = {}) {
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
  };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {import("../../packages/occ/src/state/platform-state.ts").PlatformStateStore} store
 */
export async function verifyRepositorySessions(t, store) {
  await verifyRepositorySessionCases(t, store, {
    seedSessionRevision:
      /** @type {import("./repository-session-state-cases.ts").RepositorySessionCaseBuilders["seedSessionRevision"]} */ (
        seedSessionRevision
      ),
    sessionAttempt,
  });
}
