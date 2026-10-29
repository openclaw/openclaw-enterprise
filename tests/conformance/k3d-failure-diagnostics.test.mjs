import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { failureSecrets } from "../../scripts/ci/failure-redaction.mjs";
import {
  codexTurnTrace,
  observeSandboxProbe,
  podFailureDiagnostic,
  tokenEchoDigest,
  tokenEchoReply,
} from "../helpers/k3d-failure-diagnostics.mjs";
import { commandCalls, prependPath, writeCommand } from "../helpers/fake-commands.mjs";
import { diagnosticRequestTimeout, withinDiagnosticDeadline } from "../helpers/kubernetes-real.mjs";
import { withHelmInstallDiagnostic } from "../helpers/production-helm-real.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

// Synthetic values only; none is a real credential.
const syntheticSecret = "synthetic-diagnostic-secret-0123456789";
const secrets = failureSecrets([{ SYNTHETIC_SECRET: syntheticSecret }]);

// A hook Job Pod like finding 1574's: the migration init container failed, so the main
// container never started, and the Pod did not become ready.
const hookPod = {
  metadata: {
    name: "obs-1234-initialization-abcde",
    creationTimestamp: "2026-10-16T18:15:02Z",
    labels: { "job-name": "obs-1234-initialization" },
  },
  status: {
    phase: "Failed",
    conditions: [
      { type: "Initialized", status: "False", reason: "ContainersNotInitialized" },
      { type: "PodScheduled", status: "True" },
    ],
    initContainerStatuses: [
      {
        name: "migration",
        ready: false,
        restartCount: 0,
        state: {
          terminated: {
            reason: "Error",
            exitCode: 1,
            message: `migration failed for postgresql://occ_migrator:${syntheticSecret}@postgres:5432/db`,
          },
        },
      },
    ],
    containerStatuses: [
      {
        name: "bootstrap",
        ready: false,
        restartCount: 0,
        state: { waiting: { reason: "PodInitializing" } },
      },
    ],
  },
};
const postgresPod = {
  metadata: { name: "postgres", creationTimestamp: "2026-10-16T18:14:30Z", labels: {} },
  status: {
    phase: "Running",
    conditions: [{ type: "Ready", status: "True" }],
    containerStatuses: [
      { name: "postgres", ready: true, restartCount: 0, state: { running: { startedAt: "x" } } },
    ],
  },
};
const events = [
  {
    lastTimestamp: "2026-10-16T18:15:10Z",
    type: "Warning",
    reason: "BackoffLimitExceeded",
    involvedObject: { kind: "Job", name: "obs-1234-initialization" },
    message: "Job has reached the specified backoff limit",
  },
  {
    lastTimestamp: "2026-10-16T18:14:31Z",
    type: "Normal",
    reason: "Pulled",
    count: 3,
    involvedObject: { kind: "Pod", name: "postgres" },
    message: "Container image already present on machine",
  },
  {
    eventTime: "2026-10-16T18:15:03Z",
    type: "Normal",
    reason: "Started",
    involvedObject: { kind: "Pod", name: "obs-1234-initialization-abcde" },
    message: `Started container migration with token ${syntheticSecret}`,
  },
];

function fakeKubectl({
  pods = [hookPod, postgresPod],
  events: items = events,
  logs = {},
  fail = {},
} = {}) {
  const calls = [];
  const kubectl = async (...args) => {
    calls.push(args);
    const [, verb, kindOrPod] = args;
    if (fail[verb] !== undefined) {
      throw new Error(fail[verb]);
    }
    if (verb === "get" && kindOrPod === "pods") {
      return JSON.stringify({ items: pods });
    }
    if (verb === "get" && kindOrPod === "events") {
      return JSON.stringify({ items });
    }
    if (verb === "logs") {
      const container = args[args.indexOf("--container") + 1];
      return logs[`${kindOrPod}/${container}`] ?? "";
    }
    throw new Error(`unexpected kubectl ${args.join(" ")}`);
  };
  return { kubectl, calls };
}

