import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  KubernetesSecretDriver,
  SecretBackendUnavailableError,
  SecretOwnershipError,
  SecretValidationError,
} from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";

function clone(value) {
  return structuredClone(value);
}

function kubernetesNamespaceName(namespaceId) {
  const slug =
    namespaceId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 46)
      .replace(/-+$/g, "") || "ns";
  return `oce-${slug}-${createHash("sha256").update(namespaceId).digest("hex").slice(0, 12)}`;
}

class FakeCoreV1Api {
  namespaces = new Map();
  secrets = new Map();
  reads = 0;
  deletes = [];
  readSecretFailureCodes = [];
  readSecretTimesOut = false;

  addNamespace(namespaceId) {
    const name = kubernetesNamespaceName(namespaceId);
    this.namespaces.set(name, {
      metadata: {
        name,
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/namespace": namespaceId,
        },
        annotations: { "openclaw.dev/namespace-id": namespaceId },
      },
      status: { phase: "Active" },
    });
    return name;
  }

  async listNamespace({ labelSelector }) {
    const [, namespaceId] = labelSelector.split("=");
    return {
      items: [...this.namespaces.values()].filter(
        ({ metadata }) => metadata.labels?.["openclaw.dev/namespace"] === namespaceId,
      ),
    };
  }

  async readNamespace({ name }) {
    const namespace = this.namespaces.get(name);
    if (namespace === undefined) {
      throw Object.assign(new Error("missing namespace"), { code: 404 });
    }
    return clone(namespace);
  }

  async createNamespacedSecret({ namespace, body }) {
    const key = `${namespace}/${body.metadata.name}`;
    if (this.secrets.has(key)) {
      throw Object.assign(new Error("conflict"), { code: 409 });
    }
    const stored = {
      ...clone(body),
      metadata: {
        ...body.metadata,
        uid: `uid-${this.secrets.size + 1}`,
        resourceVersion: "1",
      },
      data: Object.fromEntries(
        Object.entries(body.stringData).map(([name, value]) => [
          name,
          Buffer.from(value, "utf8").toString("base64"),
        ]),
      ),
    };
    delete stored.stringData;
    this.secrets.set(key, stored);
    return clone(stored);
  }

  async readNamespacedSecret({ namespace, name }) {
    this.reads += 1;
    const failureCode = this.readSecretFailureCodes.shift();
    if (failureCode !== undefined) {
      throw Object.assign(new Error(`read failed with ${failureCode}`), { code: failureCode });
    }
    if (this.readSecretTimesOut) {
      const signal = currentComputeAbortSignal();
      await new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    }
    const secret = this.secrets.get(`${namespace}/${name}`);
    if (secret === undefined) {
      throw Object.assign(new Error("missing secret"), { code: 404 });
    }
    return clone(secret);
  }

  async replaceNamespacedSecret({ namespace, name, body }) {
    const key = `${namespace}/${name}`;
    const existing = this.secrets.get(key);
    if (existing === undefined) {
      throw Object.assign(new Error("missing secret"), { code: 404 });
    }
    if (body.metadata.resourceVersion !== existing.metadata.resourceVersion) {
      throw Object.assign(new Error("resource version conflict"), { code: 409 });
    }
    const stored = {
      ...clone(body),
      metadata: {
        ...body.metadata,
        uid: existing.metadata.uid,
        resourceVersion: String(Number(existing.metadata.resourceVersion) + 1),
      },
      data: Object.fromEntries(
        Object.entries(body.stringData).map(([dataKey, value]) => [
          dataKey,
          Buffer.from(value, "utf8").toString("base64"),
        ]),
      ),
    };
    delete stored.stringData;
    this.secrets.set(key, stored);
    return clone(stored);
  }

  async deleteNamespacedSecret({ namespace, name, body }) {
    const key = `${namespace}/${name}`;
    const existing = this.secrets.get(key);
    if (existing === undefined) {
      throw Object.assign(new Error("missing secret"), { code: 404 });
    }
    const preconditions = body?.preconditions;
    this.deletes.push(clone(preconditions));
    if (
      preconditions?.uid !== existing.metadata.uid ||
      preconditions?.resourceVersion !== existing.metadata.resourceVersion
    ) {
      throw Object.assign(new Error("delete precondition conflict"), { code: 409 });
    }
    this.secrets.delete(key);
    return {};
  }
}

function secretId() {
  return `sec_${randomUUID()}`;
}

function namespaceId() {
  return `ns_${randomUUID()}`;
}

function driverWithClient(client) {
  const driver = new KubernetesSecretDriver(
    { authentication: { mode: "inCluster" } },
    { id: "secret-kubernetes", implementation: "occ/kubernetes-secret" },
  );
  driver.client = Promise.resolve(client);
  return driver;
}

