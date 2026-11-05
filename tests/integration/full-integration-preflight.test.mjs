import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
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
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

test("full integration workflow carries QA and installation outcomes into selected aggregation", async (t) => {
  const directory = await temporaryDirectory(t, "qa-aggregate-");
  const workflow = await readFile(
    new URL("../../.github/workflows/full-integration.yml", import.meta.url),
    "utf8",
  );
  const step = workflow.split("- name: Write selected job state")[1];
  const source = step.match(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/)[1];
  for (const target of ["qa-matrix", "dev-up-k3d", "skipper-prepared-git-installed"]) {
    for (const lane of [target, "all"]) {
      for (const result of ["success", "failure", "cancelled", "skipped", "missing"]) {
        const needs = { preflight: { result: "success" } };
        if (result !== "missing") {
          needs[target] = { result };
        }
        // Execute the shipped workflow step: every selected lane must reach
        // aggregate validation, including failures and absent job outcomes.
        const process = spawnSync(globalThis.process.execPath, ["--input-type=commonjs"], {
          input: source,
          encoding: "utf8",
          env: { RUNNER_TEMP: directory, NEEDS_JSON: JSON.stringify(needs), SELECTED_LANE: lane },
        });
        assert.equal(process.status, 0, process.stderr);
        const recorded = JSON.parse(await readFile(join(directory, "needs.json"), "utf8"));
        assert.deepEqual(recorded[target], { result }, `${lane}: ${target}: ${result}`);
      }
    }
  }
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

test("hosted repository egress selects only public GitHub API and Git IPv4 networks", () => {
  const meta = {
    api: ["140.82.112.0/20", "2606:50c0::/32"],
    git: ["140.82.112.0/20", "20.201.28.148/32"],
    actions: ["4.0.0.0/8"],
  };
  function select(metadata) {
    return spawnSync("python3", ["scripts/ci/github-repository-egress.py"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: JSON.stringify(metadata),
    });
  }
  const result = select(meta);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    githubApiAndGit: ["140.82.112.0/20", "20.201.28.148/32"],
  });
  for (const git of [
    undefined,
    [],
    ["2606:50c0::/32"],
    ["0.0.0.0/0"],
    ["172.0.0.0/8"],
    ["140.82.112.3/20"],
  ]) {
    const invalid = select({ ...meta, git });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, "");
  }
});

