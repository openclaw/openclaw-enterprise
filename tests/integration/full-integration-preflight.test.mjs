import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSourceRef,
  requiredEnvironmentsForLane,
  selectLane,
  validateEnvironmentPolicy,
  validateFullIntegrationPreflight,
} from "../../scripts/ci/full-integration-preflight.mjs";

function providerEnvironment(patch = {}) {
  return {
    name: "integration-provider-account",
    protection_rules: [],
    deployment_branch_policy: {
      custom_branch_policies: true,
      protected_branches: false,
    },
    ...patch,
  };
}

function protectedEnvironment(patch = {}) {
  return {
    name: "integration-model",
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", reviewer: { login: "reviewer" } }],
      },
    ],
    deployment_branch_policy: {
      custom_branch_policies: false,
      protected_branches: true,
    },
    ...patch,
  };
}

const mainOnlyPolicies = Object.freeze({
  total_count: 1,
  branch_policies: [{ name: "main", type: "branch" }],
});

test("full integration preflight selects only manual workflow lanes", async () => {
  assert.equal(selectLane({ eventName: "workflow_dispatch", inputLane: "all" }), "all");
  assert.equal(
    selectLane({ eventName: "workflow_dispatch", inputLane: "provider-account" }),
    "provider-account",
  );
  assert.throws(
    () => selectLane({ eventName: "push", inputLane: "all" }),
    /^Error: Unsupported full integration event: push$/,
  );
  assert.throws(
    () => selectLane({ eventName: "pull_request", inputLane: "provider-account" }),
    /^Error: Unsupported full integration event: pull_request$/,
  );
  assert.doesNotThrow(() => assertSourceRef("refs/heads/main"));
  assert.doesNotThrow(() => assertSourceRef("refs/heads/test-model-cutover", "k3d-model"));
  assert.doesNotThrow(() => assertSourceRef("refs/heads/test-openshell", "openshell"));
  assert.throws(
    () => assertSourceRef("refs/heads/test-openshell", "docker-model"),
    /must run from main/,
  );
  assert.throws(() => assertSourceRef("refs/pull/1/merge"), /must run from main/);
  assert.deepEqual(requiredEnvironmentsForLane("provider-account"), [
    "integration-provider-account",
  ]);
  assert.deepEqual(requiredEnvironmentsForLane("all"), [
    "integration-model",
    "integration-otel",
    "integration-routing",
    "integration-slack",
    "integration-provider-account",
    "integration-openshell",
  ]);
});

test("provider-account environment policy is main-only without required reviewers", () => {
  assert.doesNotThrow(() =>
    validateEnvironmentPolicy(
      "integration-provider-account",
      providerEnvironment(),
      mainOnlyPolicies,
    ),
  );
  assert.throws(
    () =>
      validateEnvironmentPolicy(
        "integration-provider-account",
        providerEnvironment({
          protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User" }] }],
        }),
        mainOnlyPolicies,
      ),
    /must not require reviewers/,
  );
  assert.throws(
    () =>
      validateEnvironmentPolicy(
        "integration-provider-account",
        providerEnvironment({
          deployment_branch_policy: { custom_branch_policies: false, protected_branches: true },
        }),
        mainOnlyPolicies,
      ),
    /custom main-only policy/,
  );
  for (const policies of [
    { total_count: 2, branch_policies: [{ name: "main", type: "branch" }] },
    {
      total_count: 2,
      branch_policies: [
        { name: "main", type: "branch" },
        { name: "release", type: "branch" },
      ],
    },
    { total_count: 1, branch_policies: [{ name: "main" }] },
  ]) {
    assert.throws(
      () =>
        validateEnvironmentPolicy("integration-provider-account", providerEnvironment(), policies),
      /must allow only the main branch/,
    );
  }
});

test("non-provider integration environments still require reviewers", () => {
  assert.doesNotThrow(() =>
    validateEnvironmentPolicy("integration-model", protectedEnvironment(), undefined),
  );
  assert.throws(
    () =>
      validateEnvironmentPolicy(
        "integration-model",
        protectedEnvironment({ protection_rules: [] }),
        undefined,
      ),
    /has no required reviewers/,
  );
  assert.throws(
    () =>
      validateEnvironmentPolicy(
        "integration-model",
        protectedEnvironment({
          protection_rules: [{ type: "required_reviewers", prevent_self_review: false }],
        }),
        undefined,
      ),
    /does not prevent self-review/,
  );
});

