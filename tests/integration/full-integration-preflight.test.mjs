import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMainRef,
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

test("full integration preflight selects provider-account for every main push", async () => {
  assert.equal(selectLane({ eventName: "push", inputLane: "all" }), "provider-account");
  assert.equal(selectLane({ eventName: "workflow_dispatch", inputLane: "all" }), "all");
  assert.throws(() => selectLane({ eventName: "pull_request", inputLane: "provider-account" }));
  assert.doesNotThrow(() => assertMainRef("refs/heads/main"));
  assert.throws(() => assertMainRef("refs/pull/1/merge"), /must run from main/);
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

test("preflight fetches only the provider environment for automatic pushes", async () => {
  const fetched = [];
  const result = await validateFullIntegrationPreflight({
    env: {
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "push",
      INPUT_LANE: "all",
      GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
      GITHUB_TOKEN: "token",
    },
    github: async ({ repository, path }) => {
      fetched.push({ repository, path });
      if (path === "/environments/integration-provider-account") return providerEnvironment();
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
