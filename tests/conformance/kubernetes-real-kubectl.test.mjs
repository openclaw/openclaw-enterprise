import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  abandonedTeardownExitGraceMs,
  assertProbeDenied,
  boundedTeardown,
  createKubernetesClient,
  deleteNamespaceExplained,
  diagnosticDeadlinePassed,
  diagnosticRequestTimeout,
  inlineProbeCommand,
  isTransientKubectlFailure,
  namespaceAlreadyTerminating,
  PROBE_DENIED_EXIT_CODE,
  probeDenial,
  retryKubectlRead,
  retryKubectlWrite,
  teardownStepLimitMs,
  withBoundedTeardown,
  withinDiagnosticDeadline,
} from "../helpers/kubernetes-real.mjs";
import { refusingPort } from "../helpers/available-port.mjs";
import { listen } from "../helpers/listen.mjs";
import { withEnvironment } from "../helpers/environment.mjs";
import { commandPath, prependPath, writeCommand } from "../helpers/fake-commands.mjs";
import { readJsonLines } from "../helpers/json-lines.mjs";
import {
  createOpenShellKubernetesFixture,
  failedRecoveryDiagnostic,
  modelAtCapacityOutcome,
  retryModelAtCapacity,
} from "../helpers/openshell-kubernetes-real.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";

const execute = promisify(execFile);
const probeScript = fileURLToPath(new URL("../fixtures/kubernetes/probe.mjs", import.meta.url));

// execFile rejects a non-zero kubectl exit with a numeric code and the
// captured stderr; a spawn failure has a string code and no stderr.
function kubectlFailure(stderr, code = 1) {
  return Object.assign(new Error(`Command failed: kubectl\n${stderr}`), { code, stderr });
}

// Verbatim stderr from run 37139165776 (finding 308): an exec into a Ready
// gateway Pod lost its stream.
const execStreamDropped =
  'Defaulted container "gateway" out of: gateway, prepare-private-state (init)\nerror: EOF\n';

// Verbatim stderr from job 112575981750 (finding 682): k3d's API server closed
// the connection of a create before it answered.
const createRequestDropped =
  'error: failed to create secret Post "https://127.0.0.1:43099/api/v1/namespaces/oce-4da49d7613731b7/secrets?fieldManager=kubectl-create&fieldValidation=Strict": EOF\n';
const secretExists = 'Error from server (AlreadyExists): secrets "transport-1" already exists\n';

function recordingOptions() {
  const sleeps = [];
  const logs = [];
  return {
    sleeps,
    logs,
    options: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: (message) => logs.push(message),
    },
  };
}

test("a kubectl read retries a dropped exec stream and returns the next attempt's output", async () => {
  const { sleeps, logs, options } = recordingOptions();
  let calls = 0;
  const output = await retryKubectlRead(async () => {
    calls += 1;
    if (calls === 1) {
      throw kubectlFailure(execStreamDropped);
    }
    return '{"gateway":{}}';
  }, options);
  assert.equal(output, '{"gateway":{}}');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [500]);
  assert.deepEqual(logs, [
    "Transient kubectl failure (error: EOF); retrying in 500 ms (attempt 2/4)",
  ]);
});

test("kubectl transport failures are transient", () => {
  for (const stderr of [
    execStreamDropped,
    createRequestDropped,
    "error: unexpected EOF\n",
    "Unable to connect to the server: EOF\n",
    "Error from server: error dialing backend: EOF\n",
    "error: websocket: close 1006 (abnormal closure): unexpected EOF\n",
    "error: read tcp 127.0.0.1:50122->127.0.0.1:6443: read: connection reset by peer\n",
    "The connection to the server 0.0.0.0:6443 was refused - did you specify the right host or port?\nconnection refused\n",
    "Unable to connect to the server: net/http: TLS handshake timeout\n",
    "Unable to connect to the server: dial tcp 127.0.0.1:6443: i/o timeout\n",
    "error: http2: client connection lost\n",
    "Error from server (ServiceUnavailable): the server is currently unable to handle the request\n",
    "Error from server: etcdserver: request timed out\n",
  ]) {
    assert.equal(isTransientKubectlFailure(kubectlFailure(stderr)), true, stderr);
  }
});

test("kubectl results and local failures are not transient", () => {
  for (const error of [
    kubectlFailure('Error from server (NotFound): pods "gateway-0" not found\n'),
    kubectlFailure(
      'Error from server (Forbidden): pods is forbidden: User "fixture" cannot list resource "pods"\n',
    ),
    // The remote command ran and failed: its output is the result, even when it
    // mentions a transport error of its own.
    kubectlFailure(
      "Error: connect ECONNREFUSED\nerror: EOF\ncommand terminated with exit code 1\n",
    ),
    // A remote command can print "error: EOF" and still succeed; kubectl then
    // exits 0 and nothing is thrown. A wrapper error without stderr is not kubectl's.
    new Error("error: EOF"),
    Object.assign(new Error("spawn kubectl ENOENT"), { code: "ENOENT", stderr: "" }),
    // A diagnostic deadline killed the read; what kubectl wrote first does not matter.
    Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
      stderr: "error: EOF\n",
    }),
  ]) {
    assert.equal(isTransientKubectlFailure(error), false, error.message);
  }
});

