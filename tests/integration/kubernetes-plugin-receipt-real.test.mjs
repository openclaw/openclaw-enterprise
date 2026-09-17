import { sha256Hex } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  configureExistingK3dLocalPathSharedFileSystem,
  createKubernetesClient,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

const execute = promisify(execFile);
const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
const fixtureImage = process.env.OCC_TEST_KUBERNETES_IMAGE;
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const selected = [kubeconfigPath, kubernetesContext, fixtureImage].some(Boolean);
const requiresKubernetes = {
  skip: selected
    ? false
    : "Set OCC_TEST_KUBERNETES_KUBECONFIG, OCC_TEST_KUBERNETES_CONTEXT, and OCC_TEST_KUBERNETES_IMAGE to run real Kubernetes receipt tests.",
};
const requiresKubernetesAndPostgres = {
  skip: !selected
    ? requiresKubernetes.skip
    : databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to a dedicated openclaw_k8s_* database to run receipt queue recovery.",
};

const pluginId = "occ-plugin:diffs";
const receiptContainer = "gateway";
const receiptFinalizer = "compute.openclaw.dev/plugin-receipt";
const receiptStateKey = "state.json";

function hash(value, length = 12) {
  return sha256Hex(value, length);
}

const { kubectl, resource, resources, waitFor } = createKubernetesClient({
  selection: { kubeconfigPath, kubernetesContext },
  waitTimeoutMs: 180_000,
  waitIntervalMs: 500,
});

async function missing(kind, name, namespace) {
  try {
    await resource(kind, name, namespace);
    return false;
  } catch (error) {
    if (/NotFound|not found/i.test(error.stderr ?? error.message)) return true;
    throw error;
  }
}

function isKubernetesObjectConflict(error) {
  return (
    error?.code === 409 ||
    /the object has been modified|Operation cannot be fulfilled/i.test(
      `${error?.body ?? ""}\n${error?.message ?? ""}`,
    )
  );
}

async function prepareRevisionEventually(fixture, driver = fixture.driver) {
  return waitFor(
    "real Compute prepareRevision to avoid transient Kubernetes conflicts",
    async () => {
      try {
        return await driver.prepareRevision(fixture.candidate, fixture.auth.context);
      } catch (error) {
        if (isKubernetesObjectConflict(error)) return undefined;
        throw error;
      }
    },
  );
}

async function assertInvalidReceiptRejected(fixture) {
  await waitFor("real Compute to reject the invalid plugin receipt", async () => {
    try {
      await fixture.driver.prepareRevision(fixture.candidate, fixture.auth.context);
      return undefined;
    } catch (error) {
      if (isKubernetesObjectConflict(error)) return undefined;
      assert.match(error.message, /Refusing invalid plugin receipt/);
      return true;
    }
  });
}

async function acknowledgeReceiptEventually(fixture, receipt) {
  await waitFor(
    "real Compute to acknowledge the plugin receipt without a transient conflict",
    async () => {
      try {
        await fixture.driver.acknowledgeRevisionReceipt(fixture.candidate, receipt);
        return true;
      } catch (error) {
        if (isKubernetesObjectConflict(error)) return undefined;
        throw error;
      }
    },
  );
}

async function assertPrerequisites() {
  assert.ok(kubeconfigPath, "OCC_TEST_KUBERNETES_KUBECONFIG is required.");
  assert.ok(kubernetesContext, "OCC_TEST_KUBERNETES_CONTEXT is required.");
  assert.ok(fixtureImage, "OCC_TEST_KUBERNETES_IMAGE must select the imported fixture server.");
  await validateExplicitK3dLoopbackContext({ kubeconfigPath, kubernetesContext });
}

