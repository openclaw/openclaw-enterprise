import { readFileSync, writeFileSync } from "node:fs";

const matrixLanes = [
  "checks-baseline-1",
  "checks-baseline-2",
  "checks-browser",
  "checks-browser-2",
  "postgres",
  "postgres-application",
  "postgres-auth",
  "postgres-platform",
  "images-packaging",
  "images-model-probes",
  "images-runtime-startup",
  "images-runtime-startup-2",
  "k3d-fixture-configuration",
  "k3d-fixture-state",
  "k3d-fixture-plugins",
  "k3d-observability",
  "logging-collector",
  "repository-credentials-container",
  "repository-credentials-platform",
];

const fixtureLane = "runtime-image-fixture";

function selectedLanes(text) {
  const lanes = JSON.parse(text);
  if (
    !Array.isArray(lanes) ||
    lanes.length === 0 ||
    new Set(lanes).size !== lanes.length ||
    !lanes.every((lane) => lane === fixtureLane || matrixLanes.includes(lane)) ||
    !lanes.some((lane) => matrixLanes.includes(lane))
  ) {
    throw new Error("lanes must be a nonempty list of distinct CI lanes with a matrix lane");
  }
  return lanes;
}

function main(args) {
  const tests = args[3] === "tests";
  if (
    args.length !== (tests ? 8 : 6) ||
    args[0] !== "--needs" ||
    args[2] !== "--mode" ||
    args[4] !== "--output" ||
    !args[1] ||
    !args[5] ||
    (tests && (args[6] !== "--lanes" || !args[7]))
  ) {
    throw new Error(
      "usage: impact-gate.mjs --needs PATH --mode docs|full --output PATH | --needs PATH --mode tests --output PATH --lanes JSON",
    );
  }
  const [, needsPath, , mode, , outputPath] = args;
  if (mode !== "docs" && mode !== "full" && mode !== "tests") {
    throw new Error(`invalid mode: ${mode}`);
  }
  const lanes = tests ? selectedLanes(args[7]) : null;
  const needs = JSON.parse(readFileSync(needsPath, "utf8"));
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    throw new Error("needs must be an object");
  }

  const issues = [];
  const expected = {
    impact: "success",
    audit: "success",
    // Lint, format, OpenAPI and docs checks run in every mode.
    "static-checks": "success",
    "pr-safe": mode === "docs" ? "skipped" : "success",
    "runtime-image-fixture":
      mode === "full" || (mode === "tests" && lanes.includes(fixtureLane)) ? "success" : "skipped",
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
  if (tests && needs.impact?.outputs?.lanes !== args[7]) {
    issues.push("impact output does not match the selected lanes");
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
  } else if (mode === "tests") {
    // Only selected lanes are expanded; the aggregator requires each one's results.
    for (const lane of lanes) {
      expanded[lane] = state(lane === fixtureLane ? fixtureLane : "pr-safe");
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
