import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { asRecord } from "../../packages/utils/src/index.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const repository = await realpath(resolve(import.meta.dirname, "../.."));
const script = join(repository, "scripts", "prepare-development-codex-seccomp.ts");
const image = `registry.invalid/runtime@sha256:${"a".repeat(64)}`;
const dockerHost = "unix:///tmp/dev-codex-seccomp-failure.sock";

// Runs the real preparation script and seccomp library against an owned
// development state directory. Only the external kubectl binary is a stand-in,
// so this proves the failure report, not behavior on a real node.
async function prepare(
  t: TestContext,
  kubectlSource?: string,
  inspect?: (state: string) => Promise<void>,
) {
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
  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: dockerHost, PATH: tools };
  delete env.NODE_TEST_CONTEXT;
  // The kubectl fixture takes a copy of stderr while the preparation process is still running.
  const stderrPath = join(state, "stderr.log");
  const stderrFile = await open(stderrPath, "w", 0o600);
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(process.execPath, [script, state, image, "1"], {
      cwd: repository,
      encoding: "utf8",
      env,
      timeout: 30_000,
      stdio: ["ignore", "pipe", stderrFile.fd],
    });
  } finally {
    await stderrFile.close();
  }
  const stderr = await readFile(stderrPath, "utf8");
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  await inspect?.(state);
  return { status: result.status, stdout: result.stdout, stderr };
}

function parseKubectlCall(line: string): string[] {
  const call: unknown = JSON.parse(line);
  assert.ok(Array.isArray(call), "expected kubectl argv array");
  const argv: unknown[] = call;
  assert.ok(
    argv.every((arg) => typeof arg === "string"),
    "expected string kubectl arguments",
  );
  return argv;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  assert.ok(record, `expected ${label}`);
  return record;
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
      async (state) => {
        const calls = (await readFile(join(state, "calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map(parseKubectlCall);
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
        // The last call must delete the Namespace that the probe created.
        const creation = calls.find(
          ([command, resource]) => command === "create" && resource === "namespace",
        );
        const createdNamespace = creation?.[2];
        assert.ok(typeof createdNamespace === "string", "expected a created namespace name");
        const deletion = calls.at(-1);
        assert.deepEqual(deletion, [
          "delete",
          "namespace",
          createdNamespace,
          "--ignore-not-found=true",
          "--wait=true",
        ]);
        assert.equal(
          (await readdir(state)).some((name) => name.startsWith("codex-seccomp-")),
          false,
        );
        const manifest: unknown = JSON.parse(await readFile(join(state, "manifest.json"), "utf8"));
        const pod = jsonObject(manifest, "a probe Pod");
        const spec = jsonObject(pod.spec, "a Pod spec");
        assert.ok(Array.isArray(spec.containers), "expected Pod containers");
        const containers: unknown[] = spec.containers;
        const probe = jsonObject(containers[0], "a probe container");
        const securityContext = jsonObject(spec.securityContext, "Pod security context");
        assert.equal(probe.image, image);
        assert.equal(probe.imagePullPolicy, "Never");
        assert.deepEqual(securityContext.seccompProfile, { type: "RuntimeDefault" });
        assert.equal(securityContext.runAsNonRoot, true);
        assert.equal(spec.automountServiceAccountToken, false);
        assert.deepEqual(probe.securityContext, {
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
