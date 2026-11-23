import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRevision, SandboxDriver } from "../../packages/contracts/src/index.ts";
import { PostgresPlatformState, type ClaimedWork } from "../../packages/occ/src/index.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { RepositoryCredentialLifecycle } from "../../apps/controller/src/worker/repository-credentials.ts";
import { routedOptions } from "../helpers/kubernetes-routed-scenarios.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";

test("Missing Sandbox repository capability refuses delivery before Worker session lookup, preparation and release", async () => {
  const sandboxDriver = {
    id: "selected-sandbox",
    implementation: "registered-sandbox-without-repository-access",
    capability: "sandbox",
    facets: ["networking"],
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    cleanup: () => assert.fail("unexpected Sandbox cleanup"),
  } satisfies SandboxDriver;
  const compute = new KubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      network: {
        repositoryCredentials: {
          namespace: "credential-service",
          podLabels: { app: "credential-service" },
          port: 8443,
        },
      },
    }),
    {
      sandboxDriver,
      preparedRepositoryIngress: true,
    },
  );
  const refusal = { code: "SANDBOX_REPOSITORY_RECIPIENT_UNVERIFIED" };
  assert.throws(() => compute.validateRepositoryCredentialSupport(sandboxDriver.id), refusal);
  const driver = { id: "repository", implementation: "github" };
  const binding = {
    repositoryRef: "project",
    profile: "git-write",
    backendId: "github-primary",
    grant: { providerInstanceId: "github", repositoryId: "42", grantId: "write-project" },
  };
  const revision: AgentRevision = {
    id: "revision-repository",
    namespaceId: "ns-repository",
    agentId: "agent-repository",
    revision: 1,
    backendId: null,
    configurationId: "configuration-repository",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {},
    gatewayManagedMode: true,
    compute: { id: compute.id, implementation: compute.implementation },
    harnessAuth: { method: "runtime" },
    servicePrincipalId: "service-principal-repository",
    createdAt: "2026-08-18T00:00:00.000Z",
    executionAdmission: { version: 2, mode: "unprotected" },
    sandboxDriverId: sandboxDriver.id,
    harness: { id: "codex", mode: "dedicated", version: "1", overrides: {}, configuration: {} },
    repositoryCredentials: { driver, bindings: [binding], deadlineWallMs: Date.now() + 600_000 },
  };
  // Exercise the real lifecycle ordering, including an already admitted revision.
  // Public grant resolution is allowed; any session lookup or broker effect fails the test.
  const state = new PostgresPlatformState({
    connect: () => assert.fail("unexpected database connection"),
    end: () => assert.fail("unexpected database shutdown"),
  });
  state.read = () => assert.fail("unexpected repository session lookup");
  state.transactWithQueue = () => assert.fail("unexpected repository session transaction");
  const lifecycle = new RepositoryCredentialLifecycle({
    repository: {
      kind: "registered",
      policy: {
        ...driver,
        capability: "repo",
        listOptions: () => assert.fail("unexpected Repository options lookup"),
        resolve: () => ({ bindings: [binding], sessionDurationSeconds: 600 }),
      },
    },
    authorize: async (_claim, { harness, sandboxDriverId }) => {
      compute.validateRepositoryCredentials(harness, sandboxDriverId);
    },
    state,
    queueOptions: {},
    effect: () => assert.fail("unexpected repository broker effect"),
  });
  const now = new Date();
  const claim: ClaimedWork = {
    kind: "lifecycle",
    idempotencyKey: "repository-work",
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
    actorId: "fixture-actor",
    state: "claimed",
    claimToken: "fixture-claim",
    leaseExpiresAt: new Date(now.getTime() + 600_000),
    availableAt: now,
    createdAt: now,
    updatedAt: now,
    attemptCount: 1,
    ageMs: 0,
  };
  await assert.rejects(lifecycle.prepare(claim, revision), refusal);
});
