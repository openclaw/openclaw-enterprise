// Read only the two files produced before installing the local rehearsal.
// The parent takes expectedPlanHash from the trusted planner's successful stdout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function privateBytes(path, limit) {
  const handle = await open(path, constants.O_NOFOLLOW | constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= limit);
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes);
    assert.equal(bytesRead, stat.size);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function boundJSON(path, limit, hash) {
  assert.match(hash ?? "", /^[0-9a-f]{64}$/);
  const content = await privateBytes(path, limit);
  assert.equal(sha256(content), hash, "staging input changed");
  return JSON.parse(content.toString("utf8"));
}

export async function readStagedSignin({ directory, expectedPlanHash, workflowSha, installation }) {
  assert.ok(directory && isAbsolute(directory) && installation);
  assert.match(workflowSha ?? "", /^[a-f0-9]{40}$/);
  const plan = await boundJSON(
    join(directory, "staging-signin-plan.json"),
    128 * 1024,
    expectedPlanHash,
  );
  const staged = await boundJSON(
    join(directory, "staging-pair-images.json"),
    16 * 1024,
    plan.stagedImagesSha256,
  );
  assert.equal(staged.kind, "staged-controller-pair");
  assert.equal(plan.kind, "signin-rehearsal-expectations");
  for (const value of [plan, staged]) {
    assert.equal(value.installation, installation);
    assert.equal(value.workflowSha, workflowSha);
  }
  assert.ok(
    plan.candidate.version === 3 && (plan.previous.version === 2 || plan.previous.version === 3),
    "unknown sign-in contract",
  );
  assert.equal(plan.fixture, plan.previous.version === 2 ? "v2-to-v3" : "v3-to-v3");
  assert.ok(plan.catalogManifest?.version === 1 && Array.isArray(plan.catalogManifest.entries));
  assert.equal(staged.previousController.revision, plan.previous.source);
  assert.equal(staged.candidateController.revision, plan.candidate.source);
  assert.equal(staged.fixedRuntime.revision, plan.previous.source);
  const profiles = {
    P: Object.freeze(staged.previousController),
    A: Object.freeze(staged.candidateController),
  };
  function canAdmit(target, images, skew) {
    if (
      !Object.hasOwn(profiles, target) ||
      !Number.isSafeInteger(skew) ||
      skew < 0 ||
      skew >= Number.MAX_SAFE_INTEGER - 120000
    ) {
      return false;
    }
    const image = images?.[target];
    const expected = profiles[target];
    return (
      expected.platform === "linux/amd64" &&
      expected.reference.endsWith("@" + expected.rootDigest) &&
      ["reference", "rootDigest", "manifestDigest", "configDigest", "revision", "platform"].every(
        (field) => image?.[field] === expected[field],
      )
    );
  }
  return {
    signinPlan: plan,
    previous: profiles.P,
    candidate: profiles.A,
    fixedRuntime: Object.freeze(staged.fixedRuntime),
    canAdmit,
  };
}

export function assertHostedSigninJob(e) {
  assert.ok(
    e.GITHUB_ACTIONS === "true" &&
      e.RUNNER_ENVIRONMENT === "github-hosted" &&
      e.RUNNER_OS === "Linux" &&
      e.RUNNER_ARCH === "X64",
    "only the disposable hosted Linux/amd64 staging runner",
  );
  assert.equal(e.GITHUB_REPOSITORY, "openclaw/openclaw-enterprise");
  assert.equal(e.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(e.GITHUB_REF, "refs/heads/main");
  assert.equal(e.GITHUB_REF_PROTECTED, "true");
  assert.equal(e.GITHUB_JOB, "stage-pair");
  assert.equal(
    e.GITHUB_WORKFLOW_REF,
    "openclaw/openclaw-enterprise/.github/workflows/staging-qualification.yml@refs/heads/main",
  );
  assert.equal(e.GITHUB_SHA, e.GITHUB_WORKFLOW_SHA);
  assert.ok(e.STAGING_INSTALLATION && e.STAGING_INSTALLATION === e.CONFIGURED_STAGING_INSTALLATION);
  assert.ok(isAbsolute(e.RUNNER_TEMP ?? "") && isAbsolute(e.GITHUB_WORKSPACE ?? ""));
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "KUBECONFIG",
    "OPENAI_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OCC_DOCKER_BIN",
    "OCC_KUBECTL_BIN",
    "OPENCLAW_CI_K3D_BIN",
    "OPENCLAW_CI_K3S_IMAGE",
    "OCC_TEST_KUBERNETES_KUBECONFIG",
    "OCC_TEST_KUBERNETES_CONTEXT",
    "OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE",
    "OCC_TEST_PRODUCTION_TUI_REAL",
    "OCC_TEST_PRODUCTION_TUI_KEEP",
  ]) {
    assert.ok(!e[name], "staging preparation requires an isolated runner environment");
  }
  assert.match(e.GITHUB_RUN_ID ?? "", /^[1-9][0-9]*$/);
  assert.match(e.GITHUB_RUN_ATTEMPT ?? "", /^[1-9][0-9]*$/);
}

