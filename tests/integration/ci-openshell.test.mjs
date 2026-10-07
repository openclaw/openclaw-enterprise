import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  k3sImage,
  kubectlVersion,
  prepareOpenShell,
  prepareOpenShellClusterBootstrap,
  selectKubectlAsset,
} from "../../scripts/ci/openshell.mjs";
import {
  createOpenShellInstallationConfiguration,
  createOpenShellServiceLoopbackLookup,
  openShellChartImageValues,
  openShellGatewayNetworkPolicies,
} from "../helpers/openshell-kubernetes-real.mjs";

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

test("kubectl asset selection supports the pinned OpenShell CI host platforms", () => {
  assert.equal(selectKubectlAsset("darwin", "arm64").name, "kubectl-darwin-arm64");
  assert.throws(() => selectKubectlAsset("darwin", "x64"), /no pinned kubectl/);
});

test("OpenShell Helm chart image values use the v0.1.3-pre.2 registry and digest contract", () => {
  const digest = "@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  assert.deepEqual(
    openShellChartImageValues("gateway.image", `localhost/example/gateway:local${digest}`),
    [
      "--set-string=gateway.image.registry=localhost",
      "--set-string=gateway.image.repository=example/gateway",
      `--set-string=gateway.image.digest=${digest.slice(1)}`,
    ],
  );
  assert.deepEqual(
    openShellChartImageValues("supervisor.image", `localhost/example/supervisor${digest}`),
    [
      "--set-string=supervisor.image.registry=localhost",
      "--set-string=supervisor.image.repository=example/supervisor",
      `--set-string=supervisor.image.digest=${digest.slice(1)}`,
    ],
  );
  assert.deepEqual(
    openShellChartImageValues("sandboxRuntime.image", `localhost:5000/example/sandbox${digest}`),
    [
      "--set-string=sandboxRuntime.image.registry=localhost:5000",
      "--set-string=sandboxRuntime.image.repository=example/sandbox",
      `--set-string=sandboxRuntime.image.digest=${digest.slice(1)}`,
    ],
  );
  assert.throws(
    () => openShellChartImageValues("gateway.image", "localhost/example/gateway:local"),
    /immutable OpenShell image digest/,
  );
});

test("OpenShell host probes retain the exposed hostname while connecting to loopback", async (t) => {
  const serviceHostname = "default--sb-review.openshell.localhost";
  let observedHost;
  // The real integration forwards the OpenShell gateway only to loopback, while routing still
  // depends on the hostname returned by CreateSandbox.
  const server = createServer((incoming, response) => {
    observedHost = incoming.headers.host;
    response.end("routed");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://${serviceHostname}:${address.port}/health`;
  const response = await new Promise((resolve, reject) => {
    const probe = request(serviceUrl, {
      lookup: createOpenShellServiceLoopbackLookup(serviceHostname),
    });
    probe.on("response", resolve);
    probe.on("error", reject);
    probe.end();
  });
  const body = [];
  for await (const chunk of response) {
    body.push(chunk);
  }

  assert.equal(response.statusCode, 200);
  assert.equal(Buffer.concat(body).toString("utf8"), "routed");
  assert.equal(observedHost, `${serviceHostname}:${address.port}`);
});

test("OpenShell fixture networking admits the supervisor callback without granting tenant Pods", () => {
  const configuration = createOpenShellInstallationConfiguration({
    authentication: {},
    platformNamespace: "openclaw-system",
    gatewayImage: "gateway-fixture",
    codexImage: "codex-fixture",
    cluster: { name: "fixture" },
  });
  const networkPolicyResources =
    configuration.drivers.sandbox.configuration.gateway.networkPolicyResources;
  // Compute owns Harness DNS; the supervisor's egress comes from OpenShell's own policy.
  assert.deepEqual(networkPolicyResources, []);
  const apiPeers = [{ ipBlock: { cidr: "192.0.2.10/32" } }];
  const policies = [
    ...openShellGatewayNetworkPolicies("tenant-fixture", apiPeers).items,
    ...networkPolicyResources,
  ];
  for (const policy of policies) {
    assert.notDeepEqual(policy.spec.podSelector, {}, `${policy.metadata.name} selects every Pod`);
  }
  const matches = (selector, labels) =>
    selector.matchLabels !== undefined &&
    Object.entries(selector.matchLabels).every(([key, value]) => labels[key] === value);
  // OpenShell v0.1.3-pre.2 supervisor Pod labels (sandbox_runtime.rs; internal/occdev/kubernetes.go).
  const supervisor = {
    "openshell.ai/managed-by": "openshell",
    "openshell.ai/boundary-role": "supervisor",
  };
  const callbacks = policies.filter((policy) => matches(policy.spec.podSelector, supervisor));
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].metadata.name, "allow-openshell-sandbox-callback");
  assert.deepEqual(callbacks[0].spec.policyTypes, ["Egress"]);
  assert.deepEqual(callbacks[0].spec.egress[0].ports, [{ protocol: "TCP", port: 8080 }]);
  const gatewayLabels = callbacks[0].spec.egress[0].to[0].podSelector.matchLabels;
  const gatewayPolicies = policies.filter((policy) =>
    matches(policy.spec.podSelector, gatewayLabels),
  );
  assert.equal(gatewayPolicies.length, 2);
  const controlPlane = gatewayPolicies.find((policy) => policy.spec.egress !== undefined);
  assert.deepEqual(
    controlPlane.spec.egress.map((rule) => rule.ports),
    [
      [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
      [{ protocol: "TCP", port: 443 }],
      [{ protocol: "TCP", port: 6443 }],
    ],
  );
  assert.deepEqual(controlPlane.spec.egress[1].to, apiPeers);
  assert.deepEqual(controlPlane.spec.egress[2].to, apiPeers);
  const callbackIngress = gatewayPolicies.find((policy) => policy.spec.ingress !== undefined);
  assert.equal(callbackIngress.metadata.name, "allow-openshell-gateway-callback");
  assert.deepEqual(callbackIngress.spec.ingress[0].ports, [
    { protocol: "TCP", port: 8080 },
    { protocol: "TCP", port: 8081 },
  ]);
  const callers = callbackIngress.spec.ingress[0].from;
  assert.equal(callers.length, 1);
  assert.equal(callers[0].namespaceSelector, undefined);
  assert.equal(matches(callers[0].podSelector, supervisor), true);

  // The Harness workload (any profile) is not the gateway caller, and no additive fixture policy
  // may select an openclaw Pod, classified or not.
  for (const profile of [
    undefined,
    "",
    "unknown-profile",
    "broad-egress-v1",
    "provider-fenced-v1",
  ]) {
    const agent = {
      "openclaw.dev/workload-role": "agent",
      ...(profile === undefined ? {} : { "openclaw.dev/network-profile": profile }),
    };
    assert.equal(matches(callers[0].podSelector, agent), false);
    assert.equal(
      policies.some((policy) => matches(policy.spec.podSelector, agent)),
      false,
    );
  }
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
