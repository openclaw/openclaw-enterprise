import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { isTransientPullFailure, pullImage } from "../../scripts/ci/image-pull.mjs";
import { fetchPinnedBytes, isTransientFetchError } from "../../scripts/ci/routing.mjs";

const image =
  "docker.io/otel/opentelemetry-collector-contrib:0.159.0@sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc";

function pullFailure(stderr, properties = {}) {
  return Object.assign(new Error(`docker pull ${image} failed: ${stderr}`), {
    stderr,
    exitCode: 1,
    ...properties,
  });
}

test("image pulls retry only registry and network blips", () => {
  for (const stderr of [
    "Error response from daemon: toomanyrequests: You have reached your pull rate limit.",
    "Error response from daemon: received unexpected HTTP status: 503 Service Unavailable",
    'Error response from daemon: Head "https://registry-1.docker.io/v2/otel/manifests/sha256:1f2c": 502 Bad Gateway',
    "error pulling image configuration: download failed after attempts=6: read tcp 10.1.0.4:443: read: connection reset by peer",
    'Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout',
    'Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp 3.94.224.37:443: i/o timeout',
    'Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)',
    "error pulling image configuration: unexpected EOF",
    'Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: no such host',
    'Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp 3.94.224.37:443: connect: connection refused',
    'Error response from daemon: Get "https://registry-1.docker.io/v2/": EOF',
  ]) {
    assert.equal(isTransientPullFailure(pullFailure(stderr)), true, stderr);
  }
  assert.equal(isTransientPullFailure(pullFailure("", { timedOut: true })), true);

  for (const stderr of [
    "Error response from daemon: manifest for otel/opentelemetry-collector-contrib@sha256:1f2c not found: manifest unknown: manifest unknown",
    "Error response from daemon: pull access denied for example/private, repository does not exist or may require 'docker login': denied: requested access to the resource is denied",
    'Error response from daemon: Head "https://ghcr.io/v2/example/manifests/sha256:1f2c": unauthorized',
    "filesystem layer verification failed for digest sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc",
    'failed commit on ref "layer-sha256:1f2c": unexpected commit digest sha256:0000, expected sha256:1f2c: failed precondition',
    "invalid reference format",
    // A permanent cause wins even when the registry also answered 503.
    "received unexpected HTTP status: 503 Service Unavailable; manifest unknown",
    // Unrecognized failures fail fast.
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    "x509: certificate signed by unknown authority",
    "",
  ]) {
    assert.equal(isTransientPullFailure(pullFailure(stderr)), false, stderr);
  }
  const missingBinary = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
  assert.equal(isTransientPullFailure(missingBinary), false);
  // The image reference is in the message, never in stderr: a 5xx-looking tag
  // or digest must not make a permanent failure transient.
  assert.equal(
    isTransientPullFailure(
      Object.assign(new Error("docker pull example/app:http-503 failed: denied"), {
        stderr: "denied",
      }),
    ),
    false,
  );
});

function scriptedPull(outcomes) {
  const calls = [];
  const execFile = async (command, args, options) => {
    calls.push({ command, args, options });
    const outcome = outcomes[calls.length - 1];
    if (outcome instanceof Error) {
      throw outcome;
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, execFile };
}

test("pullImage retries transient failures with backoff and a per-attempt timeout", async () => {
  const sleeps = [];
  const logs = [];
  const { calls, execFile } = scriptedPull([
    pullFailure("toomanyrequests: You have reached your pull rate limit."),
    pullFailure("", { timedOut: true }),
  ]);

  await pullImage(image, {
    execFile,
    docker: "podman",
    sleep: async (ms) => sleeps.push(ms),
    log: (message) => logs.push(message),
  });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.command, "podman");
    assert.deepEqual(call.args, ["pull", image]);
    assert.equal(call.options.timeoutMs, 300_000);
  }
  assert.deepEqual(sleeps, [5_000, 10_000]);
  assert.match(logs[0], /toomanyrequests.*attempt 2\/4/);
  assert.match(logs[1], /timed out after 300000 ms.*attempt 3\/4/);
});