// The supervisor supplies the digest returned by this job's successful preparation.
// A cluster name or matching kubeconfig alone must never select a fixture.
export async function readPreparedSigninCluster(e, preparedHash, planHash, staged) {
  assertHostedSigninJob(e);
  const dir = join(e.RUNNER_TEMP, "staging-installed-signin");
  const picked = await boundJSON(join(dir, "prepared.json"), 32768, preparedHash);
  assert.equal(picked.kind, "staged-signin-cluster");
  assert.equal(picked.workflowSha, e.GITHUB_WORKFLOW_SHA);
  assert.equal(picked.installation, e.STAGING_INSTALLATION);
  assert.equal(picked.runId, e.GITHUB_RUN_ID);
  assert.equal(picked.runAttempt, e.GITHUB_RUN_ATTEMPT);
  assert.equal(picked.planSha256, planHash);
  assert.deepEqual(
    picked.release,
    [staged.previous, staged.candidate, staged.fixedRuntime].map((x) => ({
      image: x.reference,
      rootDigest: x.rootDigest,
      manifestDigest: x.manifestDigest,
      configDigest: x.configDigest,
    })),
  );
  assert.match(picked.cluster, /^openclaw-k8s-[a-z0-9-]+-[a-f0-9]{12}$/);
  assert.ok(picked.cluster.length <= 32);
  for (const uid of [picked.nodeUID, picked.clusterUID]) {
    assert.match(uid, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  }
  assert.match(picked.serverID, /^[a-f0-9]{64}$/);
  const state = await boundJSON(join(dir, "cluster-state.json"), 32768, picked.stateSha256);
  assert.equal(state.lane, "staging-signin");
  assert.equal(state.statePath, join(dir, "cluster-state.json"));
  assert.ok(state.version === 1 && state.resources?.length === 1);
  const [resource] = state.resources;
  assert.equal(resource.kind, "k3d-cluster");
  assert.equal(resource.status, "ready");
  assert.equal(resource.name, picked.cluster);
  assert.deepEqual(resource.nodes, [`k3d-${picked.cluster}-server-0`]);
  assert.equal(resource.owner, state.prefix);
  return picked;
}

// Absence, interruption and unconfirmed descendants are not cleanup authority.
// A settled nonzero exit can permit cleanup, never a successful qualification.
export async function readSettledSigninCase(e, preparedHash, planHash) {
  assertHostedSigninJob(e);
  for (const hash of [preparedHash, planHash]) {
    assert.match(hash ?? "", /^[a-f0-9]{64}$/);
  }
  const raw = await privateBytes(
    join(e.RUNNER_TEMP, "staging-installed-signin", "case-returned.json"),
    4096,
  );
  const returned = JSON.parse(raw.toString("utf8"));
  assert.deepEqual(returned.bindings, {
    OCC_TEST_SIGNIN_PLAN_SHA256: planHash,
    OCC_TEST_SIGNIN_PREPARED_SHA256: preparedHash,
    GITHUB_RUN_ID: e.GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT: e.GITHUB_RUN_ATTEMPT,
  });
  assert.ok(
    returned.version === 1 && returned.completed === true && returned.descendantsQuiescent === true,
    "case completion and descendant settlement required before cleanup",
  );
  assert.ok(
    returned.signal === null &&
      Number.isInteger(returned.exitCode) &&
      returned.exitCode >= 0 &&
      returned.exitCode <= 255 &&
      returned.exitCode === returned.returnCode,
    "normal child exit required before cleanup",
  );
  assert.ok(Number.isSafeInteger(returned.reapedDescendants) && returned.reapedDescendants >= 0);
  return { exitCode: returned.exitCode, sha256: sha256(raw) };
}
