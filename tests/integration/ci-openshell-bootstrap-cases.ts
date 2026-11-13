import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  k3sImage,
  kubectlVersion,
  prepareOpenShell,
  prepareOpenShellClusterBootstrap,
} from "../../scripts/ci/openshell.mjs";
import {
  agentSandboxControllerForNodes,
  preloadAgentSandboxController,
  verifyPreloadedAgentSandbox,
} from "../../scripts/ci/agent-sandbox.ts";

type Cluster = { name: string; directory: string; kubeconfig: string; context: string };
type Fixtures = {
  fixture: (context: TestContext, prefix?: string) => Promise<string>;
  ownedCluster: (directory: string, name?: string) => Cluster;
};
type CommandCall = [command: string, args: string[]];

function first<T>(values: readonly T[]): T {
  const value = values[0];
  assert.ok(value !== undefined);
  return value;
}

export function registerOpenShellBootstrapCases({ fixture, ownedCluster }: Fixtures) {
  test("prepareOpenShellClusterBootstrap selects pinned K3s and kubectl with runc", async (t) => {
    const root = await fixture(t, "openshell-cluster-bootstrap-test");
    const calls: CommandCall[] = [];

    async function execFile(command: string, args: string[]) {
      calls.push([command, args]);
      return { stdout: "", stderr: "" };
    }

    const result: unknown = await prepareOpenShellClusterBootstrap({
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
    assert.deepEqual(first(calls)[1], ["version", "--client=true"]);
  });

  test("prepareOpenShell rejects foreign clusters before kubectl, Docker, or image registration", async (t) => {
    const root = await fixture(t, "foreign-openshell-test");
    const calls: CommandCall[] = [];
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
          execFile: async (command: string, args: string[]) => {
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
    const calls: CommandCall[] = [];
    let registerCalls = 0;

    await assert.rejects(
      () =>
        prepareOpenShell({
          cluster: ownedCluster(root, clusterName),
          execFile: async (command: string, args: string[]) => {
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
}

export function registerOpenShellPreparationCases({ fixture, ownedCluster }: Fixtures) {
  test("prepareOpenShell fails before downloads when the RuntimeClass smoke Pod fails", async (t) => {
    const clusterName = "openclaw-k8s-openshell-test";
    const root = await fixture(t, clusterName);
    const calls: CommandCall[] = [];
    let registerCalls = 0;
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
    const calls: CommandCall[] = [];
    let registerCalls = 0;
    const cluster = ownedCluster(root, clusterName);

    async function execFile(command: string, args: string[]) {
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
    const directory = await fixture(t);
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
    const directory = await fixture(t);
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
            assert.ok(
              resource === "nodes" || resource === "pods",
              `unexpected resource ${resource}`,
            );
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
}
