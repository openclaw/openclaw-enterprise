import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cleanupState, deleteOwnedK3dCluster } from "../../scripts/ci/cleanup.mjs";
import { prepareStagingSigninCluster } from "../../scripts/ci/prepare.mjs";
import {
  assertLocalRehearsalDaemon,
  bindLocalRehearsalCluster,
  runFixtureCommand,
} from "../helpers/production-rehearsal-custody.ts";
import { availablePort } from "../helpers/available-port.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const selected = process.env.OCC_TEST_STAGED_SIGNIN_CLEANUP_REAL === "1";
const evidenceRoot = process.env.OCC_TEST_STAGED_SIGNIN_CLEANUP_ARTIFACT_DIR;
const run = (command, args, options) => runFixtureCommand(command, args, options, String, true);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const lines = (text) => text.trim().split(/\r?\n/u).filter(Boolean).sort();

async function jsonFile(path, value) {
  const bytes = JSON.stringify(value) + "\n";
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return hash(bytes);
}

async function absent(path) {
  await assert.rejects(readFile(path), { code: "ENOENT" });
}

async function assertRemoved(owned) {
  assert.ok(!lines(await run("docker", ["ps", "-aq", "--no-trunc"])).includes(owned.serverID));
  assert.ok(
    !lines(await run("docker", ["network", "ls", "-q", "--no-trunc"])).includes(
      owned.membership.networkID,
    ),
  );
  const volumes = lines(await run("docker", ["volume", "ls", "-q"]));
  for (const volume of owned.membership.volumes) {
    assert.ok(!volumes.includes(volume.name), `owned volume remains: ${volume.name}`);
  }
}

async function assertVolumesRetained(owned) {
  for (const volume of owned.membership.volumes) {
    const info = JSON.parse(await run("docker", ["volume", "inspect", volume.name]));
    assert.equal(info[0].Name, volume.name);
    assert.equal(info[0].CreatedAt, volume.createdAt);
  }
}

async function capture(cluster, path) {
  const bound = await bindLocalRehearsalCluster(run, cluster, path);
  return {
    bound,
    owned: {
      cluster,
      clusterUID: bound.clusterUID,
      nodeUID: bound.nodeUID,
      serverID: bound.serverID,
      membership: await bound.cleanupIdentity(),
    },
  };
}