test("a failed hook Job's diagnostic shows Pod states, events and init container logs, redacted", async () => {
  const { kubectl, calls } = fakeKubectl({
    logs: {
      "obs-1234-initialization-abcde/migration": [
        "connecting to the database",
        `password=${syntheticSecret}`,
        "Authorization: Basic c3ludGhldGljOnN5bnRoZXRpYw==",
        // Only the credential-line rule hides this one: no value shape matches it.
        "retrying with authorization from synthetic-handle-42",
        "-----BEGIN PRIVATE KEY-----",
        "c3ludGhldGljIGtleSBib2R5",
        "-----END PRIVATE KEY-----",
        "error: relation occ.installations does not exist",
      ].join("\n"),
    },
  });
  const detail = await podFailureDiagnostic({
    kubectl,
    namespace: "oce-observe-1234",
    logLabels: { "job-name": "obs-1234-initialization" },
    secrets,
  });
  // Every read is bounded by the diagnostic request timeout.
  assert.ok(calls.every(([first]) => first === diagnosticRequestTimeout));
  assert.doesNotMatch(detail, new RegExp(syntheticSecret));
  assert.doesNotMatch(detail, /c3ludGhldGlj/);
  assert.doesNotMatch(detail, /synthetic-handle-42/);
  // The failed init container's reason, exit code and message, and the waiting main container.
  assert.match(detail, /"name":"migration".*"terminated":"Error","exitCode":1/);
  assert.match(detail, /"name":"bootstrap".*"waiting":"PodInitializing"/);
  assert.match(detail, /"unmet":\[\{"type":"Initialized","reason":"ContainersNotInitialized"\}\]/);
  assert.match(detail, /"name":"postgres","phase":"Running"/);
  // Events oldest first, with their repeat counts.
  const pulled = detail.indexOf("Pulled Pod/postgres x3");
  const backoff = detail.indexOf("BackoffLimitExceeded Job/obs-1234-initialization");
  assert.ok(pulled !== -1 && backoff > pulled, detail);
  // Only the started init container has logs; the main container never ran.
  const logReads = calls.filter(([, verb]) => verb === "logs");
  assert.deepEqual(
    logReads.map((args) => args[args.indexOf("--container") + 1]),
    ["migration"],
  );
  assert.match(detail, /Logs obs-1234-initialization-abcde\/migration:\n/);
  assert.match(detail, /error: relation occ.installations does not exist/);
  assert.match(detail, /\[redacted credential-bearing line\]/);
});

test("a rollout diagnostic reads only its Pods' events and no logs without log labels", async () => {
  const waiting = {
    metadata: { name: "writer-7d9-xyz", creationTimestamp: "2026-10-16T18:15:00Z", labels: {} },
    status: {
      phase: "Pending",
      conditions: [
        {
          type: "PodScheduled",
          status: "False",
          reason: "Unschedulable",
          message: "0/1 nodes are available: 1 Insufficient memory.",
        },
      ],
    },
  };
  const { kubectl, calls } = fakeKubectl({ pods: [waiting] });
  const detail = await podFailureDiagnostic({
    kubectl,
    namespace: "oce-tenant",
    selector: "app.kubernetes.io/name=writer",
    eventPrefix: "obs-1234-initialization",
    secrets,
  });
  assert.deepEqual(calls[0].slice(1), [
    "get",
    "pods",
    "--namespace",
    "oce-tenant",
    "--selector",
    "app.kubernetes.io/name=writer",
    "-o",
    "json",
  ]);
  assert.match(detail, /Pods in oce-tenant \(app.kubernetes.io\/name=writer\): /);
  assert.match(detail, /"reason":"Unschedulable","message":"0\/1 nodes are available/);
  assert.match(detail, /BackoffLimitExceeded/);
  assert.doesNotMatch(detail, /Pod\/postgres/);
  assert.equal(
    calls.some(([, verb]) => verb === "logs"),
    false,
  );
});

test("a restarted container that waits again has its previous run's logs read", async () => {
  const crashing = {
    metadata: {
      name: "obs-1234-initialization-fghij",
      creationTimestamp: "2026-10-16T18:16:00Z",
      labels: { "job-name": "obs-1234-initialization" },
    },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "bootstrap",
          ready: false,
          restartCount: 2,
          state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 20s" } },
          lastState: { terminated: { reason: "Error", exitCode: 2 } },
        },
      ],
    },
  };
  const { kubectl, calls } = fakeKubectl({
    pods: [crashing],
    logs: { "obs-1234-initialization-fghij/bootstrap": "bootstrap failed" },
  });
  const detail = await podFailureDiagnostic({
    kubectl,
    namespace: "oce-observe-1234",
    logLabels: { "job-name": "obs-1234-initialization" },
  });
  assert.match(
    detail,
    /"state":\{"waiting":"CrashLoopBackOff","message":"back-off 20s"\},"last":\{"terminated":"Error","exitCode":2\}/,
  );
  const logs = calls.find(([, verb]) => verb === "logs");
  assert.equal(logs.at(-1), "--previous");
  assert.match(
    detail,
    /Logs obs-1234-initialization-fghij\/bootstrap \(previous\):\nbootstrap failed/,
  );
});

