import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  codexBwrapAdditionalSyscalls,
  deriveCodexBwrapProfile,
  prepareCodexSeccompProfile,
} from "../../scripts/ci/codex-seccomp.mjs";
import { createKubernetesInstallationConfiguration } from "../helpers/kubernetes-real.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const preparePath = join(repositoryRoot, "scripts/ci/prepare.mjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ci-prepare-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  return root;
}

async function writeState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function runPrepare(args, env = {}) {
  return spawnSync(process.execPath, [preparePath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function fixtureImageCommands(
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
  const commandSource = `#!${process.execPath}\n${String.raw`
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const root = process.env.CI_FIXTURE_ROOT;
const scenario = process.env.CI_FIXTURE_SCENARIO;
const command = basename(process.argv[1], ".mjs");
const args = process.argv.slice(2);
const statePath = join(root, "commands-state.json");
const initialState = existsSync(statePath) ? readFileSync(statePath, "utf8") : "{}";
const state = JSON.parse(initialState);
const equals = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
const configId = "sha256:" + "b".repeat(64);
const manifestDigest = "sha256:" + "c".repeat(64);
appendFileSync(join(root, "commands.jsonl"), JSON.stringify({
  command, args, envPublished: existsSync(join(root, "github.env")),
}) + "\n");
function finish(stdout = "") {
  // Parallel diagnostic reads must not truncate the shared fixture state.
  const serializedState = JSON.stringify(state);
  if (serializedState !== initialState) {
    writeFileSync(statePath, serializedState);
  }
  process.stdout.write(stdout);
  process.exit(0);
}

if (command === "docker" || command === "podman") {
  if (equals(args, ["version", "--format", "{{.Server.Version}}"])) finish("29.4.0\n");
  const sourceImage = process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE;
  if (sourceImage && equals(args, ["image", "inspect", "--format", "{{json .RepoDigests}}", sourceImage])) {
    if (scenario === "inspect-failed" || (scenario === "image-absent" && !state.pulled)) {
      process.stderr.write(scenario === "inspect-failed" ? "Cannot connect to the Docker daemon\n" : "Error response from daemon: No such image\n");
      process.exit(1);
    }
    const matching = scenario === "local-digest" || (state.pulled && scenario !== "pull-mismatch");
    finish(JSON.stringify([matching ? sourceImage : "registry.example/other@sha256:" + "d".repeat(64)]));
  }
  if (sourceImage && equals(args, ["pull", sourceImage])) {
    state.pulled = true;
    finish();
  }
  if (sourceImage && equals(args, ["image", "inspect", "--format", "{{.Id}}", sourceImage])) finish(configId + "\n");
  if (sourceImage && args[0] === "tag" && args[1] === sourceImage) {
    state.tag = args[2];
    finish();
  }
  if (args[0] === "compose" && args[1] === "-f" && args[3] === "-p") {
    assert.match(args[4], /^openclaw_ci_pg_/);
    if (equals(args.slice(5), ["up", "-d", "--wait"])) finish();
    if (equals(args.slice(5), ["down", "--volumes", "--remove-orphans"])) finish();
    if (args[5] === "exec" && args[8] === "psql") finish();
  }
  if (equals(args.slice(0, 3), ["inspect", "--format", "{{json .NetworkSettings.Networks}}"]) &&
      args[3] === "k3d-" + state.cluster + "-server-0") {
    finish(JSON.stringify({ ["k3d-" + state.cluster]: {
      Gateway: scenario === "public-gateway" ? "203.0.113.1" : "172.19.0.1",
    } }));
  }
  if (args[0] === "build" && args.includes("--build-arg")) {
    assert.equal(args[args.indexOf("--build-arg") + 1], "RUNTIME_IMAGE=" + state.runtime);
    assert.ok(args[args.indexOf("-f") + 1].endsWith("/Dockerfile.platform-fixture"));
    state.tag = args[args.indexOf("-t") + 1];
    finish();
  }
  if (args[0] === "build" && args.includes("-f")) {
    assert.ok(args[args.indexOf("-f") + 1].endsWith("/deploy/runtime/Dockerfile"));
    state.runtime = args[args.indexOf("-t") + 1];
    finish();
  }
  if (equals(args.slice(0, 3), ["build", "--pull=false", "-t"]) && args.length === 5) {
    assert.equal(args[3], "localhost/" + state.cluster + "/fixture:local");
    state.tag = args[3];
    finish();
  }
  if (equals(args, ["image", "inspect", state.tag])) finish("[]\n");
  if (equals(args, ["image", "inspect", "--format", "{{.Id}}", state.tag])) {
    finish((command === "podman" ? configId.slice("sha256:".length) : configId) + "\n");
  }
  if (equals(args, ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", state.tag])) finish("linux/amd64\n");
  const expectedSave = command === "podman"
    ? ["image", "save", "--output"]
    : ["image", "save", "--platform", "linux/amd64", "--output"];
  if (equals(args.slice(0, expectedSave.length), expectedSave) &&
      args.length === expectedSave.length + 2 && args.at(-1) === state.tag) {
    state.archive = args.at(-2);
    writeFileSync(state.archive, "synthetic image archive\n");
    finish();
  }
  if (equals(args, ["image", "rm", "-f", state.tag])) finish();
  if (state.runtime && equals(args, ["image", "rm", "-f", state.runtime])) finish();
  if (args[0] === "exec" && ["server-0", "agent-0"].some((suffix) =>
      args[1] === "k3d-" + state.cluster + "-" + suffix)) {
    const node = args[1];
    const alias = state.aliases?.[node];
    if (equals(args.slice(2), ["ip", "route", "get", "10.42.7.0"])) {
      assert.ok(node.endsWith("-server-0"));
      finish(scenario === "missing-proxy-source"
        ? "10.42.7.0 dev flannel.1\n"
        : "10.42.7.0 via 10.42.7.0 dev flannel.1 src 10.42.3.0\n");
    }
    const ctr = ["ctr", "-n", "k8s.io", "images"];
    if (equals(args.slice(2), [...ctr, "list"])) {
      const references = [state.imported && state.tag, alias].filter(Boolean);
      finish("REF TYPE DIGEST SIZE PLATFORMS LABELS\n" + references.map((ref) =>
        ref + " application/vnd.oci.image.manifest.v1+json " + manifestDigest + " 1 linux/amd64 -\n",
      ).join(""));
    }
    if (equals(args.slice(2, 8), [...ctr, "tag", state.tag]) && args.length === 9) {
      if (scenario !== "missing-alias") {
        state.aliases ??= {};
        state.aliases[node] = args[8];
      }
      finish();
    }
    if (equals(args.slice(2, 7), [...ctr, "rm"]) && args.length === 8 &&
        [state.tag, alias].includes(args[7])) finish();
    if (equals(args.slice(2), ["crictl", "inspecti", alias]) && alias) {
      if (scenario === "missing-cri" ||
          (scenario === "missing-worker-cri" && node.endsWith("-agent-0"))) {
        process.stderr.write("synthetic CRI image not found\n");
        process.exit(19);
      }
      finish(JSON.stringify({ status: { id: configId, repoDigests: [alias] } }));
    }
  }
}
if (command === "helm" && equals(args, ["version", "--short"])) finish("v3.19.0\n");
if (command === "corepack" && equals(args, ["pnpm", "db:migrate"])) {
  assert.match(process.env.OCC_MIGRATION_DATABASE_URL, /^postgresql:\/\/occ_migrator:.*\/openclaw_k8s_/);
  finish();
}
if (command === "k3d") {
  if (equals(args, ["version"])) finish("k3d version v5.8.3\n");
  if (equals(args.slice(0, 2), ["cluster", "create"]) && [13, 15].includes(args.length)) {
    assert.match(args[2], /^openclaw-k8s-/);
    assert.deepEqual(args.slice(3, 5), ["--image", process.env.OPENCLAW_CI_K3S_IMAGE || "+v1.35"]);
    if (args.length === 15) {
    assert.deepEqual(args.slice(5, 10), ["--servers", "1", "--agents", "1", "--volume"]);
    const storage = args[10].split(":");
    assert.equal(storage[1], "/var/lib/rancher/k3s/storage@all");
    assert.ok(existsSync(storage[0]), "both nodes must mount an existing shared host directory");
    assert.equal(args[11], "--api-port");
    assert.match(args[12], /^127\.0\.0\.1:\d+$/);
    assert.deepEqual(args.slice(13), ["--kubeconfig-update-default=false", "--kubeconfig-switch-context=false"]);
    } else {
    assert.deepEqual(args.slice(5, 10), ["--servers", "1", "--agents", "0", "--api-port"]);
    assert.match(args[10], /^127\.0\.0\.1:\d+$/);
    assert.deepEqual(args.slice(11), ["--kubeconfig-update-default=false", "--kubeconfig-switch-context=false"]);
    }
    state.cluster = args[2];
    finish();
  }
  if (equals(args, ["kubeconfig", "get", state.cluster])) finish("apiVersion: v1\n");
  if (equals(args, ["cluster", "delete", state.cluster])) finish();
  if (equals(args.slice(0, 4), ["image", "import", "--mode", "direct"]) &&
      equals(args.slice(5), ["-c", state.cluster])) {
    assert.equal(args[4], state.archive);
    assert.ok(existsSync(state.archive));
    if (scenario === "nonzero-import") {
      process.stderr.write("synthetic import command failure\n");
      process.exit(17);
    }
    if (scenario === "missing-tag") {
      process.stderr.write("failed to import images in node: synthetic missing content\n");
      finish();
    }
    state.imported = true;
    finish();
  }
}
if (command === "kubectl") {
  if (equals(args, ["version", "--client=true"])) finish("{}\n");
  if (args[0] === "--kubeconfig" && args[2] === "--context" &&
      args[3] === "k3d-" + state.cluster) {
    if (equals(args.slice(4), ["config", "view", "--minify", "--flatten", "-o", "json"])) {
      finish(JSON.stringify({ clusters: [{ cluster: { server: "https://127.0.0.1:6443" } }] }));
    }
    if (equals(args.slice(4), ["wait", "--for=condition=Ready", "nodes", "--all", "--timeout=120s"])) finish();
    if (equals(args.slice(4), ["version", "-o", "json"])) {
      finish(JSON.stringify({ serverVersion: {
        gitVersion: scenario === "wrong-server-version" ? "v1.34.11+k3s1" : "v1.35.8+k3s1",
      } }));
    }
    if (equals(args.slice(4), ["get", "node", "k3d-" + state.cluster + "-agent-0", "-o", "json"])) {
      finish(JSON.stringify({ spec: { podCIDR: "10.42.7.0/24" } }));
    }
    if (equals(args.slice(4), ["get", "nodes", "-o", "json"])) {
      finish(JSON.stringify({ items: [{ metadata: { name: "worker" },
        spec: { taints: [{ key: "node.kubernetes.io/disk-pressure", effect: "NoSchedule" }] },
        status: { conditions: [{ type: "DiskPressure", status: "True", reason: "KubeletHasDiskPressure" }] } }] }));
    }
    if (equals(args.slice(4, 6), ["--namespace", "kube-system"])) {
      if (equals(args.slice(6, 8), ["apply", "-f"]) && args.length === 9) {
        const manifest = JSON.parse(readFileSync(args[8], "utf8"));
        assert.equal(manifest.kind, "DaemonSet");
        assert.equal(manifest.metadata.name, "openclaw-ci-fixture-image-pin");
        assert.equal(manifest.metadata.namespace, "kube-system");
        const pod = manifest.spec.template.spec;
        assert.equal(pod.automountServiceAccountToken, false);
        assert.deepEqual(pod.tolerations, [{ operator: "Exists" }]);
        assert.equal(pod.containers.length, 1);
        assert.equal(pod.containers[0].image, Object.values(state.aliases)[0]);
        assert.equal(pod.containers[0].imagePullPolicy, "Never");
        assert.deepEqual(pod.containers[0].securityContext.capabilities.drop, ["ALL"]);
        assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
        state.fixtureImagePinned = true;
        finish();
      }
      if (equals(args.slice(6), ["rollout", "status", "daemonset/openclaw-ci-fixture-image-pin", "--timeout=120s"])) {
        assert.equal(state.fixtureImagePinned, true);
        finish();
      }
      if (equals(args.slice(6), ["rollout", "status", "deployment/local-path-provisioner", "--timeout=120s"])) {
        if (scenario === "storage-unready" || (scenario === "storage-after-image-unready" && state.storageRestarted)) {
          process.stderr.write("deployment exceeded its progress deadline\n");
          process.exit(1);
        }
        finish();
      }
      if (equals(args.slice(6), ["rollout", "restart", "deployment/local-path-provisioner"])) {
        state.storageRestarted = true;
        finish();
      }
      if (equals(args.slice(6), ["get", "pods", "--selector=app=local-path-provisioner", "-o", "json"])) {
        finish(JSON.stringify({ items: [{ metadata: { name: "local-path-provisioner-fixture" },
          spec: { nodeSelector: { "kubernetes.io/os": "linux" }, containers: [{ env: [{ name: "PRIVATE", value: "do-not-publish-pod-spec" }] }] },
          status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/2 nodes are available: untolerated disk-pressure taint" }], containerStatuses: [{ name: "local-path-provisioner", ready: false,
            restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } } }] } }] }));
      }
      if (equals(args.slice(6), ["logs", "deployment/local-path-provisioner", "--tail=30"]) ||
          equals(args.slice(6), ["logs", "deployment/local-path-provisioner", "--tail=30", "--previous"])) {
        finish("Error starting daemon: fixture configuration rejected\n");
      }
    }
  }
}
throw new Error("Unexpected external command: " + command + " " + JSON.stringify(args));
`}`;
  for (const command of ["docker.mjs", "k3d.mjs", "kubectl.mjs", "podman", "corepack", "helm"]) {
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
    OCC_DOCKER_BIN: join(bin, scenario === "podman-success" ? "podman" : "docker.mjs"),
    OPENCLAW_CI_K3D_BIN: join(bin, "k3d.mjs"),
    OCC_KUBECTL_BIN: join(bin, "kubectl.mjs"),
    ...extraEnv,
  };
  const run = (script, args) =>
    spawnSync(process.execPath, [join(repositoryRoot, "scripts/ci", script), ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
  return {
    statePath,
    githubEnv,
    prepare: () =>
      run("prepare.mjs", ["--lane", lane, "--state", statePath, "--github-env", githubEnv]),
    prepareFile: (file) =>
      run("prepare.mjs", ["--lane", lane, "--file", file, "--state", statePath]),
    cleanup: () => run("cleanup.mjs", ["--state", statePath]),
    commands: async () =>
      (await readFile(join(root, "commands.jsonl"), "utf8")).trim().split("\n").map(JSON.parse),
  };
}

for (const { scenario, error } of [
  { scenario: "success" },
  { scenario: "podman-success" },
  { scenario: "missing-tag", error: /Unable to find imported OCI manifest digest/ },
  {
    scenario: "missing-alias",
    error: /Unable to find imported OCC_TEST_KUBERNETES_IMAGE reference/,
  },
  { scenario: "missing-cri", error: /synthetic CRI image not found/ },
  { scenario: "missing-worker-cri", error: /synthetic CRI image not found/ },
  { scenario: "nonzero-import", error: /synthetic import command failure/ },
]) {
  test(`fixture image CLI verifies runtime registration and cleanup: ${scenario}`, async (t) => {
    const commands = await fixtureImageCommands(t, scenario);
    const result = commands.prepare();
    assert.equal(result.error, undefined);
    const state = JSON.parse(await readFile(commands.statePath, "utf8"));

    if (error) {
      assert.equal(result.status, 1, "preparation must reject an unusable imported fixture");
      assert.match(result.stderr, error);
      assert.equal(state.env, undefined);
      await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
    } else {
      assert.equal(result.status, 0, result.stderr);
    }

    const cluster = state.resources.find((resource) => resource.kind === "k3d-cluster");
    assert.equal(cluster.nodeImage, "+v1.35");
    assert.equal(cluster.kubernetesVersion, "v1.35.8+k3s1");
    const localImage = state.resources.find((resource) => resource.kind === "image-tag");
    const importedImage = state.resources.find((resource) => resource.kind === "k3d-image");
    assert.equal(localImage.status, "ready");
    assert.equal(importedImage.status, error ? "planned" : "ready");
    assert.notEqual(localImage.id, importedImage.id);
    assert.equal(importedImage.sourceImage, localImage.name);
    assert.equal(importedImage.cluster, cluster.name);
    assert.equal(importedImage.hostImageId, `sha256:${"b".repeat(64)}`);
    for (const resource of state.resources) {
      assert.equal(resource.owner, state.prefix);
    }

    const preparation = await commands.commands();
    const save = preparation.find(
      ({ command, args }) =>
        ["docker", "podman"].includes(command) && args[0] === "image" && args[1] === "save",
    );
    assert.ok(save, "registration must export a task-owned archive");
    const archive = save.args[save.args.indexOf("--output") + 1];
    await assert.rejects(() => stat(archive), { code: "ENOENT" });
    assert.equal(save.args.includes("--platform"), scenario !== "podman-success");
    assert.equal(
      preparation.every(({ envPublished }) => !envPublished),
      true,
    );
    if (!error) {
      const expected = `localhost/${cluster.name}/fixture@sha256:${"c".repeat(64)}`;
      assert.equal(importedImage.reference, expected);
      assert.equal(state.env.OCC_TEST_KUBERNETES_IMAGE, expected);
      assert.equal(state.env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS, "10.42.3.0/32");
      assert.ok(
        (await readFile(commands.githubEnv, "utf8"))
          .split("\n")
          .includes(`OCC_TEST_KUBERNETES_IMAGE=${expected}`),
      );
      for (const suffix of ["server-0", "agent-0"]) {
        assert.ok(
          preparation.some(
            ({ command, args }) =>
              command === (scenario === "podman-success" ? "podman" : "docker") &&
              args[1] === `k3d-${cluster.name}-${suffix}` &&
              args[2] === "crictl" &&
              args[4] === expected,
          ),
          "each schedulable node must resolve the published immutable image",
        );
      }
      assert.ok(
        preparation.some(
          ({ command, args }) =>
            command === "kubectl" &&
            args.includes("rollout") &&
            args.includes("daemonset/openclaw-ci-fixture-image-pin"),
        ),
        "preparation must keep the local-only fixture image active on every node",
      );
    }

    const cleanup = commands.cleanup();
    assert.equal(cleanup.error, undefined);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
    await assert.rejects(() => stat(cluster.directory), { code: "ENOENT" });
    const cleanupCalls = (await commands.commands()).slice(preparation.length);
    const localRemoval = cleanupCalls.findIndex(
      ({ command, args }) =>
        ["docker", "podman"].includes(command) && args[0] === "image" && args[1] === "rm",
    );
    const clusterRemoval = cleanupCalls.findIndex(
      ({ command, args }) => command === "k3d" && args[0] === "cluster" && args[1] === "delete",
    );
    assert.ok(localRemoval > 0, "imported image cleanup must precede local tag cleanup");
    assert.ok(clusterRemoval > localRemoval, "the cluster must outlive image cleanup");
  });
}

test("fixture preparation rejects an unknown proxy source before publishing its environment", async (t) => {
  const commands = await fixtureImageCommands(t, "missing-proxy-source");
  const result = commands.prepare();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to determine the cross-node plugin status proxy source/);
  const state = JSON.parse(await readFile(commands.statePath, "utf8"));
  assert.equal(state.env, undefined);
  await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
  // Failed preparation retains ownership so cleanup can remove the partial cluster.
  const cleanup = commands.cleanup();
  assert.equal(cleanup.status, 0, cleanup.stderr);
  await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
});

for (const scenario of ["storage-unready", "storage-after-image-unready"]) {
  test(`fixture preparation reports unavailable storage without publishing workload inputs: ${scenario}`, async (t) => {
    const commands = await fixtureImageCommands(t, scenario);
    const result = commands.prepare();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CI fixture storage controller is not ready/);
    assert.match(result.stderr, /CrashLoopBackOff/);
    assert.match(result.stderr, /fixture configuration rejected/);
    assert.match(result.stderr, /Unschedulable/);
    assert.match(result.stderr, /KubeletHasDiskPressure/);
    assert.doesNotMatch(result.stderr, /do-not-publish-pod-spec/);
    await assert.rejects(() => stat(commands.githubEnv), { code: "ENOENT" });
    const state = JSON.parse(await readFile(commands.statePath, "utf8"));
    assert.equal(state.env, undefined);
    const cleanup = commands.cleanup();
    assert.equal(cleanup.status, 0, cleanup.stderr);
  });
}