// These are explicitly synthetic job/release/settlement bindings. Actual cluster
// identities and CI state come from their real owners. No successful sign-in or
// hosted qualification is fabricated, and no model or release image is needed.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "oce-signin-cleanup-"));
  const work = join(directory, "staging-installed-signin");
  await mkdir(work);
  await mkdir(join(work, "home"));
  await mkdir(join(work, "docker"));
  const originalEnv = process.env;
  const workflowSha = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).trim();
  assert.equal(
    await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root }),
    "",
  );
  process.env = {
    PATH: `${dirname(process.execPath)}:${originalEnv.PATH}`,
    HOME: join(work, "home"),
    DOCKER_CONFIG: join(work, "docker"),
    DOCKER_HOST: "unix:///var/run/docker.sock",
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    RUNNER_TEMP: directory,
    GITHUB_WORKSPACE: root,
    GITHUB_SHA: workflowSha,
    GITHUB_WORKFLOW_SHA: workflowSha,
    GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_PROTECTED: "true",
    GITHUB_JOB: "stage-pair",
    GITHUB_WORKFLOW_REF:
      "openclaw/openclaw-enterprise/.github/workflows/staging-qualification.yml@refs/heads/main",
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
    STAGING_INSTALLATION: "cleanup-fixture",
    CONFIGURED_STAGING_INSTALLATION: "cleanup-fixture",
  };
  const statePath = join(work, "cluster-state.json");
  const captures = [];
  let extraContainer;
  let assertionsPassed = false;
  // Register ownership before creation. This cleanup is independent of the CLI
  // assertions, so it cannot turn a refused or partial deletion into a pass.
  t.after(async () => {
    const errors = [];
    if (extraContainer) {
      await run("docker", ["rm", "-f", extraContainer]).catch((error) => errors.push(error));
    }
    await cleanupState(statePath).catch((error) => errors.push(error));
    for (const owned of captures) {
      await assertRemoved(owned).catch((error) => errors.push(error));
    }
    process.env = originalEnv;
    if (evidenceRoot) {
      await mkdir(evidenceRoot, { recursive: true });
      await jsonFile(join(evidenceRoot, `${t.name}-outcome.json`), {
        source: workflowSha,
        proof: "real Docker effects under synthetic job/release/settlement bindings",
        assertionsPassed,
        cleanupPassed: errors.length === 0,
        identities: captures,
        ...(errors.length ? { retainedDirectory: directory } : {}),
      });
    }
    if (errors.length) {
      throw new AggregateError(errors, `cleanup failed; retained state at ${directory}`);
    }
    await rm(directory, { recursive: true, force: true });
  });
  await assertLocalRehearsalDaemon(run);
  const beforeVolumes = new Set(lines(await run("docker", ["volume", "ls", "-q"])));
  const resource = await prepareStagingSigninCluster(statePath);
  const current = await capture(resource.name, join(work, "original-kubeconfig"));
  captures.push(current.owned);
  assert.ok(current.owned.membership.volumes.every((v) => !beforeVolumes.has(v.name)));
  const image = {
    reference: "fixture.invalid/controller@sha256:" + "1".repeat(64),
    rootDigest: "sha256:" + "1".repeat(64),
    manifestDigest: "sha256:" + "2".repeat(64),
    configDigest: "sha256:" + "3".repeat(64),
    revision: workflowSha,
    platform: "linux/amd64",
  };
  const stagedImagesSha256 = await jsonFile(join(directory, "staging-pair-images.json"), {
    kind: "staged-controller-pair",
    installation: "cleanup-fixture",
    workflowSha,
    previousController: image,
    candidateController: image,
    fixedRuntime: image,
  });
  const planHash = await jsonFile(join(directory, "staging-signin-plan.json"), {
    kind: "signin-rehearsal-expectations",
    installation: "cleanup-fixture",
    workflowSha,
    stagedImagesSha256,
    previous: { version: 3, source: workflowSha },
    candidate: { version: 3, source: workflowSha },
    fixture: "v3-to-v3",
    catalogManifest: { version: 1, entries: [] },
  });
  const preparedHash = await jsonFile(join(work, "prepared.json"), {
    ...current.owned,
    kind: "staged-signin-cluster",
    workflowSha,
    installation: "cleanup-fixture",
    runId: "1",
    runAttempt: "1",
    planSha256: planHash,
    stateSha256: hash(await readFile(statePath)),
    release: [image, image, image].map(
      ({ reference, rootDigest, manifestDigest, configDigest }) => ({
        image: reference,
        rootDigest,
        manifestDigest,
        configDigest,
      }),
    ),
  });
  await jsonFile(join(work, "case-returned.json"), {
    version: 1,
    bindings: {
      OCC_TEST_SIGNIN_PLAN_SHA256: planHash,
      OCC_TEST_SIGNIN_PREPARED_SHA256: preparedHash,
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
    },
    completed: true,
    descendantsQuiescent: true,
    reapedDescendants: 0,
    exitCode: 1,
    returnCode: 1,
    signal: null,
  });
  return {
    ...current,
    resource,
    work,
    directory,
    captures,
    setExtraContainer(id) {
      extraContainer = id;
    },
    passed() {
      assertionsPassed = true;
    },
    async cleanup() {
      const result = await execute(
        process.execPath,
        ["scripts/ci/cleanup-staged-signin.mjs", planHash, preparedHash],
        { cwd: root, env: process.env, timeout: 360_000, maxBuffer: 1024 * 1024 },
      ).then(
        () => {
          throw new Error("failed sign-in case unexpectedly qualified");
        },
        (error) => error,
      );
      assert.equal(
        result.code,
        1,
        "cleanup must preserve the failed case, not time out or receive a signal",
      );
      assert.match(result.stderr, /installed sign-in runner failed/);
      await absent(join(directory, "staging-signin-qualification.json"));
      if (evidenceRoot) {
        await mkdir(evidenceRoot, { recursive: true });
        await jsonFile(join(evidenceRoot, `${t.name}.json`), {
          source: workflowSha,
          proof: "real Docker effects under synthetic job/release/settlement bindings",
          original: current.owned,
          exitCode: result.code,
          stderr: result.stderr,
        });
      }
      return result;
    },
  };
}

