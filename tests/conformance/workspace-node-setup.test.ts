import assert from "node:assert/strict";
import test from "node:test";
import { rootCertificates } from "node:tls";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type {
  AgentRevision,
  SandboxDriver,
  SandboxHarnessEndpoint,
} from "../../packages/contracts/src/index.ts";
import {
  publicCaBundle,
  validateWorkspaceNodeSetupSecret,
  WorkspaceNodeSetupValidationError,
} from "../../packages/utils/src/index.ts";
import { supervisorPeerLabels } from "../fixtures/kubernetes-provider-readiness.mjs";
import {
  authContext,
  digest,
  routedOptions,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import {
  createDedicatedDeployEnrollmentFixture,
  createDedicatedDeployKubernetesFixture,
  nativeHarnessResource,
  nativeSandboxIdentity,
  readyNativeHarnessPod,
} from "./kubernetes-dedicated-deploy-fixture.ts";

test("workspace setup validation returns only the frozen canonical envelope", () => {
  const envelope = {
    url: "wss://GATEWAY.example.test:443/node",
    bootstrapToken: "synthetic-bootstrap-token",
    expiresAtMs: Date.now() + 60_000,
    tlsFingerprint: "SHA256:" + "AB:".repeat(31) + "AB",
  };
  const secret = {
    metadata: {
      namespace: "runtime-ns",
      labels: { "openclaw.dev/namespace": "ns-one", "openclaw.dev/agent": "agent-one" },
    },
    data: {
      setup: Buffer.from(
        "oc-pair://" + Buffer.from(JSON.stringify(envelope)).toString("base64url"),
      ).toString("base64"),
      unrelated: "must-not-be-returned",
    },
  };
  const snapshot = structuredClone(secret);
  const result = validateWorkspaceNodeSetupSecret(secret, {
    namespace: "runtime-ns",
    namespaceId: "ns-one",
    agentId: "agent-one",
    key: "setup",
  });
  assert.deepEqual(result, { ...envelope, url: "wss://gateway.example.test/node" });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(secret, snapshot);
});

test("workspace setup validation reports ownership and expiry through its public error type", () => {
  const secret = {
    metadata: {
      namespace: "runtime-ns",
      labels: { "openclaw.dev/namespace": "ns-one", "openclaw.dev/agent": "agent-one" },
    },
    data: {
      setup: Buffer.from(
        Buffer.from(
          JSON.stringify({
            url: "wss://gateway.example.test/node",
            bootstrapToken: "synthetic-bootstrap-token",
            expiresAtMs: 1,
          }),
        ).toString("base64url"),
      ).toString("base64"),
    },
  };
  const expected = {
    namespace: "runtime-ns",
    namespaceId: "ns-one",
    agentId: "agent-one",
    key: "setup",
  };
  for (const field of ["namespace", "namespaceId", "agentId"]) {
    assert.throws(
      () => validateWorkspaceNodeSetupSecret(secret, { ...expected, [field]: "foreign" }),
      {
        constructor: WorkspaceNodeSetupValidationError,
        message: "Refusing a workspace node setup Secret without exact Agent ownership.",
      },
    );
  }
  assert.throws(() => validateWorkspaceNodeSetupSecret(secret, expected), {
    constructor: WorkspaceNodeSetupValidationError,
    message: "The workspace node setup envelope is expired or has no bounded expiry.",
  });
});

function expiredSetupWithSavedDevice() {
  const envelope = {
    url: "wss://gateway.example.test/node",
    bootstrapToken: "synthetic-bootstrap-token",
    expiresAtMs: 1,
  };
  return {
    envelope,
    secret: {
      metadata: {
        namespace: "runtime-ns",
        labels: { "openclaw.dev/namespace": "ns-one", "openclaw.dev/agent": "agent-one" },
      },
      data: {
        setup: Buffer.from(Buffer.from(JSON.stringify(envelope)).toString("base64url")).toString(
          "base64",
        ),
        deviceId: Buffer.from("saved-device").toString("base64"),
      },
    },
    expected: {
      namespace: "runtime-ns",
      namespaceId: "ns-one",
      agentId: "agent-one",
      key: "setup",
    },
  };
}

test("workspace setup and saved-device encodings retain optional trailing padding", () => {
  const { secret, expected, envelope } = expiredSetupWithSavedDevice();
  for (const padding of ["", "=", "==", "=".repeat(65_536)]) {
    const padded = structuredClone(secret);
    for (const key of ["setup", "deviceId"] as const) {
      padded.data[key] = padded.data[key].replaceAll("=", "") + padding;
    }
    assert.deepEqual(validateWorkspaceNodeSetupSecret(padded, expected), envelope);
  }
});

test("workspace setup and saved-device encodings reject nontrailing padding", () => {
  const { secret, expected } = expiredSetupWithSavedDevice();
  for (const key of ["setup", "deviceId"] as const) {
    for (const suffix of ["=suffix", "=".repeat(65_536) + "!", "=\n"]) {
      const malformed = structuredClone(secret);
      malformed.data[key] = malformed.data[key].replaceAll("=", "") + suffix;
      assert.throws(() => validateWorkspaceNodeSetupSecret(malformed, expected), {
        constructor: WorkspaceNodeSetupValidationError,
        message:
          key === "setup"
            ? "The workspace node setup Secret contains invalid material."
            : "The workspace node device ID is invalid.",
      });
    }
  }
});

function providerTrustFixture(initialCa: string | undefined) {
  const { state, nodeEnrollment } = createDedicatedDeployEnrollmentFixture();
  const observedRevision = { id: "revision-routed-1" };
  const statusCalls: string[] = [];
  let caBundle = initialCa;
  let gatewayWrites = 0;
  let finishRolloutOnWrite = false;
  const endpoint = (): SandboxHarnessEndpoint => ({
    url: "wss://harness.example.test:8443/",
    workspaceRoot: "/workspace",
    ...(caBundle === undefined ? {} : { tls: { caBundle } }),
  });
  const sandboxDriver: SandboxDriver = {
    ...nativeSandboxIdentity(),
    async cleanup() {},
    async workspaceNodePeerLabels({ revision }) {
      return supervisorPeerLabels(revision.id);
    },
    async provisionHarness(context) {
      state.providerPod = readyNativeHarnessPod(
        context.namespace.name,
        context.requirements.labels,
      );
      return nativeHarnessResource(context);
    },
    async harnessEndpoint() {
      return endpoint();
    },
    async harnessStatus({ revision, transportToken }) {
      assert.ok(transportToken.length > 0);
      statusCalls.push(revision.id);
      return { state: "serving" };
    },
  };
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      network: {
        pluginStatusProxySourceCidrs: ["192.0.2.20/32"],
        providerHarness: {
          namespace: "provider",
          podLabels: { app: "provider" },
          address: "10.43.0.50",
          port: 8443,
        },
      },
    }),
    { sandboxDriver, nodeEnrollment },
  );
  const predecessor = routedRevision(driver, {
    sandboxDriverId: sandboxDriver.id,
  }) as AgentRevision;
  const successor = routedRevision(driver, {
    sandboxDriverId: sandboxDriver.id,
    id: "revision-routed-2",
    revision: 2,
    configurationGeneration: 2,
  }) as AgentRevision;
  const namespace = kubernetesNamespaceName(tenant.id);
  const gatewayName = `gateway-${digest(predecessor.agentId)}`;
  const target = { name: namespace, plane: "control" } as const;
  const fixture = createDedicatedDeployKubernetesFixture(
    { namespace, gatewayName, state, revision: observedRevision, sandboxDriver, clock: undefined },
    (save) => {
      save({
        ...driver["gatewayNamespaceManifest"]({ namespaceId: tenant.id }),
        status: { phase: "Active" },
      });
      for (const plane of ["execution", "control"] as const) {
        for (const policy of driver["networkPolicies"](
          { namespaceId: tenant.id },
          { name: namespace, plane },
        )) {
          save(policy);
        }
      }
      const transport = driver["manifest"](
        "v1",
        "Secret",
        `transport-${digest(predecessor.agentId)}`,
        { namespaceId: tenant.id, agentId: predecessor.agentId },
        target,
      );
      save({
        ...transport,
        type: "Opaque",
        metadata: { ...transport.metadata, uid: "transport-uid", resourceVersion: "1" },
        data: { "app-server-token": Buffer.from("test-transport").toString("base64") },
      });
      save({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "occ-model-key", namespace, uid: "model-secret-uid" },
        data: { value: Buffer.from("fixture-model-key").toString("base64") },
      });
    },
  );
  const patchDeployment = fixture.clients.apps.patchNamespacedDeployment;
  assert.ok(patchDeployment);
  fixture.clients.apps.patchNamespacedDeployment = async (request) => {
    const result = await patchDeployment(request);
    if (request.body.metadata.name === gatewayName) {
      gatewayWrites++;
      if (finishRolloutOnWrite) {
        fixture.markReady(gatewayName);
      }
    }
    return result;
  };
  Object.assign(driver, {
    apiClients: Promise.resolve(fixture.clients),
    workspaceNodePairingWaitMs: 0,
  });
  state.connected = true;
  const trustName = (revision: AgentRevision) =>
    `harness-trust-${digest(revision.agentId)}-rev-${digest(revision.id)}`;
  const trust = (revision: AgentRevision) =>
    fixture.objects.get(fixture.key("ConfigMap", trustName(revision)));
  const gateway = () => fixture.read("Deployment", gatewayName);
  const prepare = async (revision: AgentRevision) => {
    observedRevision.id = revision.id;
    return driver.prepareRevision(revision, {
      ...authContext(revision),
      secretEnvironment: [],
    });
  };
  const prepareReady = async (revision: AgentRevision) => {
    for (let pass = 0; pass < 5; pass++) {
      if ((await prepare(revision)).ready) {
        return;
      }
      if (fixture.objects.has(fixture.key("Deployment", gatewayName))) {
        fixture.markReady(gatewayName);
      }
    }
    assert.fail("the real Compute preparation did not converge");
  };
  const activate = async (revision: AgentRevision) => {
    observedRevision.id = revision.id;
    finishRolloutOnWrite = true;
    try {
      await driver.activateRevision(revision, {
        ...authContext(revision),
        secretEnvironment: [],
      });
    } finally {
      finishRolloutOnWrite = false;
    }
  };
  return {
    predecessor,
    successor,
    statusCalls,
    trust,
    gateway,
    prepare,
    prepareReady,
    activate,
    gatewayWrites: () => gatewayWrites,
    setCa(value: string | undefined) {
      caBundle = value;
    },
    removeTrust(revision: AgentRevision) {
      fixture.objects.delete(fixture.key("ConfigMap", trustName(revision)));
    },
    saveTrust(revision: AgentRevision, value: string) {
      fixture.save({
        ...driver["manifest"](
          "v1",
          "ConfigMap",
          trustName(revision),
          driver["pluginRuntimeOwnership"](revision),
          target,
        ),
        immutable: true,
        data: { "ca-bundle.pem": value },
      });
    },
  };
}