async function runQaCredentialMaterializer(
  t,
  overrides = {},
  registry = qaRegistry(["openclaw/openclaw-enterprise"]),
) {
  const directory = await temporaryDirectory(t, "qa-credentials-");
  const githubEnv = join(directory, "github-env");
  const registryFile = join(directory, "reviewed-registry.json");
  await writeFile(registryFile, registry, { mode: 0o600 });
  await writeFile(
    join(directory, "github-repository-egress.json"),
    JSON.stringify({
      githubApiAndGit: ["140.82.112.0/20"],
    }),
  );
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
    REPOSITORY_REGISTRY_FILE: registryFile,
    REPOSITORY_APP_KEY: "synthetic-private-key",
    ...overrides,
  };
  const result = spawnSync(globalThis.process.execPath, ["scripts/ci/qa-matrix-credentials.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
  return { ...result, directory, githubEnv, registryFile };
}

test("QA credential materializer reads reviewed registry files only for repository scenarios", async (t) => {
  const registryFile = "scripts/ci/qa-repositories/default.json";
  const registry = await readFile(join(repositoryRoot, registryFile), "utf8");
  const result = await runQaCredentialMaterializer(t, { REPOSITORY_REGISTRY_FILE: registryFile });
  assert.equal(result.status, 0, result.stderr);
  const exported = await readFile(result.githubEnv, "utf8");
  assert.match(exported, /OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY=/);
  assert.match(exported, /OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY=/);
  assert.doesNotMatch(exported, /OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE=/);
  const repository = join(result.directory, "qa-matrix-credentials", "repository");
  assert.equal(await readFile(join(repository, "registry.json"), "utf8"), registry);
  assert.deepEqual(JSON.parse(await readFile(join(repository, "upstream-cidrs.json"), "utf8")), {
    githubApiAndGit: ["140.82.112.0/20"],
  });
  assert.equal(
    await readFile(join(repository, "private-key.pem"), "utf8"),
    "synthetic-private-key",
  );
  assert.equal((await stat(join(repository, "registry.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(repository, "private-key.pem"))).mode & 0o777, 0o600);
  assert.doesNotMatch(exported, /synthetic-private-key|fixture-owner/);

  // Invalid inputs stop materialization without copying their contents into errors.
  for (const [overrides, contents, error] of [
    [{ REPOSITORY_REGISTRY_FILE: undefined }, registry, /REPOSITORY_REGISTRY_FILE is required/],
    [
      { REPOSITORY_REGISTRY_FILE: join(result.directory, "missing.json") },
      registry,
      /REPOSITORY_REGISTRY_FILE must name a readable file/,
    ],
    [{}, "{synthetic-private-key", /REPOSITORY_REGISTRY_FILE must contain valid JSON/],
    [{}, "[]", /REPOSITORY_REGISTRY_FILE must contain an object/],
    [{}, "{}", /repository registry must contain repositories/],
  ]) {
    const failure = await runQaCredentialMaterializer(t, overrides, contents);
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, error);
    assert.doesNotMatch(failure.stderr, /synthetic-private-key/);
  }

  // Calendar/model-only advisory runs need no repository metadata or App key.
  const noRepository = await runQaCredentialMaterializer(t, {
    OCC_TEST_QA_PRESET: "Codex",
    OCC_TEST_QA_SCENARIOS: "model-ui",
    REPOSITORY_REGISTRY_FILE: undefined,
    REPOSITORY_APP_KEY: undefined,
    QA_REPOSITORY_FIXTURE: "isolated",
  });
  assert.equal(noRepository.status, 0, noRepository.stderr);
  assert.doesNotMatch(
    await readFile(noRepository.githubEnv, "utf8"),
    /OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY/,
  );
});

test("QA credential materializer validates isolated repository fixture target", async (t) => {
  const registryFile = "scripts/ci/qa-repositories/isolated.json";
  const registry = await readFile(join(repositoryRoot, registryFile), "utf8");
  const target = JSON.parse(registry).repositories[0].repository;
  const success = await runQaCredentialMaterializer(t, {
    QA_REPOSITORY_FIXTURE: "isolated",
    QA_ISOLATED_REPOSITORY_FULL_NAME: target,
    REPOSITORY_REGISTRY_FILE: registryFile,
    REPOSITORY_APP_KEY: "synthetic-isolated-private-key",
  });
  assert.equal(success.status, 0, success.stderr);
  const repository = join(success.directory, "qa-matrix-credentials", "repository");
  assert.equal(await readFile(join(repository, "registry.json"), "utf8"), registry);
  assert.equal(
    await readFile(join(repository, "private-key.pem"), "utf8"),
    "synthetic-isolated-private-key",
  );
  const exported = await readFile(success.githubEnv, "utf8");
  assert.match(exported, /OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY=/);
  assert.match(exported, /OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY=/);
  assert.match(exported, /QA_REPOSITORY_FIXTURE=isolated/);
  assert.doesNotMatch(exported, /OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE=/);
  assert.doesNotMatch(exported, /synthetic-observer-token|synthetic-isolated-private-key/);
  const runnerEnv = Object.fromEntries(
    exported
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  const runnerSelection = selectQaMatrix({
    ...runnerEnv,
    OCC_TEST_QA_SCENARIOS: "git-write",
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

  const missingTarget = await runQaCredentialMaterializer(
    t,
    {
      QA_REPOSITORY_FIXTURE: "isolated",
    },
    qaRegistry([target]),
  );
  assert.notEqual(missingTarget.status, 0);
  assert.match(missingTarget.stderr, /QA_ISOLATED_REPOSITORY_FULL_NAME is required/);

  const wrongTarget = await runQaCredentialMaterializer(
    t,
    {
      QA_REPOSITORY_FIXTURE: "isolated",
      QA_ISOLATED_REPOSITORY_FULL_NAME: target,
    },
    qaRegistry(["fixture-owner/other-repo"]),
  );
  assert.notEqual(wrongTarget.status, 0);
  assert.match(wrongTarget.stderr, /must match QA_ISOLATED_REPOSITORY_FULL_NAME/);

  const multipleRepositories = await runQaCredentialMaterializer(
    t,
    {
      QA_REPOSITORY_FIXTURE: "isolated",
      QA_ISOLATED_REPOSITORY_FULL_NAME: target,
    },
    qaRegistry([target, "fixture-owner/other-repo"]),
  );
  assert.notEqual(multipleRepositories.status, 0);
  assert.match(multipleRepositories.stderr, /exactly one repository/);

  const workflowRepository = await runQaCredentialMaterializer(t, {
    QA_REPOSITORY_FIXTURE: "isolated",
    QA_ISOLATED_REPOSITORY_FULL_NAME: "openclaw/openclaw-enterprise",
    REPOSITORY_REGISTRY_FILE: registryFile,
  });
  assert.notEqual(workflowRepository.status, 0);
  assert.match(workflowRepository.stderr, /must not target this workflow repository/);
});

function integrationEnvironment(patch = {}) {
  return {
    name: "integration-main",
    can_admins_bypass: false,
    protection_rules: [],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    ...patch,
  };
}

const mainOnlyPolicies = {
  total_count: 1,
  branch_policies: [{ name: "main", type: "branch" }],
};
const credentialedLanes = [
  "qa-matrix",
  "docker-model",
  "k3d-model",
  "gateway-routing",
  "production-tui",
  "slack",
  "openshell",
  "k3d-otel",
];
const mainRun = {
  GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_TYPE: "branch",
  GITHUB_EVENT_NAME: "push",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "123",
  GITHUB_ACTOR: "dispatcher",
  GITHUB_ACTOR_ID: "42",
  GITHUB_TRIGGERING_ACTOR: "dispatcher",
  GITHUB_TOKEN: "synthetic-workflow-token",
  INPUT_LANE: "all",
};
const approvalEnvironment = integrationEnvironment({
  id: 26285522718,
  name: "integration-main-approval",
  protection_rules: [
    {
      type: "required_reviewers",
      prevent_self_review: false,
      reviewers: [{ type: "Team", reviewer: { id: 19674117 } }],
    },
  ],
});
const approvalReview = {
  state: "approved",
  environments: [{ id: 26285522718, name: "integration-main-approval" }],
  user: { id: 42, login: "dispatcher", type: "User" },
};

function approvalApi(overrides = {}, fetched = []) {
  const responses = {
    "/environments/integration-main-approval": approvalEnvironment,
    "/environments/integration-main-approval/deployment-branch-policies": mainOnlyPolicies,
    "/actions/runs/123/approvals": [approvalReview],
    "/environments/integration-main": integrationEnvironment(),
    "/environments/integration-main/deployment-branch-policies": mainOnlyPolicies,
    ...overrides,
  };
  return async ({ repository, path }) => {
    assert.equal(repository, mainRun.GITHUB_REPOSITORY);
    fetched.push(path);
    assert.ok(Object.hasOwn(responses, path), `unexpected API path ${path}`);
    return responses[path];
  };
}

test("full integration preflight selects automatic main pushes and manual main lanes", () => {
  assert.equal(selectLane({ eventName: "push", ref: "refs/heads/main" }), "all");
  assert.equal(
    selectLane({ eventName: "workflow_dispatch", inputLane: "docker-model" }),
    "docker-model",
  );
  for (const eventName of ["pull_request", "pull_request_target", "schedule"]) {
    assert.throws(() => selectLane({ eventName, ref: "refs/heads/main" }), /Unsupported/);
  }
  assert.throws(
    () =>
      selectLane({ eventName: "push", ref: "refs/heads/dev/kevinlin/integration-main-cutover" }),
    /Unsupported/,
  );
  assert.throws(() => requiredEnvironmentsForLane("provider-account"), /Unknown lane/);
  for (const lane of [...credentialedLanes, "all"]) {
    assert.deepEqual(requiredEnvironmentsForLane(lane), ["integration-main"]);
  }
  for (const lane of [
    "helper-timeout",
    "logging-collector",
    "dev-up-k3d",
    "skipper-prepared-git-installed",
  ]) {
    assert.deepEqual(requiredEnvironmentsForLane(lane), []);
  }
});

test("integration environment policy rejects broad, incomplete or bypassable rules", () => {
  assert.doesNotThrow(() =>
    validateEnvironmentPolicy("integration-main", integrationEnvironment(), mainOnlyPolicies),
  );
  for (const can_admins_bypass of [undefined, true]) {
    assert.throws(
      () =>
        validateEnvironmentPolicy(
          "integration-main",
          integrationEnvironment({ can_admins_bypass }),
          mainOnlyPolicies,
        ),
      /disable administrator bypass/,
    );
  }
  for (const deployment_branch_policy of [
    null,
    { custom_branch_policies: false, protected_branches: true },
    { custom_branch_policies: true, protected_branches: true },
  ]) {
    assert.throws(
      () =>
        validateEnvironmentPolicy(
          "integration-main",
          integrationEnvironment({ deployment_branch_policy }),
          mainOnlyPolicies,
        ),
      /main-only policy/,
    );
  }
  assert.throws(
    () => validateEnvironmentPolicy("integration-main", approvalEnvironment, mainOnlyPolicies),
    /must not require reviewers/,
  );
  for (const policies of [
    undefined,
    { total_count: 0, branch_policies: [] },
    { total_count: 2, branch_policies: mainOnlyPolicies.branch_policies },
    { branch_policies: mainOnlyPolicies.branch_policies },
    { total_count: 1, branch_policies: [{ name: "main", type: "tag" }] },
    { total_count: 1, branch_policies: [{ name: "main" }] },
    ...["*", "release", "refs/pull/*/merge", "dev/kevinlin/integration-main-cutover", "main"].map(
      (name) => ({
        total_count: 2,
        branch_policies: [...mainOnlyPolicies.branch_policies, { name, type: "branch" }],
      }),
    ),
  ]) {
    assert.throws(
      () => validateEnvironmentPolicy("integration-main", integrationEnvironment(), policies),
      /only the main branch/,
    );
  }
});

test("main pushes and retries require no manual approval or team credential", async () => {
  for (const attempt of ["1", "2"]) {
    const fetched = [];
    assert.deepEqual(
      await validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_RUN_ATTEMPT: attempt },
        github: approvalApi({}, fetched),
      }),
      { selectedLane: "all", runAll: true },
    );
    assert.deepEqual(fetched, [
      "/environments/integration-main",
      "/environments/integration-main/deployment-branch-policies",
    ]);
  }
});

test("manual preflight checks native team approval before reading integration credentials policy", async () => {
  for (const lane of [
    ...credentialedLanes,
    "all",
    "dev-up-k3d",
    "skipper-prepared-git-installed",
  ]) {
    const fetched = [];
    assert.deepEqual(
      await validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch", INPUT_LANE: lane },
        github: approvalApi({}, fetched),
      }),
      { selectedLane: lane, runAll: lane === "all" },
    );
    assert.deepEqual(fetched.slice(0, 3), [
      "/environments/integration-main-approval",
      "/environments/integration-main-approval/deployment-branch-policies",
      "/actions/runs/123/approvals",
    ]);
    assert.equal(
      fetched.includes("/environments/integration-main"),
      credentialedLanes.includes(lane) || lane === "all",
    );
  }
});

test("preflight denies foreign sources, old branch routes and manual reruns before metadata reads", async () => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    for (const patch of [
      { GITHUB_REPOSITORY: "other-owner/openclaw-enterprise" },
      { GITHUB_REF: "refs/tags/main", GITHUB_REF_TYPE: "tag" },
      { GITHUB_REF_TYPE: undefined },
      { GITHUB_REF: "refs/pull/1/merge" },
      { GITHUB_REF: "refs/heads/dev/kevinlin/integration-main-cutover" },
      { GITHUB_REF: "refs/heads/reviewed-branch", INPUT_LANE: "dev-up-k3d" },
      { GITHUB_REF: "refs/heads/reviewed-branch", INPUT_LANE: "skipper-prepared-git-installed" },
      ...(eventName === "workflow_dispatch"
        ? [{ GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_RUN_ATTEMPT: undefined }]
        : []),
    ]) {
      const fetched = [];
      await assert.rejects(
        validateFullIntegrationPreflight({
          env: { ...mainRun, GITHUB_EVENT_NAME: eventName, ...patch },
          github: approvalApi({}, fetched),
        }),
        /main|this repository|reruns/,
      );
      assert.deepEqual(fetched, []);
    }
  }
  assert.throws(() => assertSourceRef("refs/heads/reviewed-branch"), /main/);
});

