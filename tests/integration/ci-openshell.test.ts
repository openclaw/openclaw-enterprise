import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { asRecord } from "../../packages/utils/src/index.ts";
import { createOccLogger, resemblesCredential } from "../../apps/controller/src/logging.ts";
import {
  redactLogLine,
  redactOutputLine,
  redactFailureDetail,
} from "../../scripts/ci/failure-redaction.mjs";
import { withEnvironment } from "../helpers/environment.ts";
import { prependPath } from "../helpers/fake-commands.ts";
import {
  assertGatewayPolicyRunSucceeded,
  openShellStaleRelay,
  openShellSettingsChange,
  observeSandboxProbe,
  summarizeWorkerEvents,
  createOpenShellWorkerLogEmitter,
  workerDiagnosticLines,
  workerFailureDetail,
  rethrowOpenShellFailure,
} from "../helpers/k3d-failure-diagnostics.ts";
import { listen } from "../helpers/listen.ts";
import {
  createOpenShellInstallationConfiguration,
  createOpenShellKubernetesFixture,
  createOpenShellServiceLoopbackLookup,
  openShellChartImageValues,
  openShellGatewayNetworkPolicies,
  outageAttemptRead,
  waitForOpenShellRevisionActivation,
} from "../helpers/openshell-kubernetes-real.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { openShellTestDirectory } from "./ci-openshell-fixtures.ts";

function jsonObject(text: string) {
  const object = asRecord(JSON.parse(text));
  assert.ok(object, "expected a JSON object");
  return object;
}

type GatewayPolicyClient = Parameters<typeof assertGatewayPolicyRunSucceeded>[0];
type GatewayPolicyOutcome = Parameters<typeof assertGatewayPolicyRunSucceeded>[1];
type PollOnce = Parameters<typeof waitForOpenShellRevisionActivation>[0];

test("OpenShell failure summaries retain bounded Compute causes without provider or chat text", () => {
  const revisionId = "rev_10000000-0000-4000-8000-000000000003";
  const failure = {
    event: "worker.compute-prepare-failed",
    revisionId,
    code: "KUBERNETES_API_REJECTED",
    step: "gateway_deployment",
    errorClass: "KubernetesApiError",
    status: 422,
    candidatePreparationReached: false,
  };
  // The worker can retry the same preparation failure many times before the wait ends.
  const firstAt = "2026-11-11T20:00:00.000Z";
  const lastAt = "2026-11-11T20:01:00.000Z";
  const at = "2026-11-11T20:02:00.000Z";
  const events = [firstAt, lastAt].map((observedAt) => ({
    ...failure,
    observedAt,
    message: "private provider response",
    chat: "private chat",
  }));
  const completed = {
    event: "worker.completed",
    revisionId,
    code: "WORKSPACE_NODE_PENDING",
    cleanupCause: "SANDBOX_DELETE_PENDING",
    observedAt: at,
  };
  const observations = [...events, completed];
  assert.deepEqual(summarizeWorkerEvents(observations, revisionId), [
    { ...failure, count: 2, firstAt, lastAt },
    {
      event: "worker.completed",
      revisionId,
      code: "WORKSPACE_NODE_PENDING",
      cleanupCause: "SANDBOX_DELETE_PENDING",
      at,
    },
  ]);
  assert.equal(summarizeWorkerEvents(observations, revisionId, 1).length, 1);
  assert.deepEqual(
    summarizeWorkerEvents(
      [
        {
          ...failure,
          step: "x".repeat(161),
          errorClass: "sk-" + "s".repeat(30),
          status: Number.POSITIVE_INFINITY,
          candidatePreparationReached: "private provider response",
        },
      ],
      revisionId,
    ),
    [{ event: failure.event, revisionId, code: failure.code, at: undefined }],
  );
});

test("OpenShell worker sinks omit response text and share both credential checks", () => {
  const lines: ReturnType<typeof jsonObject>[] = [];
  const emit = createOpenShellWorkerLogEmitter(
    createOccLogger({
      component: "openshell-test-worker",
      destination: { write: (line) => lines.push(jsonObject(line)) },
    }),
  );
  const token = "ghs_" + "a_b".repeat(6);
  assert.equal(resemblesCredential(token), true);
  assert.equal(redactLogLine(token, [], 160), token, "CI redaction alone misses this shape");
  const event = {
    event: "worker.compute-prepare-failed",
    revisionId: "rev_test",
    code: "KUBERNETES_API_REJECTED",
    step: "gateway_deployment",
    status: 422,
    errorClass: "KubernetesApiError",
    validationCategory: "PVC_ADMISSION_LABELS",
    reason: "PrivateResponseWord",
    message: "private response text",
    cause: token,
  };
  emit(event);
  emit({ event: "worker.completed", code: "AUTHORIZATION_DENIED" });
  emit({ event: "worker.error", code: "DEPENDENCY_UNAVAILABLE", cleanupCause: token });
  emit({ event: "worker.health", message: "private health text" });
  assert.equal(lines.length, 3, "health stays at the suppressed debug level");
  const [failed, denied, unavailable] = lines;
  assert.ok(failed && denied && unavailable);
  const { time: _time, ...first } = failed;
  assert.deepEqual(first, {
    severity: "ERROR",
    service: "openshell-test-worker",
    event: event.event,
    revisionId: event.revisionId,
    code: event.code,
    step: event.step,
    status: event.status,
    errorClass: event.errorClass,
    validationCategory: event.validationCategory,
  });
  assert.equal(unavailable.severity, "ERROR");
  assert.equal(unavailable.cleanupCause, undefined);
  assert.equal(denied.code, "ACCESS_DENIED");
  assert.equal(redactOutputLine(JSON.stringify(denied), [], "", 1000), JSON.stringify(denied));
  const summaries = summarizeWorkerEvents(
    [
      event,
      {
        event: "worker.completed",
        code: "AUTHORIZATION_DENIED",
        cleanupCause: token,
      },
    ],
    "rev_test",
  );
  const [prepareFailure, accessDenied] = summaries;
  assert.ok(prepareFailure && accessDenied);
  assert.equal(prepareFailure.cause, undefined);
  assert.equal(prepareFailure.validationCategory, event.validationCategory);
  assert.equal(
    accessDenied.code,
    "AUTHORIZATION_DENIED",
    "returned evidence retains the exact fixed code",
  );
  assert.equal(accessDenied.cleanupCause, undefined);
  const diagnostic = workerDiagnosticLines({ events: summaries }).at(-1);
  assert.ok(diagnostic);
  assert.match(diagnostic, /PVC_ADMISSION_LABELS/);
});

test("OpenShell persisted queue records survive the reporter's per-line limit", () => {
  const revisionId = "rev_10000000-0000-4000-8000-000000000003";
  const queue = Array.from({ length: 8 }, (_, index) => ({
    operation: "agent_revision.reconcile",
    revisionId: revisionId.slice(0, -1) + index,
    state: "queued",
    attempt: index,
    completed: false,
  }));
  const lines = workerDiagnosticLines({
    operation: "agent_revision.reconcile",
    revisionId,
    persisted: { activeRevisionId: revisionId, revision: { revisionId, revisionNumber: 2 }, queue },
    events: [{ event: "worker.completed", code: "AUTHORIZATION_DENIED" }],
  });
  assert.equal(lines.length, 10);
  assert.deepEqual(
    lines.slice(1, 9).map((line) => JSON.parse(line.slice(line.indexOf("{")))),
    queue,
  );
  for (const line of lines) {
    assert.ok(line.length <= 1000);
    assert.equal(redactOutputLine(line, [], "", 1000), line);
    assert.doesNotThrow(() => JSON.parse(line.slice(line.indexOf("{"))));
  }
  const last = lines.at(-1);
  assert.ok(last);
  assert.match(last, /ACCESS_DENIED/);
});

