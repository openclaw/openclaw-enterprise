import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { asRecord } from "../../packages/utils/src/index.ts";
import {
  agentSandboxControllerForNodes,
  preloadAgentSandboxController,
  verifyPreloadedAgentSandbox,
} from "../../scripts/ci/agent-sandbox.ts";
import {
  k3sImage,
  prepareOpenShell,
  prepareOpenShellClusterBootstrap,
  selectKubectlAsset,
  validateOpenShellSelection,
} from "../../scripts/ci/openshell.ts";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { openShellTestDirectory } from "./ci-openshell-fixtures.ts";

type PrepareOptions = Parameters<typeof prepareOpenShell>[0];
type CommandCall = [command: string, args: string[]];

function ownedCluster(
  root: string,
  name = "openclaw-k8s-openshell-test",
): PrepareOptions["cluster"] {
  return {
    name,
    directory: root,
    kubeconfig: join(root, "kubeconfig"),
    context: `k3d-${name}`,
  };
}

test("kubectl asset selection supports the pinned OpenShell CI host platforms", () => {
  assert.equal(selectKubectlAsset("darwin", "arm64").name, "kubectl-darwin-arm64");
  assert.throws(() => selectKubectlAsset("darwin", "x64"), /no pinned kubectl/);
});

test("prepareOpenShellClusterBootstrap selects pinned K3s and kubectl with runc", async (t) => {
  const root = await openShellTestDirectory(t, "openshell-cluster-bootstrap-test");
  const calls: CommandCall[] = [];

  async function execFile(command: string, args: string[]) {
    calls.push([command, args]);
    return { stdout: "", stderr: "" };
  }

  const result = await prepareOpenShellClusterBootstrap({
    directory: root,
    execFile,
    hostPlatform: "darwin",
    hostArch: "arm64",
    downloadArtifact: async (url: string, destination: string, sha256: string) => {
      assert.match(url, /kubectl$/);
      assert.equal(sha256.length, 64);
      await writeFile(destination, "fake kubectl", { mode: 0o700 });
    },
  });

  const kubectlVersion = "v1.36.4";
  const kubectl = join(root, "bin", `kubectl-darwin-arm64-${kubectlVersion}`);
  assert.deepEqual(result, {
    k3sImage,
    runtimeClass: "openshell-sandbox",
    runtimeHandler: "runc",
    kubectl,
    kubectlVersion,
  });
  assert.deepEqual(calls, [[kubectl, ["version", "--client=true"]]]);
});

test("prepareOpenShell rejects foreign clusters before kubectl, Docker, or image registration", async (t) => {
  const root = await openShellTestDirectory(t, "foreign-openshell-test");
  const calls: CommandCall[] = [];

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster: {
          name: "foreign",
          directory: root,
          kubeconfig: join(root, "kubeconfig"),
          context: "foreign",
        },
        execFile: async (command: string, args: string[]) => {
          calls.push([command, args]);
          return { stdout: "", stderr: "" };
        },
        registerImage: async () => {
          assert.fail("OpenShell must refuse before image registration");
        },
        env: {},
      }),
    /unowned cluster|cluster\.name must be a Kubernetes DNS label/,
  );

  assert.deepEqual(calls, []);
});

test("prepareOpenShell rejects mutable OpenShell image overrides before kubectl or Docker", async (t) => {
  const clusterName = "openclaw-k8s-openshell-test";
  const root = await openShellTestDirectory(t, clusterName);
  const calls: CommandCall[] = [];

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster: ownedCluster(root, clusterName),
        execFile: async (command: string, args: string[]) => {
          calls.push([command, args]);
          return { stdout: "", stderr: "" };
        },
        registerImage: async () => {
          assert.fail("OpenShell must refuse before image registration");
        },
        env: {
          OCC_TEST_OPENSHELL_GATEWAY_IMAGE: "ghcr.io/nvidia/openshell/gateway:latest",
        },
      }),
    /OCC_TEST_OPENSHELL_GATEWAY_IMAGE must be an immutable image@sha256 reference/,
  );

  assert.deepEqual(calls, []);
});
const execFileAsync = promisify(execFileCallback);