const options = {
  skip: selected
    ? false
    : "Set OCC_TEST_STAGED_SIGNIN_CLEANUP_REAL=1 on an isolated local Docker host.",
  timeout: 900_000,
  concurrency: false,
};

test("staged sign-in cleans owned resources after a settled failed case", options, async (t) => {
  const f = await fixture(t);
  await f.cleanup();
  await assertRemoved(f.owned);
  const receipt = JSON.parse(await readFile(join(f.work, "cleanup.json"), "utf8"));
  assert.equal(receipt.removed, true);
  assert.equal(receipt.caseExitCode, 1);
  f.passed();
});

test("staged sign-in refuses a replacement cluster", options, async (t) => {
  const f = await fixture(t);
  await deleteOwnedK3dCluster(f.resource);
  await assertRemoved(f.owned);
  // Recreate only our own name, leaving the original receipt and state intact.
  const port = await availablePort();
  await run(
    "k3d",
    [
      "cluster",
      "create",
      f.resource.name,
      "--image",
      f.resource.nodeImage,
      "--servers",
      "1",
      "--agents",
      "0",
      "--api-port",
      `127.0.0.1:${port}`,
      "--kubeconfig-update-default=false",
      "--kubeconfig-switch-context=false",
      "--no-lb",
    ],
    { timeout: 180_000 },
  );
  const replacement = await capture(f.resource.name, join(f.work, "replacement-kubeconfig"));
  f.captures.push(replacement.owned);
  assert.notEqual(replacement.owned.clusterUID, f.owned.clusterUID);
  assert.notEqual(replacement.owned.serverID, f.owned.serverID);
  const result = await f.cleanup();
  // These exact compared values distinguish the identity refusal from setup failure.
  assert.ok(result.stderr.includes(f.owned.clusterUID));
  assert.ok(result.stderr.includes(replacement.owned.clusterUID));
  await replacement.bound.assertCluster();
  assert.deepEqual(await replacement.bound.cleanupIdentity(), replacement.owned.membership);
  await absent(join(f.work, "cleanup.json"));
  f.passed();
});

test("staged sign-in refuses a newly shared volume", options, async (t) => {
  const f = await fixture(t);
  const volume = f.owned.membership.volumes[0].name;
  // An unlabelled consumer on no network reaches the volume-consumer check;
  // cluster labels and network membership remain valid.
  const helperName = `${f.resource.name}-consumer`;
  assert.equal(await run("docker", ["ps", "-aq", "--filter", `name=^/${helperName}$`]), "");
  f.setExtraContainer(helperName);
  const helper = (
    await run("docker", [
      "create",
      "--name",
      helperName,
      "--network=none",
      "--mount",
      `type=volume,source=${volume},target=/shared,readonly`,
      "--entrypoint",
      "/bin/sh",
      f.resource.nodeImage,
      "-c",
      "sleep 600",
    ])
  ).trim();
  await run("docker", ["start", helper]);
  assert.deepEqual(
    lines(await run("docker", ["ps", "-aq", "--no-trunc", "--filter", `volume=${volume}`])),
    [f.owned.serverID, helper].sort(),
  );
  const result = await f.cleanup();
  assert.ok(result.stderr.includes(helper), "the refusal must identify the extra volume consumer");
  await f.bound.assertCluster();
  await assertVolumesRetained(f.owned);
  assert.deepEqual(
    lines(await run("docker", ["ps", "-aq", "--no-trunc", "--filter", `volume=${volume}`])),
    [f.owned.serverID, helper].sort(),
  );
  const network = JSON.parse(
    await run("docker", ["network", "inspect", f.owned.membership.networkID]),
  );
  assert.deepEqual(Object.keys(network[0].Containers), [f.owned.serverID]);
  await absent(join(f.work, "cleanup.json"));
  f.passed();
});
