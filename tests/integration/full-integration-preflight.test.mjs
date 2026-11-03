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
    /REPOSITORY_REGISTRY_FILE: scripts\/ci\/qa-repositories\/default\.json/,
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
    /REPOSITORY_REGISTRY_FILE: scripts\/ci\/qa-repositories\/isolated\.json/,
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

async function runQaCredentialMaterializer(
  t,
  overrides = {},
  registry = qaRegistry(["openclaw/openclaw-enterprise"]),
) {
  const directory = await temporaryDirectory(t, "qa-credentials-");
  const githubEnv = join(directory, "github-env");
  const registryFile = join(directory, "reviewed-registry.json");
  await writeFile(registryFile, registry, { mode: 0o600 });
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
    REPOSITORY_REGISTRY_FILE: registryFile,
    REPOSITORY_APP_KEY: "synthetic-private-key",
    REPOSITORY_UPSTREAM_CIDRS_JSON: "[]",
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
  const repository = join(result.directory, "qa-matrix-credentials", "repository");
  assert.equal(await readFile(join(repository, "registry.json"), "utf8"), registry);
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
      /REPOSITORY_REGISTRY_FILE must be readable/,
    ],
    [{}, "{synthetic-private-key", /REPOSITORY_REGISTRY_FILE must contain valid JSON/],
    [{}, "[]", /repository registry must be an object/],
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
    name: "integration",
    protection_rules: [],
    deployment_branch_policy: null,
    ...patch,
  };
}

const credentialedLanes = [
  "qa-matrix",
  "docker-model",
  "k3d-model",
  "gateway-routing",
  "production-tui",
  "slack",
  "provider-account",
  "openshell",
  "k3d-otel",
];

test("full integration preflight selects only manual workflow lanes", () => {
  assert.equal(selectLane({ eventName: "workflow_dispatch", inputLane: "all" }), "all");
  assert.equal(
    selectLane({ eventName: "workflow_dispatch", inputLane: "provider-account" }),
    "provider-account",
  );
  for (const eventName of ["push", "pull_request"]) {
    assert.throws(
      () => selectLane({ eventName, inputLane: "all" }),
      /Unsupported full integration event/,
    );
  }
  assert.doesNotThrow(() => assertSourceRef("refs/heads/main"));
  for (const lane of [...credentialedLanes, "all"]) {
    assert.deepEqual(requiredEnvironmentsForLane(lane), ["integration"]);
  }
});

test("integration permits manual branch dispatch without required reviewers", () => {
  assert.doesNotThrow(() => validateEnvironmentPolicy("integration", integrationEnvironment()));
  assert.throws(
    () =>
      validateEnvironmentPolicy(
        "integration",
        integrationEnvironment({
          protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User" }] }],
        }),
      ),
    /must not require reviewers/,
  );
  for (const deployment_branch_policy of [
    { custom_branch_policies: false, protected_branches: true },
    { custom_branch_policies: true, protected_branches: false },
  ]) {
    assert.throws(
      () =>
        validateEnvironmentPolicy(
          "integration",
          integrationEnvironment({ deployment_branch_policy }),
        ),
      /must permit all repository branches/,
    );
  }
});

test("preflight fetches the shared environment once for selected manual integration runs", async () => {
  for (const lane of [...credentialedLanes, "all"]) {
    for (const ref of ["refs/heads/main", "refs/heads/dev/kevinlin/reviewed-change"]) {
      const fetched = [];
      const result = await validateFullIntegrationPreflight({
        env: {
          GITHUB_REF: ref,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          INPUT_LANE: lane,
          GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
          GITHUB_TOKEN: "token",
        },
        github: async ({ repository, path }) => {
          fetched.push({ repository, path });
          if (path === "/environments/integration") {
            return integrationEnvironment();
          }
          throw new Error(`unexpected path ${path}`);
        },
      });

      assert.deepEqual(result, { selectedLane: lane, runAll: lane === "all" });
      assert.deepEqual(fetched, [
        { repository: "openclaw/openclaw-enterprise", path: "/environments/integration" },
      ]);
    }
  }
});

test("preflight rejects tags and PR refs before fetching environment metadata", async () => {
  const fetched = [];
  for (const lane of [...credentialedLanes, "all"]) {
    for (const ref of ["refs/tags/main", "refs/pull/1/merge", undefined]) {
      await assert.rejects(
        () =>
          validateFullIntegrationPreflight({
            env: {
              GITHUB_REF: ref,
              GITHUB_EVENT_NAME: "workflow_dispatch",
              INPUT_LANE: lane,
              GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
              GITHUB_TOKEN: "token",
            },
            github: async ({ path }) => {
              fetched.push(path);
              throw new Error(`unexpected path ${path}`);
            },
          }),
        /must run from a repository branch/,
      );
    }
  }
  assert.deepEqual(fetched, []);
});

for (const lane of ["dev-up-k3d", "skipper-prepared-git-installed"]) {
  test(`manual ${lane} lane accepts a reviewed branch without protected credentials`, async () => {
    const env = {
      GITHUB_REF: "refs/heads/reviewed-keycloak",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      INPUT_LANE: lane,
    };
    const github = async () => {
      throw new Error("credential-free lane requested a protected environment");
    };
    assert.deepEqual(await validateFullIntegrationPreflight({ env, github }), {
      selectedLane: lane,
      runAll: false,
    });
    assert.deepEqual(requiredEnvironmentsForLane(lane), []);
    for (const ref of ["refs/tags/reviewed-keycloak", "refs/pull/1138/merge"]) {
      await assert.rejects(
        validateFullIntegrationPreflight({ env: { ...env, GITHUB_REF: ref }, github }),
        /must run from a repository branch/,
      );
    }
    for (const event of ["push", "pull_request"]) {
      await assert.rejects(
        validateFullIntegrationPreflight({ env: { ...env, GITHUB_EVENT_NAME: event }, github }),
        /Unsupported full integration event/,
      );
    }
    for (const lane of ["all", "docker-model", "provider-account", "qa-matrix"]) {
      assert.doesNotThrow(() => assertSourceRef(env.GITHUB_REF, lane));
    }
  });
}

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
          ["dev-up-k3d", "skipper-prepared-git-installed"].includes(lane)
            ? `full-integration-${lane}-${ref}`
            : "full-integration",
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
    assert.equal(
      runInNewContext(job.if, { inputs: { lane } }),
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
      runInNewContext(gitJob.if, { inputs: { lane } }),
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
            needs: { preflight: { result: preflight }, slack: { result: slack } },
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
