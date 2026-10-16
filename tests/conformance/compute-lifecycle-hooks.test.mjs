import assert from "node:assert/strict";
import test from "node:test";
import { ComputeLifecycleDispatcher } from "../../apps/controller/src/drivers/compute/lifecycle-hooks.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";

const namespace = Object.freeze({
  id: "namespace-support",
  name: "Support",
  status: "ready",
  createdAt: "2026-08-20T00:00:00.000Z",
});

const revision = Object.freeze({
  id: "revision-support-1",
  namespaceId: namespace.id,
  agentId: "agent-support",
  revision: 1,
  configurationId: "configuration-support",
  configurationKind: "agent",
  configurationGeneration: 3,
  configuration: Object.freeze({
    model: "test-model",
    logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
    diagnostics: { otel: { logs: false } },
  }),
  harness: Object.freeze({ id: "openclaw", version: "1.0.0" }),
  compute: Object.freeze({ id: "compute-docker-development", implementation: "docker-local" }),
  servicePrincipalId: "service-principal-support",
  tags: Object.freeze({ usage: "personal", team: "support" }),
  createdAt: namespace.createdAt,
});

function selectedDriver(capability, id, computeLifecycleHooks) {
  return {
    capability,
    id,
    implementation: `${id}-implementation`,
    ...(computeLifecycleHooks === undefined ? {} : { computeLifecycleHooks }),
  };
}

test("selected hooks preserve controller order and revoke in reverse order", async () => {
  const calls = [];
  const owner = (capability, id) =>
    selectedDriver(capability, id, {
      async afterNamespacePrepared(actualNamespace) {
        assert.deepEqual(actualNamespace, namespace);
        calls.push(`${id}:namespace-prepared`);
      },
      async beforeWorkloadStart(actualRevision, launch) {
        assert.deepEqual(actualRevision, revision);
        launch.environment[`PLACEHOLDER_${id.toUpperCase()}`] = `opaque-${id}`;
        calls.push(`${id}:workload-start`);
      },
      async beforeWorkloadStop(actualRevision) {
        assert.deepEqual(actualRevision, revision);
        calls.push(`${id}:workload-stop`);
      },
      async beforeNamespaceDelete(actualNamespace) {
        assert.deepEqual(actualNamespace, namespace);
        calls.push(`${id}:namespace-delete`);
      },
    });

  // The controller supplies the trusted, deterministic selection order.
  const dispatcher = new ComputeLifecycleDispatcher([
    owner("iam", "identity"),
    owner("configuration", "settings"),
  ]);

  await dispatcher.afterNamespacePrepared(namespace);
  const launch = await dispatcher.beforeWorkloadStart(revision);
  await dispatcher.beforeWorkloadStop(revision);
  await dispatcher.beforeNamespaceDelete(namespace);

  assert.deepEqual(calls, [
    "identity:namespace-prepared",
    "settings:namespace-prepared",
    "identity:workload-start",
    "settings:workload-start",
    "settings:workload-stop",
    "identity:workload-stop",
    "settings:namespace-delete",
    "identity:namespace-delete",
  ]);
  assert.deepEqual(launch.environment, {
    PLACEHOLDER_SETTINGS: "opaque-settings",
    PLACEHOLDER_IDENTITY: "opaque-identity",
  });
});

test("workload hooks receive immutable Agent Configuration provenance and native settings", async () => {
  const mutableRevision = structuredClone(revision);
  let observedRevision;
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
        assert.throws(() => {
          actualRevision.configurationGeneration = 4;
        }, TypeError);
        launch.environment.MODEL_TOKEN = "opaque-provider-reference";
      },
    }),
  ]);

  assert.deepEqual(await dispatcher.beforeWorkloadStart(mutableRevision), {
    environment: { MODEL_TOKEN: "opaque-provider-reference" },
  });
  assert.notEqual(observedRevision, mutableRevision);
  assert.deepEqual(mutableRevision, revision);
});

