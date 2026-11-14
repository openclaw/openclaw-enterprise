import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { asRecord } from "../../packages/utils/src/index.ts";
import {
  createRunnerFixture,
  currentSha,
  fixtureGitEnv,
  runnerEnv,
  runRunnerSync,
  writeJson,
} from "../helpers/ci-runner-fixture.ts";
import {
  prepareK3dDiagnosticsRun,
  writeK3dChildTest,
  writeK3dKubectl,
} from "../helpers/ci-runner-k3d-fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runnerPath = join(repositoryRoot, "scripts/ci/run-tests.mjs");

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function record(value: unknown, label: string) {
  const result = asRecord(value);
  assert.ok(result, `${label} must be an object`);
  return result;
}

function array(value: unknown, label: string): readonly unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function records(value: unknown, label: string) {
  return array(value, label).map((item, index) => record(item, `${label}[${index}]`));
}

function string(value: unknown, label: string) {
  assert.ok(typeof value === "string", `${label} must be a string`);
  return value;
}

function readRecord(path: string) {
  return readFile(path, "utf8").then((text) => record(parseJson(text), path));
}

function mixedPrecisionEventBoundary({
  namespace,
  pod,
  second,
  laterCount = 199,
}: {
  namespace: string;
  pod: string;
  second: string;
  laterCount?: number;
}) {
  const event = (
    uid: string,
    reason: string,
    timestamp: { lastTimestamp?: string; eventTime?: string },
  ) => ({
    metadata: { namespace, name: `${uid}.event`, uid },
    involvedObject: { kind: "Pod", name: pod, namespace },
    type: "Normal",
    reason,
    message: reason,
    count: 1,
    ...timestamp,
  });
  const older = event("older-whole-second", "OlderWholeSecond", {
    lastTimestamp: `${second}Z`,
  });
  const newer = event("newer-fractional-second", "NewerFractionalSecond", {
    eventTime: `${second}.100000Z`,
  });
  const later = Array.from({ length: laterCount }, (_, index) =>
    event(`later-${index}`, `Later${index}`, {
      eventTime: new Date(Date.parse(`${second}Z`) + (index + 1) * 1_000).toISOString(),
    }),
  );
  return { older, newer, events: [older, newer, ...later] };
}

function podReadiness(value: unknown) {
  return records(value, "Agent namespace pods").map(({ watch, containers }) => [
    watch,
    firstRecord(containers, "Agent namespace Pod containers").ready,
  ]);
}

function firstRecord(value: unknown, label: string) {
  return record(array(value, label)[0], `${label}[0]`);
}

function captureFields({ cluster, namespaces, pods, events, omitted }: Record<string, unknown>) {
  return {
    cluster,
    namespaces,
    pods: podReadiness(pods),
    events: records(events, "Agent namespace events").map(({ reason, count, lastTimestamp }) => [
      reason,
      count,
      lastTimestamp,
    ]),
    omittedEvents: record(omitted, "omitted Agent namespace activity").events,
  };
}

