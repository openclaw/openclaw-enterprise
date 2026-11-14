import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { CleanupRegistrar } from "./console-file-app.ts";
import { commandShim, startFixtureCommandServer } from "./ci-prepare-fixture-command.ts";
import { readJsonLines } from "./json-lines.mjs";
import { socketDirectory } from "./socket-directory.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";

export { forwardedEnv } from "./ci-prepare-fixture-command.ts";

// Shared by ci-prepare.test.mjs and ci-prepare-k3d.test.ts, which split the
// preparation cases so Checks and Conformance 2 can run them at the same time.
const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export const digest = "a".repeat(64);
export const immutableImage = `registry.example/openclaw/runtime@sha256:${digest}`;
export const nodeBaseImage = `docker.io/library/node:24-bookworm@sha256:${digest}`;
export const mutableImage = "registry.example/openclaw/runtime:latest";

export async function fixture(t: CleanupRegistrar) {
  const root = await temporaryDirectory(t, "ci-prepare-test-");
  await mkdir(root, { recursive: true });
  return root;
}

// Lane preparation stderr opens with timing and host metrics, and assert.match's default
// message keeps only its start (finding 818). Show the end, where the cause is.
export function assertStderrMatch(stderr: string, pattern: RegExp, label?: string) {
  const prefix = label ? `${label}: ` : "";
  const tail = stderr.slice(-1_500);
  assert.match(
    stderr,
    pattern,
    `${prefix}stderr did not match ${pattern}; it ended with:\n${tail}`,
  );
}

type PreparationMetric = Record<string, unknown> & {
  stage: string;
  status?: string;
  elapsedMs?: number;
};

function isPreparationMetric(value: unknown): value is PreparationMetric {
  const metric = asRecord(value);
  return (
    metric !== undefined &&
    typeof metric.stage === "string" &&
    (metric.status === undefined || typeof metric.status === "string") &&
    (metric.elapsedMs === undefined || typeof metric.elapsedMs === "number")
  );
}

export function fixturePreparationMetrics(
  stderr: string,
  lane = "k3d-fixture-configuration",
): PreparationMetric[] {
  const prefix = `[prepare:${lane}] `;
  return stderr.split("\n").flatMap((line) => {
    if (!line.startsWith(`${prefix}{`)) {
      return [];
    }
    let metric: unknown;
    try {
      metric = JSON.parse(line.slice(prefix.length));
    } catch {
      throw new Error("invalid CI preparation metric");
    }
    assert.ok(isPreparationMetric(metric), "invalid CI preparation metric");
    return [metric];
  });
}

// The CLI watchdog catches a preparation that never ends: one whose own timeouts failed
// to stop a hung command. It is generous because it only fires on a hang, and concurrent
// cases on a loaded host stretch a passing preparation (up to about 40 s at four copies
// of the k3d file on four CPUs). A hung fake command exits on its own only after it has
// fired, so a preparation that waits for it still fails on the watchdog.
const watchdogMs = 90_000;
const hungCommandExitMs = watchdogMs + 30_000;

// spawnSync's result shape and timeout, asynchronously, so concurrent tests overlap: it
// resolves once the child has exited and closed its output. A child still running after
// the timeout gets SIGTERM and an ETIMEDOUT error, and its output pipes are closed, as
// spawnSync does. Unlike spawnSync, output is not capped at 1 MiB (these children write
// a few kilobytes).
type SpawnOptions = {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  onSpawn?: (child: ChildProcess) => void;
};
type SpawnResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  error: Error | undefined;
  stdout: string;
  stderr: string;
};

export function spawnResult(
  command: string,
  args: string[],
  { env, timeout = watchdogMs, onSpawn }: SpawnOptions = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onSpawn?.(child);
    const output = { stdout: "", stderr: "" };
    let error: Error | undefined;
    const streams: ("stdout" | "stderr")[] = ["stdout", "stderr"];
    for (const stream of streams) {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk: string) => (output[stream] += chunk));
    }
    const timer = setTimeout(() => {
      error = Object.assign(new Error(`spawn ${command} ETIMEDOUT`), { code: "ETIMEDOUT" });
      child.kill("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeout);
    child.on("error", (spawnError) => (error ??= spawnError));
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, error, ...output });
    });
  });
}

// The host programs the fake commands run by absolute path: the fixture PATH holds only
// the fakes.
let shimPrograms: { bash: string; sleep: string; setsid: string } | undefined;
function hostProgram(name: string) {
  for (const directory of [...(process.env.PATH ?? "").split(delimiter), "/usr/bin", "/bin"]) {
    const path = join(directory, name);
    try {
      if (isAbsolute(directory)) {
        accessSync(path, constants.X_OK);
        return path;
      }
    } catch {
      // Not here.
    }
  }
  throw new Error(`the CI preparation fixture needs ${name} on PATH`);
}

// The command server of one fixture directory, closed after the test.
export async function fixtureCommandServer(t: CleanupRegistrar, root: string) {
  const server = await startFixtureCommandServer({ root, hungCommandExitMs });
  t.after(() => server.close());
  return server;
}

// A fake command answered by server (or by whatever listens on port), private to this
// user: the script holds the server's tokens.
export async function writeFixtureCommand(
  path: string,
  command: string,
  server: Awaited<ReturnType<typeof startFixtureCommandServer>>,
  port = server.port,
) {
  shimPrograms ??= {
    bash: hostProgram("bash"),
    sleep: hostProgram("sleep"),
    setsid: hostProgram("setsid"),
  };
  const { clientToken, serverToken } = server;
  const source = commandShim({ ...shimPrograms, port, clientToken, serverToken, command });
  await writeFile(path, source, { mode: 0o700 });
}

