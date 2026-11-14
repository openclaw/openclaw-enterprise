import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Inspect the exact immutable controller already imported into the selected cluster.
export const inspectWorkerProbe = [
  "node",
  "-p",
  "['mjs', 'ts'].filter(ext => require('node:fs').lstatSync('scripts/production-healthcheck.' + ext, { throwIfNoEntry: false })?.isFile()).join(',')",
];

export async function initialUpgradeChart(
  harnessRoot: string,
  directory: string,
  extension: string,
) {
  if (extension === "ts") {
    return join(harnessRoot, "deploy/helm/openclaw-enterprise");
  }
  assert.equal(
    extension,
    "mjs",
    "The incumbent controller must provide exactly one supported worker probe.",
  );
  return stageHistoricalWorkerChart(harnessRoot, directory);
}

const reviewedSource = "7e1ac6d88e3893c3d4e6444fb3b9b9776519a3fb";

export async function stageSigninChart({
  harnessRoot,
  directory,
  plan,
}: {
  harnessRoot: string;
  directory: string;
  plan: {
    fixture: string;
    previous: { reviewedSource: string };
    candidate: { reviewedSource: string };
  };
}): Promise<string> {
  assert.equal(plan.fixture, "v3-to-v3");
  // The bound plan identifies the exact reviewed production inputs for both
  // images. That pair contains the historical probe throughout the image cuts.
  assert.equal(plan.previous.reviewedSource, reviewedSource);
  assert.equal(plan.candidate.reviewedSource, reviewedSource);

  return stageHistoricalWorkerChart(harnessRoot, directory);
}

async function stageHistoricalWorkerChart(harnessRoot: string, directory: string): Promise<string> {
  const source = join(harnessRoot, "deploy/helm/openclaw-enterprise");
  const template = "templates/deployments.yaml";
  const deployments = await readFile(join(source, template), "utf8");
  const probe =
    /^( +)(readinessProbe|livenessProbe|startupProbe):\n\1 {2}exec:\n\1 {4}command: \[node, scripts\/production-healthcheck\.ts, worker(, ready)?\]$/gm;
  assert.deepEqual(
    [...deployments.matchAll(probe)].map(([, , name, readiness]) => [name, readiness]),
    [
      ["readinessProbe", ", ready"],
      ["livenessProbe", undefined],
      ["startupProbe", undefined],
    ],
    "The trusted chart must define the three expected worker probe commands.",
  );
  const historical = deployments.replace(probe, (match) =>
    match.replace("scripts/production-healthcheck.ts", "scripts/production-healthcheck.mjs"),
  );
  assert.ok(!historical.includes("scripts/production-healthcheck.ts"));

  const staged = join(directory, "historical-worker-chart");
  await mkdir(staged, { mode: 0o700 });
  await cp(source, staged, { recursive: true });
  await writeFile(join(staged, template), historical);
  return staged;
}
