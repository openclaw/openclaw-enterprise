import assert from "node:assert/strict";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { GatewayNodeEnrollment } from "../../apps/controller/src/gateway/node-enrollment-client.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  authContext,
  digest,
  options,
  routedOptions,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type CoreApi = InstanceType<KubernetesSdk["CoreV1Api"]>;
type NetworkingApi = InstanceType<KubernetesSdk["NetworkingV1Api"]>;
type DeleteSecret = Parameters<CoreApi["deleteNamespacedSecret"]>[0];
type ReadSecret = Parameters<CoreApi["readNamespacedSecret"]>[0];
type ReplaceSecret = Parameters<CoreApi["replaceNamespacedSecret"]>[0];
type CreateSecret = Parameters<CoreApi["createNamespacedSecret"]>[0];
type WorkspaceNodeSecret = Omit<
  ReturnType<KubernetesComputeDriver["manifest"]>,
  "data" | "type"
> & {
  type: "Opaque";
  data: Record<string, string>;
};

const unexpectedEnrollment: GatewayNodeEnrollment = {
  async createSetup() {
    assert.fail("The Driver must not mint a workspace setup in this scenario");
  },
  async observeSetup() {
    assert.fail("The Driver must not read a workspace setup receipt in this scenario");
  },
  async isConnected() {
    assert.fail("The Driver must not probe workspace node credentials in this scenario");
  },
};

export async function checkAgentScopedWorkspaceNodeIdentity() {
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
    { nodeEnrollment: unexpectedEnrollment },
  );
  const revision = routedRevision(driver);
  const replacement = { ...revision, id: "revision-routed-2", revision: 2 };
  // OpenClaw keeps each session on its recorded device, so a replacement
  // AgentRevision must reconnect as the same node rather than enroll a new one.
  assert.equal(driver["workspaceNodeName"](replacement), driver["workspaceNodeName"](revision));
  assert.deepEqual(
    driver["workspaceNodeOwnership"](replacement),
    driver["workspaceNodeOwnership"](revision),
  );
  assert.equal(driver["workspaceNodeOwnership"](revision).revisionId, undefined);
  // A Harness change does not inherit another Harness kind's node.
  assert.notEqual(
    driver["workspaceNodeName"]({ ...revision, harness: { ...revision.harness, id: "codex" } }),
    driver["workspaceNodeName"]({ ...revision, harness: { ...revision.harness, id: "openclaw" } }),
  );
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
  const secrets = new Map(
    ["codex", "openclaw"].map((id, index) => {
      const name = driver["workspaceNodeName"]({ ...revision, harness: { id } });
      const secret = {
        ...driver["manifest"]("v1", "Secret", name, ownership, {
          name: namespace,
          plane: "execution",
        }),
        type: "Opaque",
      };
      secret.metadata.uid = `node-enrollment-uid-${index}`;
      return [name, secret];
    }),
  );
  const deleted: DeleteSecret[] = [];
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        async readNamespacedSecret({ name }: ReadSecret) {
          const secret = secrets.get(name);
          if (!secret) {
            throw Object.assign(new Error("not found"), { statusCode: 404 });
          }
          return structuredClone(secret);
        },
        async deleteNamespacedSecret(request: DeleteSecret) {
          deleted.push(request);
        },
      },
    }),
  });
  await driver["deleteWorkspaceNodes"](revision.agentId, ownership, {
    name: namespace,
    plane: "execution",
  });
  assert.deepEqual(
    deleted,
    [...secrets.values()].map((secret) => ({
      name: secret.metadata.name,
      namespace,
      body: { preconditions: { uid: secret.metadata.uid } },
    })),
  );
  deleted.length = 0;
  const foreign = { ...ownership, agentId: "another-agent" };
  for (const [name, secret] of secrets) {
    secrets.set(name, {
      ...secret,
      metadata: {
        ...secret.metadata,
        ...driver["manifest"]("v1", "Secret", name, foreign, {
          name: namespace,
          plane: "execution",
        }).metadata,
      },
    });
  }
  await assert.rejects(
    driver["deleteWorkspaceNodes"](revision.agentId, ownership, {
      name: namespace,
      plane: "execution",
    }),
    /Refusing unowned/,
  );
  assert.deepEqual(deleted, []);
  // Naming admits only the Harness kinds Agent deletion sweeps.
  assert.throws(
    () => driver["workspaceNodeName"]({ ...revision, harness: { id: "other" } }),
    /limited to Codex and OpenClaw/,
  );
}

