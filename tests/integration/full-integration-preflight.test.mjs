import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSourceRef,
  requiredEnvironmentsForLane,
  selectLane,
  validateEnvironmentPolicy,
  validateFullIntegrationPreflight,
} from "../../scripts/ci/full-integration-preflight.mjs";
import { selectQaMatrix, validateQaInputs } from "../helpers/qa-selection.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import {
  admitProducer,
  discoverProducer,
  pollMilliseconds,
  selectFreshLanes,
  validateResults,
  waitMilliseconds,
} from "../../scripts/ci/full-integration-reuse.mjs";
import { projectSkipperRunnerReceipt } from "../../scripts/ci/skipper-release.ts";
import { loadTestSuites } from "../../scripts/ci/test-suites.mjs";

async function reuseFixture() {
  const rows = (await selectFreshLanes([], "skipped")).matrix.filter(
    (row) => !["k3d-observability-demo", "repository-credentials-container"].includes(row.lane),
  );
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const run = {
    id: 123,
    run_attempt: 2,
    head_sha: sha,
    event: "push",
    head_branch: "main",
    repository: { full_name: "openclaw/openclaw-enterprise" },
    head_repository: { full_name: "openclaw/openclaw-enterprise" },
    workflow_id: 456,
    path: ".github/workflows/ci.yml",
    status: "completed",
    conclusion: "success",
  };
  const jobs = [
    "CI Required",
    "Suite Audit and Static Checks",
    ...rows.map((row) => row.title),
  ].map((name) => ({ name, status: "completed", conclusion: "success" }));
  const artifacts = rows.map((row, index) => ({
    id: index + 1000,
    name: `attempt-2-ci-results-${row.lane}`,
    expired: false,
    size_in_bytes: 1000,
    workflow_run: { id: 123, head_sha: sha, head_branch: "main" },
  }));
  const get = async (path) => {
    if (path === "/actions/workflows/ci.yml") {
      return { id: 456, name: "CI", path: run.path };
    }
    if (path.includes("/runs?")) {
      return { workflow_runs: [run] };
    }
    if (path.endsWith("/jobs?per_page=100")) {
      return { total_count: jobs.length, jobs };
    }
    if (path.endsWith("/artifacts?per_page=100")) {
      return { total_count: artifacts.length, artifacts };
    }
    if (path === "/actions/runs/123") {
      return run;
    }
    throw new Error(`Unexpected API request ${path}`);
  };
  return { rows, sha, run, jobs, artifacts, get };
}

test("same-SHA reuse admits only successful canonical CI jobs and immutable current-attempt artifacts", async () => {
  const fixture = await reuseFixture();
  const { get, run, sha, rows, jobs, artifacts } = fixture;
  assert.ok(await admitProducer(get, run, sha, 456, rows));
  for (const patch of [
    { head_sha: "0".repeat(40) },
    { event: "pull_request" },
    { head_branch: "other" },
    { head_repository: { full_name: "someone/fork" } },
    { workflow_id: 999 },
    { path: ".github/workflows/other.yml" },
    { conclusion: "failure" },
    { run_attempt: 3 },
  ]) {
    assert.equal(await admitProducer(get, { ...run, ...patch }, sha, 456, rows), null);
  }
  for (const job of jobs) {
    job.conclusion = "skipped";
    assert.equal(await admitProducer(get, run, sha, 456, rows), null, job.name);
    job.conclusion = "success";
  }
  for (const patch of [
    { expired: true },
    { name: "ci-results-checks-baseline-1" },
    { workflow_run: { id: 999, head_sha: sha, head_branch: "main" } },
  ]) {
    const original = artifacts[0];
    artifacts[0] = { ...original, ...patch };
    assert.equal(await admitProducer(get, run, sha, 456, rows), null);
    artifacts[0] = original;
  }
});

