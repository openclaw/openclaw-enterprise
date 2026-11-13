import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import type { KubernetesComputeDriverOptions } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import {
  DependencyUnavailableError,
  RuntimeLogsForbiddenByClusterError,
} from "../../packages/occ/src/index.ts";
import { conformanceKubeconfig } from "../helpers/kubernetes-compute.mjs";
import { options, routedOptions } from "../helpers/kubernetes-routed-scenarios.mjs";
import { createRuntimeLogDriverFixture } from "./kubernetes-runtime-log-fixture.ts";

const { kubeconfigPath, context: contextName } = conformanceKubeconfig;

// Runtime status and log reads. The fixture supplies Kubernetes API responses only;
// plane selection, ownership re-checks, Event filtering, the typed 403 and byte-limit
// detection run through the production Driver.
function runtimeLogDriverFixture({ twoCluster = false }: { twoCluster?: boolean } = {}) {
  return createRuntimeLogDriverFixture({
    kubeconfigPath,
    contextName,
    twoCluster,
    // The JavaScript builders infer their fixed mode discriminants as string.
    options: (overrides) => options(overrides) as KubernetesComputeDriverOptions,
    routedOptions: (overrides) => routedOptions(overrides) as KubernetesComputeDriverOptions,
  });
}

test("Kubernetes runtime description reads each plane's Pods and only their own Events", async () => {
  const fixture = runtimeLogDriverFixture({ twoCluster: true });
  const description = await fixture.describeAgentRuntime(new AbortController().signal);
  assert.equal(description.revisionId, fixture.binding.revision.id);
  assert.deepEqual(
    description.pods.map(({ role, cluster, name }) => ({ role, cluster, name })),
    [
      { role: "agent", cluster: "execution", name: "agent-runtime-logs-pod" },
      { role: "gateway", cluster: "control", name: "gateway-runtime-logs-pod" },
    ],
  );
  const gateway = description.pods[1];
  assert.ok(gateway);
  assert.deepEqual(gateway.containers[0], {
    name: "gateway",
    state: "running",
    reason: null,
    ready: true,
    restartCount: 2,
    startedAt: "2026-09-30T11:00:00.000Z",
    lastTermination: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-09-30T10:59:00.000Z" },
  });
  assert.deepEqual(
    gateway.events.map(({ reason, count, container }) => ({ reason, count, container })),
    [
      { reason: "BackOff", count: 4, container: "gateway" },
      { reason: "Pulled", count: 1, container: "prepare-private-state" },
      { reason: "Scheduled", count: 1, container: null },
    ],
  );
  assert.deepEqual(
    description.sources.map(({ id, pods }) => ({ id, pods })),
    [
      {
        id: "agent",
        pods: [
          {
            name: "agent-runtime-logs-pod",
            uid: "agent-runtime-logs-uid",
            container: "agent",
            restartCount: 0,
          },
        ],
      },
      {
        id: "gateway",
        pods: [
          {
            name: "gateway-runtime-logs-pod",
            uid: "gateway-runtime-logs-uid",
            container: "gateway",
            restartCount: 2,
          },
        ],
      },
    ],
  );
  // The Harness Pod and its Events come from the execution cluster; the dedicated
  // Gateway from the control-plane Gateway namespace.
  const reads = fixture.calls.filter(
    (entry) => entry.call === "listNamespacedPod" || entry.call === "listNamespacedEvent",
  );
  assert.deepEqual(
    reads.map(({ plane, call, namespace }) => ({ plane, call, namespace })),
    [
      { plane: "execution", call: "listNamespacedPod", namespace: fixture.namespaceName },
      { plane: "execution", call: "listNamespacedEvent", namespace: fixture.namespaceName },
      { plane: "control", call: "listNamespacedPod", namespace: fixture.gatewayNamespaceName },
      { plane: "control", call: "listNamespacedEvent", namespace: fixture.gatewayNamespaceName },
    ],
  );
  assert.ok(
    reads
      .filter((entry) => entry.call === "listNamespacedEvent")
      .every(({ limit }) => limit === 100),
  );

  // A Pod of another Agent in the same namespace fails the whole description.
  fixture.state.foreignPod = true;
  await assert.rejects(fixture.describeAgentRuntime(new AbortController().signal), /invalid Pod/);
  // So does a listed Pod that names another namespace even with matching labels.
  fixture.state.foreignPod = false;
  fixture.state.foreignNamespacePod = true;
  await assert.rejects(fixture.describeAgentRuntime(new AbortController().signal), /invalid Pod/);
});