test("manual preflight binds review to original actor ID and actual triggering actor", async () => {
  for (const patch of [
    { GITHUB_TRIGGERING_ACTOR: "other-user" },
    { GITHUB_TRIGGERING_ACTOR: undefined },
    { GITHUB_ACTOR: undefined },
    { GITHUB_ACTOR_ID: undefined },
    { GITHUB_ACTOR_ID: "0" },
    { GITHUB_ACTOR_ID: "9007199254740992" },
    { GITHUB_RUN_ID: "123/approvals" },
  ]) {
    const fetched = [];
    await assert.rejects(
      validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch", ...patch },
        github: approvalApi({}, fetched),
      }),
      /identified dispatcher/,
    );
    assert.deepEqual(fetched, []);
  }
});

test("manual preflight refuses missing, rejected, duplicate and wrong-identity reviews", async () => {
  for (const reviews of [
    [],
    null,
    {},
    [{ ...approvalReview, state: "pending" }],
    [{ ...approvalReview, state: "rejected" }],
    [approvalReview, approvalReview],
    [approvalReview, { ...approvalReview, state: "rejected" }],
    [{ ...approvalReview, user: { ...approvalReview.user, id: 43 } }],
    [{ ...approvalReview, user: { ...approvalReview.user, login: "other-user" } }],
    [{ ...approvalReview, user: undefined }],
    [{ ...approvalReview, environments: [{ id: 1, name: "integration-main-approval" }] }],
    [{ ...approvalReview, environments: [{ id: 26285522718, name: "other-environment" }] }],
  ]) {
    const fetched = [];
    await assert.rejects(
      validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch" },
        github: approvalApi({ "/actions/runs/123/approvals": reviews }, fetched),
      }),
      /approval|approved environment review/,
    );
    assert.equal(fetched.includes("/environments/integration-main"), false);
  }
});

