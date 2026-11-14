import { readFileSync, writeFileSync } from "node:fs";

const matrixLanes = new Set([
  "checks-baseline-1",
  "checks-baseline-2",
  "checks-browser",
  "checks-browser-2",
  "postgres",
  "postgres-application",
  "postgres-auth",
  "postgres-platform",
  "images-packaging",
  "images-runtime-startup",
  "images-runtime-startup-2",
  "images-runtime-startup-3",
  "k3d-fixture-configuration",
  "k3d-fixture-state",
  "k3d-fixture-network",
  "k3d-fixture-plugins",
  "k3d-observability",
  "logging-collector",
  "repository-credentials-container",
  "keycloak-oidc",
]);

const fixtureLane = "runtime-image-fixture";

type GateArgs = { needsPath: string; outputPath: string } & (
  { mode: "docs" | "full" } | { mode: "tests"; lanes: string[]; lanesJson: string }
);

type JobReceipt = { result: unknown; lanes?: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectedLanes(text: string): string[] {
  const lanes: unknown = JSON.parse(text);
  if (
    !Array.isArray(lanes) ||
    lanes.length === 0 ||
    !lanes.every((lane: unknown) => typeof lane === "string") ||
    new Set(lanes).size !== lanes.length ||
    !lanes.every((lane) => lane === fixtureLane || matrixLanes.has(lane)) ||
    !lanes.some((lane) => matrixLanes.has(lane))
  ) {
    throw new Error("lanes must be a nonempty list of distinct CI lanes with a matrix lane");
  }
  return lanes;
}

function parseArgs(args: string[]): GateArgs {
  const [needsFlag, needsPath, modeFlag, mode, outputFlag, outputPath, lanesFlag, lanesJson] = args;
  if (
    args.length !== (mode === "tests" ? 8 : 6) ||
    needsFlag !== "--needs" ||
    modeFlag !== "--mode" ||
    outputFlag !== "--output" ||
    !needsPath ||
    !outputPath ||
    (mode === "tests" && (lanesFlag !== "--lanes" || !lanesJson))
  ) {
    throw new Error(
      "usage: impact-gate.ts --needs PATH --mode docs|full --output PATH | --needs PATH --mode tests --output PATH --lanes JSON",
    );
  }
  if (mode === "tests" && lanesJson) {
    return { mode, needsPath, outputPath, lanes: selectedLanes(lanesJson), lanesJson };
  }
  if (mode === "docs" || mode === "full") {
    return { mode, needsPath, outputPath };
  }
  throw new Error(`invalid mode: ${mode}`);
}

function main(args: GateArgs) {
  const { mode, needsPath, outputPath } = args;
  const needs: unknown = JSON.parse(readFileSync(needsPath, "utf8"));
  if (!isRecord(needs)) {
    throw new Error("needs must be an object");
  }

  const resultOf = (job: string) => {
    const state = needs[job];
    return isRecord(state) ? state.result : undefined;
  };
  const issues: string[] = [];
  const lanes = mode === "tests" ? args.lanes : [];
  const imageSelected = mode === "full" || lanes.some((lane) => lane.startsWith("images-"));
  const otherSelected =
    mode === "full" || lanes.some((lane) => lane !== fixtureLane && !lane.startsWith("images-"));
  const expected = {
    impact: "success",
    // The suite audit and static checks share a required job in every mode.
    "static-checks": "success",
    "pr-safe": otherSelected ? "success" : "skipped",
    "image-lanes": imageSelected ? "success" : "skipped",
    "runtime-artifact": imageSelected ? "success" : "skipped",
    "runtime-image-fixture": mode === "full" || lanes.includes(fixtureLane) ? "success" : "skipped",
  };
  for (const job of Object.keys(needs)) {
    if (!Object.hasOwn(expected, job)) {
      issues.push(`unexpected dependency: ${job}`);
    }
  }
  for (const [job, result] of Object.entries(expected)) {
    const actual = resultOf(job);
    if (actual !== result) {
      issues.push(`${job}: expected ${result}, got ${actual ?? "missing"}`);
    }
  }
  const impact = needs.impact;
  const outputs = isRecord(impact) && isRecord(impact.outputs) ? impact.outputs : undefined;
  if (outputs?.mode !== mode) {
    issues.push(`impact output does not match mode ${mode}`);
  }
  if (mode === "tests" && outputs?.lanes !== args.lanesJson) {
    issues.push("impact output does not match the selected lanes");
  }

  // Matrix job results describe the parent, not each lane's outcome.
  const state = (job: string): JobReceipt => ({ result: resultOf(job) ?? "missing" });
  const expanded: Record<string, JobReceipt> = {
    impact: state("impact"),
    "static-checks": state("static-checks"),
  };
  if (imageSelected) {
    expanded["runtime-artifact"] = state("runtime-artifact");
  }
  const laneJob = (lane: string) => {
    if (lane === fixtureLane) {
      return fixtureLane;
    }
    return lane.startsWith("images-") ? "image-lanes" : "pr-safe";
  };
  const selected = mode === "full" ? [...matrixLanes, fixtureLane] : lanes;
  for (const lane of selected) {
    const job = laneJob(lane);
    const receipt = (expanded[job] ??= state(job));
    if (job !== lane) {
      (receipt.lanes ??= []).push(lane);
    }
  }
  writeFileSync(outputPath, JSON.stringify(expanded));
  if (issues.length) {
    throw new Error(issues.join("; "));
  }
}

try {
  main(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