async function candidateCheckout(t: TestContext, { gatewayAppVersion = "0.0.0" } = {}) {
  const root = await openShellTestDirectory(t, "openshell-candidate");
  const gatewayChart = join(root, "deploy", "helm", "openshell");
  const workspaceChart = join(root, "deploy", "helm", "openshell-workspace");
  for (const [directory, name] of Object.entries({
    [gatewayChart]: "openshell",
    [workspaceChart]: "openshell-workspace",
  })) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "Chart.yaml"),
      `apiVersion: v2\nname: ${name}\nversion: 0.1.6\n${directory === gatewayChart && gatewayAppVersion ? `appVersion: "${gatewayAppVersion}"\n` : ""}`,
    );
    await writeFile(join(directory, "values.yaml"), "replicaCount: 1\n");
  }
  await writeFile(join(root, ".gitignore"), "ignored.yaml\n");
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", root]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", [
    "-C",
    root,
    "-c",
    "user.name=OpenShell fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Candidate chart fixture",
  ]);
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  return {
    root,
    env: {
      OCC_TEST_OPENSHELL_SOURCE_REVISION: stdout.trim(),
      OCC_TEST_OPENSHELL_HELM_CHART: gatewayChart,
      OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART: workspaceChart,
      OCC_TEST_OPENSHELL_GATEWAY_IMAGE: `localhost/candidate/gateway@sha256:${"a".repeat(64)}`,
      OCC_TEST_OPENSHELL_SANDBOX_IMAGE: `localhost/candidate/sandbox@sha256:${"b".repeat(64)}`,
      OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: `localhost/candidate/supervisor@sha256:${"c".repeat(64)}`,
    },
  };
}

test("OpenShell stock selection accepts empty selectors and mirrors of released digests", async (t) => {
  const execFile = t.mock.fn(() => assert.fail("stock selection must not inspect a candidate"));
  for (const env of [
    {},
    {
      OCC_TEST_OPENSHELL_SOURCE_REVISION: "",
      OCC_TEST_OPENSHELL_HELM_CHART: "",
      OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART: "",
      OCC_TEST_OPENSHELL_GATEWAY_IMAGE: "",
      OCC_TEST_OPENSHELL_SANDBOX_IMAGE: "",
      OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE: "",
    },
    {
      OCC_TEST_OPENSHELL_GATEWAY_IMAGE:
        "localhost/mirror/gateway@sha256:d66352a54c680b652e5ddd7d19b9c1189568d18016f360b9b8c64014f13d89c4",
      OCC_TEST_OPENSHELL_SANDBOX_IMAGE:
        "localhost/mirror/sandbox@sha256:f0fe7dbf18d833acb5da99c405231124718f23b524aa8e3c0108e6f37530033b",
      OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE:
        "localhost/mirror/supervisor@sha256:deadeacfdba6d12ca27e538d0002696369d4de5a4fcad075ab503495503af9d1",
    },
  ]) {
    assert.equal(await validateOpenShellSelection(env, execFile), null);
  }
  assert.equal(execFile.mock.callCount(), 0);
});

test("prepareOpenShell rejects incomplete candidate tuples before commands or image registration", async (t) => {
  const { env } = await candidateCheckout(t);
  const root = await openShellTestDirectory(t, "openclaw-k8s-openshell-test");
  const execFile = t.mock.fn(() => assert.fail("incomplete candidates must not run commands"));
  const registerImage = t.mock.fn(() =>
    assert.fail("incomplete candidates must not register images"),
  );
  // Any explicit candidate input commits this run to one complete tuple, never a
  // mixture of candidate images and released charts (or the reverse).
  for (const missing of Object.keys(env)) {
    await assert.rejects(
      prepareOpenShell({
        cluster: ownedCluster(root),
        execFile,
        registerImage,
        env: { ...env, [missing]: "" },
      }),
      /requires a source revision, all three images, and both Helm charts/,
      missing,
    );
  }
  await assert.rejects(
    prepareOpenShell({
      cluster: ownedCluster(root),
      execFile,
      registerImage,
      env: { ...env, OCC_TEST_OPENSHELL_SOURCE_REVISION: "A".repeat(40) },
    }),
    /full lowercase Git commit/,
  );
  assert.equal(execFile.mock.callCount(), 0);
  assert.equal(registerImage.mock.callCount(), 0);
});