test("Kubernetes runtime description reports declared main and init containers independently", async () => {
  const fixture = runtimeLogDriverFixture();
  fixture.state.containerName = "agent";
  fixture.state.initContainers = [{ name: "prepare-private-state" }];
  fixture.state.initContainerStatuses = [
    {
      name: "prepare-private-state",
      state: { terminated: { reason: "Completed", exitCode: 0 } },
    },
  ];
  // Kubernetes can report the completed init container before the main has started.
  // Its successful exit must not stand in for the main container's missing status.
  fixture.state.noMainStatus = true;
  const describe = () => fixture.describeAgentRuntime(new AbortController().signal);
  const pending = await describe();
  assert.deepEqual(
    pending.pods[0]?.containers.map(({ name, state, lastTermination }) => ({
      name,
      state,
      exitCode: lastTermination?.exitCode ?? null,
    })),
    [
      { name: "agent", state: "unknown", exitCode: null },
      { name: "prepare-private-state", state: "terminated", exitCode: 0 },
    ],
  );
  fixture.state.noMainStatus = false;
  fixture.state.containerStatus = {
    ready: false,
    state: { terminated: { reason: "Error", exitCode: 1 } },
  };
  const failed = await describe();
  assert.equal(failed.pods[0]?.containers[0]?.lastTermination?.exitCode, 1);
  assert.equal(failed.pods[0]?.containers[1]?.lastTermination?.exitCode, 0);
  assert.deepEqual(
    failed.sources[0]?.pods.map(({ container }) => container),
    ["agent", "prepare-private-state"],
  );
});

test("Kubernetes runtime description retains newest Events across API pages", async () => {
  const fixture = runtimeLogDriverFixture();
  const event = (index: number, type = "Normal") => ({
    type,
    reason: type === "Warning" ? "BackOff" : "Pulled",
    message: type === "Warning" ? "Back-off restarting failed container" : "Image already present",
    count: 1,
    lastTimestamp: new Date(Date.UTC(2026, 8, 30, 11, 0, index)),
    involvedObject: {
      kind: "Pod",
      uid: "gateway-runtime-logs-uid",
      namespace: fixture.namespaceName,
    },
  });
  fixture.state.eventPage = ({ _continue, limit, fieldSelector }) => {
    assert.equal(limit, 100);
    assert.equal(fieldSelector, "involvedObject.uid=gateway-runtime-logs-uid");
    if (_continue === undefined) {
      // The newest Event starts on the first page and must survive later pages.
      return {
        items: [
          ...Array.from({ length: 99 }, (_, index) => event(index + 1)),
          event(201, "Warning"),
        ],
        metadata: { _continue: "filtered" },
      };
    }
    if (_continue === "filtered") {
      // A page may contain only Events excluded by the exact-Pod projection.
      return {
        items: [{ ...event(999, "Warning"), involvedObject: { kind: "Pod", uid: "foreign-pod" } }],
        metadata: { _continue: "latest" },
      };
    }
    assert.equal(_continue, "latest");
    return {
      items: Array.from({ length: 101 }, (_, index) =>
        event(index + 100, index === 100 ? "Warning" : "Normal"),
      ),
      metadata: { _continue: "" },
    };
  };
  const description = await fixture.describeAgentRuntime(new AbortController().signal, {
    source: "gateway",
  });
  const pod = description.pods[0];
  assert.ok(pod);
  const { events } = pod;
  assert.equal(events.length, 100);
  assert.equal(events[0]?.reason, "BackOff");
  assert.deepEqual(
    events.map(({ lastObservedAt }) => lastObservedAt),
    Array.from({ length: 100 }, (_, index) => event(201 - index).lastTimestamp.toISOString()),
  );
  assert.deepEqual(
    fixture.calls
      .filter((entry) => entry.call === "listNamespacedEvent")
      .map(({ _continue }) => _continue),
    [undefined, "filtered", "latest"],
  );
});