export async function checkLegacyWorkspaceNodeRetirement() {
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
    { nodeEnrollment: unexpectedEnrollment },
  );
  const revision = routedRevision(driver);
  const namespace = {
    name: kubernetesNamespaceName(revision.namespaceId),
    plane: "execution",
  } as const;
  // Installations upgraded from revision-scoped enrollment still hold one
  // Secret per revision; the first replacement enrolls a new Agent device.
  const legacyName = `workspace-node-${digest(revision.agentId)}-${digest(revision.id)}`;
  const secret = (
    name: string,
    ownership: Parameters<KubernetesComputeDriver["manifest"]>[3],
    uid: string,
  ) => {
    const value = {
      ...driver["manifest"]("v1", "Secret", name, ownership, namespace),
      type: "Opaque",
    };
    value.metadata.uid = uid;
    return value;
  };
  const secrets = new Map([
    [legacyName, secret(legacyName, driver["pluginRuntimeOwnership"](revision), "legacy-uid")],
    [
      driver["workspaceNodeName"](revision),
      secret(
        driver["workspaceNodeName"](revision),
        driver["workspaceNodeOwnership"](revision),
        "agent",
      ),
    ],
  ]);
  const deleted: DeleteSecret[] = [];
  const notFound = async () => {
    throw Object.assign(new Error("not found"), { statusCode: 404 });
  };
  const survivingGateway = driver["manifest"](
    "apps/v1",
    "Deployment",
    `gateway-${digest(revision.agentId)}`,
    {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: "revision-routed-2",
    },
    namespace,
  );
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        async listNamespace() {
          return { items: [] };
        },
        async readNamespace() {
          return driver["manifest"]("v1", "Namespace", namespace.name, {
            namespaceId: revision.namespaceId,
          });
        },
        async listNamespacedPod() {
          return { items: [] };
        },
        readNamespacedConfigMap: notFound,
        async readNamespacedSecret({ name }: ReadSecret) {
          const secret = secrets.get(name);
          if (!secret) {
            throw Object.assign(new Error("not found"), { statusCode: 404 });
          }
          return structuredClone(secret);
        },
        async deleteNamespacedSecret(request: DeleteSecret) {
          deleted.push(request);
          secrets.delete(request.name);
        },
      },
      apps: {
        async readNamespacedDeployment({
          name,
        }: Parameters<InstanceType<KubernetesSdk["AppsV1Api"]>["readNamespacedDeployment"]>[0]) {
          if (name === survivingGateway.metadata.name) {
            return structuredClone(survivingGateway);
          }
          return notFound();
        },
      },
      networking: { readNamespacedNetworkPolicy: notFound },
      objects: { read: notFound },
    }),
  });
  const expected = [
    { name: legacyName, namespace: namespace.name, body: { preconditions: { uid: "legacy-uid" } } },
  ];
  await driver.retireRevision(revision);
  assert.deepEqual(deleted, expected);
  assert.equal(secrets.has(driver["workspaceNodeName"](revision)), true);
  // A replayed retirement finds nothing left to delete.
  await driver.retireRevision(revision);
  assert.deepEqual(deleted, expected);
}