test("preflight fetches only the provider environment for manual provider runs", async () => {
  const fetched = [];
  const result = await validateFullIntegrationPreflight({
    env: {
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      INPUT_LANE: "provider-account",
      GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
      GITHUB_TOKEN: "token",
    },
    github: async ({ repository, path }) => {
      fetched.push({ repository, path });
      if (path === "/environments/integration-provider-account") {
        return providerEnvironment();
      }
      if (path === "/environments/integration-provider-account/deployment-branch-policies") {
        return mainOnlyPolicies;
      }
      throw new Error(`unexpected path ${path}`);
    },
  });

  assert.deepEqual(result, { selectedLane: "provider-account", runAll: false });
  assert.deepEqual(fetched, [
    {
      repository: "openclaw/openclaw-enterprise",
      path: "/environments/integration-provider-account",
    },
    {
      repository: "openclaw/openclaw-enterprise",
      path: "/environments/integration-provider-account/deployment-branch-policies",
    },
  ]);
});

test("preflight rejects non-main sources before fetching environment metadata", async () => {
  const fetched = [];
  await assert.rejects(
    () =>
      validateFullIntegrationPreflight({
        env: {
          GITHUB_REF: "refs/tags/v1",
          GITHUB_EVENT_NAME: "push",
          INPUT_LANE: "provider-account",
          GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
          GITHUB_TOKEN: "token",
        },
        github: async ({ path }) => {
          fetched.push(path);
          throw new Error(`unexpected path ${path}`);
        },
      }),
    /must run from main/,
  );
  assert.deepEqual(fetched, []);
});

test("manual protected branch runs require an exact environment grant and independent review", async () => {
  for (const { lane, environmentName, branch } of [
    {
      lane: "k3d-model",
      environmentName: "integration-model",
      branch: "test-model-cutover",
    },
    {
      lane: "openshell",
      environmentName: "integration-openshell",
      branch: "test-openshell",
    },
  ]) {
    const env = {
      GITHUB_REF: `refs/heads/${branch}`,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      INPUT_LANE: lane,
      GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
      GITHUB_TOKEN: "token",
    };
    const environment = protectedEnvironment({
      deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    });
    const policies = {
      total_count: 2,
      branch_policies: [...mainOnlyPolicies.branch_policies, { name: branch, type: "branch" }],
    };
    const run = (
      selectedEnv = env,
      selectedEnvironment = environment,
      selectedPolicies = policies,
    ) =>
      validateFullIntegrationPreflight({
        env: selectedEnv,
        github: async ({ path }) => {
          if (path === `/environments/${environmentName}`) {
            return selectedEnvironment;
          }
          if (path === `/environments/${environmentName}/deployment-branch-policies`) {
            return selectedPolicies;
          }
          throw new Error(`unexpected path ${path}`);
        },
      });

    // A branch name alone never grants access to the protected model credential.
    await assert.rejects(() => run(env, environment, mainOnlyPolicies), /exact branch/);
    for (const grant of [
      { name: "test-*", type: "branch" },
      { name: branch, type: "tag" },
    ]) {
      await assert.rejects(
        () =>
          run(env, environment, {
            ...policies,
            branch_policies: [...mainOnlyPolicies.branch_policies, grant],
          }),
        /exact branch/,
      );
    }
    await assert.rejects(() => run(env, protectedEnvironment()), /exact branch/);
    await assert.rejects(
      () => run(env, { ...environment, protection_rules: [] }),
      /has no required reviewers/,
    );
    await assert.rejects(
      () =>
        run(env, {
          ...environment,
          protection_rules: [{ type: "required_reviewers", prevent_self_review: false }],
        }),
      /does not prevent self-review/,
    );
    assert.deepEqual(await run(), { selectedLane: lane, runAll: false });
  }

  // Branch exceptions cannot select other credentialed lanes, tags, or automatic PR events.
  const branchEnv = {
    GITHUB_REF: "refs/heads/test-model-cutover",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    INPUT_LANE: "docker-model",
  };
  for (const INPUT_LANE of ["all", "provider-account", "docker-model"]) {
    assert.throws(() => assertSourceRef(branchEnv.GITHUB_REF, INPUT_LANE), /must run from main/);
  }
  await assert.rejects(
    () =>
      validateFullIntegrationPreflight({
        env: { ...branchEnv, GITHUB_REF: "refs/tags/test-model-cutover" },
      }),
    /must run from main/,
  );
  assert.throws(
    () => selectLane({ eventName: "pull_request", inputLane: "openshell" }),
    /Unsupported full integration event/,
  );
});
