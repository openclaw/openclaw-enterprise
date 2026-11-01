import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { availablePort } from "../helpers/available-port.mjs";
import { stopProcess } from "../helpers/stop-process.mjs";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const occ = join(repository, "bin", "occ");
const selected = process.env.OCC_TEST_DEV_UP_OPENSHELL_LOCAL_ENDPOINT_REAL === "1";
const { loadYaml } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "@kubernetes/client-node",
) as { loadYaml: (input: string) => unknown };

interface Metadata {
  name: string;
  namespace?: string;
  uid: string;
  resourceVersion: string;
  deletionTimestamp?: string;
  finalizers?: string[];
  labels?: Record<string, string>;
}

interface LogicalNamespace {
  id: string;
  name: string;
  status: string;
}

interface Resource {
  metadata: Metadata;
}

interface StartupSecret extends Resource {
  apiVersion: string;
  kind: string;
  type: string;
  data: Record<string, string>;
}

interface StartupConfiguration {
  backend: {
    id: string;
    type: string;
    configuration: Record<string, unknown>;
  }[];
  drivers: { sandbox: { configuration: { gateway: Record<string, unknown> } } };
}

async function waitFor<T>(description: string, observe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const observed = await observe();
    if (observed !== undefined) {
      return observed;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

test(
  "real worker completes Namespace cleanup after its bare OpenShell service disappears",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_DEV_UP_OPENSHELL_LOCAL_ENDPOINT_REAL=1 for the owned model-free development stack.",
    timeout: 1_800_000,
  },
  async (t) => {
    await access(occ);
    const root = await mkdtemp(join(await realpath(tmpdir()), "oce-openshell-local-cleanup-"));
    const stateDirectory = join(root, "state");
    const suffix = randomUUID().slice(0, 8);
    const cluster = `occ-dev-os-cleanup-${suffix}`;
    const apiPort = await availablePort();
    const kubernetesPort = await availablePort();
    const environment: NodeJS.ProcessEnv = {
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
    // This proof creates no Agent and needs neither model credentials nor an ambient cluster.
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_ACCESS_TOKEN;
    delete environment.KUBECONFIG;
    delete environment.OCC_DEVELOPMENT_OPENSHELL_HELM_CHART;
    delete environment.OCC_DEVELOPMENT_OPENSHELL_WORKSPACE_HELM_CHART;
    delete environment.OCC_DEVELOPMENT_OPENSHELL_AGENT_SANDBOX_MANIFEST;

    const run = async (
      command: string,
      args: string[],
      options: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
    ): Promise<string> => {
      try {
        return (
          await execute(command, args, {
            cwd: repository,
            env: options.env ?? environment,
            timeout: options.timeout ?? 150_000,
            maxBuffer: 16 * 1024 * 1024,
          })
        ).stdout;
      } catch {
        // Child-process errors contain argv and private stdout/stderr; retain no raw cause.
        throw new Error(`Owned OpenShell cleanup fixture command failed: ${command}.`);
      }
    };

    const resources: { forward?: ChildProcess; gateway?: GrpcOpenShellGatewayClient } = {};
    t.after(async () => {
      resources.gateway?.close();
      if (resources.forward?.pid !== undefined) {
        await stopProcess(resources.forward);
      }
      if (existsSync(stateDirectory)) {
        try {
          await run(join(repository, "scripts", "dev-down"), [], { timeout: 300_000 });
        } catch {
          throw new Error(
            `Owned stack cleanup failed; recovery state remains at ${stateDirectory}.`,
          );
        }
      }
      await rm(root, { recursive: true, force: true });
    });

    const startup = await run(join(repository, "scripts", "dev-up"), [], { timeout: 1_100_000 });
    assert.ok(
      startup.includes("OpenClaw Enterprise development stack is ready"),
      "the owned development stack must report readiness",
    );
    const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8")) as {
      cluster: string;
      platformNamespace: string;
      deploymentMode: string;
      sandboxDriver: string;
    };
    assert.equal(state.cluster, cluster);
    assert.equal(state.platformNamespace, "oce-system");
    assert.equal(state.deploymentMode, "k3d");
    assert.equal(state.sandboxDriver, "openshell");

    const clusterArguments = [
      "--kubeconfig",
      join(stateDirectory, "kubeconfig"),
      "--context",
      `k3d-${cluster}`,
    ];
    const kubectl = (...args: string[]) => run("kubectl", [...clusterArguments, ...args]);
    const clusterJson = async <T>(...args: string[]): Promise<T> =>
      JSON.parse(await kubectl(...args, "--output=json")) as T;
    const occEnvironment = {
      ...environment,
      OCC_URL: `http://127.0.0.1:${apiPort}`,
      OCC_SERVICE_KEY_FILE: join(stateDirectory, "initial-admin-service-key.json"),
    };
    const namespace = async <T>(...args: string[]): Promise<T> =>
      JSON.parse(
        await run(occ, ["namespace", ...args, "--output=json"], { env: occEnvironment }),
      ) as T;
    const liveNamespace = async (id: string) =>
      (await namespace<LogicalNamespace[]>("list")).find((entry) => entry.id === id);
    const waitForLogicalDeletion = (id: string) =>
      waitFor("logical Namespace deletion", async () =>
        (await liveNamespace(id)) === undefined ? true : undefined,
      );
    const setWorkerReplicas = async (replicas: 0 | 1) => {
      await kubectl(
        "scale",
        "deployment/openclaw-enterprise-worker",
        "--namespace=oce-system",
        `--replicas=${replicas}`,
      );
      if (replicas === 0) {
        await waitFor("worker Pod termination", async () => {
          const pods = await clusterJson<{ items: Resource[] }>(
            "get",
            "pods",
            "--namespace=oce-system",
            "--selector=app.kubernetes.io/component=worker",
          );
          return pods.items.length === 0 ? true : undefined;
        });
      } else {
        await kubectl(
          "rollout",
          "status",
          "deployment/openclaw-enterprise-worker",
          "--namespace=oce-system",
          "--timeout=120s",
        );
      }
    };

    const gatewayPort = await availablePort();
    const forward = spawn(
      "kubectl",
      [
        ...clusterArguments,
        "port-forward",
        "--namespace=oce-system",
        "service/openshell-gateway",
        `${gatewayPort}:8080`,
      ],
      { cwd: repository, env: environment, stdio: ["ignore", "ignore", "ignore"] },
    );
    resources.forward = forward;
    // A missing kubectl must fail the selected prerequisite without an unhandled child error.
    let forwardFailed = false;
    forward.once("error", () => {
      forwardFailed = true;
    });
    const observer = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${gatewayPort}`,
      auth: { mode: "unauthenticated" },
      requestTimeoutMs: 1_000,
    });
    resources.gateway = observer;
    await waitFor("official central OpenShell gateway", async () => {
      assert.equal(forwardFailed, false, "the owned management port-forward must start");
      assert.equal(
        forward?.exitCode,
        null,
        "the owned management port-forward must remain running",
      );
      try {
        await observer.health(AbortSignal.timeout(2_000));
        return true;
      } catch {
        return undefined;
      }
    });

    // Remove the only existing lifecycle normally before selecting a different Backend address.
    // No live Namespace is retargeted, and its completed journal is never rewritten.
    const initial = await namespace<LogicalNamespace[]>("list");
    assert.equal(initial.length, 1);
    const bootstrapNamespace = initial[0]!;
    assert.equal(bootstrapNamespace.name, "default");
    assert.equal(bootstrapNamespace.status, "ready");
    const initialPlacements = await clusterJson<{ items: Resource[] }>(
      "get",
      "namespaces",
      `--selector=openclaw.dev/namespace=${bootstrapNamespace.id}`,
    );
    assert.equal(initialPlacements.items.length, 1);
    const initialPlacement = initialPlacements.items[0]!.metadata.name;
    assert.ok((await observer.getWorkspace(initialPlacement, AbortSignal.timeout(10_000)))?.id);
    await namespace("delete", bootstrapNamespace.id);
    await waitForLogicalDeletion(bootstrapNamespace.id);
    assert.equal(
      await observer.getWorkspace(initialPlacement, AbortSignal.timeout(10_000)),
      undefined,
    );
    assert.equal((await namespace<LogicalNamespace[]>("list")).length, 0);
    await setWorkerReplicas(0);

    const startupSecret = await clusterJson<StartupSecret>(
      "get",
      "secret",
      "occ-installation-startup",
      "--namespace=oce-system",
    );
    const configuration = loadYaml(
      Buffer.from(startupSecret.data["installation.yaml"]!, "base64").toString("utf8"),
    ) as StartupConfiguration;
    const backend = configuration.backend.find((entry) => entry.type === "openshell");
    assert.ok(backend);
    const centralEndpoint = "http://openshell-gateway.oce-system.svc.cluster.local:8080";
    assert.equal(backend.configuration.endpoint, centralEndpoint);
    assert.equal(backend.configuration.insecureTransport, "network-policy");
    assert.equal(backend.configuration.serviceName, undefined);
    assert.equal(configuration.drivers.sandbox.configuration.gateway.readiness, undefined);
    const { endpoint: originalEndpoint, ...unchangedConnection } = backend.configuration;
    assert.equal(originalEndpoint, centralEndpoint);
    const aliasName = "openshell-gateway";
    backend.configuration = { ...unchangedConnection, serviceName: aliasName };
    const installation = JSON.stringify(configuration);
    const secretManifest = join(root, "installation-startup.json");
    await writeFile(
      secretManifest,
      JSON.stringify({
        apiVersion: startupSecret.apiVersion,
        kind: startupSecret.kind,
        metadata: startupSecret.metadata,
        type: startupSecret.type,
        data: {
          ...startupSecret.data,
          "installation.yaml": Buffer.from(installation).toString("base64"),
        },
      }),
      { mode: 0o600 },
    );
    await kubectl("replace", "--filename", secretManifest);
    // The normal upgrade runs Installation validation and migration hooks. The checksum rolls
    // the API, while replicaCount=0 keeps the worker stopped until the same configuration is ready.
    await run(
      "helm",
      [
        "upgrade",
        "openclaw-enterprise",
        join(repository, "deploy", "helm", "openclaw-enterprise"),
        ...["--kubeconfig", clusterArguments[1]!, "--kube-context", clusterArguments[3]!],
        "--namespace=oce-system",
        "--reuse-values",
        "--set=worker.replicaCount=0",
        `--set-string=controlPlane.installationChecksum=${createHash("sha256").update(installation).digest("hex")}`,
        "--wait",
        "--timeout=300s",
      ],
      { timeout: 330_000 },
    );
    await setWorkerReplicas(1);
    assert.equal((await namespace<LogicalNamespace[]>("list")).length, 0);

    // The Service is operator infrastructure in an explicitly adopted Namespace. It is real
    // DNS indirection to the official gateway; neither the provider nor its transport is replaced.
    const physicalName = `os-local-${suffix}`;
    await kubectl("create", "namespace", physicalName);
    await kubectl(
      "label",
      "namespace",
      physicalName,
      "app.kubernetes.io/managed-by=Helm",
      "pod-security.kubernetes.io/enforce=restricted",
      "pod-security.kubernetes.io/audit=restricted",
      "pod-security.kubernetes.io/warn=restricted",
    );
    await kubectl(
      "annotate",
      "namespace",
      physicalName,
      "openclaw.dev/namespace-lifecycle=external",
    );
    const aliasManifest = join(root, "openshell-alias.json");
    await writeFile(
      aliasManifest,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: aliasName, namespace: physicalName },
        spec: {
          type: "ExternalName",
          externalName: "openshell-gateway.oce-system.svc.cluster.local",
          ports: [{ port: 8080, protocol: "TCP" }],
        },
      }),
      { mode: 0o600 },
    );
    await kubectl("create", "--filename", aliasManifest);
    const logical = await namespace<LogicalNamespace>(
      "create",
      `local-endpoint-${suffix}`,
      "--existing-namespace",
      physicalName,
    );
    await waitFor("adopted Namespace readiness through the bare Backend", async () => {
      const current = await liveNamespace(logical.id);
      assert.notEqual(current?.status, "failed");
      return current?.status === "ready" ? true : undefined;
    });
    const workspace = await observer.getWorkspace(physicalName, AbortSignal.timeout(10_000));
    assert.ok(workspace?.id);
    assert.equal(workspace.labels["openclaw.dev/namespace-id"], logical.id);
    const backing = await clusterJson<Resource>("get", "namespace", physicalName);
    const account = await clusterJson<Resource>(
      "get",
      "serviceaccount",
      "openshell-sandbox",
      "--namespace",
      physicalName,
    );
    const finalizer = `cleanup-test.openclaw.dev/local-${suffix}`;
    await kubectl(
      "patch",
      "serviceaccount",
      account.metadata.name,
      "--namespace",
      physicalName,
      "--type=json",
      "--patch",
      JSON.stringify([
        { op: "test", path: "/metadata/uid", value: account.metadata.uid },
        {
          op: "add",
          path: "/metadata/finalizers",
          value: [...(account.metadata.finalizers ?? []), finalizer],
        },
      ]),
    );
    await namespace("delete", logical.id);
    await waitFor("provider confirmation before the held configured-resource tail", async () => {
      const current = await clusterJson<Resource>(
        "get",
        "serviceaccount",
        account.metadata.name,
        "--namespace",
        physicalName,
      );
      assert.equal(current.metadata.uid, account.metadata.uid);
      return current.metadata.deletionTimestamp !== undefined &&
        (await observer.getWorkspace(physicalName, AbortSignal.timeout(10_000))) === undefined
        ? true
        : undefined;
    });
    assert.equal((await liveNamespace(logical.id))?.status, "deleting");
    await setWorkerReplicas(0);

    const held = await clusterJson<Resource>(
      "get",
      "serviceaccount",
      account.metadata.name,
      "--namespace",
      physicalName,
    );
    assert.equal(held.metadata.uid, account.metadata.uid);
    const finalizers = held.metadata.finalizers;
    assert.ok(finalizers !== undefined);
    assert.ok(finalizers.includes(finalizer));
    await kubectl(
      "patch",
      "serviceaccount",
      account.metadata.name,
      "--namespace",
      physicalName,
      "--type=json",
      "--patch",
      JSON.stringify([
        { op: "test", path: "/metadata/uid", value: account.metadata.uid },
        { op: "test", path: "/metadata/finalizers", value: finalizers },
        {
          op: "replace",
          path: "/metadata/finalizers",
          value: finalizers.filter((value) => value !== finalizer),
        },
      ]),
    );
    // This is an operator fixture event, not OCC's external-Namespace retention behavior:
    // removing this exact owned placement also removes the only bare-name management address.
    const beforeRemoval = await clusterJson<Resource>("get", "namespace", physicalName);
    assert.equal(beforeRemoval.metadata.uid, backing.metadata.uid);
    await kubectl("delete", "namespace", physicalName, "--wait=true", "--timeout=120s");
    assert.equal(
      (
        await kubectl("get", "namespace", physicalName, "--ignore-not-found", "--output=name")
      ).trim(),
      "",
    );

    const aliasEndpoint = `http://${aliasName}.${physicalName}.svc:8080`;
    // Fresh production clients run from the surviving API Pod's actual network position. No
    // old gRPC channel or host port-forward can make the deleted alias appear reachable.
    const probe = `
      import { GrpcOpenShellGatewayClient } from "./apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
      const observe = async (endpoint) => {
        const client = new GrpcOpenShellGatewayClient({ endpoint, requestTimeoutMs: 1000, auth: { mode: "unauthenticated" } });
        try { await client.health(AbortSignal.timeout(2000)); return "reachable"; }
        catch { return "unreachable"; }
        finally { client.close(); }
      };
      console.log(JSON.stringify({
        central: await observe(${JSON.stringify(centralEndpoint)}),
        alias: await observe(${JSON.stringify(aliasEndpoint)}),
      }));
    `;
    const reachability = JSON.parse(
      await kubectl(
        "exec",
        "deployment/openclaw-enterprise-api",
        "--namespace=oce-system",
        "--",
        "node",
        "--input-type=module",
        "--eval",
        probe,
      ),
    ) as { central: string; alias: string };
    assert.deepEqual(reachability, { central: "reachable", alias: "unreachable" });
    assert.equal(await observer.getWorkspace(physicalName, AbortSignal.timeout(10_000)), undefined);
    assert.equal((await liveNamespace(logical.id))?.status, "deleting");

    // A new worker has neither a cached provider channel nor in-memory cleanup evidence. Its
    // ordinary queued deletion must finish with the unchanged bare Backend and persisted receipt.
    await setWorkerReplicas(1);
    await waitForLogicalDeletion(logical.id);
    assert.equal(await observer.getWorkspace(physicalName, AbortSignal.timeout(10_000)), undefined);
    const finalStartup = await clusterJson<StartupSecret>(
      "get",
      "secret",
      "occ-installation-startup",
      "--namespace=oce-system",
    );
    assert.equal(
      finalStartup.data["installation.yaml"],
      Buffer.from(installation).toString("base64"),
    );
    assert.equal((await namespace<LogicalNamespace[]>("list")).length, 0);
  },
);