test("OpenShell candidate preflight uses verified chart bytes and removes its snapshot", async (t) => {
  const { env } = await candidateCheckout(t);
  const inspected: string[] = [];
  let charts: { gateway: string; directory: string; workspace: string } | undefined;
  const selection = await validateOpenShellSelection(env, async (command, args) => {
    if (command === "git") {
      return execFileAsync(command, args);
    }
    if (command === "helm") {
      assert.deepEqual(args.slice(0, 2), ["show", "chart"]);
      const chart = args[2];
      assert.ok(chart);
      const gateway = await readFile(join(chart, "Chart.yaml"), "utf8");
      const directory = dirname(chart);
      const workspace = await readFile(
        join(directory, "openshell-workspace", "values.yaml"),
        "utf8",
      );
      charts = { gateway, directory, workspace };
      return { stdout: gateway };
    }
    // Docker reports fixture metadata. Git tree and on-disk chart comparisons run for real.
    assert.equal(command, "docker");
    assert.deepEqual(args.slice(0, 2), ["image", "inspect"]);
    if (inspected.length === 0) {
      // The checkout can change after chart validation and before Helm consumes it.
      await writeFile(join(env.OCC_TEST_OPENSHELL_HELM_CHART, "Chart.yaml"), "appVersion: 9.9.9\n");
      await writeFile(
        join(env.OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART, "values.yaml"),
        "replicaCount: 99\n",
      );
    }
    const image = args.at(-1);
    assert.ok(image);
    inspected.push(image);
    return { stdout: `${env.OCC_TEST_OPENSHELL_SOURCE_REVISION}\n` };
  });
  assert.deepEqual(
    new Set(inspected),
    new Set([
      env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE,
      env.OCC_TEST_OPENSHELL_SANDBOX_IMAGE,
      env.OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE,
    ]),
  );
  assert.ok(charts);
  assert.match(charts.gateway, /appVersion: "0\.0\.0"/);
  assert.equal(charts.workspace, "replicaCount: 1\n");
  assert.equal(selection, null, "preflight must not return paths it has removed");
  await assert.rejects(readdir(charts.directory), { code: "ENOENT" });
});

test("OpenShell candidate CLI reports verified JSON and rejects unselected or invalid candidates", async (t) => {
  const { env } = await candidateCheckout(t);
  const root = await openShellTestDirectory(t);
  const temporary = join(root, "tmp");
  await mkdir(temporary);
  const log = join(root, "commands.log");
  // Synthetic Docker metadata and a Helm stand-in; Git and chart filesystem
  // checks are real. No image engine, cluster, or installed behavior is tested.
  const docker = await writeCommand(
    root,
    "docker",
    `
[ "$#" = 5 ] && [ "$1" = image ] && [ "$2" = inspect ] || exit 1
printf '%s\\n' "$OCC_TEST_OPENSHELL_SOURCE_REVISION"
`,
    { log },
  );
  const helm = await writeCommand(
    root,
    "helm",
    `
[ "$#" = 3 ] && [ "$1" = show ] && [ "$2" = chart ] || exit 1
cat "$3/Chart.yaml"
`,
    { log },
  );
  const run = (selection: Partial<typeof env>) => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../../scripts/ci/check-openshell-candidate.ts", import.meta.url))],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          ...Object.fromEntries(Object.keys(env).map((key) => [key, ""])),
          ...selection,
          OCC_DOCKER_BIN: docker,
          OCC_HELM_BIN: helm,
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
        },
      },
    );
    assert.ifError(result.error);
    return result;
  };
  const success = run(env);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stderr, "");
  const receipt = asRecord(JSON.parse(success.stdout));
  assert.ok(receipt);
  assert.deepEqual(receipt, {
    outcome: "verified",
    sourceRevision: env.OCC_TEST_OPENSHELL_SOURCE_REVISION,
    elapsedMs: receipt.elapsedMs,
  });
  assert.ok(
    typeof receipt.elapsedMs === "number" &&
      Number.isInteger(receipt.elapsedMs) &&
      receipt.elapsedMs >= 0,
  );
  const calls = await commandCalls(log);
  assert.equal(calls.length, 4);
  for (const role of ["GATEWAY", "SANDBOX", "SUPERVISOR"] as const) {
    assert.ok(calls.some((call) => call.endsWith(env[`OCC_TEST_OPENSHELL_${role}_IMAGE`])));
  }
  await writeFile(join(env.OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART, "values.yaml"), "changed\n");
  for (const selection of [
    {},
    { OCC_TEST_OPENSHELL_SOURCE_REVISION: env.OCC_TEST_OPENSHELL_SOURCE_REVISION },
    env,
  ]) {
    const rejected = run(selection);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    const failure = asRecord(JSON.parse(rejected.stderr));
    assert.ok(failure);
    assert.equal(failure.outcome, "failed");
    assert.ok(
      typeof failure.elapsedMs === "number" &&
        Number.isInteger(failure.elapsedMs) &&
        failure.elapsedMs >= 0,
    );
    assert.equal(
      failure.message,
      Object.keys(selection).length === 0
        ? "No OpenShell candidate selected. Set all six candidate inputs."
        : "OpenShell candidate verification failed. Check all six inputs and local artifacts.",
    );
  }
  assert.deepEqual(await commandCalls(log), calls, "rejections precede Docker and Helm");
  assert.deepEqual(
    (await readdir(temporary)).filter((name) => name.startsWith("openshell-candidate-check-")),
    [],
    "success and failures remove snapshots",
  );
});

