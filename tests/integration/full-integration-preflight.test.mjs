import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSourceRef,
  requiredEnvironmentsForLane,
  selectLane,
  validateEnvironmentPolicy,
  validateFullIntegrationPreflight,
} from "../../scripts/ci/full-integration-preflight.mjs";
import { selectQaMatrix, validateQaInputs } from "../helpers/qa-selection.mjs";

test("full integration workflow carries QA job outcomes into targeted aggregation only", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qa-aggregate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workflow = await readFile(
    new URL("../../.github/workflows/full-integration.yml", import.meta.url),
    "utf8",
  );
  const step = workflow.split("- name: Write selected job state")[1];
  const source = step.match(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/)[1];
  for (const lane of ["qa-matrix", "all"]) {
    // `all` excludes qa-matrix until the integration-qa environment exists, so
    // a full run must neither require nor record the QA job.
    const expectRecorded = lane === "qa-matrix";
    for (const result of ["success", "failure", "cancelled", "skipped", "missing"]) {
      const needs = { preflight: { result: "success" } };
      if (result !== "missing") {
        needs["qa-matrix"] = { result };
      }
      // Execute the shipped workflow step: omission here previously made even
      // a successful QA artifact fail aggregate validation with missing-need.
      const process = spawnSync(globalThis.process.execPath, ["--input-type=commonjs"], {
        input: source,
        encoding: "utf8",
        env: { RUNNER_TEMP: directory, NEEDS_JSON: JSON.stringify(needs), SELECTED_LANE: lane },
      });
      assert.equal(process.status, 0, process.stderr);
      const recorded = JSON.parse(await readFile(join(directory, "needs.json"), "utf8"));
      assert.deepEqual(
        recorded["qa-matrix"],
        expectRecorded ? { result } : undefined,
        `${lane}: ${result}`,
      );
    }
  }
});

test("qa-matrix repository fixture dispatch keeps default and isolated credentials separate", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/full-integration.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /qa_repository_fixture:[\s\S]*?default: default[\s\S]*?options:[\s\S]*?- default[\s\S]*?- isolated/,
  );

  const defaultStep = workflow.match(
    /- name: Materialize approved QA credentials\n([\s\S]*?)\n\s+- name: Materialize isolated QA repository credentials/,
  )?.[1];
  assert.ok(defaultStep, "default QA credential materialization step is missing");
  assert.match(defaultStep, /if: inputs\.qa_repository_fixture == 'default'/);
  assert.match(
    defaultStep,
    /REPOSITORY_OBSERVER_TOKEN: \$\{\{ secrets\.REPOSITORY_OBSERVER_TOKEN \}\}/,
  );
  assert.match(
    defaultStep,
    /REPOSITORY_REGISTRY_JSON: \$\{\{ secrets\.REPOSITORY_REGISTRY_JSON \}\}/,
  );
  assert.match(defaultStep, /REPOSITORY_APP_KEY: \$\{\{ secrets\.REPOSITORY_APP_KEY \}\}/);

  const isolatedStep = workflow.match(
    /- name: Materialize isolated QA repository credentials\n([\s\S]*?)\n\s+- uses: \.\/\.github\/actions\/run-ci-lane/,
  )?.[1];
  assert.ok(isolatedStep, "isolated QA repository materialization step is missing");
  assert.match(isolatedStep, /if: inputs\.qa_repository_fixture == 'isolated'/);
  assert.match(isolatedStep, /QA_REPOSITORY_FIXTURE: isolated/);
  assert.match(
    isolatedStep,
    /QA_ISOLATED_REPOSITORY_FULL_NAME: \$\{\{ vars\.QA_ISOLATED_REPOSITORY_FULL_NAME \}\}/,
  );
  assert.doesNotMatch(isolatedStep, /REPOSITORY_OBSERVER_TOKEN/);
  assert.doesNotMatch(isolatedStep, /QA_ISOLATED_REPOSITORY_OBSERVER_TOKEN/);
  assert.match(
    isolatedStep,
    /REPOSITORY_REGISTRY_JSON: \$\{\{ secrets\.QA_ISOLATED_REPOSITORY_REGISTRY_JSON \}\}/,
  );
  assert.match(
    isolatedStep,
    /REPOSITORY_APP_KEY: \$\{\{ secrets\.QA_ISOLATED_REPOSITORY_APP_KEY \}\}/,
  );
  assert.doesNotMatch(isolatedStep, /secrets\.REPOSITORY_(?:OBSERVER_TOKEN|REGISTRY_JSON|APP_KEY)/);
  assert.equal(
    (defaultStep.match(/run: node scripts\/ci\/qa-matrix-credentials\.mjs/g) ?? []).length,
    1,
  );
  assert.equal(
    (isolatedStep.match(/run: node scripts\/ci\/qa-matrix-credentials\.mjs/g) ?? []).length,
    1,
  );
});

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function qaRegistry(repositories) {
  return JSON.stringify({
    version: 1,
    backendId: "github",
    providerInstanceId: "github-fixture-instance",
    appId: "123",
    githubInstallationId: "456",
    maximumDurationSeconds: 3600,
    repositories: repositories.map((repository, index) => ({
      repositoryRef: `repo-${index}`,
      repositoryId: String(index + 1),
      repository,
      namespaces: [{ namespaceId: "ns_test", profiles: ["git-read", "git-full"] }],
    })),
  });
}