test("full coverage receipts require real case evidence and retain approved same-SHA CI reuse", async (t) => {
  const { get, run, sha, rows } = await reuseFixture();
  const lane = "logging-collector";
  assert.ok(rows.some((row) => row.lane === lane));
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const suites = loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
  const reusedFiles = suites.lanes[lane].files;
  const full = loadTestSuites(
    join(repositoryRoot, "scripts/ci/test-suites.json"),
    "full-integration",
  );
  const installerPaths = full.lanes["openshell-installers"].files.map(({ path }) => path);
  const skipperLane = "skipper-prepared-git-installed";
  const skipperFiles = full.lanes[skipperLane].files;
  const fixtureRoot = await temporaryDirectory(t, "full-coverage-receipts-");
  const policyPath = "tests/integration/coverage-policy.test.mjs";
  const runner = join(repositoryRoot, "scripts/ci/run-tests.mjs");
  const json = (path, value) => writeFile(path, JSON.stringify(value));
  const generate = async (path, names, body, suite = "") => {
    const target = join(fixtureRoot, path);
    await mkdir(dirname(target), { recursive: true });
    const tests = names.length ? [...new Set(names)] : ["sentinel"];
    await writeFile(
      target,
      [
        'import assert from "node:assert/strict"; import test from "node:test";',
        ...tests.map((name) => `test(${JSON.stringify(name)}, async (t) => { ${body} });`),
        suite,
      ].join("\n"),
    );
  };
  const invoke = (command, target, args, env = {}) => {
    const result = spawnSync(
      process.execPath,
      [runner, command, target, "--root", fixtureRoot, "--manifest", "manifest.json", ...args],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          GITHUB_SHA: sha,
          GITHUB_WORKFLOW: "Full Integration",
          OCC_CI_SUITE_VIEW: "full-integration",
          GITHUB_REF: "refs/heads/main",
          GITHUB_RUN_ATTEMPT: "1",
          GIT_CEILING_DIRECTORIES: dirname(fixtureRoot),
          CI_RUNNER_DEADLINE_MS: "",
          ...env,
        },
      },
    );
    assert.equal(result.error, undefined);
    return result;
  };
  const clean = (target, directory = "results") =>
    spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "scripts/ci/cleanup.mjs"),
        "--state",
        join(fixtureRoot, "state", `${target}.json`),
        "--results",
        join(fixtureRoot, directory, `${target}.json`),
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 10_000 },
    );
  const produce = (target, directory = "results", env = {}) => {
    const result = invoke(
      "run",
      target,
      ["--state", `state/${target}.json`, "--results", `${directory}/${target}.json`],
      env,
    );
    const cleanup = clean(target, directory);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    return result;
  };
  await json(join(fixtureRoot, "manifest.json"), {
    version: 1,
    lanes: {
      [lane]: { files: reusedFiles },
      [skipperLane]: { files: skipperFiles },
      openshell: {
        files: [policyPath, ...installerPaths].map((path) => ({
          path,
          expectedTests: ["sentinel"],
        })),
      },
    },
    groups: { full: [lane, "openshell", skipperLane] },
  });
  for (const { path, expectedTests = [] } of reusedFiles) {
    await generate(path, expectedTests, "assert.equal(1, 1);");
  }
  for (const path of installerPaths) {
    await generate(path, ["sentinel"], "assert.equal(1, 1);");
  }
  // Exercise the installed lane's publication projection with a real runner result.
  // This local fixture proves accounting and cleanup, not an installed Skipper journey.
  await mkdir(join(fixtureRoot, "scripts/ci"), { recursive: true });
  const ownedFile = join(fixtureRoot, "owned-prepare-file");
  await writeFile(
    join(fixtureRoot, "scripts/ci/prepare.mjs"),
    [
      'import { writeFile, rm } from "node:fs/promises";',
      'const ownedFile = new URL("../../owned-prepare-file", import.meta.url);',
      "export async function prepareFile({ lane }) {",
      '  if (lane.name !== "skipper-prepared-git-installed") return {};',
      '  await writeFile(ownedFile, "owned");',
      "  return { cleanup: () => rm(ownedFile) };",
      "}",
    ].join("\n"),
  );
  for (const { path, expectedTests } of skipperFiles) {
    await generate(path, expectedTests, "assert.equal(1, 1);");
  }
  const skipperRun = produce(skipperLane);
  assert.equal(skipperRun.status, 0, skipperRun.stderr);
  await assert.rejects(readFile(ownedFile), { code: "ENOENT" });
  const skipperPath = join(fixtureRoot, "results", `${skipperLane}.json`);
  const privateSkipper = JSON.parse(await readFile(skipperPath, "utf8"));
  // Unknown diagnostic fields must never widen the published allowlist.
  privateSkipper.diagnostic = "private-output-canary";
  privateSkipper.files[0].diagnostic = "private-output-canary";
  privateSkipper.files[0].tests[0].diagnostic = "private-output-canary";
  const publicSkipper = { ...projectSkipperRunnerReceipt(privateSkipper), lane: skipperLane };
  assert.doesNotMatch(JSON.stringify(publicSkipper), /private-output-canary/);
  await json(skipperPath, publicSkipper);
  assert.equal(clean(skipperLane).status, 0);
  assert.equal(clean("unstarted-lane").status, 0);
  await assert.rejects(readFile(join(fixtureRoot, "results/unstarted-lane.json")), {
    code: "ENOENT",
  });
  const installer = produce("openshell-installers");
  assert.equal(installer.status, 0, installer.stderr);
  const ordinary = produce(lane, "download", {
    GITHUB_WORKFLOW: "CI",
    OCC_CI_SUITE_VIEW: "default",
  });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  const producer = await admitProducer(get, run, sha, 456, rows);
  assert.ok(producer);
  assert.deepEqual(await validateResults({ directory: fixtureRoot, producer, sha, get }), [lane]);
  const reusedReceipt = await readFile(join(fixtureRoot, "accepted", `${lane}.json`), "utf8");
  const reusedPath = join(fixtureRoot, "results", `${lane}.json`);
  await writeFile(reusedPath, reusedReceipt);
  const policyReceipt = join(fixtureRoot, "results/openshell-policy.json");
  const needsPath = join(fixtureRoot, "needs.json");
  let serial = 0;
  const verify = async (expectedExit, expectedMarker, env = {}) => {
    serial += 1;
    const marker = join(fixtureRoot, `marker-${serial}`);
    const output = join(fixtureRoot, `output-${serial}`);
    const result = invoke(
      "aggregate",
      "full",
      ["--results-dir", "results", "--needs", needsPath, "--full-coverage-marker", marker],
      { GITHUB_OUTPUT: output, ...env },
    );
    assert.equal(result.status, expectedExit, result.stderr || result.stdout);
    if (expectedMarker) {
      assert.equal(JSON.parse(result.stdout).fullCoverageExercised, true);
      assert.equal(await readFile(marker, "utf8"), "1\n");
      assert.equal(await readFile(output, "utf8"), "full_coverage_exercised=true\n");
    } else {
      assert.equal(JSON.parse(result.stdout).fullCoverageExercised, undefined);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    }
  };
  const needs = {
    preflight: { result: "success" },
    [lane]: { result: "success" },
    [skipperLane]: { result: "success" },
    openshell: { result: "success", lanes: ["openshell-policy", "openshell-installers"] },
  };
  await json(needsPath, needs);
  await generate(policyPath, ["sentinel"], "assert.equal(1, 1);");
  assert.equal(produce("openshell-policy").status, 0);
  await verify(0, true);
  // Installed Skipper always requires file cleanup; ordinary no-callback files
  // can legitimately retain null, so enforce the owning Skipper contract here.
  const installedReceipt = await readFile(skipperPath, "utf8");
  const nullCleanup = JSON.parse(installedReceipt);
  nullCleanup.files[0].cleanup = null;
  await json(skipperPath, nullCleanup);
  await verify(0, false);
  const extraCounts = JSON.parse(installedReceipt);
  extraCounts.files[0].counts.cancelled = 1;
  assert.equal(projectSkipperRunnerReceipt(extraCounts).files[0].exercised, undefined);
  await json(skipperPath, extraCounts);
  await verify(0, false);
  await writeFile(skipperPath, installedReceipt);
  // A later artifact-copy failure leaves case execution and completed cleanup
  // intact, even though the owning job and required aggregate remain failed.
  for (const owner of [skipperLane, "openshell"]) {
    needs[owner].result = "failure";
    await json(needsPath, needs);
    await verify(1, true);
    needs[owner].result = "success";
  }
  needs.preflight.result = "failure";
  await json(needsPath, needs);
  await verify(1, false);
  needs.preflight.result = "success";
  await json(needsPath, { ...needs, unowned: { result: "failure" } });
  await verify(1, false);
  await json(needsPath, needs);
  const passingPolicy = await readFile(policyReceipt, "utf8");
  for (const damage of [
    (value) => {
      delete value.files[0].cleanup;
    },
    (value) => {
      value.issues.push({
        code: "expected-test-not-passed",
        status: "failed",
        file: policyPath,
        name: "sentinel",
      });
    },
  ]) {
    const damaged = JSON.parse(passingPolicy);
    damage(damaged);
    await json(policyReceipt, damaged);
    await verify(0, false);
  }
  await writeFile(policyReceipt, passingPolicy);
  // Incomplete or focused evidence remains publishable, but never proves full coverage.
  for (const damage of [
    (value) => {
      delete value.scope;
    },
    (value) => {
      value.scope = "focused";
    },
    (value) => {
      delete value.files[0].exercised;
    },
    (value) => {
      delete value.files[0].signal;
    },
    (value) => {
      value.files[0].signal = "SIGTERM";
    },
    (value) => {
      delete value.files[0].issues;
    },
    (value) => {
      value.files[0].issues = [{ message: "private-output-canary" }];
    },
    (value) => {
      delete value.files[0].nodeExitCode;
    },
    (value) => {
      value.files[0].nodeExitCode = 1;
    },
    (value) => {
      value.files[0].fileFailure = { message: "private-output-canary" };
    },
    (value) => {
      delete value.files[0].counts;
    },
    (value) => {
      value.files[0].counts.total = 2;
    },
    (value) => {
      value.files[0].status = "failed";
    },
  ]) {
    const damaged = structuredClone(privateSkipper);
    damage(damaged);
    const projected = projectSkipperRunnerReceipt(damaged);
    assert.doesNotMatch(JSON.stringify(projected), /private-output-canary/);
    await json(skipperPath, { ...projected, lane: skipperLane });
    assert.equal(clean(skipperLane).status, 0);
    await verify(projected.scope === "focused" ? 1 : 0, false);
  }
  await json(skipperPath, publicSkipper);
  assert.equal(clean(skipperLane).status, 0);
  // Malformed outcomes and diagnostic-bearing values are rejected at the private boundary.
  for (const damage of [
    (value) => {
      delete value.issues;
    },
    (value) => {
      value.issues = [{ message: "private-output-canary" }];
    },
    (value) => {
      value.files[0].cleanup.status = "failed";
    },
    (value) => {
      value.files[0].tests[0].durationMs = { diagnostic: "private-output-canary" };
    },
    (value) => {
      value.files[0].tests[0].durationMs = -1;
    },
    (value) => {
      value.files[0].tests[0].durationMs = Infinity;
    },
  ]) {
    const damaged = structuredClone(privateSkipper);
    damage(damaged);
    assert.throws(() => projectSkipperRunnerReceipt(damaged), { code: "ERR_ASSERTION" });
  }
  const noDuration = structuredClone(privateSkipper);
  delete noDuration.files[0].tests[0].durationMs;
  assert.equal(projectSkipperRunnerReceipt(noDuration).files[0].tests[0].durationMs, undefined);
  const legacy = JSON.parse(reusedReceipt);
  for (const file of legacy.files) {
    delete file.exercised;
  }
  await json(reusedPath, legacy);
  await verify(0, false);
  await writeFile(reusedPath, reusedReceipt);

  needs.openshell.result = "failure";
  await json(needsPath, needs);
  await generate(
    policyPath,
    ["sentinel"],
    'await Promise.reject(new Error("synthetic setup")); assert.equal(1, 1);',
  );
  assert.equal(produce("openshell-policy").status, 1);
  await verify(1, false);

  await generate(policyPath, ["sentinel"], 'assert.fail("synthetic assertion");');
  assert.equal(produce("openshell-policy").status, 1);
  await verify(1, true);
  // Final cleanup is independent of successful file cleanup. Its refusal must
  // withhold coverage even when an assertion already makes the owning job red.
  for (const target of ["openshell-policy", "openshell-installers"]) {
    const resultPath = join(fixtureRoot, "results", `${target}.json`);
    const original = await readFile(resultPath, "utf8");
    const statePath = join(fixtureRoot, "state", `${target}.json`);
    const state = {
      version: 1,
      repositoryRoot: repositoryRoot.replace(/\/$/, ""),
      prefix: "openclaw-ci-coverage",
      resources: [
        {
          id: "retained-cluster",
          kind: "k3d-cluster",
          name: "openclaw-ci-coverage-cluster",
          owner: "openclaw-ci-different-owner",
        },
      ],
    };
    await json(statePath, state);
    const refused = clean(target);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Refusing to clean resource owned by another prefix/);
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")).cleanup, { status: "failed" });
    await verify(1, false);
    // Losing the resource ledger cannot turn a known cleanup refusal into proof
    // of removal. A retry needs actual restored state to reconcile that failure.
    await rm(statePath);
    const missingState = clean(target);
    assert.equal(missingState.status, 1);
    assert.match(missingState.stderr, /Cannot verify failed cleanup without resource state/);
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")).cleanup, { status: "failed" });
    await verify(1, false);
    // No cluster was created. Reconcile the synthetic ownership record, then
    // require the real cleanup command to remove its empty state and requalify.
    await json(statePath, { ...state, resources: [] });
    assert.equal(clean(target).status, 0);
    await assert.rejects(readFile(statePath), { code: "ENOENT" });
    await verify(1, true);
    for (const cleanup of [undefined, null, { status: "failed" }, { status: "unknown" }]) {
      await json(resultPath, { ...JSON.parse(original), cleanup });
      await verify(1, false);
    }
    await writeFile(resultPath, original);
  }
  await verify(1, false, { GITHUB_RUN_ATTEMPT: "2" });
  const genuine = await readFile(policyReceipt, "utf8");
  for (const damage of [
    (value) => {
      value.issues = [];
    },
    (value) => {
      value.files[0].issues = [];
    },
    (value) => {
      value.issues[0].file = "tests/integration/other.test.mjs";
    },
    (value) => {
      value.files[0].issues[0].name = "another case";
    },
  ]) {
    const damaged = JSON.parse(genuine);
    damage(damaged);
    await json(policyReceipt, damaged);
    await verify(1, false);
  }
  await writeFile(policyReceipt, genuine);

  await generate(
    policyPath,
    ["sentinel"],
    'await t.test("nested", async (t) => { await t.test("leaf", () => assert.fail("synthetic assertion")); }); await t.test("sibling", () => {});',
  );
  assert.equal(produce("openshell-policy").status, 1);
  await verify(1, true);

  await generate(
    policyPath,
    ["sentinel"],
    "assert.equal(1, 1);",
    'test.describe("assertion suite", () => { test("suite case", async (t) => { await t.test("leaf", () => assert.fail("synthetic assertion")); }); });',
  );
  assert.equal(produce("openshell-policy").status, 1);
  await verify(1, true);
  await generate(
    policyPath,
    ["sentinel"],
    'await t.test("nested", () => assert.fail("synthetic assertion"));',
    'test.describe("unrelated suite", () => { test.after(() => { throw new Error("synthetic teardown"); }); test("suite case", () => {}); });',
  );
  assert.equal(produce("openshell-policy").status, 1);
  await verify(1, false);

  await generate(
    policyPath,
    ["sentinel"],
    'await t.test("assertion", () => assert.fail("synthetic assertion")); await t.test("setup", () => { throw new Error("synthetic setup"); });',
  );
  assert.equal(produce("openshell-policy").status, 1);
  await verify(1, false);
  await generate(
    policyPath,
    ["sentinel"],
    'await t.test("assertion", () => assert.fail("synthetic assertion")); await t.test("skipped", { skip: true }, () => {});',
  );
  assert.equal(produce("openshell-policy").status, 1);
  await verify(1, false);
  const zero = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
  for (const damage of [
    (value) => {
      value.files[0].counts = zero;
      value.files[0].tests = [];
      value.counts = zero;
    },
    (value) => {
      value.scope = "focused";
    },
    (value) => {
      value.sourceSha = "0".repeat(40);
    },
    (value) => {
      value.files = [];
    },
  ]) {
    const bad = JSON.parse(genuine);
    damage(bad);
    await json(policyReceipt, bad);
    await verify(1, false);
  }
  await writeFile(policyReceipt, genuine);
  needs.openshell.result = "cancelled";
  await json(needsPath, needs);
  await verify(1, false);
});