test("prepareOpenShell rejects a verified gateway chart without an application version", async (t) => {
  const { env } = await candidateCheckout(t, { gatewayAppVersion: "" });
  const root = await openShellTestDirectory(t, "openclaw-k8s-openshell-test");
  await assert.rejects(
    prepareOpenShell({
      cluster: ownedCluster(root),
      async execFile(command, args) {
        if (command === "git") {
          return execFileAsync(command, args);
        }
        if (command === "docker") {
          assert.deepEqual(args.slice(0, 2), ["image", "inspect"]);
          return { stdout: `${env.OCC_TEST_OPENSHELL_SOURCE_REVISION}\n` };
        }
        assert.equal(command, "helm");
        assert.deepEqual(args.slice(0, 2), ["show", "chart"]);
        const chart = args[2];
        assert.ok(chart);
        assert.equal(dirname(dirname(chart)), root);
        return { stdout: await readFile(join(chart, "Chart.yaml"), "utf8") };
      },
      registerImage: async () => assert.fail("invalid candidate must not register images"),
      env,
    }),
    /must set a label-safe appVersion/,
  );
  assert.deepEqual(await readdir(root), [], "a failed candidate must leave no partial snapshot");
});

test("prepareOpenShell rejects source, chart, and image mismatches before cluster commands", async (t) => {
  const { root: checkout, env } = await candidateCheckout(t);
  const root = await openShellTestDirectory(t, "openclaw-k8s-openshell-test");
  const registerImage = t.mock.fn(() =>
    assert.fail("mismatched candidates must not register images"),
  );
  let imageRevision = env.OCC_TEST_OPENSHELL_SOURCE_REVISION;
  const execFile: PrepareOptions["execFile"] = async (command, args) => {
    if (command === "git") {
      return execFileAsync(command, args);
    }
    assert.equal(command, "docker", "candidate mismatch must fail before cluster commands");
    assert.deepEqual(args.slice(0, 2), ["image", "inspect"]);
    return { stdout: `${imageRevision}\n` };
  };
  const prepare = (selected = env) =>
    prepareOpenShell({
      cluster: ownedCluster(root),
      execFile,
      registerImage,
      env: selected,
    });
  await assert.rejects(
    prepare({ ...env, OCC_TEST_OPENSHELL_SOURCE_REVISION: "0".repeat(40) }),
    /chart checkout does not match the selected source revision/,
  );

  // Git status can hide modified tracked files and ignored additions; Helm still
  // reads them. Prove validation compares physical chart contents to the commit.
  const values = join(env.OCC_TEST_OPENSHELL_HELM_CHART, "values.yaml");
  await execFileAsync("git", ["-C", checkout, "update-index", "--assume-unchanged", values]);
  await writeFile(values, "replicaCount: 99\n");
  await assert.rejects(prepare(), /chart contents do not match the selected source revision/);
  await writeFile(values, "replicaCount: 1\n");
  // A committed file must remain a regular file with its recorded mode, even
  // when a link points at a file with identical bytes.
  await chmod(values, 0o755);
  await assert.rejects(prepare(), /chart contents do not match the selected source revision/);
  await rm(values);
  await symlink(join(env.OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART, "values.yaml"), values);
  await assert.rejects(prepare(), /chart contents do not match the selected source revision/);
  await rm(values);
  await writeFile(values, "replicaCount: 1\n");
  for (const name of ["extra.yaml", "ignored.yaml"]) {
    const extra = join(env.OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART, name);
    await writeFile(extra, "replicaCount: 99\n");
    await assert.rejects(prepare(), /chart contents do not match the selected source revision/);
    await rm(extra);
  }

  // Git tracks the owner execute bit. An execute bit for others alone must
  // leave this chart file non-executable in Git and reach the image check.
  await chmod(values, 0o645);
  imageRevision = "0".repeat(40);
  await assert.rejects(prepare(), /image revision does not match the selected source revision/);
  assert.equal(registerImage.mock.callCount(), 0);
});

