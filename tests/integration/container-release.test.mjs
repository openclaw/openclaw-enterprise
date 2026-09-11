import assert from "node:assert/strict";
import test from "node:test";
import {
  ghcrPackageName,
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

test("container release accepts only manual execution of the private main workflow", () => {
  validateContext(env, repo);
  for (const patch of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/tags/main" },
    { GITHUB_WORKFLOW_REF: `${repository}/${publishWorkflow}@refs/heads/contributor` },
    { GITHUB_SHA: "b".repeat(40) },
    { SOURCE_SHA: "main" },
    { GITHUB_REPOSITORY: "other/enterprise" },
  ]) {
    assert.throws(() => validateContext({ ...env, ...patch }, repo));
  }
  assert.throws(() => validateContext(env, { ...repo, private: false }));
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
