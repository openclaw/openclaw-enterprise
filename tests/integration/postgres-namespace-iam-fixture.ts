import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  Agent,
  AuditEvent,
  HarnessAuthBinding,
  Installation,
  Namespace,
  ResourceRef,
  Secret,
} from "../../packages/contracts/src/index.ts";
import {
  createAuthPrincipalSeed,
  createBootstrapAdministratorSeed,
} from "../../packages/iam/src/index.ts";
import {
  PersistedStateInvalidError,
  type PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import type { ConfigurationOwnership } from "../../packages/occ/src/state/platform-state.ts";

export function identifier(kind: string) {
  return `${kind}_${randomUUID()}`;
}

export function auditEvent(
  installationId: string,
  namespaceId: string,
  actorId: string,
  action: AuditEvent["action"],
  resource: ResourceRef,
): AuditEvent {
  return {
    id: identifier("aud"),
    installationId,
    namespaceId,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId,
    source: "occ",
    action,
    resource,
    outcome: "success",
  };
}

export async function createNamespaceAgentState(
  state: PostgresPlatformState,
  options: { harnessAuth?: HarnessAuthBinding } = {},
) {
  const createdAt = new Date().toISOString();
  const installation: Installation = (await state.loadInstallation()) ?? {
    id: identifier("ins"),
    name: `Namespace IAM ${randomUUID()}`,
    createdAt,
  };
  const namespace: Namespace = {
    id: identifier("ns"),
    name: `namespace-iam-${randomUUID()}`,
    status: "ready",
    createdAt,
  };
  const secret: Secret = {
    id: identifier("sec"),
    namespaceId: namespace.id,
    name: `Model secret ${randomUUID()}`,
    driverId: "secret-postgres-namespace-iam",
    backendRef: {
      namespaceName: "namespace-iam",
      name: "model-secret",
      key: "value",
      uid: randomUUID(),
    },
    createdAt,
  };
  const configuration: ConfigurationOwnership = {
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt,
  };
  const agent: Agent = {
    id: identifier("agt"),
    namespaceId: namespace.id,
    name: `Agent ${randomUUID()}`,
    configurationId: configuration.id,
    backendId: null,
    harnessAuth: options.harnessAuth ?? null,
    executionMode: "embedded",
    gatewayManagedMode: true,
    servicePrincipalId: `service-agent-${randomUUID()}`,
    desiredRuntimeState: "stopped",
    status: "active",
    createdAt,
  };

  await state.transact(async (unit) => {
    if ((await unit.installations.getInstallation()) === undefined) {
      await unit.installations.createInstallation(installation);
    }
    await unit.namespaces.createNamespace(namespace);
    await unit.secrets.createSecret(secret);
    await unit.configurations.createConfiguration(configuration);
    await unit.agents.createAgent(agent);
  });
  try {
    await state.loadNativeIAMState(installation.id);
  } catch (error) {
    if (
      !(error instanceof PersistedStateInvalidError) ||
      error.message !== "Persisted native IAM state is incomplete."
    ) {
      throw error;
    }
    const seed = createBootstrapAdministratorSeed(installation.id, "https://identity.example.com", {
      id: `postgres-namespace-iam-${randomUUID()}`,
    });
    await state.seedNativeIAM({
      identities: [seed.principal, seed.servicePrincipal],
      groups: [],
      memberships: [],
      roles: seed.roles,
      bindings: seed.bindings,
      restrictions: [],
    });
  }

  return { installation, namespace, secret, configuration, agent };
}

export async function createNamespaceServicePrincipal(
  state: PostgresPlatformState,
  namespaceId: string,
) {
  const identityId = `service-principal-${randomUUID()}`;
  await state.transact(async (unit) => {
    // Seed an existing Namespace-local service identity that is not owned by an Agent.
    await state.queryInTransaction(
      unit,
      `INSERT INTO occ.iam_identities (id, kind, namespace_id, agent_id)
       VALUES ($1, 'service_principal', $2, NULL)`,
      [identityId, namespaceId],
    );
  });
  return identityId;
}

export async function createHumanPrincipal(state: PostgresPlatformState, installationId: string) {
  // Enroll through the zero-grant auth account seed: a real Installation-scoped
  // Principal with no Namespace service identity, Role, or binding.
  const seed = createAuthPrincipalSeed(
    installationId,
    "https://identity.example.com",
    { id: randomUUID() },
    { grant: "none" },
  );
  assert.deepEqual(seed.roles, []);
  assert.deepEqual(seed.bindings, []);
  await state.appendNativeIAMPrincipal(seed);
  return seed.principal;
}

export function isLockTimeout(error: unknown): boolean {
  return (
    (typeof error === "object" && error !== null && "code" in error && error.code === "55P03") ||
    (error instanceof Error && /lock timeout/.test(error.message))
  );
}
