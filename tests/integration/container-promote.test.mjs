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
    platform: "linux/amd64",
    digest,
    archiveSha256: "c".repeat(64),
    destination: `ghcr.io/openclaw/enterprise-${image}`,
    tag: `sha-${sourceSha}`,
  }));
  validateReceipt(receipt, env);
  for (const patch of [
    { sourceSha: "d".repeat(40) },
    { attempt: "3" },
    { ciRunId: "789" },
    { nodeBaseImage: "docker.io/library/node:24" },
    { tag: "latest" },
    { destination: receipt[0].destination },
  ]) {
    assert.throws(() => validateReceipt([receipt[0], { ...receipt[1], ...patch }], env));
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
  for (const patch of [
    { workflow_id: 1 },
    { head_sha: "d".repeat(40) },
    { event: "pull_request" },
    { conclusion: "failure" },
    { run_attempt: 3 },
  ]) {
    assert.throws(() => validatePublicationRun({ ...run, ...patch }, workflow, env));
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
  for (const patch of [
    { is_private: false },
    { is_private: undefined },
    { namespace: "other" },
    { name: "other" },
  ]) {
    assert.throws(() => validateHubRepository({ ...repo, ...patch }, image));
  }
  for (const invalid of [
    "",
    "example/image",
    "docker.io/library",
    `${image}:latest`,
    `ghcr.io/example/image`,
  ]) {
    assert.throws(() => hubRepositoryPath(invalid));
  }
});