test("same-SHA reuse waits at most twelve minutes and falls back without delaying credentialed lanes", async () => {
  const { get, run, sha, rows } = await reuseFixture();
  let elapsed = 0;
  const sleeps = [];
  run.status = "in_progress";
  const sleep = async (ms) => {
    sleeps.push(ms);
    elapsed += ms;
  };
  assert.equal(await discoverProducer({ get, sha, rows, now: () => elapsed, sleep }), null);
  assert.equal(elapsed, 720_000);
  assert.equal(waitMilliseconds, 720_000);
  assert.equal(pollMilliseconds, 30_000);
  assert.ok(sleeps.every((ms) => ms === 30_000));
  elapsed = 0;
  const admitted = await discoverProducer({
    get,
    sha,
    rows,
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
      if (elapsed === 60_000) {
        run.status = "completed";
      }
    },
  });
  assert.equal(admitted.runId, 123);
  assert.equal(elapsed, 60_000);
  const fallback = await selectFreshLanes(
    rows.map((row) => row.lane),
    "failure",
  );
  assert.equal(fallback.matrix.length, 17);
  assert.deepEqual(fallback.lanes, []);
  const reused = await selectFreshLanes(
    rows.map((row) => row.lane),
    "success",
  );
  assert.deepEqual(
    reused.matrix.map((row) => row.lane),
    ["k3d-observability-demo", "repository-credentials-container"],
  );
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const workflow = loadYaml(
    await readFile(
      new URL("../../.github/workflows/full-integration-execution.yml", import.meta.url),
      "utf8",
    ),
  );
  for (const lane of ["docker-model", "k3d-model", "gateway-routing", "slack", "openshell"]) {
    assert.deepEqual(
      workflow.jobs[lane].needs,
      lane === "docker-model" ? ["preflight", "runtime-artifact"] : "preflight",
      lane,
    );
  }
});

test("same-SHA reuse runs the existing full-coverage validator and rejects damaged or rerun evidence", async (t) => {
  const { get, run, sha, rows } = await reuseFixture();
  const producer = await admitProducer(get, run, sha, 456, rows);
  const directory = await temporaryDirectory(t, "ci-reuse-");
  await mkdir(join(directory, "download"));
  const manifest = loadTestSuites(
    fileURLToPath(new URL("../../scripts/ci/test-suites.json", import.meta.url)),
  );
  const lane = "postgres";
  const summary = {
    version: 1,
    command: "run",
    sourceSha: sha,
    scope: "full",
    cleanup: { status: "passed" },
    lane,
    status: "passed",
    exitCode: 0,
    files: manifest.lanes[lane].files.map((file) => ({
      path: file.path,
      status: "passed",
      counts: { total: file.expectedTests.length },
      tests: file.expectedTests.map((name) => ({ name, status: "passed" })),
      cleanup: { status: "passed" },
    })),
  };
  const path = join(directory, "download", `${lane}.json`);
  await writeFile(path, JSON.stringify(summary));
  assert.deepEqual(await validateResults({ directory, producer, sha, get }), [lane]);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "accepted", `${lane}.json`))),
    summary,
  );
  for (const patch of [
    { scope: "focused" },
    { scope: undefined },
    { cleanup: undefined },
    { cleanup: { status: "failed" } },
    { cleanup: { status: "unknown" } },
    { sourceSha: "0".repeat(40) },
    { files: [] },
    { exitCode: 1 },
    { files: summary.files.map((file) => ({ ...file, cleanup: { status: "failed" } })) },
    { files: summary.files.map((file) => ({ ...file, tests: [] })) },
  ]) {
    await writeFile(path, JSON.stringify({ ...summary, ...patch }));
    assert.deepEqual(await validateResults({ directory, producer, sha, get }), []);
  }
  await writeFile(path, JSON.stringify(summary));
  run.run_attempt = 3;
  assert.deepEqual(await validateResults({ directory, producer, sha, get }), []);
});

