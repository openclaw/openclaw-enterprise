import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { withMutationDeadline } from "../../apps/controller/src/admission/mutation-deadline.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import {
  type KubernetesSecretDriver,
  SecretBackendUnavailableError,
  SecretOwnershipError,
} from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import type { Secret } from "../../packages/contracts/src/index.ts";
import {
  MINIMUM_SEND_BUDGET_MS,
  READ_RETRY_PAUSES_MS,
  frozenClock,
  nextTurns,
  settlement,
  untilSent,
  withRetryTimers,
} from "../helpers/kubernetes-core-api.ts";
import type { FakeSecretCoreV1Api } from "../helpers/kubernetes-secret-core.mjs";
import { assertProtectedStaticSecretRead } from "../helpers/protected-static-secret-read.ts";
import type { SecretApi, SecretRequestFixtures } from "./kubernetes-secret-driver.test.ts";

type Failure = string | number;
type Method = keyof FakeSecretCoreV1Api["failureCodes"];

function queueFailures(client: FakeSecretCoreV1Api, method: Method, ...failures: Failure[]) {
  // The legacy fake's JS initializer cannot express the failure types accepted by every queue.
  const queue: unknown = client.failureCodes[method];
  assert.ok(isFailureQueue(queue));
  queue.push(...failures);
}

function queueAppliedFailure(client: FakeSecretCoreV1Api, failure: Failure) {
  const queue: unknown = client.createAppliedFailureCodes;
  assert.ok(isFailureQueue(queue));
  queue.push(failure);
}

function isFailureQueue(queue: unknown): queue is Failure[] {
  return (
    Array.isArray(queue) &&
    queue.every((value: unknown) => typeof value === "number" || typeof value === "string")
  );
}

