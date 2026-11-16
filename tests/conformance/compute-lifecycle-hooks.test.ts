import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentRevision,
  Driver,
  Namespace,
  WorkloadLaunchContext,
} from "@openclaw-enterprise/contracts";
import { ComputeLifecycleDispatcher } from "../../apps/controller/src/drivers/compute/lifecycle-hooks.ts";
import {
  currentComputeAbortSignal,
  currentComputeOperationLifetime,
  withComputeAbortSignal,
  withComputeOperationDeadline,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";

const namespace = Object.freeze({
  id: "namespace-support",
  name: "Support",
  status: "ready",
  createdAt: "2026-08-20T00:00:00.000Z",
} satisfies Namespace);

const revision = Object.freeze({
  id: "revision-support-1",
  namespaceId: namespace.id,
  agentId: "agent-support",
  revision: 1,
  backendId: null,
  configurationId: "configuration-support",
  configurationKind: "agent",
  configurationGeneration: 3,
  configuration: Object.freeze({
    model: "test-model",
    logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
    diagnostics: { otel: { logs: false } },
  }),
  gatewayManagedMode: false,
  harness: Object.freeze({
    id: "openclaw",
    version: "1.0.0",
    mode: "embedded",
    overrides: {},
    configuration: {},
  }),
  harnessAuth: { method: "runtime" },
  executionAdmission: { version: 2, mode: "unprotected" },
  compute: Object.freeze({ id: "compute-docker-development", implementation: "docker-local" }),
  servicePrincipalId: "service-principal-support",
  createdAt: namespace.createdAt,
} satisfies AgentRevision);

function selectedDriver(
  capability: Driver["capability"],
  id: string,
  computeLifecycleHooks?: Driver["computeLifecycleHooks"],
): Driver {
  return {
    capability,
    id,
    implementation: `${id}-implementation`,
    ...(computeLifecycleHooks === undefined ? {} : { computeLifecycleHooks }),
  };
}

test("selected hooks preserve controller order and revoke in reverse order", async () => {
  const calls: string[] = [];
  const owner = (capability: Driver["capability"], id: string) =>
    selectedDriver(capability, id, {
      async beforeWorkloadStart(actualRevision, launch) {
        assert.deepEqual(actualRevision, revision);
        launch.environment[`PLACEHOLDER_${id.toUpperCase()}`] = `opaque-${id}`;
        calls.push(`${id}:workload-start`);
      },
      async beforeWorkloadStop(actualRevision) {
        assert.deepEqual(actualRevision, revision);
        calls.push(`${id}:workload-stop`);
      },
    });

  // The controller supplies the trusted, deterministic selection order.
  const dispatcher = new ComputeLifecycleDispatcher([
    owner("iam", "identity"),
    owner("configuration", "settings"),
  ]);

  const launch = await dispatcher.beforeWorkloadStart(revision);
  await dispatcher.beforeWorkloadStop(revision);

  assert.deepEqual(calls, [
    "identity:workload-start",
    "settings:workload-start",
    "settings:workload-stop",
    "identity:workload-stop",
  ]);
  assert.deepEqual(launch.environment, {
    PLACEHOLDER_SETTINGS: "opaque-settings",
    PLACEHOLDER_IDENTITY: "opaque-identity",
  });
});

test("workload hooks receive immutable Agent Configuration provenance and native settings", async () => {
  const mutableRevision = structuredClone(revision);
  let observedRevision: Readonly<AgentRevision> | undefined;
  const dispatcher = new ComputeLifecycleDispatcher([
    selectedDriver("configuration", "settings", {
      async beforeWorkloadStart(actualRevision, launch) {
        observedRevision = actualRevision;
        assert.equal(actualRevision.configurationId, "configuration-support");
        assert.equal(actualRevision.configurationKind, "agent");
        assert.equal(actualRevision.configurationGeneration, 3);
        assert.deepEqual(actualRevision.configuration, revision.configuration);
        assert.equal(Object.isFrozen(actualRevision), true);
        assert.equal(Object.isFrozen(actualRevision.configuration), true);
        assert.throws(
          () => Object.assign(actualRevision, { configurationGeneration: 4 }),
          TypeError,
        );
        launch.environment.MODEL_TOKEN = "opaque-provider-reference";
      },
    }),
  ]);

  assert.deepEqual(await dispatcher.beforeWorkloadStart(mutableRevision), {
    environment: { MODEL_TOKEN: "opaque-provider-reference" },
  });
  assert.ok(observedRevision);
  assert.notEqual(observedRevision, mutableRevision);
  assert.deepEqual(mutableRevision, revision);
});

test("failed workload preparation compensates completed bindings before returning", async () => {
  const calls: string[] = [];
  const dispatcher = new ComputeLifecycleDispatcher([
    selectedDriver("configuration", "first", {
      async beforeWorkloadStart(_revision, launch) {
        launch.environment.MODEL_TOKEN = "opaque-provider-reference";
        calls.push("first:bind");
      },
      async beforeWorkloadStop() {
        calls.push("first:revoke");
      },
    }),
    selectedDriver("iam", "second", {
      async beforeWorkloadStart() {
        calls.push("second:bind");
        throw new Error("secret-from-gateway");
      },
    }),
  ]);

  await assert.rejects(
    dispatcher.beforeWorkloadStart(revision),
    /beforeWorkloadStart failed for iam:second/,
  );
  assert.deepEqual(calls, ["first:bind", "second:bind", "first:revoke"]);
});

test("failed workload preparation preserves its exact tenant identity during revocation", async () => {
  const mutableRevision = structuredClone(revision);
  const original = structuredClone(mutableRevision);
  let revokedRevision: Readonly<AgentRevision> | undefined;
  const dispatcher = new ComputeLifecycleDispatcher([
    selectedDriver("configuration", "first", {
      async beforeWorkloadStart() {},
      async beforeWorkloadStop(actualRevision) {
        revokedRevision = actualRevision;
      },
    }),
    selectedDriver("iam", "malicious", {
      async beforeWorkloadStart(actualRevision) {
        Object.assign(actualRevision, { namespaceId: "foreign-tenant" });
      },
    }),
  ]);

  await assert.rejects(
    dispatcher.beforeWorkloadStart(mutableRevision),
    /beforeWorkloadStart failed for iam:malicious/,
  );
  assert.ok(revokedRevision);
  assert.deepEqual(revokedRevision, original);
  assert.equal(revokedRevision.namespaceId, namespace.id);
  assert.equal(revokedRevision.servicePrincipalId, revision.servicePrincipalId);
  assert.deepEqual(mutableRevision, original);
  assert.equal(Object.isFrozen(mutableRevision), false);
});

test("workload launches reject reserved variables, unsafe names, and plaintext credentials", async () => {
  for (const [name, value] of [
    ["HOME", "opaque-reference"],
    ["OPENCLAW_CONFIG_PATH", "opaque-reference"],
    ["unsafe-name", "opaque-reference"],
    ["MODEL_TOKEN", "actual-provider-credential"],
  ] as const) {
    const dispatcher = new ComputeLifecycleDispatcher([
      selectedDriver("configuration", "settings", {
        async beforeWorkloadStart(_revision, launch) {
          launch.environment[name] = value;
        },
      }),
    ]);

    await assert.rejects(
      dispatcher.beforeWorkloadStart(revision),
      /beforeWorkloadStart failed for configuration:settings/,
    );
  }
});

test("only the completed workload environment is validated before launch", async () => {
  const dispatcher = new ComputeLifecycleDispatcher([
    selectedDriver("configuration", "settings", {
      async beforeWorkloadStart(_revision, launch) {
        launch.environment.MODEL_TOKEN = "pending-reference";
      },
    }),
    selectedDriver("iam", "identity", {
      async beforeWorkloadStart(_revision, launch) {
        launch.environment.MODEL_TOKEN = "opaque-provider-reference";
      },
    }),
  ]);

  assert.deepEqual(await dispatcher.beforeWorkloadStart(revision), {
    environment: { MODEL_TOKEN: "opaque-provider-reference" },
  });
});

test("invalid completed launch values revoke prepared owners in reverse order", async () => {
  const revoked: string[] = [];
  const dispatcher = new ComputeLifecycleDispatcher([
    selectedDriver("configuration", "first", {
      async beforeWorkloadStart(_revision, launch) {
        launch.environment.MODEL_TOKEN = "opaque-reference";
      },
      async beforeWorkloadStop() {
        revoked.push("first");
      },
    }),
    selectedDriver("iam", "second", {
      async beforeWorkloadStart(_revision, launch) {
        launch.environment.MODEL_TOKEN = "plaintext-credential";
      },
      async beforeWorkloadStop() {
        revoked.push("second");
      },
    }),
  ]);

  await assert.rejects(dispatcher.beforeWorkloadStart(revision), /failed for iam:second/);
  assert.deepEqual(revoked, ["second", "first"]);
});

test("later callback mutations cannot change accepted workload launch values", async () => {
  let hookLaunch: WorkloadLaunchContext | undefined;
  const dispatcher = new ComputeLifecycleDispatcher([
    selectedDriver("configuration", "settings", {
      async beforeWorkloadStart(_revision, launch) {
        hookLaunch = launch;
        launch.environment.MODEL_TOKEN = "opaque-original";
      },
    }),
  ]);

  const launch = await dispatcher.beforeWorkloadStart(revision);
  assert.ok(hookLaunch);
  hookLaunch.environment.MODEL_TOKEN = "actual-provider-password";

  assert.equal(launch.environment.MODEL_TOKEN, "opaque-original");
});

test("revocation failure blocks remaining teardown and never exposes the original error", async () => {
  const calls: string[] = [];
  const dispatcher = new ComputeLifecycleDispatcher([
    selectedDriver("configuration", "settings", {
      async beforeWorkloadStop() {
        calls.push("settings:revoke");
      },
    }),
    selectedDriver("iam", "identity", {
      async beforeWorkloadStop() {
        calls.push("identity:revoke");
        throw new Error("plaintext-credential");
      },
    }),
  ]);

  await assert.rejects(dispatcher.beforeWorkloadStop(revision), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /beforeWorkloadStop failed for iam:identity/);
    assert.doesNotMatch(error.message, /plaintext-credential/);
    assert.ok("phase" in error);
    assert.equal(error.phase, "beforeWorkloadStop");
    return true;
  });
  assert.deepEqual(calls, ["identity:revoke"]);
});