export async function checkBoundedAgentNamespaceActivity(t: TestContext) {
  const root = await createRunnerFixture(t);
  const { clusterDirectory, statePath, resultsPath, args } = await prepareK3dDiagnosticsRun(root, [
    { path: "tests/integration/agent.test.mjs", expectedTests: ["agent file passes"] },
  ]);
  // This kubectl stand-in serves the raw watch streams a live API server would
  // send while the test file creates and deletes its Agent namespace.
  const pod = (ready: boolean, type: string) => ({
    type,
    object: {
      kind: "Pod",
      metadata: {
        namespace: "occ-agent-a",
        name: "harness-0",
        creationTimestamp: "2026-09-29T00:00:00Z",
      },
      spec: {
        nodeName: "server-0",
        containers: [{ name: "harness", env: [{ name: "TOKEN", value: "do-not-publish-env" }] }],
      },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: ready ? "True" : "False", lastTransitionTime: "t" }],
        containerStatuses: [{ name: "harness", ready, restartCount: 0 }],
      },
    },
  });
  const event = (namespace: string, uid: string, reason: string, message: string, count = 1) => ({
    type: "ADDED",
    object: {
      metadata: { namespace, name: `${uid}.event`, uid },
      involvedObject: { kind: "Pod", name: "harness-0", namespace },
      type: "Normal",
      reason,
      message,
      count,
      firstTimestamp: "2026-09-29T00:00:01Z",
      lastTimestamp: `2026-09-29T00:10:0${count}Z`,
    },
  });
  const pods = [
    pod(false, "ADDED"),
    pod(false, "MODIFIED"),
    pod(true, "MODIFIED"),
    pod(true, "DELETED"),
  ];
  const boundary = mixedPrecisionEventBoundary({
    namespace: "occ-agent-a",
    pod: "harness-0",
    second: "2026-09-29T00:00:10",
    laterCount: 196,
  });
  const repeatedSeries = {
    metadata: {
      namespace: "occ-agent-a",
      name: "repeated-series.event",
      uid: "repeated-series",
    },
    involvedObject: { kind: "Pod", name: "harness-0", namespace: "occ-agent-a" },
    type: "Warning",
    reason: "RepeatedSeries",
    message: "Repeated event",
    eventTime: "2026-09-29T00:00:01Z",
    series: { count: 7, lastObservedTime: "2026-09-29T00:20:00Z" },
  };
  const events = [
    { type: "ADDED", object: repeatedSeries },
    ...boundary.events.map((object) => ({ type: "ADDED", object })),
    event("occ-agent-a", "e1", "Pulled", "Successfully pulled image"),
    event("occ-agent-a", "e2", "Unhealthy", "Readiness probe failed"),
    event("occ-agent-a", "e2", "Unhealthy", "Readiness probe failed", 3),
    event("occ-agent-a", "e3", "Failed", "bearer do-not-publish-event"),
    event("kube-system", "e4", "Started", "unrelated system event"),
  ];
  const kubectl = await writeK3dKubectl(root, { kind: "watch", pods, events });
  const watchCase = {
    kind: "watch" as const,
    clusterDirectory,
    captureBarrierDirectory: join(root, "state"),
    podRecords: pods.length,
    eventRecords: events.length,
  };
  await writeK3dChildTest(join(root, "tests/integration/agent.test.mjs"), {
    ...watchCase,
    name: "agent file passes",
    id: "agent",
  });

  const result = runRunnerSync(args, {
    OCC_KUBECTL_BIN: kubectl,
    CI_RUNNER_TEST_CAPTURE_BARRIER: "single",
    CI_RUNNER_TEST_EXPECTED_CAPTURES: "1",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readRecord(resultsPath)).status, "passed");
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const report = record(parseJson(text), "single diagnostics report");
  assert.equal(report.lane, "k3d-lane");
  const namespaces = records(report.agentNamespaces, "single Agent namespace captures");
  assert.equal(namespaces.length, 1);
  const [activity] = namespaces;
  assert.ok(activity, "single Agent namespace capture");
  assert.equal(activity.file, "tests/integration/agent.test.mjs");
  assert.equal(activity.cluster, "owned-cluster");
  assert.deepEqual(activity.namespaces, ["occ-agent-a"]);
  // Unchanged watch records collapse; readiness and deletion transitions remain.
  assert.deepEqual(podReadiness(activity.pods), [
    ["ADDED", false],
    ["MODIFIED", true],
    ["DELETED", true],
  ]);
  const activityEvents = records(activity.events, "Agent namespace events");
  assert.equal(activityEvents.length, 200);
  const firstRetainedEvent = boundary.events[2];
  assert.ok(firstRetainedEvent, "first retained event in fixture");
  assert.equal(
    record(activityEvents[0], "first Agent namespace event").reason,
    firstRetainedEvent.reason,
  );
  assert.equal(
    activityEvents.some(({ reason }) => reason === boundary.older.reason),
    false,
  );
  assert.equal(
    activityEvents.some(({ reason }) => reason === boundary.newer.reason),
    false,
  );
  assert.equal(record(activity.omitted, "omitted Agent namespace activity").events, 2);
  assert.deepEqual(
    activityEvents.slice(-4).map(({ reason, count }) => [reason, count]),
    [
      ["Pulled", 1],
      ["Failed", 1],
      ["Unhealthy", 3],
      ["RepeatedSeries", 7],
    ],
  );
  assert.equal(
    record(activityEvents.at(-1), "last Agent namespace event").lastTimestamp,
    repeatedSeries.series.lastObservedTime,
  );
  assert.doesNotMatch(text, /do-not-publish|unrelated system event/);
  // Raw watch streams hold full Pod specs; only the projection survives.
  assert.deepEqual(await readdir(clusterDirectory), []);

  // Two files sharing the runner under fileConcurrency watch the same cluster at once. Each
  // keeps its own watch streams, so neither truncates nor deletes the other's capture.
  await writeK3dChildTest(join(root, "tests/integration/agent-sibling.test.mjs"), {
    ...watchCase,
    name: "sibling file passes",
    id: "sibling",
  });
  const pairFiles = [
    "tests/integration/agent.test.mjs",
    "tests/integration/agent-sibling.test.mjs",
  ] as const;
  await writeJson(join(root, "scripts/ci/pair-suites.json"), {
    version: 1,
    lanes: {
      "k3d-pair": {
        fileConcurrency: 2,
        parallelFiles: pairFiles,
        files: [
          { path: pairFiles[0], expectedTests: ["agent file passes"] },
          { path: pairFiles[1], expectedTests: ["sibling file passes"] },
        ],
      },
    },
    groups: {},
  });
  const pairStatePath = join(root, "state/k3d-pair.json");
  await writeJson(pairStatePath, {
    lane: "k3d-pair",
    prefix: "openclaw-ci-k3d-pair-23456789abcd",
    resources: array((await readRecord(statePath)).resources, "prepared resources"),
  });
  const pairResultsPath = join(root, "results/k3d-pair.json");
  const pair = runRunnerSync(
    [
      "run",
      "k3d-pair",
      "--manifest",
      join(root, "scripts/ci/pair-suites.json"),
      "--root",
      root,
      "--state",
      pairStatePath,
      "--results",
      pairResultsPath,
    ],
    {
      OCC_KUBECTL_BIN: kubectl,
      CI_RUNNER_FILE_CONCURRENCY: "2",
      CI_RUNNER_TEST_CAPTURE_BARRIER: "pair",
      CI_RUNNER_TEST_EXPECTED_CAPTURES: "2",
    },
  );
  assert.equal(pair.status, 0, pair.stderr);
  const pairSummary = await readRecord(pairResultsPath);
  assert.deepEqual(
    records(pairSummary.files, "parallel file results").map(({ mode }) => mode),
    ["parallel", "parallel"],
  );
  const pairText = await readFile(`${pairStatePath}.diagnostics.json`, "utf8");
  const pairReport = record(parseJson(pairText), "parallel diagnostics report");
  // Files can finish in either order. Each file must retain its own complete capture.
  const captures = records(pairReport.agentNamespaces, "parallel Agent namespace captures")
    .map((capture) => ({ file: string(capture.file, "capture file"), capture }))
    .sort(({ file: left }, { file: right }) => left.localeCompare(right));
  assert.deepEqual(
    captures.map(({ file }) => file),
    [...pairFiles].sort((left, right) => left.localeCompare(right)),
  );
  const singleCapture = captureFields(activity);
  for (const { file, capture } of captures) {
    assert.deepEqual(
      captureFields(capture),
      singleCapture,
      `parallel capture for ${file} matches the single-file capture`,
    );
  }
  assert.doesNotMatch(pairText, /do-not-publish|unrelated system event/);
  assert.deepEqual(await readdir(clusterDirectory), []);

  // A second cluster whose directory is gone fails the capture after the first cluster's
  // watches started. The file still runs, and those watches are stopped: left running,
  // their child processes would hold the runner until the watch timeout.
  const brokenStatePath = join(root, "state/k3d-broken.json");
  await writeJson(brokenStatePath, {
    lane: "k3d-lane",
    prefix: "openclaw-ci-k3d-lane-3456789abcde",
    resources: [
      ...array((await readRecord(statePath)).resources, "prepared resources"),
      {
        kind: "k3d-cluster",
        status: "ready",
        name: "removed-cluster",
        directory: join(root, "removed-cluster"),
        kubeconfig: join(root, "removed-cluster/kubeconfig"),
        context: "k3d-removed-cluster",
      },
    ],
  });
  const broken = spawnSync(
    process.execPath,
    [
      runnerPath,
      "run",
      "k3d-lane",
      "--manifest",
      join(root, "scripts/ci/suites.json"),
      "--root",
      root,
      "--state",
      brokenStatePath,
      "--results",
      join(root, "results/k3d-broken.json"),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...fixtureGitEnv,
        GITHUB_SHA: currentSha(),
        OCC_KUBECTL_BIN: kubectl,
      },
      timeout: 30_000,
    },
  );
  assert.equal(broken.status, 0, broken.stderr);
  assert.match(
    broken.stderr,
    /Agent namespace activity unavailable for tests\/integration\/agent\.test\.mjs/,
  );
  assert.deepEqual(await readdir(clusterDirectory), []);
}