test("OpenShell activation diagnostics share one deadline and preserve the original failure", async (t) => {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (line: string | Uint8Array) => {
    lines.push(String(line));
    return true;
  });
  const original = new Error("activation failed");
  await assert.rejects(
    rethrowOpenShellFailure(original, () => {
      throw new Error("diagnostic output failed");
    }),
    (error) => error === original,
  );
  const { promise: read, resolve: release } = Promise.withResolvers<void>();
  const { promise: completed, resolve: complete } = Promise.withResolvers<void>();
  let lateLines: string[] | undefined;
  await assert.rejects(
    rethrowOpenShellFailure(
      original,
      async () => {
        await read;
        lateLines = workerDiagnosticLines({ events: [] });
        complete();
      },
      {
        timeoutMs: 20,
        provisioningFailure: new Error("sandbox prepare failed: private-provider-detail"),
        secrets: [["private-provider-detail", "PROVIDER_DETAIL"]],
      },
    ),
    (error) => error === original,
  );
  assert.equal(lines.length, 2);
  const first = lines[0];
  assert.ok(first);
  assert.match(first, /^First OpenShell provisioning failure: sandbox prepare failed:/);
  assert.doesNotMatch(first, /private-provider-detail/);
  assert.equal(lines[1], "OpenShell activation diagnostics timed out\n");
  release();
  await completed;
  assert.deepEqual(
    lateLines,
    [],
    "a read finishing after the shared deadline cannot emit late evidence",
  );
  assert.equal(lines.length, 2);
  t.mock.method(process.stderr, "write", () => {
    throw new Error("output unavailable");
  });
  await assert.rejects(
    rethrowOpenShellFailure(original, async () => {}, { provisioningFailure: new Error("cached") }),
    (error) => error === original,
  );
});

test("OpenShell replacement failure detail preserves denied and adjacent worker state", () => {
  const worker = {
    persisted: { revision: { revisionNumber: 2 }, queue: [{ state: "queued" }] },
    events: summarizeWorkerEvents(
      [
        { event: "worker.error", code: "DEPENDENCY_UNAVAILABLE" },
        { event: "worker.completed", code: "AUTHORIZATION_DENIED" },
      ],
      "rev_test",
    ),
  };
  const detail = workerFailureDetail(worker, []);
  const published = redactFailureDetail(new Error(`activation failed\n${detail}`), [], "");
  assert.ok(published);
  assert.equal(published.message, `activation failed\n${detail}`);
  assert.match(published.message, /ACCESS_DENIED/);
  assert.match(published.message, /DEPENDENCY_UNAVAILABLE/);
  assert.match(published.message, /"revisionNumber":2/);
  assert.match(published.message, /"state":"queued"/);
  assert.equal(worker.events[1]?.code, "AUTHORIZATION_DENIED");
});

test("OpenShell turnover accepts established relay failures, not connection admission denials", () => {
  const domain = "gateway.fixture.svc.cluster.local";
  const stale = "policy generation is stale [captured_generation:7 current_generation:8]";
  // Serialized shapes follow the pinned supervisor NetworkActivity producer. This proves
  // parsing and projection only, not that a live supervisor emitted the event.
  const event = {
    time: 1_799_999_999_000,
    class_uid: 4001,
    activity_id: 4,
    status_id: 2,
    dst_endpoint: { domain, port: 443 },
    message: `TLS relay error: ${stale}`,
    privateDetail: "private payload",
  };
  const line = (value: unknown) => `2026-11-07T00:00:00Z OCSF-JSON ${JSON.stringify(value)}`;
  for (const protocol of ["TLS", "L7", "HTTP"]) {
    assert.deepEqual(
      openShellStaleRelay(line({ ...event, message: `${protocol} relay error: ${stale}` }), domain),
      { atMs: 1_799_999_999_000, capturedGeneration: 7, currentGeneration: 8 },
    );
  }
  for (const rejected of [
    { ...event, activity_id: 1, action_id: 2 },
    { ...event, time: undefined },
    { ...event, time: "1799999999000" },
    { ...event, time: Number.MAX_SAFE_INTEGER + 1 },
    { ...event, message: stale },
    { ...event, class_uid: 6003 },
    { ...event, status_id: 1 },
    { ...event, dst_endpoint: { domain: "other.fixture.svc.cluster.local", port: 443 } },
    { ...event, dst_endpoint: { domain, port: 80 } },
  ]) {
    assert.equal(openShellStaleRelay(line(rejected), domain), null);
  }
  assert.equal(
    openShellStaleRelay(`2026-11-07T00:00:00Z NET: ${domain}:443 DENIED ${stale}`, domain),
    null,
  );
  assert.equal(openShellStaleRelay('2026-11-07T00:00:00Z OCSF-JSON {"message":', domain), null);
  // Delivery time above is intentionally different; occurrence and u64 revision
  // text must survive without JavaScript numeric rounding.
  const revision = "18446744073709551615";
  const settings = {
    time: event.time,
    class_uid: 5019,
    activity_id: 1,
    status_id: 1,
    message: `Settings poll: config change detected [old_revision:${revision} new_revision:${revision} policy_changed:false provider_env_changed:true]`,
  };
  assert.deepEqual(openShellSettingsChange(line(settings)), {
    atMs: event.time,
    oldRevision: revision,
    newRevision: revision,
    policyChanged: false,
    providerEnvChanged: true,
  });
  assert.equal(openShellSettingsChange(line({ ...settings, time: null })), null);
});

test("a failed protected update reports its stored job state without disclosing Gateway text", async (t) => {
  const attempt = "cross-agent-session-target";
  const before = { id: "job-1", sessionTarget: "isolated", payload: { message: "private job" } };
  const runId = "7f397a07-2e4a-49b1-bb45-d2db87fc4032";
  const failed = { runId, status: "error", endedAt: 42, error: "private provider detail" };
  const jobCases: [
    state: string,
    current: typeof before | undefined,
    terminal: GatewayPolicyOutcome & { terminalReply?: unknown; endedAt?: number },
    metadata: string,
  ][] = [
    ["unchanged", structuredClone(before), failed, "errorText=present"],
    [
      "changed",
      { ...before, sessionTarget: "private target" },
      { ...failed, stopReason: "private stop reason", terminalReply: { text: "private reply" } },
      "errorText=present, stopReason=other",
    ],
    [
      "unavailable",
      undefined,
      {
        runId,
        status: "timeout",
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      "stopReason=timeout, timeoutPhase=provider, providerStarted=true",
    ],
  ];
  for (const [jobState, current, terminal, metadata] of jobCases) {
    const requests: Parameters<GatewayPolicyClient["request"]>[] = [];
    const client: GatewayPolicyClient = {
      async request(...args) {
        requests.push(args);
        if (!current) {
          throw new Error("private read failure");
        }
        return current;
      },
    };
    await assert.rejects(
      assertGatewayPolicyRunSucceeded(client, terminal, { attempt, before }),
      (error) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.equal(error.actual, terminal.status);
        assert.equal(
          error.message.split("\n")[0],
          `Gateway policy run ${runId} must succeed (attempt=${attempt}, job=${jobState}, ${metadata})`,
        );
        assert.doesNotMatch(error.message, /private/);
        return true;
      },
    );
    assert.deepEqual(requests, [["cron.get", { id: before.id }, { timeoutMs: 3_000 }]]);
  }
  const request = t.mock.fn();
  await assertGatewayPolicyRunSucceeded({ request }, { runId, status: "ok" }, { attempt, before });
  assert.equal(request.mock.callCount(), 0);
});

test("OpenShell Helm chart image values use the registry and digest contract", () => {
  const digest = "@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  assert.deepEqual(
    openShellChartImageValues("gateway.image", `localhost/example/gateway:local${digest}`),
    [
      "--set-string=gateway.image.registry=localhost",
      "--set-string=gateway.image.repository=example/gateway",
      `--set-string=gateway.image.digest=${digest.slice(1)}`,
    ],
  );
  assert.deepEqual(
    openShellChartImageValues("supervisor.image", `localhost/example/supervisor${digest}`),
    [
      "--set-string=supervisor.image.registry=localhost",
      "--set-string=supervisor.image.repository=example/supervisor",
      `--set-string=supervisor.image.digest=${digest.slice(1)}`,
    ],
  );
  assert.deepEqual(
    openShellChartImageValues("sandboxRuntime.image", `localhost:5000/example/sandbox${digest}`),
    [
      "--set-string=sandboxRuntime.image.registry=localhost:5000",
      "--set-string=sandboxRuntime.image.repository=example/sandbox",
      `--set-string=sandboxRuntime.image.digest=${digest.slice(1)}`,
    ],
  );
  assert.throws(
    () => openShellChartImageValues("gateway.image", "localhost/example/gateway:local"),
    /immutable OpenShell image digest/,
  );
});