test("a kubectl read fails at once on a non-transient error", async () => {
  const { sleeps, options } = recordingOptions();
  const notFound = kubectlFailure('Error from server (NotFound): pods "gateway-0" not found\n');
  let calls = 0;
  await assert.rejects(
    retryKubectlRead(async () => {
      calls += 1;
      throw notFound;
    }, options),
    (error) => error === notFound,
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test(
  "a kubectl read gives up after four attempts with the last error",
  { timeout: 5_000 },
  async () => {
    const { sleeps, logs, options } = recordingOptions();
    const failures = [];
    await assert.rejects(
      retryKubectlRead(async () => {
        const failure = kubectlFailure(execStreamDropped);
        failures.push(failure);
        throw failure;
      }, options),
      (error) => error === failures.at(-1),
    );
    assert.equal(failures.length, 4);
    assert.deepEqual(sleeps, [500, 1000, 2000]);
    assert.equal(logs.length, 3);
  },
);

// Verbatim stderr from run 39164088894 (finding 1946): the real model answered a turn that it
// was at capacity, and the turn script exited 1 with that answer as its error.
const modelAtCapacityStderr = [
  'Defaulted container "gateway" out of: gateway, prepare-private-state (init)',
  "Error: Selected model is at capacity. Please try a different model.",
  "    at WebSocket.<anonymous> ([eval]:220:16)",
  "    at [nodejs.internal.kHybridDispatch] (node:internal/event_target:848:20)",
  "    at WebSocket.dispatchEvent (node:internal/event_target:789:26)",
  "    at fireEvent (node:internal/deps/undici/undici:14438:14)",
  "    at #onMessage (node:internal/deps/undici/undici:15762:9)",
  "    at Object.onMessage (node:internal/deps/undici/undici:15469:76)",
  "    at websocketMessageReceived (node:internal/deps/undici/undici:14442:15)",
  "    at ByteParser.run (node:internal/deps/undici/undici:15145:19)",
  "    at ByteParser._write (node:internal/deps/undici/undici:15021:14)",
  "    at writeOrBuffer (node:internal/streams/writable:574:12)",
  'Native execution summary: {"failedCommands":0,"approvalRequests":0,"sandboxSignals":[],"commandGraceMs":14000,"sinceTurnEndMs":null,"pendingCommands":[]}command terminated with exit code 1',
  "",
].join("\n");
// The in-Pod client's receipt that a turn is safe to run again, with its exit status.
const retrySafeReceipt = "occ-codex-turn: retry-safe: model at capacity before any action";
const retrySafeExitCode = 75;

// A `kubectl` on PATH that answers the first `atCapacity` calls as `failure` describes (stderr,
// stdout, exit code) and later ones with a completed turn, and the OpenShell fixture's Gateway
// Pod turn run against it. Returns the turn's outcome and the kubectl calls.
async function gatewayTurnWithFakeKubectl(
  t,
  atCapacity,
  failure = { stderr: modelAtCapacityStderr, stdout: retrySafeReceipt, code: retrySafeExitCode },
) {
  const directory = await temporaryDirectory(t, "occ-fake-kubectl-");
  const calls = join(directory, "calls");
  await writeFile(calls, "");
  await writeFile(
    join(directory, "kubectl"),
    // getBuiltinModule, not require: the stand-in loads as ESM when TMPDIR is inside this repo.
    `#!${process.execPath}
const { appendFileSync, readFileSync } = process.getBuiltinModule("node:fs");
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (readFileSync(${JSON.stringify(calls)}, "utf8").trim().split("\\n").length <= ${atCapacity}) {
  process.stderr.write(${JSON.stringify(failure.stderr)});
  process.stdout.write(${JSON.stringify(failure.stdout)}, () => process.exit(${failure.code}));
} else {
  process.stdout.write(JSON.stringify({ assistant: "OCC-TURN-OK", items: [] }));
}
`,
    { mode: 0o755 },
  );
  const { sleeps, logs, options } = recordingOptions();
  const fixture = createOpenShellKubernetesFixture({
    kubeconfigPath: join(directory, "kubeconfig"),
    kubernetesContext: "fake",
    modelAtCapacityRetry: options,
  });
  const outcome = await withEnvironment({ PATH: commandPath(directory) }, () =>
    fixture
      .requestCodexTurnFromGatewayPod({
        namespace: "oce-gateway",
        gatewayPod: "gateway-0",
        providerModel: "gpt-test",
        prompt: "Reply with exactly OCC-TURN-OK.",
      })
      .then(
        (turn) => ({ turn }),
        (error) => ({ error }),
      ),
  );
  const kubectlCalls = await readJsonLines(calls);
  return { ...outcome, kubectlCalls, sleeps, logs };
}

test("a real-model turn with the client's retry receipt runs again and returns its reply", async (t) => {
  const { turn, error, kubectlCalls, sleeps, logs } = await gatewayTurnWithFakeKubectl(t, 1);
  assert.equal(error, undefined);
  assert.deepEqual(turn, { assistant: "OCC-TURN-OK", items: [] });
  assert.equal(kubectlCalls.length, 2);
  // The whole command, the turn's script included.
  assert.deepEqual(kubectlCalls[1], kubectlCalls[0], "the same turn runs again");
  assert.deepEqual(kubectlCalls[0].slice(4, 8), [
    "exec",
    "gateway-0",
    "--namespace",
    "oce-gateway",
  ]);
  assert.deepEqual(sleeps, [15_000]);
  assert.deepEqual(logs, [
    "The real model was at capacity before the turn began any action; retrying the turn in 15000 ms (attempt 2/3)",
  ]);
});

test("a real-model turn at capacity on every attempt says so on its failure's first line", async (t) => {
  const { turn, error, kubectlCalls, sleeps } = await gatewayTurnWithFakeKubectl(t, 3);
  assert.equal(turn, undefined);
  assert.equal(kubectlCalls.length, 3);
  assert.deepEqual(sleeps, [15_000, 30_000]);
  const [firstLine, ...rest] = error.message.split("\n");
  assert.equal(
    firstLine,
    'The real model was at capacity on all 3 turn attempts ("Selected model is at capacity").',
  );
  // The kubectl failure follows, for the diagnostics, and stays the cause.
  assert.match(rest.join("\n"), /^Command failed: kubectl /);
  assert.equal(modelAtCapacityOutcome(error.cause), "retry");
  // Callers that read kubectl's result still find it on the error.
  assert.equal(error.stderr, modelAtCapacityStderr);
  assert.equal(error.stdout, retrySafeReceipt);
  assert.equal(error.code, retrySafeExitCode);
});

test("a real-model turn at capacity without the client's retry receipt is not run again", async (t) => {
  // The verbatim failure predates the receipt: exit 1 and nothing on stdout.
  const { turn, error, kubectlCalls, sleeps } = await gatewayTurnWithFakeKubectl(t, 3, {
    stderr: modelAtCapacityStderr,
    stdout: "",
    code: 1,
  });
  assert.equal(turn, undefined);
  assert.equal(kubectlCalls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(
    error.message.split("\n")[0],
    'The real model was at capacity ("Selected model is at capacity"), but the turn\'s client gave no receipt that it is safe to run again (it may have begun an action), so it is not run again (attempt 1/3).',
  );
  assert.equal(error.stderr, modelAtCapacityStderr);
});

test("only the client's exact receipt retries a real-model turn", async () => {
  const exitedWith = (line) =>
    kubectlFailure(
      `Defaulted container "gateway" out of: gateway, prepare-private-state (init)\n${line}\ncommand terminated with exit code 1\n`,
    );
  const notAtCapacity = [
    exitedWith("Error: Codex harness turn timed out"),
    exitedWith("Error: Codex harness turn did not complete successfully"),
    exitedWith("Error: The model is at capacity for this account."),
    // The answer only in the turn's script, which a kubectl failure's message repeats: a prompt
    // that quotes it is not the model's answer.
    Object.assign(
      new Error(
        "Command failed: kubectl exec gateway-0 -- node -e \nError: Selected model is at capacity.\nerror: EOF\n",
      ),
      {
        code: 1,
        stderr: "error: EOF\n",
      },
    ),
    // A spawn failure has no stderr.
    Object.assign(new Error("spawn kubectl ENOENT"), { code: "ENOENT" }),
  ];
  for (const failure of notAtCapacity) {
    assert.equal(modelAtCapacityOutcome(failure), undefined, failure.message);
    const { sleeps, logs, options } = recordingOptions();
    let calls = 0;
    await assert.rejects(
      retryModelAtCapacity(async () => {
        calls += 1;
        throw failure;
      }, options),
      (error) => error === failure,
    );
    assert.equal(calls, 1, failure.message);
    assert.deepEqual([sleeps, logs], [[], []]);
  }
  const outcome = (stdout, code, stderr = modelAtCapacityStderr) =>
    modelAtCapacityOutcome(Object.assign(kubectlFailure(stderr, code), { stdout }));
  assert.equal(outcome(retrySafeReceipt, retrySafeExitCode), "retry");
  // Anything short of the exact receipt with its exit status is not permission.
  assert.equal(outcome(retrySafeReceipt.slice(0, -2), retrySafeExitCode), "unsafe");
  assert.equal(outcome(`${retrySafeReceipt}\n`, retrySafeExitCode), "unsafe");
  assert.equal(outcome(retrySafeReceipt, 1), "unsafe");
  assert.equal(outcome("", retrySafeExitCode), "unsafe");
  assert.equal(outcome(undefined, retrySafeExitCode), "unsafe");
  // stderr is diagnostic only: a receipt or a retry-safe summary there grants nothing.
  const posing = modelAtCapacityStderr.replace(
    "Please try a different model.",
    `Please try a different model.\n${retrySafeReceipt}\nNative execution summary: {"retrySafe":true,"pendingCommands":[]}`,
  );
  assert.equal(outcome("", 1, posing), "unsafe");
  assert.equal(outcome("", retrySafeExitCode, posing), "unsafe");
});

// A stubbed kubectl for deleteNamespaceExplained: the delete times out, and each read answers
// from `reads` by its first two arguments.
function namespaceKubectl(reads) {
  const calls = [];
  const kubectl = async (...args) => {
    calls.push(args);
    if (args[0] === "delete") {
      throw kubectlFailure("error: timed out waiting for the condition on namespaces/oce-held\n");
    }
    const answer = reads[`${args[0]} ${args[1]}`];
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  return { kubectl, calls };
}

test("a Namespace delete that times out says what still holds the Namespace", async () => {
  const { kubectl, calls } = namespaceKubectl({
    "get namespace": JSON.stringify({
      spec: { finalizers: ["kubernetes"] },
      status: {
        phase: "Terminating",
        conditions: [
          {
            type: "NamespaceFinalizersRemaining",
            status: "True",
            reason: "SomeFinalizersRemain",
            message:
              "Some content in the namespace has finalizers remaining: openshell.io/sandbox in 1 resource instances",
          },
        ],
      },
    }),
    "api-resources --namespaced=true":
      "pods\nevents\nevents.events.k8s.io\nsandboxes.agents.x-k8s.io\n",
    // kubectl prints the jsonpath template: arrays as JSON, a missing field as nothing.
    "get pods,sandboxes.agents.x-k8s.io":
      'Sandbox/agent-1 finalizers=["openshell.io/sandbox"] deleting=2026-10-19T09:26:00Z\n' +
      "Pod/agent-1-0 finalizers= deleting=\n",
  });
  const error = await deleteNamespaceExplained(kubectl, "oce-held").then(
    () => assert.fail("the delete resolved"),
    (failure) => failure,
  );
  // The delete's own failure comes first, unchanged; what remains follows it.
  assert.match(
    error.message,
    /^Command failed: kubectl\nerror: timed out waiting for the condition/,
  );
  assert.equal(
    error.message.slice(error.message.indexOf("\nNamespace oce-held remains: ")),
    [
      "\nNamespace oce-held remains: phase Terminating, finalizers [kubernetes]",
      "condition NamespaceFinalizersRemaining=True SomeFinalizersRemain: Some content in the namespace has finalizers remaining: openshell.io/sandbox in 1 resource instances",
      'Sandbox/agent-1 finalizers=["openshell.io/sandbox"] deleting=2026-10-19T09:26:00Z',
      "Pod/agent-1-0",
    ].join("\n  "),
  );
  assert.deepEqual(calls[0], [
    "delete",
    "namespace",
    "oce-held",
    "--ignore-not-found=true",
    "--wait=true",
    "--timeout=120s",
  ]);
  // Every read is bounded per request, and the object listing prints metadata only.
  for (const call of calls.slice(1)) {
    assert.equal(call.at(-1), diagnosticRequestTimeout);
  }
  const listing = calls.find((call) => call[0] === "get" && call[1] !== "namespace");
  assert.match(
    listing.at(-2),
    /^jsonpath=\{range \.items\[\*\]\}\{\.kind\}\/\{\.metadata\.name\} /,
  );
  assert.doesNotMatch(listing.at(-2), /\.data|\.spec|\.status/);
});

test("a timed-out Namespace delete still fails when the Namespace is gone or the listing fails", async () => {
  const gone = namespaceKubectl({
    "get namespace": kubectlFailure(
      'Error from server (NotFound): namespaces "oce-held" not found\n',
    ),
  });
  await assert.rejects(deleteNamespaceExplained(gone.kubectl, "oce-held"), (error) => {
    assert.match(error.message, /\nNamespace oce-held remains: none \(the Namespace is gone\)$/);
    return true;
  });

  const partial = namespaceKubectl({
    "get namespace": JSON.stringify({ spec: {}, status: { phase: "Terminating" } }),
    "api-resources --namespaced=true": "pods\nwidgets.example.com\n",
    "get pods,widgets.example.com": Object.assign(
      kubectlFailure("error: the server is currently unable to handle the request\n"),
      { stdout: "Pod/left finalizers= deleting=\n" },
    ),
  });
  await assert.rejects(deleteNamespaceExplained(partial.kubectl, "oce-held"), (error) => {
    assert.match(error.message, /remains: phase Terminating, finalizers \[\]\n/);
    assert.match(
      error.message,
      /\n {2}listing objects failed: error: the server is currently unable/,
    );
    assert.match(error.message, /\n {2}Pod\/left$/);
    assert.doesNotMatch(error.message, /no objects left/);
    return true;
  });

  // One unavailable aggregated API fails discovery, but kubectl still prints the other kinds
  // (a classic NamespaceDeletionDiscoveryFailure): the listing goes on with them.
  const discovery = namespaceKubectl({
    "get namespace": JSON.stringify({
      spec: { finalizers: ["kubernetes"] },
      status: {
        phase: "Terminating",
        conditions: [
          {
            type: "NamespaceDeletionDiscoveryFailure",
            status: "True",
            reason: "DiscoveryFailed",
            message: "Discovery failed for some groups: metrics.k8s.io/v1beta1",
          },
        ],
      },
    }),
    "api-resources --namespaced=true": Object.assign(
      kubectlFailure(
        "error: unable to retrieve the complete list of server APIs: metrics.k8s.io/v1beta1: the server is currently unable to handle the request\n",
      ),
      { stdout: "pods\n" },
    ),
    "get pods": "",
  });
  await assert.rejects(deleteNamespaceExplained(discovery.kubectl, "oce-held"), (error) => {
    assert.match(error.message, /\n {2}condition NamespaceDeletionDiscoveryFailure=True /);
    assert.match(
      error.message,
      /\n {2}listing kinds failed: error: unable to retrieve the complete list/,
    );
    assert.doesNotMatch(error.message, /no objects left/);
    return true;
  });
  assert.equal(discovery.calls.at(-1)[1], "pods");

  const unreadable = namespaceKubectl({ "get namespace": kubectlFailure("error: EOF\n") });
  await assert.rejects(deleteNamespaceExplained(unreadable.kubectl, "oce-held"), (error) => {
    assert.match(error.message, /^Command failed: kubectl\nerror: timed out waiting/);
    assert.match(
      error.message,
      /remains: listing what remains failed: Command failed: kubectl\nerror: EOF/,
    );
    return true;
  });
});

// Finding 2027/2028: the listing has its own bound (40 s by default, so the 120 s delete and the
// listing fit the teardown step), and a listing cut short keeps what it read: the Namespace's
// phase, finalizers and conditions are what explain a stuck delete.
test("a Namespace listing past its deadline keeps the conditions it read", async () => {
  const held = {
    "get namespace": JSON.stringify({
      spec: { finalizers: ["kubernetes"] },
      status: {
        phase: "Terminating",
        conditions: [
          {
            type: "NamespaceFinalizersRemaining",
            status: "True",
            reason: "SomeFinalizersRemain",
            message: "Some content in the namespace has finalizers remaining",
          },
        ],
      },
    }),
    "api-resources --namespaced=true": "pods\n",
  };
  const expected = [
    "\nNamespace oce-held remains: phase Terminating, finalizers [kubernetes]",
    "condition NamespaceFinalizersRemaining=True SomeFinalizersRemain: Some content in the namespace has finalizers remaining",
    "listing what remains timed out",
  ].join("\n  ");
  const remains = (error) => error.message.slice(error.message.indexOf("\nNamespace oce-held"));
  // The object listing never answers, as a get through a hung aggregated API.
  function stalledAt(stall) {
    const reads = namespaceKubectl(held);
    let reached;
    const stalled = new Promise((resolve) => {
      reached = resolve;
    });
    const kubectl = (...args) => {
      if (`${args[0]} ${args[1]}` === stall) {
        reached();
        return new Promise(() => {});
      }
      return reads.kubectl(...args);
    };
    return { kubectl, stalled };
  }

  // The deadline's timer is held until released, so the default bound is read, not waited for.
  const listing = stalledAt("get pods");
  const sleeps = [];
  let release;
  const sleep = (ms, value, { signal }) => {
    sleeps.push(ms);
    return new Promise((resolve, reject) => {
      release = () => resolve(value);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const failure = deleteNamespaceExplained(listing.kubectl, "oce-held", { sleep }).then(
    () => assert.fail("the delete resolved"),
    (error) => error,
  );
  await listing.stalled;
  assert.deepEqual(sleeps, [40_000]);
  release();
  assert.equal(remains(await failure), expected);

  // The same with the real timer and a short bound; a Namespace read that stalls keeps nothing.
  const late = stalledAt("get pods");
  await assert.rejects(
    deleteNamespaceExplained(late.kubectl, "oce-held", { listTimeoutMs: 20 }),
    (error) => remains(error) === expected,
  );
  const unread = stalledAt("get namespace");
  await assert.rejects(
    deleteNamespaceExplained(unread.kubectl, "oce-held", { listTimeoutMs: 20 }),
    (error) => remains(error) === "\nNamespace oce-held remains: listing what remains timed out",
  );
});

// A read the deadline stops rejects with an AbortError as the deadline passes, racing the
// listing's report: it must not add a "listing objects failed" line, so the report is what was
// read and then the timeout. The stand-in kubectl on PATH runs through the real client, so the
// stalled read is a real child process the deadline kills.
test("a Namespace listing stopped at its deadline reports the timeout alone", async (t) => {
  const directory = await temporaryDirectory(t, "occ-fake-kubectl-");
  const namespaceJson = JSON.stringify({
    spec: { finalizers: ["kubernetes"] },
    status: {
      phase: "Terminating",
      conditions: [
        { type: "NamespaceContentRemaining", status: "True", reason: "SomeResourcesRemain" },
      ],
    },
  });
  await writeCommand(
    directory,
    "kubectl",
    `const args = process.argv.slice(2);
const verb = args.findIndex((arg) => ["delete", "get", "api-resources"].includes(arg));
const command = args.slice(verb, verb + 2).join(" ");
if (command === "delete namespace") {
  process.stderr.write("error: timed out waiting for the condition on namespaces/oce-held\\n");
  process.exitCode = 1;
} else if (command === "get namespace") {
  process.stdout.write(${JSON.stringify(namespaceJson)});
} else if (command === "api-resources --namespaced=true") {
  process.stdout.write("pods\\n");
} else {
  // The object listing stalls, as a get through a hung aggregated API does.
  setTimeout(() => {}, 30_000);
}
`,
    { interpreter: process.execPath },
  );
  prependPath(t, directory);
  const client = createKubernetesClient({
    selection: { kubeconfigPath: join(directory, "kubeconfig"), kubernetesContext: "fake" },
  });
  let reached;
  const listing = new Promise((resolve) => {
    reached = resolve;
  });
  const kubectl = (...args) => {
    if (args[0] === "get" && args[1] === "pods") {
      reached();
    }
    return client.kubectl(...args);
  };
  // The deadline's timer is held until the stalled listing has started.
  let release;
  const sleep = (ms, value, { signal }) =>
    new Promise((resolve, reject) => {
      release = () => resolve(value);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  const failure = deleteNamespaceExplained(kubectl, "oce-held", { sleep }).then(
    () => assert.fail("the delete resolved"),
    (error) => error,
  );
  await listing;
  release();
  const error = await failure;
  assert.equal(
    error.message.slice(error.message.indexOf("\nNamespace oce-held")),
    [
      "\nNamespace oce-held remains: phase Terminating, finalizers [kubernetes]",
      "condition NamespaceContentRemaining=True SomeResourcesRemain: ",
      "listing what remains timed out",
    ].join("\n  "),
  );
});

// Finding 2027: the listing is bounded in size too, since it joins a test failure message: at most
// 40 objects, and a failed read's first stderr line cut to 300 characters.
test("a Namespace listing caps its objects and a failed read's error", async () => {
  const objects = Array.from({ length: 45 }, (_, index) => `Pod/p-${index} finalizers= deleting=`);
  const reason = `error: ${"y".repeat(400)}`;
  const { kubectl } = namespaceKubectl({
    "get namespace": JSON.stringify({ spec: {}, status: { phase: "Terminating" } }),
    "api-resources --namespaced=true": Object.assign(
      kubectlFailure("error: discovery failed for one group\nsecond line of detail\n"),
      { stdout: "pods\n" },
    ),
    "get pods": Object.assign(kubectlFailure(`${reason}\nsecond line of detail\n`), {
      stdout: `${objects.join("\n")}\n`,
    }),
  });
  await assert.rejects(deleteNamespaceExplained(kubectl, "oce-held"), (error) => {
    assert.equal(
      error.message.slice(error.message.indexOf("\nNamespace oce-held")),
      [
        "\nNamespace oce-held remains: phase Terminating, finalizers []",
        "listing kinds failed: error: discovery failed for one group",
        `listing objects failed: ${reason.slice(0, 300)}`,
        ...Array.from({ length: 40 }, (_, index) => `Pod/p-${index}`),
        "and 5 more objects",
      ].join("\n  "),
    );
    return true;
  });
});

test("a failed outage recovery says why without replacing its failure", async () => {
  const written = [];
  const write = (text) => written.push(text);
  // The wait itself failed: the worker and Pod evidence join its message.
  const failure = new Error("deployment rev-1 to activate after the gateway outage timed out");
  const described = [];
  const detail = await failedRecoveryDiagnostic({
    readWorker: async () => ({ events: [{ code: "RUNTIME_LOGIN_FAILED" }] }),
    describe: async (worker) => {
      described.push(worker);
      return "\nHarness diagnostics:\nHarness model authentication probe failed.";
    },
    failure,
    write,
  });
  assert.deepEqual(described, [{ events: [{ code: "RUNTIME_LOGIN_FAILED" }] }]);
  assert.equal(detail, "\nHarness diagnostics:\nHarness model authentication probe failed.");
  assert.equal(
    failure.message,
    "deployment rev-1 to activate after the gateway outage timed out\nHarness diagnostics:\nHarness model authentication probe failed.",
  );
  assert.deepEqual(written, [`OpenShell integration: gateway outage recovery failed.${detail}\n`]);

  // The deployment failed without a wait error: the detail is returned for the assertion, and a
  // worker read that throws still lets the Pods be described.
  const unread = [];
  assert.equal(
    await failedRecoveryDiagnostic({
      readWorker: () => {
        throw new Error("pool closed");
      },
      describe: async (worker) => {
        unread.push(worker);
        return "\nReplacement Pods: []";
      },
      failure: undefined,
      write,
    }),
    "\nReplacement Pods: []",
  );
  assert.deepEqual(unread, [undefined]);

  // A describe that fails names only its error's class; one that stalls gives way to the deadline.
  assert.equal(
    await failedRecoveryDiagnostic({
      readWorker: async () => undefined,
      describe: async () => {
        throw new TypeError("token=secret-value");
      },
      write,
    }),
    "\nRecovery diagnostic unavailable: TypeError",
  );
  const stalledWorker = [];
  await failedRecoveryDiagnostic(
    {
      readWorker: () => new Promise(() => {}),
      describe: async (worker) => {
        stalledWorker.push(worker);
        return "";
      },
      write,
    },
    { timeoutMs: 50 },
  );
  assert.deepEqual(stalledWorker, [undefined]);
  const started = Date.now();
  const stalled = new Error("wait failed");
  assert.equal(
    await failedRecoveryDiagnostic(
      {
        readWorker: () => new Promise(() => {}),
        describe: () => new Promise(() => {}),
        failure: stalled,
        write,
      },
      { timeoutMs: 50 },
    ),
    "\nRecovery diagnostic timed out after 0.05 s",
  );
  assert.equal(stalled.message, "wait failed\nRecovery diagnostic timed out after 0.05 s");
  assert.ok(Date.now() - started < 2_000);
});

test("a stalled failure diagnostic gives way to its deadline", { timeout: 5_000 }, async () => {
  // Never settles, like a kubectl read on a stalled API server (finding 1550).
  const stalled = new Promise(() => {});
  const started = Date.now();
  assert.equal(
    await withinDiagnosticDeadline(() => stalled, {
      timeoutMs: 50,
      timedOut: "\nDiagnostic timed out",
    }),
    "\nDiagnostic timed out",
  );
  assert.ok(Date.now() - started < 2_000);
  assert.match(diagnosticRequestTimeout, /^--request-timeout=\d+s$/);
});

test(
  "a failure diagnostic that settles in time is returned as is",
  { timeout: 5_000 },
  async () => {
    // The default 60 s deadline must not hold the test (or the caller) once the diagnostic settles.
    assert.equal(await withinDiagnosticDeadline(async () => "\nWorker: {}"), "\nWorker: {}");
    const failure = new Error("diagnostic read failed");
    await assert.rejects(
      withinDiagnosticDeadline(async () => {
        throw failure;
      }),
      (error) => error === failure,
    );
  },
);

// A test context stand-in: records the hook boundedTeardown registers, and keeps a private field
// so a member read through the teardown's context must be bound to the real one.
class RecordingContext {
  #name = "recorded test";
  hooks = [];
  get name() {
    return this.#name;
  }
  diagnostic(message) {
    return `${this.#name}: ${message}`;
  }
  after(hook) {
    this.hooks.push(hook);
  }
}

test(
  "a bounded teardown runs every cleanup last-registered first, also after one fails",
  { timeout: 5_000 },
  async () => {
    // Finding 1711: node:test runs a test's own after hooks first-registered first and skips the
    // rest once one throws, so a failed Namespace delete skipped the worker stop.
    const testContext = new RecordingContext();
    const logs = [];
    const exits = [];
    const teardown = boundedTeardown(testContext, {
      label: "probe teardown",
      log: (message) => logs.push(message),
      exit: () => exits.push("exit"),
    });
    const { context } = teardown;
    const ran = [];
    context.after(() => ran.push("namespace delete"));
    context.after(() => {
      ran.push("role delete");
      throw new Error("roles are gone");
    });
    context.after(async () => {
      ran.push("worker stop");
      // A cleanup registered during teardown runs next.
      context.after(() => ran.push("late cleanup"));
    });
    assert.equal(testContext.hooks.length, 1, "one node:test hook holds every cleanup");
    assert.equal(teardown.started, false);
    await assert.rejects(testContext.hooks[0](), (error) => {
      assert.match(
        error.message,
        /^cleanup registered at kubernetes-real-kubectl\.test\.mjs:\d+: roles are gone$/,
      );
      return true;
    });
    assert.equal(teardown.started, true);
    assert.deepEqual(ran, ["worker stop", "late cleanup", "role delete", "namespace delete"]);
    assert.equal(logs.length, 5);
    assert.ok(logs.every((line) => /^probe teardown: cleanup registered at /.test(line)));
    assert.match(logs[3], /kubernetes-real-kubectl\.test\.mjs:\d+ failed: roles are gone$/);
    assert.deepEqual(exits, [], "nothing was abandoned, so the process is left to exit itself");
    // Other members read through the teardown's context come from the test's own.
    assert.equal(context.name, "recorded test");
    assert.equal(context.diagnostic("note"), "recorded test: note");
  },
);

test(
  "a bounded teardown abandons a stalled cleanup, runs the rest and ends the process",
  { timeout: 5_000 },
  async () => {
    const testContext = new RecordingContext();
    const logs = [];
    const exits = [];
    const { context } = boundedTeardown(testContext, {
      stepLimitMs: 50,
      exitGraceMs: 10,
      log: (message) => logs.push(message),
      exit: () => exits.push("exit"),
      // This file's own test is still running; the stand-in waits the grace alone.
      settled: (quietMs) => delay(quietMs),
    });
    const ran = [];
    context.after(() => ran.push("namespace delete"));
    // Never settles, like a worker stop waiting on an operation that ignores its abort.
    context.after(() => new Promise(() => {}));
    context.after(() => ran.push("port-forward stop"));
    await assert.rejects(testContext.hooks[0](), /: did not finish within 50 ms$/);
    assert.deepEqual(ran, ["port-forward stop", "namespace delete"]);
    assert.match(
      logs.at(-1),
      /^teardown: exiting once the file's tests settle for 10 ms; abandoned cleanups registered at kubernetes-real-kubectl\.test\.mjs:\d+$/,
    );
    await waitUntil("the exit after the 10 ms grace", () => exits.length > 0, 2_000);
    assert.deepEqual(exits, ["exit"]);
    assert.equal(teardownStepLimitMs, 180_000, "longer than the 120 s Namespace delete waits");
    assert.equal(abandonedTeardownExitGraceMs, 2_000);
  },
);

test(
  "the OpenShell proof's installation cleanups all run when its worker stop never settles",
  { timeout: 20_000 },
  async () => {
    // Finding 1711: the proof's own cleanup registration, in a real node:test process. The
    // worker stop never settles and its poll interval keeps the process alive; every later
    // cleanup must still be attempted, the stalled one named, and the file must exit by itself.
    // Registering all six as one cleanup would attempt only the worker stop.
    const kubernetesHelper = new URL("../helpers/kubernetes-real.mjs", import.meta.url).href;
    const openShellHelper = new URL("../helpers/openshell-kubernetes-real.mjs", import.meta.url)
      .href;
    const exited = await runFailingTestScript(`
      import test from "node:test";
      import { boundedTeardown } from ${JSON.stringify(kubernetesHelper)};
      import { registerOpenShellInstallationCleanups } from ${JSON.stringify(openShellHelper)};
      const attempt = (name) => process.stdout.write("attempted " + name + "\\n");
      test("proof", async (testContext) => {
        const { context } = boundedTeardown(testContext, { stepLimitMs: 200, exitGraceMs: 50 });
        let poll;
        registerOpenShellInstallationCleanups(context, {
          workerStop: () => {
            attempt("worker stop");
            return new Promise(() => poll);
          },
          portForwards: () => attempt("port-forwards"),
          productionApp: () => attempt("production app"),
          observerPool: () => attempt("observer pool"),
          workloadNamespace: () => attempt("workload Namespace"),
          temporaryDirectory: () => attempt("temporary directory"),
        });
        // Assigned after registration, like the proof's worker: cleanups read it when they run.
        poll = setInterval(() => {}, 50);
        throw new Error("replacement timed out");
      });
    `);
    assert.deepEqual(exited.stdout.match(/^attempted .+$/gm), [
      "attempted worker stop",
      "attempted port-forwards",
      "attempted production app",
      "attempted observer pool",
      "attempted workload Namespace",
      "attempted temporary directory",
    ]);
    assert.match(
      exited.stderr,
      /teardown: cleanup workerStop registered at openshell-kubernetes-real\.mjs:\d+ failed: did not finish within 200 ms/,
    );
    assert.match(
      exited.stderr,
      /teardown: exiting once the file's tests settle for 50 ms; abandoned cleanups workerStop registered at openshell-kubernetes-real\.mjs:\d+/,
    );
  },
);

test("a helper's bounded teardown reuses its caller's and never nests a second one", () => {
  const testContext = new RecordingContext();
  const context = withBoundedTeardown(testContext);
  assert.equal(testContext.hooks.length, 1, "a raw node:test context gets one bounded hook");
  assert.equal(withBoundedTeardown(context), context);
  const { context: callers } = boundedTeardown(new RecordingContext());
  assert.equal(withBoundedTeardown(callers), callers);
  assert.equal(testContext.hooks.length, 1);
});

test("two helpers given one node:test context share its bounded teardown, newest first", async () => {
  // Finding 1725: each helper got a teardown of its own, and node:test ran the two oldest-first,
  // so the first helper's Namespace delete ran before the second helper's worker stop.
  const testContext = new RecordingContext();
  const first = withBoundedTeardown(testContext, { label: "first helper", log: () => {} });
  const second = withBoundedTeardown(testContext, { label: "second helper" });
  assert.equal(second, first);
  assert.equal(testContext.hooks.length, 1);
  const ran = [];
  first.after(() => ran.push("namespace delete"));
  second.after(() => ran.push("worker stop"));
  await testContext.hooks[0]();
  assert.deepEqual(ran, ["worker stop", "namespace delete"]);
  // A helper given the context its caller already bounded joins the caller's teardown too, and a
  // caller that bounds a context after a helper did gets the helper's.
  const callersContext = new RecordingContext();
  const { context } = boundedTeardown(callersContext);
  assert.equal(withBoundedTeardown(callersContext), context);
  assert.equal(callersContext.hooks.length, 1);
  const helpersContext = new RecordingContext();
  const helpers = withBoundedTeardown(helpersContext);
  assert.equal(boundedTeardown(helpersContext).context, helpers);
  assert.equal(helpersContext.hooks.length, 1);
});

// A cleanup registered after its teardown ran also stops the setup that made it, by throwing to it.
const stopsSetup =
  /^teardown: setup outlived its test; cleanup registered at kubernetes-real-kubectl\.test\.mjs:\d+ runs now and setup stops here$/;

test(
  "a cleanup registered after the teardown ran runs at once, bounded, and fails the file",
  { timeout: 5_000 },
  async () => {
    // Finding 1722: such a cleanup was kept for a teardown that had already run, so it never ran.
    const testContext = new RecordingContext();
    const logs = [];
    const events = [];
    const { context } = boundedTeardown(testContext, {
      stepLimitMs: 50,
      exitGraceMs: 10,
      log: (message) => logs.push(message),
      exit: () => events.push("exit"),
      failFile: () => events.push("fail"),
      // This file's own test is still running; the stand-in waits the grace alone.
      settled: (quietMs) => delay(quietMs),
    });
    const ran = [];
    context.after(() => ran.push("early cleanup"));
    await testContext.hooks[0]();
    assert.deepEqual(events, [], "nothing was abandoned or late");
    // Each late registration also stops the setup that made it, by throwing to it.
    assert.throws(() => context.after(() => ran.push("worker stop")), { message: stopsSetup });
    // A late cleanup that never settles is abandoned like any other.
    assert.throws(() => context.after(() => new Promise(() => {})), { message: stopsSetup });
    assert.throws(() => context.after(() => ran.push("port-forward stop")), {
      message: stopsSetup,
    });
    // A late cleanup may register another, as during the teardown, without being stopped.
    assert.throws(
      () =>
        context.after(() => {
          context.after(() => ran.push("pool end"));
          ran.push("observer stop");
        }),
      { message: stopsSetup },
    );
    // The drain ends with the oldest late cleanup, after the stalled one's 50 ms limit; each
    // late cleanup fails the file once it ran.
    await waitUntil(
      "the five late cleanups' failures and the exit",
      () => events.filter((event) => event === "fail").length >= 5 && events.includes("exit"),
      2_000,
    );
    // Registered in one turn, they run newest-first like the teardown, and a cleanup's own
    // registration runs next.
    assert.deepEqual(ran, [
      "early cleanup",
      "observer stop",
      "pool end",
      "port-forward stop",
      "worker stop",
    ]);
    assert.equal(events.filter((event) => event === "fail").length, 5);
    assert.equal(events.filter((event) => event === "exit").length, 1);
    assert.equal(
      logs.filter((line) => / came after the teardown ran; running it now$/.test(line)).length,
      5,
    );
    assert.ok(
      logs.some((line) =>
        /^teardown: cleanup registered at kubernetes-real-kubectl\.test\.mjs:\d+ failed: did not finish within 50 ms$/.test(
          line,
        ),
      ),
    );
  },
);

test(
  "two teardowns' late cleanups both run when one starts while the other's runs",
  { timeout: 5_000 },
  async () => {
    // Each teardown drains its own late queue; a file-wide count of running late cleanups once
    // decided whether one was drained, so the second teardown's cleanup was queued and never ran.
    const options = {
      log: () => {},
      exit: () => {},
      failFile: () => {},
      settled: (quietMs) => delay(quietMs),
    };
    const first = new RecordingContext();
    const second = new RecordingContext();
    const { context: firstContext } = boundedTeardown(first, options);
    const { context: secondContext } = boundedTeardown(second, options);
    await first.hooks[0]();
    await second.hooks[0]();
    const ran = [];
    const firstHeld = Promise.withResolvers();
    const firstRan = Promise.withResolvers();
    const release = Promise.withResolvers();
    assert.throws(
      () =>
        firstContext.after(async () => {
          firstHeld.resolve();
          await release.promise;
          ran.push("first late cleanup");
          firstRan.resolve();
        }),
      { message: stopsSetup },
    );
    await firstHeld.promise;
    try {
      assert.throws(() => secondContext.after(() => ran.push("second late cleanup")), {
        message: stopsSetup,
      });
      // Late cleanups drain in microtasks, so one event-loop turn runs the second while the
      // first teardown's is still running.
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(ran, ["second late cleanup"]);
    } finally {
      release.resolve();
    }
    await firstRan.promise;
    assert.deepEqual(ran, ["second late cleanup", "first late cleanup"]);
  },
);

const kubernetesHelperUrl = new URL("../helpers/kubernetes-real.mjs", import.meta.url).href;

// Runs a script as its own node:test root, not as a child reporting to this runner, with a TAP
// report, and returns how it ended.
async function runTestScript(script, { env: overrides = {}, timeout = 15_000 } = {}) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  const exited = await execute(
    process.execPath,
    ["--test-reporter=tap", "--input-type=module", "-e", script],
    { env, timeout },
  ).then(
    ({ stdout, stderr }) => ({ code: 0, killed: false, stdout, stderr }),
    (error) => error,
  );
  return { ...exited, elapsedMs: Date.now() - started };
}

async function runFailingTestScript(script, options) {
  const exited = await runTestScript(script, options);
  assert.equal(exited.killed, false, "the file exited on its own");
  assert.ok(exited.elapsedMs < 10_000, "the file exited promptly");
  assert.equal(exited.code, 1);
  return exited;
}

test(
  "setup that outlives its test's timeout has its late worker stop run, and the file ends",
  { timeout: 20_000 },
  async () => {
    // Finding 1722: a node:test timeout runs the test's hooks but does not stop its body. Setup
    // that started a worker after that registered its stop too late: the stop never ran, and the
    // worker's poll held the file until the runner's 5,400 s file timeout.
    const exited = await runFailingTestScript(`
      import test from "node:test";
      import { setTimeout as delay } from "node:timers/promises";
      import { boundedTeardown } from ${JSON.stringify(kubernetesHelperUrl)};
      test("setup outlives its timeout", { timeout: 200 }, async (testContext) => {
        const { context } = boundedTeardown(testContext, { stepLimitMs: 1000, exitGraceMs: 100 });
        context.after(() => process.stdout.write("attempted early cleanup\\n"));
        await delay(600);
        const poll = setInterval(() => {}, 50);
        context.after(() => {
          process.stdout.write("attempted worker stop\\n");
          clearInterval(poll);
        });
      });
    `);
    assert.deepEqual(exited.stdout.match(/^attempted .+$/gm), [
      "attempted early cleanup",
      "attempted worker stop",
    ]);
    assert.match(exited.stdout, /^not ok 1 - setup outlives its timeout$/m);
    assert.match(
      exited.stderr,
      /^teardown: cleanup registered at \[eval1\]:\d+ came after the teardown ran; running it now$/m,
    );
  },
);

test(
  "an abandoned cleanup ends the file after its later tests and hooks, not under them",
  { timeout: 20_000 },
  async () => {
    // Finding 1723: the exit fired its grace after the abandoning test's own teardown. The next
    // test was killed mid-run, missing from the report, and its cleanups never ran. Suite and file
    // hooks run outside any test, so the exit also waits for the file's root to finish; a test
    // named like the root is not it.
    const exited = await runFailingTestScript(`
      import { after, beforeEach, describe, it } from "node:test";
      import { setTimeout as delay } from "node:timers/promises";
      import { boundedTeardown } from ${JSON.stringify(kubernetesHelperUrl)};
      after(async () => {
        await delay(500);
        process.stdout.write("attempted file after\\n");
      });
      // A failing file hook skips the root's later ones; the file's end must still be seen.
      after(() => {
        throw new Error("file after hook failed");
      });
      // Named like node:test's own root, which must not pass for the file's end.
      it("<root>", (testContext) => {
        const { context } = boundedTeardown(testContext, { stepLimitMs: 100, exitGraceMs: 200 });
        // Never settles, and its poll keeps the process alive.
        context.after(() => new Promise(() => setInterval(() => {}, 50)));
      });
      // While this runs before the second test, no test is running at all.
      let tests = 0;
      beforeEach(async () => {
        tests += 1;
        if (tests === 2) {
          await delay(500);
        }
      });
      it("second outlasts the grace", async (testContext) => {
        const { context } = boundedTeardown(testContext);
        context.after(() => process.stdout.write("attempted second cleanup\\n"));
        await describe("later suite", () => {
          after(async () => {
            await delay(500);
            process.stdout.write("attempted suite after\\n");
          });
          it("child", () => {});
        });
      });
    `);
    assert.match(exited.stdout, /^not ok 1 - <root>$/m);
    assert.deepEqual(exited.stdout.match(/^attempted .+$/gm), [
      "attempted suite after",
      "attempted second cleanup",
      "attempted file after",
    ]);
    assert.match(exited.stdout, /^\s*ok 2 - second outlasts the grace$/m);
  },
);

test(
  "a pending exit waits for timed-out setup to register what it holds, then stops that setup",
  { timeout: 20_000 },
  async (t) => {
    // Review of finding 1722: two quiet seconds do not mean a timed-out setup stopped acquiring.
    // The first test's abandoned cleanup arms the exit. The second times out mid-setup; its setup
    // then acquires a resource, waits past the grace for it, and registers its release. The exit
    // must wait for that release, and the setup must not go on to its second acquisition.
    const directory = await temporaryDirectory(t, "occ-teardown-acquisitions-");
    const first = join(directory, "first-resource");
    const second = join(directory, "second-resource");
    const exited = await runFailingTestScript(
      `
      import test from "node:test";
      import { rm, writeFile } from "node:fs/promises";
      import { setTimeout as delay } from "node:timers/promises";
      import { boundedTeardown } from ${JSON.stringify(kubernetesHelperUrl)};
      const acquire = async (path) => {
        await writeFile(path, "held");
        process.stdout.write("acquired " + path + "\\n");
      };
      test("first abandons a cleanup", (testContext) => {
        const { context } = boundedTeardown(testContext, { stepLimitMs: 100, exitGraceMs: 200 });
        context.after(() => new Promise(() => setInterval(() => {}, 50)));
      });
      test("second outlives its timeout", { timeout: 200 }, async (testContext) => {
        const { context } = boundedTeardown(testContext, { stepLimitMs: 10_000, exitGraceMs: 200 });
        await delay(400);
        await acquire(process.env.FIRST_RESOURCE);
        await delay(1_500);
        context.after(() => rm(process.env.FIRST_RESOURCE));
        await acquire(process.env.SECOND_RESOURCE);
        await delay(1_500);
        context.after(() => rm(process.env.SECOND_RESOURCE));
      });
    `,
      { env: { FIRST_RESOURCE: first, SECOND_RESOURCE: second } },
    );
    assert.deepEqual(exited.stdout.match(/^acquired .+$/gm), [`acquired ${first}`]);
    assert.match(exited.stderr, /cleanup registered at \[eval1\]:\d+ came after the teardown ran/);
    await assert.rejects(readFile(first), { code: "ENOENT" }, "the first resource was released");
    await assert.rejects(readFile(second), { code: "ENOENT" }, "the second was never acquired");
  },
);

test(
  "a timeout arms the exit, which waits for setup that never stops only to its limit",
  { timeout: 20_000 },
  async () => {
    // Setup still running after its test timed out, holding a handle and never registering
    // again, kept the file alive until the runner's file timeout. The timeout now arms the exit,
    // which waits for that setup only to its limit.
    const exited = await runFailingTestScript(`
      import test from "node:test";
      import { boundedTeardown } from ${JSON.stringify(kubernetesHelperUrl)};
      test("never stops", { timeout: 200 }, async (testContext) => {
        boundedTeardown(testContext, { label: "setup", stepLimitMs: 1_000, exitGraceMs: 200 });
        await new Promise(() => setInterval(() => {}, 50));
      });
    `);
    assert.match(
      exited.stderr,
      /^setup: exiting once the file's tests settle for 200 ms; its test timed out or was cancelled with setup that may still run$/m,
    );
    assert.match(
      exited.stderr,
      /^setup: setup still ran 1000 ms after its test ended; exiting without it$/m,
    );
  },
);

test(
  "the topology and OpenShell cleanup lists register every cleanup after their teardown ran",
  { timeout: 20_000 },
  async () => {
    // A late registration throws to stop the setup; a list that stopped at its first entry would
    // leave every resource behind the later entries (the pools, Namespaces and directories).
    const topologyHelper = new URL("../helpers/harness-topology-k3d-real.mjs", import.meta.url)
      .href;
    const openShellHelper = new URL("../helpers/openshell-kubernetes-real.mjs", import.meta.url)
      .href;
    const exited = await runTestScript(`
      import { boundedTeardown } from ${JSON.stringify(kubernetesHelperUrl)};
      import {
        productionTopologyCleanupOrder,
        registerProductionTopologyCleanups,
      } from ${JSON.stringify(topologyHelper)};
      import {
        openShellInstallationCleanupOrder,
        registerOpenShellInstallationCleanups,
      } from ${JSON.stringify(openShellHelper)};
      const attempt = (name) => process.stdout.write("attempted " + name + "\\n");
      for (const [order, register] of [
        [productionTopologyCleanupOrder, registerProductionTopologyCleanups],
        [openShellInstallationCleanupOrder, registerOpenShellInstallationCleanups],
      ]) {
        const hooks = [];
        const { context } = boundedTeardown(
          { after: (hook) => hooks.push(hook) },
          { exitGraceMs: 0, log: () => {}, exit: () => {}, failFile: () => {} },
        );
        await hooks[0]();
        const operations = Object.fromEntries(order.map((name) => [name, () => attempt(name)]));
        try {
          register(context, operations);
          process.stdout.write("not stopped\\n");
        } catch (error) {
          process.stdout.write("stopped: " + /setup stops here/.test(error.message) + "\\n");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    `);
    assert.equal(exited.code, 0, exited.stderr);
    assert.deepEqual(exited.stdout.match(/^stopped: .+$/gm), ["stopped: true", "stopped: true"]);
    assert.doesNotMatch(exited.stdout, /^not stopped$/m);
    // Newest-first, as the teardown would have run them.
    assert.deepEqual(
      exited.stdout.match(/^attempted .+$/gm),
      [
        ...[
          "gatewayForward",
          "worker",
          "productionApp",
          "observerPool",
          "postgresNetwork",
          "gatewayRuntimeNamespace",
          "placementNamespace",
          "temporaryDirectory",
        ],
        ...[
          "workerStop",
          "portForwards",
          "productionApp",
          "observerPool",
          "workloadNamespace",
          "temporaryDirectory",
        ],
      ].map((name) => `attempted ${name}`),
    );
  },
);

test(
  "the production topology bounds the raw node:test context it is given",
  { timeout: 20_000 },
  async () => {
    // Finding 1724: the routing and native admin tests hand arrangeProductionTopology their own
    // node:test context and rely on its withBoundedTeardown call; the stand-in test replaces the
    // whole helper, so nothing else fails if that call goes. Without a controller image, a
    // dedicated topology stops at its first check, before any cluster call.
    const topologyHelper = new URL("../helpers/harness-topology-k3d-real.mjs", import.meta.url)
      .href;
    const env = { ...process.env };
    for (const name of [
      "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE",
      "OCC_TEST_KUBERNETES_KUBECONFIG",
      "OCC_TEST_KUBERNETES_CONTEXT",
      "OPENAI_API_KEY",
    ]) {
      delete env[name];
    }
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { arrangeProductionTopology } from ${JSON.stringify(topologyHelper)};
          const hooks = [];
          const testContext = { name: "topology", after: (hook) => hooks.push(hook) };
          const failure = await arrangeProductionTopology(testContext, "dedicated").then(
            () => "none",
            (error) => error.message.split("\\n")[0],
          );
          await Promise.all(hooks.map((hook) => hook()));
          process.stdout.write("result " + JSON.stringify({ failure, hooks: hooks.length }) + "\\n");
        `,
      ],
      { env, timeout: 15_000 },
    );
    const result = JSON.parse(/^result (.+)$/m.exec(stdout)[1]);
    assert.match(result.failure, /Dedicated storage requires the imported controller image/);
    assert.equal(result.hooks, 1, "one bounded teardown hook, registered before the first check");
  },
);

test(
  "the production topology's cleanups all run when its worker stop rejects",
  { timeout: 20_000 },
  async () => {
    // Finding 1711: the topology's own cleanup registration, in a real node:test process given a
    // raw context, as the routing and native admin tests pass it. The worker stop rejects at once;
    // every later cleanup must still be attempted, the failure kept, and the file must exit by
    // itself (the production app's close releases what holds it). Registering them as one
    // cleanup, as before, would attempt only the gateway forward and the worker stop.
    const topologyHelper = new URL("../helpers/harness-topology-k3d-real.mjs", import.meta.url)
      .href;
    const kubernetesHelper = new URL("../helpers/kubernetes-real.mjs", import.meta.url).href;
    const exited = await runFailingTestScript(`
      import test from "node:test";
      import { withBoundedTeardown } from ${JSON.stringify(kubernetesHelper)};
      import {
        productionTopologyCleanupOrder,
        registerProductionTopologyCleanups,
      } from ${JSON.stringify(topologyHelper)};
      const attempt = (name) => process.stdout.write("attempted " + name + "\\n");
      test("topology", async (testContext) => {
        const context = withBoundedTeardown(testContext, { label: "production topology teardown" });
        const held = setInterval(() => {}, 50);
        const operations = Object.fromEntries(
          productionTopologyCleanupOrder.map((name) => [name, () => attempt(name)]),
        );
        operations.worker = async () => {
          attempt("worker");
          throw new Error("worker stop failed");
        };
        operations.productionApp = () => {
          attempt("productionApp");
          clearInterval(held);
        };
        registerProductionTopologyCleanups(context, operations);
      });
    `);
    assert.deepEqual(exited.stdout.match(/^attempted .+$/gm), [
      "attempted gatewayForward",
      "attempted worker",
      "attempted productionApp",
      "attempted observerPool",
      "attempted postgresNetwork",
      "attempted gatewayRuntimeNamespace",
      "attempted placementNamespace",
      "attempted temporaryDirectory",
    ]);
    assert.match(
      exited.stderr,
      /production topology teardown: cleanup worker registered at harness-topology-k3d-real\.mjs:\d+ failed: worker stop failed/,
    );
    // The test passed; node:test fails it with the worker's own error, retained to the end.
    assert.match(
      exited.stdout,
      /cleanup worker registered at harness-topology-k3d-real\.mjs:\d+: worker stop failed/,
    );
  },
);

// Stands in for tests/helpers/harness-topology-k3d-real.mjs. Its arrangeProductionTopology
// registers cleanups in the helper's order: the platform Namespace delete (which removes the
// worker's ServiceAccount) first, the cluster roles next, and the worker stop last. The delete
// fails, and the worker's poll keeps the file alive until its stop runs.
const topologyStandIn = (exported) => `
  import { appendFileSync } from "node:fs";
  const record = (line) => appendFileSync(process.env.TOPOLOGY_TEARDOWN_RECORD, line + "\\n");
  export async function arrangeProductionTopology(context) {
    const name = context.name;
    let poll = setInterval(() => {}, 50);
    context.after(() => {
      record(name + "\\tplatform Namespace delete with the worker " + (poll ? "running" : "stopped"));
      throw new Error("platform Namespace deletion timed out");
    });
    context.after(() => record(name + "\\tcluster roles delete"));
    context.after(() => {
      record(name + "\\tworker stop");
      clearInterval(poll);
      poll = undefined;
    });
    throw new Error("topology setup failed");
  }
  // The live Slack proof checks both bots before it arranges the topology.
  export async function slackApi(method, token) {
    return method === "auth.test"
      ? { team_id: "T0", user_id: token }
      : { channel: { is_member: true } };
  }
  ${exported
    .filter((name) => !["arrangeProductionTopology", "slackApi"].includes(name))
    .map((name) =>
      name.startsWith("requires")
        ? `export const ${name} = {};`
        : `export function ${name}() { throw new Error("not reached"); }`,
    )
    .join("\n")}
`;

test(
  "every production topology test stops its worker before the platform Namespace delete",
  { timeout: 60_000 },
  async (t) => {
    // Finding 1711 in the topology tests: node:test would run the platform Namespace delete first,
    // under a running worker, and skip the worker stop once the delete failed. Each file runs with
    // the helper replaced by a stand-in; a test that hands arrangeProductionTopology its own
    // node:test context records the delete first, and its file never exits.
    const directory = await temporaryDirectory(t, "occ-topology-teardown-");
    const helper = new URL("../helpers/harness-topology-k3d-real.mjs", import.meta.url);
    const exportList = /^export \{([^}]+)\};$/m.exec(await readFile(helper, "utf8"));
    assert.ok(exportList, "the topology helper ends with one export { ... } list");
    const exported = exportList[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    assert.ok(exported.includes("arrangeProductionTopology"));
    const standIn = join(directory, "topology.mjs");
    await writeFile(standIn, topologyStandIn(exported));
    const hooks = join(directory, "hooks.mjs");
    await writeFile(
      hooks,
      `import { registerHooks } from "node:module";
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const resolved = nextResolve(specifier, context);
          return resolved.url === ${JSON.stringify(helper.href)}
            ? { url: ${JSON.stringify(pathToFileURL(standIn).href)}, shortCircuit: true }
            : resolved;
        },
      });`,
    );
    // Tests per file: each must reach arrangeProductionTopology, so a new test bumps its count.
    const files = {
      "harness-topology-k3d-real.test.mjs": 6,
      "harness-topology-k3d-otel-real.test.mjs": 2,
      "harness-topology-k3d-slack-real.test.mjs": 1,
    };
    // Settle every file before asserting, so no child still writes once the directory is removed.
    const results = await Promise.all(
      Object.entries(files).map(async ([file, tests]) => {
        const record = join(directory, `${file}.log`);
        const env = {
          ...process.env,
          TOPOLOGY_TEARDOWN_RECORD: record,
          OCC_TEST_SLACK_PROXY_URL: "http://127.0.0.1:3128",
          OCC_TEST_SLACK_CHANNEL_ID: "C0",
          OCC_TEST_SLACK_SENDER_BOT_TOKEN: "xoxb-sender",
          SLACK_APP_TOKEN: "xapp-app",
          SLACK_BOT_TOKEN: "xoxb-gateway",
        };
        // Run each file as its own node:test root, not as a child reporting to this runner.
        delete env.NODE_TEST_CONTEXT;
        const exited = await execute(
          process.execPath,
          [
            "--import",
            pathToFileURL(hooks).href,
            fileURLToPath(new URL(`../integration/${file}`, import.meta.url)),
          ],
          { env, timeout: 15_000 },
        ).then(
          () => ({ code: 0, stdout: "", stderr: "" }),
          (error) => error,
        );
        return { file, tests, exited, record: await readFile(record, "utf8").catch(() => "") };
      }),
    );
    for (const { file, tests, exited, record } of results) {
      const steps = record
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t"));
      const names = [...new Set(steps.map(([name]) => name))];
      assert.equal(
        names.length,
        tests,
        `${file} arranged a topology in every test\n${exited.stdout}\n${exited.stderr}`,
      );
      for (const name of names) {
        assert.deepEqual(
          steps.filter(([test]) => test === name).map(([, step]) => step),
          [
            "worker stop",
            "cluster roles delete",
            "platform Namespace delete with the worker stopped",
          ],
          `${file}: ${name}`,
        );
      }
      assert.notEqual(exited.killed, true, `${file} exited on its own`);
      assert.equal(exited.code, 1, `${file} fails its stand-in topology`);
    }
  },
);

test(
  "a failure diagnostic's kubectl reads stop at its deadline",
  { timeout: 20_000 },
  async (t) => {
    // A fake kubectl that records its pid and then stalls for 30 s, like a read on a stalled API
    // server (finding 1557). No cluster is involved.
    const directory = await temporaryDirectory(t, "occ-fake-kubectl-");
    const started = join(directory, "started");
    await writeCommand(directory, "kubectl", `echo "$$" >> '${started}'\nexec sleep 30\n`);
    prependPath(t, directory);
    const { kubectl } = createKubernetesClient({
      selection: { kubeconfigPath: join(directory, "kubeconfig"), kubernetesContext: "fake" },
    });

    const begun = Date.now();
    let work;
    const result = await withinDiagnosticDeadline(
      (signal) =>
        (work = (async () => {
          const first = await kubectl("get", "pods").catch((error) => error);
          // A read the diagnostic starts after its deadline is refused without running kubectl.
          const second = await kubectl("get", "pods").catch((error) => error);
          return { first, second, aborted: signal.aborted, passed: diagnosticDeadlinePassed() };
        })()),
      { timeoutMs: 500, timedOut: "\nDiagnostic timed out" },
    );
    assert.equal(result, "\nDiagnostic timed out");
    const { first, second, aborted, passed } = await work;
    // The stalled kubectl was killed at the deadline instead of running its 30 s.
    assert.equal(first.name, "AbortError");
    assert.equal(second.name, "AbortError");
    assert.ok(aborted && passed);
    assert.ok(Date.now() - begun < 10_000);
    const pids = (await readFile(started, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.ok(pids.length <= 1, `kubectl ran ${pids.length} times`);
    // The read rejects once the kill is sent; the process is gone soon after, not in 30 s.
    const running = (pid) => {
      try {
        process.kill(Number(pid), 0);
        return true;
      } catch (error) {
        assert.equal(error.code, "ESRCH");
        return false;
      }
    };
    // Within 10 s of the diagnostic's start.
    await waitUntil("the stalled kubectl to exit", () => !pids.some(running), {
      timeoutMs: begun + 10_000 - Date.now(),
      intervalMs: 20,
    });
    // Outside a diagnostic nothing has passed a deadline.
    assert.equal(diagnosticDeadlinePassed(), false);
  },
);

test("a nested failure diagnostic stops at the outer deadline", { timeout: 5_000 }, async () => {
  let inner;
  const result = await withinDiagnosticDeadline(
    () =>
      withinDiagnosticDeadline(
        async (signal) => {
          inner = signal;
          await once(signal, "abort");
          return "inner stopped";
        },
        { timeoutMs: 60_000, timedOut: "inner timed out" },
      ),
    { timeoutMs: 50, timedOut: "outer timed out" },
  );
  assert.equal(result, "outer timed out");
  assert.equal(inner.aborted, true);
});

test("a dropped kubectl create counts AlreadyExists on its retry as done", async () => {
  const { sleeps, logs, options } = recordingOptions();
  let calls = 0;
  const output = await retryKubectlWrite(async () => {
    calls += 1;
    // The dropped request was applied; the retry finds its Secret.
    throw kubectlFailure(calls === 1 ? createRequestDropped : secretExists);
  }, options);
  assert.equal(output, "");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [500]);
  assert.equal(logs.length, 1);
});

test("a dropped Namespace delete counts the terminating Conflict on its retry as done", async () => {
  const terminating =
    'Error from server (Conflict): Operation cannot be fulfilled on namespaces "oce-1": The system is ensuring all content is removed from this namespace.  Upon completion, this namespace will automatically be purged by the system.\n';
  let calls = 0;
  const output = await retryKubectlWrite(
    async () => {
      calls += 1;
      throw kubectlFailure(calls === 1 ? "Unable to connect to the server: EOF\n" : terminating);
    },
    { ...recordingOptions().options, applied: namespaceAlreadyTerminating },
  );
  assert.equal(output, "");
  assert.equal(calls, 2);
  // Without a dropped attempt, the Conflict is the delete's real answer.
  const failure = kubectlFailure(terminating);
  await assert.rejects(
    retryKubectlWrite(
      async () => {
        throw failure;
      },
      { ...recordingOptions().options, applied: namespaceAlreadyTerminating },
    ),
    (error) => error === failure,
  );
});

test("a dropped kubectl write still throws any other result of its retry", async () => {
  const { sleeps, options } = recordingOptions();
  const forbidden = kubectlFailure("Error from server (Forbidden): secrets is forbidden\n");
  let calls = 0;
  await assert.rejects(
    retryKubectlWrite(async () => {
      calls += 1;
      throw calls === 1 ? kubectlFailure(createRequestDropped) : forbidden;
    }, options),
    (error) => error === forbidden,
  );
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [500]);
});

test("a kubectl write retries a dropped connection and returns the next attempt's output", async () => {
  const { sleeps, options } = recordingOptions();
  let calls = 0;
  const output = await retryKubectlWrite(async () => {
    calls += 1;
    if (calls === 1) {
      throw kubectlFailure("Unable to connect to the server: EOF\n");
    }
    return 'namespace "oce-1" deleted\n';
  }, options);
  assert.equal(output, 'namespace "oce-1" deleted\n');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [500]);
});

test("a kubectl write fails at once on AlreadyExists or another result", async () => {
  // With no dropped attempt before it, AlreadyExists is the create's real answer.
  for (const stderr of [
    secretExists,
    'Error from server (NotFound): namespaces "oce-1" not found\n',
    "Error from server (Forbidden): secrets is forbidden\n",
  ]) {
    const { sleeps, options } = recordingOptions();
    const failure = kubectlFailure(stderr);
    let calls = 0;
    await assert.rejects(
      retryKubectlWrite(async () => {
        calls += 1;
        throw failure;
      }, options),
      (error) => error === failure,
      stderr,
    );
    assert.equal(calls, 1, stderr);
    assert.deepEqual(sleeps, [], stderr);
  }
});

test(
  "a kubectl write gives up after four dropped attempts with the last error",
  { timeout: 5_000 },
  async () => {
    const { sleeps, options } = recordingOptions();
    const failures = [];
    await assert.rejects(
      retryKubectlWrite(async () => {
        const failure = kubectlFailure(createRequestDropped);
        failures.push(failure);
        throw failure;
      }, options),
      (error) => error === failures.at(-1),
    );
    assert.equal(failures.length, 4);
    assert.deepEqual(sleeps, [500, 1000, 2000]);
  },
);

// Stands in for `kubectl exec <pod> -- node <script> ...`: kubectl reports a
// remote command's non-zero exit on stderr and exits with the same code.
async function fakeKubectlExec(script, ...args) {
  try {
    const { stdout } = await execute(process.execPath, [script, ...args], { timeout: 10_000 });
    return stdout;
  } catch (error) {
    if (typeof error.code === "number") {
      error.stderr = `${error.stderr}command terminated with exit code ${error.code}\n`;
    }
    throw error;
  }
}

// A loopback port that refuses connections until the test ends. A released port could be
// taken by a test running in parallel, and the probe would then connect.
async function refusingLoopbackPort(t) {
  const refusing = await refusingPort();
  t.after(() => refusing.release());
  return refusing.port;
}

const quiet = { sleep: async () => {}, log: () => {} };

test("the probe's own refused connection passes a deny check", async (t) => {
  const port = await refusingLoopbackPort(t);
  const denial = await assertProbeDenied(
    "refused loopback traffic",
    () => fakeKubectlExec(probeScript, "tcp", "127.0.0.1", String(port)),
    quiet,
  );
  assert.deepEqual(denial, { denied: true, code: "ECONNREFUSED" });
});

test("a connected probe fails a deny check", async (context) => {
  const server = createServer((socket) => socket.end());
  await listen(context, server);
  await assert.rejects(
    assertProbeDenied(
      "open loopback traffic",
      () => fakeKubectlExec(probeScript, "tcp", "127.0.0.1", String(server.address().port)),
      quiet,
    ),
    (error) => error.code === "ERR_ASSERTION" && /unexpectedly succeeded/.test(error.message),
  );
});

test("a deny check fails when the probe never reports a denial", async () => {
  const missingScript = fileURLToPath(new URL("./missing-probe.mjs", import.meta.url));
  const execStreamDroppedEveryTime = async () => {
    throw kubectlFailure(execStreamDropped);
  };
  for (const [reason, run] of [
    ["exec stream dropped on every attempt", execStreamDroppedEveryTime],
    ["missing probe script", () => fakeKubectlExec(missingScript, "tcp", "127.0.0.1", "1")],
    // A name that cannot resolve fails before any connection attempt.
    ["DNS failure", () => fakeKubectlExec(probeScript, "tcp", "probe.invalid", "80")],
    ["unsupported operation", () => fakeKubectlExec(probeScript, "udp", "127.0.0.1", "1")],
  ]) {
    await assert.rejects(
      assertProbeDenied(reason, run, quiet),
      (error) => error.code !== "ERR_ASSERTION" && /did not report a denial/.test(error.message),
      reason,
    );
  }
});

test("a deny check retries a dropped exec stream and accepts the probe's denial", async (t) => {
  const port = await refusingLoopbackPort(t);
  let calls = 0;
  const denial = await assertProbeDenied(
    "refused loopback traffic after a dropped stream",
    async () => {
      calls += 1;
      if (calls === 1) {
        throw kubectlFailure(execStreamDropped);
      }
      return fakeKubectlExec(probeScript, "tcp", "127.0.0.1", String(port));
    },
    quiet,
  );
  assert.equal(calls, 2);
  assert.equal(denial.code, "ECONNREFUSED");
});

test("only the probe's denial exit code with its stdout report is a denial", () => {
  const terminated = `command terminated with exit code ${PROBE_DENIED_EXIT_CODE}\n`;
  const report = '{"denied":true,"code":"ETIMEDOUT"}\n';
  assert.deepEqual(
    probeDenial(
      Object.assign(kubectlFailure(terminated, PROBE_DENIED_EXIT_CODE), { stdout: report }),
    ),
    { denied: true, code: "ETIMEDOUT" },
  );
  for (const error of [
    // The denial exit code without the probe's report, or kubectl's own exit.
    Object.assign(kubectlFailure(terminated, PROBE_DENIED_EXIT_CODE), { stdout: "" }),
    Object.assign(kubectlFailure("error: EOF\n", PROBE_DENIED_EXIT_CODE), { stdout: report }),
    // The report with a generic probe failure exit.
    Object.assign(kubectlFailure("command terminated with exit code 1\n"), { stdout: report }),
  ]) {
    assert.equal(probeDenial(error), undefined, error.message);
  }
});

// The Gateway container does not mount the probe fixture, so the Gateway
// connect check (finding 335) runs probe.mjs from its source text.
async function fakeKubectlExecInline(source, ...probeArguments) {
  const [node, ...args] = inlineProbeCommand(source, ...probeArguments);
  assert.equal(node, "node");
  return fakeKubectlExec(...args);
}

test("the inline probe's refused connection passes a deny check", async (t) => {
  const source = await readFile(probeScript, "utf8");
  const port = await refusingLoopbackPort(t);
  const denial = await assertProbeDenied(
    "refused inline loopback traffic",
    () => fakeKubectlExecInline(source, "tcp", "127.0.0.1", port),
    quiet,
  );
  assert.deepEqual(denial, { denied: true, code: "ECONNREFUSED" });
});

test("an inline deny check fails unless the probe reports a denial", async (t) => {
  const source = await readFile(probeScript, "utf8");
  const port = await refusingLoopbackPort(t);
  // Reproduces the Gateway one-liner this replaced (not the inline probe): it
  // exits 1 on any socket error, a DNS error included.
  const exitOnAnyError = `const s=require('node:net').connect({host:process.argv[1],port:Number(process.argv[2])}); s.on('connect',()=>process.exit(0)); s.on('error',()=>process.exit(1));`;
  for (const [reason, run] of [
    [
      "exec stream dropped on every attempt",
      async () => {
        throw kubectlFailure(execStreamDropped);
      },
    ],
    [
      "missing probe script",
      () => fakeKubectlExecInline('import "./missing-probe.mjs";', "tcp", "127.0.0.1", port),
    ],
    ["DNS failure", () => fakeKubectlExecInline(source, "tcp", "probe.invalid", 18790)],
    [
      "a script that exits 1 on any error",
      () => fakeKubectlExec("-e", exitOnAnyError, "127.0.0.1", String(port)),
    ],
  ]) {
    await assert.rejects(
      assertProbeDenied(reason, run, quiet),
      (error) => error.code !== "ERR_ASSERTION" && /did not report a denial/.test(error.message),
      reason,
    );
  }
});
