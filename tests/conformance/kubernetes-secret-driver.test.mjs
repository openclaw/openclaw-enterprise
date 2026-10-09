import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import {
  KubernetesSecretDriver,
  SecretBackendUnavailableError,
  SecretConflictError,
  SecretOwnershipError,
  SecretValidationError,
} from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import {
  currentComputeAbortSignal,
  withComputeAbortSignal,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { READ_RETRY_PAUSES_MS, withRetryTimers } from "../helpers/kubernetes-request-retry.mjs";

function clone(value) {
  return structuredClone(value);
}

function injectedFailure(failureCode, method) {
  if (failureCode === "dropped") {
    // What the client throws when the API server closes the connection unanswered.
    return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  }
  return Object.assign(new Error(`${method} failed with ${failureCode}`), { code: failureCode });
}

function kubernetesNamespaceName(namespaceId) {
  return `oce-${createHash("sha256").update(namespaceId).digest("hex").slice(0, 15)}`;
}

class FakeCoreV1Api {
  namespaces = new Map();
  secrets = new Map();
  reads = 0;
  deletes = [];
  readSecretFailureCodes = [];
  readSecretTimesOut = false;
  // Failures queued per method, each thrown before the call takes effect.
  failureCodes = {
    listNamespace: [],
    createNamespacedSecret: [],
    replaceNamespacedSecret: [],
    deleteNamespacedSecret: [],
  };
  // Failures thrown after a create took effect, as when its response is lost.
  createAppliedFailureCodes = [];
  // Rewrites a Secret the create stored, before a later failure is thrown.
  createAppliedMutation = undefined;
  calls = {
    listNamespace: 0,
    createNamespacedSecret: 0,
    replaceNamespacedSecret: 0,
    deleteNamespacedSecret: 0,
  };

  called(method) {
    this.calls[method] += 1;
    const failureCode = this.failureCodes[method].shift();
    if (failureCode !== undefined) {
      throw injectedFailure(failureCode, method);
    }
  }

  addNamespace(namespaceId, layout = "shared") {
    const name =
      layout === "split"
        ? `oce-gateways-${createHash("sha256").update(namespaceId).digest("hex").slice(0, 24)}`
        : layout === "adopted"
          ? "customer-support"
          : kubernetesNamespaceName(namespaceId);
    this.namespaces.set(name, {
      metadata: {
        name,
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/gateway-namespace": namespaceId,
          ...(layout === "split" ? {} : { "openclaw.dev/namespace": namespaceId }),
          ...(layout === "adopted"
            ? Object.fromEntries(
                ["enforce", "audit", "warn"].map((mode) => [
                  `pod-security.kubernetes.io/${mode}`,
                  "restricted",
                ]),
              )
            : {}),
        },
        annotations: {
          "openclaw.dev/namespace-id": namespaceId,
          ...(layout === "adopted" ? { "openclaw.dev/namespace-lifecycle": "external" } : {}),
        },
      },
      status: { phase: "Active" },
    });
    return name;
  }

  async listNamespace({ labelSelector }) {
    this.called("listNamespace");
    const [label, namespaceId] = labelSelector.split("=");
    return {
      items: [...this.namespaces.values()].filter(
        ({ metadata }) => metadata.labels?.[label] === namespaceId,
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
    this.called("createNamespacedSecret");
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
    const appliedFailure = this.createAppliedFailureCodes.shift();
    if (appliedFailure !== undefined) {
      this.createAppliedMutation?.(stored);
      throw injectedFailure(appliedFailure, "createNamespacedSecret");
    }
    return clone(stored);
  }

  async readNamespacedSecret({ namespace, name }) {
    this.reads += 1;
    const failureCode = this.readSecretFailureCodes.shift();
    if (failureCode !== undefined) {
      throw injectedFailure(failureCode, "read");
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
    this.called("replaceNamespacedSecret");
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
    this.called("deleteNamespacedSecret");
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

for (const layout of ["shared", "adopted", "split"]) {
  test(`kubernetes-secret-driver stores, verifies, updates, resolves, and deletes one exact Namespace Secret (${layout})`, async () => {
    const client = new FakeCoreV1Api();
    const nsId = namespaceId();
    const namespace = client.addNamespace(nsId, layout);
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
    const secret = {
      ...identity,
      driverId: driver.id,
      backendRef,
      createdAt: new Date().toISOString(),
    };
    assert.equal(await driver.withValue(secret, async (value) => value), "rotated-value");
    await assert.rejects(
      driver.withValue({ ...secret, backendRef: { ...backendRef, uid: "foreign" } }, async () =>
        assert.fail("foreign Secret must not be used"),
      ),
      SecretOwnershipError,
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
    // The callback receives the exact stored UTF-8 text, including a leading byte-order mark.
    updated.data.value = Buffer.from("\uFEFFrotated-value").toString("base64");
    assert.equal(await driver.withValue(secret, async (value) => value), "\uFEFFrotated-value");

    // A corrupt backend value must not reach the consumer even when ownership matches.
    for (const malformed of ["%%%", "/w=="]) {
      updated.data.value = malformed;
      await assert.rejects(
        driver.withValue(secret, async () => assert.fail("invalid value must not be used")),
        SecretBackendUnavailableError,
      );
    }
    updated.data.value = Buffer.from("rotated-value").toString("base64");

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
    await assert.rejects(
      driver.withValue(secret, async () => assert.fail("deleted Secret must not be used")),
      SecretBackendUnavailableError,
    );
    await driver.delete({
      ...identity,
      driverId: driver.id,
      backendRef: { ...backendRef, uid: updated.metadata.uid },
      createdAt: new Date().toISOString(),
    });
  });
}

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
      name: "foreign namespace annotation",
      mutateStored: (stored) =>
        (stored.metadata.annotations["openclaw.dev/namespace-id"] = namespaceId()),
    },
    {
      name: "record owned by another Secret Driver",
      mutateRecord: (record) => ({ ...record, driverId: "secret-other-driver" }),
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
    const record = {
      ...identity,
      driverId: driver.id,
      backendRef: scenario.mutateBackendRef?.(backendRef) ?? backendRef,
      createdAt: new Date().toISOString(),
    };
    const secret = scenario.mutateRecord?.(record) ?? record;
    await assert.rejects(driver.resolve(secret), SecretOwnershipError, scenario.name);
    await assert.rejects(
      driver.withValue(secret, async () => assert.fail("foreign Secret must not be used")),
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

test("kubernetes-secret-driver rejects malformed or oversized stored values on transient use", async () => {
  const client = new FakeCoreV1Api();
  const nsId = namespaceId();
  const namespace = client.addNamespace(nsId);
  const driver = driverWithClient(client);
  const identity = { id: secretId(), namespaceId: nsId, name: "model-key" };
  const backendRef = await driver.create(identity, "safe-value");
  const secret = {
    ...identity,
    driverId: driver.id,
    backendRef,
    createdAt: new Date().toISOString(),
  };
  const stored = client.secrets.get(`${namespace}/${backendRef.name}`);

  for (const encoded of [
    "",
    "not-base64!",
    "c2FmZS12YWx1ZQ==\n",
    Buffer.from([0xff]).toString("base64"),
    Buffer.from("value\0suffix").toString("base64"),
    Buffer.alloc(65_537, "x").toString("base64"),
  ]) {
    stored.data.value = encoded;
    await assert.rejects(
      driver.withValue(secret, async () => assert.fail("invalid value must not be used")),
      SecretBackendUnavailableError,
    );
  }
});

test("kubernetes-secret-driver conditional writes preserve concurrent changes and Agent-owned credentials", async () => {
  const client = new FakeCoreV1Api();
  const nsId = namespaceId();
  const namespace = client.addNamespace(nsId);
  const driver = driverWithClient(client);
  const identity = { id: secretId(), namespaceId: nsId, name: "agent-login" };
  const backendRef = await driver.create(identity, "pending-login");
  const secret = {
    ...identity,
    driverId: driver.id,
    backendRef,
    createdAt: new Date().toISOString(),
  };
  const key = `${namespace}/${backendRef.name}`;

  assert.equal(await driver.compareAndSwap(secret, "other-login", "polling-login"), false);
  assert.equal(client.secrets.get(key).metadata.resourceVersion, "1");
  await assert.rejects(
    driver.compareAndSwap(
      { ...secret, backendRef: { ...backendRef, uid: "foreign-uid" } },
      "pending-login",
      "polling-login",
    ),
    SecretOwnershipError,
  );

  // Two pollers observe the same value. Kubernetes resourceVersion admits only one claim.
  const results = await Promise.all([
    driver.compareAndSwap(secret, "pending-login", "first-poller"),
    driver.compareAndSwap(secret, "pending-login", "second-poller"),
  ]);
  assert.deepEqual([...results].sort(), [false, true]);
  const winner = results[0] ? "first-poller" : "second-poller";
  assert.equal(await driver.withValue(secret, async (value) => value), winner);
  assert.equal(client.secrets.get(key).metadata.resourceVersion, "2");

  // The Agent's ownership marker fences both ordinary edits and stale conditional completion.
  for (const phase of ["claimed", "consumed"]) {
    const stored = client.secrets.get(key);
    stored.metadata.annotations["openclaw.dev/oauth-phase"] = phase;
    const before = clone(stored);
    assert.equal(await driver.compareAndSwap(secret, winner, "stale-completion"), false);
    await assert.rejects(driver.update(secret, "reset-login"), SecretConflictError);
    assert.deepEqual(client.secrets.get(key), before);
  }
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
      client.readSecretFailureCodes.push(...Array(6).fill(failure));
    }

    await assert.rejects(
      () =>
        failure === "timeout"
          ? driver.delete(secret)
          : withRetryTimers(() => driver.delete(secret)),
      SecretBackendUnavailableError,
    );
    assert.equal(client.secrets.has(`${namespace}/${backendRef.name}`), true);
    assert.deepEqual(client.deletes, []);
    assert.ok(client.reads > readCountBeforeDelete);
  }
});

test("canonical storage discovery rejects ambiguous, foreign and insecure adopted targets before a write", async () => {
  for (const scenario of ["duplicate", "foreign", "unrestricted"]) {
    const client = new FakeCoreV1Api();
    const nsId = namespaceId();
    const name = client.addNamespace(nsId, "adopted");
    const stored = client.namespaces.get(name);
    if (scenario === "duplicate") {
      const duplicate = clone(stored);
      duplicate.metadata.name = "second-claim";
      client.namespaces.set("second-claim", duplicate);
    }
    if (scenario === "foreign") {
      stored.metadata.annotations["openclaw.dev/namespace-id"] = namespaceId();
    }
    if (scenario === "unrestricted") {
      delete stored.metadata.labels["pod-security.kubernetes.io/enforce"];
    }
    await assert.rejects(
      driverWithClient(client).create(
        { id: secretId(), namespaceId: nsId, name: "model-key" },
        "safe-value",
      ),
      SecretBackendUnavailableError,
    );
    assert.equal(client.secrets.size, 0);
  }
});

test("kubernetes-secret-driver retries a read the API server dropped for a few seconds", async () => {
  const client = new FakeCoreV1Api();
  const nsId = namespaceId();
  client.addNamespace(nsId);
  const driver = driverWithClient(client);
  const identity = { id: secretId(), namespaceId: nsId, name: "model-key" };
  const backendRef = await driver.create(identity, "stored-value");
  const secret = {
    ...identity,
    driverId: driver.id,
    backendRef,
    createdAt: new Date().toISOString(),
  };

  // Five dropped reads in a row, then an answer: the read succeeds.
  client.readSecretFailureCodes.push(...Array(5).fill("dropped"));
  let reads = client.reads;
  assert.equal(
    await withRetryTimers(() => driver.withValue(secret, async (value) => value)),
    "stored-value",
  );
  assert.equal(client.reads - reads, 6);

  // A sixth drop ends the read as an unavailable backend.
  client.readSecretFailureCodes.push(...Array(6).fill("dropped"));
  reads = client.reads;
  await assert.rejects(
    () => withRetryTimers(() => driver.resolve(secret)),
    (error) =>
      error instanceof SecretBackendUnavailableError &&
      error.message === "The Kubernetes Secret read failed.",
  );
  assert.equal(client.reads - reads, 6);
  client.readSecretFailureCodes.length = 0;

  // A refused read is final at once.
  client.readSecretFailureCodes.push(403);
  reads = client.reads;
  await assert.rejects(() => driver.resolve(secret), SecretBackendUnavailableError);
  assert.equal(client.reads - reads, 1);
});

async function storedSecret(client) {
  const nsId = namespaceId();
  client.addNamespace(nsId);
  const driver = driverWithClient(client);
  const identity = { id: secretId(), namespaceId: nsId, name: "model-key" };
  const backendRef = await driver.create(identity, "stored-value");
  return {
    driver,
    secret: { ...identity, driverId: driver.id, backendRef, createdAt: new Date().toISOString() },
  };
}

test("kubernetes-secret-driver retries 429, 5xx and dropped reads on the pause schedule", async () => {
  for (const failure of ["dropped", 429, 500, 503]) {
    const client = new FakeCoreV1Api();
    const { driver, secret } = await storedSecret(client);

    // Five failures, then an answer: the read succeeds after the five scheduled pauses.
    client.readSecretFailureCodes.push(...Array(5).fill(failure));
    let reads = client.reads;
    let pauses = [];
    assert.equal(
      await withRetryTimers(() => driver.withValue(secret, async (value) => value), pauses),
      "stored-value",
      String(failure),
    );
    assert.equal(client.reads - reads, 6, String(failure));
    assert.deepEqual(pauses, READ_RETRY_PAUSES_MS, String(failure));

    // A sixth failure ends the read once the schedule is spent.
    client.readSecretFailureCodes.push(...Array(6).fill(failure));
    reads = client.reads;
    pauses = [];
    await assert.rejects(
      () => withRetryTimers(() => driver.resolve(secret), pauses),
      (error) =>
        error instanceof SecretBackendUnavailableError &&
        error.message === "The Kubernetes Secret read failed.",
      String(failure),
    );
    assert.equal(client.reads - reads, 6, String(failure));
    assert.deepEqual(pauses, READ_RETRY_PAUSES_MS, String(failure));
  }
});

test("kubernetes-secret-driver retries namespace verification like a read", async () => {
  for (const failure of ["dropped", 429, 503]) {
    const client = new FakeCoreV1Api();
    const nsId = namespaceId();
    client.addNamespace(nsId);
    const driver = driverWithClient(client);

    client.failureCodes.listNamespace.push(...Array(5).fill(failure));
    let pauses = [];
    await withRetryTimers(
      () => driver.create({ id: secretId(), namespaceId: nsId, name: "model-key" }, "value"),
      pauses,
    );
    assert.equal(client.calls.listNamespace, 6, String(failure));
    assert.deepEqual(pauses, READ_RETRY_PAUSES_MS, String(failure));
    assert.equal(client.secrets.size, 1, String(failure));

    client.failureCodes.listNamespace.push(...Array(6).fill(failure));
    pauses = [];
    await assert.rejects(
      () =>
        withRetryTimers(
          () => driver.create({ id: secretId(), namespaceId: nsId, name: "model-key" }, "value"),
          pauses,
        ),
      (error) =>
        error instanceof SecretBackendUnavailableError &&
        error.message === "The Kubernetes Secret namespace verification failed.",
      String(failure),
    );
    assert.equal(client.calls.listNamespace, 12, String(failure));
    assert.deepEqual(pauses, READ_RETRY_PAUSES_MS, String(failure));
    assert.equal(client.calls.createNamespacedSecret, 1, String(failure));
  }
});

test("kubernetes-secret-driver sends a failed write once, even when a read would retry", async () => {
  for (const failure of ["dropped", 429, 503]) {
    for (const [action, method, write] of [
      ["create", "createNamespacedSecret", (driver, secret) => driver.create(secret, "new-value")],
      ["update", "replaceNamespacedSecret", (driver, secret) => driver.update(secret, "new-value")],
      [
        "update",
        "replaceNamespacedSecret",
        (driver, secret) => driver.compareAndSwap(secret, "stored-value", "new-value"),
      ],
      ["delete", "deleteNamespacedSecret", (driver, secret) => driver.delete(secret)],
    ]) {
      const client = new FakeCoreV1Api();
      const { driver, secret } = await storedSecret(client);
      const target = action === "create" ? { ...secret, id: secretId() } : secret;
      const before = client.calls[method];
      client.failureCodes[method].push(failure);
      const pauses = [];
      await assert.rejects(
        () => withRetryTimers(() => write(driver, target), pauses),
        (error) =>
          error instanceof SecretBackendUnavailableError &&
          error.message === `The Kubernetes Secret ${action} failed.`,
        `${method} ${failure}`,
      );
      assert.equal(client.calls[method] - before, 1, `${method} ${failure}`);
      assert.deepEqual(pauses, [], `${method} ${failure}`);
    }
  }
});

test("kubernetes-secret-driver removes a Secret whose create applied but answered an error", async () => {
  const create = (driver, nsId) =>
    driver.create({ id: secretId(), namespaceId: nsId, name: "model-key" }, "value");
  const createFailed = (error) =>
    error instanceof SecretBackendUnavailableError &&
    error.message === "The Kubernetes Secret create failed.";
  const cleanupFailed = (error) =>
    error instanceof SecretBackendUnavailableError &&
    error.message ===
      "The Kubernetes Secret create outcome is unknown, and its cleanup could not finish.";

  // The create lands but its response is lost: OCC records no metadata for it, so the driver
  // removes the exact object it stored under its own name (finding 916).
  let client = new FakeCoreV1Api();
  let nsId = namespaceId();
  client.addNamespace(nsId);
  let driver = driverWithClient(client);
  client.createAppliedFailureCodes.push("dropped");
  await assert.rejects(() => create(driver, nsId), createFailed);
  assert.equal(client.secrets.size, 0);
  assert.deepEqual(client.deletes, [{ uid: "uid-1", resourceVersion: "1" }]);

  // A create that never applied reads nothing back, deletes nothing, and keeps its own error.
  client.failureCodes.createNamespacedSecret.push("dropped");
  const reads = client.reads;
  const deletes = client.calls.deleteNamespacedSecret;
  await assert.rejects(() => create(driver, nsId), createFailed);
  assert.equal(client.reads - reads, 1);
  assert.equal(client.calls.deleteNamespacedSecret - deletes, 0);

  // An object under that name without this identity's exact ownership is never deleted, and
  // since it is not this create's, the create keeps its own error.
  client = new FakeCoreV1Api();
  nsId = namespaceId();
  client.addNamespace(nsId);
  driver = driverWithClient(client);
  client.createAppliedMutation = (stored) => {
    stored.metadata.annotations["openclaw.dev/secret-id"] = secretId();
  };
  client.createAppliedFailureCodes.push("dropped");
  await assert.rejects(() => create(driver, nsId), createFailed);
  assert.equal(client.secrets.size, 1);
  assert.equal(client.calls.deleteNamespacedSecret, 0);

  // When the stored object cannot be read, the driver cannot tell whether the create applied,
  // so it says so instead of reporting a plain failure that may have left a Secret behind.
  client = new FakeCoreV1Api();
  nsId = namespaceId();
  client.addNamespace(nsId);
  driver = driverWithClient(client);
  client.createAppliedFailureCodes.push("dropped");
  client.readSecretFailureCodes.push(403);
  await assert.rejects(() => create(driver, nsId), cleanupFailed);
  assert.equal(client.secrets.size, 1);
  assert.equal(client.calls.deleteNamespacedSecret, 0);

  // A failed cleanup delete is reported the same way.
  client = new FakeCoreV1Api();
  nsId = namespaceId();
  client.addNamespace(nsId);
  driver = driverWithClient(client);
  client.createAppliedFailureCodes.push("dropped");
  client.failureCodes.deleteNamespacedSecret.push(503);
  await assert.rejects(() => create(driver, nsId), cleanupFailed);
  assert.equal(client.secrets.size, 1);
  assert.equal(client.calls.deleteNamespacedSecret, 1);
});

test("kubernetes-secret-driver ends a retry pause at once when the owner cancels", async () => {
  const client = new FakeCoreV1Api();
  const { driver, secret } = await storedSecret(client);
  const owner = new AbortController();
  const reads = client.reads;
  client.readSecretFailureCodes.push("dropped", "dropped");

  // The mocked clock never moves: only the owner's abort can end the 100 ms pause.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = false;
    const result = withComputeAbortSignal(owner.signal, () =>
      driver.withValue(secret, async () => assert.fail("a cancelled read must not be used")),
    );
    result.then(
      () => (settled = true),
      () => (settled = true),
    );
    const turns = async (count) => {
      for (let turn = 0; turn < count && !settled; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    // The fake client answers in microtasks, so a few turns reach the pause.
    await turns(20);
    assert.equal(settled, false, "the dropped read waits in its retry pause");
    assert.equal(client.reads - reads, 1);

    owner.abort();
    await turns(20);
    assert.equal(settled, true, "the owner's abort ends the pause");
    await assert.rejects(
      result,
      (error) =>
        error instanceof SecretBackendUnavailableError &&
        error.message === "The Kubernetes Secret read was cancelled.",
    );
    assert.equal(client.reads - reads, 1, "no read after the cancellation");
  } finally {
    // Settles the read even when an assertion above failed first.
    owner.abort();
    mock.timers.reset();
  }
});

test("kubernetes-secret-driver reports a read the owner cancels in flight as cancelled", async () => {
  const client = new FakeCoreV1Api();
  const { driver, secret } = await storedSecret(client);
  const owner = new AbortController();
  const reads = client.reads;
  // The read waits for its abort signal, then rejects with the abort reason.
  client.readSecretTimesOut = true;
  const result = withComputeAbortSignal(owner.signal, () => driver.resolve(secret));
  try {
    for (let turn = 0; client.reads === reads; turn += 1) {
      assert.ok(turn < 100, "the read was never sent");
      await new Promise((resolve) => setImmediate(resolve));
    }
    owner.abort(new Error("claim lost"));
    await assert.rejects(
      result,
      (error) =>
        error instanceof SecretBackendUnavailableError &&
        error.message === "The Kubernetes Secret read was cancelled.",
    );
    assert.equal(client.reads - reads, 1, "no read after the cancellation");
  } finally {
    // Settles the read even when an assertion above failed first.
    owner.abort(new Error("claim lost"));
    await result.catch(() => {});
  }
});
