import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  SOURCE_PROVIDER_PRESET_CONFIG_KEY,
  type AgentRevision,
  type RepositoryRevisionState,
} from "../../packages/contracts/src/index.ts";
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

async function readySource(
  transaction: PlatformUnitOfWork,
  seed: PlatformStateSeed,
  tokenServiceInstanceId: string,
): Promise<string> {
  const sourceId = identifier("cs");
  const createdAt = new Date().toISOString();
  await transaction.credentialSources.createCredentialSource({
    id: sourceId,
    namespaceId: seed.namespace.id,
    name: `Standalone model source ${randomUUID()}`,
    type: "static",
    config: { [SOURCE_PROVIDER_PRESET_CONFIG_KEY]: "openai" },
    secrets: {},
    ownerCapability: "token_service",
    tokenServiceInstanceId,
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
  return sourceId;
}

async function standaloneRevision(
  transaction: PlatformUnitOfWork,
  seed: PlatformStateSeed,
  options: { repository?: RepositoryRevisionState; extraSource?: boolean } = {},
): Promise<AgentRevision> {
  const { repository } = options;
  const instance = await transaction.installations.selectTokenServiceInstance({
    id: randomUUID(),
    driverId: "token-service-contract",
    storeIdentity: "standalone-state-contract",
  });
  const sourceId = await readySource(transaction, seed, instance.id);
  const sourceIds = [sourceId];
  if (options.extraSource) {
    sourceIds.push(await readySource(transaction, seed, instance.id));
  }
  const agent = {
    ...seed.agent,
    id: identifier("agt"),
    name: `Standalone credential Agent ${randomUUID()}`,
    executionMode: "dedicated" as const,
    servicePrincipalId: identifier("service-agent"),
    harnessAuth: { method: "credential_source" as const, sourceId },
    credentialSources: sourceIds.map((id) => ({ sourceId: id })),
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
    host: "api.openai.com",
    ports: [{ from: 443, to: 443 }],
    requestPolicy: { type: "http" as const, method: "POST", path: "/v1/responses" },
  };
  return {
    ...seed.revision,
    id: identifier("rev"),
    agentId: agent.id,
    servicePrincipalId: agent.servicePrincipalId,
    executionAdmission: { version: 8, mode: "standalone" },
    configuration: {
      ...seed.revision.configuration,
      models: {
        providers: { openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" } },
      },
    },
    harness: {
      ...seed.revision.harness,
      mode: "dedicated",
      configuration: {
        modelProvider: { protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      },
    },
    sandboxDriverId: "sandbox-contract",
    harnessAuth: {
      ...agent.harnessAuth,
      sourceType: "static",
      tokenServiceInstanceId: instance.id,
    },
    credentialSources: sourceIds.map((id) => ({
      sourceId: id,
      sourceType: "static",
      tokenServiceInstanceId: instance.id,
    })),
    credentialDeployment: {
      driver: {
        id: "sandbox-contract",
        implementation: "openshell",
        configurationId: "a".repeat(64),
      },
      proxyDriverId: "proxy-contract",
      networkAccessPolicy: {
        allowed: [{ binary: request.binary, host: request.host, ports: request.ports }],
      },
      bindings: [
        {
          bindingRef: "model",
          sourceRef: { kind: "credential_source", namespaceId: seed.namespace.id, id: sourceId },
          consumer: { kind: "model", providerId: "openai" },
          projection: { environment: "OPENAI_API_KEY", presentation: "bearer" },
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
  // This controlled State-boundary control admits a realistic frozen model policy; it does not qualify a runtime.
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
  // The Worker cannot dispatch standalone delivery without the admitted Sandbox identity.
  await assert.rejects(
    store.transact(async (transaction) => {
      const revision = await standaloneRevision(transaction, seed);
      Reflect.deleteProperty(revision, "sandboxDriverId");
      await transaction.revisions.createRevision(revision);
    }),
    refusal,
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
            { bindingRef: "plugin", allowedRequests: policy.injectionPolicies[0]!.allowedRequests },
          ],
        },
      });
    }),
    refusal,
  );
  // The Agent may own both ready sources, but standalone v8 admits only its model source.
  await assert.rejects(
    store.transact(async (transaction) => {
      const revision = await standaloneRevision(transaction, seed, { extraSource: true });
      await transaction.revisions.createRevision(revision);
    }),
    refusal,
  );
  // A valid repository draft and snapshot still cannot share standalone model delivery.
  await assert.rejects(
    store.transact(async (transaction) => {
      const revision = await standaloneRevision(transaction, seed, {
        repository: repositoryCredentials(),
      });
      await transaction.revisions.createRevision(revision);
    }),
    refusal,
  );
}
