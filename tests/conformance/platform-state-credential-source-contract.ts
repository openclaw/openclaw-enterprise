import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  Agent,
  LegacyCredentialSource,
  Namespace,
  Secret,
  StaticCredentialSource,
} from "@openclaw-enterprise/contracts";
import type { PlatformStateStore } from "../../packages/occ/src/index.ts";
import {
  identifier,
  postgresOwnershipViolation,
  storeRefusal,
  type PlatformStateSeed,
} from "./platform-state-contract-fixture.ts";

export async function verifyCredentialSourceContract(
  store: PlatformStateStore,
  {
    installation,
    namespace: otherNamespace,
  }: Pick<PlatformStateSeed, "installation" | "namespace">,
  credentialServiceInstanceId: string,
): Promise<void> {
  const namespace = {
    id: identifier("ns"),
    name: `Credential source contract ${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  } satisfies Namespace;
  const configurationId = identifier("cfg");

  const source = await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(namespace);
    await transaction.configurations.createConfiguration({
      id: configurationId,
      namespaceId: namespace.id,
      kind: "agent",
      generation: 1,
      createdAt: namespace.createdAt,
    });
    assert.equal(await transaction.namespaces.hasCredentialSources(namespace.id), false);
    const ready = {
      id: identifier("cs"),
      namespaceId: namespace.id,
      name: `Owned CredentialService Source ${randomUUID()}`,
      type: "static",
      ownerCapability: "credential_service",
      credentialServiceInstanceId,
      state: "ready",
      config: { provider_preset: "openai" },
      createdAt: namespace.createdAt,
    } satisfies StaticCredentialSource;
    assert.deepEqual(await transaction.credentialSources.createCredentialSource(ready), ready);
    assert.deepEqual(
      await transaction.credentialSources.lockCredentialSource(namespace.id, ready.id),
      ready,
    );
    return ready;
  });
  await store.read(async (state) => {
    assert.deepEqual(await state.credentialSources.listCredentialSources(namespace.id), [source]);
    assert.equal(
      await state.credentialSources.findCredentialSource(otherNamespace.id, source.id),
      undefined,
    );
  });

  const agent = {
    id: identifier("agt"),
    namespaceId: namespace.id,
    name: `Source consumer ${randomUUID()}`,
    configurationId,
    backendId: null,
    executionMode: "dedicated",
    gatewayManagedMode: true,
    sandboxPolicyEditing: false,
    servicePrincipalId: identifier("service-agent"),
    harnessAuth: { method: "runtime" },
    credentialSources: [{ sourceId: source.id }],
    desiredRuntimeState: "stopped",
    status: "active",
    createdAt: namespace.createdAt,
  } satisfies Agent;
  await store.transact(async (transaction) => {
    await transaction.agents.createAgent(agent);
    assert.equal(await transaction.credentialSources.hasReferences(namespace.id, source.id), true);
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.credentialSources.deleteCredentialSource(namespace.id, source.id),
    ),
    {
      name: "ScopeViolationError",
      message: "The credential source is referenced by active platform state.",
    },
  );
  await store.transact(async (transaction) => {
    await transaction.agents.updateConfiguration(
      namespace.id,
      agent.id,
      agent.configurationId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    assert.equal(await transaction.credentialSources.hasReferences(namespace.id, source.id), false);
    // After the draft detaches, a retiring Source still blocks Namespace teardown.
    assert.deepEqual(
      await transaction.credentialSources.markCredentialSourceDeleting(namespace.id, source.id),
      {
        ...source,
        state: "deleting",
      },
    );
    assert.equal(
      await transaction.credentialSources.markCredentialSourceDeleting(namespace.id, source.id),
      undefined,
    );
    assert.equal(await transaction.namespaces.hasCredentialSources(namespace.id), true);
  });
  await assert.rejects(
    store.transact((transaction) =>
      transaction.agents.createAgent({
        ...agent,
        id: identifier("agt"),
        name: `New consumer ${randomUUID()}`,
        servicePrincipalId: identifier("service-agent"),
        harnessAuth: { method: "credential_source", sourceId: source.id },
      }),
    ),
    {
      name: "ScopeViolationError",
      message: "The Agent harness authentication references an unavailable credential source.",
    },
  );
  await store.transact(async (transaction) => {
    assert.equal(
      await transaction.credentialSources.deleteCredentialSource(namespace.id, source.id),
      true,
    );
    assert.equal(
      await transaction.credentialSources.deleteCredentialSource(namespace.id, source.id),
      false,
    );
    assert.equal(await transaction.namespaces.hasCredentialSources(namespace.id), false);
  });

  await verifyProtectedSourceSecretOwnership(store, installation.id, namespace);
}

async function verifyProtectedSourceSecretOwnership(
  store: PlatformStateStore,
  installationId: string,
  namespace: Pick<Namespace, "id" | "createdAt">,
): Promise<void> {
  const secret = {
    id: identifier("sec"),
    namespaceId: namespace.id,
    name: `Protected Source input ${randomUUID()}`,
    driverId: "protected-source-secret",
    backendRef: {
      namespaceName: "protected",
      name: "source-input",
      key: "value",
      uid: randomUUID(),
    },
    createdAt: namespace.createdAt,
  } satisfies Secret;
  const secretRef = { kind: "secret", namespaceId: namespace.id, id: secret.id } as const;
  const sourceId = identifier("cs");
  const proxy = {
    id: sourceId,
    namespaceId: namespace.id,
    name: `Protected Proxy Source ${randomUUID()}`,
    type: "bearer-token",
    ownerCapability: "credential_proxy",
    driverId: "protected-source-provider",
    config: {},
    secrets: { token: secretRef },
    egress: {
      key: {
        installationId,
        namespaceId: namespace.id,
        source: { id: sourceId, generation: 1 },
        backend: { id: "protected-source-backend", generation: 1 },
        provider: { id: "protected-source-provider", generation: 1 },
      },
      schemaVersion: 1,
      adoption: "live",
      retention: "none",
      materialRefId: "protected-source-material",
      secret: secretRef,
      secretDriver: { id: secret.driverId, generation: 1 },
      sender: { id: "protected-source-sender", generation: 1 },
      resolver: { id: "protected-source-resolver", generation: 1 },
    },
    state: "ready",
    createdAt: namespace.createdAt,
  } satisfies LegacyCredentialSource;

  await store.transact(async (transaction) => {
    await transaction.secrets.createSecret(secret);
    assert.deepEqual(await transaction.credentialSources.createCredentialSource(proxy), proxy);
  });
  await assert.rejects(
    store.transact((transaction) => transaction.secrets.deleteSecret(namespace.id, secret.id)),
    storeRefusal(
      "ScopeViolationError",
      "The Secret is referenced by active platform state.",
      postgresOwnershipViolation,
    ),
    "A selected protected Proxy Source retains its exact Secret input.",
  );
}