test("full integration workflow carries QA and installation outcomes into selected aggregation", async (t) => {
  const directory = await temporaryDirectory(t, "qa-aggregate-");
  const workflow = await readFile(
    new URL("../../.github/workflows/full-integration-execution.yml", import.meta.url),
    "utf8",
  );
  const step = workflow.split("- name: Write selected job state")[1];
  const source = step.match(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/)[1];
  for (const target of ["qa-matrix", "dev-up-k3d", "skipper-prepared-git-installed"]) {
    for (const lane of [target, "all"]) {
      for (const result of ["success", "failure", "cancelled", "skipped", "missing"]) {
        const needs = { preflight: { result: "success" } };
        if (result !== "missing") {
          needs[target] = { result };
        }
        // Execute the shipped workflow step: every selected lane must reach
        // aggregate validation, including failures and absent job outcomes.
        const process = spawnSync(globalThis.process.execPath, ["--input-type=commonjs"], {
          input: source,
          encoding: "utf8",
          env: { RUNNER_TEMP: directory, NEEDS_JSON: JSON.stringify(needs), SELECTED_LANE: lane },
        });
        assert.equal(process.status, 0, process.stderr);
        const recorded = JSON.parse(await readFile(join(directory, "needs.json"), "utf8"));
        assert.deepEqual(recorded[target], { result }, `${lane}: ${target}: ${result}`);
      }
    }
  }
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const aggregateJob = loadYaml(workflow).jobs["full-aggregate"];
  const aggregate = aggregateJob.steps.find(
    (item) => item.name === "Aggregate targeted runtime results",
  );
  // A rejected reusable-workflow string still reaches failure aggregation.
  // It must remain data even when it contains shell command substitution.
  const context = {
    needs: { preflight: { result: "failure", outputs: { selected_lane: "" } } },
    inputs: { lane: '$(touch "$RUNNER_TEMP/rejected-lane-command")' },
  };
  await assert.rejects(
    validateFullIntegrationPreflight({
      env: {
        ...mainRun,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        INPUT_LANE: context.inputs.lane,
      },
    }),
    /Unknown lane/,
  );
  const requireSelection = aggregateJob.steps.find(
    (item) => item.name === "Require validated selection",
  );
  assert.equal(workflowCondition(requireSelection.if, context), true);
  const refusal = spawnSync("/bin/sh", ["-c", requireSelection.run], {
    env: {},
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(refusal.error, undefined);
  assert.equal(refusal.status, 1, refusal.stderr);
  assert.match(refusal.stdout, /Preflight did not provide a validated selection/);
  // Independently keep the shell boundary safe even if an invalid string is
  // supplied as the selected value; validation must not be its only defense.
  context.needs.preflight.outputs.selected_lane = context.inputs.lane;
  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      aggregate.run.replace(/\$\{\{.*?\}\}/g, (expression) =>
        workflowCondition(expression, context),
      ),
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        ...Object.fromEntries(
          Object.entries(aggregate.env ?? {}).map(([name, expression]) => [
            name,
            workflowCondition(expression, context),
          ]),
        ),
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, "The unknown lane must fail aggregation");
  await assert.rejects(stat(join(directory, "rejected-lane-command")), { code: "ENOENT" });
});

test("full integration plans fresh fallback and attributes only published reuse to successful needs", async (t) => {
  const directory = await temporaryDirectory(t, "reuse-plan-");
  const output = join(directory, "output");
  const plan = spawnSync(process.execPath, ["scripts/ci/full-integration-reuse.mjs", "plan"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_TEMP: directory,
      GITHUB_OUTPUT: output,
      REUSED_LANES: '["postgres"]',
      REUSE_UPLOADED: "success",
    },
  });
  assert.equal(plan.status, 0, plan.stderr);
  const values = Object.fromEntries(
    (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), JSON.parse(line.slice(at + 1))];
      }),
  );
  assert.deepEqual(values.lanes, ["postgres"]);
  assert.equal(values.matrix.length, 16);
  assert.ok(!values.matrix.some((row) => row.lane === "postgres"));
  const workflow = await readFile(
    new URL("../../.github/workflows/full-integration-execution.yml", import.meta.url),
    "utf8",
  );
  const script = workflow
    .split("- name: Write selected job state")[1]
    .match(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/)[1];
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const jobs = loadYaml(workflow).jobs["full-aggregate"].needs;
  const execute = async (result, reused = ["postgres"], parent = "failure") => {
    const aggregated = spawnSync(process.execPath, ["--input-type=commonjs"], {
      input: script,
      encoding: "utf8",
      env: {
        RUNNER_TEMP: directory,
        SELECTED_LANE: "all",
        REUSED_LANES: JSON.stringify(reused),
        NEEDS_JSON: JSON.stringify({
          ...Object.fromEntries(jobs.map((name) => [name, { result: "success" }])),
          "ci-reuse": { result },
          "pr-safe-same-sha": { result: parent },
        }),
      },
    });
    assert.equal(aggregated.status, 0, aggregated.stderr);
    return JSON.parse(await readFile(join(directory, "needs.json"), "utf8"));
  };
  for (const result of ["success", "failure", "skipped"]) {
    const needs = await execute(result);
    assert.deepEqual(needs.postgres, result === "success" ? { result: "success" } : undefined);
    assert.equal(needs["pr-safe-same-sha"].result, "failure");
    assert.equal(needs["pr-safe-same-sha"].lanes.includes("postgres"), result !== "success");
    assert.ok(needs["pr-safe-same-sha"].lanes.includes("postgres-auth"));
    assert.equal(needs["postgres-auth"], undefined);
    assert.ok(needs["image-lanes-same-sha"].lanes.includes("images-packaging"));
  }
  // Even when every eligible lane is reused, the two fresh-only lanes retain
  // the real parent outcome. Reused lanes must not also belong to that parent.
  const { rows, sha } = await reuseFixture();
  const allReused = await execute(
    "success",
    rows.map((row) => row.lane),
  );
  assert.deepEqual(allReused["pr-safe-same-sha"], {
    result: "failure",
    lanes: ["k3d-observability-demo", "repository-credentials-container"],
  });
  for (const { lane } of rows) {
    assert.deepEqual(allReused[lane], { result: "success" });
  }

  // Feed the shipped workflow's output into the real aggregator with receipts
  // made by its runner. This proves mixed direct/matrix ownership, not merely
  // the shape of needs.json; these tiny cases do not exercise PostgreSQL.
  const lanes = ["postgres", "postgres-auth"];
  await mkdir(join(directory, "tests/integration"), { recursive: true });
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      version: 1,
      lanes: Object.fromEntries(
        lanes.map((lane) => [
          lane,
          {
            files: [{ path: `tests/integration/${lane}.test.mjs`, expectedTests: [lane] }],
          },
        ]),
      ),
      groups: { ci: lanes },
    }),
  );
  const runner = (args) =>
    spawnSync(
      process.execPath,
      ["scripts/ci/run-tests.mjs", ...args, "--root", directory, "--manifest", "manifest.json"],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_SHA: sha, GIT_CEILING_DIRECTORIES: directory },
      },
    );
  for (const lane of lanes) {
    await writeFile(
      join(directory, `tests/integration/${lane}.test.mjs`),
      `import test from "node:test"; test(${JSON.stringify(lane)}, () => {});\n`,
    );
    const result = runner([
      "run",
      lane,
      "--state",
      `state/${lane}.json`,
      "--results",
      `results/${lane}.json`,
    ]);
    assert.equal(result.status, 0, result.stderr);
  }
  const aggregate = () =>
    runner(["aggregate", "ci", "--results-dir", "results", "--needs", "needs.json"]);
  await execute("success");
  const failed = aggregate();
  assert.equal(failed.status, 1, failed.stderr);
  const summary = JSON.parse(failed.stdout);
  assert.deepEqual(
    summary.issues.map(({ code, need }) => ({ code, need })),
    [{ code: "need-not-success", need: "pr-safe-same-sha" }],
  );
  assert.ok(summary.lanes.every((lane) => lane.status === "passed"));
  await execute(
    "success",
    rows.map((row) => row.lane),
  );
  assert.deepEqual(
    JSON.parse(aggregate().stdout).issues.map((issue) => issue.code),
    ["need-not-success"],
  );
  await execute(
    "success",
    rows.map((row) => row.lane),
    "success",
  );
  assert.equal(aggregate().status, 0);
  // A success entry cannot replace the reused lane's missing or stale receipt.
  const receipt = join(directory, "results/postgres.json");
  const original = await readFile(receipt, "utf8");
  await writeFile(receipt, JSON.stringify({ ...JSON.parse(original), sourceSha: "0".repeat(40) }));
  assert.ok(
    JSON.parse(aggregate().stdout).issues.some((issue) => issue.code === "source-sha-mismatch"),
  );
  await rm(receipt);
  assert.ok(
    JSON.parse(aggregate().stdout).issues.some((issue) => issue.code === "missing-lane-output"),
  );
});

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function qaRegistry(repositories) {
  return JSON.stringify({
    version: 1,
    backendId: "github",
    providerInstanceId: "github-fixture-instance",
    appId: "123",
    githubInstallationId: "456",
    maximumDurationSeconds: 3600,
    repositories: repositories.map((repository, index) => ({
      repositoryRef: `repo-${index}`,
      repositoryId: String(index + 1),
      repository,
      namespaces: [{ namespaceId: "ns_test", profiles: ["git-read", "git-full"] }],
    })),
  });
}

test("hosted repository egress selects only public GitHub API and Git IPv4 networks", () => {
  const meta = {
    api: ["140.82.112.0/20", "2606:50c0::/32"],
    git: ["140.82.112.0/20", "20.201.28.148/32"],
    actions: ["4.0.0.0/8"],
  };
  function select(metadata) {
    return spawnSync("python3", ["scripts/ci/github-repository-egress.py"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: JSON.stringify(metadata),
    });
  }
  const result = select(meta);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    githubApiAndGit: ["140.82.112.0/20", "20.201.28.148/32"],
  });
  for (const git of [
    undefined,
    [],
    ["2606:50c0::/32"],
    ["0.0.0.0/0"],
    ["172.0.0.0/8"],
    ["140.82.112.3/20"],
  ]) {
    const invalid = select({ ...meta, git });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, "");
  }
});