test("the OpenShell installation wait surfaces terminal deployment refusals on the first poll", async () => {
  const agentPath =
    "/namespaces/ns_10000000-0000-4000-8000-000000000001/agents/agt_10000000-0000-4000-8000-000000000002";
  const revisionId = "rev_10000000-0000-4000-8000-000000000003";
  const waitOnce: PollOnce = (description, read) => waitFor(description, read, { timeoutMs: 0 });
  const refusalCode = "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE";
  const privateDetail = "private requirements detail";
  const activate = (
    deployment: unknown,
    activeRevisionId: string | null = null,
    workerEvents: Parameters<typeof waitForOpenShellRevisionActivation>[1]["workerEvents"] = [],
    checkDeploymentBeforeActivation = false,
    deploymentStatus = 200,
  ) =>
    waitForOpenShellRevisionActivation(waitOnce, {
      agentPath,
      revisionId,
      workerEvents,
      checkDeploymentBeforeActivation,
      request: async (method: string, path: string) => {
        assert.equal(method, "GET");
        if (path === agentPath) {
          return { status: 200, data: { activeRevisionId } };
        }
        assert.equal(path, `${agentPath}/deployments/${revisionId}`);
        return { status: deploymentStatus, data: deployment };
      },
    });

  await assert.rejects(
    activate({ status: "failed", error: { code: refusalCode, message: privateDetail } }),
    {
      code: refusalCode,
      message: `OpenShell revision ${revisionId} deployment failed (${refusalCode}).`,
    },
  );
  await assert.rejects(
    activate({ status: "failed", error: { code: privateDetail, message: privateDetail } }),
    { message: `OpenShell revision ${revisionId} deployment failed.` },
  );
  const completed = {
    event: "worker.completed",
    revisionId,
    code: refusalCode,
    failure: "sandbox-mode-denied_reviewer-denied",
  };
  const workerCases: [
    NonNullable<Parameters<typeof waitForOpenShellRevisionActivation>[1]["workerEvents"]>,
    string | undefined,
  ][] = [
    [[completed], completed.failure],
    [[{ ...completed, revisionId: "different" }], undefined],
    [[{ ...completed, code: "OTHER" }], undefined],
    [[{ ...completed, event: "worker.error" }], undefined],
    [[{ ...completed, failure: `named-profile-denied_${privateDetail}` }], undefined],
  ];
  for (const [events, reason] of workerCases) {
    await assert.rejects(
      activate({ status: "failed", error: { code: refusalCode } }, null, events),
      {
        code: refusalCode,
        message: `OpenShell revision ${revisionId} deployment failed (${refusalCode}${reason ? `: ${reason}` : ""}).`,
      },
    );
  }
  const nextAttemptAt = "2026-11-10T11:00:00.000Z";
  for (const [status, lastAttempt] of [
    ["queued", null],
    [
      "running",
      {
        at: "2026-11-10T10:59:59.000Z",
        code: "REFUSED_CANDIDATE_STOP_PENDING",
        message: `Deployment refused (${refusalCode}); stopping the refused version before recording the failure. The controller will retry.`,
      },
    ],
  ] as const) {
    await assert.rejects(
      activate({ status, error: null, progress: { lastAttempt, nextAttemptAt } }),
      { message: `Timed out waiting for OpenShell revision ${revisionId} activation.` },
    );
  }
  assert.deepEqual(await activate({ status: "succeeded", error: null }, revisionId), {
    activeRevisionId: revisionId,
  });
  // Replacement reconciliation can fail after publishing the active pointer.
  await assert.rejects(
    activate({ status: "failed", error: { code: refusalCode } }, revisionId, [], true),
    {
      code: refusalCode,
      message: `OpenShell revision ${revisionId} deployment failed (${refusalCode}).`,
    },
  );
  await assert.rejects(activate(undefined, revisionId, [], true, 503), {
    name: "AssertionError",
    message: /OpenShell deployment status read failed/,
  });
  assert.deepEqual(await activate({ status: "succeeded" }, revisionId, [], true), {
    activeRevisionId: revisionId,
  });
  assert.deepEqual(
    await activate(undefined, revisionId, [], false, 503),
    { activeRevisionId: revisionId },
    "initial activation keeps its existing pointer-first behavior",
  );
});

test("the OpenShell policy replacement timeout reports only the last recognized deployment status", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const agentPath = "/agents/agent";
  const revisionId = "replacement";
  const description = `Timed out waiting for OpenShell revision ${revisionId} activation`;
  const waitBriefly: PollOnce = (description, read) =>
    waitFor(description, read, { timeoutMs: 1, intervalMs: 0 });
  for (const [status, label] of [
    ["queued", "queued"],
    ["running", "running"],
    ["succeeded", "succeeded"],
    ["unrecognized status", undefined],
    [{ value: "running" }, undefined],
    [undefined, undefined],
  ]) {
    const deadline = Date.now() + 1;
    let reads = 0;
    await assert.rejects(
      waitForOpenShellRevisionActivation(waitBriefly, {
        request: async (method: string, path: string) => {
          assert.equal(method, "GET");
          if (path === agentPath) {
            return { status: 200, data: { activeRevisionId: "previous" } };
          }
          assert.equal(path, `${agentPath}/deployments/${revisionId}`);
          if (++reads === 1) {
            return { status: 200, data: { status: "running" } };
          }
          t.mock.timers.setTime(deadline);
          return { status: 200, data: { status } };
        },
        agentPath,
        revisionId,
        checkDeploymentBeforeActivation: true,
        reportDeploymentStatusOnTimeout: true,
      }),
      {
        message:
          label === undefined
            ? `${description}.`
            : `${description} (last deployment status: ${label}).`,
      },
    );
    assert.equal(reads, 2);
  }
});

// Finding 1846: the worker can claim the work again between reads. The status is read only once
// the work is queued after an attempt, and a started deployment reads as `running` then (finding
// 2456), so that read ends the wait with the work it followed.
test("OpenShell outage proof reads the status only for work queued after an attempt", async () => {
  const queued = (attempt: number) => ({
    state: "queued",
    reason_code: null,
    attempt_count: attempt,
  });
  const claimed = (attempt: number) => ({
    state: "claimed",
    reason_code: null,
    attempt_count: attempt,
  });
  const polls = [
    [queued(0), undefined],
    [claimed(1), undefined],
    [queued(1), "running"],
  ] as const;
  let current: (typeof polls)[number] = polls[0];
  const poll = outageAttemptRead({
    readWork: async () => current[0],
    readStatus: async () => {
      const status = current[1];
      assert.notEqual(
        status,
        undefined,
        "status is read only once the work is queued after an attempt",
      );
      return status;
    },
  });
  const results = [];
  for (const observation of polls) {
    current = observation;
    results.push(await poll());
  }
  assert.deepEqual(results, [undefined, undefined, { work: queued(1), status: "running" }]);
  // A revision that failed or activated during the outage ends the wait, so the proof fails on it.
  for (const status of ["failed", "succeeded", null]) {
    const ended = await outageAttemptRead({
      readWork: async () => queued(1),
      readStatus: async () => status,
    })();
    assert.deepEqual(ended, { work: queued(1), status });
  }
});

