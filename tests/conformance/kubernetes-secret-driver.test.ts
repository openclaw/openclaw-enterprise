import {
  requireConfiguration,
  ConfigurationValidationError as SharedConfigurationValidationError,
} from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  KubernetesSecretDriver,
  SecretBackendUnavailableError,
  SecretOwnershipError,
  SecretValidationError,
} from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import {
  controlledRequestTimeouts,
  untilSent,
  withRetryTimers,
} from "../helpers/kubernetes-core-api.ts";
import { FakeSecretCoreV1Api } from "../helpers/kubernetes-secret-core.mjs";
import type { Secret, SecretBackendRef } from "../../packages/contracts/src/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { registerSecretRequestCases } from "./kubernetes-secret-driver-request-cases.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
export type SecretApi = InstanceType<KubernetesSdk["CoreV1Api"]>;
type CreateSecretRequest = Parameters<SecretApi["createNamespacedSecret"]>[0];

type Placement = {
  layout?: NonNullable<Parameters<FakeSecretCoreV1Api["addNamespace"]>[1]>;
  name?: string;
};

type StoredSecret = {
  type?: string;
  immutable?: boolean;
  metadata: {
    uid: string;
    resourceVersion: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  data: Record<string, string>;
};

function isStringMap(value: unknown): value is Record<string, string> {
  const record = asRecord(value);
  return record !== undefined && Object.values(record).every((entry) => typeof entry === "string");
}

function isStoredSecret(value: unknown): value is StoredSecret {
  const secret = asRecord(value);
  const metadata = asRecord(secret?.metadata);
  return (
    metadata !== undefined &&
    typeof metadata.uid === "string" &&
    typeof metadata.resourceVersion === "string" &&
    isStringMap(metadata.labels) &&
    isStringMap(metadata.annotations) &&
    isStringMap(secret?.data) &&
    (secret?.type === undefined || typeof secret.type === "string") &&
    (secret?.immutable === undefined || typeof secret.immutable === "boolean")
  );
}

function requireStoredSecret(client: FakeSecretCoreV1Api, key: string): StoredSecret {
  const value: unknown = client.secrets.get(key);
  assert.ok(isStoredSecret(value), "Expected stored Secret metadata and encoded data");
  return value;
}

function secretId() {
  return `sec_${randomUUID()}`;
}

function namespaceId() {
  return `ns_${randomUUID()}`;
}

// A fake client with one OCC Namespace, a Driver that uses it, and a Secret identity there.
function namespacedDriver({ layout = "shared", name = "model-key" }: Placement = {}) {
  const client = new FakeSecretCoreV1Api();
  const nsId = namespaceId();
  const namespace = client.addNamespace(nsId, layout);
  const driver = new KubernetesSecretDriver(
    { authentication: { mode: "inCluster" } },
    { id: "secret-kubernetes", implementation: "occ/kubernetes-secret" },
  );
  assert.equal(Reflect.set(driver, "client", Promise.resolve(client)), true);
  const identity = { id: secretId(), namespaceId: nsId, name };
  // Creates one more Secret there, under a fresh Secret ID.
  const createFresh = () => driver.create({ ...identity, id: secretId() }, "value");
  return { client, nsId, namespace, driver, identity, createFresh };
}

// The same, with that Secret created, and the record OCC keeps for it.
async function storedSecret({
  value = "stored-value",
  ...placement
}: Placement & { value?: string } = {}) {
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

for (const layout of ["shared", "adopted", "split"] as const) {
  test(`kubernetes-secret-driver stores, verifies, updates, resolves, and deletes one exact Namespace Secret (${layout})`, async () => {
    const { client, nsId, namespace, driver, identity, backendRef, secret } = await storedSecret({
      layout,
    });
    assert.equal(backendRef.namespaceName, namespace);
    assert.equal(backendRef.key, "value");
    assert.match(backendRef.name, /^secret-[a-f0-9]{12}-[a-f0-9]{12}-[a-f0-9]{12}$/);

    const stored = requireStoredSecret(client, `${namespace}/${backendRef.name}`);
    assert.equal(stored.type, "Opaque");
    assert.equal(stored.immutable, false);
    assert.deepEqual<Record<string, string>>(stored.metadata.labels, {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      "openclaw.dev/namespace": nsId,
      "openclaw.dev/secret": identity.id,
    });
    assert.deepEqual<Record<string, string>>(stored.metadata.annotations, {
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
    const updated = requireStoredSecret(client, `${namespace}/${backendRef.name}`);
    assert.equal(updated.metadata.uid, backendRef.uid);
    assert.equal(updated.metadata.labels["operator.example/retained"], "true");
    assert.equal(updated.metadata.annotations["operator.example/retained"], "true");
    assert.ok(updated.data.value !== undefined);
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
  const scenarios: {
    name: string;
    mutateStored?: (stored: StoredSecret) => void;
    mutateRecord?: (record: Secret) => Secret;
    mutateBackendRef?: (backendRef: SecretBackendRef) => SecretBackendRef;
    deleteChecksDriver?: boolean;
  }[] = [
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
  ];
  for (const scenario of scenarios) {
    const stored = await storedSecret({ value: "safe-value" });
    const { client, namespace, driver, backendRef } = stored;
    scenario.mutateStored?.(requireStoredSecret(client, `${namespace}/${backendRef.name}`));
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
  ] as const) {
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
  await assert.rejects(
    // @ts-expect-error An absent backend reference must fail at the runtime boundary.
    driver.resolve({ ...secret, backendRef: undefined }),
    SecretValidationError,
  );
  assert.equal(client.calls.replaceNamespacedSecret, 0);
  assert.equal(await driver.withValue(secret, async (value) => value), largest);

  // Each create gets a fresh backend name, so a failed create's cleanup can only find its own.
  const again = await driver.create(identity, "safe-value");
  assert.notEqual(again.name, backendRef.name);
  assert.equal(client.secrets.size, 2);

  // A create whose stored object lacks OCC ownership (a mutating webhook, say) is refused.
  const realCreate = client.createNamespacedSecret.bind(client);
  client.createNamespacedSecret = async (request: CreateSecretRequest) => {
    const labels = request.body.metadata?.labels;
    assert.ok(labels);
    delete labels["openclaw.dev/secret"];
    return realCreate(request);
  };
  await assert.rejects(
    driver.create({ ...identity, id: secretId() }, "safe-value"),
    SecretOwnershipError,
  );
});

test("kubernetes-secret-driver refuses unknown options and implementations", () => {
  const authentication = { mode: "inCluster" } as const;
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
  const stored = requireStoredSecret(client, `${namespace}/${backendRef.name}`);

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
  assert.equal(requireStoredSecret(client, key).metadata.resourceVersion, "1");
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
  assert.equal(requireStoredSecret(client, key).metadata.resourceVersion, "2");
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
      client.readSecretFailureCodes.push(...Array.from({ length: 6 }, () => failure));
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
    assert.ok(stored, "The fixture must contain the adopted Namespace");
    if (scenario === "duplicate") {
      const duplicate = structuredClone(stored);
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

export type SecretRequestFixtures = {
  namespacedDriver: typeof namespacedDriver;
  storedSecret: typeof storedSecret;
  requireStoredSecret: typeof requireStoredSecret;
  isStoredSecret: typeof isStoredSecret;
  secretId: typeof secretId;
};

registerSecretRequestCases({
  namespacedDriver,
  storedSecret,
  requireStoredSecret,
  isStoredSecret,
  secretId,
});