export async function checkEnrolledWorkspaceNodePreservation() {
  const setups = [];
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
    }),
    {
      nodeEnrollment: {
        ...unexpectedEnrollment,
        async createSetup() {
          setups.push("setup");
          return {
            setupId: `setup-${setups.length + 1}`,
            setupCode: `code-${setups.length + 1}`,
            expiresAtMs: Date.now() + 600_000,
          };
        },
      },
    },
  );
  const revision = routedRevision(driver);
  const namespace = {
    name: kubernetesNamespaceName(revision.namespaceId),
    plane: "execution",
  } as const;
  const name = driver["workspaceNodeName"](revision);
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const deviceId = "a".repeat(64);
  // A replacement reconnects with the device token on the shared claim; the
  // expired setup must not replace that identity or credit the new revision.
  const secret: WorkspaceNodeSecret = {
    ...driver["manifest"](
      "v1",
      "Secret",
      name,
      driver["workspaceNodeOwnership"](revision),
      namespace,
    ),
    type: "Opaque",
    data: {
      setupId: encode("setup-1"),
      setupCode: encode("code-1"),
      expiresAtMs: encode("1"),
      deviceId: encode(deviceId),
      enrolledRevisionId: encode(revision.id),
    },
  };
  secret.metadata.uid = "enrolled-uid";
  secret.metadata.resourceVersion = "7";
  const enrolled = structuredClone(secret);
  const writes: [string, string | undefined, (string | undefined)?][] = [];
  driver["reconcile"] = async () => {};
  driver["gatewayReady"] = async () => true;
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        async readNamespacedSecret() {
          return structuredClone(secret);
        },
        async replaceNamespacedSecret({ name: target, body }: ReplaceSecret) {
          writes.push(["replace", target, body.metadata?.resourceVersion]);
        },
        async deleteNamespacedSecret(request: DeleteSecret) {
          writes.push(["delete", request.name]);
        },
        async createNamespacedSecret(request: CreateSecret) {
          writes.push(["create", request.body.metadata?.name]);
        },
      },
      networking: {
        async readNamespacedNetworkPolicy() {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        },
      },
    }),
  });
  const replacement = { ...revision, id: "revision-routed-2", revision: 2 };
  assert.deepEqual(await driver["prepareWorkspaceNode"](replacement, namespace), {
    name,
  });
  assert.deepEqual(writes, []);
  assert.equal(setups.length, 0);
  assert.deepEqual(secret, enrolled);
  // Repeated reconciliation keeps the same persisted identity.
  assert.deepEqual(await driver["prepareWorkspaceNode"](replacement, namespace), {
    name,
  });
  assert.deepEqual(writes, []);
  assert.equal(setups.length, 0);
  assert.deepEqual(secret, enrolled);
}

