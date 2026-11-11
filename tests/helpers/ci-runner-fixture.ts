import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

interface ManifestFixture {
  lanes: Record<string, unknown>;
  groups?: Record<string, string[]>;
  fileDurations?: unknown;
}

export function writeRunnerManifest(
  root: string,
  { lanes, groups = { ci: Object.keys(lanes) }, fileDurations }: ManifestFixture,
  filename = "manifest.json",
) {
  return writeJson(join(root, filename), { version: 1, fileDurations, lanes, groups });
}

export async function writeSingleFileRunnerLane(
  root: string,
  lane: string,
  file: string,
  source: string,
) {
  await writeFile(join(root, file), source);
  await writeRunnerManifest(root, { lanes: { [lane]: { files: [{ path: file }] } } });
}

export async function writeFirstAgentCliFixture(root: string, cliBody: string) {
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "tests/helpers"));
  await writeFile(
    join(root, "tests/helpers/local-first-agent-stack.mjs"),
    await readFile(new URL("./local-first-agent-stack.mjs", import.meta.url)),
  );
  await writeFile(join(root, "bin/occ"), `#!${process.execPath}\n${cliBody}`, { mode: 0o700 });
}

export function runnerArtifactPaths(root: string, name: string) {
  return {
    statePath: join(root, `state/${name}.json`),
    resultsPath: join(root, `results/${name}.json`),
  };
}

export function laneArgs(
  root: string,
  lane: string,
  statePath: string,
  resultsPath: string,
  manifestPath = "manifest.json",
) {
  return [
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
  ];
}

export function aggregateArgs(root: string, target: string) {
  return [
    "aggregate",
    target,
    "--manifest",
    "manifest.json",
    "--root",
    root,
    "--results-dir",
    "results",
  ];
}