async function runQaCredentialMaterializer(
  t,
  overrides = {},
  registry = qaRegistry(["openclaw/openclaw-enterprise"]),
) {
  const directory = await temporaryDirectory(t, "qa-credentials-");
  const githubEnv = join(directory, "github-env");
  const registryFile = join(directory, "reviewed-registry.json");
  await writeFile(registryFile, registry, { mode: 0o600 });
  await writeFile(
    join(directory, "github-repository-egress.json"),
    JSON.stringify({
      githubApiAndGit: ["140.82.112.0/20"],
    }),
  );
  const env = {
    RUNNER_TEMP: directory,
    GITHUB_ENV: githubEnv,
    GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
    OPENAI_API_KEY: "synthetic-openai-key",
    CODEX_ACCESS_TOKEN: "synthetic-codex-token",
    SLACK_APP_TOKEN: "synthetic-slack-app-token",
    SLACK_BOT_TOKEN: "synthetic-slack-bot-token",
    SLACK_SENDER_TOKEN: "synthetic-slack-sender-token",
    OCC_TEST_QA_SLACK_CHANNEL_ID: "C0123456789",
    OCC_TEST_QA_REPOSITORY_AUTHORIZED: "1",
    REPOSITORY_REGISTRY_FILE: registryFile,
    REPOSITORY_APP_KEY: "synthetic-private-key",
    ...overrides,
  };
  const result = spawnSync(globalThis.process.execPath, ["scripts/ci/qa-matrix-credentials.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
  return { ...result, directory, githubEnv, registryFile };
}

test("QA credential materializer reads reviewed registry files only for repository scenarios", async (t) => {
  const registryFile = "scripts/ci/qa-repositories/default.json";
  const registry = await readFile(join(repositoryRoot, registryFile), "utf8");
  const result = await runQaCredentialMaterializer(t, { REPOSITORY_REGISTRY_FILE: registryFile });
  assert.equal(result.status, 0, result.stderr);
  const exported = await readFile(result.githubEnv, "utf8");
  assert.match(exported, /OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY=/);
  assert.match(exported, /OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY=/);
  assert.doesNotMatch(exported, /OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE=/);
  const repository = join(result.directory, "qa-matrix-credentials", "repository");
  assert.equal(await readFile(join(repository, "registry.json"), "utf8"), registry);
  assert.deepEqual(JSON.parse(await readFile(join(repository, "upstream-cidrs.json"), "utf8")), {
    githubApiAndGit: ["140.82.112.0/20"],
  });
  assert.equal(
    await readFile(join(repository, "private-key.pem"), "utf8"),
    "synthetic-private-key",
  );
  assert.equal((await stat(join(repository, "registry.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(repository, "private-key.pem"))).mode & 0o777, 0o600);
  assert.doesNotMatch(exported, /synthetic-private-key|fixture-owner/);

  // Invalid inputs stop materialization without copying their contents into errors.
  for (const [overrides, contents, error] of [
    [{ REPOSITORY_REGISTRY_FILE: undefined }, registry, /REPOSITORY_REGISTRY_FILE is required/],
    [
      { REPOSITORY_REGISTRY_FILE: join(result.directory, "missing.json") },
      registry,
      /REPOSITORY_REGISTRY_FILE must name a readable file/,
    ],
    [{}, "{synthetic-private-key", /REPOSITORY_REGISTRY_FILE must contain valid JSON/],
    [{}, "[]", /REPOSITORY_REGISTRY_FILE must contain an object/],
    [{}, "{}", /repository registry must contain repositories/],
  ]) {
    const failure = await runQaCredentialMaterializer(t, overrides, contents);
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, error);
    assert.doesNotMatch(failure.stderr, /synthetic-private-key/);
  }

  // Model-only advisory runs need no repository metadata or App key.
  const noRepository = await runQaCredentialMaterializer(t, {
    OCC_TEST_QA_PRESET: "OpenClaw",
    OCC_TEST_QA_SCENARIOS: "model-ui",
    REPOSITORY_REGISTRY_FILE: undefined,
    REPOSITORY_APP_KEY: undefined,
    QA_REPOSITORY_FIXTURE: "isolated",
  });
  assert.equal(noRepository.status, 0, noRepository.stderr);
  assert.doesNotMatch(
    await readFile(noRepository.githubEnv, "utf8"),
    /OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY/,
  );
});

test("QA credential materializer validates isolated repository fixture target", async (t) => {
  const registryFile = "scripts/ci/qa-repositories/isolated.json";
  const registry = await readFile(join(repositoryRoot, registryFile), "utf8");
  const target = JSON.parse(registry).repositories[0].repository;
  const success = await runQaCredentialMaterializer(t, {
    QA_REPOSITORY_FIXTURE: "isolated",
    QA_ISOLATED_REPOSITORY_FULL_NAME: target,
    REPOSITORY_REGISTRY_FILE: registryFile,
    REPOSITORY_APP_KEY: "synthetic-isolated-private-key",
  });
  assert.equal(success.status, 0, success.stderr);
  const repository = join(success.directory, "qa-matrix-credentials", "repository");
  assert.equal(await readFile(join(repository, "registry.json"), "utf8"), registry);
  assert.equal(
    await readFile(join(repository, "private-key.pem"), "utf8"),
    "synthetic-isolated-private-key",
  );
  const exported = await readFile(success.githubEnv, "utf8");
  assert.match(exported, /OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY=/);
  assert.match(exported, /OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY=/);
  assert.match(exported, /QA_REPOSITORY_FIXTURE=isolated/);
  assert.doesNotMatch(exported, /OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE=/);
  assert.doesNotMatch(exported, /synthetic-observer-token|synthetic-isolated-private-key/);
  const runnerEnv = Object.fromEntries(
    exported
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  const runnerSelection = selectQaMatrix({
    ...runnerEnv,
    OCC_TEST_QA_SCENARIOS: "git-write",
    OCC_TEST_QA_GITHUB_OBSERVER_BINARY: "gh",
    OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE: "/private/static-token",
  });
  assert.ok(
    runnerSelection.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY"),
  );
  assert.ok(!runnerSelection.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_BINARY"));
  assert.ok(!runnerSelection.requiredEnv.includes("OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE"));
  assert.doesNotThrow(() =>
    validateQaInputs(runnerSelection, {
      ...runnerEnv,
      OCC_TEST_QA_REPOSITORY_AUTHORIZED: "1",
    }),
  );

  const missingTarget = await runQaCredentialMaterializer(
    t,
    {
      QA_REPOSITORY_FIXTURE: "isolated",
    },
    qaRegistry([target]),
  );
  assert.notEqual(missingTarget.status, 0);
  assert.match(missingTarget.stderr, /QA_ISOLATED_REPOSITORY_FULL_NAME is required/);

  const wrongTarget = await runQaCredentialMaterializer(
    t,
    {
      QA_REPOSITORY_FIXTURE: "isolated",
      QA_ISOLATED_REPOSITORY_FULL_NAME: target,
    },
    qaRegistry(["fixture-owner/other-repo"]),
  );
  assert.notEqual(wrongTarget.status, 0);
  assert.match(wrongTarget.stderr, /must match QA_ISOLATED_REPOSITORY_FULL_NAME/);

  const multipleRepositories = await runQaCredentialMaterializer(
    t,
    {
      QA_REPOSITORY_FIXTURE: "isolated",
      QA_ISOLATED_REPOSITORY_FULL_NAME: target,
    },
    qaRegistry([target, "fixture-owner/other-repo"]),
  );
  assert.notEqual(multipleRepositories.status, 0);
  assert.match(multipleRepositories.stderr, /exactly one repository/);

  const workflowRepository = await runQaCredentialMaterializer(t, {
    QA_REPOSITORY_FIXTURE: "isolated",
    QA_ISOLATED_REPOSITORY_FULL_NAME: "openclaw/openclaw-enterprise",
    REPOSITORY_REGISTRY_FILE: registryFile,
  });
  assert.notEqual(workflowRepository.status, 0);
  assert.match(workflowRepository.stderr, /must not target this workflow repository/);
});

function integrationEnvironment(patch = {}) {
  return {
    name: "integration-main",
    can_admins_bypass: false,
    protection_rules: [],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    ...patch,
  };
}

const mainOnlyPolicies = {
  total_count: 1,
  branch_policies: [{ name: "main", type: "branch" }],
};
const credentialedLanes = [
  "qa-matrix",
  "docker-model",
  "k3d-model",
  "gateway-routing",
  "production-tui",
  "slack",
  "openshell",
  "k3d-otel",
];
const mainRun = {
  GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_TYPE: "branch",
  GITHUB_EVENT_NAME: "push",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "123",
  GITHUB_ACTOR: "dispatcher",
  GITHUB_ACTOR_ID: "42",
  GITHUB_TRIGGERING_ACTOR: "dispatcher",
  GITHUB_TOKEN: "synthetic-workflow-token",
  INPUT_LANE: "all",
};
const approvalEnvironment = integrationEnvironment({
  id: 26285522718,
  name: "integration-main-approval",
  protection_rules: [
    {
      type: "required_reviewers",
      prevent_self_review: false,
      reviewers: [{ type: "Team", reviewer: { id: 19674117 } }],
    },
  ],
});
const approvalReview = {
  state: "approved",
  environments: [{ id: 26285522718, name: "integration-main-approval" }],
  user: { id: 42, login: "dispatcher", type: "User" },
};

function approvalApi(overrides = {}, fetched = []) {
  const responses = {
    "/environments/integration-main-approval": approvalEnvironment,
    "/environments/integration-main-approval/deployment-branch-policies": mainOnlyPolicies,
    "/actions/runs/123/approvals": [approvalReview],
    "/environments/integration-main": integrationEnvironment(),
    "/environments/integration-main/deployment-branch-policies": mainOnlyPolicies,
    ...overrides,
  };
  return async ({ repository, path }) => {
    assert.equal(repository, mainRun.GITHUB_REPOSITORY);
    fetched.push(path);
    assert.ok(Object.hasOwn(responses, path), `unexpected API path ${path}`);
    return responses[path];
  };
}

test("full integration preflight selects automatic main pushes and manual main lanes", () => {
  assert.equal(selectLane({ eventName: "push", ref: "refs/heads/main" }), "all");
  assert.equal(
    selectLane({ eventName: "workflow_dispatch", inputLane: "docker-model" }),
    "docker-model",
  );
  for (const eventName of ["pull_request", "pull_request_target", "schedule"]) {
    assert.throws(() => selectLane({ eventName, ref: "refs/heads/main" }), /Unsupported/);
  }
  assert.throws(
    () =>
      selectLane({ eventName: "push", ref: "refs/heads/dev/kevinlin/integration-main-cutover" }),
    /Unsupported/,
  );
  assert.throws(() => requiredEnvironmentsForLane("provider-account"), /Unknown lane/);
  for (const lane of [...credentialedLanes, "all"]) {
    assert.deepEqual(requiredEnvironmentsForLane(lane), ["integration-main"]);
  }
  for (const lane of [
    "helper-timeout",
    "logging-collector",
    "dev-up-k3d",
    "skipper-prepared-git-installed",
  ]) {
    assert.deepEqual(requiredEnvironmentsForLane(lane), []);
  }
});

test("integration environment policy rejects broad, incomplete or bypassable rules", () => {
  assert.doesNotThrow(() =>
    validateEnvironmentPolicy("integration-main", integrationEnvironment(), mainOnlyPolicies),
  );
  for (const can_admins_bypass of [undefined, true]) {
    assert.throws(
      () =>
        validateEnvironmentPolicy(
          "integration-main",
          integrationEnvironment({ can_admins_bypass }),
          mainOnlyPolicies,
        ),
      /disable administrator bypass/,
    );
  }
  for (const deployment_branch_policy of [
    null,
    { custom_branch_policies: false, protected_branches: true },
    { custom_branch_policies: true, protected_branches: true },
  ]) {
    assert.throws(
      () =>
        validateEnvironmentPolicy(
          "integration-main",
          integrationEnvironment({ deployment_branch_policy }),
          mainOnlyPolicies,
        ),
      /main-only policy/,
    );
  }
  assert.throws(
    () => validateEnvironmentPolicy("integration-main", approvalEnvironment, mainOnlyPolicies),
    /must not require reviewers/,
  );
  for (const policies of [
    undefined,
    { total_count: 0, branch_policies: [] },
    { total_count: 2, branch_policies: mainOnlyPolicies.branch_policies },
    { branch_policies: mainOnlyPolicies.branch_policies },
    { total_count: 1, branch_policies: [{ name: "main", type: "tag" }] },
    { total_count: 1, branch_policies: [{ name: "main" }] },
    ...["*", "release", "refs/pull/*/merge", "dev/kevinlin/integration-main-cutover", "main"].map(
      (name) => ({
        total_count: 2,
        branch_policies: [...mainOnlyPolicies.branch_policies, { name, type: "branch" }],
      }),
    ),
  ]) {
    assert.throws(
      () => validateEnvironmentPolicy("integration-main", integrationEnvironment(), policies),
      /only the main branch/,
    );
  }
});

test("verified docs pushes omit runtime lanes while keeping environment policy checks", async () => {
  const fetched = [];
  assert.deepEqual(
    await validateFullIntegrationPreflight({
      env: mainRun,
      github: approvalApi({}, fetched),
      impactMode: "docs",
    }),
    { selectedLane: "docs", runAll: false },
  );
  assert.deepEqual(fetched, [
    "/environments/integration-main",
    "/environments/integration-main/deployment-branch-policies",
  ]);
  await assert.rejects(
    validateFullIntegrationPreflight({
      env: mainRun,
      github: approvalApi({
        "/environments/integration-main": { ...integrationEnvironment(), can_admins_bypass: true },
      }),
      impactMode: "docs",
    }),
    /disable administrator bypass/,
  );
  assert.equal(
    selectLane({ eventName: "workflow_dispatch", inputLane: "all", impactMode: "docs" }),
    "all",
  );
  assert.equal(
    selectLane({ eventName: "push", ref: "refs/heads/main", impactMode: "tests" }),
    "all",
  );
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const readWorkflow = async (name) =>
    loadYaml(
      await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
    );
  const dispatcher = await readWorkflow("full-integration");
  // A workflow-level lock would let a docs-only push replace pending full work
  // before the selector runs. Only the eligible reusable-workflow call may lock.
  assert.equal(dispatcher.concurrency, undefined);
  const execution = await readWorkflow("full-integration-execution");
  const execute = dispatcher.jobs.execute;
  assert.equal(execution.concurrency, undefined);
  assert.deepEqual(
    new Set(Object.keys(dispatcher.jobs)),
    new Set(["manual-approval", "preflight", "execute", "reject-selection"]),
  );
  assert.equal(dispatcher.jobs.preflight.concurrency, undefined);
  assert.equal(dispatcher.jobs["manual-approval"].concurrency, undefined);
  assert.equal(execute.needs, "preflight");
  assert.equal(execute.uses, "./.github/workflows/full-integration-execution.yml");
  assert.deepEqual(execution.on, {
    workflow_call: { inputs: { lane: { type: "string", default: "" } } },
  });
  assert.equal(execute.with.lane, "${{ inputs.lane || '' }}");
  assert.equal(execute.secrets, "inherit");
  assert.deepEqual(execution.permissions, dispatcher.permissions);
  assert.deepEqual(execution.env, dispatcher.env);
  const selectStep = (workflow) =>
    workflow.jobs.preflight.steps.find((step) => step.id === "select");
  assert.equal(selectStep(dispatcher).run.trim(), "node scripts/ci/full-integration-preflight.mjs");
  assert.deepEqual(selectStep(execution), selectStep(dispatcher));
  assert.ok(!JSON.stringify(dispatcher).includes("full-integration-admitted"));
  assert.ok(
    execution.jobs.preflight.steps.some(
      (step) => step.with?.name === "full-integration-admitted-v1",
    ),
  );

  const github = {
    repository: mainRun.GITHUB_REPOSITORY,
    ref: mainRun.GITHUB_REF,
    ref_type: "branch",
    event_name: "push",
    run_attempt: "1",
  };
  for (const [file, workflow] of Object.entries({ dispatcher, execution })) {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      assert.ok(job.if, "every Full Integration job has an explicit selection condition");
      assert.equal(
        workflowCondition(job.if, {
          github,
          needs: {
            preflight: { result: "success", outputs: { selected_lane: "docs", run_all: "false" } },
            "manual-approval": { result: "skipped" },
            "runtime-artifact": { result: "skipped" },
            slack: { result: "skipped" },
          },
          inputs: {},
          always: () => true,
        }),
        name === "preflight",
        `docs push: ${file}/${name}`,
      );
    }
  }
  // Feed real authorization decisions into the shipped call condition. This is
  // local admission proof; GitHub's scheduler still needs hosted qualification.
  for (const impactMode of ["docs", "tests", "full"]) {
    const selected = await validateFullIntegrationPreflight({
      env: mainRun,
      github: approvalApi(),
      impactMode,
    });
    const preflight = {
      result: "success",
      outputs: { selected_lane: selected.selectedLane, run_all: String(selected.runAll) },
    };
    assert.equal(
      workflowCondition(execute.if, { github, needs: { preflight } }),
      impactMode !== "docs",
    );
    assert.equal(
      workflowCondition(execute.if, { github, needs: { preflight }, cancelled: () => true }),
      false,
    );
  }
  const reject = dispatcher.jobs["reject-selection"];
  assert.deepEqual(reject.permissions, {});
  assert.doesNotMatch(JSON.stringify(reject), /secrets\.|actions\/checkout/);
  // Model completed-job output loss or inconsistency. A valid docs decision
  // succeeds without the lock; every invalid decision reports failure outside it.
  for (const eventName of ["push", "workflow_dispatch"]) {
    for (const selectedLane of ["", "unknown-lane", "docs", "all", "gateway-routing"]) {
      const context = {
        github: { ...github, event_name: eventName },
        inputs: { lane: "gateway-routing" },
        needs: { preflight: { result: "success", outputs: { selected_lane: selectedLane } } },
      };
      const admitted =
        eventName === "push" ? selectedLane === "all" : selectedLane === "gateway-routing";
      const docs = eventName === "push" && selectedLane === "docs";
      assert.equal(
        workflowCondition(execute.if, context),
        admitted,
        `${eventName}: ${selectedLane}`,
      );
      assert.equal(
        workflowCondition(reject.if, context),
        !admitted && !docs,
        `${eventName}: ${selectedLane}`,
      );
      if (!admitted && !docs) {
        const result = spawnSync("/bin/sh", ["-c", reject.steps[0].run], {
          encoding: "utf8",
          timeout: 30_000,
          env: {},
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stdout, /Preflight did not publish a matching supported lane/);
      }
    }
  }
  const manualDocs = {
    github: { ...github, event_name: "workflow_dispatch" },
    inputs: { lane: "docs" },
    needs: { preflight: { result: "success", outputs: { selected_lane: "docs" } } },
  };
  assert.equal(workflowCondition(execute.if, manualDocs), false);
  assert.equal(workflowCondition(reject.if, manualDocs), true);
});

test("main pushes and retries require no manual approval or team credential", async () => {
  for (const attempt of ["1", "2"]) {
    const fetched = [];
    assert.deepEqual(
      await validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_RUN_ATTEMPT: attempt },
        github: approvalApi({}, fetched),
      }),
      { selectedLane: "all", runAll: true },
    );
    assert.deepEqual(fetched, [
      "/environments/integration-main",
      "/environments/integration-main/deployment-branch-policies",
    ]);
  }
});

test("manual preflight checks native team approval before reading integration credentials policy", async () => {
  for (const lane of [
    ...credentialedLanes,
    "all",
    "dev-up-k3d",
    "skipper-prepared-git-installed",
  ]) {
    const fetched = [];
    assert.deepEqual(
      await validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch", INPUT_LANE: lane },
        github: approvalApi({}, fetched),
      }),
      { selectedLane: lane, runAll: lane === "all" },
    );
    assert.deepEqual(fetched.slice(0, 3), [
      "/environments/integration-main-approval",
      "/environments/integration-main-approval/deployment-branch-policies",
      "/actions/runs/123/approvals",
    ]);
    assert.equal(
      fetched.includes("/environments/integration-main"),
      credentialedLanes.includes(lane) || lane === "all",
    );
  }
});

test("preflight denies foreign sources, old branch routes and manual reruns before metadata reads", async () => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    for (const patch of [
      { GITHUB_REPOSITORY: "other-owner/openclaw-enterprise" },
      { GITHUB_REF: "refs/tags/main", GITHUB_REF_TYPE: "tag" },
      { GITHUB_REF_TYPE: undefined },
      { GITHUB_REF: "refs/pull/1/merge" },
      { GITHUB_REF: "refs/heads/dev/kevinlin/integration-main-cutover" },
      { GITHUB_REF: "refs/heads/reviewed-branch", INPUT_LANE: "dev-up-k3d" },
      { GITHUB_REF: "refs/heads/reviewed-branch", INPUT_LANE: "skipper-prepared-git-installed" },
      ...(eventName === "workflow_dispatch"
        ? [{ GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_RUN_ATTEMPT: undefined }]
        : []),
    ]) {
      const fetched = [];
      await assert.rejects(
        validateFullIntegrationPreflight({
          env: { ...mainRun, GITHUB_EVENT_NAME: eventName, ...patch },
          github: approvalApi({}, fetched),
        }),
        /main|this repository|reruns/,
      );
      assert.deepEqual(fetched, []);
    }
  }
  assert.throws(() => assertSourceRef("refs/heads/reviewed-branch"), /main/);
});

