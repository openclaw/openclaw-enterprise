import assert from "node:assert/strict";
import test from "node:test";
import {
  ghcrPackageName,
  github,
  repository,
  publishWorkflow,
  validateCi,
  validateContext,
  validateEnvironment,
  validatePackage,
  validatePreparedImage,
} from "../../scripts/ci/container-release.mjs";

const sourceSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const env = {
  GITHUB_REPOSITORY: repository,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: `${repository}/${publishWorkflow}@refs/heads/main`,
  GITHUB_WORKFLOW_SHA: sourceSha,
  GITHUB_SHA: sourceSha,
  SOURCE_SHA: sourceSha,
};
const repo = { full_name: repository, private: true, default_branch: "main" };

test("container release requires manual execution of the trusted main workflow", () => {
  for (const context of [
    { env, repo },
    { env: { ...env, PUBLISH: "false" }, repo: { ...repo, private: false } },
  ]) {
    validateContext(context.env, context.repo);
    for (const patch of [
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_REF: "refs/tags/main" },
      { GITHUB_WORKFLOW_REF: `${repository}/${publishWorkflow}@refs/heads/contributor` },
      { GITHUB_WORKFLOW_SHA: "main" },
      { GITHUB_SHA: "b".repeat(40) },
      { SOURCE_SHA: "main" },
      { GITHUB_REPOSITORY: "other/enterprise" },
    ]) {
      assert.throws(() => validateContext({ ...context.env, ...patch }, context.repo));
    }
    for (const patch of [{ full_name: "other/enterprise" }, { default_branch: "other" }]) {
      assert.throws(() => validateContext(context.env, { ...context.repo, ...patch }));
    }
  }
});

test("public container preparation requires the exact false string", () => {
  validateContext({ ...env, PUBLISH: "false" }, { ...repo, private: false });
  validateContext({ ...env, PUBLISH: "false" }, repo);
  for (const PUBLISH of ["true", undefined, "", "FALSE", "0", false]) {
    validateContext({ ...env, PUBLISH }, repo);
    assert.throws(
      () => validateContext({ ...env, PUBLISH }, { ...repo, private: false }),
      /Publication requires the private Enterprise repository/,
    );
  }
});