const digest = "a".repeat(64);
const immutableImage = `registry.example/openclaw/runtime@sha256:${digest}`;
const nodeBaseImage = `docker.io/library/node:24-bookworm@sha256:${digest}`;
const mutableImage = "registry.example/openclaw/runtime:latest";

test("k3d preparation reuses only matching local immutable images and verifies fresh pulls", async (t) => {
  for (const scenario of [
    "local-digest",
    "image-absent",
    "local-mismatch",
    "pull-mismatch",
    "inspect-failed",
  ]) {
    const commands = await fixtureImageCommands(t, scenario, "k3d-model", {
      NODE_BASE_IMAGE: nodeBaseImage,
      // Supply the controller artifact so this case isolates image import, not its build.
      OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
      OPENAI_API_KEY: "test-only-key",
      OCC_TEST_OPENAI_MODEL: "test-model",
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
      OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
      // Stop at the next independent preparation boundary after image import.
      OCC_TEST_KUBERNETES_CODEX_VERSION: "0.153.0",
    });
    const result = commands.prepare();
    assert.equal(result.status, 1);
    const calls = await commands.commands();
    const pulls = calls.filter(({ command, args }) => command === "docker" && args[0] === "pull");
    assert.equal(
      pulls.length,
      ["local-digest", "inspect-failed"].includes(scenario) ? 0 : 1,
      scenario,
    );
    const state = JSON.parse(await readFile(commands.statePath, "utf8"));
    const imported = state.resources.filter(({ kind }) => kind === "k3d-image");
    if (scenario === "pull-mismatch") {
      assert.match(result.stderr, /pull did not materialize the requested registry digest/);
      assert.equal(imported.length, 0);
    } else if (scenario === "inspect-failed") {
      assert.match(result.stderr, /Cannot connect to the Docker daemon/);
      assert.equal(imported.length, 0);
    } else {
      assert.match(result.stderr, /limited to reviewed Codex versions/);
      assert.equal(imported.length, 1);
      assert.equal(imported[0].status, "ready");
      assert.equal(imported[0].sourceImage, immutableImage);
      assert.equal(imported[0].hostImageId, `sha256:${"b".repeat(64)}`);
    }
    const cleanup = commands.cleanup();
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.ok(
      !(await commands.commands()).some(
        ({ args }) => args[0] === "image" && args[1] === "rm" && args.includes(immutableImage),
      ),
      "cleanup must preserve the caller's immutable source image",
    );
  }
});

