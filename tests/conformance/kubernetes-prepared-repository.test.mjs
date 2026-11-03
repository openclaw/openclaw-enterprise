import assert from "node:assert/strict";
import test from "node:test";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { RepositoryCredentialLifecycle } from "../../apps/controller/src/worker/repository-credentials.ts";
import { routedOptions } from "../helpers/kubernetes-routed-scenarios.mjs";

test("Missing Sandbox repository capability refuses delivery before Worker session lookup, preparation and release", async () => {
  const sandboxDriver = {
    id: "selected-sandbox",
    implementation: "registered-sandbox-without-repository-access",
  };
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
  const revision = {
    executionAdmission: { version: 2, mode: "unprotected" },
    sandboxDriverId: sandboxDriver.id,
    harness: { id: "codex", mode: "dedicated", version: "1" },
    repositoryCredentials: { driver, bindings: [binding], deadlineWallMs: Date.now() + 600_000 },
  };
  // Exercise the real lifecycle ordering, including an already admitted revision.
  // Public grant resolution is allowed; any session lookup or broker effect fails the test.
  const lifecycle = new RepositoryCredentialLifecycle({
    driver: {
      ...driver,
      capability: "repo",
      resolve: () => ({ bindings: [binding], sessionDurationSeconds: 600 }),
    },
    authorize: (_claim, { harness, sandboxDriverId }) =>
      compute.validateRepositoryCredentials(harness, sandboxDriverId),
    state: { read: assert.fail, transactWithQueue: assert.fail },
    effect: assert.fail,
  });
  await assert.rejects(lifecycle.prepare({}, revision), refusal);
});
