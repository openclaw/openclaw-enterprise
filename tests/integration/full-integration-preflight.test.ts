import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertSourceRef,
  requiredEnvironmentsForLane,
  selectLane,
  validateEnvironmentPolicy,
  validateFullIntegrationPreflight,
} from "../../scripts/ci/full-integration-preflight.ts";

import {
  approvalApi,
  approvalEnvironment,
  approvalReview,
  integrationEnvironment,
  mainOnlyPolicies,
  mainRun,
} from "./full-integration-approval-fixture.ts";

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

test("full integration preflight selects automatic main pushes and manual main lanes", () => {
  assert.equal(selectLane({ eventName: "push", ref: "refs/heads/main" }), "all");
  assert.equal(
    selectLane({ eventName: "workflow_dispatch", inputLane: "docker-model" }),
    "docker-model",
  );
  for (const eventName of ["pull_request", "pull_request_target"]) {
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

test("verified docs pushes omit runtime lanes while keeping environment policy checks", async () => {
  const fetched: string[] = [];
  assert.deepEqual(
    await validateFullIntegrationPreflight({
      env: mainRun,
      github: approvalApi({}, fetched),
      impactMode: "docs",
    }),
    { selectedLane: "docs", runAll: false },
  );
  assert.deepEqual(fetched, [
    "/environments/integration-main",
    "/environments/integration-main/deployment-branch-policies",
  ]);
  await assert.rejects(
    validateFullIntegrationPreflight({
      env: mainRun,
      github: approvalApi({
        "/environments/integration-main": { ...integrationEnvironment(), can_admins_bypass: true },
      }),
      impactMode: "docs",
    }),
    /disable administrator bypass/,
  );
  assert.equal(
    selectLane({ eventName: "workflow_dispatch", inputLane: "all", impactMode: "docs" }),
    "all",
  );
  assert.equal(
    selectLane({ eventName: "push", ref: "refs/heads/main", impactMode: "tests" }),
    "all",
  );
});

test("main pushes and retries require no manual approval or team credential", async () => {
  for (const attempt of ["1", "2"]) {
    const fetched: string[] = [];
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
    const fetched: string[] = [];
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
      const fetched: string[] = [];
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
    const fetched: string[] = [];
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
    const fetched: string[] = [];
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
    const fetched: string[] = [];
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
    const fetched: string[] = [];
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

test("scheduled preflight CLI annotates only classified Actions history holds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "full-integration-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, "fetch-fixture.mjs");
  const output = join(directory, "github-output");
  const sha = "a".repeat(40);
  const mainRef = (sha: string) => ({ ref: "refs/heads/main", object: { type: "commit", sha } });
  const admissionMarkers = "/actions/artifacts?name=full-integration-admitted-v1&per_page=100";
  const responses = {
    "/git/ref/heads/main": mainRef(sha),
    [admissionMarkers]: { artifacts: [], total_count: 0 },
    "/actions/workflows/351990468/runs?branch=main&event=push&per_page=100&page=1": {
      workflow_runs: [],
      total_count: 0,
    },
    "/actions/workflows/351990468/runs?branch=main&event=workflow_dispatch&per_page=100&page=1": {
      workflow_runs: [],
      total_count: 0,
    },
    [`/actions/artifacts?name=full-integration-exercised-v1-${sha}&per_page=100`]: {
      artifacts: [],
      total_count: 0,
    },
    "/environments/integration-main": integrationEnvironment(),
    "/environments/integration-main/deployment-branch-policies": mainOnlyPolicies,
  };
  const malformedMarkers = {
    [admissionMarkers]: { artifacts: "synthetic-history-response", total_count: 1 },
  };
  const holdMessage =
    "Full Integration schedule could not verify admission metadata (admission-markers: invalid-metadata).";

  async function run(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
    await writeFile(output, "");
    await writeFile(
      preload,
      `const responses = ${JSON.stringify({ ...responses, ...overrides })};
const prefix = "https://api.github.com/repos/openclaw/openclaw-enterprise";
globalThis.fetch = async (input) => {
  const url = new URL(input);
  const path = url.href.slice(prefix.length);
  if (!url.href.startsWith(prefix + "/") || !Object.hasOwn(responses, path)) {
    throw new Error("Unexpected GitHub fixture request");
  }
  return Response.json(responses[path]);
};
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", preload, "scripts/ci/full-integration-preflight.ts"],
      {
        env: {
          ...mainRun,
          GITHUB_EVENT_NAME: "schedule",
          GITHUB_SHA: sha,
          GITHUB_ACTIONS: "true",
          GITHUB_OUTPUT: output,
          ...env,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.error, undefined);
    return { ...result, output: await readFile(output, "utf8") };
  }

  await t.test("classified Actions history hold", async () => {
    const result = await run(malformedMarkers);
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
    assert.equal(result.stderr, holdMessage + "\n");
    assert.equal(
      result.stdout,
      "::error title=Full Integration schedule::admission-markers: invalid-metadata\n",
    );
  });

  await t.test("classified hold outside Actions", async () => {
    const result = await run(malformedMarkers, { GITHUB_ACTIONS: "false" });
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
    assert.equal(result.stderr, holdMessage + "\n");
    assert.equal(result.stdout, "");
  });

  await t.test("scheduled rerun refused before history", async () => {
    const result = await run(malformedMarkers, { GITHUB_RUN_ATTEMPT: "2" });
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
    assert.equal(
      result.stderr,
      "Scheduled integration reruns are refused; start a new approved dispatch.\n",
    );
    assert.equal(result.stdout, "");
  });

  await t.test("unrelated protected environment failure", async () => {
    const result = await run({
      "/environments/integration-main": integrationEnvironment({ can_admins_bypass: true }),
    });
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
    assert.equal(
      result.stderr,
      "Protected environment integration-main must disable administrator bypass.\n",
    );
    assert.equal(result.stdout, "");
  });

  await t.test("scheduled admission succeeds", async () => {
    const result = await run();
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "Full Integration authorized by scheduled admission.\n");
    assert.equal(result.output, "selected_lane=all\nrun_all=true\n");
  });

  await t.test("stale event is skipped with a notice", async () => {
    const result = await run({ "/git/ref/heads/main": mainRef("b".repeat(40)) });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      "::notice title=Full Integration schedule::Full Integration schedule skipped: stale-event.\n",
    );
    assert.equal(result.output, "selected_lane=skip\nrun_all=false\n");
  });
});
