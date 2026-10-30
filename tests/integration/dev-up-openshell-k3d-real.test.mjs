import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { failureSecrets, redactLogLine } from "../../scripts/ci/failure-redaction.mjs";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { availablePort } from "../helpers/available-port.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { stopProcess } from "../helpers/stop-process.mjs";

const { loadYaml } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "@kubernetes/client-node",
);

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const occ = join(repository, "bin", "occ");
const devUp = join(repository, "scripts", "dev-up");
const devDown = join(repository, "scripts", "dev-down");
const selected = process.env.OCC_TEST_DEV_UP_OPENSHELL_REAL === "1";
const composeSelected = process.env.OCC_TEST_DEV_UP_OPENSHELL_COMPOSE_REAL === "1";

async function startDevelopment(environment) {
  try {
    return await execute(devUp, [], {
      cwd: repository,
      env: environment,
      timeout: 1_100_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    // Image-build progress can fill the reporter's budget before the actual startup error.
    const secrets = failureSecrets([environment]);
    const tail = String(error.stderr ?? error.message)
      .split("\n")
      .slice(-80)
      .map((line) => redactLogLine(line, secrets, 800))
      .join("\n");
    // Node's direct test reporter would print the raw subprocess output from a cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`OpenShell development startup failed:\n${tail}`);
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

async function waitForObservation(description, observe) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await observe();
    if (result) {
      return result;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${description}.`);
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
    timeout: 2_400_000,
  },
  async (t) => {
    await access(occ);
    // LocalSetup requires a canonical parent; macOS temporary roots may be symlinks.
    const root = await mkdtemp(join(await realpath(tmpdir()), "oce-dev-up-openshell-real-"));
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
      if (!existsSync(stateDirectory)) {
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

    const result = await startDevelopment(environment);
    assert.match(result.stdout, /Sandbox Driver: openshell/);
    assert.match(result.stdout, /OpenClaw Enterprise development stack is ready/);

    // Observe the real resources created through the supported OCC lifecycle,
    // without substituting the test-only OpenShell projection bridge.
    const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    assert.equal(state.cluster, cluster);
    assert.equal(state.sandboxDriver, "openshell");
    assert.equal(state.deploymentMode, "k3d");
    assert.equal(state.platformNamespace, "oce-system");
    assert.equal(existsSync(join(stateDirectory, "compose.yaml")), false);
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
      /-0\.1\.5$/,
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
    t.after(() => stopProcess(forward));
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

    const namespaceCli = async (...args) =>
      JSON.parse(
        (
          await execute(occ, ["namespace", ...args, "--output", "json"], {
            cwd: repository,
            env: occEnvironment,
            maxBuffer: 4 * 1024 * 1024,
          })
        ).stdout,
      );
    const clusterCommand = async (...args) =>
      execute("kubectl", [...kubectl, ...args], {
        cwd: repository,
        env: environment,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 150_000,
      });
    const clusterJson = async (...args) =>
      JSON.parse((await clusterCommand(...args, "--output", "json")).stdout);
    const liveNamespace = async (id) => (await namespaceCli("list")).find((item) => item.id === id);
    const waitForLogicalDeletion = async (id) => {
      await waitForObservation(
        `OCC Namespace ${id} deletion`,
        async () => (await liveNamespace(id)) === undefined,
      );
      await assert.rejects(namespaceCli("get", id), /404|NOT_FOUND/);
    };
    const setWorkerReplicas = async (replicas) => {
      await clusterCommand(
        "scale",
        "deployment/openclaw-enterprise-worker",
        "--namespace",
        state.platformNamespace,
        `--replicas=${replicas}`,
      );
      if (replicas === 0) {
        await waitForObservation("owned worker Pod termination", async () => {
          const pods = await clusterJson(
            "get",
            "pods",
            "--namespace",
            state.platformNamespace,
            "--selector",
            "app.kubernetes.io/component=worker",
          );
          return pods.items.length === 0;
        });
      } else {
        await clusterCommand(
          "rollout",
          "status",
          "deployment/openclaw-enterprise-worker",
          "--namespace",
          state.platformNamespace,
          "--timeout=120s",
        );
      }
    };
    const restartWorker = async () => {
      await setWorkerReplicas(0);
      await setWorkerReplicas(1);
    };
    const waitForDeletionDispatch = async (namespaceId) =>
      waitForObservation("worker Namespace deletion dispatch", async () => {
        const { stdout } = await clusterCommand(
          "logs",
          "deployment/openclaw-enterprise-worker",
          "--namespace",
          state.platformNamespace,
        );
        // Read only structured lifecycle evidence; never print raw worker logs.
        return stdout
          .split("\n")
          .flatMap((line) => {
            try {
              const event = JSON.parse(line);
              return event.event === "worker.completed" &&
                event.operation === "namespace.delete" &&
                event.namespaceId === namespaceId
                ? [{ result: event.result, code: event.code }]
                : [];
            } catch {
              return [];
            }
          })
          .at(-1);
      });
    const readyNamespace = async (name, ...options) => {
      const logical = await namespaceCli("create", name, ...options);
      await waitForNamespaceReady(environment, apiPort, stateDirectory, logical.id);
      const physical = await clusterJson(
        "get",
        "namespaces",
        "--selector",
        `openclaw.dev/namespace=${logical.id}`,
      );
      assert.equal(physical.items.length, 1);
      const backing = physical.items[0];
      const boundWorkspace = await gateway.getWorkspace(
        backing.metadata.name,
        AbortSignal.timeout(10_000),
      );
      assert.ok(boundWorkspace?.id, "the real provider must return its immutable Workspace ID");
      assert.equal(boundWorkspace.labels["openclaw.dev/namespace-id"], logical.id);
      return { logical, backing, boundWorkspace };
    };
    const createExternalNamespace = async (name) => {
      await clusterCommand("create", "namespace", name);
      await clusterCommand(
        "label",
        "namespace",
        name,
        "app.kubernetes.io/managed-by=Helm",
        "pod-security.kubernetes.io/enforce=restricted",
        "pod-security.kubernetes.io/audit=restricted",
        "pod-security.kubernetes.io/warn=restricted",
      );
      await clusterCommand(
        "annotate",
        "namespace",
        name,
        "openclaw.dev/namespace-lifecycle=external",
      );
      return clusterJson("get", "namespace", name);
    };

    await t.test(
      "Namespace loss does not discard the original Workspace cleanup binding",
      async () => {
        assert.ok(createdWorkspace.id);
        await setWorkerReplicas(0);
        try {
          // Only the tenant placement is lost. The independently stored Workspace must
          // remain reachable and owned until the ordinary deletion worker removes it.
          await clusterCommand(
            "delete",
            "namespace",
            createdPhysicalNamespace,
            "--wait=true",
            "--timeout=120s",
          );
          assert.equal(
            (await gateway.getWorkspace(createdPhysicalNamespace, AbortSignal.timeout(10_000)))?.id,
            createdWorkspace.id,
          );
          assert.equal((await namespaceCli("delete", created.id)).status, "deleting");
        } finally {
          await setWorkerReplicas(1);
        }
        await waitForLogicalDeletion(created.id);
        assert.equal(
          await gateway.getWorkspace(createdPhysicalNamespace, AbortSignal.timeout(10_000)),
          undefined,
          "logical deletion must include removal of the original real Workspace after placement loss",
        );
      },
    );

    await t.test(
      "confirmed Workspace cleanup survives worker restart while deletion is held",
      async () => {
        const { logical, backing } = await readyNamespace(`checkpoint-${suffix}`);
        const name = backing.metadata.name;
        const finalizer = `cleanup-test.openclaw.dev/hold-${suffix}`;
        await clusterCommand(
          "patch",
          "namespace",
          name,
          "--type=merge",
          "--patch",
          JSON.stringify({
            metadata: { finalizers: [...(backing.metadata.finalizers ?? []), finalizer] },
          }),
        );
        await namespaceCli("delete", logical.id);
        // Holding the Kubernetes tail creates a real retry after provider confirmation.
        // The provider receipt must survive the process that first observed deletion.
        await waitForObservation(
          "Workspace removal before physical Namespace removal",
          async () => {
            const current = await clusterJson("get", "namespace", name);
            return (
              current.metadata.deletionTimestamp !== undefined &&
              (await gateway.getWorkspace(name, AbortSignal.timeout(10_000))) === undefined
            );
          },
        );
        assert.equal((await namespaceCli("get", logical.id)).status, "deleting");
        await restartWorker();
        assert.equal((await waitForDeletionDispatch(logical.id)).result, "pending");
        const retained = await clusterJson("get", "namespace", name);
        assert.equal(retained.metadata.uid, backing.metadata.uid);
        assert.ok(retained.metadata.finalizers.includes(finalizer));
        await clusterCommand(
          "patch",
          "namespace",
          name,
          "--type=json",
          "--patch",
          JSON.stringify([
            { op: "test", path: "/metadata/uid", value: backing.metadata.uid },
            { op: "test", path: "/metadata/finalizers", value: retained.metadata.finalizers },
            {
              op: "replace",
              path: "/metadata/finalizers",
              value: retained.metadata.finalizers.filter((value) => value !== finalizer),
            },
          ]),
        );
        await waitForLogicalDeletion(logical.id);
        assert.equal(
          (
            await clusterCommand("get", "namespace", name, "--ignore-not-found", "--output=name")
          ).stdout.trim(),
          "",
        );
        assert.equal(await gateway.getWorkspace(name, AbortSignal.timeout(10_000)), undefined);
      },
    );

    await t.test(
      "same-name Workspace replacement is refused on deletion and explicit retry",
      async () => {
        const { logical, backing, boundWorkspace } = await readyNamespace(`replacement-${suffix}`);
        const name = backing.metadata.name;
        // Reproduce provider state loss with the real protocol. Matching ownership
        // labels do not make a newly created Workspace the saved incarnation.
        await gateway.deleteWorkspace(name, AbortSignal.timeout(10_000));
        assert.equal(await gateway.getWorkspace(name, AbortSignal.timeout(10_000)), undefined);
        const replacement = await gateway.createWorkspace(
          name,
          boundWorkspace.labels,
          AbortSignal.timeout(10_000),
        );
        assert.ok(replacement.id);
        assert.notEqual(replacement.id, boundWorkspace.id);
        const assertRefusedDeletion = async () => {
          assert.equal((await namespaceCli("delete", logical.id)).status, "deleting");
          const dispatch = await waitForDeletionDispatch(logical.id);
          assert.equal(dispatch.result, "permanent");
          assert.equal((await namespaceCli("get", logical.id)).status, "deleting");
          assert.equal(
            (await gateway.getWorkspace(name, AbortSignal.timeout(10_000)))?.id,
            replacement.id,
            "a replacement Workspace must survive the attempted deletion",
          );
          const physical = await clusterJson("get", "namespace", name);
          assert.equal(physical.metadata.uid, backing.metadata.uid);
          assert.equal(physical.metadata.deletionTimestamp, undefined);
        };
        await assertRefusedDeletion();
        await restartWorker();
        await assertRefusedDeletion();
      },
    );

    await t.test(
      "saved provider cleanup does not authorize a replacement configured ServiceAccount",
      async () => {
        const name = `resource-replacement-${suffix}`;
        const external = await createExternalNamespace(name);
        const { logical, backing, boundWorkspace } = await readyNamespace(
          `resource-replacement-${suffix}`,
          "--existing-namespace",
          name,
        );
        assert.equal(backing.metadata.uid, external.metadata.uid);
        assert.ok(boundWorkspace.id);
        const original = await clusterJson(
          "get",
          "serviceaccount",
          "openshell-sandbox",
          "--namespace",
          name,
        );
        assert.ok(original.metadata.uid);
        const finalizer = `cleanup-test.openclaw.dev/hold-resource-${suffix}`;
        await clusterCommand(
          "patch",
          "serviceaccount",
          original.metadata.name,
          "--namespace",
          name,
          "--type=json",
          "--patch",
          JSON.stringify([
            { op: "test", path: "/metadata/uid", value: original.metadata.uid },
            {
              op: "add",
              path: "/metadata/finalizers",
              value: [...(original.metadata.finalizers ?? []), finalizer],
            },
          ]),
        );
        await namespaceCli("delete", logical.id);
        // The external Namespace stays active while the configured-resource tail
        // waits for this finalizer after real provider deletion and its checkpoint.
        await waitForObservation(
          "Workspace removal and configured ServiceAccount deletion",
          async () => {
            const held = await clusterJson(
              "get",
              "serviceaccount",
              original.metadata.name,
              "--namespace",
              name,
            );
            assert.equal(held.metadata.uid, original.metadata.uid);
            return (
              held.metadata.deletionTimestamp !== undefined &&
              (await gateway.getWorkspace(name, AbortSignal.timeout(10_000))) === undefined
            );
          },
        );
        assert.equal((await namespaceCli("get", logical.id)).status, "deleting");
        assert.equal((await clusterJson("get", "namespace", name)).status.phase, "Active");
        await setWorkerReplicas(0);
        let replacement;
        try {
          const held = await clusterJson(
            "get",
            "serviceaccount",
            original.metadata.name,
            "--namespace",
            name,
          );
          assert.equal(held.metadata.uid, original.metadata.uid);
          assert.ok(held.metadata.finalizers.includes(finalizer));
          // Release only this test's hold. Kubernetes must remove the original
          // incarnation before the test creates a same-name replacement.
          await clusterCommand(
            "patch",
            "serviceaccount",
            original.metadata.name,
            "--namespace",
            name,
            "--type=json",
            "--patch",
            JSON.stringify([
              { op: "test", path: "/metadata/uid", value: original.metadata.uid },
              { op: "test", path: "/metadata/finalizers", value: held.metadata.finalizers },
              {
                op: "replace",
                path: "/metadata/finalizers",
                value: held.metadata.finalizers.filter((value) => value !== finalizer),
              },
            ]),
          );
          await waitForObservation("original configured ServiceAccount removal", async () => {
            const absent = await clusterCommand(
              "get",
              "serviceaccount",
              original.metadata.name,
              "--namespace",
              name,
              "--ignore-not-found",
              "--output=name",
            );
            return absent.stdout.trim() === "";
          });
          const manifest = join(root, "replacement-serviceaccount.json");
          await writeFile(
            manifest,
            JSON.stringify({
              apiVersion: "v1",
              kind: "ServiceAccount",
              metadata: {
                name: original.metadata.name,
                namespace: name,
                labels: original.metadata.labels,
                annotations: original.metadata.annotations,
              },
              automountServiceAccountToken: original.automountServiceAccountToken,
              imagePullSecrets: original.imagePullSecrets,
            }),
            { mode: 0o600 },
          );
          await clusterCommand("create", "--filename", manifest);
          replacement = await clusterJson(
            "get",
            "serviceaccount",
            original.metadata.name,
            "--namespace",
            name,
          );
          assert.ok(replacement.metadata.uid);
          assert.notEqual(replacement.metadata.uid, original.metadata.uid);
          assert.deepEqual(replacement.metadata.labels, original.metadata.labels);
          assert.deepEqual(replacement.metadata.annotations, original.metadata.annotations);
        } finally {
          await setWorkerReplicas(1);
        }

        const assertReplacementSurvives = async () => {
          assert.equal((await waitForDeletionDispatch(logical.id)).result, "permanent");
          assert.equal((await namespaceCli("get", logical.id)).status, "deleting");
          const retained = await clusterJson(
            "get",
            "serviceaccount",
            original.metadata.name,
            "--namespace",
            name,
          );
          assert.equal(retained.metadata.uid, replacement.metadata.uid);
          assert.equal(retained.metadata.deletionTimestamp, undefined);
          assert.deepEqual(retained.metadata.labels, replacement.metadata.labels);
          assert.deepEqual(retained.metadata.annotations, replacement.metadata.annotations);
          const physical = await clusterJson("get", "namespace", name);
          assert.equal(physical.metadata.uid, external.metadata.uid);
          assert.equal(physical.metadata.deletionTimestamp, undefined);
          assert.equal(physical.status.phase, "Active");
          assert.equal(physical.metadata.labels["openclaw.dev/namespace"], logical.id);
          // A saved provider receipt cannot authorize deleting a new Kubernetes
          // incarnation, nor permit logical completion while that refusal remains.
          assert.equal(await gateway.getWorkspace(name, AbortSignal.timeout(10_000)), undefined);
        };
        await assertReplacementSurvives();
        await restartWorker();
        assert.equal((await namespaceCli("delete", logical.id)).status, "deleting");
        await assertReplacementSurvives();
      },
    );

    await t.test(
      "external Namespace cleanup retains its physical incarnation and releases its claim",
      async () => {
        const name = `external-${suffix}`;
        const original = await createExternalNamespace(name);
        const { logical, backing } = await readyNamespace(
          `retained-${suffix}`,
          "--existing-namespace",
          name,
        );
        assert.equal(backing.metadata.uid, original.metadata.uid);
        await namespaceCli("delete", logical.id);
        await waitForLogicalDeletion(logical.id);
        // Logical 404 must follow real provider removal and claim release, while
        // preserving the operator's physical Namespace and non-OCC ownership.
        assert.equal(await gateway.getWorkspace(name, AbortSignal.timeout(10_000)), undefined);
        const retained = await clusterJson("get", "namespace", name);
        assert.equal(retained.metadata.uid, original.metadata.uid);
        assert.equal(retained.metadata.deletionTimestamp, undefined);
        assert.equal(retained.metadata.labels["app.kubernetes.io/managed-by"], "Helm");
        assert.equal(retained.metadata.labels["openclaw.dev/namespace"], undefined);
        assert.equal(retained.metadata.labels["openclaw.dev/gateway-namespace"], undefined);
        assert.equal(retained.metadata.annotations["openclaw.dev/namespace-id"], undefined);
        assert.equal(retained.metadata.annotations["openclaw.dev/namespace-lifecycle"], "external");
        assert.equal(
          (
            await clusterCommand(
              "get",
              "serviceaccount",
              "openshell-sandbox",
              "--namespace",
              name,
              "--ignore-not-found",
              "--output=name",
            )
          ).stdout.trim(),
          "",
          "the configured OpenShell ServiceAccount must be removed from the retained Namespace",
        );
      },
    );

    await t.test("deletion before first ensure needs no invented provider binding", async () => {
      const name = `cancelled-${suffix}`;
      const original = await createExternalNamespace(name);
      await setWorkerReplicas(0);
      let logical;
      try {
        // With no worker Pod, create and delete are committed through the real
        // API before any Driver preparation effect can start.
        logical = await namespaceCli("create", `cancelled-${suffix}`, "--existing-namespace", name);
        assert.equal(logical.status, "provisioning");
        assert.equal((await namespaceCli("delete", logical.id)).status, "deleting");
        assert.equal(await gateway.getWorkspace(name, AbortSignal.timeout(10_000)), undefined);
      } finally {
        await setWorkerReplicas(1);
      }
      await waitForLogicalDeletion(logical.id);
      assert.equal(await gateway.getWorkspace(name, AbortSignal.timeout(10_000)), undefined);
      const retained = await clusterJson("get", "namespace", name);
      assert.equal(retained.metadata.uid, original.metadata.uid);
      assert.deepEqual(retained.metadata.labels, original.metadata.labels);
      assert.deepEqual(retained.metadata.annotations, original.metadata.annotations);
    });

    await t.test(
      "ordinary Agent stop and deletion remove real revision providers after Namespace loss without inference",
      { timeout: 600_000 },
      async (agentTest) => {
        const { logical, backing, boundWorkspace } = await readyNamespace(
          `agent-cleanup-${suffix}`,
        );
        const name = backing.metadata.name;
        const installation = loadYaml(
          await readFile(join(stateDirectory, "installation.yaml"), "utf8"),
        );
        assert.equal(
          installation.drivers.compute.configuration.servicePrincipalCredentials.mode,
          "disabled",
        );
        const resources =
          installation.drivers.sandbox.configuration.gateway.operatorWorkspaceResources;
        const gatewayPods = await clusterJson(
          "get",
          "pods",
          "--namespace",
          state.platformNamespace,
          "--selector",
          Object.entries(service.spec.selector)
            .map(([key, value]) => `${key}=${value}`)
            .join(","),
        );
        const accounts = [...new Set(gatewayPods.items.map((pod) => pod.spec.serviceAccountName))];
        assert.equal(accounts.length, 1);
        assert.ok(accounts[0]);
        const gatewayAccount = {
          kind: "ServiceAccount",
          name: accounts[0],
          namespace: state.platformNamespace,
        };
        const sandboxRoles = resources.filter(
          (resource) =>
            resource.kind === "Role" &&
            resource.rules.some(
              (rule) =>
                rule.apiGroups.includes("agents.x-k8s.io") &&
                rule.resources.includes("sandboxes") &&
                rule.verbs.includes("create"),
            ),
        );
        const bindings = resources.filter(
          (resource) =>
            resource.kind === "RoleBinding" &&
            resource.roleRef.kind === "Role" &&
            sandboxRoles.some((role) => role.metadata.name === resource.roleRef.name) &&
            resource.subjects.some(
              (subject) =>
                subject.kind === gatewayAccount.kind &&
                subject.name === gatewayAccount.name &&
                subject.namespace === gatewayAccount.namespace,
            ),
        );
        assert.equal(
          bindings.length,
          1,
          "the rendered chart must identify one gateway Sandbox-create binding",
        );
        assert.equal(
          bindings[0].subjects.length,
          1,
          "the selected binding must grant only the gateway",
        );
        const binding = await clusterJson(
          "get",
          "rolebinding",
          bindings[0].metadata.name,
          "--namespace",
          name,
        );
        assert.equal(binding.metadata.labels["openclaw.dev/namespace"], logical.id);
        assert.deepEqual(binding.roleRef, bindings[0].roleRef);
        assert.deepEqual(binding.subjects, bindings[0].subjects);
        const originalBindings = await clusterJson("get", "rolebindings", "--namespace", name);
        const canCreateSandbox = async () => {
          agentTest.signal.throwIfAborted();
          try {
            return (
              await clusterCommand(
                "auth",
                "can-i",
                "create",
                "sandboxes.agents.x-k8s.io",
                "--namespace",
                name,
                "--as",
                `system:serviceaccount:${gatewayAccount.namespace}:${gatewayAccount.name}`,
              )
            ).stdout.trim();
          } catch (error) {
            if (error.code === 1 && error.stdout?.trim() === "no") {
              return "no";
            }
            throw error;
          }
        };
        assert.equal(await canCreateSandbox(), "yes");
        // Remove only the chart's gateway grant. OCC API/worker grants remain,
        // while Kubernetes must refuse Sandbox creation before any Harness Pod.
        await clusterCommand("delete", "rolebinding", binding.metadata.name, "--namespace", name);
        assert.equal(await canCreateSandbox(), "no");
        const remainingBindings = await clusterJson("get", "rolebindings", "--namespace", name);
        assert.deepEqual(
          remainingBindings.items.map((item) => item.metadata.uid).sort(),
          originalBindings.items
            .filter((item) => item.metadata.uid !== binding.metadata.uid)
            .map((item) => item.metadata.uid)
            .sort(),
        );

        const serviceKey = JSON.parse(
          await readFile(join(stateDirectory, "initial-admin-service-key.json"), "utf8"),
        ).data.key;
        const base = `/namespaces/${logical.id}`;
        const api = async (method, path, body, expectedStatus = 200) => {
          const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
            method,
            headers: { "x-api-key": serviceKey, "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.any([agentTest.signal, AbortSignal.timeout(30_000)]),
            redirect: "error",
          });
          const envelope = await response.json();
          assert.equal(
            response.status,
            expectedStatus,
            `${method} ${path} returned ${response.status} (${envelope.error?.code ?? "no error code"})`,
          );
          return expectedStatus === 404 ? envelope.error : envelope.data;
        };
        const modelSecret = await api(
          "POST",
          `${base}/secrets`,
          {
            name: `cleanup-model-${suffix}`,
            value: `synthetic-codex-${randomUUID()}`,
          },
          201,
        );
        const modelSource = await api(
          "POST",
          `${base}/credential-sources`,
          {
            name: `cleanup-model-${suffix}`,
            type: "codex-pat",
            config: {},
            secrets: { access_token: modelSecret.ref },
          },
          201,
        );
        assert.equal(modelSource.state, "ready");
        const workerEvents = async () => {
          agentTest.signal.throwIfAborted();
          const { stdout } = await clusterCommand(
            "logs",
            "deployment/openclaw-enterprise-worker",
            "--namespace",
            state.platformNamespace,
          );
          return stdout.split("\n").flatMap((line) => {
            try {
              const event = JSON.parse(line);
              return event.event === "worker.completed" && event.namespaceId === logical.id
                ? [event]
                : [];
            } catch {
              return [];
            }
          });
        };
        const assertNoHarness = async () => {
          assert.equal(
            (await clusterJson("get", "sandboxes.agents.x-k8s.io", "--namespace", name)).items
              .length,
            0,
          );
          const pods = await clusterJson(
            "get",
            "pods",
            "--namespace",
            name,
            "--selector",
            "openclaw.dev/workload-role=agent",
          );
          assert.equal(
            pods.items.length,
            0,
            "the denied create must not start a Harness or model process",
          );
        };
        const prepareCandidate = async (label) => {
          const configuration = createHarnessConfiguration("codex", "gpt-5.4");
          configuration.agents.defaults.skipBootstrap = true;
          const admitted = await api(
            "POST",
            `${base}/agents/provision`,
            {
              requestId: `req_${randomUUID()}`,
              name: `cleanup-${label}-${suffix}`,
              executionMode: "dedicated",
              harnessAuth: { method: "credential_source", sourceId: modelSource.id },
              configuration: { kind: "agent", values: configuration },
            },
            202,
          );
          const work = admitted.provisioning;
          assert.equal(work.url, `${base}/agents/provision/${encodeURIComponent(work.workId)}`);
          const progress = await waitForObservation("API-admitted Agent revision", async () => {
            const current = await api("GET", work.url);
            if (current.revisionId !== undefined) {
              return current;
            }
            assert.notEqual(
              current.status,
              "failed",
              `provisioning failed before revision admission (${current.error?.code ?? "unknown"})`,
            );
            return undefined;
          });
          const agentPath = `${base}/agents/${progress.agentId}`;
          const revision = await api("GET", `${agentPath}/revisions/${progress.revisionId}`);
          assert.equal(revision.id, progress.revisionId);
          assert.equal(revision.namespaceId, logical.id);
          assert.equal(revision.agentId, progress.agentId);
          assert.equal(revision.harness.id, "codex");
          assert.equal(revision.harness.mode, "dedicated");
          assert.ok(revision.harness.version);
          // The real worker must reach CreateSandbox while Kubernetes access is
          // denied. A failure before that RPC does not exercise this cleanup path.
          const refusal = await waitForObservation(
            "CreateSandbox failure while Kubernetes access is denied",
            async () =>
              (await workerEvents()).find(
                (event) =>
                  event.revisionId === revision.id &&
                  event.operation === "agent_revision.reconcile" &&
                  event.method === "CreateSandbox",
              ),
          );
          assert.notEqual(refusal.result, "success");
          assert.equal(
            refusal.grpcStatus,
            13,
            "the pinned server maps Kubernetes driver create refusal to INTERNAL, not request validation",
          );
          const providers = await gateway.listProviders(name, AbortSignal.timeout(10_000));
          const matching = providers.filter(
            (provider) =>
              provider.type === "oce-codex-runtime" &&
              provider.labels["openclaw.dev/namespace-id"] === logical.id &&
              provider.labels["openclaw.dev/agent-id"] === progress.agentId &&
              provider.labels["openclaw.dev/revision-id"] === revision.id,
          );
          assert.equal(
            matching.length,
            1,
            "the failed real preparation must retain its exact runtime Provider",
          );
          assert.equal(matching[0].labels["app.kubernetes.io/managed-by"], "openclaw-enterprise");
          await assertNoHarness();
          // Read the selected prefix rather than the Driver's default: the
          // development profile uses a different prefix for its 19-byte names.
          const prefix = installation.drivers.sandbox.configuration.sandboxNamePrefix;
          assert.equal(typeof prefix, "string");
          const hash = createHash("sha256").update(revision.id).digest("hex");
          const sandbox = `${prefix}-${hash.slice(0, 19 - prefix.length - 1)}`;
          const retainedSandbox = await gateway.getSandbox(
            { workspace: name, name: sandbox },
            AbortSignal.timeout(10_000),
          );
          if (retainedSandbox !== undefined) {
            // Official failed-create compensation can retain its Deleting record
            // when denied Kubernetes cleanup cannot settle. It must stay exact-owned.
            assert.ok(retainedSandbox.id);
            assert.equal(retainedSandbox.name, sandbox);
            assert.equal(retainedSandbox.workspace, name);
            assert.equal(retainedSandbox.labels["openclaw.dev/namespace"], logical.id);
            assert.equal(retainedSandbox.labels["openclaw.dev/agent"], progress.agentId);
            assert.equal(retainedSandbox.labels["openclaw.dev/revision"], revision.id);
            assert.equal(retainedSandbox.annotations["openclaw.dev/namespace-id"], logical.id);
            assert.equal(retainedSandbox.annotations["openclaw.dev/agent-id"], progress.agentId);
            assert.equal(retainedSandbox.annotations["openclaw.dev/revision-id"], revision.id);
          }
          return {
            agentPath,
            agentId: progress.agentId,
            revision,
            provider: matching[0],
            sandbox,
            sandboxId: retainedSandbox?.id,
          };
        };
        const stopped = await prepareCandidate("stop");
        const retired = await prepareCandidate("retire");
        await setWorkerReplicas(0);
        try {
          assert.equal(await canCreateSandbox(), "no");
          await assertNoHarness();
          for (const candidate of [stopped, retired]) {
            assert.equal(
              (
                await gateway.getProvider(
                  name,
                  candidate.provider.name,
                  AbortSignal.timeout(10_000),
                )
              )?.labels["openclaw.dev/revision-id"],
              candidate.revision.id,
            );
          }
          await clusterCommand("delete", "namespace", name, "--wait=true", "--timeout=120s");
          assert.equal(
            (await gateway.getWorkspace(name, AbortSignal.timeout(10_000)))?.id,
            boundWorkspace.id,
          );
          assert.equal(
            (await api("POST", `${stopped.agentPath}/stop`, undefined, 202)).desiredRuntimeState,
            "stopped",
          );
        } finally {
          await setWorkerReplicas(1);
        }
        await waitForObservation("ordinary Agent stop after placement loss", async () =>
          (await workerEvents()).some(
            (event) =>
              event.agentId === stopped.agentId &&
              event.operation === "agent.stop" &&
              event.result === "success",
          ),
        );
        assert.equal(
          await gateway.getProvider(name, stopped.provider.name, AbortSignal.timeout(10_000)),
          undefined,
        );
        assert.equal(
          (await api("GET", `${stopped.agentPath}/revisions/${stopped.revision.id}`)).id,
          stopped.revision.id,
        );
        assert.equal(
          (await gateway.getProvider(name, retired.provider.name, AbortSignal.timeout(10_000)))
            ?.labels["openclaw.dev/revision-id"],
          retired.revision.id,
          "stopping one Agent must preserve another candidate's real Provider",
        );

        assert.equal((await api("DELETE", retired.agentPath, undefined, 202)).status, "deleting");
        await waitForObservation(
          "ordinary Agent deletion retirement after placement loss",
          async () =>
            (await workerEvents()).some(
              (event) =>
                event.agentId === retired.agentId &&
                event.operation === "agent.delete" &&
                event.result === "success",
            ),
        );
        assert.equal((await api("GET", retired.agentPath, undefined, 404)).code, "NOT_FOUND");
        assert.equal(
          await gateway.getProvider(name, retired.provider.name, AbortSignal.timeout(10_000)),
          undefined,
        );
        for (const candidate of [stopped, retired]) {
          assert.equal(
            await gateway.getSandbox(
              { workspace: name, name: candidate.sandbox },
              AbortSignal.timeout(10_000),
            ),
            undefined,
          );
        }
        assert.equal(
          (await gateway.getWorkspace(name, AbortSignal.timeout(10_000)))?.id,
          boundWorkspace.id,
        );
        assert.equal((await namespaceCli("get", logical.id)).status, "ready");
        assert.equal(
          (
            await gateway.getProvider(
              name,
              openShellProviderName(modelSource.id),
              AbortSignal.timeout(10_000),
            )
          )?.name,
          openShellProviderName(modelSource.id),
          "revision cleanup must preserve the canonical shared source Provider",
        );
      },
    );
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
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "oce-dev-up-openshell-compose-real-"),
    );
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
      if (existsSync(stateDirectory)) {
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

    const result = await startDevelopment(environment);
    assert.match(result.stdout, /Control plane: Compose/);
    assert.match(result.stdout, /Sandbox Driver: openshell/);

    // The authenticated OCC API is served by Compose while its worker creates
    // the operator-mode OpenShell Workspace through the real k3d cluster.
    const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    assert.equal(state.cluster, cluster);
    assert.equal(state.sandboxDriver, "openshell");
    assert.equal(state.deploymentMode, undefined);
    assert.equal(existsSync(join(stateDirectory, "compose.yaml")), true);
    // Routing rewrites must keep the individually mounted Installation readable
    // by the non-root control plane; the enclosing state directory stays private.
    assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(stateDirectory, "installation.yaml"))).mode & 0o777, 0o644);
    const installation = loadYaml(
      await readFile(join(stateDirectory, "installation.yaml"), "utf8"),
    );
    const compute = installation.drivers.compute.configuration;
    assert.deepEqual(compute.gatewayRouting, {
      gatewayName: "openclaw-enterprise-agent-gateways",
      gatewayNamespace: "oce-system",
      envoyNamespace: "envoy-gateway-system",
      hostname: `k3d-${cluster}-server-0`,
      endpointPort: compute.gatewayRouting.endpointPort,
    });
    assert.ok(Number.isInteger(compute.gatewayRouting.endpointPort));
    assert.ok(compute.gatewayRouting.endpointPort > 0);
    assert.equal(compute.network.gatewayClients, undefined);
    for (const path of ["gateway-api-key", "gateway-ca.crt"]) {
      assert.equal((await stat(join(stateDirectory, path))).mode & 0o077, 0);
    }
    const compose = loadYaml(await readFile(join(stateDirectory, "compose.yaml"), "utf8"));
    for (const serviceName of ["controller", "worker-kubernetes"]) {
      const service = compose.services[serviceName];
      assert.equal(
        service.environment.OCC_GATEWAY_API_KEY_PATH,
        "/run/openclaw-development/gateway-api-key",
      );
      assert.equal(
        service.environment.NODE_EXTRA_CA_CERTS,
        "/run/openclaw-development/gateway-ca.crt",
      );
      assert.ok(
        service.volumes.some(
          ({ source, target, read_only: readOnly }) =>
            source === join(stateDirectory, "gateway-api-key") &&
            target === "/run/openclaw-development/gateway-api-key" &&
            readOnly === true,
        ),
      );
      assert.ok(
        service.volumes.some(
          ({ source, target, read_only: readOnly }) =>
            source === join(stateDirectory, "gateway-ca.crt") &&
            target === "/run/openclaw-development/gateway-ca.crt" &&
            readOnly === true,
        ),
      );
    }
    const kubectl = [
      "--kubeconfig",
      join(stateDirectory, "kubeconfig"),
      "--context",
      `k3d-${cluster}`,
    ];
    const envoySelector =
      "app.kubernetes.io/component=proxy,app.kubernetes.io/managed-by=envoy-gateway," +
      "gateway.envoyproxy.io/owning-gateway-namespace=oce-system," +
      "gateway.envoyproxy.io/owning-gateway-name=openclaw-enterprise-agent-gateways";
    const envoyPods = JSON.parse(
      (
        await execute(
          "kubectl",
          [
            ...kubectl,
            "get",
            "pods",
            "--namespace",
            "envoy-gateway-system",
            "-l",
            envoySelector,
            "-o",
            "json",
          ],
          { cwd: repository, env: environment, maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout,
    );
    const envoyProxyCidrs = envoyPods.items.map(({ status }) => `${status.podIP}/32`).toSorted();
    assert.ok(envoyProxyCidrs.length > 0);
    // Only Envoy may supply trusted client-attribution headers. Trusting the whole Pod
    // CIDR would misclassify OpenShell's transparent proxy and reject node enrollment.
    assert.deepEqual(compute.network.gatewayTrustedProxyCidrs, envoyProxyCidrs);
    const routedGateway = JSON.parse(
      (
        await execute(
          "kubectl",
          [
            ...kubectl,
            "get",
            "gateway",
            "openclaw-enterprise-agent-gateways",
            "--namespace",
            "oce-system",
            "-o",
            "json",
          ],
          { cwd: repository, env: environment, maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout,
    );
    assert.equal(
      routedGateway.status.conditions.some(
        ({ type, status }) => type === "Programmed" && status === "True",
      ),
      true,
    );
    const envoyServices = JSON.parse(
      (
        await execute(
          "kubectl",
          [
            ...kubectl,
            "get",
            "services",
            "--namespace",
            "envoy-gateway-system",
            "-l",
            envoySelector,
            "-o",
            "json",
          ],
          { cwd: repository, env: environment, maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout,
    );
    const envoyService = envoyServices.items.find(({ spec }) => spec.type === "NodePort");
    assert.ok(envoyService);
    assert.equal(
      envoyService.spec.ports.find(({ port }) => port === 443)?.nodePort,
      compute.gatewayRouting.endpointPort,
    );
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
    assert.deepEqual(compute.network.providerHarness, {
      namespace: "openshell-system",
      podLabels: {
        "app.kubernetes.io/name": "openshell",
        "app.kubernetes.io/instance": "openshell-gateway",
      },
      address: service.spec.clusterIP,
      port: 8080,
    });
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
    t.after(() => stopProcess(forward));
    await waitForPort(forward, gatewayPort, () => forwardError);
    const gateway = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${gatewayPort}`,
      auth: { mode: "unauthenticated" },
    });
    t.after(() => gateway.close());
    const workspace = await gateway.getWorkspace(namespace, AbortSignal.timeout(10_000));
    assert.equal(workspace?.name, namespace);
    assert.equal(workspace?.labels["app.kubernetes.io/managed-by"], "openclaw-enterprise");

    await stopProcess(forward);
    await execute(devDown, [], {
      cwd: repository,
      env: environment,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(existsSync(stateDirectory), false);
  },
);
