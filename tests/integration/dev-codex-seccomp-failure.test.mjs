import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repository = await realpath(resolve(import.meta.dirname, "../.."));
const script = join(repository, "scripts", "prepare-development-codex-seccomp.mjs");
const image = `registry.invalid/runtime@sha256:${"a".repeat(64)}`;
const dockerHost = "unix:///tmp/dev-codex-seccomp-failure.sock";

// Runs the real preparation script and seccomp library against an owned
// development state directory. Only the external kubectl binary is a stand-in,
// so this proves the failure report, not behavior on a real node.
async function prepare(t, kubectlSource) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "oce-dev-codex-seccomp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "state");
  const tools = join(directory, "tools");
  await mkdir(state, { mode: 0o700 });
  await mkdir(tools, { mode: 0o700 });
  await Promise.all([
    writeFile(join(state, ".openclaw-development"), "openclaw-enterprise-development-v3\n", {
      mode: 0o600,
    }),
    writeFile(
      join(state, "state.json"),
      `${JSON.stringify({
        version: 3,
        repository,
        computeDriver: "kubernetes",
        deploymentMode: "k3d",
        sandboxDriver: "none",
        containerEngine: "docker",
        cluster: "occ-dev-seccomp-failure",
        dockerHost,
      })}\n`,
      { mode: 0o600 },
    ),
    writeFile(join(state, "kubeconfig"), "{}\n", { mode: 0o600 }),
    kubectlSource === undefined
      ? undefined
      : writeFile(join(tools, "kubectl"), `#!${process.execPath}\n${kubectlSource}\n`, {
          mode: 0o700,
        }),
  ]);
  const env = { ...process.env, DOCKER_HOST: dockerHost, PATH: tools };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [script, state, image, "5"], {
    cwd: repository,
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
}

test("a failed node probe command reports its stderr but never its stdout", async (t) => {
  // The first probe command is `kubectl get nodes`. Its stdout stands in for
  // CRI output that can contain mount details and must stay out of the report.
  const result = await prepare(
    t,
    `process.stdout.write("mount-detail-that-must-not-print\\n");
process.stderr.write("Unable to connect to the server: connection refused\\n");
process.exit(1);`,
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /Development Codex sandbox preparation failed: kubectl failed \(exit 1\): Unable to connect to the server: connection refused/,
  );
  assert.doesNotMatch(result.stderr, /mount-detail-that-must-not-print/);
});

test("a missing kubectl is reported as not found", async (t) => {
  // An empty tool directory makes the first kubectl call fail to spawn,
  // which previously looked the same as any other kubectl failure.
  const result = await prepare(t);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /preparation failed: kubectl failed \(ENOENT\)/);
});
