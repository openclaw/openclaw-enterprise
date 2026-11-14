import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { admitProducer, validateResults } from "../../scripts/ci/full-integration-reuse.ts";
import { projectSkipperRunnerReceipt } from "../../scripts/ci/skipper-release.ts";
import { loadTestSuites } from "../../scripts/ci/test-suites.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

import { array, jsonRecord, present, record, text } from "./full-integration-json-fixture.ts";
import { readSuiteLane, reuseFixture } from "./full-integration-reuse-fixture.ts";

function files(lane: Record<string, unknown>) {
  return array(lane.files).map((raw) => {
    const file = record(raw);
    const path = text(file.path);
    const expectedTests =
      file.expectedTests === undefined ? [] : array(file.expectedTests).map(text);
    return { raw: file, path, expectedTests };
  });
}

function mutableReceipt(source: string) {
  const value = jsonRecord(source);
  const first = record(array(value.files)[0]);
  return { value, first };
}

test("full coverage receipts require real case evidence and retain approved same-SHA CI reuse", async (t) => {
  const { get, run, sha, rows } = await reuseFixture();
  const lane = "logging-collector";
  assert.ok(rows.some((row) => row.lane === lane));
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const suites = loadTestSuites(join(repositoryRoot, "scripts/ci/test-suites.json"));
  const reusedFiles = files(readSuiteLane(suites, lane));
  const full = loadTestSuites(
    join(repositoryRoot, "scripts/ci/test-suites.json"),
    "full-integration",
  );
  const installers = readSuiteLane(full, "openshell-installers");
  const installerPaths = files(installers).map(({ path }) => path);
  assert.deepEqual(installers.requiredEnv, ["OPENAI_API_KEY", "OCC_TEST_OPENAI_MODEL"]);
  for (const { raw: file, path } of files(readSuiteLane(full, "openshell-policy"))) {
    assert.equal(
      array(file.requiredEnv).includes("CODEX_ACCESS_TOKEN"),
      ![
        "tests/integration/openshell-refresh-real.test.ts",
        "tests/integration/openshell-withdrawal-real.test.ts",
        "tests/integration/openshell-gateway-tool-policy-real.test.ts",
      ].includes(path),
    );
  }
  const skipperLane = "skipper-prepared-git-installed";
  const skipperFiles = files(readSuiteLane(full, skipperLane));
  const fixtureRoot = await temporaryDirectory(t, "full-coverage-receipts-");
  const policyPath = "tests/integration/coverage-policy.test.mjs";
  const runner = join(repositoryRoot, "scripts/ci/run-tests.ts");
  const json = (path: string, value: object) => writeFile(path, JSON.stringify(value));
  const generate = async (path: string, names: string[], body: string, suite = "") => {
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
  const invoke = (command: string, target: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
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
  const clean = (target: string, directory = "results") =>
    spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "scripts/ci/cleanup.ts"),
        "--state",
        join(fixtureRoot, "state", `${target}.json`),
        "--results",
        join(fixtureRoot, directory, `${target}.json`),
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 10_000 },
    );
  const produce = (target: string, directory = "results", env: NodeJS.ProcessEnv = {}) => {
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
      [lane]: { files: reusedFiles.map(({ raw }) => raw) },
      [skipperLane]: { files: skipperFiles.map(({ raw }) => raw) },
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
  const privateSkipper = jsonRecord(await readFile(skipperPath, "utf8"));
  const privateFile = record(array(privateSkipper.files)[0]);
  // Unknown diagnostic fields must never widen the published allowlist.
  privateSkipper.diagnostic = "private-output-canary";
  privateFile.diagnostic = "private-output-canary";
  record(array(privateFile.tests)[0]).diagnostic = "private-output-canary";
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
  const verify = async (
    expectedExit: number,
    expectedMarker: boolean,
    env: NodeJS.ProcessEnv = {},
  ) => {
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
      assert.equal(jsonRecord(result.stdout).fullCoverageExercised, true);
      assert.equal(await readFile(marker, "utf8"), "1\n");
      assert.equal(await readFile(output, "utf8"), "full_coverage_exercised=true\n");
    } else {
      assert.equal(jsonRecord(result.stdout).fullCoverageExercised, undefined);
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
  const { value: nullCleanup, first: nullCleanupFile } = mutableReceipt(installedReceipt);
  nullCleanupFile.cleanup = null;
  await json(skipperPath, nullCleanup);
  await verify(0, false);
  const { value: extraCounts, first: extraCountsFile } = mutableReceipt(installedReceipt);
  record(extraCountsFile.counts).cancelled = 1;
  assert.equal(present(projectSkipperRunnerReceipt(extraCounts).files[0]).exercised, undefined);
  await json(skipperPath, extraCounts);
  await verify(0, false);
  await writeFile(skipperPath, installedReceipt);
  // A later artifact-copy failure leaves case execution and completed cleanup
  // intact, even though the owning job and required aggregate remain failed.
  for (const owner of [skipperLane, "openshell"] as const) {
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
    (value: Record<string, unknown>) => {
      delete record(array(value.files)[0]).cleanup;
    },
    (value: Record<string, unknown>) => {
      array(value.issues).push({
        code: "expected-test-not-passed",
        status: "failed",
        file: policyPath,
        name: "sentinel",
      });
    },
  ]) {
    const damaged = jsonRecord(passingPolicy);
    damage(damaged);
    await json(policyReceipt, damaged);
    await verify(0, false);
  }
  await writeFile(policyReceipt, passingPolicy);
  // Incomplete or focused evidence remains publishable, but never proves full coverage.
  for (const damage of [
    (value: Record<string, unknown>) => {
      delete value.scope;
    },
    (value: Record<string, unknown>) => {
      value.scope = "focused";
    },
    (value: Record<string, unknown>) => {
      delete record(array(value.files)[0]).exercised;
    },
    (value: Record<string, unknown>) => {
      delete record(array(value.files)[0]).signal;
    },
    (value: Record<string, unknown>) => {
      record(array(value.files)[0]).signal = "SIGTERM";
    },
    (value: Record<string, unknown>) => {
      delete record(array(value.files)[0]).issues;
    },
    (value: Record<string, unknown>) => {
      record(array(value.files)[0]).issues = [{ message: "private-output-canary" }];
    },
    (value: Record<string, unknown>) => {
      delete record(array(value.files)[0]).nodeExitCode;
    },
    (value: Record<string, unknown>) => {
      record(array(value.files)[0]).nodeExitCode = 1;
    },
    (value: Record<string, unknown>) => {
      record(array(value.files)[0]).fileFailure = { message: "private-output-canary" };
    },
    (value: Record<string, unknown>) => {
      delete record(array(value.files)[0]).counts;
    },
    (value: Record<string, unknown>) => {
      record(record(array(value.files)[0]).counts).total = 2;
    },
    (value: Record<string, unknown>) => {
      record(array(value.files)[0]).status = "failed";
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
    (value: Record<string, unknown>) => {
      delete value.issues;
    },
    (value: Record<string, unknown>) => {
      value.issues = [{ message: "private-output-canary" }];
    },
    (value: Record<string, unknown>) => {
      record(record(array(value.files)[0]).cleanup).status = "failed";
    },
    (value: Record<string, unknown>) => {
      record(array(record(array(value.files)[0]).tests)[0]).durationMs = {
        diagnostic: "private-output-canary",
      };
    },
    (value: Record<string, unknown>) => {
      record(array(record(array(value.files)[0]).tests)[0]).durationMs = -1;
    },
    (value: Record<string, unknown>) => {
      record(array(record(array(value.files)[0]).tests)[0]).durationMs = Infinity;
    },
  ]) {
    const damaged = structuredClone(privateSkipper);
    damage(damaged);
    assert.throws(() => projectSkipperRunnerReceipt(damaged), { code: "ERR_ASSERTION" });
  }
  const noDuration = structuredClone(privateSkipper);
  delete record(array(record(array(noDuration.files)[0]).tests)[0]).durationMs;
  assert.equal(
    present(present(projectSkipperRunnerReceipt(noDuration).files[0]).tests[0]).durationMs,
    undefined,
  );
  const legacy = jsonRecord(reusedReceipt);
  for (const file of array(legacy.files)) {
    delete record(file).exercised;
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
    assert.deepEqual(jsonRecord(await readFile(resultPath, "utf8")).cleanup, { status: "failed" });
    await verify(1, false);
    // Losing the resource ledger cannot turn a known cleanup refusal into proof
    // of removal. A retry needs actual restored state to reconcile that failure.
    await rm(statePath);
    const missingState = clean(target);
    assert.equal(missingState.status, 1);
    assert.match(missingState.stderr, /Cannot verify failed cleanup without resource state/);
    assert.deepEqual(jsonRecord(await readFile(resultPath, "utf8")).cleanup, { status: "failed" });
    await verify(1, false);
    // No cluster was created. Reconcile the synthetic ownership record, then
    // require the real cleanup command to remove its empty state and requalify.
    await json(statePath, { ...state, resources: [] });
    assert.equal(clean(target).status, 0);
    await assert.rejects(readFile(statePath), { code: "ENOENT" });
    await verify(1, true);
    for (const cleanup of [undefined, null, { status: "failed" }, { status: "unknown" }]) {
      await json(resultPath, { ...jsonRecord(original), cleanup });
      await verify(1, false);
    }
    await writeFile(resultPath, original);
  }
  await verify(1, false, { GITHUB_RUN_ATTEMPT: "2" });
  const genuine = await readFile(policyReceipt, "utf8");
  for (const damage of [
    (value: Record<string, unknown>) => {
      value.issues = [];
    },
    (value: Record<string, unknown>) => {
      record(array(value.files)[0]).issues = [];
    },
    (value: Record<string, unknown>) => {
      record(array(value.issues)[0]).file = "tests/integration/other.test.mjs";
    },
    (value: Record<string, unknown>) => {
      record(array(record(array(value.files)[0]).issues)[0]).name = "another case";
    },
  ]) {
    const damaged = jsonRecord(genuine);
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
    (value: Record<string, unknown>) => {
      record(array(value.files)[0]).counts = zero;
      record(array(value.files)[0]).tests = [];
      value.counts = zero;
    },
    (value: Record<string, unknown>) => {
      value.scope = "focused";
    },
    (value: Record<string, unknown>) => {
      value.sourceSha = "0".repeat(40);
    },
    (value: Record<string, unknown>) => {
      value.files = [];
    },
  ]) {
    const bad = jsonRecord(genuine);
    damage(bad);
    await json(policyReceipt, bad);
    await verify(1, false);
  }
  await writeFile(policyReceipt, genuine);
  needs.openshell.result = "cancelled";
  await json(needsPath, needs);
  await verify(1, false);
});