test("failed namespace preparation rolls completed owners back in reverse order", async () => {
  const calls = [];
  const owners = ["a", "b", "c"].map((id) =>
    selectedDriver("configuration", id, {
      async afterNamespacePrepared() {
        calls.push(`${id}:prepare`);
        if (id === "c") {
          throw new Error("sensitive-provider-token");
        }
      },
      async beforeNamespaceDelete() {
        calls.push(`${id}:revoke`);
      },
    }),
  );

  await assert.rejects(
    new ComputeLifecycleDispatcher(owners).afterNamespacePrepared(namespace),
    (error) => {
      assert.match(error.message, /afterNamespacePrepared failed for configuration:c/);
      assert.doesNotMatch(error.message, /sensitive-provider-token/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.deepEqual(calls, ["a:prepare", "b:prepare", "c:prepare", "b:revoke", "a:revoke"]);
});

test("failed workload preparation compensates completed bindings before returning", async () => {
  const calls = [];
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

test("failed namespace preparation preserves tenant ownership during rollback", async () => {
  const mutableNamespace = structuredClone(namespace);
  const original = structuredClone(mutableNamespace);
  const calls = [];
  let revokedNamespace;
  const dispatcher = new ComputeLifecycleDispatcher([
    selectedDriver("configuration", "first", {
      async afterNamespacePrepared(actualNamespace) {
        assert.deepEqual(actualNamespace, original);
        calls.push("first:prepare");
      },
      async beforeNamespaceDelete(actualNamespace) {
        revokedNamespace = actualNamespace;
        calls.push("first:revoke");
      },
    }),
    selectedDriver("iam", "malicious", {
      async afterNamespacePrepared(actualNamespace) {
        calls.push("malicious:prepare");
        actualNamespace.id = "foreign-tenant";
      },
    }),
  ]);

  await assert.rejects(
    dispatcher.afterNamespacePrepared(mutableNamespace),
    /afterNamespacePrepared failed for iam:malicious/,
  );
  assert.deepEqual(calls, ["first:prepare", "malicious:prepare", "first:revoke"]);
  assert.deepEqual(revokedNamespace, original);
  assert.deepEqual(mutableNamespace, original);
  assert.equal(Object.isFrozen(mutableNamespace), false);
});

test("failed workload preparation preserves its exact identity and tags during revocation", async () => {
  for (const mutate of [
    (actual) => {
      actual.namespaceId = "foreign-tenant";
    },
    (actual) => {
      actual.tags.usage = "security";
    },
  ]) {
    const mutableRevision = structuredClone(revision);
    const original = structuredClone(mutableRevision);
    let preparedRevision;
    let revokedRevision;
    const dispatcher = new ComputeLifecycleDispatcher([
      selectedDriver("configuration", "first", {
        async beforeWorkloadStart(actualRevision) {
          assert.equal(Object.isFrozen(actualRevision.tags), true);
          preparedRevision = actualRevision;
        },
        async beforeWorkloadStop(actualRevision) {
          revokedRevision = actualRevision;
        },
      }),
      selectedDriver("iam", "malicious", {
        async beforeWorkloadStart(actualRevision) {
          mutate(actualRevision);
        },
      }),
    ]);

    await assert.rejects(
      dispatcher.beforeWorkloadStart(mutableRevision),
      /beforeWorkloadStart failed for iam:malicious/,
    );
    assert.deepEqual(revokedRevision, original);
    assert.equal(revokedRevision, preparedRevision);
    assert.equal(revokedRevision.namespaceId, namespace.id);
    assert.equal(revokedRevision.servicePrincipalId, revision.servicePrincipalId);
    assert.deepEqual(mutableRevision, original);
    assert.equal(Object.isFrozen(mutableRevision), false);
    assert.equal(Object.isFrozen(mutableRevision.tags), false);
  }
});

test("workload launches reject reserved variables, unsafe names, and plaintext credentials", async () => {
  for (const [name, value] of [
    ["HOME", "opaque-reference"],
    ["OPENCLAW_CONFIG_PATH", "opaque-reference"],
    ["unsafe-name", "opaque-reference"],
    ["MODEL_TOKEN", "actual-provider-credential"],
  ]) {
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
  const revoked = [];
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
  let hookLaunch;
  const dispatcher = new ComputeLifecycleDispatcher([
    selectedDriver("configuration", "settings", {
      async beforeWorkloadStart(_revision, launch) {
        hookLaunch = launch;
        launch.environment.MODEL_TOKEN = "opaque-original";
      },
    }),
  ]);

  const launch = await dispatcher.beforeWorkloadStart(revision);
  hookLaunch.environment.MODEL_TOKEN = "actual-provider-password";

  assert.equal(launch.environment.MODEL_TOKEN, "opaque-original");
});

test("revocation failure blocks remaining teardown and never exposes the original error", async () => {
  const calls = [];
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

  await assert.rejects(dispatcher.beforeWorkloadStop(revision), (error) => {
    assert.match(error.message, /beforeWorkloadStop failed for iam:identity/);
    assert.doesNotMatch(error.message, /plaintext-credential/);
    assert.equal(error.phase, "beforeWorkloadStop");
    return true;
  });
  assert.deepEqual(calls, ["identity:revoke"]);
});

test("launch-failure cleanup revokes after its original workload claim is cancelled", async () => {
  const cancellation = new AbortController();
  const calls = [];
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
  const calls = [];
  const owner = (id) =>
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

  assert.equal(await dispatcher.afterNamespacePrepared(namespace), undefined);
  assert.deepEqual(await dispatcher.beforeWorkloadStart(revision), { environment: {} });
  assert.equal(await dispatcher.beforeWorkloadStop(revision), undefined);
  assert.equal(await dispatcher.beforeNamespaceDelete(namespace), undefined);
});

test("in-flight caller edits cannot change the tags supplied to later lifecycle owners", async () => {
  const input = structuredClone(revision);
  let continuePreparation;
  let started;
  const firstStarted = new Promise((resolve) => {
    started = resolve;
  });
  const release = new Promise((resolve) => {
    continuePreparation = resolve;
  });
  const observations = [];
  const dispatcher = new ComputeLifecycleDispatcher([
    selectedDriver("configuration", "first", {
      async beforeWorkloadStart(actual) {
        observations.push(actual.tags);
        started();
        await release;
      },
    }),
    selectedDriver("iam", "second", {
      async beforeWorkloadStart(actual) {
        observations.push(actual.tags);
      },
    }),
  ]);
  const preparation = dispatcher.beforeWorkloadStart(input);
  await firstStarted;
  input.tags.usage = "security";
  continuePreparation();
  await preparation;
  assert.deepEqual(observations, [revision.tags, revision.tags]);
  assert.equal(observations[0], observations[1]);
});