async function runQaCredentialMaterializer(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "qa-credentials-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const githubEnv = join(directory, "github-env");
  const env = {
    RUNNER_TEMP: directory,
    GITHUB_ENV: githubEnv,
    GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
    OPENAI_API_KEY: "synthetic-openai-key",
    CODEX_ACCESS_TOKEN: "synthetic-codex-token",
    SLACK_APP_TOKEN: "synthetic-slack-app-token",
    SLACK_BOT_TOKEN: "synthetic-slack-bot-token",
    SLACK_SENDER_TOKEN: "synthetic-slack-sender-token",
    OCC_TEST_QA_SLACK_CHANNEL_ID: "C0123456789",
    OCC_TEST_CODEX_CALENDAR_TOOL_NAME: "calendar.list",
    OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT: "Synthetic calendar result",
    OCC_TEST_QA_REPOSITORY_AUTHORIZED: "1",
    REPOSITORY_OBSERVER_TOKEN: "synthetic-observer-token",
    REPOSITORY_REGISTRY_JSON: qaRegistry(["openclaw/openclaw-enterprise"]),
    REPOSITORY_APP_KEY: "synthetic-private-key",
    REPOSITORY_UPSTREAM_CIDRS_JSON: "[]",
    ...overrides,
  };
  const result = spawnSync(globalThis.process.execPath, ["scripts/ci/qa-matrix-credentials.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
  return { ...result, directory, githubEnv };
}

test("QA credential materializer preserves the default repository fixture", async (t) => {
  const result = await runQaCredentialMaterializer(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(result.githubEnv, "utf8"), /OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY=/);
});

test("QA credential materializer validates isolated repository fixture target", async (t) => {
  const target = "fixture-owner/fixture-repo";
  const success = await runQaCredentialMaterializer(t, {
    QA_REPOSITORY_FIXTURE: "isolated",
    QA_ISOLATED_REPOSITORY_FULL_NAME: target,
    REPOSITORY_REGISTRY_JSON: qaRegistry([target]),
  });
  assert.equal(success.status, 0, success.stderr);
  const exported = await readFile(success.githubEnv, "utf8");
  assert.match(exported, /OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY=/);
  assert.match(exported, /OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY=/);
  assert.match(exported, /QA_REPOSITORY_FIXTURE=isolated/);
  assert.doesNotMatch(exported, /OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE=/);
  assert.doesNotMatch(exported, /synthetic-observer-token/);
  const runnerEnv = Object.fromEntries(
    exported
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  const runnerSelection = selectQaMatrix({
    ...runnerEnv,
    OCC_TEST_QA_SCENARIOS: "git-full",
    OCC_TEST_QA_GITHUB_OBSERVER_BINARY: "gh",
    OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE: "/private/static-token",
  });
  assert.ok(
    runnerSelection.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY"),
  );
  assert.ok(!runnerSelection.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_BINARY"));
  assert.ok(!runnerSelection.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE"));
  assert.doesNotThrow(() =>
    validateQaInputs(runnerSelection, {
      ...runnerEnv,
      OCC_TEST_QA_REPOSITORY_AUTHORIZED: "1",
    }),
  );

  const missingTarget = await runQaCredentialMaterializer(t, {
    QA_REPOSITORY_FIXTURE: "isolated",
    REPOSITORY_REGISTRY_JSON: qaRegistry([target]),
  });
  assert.notEqual(missingTarget.status, 0);
  assert.match(missingTarget.stderr, /QA_ISOLATED_REPOSITORY_FULL_NAME is required/);

  const wrongTarget = await runQaCredentialMaterializer(t, {
    QA_REPOSITORY_FIXTURE: "isolated",
    QA_ISOLATED_REPOSITORY_FULL_NAME: target,
    REPOSITORY_REGISTRY_JSON: qaRegistry(["fixture-owner/other-repo"]),
  });
  assert.notEqual(wrongTarget.status, 0);
  assert.match(wrongTarget.stderr, /must match QA_ISOLATED_REPOSITORY_FULL_NAME/);

  const multipleRepositories = await runQaCredentialMaterializer(t, {
    QA_REPOSITORY_FIXTURE: "isolated",
    QA_ISOLATED_REPOSITORY_FULL_NAME: target,
    REPOSITORY_REGISTRY_JSON: qaRegistry([target, "fixture-owner/other-repo"]),
  });
  assert.notEqual(multipleRepositories.status, 0);
  assert.match(multipleRepositories.stderr, /exactly one repository/);

  const workflowRepository = await runQaCredentialMaterializer(t, {
    QA_REPOSITORY_FIXTURE: "isolated",
    QA_ISOLATED_REPOSITORY_FULL_NAME: "openclaw/openclaw-enterprise",
    REPOSITORY_REGISTRY_JSON: qaRegistry(["openclaw/openclaw-enterprise"]),
  });
  assert.notEqual(workflowRepository.status, 0);
  assert.match(workflowRepository.stderr, /must not target this workflow repository/);
});

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
  assert.deepEqual(requiredEnvironmentsForLane("qa-matrix"), ["integration-qa"]);
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
