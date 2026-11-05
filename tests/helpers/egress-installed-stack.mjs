import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createManagedWorkloadExec } from "./egress-managed-workload-exec.mjs";
import { enforcementCapabilities } from "./egress-installed-agent.mjs";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { createRealKubernetesFixture } from "./kubernetes-real.mjs";
import { createOpenShellKubernetesFixture } from "./openshell-kubernetes-real.mjs";
import {
  assertConnectedResponse,
  takeConnectedControllerBinding,
  validateConnectedInputs,
  validateConnectedDatabaseUrl,
  serializeConnectedRequest,
  sendConnectedRequest,
} from "./egress-connected-inputs.mjs";

export async function arrangeRealPrerequisites(t, progress, inputsPath, profile = {}) {
  assert.equal(process.env.OCC_TEST_EGRESS_CONNECTED, "1");
  assert.ok(inputsPath, "OCC_TEST_EGRESS_CONNECTED_INPUTS must name the exact prepared stack");
  const controller = takeConnectedControllerBinding(process.env);
  const input = validateConnectedInputs(
    JSON.parse(await readFile(inputsPath, "utf8")),
    controller,
    profile,
  );
  const databaseUrl = validateConnectedDatabaseUrl(process.env.OCC_TEST_DATABASE_URL);
  const selection = {
    kubeconfigPath: input.kubeconfigPath,
    kubernetesContext: input.kubernetesContext,
    gatewayImage: input.images.gateway,
    codexImage: input.images.agent,
    databaseUrl,
  };
  const base = createRealKubernetesFixture(selection);
  // Keep the existing loopback k3d and disposable-database guards. The legacy
  // fixture's real-provider-key prerequisite belongs to its separate smoke lane.
  progress.stage = "cluster-prerequisites";
  await base.validatePrerequisites();
  const f = createOpenShellKubernetesFixture({
    ...selection,
    openShellGatewayImage: input.images.openShellGateway,
    openShellSandboxImage: input.images.sandbox,
    openShellSupervisorImage: input.images.supervisor,
    openShellRuntimeClass: input.runtimeClass,
    commandTimeoutMs: 120_000,
    signal: t.signal,
  });
  return { input, controller, selection, databaseUrl, f };
}

