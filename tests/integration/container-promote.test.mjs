import assert from "node:assert/strict";
import test from "node:test";
import {
  hubRepositoryPath,
  validateHubRepository,
  validatePublicationRun,
  validateReceipt,
} from "../../scripts/ci/container-promote.mjs";
import { repository, publishWorkflow } from "../../scripts/ci/container-release.mjs";

const sourceSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const env = {
  SOURCE_SHA: sourceSha,
  PUBLICATION_RUN_ID: "123",
  PUBLICATION_ATTEMPT: "2",
  NODE_BASE_IMAGE: `docker.io/library/node:24-bookworm@${digest}`,
};

test("Docker Hub promotion rejects receipts from another source, CI run or publication attempt", () => {
  const receipt = ["controller", "runtime"].map((image) => ({
    image,
    sourceSha,
    workflowSha: sourceSha,
    runId: "123",
    attempt: "2",
    ciRunId: "456",
    ciAttempt: "1",
    nodeBaseImage: env.NODE_BASE_IMAGE,
    platforms: ["linux/amd64", "linux/arm64"],
    digest,
    archiveSha256: "c".repeat(64),
    destination: `ghcr.io/openclaw/enterprise-${image}`,
    tag: `sha-${sourceSha}`,
  }));
  validateReceipt(receipt, env);
  // Each rejection names the guard that must refuse it, so removing any one guard fails.
  const runtime = (patch) => [receipt[0], { ...receipt[1], ...patch }];
  const prepared = (key) => ({ message: new RegExp(`^Prepared image ${key} does not match`) });
  for (const [changed, changedEnv, guard] of [
    [{}, env, { name: "AssertionError", actual: false, expected: true }],
    [[receipt[1], receipt[0]], env, { operator: "deepStrictEqual" }],
    [[{ ...receipt[0], ciRunId: "0" }, receipt[1]], env, { operator: "match", actual: "0" }],
    [[{ ...receipt[0], ciAttempt: "x" }, receipt[1]], env, { operator: "match", actual: "x" }],
    [
      receipt,
      { ...env, NODE_BASE_IMAGE: "docker.io/library/node:24" },
      { operator: "match", actual: "docker.io/library/node:24" },
    ],
    [runtime({ sourceSha: "d".repeat(40) }), env, prepared("sourceSha")],
    [runtime({ attempt: "3" }), env, prepared("attempt")],
    [runtime({ ciRunId: "789" }), env, prepared("ciRunId")],
    [runtime({ nodeBaseImage: "docker.io/library/node:24" }), env, prepared("nodeBaseImage")],
    [runtime({ tag: "latest" }), env, { actual: "latest", expected: `sha-${sourceSha}` }],
    [runtime({ destination: receipt[0].destination }), env, { operator: "notStrictEqual" }],
  ]) {
    assert.throws(() => validateReceipt(changed, changedEnv), guard);
  }
  const workflow = { id: 789, path: publishWorkflow, state: "active" };
  const run = {
    id: 123,
    run_attempt: 2,
    workflow_id: 789,
    path: publishWorkflow,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_branch: "main",
    head_sha: sourceSha,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
  };
  validatePublicationRun(run, workflow, env);
  const other = ".github/workflows/other.yml";
  for (const [changedRun, changedWorkflow, changedEnv, guard] of [
    [run, workflow, { ...env, PUBLICATION_RUN_ID: "0" }, { operator: "match", actual: "0" }],
    [run, workflow, { ...env, PUBLICATION_ATTEMPT: "x" }, { operator: "match", actual: "x" }],
    [{ ...run, id: 124 }, workflow, env, { actual: "124", expected: "123" }],
    [{ ...run, run_attempt: 3 }, workflow, env, { actual: "3", expected: "2" }],
    [run, { ...workflow, path: other }, env, { actual: other, expected: publishWorkflow }],
    [run, { ...workflow, state: "disabled_manually" }, env, { actual: "disabled_manually" }],
    [{ ...run, workflow_id: 1 }, workflow, env, { actual: 1, expected: 789 }],
    [{ ...run, path: other }, workflow, env, { actual: other, expected: publishWorkflow }],
    [
      { ...run, repository: { full_name: "other/enterprise" } },
      workflow,
      env,
      { actual: "other/enterprise", expected: repository },
    ],
    [
      { ...run, head_repository: { full_name: "fork/enterprise" } },
      workflow,
      env,
      { actual: "fork/enterprise", expected: repository },
    ],
    [{ ...run, head_branch: "feature" }, workflow, env, { actual: "feature", expected: "main" }],
    [{ ...run, head_sha: "d".repeat(40) }, workflow, env, { actual: "d".repeat(40) }],
    [{ ...run, event: "pull_request" }, workflow, env, { actual: "pull_request" }],
    [{ ...run, status: "in_progress" }, workflow, env, { actual: "in_progress" }],
    [{ ...run, conclusion: "failure" }, workflow, env, { actual: "failure", expected: "success" }],
  ]) {
    assert.throws(() => validatePublicationRun(changedRun, changedWorkflow, changedEnv), guard);
  }
});

test("Docker Hub promotion requires an exact pre-existing private repository", () => {
  const image = "docker.io/example/enterprise-controller";
  const repo = { namespace: "example", name: "enterprise-controller", is_private: true };
  assert.equal(
    hubRepositoryPath(image),
    "/v2/namespaces/example/repositories/enterprise-controller",
  );
  validateHubRepository(repo, image);
  const notPrivate = { message: /^Docker Hub repository must already exist and be private\./ };
  for (const [patch, guard] of [
    [{ is_private: false }, notPrivate],
    [{ is_private: undefined }, notPrivate],
    [{ namespace: "other" }, { actual: "other", expected: "example" }],
    [{ name: "other" }, { actual: "other", expected: "enterprise-controller" }],
  ]) {
    assert.throws(() => validateHubRepository({ ...repo, ...patch }, image), guard);
  }
  for (const invalid of [
    "",
    "example/image",
    "docker.io/library",
    `${image}:latest`,
    `ghcr.io/example/image`,
  ]) {
    assert.throws(() => hubRepositoryPath(invalid), {
      message: /^Set an explicit Docker Hub namespace\/repository without a tag or digest\./,
    });
  }
});
