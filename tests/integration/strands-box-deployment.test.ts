import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { digest as hostRequirementsDigest } from "../../deploy/examples/strands-box/host/control.ts";
import type {
  Agent,
  HarnessWorkloadRequirements,
  Namespace,
} from "../../packages/contracts/src/index.ts";
import { PostgresWorkQueue } from "../../packages/occ/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { cleanupNamespaces } from "../helpers/postgres-backend-state.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { grantAgentSecretOperate } from "../helpers/postgres-harness-auth.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { waitFor } from "../helpers/wait-for.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const driverSource = join(repository, "deploy/examples/strands-box/driver");
const packageName = "@openclaw-enterprise/example-strands-box-driver";
const implementation = `${packageName}@0.1.0`;
const sandboxId = "strands-box-demo";
const modelOrigin = "https://model.pilot.svc.cluster.local/v1";
const modelMarker = "openclaw-strands-controlled-inference-v1";
const setupCode = "test-only-workspace-setup-code";

interface ObjectRef {
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly namespace?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly uid?: string;
    readonly resourceVersion?: string;
    readonly generation?: number;
  };
}

type ApiObject = ObjectRef & {
  readonly status?: Readonly<Record<string, unknown>>;
  readonly spec?: Readonly<Record<string, unknown>>;
  readonly data?: Readonly<Record<string, string>>;
  readonly stringData?: Readonly<Record<string, string>>;
};

// Only the Kubernetes API boundary is controlled. Store the stock drivers' actual
// objects, and let the test separately observe the prerequisite Gateway rollout.
function kubernetesApi(workspaceVolume: { claimUid: string; volumeName: string }) {
  const objects = new Map<string, ApiObject>();
  const providerSecretReads: string[] = [];
  const missing = () => Object.assign(new Error("Fixture object is absent"), { statusCode: 404 });
  const key = (kind: string, name: string, namespace = "") => `${kind}:${namespace}:${name}`;
  const get = (kind: string, name: string, namespace?: string) =>
    structuredClone(objects.get(key(kind, name, namespace)));
  function read(kind: string, name: string, namespace?: string): ApiObject {
    const value = get(kind, name, namespace);
    if (value === undefined) {
      throw missing();
    }
    return value;
  }
  function save(body: ApiObject): ApiObject {
    const old = get(body.kind, body.metadata.name, body.metadata.namespace);
    const { stringData, ...resource } = body;
    const value = {
      ...old,
      ...resource,
      ...(body.kind === "Namespace" ? { status: { phase: "Active" } } : {}),
      ...(body.kind === "PersistentVolumeClaim" &&
      body.metadata.name.startsWith("workspace-") &&
      old === undefined
        ? {
            status: { phase: "Bound" },
            spec: { ...resource.spec, volumeName: workspaceVolume.volumeName },
          }
        : {}),
      metadata: {
        ...old?.metadata,
        ...body.metadata,
        uid:
          old?.metadata.uid ??
          (body.kind === "PersistentVolumeClaim" && body.metadata.name.startsWith("workspace-")
            ? workspaceVolume.claimUid
            : randomUUID()),
        resourceVersion: String(Number(old?.metadata.resourceVersion ?? 0) + 1),
        generation: old?.metadata.generation ?? 1,
      },
      ...(stringData === undefined
        ? {}
        : {
            data: {
              ...body.data,
              ...Object.fromEntries(
                Object.entries(stringData).map(([name, text]) => [
                  name,
                  Buffer.from(text).toString("base64"),
                ]),
              ),
            },
          }),
    };
    objects.set(key(value.kind, value.metadata.name, value.metadata.namespace), value);
    return structuredClone(value);
  }
  function list(kind: string, namespace?: string, labelSelector?: string) {
    return {
      items: [...objects.values()].filter(
        (value) =>
          value.kind === kind &&
          (namespace === undefined || value.metadata.namespace === namespace) &&
          (labelSelector === undefined ||
            labelSelector.split(",").every((filter) => {
              const [name, label] = filter.split("=");
              const actual = value.metadata.labels?.[name!];
              return label === undefined ? actual !== undefined : actual === label;
            })),
      ),
    };
  }
  type Request = {
    readonly name: string;
    readonly namespace?: string;
    readonly labelSelector?: string;
  };
  type Write = { readonly body: ApiObject };
  function resourceMethods(kinds: readonly string[]) {
    return Object.fromEntries(
      kinds.flatMap((kind) => {
        const resource = kind === "Namespace" ? kind : `Namespaced${kind}`;
        return [
          [`read${resource}`, ({ name, namespace }: Request) => read(kind, name, namespace)],
          [
            `list${resource}`,
            ({ namespace, labelSelector }: Request) => list(kind, namespace, labelSelector),
          ],
          ...["create", "patch", "replace"].map((verb) => [
            `${verb}${resource}`,
            ({ body }: Write) => save(body),
          ]),
        ];
      }),
    );
  }
  const core = resourceMethods([
    "Namespace",
    "ConfigMap",
    "Secret",
    "Service",
    "ServiceAccount",
    "PersistentVolumeClaim",
    "Pod",
    "ResourceQuota",
    "LimitRange",
  ]);
  const clients = {
    server: "http://127.0.0.1",
    core,
    apps: resourceMethods(["Deployment"]),
    networking: resourceMethods(["NetworkPolicy"]),
    objects: {
      read: ({ kind, metadata }: ObjectRef) => {
        if (kind === "Secret") {
          providerSecretReads.push(metadata.name);
        }
        return read(kind, metadata.name, metadata.namespace);
      },
      create: save,
      patch: save,
      delete: () => assert.fail("the held Driver must not delete Kubernetes objects"),
      list: (_version: string, kind: string, namespace: string) => list(kind, namespace),
    },
    version: {
      async getCode() {
        return { gitVersion: "v1.35.0" };
      },
    },
    discovery: {
      async listNamespacedEndpointSlice({ namespace, labelSelector }: Request) {
        const name = labelSelector?.split("=")[1];
        const service = name === undefined ? undefined : get("Service", name, namespace);
        return {
          items:
            service === undefined
              ? []
              : [
                  {
                    metadata: {
                      labels: { "kubernetes.io/service-name": name },
                      ownerReferences: [{ kind: "Service", name, uid: service.metadata.uid }],
                    },
                    endpoints: [{ conditions: { ready: true } }],
                  },
                ],
        };
      },
    },
  };
  return { clients, get, save, objects, providerSecretReads };
}