test("manual preflight rejects altered approval environment protection before history reads", async () => {
  for (const environment of [
    { ...approvalEnvironment, id: 1 },
    { ...approvalEnvironment, name: "other" },
    { ...approvalEnvironment, can_admins_bypass: true },
    { ...approvalEnvironment, protection_rules: [] },
    {
      ...approvalEnvironment,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: true,
          reviewers: approvalEnvironment.protection_rules[0].reviewers,
        },
      ],
    },
    {
      ...approvalEnvironment,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [{ type: "Team", reviewer: { id: 1 } }],
        },
      ],
    },
    {
      ...approvalEnvironment,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [{ type: "User", reviewer: { id: 42 } }],
        },
      ],
    },
    {
      ...approvalEnvironment,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [
            ...approvalEnvironment.protection_rules[0].reviewers,
            { type: "User", reviewer: { id: 42 } },
          ],
        },
      ],
    },
  ]) {
    const fetched = [];
    await assert.rejects(
      validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch" },
        github: approvalApi({ "/environments/integration-main-approval": environment }, fetched),
      }),
      /approval|administrator bypass|main-only policy|main branch/,
    );
    assert.equal(fetched.includes("/actions/runs/123/approvals"), false);
    assert.equal(fetched.includes("/environments/integration-main"), false);
  }
});