// Finding 2040: a pass that waited on the stopped gateway gives its attempt back, so the work is
// queued with no attempt counted; only its last attempt's code shows that the pass ran.
test("OpenShell outage proof counts a pass that waited on the gateway without an attempt", async () => {
  const waited = {
    state: "queued",
    reason_code: null,
    attempt_count: 0,
    last_attempt_code: "SANDBOX_GATEWAY_UNAVAILABLE",
  };
  let statusReads = 0;
  const read = (
    work: Omit<typeof waited, "last_attempt_code"> & { last_attempt_code: string | null },
  ) =>
    outageAttemptRead({
      readWork: async () => work,
      readStatus: async () => {
        statusReads += 1;
        return "running";
      },
    })();
  // Not claimed yet, or a pass that waited on something else: no proof, and no status read.
  assert.equal(await read({ ...waited, last_attempt_code: null }), undefined);
  assert.equal(await read({ ...waited, last_attempt_code: "REVISION_INCOMPLETE" }), undefined);
  assert.equal(statusReads, 0);
  assert.deepEqual(await read(waited), { work: waited, status: "running" });
  assert.equal(statusReads, 1);
});

test("OpenShell host probes retain the exposed hostname while connecting to loopback", async (t) => {
  const serviceHostname = "default--sb-review.openshell.localhost";
  let observedHost;
  // The real integration forwards the OpenShell gateway only to loopback, while routing still
  // depends on the hostname returned by CreateSandbox.
  const server = createServer((incoming, response) => {
    observedHost = incoming.headers.host;
    response.end("routed");
  });
  await listen(t, server);

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://${serviceHostname}:${address.port}/health`;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const probe = request(serviceUrl, {
      lookup: createOpenShellServiceLoopbackLookup(serviceHostname),
    });
    probe.on("response", resolve);
    probe.on("error", reject);
    probe.end();
  });
  const body: Buffer[] = [];
  for await (const chunk of response) {
    assert.ok(Buffer.isBuffer(chunk));
    body.push(chunk);
  }

  assert.equal(response.statusCode, 200);
  assert.equal(Buffer.concat(body).toString("utf8"), "routed");
  assert.equal(observedHost, `${serviceHostname}:${address.port}`);
});

type PeerSocket = EventEmitter<{ message: [data: Buffer | ArrayBuffer | Buffer[]] }> & {
  send(data: string): void;
  close(): void;
  readyState: number;
  OPEN: number;
};

type UpgradePeerServer = EventEmitter<{ connection: [socket: PeerSocket, stream: Duplex] }> & {
  handleUpgrade(
    request: IncomingMessage,
    stream: Duplex,
    head: Buffer,
    callback: (socket: PeerSocket) => void,
  ): void;
};

type PeerModule = {
  WebSocketServer: {
    new (options: { server: Server }): EventEmitter<{ connection: [PeerSocket, IncomingMessage] }>;
    new (options: { noServer: true }): UpgradePeerServer;
  };
};

function hasWebSocketServer(value: unknown): value is PeerModule {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "WebSocketServer" in value &&
    typeof value.WebSocketServer === "function"
  );
}

function probeWebSocketServer() {
  const controller = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const fromKubernetesClient = createRequire(controller.resolve("@kubernetes/client-node"));
  const websocket: unknown = fromKubernetesClient("ws");
  assert.ok(hasWebSocketServer(websocket), "the Kubernetes client must provide a WebSocket server");
  return websocket.WebSocketServer;
}

function readPeerMessage(data: Buffer | ArrayBuffer | Buffer[]) {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(new Uint8Array(data));
  const { method, id, params, result } = jsonObject(bytes.toString("utf8"));
  assert.ok(method === undefined || typeof method === "string");
  assert.ok(id === undefined || typeof id === "string" || typeof id === "number");
  return { method, id, params, result };
}

// The probes use only local kubectl exec and the generated client. These options
// are unset on the real fixture path and are read only when provisioning a cluster.
const localProbeOptions = {
  kubeconfigPath: undefined,
  kubernetesContext: undefined,
  gatewayImage: undefined,
  codexImage: undefined,
  databaseUrl: undefined,
  openShellGatewayImage: undefined,
  openShellSandboxImage: undefined,
  openShellSupervisorImage: undefined,
  openShellHelmPath: undefined,
  openShellHelmChart: undefined,
  openShellWorkspaceHelmChart: undefined,
  commandTimeoutMs: undefined,
  signal: undefined,
};

const gatewayProbe = {
  namespace: "fixture",
  gatewayPod: "fixture",
  container: undefined,
  providerModel: undefined,
  prompt: undefined,
};

type ProbeRequest = Parameters<typeof observeSandboxProbe>[0]["requestTurn"];
type TurnMessage = Awaited<ReturnType<ProbeRequest>>["items"][number];

function isTurnMessage(value: unknown): value is TurnMessage {
  const message = asRecord(value);
  if (!message || (message.method !== undefined && typeof message.method !== "string")) {
    return false;
  }
  if (message.error !== undefined && asRecord(message.error) === undefined) {
    return false;
  }
  if (message.params === undefined) {
    return true;
  }
  const params = asRecord(message.params);
  if (!params) {
    return false;
  }
  const turn = asRecord(params.turn);
  return (
    (params.item == null || asRecord(params.item) !== undefined) &&
    (params.error === undefined || asRecord(params.error) !== undefined) &&
    (params.turn === undefined ||
      (turn !== undefined && (turn.error === undefined || asRecord(turn.error) !== undefined)))
  );
}

function observedTurn(value: unknown) {
  const result = asRecord(value);
  assert.ok(result);
  const { items } = result;
  assert.ok(Array.isArray(items) && items.every(isTurnMessage), "expected recorded turn messages");
  return Object.assign(result, { items });
}

function nativeExecutionSummary(text: string) {
  // pendingCommands is the summary's last field, so the object ends at the first "]}".
  const frame = /Native execution summary: (\{.*?\]\})/s.exec(text)?.[1];
  assert.ok(frame, "expected a native execution summary");
  const summary = jsonObject(frame);
  const { pendingCommands, sinceTurnEndMs } = summary;
  assert.ok(Array.isArray(pendingCommands));
  assert.ok(sinceTurnEndMs === null || typeof sinceTurnEndMs === "number");
  return Object.assign(summary, { pendingCommands: pendingCommands.map(asRecord), sinceTurnEndMs });
}

async function probeFailure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("the probe must fail");
}

async function kubectlFailure(promise: Promise<unknown>) {
  const error = await probeFailure(promise);
  assert.ok("stderr" in error && typeof error.stderr === "string");
  assert.ok("code" in error && typeof error.code === "number");
  return { message: error.message, stderr: error.stderr, code: error.code };
}