type FixtureResource = Record<string, unknown> & {
  id: string;
  kind: string;
  status: string;
  owner: string;
  name?: string;
  directory?: string;
};
type FixtureState = Record<string, unknown> & {
  lane: string;
  prefix: string;
  resources: FixtureResource[];
  env?: Record<string, string>;
};

function isFixtureResource(value: unknown): value is FixtureResource {
  const resource = asRecord(value);
  return (
    resource !== undefined &&
    typeof resource.id === "string" &&
    typeof resource.kind === "string" &&
    typeof resource.status === "string" &&
    typeof resource.owner === "string" &&
    (resource.name === undefined || typeof resource.name === "string") &&
    (resource.directory === undefined || typeof resource.directory === "string")
  );
}

function isFixtureState(value: unknown): value is FixtureState {
  const state = asRecord(value);
  const env = state?.env === undefined ? undefined : asRecord(state.env);
  return (
    state !== undefined &&
    typeof state.lane === "string" &&
    typeof state.prefix === "string" &&
    Array.isArray(state.resources) &&
    state.resources.every(isFixtureResource) &&
    (state.env === undefined ||
      (env !== undefined && Object.values(env).every((entry) => typeof entry === "string")))
  );
}

type FixtureCommand = {
  command: string;
  args: string[];
  at?: number;
  envPublished?: boolean;
};

function isFixtureCommand(value: unknown): value is FixtureCommand {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.command === "string" &&
    Array.isArray(record.args) &&
    record.args.every((argument: unknown) => typeof argument === "string") &&
    (record.at === undefined || (typeof record.at === "number" && Number.isFinite(record.at))) &&
    (record.envPublished === undefined || typeof record.envPublished === "boolean")
  );
}

export async function fixtureImageCommands(
  t: CleanupRegistrar,
  scenario: string,
  lane = "k3d-fixture-configuration",
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const root = await fixture(t);
  const bin = join(root, "bin");
  const home = join(root, "home");
  await mkdir(bin);
  await mkdir(home);
  // Each fake is a bash script answered by this test's command server
  // (ci-prepare-fixture-command.ts), which runs the scenario's logic in this process.
  const server = await fixtureCommandServer(t, root);
  for (const file of ["docker.mjs", "k3d.mjs", "kubectl.mjs", "podman", "corepack", "helm", "yq"]) {
    await writeFixtureCommand(join(bin, file), file.replace(/\.mjs$/, ""), server);
  }
  await symlink(process.execPath, join(bin, "node"));
  const statePath = join(root, "state.json");
  const githubEnv = join(root, "github.env");
  // The fake PostgreSQL server's Unix socket (ci-prepare-fixture-command.ts).
  const postgresSockets = await socketDirectory(t, "ci-prepare-pg-", {
    longest: ".s.PGSQL.65535",
  });
  // No inherited credentials, infrastructure selectors, or real command fallback.
  const env = {
    HOME: home,
    PATH: bin,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    RUNNER_TEMP: root,
    CI_FIXTURE_SCENARIO: scenario,
    CI_FIXTURE_LANE: lane,
    OCC_DOCKER_BIN: join(
      bin,
      ["podman-success", "podman-image-absent"].includes(scenario) ? "podman" : "docker.mjs",
    ),
    OPENCLAW_CI_K3D_BIN: join(bin, "k3d.mjs"),
    OCC_KUBECTL_BIN: join(bin, "kubectl.mjs"),
    OPENCLAW_CI_POSTGRES_SOCKET_DIR: postgresSockets,
    ...extraEnv,
  };
  const run = (script: string, args: string[], options?: SpawnOptions) =>
    spawnResult(process.execPath, [join(repositoryRoot, "scripts/ci", script), ...args], {
      ...options,
      env: { ...env, ...options?.env },
    });
  const prepareArgs = ["--lane", lane, "--state", statePath, "--github-env", githubEnv];
  const cleanup = () => run("cleanup.mjs", ["--state", statePath]);
  return {
    statePath,
    githubEnv,
    runShell: (script: string, extraEnv: NodeJS.ProcessEnv = {}) =>
      spawnResult(hostProgram("bash"), ["-e", "-o", "pipefail", "-c", script], {
        env: { ...env, ...extraEnv },
      }),
    prepare: (args: string[] = [], options?: SpawnOptions) =>
      run("prepare.mjs", [...prepareArgs, ...args], options),
    prepareStagingSignin: () =>
      spawnResult(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import { prepareStagingSigninCluster } from "./scripts/ci/prepare.mjs"; await prepareStagingSigninCluster(process.argv[1]);',
          statePath,
        ],
        { env },
      ),
    warmImageCache: (args: string[] = []) =>
      run("prepare.mjs", ["--warm-image-cache", "--state", statePath, ...args]),
    prepareFile: (file: string) =>
      run("prepare.mjs", ["--lane", lane, "--file", file, "--state", statePath]),
    cleanup,
    cleanupSuccessfully: async () => {
      const result = await cleanup();
      assert.equal(result.status, 0, result.stderr);
    },
    readState: async () => {
      const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
      assert.ok(isFixtureState(state), "invalid CI preparation fixture state");
      return state;
    },
    commands: async (): Promise<FixtureCommand[]> => {
      const records: unknown = await readJsonLines(join(root, "commands.jsonl"));
      assert.ok(
        Array.isArray(records) && records.every(isFixtureCommand),
        "invalid CI command log",
      );
      return records;
    },
  };
}
