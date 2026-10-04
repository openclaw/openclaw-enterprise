import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const gate = resolve("scripts/ci/impact-gate.mjs");
const allLanes = [
  "checks-baseline-1",
  "checks-baseline-2",
  "checks-browser",
  "postgres",
  "postgres-application",
  "postgres-auth",
  "images-packaging",
  "images-model-probes",
  "runtime-image-fixture",
  "k3d-fixture-configuration",
  "k3d-fixture-state",
  "k3d-fixture-plugins",
  "k3d-observability",
  "logging-collector",
  "repository-credentials-container",
  "repository-credentials-platform",
];

function needsFor(mode) {
  return {
    impact: { result: "success", outputs: { mode } },
    audit: { result: "success", outputs: {} },
    "docs-checks": { result: mode === "docs" ? "success" : "skipped", outputs: {} },
    "pr-safe": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
    "runtime-image-fixture": { result: mode === "docs" ? "skipped" : "success", outputs: {} },
  };
}

function runGate(t, mode, needs) {
  const dir = mkdtempSync(join(tmpdir(), "ci-impact-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, "needs.json");
  const output = join(dir, "expanded.json");
  writeFileSync(input, typeof needs === "string" ? needs : JSON.stringify(needs));
  const result = spawnSync(
    process.execPath,
    [gate, "--needs", input, "--mode", mode, "--output", output],
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
  const docs = runGate(t, "docs", needsFor("docs"));
  assert.equal(docs.status, 0, docs.stderr);
  // No successful test-lane receipt may be manufactured for omitted docs lanes.
  for (const lane of allLanes) {
    assert.notEqual(docs.expanded?.[lane]?.result, "success", lane);
  }
  const full = runGate(t, "full", needsFor("full"));
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(Object.keys(full.expanded).sort(), ["impact", "audit", ...allLanes].sort());
  for (const state of Object.values(full.expanded)) {
    assert.equal(state.result, "success");
  }
});

test("gate rejects failed, cancelled, missing, and unexpectedly run or skipped jobs", (t) => {
  for (const mode of ["docs", "full"]) {
    for (const [job, state] of Object.entries(needsFor(mode))) {
      for (const bad of [
        "failure",
        "cancelled",
        "missing",
        state.result === "success" ? "skipped" : "success",
      ]) {
        const needs = needsFor(mode);
        if (bad === "missing") {
          delete needs[job];
        } else {
          needs[job].result = bad;
        }
        const result = runGate(t, mode, needs);
        assert.notEqual(result.status, 0, `${mode}: ${job} ${bad}`);
        assert.match(result.stderr, new RegExp(job));
      }
    }
  }
});

test("gate fails closed for invalid selection and malformed dependencies", (t) => {
  const mismatch = needsFor("docs");
  mismatch.impact.outputs.mode = "full";
  assert.notEqual(runGate(t, "docs", mismatch).status, 0);
  const missingMode = needsFor("docs");
  delete missingMode.impact.outputs.mode;
  assert.notEqual(runGate(t, "docs", missingMode).status, 0);
  const unexpected = needsFor("full");
  unexpected.newJob = { result: "failure", outputs: {} };
  assert.notEqual(runGate(t, "full", unexpected).status, 0);
  assert.notEqual(runGate(t, "unknown", needsFor("full")).status, 0);
  assert.notEqual(runGate(t, "docs", "{not json").status, 0);
  assert.notEqual(runGate(t, "docs", "[]").status, 0);
  assert.notEqual(spawnSync(process.execPath, [gate], { encoding: "utf8" }).status, 0);
});