test("ordinary k3d preparation forwards an immutable K3s override and retains the server version gate", async (t) => {
  const image = `registry.example/k3s:v1.35.8-k3s1@sha256:${digest}`;
  for (const scenario of ["success", "wrong-server-version"]) {
    const commands = await fixtureImageCommands(t, scenario, "k3d-fixture-configuration", {
      OPENCLAW_CI_K3S_IMAGE: image,
    });
    const result = commands.prepare();
    assert.equal(result.status, scenario === "success" ? 0 : 1, result.stderr);
    const state = JSON.parse(await readFile(commands.statePath, "utf8"));
    const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
    assert.equal(cluster.nodeImage, image);
    if (scenario === "success") {
      assert.equal(cluster.kubernetesVersion, "v1.35.8+k3s1");
    } else {
      assert.match(result.stderr, /must resolve to Kubernetes 1\.35\.x/);
      assert.equal(
        (await commands.commands()).some(({ args }) => args[0] === "build"),
        false,
      );
    }
    const cleanup = commands.cleanup();
    assert.equal(cleanup.status, 0, cleanup.stderr);
  }
});

test("ordinary k3d preparation rejects mutable K3s overrides before creating state", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state.json");
  const result = runPrepare(["--lane", "repository-credentials-platform", "--state", statePath], {
    OPENCLAW_CI_K3S_IMAGE: "rancher/k3s:latest",
    OCC_DOCKER_BIN: join(root, "no-docker-command"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENCLAW_CI_K3S_IMAGE must be an immutable/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
});

test("repository platform preparation binds runtime clients, an owned gateway and a fresh migrated database", async (t) => {
  const commands = await fixtureImageCommands(t, "success", "repository-credentials-platform");
  const prepared = commands.prepare();
  assert.equal(prepared.status, 0, prepared.stderr);
  const state = JSON.parse(await readFile(commands.statePath, "utf8"));
  const cluster = state.resources.find(({ kind }) => kind === "k3d-cluster");
  assert.equal(state.env.OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM, "1");
  assert.equal(state.env.OCC_TEST_REPOSITORY_CREDENTIALS_HOST_ADDRESS, "172.19.0.1");
  assert.equal(
    state.env.OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM_IMAGE,
    `localhost/${cluster.name}/repository-platform@sha256:${"c".repeat(64)}`,
  );
  assert.equal(state.env.OPENAI_API_KEY, undefined);

  const file = commands.prepareFile("tests/integration/repository-credentials-platform.test.mjs");
  assert.equal(file.status, 0, file.stderr);
  const migrated = JSON.parse(await readFile(commands.statePath, "utf8"));
  const database = migrated.resources.find(({ kind }) => kind === "postgres-database");
  assert.match(database.name, /^openclaw_k8s_/);
  assert.equal(database.status, "ready");
  const calls = await commands.commands();
  assert.ok(calls.some(({ command, args }) => command === "corepack" && args[1] === "db:migrate"));
  const builds = calls.filter(({ command, args }) => command === "docker" && args[0] === "build");
  assert.equal(builds.length, 2);
  for (const { args } of builds) {
    assert.equal(args[args.indexOf("--builder") + 1], "default");
    assert.ok(args.includes("--load"));
  }
  assert.ok(
    builds[1].args.includes(`RUNTIME_IMAGE=${builds[0].args[builds[0].args.indexOf("-t") + 1]}`),
  );
  const cleaned = commands.cleanup();
  assert.equal(cleaned.status, 0, cleaned.stderr);
  await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
});

test("repository platform preparation refuses a public relay gateway before building images", async (t) => {
  const commands = await fixtureImageCommands(
    t,
    "public-gateway",
    "repository-credentials-platform",
  );
  const prepared = commands.prepare();
  assert.equal(prepared.status, 1);
  assert.match(prepared.stderr, /private IPv4 Docker host gateway/);
  assert.equal(
    (await commands.commands()).some(({ args }) => args[0] === "build"),
    false,
  );
  const cleaned = commands.cleanup();
  assert.equal(cleaned.status, 0, cleaned.stderr);
});

test("installed repository preparation requires explicit authorization and protected inputs before side effects", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "installed-state.json");
  const configPath = join(root, "app.json");
  const keyPath = join(root, "app.pem");
  await writeFile(configPath, "{}", { mode: 0o600 });
  await writeFile(keyPath, "test-only key", { mode: 0o600 });
  const env = {
    OPENAI_API_KEY: "test-only-model-key",
    OCC_TEST_OPENAI_MODEL: "test-model",
    NODE_BASE_IMAGE: `docker.io/library/node:24-bookworm@sha256:${digest}`,
    OCC_TEST_REPOSITORY_CREDENTIALS_AUTHORIZED: "0",
    OCC_TEST_REPOSITORY_CREDENTIALS_REPOSITORY: "fixture/repository",
    OCC_TEST_REPOSITORY_CREDENTIALS_APP_CONFIG_FILE: configPath,
    OCC_TEST_REPOSITORY_CREDENTIALS_APP_KEY_FILE: keyPath,
    OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE: immutableImage,
    OCC_TEST_REPOSITORY_CREDENTIALS_UPSTREAM_CIDRS: "203.0.113.1/32",
    OCC_TEST_PRODUCTION_POSTGRES_IMAGE: immutableImage,
    OCC_TEST_PRODUCTION_NODE_IMAGE: immutableImage,
  };
  const args = ["--lane", "repository-credentials-installed", "--state", statePath];
  const unauthorized = runPrepare(args, env);
  assert.equal(unauthorized.status, 1);
  assert.match(unauthorized.stderr, /explicit write and cleanup authorization/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });

  await chmod(keyPath, 0o644);
  const unprotected = runPrepare(args, { ...env, OCC_TEST_REPOSITORY_CREDENTIALS_AUTHORIZED: "1" });
  assert.equal(unprotected.status, 1);
  assert.match(unprotected.stderr, /must have mode 0600/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });

  await chmod(keyPath, 0o600);
  const linkedKey = join(root, "linked-key.pem");
  await symlink(keyPath, linkedKey);
  const linked = runPrepare(args, {
    ...env,
    OCC_TEST_REPOSITORY_CREDENTIALS_AUTHORIZED: "1",
    OCC_TEST_REPOSITORY_CREDENTIALS_APP_KEY_FILE: linkedKey,
  });
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /bounded regular private file/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });

  const invalidScope = runPrepare(args, {
    ...env,
    OCC_TEST_REPOSITORY_CREDENTIALS_AUTHORIZED: "1",
    OCC_TEST_REPOSITORY_CREDENTIALS_UPSTREAM_CIDRS: "10.0.0.1/32",
  });
  assert.equal(invalidScope.status, 1);
  assert.match(invalidScope.stderr, /approved public IPv4/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
});