function computeConfiguration() {
  const resources = {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "1", memory: "512Mi" },
  };
  return {
    authentication: { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
    images: { gateway: fixtureImage, agent: fixtureImage, requireImmutableDigest: false },
    resources: {
      gateway: resources,
      agent: resources,
      namespace: {
        quota: {
          pods: "20",
          services: "20",
          secrets: "20",
          configmaps: "30",
          persistentvolumeclaims: "10",
          "requests.cpu": "4",
          "requests.memory": "4Gi",
          "limits.cpu": "8",
          "limits.memory": "8Gi",
        },
        containerDefaults: resources,
      },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayClients: [
        { namespace: "default", podLabels: { "app.kubernetes.io/name": "platform-probe" } },
      ],
    },
    servicePrincipalCredentials: { mode: "disabled" },
  };
}

function createDriver() {
  return new KubernetesComputeDriver(computeConfiguration(), {
    id: "compute-kubernetes-plugin-receipt-real",
    implementation: "kubernetes-plugin-receipt-real",
  });
}

function namespace(label) {
  return {
    id: `ns_${randomUUID()}`,
    name: `${label}-${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
}

function agentName(agentId) {
  return `agent-${hash(agentId)}`;
}

function gatewayName(agentId) {
  return `gateway-${hash(agentId)}`;
}

function receiptName(revision) {
  return `plugin-receipt-${hash(revision.agentId)}-rev-${hash(revision.id)}`;
}

function pluginRevisionState() {
  return {
    driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
    plugins: { [pluginId]: { enabled: true, approvalMode: "always" } },
  };
}

function revision(driver, owner, agentId, number, harnessAuth) {
  return {
    id: `rev_${randomUUID()}`,
    namespaceId: owner.id,
    agentId,
    revision: number,
    providerId: null,
    configurationId: `cfg_${randomUUID()}`,
    configurationKind: "agent",
    configurationGeneration: number,
    configuration: admitLoggingConfiguration(
      {
        gateway: { controlUi: { enabled: false } },
        agents: { defaults: { model: "openai/gpt-5" } },
        logging: { level: "info" },
      },
      "info",
    ),
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: harnessAuth.snapshot,
    compute: { id: driver.id, implementation: driver.implementation },
    plugins: pluginRevisionState(),
    servicePrincipalId: `service-agent-${agentId}`,
    createdAt: new Date().toISOString(),
  };
}

async function prepareNamespace(driver, owner) {
  await waitFor(`Namespace ${owner.id} to become ready`, async () => {
    const observation = await driver.ensureNamespace(owner);
    assert.notEqual(observation.failure, "permanent");
    return observation.namespaceReady ? observation : undefined;
  });
  return kubernetesNamespaceName(owner.id);
}

async function provisionHarnessAuth(owner, state) {
  const { KubernetesSecretDriver } =
    await import("../../apps/controller/src/drivers/secret/kubernetes/index.ts");
  const driver = new KubernetesSecretDriver({
    authentication: { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
  });
  const identity = {
    id: `sec_${randomUUID()}`,
    namespaceId: owner.id,
    name: `Plugin receipt model key ${randomUUID()}`,
  };
  const backendRef = await driver.create(identity, `fixture-only-${randomUUID()}`);
  if (state !== undefined) {
    await state.transact((unit) =>
      unit.secrets.createSecret({
        ...identity,
        driverId: driver.id,
        backendRef,
        createdAt: new Date().toISOString(),
      }),
    );
  }
  const snapshot = {
    method: "api_key",
    source: { kind: "secret", namespaceId: owner.id, id: identity.id },
    secretDriverId: driver.id,
  };
  return {
    snapshot,
    context: {
      secretEnvironment: [],
      harnessAuth: {
        ...snapshot,
        backendRef: await driver.resolve({
          ...identity,
          driverId: driver.id,
          createdAt: new Date().toISOString(),
          backendRef,
        }),
      },
    },
  };
}

async function receipt(namespaceName, candidate) {
  const configMap = await resource("configmap", receiptName(candidate), namespaceName);
  return { configMap, state: JSON.parse(configMap.data[receiptStateKey]) };
}

async function patchReceiptState(namespaceName, candidate, state) {
  await kubectl(
    "patch",
    "configmap",
    receiptName(candidate),
    "--namespace",
    namespaceName,
    "--type",
    "merge",
    "--patch",
    JSON.stringify({ data: { [receiptStateKey]: JSON.stringify(state) } }),
  );
}

async function patchReceiptRaw(namespaceName, candidate, raw) {
  await kubectl(
    "patch",
    "configmap",
    receiptName(candidate),
    "--namespace",
    namespaceName,
    "--type",
    "merge",
    "--patch",
    JSON.stringify({ data: { [receiptStateKey]: raw } }),
  );
}

async function gatewayPods(namespaceName, agentId) {
  return resources(
    "pods",
    namespaceName,
    "--selector",
    `app.kubernetes.io/name=${gatewayName(agentId)}`,
  );
}

async function waitForGatewayTermination(namespaceName, agentId, podUid) {
  return waitFor("the receipt-boundary gateway Pod to terminate", async () => {
    const pod = (await gatewayPods(namespaceName, agentId)).find(
      ({ metadata }) => metadata.uid === podUid,
    );
    const container = pod?.status?.containerStatuses?.find(({ name }) => name === receiptContainer);
    const terminated = container?.state?.terminated ?? container?.lastState?.terminated;
    return terminated === undefined ? undefined : { pod, terminated };
  });
}

async function receiptPod(namespaceName, candidate, podUid) {
  const pods = await resources(
    "pods",
    namespaceName,
    "--selector",
    `openclaw.dev/agent=${candidate.agentId},openclaw.dev/revision=${candidate.id},openclaw.dev/workload-role=${receiptContainer}`,
  );
  return pods.find(({ metadata }) => metadata.uid === podUid);
}

async function execNode(namespaceName, podName, script) {
  return execute(
    "kubectl",
    [
      "--kubeconfig",
      kubeconfigPath,
      "--context",
      kubernetesContext,
      "exec",
      "--namespace",
      namespaceName,
      podName,
      "--container",
      receiptContainer,
      "--",
      "node",
      "-e",
      script,
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}

async function execNodeThatTerminatesContainer(namespaceName, podName, script) {
  await execNode(namespaceName, podName, script).catch((error) => {
    if (/exit code 137|command terminated/i.test(`${error.stderr ?? ""}\n${error.message ?? ""}`)) {
      return;
    }
    throw error;
  });
}

function receiptVolumeProbeScript() {
  return `
const { rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const target = join(process.env.OCC_PLUGIN_RECEIPT_DIRECTORY, "permission-probe");
writeFileSync(target, "ok\\n", { mode: 0o600 });
rmSync(target);
`;
}

function controlledFailureProducerScript() {
  return `
${PLUGIN_RUNTIME_HELPERS}
const receipt = checkPluginReceiptBeforeInstall(${JSON.stringify(receiptContainer)});
persistPluginDiagnostic(
  receipt,
  pluginDiagnostic(${JSON.stringify(pluginId)}, "PLUGIN_INSTALL_FAILED")
);
process.kill(1, "SIGTERM");
`;
}

function latchedFailureProbeScript() {
  return `
${PLUGIN_RUNTIME_HELPERS}
checkPluginReceiptBeforeInstall(${JSON.stringify(receiptContainer)});
`;
}

function malformedTerminationProducerScript(message) {
  return `
const { writeFileSync } = require("node:fs");
writeFileSync("/dev/termination-log", ${JSON.stringify(message)}, { mode: 0o600 });
process.kill(1, "SIGTERM");
`;
}

async function createReceiptCandidate(label, context, state) {
  const driver = createDriver();
  const owner = namespace(label);
  const namespaceName = await prepareNamespace(driver, owner);
  if (state !== undefined) await state.transact((unit) => unit.namespaces.createNamespace(owner));
  const agentId = `agt_${randomUUID()}`;
  const auth = await provisionHarnessAuth(owner, state);
  const candidate = revision(driver, owner, agentId, 1, auth);
  context.after(async () => {
    await createDriver()
      .retireRevision(candidate)
      .catch(() => {});
    await kubectl("delete", "namespace", namespaceName, "--ignore-not-found=true", "--wait=false");
    await kubectl("wait", "--for=delete", `namespace/${namespaceName}`, "--timeout=30s").catch(
      () => {},
    );
  });
  return {
    driver,
    owner,
    namespaceName,
    agentId,
    auth,
    candidate,
  };
}

async function bindControlledReceiptWorkload(fixture) {
  return waitFor("real Compute to bind the receipt-boundary fixture Pod", async () => {
    await prepareRevisionEventually(fixture);
    const current = await receipt(fixture.namespaceName, fixture.candidate);
    if (current.state.phase !== "pending" || current.state.podUid === undefined) return undefined;
    const pod = await receiptPod(fixture.namespaceName, fixture.candidate, current.state.podUid);
    if (pod === undefined || !pod.metadata.finalizers?.includes(receiptFinalizer)) return undefined;
    const ready = pod.status?.conditions?.some(
      ({ type, status }) => type === "Ready" && status === "True",
    );
    return ready ? { pod, receipt: current } : undefined;
  });
}

async function waitForControlledRestart(fixture, podUid, restartCount) {
  return waitFor("the controlled receipt producer to restart and become ready", async () => {
    const pod = await receiptPod(fixture.namespaceName, fixture.candidate, podUid);
    const container = pod?.status?.containerStatuses?.find(({ name }) => name === receiptContainer);
    const restarted = Number(container?.restartCount ?? 0) > restartCount;
    const ready = pod?.status?.conditions?.some(
      ({ type, status }) => type === "Ready" && status === "True",
    );
    return restarted && ready ? { pod, container } : undefined;
  });
}

async function execControlledFailureProducer(fixture) {
  const produced = await bindControlledReceiptWorkload(fixture);
  await execNode(fixture.namespaceName, produced.pod.metadata.name, receiptVolumeProbeScript());
  const container = produced.pod.status?.containerStatuses?.find(
    ({ name }) => name === receiptContainer,
  );
  const restartCount = Number(container?.restartCount ?? 0);
  await execNodeThatTerminatesContainer(
    fixture.namespaceName,
    produced.pod.metadata.name,
    controlledFailureProducerScript(),
  );
  await waitForGatewayTermination(
    fixture.namespaceName,
    fixture.agentId,
    produced.pod.metadata.uid,
  );
  const restarted = await waitForControlledRestart(
    fixture,
    produced.pod.metadata.uid,
    restartCount,
  );
  const latched = await execNode(
    fixture.namespaceName,
    restarted.pod.metadata.name,
    latchedFailureProbeScript(),
  ).then(
    () => undefined,
    (error) => error,
  );
  assert.match(latched?.stderr ?? latched?.message ?? "", /Plugin installation already failed/);
  return produced;
}

async function observeFailure(fixture, driver = fixture.driver) {
  return waitFor("real Compute to observe the controlled plugin receipt failure", async () => {
    const observation = await prepareRevisionEventually(fixture, driver);
    if (observation.failure === undefined) return undefined;
    return observation;
  });
}

test(
  "real Kubernetes Compute Driver retains controlled plugin receipt failure over later readiness",
  { ...requiresKubernetes, timeout: 360_000 },
  async (context) => {
    await assertPrerequisites();
    await configureExistingK3dLocalPathSharedFileSystem({ kubeconfigPath, kubernetesContext });
    const fixture = await createReceiptCandidate("plugin-receipt", context);
    // This test proves the receipt boundary, not native plugin installation: the fixture
    // server stays alive while real Compute binds the receipt gate/finalizer, then an
    // in-container command uses the production runtime helpers to persist a diagnostic.
    await execControlledFailureProducer(fixture);

    // Replace the restarted Pod before Compute collects its native diagnosis.
    // The finalizer must retain the old UID's evidence even if a replacement is Ready.
    const bound = await receipt(fixture.namespaceName, fixture.candidate);
    const boundPod = await receiptPod(fixture.namespaceName, fixture.candidate, bound.state.podUid);
    await kubectl(
      "delete",
      "pod",
      boundPod.metadata.name,
      "--namespace",
      fixture.namespaceName,
      "--wait=false",
    );
    const replacement = await waitFor("a Ready replacement before receipt collection", async () => {
      return (await gatewayPods(fixture.namespaceName, fixture.agentId)).find(
        (pod) =>
          pod.metadata.uid !== bound.state.podUid &&
          pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
      );
    });
    assert.notEqual(replacement.metadata.uid, bound.state.podUid);
    assert.ok(
      (
        await receiptPod(fixture.namespaceName, fixture.candidate, bound.state.podUid)
      ).metadata.finalizers.includes(receiptFinalizer),
    );

    const failed = await observeFailure(fixture);
    const failedReceipt = await receipt(fixture.namespaceName, fixture.candidate);
    assert.deepEqual(failed.failure, { pluginId, code: "PLUGIN_INSTALL_FAILED" });
    assert.equal(failed.receiptId, failedReceipt.configMap.metadata.uid);
    assert.deepEqual(failedReceipt.state, {
      phase: "failed",
      podUid: failedReceipt.state.podUid,
      container: receiptContainer,
      diagnostic: { pluginId, code: "PLUGIN_INSTALL_FAILED" },
    });

    const retained = await prepareRevisionEventually(fixture, createDriver());
    assert.deepEqual(
      retained.failure,
      { pluginId, code: "PLUGIN_INSTALL_FAILED" },
      "the persisted failed receipt must outrank later workload readiness",
    );
    assert.equal(retained.receiptId, failedReceipt.configMap.metadata.uid);

    const wrongContainer = await createReceiptCandidate("pr-wrong", context);
    await prepareRevisionEventually(wrongContainer);
    await patchReceiptState(wrongContainer.namespaceName, wrongContainer.candidate, {
      phase: "pending",
      container: receiptContainer === "gateway" ? "agent" : "gateway",
    });
    await assertInvalidReceiptRejected(wrongContainer);
    // Terminal states cannot assert success or attribution without the exact
    // Pod identity that Compute bound before native installation.
    for (const state of [
      { phase: "succeeded", container: receiptContainer },
      {
        phase: "failed",
        container: receiptContainer,
        diagnostic: { pluginId, code: "PLUGIN_INSTALL_FAILED" },
      },
    ]) {
      await patchReceiptState(wrongContainer.namespaceName, wrongContainer.candidate, state);
      await assertInvalidReceiptRejected(wrongContainer);
    }

    const wrongUid = await createReceiptCandidate("pr-wrong-uid", context);
    await prepareRevisionEventually(wrongUid);
    await patchReceiptState(wrongUid.namespaceName, wrongUid.candidate, {
      phase: "pending",
      podUid: randomUUID(),
      container: receiptContainer,
    });
    const wrongUidObservation = await prepareRevisionEventually(wrongUid);
    assert.equal(
      wrongUidObservation.ready,
      false,
      "a receipt bound to a different Pod UID must not become ready from a replacement Pod",
    );

    const malformed = await createReceiptCandidate("pr-bad-json", context);
    await prepareRevisionEventually(malformed);
    await patchReceiptRaw(malformed.namespaceName, malformed.candidate, "{");
    await assertInvalidReceiptRejected(malformed);

    const generic = await createReceiptCandidate("pr-generic", context);
    const genericProducer = await bindControlledReceiptWorkload(generic);
    await execNodeThatTerminatesContainer(
      generic.namespaceName,
      genericProducer.pod.metadata.name,
      malformedTerminationProducerScript(JSON.stringify({ pluginId, code: "PLUGIN_UNKNOWN" })),
    );
    await waitForGatewayTermination(
      generic.namespaceName,
      generic.agentId,
      genericProducer.pod.metadata.uid,
    );
    const genericObservation = await prepareRevisionEventually(generic);
    assert.equal(genericObservation.failure, undefined);
    const genericReceipt = await receipt(generic.namespaceName, generic.candidate);
    assert.deepEqual(genericReceipt.state, {
      phase: "failed",
      podUid: genericReceipt.state.podUid,
      container: receiptContainer,
    });

    const truncated = await createReceiptCandidate("pr-truncated", context);
    const truncatedProducer = await bindControlledReceiptWorkload(truncated);
    await execNodeThatTerminatesContainer(
      truncated.namespaceName,
      truncatedProducer.pod.metadata.name,
      malformedTerminationProducerScript("x".repeat(4096)),
    );
    await waitForGatewayTermination(
      truncated.namespaceName,
      truncated.agentId,
      truncatedProducer.pod.metadata.uid,
    );
    const truncatedObservation = await prepareRevisionEventually(truncated);
    assert.equal(truncatedObservation.failure, undefined);
    const truncatedReceipt = await receipt(truncated.namespaceName, truncated.candidate);
    assert.deepEqual(truncatedReceipt.state, {
      phase: "failed",
      podUid: truncatedReceipt.state.podUid,
      container: receiptContainer,
    });

    await acknowledgeReceiptEventually(fixture, {
      receiptId: failedReceipt.configMap.metadata.uid,
      outcome: "failed",
    });
    await waitFor("failed receipt acknowledgement to stop the exact blocked workload", async () => {
      return (await missing("deployment", gatewayName(fixture.agentId), fixture.namespaceName))
        ? true
        : undefined;
    });
    const terminal = await prepareRevisionEventually(fixture, createDriver());
    assert.deepEqual(terminal.failure, failed.failure);
    assert.equal(
      await missing("deployment", gatewayName(fixture.agentId), fixture.namespaceName),
      true,
    );

    // A new authorized revision can retry. Delayed cleanup of its predecessor
    // must preserve the successor and its shared gateway resources.
    const successor = {
      ...fixture,
      candidate: revision(fixture.driver, fixture.owner, fixture.agentId, 2, fixture.auth),
    };
    await waitFor("the new revision to become ready", async () => {
      const observation = await prepareRevisionEventually(successor);
      return observation.ready ? observation : undefined;
    });
    const successorDeployment = await resource(
      "deployment",
      gatewayName(fixture.agentId),
      fixture.namespaceName,
    );
    const sharedResources = [
      ["deployment", gatewayName(fixture.agentId)],
      ["service", gatewayName(fixture.agentId)],
      ["serviceaccount", successorDeployment.spec.template.spec.serviceAccountName],
    ];
    const successorResources = await Promise.all(
      sharedResources.map(([kind, name]) => resource(kind, name, fixture.namespaceName)),
    );
    await acknowledgeReceiptEventually(fixture, { receiptId: failed.receiptId, outcome: "failed" });
    const afterOldAcknowledgement = await Promise.all(
      sharedResources.map(([kind, name]) => resource(kind, name, fixture.namespaceName)),
    );
    assert.deepEqual(
      afterOldAcknowledgement.map((item) => item.metadata.uid),
      successorResources.map((item) => item.metadata.uid),
    );
    assert.equal((await prepareRevisionEventually(successor)).ready, true);
    const successorReceipt = await receipt(fixture.namespaceName, successor.candidate);
    await acknowledgeReceiptEventually(successor, {
      receiptId: successorReceipt.configMap.metadata.uid,
      outcome: "succeeded",
    });
    await successor.driver.retireRevision(successor.candidate);
  },
);

test(
  "successful controlled plugin receipt acknowledgement releases the Pod finalizer",
  { ...requiresKubernetes, timeout: 360_000 },
  async (context) => {
    await assertPrerequisites();
    await configureExistingK3dLocalPathSharedFileSystem({ kubeconfigPath, kubernetesContext });
    const fixture = await createReceiptCandidate("pr-success", context);
    await bindControlledReceiptWorkload(fixture);
    const pending = await receipt(fixture.namespaceName, fixture.candidate);
    assert.equal(pending.state.phase, "pending");
    assert.equal(pending.state.container, receiptContainer);
    assert.match(pending.state.podUid, /^[0-9a-f-]{36}$/);
    const pod = await receiptPod(fixture.namespaceName, fixture.candidate, pending.state.podUid);
    assert.ok(pod?.metadata.finalizers?.includes(receiptFinalizer));

    await acknowledgeReceiptEventually(fixture, {
      receiptId: pending.configMap.metadata.uid,
      outcome: "succeeded",
    });
    const succeeded = await receipt(fixture.namespaceName, fixture.candidate);
    assert.deepEqual(succeeded.state, {
      phase: "succeeded",
      podUid: pending.state.podUid,
      container: receiptContainer,
    });
    await waitFor("successful receipt acknowledgement to release the finalizer", async () => {
      const current = await receiptPod(
        fixture.namespaceName,
        fixture.candidate,
        pending.state.podUid,
      );
      return current === undefined || !current.metadata.finalizers?.includes(receiptFinalizer)
        ? true
        : undefined;
    });
    await kubectl(
      "delete",
      "pod",
      pod.metadata.name,
      "--namespace",
      fixture.namespaceName,
      "--wait=false",
    );
    await waitFor("normal Pod replacement after success acknowledgement", async () => {
      const replacement = (await gatewayPods(fixture.namespaceName, fixture.agentId)).find(
        (item) =>
          item.metadata.uid !== pending.state.podUid &&
          item.status?.conditions?.some(
            ({ type, status }) => type === "Ready" && status === "True",
          ),
      );
      if (replacement === undefined) return undefined;
      return (await prepareRevisionEventually(fixture)).ready;
    });
  },
);

test(
  "PostgreSQL queue rejects stale controlled receipt commits before a fresh claim rereads it",
  { ...requiresKubernetesAndPostgres, timeout: 360_000 },
  async (context) => {
    await assertPrerequisites();
    await configureExistingK3dLocalPathSharedFileSystem({ kubeconfigPath, kubernetesContext });
    assert.match(new URL(databaseUrl).pathname, /^\/openclaw_k8s_[a-z0-9_]+$/);
    const [{ Pool }, { PostgresPlatformState }, { PostgresWorkQueue }] = await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/occ/src/state/postgres-work-queue.ts"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    await pool.query(
      `UPDATE occ.controller_work
       SET state = 'failed_permanent',
           claim_token = NULL,
           lease_expires_at = NULL,
           completed_at = COALESCE(completed_at, clock_timestamp()),
           reason_code = COALESCE(reason_code, 'TEST_SUPERSEDED'),
           updated_at = clock_timestamp()
       WHERE state IN ('queued', 'claimed')`,
    );
    const state = new PostgresPlatformState(pool);
    context.after(() => pool.end());

    let installation = await state.loadInstallation();
    if (installation === undefined) {
      const { createAuthPrincipalSeed } = await import("../../packages/iam/src/index.ts");
      const { createDevelopmentIAMState } = await import("../helpers/development-iam-state.mjs");
      installation = {
        id: `ins_${randomUUID()}`,
        name: "Kubernetes plugin receipt queue integration",
        createdAt: new Date().toISOString(),
      };
      state.setBootstrapNativeIAM(
        createDevelopmentIAMState(
          createAuthPrincipalSeed(installation.id, "kubernetes-plugin-receipt", {
            id: `account-${randomUUID()}`,
          }),
        ),
      );
      await state.transact((unit) => unit.installations.createInstallation(installation));
    }
    const fixture = await createReceiptCandidate("pr-queue", context, state);
    await execControlledFailureProducer(fixture);

    await state.transactWithQueue(async (unit, queue) => {
      await unit.configurations.createConfiguration({
        id: fixture.candidate.configurationId,
        namespaceId: fixture.owner.id,
        kind: "agent",
        generation: fixture.candidate.configurationGeneration,
        createdAt: new Date().toISOString(),
      });
      await unit.agents.createAgent({
        id: fixture.agentId,
        namespaceId: fixture.owner.id,
        name: "plugin receipt queue",
        configurationId: fixture.candidate.configurationId,
        providerId: null,
        harnessAuth: {
          method: fixture.candidate.harnessAuth.method,
          source: fixture.candidate.harnessAuth.source,
        },
        executionMode: "embedded",
        servicePrincipalId: fixture.candidate.servicePrincipalId,
        createdAt: new Date().toISOString(),
      });
      await unit.revisions.createRevision(fixture.candidate);
      await unit.agents.compareAndSetActiveRevision(
        fixture.owner.id,
        fixture.agentId,
        undefined,
        fixture.candidate.id,
      );
      await queue.enqueue({
        idempotencyKey: `agent_revision:${fixture.candidate.id}:reconcile`,
        namespaceId: fixture.owner.id,
        agentId: fixture.agentId,
        revisionId: fixture.candidate.id,
        actorId: "receipt-boundary-test",
        availableAt: new Date(0),
      });
    });

    const queue = new PostgresWorkQueue(pool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    });
    const claim = await queue.claim();
    assert.ok(claim);
    const observed = await observeFailure(fixture);
    assert.equal(observed.receiptId.length > 0, true);

    await pool.query(
      `UPDATE occ.controller_work
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1 AND claim_token = $2::uuid`,
      [claim.idempotencyKey, claim.claimToken],
    );
    const recovery = await queue.recoverStale();
    assert.ok(recovery.recovered >= 1);
    const recovered = await queue.claim();
    assert.ok(recovered);
    assert.equal(recovered.idempotencyKey, claim.idempotencyKey);
    assert.notEqual(recovered.claimToken, claim.claimToken);

    await assert.rejects(
      () =>
        queue.fail(claim, {
          code: "PLUGIN_INSTALL_FAILED",
          data: { pluginId },
          receiptId: observed.receiptId,
        }),
      /claim|stale|lost|complete/i,
    );
    let row = (
      await pool.query(
        `SELECT state, claim_token, reason_code, receipt_id, receipt_acknowledged_at
         FROM occ.controller_work WHERE idempotency_key = $1`,
        [claim.idempotencyKey],
      )
    ).rows[0];
    assert.equal(row.state, "claimed");
    assert.equal(row.claim_token, recovered.claimToken);
    assert.equal(row.reason_code, null);
    assert.equal(row.receipt_id, null);

    const reread = await observeFailure(fixture, createDriver());
    assert.equal(reread.receiptId, observed.receiptId);
    await queue.fail(recovered, {
      code: "PLUGIN_INSTALL_FAILED",
      data: { pluginId },
      receiptId: reread.receiptId,
    });
    await acknowledgeReceiptEventually(fixture, {
      receiptId: reread.receiptId,
      outcome: "failed",
    });
    await queue.acknowledgeReceipt({
      idempotencyKey: claim.idempotencyKey,
      state: "failed_permanent",
      reasonCode: "PLUGIN_INSTALL_FAILED",
      receiptId: reread.receiptId,
    });
    row = (
      await pool.query(
        `SELECT state, reason_code, error_data, receipt_id,
                receipt_acknowledged_at IS NOT NULL AS acknowledged
         FROM occ.controller_work WHERE idempotency_key = $1`,
        [claim.idempotencyKey],
      )
    ).rows[0];
    assert.deepEqual(row, {
      state: "failed_permanent",
      reason_code: "PLUGIN_INSTALL_FAILED",
      error_data: { pluginId },
      receipt_id: reread.receiptId,
      acknowledged: true,
    });

    await waitFor("failed receipt retirement to remove the blocked workload", async () => {
      await createDriver().retireRevision(fixture.candidate);
      return (await missing("deployment", gatewayName(fixture.agentId), fixture.namespaceName))
        ? true
        : undefined;
    });
    assert.equal(
      await missing("configmap", receiptName(fixture.candidate), fixture.namespaceName),
      true,
    );
  },
);