test("manual preflight binds review to original actor ID and actual triggering actor", async () => {
  for (const patch of [
    { GITHUB_TRIGGERING_ACTOR: "other-user" },
    { GITHUB_TRIGGERING_ACTOR: undefined },
    { GITHUB_ACTOR: undefined },
    { GITHUB_ACTOR_ID: undefined },
    { GITHUB_ACTOR_ID: "0" },
    { GITHUB_ACTOR_ID: "9007199254740992" },
    { GITHUB_RUN_ID: "123/approvals" },
  ]) {
    const fetched = [];
    await assert.rejects(
      validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch", ...patch },
        github: approvalApi({}, fetched),
      }),
      /identified dispatcher/,
    );
    assert.deepEqual(fetched, []);
  }
});

test("manual preflight refuses missing, rejected, duplicate and wrong-identity reviews", async () => {
  for (const reviews of [
    [],
    null,
    {},
    [{ ...approvalReview, state: "pending" }],
    [{ ...approvalReview, state: "rejected" }],
    [approvalReview, approvalReview],
    [approvalReview, { ...approvalReview, state: "rejected" }],
    [{ ...approvalReview, user: { ...approvalReview.user, id: 43 } }],
    [{ ...approvalReview, user: { ...approvalReview.user, login: "other-user" } }],
    [{ ...approvalReview, user: undefined }],
    [{ ...approvalReview, environments: [{ id: 1, name: "integration-main-approval" }] }],
    [{ ...approvalReview, environments: [{ id: 26285522718, name: "other-environment" }] }],
  ]) {
    const fetched = [];
    await assert.rejects(
      validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch" },
        github: approvalApi({ "/actions/runs/123/approvals": reviews }, fetched),
      }),
      /approval|approved environment review/,
    );
    assert.equal(fetched.includes("/environments/integration-main"), false);
  }
});

