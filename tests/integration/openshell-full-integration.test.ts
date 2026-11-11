import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, writeSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTestSuites } from "../../scripts/ci/test-suites.mjs";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = "scripts/ci/test-suites.json";
const installerFile = "tests/integration/local-first-agent-openshell-real.test.mjs";
const testedSha = "1".repeat(40);

type FileEntry = { path: string; expectedTests: string[] };
type Lane = { files: FileEntry[] };
type Suite = { lanes: Record<string, Lane>; groups: Record<string, string[]> };
type Result = {
  version: number;
  command: string;
  lane: string;
  scope: string;
  sourceSha: string;
  status: string;
  exitCode: number;
  files: {
    path: string;
    status: string;
    counts: { total: number };
    tests: { name: string; status: string }[];
    cleanup: { status: string };
  }[];
};

function command(script: string, args: string[], view = "default") {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: { PATH: process.env.PATH, GITHUB_SHA: testedSha, OCC_CI_SUITE_VIEW: view },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

const runner = "scripts/ci/run-tests.mjs";
const fullView = "full-integration";

function assertIssue(
  result: ReturnType<typeof command>,
  code: string,
  expected?: { lane: string; file: string },
) {
  assert.equal(result.status, 1, result.stderr);
  const summary: { issues: { code: string; lane?: string; file?: string }[] } = JSON.parse(
    result.stdout,
  );
  assert.ok(
    summary.issues.some(
      (issue) =>
        issue.code === code &&
        (!expected || (issue.lane === expected.lane && issue.file === expected.file)),
    ),
    JSON.stringify(summary.issues),
  );
}

function present<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

function writeJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data));
}

test("Full Integration partitions OpenShell without changing the default focused caller", (t) => {
  const legacy: Suite = loadTestSuites(join(root, manifest));
  const selected: Suite = loadTestSuites(join(root, manifest), fullView);
  const canonical = present(legacy.lanes.openshell);
  const shards = present(selected.groups.openshell);
  assert.deepEqual(shards, ["openshell-policy", "openshell-installers"]);
  assert.equal(selected.lanes.openshell, undefined);
  assert.ok(
    present(selected.lanes["openshell-installers"]).files.some(
      ({ path }) => path === "tests/integration/openshell-git-finite-removal-real.test.ts",
    ),
    "tests/integration/openshell-git-finite-removal-real.test.ts must be in openshell-installers",
  );
  assert.ok(
    !present(selected.lanes["openshell-policy"]).files.some(
      ({ path }) => path === "tests/integration/openshell-git-finite-removal-real.test.ts",
    ),
    "tests/integration/openshell-git-finite-removal-real.test.ts must be absent from openshell-policy",
  );
  const allFiles = shards.flatMap((name) => present(selected.lanes[name]).files);
  assert.equal(allFiles.length, canonical.files.length);
  assert.deepEqual(
    [...allFiles].sort((a, b) => a.path.localeCompare(b.path)),
    [...canonical.files].sort((a, b) => a.path.localeCompare(b.path)),
  );
  for (const name of shards) {
    const lane = present(selected.lanes[name]);
    const paths = new Set(lane.files.map(({ path }) => path));
    assert.deepEqual(lane, {
      ...canonical,
      files: canonical.files.filter(({ path }) => paths.has(path)),
    });
  }

  // Each physical job must retain its identity in the timing summary used for comparisons.
  const timingDirectory = temporaryDirectorySync(t, "openshell-view-timing-");
  for (const lane of ["openshell", ...shards]) {
    const summary = join(timingDirectory, `${lane}.md`);
    const artifact = join(timingDirectory, `${lane}.json`);
    const timing = spawnSync(
      process.execPath,
      ["scripts/ci/openshell-phase-timing.ts", "summarize", artifact],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_SHA: testedSha,
          GITHUB_JOB: "openshell",
          GITHUB_RUN_ATTEMPT: "2",
          OPENSHELL_LANE: lane,
          OPENSHELL_SELECTION: "full",
          OPENSHELL_ENTRY: "0.00",
          OPENSHELL_PREPARE_START: "0.01",
          OPENSHELL_PREPARE_END: "0.02",
          OPENSHELL_RUN_START: "0.03",
          OPENSHELL_CLEANUP_START: "0.04",
          OPENSHELL_CLEANUP_END: "0.05",
          OPENSHELL_PREPARE_OUTCOME: "success",
          OPENSHELL_RUN_OUTCOME: "success",
          OPENSHELL_CLEANUP_OUTCOME: "success",
        },
      },
    );
    assert.equal(timing.error, undefined);
    assert.equal(timing.signal, null);
    assert.equal(timing.status, 0, timing.stderr);
    const json = present(readFileSync(summary, "utf8").split("```json\n")[1]);
    const receipt = JSON.parse(present(json.split("\n```")[0]));
    assert.deepEqual(JSON.parse(readFileSync(artifact, "utf8")), receipt);
    assert.equal(receipt.attempt, "2");
    assert.equal(receipt.lane, lane);
    assert.equal(receipt.sha, testedSha);
    assert.equal(receipt.selection, "full");
    for (const phase of ["prepare", "run", "cleanup"]) {
      assert.deepEqual(receipt.phases[phase], { elapsedMs: 10, outcome: "success" });
    }
    assert.equal(receipt.residualMs, 0);
    if (lane === "openshell-policy") {
      const { elapsedMs, residualMs, phases } = receipt;
      assert.notEqual(timing.stdout, "", "MISSING_POLICY_TIMING_NOTICE");
      assert.equal(
        timing.stdout,
        `::notice title=OpenShell policy phase timing::${JSON.stringify({ elapsedMs, residualMs, phases })}\n`,
      );
    } else {
      assert.equal(timing.stdout, "");
    }
  }

  const select = (lane: string, view?: string) =>
    command(runner, ["check-selection", lane, "--file", installerFile], view);
  assert.equal(select("openshell").status, 0);
  assert.equal(select("openshell-installers").status, 1);
  assert.equal(select("openshell-installers", fullView).status, 0);
  assert.equal(select("openshell-policy", fullView).status, 1);

  const state = join(temporaryDirectorySync(t, "openshell-view-state-"), "policy.json");
  const refused = command(
    "scripts/ci/prepare.mjs",
    ["--lane", "openshell-policy", "--selected-file", installerFile, "--state", state],
    fullView,
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Selected file must belong to the lane manifest/);
});

