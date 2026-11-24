import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createRunnerFixture as fixture } from "../helpers/ci-runner-fixture.ts";
import {
  checkBoundedAgentNamespaceActivity,
  checkControllerReadinessEvidence,
  checkFailedWaitContainerLog,
  checkMixedPrecisionEventOrder,
} from "./ci-runner-k3d-diagnostics-cases.ts";
import { checkAllowlistedMeasurements } from "./ci-runner-measurements-case.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export function registerResourceDiagnosticsCases() {
  test("each job attempt uploads its own diagnostics report", async () => {
    // A passing rerun must not replace a failed attempt's report. This reads the
    // composite action; it is not a GitHub Actions execution.
    const action = await readFile(
      join(repositoryRoot, ".github/actions/run-ci-lane/action.yml"),
      "utf8",
    );
    const upload = action.match(/- name: Upload cluster diagnostics\n[\s\S]*?\n {4}- /u)?.[0] ?? "";
    assert.match(
      upload,
      /\n\s+name: diagnostics-\$\{\{ inputs\.artifact-prefix \}\}-\$\{\{ inputs\.lane \}\}-attempt-\$\{\{ github\.run_attempt \}\}\n/u,
    );
  });

  test(
    "run keeps bounded Agent namespace activity from passing k3d files, alone and side by side",
    checkBoundedAgentNamespaceActivity,
  );

  test(
    "k3d diagnostics preserve equal-instant event order across precision variants",
    checkMixedPrecisionEventOrder,
  );

  test("first-Agent scenario ownership drains child work before teardown after failure or cancellation", async (t) => {
    for (const mode of ["failure", "cancel"]) {
      const root = await fixture(t);
      const trace = join(root, "trace");
      const file = join(root, "scenario.test.mjs");
      const owner = pathToFileURL(
        join(repositoryRoot, "tests/helpers/local-first-agent-stack.mjs"),
      ).href;
      await writeFile(
        file,
        `
import test from 'node:test';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { ownFirstAgentWork } from ${JSON.stringify(owner)};
const controller = new AbortController();
test('scenario', { signal: controller.signal }, async (t) => {
  const own = ownFirstAgentWork(t);
  t.after(() => appendFileSync(${JSON.stringify(trace)}, 'cleanup|'));
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  t.test('native', { signal: t.signal }, (native) => own(new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50)); console.log('ready'); setTimeout(() => process.exit(0), 300);"], { stdio: ['ignore', 'pipe', 'ignore'] });
    native.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    child.stdout.once('data', ready);
    child.once('error', reject);
    child.once('close', () => { appendFileSync(${JSON.stringify(trace)}, 'settled|'); resolve(); });
  })));
  await started;
  if (${JSON.stringify(mode)} === 'cancel') { controller.abort(); }
  else { throw new Error('scenario-failed'); }
});
`,
      );
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_TEST_WORKER_ID;
      const result = spawnSync(process.execPath, ["--test", file], {
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(await readFile(trace, "utf8"), "settled|cleanup|", mode);
    }
  });

  test(
    "run records only allowlisted measurements from test diagnostics",
    checkAllowlistedMeasurements,
  );

  test(
    "run publishes a failed wait's followed container log, redacted, beside Agent activity",
    checkFailedWaitContainerLog,
  );

  for (const earlyLogExit of [false, true]) {
    test(`run retains controller readiness evidence before its fixture namespace is deleted (early log exit: ${earlyLogExit})`, (t) =>
      checkControllerReadinessEvidence(t, earlyLogExit));
  }
}
