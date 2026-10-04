import { readFileSync, writeFileSync } from "node:fs";

const matrixLanes = [
  "checks-baseline-1",
  "checks-baseline-2",
  "checks-browser",
  "postgres",
  "postgres-application",
  "postgres-auth",
  "images-packaging",
  "images-model-probes",
  "k3d-fixture-configuration",
  "k3d-fixture-state",
  "k3d-fixture-plugins",
  "k3d-observability",
  "logging-collector",
  "repository-credentials-container",
  "repository-credentials-platform",
];

function main(args) {
  if (
    args.length !== 6 ||
    args[0] !== "--needs" ||
    args[2] !== "--mode" ||
    args[4] !== "--output" ||
    !args[1] ||
    !args[5]
  ) {
    throw new Error("usage: impact-gate.mjs --needs PATH --mode docs|full --output PATH");
  }
  const [, needsPath, , mode, , outputPath] = args;
  if (mode !== "docs" && mode !== "full") {
    throw new Error(`invalid mode: ${mode}`);
  }
  const needs = JSON.parse(readFileSync(needsPath, "utf8"));
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    throw new Error("needs must be an object");
  }

  const issues = [];
  const expected = {
    impact: "success",
    audit: "success",
    "docs-checks": mode === "docs" ? "success" : "skipped",
    "pr-safe": mode === "docs" ? "skipped" : "success",
    "runtime-image-fixture": mode === "docs" ? "skipped" : "success",
  };
  for (const job of Object.keys(needs)) {
    if (!Object.hasOwn(expected, job)) {
      issues.push(`unexpected dependency: ${job}`);
    }
  }
  for (const [job, result] of Object.entries(expected)) {
    if (needs[job]?.result !== result) {
      issues.push(`${job}: expected ${result}, got ${needs[job]?.result ?? "missing"}`);
    }
  }
  if (needs.impact?.outputs?.mode !== mode) {
    issues.push(`impact output does not match mode ${mode}`);
  }

  // Preserve failed and missing job states for the existing artifact aggregator.
  const state = (job) => ({ result: needs[job]?.result ?? "missing" });
  const expanded = {
    impact: state("impact"),
    audit: state("audit"),
  };
  if (mode === "full") {
    expanded["runtime-image-fixture"] = state("runtime-image-fixture");
    for (const lane of matrixLanes) {
      expanded[lane] = state("pr-safe");
    }
  }
  writeFileSync(outputPath, JSON.stringify(expanded));
  if (issues.length) {
    throw new Error(issues.join("; "));
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
