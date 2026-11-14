import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const repository = await realpath(resolve(import.meta.dirname, "../.."));
const script = join(repository, "scripts", "prepare-development-codex-seccomp.ts");
const image = `registry.invalid/runtime@sha256:${"a".repeat(64)}`;
const dockerHost = "unix:///tmp/dev-codex-seccomp-failure.sock";

// Runs the real preparation script and seccomp library against an owned
// development state directory. Only the external kubectl binary is a stand-in,
// so this proves the failure report, not behavior on a real node.
async function prepare(t, kubectlSource, inspect) {
  const directory = await realpath(await temporaryDirectory(t, "oce-dev-codex-seccomp-"));
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
  const stderr = await open(join(state, "stderr.log"), "w", 0o600);
  const result = spawnSync(process.execPath, [script, state, image, "1"], {
    cwd: repository,
    encoding: "utf8",
    env,
    timeout: 30_000,
    stdio: ["ignore", "pipe", stderr.fd],
  });
  await stderr.close();
  result.stderr = await readFile(join(state, "stderr.log"), "utf8");
  if (inspect) {
    await inspect({ state, directory });
  }
  return result;
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

  assert.doesNotMatch(result.stderr, /OCE_CODEX_SECCOMP_READINESS_FAILURE/);
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

  assert.doesNotMatch(result.stderr, /OCE_CODEX_SECCOMP_READINESS_FAILURE/);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /preparation failed: kubectl failed \(ENOENT\)/);
});

for (const reason of ["ErrImageNeverPull", "arbitrary-reason-sentinel", undefined]) {
  test(`RuntimeDefault readiness reports only an allowed waiting reason: ${reason}`, async (t) => {
    const result = await prepare(
      t,
      `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const state = path.dirname(args[1]);
const log = path.join(state, "calls.jsonl");
fs.appendFileSync(log, JSON.stringify(args.slice(6)) + "\\n");
const command = args[6];
if (command === "get" && args[7] === "nodes") {
  console.log(JSON.stringify({items: [{metadata: {name: "k3d-occ-dev-seccomp-failure-server-0"}}]}));
} else if (command === "create" || command === "delete") {
  if (command === "delete") {
    fs.copyFileSync(path.join(state, "stderr.log"), path.join(state, "before-cleanup.log"));
  }
} else if (command === "apply") {
  fs.copyFileSync(args[8], path.join(state, "manifest.json"));
} else if (command === "get" && args[7] === "pod") {
  console.log(JSON.stringify({status: {containerStatuses: [
    {name: "unrelated", state: {waiting: {reason: "ImagePullBackOff"}}},
    {name: "probe", ready: false, state: {waiting: {reason: ${JSON.stringify(reason) ?? "undefined"}, message: "waiting-message-sentinel"}}}
  ]}}));
} else process.exit(90);
`,
      async ({ state }) => {
        const calls = (await readFile(join(state, "calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse);
        const observations = calls.filter(
          ([command, resource]) => command === "get" && resource === "pod",
        );
        assert.ok(observations.length >= 1 && observations.length <= 2);
        assert.match(
          await readFile(join(state, "before-cleanup.log"), "utf8"),
          /^OCE_CODEX_SECCOMP_READINESS_FAILURE .*\n$/,
        );
        assert.equal(
          calls.some(([command]) => command === "exec"),
          false,
        );
        const deletion = calls.at(-1);
        assert.deepEqual(deletion, [
          "delete",
          "namespace",
          calls.find(([command]) => command === "create")[2],
          "--ignore-not-found=true",
          "--wait=true",
        ]);
        assert.equal(
          (await readdir(state)).some((name) => name.startsWith("codex-seccomp-")),
          false,
        );
        const pod = JSON.parse(await readFile(join(state, "manifest.json"), "utf8"));
        assert.equal(pod.spec.containers[0].image, image);
        assert.equal(pod.spec.containers[0].imagePullPolicy, "Never");
        assert.deepEqual(pod.spec.securityContext.seccompProfile, { type: "RuntimeDefault" });
        assert.equal(pod.spec.securityContext.runAsNonRoot, true);
        assert.equal(pod.spec.automountServiceAccountToken, false);
        assert.deepEqual(pod.spec.containers[0].securityContext, {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
        });
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const marker =
      "OCE_CODEX_SECCOMP_READINESS_FAILURE " +
      JSON.stringify({
        operation: "runtime-default-pod-readiness",
        reason: reason === "ErrImageNeverPull" ? reason : null,
      });
    assert.equal(
      result.stderr
        .split("\n")
        .filter((line) => line.startsWith("OCE_CODEX_SECCOMP_READINESS_FAILURE"))
        .join("\n"),
      marker,
    );
    assert.match(
      result.stderr,
      /Development Codex sandbox preparation failed: Timed out waiting for Pod .* to become ready\./,
    );
    assert.doesNotMatch(result.stderr, /waiting-message-sentinel|arbitrary-reason-sentinel/);
  });
}
