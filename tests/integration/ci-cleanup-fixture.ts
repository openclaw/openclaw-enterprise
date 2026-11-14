import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

export const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const cleanupPath = join(repositoryRoot, "scripts/ci/cleanup.mjs");

export async function fixture(t: TestContext) {
  const root = await temporaryDirectory(t, "ci-cleanup-test-");
  await mkdir(join(root, "bin"), { recursive: true });
  return root;
}

export async function writeState(path: string, state: object) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function createK3dClusterResource(
  identity: { name: string; owner?: string },
  directory: string,
) {
  const kubeconfig = join(directory, "kubeconfig");
  await mkdir(directory);
  await writeFile(kubeconfig, "apiVersion: v1\n", { mode: 0o600 });
  return { id: "cluster-1", kind: "k3d-cluster", ...identity, directory, kubeconfig };
}

export function runCleanup(statePath: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cleanupPath, "--state", statePath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}
