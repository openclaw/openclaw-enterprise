// Destructive cleanup is separate from test success: a failed but settled case
// can be cleaned. Missing settlement or replaced resources require reconciliation.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  assertHostedSigninJob as validateHostedSigninJob,
  readPreparedSigninCluster,
  readSettledSigninCase,
  readStagedSignin,
} from "../../tests/helpers/signin/staged.mjs";
import {
  bindLocalRehearsalCluster,
  runFixtureCommand,
  type FixtureRun,
} from "../../tests/helpers/production-rehearsal-custody.ts";
import { caseName } from "./prepared-signin-case.mjs";
import { restrictStagingProcess } from "./prepare-staged-signin.ts";

const run: FixtureRun = (command, args, options) =>
  runFixtureCommand(command, args, options, String, true);
const assertHostedSigninJob: (
  environment: NodeJS.ProcessEnv,
) => asserts environment is NodeJS.ProcessEnv & {
  GITHUB_WORKSPACE: string;
  RUNNER_TEMP: string;
  GITHUB_RUN_ID: string;
  GITHUB_RUN_ATTEMPT: string;
  STAGING_INSTALLATION: string;
} = validateHostedSigninJob;

async function admitCleanup(planHash: string, preparedHash: string) {
  const e = process.env;
  assertHostedSigninJob(e);
  restrictStagingProcess(e);
  const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
  assert.equal(await realpath(e.GITHUB_WORKSPACE), root);
  assert.equal(await realpath(process.cwd()), root);
  const workflowSha = (await run("git", ["rev-parse", "HEAD"])).trim();
  assert.equal(workflowSha, e.GITHUB_WORKFLOW_SHA);
  assert.equal(await run("git", ["status", "--porcelain", "--untracked-files=no"]), "");
  const staged = await readStagedSignin({
    directory: e.RUNNER_TEMP,
    expectedPlanHash: planHash,
    workflowSha,
    installation: e.STAGING_INSTALLATION,
  });
  const prepared: unknown = await readPreparedSigninCluster(e, preparedHash, planHash, staged);
  const returned: unknown = await readSettledSigninCase(e, preparedHash, planHash);
  const owned = asRecord(prepared);
  const settled = asRecord(returned);
  assert.ok(owned && settled);
  const { cluster, clusterUID, serverID, nodeUID, stateSha256 } = owned;
  assert.ok(
    typeof cluster === "string" &&
      typeof clusterUID === "string" &&
      typeof serverID === "string" &&
      typeof nodeUID === "string" &&
      typeof stateSha256 === "string",
  );
  assert.ok(typeof settled.sha256 === "string" && typeof settled.exitCode === "number");
  const signinPlan: unknown = staged.signinPlan;
  return {
    runnerTemp: e.RUNNER_TEMP,
    dir: join(e.RUNNER_TEMP, "staging-installed-signin"),
    planHash,
    preparedHash,
    signinPlan,
    owned: {
      cluster,
      clusterUID,
      serverID,
      nodeUID,
      stateSha256,
      membership: owned.membership,
      workflowSha,
      runId: e.GITHUB_RUN_ID,
      runAttempt: e.GITHUB_RUN_ATTEMPT,
      installation: e.STAGING_INSTALLATION,
    },
    settled: { sha256: settled.sha256, exitCode: settled.exitCode },
  };
}

type CleanupJob = Awaited<ReturnType<typeof admitCleanup>>;

// Evaluate only after the supervisor has accounted for all descendants. Preserve
// the first proof failure while still releasing resources with confirmed custody.
async function caseEvidence({ dir, signinPlan, owned, planHash, preparedHash }: CleanupJob) {
  const path = join(dir, "case-result.json");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value: unknown;
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.size > 0 && info.size <= 4096);
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes);
    assert.equal(bytesRead, info.size);
    value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
  const result = asRecord(value);
  assert.ok(result);
  assert.equal(result.kind, "staging-signin-case");
  assert.equal(result.caseName, caseName);
  assert.equal(result.passed, true);
  assert.deepEqual(result.counts, { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 });
  for (const key of ["workflowSha", "cluster", "runId", "runAttempt"] as const) {
    assert.equal(result[key], owned[key]);
  }
  assert.equal(result.planHash, planHash);
  assert.equal(result.preparedHash, preparedHash);
  const folder = join(dir, "case-tmp");
  const entries = (await readdir(folder, { withFileTypes: true })).filter((d) =>
    d.name.startsWith("oce-production-tui-"),
  );
  const [entry] = entries;
  assert.ok(entries.length === 1 && entry && entry.isDirectory());
  const proof = join(folder, entry.name, "proof.json");
  assert.equal(await realpath(proof), proof);
  const reader = fileURLToPath(new URL("./staged-signin-proof.py", import.meta.url));
  const plan = asRecord(signinPlan);
  const previous = asRecord(plan?.previous)?.version;
  const candidate = asRecord(plan?.candidate)?.version;
  assert.ok((previous === 2 || previous === 3) && candidate === 3);
  const output: unknown = JSON.parse(
    await run(
      "python3",
      [
        "-I",
        reader,
        proof,
        "--previous-version",
        String(previous),
        "--candidate-version",
        String(candidate),
        "--expected-cluster",
        "k3d-" + owned.cluster,
      ],
      { protectedInput: true, timeout: 10_000 },
    ),
  );
  const checked = asRecord(output);
  assert.ok(typeof checked?.sha256 === "string");
  assert.match(checked.sha256, /^[a-f0-9]{64}$/);
  const stages: unknown = checked.stages;
  assert.ok(Array.isArray(stages) && stages.every((stage: unknown) => typeof stage === "string"));
  return { sha256: checked.sha256, stages };
}