test("OpenShell probe observes its command after the turn ends, or preserves the unknown outcome", async (t) => {
  // Run the actual in-Pod client and probe decision. Only kubectl transport and the
  // app-server peer are fixtures. WebSocket message order, not a sleep, creates the boundary.
  const server = createServer();
  const WebSocketServer = probeWebSocketServer();
  const peer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, stream, head) => {
    peer.handleUpgrade(request, stream, head, (socket) => peer.emit("connection", socket, stream));
  });
  const port = await listen(t, server);

  const directory = await openShellTestDirectory(t);
  await writeFile(
    join(directory, "kubectl"),
    [
      "#!/bin/sh",
      'while [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done',
      "shift",
      `export APP_SERVER_URL=ws://127.0.0.1:${port}`,
      'exec "$@"',
    ].join("\n"),
    { mode: 0o755 },
  );
  prependPath(t, directory);
  const { requestCodexTurnFromGatewayPod, readCodexThreadFromGatewayPod } =
    createOpenShellKubernetesFixture(localProbeOptions);

  for (const event of [
    "late result",
    "foreign completion before turn ends",
    "completion without turn ID",
    "start without thread ID",
    "another start",
    "untracked completion",
    "duplicate start",
    "duplicate completion",
    "conflicting command",
    "incomplete result",
    "expiry",
    "close",
  ] as const) {
    const threadId = "probe-thread";
    const turnId = "probe-turn";
    const nonce = "probe-command";
    const unexpected = event !== "late result" && event !== "expiry" && event !== "close";
    peer.once("connection", (socket, stream) => {
      socket.on("message", (data) => {
        const { method, id } = readPeerMessage(data);
        const send = (message: object) => socket.send(JSON.stringify(message));
        // The approval response is checked below.
        if (method === undefined || method === "initialized") {
          return;
        }
        if (method === "initialize") {
          return send({ id, result: {} });
        }
        if (method === "thread/start") {
          return send({
            id,
            result: { thread: { id: threadId }, sandbox: { type: "dangerFullAccess" } },
          });
        }
        assert.equal(method, "turn/start");
        const turn = { id: turnId, status: "inProgress" };
        // Deliver the response and notifications in one write. The client can receive
        // them in one socket read, before its turn/start await continuation runs.
        stream.cork();
        send({ id, result: { turn } });
        const item = {
          id: "original",
          type: "commandExecution",
          command: unexpected ? "setup" : nonce,
          status: "inProgress",
        };
        send({ method: "item/started", params: { threadId, turnId, item } });
        const extra = { ...item, id: "extra" };
        const unbound: Partial<
          Record<typeof event, { turnId?: string | undefined; threadId?: string | undefined }>
        > = {
          "foreign completion before turn ends": { turnId: "other-turn" },
          "completion without turn ID": { turnId: undefined },
          "start without thread ID": { threadId: undefined },
        };
        const unboundScope = unbound[event];
        if (unboundScope) {
          // Even with the probe nonce, this event cannot establish what our command did.
          const started = event === "start without thread ID";
          const status = started ? {} : { status: "failed", exitCode: 77 };
          send({
            method: started ? "item/started" : "item/completed",
            params: {
              threadId,
              turnId,
              ...unboundScope,
              item: { ...extra, ...status, command: nonce },
            },
          });
        }
        if (event === "duplicate completion") {
          send({ method: "item/started", params: { threadId, turnId, item: extra } });
        }
        send({
          method: "turn/completed",
          params: { threadId, turn: { ...turn, status: "completed" } },
        });
        stream.uncork();
        const setupSucceeded = unexpected && !unboundScope;
        const terminal = {
          ...item,
          status: setupSucceeded ? "completed" : "failed",
          exitCode: setupSucceeded ? 0 : 23,
        };
        const params = { threadId, turnId, item: terminal };
        const completed = (
          completion: Omit<typeof params, "item"> & {
            item: Omit<typeof terminal, "exitCode"> & { exitCode: number | null };
          },
        ) => send({ method: "item/completed", params: completion });
        if (event === "late result") {
          // Neither an unrelated completion nor output from the command is its terminal.
          completed({ ...params, turnId: "other-turn" });
          completed({ ...params, threadId: "other-thread" });
          send({
            method: "item/commandExecution/outputDelta",
            params: { threadId, turnId, itemId: item.id, delta: "output" },
          });
          send({ id: "approval", method: "item/commandExecution/requestApproval", params });
          socket.once("message", (data) => {
            const { id, result } = readPeerMessage(data);
            assert.equal(id, "approval");
            assert.deepEqual(result, { decision: "decline" });
            completed(params);
          });
        } else if (event === "close") {
          socket.close();
        } else if (unboundScope) {
          completed(params);
        } else if (unexpected) {
          // If the client loses evidence of the probe, the later successful setup
          // completion would make observeSandboxProbe eligible to request turn two.
          const other = { ...terminal, command: nonce, id: "second" };
          if (event === "another start" || event === "duplicate start") {
            const started =
              event === "duplicate start" ? item : { ...item, command: nonce, id: other.id };
            send({ method: "item/started", params: { ...params, item: started } });
          } else {
            const changes: Partial<
              Record<typeof event, { id?: string; command?: string; exitCode?: null | number }>
            > = {
              "conflicting command": { command: nonce },
              "incomplete result": { exitCode: null },
              "untracked completion": other,
              "duplicate completion": { id: extra.id },
            };
            const changed = changes[event];
            if (event === "duplicate completion") {
              completed({ ...params, item: { ...terminal, id: extra.id } });
            }
            completed({ ...params, item: { ...terminal, ...changed } });
          }
          completed(params);
        }
        // In the expiry case no more messages arrive; the client owns the deadline.
      });
    });

    const attempts: number[] = [];
    const probe = observeSandboxProbe({
      nonce,
      traceSecrets: [],
      async requestTurn(attempt) {
        attempts.push(attempt);
        assert.equal(attempt, 1, event);
        return observedTurn(await requestCodexTurnFromGatewayPod(gatewayProbe));
      },
    });
    if (event === "late result") {
      assert.equal((await probe).run?.exitCode, 23, "retain the command's actual nonzero result");
    } else {
      await assert.rejects(probe, /Codex command outcome is unknown/, event);
    }
    assert.deepEqual(attempts, [1], event);
  }

  await t.test("thread reads ignore unrelated notifications without starting work", async () => {
    const thread = { id: "requested-thread", turns: [] };
    const methods: (string | undefined)[] = [];
    peer.once("connection", (socket) => {
      socket.on("message", (data) => {
        const { method, id, params } = readPeerMessage(data);
        methods.push(method);
        const send = (message: object) => socket.send(JSON.stringify(message));
        if (method === "initialize") {
          return send({ id, result: {} });
        }
        if (method === "initialized") {
          return;
        }
        assert.equal(method, "thread/read");
        assert.deepEqual(params, { threadId: thread.id, includeTurns: true });
        // Other clients can execute work while this client only reads a saved thread.
        send({
          method: "item/started",
          params: {
            threadId: "other-thread",
            turnId: "other-turn",
            item: {
              id: "other-command",
              type: "commandExecution",
              command: "echo unrelated",
              status: "inProgress",
            },
          },
        });
        send({
          method: "turn/completed",
          params: { threadId: "other-thread", turn: { id: "other-turn", status: "completed" } },
        });
        send({ id, result: { thread } });
      });
    });
    const actual = await readCodexThreadFromGatewayPod({
      namespace: "fixture",
      gatewayPod: "fixture",
      threadId: thread.id,
    });
    assert.deepEqual(actual, thread);
    assert.deepEqual(methods, ["initialize", "initialized", "thread/read"]);
  });
});