export async function checkMixedPrecisionEventOrder() {
  const { projectContainerLog } = await import("../../scripts/ci/k3d-diagnostics.mjs");
  const { older, newer } = mixedPrecisionEventBoundary({
    namespace: "occ-agent-a",
    pod: "harness-0",
    second: "2026-10-21T00:00:00",
    laterCount: 0,
  });
  const projected = projectContainerLog({
    lines: [],
    snapshots: [
      {
        events: [
          older,
          {
            ...older,
            metadata: { ...older.metadata, uid: "equal-fractional" },
            reason: "EqualFractional",
            eventTime: "2026-10-21T00:00:00.000000Z",
            lastTimestamp: undefined,
          },
          newer,
        ],
      },
      {
        events: [
          {
            metadata: { namespace: "occ-agent-a", uid: "repeated-series" },
            involvedObject: { kind: "Pod", name: "harness-0", namespace: "occ-agent-a" },
            type: "Warning",
            reason: "RepeatedSeries",
            message: "Repeated event",
            eventTime: "2026-10-21T00:00:01Z",
            series: { count: 7, lastObservedTime: "2026-10-21T00:10:00Z" },
          },
          ...Array.from({ length: 200 }, (_, index) => ({
            metadata: { namespace: "occ-agent-a", uid: `intervening-${index}` },
            involvedObject: { kind: "Pod", name: "harness-0", namespace: "occ-agent-a" },
            type: "Normal",
            reason: `Intervening${index}`,
            message: "Intervening event",
            count: 1,
            eventTime: new Date(
              Date.parse("2026-10-21T00:00:01Z") + (index + 1) * 1_000,
            ).toISOString(),
          })),
        ],
      },
    ],
  });
  assert.ok(projected, "projected container log");
  const [precisionSnapshot, repeatedSnapshot] = projected.snapshots;
  assert.ok(precisionSnapshot, "equal-instant event snapshot");
  assert.ok(repeatedSnapshot, "repeated event snapshot");
  assert.deepEqual(
    precisionSnapshot.events.map(({ reason }) => reason),
    [older.reason, "EqualFractional", newer.reason],
  );
  assert.deepEqual(repeatedSnapshot.events.at(-1), {
    namespace: "occ-agent-a",
    kind: "Pod",
    name: "harness-0",
    type: "Warning",
    reason: "RepeatedSeries",
    message: "Repeated event",
    count: 7,
    firstTimestamp: "2026-10-21T00:00:01Z",
    lastTimestamp: "2026-10-21T00:10:00Z",
  });
}

