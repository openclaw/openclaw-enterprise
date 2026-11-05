import {
  requireConfiguration,
  ConfigurationValidationError as SharedConfigurationValidationError,
} from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import {
  KubernetesSecretDriver,
  SecretBackendUnavailableError,
  SecretOwnershipError,
  SecretValidationError,
} from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { withMutationDeadline } from "../../apps/controller/src/admission/mutation-deadline.ts";
import {
  controlledRequestTimeouts,
  FakeNamespaceCoreV1Api,
  frozenClock,
  injectedFailure,
  nextTurns,
  settlement,
  stallUntilAborted,
  untilSent,
} from "../helpers/kubernetes-core-api.mjs";
import {
  MINIMUM_SEND_BUDGET_MS,
  READ_RETRY_PAUSES_MS,
  withRetryTimers,
} from "../helpers/kubernetes-request-retry.mjs";

import { assertProtectedStaticSecretRead } from "../helpers/protected-static-secret-read.ts";

function clone(value) {
  return structuredClone(value);
}

class FakeCoreV1Api extends FakeNamespaceCoreV1Api {
  secretUid = undefined;
  secrets = new Map();
  reads = 0;
  deletes = [];
  readSecretFailureCodes = [];
  // Holds each Secret read until its request is aborted.
  readSecretStalls = false;
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

