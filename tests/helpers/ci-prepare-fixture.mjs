import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { defaultK3sImage, lanesWithoutK3sAddons } from "../../scripts/ci/prepare.mjs";

// Shared by ci-prepare.test.mjs and ci-prepare-k3d.test.mjs, which split the
// preparation cases so Checks and Conformance 2 can run them at the same time.
const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export const digest = "a".repeat(64);
export const immutableImage = `registry.example/openclaw/runtime@sha256:${digest}`;
export const nodeBaseImage = `docker.io/library/node:24-bookworm@sha256:${digest}`;
export const mutableImage = "registry.example/openclaw/runtime:latest";

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ci-prepare-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  return root;
}

// Lane preparation stderr opens with timing and host metrics, and assert.match's default
// message keeps only its start (finding 818). Show the end, where the cause is.
export function assertStderrMatch(stderr, pattern, label) {
  const prefix = label ? `${label}: ` : "";
  const tail = stderr.slice(-1_500);
  assert.match(
    stderr,
    pattern,
    `${prefix}stderr did not match ${pattern}; it ended with:\n${tail}`,
  );
}

export function fixturePreparationMetrics(stderr) {
  return stderr.split("\n").flatMap((line) => {
    const match = line.match(/^\[prepare:k3d-fixture-configuration\] (\{.*\})$/);
    return match ? [JSON.parse(match[1])] : [];
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
export function spawnResult(command, args, { env, timeout = watchdogMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: "", stderr: "" };
    let error;
    for (const stream of ["stdout", "stderr"]) {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk) => (output[stream] += chunk));
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

export async function fixtureImageCommands(
  t,
  scenario,
  lane = "k3d-fixture-configuration",
  extraEnv = {},
) {
  const root = await fixture(t);
  const bin = join(root, "bin");
  const home = join(root, "home");
  await mkdir(bin);
  await mkdir(home);
  const commandUrl = new URL("./ci-prepare-fixture-command.mjs", import.meta.url).href;
  const commandSource = `#!${process.execPath}\nimport ${JSON.stringify(commandUrl)};\n`;
  for (const command of [
    "docker.mjs",
    "k3d.mjs",
    "kubectl.mjs",
    "podman",
    "corepack",
    "helm",
    "yq",
  ]) {
    await writeFile(join(bin, command), commandSource, { mode: 0o700 });
  }
  const statePath = join(root, "state.json");
  const githubEnv = join(root, "github.env");
  // No inherited credentials, infrastructure selectors, or real command fallback.
  const env = {
    HOME: home,
    PATH: bin,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    RUNNER_TEMP: root,
    CI_FIXTURE_ROOT: root,
    CI_FIXTURE_SCENARIO: scenario,
    CI_FIXTURE_LANE: lane,
    OCC_DOCKER_BIN: join(
      bin,
      ["podman-success", "podman-image-absent"].includes(scenario) ? "podman" : "docker.mjs",
    ),
    OPENCLAW_CI_K3D_BIN: join(bin, "k3d.mjs"),
    OCC_KUBECTL_BIN: join(bin, "kubectl.mjs"),
    ...extraEnv,
    CI_FIXTURE_COMMAND_CONFIG: JSON.stringify({
      defaultK3sImage,
      lanesWithoutK3sAddons: [...lanesWithoutK3sAddons],
      hungCommandExitMs,
    }),
  };
  const run = (script, args) =>
    spawnResult(process.execPath, [join(repositoryRoot, "scripts/ci", script), ...args], { env });
  const prepareArgs = ["--lane", lane, "--state", statePath, "--github-env", githubEnv];
  const cleanup = () => run("cleanup.mjs", ["--state", statePath]);
  return {
    statePath,
    githubEnv,
    prepare: () => run("prepare.mjs", prepareArgs),
    warmImageCache: (args = []) =>
      run("prepare.mjs", ["--warm-image-cache", "--state", statePath, ...args]),
    prepareFile: (file) =>
      run("prepare.mjs", ["--lane", lane, "--file", file, "--state", statePath]),
    cleanup,
    cleanupSuccessfully: async () => {
      const result = await cleanup();
      assert.equal(result.status, 0, result.stderr);
    },
    readState: async () => JSON.parse(await readFile(statePath, "utf8")),
    commands: async () =>
      (await readFile(join(root, "commands.jsonl"), "utf8")).trim().split("\n").map(JSON.parse),
  };
}
