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

test("gate accepts only the selected jobs and preserves full-mode matrix ownership", (t) => {
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
    [
      "impact",
      "static-checks",
      "runtime-artifact",
      "pr-safe",
      "image-lanes",
      "runtime-image-fixture",
    ].sort(),
  );
  assert.deepEqual(
    full.expanded["pr-safe"].lanes,
    expectedFullLanes.filter(
      (lane) => lane !== "runtime-image-fixture" && !lane.startsWith("images-"),
    ),
  );
  assert.deepEqual(
    full.expanded["image-lanes"].lanes,
    expectedFullLanes.filter((lane) => lane.startsWith("images-")),
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
            const source =
              lane === "runtime-image-fixture"
                ? lane
                : lane.startsWith("images-")
                  ? "image-lanes"
                  : "pr-safe";
            assert.equal(
              result.expanded?.[source]?.result,
              job === source ? bad : "success",
              `${mode}: ${job} ${bad} -> ${lane}`,
            );
            if (lane !== source) {
              assert.equal(
                result.expanded?.[lane],
                undefined,
                "matrix result is not a lane result",
              );
              assert.ok(result.expanded?.[source]?.lanes.includes(lane));
            }
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
    "pr-safe": {
      result: lanes.some((lane) => lane !== "runtime-image-fixture" && !lane.startsWith("images-"))
        ? "success"
        : "skipped",
      outputs: {},
    },
    "image-lanes": {
      result: lanes.some((lane) => lane.startsWith("images-")) ? "success" : "skipped",
      outputs: {},
    },
    "runtime-artifact": {
      result: lanes.some((lane) => lane.startsWith("images-")) ? "success" : "skipped",
      outputs: {},
    },
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

test("tests mode records only the selected lanes under their actual parents", (t) => {
  const plain = runTestsGate(t, ["checks-baseline-1", "postgres"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(plain.expanded, {
    impact: { result: "success" },
    "static-checks": { result: "success" },
    "pr-safe": { result: "success", lanes: ["checks-baseline-1", "postgres"] },
  });
  // The Keycloak OIDC lane is a matrix row, so pr-safe carries its result.
  const keycloak = runTestsGate(t, ["keycloak-oidc"]);
  assert.equal(keycloak.status, 0, keycloak.stderr);
  assert.deepEqual(keycloak.expanded, {
    impact: { result: "success" },
    "static-checks": { result: "success" },
    "pr-safe": { result: "success", lanes: ["keycloak-oidc"] },
  });
  const keycloakFailed = testNeeds(["keycloak-oidc"]);
  keycloakFailed["pr-safe"].result = "failure";
  const keycloakResult = runTestsGate(t, ["keycloak-oidc"], keycloakFailed);
  assert.notEqual(keycloakResult.status, 0);
  assert.equal(keycloakResult.expanded["pr-safe"].result, "failure");
  assert.equal(keycloakResult.expanded["keycloak-oidc"], undefined);
  const fixture = runTestsGate(t, ["checks-baseline-1", "runtime-image-fixture"]);
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.deepEqual(Object.keys(fixture.expanded).sort(), [
    "impact",
    "pr-safe",
    "runtime-image-fixture",
    "static-checks",
  ]);
  // The standalone fixture is still a direct job result, not a matrix parent.
  const failed = testNeeds(["checks-baseline-1", "runtime-image-fixture"]);
  failed["runtime-image-fixture"].result = "failure";
  const result = runTestsGate(t, ["checks-baseline-1", "runtime-image-fixture"], failed);
  assert.notEqual(result.status, 0);
  assert.equal(result.expanded["runtime-image-fixture"].result, "failure");
});

test("tests mode rejects wrong job states and unverifiable lane sets", (t) => {
  for (const lanes of [
    ["checks-baseline-1", "postgres"],
    ["images-runtime-startup-2"],
    ["checks-baseline-1", "images-packaging"],
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
          const source =
            lane === "runtime-image-fixture"
              ? lane
              : lane.startsWith("images-")
                ? "image-lanes"
                : "pr-safe";
          assert.equal(
            result.expanded?.[source]?.result,
            job === source ? bad : "success",
            `${job} ${bad} -> ${lane}`,
          );
          if (lane !== source) {
            assert.equal(result.expanded?.[lane], undefined, "matrix result is not a lane result");
            assert.ok(result.expanded?.[source]?.lanes.includes(lane));
          }
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

test("image-only selection requires its producer and does not require unrelated lanes", (t) => {
  const lanes = ["images-runtime-startup-2"];
  const passed = runTestsGate(t, lanes);
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(passed.expanded, {
    impact: { result: "success" },
    "static-checks": { result: "success" },
    "runtime-artifact": { result: "success" },
    "image-lanes": { result: "success", lanes: ["images-runtime-startup-2"] },
  });
  const needs = testNeeds(lanes);
  needs["runtime-artifact"].result = "failure";
  needs["image-lanes"].result = "skipped";
  const failed = runTestsGate(t, lanes, needs);
  assert.notEqual(failed.status, 0);
  assert.equal(failed.expanded["runtime-artifact"].result, "failure");
  assert.equal(failed.expanded["image-lanes"].result, "skipped");
  assert.equal(failed.expanded["images-runtime-startup-2"], undefined);
});