export async function createRunEvidence(t, setup, progress) {
  const { input, controller } = setup;
  const runId = randomUUID();
  const directory = resolve(".build/egress-connected", `runtime-${runId}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  t.diagnostic(`egress-connected evidence-directory .build/egress-connected/runtime-${runId}`);
  const ledger = {
    runId,
    startedAt: new Date().toISOString(),
    oceCommit: input.oceCommit,
    supplierCommit: input.supplierCommit,
    images: input.images,
    namespaceId: controller.namespaceId,
    resources: [],
    phases: [],
    cleanup: "pending",
  };
  // An admitted client can still be pending when we dispatch another one. Serialize
  // atomic ledger snapshots so each pre-dispatch checkpoint is durable before its RPC.
  let writing = Promise.resolve();
  const saveLedger = () => {
    const snapshot = JSON.stringify(ledger, null, 2) + "\n";
    writing = writing.then(async () => {
      const pending = join(directory, "observations.pending.json");
      await writeFile(pending, snapshot, { mode: 0o600 });
      await rename(pending, join(directory, "observations.json"));
    });
    return writing;
  };
  const checkpoint = async (phase, details = {}, privateDetails = {}) => {
    progress.stage = phase;
    ledger.phases.push({ phase, at: new Date().toISOString(), ...details, ...privateDetails });
    await saveLedger();
    t.diagnostic(`egress-connected ${phase} ${JSON.stringify(details)}`);
  };
  const credentials = {
    initial: `SYNTHETIC-OCE-EGRESS-${runId}-v1`,
    rotated: `SYNTHETIC-OCE-EGRESS-${runId}-v2`,
  };
  const protectedValues = new Set(Object.values(credentials));
  const protect = (...values) => values.forEach((value) => protectedValues.add(value));
  const excludesCredentials = (value, label) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    for (const secret of protectedValues) {
      for (const encoded of [
        secret,
        encodeURIComponent(secret),
        JSON.stringify(secret).slice(1, -1),
        Buffer.from(secret).toString("base64"),
        Buffer.from(secret).toString("base64url"),
      ]) {
        assert.equal(
          text.includes(encoded),
          false,
          `${label} leaked synthetic credential material`,
        );
      }
    }
  };
  const request = async (method, path, body, cleanup = false) => {
    if (!cleanup) {
      t.signal.throwIfAborted();
    }
    const wire = serializeConnectedRequest(method, path, body);
    // The operation ID identifies this local attempt. Persist uncertainty before
    // sending; do not copy the controller's response, request ID or URL to this record.
    ledger.lastApi = { operationId: randomUUID(), method, outcome: "unknown" };
    await saveLedger();
    const response = await sendConnectedRequest(
      controller,
      wire,
      cleanup
        ? AbortSignal.timeout(20_000)
        : AbortSignal.any([t.signal, AbortSignal.timeout(20_000)]),
    );
    const raw = await response.text();
    excludesCredentials(raw, "controller response");
    assert.equal(
      raw.includes(controller.serviceKey),
      false,
      "controller response leaked its service key",
    );
    const captured = {
      status: response.status,
      body: raw === "" ? undefined : JSON.parse(raw),
    };
    if (captured.body !== undefined) {
      excludesCredentials(captured.body, "decoded controller response");
      assert.equal(
        JSON.stringify(captured.body).includes(controller.serviceKey),
        false,
        "decoded controller response leaked its service key",
      );
    }
    ledger.lastApi.outcome = response.ok ? "received-success-status" : "received-error-status";
    await saveLedger();
    return captured;
  };
  const api = async (method, path, body, status = 200) =>
    assertConnectedResponse(await request(method, path, body), status);
  return {
    runId,
    directory,
    ledger,
    checkpoint,
    credentials,
    protect,
    excludesCredentials,
    request,
    api,
  };
}

export async function selectLiveControllerPods({ input, f: { kubectl } }, ...options) {
  const controllerPods = JSON.parse(
    await kubectl(
      "get",
      "pods",
      "--namespace",
      input.controllerNamespace,
      "--selector",
      input.controllerSelector,
      "-o",
      "json",
      ...options,
    ),
  ).items;
  assert.ok(controllerPods.length > 0, "candidate controller Pod is required");
  for (const component of ["api", "worker"]) {
    assert.ok(
      controllerPods.some(
        ({ metadata }) => metadata.labels?.["app.kubernetes.io/component"] === component,
      ),
      `the prepared controller selector must include the ${component} Pod`,
    );
  }
  for (const pod of controllerPods) {
    const { name, namespace, deletionTimestamp, labels } = pod.metadata;
    assert.equal(namespace, input.controllerNamespace);
    assert.ok(["api", "worker"].includes(labels["app.kubernetes.io/component"]));
    assert.ok(!deletionTimestamp, `${name} is terminating`);
    assert.ok(
      pod.spec.containers.some(({ image }) => image === input.images.controller),
      `${name} must use the candidate controller image`,
    );
    assert.ok(
      pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
    );
  }
  return controllerPods;
}

export async function observePreparedStack(t, setup, evidence, progress) {
  const {
    input,
    databaseUrl,
    controller,
    f: { kubectl },
  } = setup;
  const { api } = evidence;
  const namespacePath = `/namespaces/${controller.namespaceId}`;
  progress.stage = "prepared-stack-observation";
  const namespace = await api("GET", namespacePath);
  assert.equal(namespace.status, "ready");
  const placements = JSON.parse(await kubectl("get", "namespaces", "-o", "json")).items.filter(
    ({ metadata }) => metadata.labels?.["openclaw.dev/namespace"] === namespace.id,
  );
  assert.equal(placements.length, 1, "select a single-cluster tenant placement");
  const placement = placements[0].metadata.name;
  const controllerPods = await selectLiveControllerPods(setup);
  const gateway = new OpenShellGateway(input.openShellBackend);
  t.after(() => gateway.close());
  const gatewayClient = gateway.clientForNamespace(placement);
  const info = await gatewayClient.getGatewayInfo(AbortSignal.timeout(10_000));
  assert.ok(
    info.extensions?.some((extension) =>
      enforcementCapabilities(input).every(
        (capability) =>
          extension.required_capabilities?.includes(capability) &&
          extension.supported_capabilities?.includes(capability),
      ),
    ),
    "matching protected counterpart is required",
  );
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  t.after(() => pool.end());
  const role = await pool.query("SELECT current_user AS role");
  assert.equal(role.rows[0].role, "occ_app", "observe through the limited application role");
  const installation = await api("GET", "/installation");
  const persistedInstallation = await pool.query("SELECT id FROM occ.installation");
  assert.deepEqual(
    persistedInstallation.rows,
    [{ id: installation.id }],
    "the observer must use this controller's database",
  );
  const supplierPods = JSON.parse(
    await kubectl(
      "get",
      "pods",
      "--namespace",
      input.openShellGatewayNamespace,
      "--selector",
      input.openShellGatewaySelector,
      "-o",
      "json",
    ),
  ).items;
  assert.ok(supplierPods.length > 0, "candidate OpenShell gateway Pod is required");
  for (const pod of supplierPods) {
    assert.ok(pod.spec.containers.some(({ image }) => image === input.images.openShellGateway));
    assert.ok(
      pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
    );
  }
  const execWorkload = createManagedWorkloadExec(t, {
    backend: input.openShellBackend,
    workspace: placement,
    gatewayClient,
    checkpoint: evidence.checkpoint,
  });
  return {
    namespacePath,
    namespace,
    placement,
    controllerPods,
    gatewayClient,
    pool,
    installation,
    execWorkload,
  };
}