test("newer Pods do not crowd the logged hook Pod out of the diagnostic", async () => {
  // A Helm --wait timeout: API and worker Pods, all newer than the hook Job's Pod.
  const newer = Array.from({ length: 6 }, (_, index) => ({
    metadata: {
      name: `obs-1234-api-${index}`,
      creationTimestamp: `2026-10-16T18:2${index}:00Z`,
      labels: {},
    },
    status: { phase: "Pending" },
  }));
  const { kubectl, calls } = fakeKubectl({
    pods: [hookPod, ...newer],
    logs: { "obs-1234-initialization-abcde/migration": "migration failed" },
  });
  const detail = await podFailureDiagnostic({
    kubectl,
    namespace: "oce-observe-1234",
    logLabels: { "job-name": "obs-1234-initialization" },
  });
  assert.match(detail, /"name":"obs-1234-initialization-abcde"/);
  assert.match(detail, /Logs obs-1234-initialization-abcde\/migration:\nmigration failed/);
  assert.equal(calls.filter(([, verb]) => verb === "logs").length, 1);
  // Five Pods are described: the hook Pod and the four newest others.
  assert.match(detail, /obs-1234-api-5/);
  assert.doesNotMatch(detail, /obs-1234-api-1"/);
});

test("an event or turn error that names a credential is dropped whole", async () => {
  const { kubectl } = fakeKubectl({ pods: [] });
  const leaky = async (...args) =>
    args[2] === "events"
      ? JSON.stringify({
          items: [
            {
              lastTimestamp: "2026-10-16T18:15:10Z",
              type: "Warning",
              reason: "Failed",
              involvedObject: { kind: "Pod", name: "p" },
              message: "pull failed with authorization synthetic-handle-77",
            },
          ],
        })
      : kubectl(...args);
  const detail = await podFailureDiagnostic({ kubectl: leaky, namespace: "oce-x" });
  assert.doesNotMatch(detail, /synthetic-handle-77/);
  assert.match(detail, /\[redacted credential-bearing line\]/);
  const trace = codexTurnTrace([
    {
      method: "error",
      params: { error: { message: "upstream echoed authorization synthetic-handle-78" } },
    },
  ]);
  assert.equal(trace, "error: [redacted credential-bearing line]");
});

test("Pod messages and failed reads suppress credential-bearing prose before clipping", async () => {
  // An upstream can name a credential the fixture does not know. Put the keyword past the
  // display limit as well: clipping first must not turn the start of that line into safe text.
  const opaque = "synthetic-opaque-handle";
  const message = `${opaque} ${"padding ".repeat(45)}authorization unavailable`;
  const { kubectl } = fakeKubectl({
    pods: [
      {
        ...hookPod,
        status: {
          conditions: [{ type: "Ready", status: "False", message }],
          initContainerStatuses: [
            { name: "init", state: { terminated: { exitCode: 1, message } } },
          ],
          containerStatuses: [{ name: "app", state: { waiting: { reason: "BackOff", message } } }],
        },
      },
    ],
    fail: { logs: message },
  });
  const detail = await podFailureDiagnostic({
    kubectl,
    namespace: "oce-observe-1234",
    logLabels: { "job-name": "obs-1234-initialization" },
  });
  assert.equal(
    detail.includes(opaque),
    false,
    "do not copy any part of a credential-bearing message",
  );
  assert.equal(detail.split("[redacted credential-bearing line]").length - 1, 4);
  assert.match(detail, /"exitCode":1/);
  assert.match(detail, /"waiting":"BackOff"/);
});

test("a failed read leaves a redacted note and the other sections", async () => {
  const { kubectl } = fakeKubectl({
    fail: { logs: `Error from server: dial tcp: token ${syntheticSecret}` },
  });
  const detail = await podFailureDiagnostic({
    kubectl,
    namespace: "oce-observe-1234",
    logLabels: { "job-name": "obs-1234-initialization" },
    secrets,
  });
  assert.match(
    detail,
    /Logs obs-1234-initialization-abcde\/migration unavailable: Error from server/,
  );
  assert.doesNotMatch(detail, new RegExp(syntheticSecret));
  assert.match(detail, /Events in oce-observe-1234, oldest first:/);
  const missing = await podFailureDiagnostic({
    kubectl: async () => {
      throw new Error("Unable to connect to the server");
    },
    namespace: "oce-gone",
  });
  assert.match(missing, /Pods in oce-gone unavailable: Unable to connect to the server/);
  assert.match(missing, /Events in oce-gone unavailable: Unable to connect to the server/);
});

test("the event and log budgets keep the newest entries", async () => {
  const many = Array.from(
    { length: 50 },
    (_, index) => `log line ${String(index).padStart(2, "0")}`,
  );
  const { kubectl } = fakeKubectl({
    logs: { "obs-1234-initialization-abcde/migration": many.join("\n") },
  });
  const detail = await podFailureDiagnostic({
    kubectl,
    namespace: "oce-observe-1234",
    logLabels: { "job-name": "obs-1234-initialization" },
    budgets: { events: 150, logs: 60 },
  });
  assert.match(detail, /BackoffLimitExceeded/);
  assert.doesNotMatch(detail, /Pulled/);
  assert.match(detail, /log line 49$/);
  assert.doesNotMatch(detail, /log line 0\d/);
});

test("events are ordered by when they were last observed, across timestamp precision", async () => {
  const event = (reason, times) => ({
    ...times,
    type: "Normal",
    reason,
    involvedObject: { kind: "Pod", name: "postgres" },
    message: reason,
  });
  const { kubectl } = fakeKubectl({
    events: [
      // Text order put "05.400000Z" before "05Z", so the whole-second event read as the newer
      // one and the budget dropped the newest (finding 2225).
      event("FractionalSameSecond", { eventTime: "2026-10-16T18:15:05.400000Z" }),
      event("WholeSecond", { lastTimestamp: "2026-10-16T18:15:05Z" }),
      // A repeating event's last sighting is its series', not its first eventTime.
      event("SeriesLatest", {
        eventTime: "2026-10-16T18:15:01.000000Z",
        series: { lastObservedTime: "2026-10-16T18:15:04.900000Z", count: 2 },
      }),
      event("Undated", {}),
    ],
  });
  const lines = (await podFailureDiagnostic({ kubectl, namespace: "oce-observe-1234" }))
    .split("\n")
    .filter((line) => / Normal /.test(line));
  assert.deepEqual(lines, [
    "unknown-time Normal Undated Pod/postgres: Undated",
    "2026-10-16T18:15:04.900000Z Normal SeriesLatest Pod/postgres x2: SeriesLatest",
    "2026-10-16T18:15:05Z Normal WholeSecond Pod/postgres: WholeSecond",
    "2026-10-16T18:15:05.400000Z Normal FractionalSameSecond Pod/postgres: FractionalSameSecond",
  ]);
  // A budget for one line keeps the newest event.
  const newest = await podFailureDiagnostic({
    kubectl,
    namespace: "oce-observe-1234",
    budgets: { events: 100 },
  });
  assert.match(newest, /FractionalSameSecond/);
  assert.doesNotMatch(newest, /WholeSecond|SeriesLatest|Undated/);
});

test("a stalled pod diagnostic gives way to its deadline and starts no read after it", async () => {
  const calls = [];
  const result = await withinDiagnosticDeadline(
    () =>
      podFailureDiagnostic({
        kubectl: (...args) => {
          calls.push(args);
          // Never settles, like a read on a stalled API server.
          return new Promise(() => {});
        },
        namespace: "oce-stalled",
      }),
    { timeoutMs: 50, timedOut: "\nDiagnostic timed out" },
  );
  assert.equal(result, "\nDiagnostic timed out");
  assert.equal(calls.length, 1);
  const late = [];
  const settled = await withinDiagnosticDeadline(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return podFailureDiagnostic({
        kubectl: async (...args) => {
          late.push(args);
          return "{}";
        },
        namespace: "oce-late",
      });
    },
    { timeoutMs: 20, timedOut: "late" },
  );
  assert.equal(settled, "late");
  // Let the abandoned diagnostic finish: past its deadline it reads nothing.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(late, []);
});

