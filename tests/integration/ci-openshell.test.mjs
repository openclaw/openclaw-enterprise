import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  k3sImage,
  kubectlVersion,
  prepareOpenShell,
  prepareOpenShellClusterBootstrap,
  selectCliAsset,
  selectKubectlAsset,
} from "../../scripts/ci/openshell.mjs";
import { openShellChartImageValues } from "../helpers/openshell-kubernetes-real.mjs";

async function fixture(t, prefix = "ci-openshell-test") {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function ownedCluster(root, name = "openclaw-k8s-openshell-test") {
  return {
    name,
    directory: root,
    kubeconfig: join(root, "kubeconfig"),
    context: `k3d-${name}`,
  };
}

test("selectCliAsset rejects unsupported OpenShell host artifacts", () => {
  assert.equal(selectCliAsset("linux", "x64").sha256.length, 64);
  assert.throws(() => selectCliAsset("darwin", "x64"), /no pinned CLI asset/);
});

test("kubectl asset selection supports the pinned OpenShell CI host platforms", () => {
  assert.equal(selectKubectlAsset("darwin", "arm64").name, "kubectl-darwin-arm64");
  assert.throws(() => selectKubectlAsset("darwin", "x64"), /no pinned kubectl/);
});

test("OpenShell Helm chart image values preserve immutable digests in rendered tags", () => {
  const digest = "@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  assert.deepEqual(
    openShellChartImageValues("image", `localhost/example/gateway:local${digest}`, "0.0.113"),
    [
      "--set-string=image.repository=localhost/example/gateway",
      `--set-string=image.tag=local${digest}`,
    ],
  );
  assert.deepEqual(
    openShellChartImageValues(
      "supervisor.image",
      `localhost/example/supervisor${digest}`,
      "0.0.113",
    ),
    [
      "--set-string=supervisor.image.repository=localhost/example/supervisor",
      `--set-string=supervisor.image.tag=0.0.113${digest}`,
    ],
  );
  assert.throws(
    () => openShellChartImageValues("image", "localhost/example/gateway:local", "0.0.113"),
    /immutable OpenShell image digest/,
  );
});

test("prepareOpenShellClusterBootstrap selects pinned K3s and kubectl with runc", async (t) => {
  const root = await fixture(t, "openshell-cluster-bootstrap-test");
  const calls = [];

  async function execFile(command, args) {
    calls.push([command, args]);
    return { stdout: "", stderr: "" };
  }

  const result = await prepareOpenShellClusterBootstrap({
    directory: root,
    execFile,
    hostPlatform: "darwin",
    hostArch: "arm64",
    downloadArtifact: async (url, destination, sha256) => {
      assert.match(url, /kubectl$/);
      assert.equal(sha256.length, 64);
      await writeFile(destination, "fake kubectl", { mode: 0o700 });
    },
  });

  assert.deepEqual(result, {
    k3sImage,
    runtimeClass: "openshell-sandbox",
    runtimeHandler: "runc",
    kubectl: join(root, "bin", `kubectl-darwin-arm64-${kubectlVersion}`),
    kubectlVersion,
  });
  assert.deepEqual(
    calls.map(([command]) =>
      command.endsWith("kubectl-darwin-arm64-v1.36.4") ? "kubectl" : command,
    ),
    ["kubectl"],
  );
  assert.deepEqual(calls[0][1], ["version", "--client=true"]);
});

test("prepareOpenShell rejects foreign clusters before kubectl, Docker, or image registration", async (t) => {
  const root = await fixture(t, "foreign-openshell-test");
  const calls = [];
  let registerCalls = 0;

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster: {
          name: "foreign",
          directory: root,
          kubeconfig: join(root, "kubeconfig"),
          context: "foreign",
        },
        execFile: async (command, args) => {
          calls.push([command, args]);
          return { stdout: "", stderr: "" };
        },
        registerImage: async () => {
          registerCalls += 1;
        },
        env: {},
      }),
    /unowned cluster|cluster\.name must be a Kubernetes DNS label/,
  );

  assert.deepEqual(calls, []);
  assert.equal(registerCalls, 0);
});

test("prepareOpenShell rejects mutable OpenShell image overrides before kubectl or Docker", async (t) => {
  const clusterName = "openclaw-k8s-openshell-test";
  const root = await fixture(t, clusterName);
  const calls = [];
  let registerCalls = 0;

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster: ownedCluster(root, clusterName),
        execFile: async (command, args) => {
          calls.push([command, args]);
          return { stdout: "", stderr: "" };
        },
        registerImage: async () => {
          registerCalls += 1;
        },
        env: {
          OCC_TEST_OPENSHELL_GATEWAY_IMAGE: "ghcr.io/nvidia/openshell/gateway:latest",
        },
      }),
    /OCC_TEST_OPENSHELL_GATEWAY_IMAGE must be an immutable image@sha256 reference/,
  );

  assert.deepEqual(calls, []);
  assert.equal(registerCalls, 0);
});

test("prepareOpenShell fails before downloads when the RuntimeClass smoke Pod fails", async (t) => {
  const clusterName = "openclaw-k8s-openshell-test";
  const root = await fixture(t, clusterName);
  const calls = [];
  let registerCalls = 0;
  const cluster = ownedCluster(root, clusterName);
  const agentImage =
    "localhost/openclaw-k8s-openshell-test/agent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  async function execFile(command, args) {
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
          registerCalls += 1;
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

  assert.equal(registerCalls, 0);
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
  const root = await fixture(t, clusterName);
  const calls = [];
  let registerCalls = 0;
  const cluster = ownedCluster(root, clusterName);

  async function execFile(command, args) {
    calls.push([command, args]);
    if (command === "docker" && args[0] === "exec") {
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }

  await assert.rejects(
    () =>
      prepareOpenShell({
        cluster,
        execFile,
        registerImage: async () => {
          registerCalls += 1;
        },
        env: {
          OCC_KUBECTL_BIN: "kubectl",
          OCC_HELM_BIN: "helm",
          OCC_DOCKER_BIN: "docker",
        },
      }),
    /does not advertise that handler/,
  );

  assert.equal(registerCalls, 0);
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
