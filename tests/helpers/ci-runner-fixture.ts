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
const runnerPath = join(repositoryRoot, "scripts/ci/run-tests.ts");

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

export async function writeCleanupFixture(root: string, mode: "sync" | "async" = "async") {
  const asyncKeyword = mode === "async" ? "async " : "";
  await writeFile(
    join(root, "scripts/ci/prepare.ts"),
    [
      'import { appendFile } from "node:fs/promises";',
      `export ${asyncKeyword}function prepareFile({ file, statePath }) {`,
      `  return { cleanup: ${asyncKeyword}() => appendFile(statePath, file.path + "\\n") };`,
      "}",
      "",
    ].join("\n"),
  );
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

export async function writeRunnerLaneFiles(
  root: string,
  lane: string,
  names: readonly string[],
  source: string,
) {
  const files = names.map((name) => ({ path: `tests/integration/${name}.test.mjs` }));
  for (const { path } of files) {
    await writeFile(join(root, path), source);
  }
  await writeRunnerManifest(root, { lanes: { [lane]: { files } } });
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
    join(root, "tests/helpers/compose-network.ts"),
    await readFile(new URL("./compose-network.ts", import.meta.url)),
  );
  await mkdir(join(root, "scripts/lib"), { recursive: true });
  await writeFile(
    join(root, "scripts/lib/podman-compose-provider.ts"),
    await readFile(new URL("../../scripts/lib/podman-compose-provider.ts", import.meta.url)),
  );
  await mkdir(join(root, "scripts/ci"), { recursive: true });
  await writeFile(
    join(root, "scripts/ci/failure-redaction.ts"),
    await readFile(new URL("../../scripts/ci/failure-redaction.ts", import.meta.url)),
  );
  await writeFile(join(root, "bin/occ"), `#!${process.execPath}\n${cliBody}`, { mode: 0o700 });
}

export function requireTestResult<T extends { name: string }>(
  results: readonly T[],
  name: string,
): T {
  const result = results.find((entry) => entry.name === name);
  assert.ok(result, `Missing test result: ${name}`);
  return result;
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

type ProcReader = (path: string, encoding: "utf8") => string;

function readProcFile(path: string, read: ProcReader) {
  try {
    return read(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    ) {
      return undefined;
    }
    throw error;
  }
}

export function readProcStat(pid: number, read: ProcReader = readFileSync) {
  const text = readProcFile(`/proc/${pid}/stat`, read);
  if (text === undefined) {
    return undefined;
  }

  // The process name can contain spaces and parentheses. Fields 3, 5 and 22
  // are the state, process group and start time. Require a delimiter after
  // each identity field so a short read cannot turn it into a different number.
  const fields = text.slice(text.lastIndexOf(")") + 1);
  const identity = /^ ([a-zA-Z]) \d+ ([1-9]\d*) (?:-?\d+ ){16}(\d+) /u.exec(fields);
  const state = identity?.[1];
  const pgid = Number(identity?.[2]);
  const start = identity?.[3];
  assert.ok(
    text.startsWith(`${pid} (`) && state && start && pgid <= 0x7fffffff,
    `Invalid process group or start time in /proc/${pid}/stat`,
  );
  return { state, pgid, start };
}

// Best effort only. An unknown identity cannot authorize a signal or prove exit.
export function procStat(pid: number, read: ProcReader = readFileSync) {
  try {
    return readProcStat(pid, read);
  } catch {
    return undefined;
  }
}

function hasExited(state: string) {
  return state === "Z" || state === "X";
}

export function detachedProcessLive(
  record: { pid: number; start: string },
  purpose: "assert" | "teardown",
  read: ProcReader = readFileSync,
) {
  const observe = purpose === "teardown" ? procStat : readProcStat;
  const current = observe(record.pid, read);
  return current?.start === record.start && !hasExited(current.state);
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

// The recorded fixture processes still in group `pgid` that nothing has killed. A process
// counts as killed once it is gone, a zombie (Z) or dead and being reaped (X), or SIGKILL
// is pending for its whole thread group. kill(-pgid, "SIGKILL") queues that shared signal
// before it returns and the kernel clears it only when it releases the process, so this
// needs no deadline. Waiting for the processes to disappear did: on a busy host a killed
// multithreaded Node process can take seconds to finish exiting (a zombie leader with
// another thread still running its exit, or a process still being reaped).
export function unkilled(pids: readonly number[], pgid: number, read: ProcReader = readFileSync) {
  return pids.filter((pid) => {
    const stat = readProcStat(pid, read);
    if (!stat || stat.pgid !== pgid || hasExited(stat.state)) {
      return false;
    }
    const status = readProcFile(`/proc/${pid}/status`, read);
    if (status === undefined) {
      return false;
    }
    // Signal masks are hexadecimal with bit (signal number - 1) set; SIGKILL is 9.
    const sharedPending = /^ShdPnd:[ \t]*([0-9a-f]+)\n/mu.exec(status);
    return sharedPending === null || (BigInt(`0x${sharedPending[1]}`) & (1n << 8n)) === 0n;
  });
}

// Polls until check() is truthy or the deadline passes; returns check()'s last value.
export async function waitFor<T>(check: () => T, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = check();
  while (!value && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = check();
  }
  return value;
}
