import assert from "node:assert/strict";
import { availableParallelism, totalmem } from "node:os";
import test from "node:test";
import { asRecord } from "../../packages/utils/src/objects.ts";
import {
  recordFirstAgentPodTiming,
  sampleFirstAgentCapacity,
} from "../helpers/local-first-agent-profile.ts";

function recorder() {
  const measurements: Record<string, unknown>[] = [];
  const diagnostic = (line: string) => {
    const prefix = "openclaw-ci-measurement ";
    assert.ok(line.startsWith(prefix));
    const measurement = asRecord(JSON.parse(line.slice(prefix.length)));
    assert.ok(measurement);
    measurements.push(measurement);
  };
  return { diagnostic, measurements };
}

const created = Date.UTC(2026, 0, 1);
const timestamp = (offset: number) => new Date(created + offset).toISOString();

test("first-Agent Pod timing reports only relative milestones and aggregate restarts", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: created + 500 });
  const context = recorder();
  const pod = {
    metadata: { creationTimestamp: timestamp(0), name: "private-pod" },
    spec: { nodeName: "private-worker" },
    status: {
      conditions: [
        { type: "PodScheduled", status: "False", lastTransitionTime: timestamp(4) },
        { type: "PodScheduled", status: "True", lastTransitionTime: timestamp(30) },
        { type: "Initialized", status: "True", lastTransitionTime: timestamp(50) },
        { type: "Ready", status: "True", lastTransitionTime: timestamp(300) },
      ],
      containerStatuses: [
        {
          name: "private-container",
          state: { running: { startedAt: timestamp(210) } },
          restartCount: 2,
        },
        { state: { running: { startedAt: timestamp(160) } }, restartCount: 1 },
        {},
      ],
    },
  };
  recordFirstAgentPodTiming(context, "native-initial", "harness", pod, created - 15);
  assert.deepEqual(context.measurements, [
    {
      kind: "local-first-agent-pod",
      stage: "native-initial",
      role: "harness",
      createdAfterRequestMs: 15,
      scheduledMs: 30,
      initializedMs: 50,
      runningMs: 210,
      readyMs: 300,
      observedMs: 500,
      restarts: 3,
    },
  ]);
});

test("first-Agent Pod timing distinguishes absent containers from missing start times", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: created });
  const context = recorder();
  const metadata = { creationTimestamp: timestamp(0) };
  for (const status of [
    {},
    {
      conditions: [{ type: "Ready", status: "True", lastTransitionTime: "invalid" }],
      containerStatuses: [{}],
    },
  ]) {
    recordFirstAgentPodTiming(
      context,
      "native-replacement",
      "gateway",
      { metadata, status },
      created + 5,
    );
  }
  assert.deepEqual(
    context.measurements,
    [null, 0].map((runningMs) => ({
      kind: "local-first-agent-pod",
      stage: "native-replacement",
      role: "gateway",
      createdAfterRequestMs: -5,
      scheduledMs: null,
      initializedMs: null,
      runningMs,
      readyMs: null,
      observedMs: 0,
      restarts: 0,
    })),
  );
});

test("first-Agent capacity finish reports one aggregate across initial, interval and final samples", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const context = recorder();
  const finish = sampleFirstAgentCapacity(context);
  t.mock.timers.tick(2_000);
  assert.equal(context.measurements.length, 0);
  finish();
  t.mock.timers.tick(2_000);
  finish();
  const [capacity] = context.measurements;
  assert.ok(capacity);
  const { minimumFreeMiB, maximumLoadHundredths } = capacity;
  assert.ok(
    typeof minimumFreeMiB === "number" &&
      Number.isInteger(minimumFreeMiB) &&
      minimumFreeMiB >= 0 &&
      minimumFreeMiB <= Math.round(totalmem() / 1024 ** 2),
  );
  assert.ok(
    typeof maximumLoadHundredths === "number" &&
      Number.isInteger(maximumLoadHundredths) &&
      maximumLoadHundredths >= 0,
  );
  assert.deepEqual(context.measurements, [
    {
      kind: "local-first-agent-capacity",
      cpus: availableParallelism(),
      totalMiB: Math.round(totalmem() / 1024 ** 2),
      minimumFreeMiB,
      maximumLoadHundredths,
      samples: 3,
    },
  ]);
});
