import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { expectedFullLanes, passingGateNeeds } from "../helpers/ci-expected-coverage.mjs";
import { temporaryDirectorySync } from "../helpers/temporary-directory.mjs";

const gate = resolve("scripts/ci/impact-gate.mjs");

function runGate(t, mode, needs, extra = []) {
  const dir = temporaryDirectorySync(t, "ci-impact-gate-");
  const input = join(dir, "needs.json");
  const output = join(dir, "expanded.json");
  writeFileSync(input, typeof needs === "string" ? needs : JSON.stringify(needs));
  const result = spawnSync(
    process.execPath,
    [gate, "--needs", input, "--mode", mode, "--output", output, ...extra],
    {
      encoding: "utf8",
    },
  );
  let expanded;
  try {
    expanded = JSON.parse(readFileSync(output, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return { ...result, expanded };
}

test("gate accepts only the selected jobs and expands full-mode dependencies", (t) => {
  const docs = runGate(t, "docs", passingGateNeeds("docs"));
  assert.equal(docs.status, 0, docs.stderr);
  // No successful test-lane receipt may be manufactured for omitted docs lanes.
  for (const lane of expectedFullLanes) {
    assert.notEqual(docs.expanded?.[lane]?.result, "success", lane);
  }
  const full = runGate(t, "full", passingGateNeeds("full"));
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(
    Object.keys(full.expanded).sort(),
    ["impact", "static-checks", ...expectedFullLanes].sort(),
  );
  for (const state of Object.values(full.expanded)) {
    assert.equal(state.result, "success");
  }
});

test("gate rejects failed, cancelled, missing, and unexpectedly run or skipped jobs", (t) => {
  for (const mode of ["docs", "full"]) {
    for (const [job, state] of Object.entries(passingGateNeeds(mode))) {
      for (const bad of [
        "failure",
        "cancelled",
        "missing",
        state.result === "success" ? "skipped" : "success",
      ]) {
        const needs = passingGateNeeds(mode);
        if (bad === "missing") {
          delete needs[job];
        } else {
          needs[job].result = bad;
        }
        const result = runGate(t, mode, needs);
        assert.notEqual(result.status, 0, `${mode}: ${job} ${bad}`);
        assert.match(result.stderr, new RegExp(job));
        if (mode === "full") {
          for (const lane of expectedFullLanes) {
            const source = lane === "runtime-image-fixture" ? lane : "pr-safe";
            assert.equal(
              result.expanded?.[lane]?.result,
              job === source ? bad : "success",
              `${mode}: ${job} ${bad} -> ${lane}`,
            );
          }
        }
      }
    }
  }
});

test("gate fails closed for invalid selection and malformed dependencies", (t) => {
  const mismatch = passingGateNeeds("docs");
  mismatch.impact.outputs.mode = "full";
  assert.notEqual(runGate(t, "docs", mismatch).status, 0);
  const missingMode = passingGateNeeds("docs");
  delete missingMode.impact.outputs.mode;
  assert.notEqual(runGate(t, "docs", missingMode).status, 0);
  const unexpected = passingGateNeeds("full");
  unexpected.newJob = { result: "failure", outputs: {} };
  assert.notEqual(runGate(t, "full", unexpected).status, 0);
  assert.notEqual(runGate(t, "unknown", passingGateNeeds("full")).status, 0);
  assert.notEqual(runGate(t, "docs", "{not json").status, 0);
  assert.notEqual(runGate(t, "docs", "[]").status, 0);
  assert.notEqual(spawnSync(process.execPath, [gate], { encoding: "utf8" }).status, 0);
});

function testNeeds(lanes) {
  const json = JSON.stringify(lanes);
  return {
    impact: { result: "success", outputs: { mode: "tests", lanes: json } },
    "static-checks": { result: "success", outputs: {} },
    "pr-safe": { result: "success", outputs: {} },
    "runtime-image-fixture": {
      result: lanes.includes("runtime-image-fixture") ? "success" : "skipped",
      outputs: {},
    },
  };
}

function runTestsGate(t, lanes, needs = testNeeds(lanes)) {
  return runGate(t, "tests", needs, [
    "--lanes",
    typeof lanes === "string" ? lanes : JSON.stringify(lanes),
  ]);
}

test("tests mode expands only the selected lanes", (t) => {
  const plain = runTestsGate(t, ["checks-baseline-1", "postgres"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(plain.expanded, {
    impact: { result: "success" },
    "static-checks": { result: "success" },
    "checks-baseline-1": { result: "success" },
    postgres: { result: "success" },
  });
  // The Keycloak OIDC lane is a matrix row, so pr-safe carries its result.
  const keycloak = runTestsGate(t, ["keycloak-oidc"]);
  assert.equal(keycloak.status, 0, keycloak.stderr);
  assert.deepEqual(keycloak.expanded, {
    impact: { result: "success" },
    "static-checks": { result: "success" },
    "keycloak-oidc": { result: "success" },
  });
  const keycloakFailed = testNeeds(["keycloak-oidc"]);
  keycloakFailed["pr-safe"].result = "failure";
  const keycloakResult = runTestsGate(t, ["keycloak-oidc"], keycloakFailed);
  assert.notEqual(keycloakResult.status, 0);
  assert.equal(keycloakResult.expanded["keycloak-oidc"].result, "failure");
  const fixture = runTestsGate(t, ["checks-baseline-1", "runtime-image-fixture"]);
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.deepEqual(Object.keys(fixture.expanded).sort(), [
    "checks-baseline-1",
    "impact",
    "runtime-image-fixture",
    "static-checks",
  ]);
  // A failed matrix or fixture job reaches the aggregator as a failed lane.
  const failed = testNeeds(["checks-baseline-1", "runtime-image-fixture"]);
  failed["runtime-image-fixture"].result = "failure";
  const result = runTestsGate(t, ["checks-baseline-1", "runtime-image-fixture"], failed);
  assert.notEqual(result.status, 0);
  assert.equal(result.expanded["runtime-image-fixture"].result, "failure");
});

test("tests mode rejects wrong job states and unverifiable lane sets", (t) => {
  for (const lanes of [
    ["checks-baseline-1", "postgres"],
    ["checks-baseline-1", "runtime-image-fixture"],
  ]) {
    for (const [job, state] of Object.entries(testNeeds(lanes))) {
      for (const bad of [
        "failure",
        "cancelled",
        "missing",
        state.result === "success" ? "skipped" : "success",
      ]) {
        const needs = testNeeds(lanes);
        if (bad === "missing") {
          delete needs[job];
        } else {
          needs[job].result = bad;
        }
        const result = runTestsGate(t, lanes, needs);
        assert.notEqual(result.status, 0, `${job} ${bad}`);
        assert.match(result.stderr, new RegExp(job));
        for (const lane of lanes) {
          const source = lane === "runtime-image-fixture" ? lane : "pr-safe";
          assert.equal(
            result.expanded?.[lane]?.result,
            job === source ? bad : "success",
            `${job} ${bad} -> ${lane}`,
          );
        }
      }
    }
  }
  const lanes = ["checks-baseline-1", "postgres"];
  // The impact job's lanes must be the ones being gated.
  const other = testNeeds(lanes);
  other.impact.outputs.lanes = JSON.stringify(["checks-baseline-1"]);
  assert.notEqual(runTestsGate(t, lanes, other).status, 0);
  const wrongMode = testNeeds(lanes);
  wrongMode.impact.outputs.mode = "full";
  assert.notEqual(runTestsGate(t, lanes, wrongMode).status, 0);
  for (const bad of [
    "",
    "[]",
    "{}",
    "not json",
    '["checks-baseline-1","checks-baseline-1"]',
    '["checks-baseline-1","unknown"]',
    '["runtime-image-fixture"]',
    '["first-agent-smoke"]',
  ]) {
    const result = runTestsGate(t, bad, testNeeds(lanes));
    assert.notEqual(result.status, 0, bad);
    assert.equal(result.expanded, undefined, bad);
  }
  // --lanes belongs to tests mode only and is required there.
  assert.notEqual(runGate(t, "tests", testNeeds(lanes)).status, 0);
  assert.notEqual(
    runGate(t, "full", passingGateNeeds("full"), ["--lanes", '["postgres"]']).status,
    0,
  );
  assert.notEqual(
    runGate(t, "docs", passingGateNeeds("docs"), ["--lanes", '["postgres"]']).status,
    0,
  );
});