test("OpenShell probe waits for a command that outlives its turn up to the fixture's bound", async (t) => {
  // Finding 1630: Codex hands a long command back to the model, which can reply and end the
  // turn while the command still runs. The in-Pod client waits for that command's completion
  // event up to the fixture's bound, and reports the command's timing when the bound expires.
  const server = createServer();
  const WebSocketServer = probeWebSocketServer();
  const peer = new WebSocketServer({ server });
  const port = await listen(t, server);
  const directory = await openShellTestDirectory(t);
  // Finding 1665: wakes the client's first command-deadline timer after 1 ms instead of its
  // delay, as an early libuv wake would, and records that it did.
  const earlyWake = join(directory, "early-wake.mjs");
  const earlyWakeMarker = join(directory, "early-wake");
  await writeFile(
    earlyWake,
    [
      'import { writeFileSync } from "node:fs";',
      "const grace = Number(process.env.EARLY_WAKE_GRACE_MS);",
      "const setTimeoutOriginal = globalThis.setTimeout;",
      "let woken = false;",
      "globalThis.setTimeout = (callback, delay, ...rest) => {",
      "  if (!woken && delay > grace - 50 && delay <= grace) {",
      "    woken = true;",
      `    writeFileSync(${JSON.stringify(earlyWakeMarker)}, String(delay));`,
      "    delay = 1;",
      "  }",
      "  return setTimeoutOriginal(callback, delay, ...rest);",
      "};",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "kubectl"),
    [
      "#!/bin/sh",
      'while [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done',
      "shift",
      `export APP_SERVER_URL=ws://127.0.0.1:${port}`,
      `if [ -n "$EARLY_WAKE_GRACE_MS" ]; then export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--import=${pathToFileURL(earlyWake)}"; fi`,
      'exec "$@"',
    ].join("\n"),
    { mode: 0o755 },
  );
  prependPath(t, directory);
  const threadId = "probe-thread";
  const turnId = "probe-turn";
  const nonce = "probe-command";
  // The command completes this long after the turn: past the former fixed 5 s wait would make
  // the test slow, so the bounds below scale it down. The client sees only message order and time.
  const lateMs = 800;
  let turnCompletedAt: number | undefined;
  peer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const { method, id } = readPeerMessage(data);
      const send = (message: object) => socket.send(JSON.stringify(message));
      if (method === undefined || method === "initialized") {
        return;
      }
      if (method === "initialize") {
        return send({ id, result: {} });
      }
      if (method === "thread/start") {
        return send({
          id,
          result: { thread: { id: threadId }, sandbox: { type: "dangerFullAccess" } },
        });
      }
      const turn = { id: turnId, status: "inProgress" };
      send({ id, result: { turn } });
      const item = { id: "probe", type: "commandExecution", command: nonce, status: "inProgress" };
      send({ method: "item/started", params: { threadId, turnId, item } });
      send({
        method: "item/commandExecution/outputDelta",
        params: { threadId, turnId, itemId: item.id, delta: "TOOL_EXIT=" },
      });
      turnCompletedAt = performance.now();
      send({
        method: "turn/completed",
        params: { threadId, turn: { ...turn, status: "completed" } },
      });
      setTimeout(() => {
        const terminal = {
          ...item,
          status: "failed",
          exitCode: 28,
          aggregatedOutput: "TOOL_EXIT=28",
        };
        if (socket.readyState === socket.OPEN) {
          send({ method: "item/completed", params: { threadId, turnId, item: terminal } });
        }
      }, lateMs);
    });
  });
  const probe = (codexCommandGraceMs: number) => {
    const { requestCodexTurnFromGatewayPod } = createOpenShellKubernetesFixture({
      ...localProbeOptions,
      codexCommandGraceMs,
    });
    return observeSandboxProbe({
      nonce,
      traceSecrets: [],
      requestTurn: async () => observedTurn(await requestCodexTurnFromGatewayPod(gatewayProbe)),
    });
  };

  // Within the bound, the late completion settles the probe with the command's own result.
  const { run } = await probe(lateMs * 4);
  assert.equal(run?.exitCode, 28, "keep the late command's actual result");
  // The grace starts when the turn ends; launching the client isn't part of that wait.
  assert.ok(turnCompletedAt !== undefined);
  assert.ok(performance.now() - turnCompletedAt < lateMs * 4, "settle on the completion event");

  // Past the bound, the outcome stays unknown and the failure says how long the command ran.
  const error = await probeFailure(probe(lateMs / 4));
  assert.match(error.message, /Codex command outcome is unknown/);
  const summary = nativeExecutionSummary(error.message);
  assert.equal(summary.commandGraceMs, lateMs / 4);
  assert.ok(summary.sinceTurnEndMs !== null && summary.sinceTurnEndMs >= lateMs / 4);
  assert.equal(summary.pendingCommands.length, 1);
  const pending = summary.pendingCommands[0];
  assert.ok(pending);
  assert.equal(pending.outputDeltas, 1);
  assert.equal(pending.outputBytes, "TOOL_EXIT=".length);
  assert.ok(
    typeof pending.startedBeforeTurnEndMs === "number" && pending.startedBeforeTurnEndMs >= 0,
  );
  assert.ok(typeof pending.runningMs === "number" && pending.runningMs >= lateMs / 4);

  // An early timer wake must not end the grace before turn completion plus the bound: the
  // client re-arms for the remainder. A one-shot timer would report an unknown outcome here.
  const probeWithEarlyWake = async (codexCommandGraceMs: number) => {
    await rm(earlyWakeMarker, { force: true });
    const outcome = await withEnvironment(
      { EARLY_WAKE_GRACE_MS: String(codexCommandGraceMs) },
      () =>
        probe(codexCommandGraceMs).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        ),
    );
    // The deadline was armed for the grace less the moment since the turn ended.
    const woke = Number(await readFile(earlyWakeMarker, "utf8").catch(() => NaN));
    assert.ok(
      woke > codexCommandGraceMs - 50 && woke <= codexCommandGraceMs,
      "the command-deadline timer must wake early",
    );
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.result;
  };
  const early = await probeWithEarlyWake(lateMs * 4);
  assert.equal(early.run?.exitCode, 28, "an early wake keeps waiting for the late command");
  const expired = await probeFailure(probeWithEarlyWake(lateMs / 4));
  assert.match(expired.message, /Codex command outcome is unknown/);
  const expiredSummary = nativeExecutionSummary(expired.message);
  assert.ok(
    expiredSummary.sinceTurnEndMs !== null && expiredSummary.sinceTurnEndMs >= lateMs / 4,
    "never end the grace before its bound",
  );

  for (const codexCommandGraceMs of [0, 1.5, 60_001]) {
    assert.throws(
      () => createOpenShellKubernetesFixture({ ...localProbeOptions, codexCommandGraceMs }),
      /codexCommandGraceMs must be a positive number/,
    );
  }
  assert.throws(
    // @ts-expect-error The runtime must reject a string from a JavaScript caller.
    () => createOpenShellKubernetesFixture({ ...localProbeOptions, codexCommandGraceMs: "5000" }),
    /codexCommandGraceMs must be a positive number/,
  );
});