test("ordinary CI groups require platform proof and exclude installed live repository writes", async () => {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "scripts/ci/test-suites.json"), "utf8"),
  );
  for (const name of ["ci", "full"]) {
    assert.ok(manifest.groups[name].includes("repository-credentials-platform"));
    assert.ok(!manifest.groups[name].includes("repository-credentials-installed"));
    for (const lane of manifest.groups[name]) {
      assert.notEqual(manifest.lanes[lane].env?.OCC_TEST_REPOSITORY_CREDENTIALS_REAL, "1");
    }
  }
});

const runtimeDefaultBaseline = Object.freeze({
  architectures: ["SCMP_ARCH_X86_64"],
  defaultAction: "SCMP_ACT_ERRNO",
  syscalls: [
    { names: ["read"], action: "SCMP_ACT_ALLOW" },
    { names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38 },
  ],
});

test("codex seccomp profile derivation preserves the RuntimeDefault baseline and adds only reviewed bwrap rules", () => {
  const profile = deriveCodexBwrapProfile(runtimeDefaultBaseline);
  const added = profile.syscalls.slice(runtimeDefaultBaseline.syscalls.length);

  assert.deepEqual(profile.architectures, runtimeDefaultBaseline.architectures);
  assert.deepEqual(profile.syscalls.slice(0, runtimeDefaultBaseline.syscalls.length), [
    ...runtimeDefaultBaseline.syscalls,
  ]);
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  assert.equal(added.length, 78);
  assert.deepEqual(added, codexBwrapAdditionalSyscalls());
  assert.deepEqual(
    added.filter((rule) => rule.names.includes("unshare")),
    [
      {
        names: ["unshare"],
        action: "SCMP_ACT_ALLOW",
        args: [{ index: 0, op: "SCMP_CMP_EQ", value: 0x10000000 }],
      },
    ],
  );
  assert.deepEqual(
    added.filter((rule) => rule.names.includes("pivot_root")),
    [{ names: ["pivot_root"], action: "SCMP_ACT_ALLOW" }],
  );
  assert.deepEqual(
    added.filter((rule) => rule.names.includes("umount2")),
    [
      {
        names: ["umount2"],
        action: "SCMP_ACT_ALLOW",
        args: [{ index: 1, op: "SCMP_CMP_EQ", value: 2 }],
      },
    ],
  );
  assert.equal(
    added.some((rule) => rule.names.includes("clone3")),
    false,
    "clone3 must remain governed by the RuntimeDefault ENOSYS rule",
  );
});

