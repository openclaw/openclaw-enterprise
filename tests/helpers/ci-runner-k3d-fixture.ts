import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

export async function writeK3dKubectl(directory: string, scenario: K3dKubectlScenario) {
  await copyFile(
    new URL("../fixtures/ci-runner-k3d-kubectl.ts", import.meta.url),
    join(directory, "ci-runner-k3d-kubectl.ts"),
  );
  await writeJson(join(directory, "kubectl.scenario.json"), scenario);
  return writeCommand(
    directory,
    "kubectl",
    `import { readFileSync } from "node:fs";
import { runK3dKubectl } from "./ci-runner-k3d-kubectl.ts";
runK3dKubectl(JSON.parse(readFileSync(new URL("./kubectl.scenario.json", import.meta.url), "utf8")));`,
    { interpreter: process.execPath },
  );
}

export async function writeK3dChildTest(path: string, scenario: K3dChildCase) {
  // The child fixture imports other helpers relative to its repository location.
  await symlink(
    fileURLToPath(new URL("../fixtures/ci-runner-k3d-cases.ts", import.meta.url)),
    `${path}.fixture.ts`,
  );
  await writeJson(`${path}.scenario.json`, scenario);
  return writeFile(
    path,
    `import { readFile } from "node:fs/promises";
const { registerK3dChildTest } = await import(import.meta.url + ".fixture.ts");
const scenario = JSON.parse(await readFile(new URL(import.meta.url + ".scenario.json"), "utf8"));
await registerK3dChildTest(scenario);
`,
  );
}