test("prepareOpenShell fails before downloads when the RuntimeClass smoke Pod fails", async (t) => {
  const clusterName = "openclaw-k8s-openshell-test";
  const root = await openShellTestDirectory(t, clusterName);
  const calls: CommandCall[] = [];
  const cluster = ownedCluster(root, clusterName);
  const agentImage =
    "localhost/openclaw-k8s-openshell-test/agent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  async function execFile(command: string, args: string[]) {
    calls.push([command, args]);
    if (command === "docker" && args[0] === "exec") {
      return {
        stdout: "[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'runc']\n",
        stderr: "",
      };
    }
    if (
      command === "kubectl" &&
      args.includes("--dry-run=server") &&
      args.some((arg) => arg.endsWith("openshell-psa-restricted-rejection.yaml"))
    ) {
      throw new Error(
        'Error from server (Forbidden): pods "openshell-psa-violation" is forbidden: violates PodSecurity "restricted:latest": privileged',
      );
    }
    if (command === "kubectl" && args.includes("--for=jsonpath={.status.phase}=Succeeded")) {
      throw new Error("pod reached Failed phase");
    }
    if (command === "kubectl" && args.includes("describe")) {
      return { stdout: "FailedCreatePodSandBox runc unavailable", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster,
        execFile,
        registerImage: async () => {
          assert.fail("OpenShell must refuse before image registration");
        },
        env: {
          OCC_KUBECTL_BIN: "kubectl",
          OCC_HELM_BIN: "helm",
          OCC_DOCKER_BIN: "docker",
          OCC_TEST_KUBERNETES_AGENT_IMAGE: agentImage,
        },
      }),
    /FailedCreatePodSandBox runc unavailable/,
  );

  assert.equal(
    calls.some(([command]) => command === "tar"),
    false,
  );
  assert.equal(
    calls.some(([command, args]) => command === "helm" && args[0] === "pull"),
    false,
  );
  assert.ok(
    calls.some(
      ([command, args]) =>
        command === "kubectl" &&
        args.includes("delete") &&
        args.includes("openshell-runtimeclass-smoke"),
    ),
  );

  const manifest = await readFile(
    join(root, "openshell", "openshell-runtimeclass-smoke.yaml"),
    "utf8",
  );
  assert.match(manifest, /runtimeClassName: openshell-sandbox/);
  assert.match(manifest, new RegExp(`image: "${agentImage}"`));
  assert.match(manifest, /imagePullPolicy: Never/);
});

test("prepareOpenShell fails before downloads when the k3d node lacks the selected handler", async (t) => {
  const clusterName = "openclaw-k8s-openshell-test";
  const root = await openShellTestDirectory(t, clusterName);
  const calls: CommandCall[] = [];
  const cluster = ownedCluster(root, clusterName);

  async function execFile(command: string, args: string[]) {
    calls.push([command, args]);
    return { stdout: "", stderr: "" };
  }

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster,
        execFile,
        registerImage: async () => {
          assert.fail("OpenShell must refuse before image registration");
        },
        env: {
          OCC_KUBECTL_BIN: "kubectl",
          OCC_HELM_BIN: "helm",
          OCC_DOCKER_BIN: "docker",
        },
      }),
    /does not advertise that handler/,
  );

  assert.equal(
    calls.some(([command]) => command === "tar"),
    false,
  );
  assert.equal(
    calls.some(([command, args]) => command === "helm" && args[0] === "pull"),
    false,
  );
  assert.equal(
    calls.some(([command, args]) => command === "docker" && args[0] !== "exec"),
    false,
  );
  assert.deepEqual(
    calls.filter(([command]) => command === "docker").map(([, args]) => args[1]),
    [`k3d-${cluster.name}-server-0`],
  );
  for (const [, args] of calls.filter(([command]) => command === "kubectl")) {
    assert.deepEqual(args.slice(0, 4), [
      "--kubeconfig",
      cluster.kubeconfig,
      "--context",
      cluster.context,
    ]);
  }
});

