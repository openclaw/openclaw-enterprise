import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertProbeDenied,
  inlineProbeCommand,
  isTransientKubectlFailure,
  PROBE_DENIED_EXIT_CODE,
  probeDenial,
  retryKubectlRead,
} from "../helpers/kubernetes-real.mjs";
import { refusingPort } from "../helpers/available-port.mjs";

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
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
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