test("Kubernetes provider Harness retains prepared successor trust through activation", async (t) => {
  const caA = publicCaBundle(rootCertificates[0]!);
  const caB = publicCaBundle(rootCertificates[1]!);
  assert.notEqual(caA, caB);

  for (const scenario of [
    "changed CA",
    "pre-existing trust",
    "omitted CA",
    "missing trust",
  ] as const) {
    await t.test(scenario, async () => {
      const fixture = providerTrustFixture(caA);
      await fixture.prepareReady(fixture.predecessor);
      await fixture.activate(fixture.predecessor);
      const serving = fixture.gateway();
      if (scenario === "pre-existing trust") {
        fixture.saveTrust(fixture.successor, caA);
      }
      const writesBeforePreparation = fixture.gatewayWrites();
      assert.equal((await fixture.prepare(fixture.successor)).ready, true);
      assert.equal(fixture.gatewayWrites(), writesBeforePreparation);
      const preparedTrust = structuredClone(fixture.trust(fixture.successor));
      if (scenario === "missing trust") {
        fixture.removeTrust(fixture.successor);
      } else {
        fixture.setCa(scenario === "omitted CA" ? undefined : caB);
      }
      const beforeStatus = fixture.statusCalls.length;
      const beforeWrites = fixture.gatewayWrites();
      await assert.rejects(
        fixture.activate(fixture.successor),
        /immutable Kubernetes ConfigMap|prepared Harness trust/,
      );
      assert.equal(
        fixture.statusCalls.length,
        beforeStatus,
        "trust refusal precedes authenticated status",
      );
      assert.equal(fixture.gatewayWrites(), beforeWrites, "the serving Gateway is not replaced");
      assert.deepEqual(fixture.gateway(), serving);
      assert.deepEqual(preparedTrust?.data, { "ca-bundle.pem": caA });
      assert.equal(preparedTrust?.immutable, true);
      assert.deepEqual(
        fixture.trust(fixture.successor)?.data,
        scenario === "missing trust" ? undefined : { "ca-bundle.pem": caA },
      );
      assert.deepEqual(fixture.trust(fixture.predecessor)?.data, { "ca-bundle.pem": caA });
    });
  }

  for (const ca of [caA, undefined]) {
    await t.test(ca === undefined ? "CA-free cutover" : "unchanged CA cutover", async () => {
      const fixture = providerTrustFixture(ca);
      await fixture.prepareReady(fixture.predecessor);
      await fixture.activate(fixture.predecessor);
      const beforePreparation = fixture.gatewayWrites();
      assert.equal((await fixture.prepare(fixture.successor)).ready, true);
      assert.equal(fixture.gatewayWrites(), beforePreparation);
      assert.deepEqual(
        fixture.trust(fixture.successor)?.data,
        ca === undefined ? undefined : { "ca-bundle.pem": ca },
      );
      const beforeStatus = fixture.statusCalls.length;
      await fixture.activate(fixture.successor);
      assert.equal(fixture.statusCalls.length, beforeStatus + 1);
      assert.ok(fixture.gatewayWrites() > beforePreparation);
      assert.equal(
        (fixture.gateway().metadata.annotations as Record<string, string>)[
          "openclaw.dev/agent-revision-id"
        ],
        fixture.successor.id,
      );
    });
  }

  for (const scenario of ["changed CA", "omitted CA"] as const) {
    await t.test(`same revision rejects ${scenario}`, async () => {
      const fixture = providerTrustFixture(caA);
      await fixture.prepareReady(fixture.predecessor);
      await fixture.activate(fixture.predecessor);
      const serving = structuredClone(fixture.gateway());
      const beforeStatus = fixture.statusCalls.length;
      const beforeWrites = fixture.gatewayWrites();
      fixture.setCa(scenario === "omitted CA" ? undefined : caB);
      await assert.rejects(
        fixture.activate(fixture.predecessor),
        /immutable Kubernetes ConfigMap|prepared Harness trust/,
      );
      assert.equal(fixture.statusCalls.length, beforeStatus);
      assert.equal(fixture.gatewayWrites(), beforeWrites);
      assert.deepEqual(fixture.gateway(), serving);
      assert.deepEqual(fixture.trust(fixture.predecessor)?.data, { "ca-bundle.pem": caA });
    });
  }
});

