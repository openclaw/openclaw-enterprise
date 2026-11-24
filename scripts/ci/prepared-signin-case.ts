import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertHostedSigninJob,
  assertSigninHash,
  readPreparedSigninCluster,
  readStagedSignin,
} from "../../tests/helpers/signin/staged.ts";
import { restrictStagingProcess } from "./prepare-staged-signin.ts";
import type { PreparedSigninRunFile } from "./run-tests.ts";

const relativePath = "tests/integration/production-tui-k3d-real.test.mjs";
export const caseName =
  "Owned P/A sign-in receipts survive only the admitted controller transitions";

// The outer Linux supervisor owns descendant settlement. The CI runner owns
// reporter parsing, skip/todo checks and timeouts; only this case may qualify.
export async function runPreparedSigninCase(root: string, runFile: PreparedSigninRunFile) {
  const e = process.env;
  assertHostedSigninJob(e);
  const planHash = e.OCC_TEST_SIGNIN_PLAN_SHA256;
  const preparedHash = e.OCC_TEST_SIGNIN_PREPARED_SHA256;
  restrictStagingProcess(e);
  assert.equal(await realpath(root), await realpath(e.GITHUB_WORKSPACE));
  assert.equal(await realpath(process.cwd()), await realpath(root));
  const staged = await readStagedSignin({
    directory: e.RUNNER_TEMP,
    expectedPlanHash: planHash,
    workflowSha: e.GITHUB_WORKFLOW_SHA,
    installation: e.STAGING_INSTALLATION,
  });
  const receipt = await readPreparedSigninCluster(e, preparedHash, planHash, staged);
  assertSigninHash(planHash);
  assertSigninHash(preparedHash);
  const directory = join(e.RUNNER_TEMP, "staging-installed-signin");
  e.HOME = join(directory, "home");
  e.DOCKER_CONFIG = join(directory, "docker");
  e.TMPDIR = join(directory, "case-tmp");
  e.GOPROXY = "off";
  e.GOTOOLCHAIN = "local";
  // A previous run may have changed the fixture even when it produced no result.
  await mkdir(e.TMPDIR, { mode: 0o700 });
  const file = {
    path: relativePath,
    expectedTests: [caseName],
    env: {},
    requiredEnv: [],
    optionalEnv: [],
  };
  const lane = {
    name: "staging-signin",
    requiredEnv: [],
    optionalEnv: [],
    env: {
      OCC_TEST_PRODUCTION_SIGNIN_REHEARSAL: "1",
      OCC_TEST_SIGNIN_PLAN_SHA256: planHash,
      OCC_TEST_SIGNIN_PREPARED_SHA256: preparedHash,
    },
  };
  const result = await runFile(root, lane, file);
  const [test] = result.tests;
  const ok =
    result.status === "passed" &&
    result.nodeExitCode === 0 &&
    result.signal === null &&
    !result.fileFailure &&
    result.issues.length === 0 &&
    result.counts.total === 1 &&
    result.counts.passed === 1 &&
    result.tests.length === 1 &&
    test?.name === caseName &&
    test.status === "passed" &&
    test.file === relativePath;
  const outcome = {
    kind: "staging-signin-case",
    workflowSha: e.GITHUB_WORKFLOW_SHA,
    preparedHash,
    planHash,
    runId: receipt.runId,
    runAttempt: receipt.runAttempt,
    cluster: receipt.cluster,
    caseName,
    counts: result.counts,
    passed: ok,
  };
  // Never publish the raw reporter output or fixture's authentication material.
  await writeFile(join(directory, "case-result.json"), JSON.stringify(outcome) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  if (!ok) {
    console.error("The single prepared sign-in case did not pass; see private fixture evidence.");
  }
  return ok ? 0 : 1;
}
