import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { temporaryDirectory } from "./temporary-directory.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runnerPath = join(repositoryRoot, "scripts/ci/run-tests.mjs");

// Fixtures live under tmpdir(), which may itself sit inside an unrelated Git
// checkout. Stop Git's repository search at tmpdir() so the runner never reads
// that checkout's HEAD as the fixture's source SHA.
export const fixtureGitEnv = { GIT_CEILING_DIRECTORIES: tmpdir() };

export async function createRunnerFixture(t: TestContext) {
  const root = await temporaryDirectory(t, "ci-runner-");
  await mkdir(join(root, "scripts/ci"), { recursive: true });
  await mkdir(join(root, "tests/integration"), { recursive: true });
  await mkdir(join(root, "results"), { recursive: true });
  await mkdir(join(root, "state"), { recursive: true });
  return root;
}

export function currentSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function runnerEnv(env: NodeJS.ProcessEnv = {}) {
  const baseEnv = { ...process.env };
  delete baseEnv.NODE_ENV;
  return {
    ...baseEnv,
    GITHUB_SHA: currentSha(),
    CI_RUNNER_PARENT_SECRET: "secretauthvalue-parent",
    // Fixture failures quote this value; the reporter must redact env values.
    CI_RUNNER_FIXTURE_CREDENTIAL: "secretauthvalue",
    // The fixture runners never inherit the lane's own deadline.
    CI_RUNNER_DEADLINE_MS: "",
    ...fixtureGitEnv,
    ...env,
  };
}

export function runRunnerSync(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
  { timeout }: { timeout?: number } = {},
) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: runnerEnv(env),
    timeout,
  });
}

// Run the CLI without blocking tests that wait out time limits side by side.
// The result has spawnSync's shape, including its ETIMEDOUT error when `timeout` ends the runner.
interface AsyncRunnerResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: NodeJS.ErrnoException | undefined;
}

export function runRunnerAsync(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
  { timeout, execArgv = [] }: { timeout?: number; execArgv?: readonly string[] } = {},
) {
  return new Promise<AsyncRunnerResult>((resolvePromise) => {
    const child = spawn(process.execPath, [...execArgv, runnerPath, ...args], {
      cwd: repositoryRoot,
      env: runnerEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error: NodeJS.ErrnoException | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            error ??= Object.assign(new Error(`runner exceeded ${timeout} ms`), {
              code: "ETIMEDOUT",
            });
            child.kill("SIGTERM");
          }, timeout);
    const settle = (status: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, stdout, stderr, error });
    };
    child.on("error", (spawnError) => {
      error ??= spawnError;
      settle(null, null);
    });
    child.on("close", settle);
  });
}

// Node arguments that give the runner a clock that stands still at holdAt (Unix epoch
// milliseconds) until every gate path exists (tests/helpers/ci-runner-held-clock.ts). A test
// that needs its fixture in some state before the lane deadline creates a gate there, so a
// busy host delays the deadline instead of reaching it first (finding 2164).
export function heldClock(holdAt: number, gates: readonly string[]) {
  const preload = new URL("./ci-runner-held-clock.ts", import.meta.url);
  preload.searchParams.set("hold", String(holdAt));
  for (const gate of gates) {
    preload.searchParams.append("gate", gate);
  }
  return ["--import", preload.href];
}

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
  await writeFile(
    join(root, "tests/helpers/compose-network.mjs"),
    await readFile(new URL("./compose-network.mjs", import.meta.url)),
  );
  await mkdir(join(root, "scripts/ci"), { recursive: true });
  await writeFile(
    join(root, "scripts/ci/failure-redaction.mjs"),
    await readFile(new URL("../../scripts/ci/failure-redaction.mjs", import.meta.url)),
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