test("the full view refuses canonical overlap and the audit detects omitted files", (t) => {
  const directory = temporaryDirectorySync(t, "openshell-view-audit-");
  const source: Suite = loadTestSuites(join(root, manifest));
  const original = present(source.lanes.openshell);
  for (const { path } of original.files) {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  const firstFile = original.files[0];
  assert.ok(firstFile);
  const path = join(directory, "suite.json");
  const audit = (files: FileEntry[]) => {
    writeJson(path, {
      version: 1,
      lanes: { openshell: { ...original, files } },
      groups: { full: ["openshell"] },
    });
    return command(runner, ["audit", "--root", directory, "--manifest", path], fullView);
  };
  assert.equal(audit(original.files).status, 0);
  const overlap = audit([...original.files, firstFile]);
  assert.equal(overlap.status, 1);
  assert.match(overlap.stderr, /two disjoint, nonempty OpenShell lanes/);
  assertIssue(audit(original.files.slice(1)), "unmapped-file");
});

test("both complete OpenShell receipts are required by targeted and full aggregation", (t) => {
  const directory = temporaryDirectorySync(t, "openshell-view-aggregate-");
  const suite: Suite = loadTestSuites(join(root, manifest), fullView);
  const lanes = present(suite.groups.openshell);
  const makeReceipt = (lane: string): Result => ({
    version: 1,
    command: "run",
    lane,
    scope: "full",
    sourceSha: testedSha,
    status: "passed",
    exitCode: 0,
    files: present(suite.lanes[lane]).files.map(({ path, expectedTests }) => ({
      path,
      status: "passed",
      counts: { total: expectedTests.length },
      tests: expectedTests.map((name) => ({ name, status: "passed" })),
      cleanup: { status: "passed" },
    })),
  });
  const [policy, installers] = lanes;
  assert.ok(policy && installers);
  const needs = join(directory, "needs.json");
  writeJson(needs, { openshell: { result: "success", lanes } });
  writeJson(join(directory, `${policy}.json`), makeReceipt(policy));
  const receiptPath = join(directory, `${installers}.json`);
  const aggregate = (group: string) =>
    command(
      runner,
      [
        "aggregate",
        group,
        "--root",
        directory,
        "--manifest",
        join(root, manifest),
        "--results-dir",
        directory,
        "--needs",
        needs,
        ...(group === "full" ? ["--lanes", JSON.stringify(lanes)] : []),
      ],
      fullView,
    );
  assertIssue(aggregate("openshell"), "missing-lane-output");
  for (const group of ["openshell", "full"]) {
    writeJson(receiptPath, makeReceipt(installers));
    const pass = aggregate(group);
    assert.equal(pass.status, 0, pass.stdout || pass.stderr);
    const reject = (receipt: Result, code: string) => {
      writeJson(receiptPath, receipt);
      assertIssue(aggregate(group), code);
    };
    reject({ ...makeReceipt(installers), sourceSha: "2".repeat(40) }, "source-sha-mismatch");
    reject({ ...makeReceipt(installers), scope: "focused" }, "focused-lane-evidence");
    const receipt = makeReceipt(installers);
    present(receipt.files[0]).tests.shift();
    reject(receipt, "missing-expected-test");
    reject({ ...makeReceipt(installers), status: "failed", exitCode: 1 }, "lane-failed");
    const cleanup = makeReceipt(installers);
    present(cleanup.files[0]).cleanup.status = "failed";
    reject(cleanup, "cleanup-failed");
    // A successful lane receipt cannot omit the finite-removal file's complete evidence.
    const missingFile = makeReceipt(installers);
    missingFile.files = missingFile.files.filter(
      ({ path }) => path !== "tests/integration/openshell-git-finite-removal-real.test.ts",
    );
    writeJson(receiptPath, missingFile);
    assertIssue(aggregate(group), "missing-lane-evidence", {
      lane: "openshell-installers",
      file: "tests/integration/openshell-git-finite-removal-real.test.ts",
    });
  }
});

test("gateway installation preserves settled phases, operation outcomes and the receipt cap", async () => {
  const { observeGatewayInstallation } = await import("../helpers/openshell-installation.ts");
  const { collectInstallationPhases, installationPhase, maxInstallationInvocations } =
    await import("../../scripts/ci/openshell-installation-phase.ts");
  const raw = {
    kind: "openshell-installation",
    stage: "workspace-helm",
    outcome: "entered",
    invocation: 1,
    offsetMs: 0,
  };
  for (const invalid of [
    { ...raw, detail: "untrusted" },
    { ...raw, stage: "untrusted" },
    { ...raw, offsetMs: -1 },
    { ...raw, invocation: 10 },
  ]) {
    assert.equal(installationPhase(invalid), undefined);
  }
  const receipt = collectInstallationPhases();
  const writes: unknown[] = [];
  // Validate outside the best-effort writer so diagnostic failures cannot swallow assertions.
  const acceptWrites = () => {
    for (const row of writes.splice(0)) {
      const valid = installationPhase(row);
      assert.ok(valid);
      receipt.accept(valid);
    }
  };
  let clock = 0;
  const observe = observeGatewayInstallation(
    (row) => writes.push(row),
    () => clock++,
  );
  const failure = new Error("installation failed");
  const ok = async () => 7;
  const values = { overrides: ["workspace.enabled=true"] };
  const gatewayValues = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return values;
  };
  const gatewayHelm = async (received: typeof values) => {
    assert.equal(received, values);
  };
  const fail = async () => {
    throw failure;
  };
  await assert.rejects(observe(ok, gatewayValues, fail, ok), (error) => error === failure);
  assert.equal(await observe(ok, gatewayValues, gatewayHelm, ok), 7);
  acceptWrites();
  assert.deepEqual(receipt.result(), {
    phases: [
      { invocation: 1, stage: "workspace-helm", enteredMs: 1, outcome: "passed", elapsedMs: 1 },
      { invocation: 1, stage: "gateway-helm", enteredMs: 3, outcome: "failed", elapsedMs: 1 },
      { invocation: 2, stage: "workspace-helm", enteredMs: 1, outcome: "passed", elapsedMs: 1 },
      { invocation: 2, stage: "gateway-helm", enteredMs: 3, outcome: "passed", elapsedMs: 1 },
      { invocation: 2, stage: "gateway-pod-ready", enteredMs: 5, outcome: "passed", elapsedMs: 1 },
    ],
    truncated: false,
  });
  for (let invocation = 3; invocation <= maxInstallationInvocations; invocation++) {
    assert.equal(await observe(ok, gatewayValues, gatewayHelm, ok), 7);
  }
  acceptWrites();
  // Overflow still performs installation, but emits only one marker across later invocations.
  assert.equal(await observe(ok, gatewayValues, gatewayHelm, ok), 7);
  assert.deepEqual(writes, [
    {
      kind: "openshell-installation",
      stage: "workspace-helm",
      outcome: "entered",
      invocation: maxInstallationInvocations + 1,
      offsetMs: 1,
    },
  ]);
  acceptWrites();
  assert.equal(await observe(ok, gatewayValues, gatewayHelm, ok), 7);
  assert.equal(writes.length, 0);
  assert.equal(receipt.result().truncated, true);
  assert.equal(receipt.result().phases.length, 3 * maxInstallationInvocations - 1);

  const valuesFailure = new Error("gateway values failed");
  const failingValues = observeGatewayInstallation(
    (row) => writes.push(row),
    () => clock++,
  );
  const laterOperations: string[] = [];
  await assert.rejects(
    failingValues(
      ok,
      async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        throw valuesFailure;
      },
      async () => laterOperations.push("gateway-helm"),
      async () => laterOperations.push("gateway-pod-ready"),
    ),
    (error) => error === valuesFailure,
  );
  assert.deepEqual(laterOperations, []);
  const failedReceipt = collectInstallationPhases();
  for (const row of writes.splice(0)) {
    const valid = installationPhase(row);
    assert.ok(valid);
    failedReceipt.accept(valid);
  }
  assert.deepEqual(failedReceipt.result(), {
    phases: [
      { invocation: 1, stage: "workspace-helm", enteredMs: 1, outcome: "passed", elapsedMs: 1 },
    ],
    truncated: false,
  });
  const readOnly = openSync(import.meta.filename, "r");
  try {
    for (const sink of [undefined, () => writeSync(readOnly, "diagnostic")]) {
      const install = observeGatewayInstallation(sink);
      assert.equal(await install(ok, gatewayValues, gatewayHelm, ok), 7);
      await assert.rejects(
        install(ok, gatewayValues, gatewayHelm, fail),
        (error) => error === failure,
      );
    }
  } finally {
    closeSync(readOnly);
  }
});