test("pullImage fails a permanent failure on the first attempt with the original error", async () => {
  const failure = pullFailure("manifest unknown: manifest unknown");
  const { calls, execFile } = scriptedPull([failure]);

  await assert.rejects(
    pullImage(image, { execFile, sleep: async () => assert.fail("must not retry") }),
    (error) => error === failure,
  );
  assert.equal(calls.length, 1);
});

test("pullImage stops at its attempt limit and its retry budget", async () => {
  const outage = () => pullFailure("received unexpected HTTP status: 503 Service Unavailable");
  const limited = scriptedPull([outage(), outage(), outage(), outage(), outage()]);
  await assert.rejects(
    pullImage(image, { execFile: limited.execFile, sleep: async () => {}, log: () => {} }),
    /503 Service Unavailable/,
  );
  assert.equal(limited.calls.length, 4);

  // With an instant sleep, the second backoff (10 s) alone passes an 8 s budget.
  const budgeted = scriptedPull([outage(), outage(), outage()]);
  await assert.rejects(
    pullImage(image, {
      execFile: budgeted.execFile,
      budgetMs: 8_000,
      sleep: async () => {},
      log: () => {},
    }),
    /503/,
  );
  assert.equal(budgeted.calls.length, 2);
});

async function flakyServer(t, handlers) {
  let requests = 0;
  const server = createServer((request, response) => {
    const handler = handlers[Math.min(requests, handlers.length - 1)];
    requests += 1;
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/artifact.yaml`,
    requests: () => requests,
  };
}

const answer =
  (status, body = "") =>
  (_request, response) => {
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(body);
  };
const reset = (request) => request.socket.destroy();
const hang = () => {};
const quick = { firstDelayMs: 1, attemptTimeoutMs: 1_000 };

test("fetchPinnedBytes retries 5xx, resets and timeouts, then returns the body", async (t) => {
  const server = await flakyServer(t, [answer(503), reset, hang, answer(200, "pinned")]);

  const data = await fetchPinnedBytes({ name: "artifact", url: server.url }, quick);

  assert.equal(data.toString(), "pinned");
  assert.equal(server.requests(), 4);
});

test("fetchPinnedBytes fails a 404 at once", async (t) => {
  const server = await flakyServer(t, [answer(404), answer(200, "late")]);

  await assert.rejects(
    fetchPinnedBytes({ name: "artifact", url: server.url }, quick),
    /artifact download failed: HTTP 404 after 1 attempt\(s\)/,
  );
  assert.equal(server.requests(), 1);
});

test("fetchPinnedBytes keeps the original error and does not retry non-network errors", async () => {
  await assert.rejects(fetchPinnedBytes({ name: "artifact", url: "not a url" }, quick), (error) => {
    assert.match(error.message, /artifact download failed: .* after 1 attempt\(s\)/);
    assert.ok(error.cause instanceof TypeError);
    return true;
  });
});

test("fetchPinnedBytes keeps the last network error as cause when retries run out", async (t) => {
  const server = await flakyServer(t, [reset]);

  await assert.rejects(
    fetchPinnedBytes({ name: "artifact", url: server.url }, { ...quick, attempts: 2 }),
    (error) => {
      assert.match(error.message, /after 2 attempt\(s\)/);
      assert.equal(isTransientFetchError(error.cause), true);
      return true;
    },
  );
  assert.equal(server.requests(), 2);
});

test("fetch error classification retries only connection and timeout failures", () => {
  const wrapped = (code) =>
    new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
  for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"]) {
    assert.equal(isTransientFetchError(wrapped(code)), true, code);
  }
  const multiAddress = new TypeError("fetch failed", {
    cause: new AggregateError([Object.assign(new Error("refused"), { code: "ECONNREFUSED" })]),
  });
  assert.equal(isTransientFetchError(multiAddress), true);
  assert.equal(
    isTransientFetchError(new DOMException("The operation timed out.", "TimeoutError")),
    true,
  );
  for (const code of ["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_INVALID_URL"]) {
    assert.equal(isTransientFetchError(wrapped(code)), false, code);
  }
  assert.equal(isTransientFetchError(new TypeError("fetch failed")), false);
  assert.equal(isTransientFetchError(new RangeError("bad option")), false);
});