async function installedPackage(t: TestContext) {
  const directory = await temporaryDirectory(t, "strands-worker-");
  const packageRoot = join(directory, "controller");
  const scope = join(packageRoot, "node_modules", "@openclaw-enterprise");
  const installed = join(scope, "example-strands-box-driver");
  const staging = join(directory, "package");
  await mkdir(staging);
  await mkdir(installed, { recursive: true });
  await cp(join(driverSource, "package.json"), join(staging, "package.json"));
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ dependencies: { [packageName]: "0.1.0" } }),
  );
  for (const peer of ["occ", "utils", "contracts"]) {
    await symlink(join(repository, "packages", peer), join(scope, peer), "dir");
  }
  execFileSync(process.execPath, [join(driverSource, "build.ts"), join(staging, "dist")], {
    cwd: repository,
  });
  execFileSync("pnpm", ["pack", "--pack-destination", directory], { cwd: staging, stdio: "pipe" });
  const archive = "openclaw-enterprise-example-strands-box-driver-0.1.0.tgz";
  execFileSync("tar", ["-xzf", join(directory, archive), "--strip-components=1", "-C", installed]);
  const caPath = join(directory, "ca.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=Strands Box Worker fixture CA",
      "-days",
      "1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-keyout",
      join(directory, "ca.key"),
      "-out",
      caPath,
    ],
    { stdio: "ignore" },
  );
  return { directory, packageRoot, ca: await readFile(caPath, "utf8") };
}

interface Admission {
  readonly owner: {
    readonly namespaceId: string;
    readonly namespaceName: string;
    readonly driverId: string;
    readonly implementation: string;
    readonly agentId: string;
    readonly revisionId: string;
  };
  readonly requirementsDigest: string;
  readonly requirements: HarnessWorkloadRequirements;
  readonly workspaceVolume: { readonly claimUid: string; readonly volumeName: string };
}

