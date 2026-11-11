import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { K3dChildCase } from "../fixtures/ci-runner-k3d-cases.ts";
import type { K3dKubectlScenario } from "../fixtures/ci-runner-k3d-kubectl.ts";
import { writeCommand } from "./fake-commands.ts";

type LaneFile = { path: string; expectedTests: string[] };

export async function prepareK3dDiagnosticsRun(
  root: string,
  files: LaneFile[],
  env?: Record<string, string>,
) {
  const lane = "k3d-lane";
  const clusterDirectory = join(root, "cluster");
  const statePath = join(root, "state/k3d.json");
  const resultsPath = join(root, "results/k3d.json");
  const manifestPath = join(root, "scripts/ci/suites.json");
  await mkdir(clusterDirectory);
  await writeJson(statePath, {
    lane,
    resources: [
      {
        kind: "k3d-cluster",
        status: "ready",
        name: "owned-cluster",
        directory: clusterDirectory,
        kubeconfig: join(clusterDirectory, "kubeconfig"),
        context: "k3d-owned-cluster",
      },
    ],
  });
  await writeJson(join(root, "scripts/ci/k3d-lane.json"), { env, files });
  await writeJson(manifestPath, {
    version: 1,
    lanes: { [lane]: "./k3d-lane.json" },
    groups: {},
  });
  return {
    clusterDirectory,
    statePath,
    resultsPath,
    args: [
      "run",
      lane,
      "--manifest",
      manifestPath,
      "--root",
      root,
      "--state",
      statePath,
      "--results",
      resultsPath,
    ],
  };
}

function writeJson(path: string, value: object) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeK3dKubectl(directory: string, scenario: K3dKubectlScenario) {
  const entry = new URL("../fixtures/ci-runner-k3d-kubectl.ts", import.meta.url).href;
  return writeCommand(
    directory,
    "kubectl",
    `import(${JSON.stringify(entry)}).then(({ runK3dKubectl }) => runK3dKubectl(${JSON.stringify(scenario)}));`,
    { interpreter: process.execPath },
  );
}

export function writeK3dChildTest(path: string, scenario: K3dChildCase) {
  const entry = new URL("../fixtures/ci-runner-k3d-cases.ts", import.meta.url).href;
  return writeFile(
    path,
    `import { registerK3dChildTest } from ${JSON.stringify(entry)};\nawait registerK3dChildTest(${JSON.stringify(scenario)});\n`,
  );
}
