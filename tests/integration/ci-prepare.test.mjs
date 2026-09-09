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
    "node:24-bookworm@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
    "node:24-bookworm@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

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
    NODE_BASE_IMAGE: "node:24-bookworm",
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
