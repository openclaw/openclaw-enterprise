import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSourceRef,
  requiredEnvironmentsForLane,
  selectLane,
  validateEnvironmentPolicy,
  validateFullIntegrationPreflight,
} from "../../scripts/ci/full-integration-preflight.mjs";

test("full integration workflow carries QA job outcomes into targeted aggregation only", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qa-aggregate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workflow = await readFile(
    new URL("../../.github/workflows/full-integration.yml", import.meta.url),
    "utf8",
  );
  const step = workflow.split("- name: Write selected job state")[1];
  const source = step.match(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/)[1];
  for (const lane of ["qa-matrix", "dev-up-k3d", "all"]) {
    // `all` excludes qa-matrix until the integration-qa environment exists, so
    // a full run must neither require nor record the QA job.
    const target = lane === "dev-up-k3d" ? lane : "qa-matrix";
    const expectRecorded = lane !== "all";
    for (const result of ["success", "failure", "cancelled", "skipped", "missing"]) {
      const needs = { preflight: { result: "success" } };
      if (result !== "missing") {
        needs[target] = { result };
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
        recorded[target],
        expectRecorded ? { result } : undefined,
        `${lane}: ${result}`,
      );
    }
  }
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

test("manual dev-up lane accepts a reviewed branch without protected credentials", async () => {
  const env = {
    GITHUB_REF: "refs/heads/reviewed-keycloak",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    INPUT_LANE: "dev-up-k3d",
  };
  const github = async () => {
    throw new Error("credential-free lane requested a protected environment");
  };
  assert.deepEqual(await validateFullIntegrationPreflight({ env, github }), {
    selectedLane: "dev-up-k3d",
    runAll: false,
  });
  assert.deepEqual(requiredEnvironmentsForLane("dev-up-k3d"), []);
  for (const ref of ["refs/tags/reviewed-keycloak", "refs/pull/1138/merge"]) {
    await assert.rejects(
      validateFullIntegrationPreflight({ env: { ...env, GITHUB_REF: ref }, github }),
      /must run from main/,
    );
  }
  for (const event of ["push", "pull_request"]) {
    await assert.rejects(
      validateFullIntegrationPreflight({ env: { ...env, GITHUB_EVENT_NAME: event }, github }),
      /Unsupported full integration event/,
    );
  }
  for (const lane of ["all", "docker-model", "provider-account", "qa-matrix"]) {
    assert.throws(() => assertSourceRef(env.GITHUB_REF, lane), /must run from main/);
  }
});

test("manual dev-up workflow prepares the complete lane and aggregates its exact source", async () => {
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const workflow = loadYaml(await read(".github/workflows/full-integration.yml"));
  const action = loadYaml(await read(".github/actions/run-ci-lane/action.yml"));
  const suites = JSON.parse(await read("scripts/ci/test-suites.json"));
  assert.ok(workflow.on.workflow_dispatch.inputs.lane.options.includes("dev-up-k3d"));
  const group = workflow.concurrency.group.startsWith("${{")
    ? workflow.concurrency.group.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    : JSON.stringify(workflow.concurrency.group);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  // Protected lanes keep their existing queue; launcher runs serialize by branch,
  // even when a later dispatch selects a different commit on that branch.
  for (const lane of workflow.on.workflow_dispatch.inputs.lane.options) {
    for (const ref of ["refs/heads/main", "refs/heads/reviewed-keycloak"]) {
      for (const sha of ["first-commit", "later-commit"]) {
        assert.equal(
          runInNewContext(group, {
            inputs: { lane },
            github: { ref, sha },
            format: (template, value) => template.replace("{0}", value),
          }),
          lane === "dev-up-k3d" ? `full-integration-dev-up-k3d-${ref}` : "full-integration",
          `${lane}: ${ref} at ${sha}`,
        );
      }
    }
  }
  const job = workflow.jobs["dev-up-k3d"];
  assert.equal(job.environment, undefined);
  assert.equal(job.env, undefined);
  assert.equal(job.needs, "preflight");
  assert.equal(job["runs-on"], "ubuntu-22.04");
  for (const lane of ["dev-up-k3d", "all", "k3d-model"]) {
    assert.equal(runInNewContext(job.if, { inputs: { lane } }), lane === "dev-up-k3d");
  }
  assert.equal(job.steps[0].with.ref, "${{ github.sha }}");
  assert.equal(job.steps[0].with["persist-credentials"], false);
  const run = job.steps.find(({ uses }) => uses === "./.github/actions/run-ci-lane");
  assert.equal(run.with.lane, "dev-up-k3d");
  assert.equal(run.with.profile, "full");
  assert.equal(run.with["artifact-prefix"], "full-results");
  assert.ok(workflow.jobs["full-aggregate"].needs.includes("dev-up-k3d"));
  assert.equal(suites.groups.ci.includes("dev-up-k3d"), false);
  assert.equal(suites.groups.full.includes("dev-up-k3d"), false);
  const inputs = { lane: "dev-up-k3d", profile: run.with.profile };
  const evaluate = (expression) =>
    runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
      inputs,
      startsWith: (value, prefix) => value.startsWith(prefix),
    });
  for (const name of [
    "Set up Go toolchain",
    "Build Go CLI for development installation proof",
    "Install browser dependencies",
    "Enable Kubernetes bridge packet filtering",
  ]) {
    const step = action.runs.steps.find((step) => step.name === name);
    assert.equal(evaluate(step.if), true, `${name} must run for this lane`);
  }
  const timeout = Number(
    evaluate(
      action.runs.steps.find(({ name }) => name === "Run lane").env.CI_RUNNER_TEST_TIMEOUT_MS,
    ),
  );
  assert.ok(timeout >= 7_800_000, "six sequential cases need at least 130 minutes");
  assert.ok(job["timeout-minutes"] * 60_000 > timeout, "job must also allow setup and cleanup");
  const secretSteps = action.runs.steps.filter(({ name }) =>
    ["Expose image cache credentials", "Install trusted browser certificate tooling"].includes(
      name,
    ),
  );
  for (const step of secretSteps) {
    assert.equal(evaluate(step.if), false);
  }
});
