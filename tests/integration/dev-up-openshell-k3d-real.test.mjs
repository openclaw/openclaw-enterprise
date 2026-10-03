import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { availablePort } from "../helpers/available-port.mjs";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const occ = join(repository, "bin", "occ");
const devUp = join(repository, "scripts", "dev-up");
const devDown = join(repository, "scripts", "dev-down");
const selected = process.env.OCC_TEST_DEV_UP_OPENSHELL_REAL === "1";
const composeSelected = process.env.OCC_TEST_DEV_UP_OPENSHELL_COMPOSE_REAL === "1";

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function waitForPort(child, port, stderr) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`OpenShell port-forward exited before readiness: ${stderr()}`);
    }
    const connected = await new Promise((resolveConnect) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(250);
      socket.once("connect", () => {
        socket.destroy();
        resolveConnect(true);
      });
      const unavailable = () => {
        socket.destroy();
        resolveConnect(false);
      };
      socket.once("error", unavailable);
      socket.once("timeout", unavailable);
    });
    if (connected) {
      return;
    }
    await delay(100);
  }
  throw new Error(`OpenShell port-forward did not become ready: ${stderr()}`);
}

async function stopPortForward(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function waitForNamespaceReady(environment, apiPort, stateDirectory, namespaceId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await execute(occ, ["namespace", "get", namespaceId, "--output", "json"], {
      cwd: repository,
      env: {
        ...environment,
        OCC_URL: `http://127.0.0.1:${apiPort}`,
        OCC_SERVICE_KEY_FILE: join(stateDirectory, "initial-admin-service-key.json"),
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    const namespace = JSON.parse(result.stdout);
    if (namespace.status === "ready") {
      return namespace;
    }
    if (namespace.status === "failed") {
      throw new Error(`OCC Namespace ${namespaceId} failed reconciliation.`);
    }
    await delay(500);
  }
  throw new Error(`OCC Namespace ${namespaceId} did not become ready.`);
}

async function runGatewayProbe({
  directory,
  kubectl,
  environment,
  namespace,
  name,
  image,
  gatewayIP,
  labels,
}) {
  const manifestPath = join(directory, `${name}.json`);
  const connect = [
    "const net=require('node:net')",
    "const socket=net.connect(8080,process.argv[1])",
    "const timer=setTimeout(()=>{socket.destroy();process.exit(2)},5000)",
    "socket.once('connect',()=>{clearTimeout(timer);socket.destroy();process.exit(0)})",
    "socket.once('error',()=>{clearTimeout(timer);process.exit(3)})",
  ].join(";");
  await writeFile(
    manifestPath,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name, namespace, labels },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "probe",
            image,
            imagePullPolicy: "Never",
            command: ["node", "-e", connect, gatewayIP],
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            resources: {
              requests: { cpu: "10m", memory: "16Mi" },
              limits: { cpu: "100m", memory: "64Mi" },
            },
          },
        ],
      },
    }),
    { mode: 0o600 },
  );
  await execute("kubectl", [...kubectl, "apply", "-f", manifestPath], {
    cwd: repository,
    env: environment,
  });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const pod = JSON.parse(
        (
          await execute(
            "kubectl",
            [...kubectl, "get", "pod", name, "--namespace", namespace, "-o", "json"],
            { cwd: repository, env: environment, maxBuffer: 4 * 1024 * 1024 },
          )
        ).stdout,
      );
      if (["Succeeded", "Failed"].includes(pod.status.phase)) {
        return pod.status.phase;
      }
      await delay(250);
    }
    throw new Error(`Gateway network probe ${name} did not complete.`);
  } finally {
    await execute(
      "kubectl",
      [
        ...kubectl,
        "delete",
        "pod",
        name,
        "--namespace",
        namespace,
        "--ignore-not-found=true",
        "--wait=true",
        "--timeout=60s",
      ],
      { cwd: repository, env: environment },
    );
  }
}