export function registerSecretRequestCases({
  namespacedDriver,
  storedSecret,
  requireStoredSecret,
  isStoredSecret,
  secretId,
}: SecretRequestFixtures) {
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
      client.readSecretFailureCodes.push(...Array.from({ length: 5 }, () => failure));
      let reads = client.reads;
      let pauses: number[] = [];
      assert.equal(
        await withRetryTimers(() => driver.withValue(secret, async (value) => value), pauses),
        "stored-value",
        String(failure),
      );
      assert.equal(client.reads - reads, 6, String(failure));
      assert.deepEqual(pauses, READ_RETRY_PAUSES_MS, String(failure));

      // A sixth failure ends the read once the schedule is spent.
      client.readSecretFailureCodes.push(...Array.from({ length: 6 }, () => failure));
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

      queueFailures(client, "listNamespace", ...Array.from({ length: 5 }, () => failure));
      let pauses: number[] = [];
      await withRetryTimers(createFresh, pauses);
      assert.equal(client.calls.listNamespace, 6, String(failure));
      assert.deepEqual(pauses, READ_RETRY_PAUSES_MS, String(failure));
      assert.equal(client.secrets.size, 1, String(failure));

      queueFailures(client, "listNamespace", ...Array.from({ length: 6 }, () => failure));
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
    const writes: readonly [
      action: string,
      method: keyof FakeSecretCoreV1Api["calls"],
      write: (driver: KubernetesSecretDriver, secret: Secret) => Promise<unknown>,
    ][] = [
      ["create", "createNamespacedSecret", (driver, secret) => driver.create(secret, "new-value")],
      ["update", "replaceNamespacedSecret", (driver, secret) => driver.update(secret, "new-value")],
      [
        "update",
        "replaceNamespacedSecret",
        (driver, secret) => driver.compareAndSwap(secret, "stored-value", "new-value"),
      ],
      ["delete", "deleteNamespacedSecret", (driver, secret) => driver.delete(secret)],
    ];
    for (const failure of ["dropped", 429, 503]) {
      for (const [action, method, write] of writes) {
        const { client, driver, secret } = await storedSecret();
        const target = action === "create" ? { ...secret, id: secretId() } : secret;
        const before = client.calls[method];
        queueFailures(client, method, failure);
        const pauses: number[] = [];
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

  const createFailed = (error: unknown) =>
    error instanceof SecretBackendUnavailableError &&
    error.message === "The Kubernetes Secret create failed.";
  const ownershipRefused = (error: unknown) =>
    error instanceof SecretOwnershipError &&
    error.message === "Secret backend does not match exact OCC ownership.";
  const cleanupFailed = (error: unknown) =>
    error instanceof SecretBackendUnavailableError &&
    error.message ===
      "The Kubernetes Secret create outcome is unknown, and its cleanup could not finish.";

  test("kubernetes-secret-driver removes a Secret whose create applied but answered an error", async () => {
    // The create lands but its response is lost: OCC records no metadata for it, so the driver
    // removes the exact object it stored under its own name (finding 916).
    let { client, createFresh } = namespacedDriver();
    queueAppliedFailure(client, "dropped");
    await assert.rejects(createFresh, createFailed);
    assert.equal(client.secrets.size, 0);
    assert.deepEqual(client.deletes, [{ uid: "uid-1", resourceVersion: "1" }]);

    // A create that never applied reads nothing back, deletes nothing, and keeps its own error.
    queueFailures(client, "createNamespacedSecret", "dropped");
    const reads = client.reads;
    const deletes = client.calls.deleteNamespacedSecret;
    await assert.rejects(createFresh, createFailed);
    assert.equal(client.reads - reads, 1);
    assert.equal(client.calls.deleteNamespacedSecret - deletes, 0);

    // An object under that name without this identity's exact ownership is never deleted, and
    // since it is not this create's, the create keeps its own error.
    ({ client, createFresh } = namespacedDriver());
    const changeOwner = (stored: unknown) => {
      assert.ok(isStoredSecret(stored));
      stored.metadata.annotations["openclaw.dev/secret-id"] = secretId();
    };
    assert.equal(Reflect.set(client, "createAppliedMutation", changeOwner), true);
    queueAppliedFailure(client, "dropped");
    await assert.rejects(createFresh, createFailed);
    assert.equal(client.secrets.size, 1);
    assert.equal(client.calls.deleteNamespacedSecret, 0);

    // When the stored object cannot be read, the driver cannot tell whether the create applied,
    // so it says so instead of reporting a plain failure that may have left a Secret behind.
    ({ client, createFresh } = namespacedDriver());
    queueAppliedFailure(client, "dropped");
    client.readSecretFailureCodes.push(403);
    await assert.rejects(createFresh, cleanupFailed);
    assert.equal(client.secrets.size, 1);
    assert.equal(client.calls.deleteNamespacedSecret, 0);

    // A failed cleanup delete is reported the same way.
    ({ client, createFresh } = namespacedDriver());
    queueAppliedFailure(client, "dropped");
    queueFailures(client, "deleteNamespacedSecret", 503);
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
    client.createNamespacedSecret = async (
      request: Parameters<SecretApi["createNamespacedSecret"]>[0],
    ) => {
      clock.now += 5_000;
      return create(request);
    };
    queueAppliedFailure(client, "dropped");
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

  type CreateBody = Parameters<SecretApi["createNamespacedSecret"]>[0]["body"];
  type AnsweredSecret = Awaited<ReturnType<SecretApi["createNamespacedSecret"]>>;

  function stripSecretLabel(body: CreateBody): void {
    const labels = body.metadata?.labels;
    assert.ok(labels);
    delete labels["openclaw.dev/secret"];
  }

  type WebhookControls = {
    rewrite?: (body: CreateBody) => void;
    answer?: (metadata: NonNullable<AnsweredSecret["metadata"]>) => void;
    afterStore?: (client: FakeSecretCoreV1Api, key: string) => void;
  };
  // A client whose admission webhook rewrites what create stores (and so what it answers),
  // with a hook to change the stored object after the answer and each delete's target recorded.
  function webhookClient({ rewrite, answer, afterStore }: WebhookControls) {
    const { client, createFresh } = namespacedDriver();
    const realCreate = client.createNamespacedSecret.bind(client);
    const requested: string[] = [];
    client.createNamespacedSecret = async (
      request: Parameters<SecretApi["createNamespacedSecret"]>[0],
    ) => {
      const body: CreateBody = structuredClone(request.body);
      rewrite?.(body);
      const answered: unknown = await realCreate({ ...request, body });
      assert.ok(isStoredSecret(answered));
      const name: unknown = request.body.metadata?.name;
      assert.equal(typeof name, "string");
      const key = `${request.namespace}/${name}`;
      requested.push(key);
      afterStore?.(client, key);
      answer?.(answered.metadata);
      return answered;
    };
    const realDelete = client.deleteNamespacedSecret.bind(client);
    const deleted: string[] = [];
    client.deleteNamespacedSecret = async (
      request: Parameters<SecretApi["deleteNamespacedSecret"]>[0],
    ) => {
      deleted.push(`${request.namespace}/${request.name}`);
      return realDelete({ ...request, body: request.body });
    };
    return { client, create: createFresh, requested, deleted };
  }

  test("kubernetes-secret-driver deletes the exact Secret a refused create stored", async () => {
    // Whatever the webhook rewrote, the create is refused and the stored object, which holds the
    // value, is deleted by its name with the uid and resourceVersion it was answered with
    // (finding 1111).
    const rewrites: readonly [string, NonNullable<WebhookControls["rewrite"]>][] = [
      ["label stripped", stripSecretLabel],
      [
        "driver annotation rewritten",
        (body) => {
          const annotations = body.metadata?.annotations;
          assert.ok(annotations);
          annotations["openclaw.dev/secret-driver-id"] = "other-driver";
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
    ];
    for (const [label, rewrite] of rewrites) {
      const { client, create, requested, deleted } = webhookClient({ rewrite });
      await assert.rejects(create, ownershipRefused, label);
      assert.equal(client.secrets.size, 0, label);
      assert.deepEqual(client.deletes, [{ uid: "uid-1", resourceVersion: "1" }], label);
      assert.deepEqual(deleted, requested, label);
    }

    // The delete targets the name this create chose, not one the answer claims, and the
    // answer's own refusal is what the caller sees.
    {
      const { client, create, requested, deleted } = webhookClient({
        rewrite: stripSecretLabel,
        answer: (answered) => {
          answered.name = "secret-someone-else";
        },
      });
      await assert.rejects(create, ownershipRefused);
      assert.equal(client.secrets.size, 0);
      assert.deepEqual(client.deletes, [{ uid: "uid-1", resourceVersion: "1" }]);
      assert.deepEqual(deleted, requested);
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
    const { client, create, requested, deleted } = webhookClient({
      answer: (answered) => {
        answered.name = "secret-someone-else";
      },
    });
    await assert.rejects(create, ownershipRefused);
    assert.equal(client.secrets.size, 0);
    assert.deepEqual(client.deletes, [{ uid: "uid-1", resourceVersion: "1" }]);
    assert.deepEqual(deleted, requested);

    // Nothing under this create's name does not prove nothing was stored: the object may live
    // under the name it was answered with, so the outcome is reported as unknown.
    {
      const { client, create } = webhookClient({
        answer: (answered) => {
          answered.name = "secret-someone-else";
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
    ] as const) {
      let replacement: ReturnType<typeof requireStoredSecret> | undefined;
      const { client, create } = webhookClient({
        rewrite: stripSecretLabel,
        afterStore: (fake, key) => {
          replacement = structuredClone(requireStoredSecret(fake, key));
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
      queueFailures(client, "deleteNamespacedSecret", failure);
      const pauses: number[] = [];
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
    for (const field of ["uid", "resourceVersion"] as const) {
      const { client, create } = webhookClient({
        rewrite: stripSecretLabel,
        answer: (answered) => {
          delete answered[field];
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
      assert.equal(Reflect.set(client, "secretUid", "00000000-0000-4000-8000-000000000010"), true);
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
}