function first<T>(values: readonly T[]): T {
  const value = values[0];
  assert.ok(value !== undefined);
  return value;
}

function controllerNodes(architecture = "amd64") {
  return {
    items: [
      {
        metadata: { name: "k3d-owned-server-0" },
        status: { nodeInfo: { operatingSystem: "linux", architecture } },
      },
    ],
  };
}

// This exercises manifest preparation and its image-registration boundary, not a cluster.
test("Agent Sandbox preparation uses the imported image and preserves unrelated manifest bytes", async (t) => {
  const directory = await openShellTestDirectory(t);
  const manifest = join(directory, "sandbox.yaml");
  const source = [
    "# upstream namespace",
    "apiVersion: v1",
    "kind: Namespace",
    "metadata:",
    "  name: agent-sandbox-system",
    "---",
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: agent-sandbox-controller",
    "spec:",
    "  template:",
    "    spec:",
    "      containers:",
    "      - name: agent-sandbox-controller",
    "        image: registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2",
    "        args: [--leader-elect=true]",
    "      - name: unrelated",
    "        image: example.invalid/other:v1",
    "---",
    "# schemas and remaining resources stay unchanged",
    "kind: CustomResourceDefinition",
    "",
  ].join("\n");
  await writeFile(manifest, source);
  const imported = `localhost/owned/controller@sha256:${"a".repeat(64)}`;
  const output = await preloadAgentSandboxController(
    manifest,
    controllerNodes(),
    async (image, _description, nativeSelection) => {
      assert.equal(
        image,
        "registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2@sha256:c28ca6f2366160f2470013c4588821cf7ebd21538d62c1016b6afc93583830d6",
      );
      assert.deepEqual(nativeSelection, {
        platform: "linux/amd64",
        configDigest: "sha256:5b6c81129dc7491b3d260940e34ff68323fb6f7f21450d42129be5169e52ab17",
        cacheIndex:
          "registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2@sha256:dbbad861e6c2cc0df1f7ec37dd0e2827b3d2bc051eb45855e01f94e697440403",
      });
      await assert.rejects(readFile(join(directory, "agent-sandbox-local.yaml")), {
        code: "ENOENT",
      });
      return imported;
    },
  );
  const prepared = await readFile(output, "utf8");
  const replacement = `        image: ${imported}\n        imagePullPolicy: Never\n`;
  assert.equal(prepared.split(replacement).length, 2);
  assert.equal(
    prepared.replace(
      replacement,
      "        image: registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2\n",
    ),
    source,
  );
  assert.equal(await readFile(manifest, "utf8"), source);
});