test("manual preflight rejects altered approval environment protection before history reads", async () => {
  for (const environment of [
    { ...approvalEnvironment, id: 1 },
    { ...approvalEnvironment, name: "other" },
    { ...approvalEnvironment, can_admins_bypass: true },
    { ...approvalEnvironment, protection_rules: [] },
    {
      ...approvalEnvironment,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: true,
          reviewers: approvalEnvironment.protection_rules[0].reviewers,
        },
      ],
    },
    {
      ...approvalEnvironment,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [{ type: "Team", reviewer: { id: 1 } }],
        },
      ],
    },
    {
      ...approvalEnvironment,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [{ type: "User", reviewer: { id: 42 } }],
        },
      ],
    },
    {
      ...approvalEnvironment,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [
            ...approvalEnvironment.protection_rules[0].reviewers,
            { type: "User", reviewer: { id: 42 } },
          ],
        },
      ],
    },
  ]) {
    const fetched = [];
    await assert.rejects(
      validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch" },
        github: approvalApi({ "/environments/integration-main-approval": environment }, fetched),
      }),
      /approval|administrator bypass|main-only policy|main branch/,
    );
    assert.equal(fetched.includes("/actions/runs/123/approvals"), false);
    assert.equal(fetched.includes("/environments/integration-main"), false);
  }
});

test("manual approval API failures stop before protected environment access", async () => {
  for (const failurePath of [
    "/environments/integration-main-approval",
    "/environments/integration-main-approval/deployment-branch-policies",
    "/actions/runs/123/approvals",
  ]) {
    const fetched = [];
    const valid = approvalApi({}, fetched);
    await assert.rejects(
      validateFullIntegrationPreflight({
        env: { ...mainRun, GITHUB_EVENT_NAME: "workflow_dispatch" },
        github: async (request) => {
          if (request.path === failurePath) {
            throw new Error("GitHub API unavailable");
          }
          return valid(request);
        },
      }),
      /API unavailable/,
    );
    assert.equal(fetched.includes("/environments/integration-main"), false);
  }
});

function workflowCondition(expression, context) {
  return runInNewContext(
    expression
      .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
      .replace(/needs\.([a-z][a-z0-9-]*)/g, 'needs["$1"]'),
    { cancelled: () => false, ...context },
  );
}