export async function checkFailedWaitContainerLog(t: TestContext) {
  const root = await createRunnerFixture(t);
  const pod = {
    metadata: {
      namespace: "occ-agent-a",
      name: "gateway-0",
      uid: "uid-1",
      creationTimestamp: "2026-10-08T07:43:40Z",
      deletionTimestamp: "2026-10-08T07:43:53Z",
      deletionGracePeriodSeconds: 330,
    },
    spec: {
      containers: [{ name: "gateway", env: [{ name: "TOKEN", value: "do-not-publish-env" }] }],
    },
    status: {
      phase: "Running",
      containerStatuses: [
        { name: "gateway", ready: false, restartCount: 0, state: { running: { startedAt: "t" } } },
      ],
    },
  };
  const event = {
    metadata: { namespace: "occ-agent-a", name: "gateway-0.kill", uid: "e1" },
    involvedObject: { kind: "Pod", name: "gateway-0", namespace: "occ-agent-a" },
    type: "Normal",
    reason: "Killing",
    message: "Stopping container gateway",
    count: 1,
    lastTimestamp: "2026-10-08T07:43:53Z",
  };
  const boundary = mixedPrecisionEventBoundary({
    namespace: "occ-agent-a",
    pod: "gateway-0",
    second: "2026-10-08T07:43:52",
    laterCount: 198,
  });
  const events = [...boundary.events, event];
  const logLines = [
    "2026-10-08T07:43:49.1Z [gateway] startup phase: config.auth starting",
    "2026-10-08T07:43:53.2Z [gateway] received SIGTERM; shutting down",
    "2026-10-08T07:43:53.3Z request Authorization: Bearer do-not-publish-header",
    "2026-10-08T07:43:53.4Z provider token=do-not-publish-assignment refreshed",
    "2026-10-08T07:43:53.5Z parent value secretauthvalue-parent seen",
    '2026-10-08T07:43:53.5Z OCSF-JSON {"detail":"private-structured-early","message":"failure"}',
    '2026-10-08T07:43:53.5Z OCSF-JSON {"message":"failure","detail":"private-structured-truncated',
  ];
  // Only the lane gives the child this value; the runner's own env never has it.
  const childSecret = "childonlysecret-1754";
  // One stand-in serves the runner's raw watches (which wait until stopped) and
  // the test helper's log follow and snapshots; the log ends after a slow exit.
  const bin = join(root, "bin");
  await mkdir(bin);
  const kubectl = await writeK3dKubectl(bin, { kind: "stop", pod, events, logLines });
  const kubectlCalls = join(root, "kubectl-calls.jsonl");
  await writeFile(
    kubectl,
    `${await readFile(kubectl, "utf8")}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(kubectlCalls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
  );
  await writeK3dChildTest(join(root, "tests/integration/stop.test.mjs"), { kind: "stop" });
  await writeK3dChildTest(join(root, "tests/integration/pass.test.mjs"), { kind: "passing" });

  const { clusterDirectory, statePath, args } = await prepareK3dDiagnosticsRun(
    root,
    [
      { path: "tests/integration/stop.test.mjs", expectedTests: ["gateway stop is confirmed"] },
      { path: "tests/integration/pass.test.mjs", expectedTests: ["passes"] },
    ],
    { OCC_TEST_CHILD_ONLY: childSecret },
  );
  const provenanceCanary = "private-image-metadata";
  const runtimeProvenance = {
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE: {
      imageId: `sha256:${"a".repeat(64)}`,
      manifestDigest: `sha256:${"b".repeat(64)}`,
      status: "available",
      platform: "linux/amd64",
      openclawCommit: "c".repeat(40),
      codex: { version: "0.164.0", binarySha256: "d".repeat(64) },
    },
    OCC_TEST_KUBERNETES_AGENT_IMAGE: {
      imageId: `sha256:${"e".repeat(64)}`,
      manifestDigest: `sha256:${"f".repeat(64)}`,
      status: "unavailable",
    },
  };
  const state = {
    ...(await readRecord(statePath)),
    prefix: provenanceCanary,
    runtimeProvenance: {
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: {
        ...runtimeProvenance.OCC_TEST_KUBERNETES_GATEWAY_IMAGE,
        config: provenanceCanary,
      },
      OCC_TEST_KUBERNETES_AGENT_IMAGE: {
        ...runtimeProvenance.OCC_TEST_KUBERNETES_AGENT_IMAGE,
        error: provenanceCanary,
      },
    },
  };
  await writeJson(statePath, state);
  // The last file removes the private state, as per-file cleanup can. Earlier
  // validated evidence must survive in both the final result and same-run sidecar.
  const passingFile = join(root, "tests/integration/pass.test.mjs");
  await writeFile(
    passingFile,
    `${await readFile(passingFile, "utf8")}\nimport { rm } from "node:fs/promises";\nawait rm(${JSON.stringify(statePath)});\n`,
  );
  await writeJson(`${statePath}.diagnostics.json`, {
    lane: "previous-lane",
    preparationId: "previous-preparation",
    failures: [{ file: "previous-file", private: provenanceCanary }],
    runtimeProvenance,
  });
  const result = runRunnerSync(args, {
    OCC_KUBECTL_BIN: kubectl,
    PATH: `${bin}:${process.env.PATH}`,
  });

  assert.equal(result.status, 1, result.stderr);
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const report = record(parseJson(text), "failed wait diagnostics report");
  const summary = await readRecord(join(root, "results/k3d.json"));
  assert.deepEqual(
    records(summary.files, "failed wait file results").map(({ path, status, tests }) => ({
      path,
      status,
      tests: records(tests, "file test results").map(({ name, status }) => [name, status]),
    })),
    [
      {
        path: "tests/integration/stop.test.mjs",
        status: "failed",
        tests: [["gateway stop is confirmed", "failed"]],
      },
      {
        path: "tests/integration/pass.test.mjs",
        status: "passed",
        tests: [["passes", "passed"]],
      },
    ],
    "the failed wait and the passing control have distinct runner outcomes",
  );
  assert.deepEqual(summary.runtimeProvenance, runtimeProvenance);
  assert.deepEqual(report.runtimeProvenance, runtimeProvenance);
  assert.equal(report.preparationId, createHash("sha256").update(state.prefix).digest("hex"));
  assert.ok(!JSON.stringify(summary).includes(provenanceCanary));
  assert.ok(!text.includes(provenanceCanary));
  const containerLogs = records(report.containerLogs, "failed wait container logs");
  // Only the failed wait writes a record: not the wait that settled, not the passing file.
  assert.equal(containerLogs.length, 1);
  const [log] = containerLogs;
  assert.ok(log, "failed wait container log");
  assert.equal(log.file, "tests/integration/stop.test.mjs");
  assert.equal(log.test, "gateway stop is confirmed");
  assert.equal(log.reason, "terminal response wait");
  assert.deepEqual(
    [log.namespace, log.pod, log.container],
    ["occ-agent-a", "gateway-0", "gateway"],
  );
  assert.deepEqual(
    records(log.markers, "container log markers").map(({ label }) => label),
    ["stop requested", "failed: terminal response wait"],
  );
  // The follow ran to the container's exit, unterminated last line included.
  const stream = record(log.stream, "container log stream");
  assert.equal(stream.ended, true);
  assert.equal(stream.exitCode, 0);
  assert.equal(stream.error, "follow note\n[redacted credential-bearing line]");
  assert.deepEqual(log.lines, [
    logLines[0],
    logLines[1],
    "[redacted credential-bearing line]",
    "2026-10-08T07:43:53.4Z provider token=[redacted] refreshed",
    "2026-10-08T07:43:53.5Z parent value [env:CI_RUNNER_PARENT_SECRET] seen",
    "2026-10-08T07:43:53.6Z child value [env:OCC_TEST_CHILD_ONLY]",
    "2026-10-08T07:44:22.0Z [gateway] exit 0",
  ]);
  // A failed read is marked, so it cannot pass for a Pod that is already gone.
  const snapshots = records(log.snapshots, "failed wait snapshots");
  assert.deepEqual(
    snapshots.map(({ label, unavailable }) => [label, unavailable]),
    [
      ["at-failure", undefined],
      ["after-log", true],
    ],
  );
  const [snapshot] = snapshots;
  assert.ok(snapshot, "snapshot at failure");
  const stoppedPod = firstRecord(snapshot.pods, "stopped Pods");
  assert.equal(stoppedPod.deletedAt, "2026-10-08T07:43:53Z");
  assert.equal(stoppedPod.deletionGracePeriodSeconds, 330);
  assert.equal(firstRecord(stoppedPod.containers, "stopped Pod containers").startedAt, "t");
  const snapshotEvents = records(snapshot.events, "failed wait events");
  assert.equal(snapshotEvents.length, 200);
  assert.equal(
    record(snapshotEvents[0], "first retained failed wait event").reason,
    boundary.newer.reason,
  );
  assert.equal(
    snapshotEvents.some(({ reason }) => reason === boundary.older.reason),
    false,
  );
  assert.deepEqual(
    snapshotEvents.find(({ reason }) => reason === "Killing"),
    {
      namespace: "occ-agent-a",
      kind: "Pod",
      name: "gateway-0",
      type: "Normal",
      reason: "Killing",
      message: "Stopping container gateway",
      count: 1,
      lastTimestamp: "2026-10-08T07:43:53Z",
    },
  );
  assert.doesNotMatch(text, /do-not-publish|secretauthvalue|childonlysecret/);
  // The record directory lived in the cluster's private directory and is gone.
  assert.deepEqual(
    (await readdir(clusterDirectory)).filter((name) => name.startsWith("container-logs-")),
    [],
  );

  // A different lane must not inherit retained state or the sidecar from this lane.
  await assert.rejects(readFile(statePath), { code: "ENOENT" });
  await writeJson(statePath, state);
  await writeFile(
    join(root, "tests/integration/later.test.mjs"),
    'import test from "node:test"; test("later failure", () => { throw new Error("later"); });\n',
  );
  await writeJson(join(root, "scripts/ci/k3d-lane.json"), {
    files: [{ path: "tests/integration/later.test.mjs", expectedTests: ["later failure"] }],
  });
  await writeJson(join(root, "scripts/ci/suites.json"), {
    version: 1,
    lanes: { "later-lane": "./k3d-lane.json" },
    groups: {},
  });
  const initialCalls = await readFile(kubectlCalls, "utf8");
  assert.notEqual(initialCalls, "", "the original lane reached namespace capture");
  const [command, , ...laneOptions] = args;
  assert.ok(command, "runner command");
  for (const retainedState of [true, false]) {
    if (!retainedState) {
      await rm(statePath, { force: true });
    }
    const later = runRunnerSync([command, "later-lane", ...laneOptions], {
      OCC_KUBECTL_BIN: kubectl,
      PATH: `${bin}:${process.env.PATH}`,
    });
    assert.equal(later.status, 1, later.stderr);
    const laterSummary = await readRecord(join(root, "results/k3d.json"));
    assert.equal(laterSummary.runtimeProvenance, undefined);
    const next = await readRecord(`${statePath}.diagnostics.json`);
    assert.equal(next.lane, "later-lane");
    assert.equal(next.runtimeProvenance, undefined);
    assert.equal(next.agentNamespaces, undefined);
    assert.equal(
      await readFile(kubectlCalls, "utf8"),
      initialCalls,
      "foreign state starts no capture",
    );
    assert.equal(next.containerLogs, undefined);
    assert.deepEqual(
      records(next.failures, "later lane failures").map(({ file }) => file),
      ["tests/integration/later.test.mjs"],
    );
  }
}

export async function checkControllerReadinessEvidence(t: TestContext, earlyLogExit: boolean) {
  const root = await createRunnerFixture(t);
  const bin = join(root, "bin");
  await mkdir(bin);
  const deleted = join(root, "namespace-deleted");
  const calls = join(root, "kubectl-calls.jsonl");
  const { clusterDirectory, statePath, args } = await prepareK3dDiagnosticsRun(root, [
    { path: "tests/integration/startup.test.mjs", expectedTests: ["controller startup fails"] },
  ]);
  // These are the controller fixture's real labels, without Compute's managed-by label.
  // The Agent watch sees no Pod; only the startup wait's capture can retain this failure.
  const labels = {
    "app.kubernetes.io/name": "openclaw-enterprise",
    "app.kubernetes.io/instance": "fixture",
    "app.kubernetes.io/component": "api",
  };
  const namespace = "occ-controller-failed";
  const pod = {
    metadata: { namespace, name: "api-0", uid: "api-uid", labels },
    spec: { containers: [{ name: "api", env: [{ name: "TOKEN", value: "private-env" }] }] },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "api",
          ready: false,
          restartCount: 2,
          state: { waiting: { reason: "CrashLoopBackOff" } },
        },
      ],
    },
  };
  const eventValue = "opaque-long-value-" + "z".repeat(600);
  const event = {
    metadata: { namespace, name: "api-backoff", uid: "event-uid" },
    involvedObject: { kind: "Pod", name: "api-0", namespace },
    type: "Warning",
    reason: "BackOff",
    message: [
      "Back-off restarting failed container api",
      "-----BEGIN " + "PRIVATE KEY-----",
      "synthetic-pem-body-marker",
      "-----END " + "PRIVATE KEY-----",
      eventValue,
    ].join("\n"),
  };
  const kubectl = await writeK3dKubectl(bin, {
    kind: "startup",
    root,
    calls,
    deleted,
    earlyLogExit,
    pod,
    event,
  });
  await writeK3dChildTest(join(root, "tests/integration/startup.test.mjs"), {
    kind: "startup",
    root,
    deleted,
    selection: {
      kubeconfigPath: join(clusterDirectory, "kubeconfig"),
      kubernetesContext: "k3d-owned-cluster",
    },
    target: { namespace, container: "api", labels },
  });
  const result = runRunnerSync(args, {
    OCC_KUBECTL_BIN: kubectl,
    PATH: `${bin}:${process.env.PATH}`,
    OCC_TEST_EVENT_VALUE: eventValue,
    // pnpm's package name matches the fixture deployment name. Keep the
    // readiness assertion independent of environment-value redaction.
    npm_package_name: "",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /timed out waiting for the condition on deployments\/openclaw-enterprise-api/,
  );
  assert.equal(await readFile(deleted, "utf8"), "deleted");
  const text = await readFile(`${statePath}.diagnostics.json`, "utf8");
  const report = record(parseJson(text), "controller readiness diagnostics report");
  assert.equal(report.agentNamespaces, undefined);
  assert.ok(
    Array.isArray(report.containerLogs),
    "failed controller startup must retain diagnostics",
  );
  const containerLogs: readonly unknown[] = report.containerLogs;
  assert.equal(containerLogs.length, 1, "a successful wait must not publish a failure record");
  const log = record(containerLogs[0], "controller readiness container log");
  assert.equal(log.namespace, namespace);
  assert.equal(log.pod, undefined);
  assert.equal(log.container, "api");
  assert.equal(log.reason, "deployment/openclaw-enterprise-api readiness");
  assert.deepEqual(log.lines, [
    "startup: configured role still has bindings",
    "[redacted credential-bearing line]",
  ]);
  const snapshot = firstRecord(log.snapshots, "controller readiness snapshots");
  const failedPod = firstRecord(snapshot.pods, "controller readiness Pods");
  assert.equal(failedPod.uid, "api-uid");
  assert.equal(
    firstRecord(failedPod.containers, "controller Pod containers").waitingReason,
    "CrashLoopBackOff",
  );
  if (earlyLogExit) {
    assert.equal(snapshot.unavailable, true);
    assert.deepEqual(snapshot.events, []);
    const stream = record(log.stream, "controller readiness log stream");
    assert.match(string(stream.error, "log stream error"), /ContainerCreating/);
  } else {
    assert.equal(firstRecord(snapshot.events, "controller readiness events").reason, "BackOff");
  }
  assert.doesNotMatch(
    text,
    /private-env|private-header|synthetic-pem-body-marker|opaque-long-value-/,
  );
  const commands = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line, index) => {
      const argv = array(parseJson(line), `kubectl command ${index + 1}`);
      assert.ok(
        argv.every((arg) => typeof arg === "string"),
        `kubectl command ${index + 1} must contain strings`,
      );
      return argv;
    });
  for (const args of commands.filter((args) => !args.includes("--raw"))) {
    assert.equal(args[args.indexOf("--namespace") + 1], namespace);
  }
  const recovered = commands.filter(
    (args) => args.includes("logs") && !args.includes("--follow=true"),
  );
  assert.equal(recovered.length, earlyLogExit ? 1 : 0);
  const reads = commands.filter((args) => args.includes("pods"));
  assert.equal(reads.length, 2);
  for (const args of reads) {
    assert.equal(
      args[args.indexOf("-l") + 1],
      Object.entries(labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(","),
    );
  }
  assert.deepEqual(
    (await readdir(clusterDirectory)).filter((name) => name.startsWith("container-logs-")),
    [],
  );
  // A direct local run has no CI record directory. Its diagnostic must be just as
  // redacted, and failed diagnostic reads must not replace the readiness error.
  if (!earlyLogExit) {
    await rm(deleted);
  }
  const directEnv: NodeJS.ProcessEnv = runnerEnv({
    PATH: `${bin}:${process.env.PATH}`,
    OCC_TEST_EVENT_VALUE: eventValue,
  });
  delete directEnv.NODE_TEST_CONTEXT;
  delete directEnv.OPENCLAW_CI_CONTAINER_LOG_DIR;
  const direct = spawnSync(
    process.execPath,
    ["--test", join(root, "tests/integration/startup.test.mjs")],
    {
      cwd: root,
      env: directEnv,
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(direct.status, 1, direct.stderr);
  assert.match(
    direct.stdout,
    /timed out waiting for the condition on deployments\/openclaw-enterprise-api/,
  );
  if (earlyLogExit) {
    assert.match(direct.stdout, /"unavailable":true/);
  } else {
    assert.match(direct.stdout, /Back-off restarting failed container api/);
  }
  assert.match(direct.stdout, /startup: configured role still has bindings/);
  assert.doesNotMatch(
    direct.stdout + direct.stderr,
    /private-env|private-header|synthetic-pem-body-marker|opaque-long-value-/,
  );
}