test("codex seccomp profile derivation rejects non-denying or malformed baselines", () => {
  assert.throws(
    () =>
      deriveCodexBwrapProfile({
        ...runtimeDefaultBaseline,
        defaultAction: "SCMP_ACT_ALLOW",
      }),
    /default-deny/,
  );
  assert.throws(
    () =>
      deriveCodexBwrapProfile({
        ...runtimeDefaultBaseline,
        syscalls: [{ names: ["read"], action: "SCMP_ACT_ALLOW" }],
      }),
    /clone3 ENOSYS/,
  );
});

test("Kubernetes test helper passes an explicit Codex localhost seccomp profile into runtime config", () => {
  const profile = "openclaw/codex-bwrap.json";
  const configuration = createKubernetesInstallationConfiguration({
    authentication: { mode: "inCluster" },
    platformNamespace: "openclaw-platform",
    gatewayImage: immutableImage,
    codexImage: immutableImage,
    cluster: "k3d-openclaw-ci",
    codexSeccompProfile: profile,
  });

  assert.equal(configuration.drivers.compute.configuration.runtime.codexSeccompProfile, profile);
});

test("codex seccomp preparation fails closed for unverified Codex versions and foreign clusters", async () => {
  const execFile = async () => {
    throw new Error("execFile should not run before validation fails");
  };
  const cluster = {
    name: "openclaw-k8s-test",
    directory: "/tmp/openclaw-k8s-test-abcdef",
    kubeconfig: "/tmp/openclaw-k8s-test-abcdef/kubeconfig",
    context: "k3d-openclaw-k8s-test",
  };

  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster,
        image: immutableImage,
        execFile,
        codexVersion: "0.153.0",
      }),
    /reviewed Codex versions: 0\.152\.1, 0\.154\.0, 0\.156\.0/,
  );
  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster: { ...cluster, name: "shared-cluster", context: "shared-cluster" },
        image: immutableImage,
        execFile,
      }),
    /run-owned openclaw-k8s k3d cluster/,
  );
  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster,
        image: immutableImage,
        profileName: "openclaw\\codex-bwrap.json",
        execFile,
      }),
    /POSIX path separators/,
  );
  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster: {
          ...cluster,
          directory: "relative-openclaw-k8s-test",
          kubeconfig: "/tmp/openclaw-k8s-test-abcdef/kubeconfig",
        },
        image: immutableImage,
        execFile,
      }),
    /cluster\.directory must be absolute/,
  );
});

