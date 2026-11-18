import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Inspect the exact immutable controller already imported into the selected cluster.
export const inspectWorkerProbe = [
  "node",
  "-p",
  "['production-healthcheck', 'bootstrap-installation'].map(name => ['mjs', 'ts'].filter(ext => require('node:fs').lstatSync('scripts/' + name + '.' + ext, { throwIfNoEntry: false })?.isFile()).join(',')).join(':')",
];

export async function initialUpgradeChart(
  harnessRoot: string,
  directory: string,
  extension: string,
) {
  const [worker, bootstrap, extra] = extension.split(":");
  assert.ok(
    extra === undefined && ["mjs", "ts"].includes(worker ?? "") && ["mjs", "ts"].includes(bootstrap ?? ""),
    "The incumbent controller must provide exactly one supported worker probe and bootstrap program.",
  );
  if (worker === "ts" && bootstrap === "ts") {
    return join(harnessRoot, "deploy/helm/openclaw-enterprise");
  }
  return stageHistoricalWorkerChart(harnessRoot, directory, worker === "mjs", bootstrap === "mjs");
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
    previous: { reviewedSource?: unknown };
    candidate: { reviewedSource?: unknown };
  };
}): Promise<string> {
  assert.equal(plan.fixture, "v3-to-v3");
  // The bound plan identifies the exact reviewed production inputs for both
  // images. That pair contains the historical probe throughout the image cuts.
  assert.equal(plan.previous.reviewedSource, reviewedSource);
  assert.equal(plan.candidate.reviewedSource, reviewedSource);

  return stageHistoricalWorkerChart(harnessRoot, directory, true, true);
}

async function stageHistoricalWorkerChart(
  harnessRoot: string,
  directory: string,
  historicalWorker: boolean,
  historicalBootstrap: boolean,
): Promise<string> {
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
  const historical = historicalWorker
    ? deployments.replace(probe, (match) =>
        match.replace("scripts/production-healthcheck.ts", "scripts/production-healthcheck.mjs"),
      )
    : deployments;
  const jobs = await readFile(join(source, "templates/jobs.yaml"), "utf8");
  const bootstrap = 'args: ["scripts/bootstrap-installation.ts"]';
  assert.equal(jobs.split(bootstrap).length, 2, "The trusted chart must define one direct bootstrap program.");
  const stagedJobs = historicalBootstrap
    ? jobs.replace(bootstrap, 'args: ["scripts/bootstrap-installation.mjs"]')
    : jobs;

  const staged = join(directory, "historical-worker-chart");
  await mkdir(staged, { mode: 0o700 });
  await cp(source, staged, { recursive: true });
  await writeFile(join(staged, template), historical);
  await writeFile(join(staged, "templates/jobs.yaml"), stagedJobs);
  return staged;
}