test("Agent Sandbox preparation rejects changed manifests and failed imports before producing deployment input", async (t) => {
  const directory = await openShellTestDirectory(t);
  const manifest = join(directory, "sandbox.yaml");
  const controller =
    "      - name: agent-sandbox-controller\n        image: registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2\n";
  for (const invalid of ["kind: Namespace\n", controller + controller]) {
    await writeFile(manifest, invalid);
    await assert.rejects(
      preloadAgentSandboxController(manifest, controllerNodes(), async () =>
        assert.fail("invalid manifest must not import an image"),
      ),
      /exactly one expected controller image/,
    );
  }
  await writeFile(manifest, controller);
  const failure = new Error("image import failed");
  await assert.rejects(
    preloadAgentSandboxController(manifest, controllerNodes(), async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  await assert.rejects(readFile(join(directory, "agent-sandbox-local.yaml")), { code: "ENOENT" });
});

// The selected native child must follow the node, regardless of the host cache.
test("Agent Sandbox selects the native node platform and rejects unknown or mixed nodes", () => {
  assert.equal(
    agentSandboxControllerForNodes(controllerNodes("arm64")).source,
    "registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2@sha256:7e273b836b1f7e5e33c08c68bcf539959ca2b298cb29153e1fab60fd05851248",
  );
  for (const nodes of [
    controllerNodes("ppc64le"),
    { items: [] },
    { items: [...controllerNodes().items, ...controllerNodes("arm64").items] },
  ]) {
    assert.throws(() => agentSandboxControllerForNodes(nodes), /node platform/);
  }
});

// Fixture observations exercise the verifier, not image transport or a real cluster.
// The retained upstream manifest is the actual v0.5.2 linux/amd64 child.
test("Agent Sandbox installed verification binds readiness and CRI identity to the native release", async () => {
  const manifest = await readFile(
    new URL("../fixtures/agent-sandbox-v0.5.2-amd64-manifest.json.txt", import.meta.url),
    "utf8",
  );
  const source =
    "registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2@sha256:c28ca6f2366160f2470013c4588821cf7ebd21538d62c1016b6afc93583830d6";
  const reference =
    "docker.io/owned/controller@sha256:c28ca6f2366160f2470013c4588821cf7ebd21538d62c1016b6afc93583830d6";
  const config = "sha256:5b6c81129dc7491b3d260940e34ff68323fb6f7f21450d42129be5169e52ab17";
  const observations = {
    nodes: controllerNodes(),
    pods: {
      items: [
        {
          metadata: {
            name: "agent-sandbox-controller-5cdd-7kr6b",
            namespace: "agent-sandbox-system",
          },
          spec: {
            nodeName: "k3d-owned-server-0",
            containers: [
              { name: "agent-sandbox-controller", image: reference, imagePullPolicy: "Never" },
            ],
          },
          status: {
            conditions: [{ type: "Ready", status: "True" }],
            containerStatuses: [
              {
                name: "agent-sandbox-controller",
                ready: true,
                imageID: config,
                state: { running: { startedAt: "2026-11-11T21:00:00Z" } },
              },
            ],
          },
        },
      ],
    },
    content: manifest,
    cri: {
      [reference]: { status: { id: config } },
      [config]: { status: { id: config } },
    },
  };
  type Observations = typeof observations;
  const verify = (data: Observations, overrides: { source?: string } = {}) =>
    verifyPreloadedAgentSandbox({
      source,
      reference,
      kubectl: [],
      engine: "docker",
      ownedNodes: ["k3d-owned-server-0"],
      ...overrides,
      execFile: async (file, args) => {
        if (file === "kubectl" && args[0] === "get") {
          const resource = args[1];
          assert.ok(resource === "nodes" || resource === "pods", `unexpected resource ${resource}`);
          return { stdout: JSON.stringify(data[resource]) };
        }
        if (file === "docker" && args[0] === "exec" && args[2] === "ctr") {
          return { stdout: data.content };
        }
        if (file === "docker" && args[0] === "exec" && args[2] === "crictl") {
          assert.equal(args[3], "inspecti");
          const requestedImage = args[4];
          assert.ok(
            requestedImage === reference || requestedImage === config,
            `unexpected CRI image ${requestedImage}`,
          );
          const image = data.cri[requestedImage];
          return { stdout: JSON.stringify(image) };
        }
        assert.fail(`unexpected verification command ${file} ${args.join(" ")}`);
      },
    });
  await verify(observations);
  const failureCases: [(data: Observations) => void, RegExp][] = [
    [
      (data) => {
        first(first(data.pods.items).spec.containers).image =
          `docker.io/wrong/controller@sha256:${"a".repeat(64)}`;
      },
      /exact imported reference/,
    ],
    [
      (data) => {
        first(first(data.pods.items).spec.containers).imagePullPolicy = "IfNotPresent";
      },
      /exact imported reference/,
    ],
    [
      (data) => {
        first(first(data.pods.items).status.conditions).status = "False";
      },
      /Ready/,
    ],
    [
      (data) => {
        data.cri[reference].status.id = `sha256:${"a".repeat(64)}`;
      },
      /running image/,
    ],
    [
      (data) => {
        // The imported alias is still correct; only the running Pod resolves
        // to the wrong config. Querying the alias twice must not pass.
        data.cri[config].status.id = `sha256:${"a".repeat(64)}`;
      },
      /running image/,
    ],
    [
      (data) => {
        data.content += " ";
      },
      /imported manifest/,
    ],
    [
      (data) => {
        first(data.pods.items).spec.nodeName = "unowned-node";
      },
      /owned node/,
    ],
  ];
  for (const [change, expected] of failureCases) {
    const changed = structuredClone(observations);
    change(changed);
    await assert.rejects(verify(changed), expected);
  }
  await assert.rejects(
    verify(observations, {
      source: agentSandboxControllerForNodes(controllerNodes("arm64")).source,
    }),
    /node platform release/,
  );
});
