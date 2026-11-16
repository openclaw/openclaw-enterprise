import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentRevision,
  AuditEvent,
  HarnessAuthBinding,
  Installation,
  Namespace,
  Secret,
} from "@openclaw-enterprise/contracts";
import type {
  PlatformOperation,
  PlatformStateStore,
  PlatformUnitOfWork,
} from "../../packages/occ/src/index.ts";

export function identifier(kind: string): string {
  return `${kind}_${randomUUID()}`;
}

export function event(
  installation: Pick<Installation, "id">,
  namespace: Pick<Namespace, "id">,
  agent: Pick<Agent, "id">,
  action: string,
): AuditEvent {
  return {
    id: identifier("aud"),
    installationId: installation.id,
    namespaceId: namespace.id,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId: "principal-platform-state-contract",
    action,
    resource: {
      kind: "agent",
      id: agent.id,
      namespaceId: namespace.id,
    },
    outcome: "success",
  };
}

// A database-backed store stamps a revision's admission time on its own clock, the one that
// stamps controller work (finding 1195), so a created revision equals its input except for
// createdAt. The input adopts the stored stamp, so later reads compare against the record.
export function assertCreatedRevision(
  created: Readonly<AgentRevision>,
  input: { createdAt: string },
): void {
  assert.ok(Number.isFinite(Date.parse(created.createdAt)), "createdAt is a timestamp");
  assert.deepEqual({ ...created, createdAt: input.createdAt }, input);
  input.createdAt = created.createdAt;
}

// Both stores raise the same error class for these refusals but word them differently. The
// memory store names the refusing check. PostgreSQL either enforces it with a constraint or
// trigger whose violation databaseError maps to one generic message without a cause, or refuses
// it in a broader application check (controller work shape, revision harness authentication).
export function storeRefusal(
  name: string,
  memoryMessage: string,
  postgresMessage: string,
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    error.name === name &&
    (error.message === memoryMessage || error.message === postgresMessage);
}
export const postgresOwnershipViolation =
  "The resource violates its exact platform ownership or state.";
export const postgresIdentityConflict =
  "A platform resource with this identity or name already exists.";

export async function seedPlatformState(
  store: PlatformStateStore,
  existingInstallation?: Readonly<Installation>,
) {
  const installation = existingInstallation ?? {
    id: identifier("ins"),
    name: `Platform state ${randomUUID()}`,
    createdAt: new Date().toISOString(),
  };
  const namespace = {
    id: identifier("ns"),
    name: `Namespace ${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  } satisfies Namespace;
  const configuration = {
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  } satisfies Parameters<PlatformUnitOfWork["configurations"]["createConfiguration"]>[0];
  const harnessSecret = {
    id: identifier("sec"),
    namespaceId: namespace.id,
    name: "Harness key " + randomUUID(),
    driverId: "secret-contract",
    backendRef: { namespaceName: "contract", name: "harness-key", key: "value", uid: randomUUID() },
    createdAt: new Date().toISOString(),
  } satisfies Secret;
  const apiKeyBinding = {
    method: "api_key",
    source: { kind: "secret", namespaceId: namespace.id, id: harnessSecret.id },
  } satisfies Extract<HarnessAuthBinding, { method: "api_key" }>;
  const agent = {
    id: identifier("agt"),
    namespaceId: namespace.id,
    name: `Agent ${randomUUID()}`,
    configurationId: configuration.id,
    backendId: null,
    harnessAuth: apiKeyBinding,
    executionMode: "embedded",
    gatewayManagedMode: true,
    sandboxPolicyEditing: false,
    servicePrincipalId: identifier("service-agent"),
    desiredRuntimeState: "stopped",
    // Both adapters force a created Agent to `active` rather than honoring a
    // caller-supplied status, so a seeded Agent must carry the same value.
    status: "active",
    createdAt: new Date().toISOString(),
  } satisfies Agent;
  const revision = {
    id: identifier("rev"),
    namespaceId: namespace.id,
    agentId: agent.id,
    revision: 1,
    gatewayManagedMode: true,
    backendId: null,
    configurationId: configuration.id,
    configurationKind: configuration.kind,
    configurationGeneration: configuration.generation,
    configuration: {
      models: {
        providers: {
          openai: { baseUrl: "https://api.openai.com/v1" },
        },
      },
      agents: { defaults: { model: "openai/gpt-5", maxConcurrent: 2 } },
      gateway: { controlUi: { enabled: false } },
    },
    harnessAuth: { ...apiKeyBinding, secretDriverId: harnessSecret.driverId },
    harness: {
      id: "openclaw",
      version: "1.0.0",
      mode: "embedded",
      overrides: {},
      configuration: {},
    },
    compute: {
      id: "compute-contract",
      implementation: "deterministic-contract",
      admission: `driver-state:v1:${"a".repeat(64)}`,
    },
    executionAdmission: { version: 2, mode: "unprotected" },
    servicePrincipalId: agent.servicePrincipalId,
    createdAt: new Date().toISOString(),
  } satisfies AgentRevision;
  const audit = event(installation, namespace, agent, "deploy");
  const operation = {
    kind: "agent_revision",
    action: "reconcile",
    namespaceId: namespace.id,
    resourceId: revision.id,
    actorId: audit.actorId,
  } satisfies Extract<PlatformOperation, { kind: "agent_revision" }>;

  await store.transact(async (transaction) => {
    if (existingInstallation === undefined) {
      assert.deepEqual(
        await transaction.installations.createInstallation(installation),
        installation,
      );
    }
    assert.deepEqual(await transaction.namespaces.createNamespace(namespace), namespace);
    assert.equal(await transaction.namespaces.hasConfigurations(namespace.id), false);
    assert.deepEqual(
      await transaction.configurations.createConfiguration(configuration),
      configuration,
    );
    assert.equal(await transaction.namespaces.hasConfigurations(namespace.id), true);
    assert.deepEqual(await transaction.namespaces.listConfigurationIds(namespace.id), [
      configuration.id,
    ]);
    await transaction.secrets.createSecret(harnessSecret);
    // Creation defaults editing to disabled; reloads must preserve the same Agent shape.
    const { sandboxPolicyEditing: _editing, ...agentWithoutEditing } = agent;
    assert.deepEqual(await transaction.agents.createAgent(agentWithoutEditing), agent);
    assert.equal(await transaction.namespaces.hasAgents(namespace.id), true);
    assertCreatedRevision(await transaction.revisions.createRevision(revision), revision);
    await transaction.audit.append(audit);
    await transaction.operations.append(operation);
  });

  return {
    installation,
    namespace,
    configuration,
    harnessSecret,
    agent,
    revision,
    audit,
    operation,
  };
}

export type PlatformStateSeed = Awaited<ReturnType<typeof seedPlatformState>>;
