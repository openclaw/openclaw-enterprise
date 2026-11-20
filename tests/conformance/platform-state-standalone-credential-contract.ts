import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgentRevision, RepositoryRevisionState } from "@openclaw-enterprise/contracts";
import type {
  PlatformUnitOfWork,
  PlatformStateStore,
} from "../../packages/occ/src/state/platform-state.ts";
import { repositoryCredentials } from "../fixtures/repository-credentials/session-state.ts";
import {
  assertCreatedRevision,
  identifier,
  postgresOwnershipViolation,
  storeRefusal,
  type PlatformStateSeed,
} from "./platform-state-contract-fixture.ts";

async function standaloneRevision(
  transaction: PlatformUnitOfWork,
  seed: PlatformStateSeed,
  repository?: RepositoryRevisionState,
): Promise<AgentRevision> {
  const instance = await transaction.installations.selectTokenServiceInstance({
    id: randomUUID(),
    driverId: "token-service-contract",
    storeIdentity: "standalone-state-contract",
  });
  const sourceId = identifier("cs");
  const createdAt = new Date().toISOString();
  await transaction.credentialSources.createCredentialSource({
    id: sourceId,
    namespaceId: seed.namespace.id,
    name: `Standalone model source ${randomUUID()}`,
    type: "static",
    config: {},
    secrets: {},
    ownerCapability: "token_service",
    tokenServiceInstanceId: instance.id,
    state: "registering",
    createdAt,
  });
  assert.equal(
    await transaction.credentialSources.setCredentialSourceRegistrationDispatch(
      seed.namespace.id,
      sourceId,
      createdAt,
    ),
    true,
  );
  assert.ok(
    await transaction.credentialSources.markCredentialSourceReady(seed.namespace.id, sourceId, {}),
  );
  const agent = {
    ...seed.agent,
    id: identifier("agt"),
    name: `Standalone credential Agent ${randomUUID()}`,
    executionMode: "dedicated" as const,
    servicePrincipalId: identifier("service-agent"),
    harnessAuth: { method: "credential_source" as const, sourceId },
    credentialSources: [{ sourceId }],
    ...(repository === undefined
      ? {}
      : {
          repositoryBindings: repository.bindings.map(({ repositoryRef, profile }) => ({
            repositoryRef,
            profile,
          })),
        }),
  };
  await transaction.agents.createAgent(agent);
  const request = {
    binary: "/usr/bin/node",
    host: "api.example.test",
    ports: [{ from: 443, to: 443 }],
    requestPolicy: { type: "http" as const, method: "POST", path: "/v1/responses" },
  };
  return {
    ...seed.revision,
    id: identifier("rev"),
    agentId: agent.id,
    servicePrincipalId: agent.servicePrincipalId,
    executionAdmission: { version: 8, mode: "standalone" },
    harness: { ...seed.revision.harness, mode: "dedicated" },
    sandboxDriverId: "sandbox-contract",
    harnessAuth: {
      ...agent.harnessAuth,
      sourceType: "static",
      tokenServiceInstanceId: instance.id,
    },
    credentialSources: [{ sourceId, sourceType: "static", tokenServiceInstanceId: instance.id }],
    credentialDeployment: {
      proxyDriverId: "proxy-contract",
      networkAccessPolicy: { allowed: [request] },
      bindings: [
        {
          bindingRef: "model",
          sourceRef: { kind: "credential_source", namespaceId: seed.namespace.id, id: sourceId },
          consumer: { kind: "model", providerId: "model-provider" },
          projection: { environment: "MODEL_API_KEY", presentation: "bearer" },
        },
      ],
      injectionPolicies: [{ bindingRef: "model", allowedRequests: [request] }],
    },
    ...(repository === undefined ? {} : { repositoryCredentials: repository }),
  };
}

export async function verifyStandaloneCredentialStateContract(
  store: PlatformStateStore,
  seed: PlatformStateSeed,
): Promise<void> {
  // The real State producer must admit the supported one-model shape before negative probes.
  const rollback = new Error("rollback standalone credential contract");
  await assert.rejects(
    store.transact(async (transaction) => {
      const revision = await standaloneRevision(transaction, seed);
      assertCreatedRevision(await transaction.revisions.createRevision(revision), revision);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  const refusal = storeRefusal(
    "ScopeViolationError",
    "An AgentRevision requires valid Configuration metadata, a native document, and pinned Harness and Compute descriptors.",
    postgresOwnershipViolation,
  );
  // A generic policy can describe Plugins, but standalone v8 currently admits only one model.
  await assert.rejects(
    store.transact(async (transaction) => {
      const revision = await standaloneRevision(transaction, seed);
      const policy = revision.credentialDeployment!;
      const pluginBinding = {
        ...policy.bindings[0]!,
        bindingRef: "plugin",
        consumer: {
          kind: "plugin" as const,
          pluginId: "plugin",
          requirement: "api-key",
          connection: "primary",
        },
        projection: { environment: "PLUGIN_API_KEY", presentation: "bearer" as const },
      };
      await transaction.revisions.createRevision({
        ...revision,
        credentialDeployment: {
          ...policy,
          bindings: [...policy.bindings, pluginBinding],
          injectionPolicies: [
            ...policy.injectionPolicies,
            { bindingRef: "plugin", allowedRequests: policy.networkAccessPolicy.allowed },
          ],
        },
      });
    }),
    refusal,
  );
  // A valid repository draft and snapshot still cannot share standalone model delivery.
  await assert.rejects(
    store.transact(async (transaction) => {
      const revision = await standaloneRevision(transaction, seed, repositoryCredentials());
      await transaction.revisions.createRevision(revision);
    }),
    refusal,
  );
}
