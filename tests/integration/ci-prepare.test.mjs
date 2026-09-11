import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  codexBwrapAdditionalSyscalls,
  deriveCodexBwrapProfile,
  prepareCodexSeccompProfile,
} from "../../scripts/ci/codex-seccomp.mjs";
import { resolveGatewayPublisherImage } from "../helpers/envoy-workspace-gateway.mjs";
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

async function fixtureImageCommands(t, scenario) {
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
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const equals = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
const configId = "sha256:" + "b".repeat(64);
const manifestDigest = "sha256:" + "c".repeat(64);
appendFileSync(join(root, "commands.jsonl"), JSON.stringify({
  command, args, envPublished: existsSync(join(root, "github.env")),
}) + "\n");
function finish(stdout = "") {
  writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write(stdout);
  process.exit(0);
}

if (command === "docker") {
  if (equals(args, ["version", "--format", "{{.Server.Version}}"])) finish("29.4.0\n");
  if (args[0] === "compose" && args[1] === "-f" && args[3] === "-p") {
    assert.match(args[4], /^openclaw_ci_pg_/);
    if (equals(args.slice(5), ["up", "-d", "--wait"])) finish();
    if (equals(args.slice(5), ["down", "--volumes", "--remove-orphans"])) finish();
  }
  if (equals(args.slice(0, 3), ["build", "--pull=false", "-t"]) && args.length === 5) {
    assert.equal(args[3], "localhost/" + state.cluster + "/fixture:local");
    state.tag = args[3];
    finish();
  }
  if (equals(args, ["image", "inspect", state.tag])) finish("[]\n");
  if (equals(args, ["image", "inspect", "--format", "{{.Id}}", state.tag])) finish(configId + "\n");
  if (equals(args, ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", state.tag])) finish("linux/amd64\n");
  if (equals(args.slice(0, 5), ["image", "save", "--platform", "linux/amd64", "--output"]) &&
      args.length === 7 && args[6] === state.tag) {
    state.archive = args[5];
    writeFileSync(state.archive, "synthetic image archive\n");
    finish();
  }
  if (equals(args, ["image", "rm", "-f", state.tag])) finish();
  if (args[0] === "exec" && args[1] === "k3d-" + state.cluster + "-server-0") {
    const ctr = ["ctr", "-n", "k8s.io", "images"];
    if (equals(args.slice(2), [...ctr, "list"])) {
      const references = [state.imported && state.tag, state.alias].filter(Boolean);
      finish("REF TYPE DIGEST SIZE PLATFORMS LABELS\n" + references.map((ref) =>
        ref + " application/vnd.oci.image.manifest.v1+json " + manifestDigest + " 1 linux/amd64 -\n",
      ).join(""));
    }
    if (equals(args.slice(2, 8), [...ctr, "tag", state.tag]) && args.length === 9) {
      if (scenario !== "missing-alias") state.alias = args[8];
      finish();
    }
    if (equals(args.slice(2, 7), [...ctr, "rm"]) && args.length === 8 &&
        [state.tag, state.alias].includes(args[7])) finish();
    if (equals(args.slice(2), ["crictl", "inspecti", state.alias]) && state.alias) {
      if (scenario === "missing-cri") {
        process.stderr.write("synthetic CRI image not found\n");
        process.exit(19);
      }
      finish(JSON.stringify({ status: { id: configId, repoDigests: [state.alias] } }));
    }
  }
}
if (command === "k3d") {
  if (equals(args, ["version"])) finish("k3d version v5.8.3\n");
  if (equals(args.slice(0, 2), ["cluster", "create"]) && args.length === 11) {
    assert.match(args[2], /^openclaw-k8s-/);
    assert.deepEqual(args.slice(3, 8), ["--servers", "1", "--agents", "0", "--api-port"]);
    assert.match(args[8], /^127\.0\.0\.1:\d+$/);
    assert.deepEqual(args.slice(9), ["--kubeconfig-update-default=false", "--kubeconfig-switch-context=false"]);
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
  }
}
throw new Error("Unexpected external command: " + command + " " + JSON.stringify(args));
`}`;
  for (const command of ["docker", "k3d", "kubectl"]) {
    await writeFile(join(bin, `${command}.mjs`), commandSource, { mode: 0o700 });
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
    OCC_DOCKER_BIN: join(bin, "docker.mjs"),
    OPENCLAW_CI_K3D_BIN: join(bin, "k3d.mjs"),
    OCC_KUBECTL_BIN: join(bin, "kubectl.mjs"),
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
      run("prepare.mjs", [
        "--lane",
        "k3d-fixture-configuration",
        "--state",
        statePath,
        "--github-env",
        githubEnv,
      ]),
    cleanup: () => run("cleanup.mjs", ["--state", statePath]),
    commands: async () =>
      (await readFile(join(root, "commands.jsonl"), "utf8")).trim().split("\n").map(JSON.parse),
  };
}

for (const { scenario, error } of [
  { scenario: "success" },
  { scenario: "missing-tag", error: /Unable to find imported OCI manifest digest/ },
  {
    scenario: "missing-alias",
    error: /Unable to find imported OCC_TEST_KUBERNETES_IMAGE reference/,
  },
  { scenario: "missing-cri", error: /synthetic CRI image not found/ },
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
    const localImage = state.resources.find((resource) => resource.kind === "image-tag");
    const importedImage = state.resources.find((resource) => resource.kind === "k3d-image");
    assert.equal(localImage.status, "ready");
    assert.equal(importedImage.status, error ? "planned" : "ready");
    assert.notEqual(localImage.id, importedImage.id);
    assert.equal(importedImage.sourceImage, localImage.name);
    assert.equal(importedImage.cluster, cluster.name);
    assert.equal(importedImage.hostImageId, `sha256:${"b".repeat(64)}`);
    for (const resource of state.resources) assert.equal(resource.owner, state.prefix);

    const preparation = await commands.commands();
    const save = preparation.find(
      ({ command, args }) => command === "docker" && args[0] === "image" && args[1] === "save",
    );
    assert.ok(save, "registration must export a task-owned archive");
    await assert.rejects(() => stat(save.args[5]), { code: "ENOENT" });
    assert.equal(
      preparation.every(({ envPublished }) => !envPublished),
      true,
    );
    if (!error) {
      const expected = `localhost/${cluster.name}/fixture@sha256:${"c".repeat(64)}`;
      assert.equal(importedImage.reference, expected);
      assert.equal(state.env.OCC_TEST_KUBERNETES_IMAGE, expected);
      assert.ok(
        (await readFile(commands.githubEnv, "utf8"))
          .split("\n")
          .includes(`OCC_TEST_KUBERNETES_IMAGE=${expected}`),
      );
      assert.ok(
        preparation.some(
          ({ command, args }) =>
            command === "docker" && args[2] === "crictl" && args[4] === expected,
        ),
      );
    }

    const cleanup = commands.cleanup();
    assert.equal(cleanup.error, undefined);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    await assert.rejects(() => stat(commands.statePath), { code: "ENOENT" });
    await assert.rejects(() => stat(cluster.directory), { code: "ENOENT" });
    const cleanupCalls = (await commands.commands()).slice(preparation.length);
    const localRemoval = cleanupCalls.findIndex(
      ({ command, args }) => command === "docker" && args[0] === "image" && args[1] === "rm",
    );
    const clusterRemoval = cleanupCalls.findIndex(
      ({ command, args }) => command === "k3d" && args[0] === "cluster" && args[1] === "delete",
    );
    assert.ok(localRemoval > 0, "imported image cleanup must precede local tag cleanup");
    assert.ok(clusterRemoval > localRemoval, "the cluster must outlive image cleanup");
  });
}

const digest = "a".repeat(64);
const immutableImage = `registry.example/openclaw/runtime@sha256:${digest}`;
const mutableImage = "registry.example/openclaw/runtime:latest";
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

test("Envoy host publisher requires the prepared Docker-local gateway image identity", () => {
  const k3dRuntimeReference =
    "localhost/openclaw-k8s-test/occ-test-kubernetes-gateway-image@sha256:" + digest;
  const dockerImageId = `sha256:${"b".repeat(64)}`;

  assert.equal(
    resolveGatewayPublisherImage({
      gatewayImage: k3dRuntimeReference,
      gatewayPublisherImage: dockerImageId,
    }),
    dockerImageId,
  );
  assert.throws(
    () =>
      resolveGatewayPublisherImage({
        gatewayImage: k3dRuntimeReference,
      }),
    /OCC_TEST_KUBERNETES_GATEWAY_DOCKER_IMAGE/,
  );
  assert.throws(
    () =>
      resolveGatewayPublisherImage({
        gatewayImage: k3dRuntimeReference,
        gatewayPublisherImage: k3dRuntimeReference,
      }),
    /immutable Docker image ID/,
  );
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
    /pinned to Codex 0\.152\.1/,
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
      if (args.includes("create") && args.includes("namespace")) return { stdout: "", stderr: "" };
      if (args.includes("delete") && args.includes("namespace")) return { stdout: "", stderr: "" };
      if (args.includes("apply")) return { stdout: "", stderr: "" };
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
      if (args.includes("exec")) throw failure(command, args);
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
          error.stderr = "Codex version mismatch: expected 0.152.1, got 0.153.0";
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
        ...optionalKubernetesImages,
        OCC_TEST_KUBERNETES_GATEWAY_IMAGE: mutableImage,
      },
    },
    {
      lane: "k3d-otel",
      envName: "OCC_TEST_KUBERNETES_AGENT_IMAGE",
      env: {
        ...baseModelEnv,
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
        OCC_TEST_KUBERNETES_AGENT_IMAGE: mutableImage,
      },
    },
    {
      lane: "slack",
      envName: "OCC_TEST_KUBERNETES_GATEWAY_IMAGE",
      env: {
        ...baseModelEnv,
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
        OCC_TEST_OPENSHELL_CLI: "openshell",
        OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
        OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: mutableImage,
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
        OCC_TEST_OPENSHELL_CLI: "openshell",
        OCC_TEST_OPENSHELL_GATEWAY_IMAGE: immutableImage,
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