test("launch-failure cleanup revokes after its original workload claim is cancelled", async () => {
  const cancellation = new AbortController();
  const calls: string[] = [];
  const dispatcher = new ComputeLifecycleDispatcher([
    selectedDriver("configuration", "settings", {
      async beforeWorkloadStart(actualRevision, _launch, signal) {
        assert.deepEqual(actualRevision, revision);
        assert.equal(signal, cancellation.signal);
        calls.push("bind");
      },
      async beforeWorkloadStop(actualRevision, signal) {
        assert.deepEqual(actualRevision, revision);
        assert.notEqual(signal, cancellation.signal);
        assert.equal(signal.aborted, false);
        calls.push("revoke");
      },
    }),
  ]);

  await withComputeAbortSignal(cancellation.signal, async () => {
    await dispatcher.beforeWorkloadStart(revision);
    cancellation.abort();
    await dispatcher.beforeWorkloadStop(revision, { cleanup: true });
  });
  assert.deepEqual(calls, ["bind", "revoke"]);
});

test("ordinary workload retirement still respects operation cancellation", async () => {
  const cancellation = new AbortController();
  let revoked = false;
  const dispatcher = new ComputeLifecycleDispatcher([
    selectedDriver("configuration", "settings", {
      async beforeWorkloadStop() {
        revoked = true;
      },
    }),
  ]);

  await assert.rejects(
    withComputeAbortSignal(cancellation.signal, async () => {
      cancellation.abort();
      await dispatcher.beforeWorkloadStop(revision);
    }),
    { name: "AbortError" },
  );
  assert.equal(revoked, false);
});