test("codex seccomp preparation requires a namespace/seccomp RuntimeDefault denial before node writes", async (t) => {
  const root = await fixture(t);
  const clusterDirectory = join(root, "openclaw-k8s-test-owned");
  await mkdir(clusterDirectory);
  const cluster = {
    name: "openclaw-k8s-test",
    directory: clusterDirectory,
    kubeconfig: join(clusterDirectory, "kubeconfig"),
    context: "k3d-openclaw-k8s-test",
  };
  const dockerCalls = [];
  const execFileForRuntimeDefaultFailure = (failure) => async (command, args) => {
    if (command === "kubectl") {
      if (args.includes("create") && args.includes("namespace")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("delete") && args.includes("namespace")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("apply")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("nodes")) {
        return {
          stdout: JSON.stringify({
            items: [{ metadata: { name: "k3d-openclaw-k8s-test-server-0" } }],
          }),
          stderr: "",
        };
      }
      if (args.includes("pod")) {
        return {
          stdout: JSON.stringify({
            metadata: { name: "runtime-default-probe" },
            status: {
              containerStatuses: [
                {
                  name: "probe",
                  ready: true,
                  containerID: "containerd://runtime-default-container",
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("exec")) {
        throw failure(command, args);
      }
    }
    if (command === "docker") {
      dockerCalls.push(args);
      throw new Error("docker should not be reached");
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster,
        image: immutableImage,
        // The current runtime must still reject unrelated setup failures before node writes.
        codexVersion: "0.156.0",
        execFile: execFileForRuntimeDefaultFailure((command, args) => {
          const commandText = `${command} ${args.join(" ")}`;
          assert.match(commandText, /--namespace/);
          assert.match(commandText, /codex-seccomp-ok/);
          const error = new Error(`${commandText} failed: unrelated setup failure`);
          error.stderr = "unrelated setup failure";
          error.stdout = "";
          error.exitCode = 1;
          error.timedOut = false;
          return error;
        }),
      }),
    /RuntimeDefault Codex sandbox denial must mention/,
  );
  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster,
        image: immutableImage,
        execFile: execFileForRuntimeDefaultFailure((command, args) => {
          const error = new Error(`${command} ${args.join(" ")} timed out after 195000ms`);
          error.stderr = "operation not permitted";
          error.stdout = "";
          error.timedOut = true;
          return error;
        }),
      }),
    /timed out after 195000ms/,
  );
  await assert.rejects(
    () =>
      prepareCodexSeccompProfile({
        cluster,
        image: immutableImage,
        execFile: execFileForRuntimeDefaultFailure((command, args) => {
          const error = new Error(`${command} ${args.join(" ")} failed: version mismatch`);
          error.stderr = "Codex version mismatch: expected 0.156.0, got 0.152.1";
          error.stdout = "";
          error.exitCode = 64;
          error.timedOut = false;
          return error;
        }),
      }),
    /version mismatch/,
  );
  assert.deepEqual(dockerCalls, []);
});

test("prepareLane fails closed instead of overwriting an existing CI state file", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "state.json");
  const state = {
    version: 1,
    repositoryRoot,
    lane: "postgres",
    prefix: "openclaw-ci-local-existing-state",
    statePath,
    resources: [
      {
        id: "resource-1",
        kind: "compose-postgres",
        owner: "openclaw-ci-local-existing-state",
        name: "openclaw_ci_pg_existing_state_abcdef123456",
        composeFile: join(repositoryRoot, "compose.postgres.yaml"),
        port: 51234,
      },
    ],
  };
  await writeState(statePath, state);

  const result = runPrepare(["--lane", "helper-timeout", "--state", statePath]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /CI state already exists/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("prepareLane preserves an explicit logging Collector Node image over its default", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "logging-state.json");
  const githubEnv = join(root, "github.env");
  const customNodeImage =
    "docker.io/library/node:24-bookworm@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  const result = runPrepare(
    ["--lane", "logging-collector", "--state", statePath, "--github-env", githubEnv],
    {
      OCC_TEST_LOGGING_NODE_IMAGE: customNodeImage,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const exported = await readFile(githubEnv, "utf8");
  assert.match(exported, /OCC_TEST_LOGGING_COLLECTOR=1/);
  assert.match(exported, new RegExp(`OCC_TEST_LOGGING_NODE_IMAGE=${customNodeImage}`));
});

test("prepareFile applies the images packaging Node base default without hiding invalid overrides", async (t) => {
  const root = await fixture(t);
  const statePath = join(root, "missing-state.json");
  const file = "tests/integration/runtime-image-startup.test.mjs";
  const customNodeBaseImage =
    "docker.io/library/node:24-bookworm@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

  const defaulted = runPrepare(
    ["--lane", "images-packaging", "--file", file, "--state", statePath],
    {
      NODE_BASE_IMAGE: "",
    },
  );
  assert.equal(defaulted.status, 1);
  assert.match(defaulted.stderr, /requires a prior prepareLane/);

  const explicit = runPrepare(
    ["--lane", "images-packaging", "--file", file, "--state", statePath],
    {
      NODE_BASE_IMAGE: customNodeBaseImage,
    },
  );
  assert.equal(explicit.status, 1);
  assert.match(explicit.stderr, /requires a prior prepareLane/);

  const invalid = runPrepare(["--lane", "images-packaging", "--file", file, "--state", statePath], {
    NODE_BASE_IMAGE: "docker.io/library/node:24-bookworm",
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /NODE_BASE_IMAGE must be an immutable/);
});

test("provider-account preparation accepts absent image inputs before prepared state exists", async (t) => {
  const root = await fixture(t);
  const adminKeyPath = join(root, "chatgpt-admin.key");
  const statePath = join(root, "missing-state.json");
  await writeFile(adminKeyPath, "admin key\n", { mode: 0o600 });
  await chmod(adminKeyPath, 0o600);

  const result = runPrepare(
    [
      "--lane",
      "provider-account",
      "--file",
      "tests/integration/service-account-driver-real.test.mjs",
      "--state",
      statePath,
    ],
    {
      OCC_TEST_OPENAI_MODEL: "gpt-test",
      OCC_TEST_CHATGPT_WORKSPACE_ID: "workspace-test",
      OCC_TEST_CHATGPT_ADMIN_KEY_PATH: adminKeyPath,
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: "",
      OCC_TEST_KUBERNETES_AGENT_IMAGE: "",
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a prior prepareLane/);
  assert.doesNotMatch(result.stderr, /OCC_TEST_KUBERNETES_.*IMAGE/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
});

test("prepareLane rejects mutable Kubernetes image inputs before creating state", async (t) => {
  const root = await fixture(t);
  const adminKeyPath = join(root, "admin.key");
  await writeFile(adminKeyPath, "admin key\n", { mode: 0o600 });
  await chmod(adminKeyPath, 0o600);

  const optionalKubernetesImages = {
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE: "",
    OCC_TEST_KUBERNETES_AGENT_IMAGE: "",
    OCC_TEST_KUBERNETES_RUNTIME_IMAGE: "",
    OCC_TEST_KUBERNETES_CODEX_IMAGE: "",
  };
  const baseModelEnv = {
    OPENAI_API_KEY: "test-openai-key",
    OCC_TEST_OPENAI_MODEL: "gpt-test",
  };
  const k3dImages = {
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE: immutableImage,
    OCC_TEST_KUBERNETES_AGENT_IMAGE: immutableImage,
  };
  const cases = [
    {
      lane: "k3d-model",
      envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
      env: {
        ...baseModelEnv,
        NODE_BASE_IMAGE: nodeBaseImage,
        ...optionalKubernetesImages,
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
      },
    },
    {
      lane: "k3d-otel",
      envName: "OCC_TEST_KUBERNETES_AGENT_IMAGE",
      env: {
        ...baseModelEnv,
        NODE_BASE_IMAGE: nodeBaseImage,
        ...optionalKubernetesImages,
        OCC_TEST_KUBERNETES_AGENT_IMAGE: mutableImage,
      },
    },
    {
      lane: "gateway-routing",
      envName: "OCC_TEST_KUBERNETES_AGENT_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        NODE_BASE_IMAGE: nodeBaseImage,
        OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: immutableImage,
        OCC_TEST_KUBERNETES_AGENT_IMAGE: mutableImage,
      },
    },
    {
      lane: "slack",
      envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
      env: {
        ...baseModelEnv,
        NODE_BASE_IMAGE: nodeBaseImage,
        ...k3dImages,
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
        OCC_TEST_SLACK_PROXY_URL: "http://127.0.0.1:3000",
        OCC_TEST_SLACK_CHANNEL_ID: "C0123456789",
        OCC_TEST_SLACK_SENDER_BOT_TOKEN: "xoxb-sender",
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
      },
    },
    {
      lane: "provider-account",
      envName: "OCC_TEST_KUBERNETES_AGENT_IMAGE",
      env: {
        ...k3dImages,
        OCC_TEST_KUBERNETES_AGENT_IMAGE: mutableImage,
        OCC_TEST_OPENAI_MODEL: "gpt-test",
        OCC_TEST_CHATGPT_WORKSPACE_ID: "workspace-test",
        OCC_TEST_CHATGPT_ADMIN_KEY_PATH: adminKeyPath,
      },
    },
    {
      lane: "openshell",
      envName: "OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SANDBOX_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: mutableImage,
        OCC_TEST_OPENSHELL_HELM: "helm",
        OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
        OCC_TEST_OPENSHELL_RUNTIME_CLASS: "runc",
      },
    },
    {
      lane: "openshell",
      envName: "OCC_TEST_OPENSHELL_SANDBOX_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SANDBOX_IMAGE: mutableImage,
        OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_HELM: "helm",
        OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
        OCC_TEST_OPENSHELL_RUNTIME_CLASS: "runc",
      },
    },
    {
      lane: "openshell",
      envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
      env: {
        ...baseModelEnv,
        ...k3dImages,
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
        OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SANDBOX_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_HELM: "helm",
        OCC_TEST_OPENSHELL_HELM_CHART: "openshell-chart",
        OCC_TEST_OPENSHELL_RUNTIME_CLASS: "runc",
      },
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const statePath = join(root, `state-${index}.json`);
    const result = runPrepare(["--lane", testCase.lane, "--state", statePath], testCase.env);

    assert.equal(result.status, 1, `${testCase.lane} unexpectedly passed`);
    assert.match(result.stderr, new RegExp(`${testCase.envName} must be an immutable`));
    await assert.rejects(() => stat(statePath), { code: "ENOENT" });
  }
});