async function releaseCluster(
  { dir, owned, planHash, preparedHash }: CleanupJob,
  auditDir: string,
  privateConfig: string,
) {
  const current = await bindLocalRehearsalCluster(run, owned.cluster, privateConfig);
  assert.equal(current.clusterUID, owned.clusterUID);
  assert.equal(current.serverID, owned.serverID);
  assert.equal(current.nodeUID, owned.nodeUID);
  const membership = await current.cleanupIdentity();
  assert.deepEqual(membership, owned.membership);
  const networkID: unknown = membership.networkID;
  assert.ok(typeof networkID === "string");
  const volumeEntries: unknown[] = membership.volumes;
  const volumes = volumeEntries.map((value) => {
    const volume = asRecord(value);
    assert.ok(typeof volume?.name === "string" && typeof volume.createdAt === "string");
    return { name: volume.name, createdAt: volume.createdAt };
  });
  const { cleanupState } = await import("./cleanup.ts");
  // A normal CLI exit cannot settle a timed-out inner Docker request. Persist
  // intent before entering the destructive owner; only cleanup.json closes it.
  await writeFile(
    join(auditDir, "mutation-started.json"),
    JSON.stringify({ planSha256: planHash, preparedSha256: preparedHash }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await cleanupState(join(dir, "cluster-state.json"), {
    expectedStateSha256: owned.stateSha256,
    k3dIdentity: {
      cluster: owned.cluster,
      serverID: owned.serverID,
      networkID,
      volumes,
    },
  });
  const resources: [kind: "network" | "volume", id: string][] = [
    ["network", networkID],
    ...volumes.map(({ name }): ["volume", string] => ["volume", name]),
  ];
  for (const [kind, id] of resources) {
    const list = await run("docker", [
      kind,
      "ls",
      "-q",
      ...(kind === "network" ? ["--no-trunc"] : []),
    ]);
    assert.ok(
      !list.trim().split(/\r?\n/u).includes(id),
      "owned Docker resource still present after cleanup",
    );
  }
  const ids = await run("docker", ["ps", "-aq", "--no-trunc"]);
  assert.ok(!ids.trim().split(/\r?\n/u).includes(owned.serverID));
}

async function cleanup(planHash: string, preparedHash: string) {
  const job = await admitCleanup(planHash, preparedHash);
  const { dir, owned, runnerTemp, settled } = job;
  process.env.HOME = join(dir, "home");
  process.env.DOCKER_CONFIG = join(dir, "docker");
  process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
  const auditDir = join(dir, "cleanup");
  await mkdir(auditDir, { mode: 0o700 }); // a partial cleanup is not replayable
  let proof: Awaited<ReturnType<typeof caseEvidence>> | undefined;
  let primary: unknown;
  try {
    assert.equal(settled.exitCode, 0, "installed sign-in runner failed");
    proof = await caseEvidence(job);
  } catch (error) {
    primary = error;
  }
  const privateConfig = join(auditDir, "kubeconfig");
  try {
    await releaseCluster(job, auditDir, privateConfig);
  } catch (error) {
    if (primary) {
      throw new AggregateError(
        [primary, error],
        "Sign-in case and owned cluster cleanup both failed",
        { cause: error },
      );
    }
    throw error;
  } finally {
    await rm(privateConfig, { force: true });
  }
  // The case can contain generated passwords, protected requests and private
  // kubeconfigs. Return only the bounded outcome and hashes to the workflow.
  for (const entry of ["case-tmp", "home", "docker", "case.log", "bound-kubeconfig"]) {
    await rm(join(dir, entry), { recursive: true, force: true });
  }
  const evidence = {
    kind: "staging-signin-cleanup",
    workflowSha: owned.workflowSha,
    runId: owned.runId,
    runAttempt: owned.runAttempt,
    planSha256: planHash,
    preparedSha256: preparedHash,
    caseReturnedSha256: settled.sha256,
    caseExitCode: settled.exitCode,
    removed: true,
  };
  await writeFile(join(dir, "cleanup.json"), JSON.stringify(evidence) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  if (primary) {
    throw primary;
  }
  assert.ok(proof);
  const qualification = {
    kind: "installed-signin-transition",
    platform: "linux/amd64",
    installation: owned.installation,
    workflowSha: owned.workflowSha,
    runId: owned.runId,
    runAttempt: owned.runAttempt,
    planSha256: planHash,
    preparedSha256: preparedHash,
    caseReturnedSha256: settled.sha256,
    fixtureProofSha256: proof.sha256,
    stages: proof.stages,
    cleanup: "verified",
  };
  await writeFile(
    join(runnerTemp, "staging-signin-qualification.json"),
    JSON.stringify(qualification) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}
if (import.meta.main) {
  assert.equal(process.argv.length, 4, "supply the job's plan and preparation hashes");
  const [, , planHash, preparedHash] = process.argv;
  assert.ok(planHash !== undefined && preparedHash !== undefined);
  await cleanup(planHash, preparedHash);
}
