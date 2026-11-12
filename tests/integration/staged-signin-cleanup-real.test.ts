import assert from "node:assert/strict";
import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deleteOwnedK3dCluster } from "../../scripts/ci/cleanup.mjs";
import {
  assertLocalRehearsalDaemon,
  FixtureCommandError,
  bindLocalRehearsalCluster,
  runFixtureCommand,
  type FixtureRun,
} from "../helpers/production-rehearsal-custody.ts";
import { availablePort } from "../helpers/available-port.mjs";

const execute = promisify(execFile);
type Owned = {
  cluster: string;
  clusterUID: string;
  nodeUID: string | undefined;
  serverID: string;
  membership: { networkID: string; volumes: { name: string; createdAt: string }[] };
};

const root = fileURLToPath(new URL("../../", import.meta.url));
const selected = process.env.OCC_TEST_STAGED_SIGNIN_CLEANUP_REAL === "1";
const evidenceRoot = process.env.OCC_TEST_STAGED_SIGNIN_CLEANUP_ARTIFACT_DIR;
// Share one admission deadline across all cases, preserving time for cleanup and
// the lane's other files. Every launched operation is awaited before teardown.
const laneDeadline = Number(process.env.CI_RUNNER_DEADLINE_MS);
const proofDeadline = Math.min(
  Date.now() + 15 * 60_000,
  Number.isSafeInteger(laneDeadline) && laneDeadline > 0 ? laneDeadline - 3 * 60_000 : Infinity,
);
let previousCaseFailed = false;
const run: FixtureRun = (command, args, options) =>
  runFixtureCommand(command, args, options, String, true);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const lines = (text: string) => text.trim().split(/\r?\n/u).filter(Boolean).sort();

async function jsonFile(path: string, value: unknown) {
  const bytes = JSON.stringify(value) + "\n";
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return hash(bytes);
}

async function absent(path: string) {
  await assert.rejects(readFile(path), { code: "ENOENT" });
}

async function assertRemoved(owned: Owned, command: FixtureRun = run) {
  assert.ok(!lines(await command("docker", ["ps", "-aq", "--no-trunc"])).includes(owned.serverID));
  assert.ok(
    !lines(await command("docker", ["network", "ls", "-q", "--no-trunc"])).includes(
      owned.membership.networkID,
    ),
  );
  const volumes = lines(await command("docker", ["volume", "ls", "-q"]));
  for (const volume of owned.membership.volumes) {
    assert.ok(!volumes.includes(volume.name), `owned volume remains: ${volume.name}`);
  }
}

async function assertVolumesRetained(owned: Owned, command: FixtureRun) {
  for (const volume of owned.membership.volumes) {
    const info = JSON.parse(await command("docker", ["volume", "inspect", volume.name]));
    assert.equal(info[0].Name, volume.name);
    assert.equal(info[0].CreatedAt, volume.createdAt);
  }
}