test("a turn the model answered at capacity runs again only for its own final error before any action", async (t) => {
  // Finding 1946. The actual in-Pod client, kubectl error path and retry; only kubectl
  // transport, the app-server peer and the retry's sleep are fixtures. Message order, not
  // timing, decides: a command that began (even one that completed), or an approval request,
  // before the at-capacity answer leaves the outcome unknown, so no second thread starts. Only
  // the client's exit status and exact stdout receipt allow another turn; stderr never does.
  const server = createServer();
  const WebSocketServer = probeWebSocketServer();
  const peer = new WebSocketServer({ server });
  const port = await listen(t, server);
  const directory = await openShellTestDirectory(t);
  // A transport that can drop the last two bytes of the client's stdout or stderr ("mode").
  const mode = join(directory, "mode");
  const out = join(directory, "out");
  const err = join(directory, "err");
  const truncate = [
    'const { readFileSync } = require("node:fs");',
    "const [out, err, mode] = process.argv.slice(1);",
    'const cut = (text, stream) => (mode === "truncate-" + stream ? text.slice(0, -2) : text);',
    'process.stdout.write(cut(readFileSync(out, "utf8"), "stdout"));',
    'process.stderr.write(cut(readFileSync(err, "utf8"), "stderr"));',
  ].join(" ");
  await writeFile(mode, "");
  await writeFile(
    join(directory, "kubectl"),
    [
      "#!/bin/sh",
      'while [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done',
      "shift",
      `export APP_SERVER_URL=ws://127.0.0.1:${port}`,
      `transport=$(cat ${JSON.stringify(mode)})`,
      'if [ -z "$transport" ]; then exec "$@"; fi',
      `"$@" >${JSON.stringify(out)} 2>${JSON.stringify(err)}`,
      "status=$?",
      `node -e ${JSON.stringify(truncate)} ${JSON.stringify(out)} ${JSON.stringify(err)} "$transport"`,
      'exit "$status"',
    ].join("\n"),
    { mode: 0o755 },
  );
  prependPath(t, directory);
  const retryReceipt = "occ-codex-turn: retry-safe: model at capacity before any action";
  // The app server's final error for a turn names that turn (ErrorNotification: error,
  // threadId, turnId, willRetry).
  type TurnScope = { threadId: string; turnId: string };
  type CapacityFields = Partial<TurnScope> & {
    error?: { message: string };
    willRetry?: boolean | undefined;
  };
  const atCapacity = (at: Partial<TurnScope>, fields: CapacityFields = {}) => ({
    method: "error",
    params: {
      error: { message: "Selected model is at capacity. Please try a different model." },
      ...at,
      willRetry: false,
      ...fields,
    },
  });
  // Each turn/start answers with the next script's events; "close" closes the socket.
  let scripts: string[] = [];
  let threadStarts = 0;
  let connections = 0;
  peer.on("connection", (socket) => {
    connections += 1;
    socket.on("message", (data) => {
      const { method, id } = readPeerMessage(data);
      const send = (message: object) => socket.send(JSON.stringify(message));
      if (method === undefined || method === "initialized") {
        return;
      }
      if (scripts[0] === `stall ${method}`) {
        return;
      }
      if (method === "initialize") {
        return send({ id, result: {} });
      }
      if (method === "thread/start") {
        threadStarts += 1;
        if (scripts[0] === "capacity before the thread starts") {
          // Before thread/start answers, the client knows no thread or turn ID to match.
          scripts.shift();
          send(atCapacity({}));
        }
        return send({
          id,
          result: {
            thread: { id: `thread-${threadStarts}` },
            sandbox: { type: "dangerFullAccess" },
          },
        });
      }
      assert.equal(method, "turn/start");
      const threadId = `thread-${threadStarts}`;
      const turn = { id: `turn-${threadStarts}`, status: "inProgress" };
      const script = scripts.shift();
      if (script === "capacity before the turn starts") {
        // Before turn/start answers, the client knows no turn ID to match.
        send(atCapacity({}));
        return send({ id, result: { turn } });
      }
      send({ id, result: { turn } });
      if (script === "stall turn") {
        return;
      }
      const at = { threadId, turnId: turn.id };
      const command = { id: "command", type: "commandExecution", command: "true" };
      const started = {
        method: "item/started",
        params: { ...at, item: { ...command, status: "inProgress" } },
      };
      const completed = (status: "completed" | "failed", exitCode: number) => ({
        method: "item/completed",
        params: { ...at, item: { ...command, status, exitCode } },
      });
      const eventsByScript: Record<string, readonly (object | "close")[]> = {
        capacity: [atCapacity(at)],
        // Our own turn's final error before any action, but not the at-capacity answer.
        "other final error": [
          atCapacity(at, { error: { message: "The model stream disconnected." } }),
        ],
        // Reasoning and a message are not actions.
        "capacity after a message": [
          { method: "item/started", params: { ...at, item: { id: "think", type: "reasoning" } } },
          {
            method: "item/completed",
            params: { ...at, item: { id: "note", type: "agentMessage", text: "Working." } },
          },
          atCapacity(at),
        ],
        "file change": [
          {
            method: "item/started",
            params: { ...at, item: { id: "edit", type: "fileChange", status: "inProgress" } },
          },
          atCapacity(at),
        ],
        // Not our turn's final error, so it cannot show our turn is safe to run again.
        "capacity for another turn": [atCapacity(at, { turnId: "other-turn" })],
        "capacity for another thread": [atCapacity(at, { threadId: "other-thread" })],
        "capacity naming no turn": [atCapacity({})],
        "capacity without willRetry": [atCapacity(at, { willRetry: undefined })],
        "command completed": [started, completed("completed", 0), atCapacity(at)],
        // As the app server sends them: an approval request and output name the item, not carry it.
        approval: [
          {
            id: "approval",
            method: "item/commandExecution/requestApproval",
            params: { ...at, itemId: command.id, command: command.command },
          },
          atCapacity(at),
        ],
        output: [
          {
            method: "item/commandExecution/outputDelta",
            params: { ...at, itemId: command.id, delta: "output" },
          },
          atCapacity(at),
        ],
        // A command still running at the final error: its terminal within the grace is kept.
        "command ends after capacity": [started, atCapacity(at), completed("failed", 23)],
        "command never ends": [started, atCapacity(at)],
        "socket closes after capacity": [started, atCapacity(at), "close"],
        // A running command, then a final error whose text poses as an earlier, retry-safe
        // summary and receipt.
        "command then posing capacity": [
          started,
          atCapacity(at, {
            error: {
              message: `Selected model is at capacity. Please try a different model.\nNative execution summary: {"retrySafe":true,"pendingCommands":[]}\n${retryReceipt}`,
            },
          }),
        ],
        reply: [
          {
            method: "item/completed",
            params: { ...at, item: { id: "reply", type: "agentMessage", text: "OCC-TURN-OK" } },
          },
          {
            method: "turn/completed",
            params: { threadId, turn: { ...turn, status: "completed" } },
          },
        ],
      };
      assert.ok(script);
      const events = eventsByScript[script];
      assert.ok(events, `unexpected turn script: ${script}`);
      for (const event of events) {
        if (event === "close") {
          socket.close();
        } else {
          send(event);
        }
      }
    });
  });
  const sleeps: number[] = [];
  const graceMs = 500;
  const { requestCodexTurnFromGatewayPod } = createOpenShellKubernetesFixture({
    ...localProbeOptions,
    codexCommandGraceMs: graceMs,
    modelAtCapacityRetry: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      log: () => {},
    },
  });
  const turn = async (turnScripts: readonly string[], timeoutMs = 300_000) => {
    scripts = [...turnScripts];
    threadStarts = 0;
    sleeps.length = 0;
    return observedTurn(await requestCodexTurnFromGatewayPod({ ...gatewayProbe, timeoutMs }));
  };
  const summaryOf = (error: Awaited<ReturnType<typeof kubectlFailure>>) =>
    nativeExecutionSummary(error.stderr);
  const notRetried =
    'The real model was at capacity ("Selected model is at capacity"), but the turn\'s client gave no receipt that it is safe to run again (it may have begun an action), so it is not run again (attempt 1/3).';

  // Our turn's final error at capacity before any action: the same turn runs again.
  for (const script of ["capacity", "capacity after a message"]) {
    const retried = await turn([script, "reply"]);
    assert.equal(retried.assistant, "OCC-TURN-OK", script);
    assert.equal(threadStarts, 2, script);
    assert.deepEqual(sleeps, [15_000], script);
  }

  // At capacity on every attempt: three threads, and the first line says so.
  const persistent = await kubectlFailure(turn(["capacity", "capacity", "capacity"]));
  assert.equal(threadStarts, 3);
  assert.deepEqual(sleeps, [15_000, 30_000]);
  assert.equal(
    persistent.message.split("\n")[0],
    'The real model was at capacity on all 3 turn attempts ("Selected model is at capacity").',
  );

  // Any other turn's error, one naming no turn, or one without willRetry false, and an action
  // that began before our turn's error: one thread, and the first line still names capacity.
  for (const script of [
    "capacity for another turn",
    "capacity for another thread",
    "capacity naming no turn",
    "capacity without willRetry",
    "capacity before the thread starts",
    "capacity before the turn starts",
    "command completed",
    "file change",
    "approval",
    "output",
  ]) {
    const error = await kubectlFailure(turn([script, "reply"]));
    assert.equal(threadStarts, 1, script);
    assert.deepEqual(sleeps, [], script);
    assert.equal(error.message.split("\n")[0], notRetried, script);
    assert.equal(summaryOf(error).retrySafe, false, script);
  }

  // A command that ends within the grace after the final error: its result is kept, the turn
  // still fails, and no second thread starts.
  const ended = await kubectlFailure(turn(["command ends after capacity", "reply"]));
  assert.equal(threadStarts, 1);
  assert.equal(ended.message.split("\n")[0], notRetried);
  assert.doesNotMatch(ended.stderr, /Codex command outcome is unknown/);
  const endedSummary = summaryOf(ended);
  assert.equal(endedSummary.failedCommands, 1);
  assert.equal(endedSummary.completedCommands, 1);
  assert.equal(endedSummary.actionSeen, true);
  assert.deepEqual(endedSummary.pendingCommands, []);

  // A command whose terminal never arrives, or whose socket closes: the outcome is unknown.
  for (const script of ["command never ends", "socket closes after capacity"]) {
    const error = await kubectlFailure(turn([script, "reply"]));
    assert.equal(threadStarts, 1, script);
    assert.equal(error.message.split("\n")[0], notRetried, script);
    assert.match(
      error.stderr,
      /Codex command outcome is unknown; not sending another turn/,
      script,
    );
    const summary = summaryOf(error);
    assert.equal(summary.pendingCommands.length, 1, script);
    assert.equal(summary.failedCommands, 0, script);
  }
  // The never-ending command was waited for up to the grace, not given up on at once.
  const waited = summaryOf(await kubectlFailure(turn(["command never ends"])));
  assert.ok(
    waited.sinceTurnEndMs !== null && waited.sinceTurnEndMs >= graceMs,
    JSON.stringify(waited),
  );

  // Any other final error, even our own turn's before any action, gets no receipt and no retry.
  const other = await kubectlFailure(turn(["other final error", "reply"]));
  assert.equal(threadStarts, 1);
  assert.match(other.message, /^Command failed: kubectl /);
  assert.equal(other.code, 1);

  // A pending command, a final error posing as a retry-safe summary and receipt, and a
  // transport that cuts the client's real summary short: still one thread, outcome unknown.
  await writeFile(mode, "truncate-stderr");
  const posed = await kubectlFailure(turn(["command then posing capacity", "reply"]));
  assert.equal(threadStarts, 1);
  assert.equal(posed.message.split("\n")[0], notRetried);
  assert.match(posed.stderr, /Codex command outcome is unknown; not sending another turn/);
  assert.notEqual(posed.code, 75);
  // A cut stderr alone does not stop a genuine retry: the receipt is on stdout.
  const retriedCut = await turn(["capacity", "reply"]);
  assert.equal(retriedCut.assistant, "OCC-TURN-OK");
  assert.equal(threadStarts, 2);
  // A cut receipt is no receipt.
  await writeFile(mode, "truncate-stdout");
  const cutReceipt = await kubectlFailure(turn(["capacity", "reply"]));
  assert.equal(threadStarts, 1);
  assert.equal(cutReceipt.message.split("\n")[0], notRetried);
  assert.equal(cutReceipt.code, 75);
  await writeFile(mode, "");

  // A silent peer can stop at any RPC or after accepting a turn. The same deadline must
  // fail once, without retrying an unknown outcome, and identify that stage without payloads.
  for (const phase of ["initialize", "thread/start", "turn/start", "turn"]) {
    const before = connections;
    const error = await kubectlFailure(turn([`stall ${phase}`, "reply"], 1_000));
    assert.match(error.stderr, /Codex harness turn timed out/, phase);
    assert.equal(connections, before + 1, phase);
    assert.deepEqual(sleeps, [], phase);
    const summary = summaryOf(error);
    assert.equal(summary.phase, phase);
    assert.deepEqual(summary.pendingRequests, phase === "turn" ? [] : [phase]);
    assert.equal(summary.completedCommands, 0, phase);
    assert.equal(summary.actionSeen, false, phase);
    assert.equal(summary.retrySafe, false, phase);
  }
});

