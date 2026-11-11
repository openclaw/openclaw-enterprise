import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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

export function spawnLifecycleRunner(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  return { child, exit: () => exit, stderr: () => stderr };
}

export function lifecycleReady(path: string) {
  try {
    return JSON.parse(readFileSync(path, "utf8")) !== null;
  } catch {
    return false;
  }
}

// Field 5 of /proc/<pid>/stat is the process group; the name in parentheses may hold spaces.
export function procStat(pid: number) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8")
      .replace(/^.*\) /su, "")
      .split(" ");
    return { state: fields[0], pgid: Number(fields[2]) };
  } catch {
    return undefined;
  }
}

export function killRecordedProcessGroupMembers(
  pgid: number | undefined,
  pids: readonly (number | undefined)[],
) {
  if (pgid === undefined || !Number.isSafeInteger(pgid) || pgid <= 1) {
    return;
  }

  for (const pid of pids) {
    if (
      pid === undefined ||
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      pid === process.pid ||
      procStat(pid)?.pgid !== pgid
    ) {
      continue;
    }

    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
