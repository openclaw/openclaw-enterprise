import assert from "node:assert/strict";
import test from "node:test";
import type { Namespace, NamespaceLifecycleHooks } from "@openclaw-enterprise/contracts";
import {
  reconcileNamespaceLifecycle,
  selectedNamespaceLifecycle,
} from "../../packages/occ/src/namespace-lifecycle.ts";
import { createReadyComputeDriver } from "../helpers/development.ts";

const namespace: Namespace = {
  id: "namespace-a",
  name: "support",
  status: "provisioning",
  createdAt: "2026-11-06T00:00:00Z",
};
const signal = () => new AbortController().signal;

function owner(id: string, namespaceLifecycleHooks: NamespaceLifecycleHooks) {
  return {
    id,
    implementation: "lifecycle-contract-fixture",
    capability: "configuration" as const,
    namespaceLifecycleHooks,
  };
}

test("Namespace reconciliation stops at pending Compute and retries participants in registration order", async () => {
  const effects: string[] = [];
  let infrastructureReady = false;
  let providerReady = false;
  const compute = createReadyComputeDriver("compute", {
    async ensureNamespace() {
      return { namespaceId: namespace.id, namespaceReady: infrastructureReady };
    },
  });
  const first = owner("a", {
    async ensureNamespace() {
      effects.push("a");
      return { namespaceId: namespace.id, namespaceReady: providerReady };
    },
  });
  const last = owner("z", {
    async ensureNamespace() {
      effects.push("z");
      return { namespaceId: namespace.id, namespaceReady: true };
    },
  });
  const participants = selectedNamespaceLifecycle([last, first, first]);
  const run = () =>
    reconcileNamespaceLifecycle(compute, participants, namespace, "ready", signal(), () => {});
  assert.deepEqual(await run(), { namespaceId: namespace.id, namespaceReady: false });
  assert.deepEqual(effects, []);
  infrastructureReady = true;
  assert.deepEqual(await run(), { namespaceId: namespace.id, namespaceReady: false });
  assert.deepEqual(effects, ["a"]);
  providerReady = true;
  assert.deepEqual(await run(), { namespaceId: namespace.id, namespaceReady: true });
  assert.deepEqual(effects, ["a", "a", "z"]);
});

test("Namespace hooks cannot change scope or expose thrown provider details", async () => {
  const compute = createReadyComputeDriver("compute");
  for (const ensureNamespace of [
    async () => ({ namespaceId: "foreign", namespaceReady: true }),
    async () => ({ namespaceId: namespace.id, namespaceReady: true, namespaceDeleted: true }),
    async () => ({ namespaceId: namespace.id, installationId: "foreign", namespaceReady: true }),
  ]) {
    const result = await reconcileNamespaceLifecycle(
      compute,
      selectedNamespaceLifecycle([owner("provider", { ensureNamespace })]),
      namespace,
      "ready",
      signal(),
      () => {},
    );
    assert.deepEqual(result, {
      namespaceId: namespace.id,
      namespaceReady: false,
      failure: "permanent",
    });
  }
  const mutable = structuredClone(namespace);
  const result = await reconcileNamespaceLifecycle(
    compute,
    selectedNamespaceLifecycle([
      owner("provider", {
        async ensureNamespace({ namespace: snapshot }) {
          assert.throws(() => Object.assign(snapshot, { id: "foreign" }), TypeError);
          throw new Error("provider response must stay private");
        },
      }),
    ]),
    mutable,
    "ready",
    signal(),
    () => {},
  );
  assert.deepEqual(result, {
    namespaceId: namespace.id,
    namespaceReady: false,
    failure: "retryable",
  });
  assert.deepEqual(mutable, namespace);
});

test("lost Namespace claims start no later hooks and perform no compensation", async () => {
  const abort = new AbortController();
  const effects: string[] = [];
  const participants = selectedNamespaceLifecycle([
    owner("a", {
      async ensureNamespace({ signal: supplied }) {
        assert.equal(supplied, abort.signal);
        effects.push("prepared");
        abort.abort();
        return { namespaceId: namespace.id, namespaceReady: true };
      },
      async deleteNamespace() {
        effects.push("compensated");
        return { namespaceId: namespace.id, namespaceDeleted: true };
      },
    }),
    owner("b", {
      async ensureNamespace() {
        effects.push("late");
        return { namespaceId: namespace.id, namespaceReady: true };
      },
    }),
  ]);
  await assert.rejects(
    reconcileNamespaceLifecycle(
      createReadyComputeDriver("compute"),
      participants,
      namespace,
      "ready",
      abort.signal,
      () => {},
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(effects, ["prepared"]);
});

test("Namespace deletion checks eligibility before reverse cleanup and infrastructure removal", async () => {
  const effects: string[] = [];
  let allowed = false;
  let complete = false;
  let unclaimed = false;
  const compute = createReadyComputeDriver("compute", {
    async checkNamespaceDeletion() {
      return {
        namespaceId: namespace.id,
        deletionAllowed: allowed,
        ...(unclaimed ? { skipParticipantCleanup: true as const } : {}),
        ...(allowed ? {} : { failure: "permanent" as const }),
      };
    },
    async deleteNamespace() {
      effects.push("infrastructure");
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
  });
  const participants = selectedNamespaceLifecycle(
    ["a", "z"].map((id) =>
      owner(id, {
        async ensureNamespace() {
          return { namespaceId: namespace.id, namespaceReady: true };
        },
        async deleteNamespace() {
          effects.push(id);
          return { namespaceId: namespace.id, namespaceDeleted: complete };
        },
      }),
    ),
  );
  const run = () =>
    reconcileNamespaceLifecycle(compute, participants, namespace, "deleted", signal(), () => {});
  assert.deepEqual(await run(), {
    namespaceId: namespace.id,
    namespaceDeleted: false,
    failure: "permanent",
  });
  assert.deepEqual(effects, []);
  allowed = true;
  assert.deepEqual(await run(), { namespaceId: namespace.id, namespaceDeleted: false });
  assert.deepEqual(effects, ["z"]);
  complete = true;
  assert.deepEqual(await run(), { namespaceId: namespace.id, namespaceDeleted: true });
  assert.deepEqual(effects, ["z", "z", "a", "infrastructure"]);
  // An unclaimed external namespace cannot be passed to provider cleanup.
  unclaimed = true;
  effects.length = 0;
  assert.deepEqual(await run(), { namespaceId: namespace.id, namespaceDeleted: true });
  assert.deepEqual(effects, ["infrastructure"]);
});
