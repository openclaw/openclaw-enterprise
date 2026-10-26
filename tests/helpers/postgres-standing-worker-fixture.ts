import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import {
  CREDENTIAL_GATEWAY_FIXTURE_ID,
  createWorkerRevisionFixtures,
} from "./postgres-worker-revision-fixture.mjs";
import { databaseUrl } from "./postgres-database.mjs";
import { ensurePostgresAgentBootstrap } from "./postgres-agent-app.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";
import { GitHubNativeRepositorySender } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import type { CredentialGatewayDriver } from "../../packages/contracts/src/index.ts";
import type { ControllerWorker } from "../../apps/controller/src/worker.ts";
import type { Pool } from "pg";
import { repositoryApprovalFingerprint } from "../../packages/occ/src/index.ts";

// The worker reaches model withdrawal through Compute. This registration supplies only
// the paired gateway identity; the test does not claim real provider attachment or chat.
export function observationGateway(): CredentialGatewayDriver {
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected direct gateway effect");
  };
  return {
    id: CREDENTIAL_GATEWAY_FIXTURE_ID,
    implementation: "credential-gateway-worker-fixture",
    capability: "credential_gateway",
    validateSourceConfig() {},
    listSourceTypes: async () => [],
    registerSource: unused,
    updateSource: unused,
    sourceStatus: unused,
    removeSource: unused,
    attachForRevision: unused,
    attachmentStatus: unused,
    withdraw: unused,
  };
}

export async function setupStandingWorkerDatabase(
  t: TestContext,
  sourceUrl: string,
  options: { maxAttempts?: number } = {},
) {
  await ensurePostgresAgentBootstrap(t, {
    label: "standing-worker-missing",
    authSecret: "standing-worker-fixture-auth-secret-32",
  });
  const database = {
    url: databaseUrl!,
    pools: new Set<Pool>(),
    workers: new Set<ControllerWorker>(),
  };
  // Close database pools after broker shutdown has persisted its final receipts.
  t.after(() =>
    t.after(async () => {
      for (const worker of database.workers) {
        await worker.stop();
      }
      for (const pool of database.pools) {
        if (!("ending" in pool && pool.ending)) {
          await pool.end();
        }
      }
    }),
  );
  const setupOptions = { database, leaseDurationMs: 30_000, ...options };
  const f = await createWorkerRevisionFixtures(sourceUrl).setup(t, setupOptions);
  return { ...f, workers: database.workers };
}

export async function setupStandingWorkerAuthority(
  t: TestContext,
  f: Awaited<ReturnType<typeof setupStandingWorkerDatabase>>,
  options: { nonModelSources?: number } = {},
) {
  const credentials = await startRegistryCredentialServiceFixture(t, {
    namespaceId: f.namespace.id,
    autoOpen: false,
    clock: createSystemClock(),
    limits: { exchangeMs: 5_000, credentialMarginMs: 1_000 },
    gateway: { listen: "127.0.0.1:0" },
  });
  assert.ok(credentials);
  const registry = structuredClone(credentials.registry);
  registry.allowStandingApprovals = true;
  for (const r of registry.repositories) {
    for (const p of r.namespaces) {
      p.allowStandingApproval = true;
    }
  }
  const backend = {
    id: credentials.backendId,
    client: new UnixRepositoryCredentialControlClient({
      controlSocket: credentials.config.gateway.controlSocket,
    }),
    drivers: { repo: "repository-credentials" },
  };
  const driver = new GitHubRepositoryPolicy(backend, registry, { sessionDurationSeconds: 90 });
  const sender = new GitHubNativeRepositorySender(backend, { publicCa: credentials.tls.ca });
  const receipt = await startRepositoryReceiptServer({
    state: f.state,
    controlSocket: credentials.config.gateway.controlSocket,
    driverId: driver.id,
    implementation: driver.implementation,
    backendId: credentials.backendId,
  });
  t.after(() => receipt.close());
  const owner = await f.agent("standing-runtime", { auth: "credential_source", ...options });
  const modelSourceId =
    owner.harnessAuth?.method === "credential_source" ? owner.harnessAuth.sourceId : undefined;
  const [selected] = driver.resolve({
    namespaceId: f.namespace.id,
    bindings: [{ repositoryRef: "repo-a", profile: "git-write" }],
  }).bindings;
  const binding = selected!;
  await f.observerPool.query("UPDATE occ.agents SET repository_bindings=$1 WHERE id=$2", [
    JSON.stringify([{ repositoryRef: binding.repositoryRef, profile: binding.profile }]),
    owner.id,
  ]);
  const scope = driver.standingApprovalScope({ namespaceId: f.namespace.id, binding })!;
  const fingerprint = repositoryApprovalFingerprint({
    namespaceId: f.namespace.id,
    agentId: owner.id,
    binding,
    scope,
  });
  const approval = await f.state.transact((u) =>
    u.repositorySessions.approveStanding({
      id: randomUUID(),
      namespaceId: f.namespace.id,
      agentId: owner.id,
      binding,
      scope,
      scopeFingerprint: fingerprint,
      approvedBy: f.actor.id,
      createdAt: new Date().toISOString(),
    }),
  );
  const originalBoundary = Date.now() + 90_000;
  const revisionOptions = {
    actorId: f.actor.id,
    repositoryCredentials: {
      driver: { id: driver.id, implementation: driver.implementation },
      bindings: [binding],
      deadlineWallMs: originalBoundary,
      standingApprovalId: approval.id,
      standingApprovalGeneration: approval.generation,
      standingApprovalScopeFingerprint: fingerprint,
    },
  };
  const revision = await f.revision(owner, 1, revisionOptions);
  const execution = {
    executionId: randomUUID(),
    fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
  };
  return {
    credentials,
    driver,
    sender,
    owner,
    modelSourceId,
    approval,
    revision,
    revisionOptions,
    execution,
  };
}