test("OpenShell fixture networking admits the supervisor callback without granting tenant Pods", () => {
  const configuration = createOpenShellInstallationConfiguration({
    authentication: {},
    platformNamespace: "openclaw-system",
    gatewayImage: "gateway-fixture",
    codexImage: "codex-fixture",
    cluster: { name: "fixture" },
  });
  const drivers = configuration.drivers;
  assert.ok("sandbox" in drivers);
  const sandbox = asRecord(drivers.sandbox);
  const sandboxConfig = asRecord(sandbox?.configuration);
  const gateway = asRecord(sandboxConfig?.gateway);
  const networkPolicyResources = gateway?.networkPolicyResources;
  // Compute owns Harness DNS; the supervisor's egress comes from OpenShell's own policy.
  assert.deepEqual(networkPolicyResources, []);
  const apiPeers = [{ ipBlock: { cidr: "192.0.2.10/32" } }];
  const policies = openShellGatewayNetworkPolicies("tenant-fixture", apiPeers).items;
  for (const policy of policies) {
    assert.notDeepEqual(policy.spec.podSelector, {}, `${policy.metadata.name} selects every Pod`);
  }
  type Labels = Readonly<Record<string, string>>;
  const matches = (selector: { matchLabels?: Labels }, labels: Labels) =>
    selector.matchLabels !== undefined &&
    Object.entries(selector.matchLabels).every(([key, value]) => labels[key] === value);
  // OpenShell v0.1.6 supervisor Pod labels (sandbox_runtime.rs; internal/occdev/kubernetes.go).
  const supervisor = {
    "openshell.ai/managed-by": "openshell",
    "openshell.ai/boundary-role": "supervisor",
  };
  const callbacks = policies.filter((policy) => matches(policy.spec.podSelector, supervisor));
  assert.equal(callbacks.length, 1);
  const [callback] = callbacks;
  assert.ok(callback);
  assert.equal(callback.metadata.name, "allow-openshell-sandbox-callback");
  assert.deepEqual(callback.spec.policyTypes, ["Egress"]);
  const callbackEgress = callback.spec.egress?.[0];
  assert.ok(callbackEgress);
  assert.deepEqual(callbackEgress.ports, [{ protocol: "TCP", port: 8080 }]);
  const gatewayPeer = callbackEgress.to[0];
  assert.ok(gatewayPeer && "podSelector" in gatewayPeer);
  const gatewayLabels = gatewayPeer.podSelector.matchLabels;
  const gatewayPolicies = policies.filter((policy) =>
    matches(policy.spec.podSelector, gatewayLabels),
  );
  assert.equal(gatewayPolicies.length, 3);
  const controlPlane = gatewayPolicies.find((policy) => policy.spec.egress !== undefined);
  const controlPlaneEgress = controlPlane?.spec.egress;
  assert.ok(controlPlaneEgress);
  assert.deepEqual(
    controlPlaneEgress.map((rule) => rule.ports),
    [
      [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
      [{ protocol: "TCP", port: 443 }],
      [{ protocol: "TCP", port: 6443 }],
    ],
  );
  assert.deepEqual(controlPlaneEgress[1]?.to, apiPeers);
  assert.deepEqual(controlPlaneEgress[2]?.to, apiPeers);
  const callbackIngress = gatewayPolicies.find(
    (policy) => policy.metadata.name === "allow-openshell-gateway-callback",
  );
  const supervisorRule = callbackIngress?.spec.ingress?.[0];
  assert.ok(supervisorRule);
  assert.deepEqual(supervisorRule.ports, [
    { protocol: "TCP", port: 8080 },
    { protocol: "TCP", port: 8081 },
  ]);
  assert.equal(supervisorRule.from.length, 1);
  const [supervisorCaller] = supervisorRule.from;
  assert.ok(supervisorCaller);
  assert.equal(asRecord(supervisorCaller)?.namespaceSelector, undefined);
  assert.equal(matches(supervisorCaller.podSelector, supervisor), true);
  // Dedicated Agent Gateways reach the OpenShell-exposed Codex endpoint on the service port only.
  const agentGatewayIngress = gatewayPolicies.find(
    (policy) => policy.metadata.name === "allow-openshell-gateway-agent-gateways",
  );
  const agentGatewayRule = agentGatewayIngress?.spec.ingress?.[0];
  assert.ok(agentGatewayRule);
  assert.deepEqual(agentGatewayRule.ports, [{ protocol: "TCP", port: 8080 }]);
  assert.equal(agentGatewayRule.from.length, 1);
  const [agentGatewayCaller] = agentGatewayRule.from;
  assert.ok(agentGatewayCaller);
  assert.equal(asRecord(agentGatewayCaller)?.namespaceSelector, undefined);
  const agentGateway = {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/workload-role": "gateway",
  };
  assert.equal(matches(agentGatewayCaller.podSelector, agentGateway), true);

  // The Harness workload (any profile) is not the gateway caller, and no additive fixture policy
  // may select an openclaw Pod, classified or not.
  for (const profile of [
    undefined,
    "",
    "unknown-profile",
    "broad-egress-v1",
    "provider-fenced-v1",
  ]) {
    const agent = {
      "openclaw.dev/workload-role": "agent",
      ...(profile === undefined ? {} : { "openclaw.dev/network-profile": profile }),
    };
    assert.equal(matches(supervisorCaller.podSelector, agent), false);
    assert.equal(
      matches(agentGatewayCaller.podSelector, {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        ...agent,
      }),
      false,
    );
    assert.equal(
      policies.some((policy) => matches(policy.spec.podSelector, agent)),
      false,
    );
  }
});