test(
  "dev-up installs the pinned OpenShell profile in its owned k3d cluster",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_DEV_UP_OPENSHELL_REAL=1 to run the real development profile.",
    timeout: 1_200_000,
  },
  async (t) => {
    await access(occ);
    const root = await mkdtemp(join(tmpdir(), "oce-dev-up-openshell-real-"));
    const stateDirectory = join(root, "state");
    const suffix = randomUUID().slice(0, 8);
    const cluster = `occ-dev-openshell-${suffix}`;
    const apiPort = await availablePort();
    const kubernetesPort = await availablePort();
    const environment = {
      ...process.env,
      OPENCLAW_DEV_PORT: String(apiPort),
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
      OCC_DEVELOPMENT_SANDBOX_DRIVER: "openshell",
      OCC_DEVELOPMENT_CONTAINER_ENGINE: process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE ?? "docker",
      OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
      OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
      OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubernetesPort),
      OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT:
        process.env.OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT ?? "1",
      OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "600",
    };
    delete environment.OCC_DEVELOPMENT_OPENSHELL_HELM_CHART;
    delete environment.OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART;
    delete environment.OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST;
    // Cleanup reuses the state and engine endpoint recorded by this invocation;
    // it must not discover or remove an unrelated cluster.
    t.after(async () => {
      if (!(await exists(stateDirectory))) {
        await rm(root, { recursive: true, force: true });
        return;
      }
      try {
        await execute(devDown, [], {
          cwd: repository,
          env: environment,
          timeout: 300_000,
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch (error) {
        throw new Error(
          `OpenShell development cleanup failed; recovery state preserved at ${stateDirectory}.`,
          { cause: error },
        );
      }
      await rm(root, { recursive: true, force: true });
    });

    const result = await execute(devUp, [], {
      cwd: repository,
      env: environment,
      timeout: 1_100_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.match(result.stdout, /Sandbox Driver: openshell/);
    assert.match(result.stdout, /OpenClaw Enterprise development stack is ready/);

    // Observe the real resources created through the supported OCC lifecycle,
    // without substituting the test-only OpenShell projection bridge.
    const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    assert.equal(state.cluster, cluster);
    assert.equal(state.sandboxDriver, "openshell");
    assert.equal(state.deploymentMode, "k3d");
    assert.equal(state.platformNamespace, "oce-system");
    assert.equal(await exists(join(stateDirectory, "compose.yaml")), false);
    const kubectl = [
      "--kubeconfig",
      join(stateDirectory, "kubeconfig"),
      "--context",
      `k3d-${cluster}`,
    ];
    const releases = JSON.parse(
      (
        await execute(
          "helm",
          [
            "list",
            "--kubeconfig",
            join(stateDirectory, "kubeconfig"),
            "--kube-context",
            `k3d-${cluster}`,
            "--namespace",
            "oce-system",
            "--output",
            "json",
          ],
          { cwd: repository, env: environment, maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout,
    );
    assert.match(
      releases.find(({ name }) => name === "openshell-gateway")?.chart ?? "",
      /-0\.1\.3-pre\.1$/,
      "the default development profile must install the documented OpenShell chart",
    );
    const namespaceList = JSON.parse(
      (
        await execute(
          "kubectl",
          [...kubectl, "get", "namespaces", "--selector", "openclaw.dev/namespace", "-o", "json"],
          {
            cwd: repository,
            env: environment,
            maxBuffer: 4 * 1024 * 1024,
          },
        )
      ).stdout,
    );
    assert.equal(namespaceList.items.length, 1);
    const namespace = namespaceList.items[0].metadata.name;
    assert.equal(namespaceList.items[0].metadata.labels["openshell.ai/openclaw-workspace"], "true");
    const service = JSON.parse(
      (
        await execute(
          "kubectl",
          [
            ...kubectl,
            "get",
            "service",
            "openshell-gateway",
            "--namespace",
            "oce-system",
            "-o",
            "json",
          ],
          {
            cwd: repository,
            env: environment,
            maxBuffer: 4 * 1024 * 1024,
          },
        )
      ).stdout,
    );
    assert.equal(service.spec.type, "ClusterIP");
    let controllerImage;
    for (const [component, selector] of [
      ["PostgreSQL", "app=postgres"],
      ["OCE API", "app.kubernetes.io/component=api"],
      ["OCE worker", "app.kubernetes.io/component=worker"],
    ]) {
      const pods = JSON.parse(
        (
          await execute(
            "kubectl",
            [
              ...kubectl,
              "get",
              "pods",
              "--namespace",
              "oce-system",
              "--selector",
              selector,
              "--output",
              "json",
            ],
            { cwd: repository, env: environment, maxBuffer: 4 * 1024 * 1024 },
          )
        ).stdout,
      );
      assert.equal(pods.items.length, 1, `${component} must have one Pod`);
      assert.equal(pods.items[0].status.phase, "Running", `${component} Pod must be running`);
      assert.ok(
        pods.items[0].status.containerStatuses?.every(({ ready }) => ready),
        `${component} containers must be ready`,
      );
      if (component === "OCE API") {
        controllerImage = pods.items[0].spec.containers[0].image;
      }
    }
    assert.equal(typeof controllerImage, "string");

    // The Gateway accepts unauthenticated development calls, so both halves of
    // the NetworkPolicy boundary must deny arbitrary tenant Pods while retaining
    // the OpenShell supervisor callback path.
    assert.equal(
      await runGatewayProbe({
        directory: root,
        kubectl,
        environment,
        namespace,
        name: `gateway-denied-${suffix}`,
        image: controllerImage,
        gatewayIP: service.spec.clusterIP,
        labels: { "app.kubernetes.io/name": "untrusted-gateway-probe" },
      }),
      "Failed",
      "an ordinary tenant Pod must not reach the unauthenticated Gateway",
    );
    assert.equal(
      await runGatewayProbe({
        directory: root,
        kubectl,
        environment,
        namespace,
        name: `gateway-allowed-${suffix}`,
        image: controllerImage,
        gatewayIP: service.spec.clusterIP,
        labels: {
          "openshell.ai/managed-by": "openshell",
          "openshell.ai/boundary-role": "supervisor",
        },
      }),
      "Succeeded",
      "an OpenShell supervisor Pod must retain its Gateway callback",
    );
    await execute(
      "kubectl",
      [...kubectl, "get", "serviceaccount", "openshell-sandbox", "--namespace", namespace],
      { cwd: repository, env: environment },
    );
    await execute("kubectl", [...kubectl, "get", "runtimeclass", "openshell-sandbox"], {
      cwd: repository,
      env: environment,
    });
    await execute("kubectl", [...kubectl, "get", "crd", "sandboxes.agents.x-k8s.io"], {
      cwd: repository,
      env: environment,
    });
    for (const name of [
      "openclaw-development-tenant-worker",
      "openclaw-development-openshell-workspace-rbac",
      "openclaw-development-tenant-configuration",
      "openclaw-development-tenant-secrets",
    ]) {
      await execute("kubectl", [...kubectl, "get", "clusterrolebinding", name], {
        cwd: repository,
        env: environment,
      });
    }
    await execute(
      "kubectl",
      [...kubectl, "get", "clusterrole", "openclaw-development-openshell-workspace-rbac"],
      { cwd: repository, env: environment },
    );

    // The namespace is not ready until the Sandbox Driver has created and
    // adopted its corresponding Gateway Workspace through the real gRPC API.
    const gatewayPort = await availablePort();
    const forward = spawn(
      "kubectl",
      [
        ...kubectl,
        "port-forward",
        "--namespace",
        "oce-system",
        "service/openshell-gateway",
        `${gatewayPort}:8080`,
      ],
      { cwd: repository, env: environment, stdio: ["ignore", "ignore", "pipe"] },
    );
    let forwardError = "";
    forward.stderr.on("data", (chunk) => {
      forwardError = `${forwardError}${chunk.toString()}`.slice(-4096);
    });
    t.after(() => stopPortForward(forward));
    await waitForPort(forward, gatewayPort, () => forwardError);
    const gateway = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${gatewayPort}`,
      auth: { mode: "unauthenticated" },
    });
    t.after(() => gateway.close());
    const workspace = await gateway.getWorkspace(namespace, AbortSignal.timeout(10_000));
    assert.equal(workspace?.name, namespace);
    assert.equal(workspace?.labels["app.kubernetes.io/managed-by"], "openclaw-enterprise");
    assert.equal(
      workspace?.labels["openclaw.dev/namespace-id"],
      namespaceList.items[0].metadata.annotations["openclaw.dev/namespace-id"],
    );

    // A Namespace created after startup must receive the same chart resources
    // through ensureNamespace; no host-side Helm release participates.
    const occEnvironment = {
      ...environment,
      OCC_URL: `http://127.0.0.1:${apiPort}`,
      OCC_SERVICE_KEY_FILE: join(stateDirectory, "initial-admin-service-key.json"),
    };
    const created = JSON.parse(
      (
        await execute(occ, ["namespace", "create", `operator-${suffix}`, "--output", "json"], {
          cwd: repository,
          env: occEnvironment,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout,
    );
    await waitForNamespaceReady(environment, apiPort, stateDirectory, created.id);
    const createdNamespaceList = JSON.parse(
      (
        await execute(
          "kubectl",
          [
            ...kubectl,
            "get",
            "namespaces",
            "--selector",
            `openclaw.dev/namespace=${created.id}`,
            "-o",
            "json",
          ],
          { cwd: repository, env: environment, maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout,
    );
    assert.equal(createdNamespaceList.items.length, 1);
    const createdPhysicalNamespace = createdNamespaceList.items[0].metadata.name;
    await execute(
      "kubectl",
      [
        ...kubectl,
        "get",
        "serviceaccount",
        "openshell-sandbox",
        "--namespace",
        createdPhysicalNamespace,
      ],
      { cwd: repository, env: environment },
    );
    const createdWorkspace = await gateway.getWorkspace(
      createdPhysicalNamespace,
      AbortSignal.timeout(10_000),
    );
    assert.equal(createdWorkspace?.labels["openclaw.dev/namespace-id"], created.id);

    const namespaces = await execute(occ, ["namespace", "list", "--output", "json"], {
      cwd: repository,
      env: occEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.ok(
      JSON.parse(namespaces.stdout).some(
        ({ name, status }) => name === "default" && status === "ready",
      ),
      "the regular OCC workflow must observe the bootstrap Namespace as ready",
    );

    // The generated Installation selects the OpenShell Credential Gateway, so the CLI's
    // credential-source commands must reach the live gateway through the API. The value is
    // synthetic: registration stores it in OpenShell without contacting the model provider.
    const cli = async (...args) =>
      JSON.parse(
        (
          await execute(occ, [...args, "--output", "json"], {
            cwd: repository,
            env: { ...occEnvironment, OCC_NAMESPACE: created.id },
            maxBuffer: 4 * 1024 * 1024,
          })
        ).stdout,
      );
    const syntheticKey = `sk-oce-dev-up-${randomUUID()}`;
    const secretFile = join(root, "credential-source-secret.json");
    await writeFile(secretFile, JSON.stringify({ name: `openai-${suffix}`, value: syntheticKey }), {
      mode: 0o600,
    });
    const secret = await cli("secret", "create", "--file", secretFile);
    await rm(secretFile);
    const sourceFile = join(root, "credential-source.json");
    await writeFile(
      sourceFile,
      JSON.stringify({
        name: `openai-${suffix}`,
        type: "openai",
        secrets: { api_key: secret.ref },
      }),
    );
    const source = await cli("credential-source", "create", "--file", sourceFile);
    assert.match(source.id, /^cs_/);
    assert.equal(source.state, "ready");
    assert.deepEqual(source.status, { state: "ready" });
    assert.equal(JSON.stringify(source).includes(syntheticKey), false);
    const observed = await cli("credential-source", "get", source.id);
    assert.deepEqual(observed.status, { state: "ready" });
    assert.deepEqual(
      (await cli("credential-source", "list")).map(({ id }) => id),
      [source.id],
    );
    // The gateway copy lives in the Namespace's own OpenShell Workspace under an OCC-owned name.
    const providerName = openShellProviderName(source.id);
    const provider = await gateway.getProvider(
      createdPhysicalNamespace,
      providerName,
      AbortSignal.timeout(10_000),
    );
    assert.equal(provider?.name, providerName);

    // Agents need exact operate on a source before deployment, so Namespace IAM must accept
    // credential_source Roles through the same CLI and API path an operator uses.
    const roleFile = join(root, "credential-source-role.json");
    await writeFile(
      roleFile,
      JSON.stringify({
        name: "Use a credential source",
        permissions: [{ action: "operate", resourceKind: "credential_source" }],
      }),
    );
    const role = await cli("iam", "role", "create", "--file", roleFile);
    assert.deepEqual(role.permissions, [{ action: "operate", resourceKind: "credential_source" }]);
    await cli("iam", "role", "delete", role.id);

    // A referenced Secret cannot be deleted while its source exists; deleting the source
    // removes the gateway copy, after which the Secret is unreferenced again.
    await assert.rejects(cli("secret", "delete", secret.id), /409|RESOURCE_CONFLICT/);
    // Right after registration, DELETE removes the copy but keeps the record: a timed-out
    // registration could still create a copy, so OCC finalizes only after its fence window.
    await assert.rejects(
      cli("credential-source", "delete", source.id),
      /503|DEPENDENCY_UNAVAILABLE/,
    );
    assert.equal(
      (await cli("credential-source", "get", source.id)).state,
      "deleting",
      "an early deletion must keep the cleanup record",
    );
    const fenceDeadline = Date.now() + 120_000;
    for (;;) {
      try {
        await cli("credential-source", "delete", source.id);
        break;
      } catch (error) {
        if (Date.now() > fenceDeadline || !/503|DEPENDENCY_UNAVAILABLE/.test(String(error))) {
          throw error;
        }
        await delay(5_000);
      }
    }
    assert.equal(
      await gateway.getProvider(
        createdPhysicalNamespace,
        providerName,
        AbortSignal.timeout(10_000),
      ),
      undefined,
    );
    await cli("secret", "delete", secret.id);
  },
);

test(
  "dev-up runs OCC in Compose with OpenShell and Kubernetes Compute in k3d",
  {
    skip: composeSelected
      ? false
      : "Set OCC_TEST_DEV_UP_OPENSHELL_COMPOSE_REAL=1 to run the Compose-backed OpenShell profile.",
    timeout: 1_200_000,
  },
  async (t) => {
    await access(occ);
    const root = await mkdtemp(join(tmpdir(), "oce-dev-up-openshell-compose-real-"));
    const stateDirectory = join(root, "state");
    const suffix = randomUUID().slice(0, 8);
    const cluster = `occ-dev-os-compose-${suffix}`;
    const apiPort = await availablePort();
    const kubernetesPort = await availablePort();
    const environment = {
      ...process.env,
      OPENCLAW_DEV_PORT: String(apiPort),
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_SANDBOX_DRIVER: "openshell",
      OCC_DEVELOPMENT_CONTROL_PLANE: "compose",
      OCC_DEVELOPMENT_CONTAINER_ENGINE: process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE ?? "docker",
      OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
      OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
      OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubernetesPort),
      OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT:
        process.env.OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT ?? "1",
      OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "600",
    };
    delete environment.OCC_DEVELOPMENT_OPENSHELL_HELM_CHART;
    delete environment.OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART;
    delete environment.OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST;
    t.after(async () => {
      if (await exists(stateDirectory)) {
        try {
          await execute(devDown, [], {
            cwd: repository,
            env: environment,
            timeout: 300_000,
            maxBuffer: 8 * 1024 * 1024,
          });
        } catch (error) {
          throw new Error(
            `Compose-backed OpenShell cleanup failed; recovery state preserved at ${stateDirectory}.`,
            { cause: error },
          );
        }
      }
      await rm(root, { recursive: true, force: true });
    });

    const result = await execute(devUp, [], {
      cwd: repository,
      env: environment,
      timeout: 1_100_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.match(result.stdout, /Control plane: Compose/);
    assert.match(result.stdout, /Sandbox Driver: openshell/);

    // The authenticated OCC API is served by Compose while its worker creates
    // the operator-mode OpenShell Workspace through the real k3d cluster.
    const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    assert.equal(state.cluster, cluster);
    assert.equal(state.sandboxDriver, "openshell");
    assert.equal(state.deploymentMode, undefined);
    assert.equal(await exists(join(stateDirectory, "compose.yaml")), true);
    const kubectl = [
      "--kubeconfig",
      join(stateDirectory, "kubeconfig"),
      "--context",
      `k3d-${cluster}`,
    ];
    const service = JSON.parse(
      (
        await execute(
          "kubectl",
          [
            ...kubectl,
            "get",
            "service",
            "openshell-gateway",
            "--namespace",
            "openshell-system",
            "-o",
            "json",
          ],
          { cwd: repository, env: environment, maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout,
    );
    assert.equal(service.spec.type, "NodePort");
    assert.equal(service.spec.ports[0].nodePort, 30051);
    const namespaceList = JSON.parse(
      (
        await execute(
          "kubectl",
          [...kubectl, "get", "namespaces", "--selector", "openclaw.dev/namespace", "-o", "json"],
          { cwd: repository, env: environment, maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout,
    );
    assert.equal(namespaceList.items.length, 1);
    const namespace = namespaceList.items[0].metadata.name;
    assert.equal(namespaceList.items[0].metadata.labels["openshell.ai/openclaw-workspace"], "true");
    await execute(
      "kubectl",
      [...kubectl, "get", "serviceaccount", "openshell-sandbox", "--namespace", namespace],
      { cwd: repository, env: environment },
    );

    const gatewayPort = await availablePort();
    const forward = spawn(
      "kubectl",
      [
        ...kubectl,
        "port-forward",
        "--namespace",
        "openshell-system",
        "service/openshell-gateway",
        `${gatewayPort}:8080`,
      ],
      { cwd: repository, env: environment, stdio: ["ignore", "ignore", "pipe"] },
    );
    let forwardError = "";
    forward.stderr.on("data", (chunk) => {
      forwardError = `${forwardError}${chunk.toString()}`.slice(-4096);
    });
    t.after(() => stopPortForward(forward));
    await waitForPort(forward, gatewayPort, () => forwardError);
    const gateway = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${gatewayPort}`,
      auth: { mode: "unauthenticated" },
    });
    t.after(() => gateway.close());
    const workspace = await gateway.getWorkspace(namespace, AbortSignal.timeout(10_000));
    assert.equal(workspace?.name, namespace);
    assert.equal(workspace?.labels["app.kubernetes.io/managed-by"], "openclaw-enterprise");

    await stopPortForward(forward);
    await execute(devDown, [], {
      cwd: repository,
      env: environment,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(await exists(stateDirectory), false);
  },
);