test("workflow permits main push retries and refuses approval reuse on manual retries", async () => {
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const workflow = loadYaml(
    await readFile(
      new URL("../../.github/workflows/full-integration.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.on.pull_request, undefined);
  const execution = loadYaml(
    await readFile(
      new URL("../../.github/workflows/full-integration-execution.yml", import.meta.url),
      "utf8",
    ),
  );
  const jobs = [...Object.entries(workflow.jobs), ...Object.entries(execution.jobs)].filter(
    ([name]) =>
      !["manual-approval", "preflight", "full-aggregate", "reject-selection"].includes(name),
  );
  assert.ok(jobs.length > 0);
  for (const [name, job] of jobs) {
    for (const event_name of ["push", "workflow_dispatch"]) {
      const github = {
        repository: mainRun.GITHUB_REPOSITORY,
        ref: mainRun.GITHUB_REF,
        ref_type: "branch",
        run_attempt: "1",
        event_name,
      };
      const needs = {
        preflight: {
          result: "success",
          outputs: { selected_lane: name === "logging-collector" ? name : "all", run_all: "true" },
        },
        slack: { result: "success" },
        "runtime-artifact": { result: "success" },
      };
      const inputs = { lane: needs.preflight.outputs.selected_lane };
      assert.equal(
        workflowCondition(job.if, { github, needs, inputs }),
        true,
        `${name}: first attempt`,
      );
      assert.equal(
        workflowCondition(job.if, { github: { ...github, run_attempt: "2" }, needs, inputs }),
        event_name === "push",
        `${name}: only main pushes can retry`,
      );
      for (const patch of [
        { ref: "refs/tags/main", ref_type: "tag" },
        { repository: "other/repository" },
        { event_name: "pull_request" },
      ]) {
        assert.equal(
          workflowCondition(job.if, { github: { ...github, ...patch }, needs, inputs }),
          false,
          `${name}: ${JSON.stringify(patch)}`,
        );
      }
      assert.equal(
        workflowCondition(job.if, {
          github,
          needs: { ...needs, preflight: { result: "failure", outputs: { selected_lane: "all" } } },
        }),
        false,
        `${name}: failed preflight`,
      );
    }
  }
  const manual = workflow.jobs["manual-approval"];
  assert.equal(manual.environment, "integration-main-approval");
  assert.deepEqual(manual.permissions, {});
  assert.doesNotMatch(JSON.stringify(manual), /secrets\.|actions\/checkout/);
  const github = {
    repository: mainRun.GITHUB_REPOSITORY,
    ref: mainRun.GITHUB_REF,
    ref_type: "branch",
    run_attempt: "1",
    event_name: "push",
  };
  assert.equal(
    workflowCondition(workflow.jobs.preflight.if, {
      github,
      needs: { "manual-approval": { result: "skipped" } },
    }),
    true,
  );
  for (const event_name of ["push", "workflow_dispatch"]) {
    assert.equal(
      workflowCondition(workflow.jobs.preflight.if, {
        github: { ...github, event_name, run_attempt: "2" },
        needs: { "manual-approval": { result: "skipped" } },
      }),
      true,
      "Retries reach preflight so refused manual reruns cannot silently skip every job",
    );
  }
  assert.equal(
    workflowCondition(manual.if, {
      github: { ...github, event_name: "workflow_dispatch", run_attempt: "2" },
    }),
    false,
  );
  // Run the shipped preflight command: manual retries must report failure while
  // the approval and expensive execution jobs remain excluded above.
  const select = workflow.jobs.preflight.steps.find((step) => step.id === "select");
  const refused = spawnSync("/bin/sh", ["-c", select.run], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: {
      ...mainRun,
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ATTEMPT: "2",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(refused.error, undefined);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /Manual integration reruns are refused/);
  for (const result of ["skipped", "failure", "cancelled", "success"]) {
    assert.equal(
      workflowCondition(workflow.jobs.preflight.if, {
        github: { ...github, event_name: "workflow_dispatch" },
        needs: { "manual-approval": { result } },
      }),
      result === "success",
    );
  }
});

test("manual dev-up workflow prepares the complete lane and aggregates its exact source", async (t) => {
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const dispatcher = loadYaml(await read(".github/workflows/full-integration.yml"));
  const workflow = loadYaml(await read(".github/workflows/full-integration-execution.yml"));
  const action = loadYaml(await read(".github/actions/run-ci-lane/action.yml"));
  const finalCleanup = action.runs.steps.find((step) => step.id === "cleanup-lane");
  assert.equal(finalCleanup.if, "always()");
  assert.equal(
    finalCleanup.run,
    'node scripts/ci/cleanup.mjs --state "$RUNNER_TEMP/state/${{ inputs.lane }}.json" --results "$RUNNER_TEMP/results/${{ inputs.lane }}.json"',
  );
  const suites = JSON.parse(await read("scripts/ci/test-suites.json"));
  assert.ok(dispatcher.on.workflow_dispatch.inputs.lane.options.includes("dev-up-k3d"));
  assert.deepEqual(dispatcher.on.push.branches, ["main"]);
  assert.equal(dispatcher.on.pull_request, undefined);
  assert.equal(dispatcher.on.pull_request_target, undefined);
  assert.equal(dispatcher.on.workflow_dispatch.inputs.source_ref, undefined);
  for (const selected of [...Object.values(dispatcher.jobs), ...Object.values(workflow.jobs)]) {
    for (const step of selected.steps ?? []) {
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(step.with.ref, "${{ github.sha }}");
        assert.equal(step.with["persist-credentials"], false);
      }
    }
  }
  // A pending manual approval cannot occupy the push queue or replace another
  // pending approval, even if both dispatchers select the same lane.
  const queue = (eventName, runId) =>
    workflowCondition(dispatcher.jobs.execute.concurrency.group, {
      github: { event_name: eventName, run_id: runId },
      format: (template, value) => template.replace("{0}", value),
    });
  assert.equal(dispatcher.jobs.execute.concurrency["cancel-in-progress"], false);
  const pushQueue = queue("push", "100");
  const manualQueue = queue("workflow_dispatch", "101");
  assert.equal(pushQueue, queue("push", "102"));
  assert.notEqual(pushQueue, manualQueue);
  assert.notEqual(manualQueue, queue("workflow_dispatch", "103"));

  // Both event types acquire the same resource lock only after authorization.
  const queuedLanes = ["slack", "dev-up-k3d", "skipper-prepared-git-installed"];
  assert.equal(dispatcher.jobs.execute.concurrency.queue, undefined);
  const jobsWithQueue = Object.entries(workflow.jobs)
    .filter(([, job]) => job.concurrency?.queue !== undefined)
    .map(([lane]) => lane);
  assert.deepEqual(jobsWithQueue.sort(), [...queuedLanes].sort());
  const resourceQueues = new Set();
  for (const lane of queuedLanes) {
    const job = workflow.jobs[lane];
    assert.equal(job.needs, "preflight");
    assert.equal(job.concurrency["cancel-in-progress"], false);
    assert.equal(job.concurrency.queue, "max");
    const group = job.concurrency.group;
    assert.ok(group.startsWith("full-integration-"));
    if (lane === "slack") {
      assert.doesNotMatch(group, /\$\{/);
    } else {
      assert.equal(group, ["full-integration", lane, "${{ github.ref }}"].join("-"));
    }
    assert.ok(!resourceQueues.has(group));
    resourceQueues.add(group);
  }
  // Exercise the hosted workflow input through the same selector that determines
  // which credentials to materialize and which real installation cells run.
  const qaJob = workflow.jobs["qa-matrix"];
  const qaManifest = JSON.parse(await read("scripts/ci/test-suites/qa-matrix.json"));
  const qaRunnerEnv = Object.fromEntries(
    Object.entries(qaJob.env).filter(([name]) => qaManifest.optionalEnv.includes(name)),
  );
  const qaSelection = selectQaMatrix(qaRunnerEnv);
  assert.equal(qaSelection.scope, "partial:selected");
  assert.deepEqual(qaSelection.installations, ["compose", "kubernetes"]);
  for (const cell of qaSelection.cells) {
    assert.deepEqual(
      cell.scenarios,
      cell.preset === "OpenClaw" ? ["model-ui", "console-secrets"] : ["console-secrets"],
    );
  }
  assert.equal(qaSelection.exclusions.length, 2);
  assert.deepEqual(qaSelection.requiredEnv, [
    "OCC_TEST_QA_OPENAI_KEY_FILE",
    "OCC_TEST_QA_CODEX_TOKEN_FILE",
  ]);
  assert.deepEqual(
    Object.keys(
      qaJob.steps.find(({ name }) => name === "Materialize selected QA credentials").env,
    ).sort(),
    ["CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"],
  );
  const job = workflow.jobs["dev-up-k3d"];
  assert.equal(job.environment, undefined);
  assert.deepEqual(job.env, {
    NODE_BASE_IMAGE: "${{ vars.CONTAINER_NODE_BASE_IMAGE }}",
  });
  assert.equal(job.needs, "preflight");
  assert.equal(job["runs-on"], "ubuntu-22.04");
  for (const lane of ["dev-up-k3d", "all", "k3d-model"]) {
    assert.equal(
      workflowCondition(job.if, {
        github: {
          repository: mainRun.GITHUB_REPOSITORY,
          ref: mainRun.GITHUB_REF,
          ref_type: "branch",
          run_attempt: "1",
          event_name: "workflow_dispatch",
        },
        needs: { preflight: { result: "success", outputs: { selected_lane: lane } } },
      }),
      lane === "dev-up-k3d" || lane === "all",
    );
  }
  assert.equal(job.steps[0].with.ref, "${{ github.sha }}");
  assert.equal(job.steps[0].with["persist-credentials"], false);
  const run = job.steps.find(({ uses }) => uses === "./.github/actions/run-ci-lane");
  assert.equal(run.with.lane, "dev-up-k3d");
  assert.equal(run.with.profile, "full");
  assert.equal(run.with["artifact-prefix"], "full-results");
  assert.ok(workflow.jobs["full-aggregate"].needs.includes("dev-up-k3d"));
  assert.equal(suites.groups.ci.includes("dev-up-k3d"), false);
  for (const lane of dispatcher.on.workflow_dispatch.inputs.lane.options) {
    if (lane !== "all") {
      assert.ok(suites.groups.full.includes(lane), `all must require ${lane} results`);
    }
  }
  const privateGit = "skipper-prepared-git-installed";
  const gitJob = workflow.jobs[privateGit];
  assert.equal(gitJob.environment, undefined);
  assert.deepEqual(gitJob.permissions, { contents: "read" });
  assert.equal(gitJob.needs, "preflight");
  assert.equal(gitJob["runs-on"], "ubuntu-22.04");
  for (const lane of [privateGit, "all", "dev-up-k3d"]) {
    assert.equal(
      workflowCondition(gitJob.if, {
        github: {
          repository: mainRun.GITHUB_REPOSITORY,
          ref: mainRun.GITHUB_REF,
          ref_type: "branch",
          run_attempt: "1",
          event_name: "workflow_dispatch",
        },
        needs: { preflight: { result: "success", outputs: { selected_lane: lane } } },
      }),
      [privateGit, "all"].includes(lane),
    );
  }
  assert.equal(gitJob.steps[0].with.ref, "${{ github.sha }}");
  assert.equal(gitJob.steps[0].with["persist-credentials"], false);
  assert.doesNotMatch(JSON.stringify(gitJob), /secrets\.|diagnostics\//);
  const [receipt] = gitJob.steps.filter(({ uses }) => uses?.startsWith("actions/upload-artifact@"));
  assert.equal(receipt.with.path, "${{ runner.temp }}/results/" + privateGit + ".json");
  assert.equal(receipt.if, undefined, "publish the receipt only after successful fixture cleanup");
  assert.ok(workflow.jobs["full-aggregate"].needs.includes(privateGit));
  const qa = workflow.jobs["qa-matrix"];
  assert.ok(qa.needs.includes("slack"), "shared Slack consumers must run sequentially");
  // A failed focused Slack proof must not suppress the broader QA proof. Only
  // failed preflight, an unselected lane, or run cancellation should prevent it.
  for (const lane of ["all", "qa-matrix", "docker-model"]) {
    for (const preflight of ["success", "failure"]) {
      for (const slack of ["success", "failure", "skipped"]) {
        for (const cancelled of [false, true]) {
          const selected = runInNewContext(qa.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
            inputs: { lane },
            github: {
              repository: mainRun.GITHUB_REPOSITORY,
              ref: mainRun.GITHUB_REF,
              ref_type: "branch",
              run_attempt: "1",
              event_name: "workflow_dispatch",
            },
            needs: {
              preflight: { result: preflight, outputs: { selected_lane: lane } },
              slack: { result: slack },
            },
            always: () => true,
            cancelled: () => cancelled,
          });
          assert.equal(
            selected,
            !cancelled && preflight === "success" && ["all", "qa-matrix"].includes(lane),
            `${lane}: preflight ${preflight}, slack ${slack}, cancelled ${cancelled}`,
          );
        }
      }
    }
  }
  const inputs = { lane: "dev-up-k3d", profile: run.with.profile };
  const directory = await temporaryDirectory(t, "manual-dev-up-image-mode-");
  const output = join(directory, "outputs");
  const mode = action.runs.steps.find(({ id }) => id === "image-mode");
  const imageSelection = spawnSync("bash", ["-c", mode.run], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CI_SELECTED_LANE: inputs.lane,
      CI_SELECTED_TEST_FILE: "",
      GITHUB_OUTPUT: output,
    },
  });
  assert.equal(imageSelection.status, 0, imageSelection.stderr);
  const firstAgent = /^first-agent=(true|false)$/m.exec(await readFile(output, "utf8"))?.[1];
  assert.ok(firstAgent, "the shipped image selection must publish its mode");
  const sourceBuild = /^source-build=(true|false)$/m.exec(await readFile(output, "utf8"))?.[1];
  assert.ok(sourceBuild);
  const evaluate = (expression) =>
    runInNewContext(
      expression
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        // GitHub property names may contain hyphens; JavaScript needs brackets.
        .replaceAll(
          "steps.image-mode.outputs.first-agent",
          'steps["image-mode"].outputs["first-agent"]',
        )
        .replaceAll(
          "steps.image-mode.outputs.source-build",
          'steps["image-mode"].outputs["source-build"]',
        ),
      {
        inputs,
        steps: {
          "image-mode": { outputs: { "first-agent": firstAgent, "source-build": sourceBuild } },
        },
        startsWith: (value, prefix) => value.startsWith(prefix),
      },
    );
  for (const name of [
    "Set up Go toolchain",
    "Build Go CLI for development installation proof",
    "Install browser dependencies",
    "Enable Kubernetes bridge packet filtering",
    // certutil imports the printed CA files into the Keycloak case's browser.
    "Install trusted browser certificate tooling",
  ]) {
    const step = action.runs.steps.find((step) => step.name === name);
    assert.equal(evaluate(step.if), true, `${name} must run for this lane`);
  }
  const timeout = Number(
    evaluate(
      action.runs.steps.find(({ name }) => name === "Run lane").env.CI_RUNNER_TEST_TIMEOUT_MS,
    ),
  );
  assert.ok(timeout >= 7_800_000, "six sequential cases need at least 130 minutes");
  assert.ok(job["timeout-minutes"] * 60_000 > timeout, "job must also allow setup and cleanup");
  const secretStep = action.runs.steps.find(
    ({ name }) => name === "Expose image cache credentials",
  );
  assert.equal(evaluate(secretStep.if), true);
});
