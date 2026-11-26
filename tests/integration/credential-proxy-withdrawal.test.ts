import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { EgressRoute } from "../../packages/contracts/src/index.ts";

// The admission and successor validators must independently reject authority expansion.
// This protects recovery from a forged or stale stored policy, not just the happy-path reducer.
test("Git reduction v7 preserves earlier admission meanings and rejects widening", async () => {
  const { assertExecutionAdmission } = await import("../../packages/contracts/src/index.ts");
  const { isReducedCredentialPlan } = await import("../../packages/occ/src/index.ts");
  const execution = {
    installationId: "ins_" + randomUUID(),
    namespaceId: "ns_" + randomUUID(),
    agentId: "agt_" + randomUUID(),
    servicePrincipalId: "sp_" + randomUUID(),
    revisionId: "rev_" + randomUUID(),
    executionId: randomUUID(),
  };
  const reference = { id: "controlled-driver", generation: 1 };
  const route: EgressRoute = {
    route: { id: "independent", generation: 1 },
    origin: "https://127.0.0.1:8443",
    path: "/repos/example/independent",
    method: "GET",
    deadlineMs: 5000,
    operationPolicy: reference,
    responsePolicy: reference,
    binding: {
      binding: reference,
      execution,
      isolationId: execution.agentId,
      source: {
        installationId: execution.installationId,
        namespaceId: execution.namespaceId,
        source: { id: "cs_" + randomUUID(), generation: 1 },
        backend: reference,
        provider: reference,
      },
      grant: {
        kind: "credential_free_repository_metadata",
        profile: "metadata-read",
        isolationId: execution.agentId,
        repository: "example/independent",
        repositoryId: "99",
      },
      grantHash: "a".repeat(64),
    },
  };
  const plan: import("../../packages/contracts/src/index.ts").ProxyPlan = {
    id: randomUUID(),
    generation: 1,
    execution,
    sandboxDriverId: reference.id,
    egressDriverId: reference.id,
    driver: { id: reference.id, implementation: "controlled", configurationId: "a".repeat(64) },
    policyReductionVersion: 2,
    repositoryGit: {
      driver: { id: "repo", implementation: "github" },
      deadlineWallMs: Date.now() + 60000,
      bindings: [
        {
          backendId: "repo",
          repositoryRef: "installation",
          profile: "github-installation",
          grant: { providerInstanceId: "provider", repositoryId: "installation", grantId: "grant" },
        },
      ],
    },
    routes: [route],
  };
  assert.doesNotThrow(() =>
    assertExecutionAdmission({
      executionAdmission: { version: 7, mode: "protected" },
      egressPlan: plan,
    }),
  );
  for (const version of [3, 4, 5, 6] as const) {
    assert.throws(
      () =>
        assertExecutionAdmission({
          executionAdmission: { version, mode: "protected" },
          egressPlan: plan,
        }),
      /admitted policy reduction capability/,
    );
  }
  const { repositoryGit, policyReductionVersion, ...ordinary } = plan;
  assert.ok(repositoryGit && policyReductionVersion);
  const reduced = { ...ordinary, policyReductionVersion, generation: 2 };
  assert.equal(isReducedCredentialPlan(plan, reduced), true);
  assert.deepEqual(
    reduced.routes,
    [route],
    "removing Git preserves the independent binding exactly",
  );
  assert.equal(
    isReducedCredentialPlan(plan, {
      ...reduced,
      routes: [{ ...route, path: "/repos/example/another" }],
    }),
    false,
  );
  assert.equal(isReducedCredentialPlan(plan, { ...reduced, routes: [route, route] }), false);
  assert.equal(
    isReducedCredentialPlan(plan, {
      ...reduced,
      execution: { ...execution, executionId: randomUUID() },
    }),
    false,
  );
  assert.equal(isReducedCredentialPlan(plan, { ...reduced, generation: 1 }), false);
  assert.equal(
    isReducedCredentialPlan(reduced, { ...reduced, generation: 3, repositoryGit }),
    false,
    "withdrawn Git cannot be restored",
  );
  assert.equal(
    isReducedCredentialPlan(reduced, { ...reduced, generation: 3, routes: [] }),
    true,
    "last binding reduces to deny-all",
  );
  const legacy = { ...plan, policyReductionVersion: 1 as const };
  assert.equal(
    isReducedCredentialPlan(legacy, { ...reduced, policyReductionVersion: 1 }),
    false,
    "v1 does not acquire Git removal semantics",
  );
  for (const version of [4, 5, 6] as const) {
    const legacyPlan = {
      ...ordinary,
      repositoryGit,
      routes: [],
      ...(version === 5 ? { repositoryGitAuthorization: "online-request" as const } : {}),
      ...(version === 6 ? { repositoryGitAuthorization: "request-hook-observed" as const } : {}),
    };
    assert.doesNotThrow(() =>
      assertExecutionAdmission({
        executionAdmission: { version, mode: "protected" },
        egressPlan: legacyPlan,
      }),
    );
    assert.throws(
      () =>
        assertExecutionAdmission({
          executionAdmission: { version, mode: "protected" },
          egressPlan: { ...legacyPlan, policyReductionVersion: 2 },
        }),
      /admitted policy reduction capability/,
    );
  }
});