async function capture(cluster: string, path: string, command: FixtureRun = run) {
  const bound = await bindLocalRehearsalCluster(command, cluster, path);
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
async function fixture(
  t: TestContext,
  signal: AbortSignal,
  registerCleanup: (cleanup: () => Promise<void>) => void,
) {
  assert.ok(!previousCaseFailed, "stop resource creation after an earlier case failed");
  const remaining = () => {
    signal.throwIfAborted();
    const ms = proofDeadline - Date.now();
    assert.ok(ms > 0, "shared cleanup proof deadline expired");
    return ms;
  };
  let uncertain = false;
  const command: FixtureRun = async (name, args, options = {}) => {
    const timeout = Math.min(options.timeout ?? 120_000, remaining());
    try {
      return await run(name, args, { ...options, timeout });
    } catch (error) {
      // A normal nonzero child exit is observable; a signal/timeout or unknown
      // transport failure is not affirmative settlement of daemon work.
      uncertain ||= !(error instanceof FixtureCommandError) || !error.settled;
      throw error;
    }
  };
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
    OPENCLAW_CI_CLEANUP_COMMAND_TIMEOUT_MS: "60000",
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
  const captures: Owned[] = [];
  let extraContainer: string | undefined;
  let extraVolumes: string[] = [];
  let assertionsPassed = false;
  let requiresReconciliation = false;
  let cleanupOutcome: "not-run" | "unknown" | "refused" | "removed" = "not-run";
  const cleanupAuthority: { identity?: Owned; stateSha256?: string } = {};
  // Register ownership before creation. This cleanup is independent of the CLI
  // assertions, so it cannot turn a refused or partial deletion into a pass.
  registerCleanup(async () => {
    previousCaseFailed ||= !assertionsPassed;
    const errors: unknown[] = [];
    const cleanupDeadline = Date.now() + 3 * 60_000;
    const cleanupRemaining = () => {
      const ms = cleanupDeadline - Date.now();
      assert.ok(ms > 0, "cleanup deadline expired; retain ownership state");
      return ms;
    };
    const cleanupRun: FixtureRun = async (name, args, options = {}) =>
      run(name, args, {
        ...options,
        timeout: Math.min(options.timeout ?? 30_000, cleanupRemaining()),
      });
    try {
      assert.ok(
        !uncertain && !requiresReconciliation,
        `unconfirmed resource ownership; retain ${directory}`,
      );
      assert.ok(
        cleanupOutcome === "not-run" ||
          cleanupOutcome === "removed" ||
          (cleanupOutcome === "refused" && assertionsPassed),
        `unconfirmed cleanup outcome; retain ${directory}`,
      );
      if (cleanupOutcome === "removed") {
        await absent(statePath);
      }
      if (extraContainer) {
        // Stop here on any removal or absence failure. A still-shared volume
        // never grants fallback authority to delete the cluster underneath it.
        await cleanupRun("docker", ["rm", "-f", "-v", extraContainer]);
        assert.ok(
          !lines(await cleanupRun("docker", ["ps", "-aq", "--no-trunc"])).includes(extraContainer),
        );
        const volumes = lines(await cleanupRun("docker", ["volume", "ls", "-q"]));
        assert.ok(
          extraVolumes.every((volume) => !volumes.includes(volume)),
          "helper anonymous volume remains",
        );
      }
      const state = await readFile(statePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      });
      if (state) {
        assert.ok(
          cleanupAuthority.identity && cleanupAuthority.stateSha256,
          "no acknowledged cluster cleanup authority",
        );
        assert.equal(
          hash(state),
          cleanupAuthority.stateSha256,
          "fixture state changed before final cleanup",
        );
        const current = await capture(
          cleanupAuthority.identity.cluster,
          join(work, "final-kubeconfig"),
          cleanupRun,
        );
        assert.deepEqual(
          current.owned,
          cleanupAuthority.identity,
          "fixture cluster changed before final cleanup",
        );
        await execute(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            'import {cleanupState} from "./scripts/ci/cleanup.mjs"; await cleanupState(process.argv[1], JSON.parse(process.argv[2]));',
            statePath,
            JSON.stringify({
              expectedStateSha256: cleanupAuthority.stateSha256,
              k3dIdentity: {
                cluster: cleanupAuthority.identity.cluster,
                serverID: cleanupAuthority.identity.serverID,
                ...cleanupAuthority.identity.membership,
              },
            }),
          ],
          {
            cwd: root,
            env: process.env,
            timeout: Math.min(120_000, cleanupRemaining()),
            killSignal: "SIGTERM",
            maxBuffer: 1024 * 1024,
          },
        );
      }
      for (const owned of captures) {
        await assertRemoved(owned, cleanupRun);
      }
    } catch (error) {
      // Any failure ends mutation. Keep state and report incomplete cleanup.
      errors.push(error);
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
  await assertLocalRehearsalDaemon(command);
  const beforeVolumes = new Set(lines(await command("docker", ["volume", "ls", "-q"])));
  // Run the producer in its own bounded process. This test budget may stop
  // unacknowledged work; that is uncertain failure, never cleanup proof.
  assert.ok(remaining() >= 4 * 60_000, "insufficient proof budget for another cluster");
  requiresReconciliation = true;
  const prepared = await command(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { prepareStagingSigninCluster } from "./scripts/ci/prepare.mjs"; console.log(JSON.stringify(await prepareStagingSigninCluster(process.argv[1])));',
      statePath,
    ],
    { cwd: root, timeout: 4 * 60_000 },
  );
  const resource = JSON.parse(prepared) as Record<string, unknown> & {
    name: string;
    nodeImage: string;
  };
  signal.throwIfAborted();
  const current = await capture(resource.name, join(work, "original-kubeconfig"), command);
  captures.push(current.owned);
  assert.ok(current.owned.membership.volumes.every((v) => !beforeVolumes.has(v.name)));
  cleanupAuthority.identity = current.owned;
  cleanupAuthority.stateSha256 = hash(await readFile(statePath));
  requiresReconciliation = false;
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
  const caseReturnedSha256 = await jsonFile(join(work, "case-returned.json"), {
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
    run: command,
    resource,
    work,
    directory,
    captures,
    beginCreation() {
      requiresReconciliation = true;
    },
    acknowledgeReplacement(owned: Owned) {
      assert.equal(owned.cluster, resource.name);
      assert.ok(
        owned.membership.volumes.every((v) => !beforeVolumes.has(v.name)),
        "replacement mounted a pre-existing volume",
      );
      captures.push(owned);
      assert.ok(cleanupAuthority.identity && cleanupAuthority.stateSha256);
      cleanupAuthority.identity = owned;
      requiresReconciliation = false;
    },
    setExtraContainer(id: string, volumes?: string[]) {
      assert.match(id, /^[a-f0-9]{64}$/);
      extraContainer = id;
      if (volumes !== undefined) {
        extraVolumes = volumes;
        requiresReconciliation = false;
      }
    },
    passed() {
      assertionsPassed = true;
    },
    async cleanup(expectedOutcome: "removed" | "refused") {
      cleanupOutcome = "unknown";
      const result = await execute(
        process.execPath,
        ["scripts/ci/cleanup-staged-signin.mjs", planHash, preparedHash],
        {
          cwd: root,
          env: process.env,
          timeout: Math.min(180_000, remaining()),
          maxBuffer: 1024 * 1024,
        },
      ).then(
        () => {
          throw new Error("failed sign-in case unexpectedly qualified");
        },
        (error: ExecFileException & { stderr: string; signal?: string }) => error,
      );
      uncertain ||= Boolean(result.killed || result.signal != null);
      assert.equal(
        result.code,
        1,
        "cleanup must preserve the failed case, not time out or receive a signal",
      );
      assert.match(result.stderr, /installed sign-in runner failed/);
      await absent(join(directory, "staging-signin-qualification.json"));
      const mutation = await readFile(join(work, "cleanup", "mutation-started.json"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            return undefined;
          }
          throw error;
        },
      );
      if (mutation !== undefined) {
        assert.deepEqual(JSON.parse(mutation), {
          planSha256: planHash,
          preparedSha256: preparedHash,
        });
        // After dispatch, only the completed receipt permits absence checks.
        // Missing/partial cleanup never authorizes a second deletion attempt.
        const receipt = JSON.parse(await readFile(join(work, "cleanup.json"), "utf8"));
        assert.equal(receipt.kind, "staging-signin-cleanup");
        assert.equal(receipt.workflowSha, workflowSha);
        assert.equal(receipt.runId, "1");
        assert.equal(receipt.runAttempt, "1");
        assert.equal(receipt.planSha256, planHash);
        assert.equal(receipt.preparedSha256, preparedHash);
        assert.equal(receipt.caseReturnedSha256, caseReturnedSha256);
        assert.equal(receipt.caseExitCode, 1);
        assert.equal(receipt.removed, true);
        cleanupOutcome = "removed";
      } else {
        // The case must still prove its expected refusal before fallback gains
        // authority. Unexpected pre-mutation failures retain the fixture too.
        cleanupOutcome = "refused";
      }
      assert.equal(cleanupOutcome, expectedOutcome);
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

// node:test may start after hooks while a timed-out body still runs. Stop
// admitting new stages, then join the complete body before releasing resources.
async function runCase(
  t: TestContext,
  body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const closing = new AbortController();
  const signal = AbortSignal.any([t.signal, closing.signal]);
  let cleanup = async () => {};
  const work = Promise.resolve().then(async () => {
    const f = await fixture(t, signal, (registered) => {
      cleanup = registered;
    });
    await body(f);
  });
  t.after(async () => {
    closing.abort();
    const [result] = await Promise.allSettled([work]);
    previousCaseFailed ||= result?.status === "rejected";
    try {
      await cleanup();
    } catch (error) {
      previousCaseFailed = true;
      throw error;
    }
  });
  return work;
}

const options = {
  skip: selected
    ? false
    : "Set OCC_TEST_STAGED_SIGNIN_CLEANUP_REAL=1 on an isolated local Docker host.",
  timeout: 15 * 60_000,
  concurrency: false,
};

test("staged sign-in cleans owned resources after a settled failed case", options, (t) =>
  runCase(t, async (f) => {
    await f.cleanup("removed");
    await assertRemoved(f.owned, f.run);
    const receipt = JSON.parse(await readFile(join(f.work, "cleanup.json"), "utf8"));
    assert.equal(receipt.removed, true);
    assert.equal(receipt.caseExitCode, 1);
    f.passed();
  }),
);

test("staged sign-in refuses a replacement cluster", options, (t) =>
  runCase(t, async (f) => {
    await deleteOwnedK3dCluster(f.resource, {
      execFile: async (name, args) => ({ stdout: await f.run(name, args) }),
      identity: { cluster: f.owned.cluster, serverID: f.owned.serverID, ...f.owned.membership },
    });
    await assertRemoved(f.owned, f.run);
    // Recreate only our own name, leaving the original receipt and state intact.
    const port = await availablePort();
    f.beginCreation();
    await f.run(
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
        "--no-rollback",
      ],
      { timeout: 180_000 },
    );
    const replacement = await capture(
      f.resource.name,
      join(f.work, "replacement-kubeconfig"),
      f.run,
    );
    assert.notEqual(replacement.owned.clusterUID, f.owned.clusterUID);
    assert.notEqual(replacement.owned.serverID, f.owned.serverID);
    f.acknowledgeReplacement(replacement.owned);
    const result = await f.cleanup("refused");
    // These exact compared values distinguish the identity refusal from setup failure.
    assert.ok(result.stderr.includes(f.owned.clusterUID));
    assert.ok(result.stderr.includes(replacement.owned.clusterUID));
    await replacement.bound.assertCluster();
    assert.deepEqual(await replacement.bound.cleanupIdentity(), replacement.owned.membership);
    await absent(join(f.work, "cleanup.json"));
    f.passed();
  }),
);

test("staged sign-in refuses a newly shared volume", options, (t) =>
  runCase(t, async (f) => {
    const firstVolume = f.owned.membership.volumes[0];
    assert.ok(firstVolume);
    const volume = firstVolume.name;
    // An unlabelled consumer on no network reaches the volume-consumer check;
    // cluster labels and network membership remain valid.
    const helperName = `${f.resource.name}-consumer`;
    assert.equal(await f.run("docker", ["ps", "-aq", "--filter", `name=^/${helperName}$`]), "");
    f.beginCreation();
    const helper = (
      await f.run("docker", [
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
    f.setExtraContainer(helper);
    const [helperInfo] = JSON.parse(await f.run("docker", ["inspect", helper]));
    const helperVolumes = helperInfo.Mounts.filter(
      (mount: { Type: string; Name: string }) => mount.Type === "volume" && mount.Name !== volume,
    ).map((mount: { Name: string }) => mount.Name);
    f.setExtraContainer(helper, helperVolumes);
    await f.run("docker", ["start", helper]);
    assert.deepEqual(
      lines(await f.run("docker", ["ps", "-aq", "--no-trunc", "--filter", `volume=${volume}`])),
      [f.owned.serverID, helper].sort(),
    );
    const result = await f.cleanup("refused");
    assert.ok(
      result.stderr.includes(helper),
      "the refusal must identify the extra volume consumer",
    );
    await f.bound.assertCluster();
    await assertVolumesRetained(f.owned, f.run);
    assert.deepEqual(
      lines(await f.run("docker", ["ps", "-aq", "--no-trunc", "--filter", `volume=${volume}`])),
      [f.owned.serverID, helper].sort(),
    );
    const network = JSON.parse(
      await f.run("docker", ["network", "inspect", f.owned.membership.networkID]),
    );
    assert.deepEqual(Object.keys(network[0].Containers), [f.owned.serverID]);
    await absent(join(f.work, "cleanup.json"));
    f.passed();
  }),
);