test("kubernetes-secret-driver stores, verifies, updates, resolves, and deletes one exact Namespace Secret", async () => {
  const client = new FakeCoreV1Api();
  const nsId = namespaceId();
  const namespace = client.addNamespace(nsId);
  const driver = driverWithClient(client);
  const identity = { id: secretId(), namespaceId: nsId, name: "model-key" };

  const backendRef = await driver.create(identity, "stored-value");
  assert.equal(backendRef.namespaceName, namespace);
  assert.equal(backendRef.key, "value");
  assert.match(backendRef.name, /^secret-[a-f0-9]{12}-[a-f0-9]{12}-[a-f0-9]{12}$/);

  const stored = client.secrets.get(`${namespace}/${backendRef.name}`);
  assert.equal(stored.type, "Opaque");
  assert.equal(stored.immutable, false);
  assert.deepEqual(stored.metadata.labels, {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/namespace": nsId,
    "openclaw.dev/secret": identity.id,
  });
  assert.deepEqual(stored.metadata.annotations, {
    "openclaw.dev/namespace-id": nsId,
    "openclaw.dev/secret-id": identity.id,
    "openclaw.dev/secret-name": "model-key",
    "openclaw.dev/secret-driver-id": "secret-kubernetes",
  });

  stored.metadata.labels["operator.example/retained"] = "true";
  await driver.update(
    {
      ...identity,
      driverId: driver.id,
      backendRef,
      createdAt: new Date().toISOString(),
    },
    "rotated-value",
  );
  const updated = client.secrets.get(`${namespace}/${backendRef.name}`);
  assert.equal(updated.metadata.uid, backendRef.uid);
  assert.equal(updated.metadata.labels["operator.example/retained"], "true");
  assert.equal(Buffer.from(updated.data.value, "base64").toString("utf8"), "rotated-value");
  assert.deepEqual(
    await driver.resolve({
      ...identity,
      driverId: driver.id,
      backendRef,
      createdAt: new Date().toISOString(),
    }),
    backendRef,
  );

  await driver.delete({
    ...identity,
    driverId: driver.id,
    backendRef: { ...backendRef, uid: updated.metadata.uid },
    createdAt: new Date().toISOString(),
  });
  assert.deepEqual(client.deletes[0], {
    uid: updated.metadata.uid,
    resourceVersion: updated.metadata.resourceVersion,
  });
  await driver.delete({
    ...identity,
    driverId: driver.id,
    backendRef: { ...backendRef, uid: updated.metadata.uid },
    createdAt: new Date().toISOString(),
  });
});

test("kubernetes-secret-driver fails closed on missing placement, invalid values, and foreign backends", async () => {
  for (const scenario of [
    {
      name: "foreign namespace label",
      mutateStored: (stored) => (stored.metadata.labels["openclaw.dev/namespace"] = namespaceId()),
    },
    {
      name: "foreign Secret label",
      mutateStored: (stored) => (stored.metadata.labels["openclaw.dev/secret"] = secretId()),
    },
    {
      name: "foreign driver annotation",
      mutateStored: (stored) =>
        (stored.metadata.annotations["openclaw.dev/secret-driver-id"] = "other"),
    },
    {
      name: "foreign backend namespace",
      mutateBackendRef: (backendRef) => ({ ...backendRef, namespaceName: "foreign-namespace" }),
    },
    {
      name: "foreign backend UID",
      mutateBackendRef: (backendRef) => ({ ...backendRef, uid: "foreign-uid" }),
    },
  ]) {
    const client = new FakeCoreV1Api();
    const nsId = namespaceId();
    const namespace = client.addNamespace(nsId);
    const driver = driverWithClient(client);
    const identity = { id: secretId(), namespaceId: nsId, name: "model-key" };
    const backendRef = await driver.create(identity, "safe-value");
    scenario.mutateStored?.(client.secrets.get(`${namespace}/${backendRef.name}`));
    await assert.rejects(
      driver.resolve({
        ...identity,
        driverId: driver.id,
        backendRef: scenario.mutateBackendRef?.(backendRef) ?? backendRef,
        createdAt: new Date().toISOString(),
      }),
      SecretOwnershipError,
      scenario.name,
    );
  }

  const client = new FakeCoreV1Api();
  const nsId = namespaceId();
  client.addNamespace(nsId);
  const driver = driverWithClient(client);
  const identity = { id: secretId(), namespaceId: nsId, name: "model-key" };
  await assert.rejects(
    () => driver.create({ ...identity, id: secretId() }, ""),
    SecretValidationError,
  );
  await assert.rejects(
    () => driver.create({ ...identity, id: secretId() }, "\ud800"),
    SecretValidationError,
  );
  await assert.rejects(
    () => driver.create({ ...identity, id: secretId(), namespaceId: namespaceId() }, "safe-value"),
    SecretBackendUnavailableError,
  );
});

test("kubernetes-secret-driver delete reports inaccessible backends instead of idempotent success", async () => {
  for (const failure of [403, 500, "timeout"]) {
    const client = new FakeCoreV1Api();
    const nsId = namespaceId();
    const namespace = client.addNamespace(nsId);
    const driver = driverWithClient(client);
    const identity = { id: secretId(), namespaceId: nsId, name: "model-key" };
    const backendRef = await driver.create(identity, "stored-value");
    const secret = {
      ...identity,
      driverId: driver.id,
      backendRef,
      createdAt: new Date().toISOString(),
    };
    const readCountBeforeDelete = client.reads;
    if (failure === "timeout") {
      client.readSecretTimesOut = true;
    } else {
      client.readSecretFailureCodes.push(failure, failure, failure);
    }

    await assert.rejects(() => driver.delete(secret), SecretBackendUnavailableError);
    assert.equal(client.secrets.has(`${namespace}/${backendRef.name}`), true);
    assert.deepEqual(client.deletes, []);
    assert.ok(client.reads > readCountBeforeDelete);
  }
});
