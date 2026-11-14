// Read only the two files produced before installing the local rehearsal.
// The parent takes expectedPlanHash from the trusted planner's successful stdout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { asRecord } from "../../../packages/utils/src/index.ts";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function assertSigninHash(hash: unknown): asserts hash is string {
  assert.ok(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
}

async function privateBytes(path: string, limit: number) {
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

function jsonRecord(raw: Buffer) {
  const parsed: unknown = JSON.parse(raw.toString("utf8"));
  const record = asRecord(parsed);
  assert.ok(record);
  return record;
}

async function boundJSON(path: string, limit: number, hash: unknown) {
  assertSigninHash(hash);
  const content = await privateBytes(path, limit);
  assert.equal(sha256(content), hash, "staging input changed");
  return jsonRecord(content);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

const imageFields = [
  "reference",
  "rootDigest",
  "manifestDigest",
  "configDigest",
  "revision",
  "platform",
] as const;

type StagedImage = Record<(typeof imageFields)[number], string>;

function isStagedImage(value: unknown): value is StagedImage {
  const image = asRecord(value);
  return image !== undefined && imageFields.every((field) => typeof image[field] === "string");
}

type StagedSigninInputs = {
  directory: string | undefined;
  expectedPlanHash: string | undefined;
  workflowSha: string | undefined;
  installation: string | undefined;
};

type PlanRelease<Version extends 2 | 3> = {
  version: Version;
  source: string;
  // Only the installed chart consumes reviewedSource. Cleanup plans may omit it.
  reviewedSource?: unknown;
  buildInputs?: unknown;
};

function isPlanRelease<Version extends 2 | 3>(
  value: unknown,
  ...versions: Version[]
): value is PlanRelease<Version> {
  const release = asRecord(value);
  return (
    typeof release?.source === "string" && versions.some((version) => version === release.version)
  );
}

export async function readStagedSignin({
  directory,
  expectedPlanHash,
  workflowSha,
  installation,
}: StagedSigninInputs) {
  assert.ok(directory && isAbsolute(directory) && installation);
  assert.ok(typeof workflowSha === "string");
  assert.match(workflowSha, /^[a-f0-9]{40}$/);
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
  const { previous, candidate } = plan;
  assert.ok(
    isPlanRelease(candidate, 3) && isPlanRelease(previous, 2, 3),
    "unknown sign-in contract",
  );
  const fixture = previous.version === 2 ? "v2-to-v3" : "v3-to-v3";
  assert.equal(plan.fixture, fixture);
  const catalogManifest = asRecord(plan.catalogManifest);
  assert.ok(catalogManifest?.version === 1 && isUnknownArray(catalogManifest.entries));
  const { previousController, candidateController, fixedRuntime } = staged;
  assert.ok(
    isStagedImage(previousController) &&
      isStagedImage(candidateController) &&
      isStagedImage(fixedRuntime),
  );
  assert.equal(previousController.revision, previous.source);
  assert.equal(candidateController.revision, candidate.source);
  assert.equal(fixedRuntime.revision, previous.source);
  const profiles = {
    P: Object.freeze(previousController),
    A: Object.freeze(candidateController),
  };
  function canAdmit(target: unknown, images: unknown, skew: unknown) {
    if (
      (target !== "P" && target !== "A") ||
      typeof skew !== "number" ||
      !Number.isSafeInteger(skew) ||
      skew < 0 ||
      skew >= Number.MAX_SAFE_INTEGER - 120000
    ) {
      return false;
    }
    const image = asRecord(asRecord(images)?.[target]);
    const expected = profiles[target];
    return (
      expected.platform === "linux/amd64" &&
      expected.reference.endsWith("@" + expected.rootDigest) &&
      imageFields.every((field) => image?.[field] === expected[field])
    );
  }
  return {
    signinPlan: {
      ...plan,
      workflowSha,
      fixture,
      previous,
      candidate,
      catalogManifest: {
        ...catalogManifest,
        version: catalogManifest.version,
        entries: catalogManifest.entries,
      },
    },
    previous: profiles.P,
    candidate: profiles.A,
    fixedRuntime: Object.freeze(fixedRuntime),
    canAdmit,
  };
}

type HostedSigninEnvironment = NodeJS.ProcessEnv & {
  GITHUB_WORKSPACE: string;
  RUNNER_TEMP: string;
  GITHUB_RUN_ID: string;
  GITHUB_RUN_ATTEMPT: string;
  STAGING_INSTALLATION: string;
};

export function assertHostedSigninJob(e: NodeJS.ProcessEnv): asserts e is HostedSigninEnvironment {
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

type StagedRelease = {
  previous: Readonly<StagedImage>;
  candidate: Readonly<StagedImage>;
  fixedRuntime: Readonly<StagedImage>;
};

export function signinReleaseImages({ previous, candidate, fixedRuntime }: StagedRelease) {
  return [previous, candidate, fixedRuntime].map(
    ({ reference, rootDigest, manifestDigest, configDigest }) => ({
      image: reference,
      rootDigest,
      manifestDigest,
      configDigest,
    }),
  );
}

// The supervisor supplies the digest returned by this job's successful preparation.
// A cluster name or matching kubeconfig alone must never select a fixture.
export async function readPreparedSigninCluster(
  e: NodeJS.ProcessEnv,
  preparedHash: string | undefined,
  planHash: string | undefined,
  staged: StagedRelease,
) {
  assertHostedSigninJob(e);
  const dir = join(e.RUNNER_TEMP, "staging-installed-signin");
  const picked = await boundJSON(join(dir, "prepared.json"), 32768, preparedHash);
  assert.equal(picked.kind, "staged-signin-cluster");
  assert.equal(picked.workflowSha, e.GITHUB_WORKFLOW_SHA);
  assert.equal(picked.installation, e.STAGING_INSTALLATION);
  assert.equal(picked.runId, e.GITHUB_RUN_ID);
  assert.equal(picked.runAttempt, e.GITHUB_RUN_ATTEMPT);
  assert.equal(picked.planSha256, planHash);
  assert.deepEqual(picked.release, signinReleaseImages(staged));
  const { cluster, nodeUID, clusterUID, serverID, stateSha256 } = picked;
  assert.ok(typeof cluster === "string" && cluster.length <= 32);
  assert.match(cluster, /^openclaw-k8s-[a-z0-9-]+-[a-f0-9]{12}$/);
  const uid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  assert.ok(typeof nodeUID === "string" && typeof clusterUID === "string");
  assert.match(nodeUID, uid);
  assert.match(clusterUID, uid);
  assert.ok(typeof serverID === "string");
  assert.match(serverID, /^[a-f0-9]{64}$/);
  assertSigninHash(stateSha256);
  const statePath = join(dir, "cluster-state.json");
  const state = await boundJSON(statePath, 32768, stateSha256);
  assert.equal(state.lane, "staging-signin");
  assert.equal(state.statePath, statePath);
  assert.ok(state.version === 1 && isUnknownArray(state.resources) && state.resources.length === 1);
  const resource = asRecord(state.resources[0]);
  assert.ok(resource);
  assert.equal(resource.kind, "k3d-cluster");
  assert.equal(resource.status, "ready");
  assert.equal(resource.name, cluster);
  assert.deepEqual(resource.nodes, [`k3d-${cluster}-server-0`]);
  assert.ok(typeof state.prefix === "string" && state.prefix);
  assert.equal(resource.owner, state.prefix);
  return {
    ...picked,
    cluster,
    nodeUID,
    clusterUID,
    serverID,
    stateSha256,
    runId: picked.runId,
    runAttempt: picked.runAttempt,
    support: picked.support,
    membership: picked.membership,
    release: picked.release,
  };
}

// Absence, interruption and unconfirmed descendants are not cleanup authority.
// A settled nonzero exit can permit cleanup, never a successful qualification.
export async function readSettledSigninCase(
  e: NodeJS.ProcessEnv,
  preparedHash: string | undefined,
  planHash: string | undefined,
) {
  assertHostedSigninJob(e);
  assertSigninHash(preparedHash);
  assertSigninHash(planHash);
  const raw = await privateBytes(
    join(e.RUNNER_TEMP, "staging-installed-signin", "case-returned.json"),
    4096,
  );
  const returned = jsonRecord(raw);
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
  const { exitCode, reapedDescendants } = returned;
  assert.ok(
    returned.signal === null &&
      typeof exitCode === "number" &&
      Number.isInteger(exitCode) &&
      exitCode >= 0 &&
      exitCode <= 255 &&
      exitCode === returned.returnCode,
    "normal child exit required before cleanup",
  );
  assert.ok(
    typeof reapedDescendants === "number" &&
      Number.isSafeInteger(reapedDescendants) &&
      reapedDescendants >= 0,
  );
  return { exitCode, sha256: sha256(raw) };
}