for (const workflow of [
  ".github/workflows/container-promote.yml",
  ".github/workflows/container-bootstrap.yml",
]) {
  test(`${workflow} retains private source and workflow identity even with PUBLISH false`, () => {
    const promotion = {
      ...env,
      GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/main`,
    };
    for (const PUBLISH of [undefined, "true", "false"]) {
      validateContext({ ...promotion, PUBLISH }, repo, workflow);
      assert.throws(
        () => validateContext({ ...promotion, PUBLISH }, { ...repo, private: false }, workflow),
        /Publication requires the private Enterprise repository/,
      );
    }
    assert.throws(() => validateContext({ ...env, PUBLISH: "false" }, repo, workflow));
  });
}

test("only explicit bootstrap lookups tolerate missing package metadata", async (t) => {
  // The external API supplies status codes; the real client must distinguish
  // absence from authorization failures before harmless bootstrap is permitted.
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "test-token";
  t.after(() => {
    if (token === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = token;
    }
  });
  for (const status of [401, 403, 404, 429, 500]) {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status }));
    await assert.rejects(
      github("orgs/openclaw/packages/container/example"),
      new RegExp(`\\(${status}\\)`),
    );
    const lookup = github("orgs/openclaw/packages/container/example", { allowNotFound: true });
    if (status === 404) {
      assert.equal(await lookup, null);
    } else {
      await assert.rejects(lookup, new RegExp(`\\(${status}\\)`));
    }
    t.mock.restoreAll();
  }
  const pkg = { name: "example", visibility: "private" };
  t.mock.method(globalThis, "fetch", async () => Response.json(pkg));
  assert.deepEqual(
    await github("orgs/openclaw/packages/container/example", { allowNotFound: true }),
    pkg,
  );
});

test("container context rejects malformed repository privacy in preparation and publication", () => {
  for (const privateValue of [undefined, null, "false", "true", 0, 1, {}, []]) {
    for (const PUBLISH of ["false", "true", undefined]) {
      assert.throws(() => validateContext({ ...env, PUBLISH }, { ...repo, private: privateValue }));
    }
  }
});

test("container release requires exact successful CI identity and its aggregate job", () => {
  // Shapes follow the Actions workflow, workflow-run, and attempt-jobs REST responses.
  const workflow = { id: 123, path: ".github/workflows/ci.yml", state: "active" };
  const run = {
    id: 456,
    workflow_id: 123,
    path: workflow.path,
    repository: repo,
    head_repository: repo,
    head_sha: sourceSha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
  };
  const jobs = [
    { name: "CI Required", head_sha: sourceSha, conclusion: "success", status: "completed" },
  ];
  validateCi(run, workflow, jobs, sourceSha, "456", "2");
  for (const patch of [
    { workflow_id: 999 },
    { head_sha: "b".repeat(40) },
    { head_branch: "feature" },
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { run_attempt: 3 },
    { head_repository: { full_name: "other/enterprise" } },
  ]) {
    assert.throws(() => validateCi({ ...run, ...patch }, workflow, jobs, sourceSha, "456", "2"));
  }
  for (const invalidJobs of [[], [...jobs, ...jobs], [{ ...jobs[0], conclusion: "skipped" }]]) {
    assert.throws(() => validateCi(run, workflow, invalidJobs, sourceSha, "456", "2"));
  }
});

test("container publication rejects unprotected environments and public or unrelated packages", () => {
  const environment = {
    name: "container-publish",
    can_admins_bypass: false,
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "Team", reviewer: { id: 1 } }],
      },
    ],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  };
  const policies = [{ name: "main", type: "branch" }];
  validateEnvironment(environment, policies);
  assert.throws(() => validateEnvironment({ ...environment, can_admins_bypass: true }, policies));
  assert.throws(() =>
    validateEnvironment({ ...environment, can_admins_bypass: undefined }, policies),
  );
  assert.throws(() => validateEnvironment({ ...environment, protection_rules: [] }, policies));
  assert.throws(() => validateEnvironment(environment, [{ name: "*", type: "branch" }]));
  assert.throws(() => validateEnvironment(environment, [{ name: "main", type: "tag" }]));
  const image = "ghcr.io/openclaw/openclaw-enterprise/controller";
  const pkg = {
    name: "openclaw-enterprise/controller",
    package_type: "container",
    visibility: "private",
    repository: repo,
  };
  validatePackage(pkg, image);
  assert.throws(() => validatePackage({ ...pkg, visibility: "public" }, image));
  assert.throws(() => validatePackage({ ...pkg, repository: { ...repo, private: false } }, image));
  assert.throws(() =>
    validatePackage({ ...pkg, repository: { full_name: "openclaw/openclaw" } }, image),
  );
  assert.throws(() => validatePackage({ ...pkg, name: "other" }, image));
  for (const destination of [
    "",
    "ghcr.io/other/controller",
    `${image}:latest`,
    `${image}@${digest}`,
    "docker.io/openclaw/controller",
  ]) {
    assert.throws(() => ghcrPackageName(destination));
  }
});

test("prepared OCI metadata cannot cross source, image, attempt, CI or base-image boundaries", () => {
  const expected = {
    sourceSha,
    workflowSha: sourceSha,
    runId: "123",
    attempt: "2",
    ciRunId: "456",
    ciAttempt: "1",
    nodeBaseImage: `docker.io/library/node:24-bookworm@${digest}`,
    image: "controller",
  };
  const metadata = { ...expected, platform: "linux/amd64", digest, archiveSha256: "c".repeat(64) };
  validatePreparedImage(metadata, expected);
  for (const key of Object.keys(expected)) {
    assert.throws(() => validatePreparedImage({ ...metadata, [key]: "different" }, expected));
  }
  assert.throws(() => validatePreparedImage({ ...metadata, digest: "latest" }, expected));
  assert.throws(() => validatePreparedImage({ ...metadata, platform: "linux/arm64" }, expected));
});