test("the runner retains an unknown gateway readiness outcome after the test child terminates", (t) => {
  const directory = temporaryDirectorySync(t, "installation-progress-");
  const file = "tests/integration/installation.test.ts";
  mkdirSync(join(directory, dirname(file)), { recursive: true });
  mkdirSync(join(directory, "scripts/ci"), { recursive: true });
  writeFileSync(
    join(directory, "scripts/ci/prepare.mjs"),
    `import { writeFileSync } from "node:fs";
export function prepareFile({ statePath }) {
  return { cleanup: () => writeFileSync(statePath + ".cleaned", "completed") };
}`,
  );
  const helper = new URL("../helpers/openshell-installation.ts", import.meta.url).href;
  writeFileSync(
    join(directory, file),
    `import test from "node:test";
import { runGatewayInstallation } from ${JSON.stringify(helper)};
test("terminated readiness", () => runGatewayInstallation(
  async () => {}, async () => {}, async () => {},
  async () => { process.kill(process.pid, "SIGTERM"); await new Promise(() => {}); },
));
`,
  );
  const suite = join(directory, "suite.json");
  const state = join(directory, "state.json");
  const results = join(directory, "results.json");
  writeJson(suite, { version: 1, lanes: { openshell: { files: [{ path: file }] } }, groups: {} });
  const result = command(runner, [
    "run",
    "openshell",
    "--root",
    directory,
    "--manifest",
    suite,
    "--state",
    state,
    "--results",
    results,
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const [entry] = JSON.parse(readFileSync(results, "utf8")).files;
  assert.equal(entry.status, "failed");
  assert.equal(entry.nodeExitCode, 1);
  assert.equal(entry.fileFailure.error.signal, "SIGTERM");
  assert.deepEqual(entry.cleanup, { status: "passed" });
  assert.equal(readFileSync(state + ".cleaned", "utf8"), "completed");
  assert.equal(entry.installationPhases.truncated, false);
  const phases: {
    invocation: number;
    stage: string;
    enteredMs: number;
    outcome: string;
    elapsedMs?: number;
  }[] = entry.installationPhases.phases;
  assert.deepEqual(
    phases.map(({ invocation, stage, outcome }) => [invocation, stage, outcome]),
    [
      [1, "workspace-helm", "passed"],
      [1, "gateway-helm", "passed"],
      [1, "gateway-pod-ready", "unknown"],
    ],
  );
  assert.equal(present(phases[2]).elapsedMs, undefined);
});