export async function checkExpiredWorkspaceNodeSetup() {
  for (const redeemed of [true, false]) {
    const setups = [];
    const observed: string[] = [];
    const deviceId = "b".repeat(64);
    const driver = new KubernetesComputeDriver(
      routedOptions({
        runtime: {
          transportSecretPrefix: "transport",
          gatewayStorageClassName: "local-path",
        },
      }),
      {
        nodeEnrollment: {
          async createSetup() {
            setups.push("setup");
            return { setupId: "setup-b", setupCode: "code-b", expiresAtMs: Date.now() + 600_000 };
          },
          async isConnected() {
            return true;
          },
          async observeSetup(_url, setupId) {
            observed.push(setupId);
            return redeemed ? { deviceId, delivery: "confirmed" } : undefined;
          },
        },
      },
    );
    const revision = routedRevision(driver);
    const namespace = {
      name: kubernetesNamespaceName(revision.namespaceId),
      plane: "execution",
    } as const;
    const name = driver["workspaceNodeName"](revision);
    const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
    // An expired setup may have been redeemed before readiness could record it.
    let secret: WorkspaceNodeSecret = {
      ...driver["manifest"](
        "v1",
        "Secret",
        name,
        driver["workspaceNodeOwnership"](revision),
        namespace,
      ),
      type: "Opaque",
      data: { setupId: encode("setup-a"), setupCode: encode("code-a"), expiresAtMs: encode("1") },
    };
    secret.metadata.uid = "unobserved-uid";
    secret.metadata.resourceVersion = "3";
    const metadata = structuredClone(secret.metadata);
    const writes: (string | undefined)[] = [];
    driver["reconcile"] = async () => {};
    driver["gatewayReady"] = async () => true;
    Object.assign(driver, {
      apiClients: Promise.resolve({
        core: {
          async readNamespacedSecret() {
            return structuredClone(secret);
          },
          async replaceNamespacedSecret({ name: target, body }: ReplaceSecret) {
            assert.ok(body.metadata?.name && body.data);
            assert.equal(body.kind, "Secret");
            assert.equal(body.apiVersion, "v1");
            assert.equal(body.type, "Opaque");
            assert.equal(target, name);
            assert.equal(body.metadata.resourceVersion, secret.metadata.resourceVersion);
            writes.push(body.metadata.resourceVersion);
            secret = {
              apiVersion: body.apiVersion,
              kind: body.kind,
              metadata: {
                ...body.metadata,
                name: body.metadata.name,
                resourceVersion: String(Number(body.metadata.resourceVersion) + 1),
              },
              type: body.type,
              data: structuredClone(body.data),
            };
          },
        },
        networking: {
          async readNamespacedNetworkPolicy() {
            throw Object.assign(new Error("not found"), { statusCode: 404 });
          },
        },
      }),
    });
    const expectedSetupId = redeemed ? "setup-a" : "setup-b";
    assert.deepEqual(await driver["prepareWorkspaceNode"](revision, namespace), {
      name,
    });
    assert.deepEqual(observed, ["setup-a"]);
    assert.deepEqual(writes, redeemed ? ["3", "4"] : ["3"]);
    assert.equal(setups.length, redeemed ? 0 : 1);
    assert.deepEqual(secret.metadata, { ...metadata, resourceVersion: redeemed ? "5" : "4" });
    const data = Object.fromEntries(
      Object.entries(secret.data).map(([key, value]) => [
        key,
        Buffer.from(value, "base64").toString(),
      ]),
    );
    assert.equal(data.setupId, expectedSetupId);
    assert.equal(data.setupCode, redeemed ? "code-a" : "code-b");
    if (redeemed) {
      assert.equal(data.expiresAtMs, "1");
    } else {
      assert.ok(Number(data.expiresAtMs) > Date.now());
    }
    assert.equal(data.deviceId, redeemed ? deviceId : undefined);
    // The readiness check credits the revision whose node connects, not an observed setup.
    assert.equal(data.enrolledRevisionId, undefined);
    // Neither the newly recorded device nor a current setup needs another mint.
    assert.deepEqual(await driver["prepareWorkspaceNode"](revision, namespace), {
      name,
    });
    assert.deepEqual(observed, ["setup-a"]);
    assert.deepEqual(writes, redeemed ? ["3", "4"] : ["3"]);
    assert.equal(setups.length, redeemed ? 0 : 1);
  }
}

