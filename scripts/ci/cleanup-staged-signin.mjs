// Destructive cleanup is separate from test success: a failed but settled case
// can be cleaned. Missing settlement or replaced resources require reconciliation.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertHostedSigninJob,
  readStagedSignin,
  readPreparedSigninCluster,
  readSettledSigninCase,
} from "../../tests/helpers/signin/staged.mjs";
import {
  bindLocalRehearsalCluster,
  runFixtureCommand,
} from "../../tests/helpers/production-rehearsal-custody.ts";
import { caseName } from "./prepared-signin-case.mjs";
import { restrictStagingProcess } from "./prepare-staged-signin.ts";

// Evaluate only after the supervisor has accounted for all descendants. Preserve
// the first proof failure while still releasing resources with confirmed custody.
async function caseEvidence(dir, staged, owned, preparedHash, run) {
  const path = join(dir, "case-result.json");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let result;
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.size > 0 && info.size <= 4096);
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes);
    assert.equal(bytesRead, info.size);
    result = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
  assert.equal(result.kind, "staging-signin-case");
  assert.equal(result.caseName, caseName);
  assert.equal(result.passed, true);
  assert.deepEqual(result.counts, { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 });
  for (const key of ["workflowSha", "cluster", "runId", "runAttempt"]) {
    assert.equal(result[key], owned[key]);
  }
  assert.equal(result.planHash, owned.planSha256);
  assert.equal(result.preparedHash, preparedHash);
  const folder = join(dir, "case-tmp");
  const entries = (await readdir(folder, { withFileTypes: true })).filter((d) =>
    d.name.startsWith("oce-production-tui-"),
  );
  assert.ok(entries.length === 1 && entries[0].isDirectory());
  const proof = join(folder, entries[0].name, "proof.json");
  assert.equal(await realpath(proof), proof);
  const reader = fileURLToPath(new URL("./staged-signin-proof.py", import.meta.url));
  const checked = JSON.parse(
    await run(
      "python3",
      [
        "-I",
        reader,
        proof,
        "--previous-version",
        String(staged.signinPlan.previous.version),
        "--candidate-version",
        String(staged.signinPlan.candidate.version),
        "--expected-cluster",
        "k3d-" + owned.cluster,
      ],
      { protectedInput: true, timeout: 10_000 },
    ),
  );
  assert.match(checked.sha256, /^[a-f0-9]{64}$/);
  return checked;
}

async function cleanup(planHash, preparedHash) {
  const e = process.env;
  assertHostedSigninJob(e);
  restrictStagingProcess(e);
  const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
  assert.equal(await realpath(e.GITHUB_WORKSPACE), root);
  assert.equal(await realpath(process.cwd()), root);
  const run = (command, args, options) => runFixtureCommand(command, args, options, String, true);
  assert.equal((await run("git", ["rev-parse", "HEAD"])).trim(), e.GITHUB_WORKFLOW_SHA);
  assert.equal(await run("git", ["status", "--porcelain", "--untracked-files=no"]), "");
  const staged = await readStagedSignin({
    directory: e.RUNNER_TEMP,
    expectedPlanHash: planHash,
    workflowSha: e.GITHUB_WORKFLOW_SHA,
    installation: e.STAGING_INSTALLATION,
  });
  const owned = await readPreparedSigninCluster(e, preparedHash, planHash, staged);
  const settled = await readSettledSigninCase(e, preparedHash, planHash);
  const dir = join(e.RUNNER_TEMP, "staging-installed-signin");
  e.HOME = join(dir, "home");
  e.DOCKER_CONFIG = join(dir, "docker");
  e.DOCKER_HOST = "unix:///var/run/docker.sock";
  const auditDir = join(dir, "cleanup");
  await mkdir(auditDir, { mode: 0o700 }); // a partial cleanup is not replayable
  let proof;
  let primary;
  try {
    assert.equal(settled.exitCode, 0, "installed sign-in runner failed");
    proof = await caseEvidence(dir, staged, owned, preparedHash, run);
  } catch (error) {
    primary = error;
  }
  const privateConfig = join(auditDir, "kubeconfig");
  try {
    const current = await bindLocalRehearsalCluster(run, owned.cluster, privateConfig);
    assert.equal(current.clusterUID, owned.clusterUID);
    assert.equal(current.serverID, owned.serverID);
    assert.equal(current.nodeUID, owned.nodeUID);
    assert.deepEqual(await current.cleanupIdentity(), owned.membership);
    const { cleanupState } = await import("./cleanup.mjs");
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
        ...owned.membership,
      },
    });
    for (const [kind, id] of [
      ["network", owned.membership.networkID],
      ...owned.membership.volumes.map((v) => ["volume", v.name]),
    ]) {
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
    workflowSha: e.GITHUB_WORKFLOW_SHA,
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
    join(e.RUNNER_TEMP, "staging-signin-qualification.json"),
    JSON.stringify(qualification) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}
if (import.meta.main) {
  assert.equal(process.argv.length, 4, "supply the job's plan and preparation hashes");
  await cleanup(process.argv[2], process.argv[3]);
}