test("Kubernetes runtime Event pagination preserves later-page RBAC failures", async () => {
  const fixture = runtimeLogDriverFixture();
  fixture.state.eventPage = ({ _continue }) => {
    if (_continue === undefined) {
      return { items: [], metadata: { _continue: "next" } };
    }
    throw { code: 403 };
  };
  await assert.rejects(
    fixture.describeAgentRuntime(new AbortController().signal, {
      source: "gateway",
    }),
    (error) => error instanceof RuntimeLogsForbiddenByClusterError,
  );
});

test("Kubernetes runtime Event pagination remains bounded by the caller abort", async () => {
  const fixture = runtimeLogDriverFixture();
  const abort = new AbortController();
  const reason = new Error("Runtime Event observation cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  fixture.state.eventPage = ({ _continue }) => {
    if (_continue === undefined) {
      return { items: [], metadata: { _continue: "next" } };
    }
    timer = setTimeout(() => abort.abort(reason), 25);
    const signal = currentComputeAbortSignal();
    assert.ok(signal instanceof AbortSignal);
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  try {
    await assert.rejects(
      fixture.describeAgentRuntime(abort.signal, { source: "gateway" }),
      (error) => error === reason,
    );
  } finally {
    clearTimeout(timer);
  }
});

const previousRuntimeTermination = {
  reason: "Error",
  exitCode: 17,
  finishedAt: new Date("2026-10-09T16:00:00Z"),
};
for (const scenario of [
  {
    name: "first current exit",
    state: {
      terminated: { ...previousRuntimeTermination, startedAt: new Date("2026-10-09T15:59:00Z") },
    },
    lastState: {},
    expected: previousRuntimeTermination,
  },
  {
    name: "newest current exit",
    state: {
      terminated: {
        reason: "Completed",
        exitCode: 0,
        finishedAt: new Date("2026-10-09T16:01:00Z"),
      },
    },
    lastState: { terminated: previousRuntimeTermination },
    expected: { reason: "Completed", exitCode: 0, finishedAt: new Date("2026-10-09T16:01:00Z") },
  },
  {
    name: "running prior exit",
    state: { running: { startedAt: new Date("2026-10-09T16:01:00Z") } },
    lastState: { terminated: previousRuntimeTermination },
    expected: previousRuntimeTermination,
  },
  {
    name: "waiting prior exit",
    state: { waiting: { reason: "CrashLoopBackOff" } },
    lastState: { terminated: previousRuntimeTermination },
    expected: previousRuntimeTermination,
  },
  {
    name: "running without an exit",
    state: { running: { startedAt: new Date("2026-10-09T16:01:00Z") } },
    lastState: {},
    expected: null,
  },
  {
    name: "waiting without an exit",
    state: { waiting: { reason: "ContainerCreating" } },
    lastState: {},
    expected: null,
  },
]) {
  test(`Kubernetes runtime termination status retains ${scenario.name}`, async () => {
    const fixture = runtimeLogDriverFixture();
    fixture.state.containerStatus = {
      state: scenario.state,
      lastState: scenario.lastState,
      restartCount: scenario.lastState.terminated === undefined ? 0 : 1,
      ready: scenario.state.running !== undefined,
    };
    const description = await fixture.describeAgentRuntime(new AbortController().signal);
    const expected =
      scenario.expected === null
        ? null
        : { ...scenario.expected, finishedAt: scenario.expected.finishedAt.toISOString() };
    for (const pod of description.pods) {
      const [container] = pod.containers;
      assert.ok(container);
      assert.deepEqual(container.lastTermination, expected, pod.role);
      assert.equal(container.state, Object.keys(scenario.state)[0]);
    }
  });
}

test("Kubernetes runtime times keep real UTC instants and refuse rolled-over or offset strings", async (t) => {
  const describe = (fixture: ReturnType<typeof runtimeLogDriverFixture>) =>
    fixture.describeAgentRuntime(new AbortController().signal);
  type ContainerStatus = NonNullable<
    ReturnType<typeof runtimeLogDriverFixture>["state"]["containerStatus"]
  >;
  const withContainerState = (state: NonNullable<ContainerStatus["state"]>) => {
    const fixture = runtimeLogDriverFixture();
    fixture.state.containerStatus = { state };
    return fixture;
  };
  const accepted = [
    // The typed client hands a Date; a valid one keeps its exact instant.
    [new Date("2026-09-30T11:00:00.123Z"), "2026-09-30T11:00:00.123Z"],
    ["2026-09-30T11:00:00Z", "2026-09-30T11:00:00.000Z"],
    ["2026-09-30T11:00:00.5Z", "2026-09-30T11:00:00.500Z"],
    ["2026-09-30T11:00:00.123456Z", "2026-09-30T11:00:00.123Z"],
    ["2026-09-30T11:00:00.123456789Z", "2026-09-30T11:00:00.123Z"],
    ["2024-02-29T00:00:00Z", "2024-02-29T00:00:00.000Z"],
  ] as const;
  const refused = [
    "2026-02-30T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-04-31T12:00:00.000Z",
    "2026-09-30T24:00:00Z",
    "2026-09-30T11:60:00Z",
    "2026-09-30T11:00:00+00:00",
    "2026-09-30T13:00:00.000+02:00",
    "2026-09-30T11:00:00",
    "2026-09-30T11:00:00.1234567890Z",
    "2026-09-30",
    "not-a-time",
    new Date(Number.NaN),
    Date.UTC(2026, 8, 30, 11),
  ];
  const invalidTime = (error: unknown) =>
    error instanceof DependencyUnavailableError && /invalid timestamp/.test(error.message);
  for (const [value, expected] of accepted) {
    await t.test(`accepts ${inspect(value)}`, async () => {
      const running = await describe(withContainerState({ running: { startedAt: value } }));
      for (const pod of running.pods) {
        assert.equal(pod.containers[0]?.startedAt, expected, pod.role);
      }
      const exited = await describe(
        withContainerState({ terminated: { reason: "Error", exitCode: 1, finishedAt: value } }),
      );
      for (const pod of exited.pods) {
        assert.equal(pod.containers[0]?.lastTermination?.finishedAt, expected, pod.role);
      }
      const fixture = runtimeLogDriverFixture();
      fixture.state.extraEvents = [
        { type: "Warning", reason: "Series", series: { count: 2, lastObservedTime: value } },
        { type: "Normal", reason: "Micro", eventTime: value, lastTimestamp: null },
      ];
      const observed = await describe(fixture);
      for (const pod of observed.pods) {
        for (const reason of ["Series", "Micro"]) {
          assert.equal(
            pod.events.find((event) => event.reason === reason)?.lastObservedAt,
            expected,
            `${pod.role} ${reason}`,
          );
        }
      }
    });
  }
  for (const value of refused) {
    await t.test(`refuses ${inspect(value)}`, async () => {
      await assert.rejects(
        describe(withContainerState({ running: { startedAt: value } })),
        invalidTime,
      );
      await assert.rejects(
        describe(
          withContainerState({ terminated: { reason: "Error", exitCode: 1, finishedAt: value } }),
        ),
        invalidTime,
      );
      // A refused newer field does not fall back to an older valid one.
      const fixture = runtimeLogDriverFixture();
      fixture.state.extraEvents = [
        {
          type: "Warning",
          reason: "Series",
          series: { count: 2, lastObservedTime: value },
          lastTimestamp: new Date("2026-09-30T11:00:00Z"),
        },
      ];
      await assert.rejects(describe(fixture), invalidTime);
      // A log read re-reads the Pod status and refuses the same time.
      const reader = withContainerState({ running: { startedAt: value } });
      await assert.rejects(reader.readAgentRuntimeLogs(reader.request("gateway")), invalidTime);
    });
  }
  // Absent times stay absent rather than refused.
  for (const running of [{ startedAt: null }, {}]) {
    const absent = await describe(withContainerState({ running }));
    for (const pod of absent.pods) {
      assert.equal(pod.containers[0]?.startedAt, null, pod.role);
    }
  }
});

test("Kubernetes runtime description drops only a settled VolumeBinding conflict", async () => {
  const fixture = runtimeLogDriverFixture();
  const conflict = {
    type: "Warning",
    reason: "FailedScheduling",
    message:
      'running PreBind plugin "VolumeBinding": Operation cannot be fulfilled on persistentvolumeclaims "workspace-agt-0123": the object has been modified; please apply your changes to the latest version and try again',
    lastTimestamp: new Date("2026-09-30T10:00:01Z"),
  };
  const kept = [
    // Other scheduling failures, including other VolumeBinding errors, stay visible.
    {
      type: "Warning",
      reason: "FailedScheduling",
      message:
        "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector. preemption: 0/3 nodes are available.",
      lastTimestamp: new Date("2026-09-30T10:00:02Z"),
    },
    {
      type: "Warning",
      reason: "FailedScheduling",
      message: 'running PreBind plugin "VolumeBinding": binding volumes: context deadline exceeded',
      lastTimestamp: new Date("2026-09-30T10:00:03Z"),
    },
    // The same text under another reason is not the scheduler's retry.
    { ...conflict, reason: "FailedBinding", lastTimestamp: new Date("2026-09-30T10:00:04Z") },
  ];
  fixture.state.extraEvents = [conflict, ...kept];
  const reasons = async () => {
    const { pods } = await fixture.describeAgentRuntime(new AbortController().signal);
    const gateway = pods.find(({ role }) => role === "gateway");
    assert.ok(gateway);
    return gateway.events.map(({ reason, message }) => `${reason}: ${message}`);
  };

  const scheduled = await reasons();
  assert.equal(scheduled.includes(`FailedScheduling: ${conflict.message}`), false);
  for (const event of kept) {
    assert.ok(scheduled.includes(`${event.reason}: ${event.message}`), event.message);
  }
  assert.equal(scheduled.length, kept.length + 3);

  // While the Pod has no node the retry has not succeeded yet, so the Event stays.
  fixture.state.nodeName = undefined;
  const pending = await reasons();
  assert.ok(pending.includes(`FailedScheduling: ${conflict.message}`));
  assert.equal(pending.length, kept.length + 4);
});

test("Kubernetes runtime description for a log read lists one source's Pods and no Events", async () => {
  const fixture = runtimeLogDriverFixture({ twoCluster: true });
  const description = await fixture.describeAgentRuntime(new AbortController().signal, {
    source: "gateway",
    events: false,
  });
  assert.deepEqual(
    description.sources.map(({ id }) => id),
    ["gateway"],
  );
  assert.deepEqual(
    description.pods.map(({ role, events }) => ({ role, events })),
    [{ role: "gateway", events: [] }],
  );
  assert.deepEqual(
    fixture.calls
      .filter((entry) => entry.call === "listNamespacedPod" || entry.call === "listNamespacedEvent")
      .map(({ plane, call }) => ({ plane, call })),
    [{ plane: "control", call: "listNamespacedPod" }],
  );
});

test("Kubernetes runtime log reads are bounded, timestamped and re-check the Pod", async () => {
  const fixture = runtimeLogDriverFixture();
  fixture.state.logs.gateway =
    '2026-09-30T12:00:00.123456789Z {"level":"info","message":"ready"}\n2026-09-30T12:00:01Z plain text\n';
  const chunk = await fixture.readAgentRuntimeLogs(
    fixture.request("gateway", { previous: true, sinceSeconds: 30, tailLines: 50 }),
  );
  assert.deepEqual(chunk.lines, [
    { time: "2026-09-30T12:00:00.123456789Z", raw: '{"level":"info","message":"ready"}' },
    { time: "2026-09-30T12:00:01Z", raw: "plain text" },
  ]);
  assert.equal(chunk.truncated, false);
  assert.deepEqual(chunk.stream, {
    source: "gateway",
    pod: "gateway-runtime-logs-pod",
    podUid: "gateway-runtime-logs-uid",
    container: "gateway",
    restartCount: 2,
  });
  const logRead = fixture.calls.find((entry) => entry.call === "readNamespacedPodLog");
  assert.ok(logRead);
  assert.deepEqual(
    {
      namespace: logRead.namespace,
      name: logRead.name,
      container: logRead.container,
      previous: logRead.previous,
      sinceSeconds: logRead.sinceSeconds,
      tailLines: logRead.tailLines,
      limitBytes: logRead.limitBytes,
      timestamps: logRead.timestamps,
      follow: logRead.follow,
    },
    {
      namespace: fixture.gatewayNamespaceName,
      name: "gateway-runtime-logs-pod",
      container: "gateway",
      previous: true,
      sinceSeconds: 30,
      tailLines: 50,
      limitBytes: 1024 * 1024,
      timestamps: true,
      follow: false,
    },
  );
  // The Pod is listed before and after the read, so a restart during the read is visible.
  fixture.state.restartDuringRead = true;
  const restarted = await fixture.readAgentRuntimeLogs(fixture.request("gateway"));
  assert.equal(restarted.stream.restartCount, 3);
  fixture.state.restartDuringRead = false;

  // Output that fills the byte limit is reported as truncated.
  fixture.state.logs.gateway = `2026-09-30T12:00:02Z ${"x".repeat(64)}`;
  const cut = await fixture.readAgentRuntimeLogs(fixture.request("gateway", { limitBytes: 32 }));
  assert.equal(cut.truncated, true);

  // A Pod name the revision does not own never reaches readNamespacedPodLog.
  const before = fixture.calls.filter((entry) => entry.call === "readNamespacedPodLog").length;
  await assert.rejects(
    fixture.readAgentRuntimeLogs(
      fixture.request("gateway", { pod: "kube-apiserver", podUid: "gateway-runtime-logs-uid" }),
    ),
    /no longer available/,
  );
  await assert.rejects(
    fixture.readAgentRuntimeLogs(fixture.request("gateway", { container: "agent" })),
    /does not match/,
  );
  assert.equal(
    fixture.calls.filter((entry) => entry.call === "readNamespacedPodLog").length,
    before,
  );
});

test("Kubernetes runtime log reads normalize RFC3339 offsets without losing nanoseconds", async () => {
  const fixture = runtimeLogDriverFixture();
  const lines = [
    ["2026-09-30T12:00:00Z", "2026-09-30T12:00:00Z"],
    ["2026-09-30T12:00:00.123456789Z", "2026-09-30T12:00:00.123456789Z"],
    ["2026-10-01T00:00:00.123456789+08:00", "2026-09-30T16:00:00.123456789Z"],
    ["2026-09-30T23:00:00.987654321-07:30", "2026-10-01T06:30:00.987654321Z"],
    ["2026-09-30T12:00:00.12+00:00", "2026-09-30T12:00:00.12Z"],
    ["2026-09-30T12:00:00+05:45", "2026-09-30T06:15:00Z"],
  ];
  const unknown = [
    "plain diagnostic",
    "2026-09-30T12:00:00+8:00 malformed offset",
    "2026-09-30T12:00:00+24:00 invalid offset",
    "2026-09-30T12:00:00+08:60 invalid minute",
    "2026-02-30T12:00:00+08:00 invalid date",
  ];
  fixture.state.logs.gateway =
    [...lines.map(([time]) => `${time} ready`), ...unknown].join("\n") + "\n";
  const chunk = await fixture.readAgentRuntimeLogs(fixture.request("gateway"));
  assert.deepEqual(chunk.lines, [
    ...lines.map(([, time]) => ({ time, raw: "ready" })),
    ...unknown.map((raw) => ({ time: null, raw })),
  ]);
});

test("Kubernetes runtime log and Event 403s become the typed cluster RBAC error", async () => {
  const forbidden = () =>
    Object.assign(new Error("pods/log is forbidden: secret detail"), { statusCode: 403 });
  const fixture = runtimeLogDriverFixture();
  fixture.state.logError = forbidden();
  await assert.rejects(
    fixture.readAgentRuntimeLogs(fixture.request("gateway")),
    RuntimeLogsForbiddenByClusterError,
  );
  fixture.state.eventError = forbidden();
  await assert.rejects(
    fixture.describeAgentRuntime(new AbortController().signal),
    RuntimeLogsForbiddenByClusterError,
  );
  // A container without a previous instance yields no lines instead of an error.
  fixture.state.logError = Object.assign(new Error("previous terminated container not found"), {
    statusCode: 400,
  });
  const empty = await fixture.readAgentRuntimeLogs(fixture.request("gateway", { previous: true }));
  assert.deepEqual(empty.lines, []);
});

test("Kubernetes initial container log reads wait without swallowing other failures", async (t) => {
  for (const source of ["gateway", "agent"] as const) {
    for (const reason of ["PodInitializing", "ContainerCreating"]) {
      await t.test(`${source}: ${reason}`, async () => {
        const fixture = runtimeLogDriverFixture();
        fixture.state.waitingReason = reason;
        fixture.state.restartCount[source] = 0;
        const waiting = (
          message = `container "${source}" in pod "${source}-runtime-logs-pod" is waiting to start: ${reason}`,
        ) =>
          Object.assign(new Error("Kubernetes BadRequest"), {
            statusCode: 400,
            body: JSON.stringify({
              apiVersion: "v1",
              kind: "Status",
              code: 400,
              reason: "BadRequest",
              message,
            }),
          });
        fixture.state.logError = waiting();
        const empty = await fixture.readAgentRuntimeLogs(fixture.request(source));
        assert.deepEqual(empty.lines, []);
        assert.equal(empty.stream.restartCount, 0);
        assert.equal(empty.truncated, false);

        // Pod status can lag startup. A readable current instance must still be read.
        fixture.state.logError = undefined;
        fixture.state.logs[source] = "2026-09-30T12:00:00Z runtime started\n";
        const running = await fixture.readAgentRuntimeLogs(fixture.request(source));
        assert.deepEqual(running.lines, [{ time: "2026-09-30T12:00:00Z", raw: "runtime started" }]);

        for (const message of [
          "sinceSeconds must be greater than 0",
          `container "${source}" in pod "different-pod" is waiting to start: ${reason}`,
          `container "different-container" in pod "${source}-runtime-logs-pod" is waiting to start: ${reason}`,
        ]) {
          fixture.state.logError = waiting(message);
          await assert.rejects(
            fixture.readAgentRuntimeLogs(fixture.request(source)),
            (error) => error === fixture.state.logError,
          );
        }

        // An assigned instance ID makes initial absence uncertain; keep the failure.
        fixture.state.waitingReason = "ContainerCreating";
        fixture.state.logError = waiting(
          `container "${source}" in pod "${source}-runtime-logs-pod" is waiting to start: ContainerCreating`,
        );
        fixture.state.containerId = "containerd://existing-instance";
        await assert.rejects(
          fixture.readAgentRuntimeLogs(fixture.request(source)),
          (error) => error === fixture.state.logError,
        );
        fixture.state.containerId = undefined;
        fixture.state.restartCount[source] = 1;
        fixture.state.waitingReason = "CrashLoopBackOff";
        fixture.state.logError = waiting(
          `container "${source}" in pod "${source}-runtime-logs-pod" is waiting to start: CrashLoopBackOff`,
        );
        await assert.rejects(
          fixture.readAgentRuntimeLogs(fixture.request(source)),
          (error) => error === fixture.state.logError,
        );
      });
    }
  }
});

test("Kubernetes runtime log reads drop kubelet's untimestamped log-unavailable answer", async () => {
  const fixture = runtimeLogDriverFixture();
  // While the container restarts, kubelet answers 200 with its own error line, which has
  // no timestamp. It is not container output.
  fixture.state.logs.gateway =
    "unable to retrieve container logs for containerd://50c25aa8e1ba378edb6953635f4b49e376f6802d3d9a49775772c89845d8a7e0";
  const restarting = await fixture.readAgentRuntimeLogs(
    fixture.request("gateway", { previous: true }),
  );
  assert.deepEqual(restarting.lines, []);
  // The same text printed by the container carries a timestamp and stays.
  fixture.state.logs.gateway =
    "2026-09-30T12:00:00Z unable to retrieve container logs for containerd://abc\n";
  const printed = await fixture.readAgentRuntimeLogs(
    fixture.request("gateway", { previous: true }),
  );
  assert.deepEqual(printed.lines, [
    {
      time: "2026-09-30T12:00:00Z",
      raw: "unable to retrieve container logs for containerd://abc",
    },
  ]);
});