export async function checkActivationWorkspaceNodeRefusals() {
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
      },
      // The controller reads the Gateway's ack, so the node travels in the binding.
      network: { pluginStatusProxySourceCidrs: ["192.0.2.20/32"] },
    }),
    { nodeEnrollment: unexpectedEnrollment },
  );
  const admitted = routedRevision(driver);
  const revision = {
    ...admitted,
    configuration: admitLoggingConfiguration(admitted.configuration, "info"),
  };
  const context = { ...authContext(revision), secretEnvironment: [] };
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  let secret:
    | (ReturnType<KubernetesComputeDriver["manifest"]> & { data: Record<string, string> })
    | undefined;
  const policies = [
    ...driver["networkPolicies"](
      { namespaceId: tenant.id },
      { name: namespace, plane: "execution" },
    ),
    ...driver["networkPolicies"](
      { namespaceId: tenant.id },
      { name: kubernetesNamespaceName(tenant.id), plane: "control" },
    ),
  ];
  const gatewayName = `gateway-${digest(revision.agentId)}`;
  const gateway = driver["deployment"](
    gatewayName,
    { namespaceId: tenant.id, agentId: revision.agentId },
    { name: kubernetesNamespaceName(tenant.id), plane: "control" },
    options().images.gateway,
    gatewayName,
    "gateway",
    {},
    "info",
    driver["gatewayConfiguration"](revision, "previous-device", {
      name: kubernetesNamespaceName(tenant.id),
      plane: "execution",
    }),
  );
  const pod = asRecord(asRecord(gateway.spec?.template)?.spec);
  assert.ok(Array.isArray(pod?.containers));
  const env = asRecord(pod.containers[0])?.env;
  assert.ok(Array.isArray(env));
  assert.equal(
    env.some((variable) => asRecord(variable)?.name === "OPENCLAW_WORKSPACE_NODE_ID"),
    false,
  );
  const binding = {
    ...driver["manifest"](
      "v1",
      "ConfigMap",
      `gateway-${digest(revision.agentId)}-workspace-node`,
      { namespaceId: tenant.id, agentId: revision.agentId },
      { name: kubernetesNamespaceName(tenant.id), plane: "control" },
    ),
    data: {
      "workspace-node.json": JSON.stringify({
        revisionId: revision.id,
        deviceId: "previous-device",
      }),
    },
  };
  // Only Kubernetes reads are available: activation must reject before any write
  // or selecting a candidate Harness when its exact enrollment is unavailable.
  Object.assign(driver, {
    apiClients: Promise.resolve({
      core: {
        async listNamespace() {
          return { items: [] };
        },
        async readNamespace({ name }: Parameters<CoreApi["readNamespace"]>[0]) {
          return {
            ...(name === kubernetesNamespaceName(tenant.id)
              ? driver["gatewayNamespaceManifest"]({ namespaceId: tenant.id })
              : driver["manifest"]("v1", "Namespace", namespace, { namespaceId: tenant.id })),
            status: { phase: "Active" },
          };
        },
        async readNamespacedSecret() {
          if (secret === undefined) {
            throw Object.assign(new Error("not found"), { statusCode: 404 });
          }
          return structuredClone(secret);
        },
        // The serving Codex Gateway learned its node from the Agent-scoped binding,
        // not its pod spec.
        async readNamespacedConfigMap({ name }: Parameters<CoreApi["readNamespacedConfigMap"]>[0]) {
          assert.equal(name, `gateway-${digest(revision.agentId)}-workspace-node`);
          return structuredClone(binding);
        },
      },
      apps: {
        async readNamespacedDeployment() {
          return structuredClone(gateway);
        },
      },
      networking: {
        async readNamespacedNetworkPolicy({
          name,
          namespace: target,
        }: Parameters<NetworkingApi["readNamespacedNetworkPolicy"]>[0]) {
          return structuredClone(
            policies.find(
              (policy) => policy.metadata.name === name && policy.metadata.namespace === target,
            ),
          );
        },
      },
    }),
  });
  await assert.rejects(
    driver.activateRevision(revision, context),
    /workspace node is not enrolled/,
  );
  // Losing enrollment metadata after activation must not switch document reads
  // back to the stale Gateway workspace on the next preparation pass.
  await assert.rejects(
    driver.prepareRevision(revision, context),
    /workspace node binding cannot change/,
  );
  secret = {
    ...driver["manifest"](
      "v1",
      "Secret",
      driver["workspaceNodeName"](revision),
      { namespaceId: revision.namespaceId, agentId: "another-agent" },
      { name: namespace, plane: "execution" },
    ),
    data: { deviceId: Buffer.from("previous-device").toString("base64") },
  };
  await assert.rejects(
    driver.activateRevision(revision, context),
    /ownership|another|revision|Refusing/i,
  );
  // The binding is controller-owned: one that names another Agent is refused,
  // not read.
  secret = undefined;
  binding.metadata = driver["manifest"](
    "v1",
    "ConfigMap",
    binding.metadata.name,
    { namespaceId: tenant.id, agentId: "another-agent" },
    { name: kubernetesNamespaceName(tenant.id), plane: "control" },
  ).metadata;
  await assert.rejects(
    driver.prepareRevision(revision, context),
    /Refusing unowned Kubernetes ConfigMap gateway-[a-f0-9]{12}-workspace-node/,
  );
}