// This wire peer exercises the real installed Driver through its hold boundary.
// It has no launch, authenticated native endpoint, or approval authority.
async function heldHostPeer(
  t: TestContext,
  directory: string,
  expectedVolume: Admission["workspaceVolume"],
) {
  const path = join(directory, "control.sock");
  const calls: string[] = [];
  const admissions: Admission[] = [];
  const server = createServer(async (request, response) => {
    const operation = `${request.method} ${request.url}`;
    calls.push(operation);
    if (operation === "GET /v1/execution") {
      response.writeHead(404).end();
      return;
    }
    if (operation === "POST /v1/admission") {
      const admission = (await json(request)) as Admission;
      admissions.push(admission);
      if (
        admission.workspaceVolume.claimUid !== expectedVolume.claimUid ||
        admission.workspaceVolume.volumeName !== expectedVolume.volumeName
      ) {
        response.writeHead(409).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          state: "held",
          owner: admission.owner,
          requirementsDigest: admission.requirementsDigest,
          workspaceNodeMode: "file-only-v1",
          workspaceVolume: admission.workspaceVolume,
        }),
      );
      return;
    }
    response.writeHead(409).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  await chmod(path, 0o600);
  return { path, calls, admissions };
}

test(
  "the normal Worker holds an installed file-only Box deployment on its exact bound workspace claim",
  {
    ...requiresPostgres,
    timeout: 60_000,
  },
  async (t) => {
    assert.ok(databaseUrl);
    const installed = await installedPackage(t);
    const workspaceVolume = { claimUid: randomUUID(), volumeName: "pilot-workspace-volume" };
    const host = await heldHostPeer(t, installed.directory, workspaceVolume);
    const api = kubernetesApi(workspaceVolume);
    const fixture = await createPostgresAgentApp(t, {
      label: "strands-box",
      authSecret: "test-only-strands-box-controller-session-secret",
      controllerOptions: { recordOperations: true },
    });
    const createNamespace = await fixture.inject("POST", "/namespaces", {
      name: `Strands Box ${randomUUID()}`,
    });
    assert.equal(createNamespace.statusCode, 201, createNamespace.body);
    const namespace = createNamespace.json<{ data: Namespace }>().data;
    const kubeNamespace = kubernetesNamespaceName(namespace.id);
    t.after(async () => {
      const cleanup = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      try {
        await cleanupNamespaces(cleanup, [namespace.id]);
      } finally {
        await cleanup.end();
      }
    });
    const base = createInstallationDriverConfiguration();
    const stock = base.drivers.compute.configuration;
    const { gatewayClients: _gatewayClients, ...network } = stock.network;
    const path = join(installed.packageRoot, "installation.json");
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        presets: { includeDefaults: false },
        drivers: {
          ...base.drivers,
          sandbox: {
            id: sandboxId,
            package: packageName,
            configuration: {
              namespace: kubeNamespace,
              controlSocket: host.path,
              nativeEndpoint: `wss://box-harness.${kubeNamespace}.svc.cluster.local:8443/`,
              nativeCaBundle: installed.ca,
              workspaceRoot: "/home/node/workspace",
              controlledInference: { modelBaseUrl: modelOrigin },
              workspaceNodeMode: "file-only-v1",
              relay: {
                image: `registry.example/relay@sha256:${"f".repeat(64)}`,
                hostAddress: "10.0.0.7",
                installation: "pilot",
                workerPeer: { namespace: "occ-system", podLabels: { app: "worker" } },
              },
            },
          },
          compute: {
            ...base.drivers.compute,
            configuration: {
              ...stock,
              servicePrincipalCredentials: { mode: "disabled" },
              gatewayRouting: {
                hostname: "agents.example.test",
                gatewayName: "gateways",
                gatewayNamespace: "occ-system",
                envoyNamespace: "envoy",
              },
              network: {
                ...network,
                providerHarness: {
                  namespace: kubeNamespace,
                  address: "10.43.0.50",
                  port: 8443,
                  podLabels: {
                    "app.kubernetes.io/name": "box-harness-relay",
                    "box.openclaw.dev/installation": "pilot",
                  },
                },
              },
              runtime: {
                ...stock.runtime,
                modelProvider: { protocol: "openai-responses", baseUrl: modelOrigin },
              },
            },
          },
        },
      }),
    );
    const drivers = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: path },
      packageRoot: installed.packageRoot,
    });
    assert.ok(drivers?.sandboxDriver);
    assert.equal(drivers.sandboxDriver.implementation, implementation);
    assert.equal(drivers.protectedDriver, undefined);
    assert.ok(drivers.computeDriver instanceof KubernetesComputeDriver);
    const enrollmentRequests: string[] = [];
    Object.assign(drivers.computeDriver, {
      apiClients: Promise.resolve(api.clients),
      nodeEnrollment: {
        async createSetup(_gateway: string, nodeUrl: string) {
          enrollmentRequests.push(nodeUrl);
          return { setupId: "fixture-node-setup", setupCode, expiresAtMs: Date.now() + 60_000 };
        },
      },
    });
    for (const driver of [drivers.configurationDriver, drivers.secretDriver]) {
      Object.assign(driver, { client: Promise.resolve(api.clients.core) });
    }
    for (const driver of [
      drivers.computeDriver,
      drivers.configurationDriver,
      drivers.secretDriver,
      drivers.sandboxDriver,
    ]) {
      fixture.controller.registerDriver(driver);
      fixture.controller.selectDriver(driver.capability, driver.id);
    }
    const preparedNamespace = await fixture.controller.handleNamespaceLifecycle(
      fixture.principal.id,
      namespace.id,
      "ready",
    );
    assert.equal(preparedNamespace?.status, "ready");
    const nsPath = `/namespaces/${namespace.id}`;
    const config = await fixture.inject("POST", `${nsPath}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("codex", "gpt-4.1"),
    });
    assert.equal(config.statusCode, 201, config.body);
    const secret = await fixture.inject("POST", `${nsPath}/secrets`, {
      name: "Controlled model fixture marker",
      value: modelMarker,
    });
    assert.equal(secret.statusCode, 201, secret.body);
    const source = secret.json<{
      data: { ref: { kind: "secret"; namespaceId: string; id: string } };
    }>().data.ref;
    const agentResult = await fixture.inject("POST", `${nsPath}/agents`, {
      name: "Dedicated Strands Box fixture",
      executionMode: "dedicated",
      configurationId: config.json<{ data: { id: string } }>().data.id,
      harnessAuth: { method: "api_key", source },
    });
    assert.equal(agentResult.statusCode, 201, agentResult.body);
    const agent = agentResult.json<{ data: Agent }>().data;
    await grantAgentSecretOperate(fixture.pool, agent, source.id);
    const admitted = await fixture.inject("POST", `${nsPath}/agents/${agent.id}/deploy`);
    assert.equal(admitted.statusCode, 202, admitted.body);
    const [revision] = await fixture.state.read((view) =>
      view.revisions.listRevisions(namespace.id, agent.id),
    );
    assert.ok(revision);
    assert.equal(revision.harness.mode, "dedicated");
    assert.equal(revision.sandboxDriverId, sandboxId);
    assert.equal(revision.executionAdmission?.mode, "unprotected");

    const events: Readonly<Record<string, unknown>>[] = [];
    const worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl, max: 4 }),
      drivers,
      mode: "production",
      pollIntervalMs: 20,
      emit: (event) => events.push(event),
    });
    t.after(() => worker.stop());
    await worker.start();
    const gatewayName = `gateway-${createHash("sha256").update(agent.id).digest("hex").slice(0, 12)}`;
    const gateway: ApiObject = await waitFor(
      () =>
        `the Worker-created prerequisite Gateway Deployment; events: ${JSON.stringify(events.filter(({ event }) => event !== "worker.error").slice(-12))}`,
      () => api.get("Deployment", gatewayName, kubeNamespace),
    );
    assert.deepEqual(
      host.admissions,
      [],
      "Compute waits for the Gateway before provisioning the Harness",
    );
    // Observe only the fake Kubernetes Gateway's rollout. No relay, Harness, or node
    // readiness is synthesized, so the Agent cannot activate in this test.
    api.save({
      ...gateway,
      status: {
        observedGeneration: gateway.metadata.generation,
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
      },
    });

    const admission: Admission = await waitFor(
      () =>
        `the installed Box Driver's Unix hold request; events: ${JSON.stringify(events.filter(({ event }) => event !== "worker.error").slice(-12))}`,
      () => host.admissions[0],
    );
    await waitFor(
      () =>
        `the Worker's attributable pending result; events: ${JSON.stringify(events.slice(-12))}`,
      () =>
        events.find(
          (event) =>
            event.event === "worker.completed" &&
            event.revisionId === revision.id &&
            event.outcome === "pending" &&
            event.code === "SANDBOX_GATEWAY_UNAVAILABLE",
        ),
    );
    await worker.stopLoop();
    assert.deepEqual(admission.owner, {
      driverId: sandboxId,
      implementation,
      namespaceId: namespace.id,
      namespaceName: kubeNamespace,
      agentId: agent.id,
      revisionId: revision.id,
    });
    assert.equal(admission.requirementsDigest, hostRequirementsDigest(admission.requirements));
    assert.equal(admission.requirements.labels["openclaw.dev/revision"], revision.id);
    assert.deepEqual(admission.requirements.command.slice(0, 5), [
      "/usr/bin/tini",
      "-s",
      "-e",
      "143",
      "--",
    ]);
    assert.ok(
      admission.requirements.workspaceMounts.some(
        ({ mountPath }) => mountPath === "/home/node/workspace",
      ),
    );
    assert.match(
      JSON.stringify(
        admission.requirements.environment.find(({ name }) => name === "APP_TOKEN_SHA"),
      ),
      /[a-f0-9]{64}/,
    );
    assert.ok(
      admission.requirements.environment.some(({ name }) => name === "OPENCLAW_NODE_SETUP_CODE"),
    );
    assert.ok(admission.requirements.environment.some(({ name }) => name === "OPENAI_API_KEY"));
    assert.ok(!admission.requirements.environment.some(({ name }) => name === "APP_SERVER_TOKEN"));
    assert.deepEqual(api.providerSecretReads, [], "the packed Driver reads no Secrets while held");
    const workspaceClaim = admission.requirements.workspaceMounts.find(
      ({ mountPath }) => mountPath === "/home/node/workspace",
    );
    assert.ok(workspaceClaim);
    const claim = api.get("PersistentVolumeClaim", workspaceClaim.claimName, kubeNamespace);
    assert.ok(claim);
    assert.equal(claim.metadata.uid, workspaceVolume.claimUid);
    assert.equal(claim.spec?.volumeName, workspaceVolume.volumeName);
    assert.deepEqual(admission.workspaceVolume, workspaceVolume);
    api.save({ ...claim, spec: { ...claim.spec, volumeName: "replacement-volume" } });
    const previousHostCalls = host.calls.length;
    await assert.rejects(
      drivers.sandboxDriver.provisionHarness!({
        namespace: { ...namespace, name: kubeNamespace },
        revision,
        requirements: admission.requirements,
        kubernetes: api.clients.objects,
        signal: new AbortController().signal,
      }),
      /did not confirm the exact pending workload/,
    );
    assert.deepEqual(host.calls.slice(previousHostCalls), [
      "GET /v1/execution",
      "POST /v1/admission",
    ]);
    assert.deepEqual(api.providerSecretReads, [], "a replacement claim cannot reach a Secret read");
    assert.ok(!JSON.stringify(admission).includes(setupCode));
    assert.ok(!JSON.stringify(admission).includes(modelMarker));
    assert.ok(
      enrollmentRequests.some((url) => url.includes(`/${agent.id}`) && url.endsWith("/node")),
    );
    assert.ok(
      host.calls.every((call) => call === "GET /v1/execution" || call === "POST /v1/admission"),
    );
    assert.ok(
      ![...api.objects.values()].some(
        ({ metadata }) => metadata.labels?.["app.kubernetes.io/name"] === "box-harness-relay",
      ),
    );
    const work = await new PostgresWorkQueue(fixture.pool).findWork(
      `agent_revision:${revision.id}:reconcile`,
    );
    assert.ok(work);
    assert.equal(work.state, "queued");
    assert.equal(work.attemptCount, 0);
    const stored = await fixture.state.read((view) =>
      view.agents.findAgent(namespace.id, agent.id),
    );
    assert.ok(stored);
    assert.equal(stored.activeRevisionId, undefined);
  },
);