test("Kubernetes provider Harness retains saved trust during repeated preparation", async (t) => {
  const caA = publicCaBundle(rootCertificates[0]!);
  for (const gatewayOwner of ["predecessor", "same revision"] as const) {
    await t.test(`${gatewayOwner} Gateway rejects omitted CA`, async () => {
      const fixture = providerTrustFixture(caA);
      await fixture.prepareReady(fixture.predecessor);
      await fixture.activate(fixture.predecessor);
      assert.equal((await fixture.prepare(fixture.successor)).ready, true);
      if (gatewayOwner === "same revision") {
        await fixture.activate(fixture.successor);
      }
      const serving = structuredClone(fixture.gateway());
      const savedTrust = structuredClone(fixture.trust(fixture.successor));
      assert.deepEqual(savedTrust?.data, { "ca-bundle.pem": caA });
      assert.equal(savedTrust?.immutable, true);
      const beforeStatus = fixture.statusCalls.length;
      const beforeWrites = fixture.gatewayWrites();
      fixture.setCa(undefined);

      // Re-preparation cannot replace the revision's saved private trust with
      // system trust, even if this revision already owns the shared Gateway.
      await assert.rejects(
        fixture.prepare(fixture.successor),
        /immutable Kubernetes ConfigMap|prepared Harness trust/,
      );
      assert.equal(
        fixture.statusCalls.length,
        beforeStatus,
        "trust refusal precedes authenticated status",
      );
      assert.equal(fixture.gatewayWrites(), beforeWrites, "the serving Gateway is not rewritten");
      assert.deepEqual(fixture.gateway(), serving);
      assert.deepEqual(fixture.trust(fixture.successor), savedTrust);
      assert.deepEqual(fixture.trust(fixture.predecessor)?.data, { "ca-bundle.pem": caA });
    });
  }

  for (const ca of [caA, undefined]) {
    await t.test(
      ca === undefined ? "CA-free repeated preparation" : "unchanged CA repeated preparation",
      async () => {
        const fixture = providerTrustFixture(ca);
        await fixture.prepareReady(fixture.predecessor);
        await fixture.activate(fixture.predecessor);
        assert.equal((await fixture.prepare(fixture.successor)).ready, true);
        const beforeStatus = fixture.statusCalls.length;
        const beforeWrites = fixture.gatewayWrites();
        assert.equal((await fixture.prepare(fixture.successor)).ready, true);
        assert.equal(fixture.statusCalls.length, beforeStatus + 1);
        assert.equal(fixture.gatewayWrites(), beforeWrites);
        assert.deepEqual(
          fixture.trust(fixture.successor)?.data,
          ca === undefined ? undefined : { "ca-bundle.pem": ca },
        );
        await fixture.activate(fixture.successor);
        await fixture.prepareReady(fixture.successor);
        assert.deepEqual(
          fixture.trust(fixture.successor)?.data,
          ca === undefined ? undefined : { "ca-bundle.pem": ca },
        );
      },
    );
  }

  await t.test("missing trust recovers through ordinary preparation", async () => {
    const fixture = providerTrustFixture(caA);
    await fixture.prepareReady(fixture.predecessor);
    await fixture.activate(fixture.predecessor);
    assert.equal((await fixture.prepare(fixture.successor)).ready, true);
    fixture.removeTrust(fixture.successor);
    const beforeStatus = fixture.statusCalls.length;
    const beforeWrites = fixture.gatewayWrites();
    await assert.rejects(fixture.activate(fixture.successor), /prepared Harness trust/);
    assert.equal(fixture.statusCalls.length, beforeStatus);
    assert.equal(fixture.gatewayWrites(), beforeWrites);
    assert.equal(fixture.trust(fixture.successor), undefined);
    // The read-only activation refusal must still permit the preparation
    // lifecycle to restore missing trust for the unchanged provider endpoint.
    assert.equal((await fixture.prepare(fixture.successor)).ready, true);
    assert.deepEqual(fixture.trust(fixture.successor)?.data, { "ca-bundle.pem": caA });
    assert.equal(fixture.trust(fixture.successor)?.immutable, true);
    await fixture.activate(fixture.successor);
    assert.equal(
      (fixture.gateway().metadata.annotations as Record<string, string>)[
        "openclaw.dev/agent-revision-id"
      ],
      fixture.successor.id,
    );
  });
});