test("manual approval API failures stop before protected environment access", async () => {
  for (const failurePath of [
    "/environments/integration-main-approval",
    "/environments/integration-main-approval/deployment-branch-policies",
    "/actions/runs/123/approvals",
  ]) {
    const fetched = [];
    const valid = approvalApi({}, fetched);
    await assert.rejects(
      validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch" },
        github: async (request) => {
          if (request.path === failurePath) {
            throw new Error("GitHub API unavailable");
          }
          return valid(request);
        },
      }),
      /API unavailable/,
    );
    assert.equal(fetched.includes("/environments/integration-main"), false);
  }
});

function workflowCondition(expression, context) {
  return runInNewContext(
    expression
      .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
      .replace(/needs\.([a-z][a-z0-9-]*)/g, 'needs["$1"]'),
    { cancelled: () => false, ...context },
  );
}

test("workflow permits main push retries and refuses approval reuse on manual retries", async () => {
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const workflow = loadYaml(
    await readFile(
      new URL("../../.github/workflows/full-integration.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.on.pull_request, undefined);
  const jobs = Object.entries(workflow.jobs).filter(
    ([name]) => !["manual-approval", "preflight", "full-aggregate"].includes(name),
  );
  assert.ok(jobs.length > 0);
  for (const [name, job] of jobs) {
    for (const event_name of ["push", "workflow_dispatch"]) {
      const github = {
        repository: mainRun.GITHUB_REPOSITORY,
        ref: mainRun.GITHUB_REF,
        ref_type: "branch",
        run_attempt: "1",
        event_name,
      };
      const needs = {
        preflight: {
          result: "success",
          outputs: { selected_lane: name === "logging-collector" ? name : "all", run_all: "true" },
        },
        slack: { result: "success" },
      };
      assert.equal(workflowCondition(job.if, { github, needs }), true, `${name}: first attempt`);
      assert.equal(
        workflowCondition(job.if, { github: { ...github, run_attempt: "2" }, needs }),
        event_name === "push",
        `${name}: only main pushes can retry`,
      );
      for (const patch of [
        { ref: "refs/tags/main", ref_type: "tag" },
        { repository: "other/repository" },
        { event_name: "pull_request" },
      ]) {
        assert.equal(
          workflowCondition(job.if, { github: { ...github, ...patch }, needs }),
          false,
          `${name}: ${JSON.stringify(patch)}`,
        );
      }
      assert.equal(
        workflowCondition(job.if, {
          github,
          needs: { ...needs, preflight: { result: "failure", outputs: { selected_lane: "all" } } },
        }),
        false,
        `${name}: failed preflight`,
      );
    }
  }
  const manual = workflow.jobs["manual-approval"];
  assert.equal(manual.environment, "integration-main-approval");
  assert.deepEqual(manual.permissions, {});
  assert.doesNotMatch(JSON.stringify(manual), /secrets\.|actions\/checkout/);
  const github = {
    repository: mainRun.GITHUB_REPOSITORY,
    ref: mainRun.GITHUB_REF,
    ref_type: "branch",
    run_attempt: "1",
    event_name: "push",
  };
  assert.equal(
    workflowCondition(workflow.jobs.preflight.if, {
      github,
      needs: { "manual-approval": { result: "skipped" } },
    }),
    true,
  );
  for (const event_name of ["push", "workflow_dispatch"]) {
    assert.equal(
      workflowCondition(workflow.jobs.preflight.if, {
        github: { ...github, event_name, run_attempt: "2" },
        needs: { "manual-approval": { result: event_name === "push" ? "skipped" : "success" } },
      }),
      event_name === "push",
    );
  }
  for (const result of ["skipped", "failure", "cancelled", "success"]) {
    assert.equal(
      workflowCondition(workflow.jobs.preflight.if, {
        github: { ...github, event_name: "workflow_dispatch" },
        needs: { "manual-approval": { result } },
      }),
      result === "success",
    );
  }
});

test("manual dev-up workflow prepares the complete lane and aggregates its exact source", async (t) => {
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const workflow = loadYaml(await read(".github/workflows/full-integration.yml"));
  const action = loadYaml(await read(".github/actions/run-ci-lane/action.yml"));
  const suites = JSON.parse(await read("scripts/ci/test-suites.json"));
  assert.ok(workflow.on.workflow_dispatch.inputs.lane.options.includes("dev-up-k3d"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.on.workflow_dispatch.inputs.source_ref, undefined);
  for (const selected of Object.values(workflow.jobs)) {
    for (const step of selected.steps ?? []) {
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(step.with.ref, "${{ github.sha }}");
        assert.equal(step.with["persist-credentials"], false);
      }
    }
  }
  // A pending manual approval cannot occupy the push queue or replace another
  // pending approval, even if both dispatchers select the same lane.
  const queue = (eventName, runId) =>
    workflowCondition(workflow.concurrency.group, {
      github: { event_name: eventName, run_id: runId },
      format: (template, value) => template.replace("{0}", value),
    });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const pushQueue = queue("push", "100");
  const manualQueue = queue("workflow_dispatch", "101");
  assert.equal(pushQueue, queue("push", "102"));
  assert.notEqual(pushQueue, manualQueue);
  assert.notEqual(manualQueue, queue("workflow_dispatch", "103"));

  // Both event types acquire the same resource lock only after authorization.
  const resourceQueues = new Set();
  for (const lane of ["slack", "dev-up-k3d", "skipper-prepared-git-installed"]) {
    const job = workflow.jobs[lane];
    assert.equal(job.needs, "preflight");
    assert.equal(job.concurrency["cancel-in-progress"], false);
    const group = job.concurrency.group;
    assert.ok(group.startsWith("full-integration-"));
    if (lane === "slack") {
      assert.doesNotMatch(group, /\$\{/);
    } else {
      assert.equal(group, ["full-integration", lane, "${{ github.ref }}"].join("-"));
    }
    assert.ok(!resourceQueues.has(group));
    resourceQueues.add(group);
  }
  // Exercise the hosted workflow input through the same selector that determines
  // which credentials to materialize and which real installation cells run.
  const qaJob = workflow.jobs["qa-matrix"];
  const qaManifest = JSON.parse(await read("scripts/ci/test-suites/qa-matrix.json"));
  const qaRunnerEnv = Object.fromEntries(
    Object.entries(qaJob.env).filter(([name]) => qaManifest.optionalEnv.includes(name)),
  );
  const qaSelection = selectQaMatrix(qaRunnerEnv);
  assert.equal(qaSelection.scope, "partial:selected");
  assert.deepEqual(qaSelection.installations, ["compose", "kubernetes"]);
  for (const cell of qaSelection.cells) {
    assert.deepEqual(
      cell.scenarios,
      cell.preset === "OpenClaw" ? ["model-ui", "console-secrets"] : ["console-secrets"],
    );
  }
  assert.equal(qaSelection.exclusions.length, 2);
  assert.deepEqual(qaSelection.requiredEnv, [
    "OCC_TEST_QA_OPENAI_KEY_FILE",
    "OCC_TEST_QA_CODEX_TOKEN_FILE",
  ]);
  assert.deepEqual(
    Object.keys(
      qaJob.steps.find(({ name }) => name === "Materialize selected QA credentials").env,
    ).sort(),
    ["CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"],
  );
  const job = workflow.jobs["dev-up-k3d"];
  assert.equal(job.environment, undefined);
  assert.equal(job.env, undefined);
  assert.equal(job.needs, "preflight");
  assert.equal(job["runs-on"], "ubuntu-22.04");
  for (const lane of ["dev-up-k3d", "all", "k3d-model"]) {
    assert.equal(
      workflowCondition(job.if, {
        github: {
          repository: mainRun.GITHUB_REPOSITORY,
          ref: mainRun.GITHUB_REF,
          ref_type: "branch",
          run_attempt: "1",
          event_name: "workflow_dispatch",
        },
        needs: { preflight: { result: "success", outputs: { selected_lane: lane } } },
      }),
      lane === "dev-up-k3d" || lane === "all",
    );
  }
  assert.equal(job.steps[0].with.ref, "${{ github.sha }}");
  assert.equal(job.steps[0].with["persist-credentials"], false);
  const run = job.steps.find(({ uses }) => uses === "./.github/actions/run-ci-lane");
  assert.equal(run.with.lane, "dev-up-k3d");
  assert.equal(run.with.profile, "full");
  assert.equal(run.with["artifact-prefix"], "full-results");
  assert.ok(workflow.jobs["full-aggregate"].needs.includes("dev-up-k3d"));
  assert.equal(suites.groups.ci.includes("dev-up-k3d"), false);
  for (const lane of workflow.on.workflow_dispatch.inputs.lane.options) {
    if (lane !== "all") {
      assert.ok(suites.groups.full.includes(lane), `all must require ${lane} results`);
    }
  }
  const privateGit = "skipper-prepared-git-installed";
  const gitJob = workflow.jobs[privateGit];
  assert.equal(gitJob.environment, undefined);
  assert.deepEqual(gitJob.permissions, { contents: "read" });
  assert.equal(gitJob.needs, "preflight");
  assert.equal(gitJob["runs-on"], "ubuntu-22.04");
  for (const lane of [privateGit, "all", "dev-up-k3d"]) {
    assert.equal(
      workflowCondition(gitJob.if, {
        github: {
          repository: mainRun.GITHUB_REPOSITORY,
          ref: mainRun.GITHUB_REF,
          ref_type: "branch",
          run_attempt: "1",
          event_name: "workflow_dispatch",
        },
        needs: { preflight: { result: "success", outputs: { selected_lane: lane } } },
      }),
      [privateGit, "all"].includes(lane),
    );
  }
  assert.equal(gitJob.steps[0].with.ref, "${{ github.sha }}");
  assert.equal(gitJob.steps[0].with["persist-credentials"], false);
  assert.doesNotMatch(JSON.stringify(gitJob), /secrets\.|diagnostics\//);
  const [receipt] = gitJob.steps.filter(({ uses }) => uses?.startsWith("actions/upload-artifact@"));
  assert.equal(receipt.with.path, "${{ runner.temp }}/results/" + privateGit + ".json");
  assert.equal(receipt.if, undefined, "publish the receipt only after successful fixture cleanup");
  assert.ok(workflow.jobs["full-aggregate"].needs.includes(privateGit));
  const qa = workflow.jobs["qa-matrix"];
  assert.ok(qa.needs.includes("slack"), "shared Slack consumers must run sequentially");
  // A failed focused Slack proof must not suppress the broader QA proof. Only
  // failed preflight, an unselected lane, or run cancellation should prevent it.
  for (const lane of ["all", "qa-matrix", "docker-model"]) {
    for (const preflight of ["success", "failure"]) {
      for (const slack of ["success", "failure", "skipped"]) {
        for (const cancelled of [false, true]) {
          const selected = runInNewContext(qa.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
            inputs: { lane },
            github: {
              repository: mainRun.GITHUB_REPOSITORY,
              ref: mainRun.GITHUB_REF,
              ref_type: "branch",
              run_attempt: "1",
              event_name: "workflow_dispatch",
            },
            needs: {
              preflight: { result: preflight, outputs: { selected_lane: lane } },
              slack: { result: slack },
            },
            always: () => true,
            cancelled: () => cancelled,
          });
          assert.equal(
            selected,
            !cancelled && preflight === "success" && ["all", "qa-matrix"].includes(lane),
            `${lane}: preflight ${preflight}, slack ${slack}, cancelled ${cancelled}`,
          );
        }
      }
    }
  }
  const inputs = { lane: "dev-up-k3d", profile: run.with.profile };
  const directory = await temporaryDirectory(t, "manual-dev-up-image-mode-");
  const output = join(directory, "outputs");
  const mode = action.runs.steps.find(({ id }) => id === "image-mode");
  const imageSelection = spawnSync("bash", ["-c", mode.run], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CI_SELECTED_LANE: inputs.lane,
      CI_SELECTED_TEST_FILE: "",
      GITHUB_OUTPUT: output,
    },
  });
  assert.equal(imageSelection.status, 0, imageSelection.stderr);
  const firstAgent = /^first-agent=(true|false)$/m.exec(await readFile(output, "utf8"))?.[1];
  assert.ok(firstAgent, "the shipped image selection must publish its mode");
  const evaluate = (expression) =>
    runInNewContext(
      expression
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        // GitHub property names may contain hyphens; JavaScript needs brackets.
        .replaceAll(
          "steps.image-mode.outputs.first-agent",
          'steps["image-mode"].outputs["first-agent"]',
        ),
      {
        inputs,
        steps: { "image-mode": { outputs: { "first-agent": firstAgent } } },
        startsWith: (value, prefix) => value.startsWith(prefix),
      },
    );
  for (const name of [
    "Set up Go toolchain",
    "Build Go CLI for development installation proof",
    "Install browser dependencies",
    "Enable Kubernetes bridge packet filtering",
    // certutil imports the printed CA files into the Keycloak case's browser.
    "Install trusted browser certificate tooling",
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
  const secretStep = action.runs.steps.find(
    ({ name }) => name === "Expose image cache credentials",
  );
  assert.equal(evaluate(secretStep.if), false);
});