  async listNamespace(request) {
    this.called("listNamespace");
    return super.listNamespace(request);
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
        uid: this.secretUid ?? `uid-${this.secrets.size + 1}`,
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
    if (this.readSecretStalls) {
      await stallUntilAborted("readNamespacedSecret");
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

// A fake client with one OCC Namespace, a Driver that uses it, and a Secret identity there.
function namespacedDriver({ layout = "shared", name = "model-key" } = {}) {
  const client = new FakeCoreV1Api();
  const nsId = namespaceId();
  const namespace = client.addNamespace(nsId, layout);
  const driver = new KubernetesSecretDriver(
    { authentication: { mode: "inCluster" } },
    { id: "secret-kubernetes", implementation: "occ/kubernetes-secret" },
  );
  driver.client = Promise.resolve(client);
  const identity = { id: secretId(), namespaceId: nsId, name };
  // Creates one more Secret there, under a fresh Secret ID.
  const createFresh = () => driver.create({ ...identity, id: secretId() }, "value");
  return { client, nsId, namespace, driver, identity, createFresh };
}

// The same, with that Secret created, and the record OCC keeps for it.
async function storedSecret({ value = "stored-value", ...placement } = {}) {
  const setup = namespacedDriver(placement);
  const backendRef = await setup.driver.create(setup.identity, value);
  const secret = {
    ...setup.identity,
    driverId: setup.driver.id,
    backendRef,
    createdAt: new Date().toISOString(),
  };
  return { ...setup, backendRef, secret };
}

for (const layout of ["shared", "adopted", "split"]) {
  test(`kubernetes-secret-driver stores, verifies, updates, resolves, and deletes one exact Namespace Secret (${layout})`, async () => {
    const { client, nsId, namespace, driver, identity, backendRef, secret } = await storedSecret({
      layout,
    });
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
    stored.metadata.annotations["operator.example/retained"] = "true";
    await driver.update(secret, "rotated-value");
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
    assert.equal(updated.metadata.annotations["operator.example/retained"], "true");
    assert.equal(Buffer.from(updated.data.value, "base64").toString("utf8"), "rotated-value");
    assert.deepEqual(await driver.resolve(secret), backendRef);
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

    const deleted = { ...secret, backendRef: { ...backendRef, uid: updated.metadata.uid } };
    await driver.delete(deleted);
    assert.deepEqual(client.deletes[0], {
      uid: updated.metadata.uid,
      resourceVersion: updated.metadata.resourceVersion,
    });
    await assert.rejects(
      driver.withValue(secret, async () => assert.fail("deleted Secret must not be used")),
      SecretBackendUnavailableError,
    );
    await driver.delete(deleted);
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
      // delete does not compare the record's driverId: OCC picks the driver by it.
      deleteChecksDriver: false,
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
    {
      name: "foreign backend key",
      mutateBackendRef: (backendRef) => ({ ...backendRef, key: "token" }),
    },
    {
      name: "unmanaged Secret",
      mutateStored: (stored) => delete stored.metadata.labels["app.kubernetes.io/managed-by"],
    },
    {
      name: "service account token Secret",
      mutateStored: (stored) => (stored.type = "kubernetes.io/service-account-token"),
    },
    { name: "immutable Secret", mutateStored: (stored) => (stored.immutable = true) },
    { name: "Secret without its value key", mutateStored: (stored) => delete stored.data.value },
  ]) {
    const stored = await storedSecret({ value: "safe-value" });
    const { client, namespace, driver, backendRef } = stored;
    scenario.mutateStored?.(client.secrets.get(`${namespace}/${backendRef.name}`));
    const record = {
      ...stored.secret,
      backendRef: scenario.mutateBackendRef?.(backendRef) ?? backendRef,
    };
    const secret = scenario.mutateRecord?.(record) ?? record;
    await assert.rejects(driver.resolve(secret), SecretOwnershipError, scenario.name);
    await assert.rejects(
      driver.withValue(secret, async () => assert.fail("foreign Secret must not be used")),
      SecretOwnershipError,
      scenario.name,
    );
    if (scenario.deleteChecksDriver !== false) {
      await assert.rejects(driver.delete(secret), SecretOwnershipError, scenario.name);
      assert.equal(client.calls.deleteNamespacedSecret, 0, scenario.name);
      assert.equal(client.secrets.size, 1, scenario.name);
    }
  }

  const { client, driver, identity } = namespacedDriver();
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

  // Malformed identities and values are refused before any request, and nothing is stored,
  // even when a namespace carries the unprefixed ID.
  const unprefixed = `namespace_${randomUUID()}`;
  client.addNamespace(unprefixed);
  const listed = client.calls.listNamespace;
  for (const [name, invalid, value] of [
    ["Secret ID prefix", { ...identity, id: `secret_${randomUUID()}` }, "safe-value"],
    ["Namespace ID prefix", { ...identity, namespaceId: unprefixed }, "safe-value"],
    ["empty name", { ...identity, name: "" }, "safe-value"],
    // 65,537 UTF-8 bytes in 32,769 UTF-16 code units.
    ["one byte over the limit", identity, `${"é".repeat(32_768)}x`],
  ]) {
    await assert.rejects(() => driver.create(invalid, value), SecretValidationError, name);
  }
  assert.equal(client.calls.listNamespace, listed);
  assert.equal(client.secrets.size, 0);

  // Exactly 65,536 UTF-8 bytes fit.
  const largest = "é".repeat(32_768);
  const backendRef = await driver.create(identity, largest);
  const secret = {
    ...identity,
    driverId: driver.id,
    backendRef,
    createdAt: new Date().toISOString(),
  };
  // Updates and conditional writes refuse what a create refuses, and write nothing.
  await assert.rejects(driver.update(secret, ""), SecretValidationError);
  await assert.rejects(driver.compareAndSwap(secret, "", "safe-value"), SecretValidationError);
  // A record without a name or a backend reference is refused before it is used.
  await assert.rejects(driver.update({ ...secret, name: "" }, "safe-value"), SecretValidationError);
  await assert.rejects(driver.delete({ ...secret, name: "" }), SecretValidationError);
  await assert.rejects(driver.resolve({ ...secret, backendRef: undefined }), SecretValidationError);
  assert.equal(client.calls.replaceNamespacedSecret, 0);
  assert.equal(await driver.withValue(secret, async (value) => value), largest);

  // Each create gets a fresh backend name, so a failed create's cleanup can only find its own.
  const again = await driver.create(identity, "safe-value");
  assert.notEqual(again.name, backendRef.name);
  assert.equal(client.secrets.size, 2);

  // A create whose stored object lacks OCC ownership (a mutating webhook, say) is refused.
  const realCreate = client.createNamespacedSecret.bind(client);
  client.createNamespacedSecret = async (request) => {
    delete request.body.metadata.labels["openclaw.dev/secret"];
    return realCreate(request);
  };
  await assert.rejects(
    driver.create({ ...identity, id: secretId() }, "safe-value"),
    SecretOwnershipError,
  );
});

test("kubernetes-secret-driver refuses unknown options and implementations", () => {
  const authentication = { mode: "inCluster" };
  for (const options of [
    undefined,
    { authentication, clients: {} },
    { authentication, namespace: "default" },
  ]) {
    assert.throws(
      () => requireConfiguration(KubernetesSecretDriver, options),
      SharedConfigurationValidationError,
    );
  }
  assert.throws(
    () => new KubernetesSecretDriver({ authentication }, { implementation: "occ/other-secret" }),
    SecretValidationError,
  );
});

test("kubernetes-secret-driver rejects malformed or oversized stored values on transient use", async () => {
  const { client, namespace, driver, backendRef, secret } = await storedSecret({
    value: "safe-value",
  });
  const stored = client.secrets.get(`${namespace}/${backendRef.name}`);

  for (const encoded of [
    "",
    "not-base64!",
    "c2FmZS12YWx1ZQ==\n",
    // "a" with nonzero padding bits; its canonical form is "YQ==".
    "YR==",
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

test("kubernetes-secret-driver conditional writes preserve concurrent changes and Secret identity", async () => {
  const { client, namespace, driver, backendRef, secret } = await storedSecret({
    name: "agent-login",
    value: "pending-login",
  });
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
});

test("kubernetes-secret-driver delete reports inaccessible backends instead of idempotent success", async (t) => {
  // The read's own 10 s deadline fires on demand, so the timeout case does not wait for it.
  const timeouts = controlledRequestTimeouts(t);
  for (const failure of [403, 500, "timeout"]) {
    const { client, namespace, driver, backendRef, secret } = await storedSecret();
    const readCountBeforeDelete = client.reads;
    if (failure === "timeout") {
      client.readSecretStalls = true;
      const result = driver.delete(secret);
      try {
        await untilSent(() => client.reads > readCountBeforeDelete, "the read");
        timeouts.fireLatest();
        await assert.rejects(
          result,
          (error) =>
            error instanceof SecretBackendUnavailableError &&
            error.message === "The Kubernetes Secret read outcome is unknown after timeout.",
        );
      } finally {
        timeouts.fireAll();
        await result.catch(() => {});
      }
    } else {
      client.readSecretFailureCodes.push(...Array(6).fill(failure));
      await assert.rejects(
        () => withRetryTimers(() => driver.delete(secret)),
        SecretBackendUnavailableError,
      );
    }
    assert.equal(client.secrets.has(`${namespace}/${backendRef.name}`), true);
    assert.deepEqual(client.deletes, []);
    assert.ok(client.reads > readCountBeforeDelete);
  }
});

test("canonical storage discovery rejects ambiguous, foreign and insecure adopted targets before a write", async () => {
  for (const scenario of ["duplicate", "foreign", "unrestricted"]) {
    const { client, namespace, driver, identity } = namespacedDriver({ layout: "adopted" });
    const stored = client.namespaces.get(namespace);
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
    await assert.rejects(driver.create(identity, "safe-value"), SecretBackendUnavailableError);
    assert.equal(client.secrets.size, 0);
  }
});

// Dropped reads are retried: see the pause-schedule test below.
test("kubernetes-secret-driver ends a refused read at once", async () => {
  const { client, driver, secret } = await storedSecret();
  client.readSecretFailureCodes.push(403);
  const reads = client.reads;
  await assert.rejects(
    () => driver.resolve(secret),
    (error) =>
      error instanceof SecretBackendUnavailableError && /not authorized/.test(error.message),
  );
  assert.equal(client.reads - reads, 1);
});

test("kubernetes-secret-driver retries 429, 5xx and dropped reads on the pause schedule", async () => {
  for (const failure of ["dropped", 429, 500, 503]) {
    const { client, driver, secret } = await storedSecret();

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
    const { client, createFresh } = namespacedDriver();

    client.failureCodes.listNamespace.push(...Array(5).fill(failure));
    let pauses = [];
    await withRetryTimers(createFresh, pauses);
    assert.equal(client.calls.listNamespace, 6, String(failure));
    assert.deepEqual(pauses, READ_RETRY_PAUSES_MS, String(failure));
    assert.equal(client.secrets.size, 1, String(failure));

    client.failureCodes.listNamespace.push(...Array(6).fill(failure));
    pauses = [];
    await assert.rejects(
      () => withRetryTimers(createFresh, pauses),
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
      const { client, driver, secret } = await storedSecret();
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

const createFailed = (error) =>
  error instanceof SecretBackendUnavailableError &&
  error.message === "The Kubernetes Secret create failed.";
const ownershipRefused = (error) =>
  error instanceof SecretOwnershipError &&
  error.message === "Secret backend does not match exact OCC ownership.";
const cleanupFailed = (error) =>
  error instanceof SecretBackendUnavailableError &&
  error.message ===
    "The Kubernetes Secret create outcome is unknown, and its cleanup could not finish.";

test("kubernetes-secret-driver removes a Secret whose create applied but answered an error", async () => {
  // The create lands but its response is lost: OCC records no metadata for it, so the driver
  // removes the exact object it stored under its own name (finding 916).
  let { client, createFresh } = namespacedDriver();
  client.createAppliedFailureCodes.push("dropped");
  await assert.rejects(createFresh, createFailed);
  assert.equal(client.secrets.size, 0);
  assert.deepEqual(client.deletes, [{ uid: "uid-1", resourceVersion: "1" }]);

  // A create that never applied reads nothing back, deletes nothing, and keeps its own error.
  client.failureCodes.createNamespacedSecret.push("dropped");
  const reads = client.reads;
  const deletes = client.calls.deleteNamespacedSecret;
  await assert.rejects(createFresh, createFailed);
  assert.equal(client.reads - reads, 1);
  assert.equal(client.calls.deleteNamespacedSecret - deletes, 0);

  // An object under that name without this identity's exact ownership is never deleted, and
  // since it is not this create's, the create keeps its own error.
  ({ client, createFresh } = namespacedDriver());
  client.createAppliedMutation = (stored) => {
    stored.metadata.annotations["openclaw.dev/secret-id"] = secretId();
  };
  client.createAppliedFailureCodes.push("dropped");
  await assert.rejects(createFresh, createFailed);
  assert.equal(client.secrets.size, 1);
  assert.equal(client.calls.deleteNamespacedSecret, 0);

  // When the stored object cannot be read, the driver cannot tell whether the create applied,
  // so it says so instead of reporting a plain failure that may have left a Secret behind.
  ({ client, createFresh } = namespacedDriver());
  client.createAppliedFailureCodes.push("dropped");
  client.readSecretFailureCodes.push(403);
  await assert.rejects(createFresh, cleanupFailed);
  assert.equal(client.secrets.size, 1);
  assert.equal(client.calls.deleteNamespacedSecret, 0);

  // A failed cleanup delete is reported the same way.
  ({ client, createFresh } = namespacedDriver());
  client.createAppliedFailureCodes.push("dropped");
  client.failureCodes.deleteNamespacedSecret.push(503);
  await assert.rejects(createFresh, cleanupFailed);
  assert.equal(client.secrets.size, 1);
  assert.equal(client.calls.deleteNamespacedSecret, 1);
});

test("kubernetes-secret-driver cleans up a dropped create after the API mutation's deadline passed", async (t) => {
  // Finding 3106: an API mutation's Kubernetes calls end at its deadline. A create that was sent
  // in time, applied, and then lost its answer once the deadline had passed is still found and
  // removed: its cleanup calls keep their own timeouts instead of the spent deadline.
  const clock = frozenClock(t);
  const { client, createFresh } = namespacedDriver();
  const create = client.createNamespacedSecret.bind(client);
  client.createNamespacedSecret = async (request) => {
    clock.now += 5_000;
    return create(request);
  };
  client.createAppliedFailureCodes.push("dropped");
  await assert.rejects(withMutationDeadline(clock.now + 3_000, createFresh), createFailed);
  assert.equal(client.secrets.size, 0);
  assert.deepEqual(client.deletes, [{ uid: "uid-1", resourceVersion: "1" }]);
});

test("kubernetes-secret-driver sends no create and reads nothing back with less than the minimum send budget left", async (t) => {
  // A create sent just before an API mutation's deadline is likely cut off as "outcome unknown"
  // while the API server still stores the value, with no OCC row naming it. With less than
  // MINIMUM_SEND_BUDGET_MS left the create is refused as "not sent", and nothing is stored.
  // Finding 3108: nothing was sent, so no cleanup read runs past the deadline. A cleanup read
  // that failed would turn the clean "not sent" into "outcome unknown"; the queued 403 proves
  // no read happened.
  const clock = frozenClock(t);
  const { client, createFresh } = namespacedDriver();
  client.readSecretFailureCodes.push(403);
  await assert.rejects(
    withMutationDeadline(clock.now + MINIMUM_SEND_BUDGET_MS - 1, createFresh),
    (error) =>
      error instanceof SecretBackendUnavailableError &&
      error.message === "The Kubernetes Secret create was not sent: the request ran out of time.",
  );
  assert.equal(client.calls.createNamespacedSecret, 0);
  assert.equal(client.reads, 0);
  assert.equal(client.secrets.size, 0);
});

const stripSecretLabel = (body) => {
  delete body.metadata.labels["openclaw.dev/secret"];
};
// A client whose admission webhook rewrites what create stores (and so what it answers),
// with a hook to change the stored object after the answer and each delete's target recorded.
const webhookClient = ({ rewrite = () => {}, answer = () => {}, afterStore = () => {} }) => {
  const { client, createFresh } = namespacedDriver();
  const realCreate = client.createNamespacedSecret.bind(client);
  client.requested = [];
  client.createNamespacedSecret = async (request) => {
    const body = clone(request.body);
    rewrite(body);
    const answered = await realCreate({ ...request, body });
    client.requested.push(`${request.namespace}/${request.body.metadata.name}`);
    afterStore(client, `${request.namespace}/${request.body.metadata.name}`);
    answer(answered);
    return answered;
  };
  const realDelete = client.deleteNamespacedSecret.bind(client);
  client.deleted = [];
  client.deleteNamespacedSecret = async (request) => {
    client.deleted.push(`${request.namespace}/${request.name}`);
    return realDelete(request);
  };
  return { client, create: createFresh };
};

test("kubernetes-secret-driver deletes the exact Secret a refused create stored", async () => {
  // Whatever the webhook rewrote, the create is refused and the stored object, which holds the
  // value, is deleted by its name with the uid and resourceVersion it was answered with
  // (finding 1111).
  for (const [label, rewrite] of [
    ["label stripped", stripSecretLabel],
    [
      "driver annotation rewritten",
      (body) => {
        body.metadata.annotations["openclaw.dev/secret-driver-id"] = "other-driver";
      },
    ],
    [
      "type rewritten",
      (body) => {
        body.type = "kubernetes.io/basic-auth";
      },
    ],
    [
      "made immutable",
      (body) => {
        body.immutable = true;
      },
    ],
  ]) {
    const { client, create } = webhookClient({ rewrite });
    await assert.rejects(create, ownershipRefused, label);
    assert.equal(client.secrets.size, 0, label);
    assert.deepEqual(client.deletes, [{ uid: "uid-1", resourceVersion: "1" }], label);
    assert.deepEqual(client.deleted, client.requested, label);
  }

  // The delete targets the name this create chose, not one the answer claims, and the
  // answer's own refusal is what the caller sees.
  {
    const { client, create } = webhookClient({
      rewrite: stripSecretLabel,
      answer: (answered) => {
        answered.metadata.name = "secret-someone-else";
      },
    });
    await assert.rejects(create, ownershipRefused);
    assert.equal(client.secrets.size, 0);
    assert.deepEqual(client.deletes, [{ uid: "uid-1", resourceVersion: "1" }]);
    assert.deepEqual(client.deleted, client.requested);
  }

  // An accepted create deletes nothing.
  {
    const { client, create } = webhookClient({});
    await create();
    assert.equal(client.secrets.size, 1);
    assert.equal(client.calls.deleteNamespacedSecret, 0);
  }
});

test("kubernetes-secret-driver refuses a create answered under another name", async () => {
  // A nonconforming API server answers the create with exact OCC ownership but another
  // metadata.name. No backendRef names that object: the create is refused and the object it
  // stored under this create's name is deleted, pinned to the answered uid (finding 1121).
  const { client, create } = webhookClient({
    answer: (answered) => {
      answered.metadata.name = "secret-someone-else";
    },
  });
  await assert.rejects(create, ownershipRefused);
  assert.equal(client.secrets.size, 0);
  assert.deepEqual(client.deletes, [{ uid: "uid-1", resourceVersion: "1" }]);
  assert.deepEqual(client.deleted, client.requested);

  // Nothing under this create's name does not prove nothing was stored: the object may live
  // under the name it was answered with, so the outcome is reported as unknown.
  {
    const { client, create } = webhookClient({
      answer: (answered) => {
        answered.metadata.name = "secret-someone-else";
      },
      afterStore: (fake, key) => fake.secrets.delete(key),
    });
    await assert.rejects(create, cleanupFailed);
    assert.equal(client.calls.deleteNamespacedSecret, 1);
  }
});

test("kubernetes-secret-driver leaves an object that is no longer the refused answer alone", async () => {
  // An object that is no longer the one answered (replaced under that name, or rewritten
  // since) fails the delete preconditions and is left alone, and the driver reports that it
  // could not clean up instead of a plain refusal.
  for (const [label, field, value] of [
    ["replaced", "uid", "uid-other"],
    ["rewritten since", "resourceVersion", "2"],
  ]) {
    let replacement;
    const { client, create } = webhookClient({
      rewrite: stripSecretLabel,
      afterStore: (fake, key) => {
        replacement = clone(fake.secrets.get(key));
        replacement.metadata[field] = value;
        fake.secrets.set(key, replacement);
      },
    });
    await assert.rejects(create, cleanupFailed, label);
    assert.deepEqual(client.deletes, [{ uid: "uid-1", resourceVersion: "1" }], label);
    assert.deepEqual([...client.secrets.values()], [replacement], label);
  }
});

test("kubernetes-secret-driver reports a refused create it cannot clean up as an unknown outcome", async () => {
  // A delete the API server fails is sent once and reported as an unknown outcome, not
  // swallowed into the refusal.
  for (const failure of ["dropped", 403, 503]) {
    const { client, create } = webhookClient({ rewrite: stripSecretLabel });
    client.failureCodes.deleteNamespacedSecret.push(failure);
    const pauses = [];
    await assert.rejects(() => withRetryTimers(create, pauses), cleanupFailed, `${failure}`);
    assert.equal(client.secrets.size, 1, `${failure}`);
    assert.equal(client.calls.deleteNamespacedSecret, 1, `${failure}`);
    assert.deepEqual(pauses, [], `${failure}`);
  }

  // An object already gone needs no cleanup, so the refusal stands.
  {
    const { client, create } = webhookClient({
      rewrite: stripSecretLabel,
      afterStore: (fake, key) => fake.secrets.delete(key),
    });
    await assert.rejects(create, ownershipRefused);
    assert.equal(client.calls.deleteNamespacedSecret, 1);
  }

  // An answer without the uid or resourceVersion that would pin a delete cannot be cleaned up
  // safely, so nothing is deleted and the outcome is reported as unknown.
  for (const field of ["uid", "resourceVersion"]) {
    const { client, create } = webhookClient({
      rewrite: stripSecretLabel,
      answer: (answered) => {
        delete answered.metadata[field];
      },
    });
    await assert.rejects(create, cleanupFailed, field);
    assert.equal(client.secrets.size, 1, field);
    assert.equal(client.calls.deleteNamespacedSecret, 0, field);
  }
});

test("kubernetes-secret-driver ends a retry pause at once when the owner cancels", async () => {
  const { client, driver, secret } = await storedSecret();
  const owner = new AbortController();
  const reads = client.reads;
  client.readSecretFailureCodes.push("dropped", "dropped");

  // The mocked clock never moves: only the owner's abort can end the 100 ms pause.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const result = withComputeAbortSignal(owner.signal, () =>
      driver.withValue(secret, async () => assert.fail("a cancelled read must not be used")),
    );
    const state = settlement(result);
    await nextTurns(20, () => state.settled);
    assert.equal(state.settled, false, "the dropped read waits in its retry pause");
    assert.equal(client.reads - reads, 1);

    owner.abort();
    await nextTurns(20, () => state.settled);
    assert.equal(state.settled, true, "the owner's abort ends the pause");
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
  const { client, driver, secret } = await storedSecret();
  const owner = new AbortController();
  const reads = client.reads;
  // The read waits for its abort signal, then rejects with the abort reason.
  client.readSecretStalls = true;
  const result = withComputeAbortSignal(owner.signal, () => driver.resolve(secret));
  try {
    await untilSent(() => client.reads > reads, "the read");
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

test(
  "kubernetes-secret-driver protects versioned static reads by exact UID",
  { timeout: 5_000 },
  async (t) => {
    const { client, driver, identity } = namespacedDriver({ name: "protected-static" });
    client.secretUid = "00000000-0000-4000-8000-000000000010";
    await assertProtectedStaticSecretRead(
      t,
      driver,
      identity,
      (error) =>
        error instanceof SecretOwnershipError &&
        error.message === "Secret backend identity changed.",
    );
    t.after(() => {
      assert.equal(client.secrets.size, 0);
      assert.equal(client.calls.deleteNamespacedSecret, 1);
    });
  },
);
