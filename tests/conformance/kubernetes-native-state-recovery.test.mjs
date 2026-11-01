import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  GATEWAY_STATE_DATABASE_PATH,
  GATEWAY_STATE_OWNER_ANNOTATION,
  GATEWAY_STATE_RECOVERY_ANNOTATION,
  GATEWAY_STATE_RECOVERY_VOLUME,
  TRUSTED_GATEWAY_TOOL_BOUNDARY,
  GATEWAY_RECOVERY_SOURCE_PROTECTION,
  GATEWAY_STATE_ORIGIN_ANNOTATION,
  GATEWAY_PRIVATE_STATE_ORIGIN,
  gatewayOwnerTerminationMessage,
} from "../../apps/controller/src/drivers/compute/native-state-owner.ts";
import {
  options,
  preparedAuth,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";

function ownerFixture({
  protectedBoundary = true,
  statusReachable = true,
  privateOrigin = true,
  nativeHarness = false,
} = {}) {
  const driver = new KubernetesComputeDriver(
    options({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      network: {
        ...options().network,
        pluginStatusProxySourceCidrs: statusReachable ? ["127.0.0.1/32"] : [],
      },
    }),
    protectedBoundary ? { trustedGatewayToolBoundary: TRUSTED_GATEWAY_TOOL_BOUNDARY } : {},
  );
  const baseRevision = routedRevision(driver);
  const revision = nativeHarness
    ? {
        ...baseRevision,
        harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
        configuration: admitLoggingConfiguration(
          JSON.parse(
            readFileSync(
              new URL("../../deploy/presets/standard-openclaw.json", import.meta.url),
              "utf8",
            ),
          ).template.configuration.values,
          "info",
        ),
      }
    : baseRevision;
  const namespace = { name: "gateway-control", plane: "control" };
  const ownership = { namespaceId: tenant.id, agentId: revision.agentId };
  const nativeOwner = {
    databasePath: GATEWAY_STATE_DATABASE_PATH,
    ownerId: "observed-native-owner",
    role: "gateway",
    pid: 21,
    startTime: 123456,
    processNamespace: {
      platform: "linux",
      host: "gateway-old",
      identity: "boot-uuid",
      pidNsInode: "4026533000",
    },
  };
  const render = (embedded = false, role = "gateway") =>
    driver.deployment(
      role,
      { ...ownership, ...(role === "agent" ? { revisionId: revision.id } : {}) },
      namespace,
      "gateway:local",
      role,
      role,
      {},
      "info",
      role === "gateway"
        ? driver.gatewayConfiguration(
            revision,
            undefined,
            namespace,
            privateOrigin ? "state-pvc-uid" : undefined,
          )
        : undefined,
      embedded,
      undefined,
      nativeHarness ? undefined : preparedAuth(driver, namespace.name, embedded),
    );
  const pod = (name, uid, containerId) => ({
    ...driver.manifest("v1", "Pod", name, ownership, namespace),
    metadata: {
      ...render().spec.template.metadata,
      name,
      namespace: namespace.name,
      uid,
      resourceVersion: "1",
    },
    spec: render().spec.template.spec,
    status: {
      phase: "Running",
      podIP: "10.42.0.12",
      containerStatuses: [{ name: "gateway", containerID: containerId }],
    },
  });
  let current = pod("gateway-old", "old-pod-uid", "containerd://old");
  const pods = new Map([[current.metadata.name, current]]);
  const claim = driver.gatewayPrivateStateClaim(revision.agentId, ownership, namespace);
  Object.assign(claim.metadata, { uid: "state-pvc-uid", resourceVersion: "1" });
  if (privateOrigin) {
    claim.metadata.annotations[GATEWAY_STATE_ORIGIN_ANNOTATION] = GATEWAY_PRIVATE_STATE_ORIGIN;
  }
  let gatewayState = {
    toolBoundary: TRUSTED_GATEWAY_TOOL_BOUNDARY,
    sourceProtection: GATEWAY_RECOVERY_SOURCE_PROTECTION,
    stateOrigin: GATEWAY_PRIVATE_STATE_ORIGIN,
    storageId: claim.metadata.uid,
    instanceId: "wrapper-old",
    liveOwner: nativeOwner,
  };
  const mutations = [];
  let conflict = false;
  driver.clients = async () => ({
    core: {
      readNamespacedPersistentVolumeClaim: async () => structuredClone(claim),
      readNamespacedPod: async ({ name }) => {
        if (!pods.has(name)) {
          throw Object.assign(new Error("absent"), { code: 404 });
        }
        return structuredClone(pods.get(name));
      },
      listNamespacedPod: async () => ({ items: [structuredClone(current)] }),
      connectGetNamespacedPodProxyWithPath: async () => ({
        revisionId: revision.id,
        container: "gateway",
        podUid: current.metadata.uid,
        gatewayState,
      }),
      patchNamespacedPersistentVolumeClaim: async ({ body }) => {
        assert.equal(body.metadata.uid, claim.metadata.uid);
        assert.equal(body.metadata.resourceVersion, claim.metadata.resourceVersion);
        if (conflict) {
          throw Object.assign(new Error("conflict"), { code: 409 });
        }
        Object.assign(claim.metadata.annotations, body.metadata.annotations);
        claim.metadata.resourceVersion = String(Number(claim.metadata.resourceVersion) + 1);
        mutations.push({ kind: "PersistentVolumeClaim", body: structuredClone(body) });
        return structuredClone(claim);
      },
      patchNamespacedPod: async ({ name, body }) => {
        assert.equal(name, current.metadata.name);
        assert.equal(body.metadata.uid, current.metadata.uid);
        assert.equal(body.metadata.resourceVersion, current.metadata.resourceVersion);
        Object.assign(current.metadata.annotations, body.metadata.annotations);
        mutations.push({ kind: "Pod", body: structuredClone(body) });
      },
    },
  });
  return {
    driver,
    revision,
    namespace,
    claim,
    pods,
    nativeOwner,
    mutations,
    render,
    observe: () => driver.reconcileNativeGatewayStateOwner(revision, namespace),
    binding: () => JSON.parse(claim.metadata.annotations[GATEWAY_STATE_OWNER_ANNOTATION]),
    setConflict: () => {
      conflict = true;
    },
    manualSources: () => {
      gatewayState = {
        toolBoundary: TRUSTED_GATEWAY_TOOL_BOUNDARY,
        stateOrigin: GATEWAY_PRIVATE_STATE_ORIGIN,
        storageId: claim.metadata.uid,
        instanceId: "wrapper-old",
        recovery: { state: "manual" },
      };
    },
    holdReplacement: () => {
      current = pod("gateway-new", "new-pod-uid", "containerd://new");
      pods.set(current.metadata.name, current);
      gatewayState = {
        toolBoundary: TRUSTED_GATEWAY_TOOL_BOUNDARY,
        stateOrigin: GATEWAY_PRIVATE_STATE_ORIGIN,
        storageId: claim.metadata.uid,
        instanceId: "wrapper-new",
        recovery: {
          state: "waiting",
          ownerRecords: [{ kind: "gateway-lease", owner: nativeOwner }],
        },
      };
      return current;
    },
  };
}

test("only trusted dedicated Gateway rendering receives recovery authority", async () => {
  for (const [protectedBoundary, embedded, statusReachable] of [
    [false, false, true],
    [true, true, true],
    [true, false, false],
    [true, false, true],
  ]) {
    const fixture = ownerFixture({ protectedBoundary, statusReachable });
    const spec = fixture.render(embedded).spec.template.spec;
    const enabled = protectedBoundary && !embedded && statusReachable;
    const gateway = spec.containers[0];
    assert.equal(
      spec.volumes.some(({ name }) => name === GATEWAY_STATE_RECOVERY_VOLUME),
      enabled,
    );
    assert.equal(
      gateway.env.some(({ name }) => name === "OPENCLAW_TRUSTED_GATEWAY_TOOL_BOUNDARY"),
      enabled,
    );
    assert.equal(gateway.terminationMessagePolicy, enabled ? "File" : undefined);
    if (enabled) {
      assert.equal(gateway.terminationMessagePath, "/dev/termination-log");
      assert.equal(
        gateway.volumeMounts.find(({ name }) => name === GATEWAY_STATE_RECOVERY_VOLUME).readOnly,
        true,
      );
      assert.equal(spec.automountServiceAccountToken, false);
    }
    const harness = fixture.render(false, "agent").spec.template.spec;
    assert.equal(
      harness.volumes.some(({ name }) => name === GATEWAY_STATE_RECOVERY_VOLUME),
      false,
    );
    assert.equal(
      harness.containers[0].env.some(
        ({ name }) => name === "OPENCLAW_TRUSTED_GATEWAY_TOOL_BOUNDARY",
      ),
      false,
    );
    if (!enabled) {
      fixture.driver.clients = () => {
        throw new Error("inert recovery must not contact Kubernetes");
      };
      await fixture.driver.reconcileNativeGatewayStateOwner(
        {
          ...fixture.revision,
          harness: { ...fixture.revision.harness, mode: embedded ? "embedded" : "dedicated" },
        },
        fixture.namespace,
      );
    }
  }
});

test("Compute persists live custody, preserves it while replacement waits, and requires retained death proof", async () => {
  const fixture = ownerFixture();
  await fixture.observe();
  const binding = fixture.binding();
  assert.equal(binding.pvcUid, fixture.claim.metadata.uid);
  assert.equal(binding.containerId, "containerd://old");
  assert.equal(binding.instanceId, "wrapper-old");
  assert.deepEqual(binding.owner, fixture.nativeOwner);
  const old = fixture.pods.get("gateway-old");
  const replacement = fixture.holdReplacement();
  await fixture.observe();
  assert.deepEqual(fixture.binding(), binding);
  assert.equal(fixture.mutations.length, 1);
  old.status.containerStatuses[0].state = {
    terminated: {
      containerID: binding.containerId,
      reason: "Error",
      exitCode: 137,
      finishedAt: "2026-10-23T10:00:00Z",
      message: gatewayOwnerTerminationMessage(binding),
    },
  };
  await fixture.observe();
  assert.equal(fixture.binding().termination.containerId, binding.containerId);
  assert.equal(fixture.mutations.at(-1).kind, "PersistentVolumeClaim");
  assert.equal(replacement.metadata.annotations[GATEWAY_STATE_RECOVERY_ANNOTATION], undefined);
  // The next pass consumes the already-persisted proof; losing the old Pod now is safe.
  fixture.pods.delete("gateway-old");
  await fixture.observe();
  const intent = JSON.parse(replacement.metadata.annotations[GATEWAY_STATE_RECOVERY_ANNOTATION]);
  assert.equal(intent.podUid, replacement.metadata.uid);
  assert.equal(intent.instanceId, "wrapper-new");
  assert.equal(intent.storageId, fixture.claim.metadata.uid);
  assert.deepEqual(intent.owner, fixture.nativeOwner);
  assert.equal(fixture.mutations.at(-1).kind, "Pod");
});

test("unproved disappearance, replaced PVCs and metadata conflicts do not authorize recovery", async () => {
  const missing = ownerFixture();
  await missing.observe();
  const before = missing.binding();
  missing.holdReplacement();
  missing.pods.delete("gateway-old");
  await missing.observe();
  assert.deepEqual(missing.binding(), before);
  assert.equal(missing.mutations.length, 1);

  const replaced = ownerFixture();
  await replaced.observe();
  replaced.claim.metadata.uid = "replacement-pvc-uid";
  replaced.holdReplacement();
  await replaced.observe();
  assert.equal(replaced.mutations.length, 1);

  const concurrent = ownerFixture();
  concurrent.setConflict();
  assert.equal(
    await concurrent.driver.gatewayReady(concurrent.revision, "gateway", concurrent.namespace),
    false,
  );
  assert.equal(concurrent.mutations.length, 0);
});

test("only creation can establish private state origin, including concurrent legacy creation", async () => {
  for (const scenario of ["absent", "protected", "legacy", "concurrent-legacy"]) {
    const fixture = ownerFixture();
    const { driver, revision, namespace } = fixture;
    let claim =
      scenario === "absent" || scenario === "concurrent-legacy"
        ? undefined
        : structuredClone(fixture.claim);
    if (scenario === "legacy") {
      delete claim.metadata.annotations[GATEWAY_STATE_ORIGIN_ANNOTATION];
    }
    const creations = [];
    driver.getOwned = async () => (claim === undefined ? undefined : structuredClone(claim));
    driver.clients = async () => ({
      core: {
        createNamespacedPersistentVolumeClaim: async (request) => {
          creations.push(request);
          if (scenario === "concurrent-legacy") {
            claim = structuredClone(fixture.claim);
            delete claim.metadata.annotations[GATEWAY_STATE_ORIGIN_ANNOTATION];
            throw Object.assign(new Error("AlreadyExists"), { code: 409 });
          }
          claim = {
            ...request.body,
            metadata: { ...request.body.metadata, uid: "created-state-uid", resourceVersion: "1" },
          };
        },
      },
    });
    driver.reconcile = async (desired) => {
      assert.equal(
        desired.metadata.annotations[GATEWAY_STATE_ORIGIN_ANNOTATION],
        undefined,
        "ordinary SSA must never certify or adopt existing state",
      );
    };
    const result = await driver.prepareGatewayPrivateStateClaim(
      revision,
      { namespaceId: revision.namespaceId, agentId: revision.agentId },
      namespace,
    );
    assert.equal(creations.length, ["absent", "concurrent-legacy"].includes(scenario) ? 1 : 0);
    assert.equal(
      result,
      scenario === "absent"
        ? "created-state-uid"
        : scenario === "protected"
          ? fixture.claim.metadata.uid
          : undefined,
    );
    if (creations.length > 0) {
      assert.equal(
        creations[0].body.metadata.annotations[GATEWAY_STATE_ORIGIN_ANNOTATION],
        GATEWAY_PRIVATE_STATE_ORIGIN,
      );
      assert.equal(creations[0].fieldManager, "openclaw-native-state-origin");
    }
    assert.equal(
      claim.metadata.annotations[GATEWAY_STATE_ORIGIN_ANNOTATION],
      ["absent", "protected"].includes(scenario) ? GATEWAY_PRIVATE_STATE_ORIGIN : undefined,
    );
  }
});

test("unprotected reuse or an unsupported source permanently ends private-state eligibility", async () => {
  for (const scenario of ["embedded", "unprotected", "custom-source"]) {
    const fixture = ownerFixture({ protectedBoundary: scenario !== "unprotected" });
    const changed =
      scenario === "embedded"
        ? { ...fixture.revision, harness: { ...fixture.revision.harness, mode: "embedded" } }
        : scenario === "custom-source"
          ? { ...fixture.revision, configuration: { hooks: { internal: { enabled: true } } } }
          : fixture.revision;
    assert.equal(await fixture.driver.gatewayStateOriginUid(changed, fixture.namespace), undefined);
    assert.equal(fixture.claim.metadata.annotations[GATEWAY_STATE_ORIGIN_ANNOTATION], null);
    assert.equal(
      await fixture.driver.gatewayStateOriginUid(fixture.revision, fixture.namespace),
      undefined,
    );
    assert.equal(fixture.mutations.length, 1, "a clean config cannot relabel this existing state");
  }
  const fixture = ownerFixture();
  await fixture.observe();
  fixture.manualSources();
  await fixture.observe();
  assert.equal(fixture.claim.metadata.annotations[GATEWAY_STATE_ORIGIN_ANNOTATION], null);
  assert.equal(
    fixture.mutations.some(({ kind }) => kind === "Pod"),
    false,
  );
});

test("default dedicated OC and remote Codex both establish and retain protected custody", async () => {
  for (const nativeHarness of [true, false]) {
    const fixture = ownerFixture({ nativeHarness });
    const { driver, revision, namespace } = fixture;
    let claim;
    const renderClaim = structuredClone(fixture.claim);
    driver.getOwned = async (kind, name) =>
      kind === "PersistentVolumeClaim"
        ? claim === undefined
          ? undefined
          : structuredClone(claim)
        : structuredClone(fixture.pods.get(name));
    const originalClients = await driver.clients();
    driver.clients = async () => ({
      core: {
        ...originalClients.core,
        createNamespacedPersistentVolumeClaim: async ({ body }) => {
          claim = {
            ...body,
            metadata: { ...body.metadata, uid: renderClaim.metadata.uid, resourceVersion: "1" },
          };
        },
      },
    });
    driver.reconcile = async () => {};
    assert.equal(
      await driver.prepareGatewayPrivateStateClaim(
        revision,
        { namespaceId: revision.namespaceId, agentId: revision.agentId },
        namespace,
      ),
      renderClaim.metadata.uid,
    );
    // Continue with the same newly certified scope through the existing custody producer.
    Object.assign(fixture.claim.metadata, claim.metadata);
    driver.getOwned = KubernetesComputeDriver.prototype.getOwned;
    await fixture.observe();
    assert.equal(fixture.binding().toolBoundary, TRUSTED_GATEWAY_TOOL_BOUNDARY);
    assert.deepEqual(fixture.binding().owner, fixture.nativeOwner);
    assert.ok(
      fixture
        .render()
        .spec.template.spec.containers[0].env.some(
          ({ name }) => name === "OPENCLAW_STATE_OWNER_RECOVERY_PATH",
        ),
    );
  }
});