test("a failed Helm install's error gains the hook Job Pod's logs through kubectl", async (t) => {
  // A fake kubectl on PATH, like #2613's: it records its arguments and answers from fixtures.
  // No cluster is involved.
  const directory = await temporaryDirectory(t, "occ-fake-kubectl-");
  const calls = join(directory, "calls");
  await writeFile(join(directory, "pods.json"), JSON.stringify({ items: [hookPod, postgresPod] }));
  await writeFile(join(directory, "events.json"), JSON.stringify({ items: events }));
  await writeCommand(
    directory,
    "kubectl",
    [
      'case "$*" in',
      `  *" get pods "*) cat '${join(directory, "pods.json")}' ;;`,
      `  *" get events "*) cat '${join(directory, "events.json")}' ;;`,
      `  *" logs "*) printf 'running migrations\\nerror: connect ECONNREFUSED ${syntheticSecret}\\n' ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { log: calls },
  );
  prependPath(t, directory);
  const failure = new Error(
    "helm: Error: failed pre-install: 1 error occurred:\n\t* job obs-1234-initialization failed: BackoffLimitExceeded",
  );
  const error = await withHelmInstallDiagnostic(failure, {
    selection: { kubeconfigPath: join(directory, "kubeconfig"), kubernetesContext: "fake" },
    namespace: "oce-observe-1234",
    release: "obs-1234",
    secrets,
  });
  // The same error, so its stack still names the install.
  assert.equal(error, failure);
  assert.match(error.message, /^helm: Error: failed pre-install/);
  assert.match(error.message, /"name":"migration".*"terminated":"Error","exitCode":1/);
  assert.match(error.message, /BackoffLimitExceeded Job\/obs-1234-initialization/);
  assert.match(
    error.message,
    /Logs obs-1234-initialization-abcde\/migration:\nrunning migrations\nerror: connect ECONNREFUSED/,
  );
  assert.doesNotMatch(error.message, new RegExp(syntheticSecret));
  const recorded = await commandCalls(calls);
  assert.equal(recorded.length, 3, recorded.join("\n"));
  for (const line of recorded) {
    assert.ok(
      line.startsWith(
        `--kubeconfig ${join(directory, "kubeconfig")} --context fake ${diagnosticRequestTimeout} `,
      ),
      line,
    );
  }
  assert.match(
    recorded[2],
    /logs obs-1234-initialization-abcde .*--container migration --tail=200$/,
  );
});

// The shape of finding 1575's turn: two agent messages and no command execution.
const skippedProbeTurn = [
  { id: 1, result: { userAgent: "codex" } },
  { id: 2, result: { thread: { id: "t" }, model: "m", sandbox: { type: "dangerFullAccess" } } },
  { method: "thread/started", params: { thread: { id: "t" } } },
  { id: 3, result: { turn: { id: "u" } } },
  { method: "turn/started", params: {} },
  { method: "item/started", params: { item: { type: "userMessage", text: "run it" } } },
  { method: "item/completed", params: { item: { type: "userMessage", text: "run it" } } },
  {
    method: "error",
    params: {
      willRetry: true,
      error: { message: `stream disconnected before completion ${syntheticSecret}` },
    },
  },
  { method: "item/started", params: { item: { type: "agentMessage", text: "" } } },
  { method: "item/agentMessage/delta", params: { delta: "I'll" } },
  { method: "item/agentMessage/delta", params: { delta: " run" } },
  { method: "item/agentMessage/delta", params: { delta: " it" } },
  {
    method: "item/completed",
    params: {
      item: { type: "agentMessage", text: `I'll run the command now. ${syntheticSecret}` },
    },
  },
  {
    method: "item/completed",
    params: {
      item: {
        type: "mcpToolCall",
        server: "workspace",
        tool: "read_file",
        status: "failed",
        arguments: { path: "/secret" },
      },
    },
  },
  {
    method: "item/commandExecution/requestApproval",
    id: 9,
    params: { itemId: "c", command: "bash /sandbox/enterprise/x.sh" },
  },
  { method: "turn/completed", params: { turn: { status: "completed" } } },
];

test("a skipped probe's turn trace names each step without item text", () => {
  const trace = codexTurnTrace(skippedProbeTurn, secrets);
  assert.equal(
    trace,
    [
      "response 1: {userAgent}",
      "response 2: {model,sandbox,thread} sandbox=dangerFullAccess",
      "thread/started",
      "response 3: {turn}",
      "turn/started",
      "item/started userMessage",
      "item/completed userMessage",
      "error (will retry): stream disconnected before completion [env:SYNTHETIC_SECRET]",
      "item/started agentMessage",
      "item/agentMessage/delta x3",
      "item/completed agentMessage",
      "item/completed mcpToolCall tool=read_file server=workspace status=failed",
      "item/commandExecution/requestApproval (request 9)",
      "turn/completed completed",
    ].join(" > "),
  );
  assert.doesNotMatch(trace, new RegExp(syntheticSecret));
  assert.doesNotMatch(trace, /run it|I'll|\/secret|sandbox\/enterprise/);
});

test("turn trace redacts known values in RPC metadata as well as error text", () => {
  const trace = codexTurnTrace(
    [
      {
        id: syntheticSecret,
        result: { [syntheticSecret]: true, sandbox: { type: syntheticSecret } },
      },
      { method: `fixture/${syntheticSecret}`, params: { item: { type: syntheticSecret } } },
      { method: "turn/completed", params: { turn: { status: syntheticSecret } } },
    ],
    secrets,
  );
  assert.equal(
    trace.includes(syntheticSecret),
    false,
    "an invented value survived in trace metadata",
  );
  assert.match(trace, /turn\/completed \[env:SYNTHETIC_SECRET\]/u);
});

test("a long turn trace keeps its start and end", () => {
  const messages = [
    { method: "turn/started", params: {} },
    ...Array.from({ length: 200 }, (_, index) => ({ method: `notice/${index}` })),
    {
      method: "turn/completed",
      params: { turn: { status: "failed", error: { message: "boom" } } },
    },
  ];
  const trace = codexTurnTrace(messages, [], 300);
  assert.ok(trace.length <= 340, trace);
  assert.match(trace, /^turn\/started > notice\/0 > /);
  assert.match(trace, / > turn\/completed failed: boom$/);
  assert.match(trace, /\[\d+ steps omitted\]/);
  assert.equal(codexTurnTrace(undefined), "");
});

test("OpenShell settles observed commands before deciding whether to ask for another probe", async (t) => {
  const nonce = "fixture-probe";
  const probe = { command: `cd /work && bash ${nonce}.sh ${syntheticSecret}`, id: "probe" };
  const event = (phase, item) => ({
    method: `item/${phase}`,
    params: { item: { type: "commandExecution", ...item } },
  });
  const start = event("started", probe);
  const end = event("completed", { ...probe, exitCode: 52 });
  const unrelated = event("completed", { command: "pwd", id: "other", exitCode: 0 });
  const otherStart = event("started", unrelated.params.item);
  // The shell joins these fragments into fixture-probe.sh; the event text does not contain the nonce.
  const splitStart = event("started", { ...probe, command: "bash fixture-'probe'.sh" });
  for (const [name, turns, expected] of [
    ["split shell spelling, no completion", [[splitStart]], "unknown"],
    ["unsettled command before completed probe", [[otherStart, start, end]], "unknown"],
    ["unsettled command after completed probe", [[start, end, otherStart]], "unknown"],
    ["duplicate start", [[start, start, end]], "unknown"],
    ["duplicate completion", [[start, end, end]], "unknown"],
    ["conflicting command for the same id", [[splitStart, end]], "unknown"],
    [
      "completed unrelated start, then probe",
      [
        [otherStart, unrelated],
        [start, end],
      ],
      "completed",
    ],
    ["no commands, then nonzero probe completion", [[], [start, end]], "completed"],
    ["only a probe completion was observed", [[end]], "completed"],
    ["start without completion", [[start]], "unknown"],
    ["start followed by another command's result", [[start, unrelated]], "unknown"],
    ["inconclusive command identity", [[event("started", { id: "probe" })]], "unknown"],
    ["completion without exit status", [[start, event("completed", probe)]], "unknown"],
    ["unrelated command, then completed probe", [[unrelated], [start, end]], "completed"],
    ["no probe observed in three turns", [[], [], []], "absent"],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const observation = observeSandboxProbe({
        nonce,
        traceSecrets: secrets,
        async requestTurn() {
          const events = turns[calls++];
          assert.ok(events, "must not send another turn after a possible probe effect");
          return {
            items: [
              ...events,
              { method: "turn/completed", params: { turn: { status: "completed" } } },
            ],
          };
        },
      });
      if (expected === "unknown") {
        await assert.rejects(observation, (error) => {
          assert.match(error.message, /outcome is unknown; not sending another turn/);
          assert.ok(!error.message.includes(syntheticSecret), "do not expose command text");
          return true;
        });
      } else {
        const { run, traces } = await observation;
        assert.equal(run, expected === "completed" ? end.params.item : undefined);
        assert.equal(traces.length, expected === "completed" ? calls - 1 : calls);
      }
      assert.equal(calls, turns.length);
    });
  }
});

// Finding 2281: a Harness call to the token echo printed something other than the echo's JSON,
// and the check reported only digest `undefined`. Values are synthetic.
const echoUrl = "http://token-echo.oce-token-echo-1.svc:8080/tool-a";
const syntheticToolToken = "oce-tool-synthetic-0123456789abcdef";
const syntheticPlaceholder = "openshell:resolve:env:v3_OCE_TOOL_A_TOKEN";
const echoSecrets = failureSecrets([{ TOOL_TOKEN_0: syntheticToolToken }]);
const echoCommand = (aggregatedOutput, exitCode = 0) => ({
  type: "commandExecution",
  command: `/bin/bash -lc 'curl -sS --max-time 20 -H "Authorization: Bearer $OCE_TOOL_A" ${echoUrl}'`,
  exitCode,
  aggregatedOutput,
});
const sha256 = "a".repeat(64);

test("a token echo call that prints no JSON fails naming the command and its redacted output", () => {
  const output =
    `curl: (56) Recv failure: Connection reset by peer\n` +
    `> Authorization: Bearer ${syntheticToolToken}\n` +
    `placeholder ${syntheticPlaceholder}\n` +
    `{"path":"/tool-a","digest":"${sha256}"}\n` +
    "x".repeat(5_000);
  const reply = tokenEchoReply([echoCommand(output, 56)], echoUrl, echoSecrets);
  // The refresh phase's checks read it as a reply with no token; the tool checks fail on it.
  assert.deepEqual(Object.keys(reply), ["unparsed", "shown"]);
  assert.throws(
    () => tokenEchoDigest(reply),
    (error) => {
      assert.equal(error.name, "AssertionError");
      assert.match(error.message, /^the token echo call must print JSON: `/);
      assert.ok(error.message.includes(`${echoUrl}'\``), "names the command");
      assert.match(error.message, /\(exit 56\) printed curl: \(56\) Recv failure/);
      assert.match(error.message, /openshell:resolve:\[placeholder\]/);
      assert.match(error.message, /"digest":"\[sha256\]"/);
      assert.ok(error.message.length < 1_000, "the output start is bounded");
      for (const hidden of [syntheticToolToken, syntheticPlaceholder, sha256]) {
        assert.equal(JSON.stringify(error).includes(hidden), false, hidden);
        assert.equal(error.message.includes(hidden), false, hidden);
        assert.equal(reply.unparsed.includes(hidden), false, hidden);
      }
      return true;
    },
  );
  assert.throws(() => tokenEchoReply([], echoUrl, echoSecrets), /the Harness must call/);
});

test("a token echo reply gives its digest, and OpenShell's refusal is shown without one", () => {
  const echoed = tokenEchoReply(
    [echoCommand(`{"path":"/tool-a","digest":"${sha256}","placeholder":false,"length":43}\n`)],
    echoUrl,
    echoSecrets,
  );
  assert.equal(tokenEchoDigest(echoed), sha256);
  assert.equal(echoed.shown.includes(sha256), false, "digests are compared, never shown");
  const refused = tokenEchoReply(
    [
      echoCommand(
        '{"error":"credential_unavailable","message":"Credential placeholder could not be resolved"}',
      ),
    ],
    echoUrl,
    echoSecrets,
  );
  assert.equal(tokenEchoDigest(refused), undefined);
  assert.match(refused.shown, /\(exit 0\) printed \{"error":"credential_unavailable"/);
});