test("cancellation after workload preparation revokes every completed owner in reverse", async () => {
  const cancellation = new AbortController();
  const calls: string[] = [];
  const owner = (id: string) =>
    selectedDriver("configuration", id, {
      async beforeWorkloadStart(_revision, launch, signal) {
        assert.equal(signal, cancellation.signal);
        launch.environment[`PLACEHOLDER_${id.toUpperCase()}`] = `opaque-${id}`;
        calls.push(`${id}:bind`);
        if (id === "second") {
          cancellation.abort();
        }
      },
      async beforeWorkloadStop(_revision, signal) {
        // Revocation gets a fresh, bounded signal after the original lease is lost.
        assert.notEqual(signal, cancellation.signal);
        assert.equal(signal.aborted, false);
        calls.push(`${id}:revoke`);
      },
    });
  const dispatcher = new ComputeLifecycleDispatcher([owner("first"), owner("second")]);

  await assert.rejects(
    withComputeAbortSignal(cancellation.signal, () => dispatcher.beforeWorkloadStart(revision)),
    /beforeWorkloadStart failed for configuration:second/,
  );
  assert.deepEqual(calls, ["first:bind", "second:bind", "second:revoke", "first:revoke"]);
});

test("drivers without hooks remain valid selected owners", async () => {
  const driver = selectedDriver("configuration", "settings");
  const dispatcher = new ComputeLifecycleDispatcher([driver]);

  assert.deepEqual(await dispatcher.beforeWorkloadStart(revision), { environment: {} });
  assert.equal(await dispatcher.beforeWorkloadStop(revision), undefined);
});

test("nested compute signals retain parent cancellation without a deadline", async () => {
  const parent = new AbortController();
  const reason = new Error("parent cancelled");
  await withComputeAbortSignal(parent.signal, () =>
    withComputeAbortSignal(new AbortController().signal, async () => {
      const signal = currentComputeAbortSignal();
      assert.ok(signal);
      parent.abort(reason);
      assert.equal(signal.aborted, true);
      const abortReason: unknown = signal.reason;
      assert.equal(abortReason, reason);
    }),
  );
});

test("nested compute signals reject an already aborted parent", async () => {
  const parent = new AbortController();
  const reason = new Error("parent cancelled");
  await withComputeAbortSignal(parent.signal, async () => {
    parent.abort(reason);
    await assert.rejects(
      withComputeAbortSignal(new AbortController().signal, async () =>
        assert.fail("operation ran"),
      ),
      (error: unknown) => error === reason,
    );
  });
});

test("nested compute signals preserve the parent deadline", async () => {
  const deadline = Date.now() + 60_000;
  await withComputeOperationDeadline(
    { signal: new AbortController().signal, deadlineAt: new Date(deadline).toISOString() },
    () =>
      withComputeAbortSignal(new AbortController().signal, async () => {
        const lifetime = currentComputeOperationLifetime();
        assert.ok(lifetime);
        assert.equal(lifetime.deadline, deadline);
      }),
  );
});
