import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { CODEX_FAILURE_OUTPUT_CLASS_HELPER } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { CODEX_FAILURE_OUTPUT_CLASSES } from "../../packages/contracts/src/runtime-failure.mjs";
import {
  checkCodexStartup,
  createCodexStartup,
  login,
  probe,
  timedOut,
} from "../fixtures/codex-native-startup.mjs";

const ready = {
  phases: [
    ["codex-login", "ok"],
    ["model-probe", "ok"],
    ["native-spawn", "ok"],
  ],
  code: "READY",
};
function loginFailure(code = "LOGIN_FAILED") {
  return { phases: [["codex-login", "failed"]], check: "login", code };
}
function probeFailure(cause, provider) {
  return {
    phases: [
      ["codex-login", "ok"],
      ["model-probe", "failed"],
    ],
    check: "model-probe",
    code: "MODEL_PROBE_FAILED",
    cause,
    provider,
  };
}

const probeTimeout = { ...probeFailure(), code: "MODEL_PROBE_TIMEOUT" };
const probeAuthenticationFailure = { ...probeFailure(), code: "AUTHENTICATION_FAILED" };

const errorEvent = (message) => ({ type: "error", message });
const failedTurn = (message) => ({ type: "turn.failed", error: { message } });

// Component conformance: scripted native output, real generated entrypoint and status handler.
test("Codex runtime gates startup and readiness on a successful native authentication turn", async (t) => {
  const started = { type: "turn.started" };
  const assistant = { type: "item.completed", item: { type: "agent_message", text: "READY" } };
  const completed = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
  const advisory = {
    type: "item.completed",
    item: errorEvent("Model catalog metadata unavailable"),
  };
  const recoveredStreamError = errorEvent(
    "Reconnecting... 1/3 stream disconnected before completion",
  );
  const recoveredRetryingSamplingError = errorEvent(
    "Reconnecting... 2/3 stream disconnected - retrying sampling request",
  );
  const completedTurn = (...events) => [started, ...events, assistant, completed];
  const scenarios = [
    {
      name: "protected profile without enrollment refuses before any native process",
      protectedInference: "missing",
      native: [],
    },
    {
      name: "protected probe retains zero retry settings despite ignoring user config",
      protectedInference: "signed",
      events: completedTurn(),
      expect: ready,
    },
    {
      name: "protected probe timeout never starts a second business request",
      protectedInference: "signed",
      native: [login(), probe([], timedOut, 30000)],
      expect: probeTimeout,
    },
    {
      name: "protected probe refuses an unexpected native stream retry",
      protectedInference: "signed",
      events: completedTurn(recoveredStreamError),
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "error-event" }),
    },
    {
      // Finding 1599: a protected profile retries nothing, so a transient failure that earns
      // an unprotected probe its one retry is held at once, after one business request.
      name: "protected transient probe error never starts a second business request",
      protectedInference: "signed",
      native: [login(), probe([started, errorEvent("connection refused")], { status: 1 })],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "error-event" }),
    },
    {
      name: "protected transient failed turn never starts a second business request",
      protectedInference: "signed",
      native: [
        login(),
        probe([started, failedTurn("unexpected status 502: upstream")], { status: 1 }),
      ],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "turn-failed" }, { status: 502 }),
    },
    {
      name: "provider PAT placeholder uses native auth storage before the model probe",
      providerPat: true,
      events: completedTurn(),
      expect: ready,
    },
    {
      name: "provider PAT metadata rejection keeps the revision unready",
      providerPat: true,
      native: [
        login({
          status: 1,
          stderr: "personal access token metadata request failed with status 401 Unauthorized",
        }),
      ],
      expect: loginFailure("AUTHENTICATION_FAILED"),
      loginClasses: ["http_401_403"],
    },
    {
      name: "verifier-only app server starts without exposing either token input",
      transportToken: "verifier",
      events: completedTurn(),
      expect: ready,
    },
    {
      name: "delayed retry uses only the remaining budget",
      native: [login(), probe([], timedOut, 30000), probe([], timedOut, 500)],
      retryAfterMs: 30500,
      expect: probeTimeout,
      probeCodes: ["MODEL_PROBE_TIMEOUT", "MODEL_PROBE_TIMEOUT"],
    },
    {
      name: "expired retry budget starts no process",
      native: [login(), probe([], timedOut, 30000)],
      retryAfterMs: 32000,
      expect: probeTimeout,
      probeCodes: ["MODEL_PROBE_TIMEOUT"],
    },
    {
      name: "tool output followed by timeout is not retried",
      events: [started, { type: "item.completed", item: { type: "command_execution" } }],
      result: {
        error: { code: "ETIMEDOUT" },
      },
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "tool-event" }),
    },
    {
      name: "rejection followed by timeout is not retried",
      events: [errorEvent("authentication rejected")],
      result: {
        error: { code: "ETIMEDOUT" },
      },
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "error-event" }),
    },
    {
      name: "malformed output followed by timeout is not retried",
      events: [],
      result: { error: { code: "ETIMEDOUT" }, stdout: "not-json" },
      expect: probeFailure({ kind: "INVALID_OUTPUT", detail: "json" }),
    },
    {
      name: "model timeout recovers on the second attempt",
      native: [login(), probe([], timedOut, 30000), probe(completedTurn())],
      retryAfterMs: 1000,
      expect: ready,
      probeCodes: ["MODEL_PROBE_TIMEOUT", "READY"],
    },
    {
      name: "model timeout exhausts two attempts",
      native: [login(), probe([], timedOut, 30000), probe([], timedOut, 30000)],
      retryAfterMs: 1000,
      expect: probeTimeout,
      probeCodes: ["MODEL_PROBE_TIMEOUT", "MODEL_PROBE_TIMEOUT"],
    },
    {
      name: "malformed model output is not retried",
      events: [],
      result: { stdout: "not-json" },
      expect: probeFailure({ kind: "INVALID_OUTPUT", detail: "json" }),
    },
    {
      name: "non-event model output is not retried",
      events: [],
      result: { stdout: "null" },
      expect: probeFailure({ kind: "INVALID_OUTPUT", detail: "shape" }),
    },
    { name: "failed login", native: [login({ status: 1 })], expect: loginFailure() },
    {
      name: "API-key login timeout is not retried",
      native: [login(timedOut)],
      expect: loginFailure(),
    },
    {
      name: "access-token spawn failure is not retried",
      loginMode: "codex_pat",
      native: [login({ status: null, error: { code: "ENOENT" } })],
      expect: loginFailure(),
      loginClasses: ["empty"],
    },
    {
      name: "access-token login refusal is not retried",
      loginMode: "codex_pat",
      native: [login({ status: 1 })],
      expect: loginFailure(),
      loginClasses: ["empty"],
    },
    {
      // Native text observed from codex-cli 0.154 with a revoked access token.
      name: "access-token login credential rejection is a deterministic authentication failure",
      loginMode: "codex_pat",
      native: [
        login({
          status: 1,
          stderr:
            "Error logging in with access token: personal access token metadata request failed with status 403 Forbidden\n",
        }),
      ],
      expect: loginFailure("AUTHENTICATION_FAILED"),
      loginClasses: ["http_401_403"],
    },
    {
      // Finding 2017: a transport error is a reliability failure, retried before it is held.
      name: "access-token login transport error is retried, then held as a login failure",
      loginMode: "codex_pat",
      native: Array.from({ length: 5 }, () =>
        login({
          status: 1,
          stderr:
            "Error logging in with access token: failed to request personal access token metadata: error sending request for url (https://auth.openai.com/)\n",
        }),
      ),
      expect: loginFailure(),
      loginClasses: ["network", "network", "network", "network", "network"],
      loginPauses: [1000, 2000, 4000, 8000],
    },
    {
      name: "access-token login recovers one timeout before probing",
      loginMode: "codex_pat",
      native: [login(timedOut), login(), probe(completedTurn())],
      expect: ready,
      loginClasses: ["timeout"],
    },
    {
      name: "access-token login stops after three timeouts",
      loginMode: "codex_pat",
      native: [login(timedOut, 30000), login(timedOut, 30000), login(timedOut, 30000)],
      expect: loginFailure(),
      loginClasses: ["timeout", "timeout", "timeout"],
    },
    {
      name: "service account token uses native access-token login before probe and clears credentials",
      loginMode: "codex_pat",
      events: completedTurn(),
      expect: ready,
    },
    {
      name: "nonfatal advisory followed by completed assistant turn",
      events: completedTurn(advisory),
      expect: ready,
    },
    {
      name: "recovered native stream error during active turn",
      events: completedTurn(recoveredStreamError),
      expect: ready,
    },
    {
      name: "recovered native sampling retry error during active turn",
      events: completedTurn(recoveredRetryingSamplingError),
      expect: ready,
    },
    {
      name: "fatal top-level error despite assistant output",
      events: [started, assistant, errorEvent("authentication failed"), completed],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "error-event" }),
    },
    {
      name: "reconnecting error with auth marker remains fatal",
      events: completedTurn(
        errorEvent("Reconnecting... 1/3 stream disconnected before completion after 401 auth"),
      ),
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "error-event" }),
    },
    {
      name: "recovered native stream error with provider detail during active turn",
      events: completedTurn(
        errorEvent(
          "Reconnecting... 1/5 (stream disconnected before completion: connection reset by peer)",
        ),
      ),
      expect: ready,
    },
    {
      name: "reconnecting error after completed turn remains fatal",
      events: [started, assistant, completed, recoveredStreamError],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "error-event" }),
    },
    {
      name: "reconnecting error before the turn starts remains fatal",
      events: [recoveredStreamError, started, assistant, completed],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "error-event" }),
    },
    ...[
      [
        "with auth detail",
        "Reconnecting... 1/3 stream disconnected before completion: 401 Unauthorized",
      ],
      [
        "with credential detail",
        "Reconnecting... 1/3 stream disconnected before completion: invalid credential",
      ],
      ["with an unknown reason", "Reconnecting... 1/3 request failed with status 500", 500],
      ["with trailing reason text", "Reconnecting... 1/3 stream disconnected before completionist"],
      ["not at the start", "Error: Reconnecting... 1/3 stream disconnected before completion"],
      ["past its retry limit", "Reconnecting... 4/3 stream disconnected before completion"],
      ["above the retry budget", "Reconnecting... 1/50 stream disconnected before completion"],
      ["with a zero attempt", "Reconnecting... 0/3 stream disconnected before completion"],
    ].map(([description, message, status]) => ({
      name: `reconnecting error ${description} remains fatal`,
      events: completedTurn(errorEvent(message)),
      expect: probeFailure(
        { kind: "PROBE_STATUS", detail: "error-event" },
        status ? { status } : undefined,
      ),
    })),
    {
      name: "unbounded reconnecting errors remain fatal",
      events: completedTurn(...Array.from({ length: 11 }, () => recoveredStreamError)),
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "error-event" }),
    },
    {
      name: "failed turn",
      events: [started, assistant, failedTurn("authentication failed")],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "turn-failed" }),
    },
    {
      // Native terminal event observed from codex-cli 0.154 with an invalid API key.
      name: "provider credential rejection is a deterministic authentication failure",
      events: [
        started,
        errorEvent("unexpected status 401 Unauthorized: Incorrect API key provided"),
        failedTurn("unexpected status 401 Unauthorized: Incorrect API key provided"),
      ],
      result: { status: 1 },
      expect: probeAuthenticationFailure,
    },
    // A provider usage limit, quota or 429 is rate_limit, not a generic error-event or
    // failed turn. The log line keeps the HTTP status and a known code, never the text.
    {
      // Native text for an exhausted ChatGPT-plan Codex usage limit.
      name: "usage limit error event is a rate limit",
      events: [
        started,
        errorEvent(
          "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again in 3 days.",
        ),
        failedTurn("You've hit your usage limit."),
      ],
      result: { status: 1 },
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "rate_limit" }),
    },
    {
      name: "usage limit with a provider status and code is a rate limit",
      events: [
        started,
        errorEvent(
          'unexpected status 429 Too Many Requests: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached for fixture-api-key"}}',
        ),
      ],
      result: { status: 1 },
      expect: probeFailure(
        { kind: "PROBE_STATUS", detail: "rate_limit" },
        { status: 429, code: "usage_limit_reached" },
      ),
    },
    {
      name: "exhausted 429 retries in a failed turn are a rate limit",
      events: [
        started,
        failedTurn("exceeded retry limit, last status: 429 Too Many Requests, request id: req_1"),
      ],
      result: { status: 1 },
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "rate_limit" }, { status: 429 }),
    },
    {
      name: "exceeded API quota is a rate limit",
      events: [
        started,
        errorEvent(
          "Quota exceeded: You exceeded your current quota, please check your plan and billing details. (insufficient_quota)",
        ),
      ],
      result: { status: 1 },
      expect: probeFailure(
        { kind: "PROBE_STATUS", detail: "rate_limit" },
        { code: "insufficient_quota" },
      ),
    },
    {
      // Native text when a workspace owner's spend cap blocks the account.
      name: "workspace spend cap is a rate limit",
      events: [
        started,
        errorEvent(
          "You've reached the spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
        ),
      ],
      result: { status: 1 },
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "rate_limit" }),
    },
    {
      name: "local disk quota is not a provider rate limit",
      events: [started, errorEvent("failed to write session: Disk quota exceeded")],
      result: { status: 1 },
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "error-event" }),
    },
    {
      name: "completed turn without visible assistant",
      events: [started, advisory, completed],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "no-reply" }),
    },
    {
      // Provider text that echoes the credential never reaches the cause.
      name: "provider text in a failed turn stays out of the cause",
      events: [
        started,
        failedTurn("unexpected status 400 Bad Request: model rejected for fixture-api-key"),
      ],
      result: { status: 1 },
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "turn-failed" }, { status: 400 }),
    },
    {
      name: "a missing model is not retried",
      events: [
        started,
        failedTurn(
          'unexpected status 404 Not Found: {"error":{"code":"model_not_found","message":"no such model"}}',
        ),
      ],
      result: { status: 1 },
      expect: probeFailure(
        { kind: "PROBE_STATUS", detail: "turn-failed" },
        { status: 404, code: "model_not_found" },
      ),
    },
    {
      name: "a server error naming the credential is not retried",
      events: [started, failedTurn("unexpected status 500: invalid api key for this server")],
      result: { status: 1 },
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "turn-failed" }, { status: 500 }),
    },
    {
      name: "a rate limit with an overload marker is not retried",
      events: [started, failedTurn("rate limit reached while servers are overloaded")],
      result: { status: 1 },
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "rate_limit" }),
    },
    {
      // spawnSync kills a probe whose output overflows; that is not an outside kill.
      name: "a probe killed for oversized output is not retried",
      events: [],
      result: { status: null, signal: "SIGKILL", error: { code: "ENOBUFS" } },
      expect: probeFailure({ kind: "PROCESS_EXIT", detail: "error-ENOBUFS" }),
    },
    {
      name: "tool event despite completed assistant turn",
      events: completedTurn({
        type: "item.completed",
        item: { type: "command_execution", command: "echo READY", exit_code: 0 },
      }),
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "tool-event" }),
    },
    {
      name: "nonzero native exit despite completed assistant turn",
      events: completedTurn(),
      result: { status: 1 },
      expect: probeFailure({ kind: "PROCESS_EXIT", detail: "exit-1" }),
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, (t) => {
      return checkCodexStartup(t, scenario);
    });
  }
});

// Finding 1576: one provider 5xx or dropped stream must not fail a deployment for good.
// A transient failure gets the single retry a model timeout gets, inside the same 61 s
// budget; the held cause is the last attempt's, marked as retried.
// Finding 2412: Codex runs hook commands outside its sandbox with its own environment, and
// sandboxed commands with the environment shell_environment_policy shapes. The sandbox
// cannot read the hook directory, so its commands keep the CA path the Pod set.
test("Codex app-server gives sandboxed commands the Pod's CA path, never the hook directory's", (t) => {
  const hookCa = "/home/node/.oce-native-hooks/gateway-ca.pem";
  const podCa = "/run/oce/repository-credentials/sessions/session/ca-bundle.pem";
  const readyTurn = probe([
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "READY" } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ]);
  for (const [name, shellCa, expected] of [
    ["without a hook CA copy, Codex keeps its settings", undefined, []],
    [
      "a Pod CA reaches sandboxed commands",
      podCa,
      ["-c", "shell_environment_policy.set.NODE_EXTRA_CA_CERTS=" + JSON.stringify(podCa)],
    ],
    [
      "without a Pod CA, sandboxed commands get none",
      "",
      ["-c", 'shell_environment_policy.exclude=["NODE_EXTRA_CA_CERTS"]'],
    ],
  ]) {
    const runtime = createCodexStartup(t, {
      native: [login(), readyTurn],
      environment: {
        NODE_EXTRA_CA_CERTS: hookCa,
        ...(shellCa === undefined ? {} : { OPENCLAW_SHELL_NODE_EXTRA_CA_CERTS: shellCa }),
      },
    });
    runtime.start();
    runtime.assertNativeScriptConsumed();
    assert.equal(runtime.appServerSpawns.length, 1, name);
    const [{ args, env }] = runtime.appServerSpawns;
    const caArguments = args.flatMap((argument, index) =>
      argument.includes("NODE_EXTRA_CA_CERTS") ? [args[index - 1], argument] : [],
    );
    assert.deepEqual(caArguments, expected, name);
    // Hook commands inherit the app-server's own environment.
    assert.equal(env.NODE_EXTRA_CA_CERTS, hookCa, name);
    assert.equal(Object.hasOwn(env, "OPENCLAW_SHELL_NODE_EXTRA_CA_CERTS"), false, name);
  }
});

test("Codex runtime retries a transient startup model probe failure once", async (t) => {
  const started = { type: "turn.started" };
  const assistant = { type: "item.completed", item: { type: "agent_message", text: "READY" } };
  const completed = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
  const success = probe([started, assistant, completed]);
  const failedWith = (message, elapsed) =>
    probe([started, failedTurn(message)], { status: 1 }, undefined, elapsed);
  const erroredWith = (message) => probe([started, errorEvent(message)], { status: 1 });
  const killed = probe([], { status: null, signal: "SIGKILL" });
  const recoveredNotice = errorEvent("Reconnecting... 1/3 stream disconnected before completion");
  // Finding 1618: the pinned Codex build prints this for a provider it cannot connect to
  // (refused, unresolvable or failed TLS alike) and keeps waiting until the probe times out.
  // Finding 1621: only this exact text is transient; any other cause is held.
  const networkWait = (cause = "Connection failed: error sending request") =>
    errorEvent(`Reconnecting... waiting for network (${cause})`);
  const unreachable = probe([started, networkWait(), networkWait()], timedOut, 30000);
  // Each transient class, by the one marker that makes it transient.
  const transient = [
    [
      "a provider 5xx",
      failedWith("unexpected status 502: upstream"),
      "turn-failed",
      { status: 502 },
    ],
    [
      "the lowest provider 5xx",
      failedWith("unexpected status 500"),
      "turn-failed",
      { status: 500 },
    ],
    [
      "a provider server error",
      erroredWith('{"error":{"type":"server_error"}}'),
      "error-event",
      { code: "server_error" },
    ],
    [
      "an overloaded provider",
      erroredWith('{"error":{"type":"overloaded_error"}}'),
      "error-event",
      { code: "overloaded_error" },
    ],
    ["a model at capacity", failedWith("Selected model is at capacity."), "turn-failed"],
    [
      "provider high demand",
      failedWith("We're currently experiencing high demand, which may cause temporary errors."),
      "turn-failed",
    ],
    [
      "a dropped stream",
      failedWith("stream disconnected before completion: response ended early"),
      "turn-failed",
    ],
    [
      "a transport error",
      erroredWith("error sending request for url (https://api.openai.com/v1/responses)"),
      "error-event",
    ],
    ["a failed connection", erroredWith("connection refused"), "error-event"],
    // Codex's HTTP client names no cause for a failed connection, so a DNS or TLS
    // failure reported this way cannot be told from a transient one.
    [
      "a failed connection that names no cause",
      erroredWith("Connection failed: error sending request"),
      "error-event",
    ],
    [
      "a DNS lookup that may recover",
      failedWith(
        "stream disconnected before completion: failed to lookup address information: Try again",
      ),
      "turn-failed",
    ],
    ["a broken pipe", erroredWith("broken pipe"), "error-event"],
    ["a reset connection", erroredWith("Connection reset by peer (os error 104)"), "error-event"],
    [
      "a closed connection",
      erroredWith("connection closed before message completed"),
      "error-event",
    ],
    [
      "a failed connection that names its cause",
      erroredWith("Connection failed: tcp connect error"),
      "error-event",
    ],
    ["an unreachable provider", unreachable, "error-event"],
    ["a killed probe", killed, "signal-SIGKILL", undefined, "PROCESS_EXIT"],
    [
      "a terminated probe",
      probe([], { status: null, signal: "SIGTERM" }),
      "signal-SIGTERM",
      undefined,
      "PROCESS_EXIT",
    ],
  ];
  // Findings 1601 and 1602: each of these fails the same way again, even with a
  // transient word in its text, so it is held at once without a second model call.
  // The messages follow what the pinned Codex build prints for each failure.
  const heldAtOnce = [
    [
      "a provider 404 that says overloaded",
      failedWith(
        "unexpected status 404 Not Found: overloaded, url: https://provider.example/v1/responses",
      ),
      "turn-failed",
      { status: 404 },
    ],
    [
      "a provider 402 with a server error body",
      failedWith(
        'unexpected status 402 Payment Required: {"error":{"type":"server_error"}}, url: https://provider.example/v1/responses',
      ),
      "turn-failed",
      { status: 402, code: "server_error" },
    ],
    [
      // Codex prints a 400 as its bare body, without the status.
      "a provider 400 body that says overloaded",
      failedWith(
        '{"error":{"message":"the server is overloaded","type":"invalid_request_error","code":"server_error"}}',
      ),
      "turn-failed",
      { code: "server_error" },
    ],
    [
      "a content-filter stop",
      failedWith(
        "stream disconnected before completion: Incomplete response returned, reason: content_filter",
      ),
      "turn-failed",
    ],
    [
      "a rejected provider certificate",
      erroredWith(
        "stream disconnected before completion: invalid peer certificate: Other(OtherError(CaUsedAsEndEntity))",
      ),
      "error-event",
    ],
    [
      "a provider host name that does not resolve",
      erroredWith(
        "stream disconnected before completion: failed to lookup address information: Name does not resolve",
      ),
      "error-event",
    ],
    [
      "a provider host name with no address",
      erroredWith(
        "stream disconnected before completion: failed to lookup address information: Name has no usable address",
      ),
      "error-event",
    ],
    // The 4xx guard's bounds; a compatible endpoint may print the status.
    [
      "a provider 400 with its status that says overloaded",
      failedWith(
        "unexpected status 400 Bad Request: the server is overloaded, url: https://provider.example/v1/responses",
      ),
      "turn-failed",
      { status: 400 },
    ],
    [
      "the highest provider 4xx",
      failedWith("unexpected status 499: overloaded"),
      "turn-failed",
      { status: 499 },
    ],
    // A credential marker vetoes a transient one, each on its own.
    [
      "a dropped stream naming auth",
      erroredWith("stream disconnected before completion: auth token expired"),
      "error-event",
    ],
    [
      "a server error naming a forbidden request",
      erroredWith("server_error: forbidden by the workspace policy"),
      "error-event",
      { code: "server_error" },
    ],
    [
      "an overload naming a credential",
      erroredWith("overloaded: the credential was revoked"),
      "error-event",
    ],
    [
      "a dropped stream naming a 403 without its status",
      erroredWith("stream disconnected before completion: upstream answered 403"),
      "error-event",
    ],
    [
      "a dropped stream naming the API key in any case",
      erroredWith("stream disconnected before completion: Incorrect API key provided"),
      "error-event",
    ],
    // Only a network wait for a failed connection is transient; any other Reconnecting
    // notice the recovered-stream rule refused is held, even with a transient cause. These
    // are boundary shapes the pinned build does not print, so a looser match fails here.
    [
      "a network wait for a provider 503",
      erroredWith("Reconnecting... waiting for network (unexpected status 503)"),
      "error-event",
      { status: 503 },
    ],
    [
      "a network wait that does not start the notice",
      erroredWith(`Error: ${networkWait().message}`),
      "error-event",
    ],
    [
      "a network wait with text after its cause",
      erroredWith(`${networkWait().message} after 3 tries`),
      "error-event",
    ],
    [
      "a network wait for a failed connection naming a credential",
      erroredWith(networkWait("Connection failed: invalid credential").message),
      "error-event",
    ],
    // Finding 1621: a cause other than the pinned text may be permanent, so it is held.
    ...[
      "Connection failed: invalid URL, scheme is not http",
      "Connection failed: builder error",
      "Connection failed: error sending request for url (https://provider.example/v1/responses)",
      "Connection failed: blocked by policy",
    ].map((cause) => [
      `a network wait for "${cause}"`,
      erroredWith(networkWait(cause).message),
      "error-event",
    ]),
  ];
  const scenarios = [
    ...heldAtOnce.map(([description, first, detail, provider]) => ({
      name: `${description} is held at once, with no second probe`,
      native: [login(), first],
      expect: probeFailure({ kind: "PROBE_STATUS", detail }, provider),
    })),
    ...transient.map(([description, first]) => ({
      name: `${description} recovers on the second attempt`,
      native: [login(), first, success],
      retryAfterMs: 1000,
      expect: ready,
      probeCodes: ["MODEL_PROBE_FAILED", "READY"],
    })),
    ...transient.map(([description, first, detail, provider, kind = "PROBE_STATUS"]) => ({
      name: `${description} twice holds the second cause, marked as retried`,
      native: [login(), first, first],
      retryAfterMs: 1000,
      expect: probeFailure({ kind, detail: `${detail}-attempt2` }, provider),
      lastProbeCause: { kind, detail },
      probeCodes: ["MODEL_PROBE_FAILED", "MODEL_PROBE_FAILED"],
    })),
    {
      name: "a deterministic second attempt holds its own cause, marked as retried",
      native: [
        login(),
        failedWith("unexpected status 503"),
        probe([started, { type: "item.completed", item: { type: "command_execution" } }]),
      ],
      retryAfterMs: 1000,
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "tool-event-attempt2" }),
      lastProbeCause: { kind: "PROBE_STATUS", detail: "tool-event" },
      probeCodes: ["MODEL_PROBE_FAILED", "MODEL_PROBE_FAILED"],
    },
    {
      name: "a transient failure then a credential rejection is an authentication failure",
      native: [
        login(),
        killed,
        probe([started, failedTurn("unexpected status 401 Unauthorized: Incorrect API key")], {
          status: 1,
        }),
      ],
      retryAfterMs: 1000,
      expect: { ...probeFailure(), code: "AUTHENTICATION_FAILED" },
      probeCodes: ["MODEL_PROBE_FAILED", "AUTHENTICATION_FAILED"],
    },
    // Within one attempt, a later deterministic failure vetoes an earlier transient one.
    {
      name: "a transient error then a tool event in the same attempt holds the tool event",
      native: [
        login(),
        probe([
          started,
          errorEvent("unexpected status 503"),
          { type: "item.completed", item: { type: "command_execution" } },
        ]),
      ],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "tool-event" }),
    },
    {
      name: "a transient error then a rate limit in the same attempt holds the rate limit",
      native: [
        login(),
        probe(
          [
            started,
            errorEvent("unexpected status 503"),
            failedTurn("exceeded retry limit, last status: 429 Too Many Requests"),
          ],
          { status: 1 },
        ),
      ],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "rate_limit" }, { status: 429 }),
    },
    {
      name: "a transient error then a credential rejection in the same attempt is an authentication failure",
      native: [
        login(),
        probe(
          [
            started,
            errorEvent("unexpected status 503"),
            failedTurn("unexpected status 401 Unauthorized: Incorrect API key"),
          ],
          { status: 1 },
        ),
      ],
      expect: { ...probeFailure(), code: "AUTHENTICATION_FAILED" },
    },
    {
      name: "a transient error then a completed reply in the same attempt is still retried",
      native: [
        login(),
        probe([started, errorEvent("unexpected status 503"), assistant, completed]),
        success,
      ],
      retryAfterMs: 1000,
      expect: ready,
      probeCodes: ["MODEL_PROBE_FAILED", "READY"],
    },
    // Finding 1622: Codex reconnects after a network wait on its own, so a wait inside the
    // turn of an attempt that exits answered passes, like a recovered stream notice.
    {
      name: "network waits then a completed reply in the same attempt pass",
      native: [login(), probe([started, networkWait(), networkWait(), assistant, completed])],
      expect: ready,
    },
    ...[
      ["a network wait before the turn", [networkWait(), started, assistant, completed]],
      [
        "a failed turn with the network wait text",
        [started, failedTurn(networkWait().message), assistant, completed],
        undefined,
        "turn-failed",
      ],
      [
        // A made-up shape: only an error event's own text is a network wait.
        "a failed turn naming the network wait beside a transient error",
        [
          started,
          { ...failedTurn("unexpected status 503"), message: networkWait().message },
          assistant,
          completed,
        ],
        undefined,
        "turn-failed",
      ],
      [
        "a network wait and a transient error",
        [started, errorEvent("unexpected status 503"), networkWait(), assistant, completed],
      ],
      ["a network wait then a completed turn with no reply", [started, networkWait(), completed]],
      [
        "a network wait then a blank reply",
        [
          started,
          networkWait(),
          { type: "item.completed", item: { type: "agent_message", text: "  " } },
          completed,
        ],
      ],
      [
        // A made-up shape: one turn reported complete twice is not an answer.
        "a network wait then a turn completed twice",
        [started, networkWait(), assistant, completed, completed],
      ],
      [
        "a network wait then a reply after the turn",
        [started, networkWait(), completed, assistant],
      ],
      [
        "a network wait then a reply from a failed process",
        [started, networkWait(), assistant, completed],
        { status: 1 },
      ],
      [
        // Held as the network wait, not as the kill that ended the process.
        "a network wait then a reply from a terminated process",
        [started, networkWait(), assistant, completed],
        { status: null, signal: "SIGTERM" },
      ],
      [
        "a network wait then a reply from a probe that overflowed its output",
        [started, networkWait(), assistant, completed],
        { error: { code: "ENOBUFS" } },
      ],
    ].map(([description, events, result, detail = "error-event"]) => ({
      name: `${description} in one attempt is still retried`,
      native: [login(), probe(events, result), success],
      retryAfterMs: 1000,
      expect: ready,
      probeCodes: ["MODEL_PROBE_FAILED", "READY"],
      probeCauses: [{ kind: "PROBE_STATUS", detail }, undefined],
    })),
    {
      name: "two transient failures in one attempt still get one retry",
      native: [
        login(),
        probe([started, errorEvent("unexpected status 502"), failedTurn("broken pipe")], {
          status: 1,
        }),
        failedWith("unexpected status 503"),
      ],
      retryAfterMs: 1000,
      expect: probeFailure(
        { kind: "PROBE_STATUS", detail: "turn-failed-attempt2" },
        { status: 503 },
      ),
      lastProbeCause: { kind: "PROBE_STATUS", detail: "turn-failed" },
      probeCodes: ["MODEL_PROBE_FAILED", "MODEL_PROBE_FAILED"],
      // The first attempt reports its first transient failure.
      probeCauses: [
        { kind: "PROBE_STATUS", detail: "error-event" },
        { kind: "PROBE_STATUS", detail: "turn-failed" },
      ],
    },
    {
      name: "two transient failures then a tool event in one attempt hold the tool event",
      native: [
        login(),
        probe([
          started,
          errorEvent("unexpected status 502"),
          errorEvent("broken pipe"),
          { type: "item.completed", item: { type: "command_execution" } },
        ]),
      ],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "tool-event" }),
    },
    // A recovered stream notice is never a transient failure, before or after one.
    ...[
      ["before", [recoveredNotice, errorEvent("unexpected status 503")]],
      ["after", [errorEvent("unexpected status 503"), recoveredNotice]],
    ].map(([order, events]) => ({
      name: `a recovered stream notice ${order} a transient error is still retried`,
      native: [login(), probe([started, ...events, assistant, completed]), success],
      retryAfterMs: 1000,
      expect: ready,
      probeCodes: ["MODEL_PROBE_FAILED", "READY"],
      probeCauses: [{ kind: "PROBE_STATUS", detail: "error-event" }, undefined],
    })),
    {
      name: "a transient failure then a timeout holds the timeout",
      native: [login(), failedWith("unexpected status 503"), probe([], timedOut, 30000)],
      retryAfterMs: 1000,
      expect: { ...probeFailure(), code: "MODEL_PROBE_TIMEOUT" },
      probeCodes: ["MODEL_PROBE_FAILED", "MODEL_PROBE_TIMEOUT"],
    },
    {
      // The one retry is shared: a timeout spends it, so a transient failure after it holds.
      name: "a timeout then a transient failure holds without a second retry",
      native: [login(), probe([], timedOut, 30000), failedWith("unexpected status 503")],
      retryAfterMs: 1000,
      expect: probeFailure(
        { kind: "PROBE_STATUS", detail: "turn-failed-attempt2" },
        { status: 503 },
      ),
      lastProbeCause: { kind: "PROBE_STATUS", detail: "turn-failed" },
      probeCodes: ["MODEL_PROBE_TIMEOUT", "MODEL_PROBE_FAILED"],
    },
    {
      name: "a transient retry gets only the remaining budget",
      native: [login(), failedWith("unexpected status 503", 40000), probe([], timedOut, 20000)],
      retryAfterMs: 1000,
      expect: { ...probeFailure(), code: "MODEL_PROBE_TIMEOUT" },
      probeCodes: ["MODEL_PROBE_FAILED", "MODEL_PROBE_TIMEOUT"],
    },
    {
      name: "a transient failure with no budget left for a retry holds at once",
      native: [login(), failedWith("unexpected status 503", 60500)],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "turn-failed" }, { status: 503 }),
    },
    {
      // The retry waits one second, so exactly one second left is not enough.
      name: "a transient failure with exactly the retry delay left holds at once",
      native: [login(), failedWith("unexpected status 503", 60000)],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "turn-failed" }, { status: 503 }),
    },
    {
      // A transient event the attempt saw is its failure, even when the attempt then timed out.
      name: "a transient error then a timeout in the same attempt is retried as transient",
      native: [
        login(),
        probe([started, errorEvent("unexpected status 503")], timedOut, 30000),
        success,
      ],
      retryAfterMs: 1000,
      expect: ready,
      probeCodes: ["MODEL_PROBE_FAILED", "READY"],
    },
    {
      // Only a detail token is marked as retried; a cause with no detail keeps none.
      name: "a wrapper error after a transient failure holds a cause with no detail",
      // A non-string stdout makes the wrapper throw.
      native: [login(), killed, probe([], { stdout: 1 })],
      retryAfterMs: 1000,
      expect: probeFailure({ kind: "WRAPPER_ERROR" }),
      probeCodes: ["MODEL_PROBE_FAILED", "MODEL_PROBE_FAILED"],
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, (t) => checkCodexStartup(t, scenario));
  }
});

// Owner rule (finding 2017): a reliability failure (network, timeout, provider or proxy
// 5xx) of the native login or the model check is retried within the step's existing time
// budget; a security failure (a credential rejection, 401 or 403, another 4xx, TLS) or
// unclassified output is held at once, as before.
test("Codex runtime retries a reliability failure of its login or model check, never a security failure", async (t) => {
  const started = { type: "turn.started" };
  const assistant = { type: "item.completed", item: { type: "agent_message", text: "READY" } };
  const completed = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
  const success = probe([started, assistant, completed]);
  const pat = { loginMode: "codex_pat" };
  const loginFailed = (stderr, elapsed) => login({ status: 1, stderr }, undefined, elapsed);
  const network = "failed to request personal access token metadata: error sending request for url";
  const serverError = "personal access token metadata request failed with status 503";
  // Codex exits 1 before printing any event: the 2017 model check shape.
  const exited = (stderr, result) => probe([], { status: 1, stderr, ...result });
  const exitCause = (detail) => ({ kind: "PROCESS_EXIT", detail });
  const exitFailure = (detail) => probeFailure(exitCause(detail));
  const loginScenarios = [
    {
      name: "a login network failure then success retries once",
      native: [loginFailed(network), login(), success],
      expect: ready,
      loginClasses: ["network"],
      loginPauses: [1000],
    },
    {
      // The request URL Codex names is not output that fails the same way again.
      name: "a login network failure naming a URL with failure words retries once",
      native: [
        loginFailed(
          "error sending request for url (https://credential-quota.example.invalid/apikey/403)",
        ),
        login(),
        success,
      ],
      expect: ready,
      loginClasses: ["network"],
      loginPauses: [1000],
    },
    {
      name: "a login 5xx then success retries once",
      native: [loginFailed(serverError), login(), success],
      expect: ready,
      loginClasses: ["http_5xx"],
      loginPauses: [1000],
    },
    {
      name: "a login network failure then a 5xx then success backs off twice",
      native: [loginFailed(network), loginFailed(serverError), login(), success],
      expect: ready,
      loginClasses: ["network", "http_5xx"],
      loginPauses: [1000, 2000],
    },
    {
      // A timed-out attempt waited 30 s already, so only the fast failure backs off.
      name: "a login timeout then a network failure then success waits only after the fast failure",
      native: [login(timedOut, 30000), loginFailed(network), login(undefined, 30000), success],
      expect: ready,
      loginClasses: ["timeout", "network"],
      loginPauses: [2000],
    },
    {
      name: "login network failures are held after five attempts with the same status shape",
      native: Array.from({ length: 5 }, () => loginFailed(network)),
      expect: loginFailure(),
      loginClasses: ["network", "network", "network", "network", "network"],
      loginPauses: [1000, 2000, 4000, 8000],
    },
    {
      // Each wait follows a fast failure; the attempts and waits stay inside 90 s.
      name: "login backoff ends at the 90-second budget",
      random: 0.999,
      native: [
        loginFailed(network, 20000),
        loginFailed(network, 20000),
        loginFailed(network, 20000),
        loginFailed(network, 10000),
      ],
      expect: loginFailure(),
      loginClasses: ["network", "network", "network", "network"],
      // 20 + 1.5 + 20 + 3 + 20 + 6 + 10 s leaves under 10 s: the 12 s fourth wait does not fit.
      loginPauses: [1500, 2999, 5998],
    },
    {
      // A wait that wakes late must not start an attempt without a timeout.
      name: "a login retry wait that wakes too late is held at once",
      lateWakeMs: 1000,
      native: [loginFailed(network, 87500)],
      expect: loginFailure(),
      loginClasses: ["network"],
      loginPauses: [1000],
    },
    {
      name: "a login network failure then a credential rejection is held at once",
      native: [loginFailed(network), loginFailed("request failed with status 401 Unauthorized")],
      expect: loginFailure("AUTHENTICATION_FAILED"),
      loginClasses: ["network", "http_401_403"],
      loginPauses: [1000],
    },
    {
      // Jitter spreads retries by up to half of the base delay.
      name: "a login retry waits at most half again its base delay",
      random: 0.999,
      native: [loginFailed(network), loginFailed(network), login(), success],
      expect: ready,
      loginClasses: ["network", "network"],
      loginPauses: [1500, 2999],
    },
    {
      // Three attempts keep the 90 s the three 30 s attempts always had.
      name: "a login retry gets only the remaining budget",
      native: [loginFailed(network, 59500), login(timedOut, 29500)],
      expect: loginFailure(),
      loginClasses: ["network", "timeout"],
      loginPauses: [1000],
    },
    {
      name: "a login network failure with no budget left for a retry is held at once",
      native: [loginFailed(network, 89000)],
      expect: loginFailure(),
      loginClasses: ["network"],
    },
    ...[
      [
        "a login 401",
        "request failed with status 401 Unauthorized",
        "http_401_403",
        "AUTHENTICATION_FAILED",
      ],
      [
        "a login 403",
        "request failed with status 403 Forbidden",
        "http_401_403",
        "AUTHENTICATION_FAILED",
      ],
      // A credential rejection Codex quotes beside network text still names the credential.
      [
        "a login credential rejection beside network text",
        'error sending request: "status 401 Unauthorized"',
        "network",
        "AUTHENTICATION_FAILED",
      ],
      ["a login rate limit", "last status: 429 Too Many Requests", "http_other"],
      ["a login TLS failure", "invalid peer certificate: UnknownIssuer", "tls"],
      [
        "a login TLS failure beside network text",
        "error sending request: tls handshake eof",
        "tls",
      ],
      // The class names the most specific text; a no-retry marker still vetoes the retry.
      [
        "a login proxy 5xx naming a certificate",
        "unexpected status 502 Bad Gateway: upstream certificate verify failed",
        "http_5xx",
      ],
      [
        "a login proxy 5xx naming a TLS handshake",
        "unexpected status 503: tls handshake eof",
        "http_5xx",
      ],
      ["a login proxy 5xx naming a handshake failure", "status 502: handshake failure", "http_5xx"],
      [
        "a login 401 beside a transport timeout",
        "HTTP status client error (401 Unauthorized) for url: operation timed out",
        "network",
      ],
      [
        "a login rate limit beside a closed connection",
        "Rate limit reached, connection closed",
        "network",
      ],
      ["a login invalid key beside a broken pipe", "invalid api key; broken pipe", "network"],
      ["a login 5xx naming a credential", "status 503: credential unavailable", "http_5xx"],
      ["an unresolvable login host", "dns error: Name does not resolve", "network"],
      ["unrecognized login output", "something else went wrong", "unknown"],
      ["a silent login failure", "", "empty"],
    ].map(([description, stderr, failureClass, code]) => ({
      name: `${description} is held at once`,
      native: [loginFailed(stderr)],
      expect: loginFailure(code),
      loginClasses: [failureClass],
    })),
    {
      // A wrapper-side process error is not a reliability failure, whatever the output says.
      name: "a login whose output overflowed is held at once",
      native: [login({ status: null, error: { code: "ENOBUFS" }, stderr: network })],
      expect: loginFailure(),
      loginClasses: ["network"],
    },
    {
      name: "a login timeout whose output names a credential rejection is held at once",
      native: [login({ ...timedOut, stderr: "status 401 Unauthorized" })],
      expect: loginFailure(),
      loginClasses: ["http_401_403"],
    },
  ].map((scenario) => ({ ...pat, ...scenario }));
  const probeScenarios = [
    {
      name: "a model check that exits with a network failure then succeeds retries once",
      native: [login(), exited("Error: error sending request for url"), success],
      retryAfterMs: 1000,
      expect: ready,
      probeCodes: ["MODEL_PROBE_FAILED", "READY"],
      probeFailureClasses: ["network", undefined],
    },
    {
      name: "a model check that exits with a 5xx then succeeds retries once",
      native: [login(), exited("Error: unexpected status 503 Service Unavailable"), success],
      retryAfterMs: 1000,
      expect: ready,
      probeCodes: ["MODEL_PROBE_FAILED", "READY"],
      probeFailureClasses: ["http_5xx", undefined],
    },
    {
      name: "a model check that exits with a network failure twice holds the second exit",
      native: [login(), exited("connection refused"), exited("connection refused")],
      retryAfterMs: 1000,
      expect: exitFailure("exit-1-attempt2"),
      lastProbeCause: exitCause("exit-1"),
      probeCodes: ["MODEL_PROBE_FAILED", "MODEL_PROBE_FAILED"],
      probeFailureClasses: ["network", "network"],
    },
    {
      name: "a model check retry waits at most half again its base delay",
      random: 0.999,
      native: [login(), exited("connection reset by peer"), success],
      retryAfterMs: 1500,
      retryDelayMs: 1500,
      expect: ready,
      probeCodes: ["MODEL_PROBE_FAILED", "READY"],
    },
    {
      // The jittered delay must fit in the 61 s budget too.
      name: "a model check without a second left after its jittered delay is held at once",
      random: 0.999,
      native: [login(), probe([], { status: 1, stderr: "connection refused" }, undefined, 58600)],
      expect: exitFailure("exit-1"),
    },
    ...[
      ["a 401", "Error: unexpected status 401 Unauthorized", "http_401_403"],
      ["a 403", "Error: unexpected status 403 Forbidden", "http_401_403"],
      ["a rate limit", "Error: last status: 429 Too Many Requests", "http_other"],
      ["a TLS failure", "invalid peer certificate: UnknownIssuer", "tls"],
      ["a TLS failure beside network text", "error sending request: tls handshake eof", "tls"],
      [
        "a proxy 5xx naming a certificate",
        "Error: unexpected status 502 Bad Gateway: upstream certificate verify failed",
        "http_5xx",
      ],
      [
        "a proxy 5xx naming a TLS handshake",
        "unexpected status 503: tls handshake eof",
        "http_5xx",
      ],
      ["a proxy 5xx naming an unknown issuer", "status 502: unknown issuer", "http_5xx"],
      [
        "a quoted credential rejection beside network text",
        'error sending request: "status 401 Unauthorized"',
        "network",
      ],
      [
        "an unresolvable host",
        "failed to lookup address information: Name does not resolve",
        "network",
      ],
      ["unrecognized output", "something else went wrong", "unknown"],
      ["no output", "", "empty"],
    ].map(([description, stderr, failureClass]) => ({
      name: `a model check that exits with ${description} is held at once`,
      native: [login(), exited(stderr)],
      expect: exitFailure("exit-1"),
      probeFailureClasses: [failureClass],
    })),
    {
      // Only a Codex exit is classified this way; a wrapper-side process error is not.
      name: "a model check whose output overflowed is held at once, whatever its class",
      native: [login(), exited("connection refused", { status: null, error: { code: "ENOBUFS" } })],
      expect: exitFailure("error-ENOBUFS"),
      probeFailureClasses: ["network"],
    },
    // A security class vetoes the timeout and transient retries too.
    {
      name: "a model check timeout whose output names a 401 is held at once",
      native: [
        login(),
        probe([], { ...timedOut, stderr: "unexpected status 401 Unauthorized" }, 30000),
      ],
      expect: probeTimeout,
      probeFailureClasses: ["http_401_403"],
    },
    {
      name: "a transient model check failure whose output names a 403 is held at once",
      native: [
        login(),
        probe([started, failedTurn("unexpected status 502: upstream")], {
          status: 1,
          stderr: "unexpected status 403 Forbidden",
        }),
      ],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "turn-failed" }, { status: 502 }),
      probeFailureClasses: ["http_401_403"],
    },
    {
      name: "a transient model check failure whose output names a usage limit is held at once",
      native: [
        login(),
        probe([started, failedTurn("unexpected status 503")], {
          status: 1,
          stderr: "usage limit reached",
        }),
      ],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "turn-failed" }, { status: 503 }),
      probeFailureClasses: ["http_5xx"],
    },
    {
      // The second attempt must get at least a second after the delay.
      name: "a model check with less than a second left after its delay is held at once",
      native: [login(), probe([], { status: 1, stderr: "connection refused" }, undefined, 59100)],
      expect: exitFailure("exit-1"),
    },
    {
      // Finding 1599: a protected profile retries nothing, including a Codex exit whose
      // output names a reliability class.
      name: "a protected model check that exits with a network failure is held at once",
      protectedInference: "signed",
      native: [login(), exited("Error: error sending request for url")],
      expect: exitFailure("exit-1"),
      probeCodes: ["MODEL_PROBE_FAILED"],
      probeFailureClasses: ["network"],
    },
    {
      name: "a model check timeout then a network exit holds without a second retry",
      native: [login(), probe([], timedOut, 30000), exited("connection refused")],
      retryAfterMs: 1000,
      expect: exitFailure("exit-1-attempt2"),
      lastProbeCause: exitCause("exit-1"),
      probeCodes: ["MODEL_PROBE_TIMEOUT", "MODEL_PROBE_FAILED"],
    },
  ];
  for (const scenario of [...loginScenarios, ...probeScenarios]) {
    // checkCodexStartup is async since protected startup awaits its release.
    await t.test(scenario.name, (t) => checkCodexStartup(t, scenario));
  }
});

test("a no-retry marker anywhere in the output vetoes a retry, whatever its class", () => {
  const context = vm.createContext({});
  vm.runInContext(
    `${CODEX_FAILURE_OUTPUT_CLASS_HELPER}\nthis.noRetry = codexNoRetryOutput;`,
    context,
  );
  for (const text of [
    "401 Unauthorized: invalid token; connection reset",
    "status code 401; connection closed",
    '{"status":403} error sending request',
    "Forbidden by policy",
    "invalid api key; broken pipe",
    "the API_KEY was revoked",
    "the credential was withdrawn",
    "429 then connection reset",
    "Too Many Requests",
    "Rate limit reached, connection closed",
    "usage_limit_reached",
    "exceeded your current quota",
    "upstream certificate verify failed",
    "unexpected status 503: TLS handshake eof",
    "status 502: Handshake Failure",
    "status 504: unknown issuer",
    "failed to lookup address information: Name does not resolve",
    "Name has no usable address",
    // A marker far before the classifier's 8 KiB window still counts.
    `status 401 Unauthorized${" ".repeat(16384)}connection refused`,
  ]) {
    assert.equal(context.noRetry(text), true, text);
  }
  for (const text of [
    "failed to request personal access token metadata: error sending request for url (https://auth.openai.com/)",
    "connection refused",
    "unexpected status 503 Service Unavailable",
    "failed to lookup address information: Try again",
    "operation timed out",
    "port 4010 closed",
    // A configured endpoint's URL names no failure, whatever words it carries.
    "error sending request for url (https://quota-credential.example.invalid/v1/apikey/401/responses?rate_limit=1)",
    "connection refused: http://proxy.internal:3128/forbidden",
    "",
  ]) {
    assert.equal(context.noRetry(text), false, text);
  }
  assert.equal(context.noRetry(undefined, "connection reset", "Unauthorized"), true);
  assert.equal(context.noRetry(undefined, null), false);
});

// Finding 2017: a failed login or model check logs only the class of Codex's error output.
// Fake credentials, a JWT, a bearer header and a URL with a query string in that output
// must never reach the held status or any log line.
const fakeSecrets = [
  "sk-proj-FAKE0123456789abcdefghijklmnopqrstuv",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.ZmFrZS1zaWduYXR1cmU",
  "at-fixture-token",
  "code=fake-authorization-code",
];
const secretOutput = (text) =>
  `${text} (https://auth.example.invalid/oauth/token?${fakeSecrets[3]}) ` +
  `Authorization: Bearer ${fakeSecrets[1]} key ${fakeSecrets[0]} token ${fakeSecrets[2]}\n`;
const leaked = new RegExp(
  [
    ...fakeSecrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "Bearer",
    "example\\.invalid",
    "://",
    "error sending",
    "dns error",
    "certificate",
    "Service Unavailable",
  ].join("|"),
  "i",
);

test("Codex runtime logs a failed login or model check's output class, never the output", async (t) => {
  const loginFailed = (code = "LOGIN_FAILED") => ({
    phases: [["codex-login", "failed"]],
    check: "login",
    code,
  });
  const probeExit = {
    phases: [
      ["codex-login", "ok"],
      ["model-probe", "failed"],
    ],
    check: "model-probe",
    code: "MODEL_PROBE_FAILED",
    cause: { kind: "PROCESS_EXIT", detail: "exit-1" },
  };
  // The 2017 shape: Codex exits 1 before printing any event.
  const exited = (stderr) => probe([], { status: 1, stderr });
  const pat = { loginMode: "codex_pat" };
  // A reliability class is retried (finding 2017): five attempts, each logging its class.
  const attempts = 5;
  const everyAttempt = (step) => Array.from({ length: attempts }, () => step);
  const retried = (failureClass) => ({
    loginClasses: Array.from({ length: attempts }, () => failureClass),
    loginPauses: [1000, 2000, 4000, 8000],
  });
  // The model check retries a reliability class once and holds the second exit.
  const probeExitRetried = {
    ...probeExit,
    cause: { kind: "PROCESS_EXIT", detail: "exit-1-attempt2" },
  };
  const probeRetried = {
    retryAfterMs: 1000,
    lastProbeCause: { kind: "PROCESS_EXIT", detail: "exit-1" },
    probeCodes: ["MODEL_PROBE_FAILED", "MODEL_PROBE_FAILED"],
  };
  const scenarios = [
    {
      name: "a login transport error is network",
      ...pat,
      native: everyAttempt(
        login({
          status: 1,
          stderr: secretOutput(
            "Error logging in with access token: failed to request personal access token metadata: error sending request for url",
          ),
        }),
      ),
      expect: loginFailed(),
      failureClass: "network",
      ...retried("network"),
    },
    {
      name: "a login DNS failure is network",
      ...pat,
      native: everyAttempt(
        login({
          status: 1,
          stderr: secretOutput("dns error: failed to lookup address information"),
        }),
      ),
      expect: loginFailed(),
      failureClass: "network",
      ...retried("network"),
    },
    {
      name: "a login provider 5xx is http_5xx",
      ...pat,
      native: everyAttempt(
        login({ status: 1, stderr: secretOutput("unexpected status 503 Service Unavailable") }),
      ),
      expect: loginFailed(),
      failureClass: "http_5xx",
      ...retried("http_5xx"),
    },
    {
      name: "a login credential rejection is http_401_403",
      ...pat,
      native: [
        login({
          status: 1,
          stderr: secretOutput(
            "personal access token metadata request failed with status 401 Unauthorized",
          ),
        }),
      ],
      expect: loginFailed("AUTHENTICATION_FAILED"),
      failureClass: "http_401_403",
      loginClasses: ["http_401_403"],
    },
    {
      name: "another login 4xx is http_other",
      ...pat,
      native: [login({ status: 1, stderr: secretOutput("last status: 429 Too Many Requests") })],
      expect: loginFailed(),
      failureClass: "http_other",
      loginClasses: ["http_other"],
    },
    {
      name: "a rejected proxy certificate is tls",
      ...pat,
      native: [
        login({ status: 1, stderr: secretOutput("invalid peer certificate: UnknownIssuer") }),
      ],
      expect: loginFailed(),
      failureClass: "tls",
      loginClasses: ["tls"],
    },
    {
      name: "three login timeouts are timeout",
      ...pat,
      native: [login(timedOut), login(timedOut), login(timedOut)],
      expect: loginFailed(),
      failureClass: "timeout",
      loginClasses: ["timeout", "timeout", "timeout"],
    },
    {
      name: "a silent login failure is empty",
      ...pat,
      native: [login({ status: 1, stderr: "" })],
      expect: loginFailed(),
      failureClass: "empty",
      loginClasses: ["empty"],
    },
    {
      name: "unrecognized login output is unknown",
      ...pat,
      native: [login({ status: 1, stderr: secretOutput("something else went wrong") })],
      expect: loginFailed(),
      failureClass: "unknown",
      loginClasses: ["unknown"],
    },
    {
      name: "a probe that exits before any event with a transport error is network",
      native: [
        login(),
        exited(secretOutput("Error: error sending request for url")),
        exited(secretOutput("Error: error sending request for url")),
      ],
      expect: probeExitRetried,
      failureClass: "network",
      ...probeRetried,
    },
    {
      name: "a probe that exits before any event with a provider 5xx is http_5xx",
      native: [
        login(),
        exited(secretOutput("Error: unexpected status 502 Bad Gateway")),
        exited(secretOutput("Error: unexpected status 502 Bad Gateway")),
      ],
      expect: probeExitRetried,
      failureClass: "http_5xx",
      ...probeRetried,
    },
    {
      name: "a probe that exits before any event with a 403 is http_401_403",
      native: [login(), exited(secretOutput("Error: unexpected status 403 Forbidden"))],
      expect: probeExit,
      failureClass: "http_401_403",
    },
    {
      name: "a probe that exits silently is empty",
      native: [login(), exited("")],
      expect: probeExit,
      failureClass: "empty",
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const { status, diagnostics } = await checkCodexStartup(t, scenario);
      assert.doesNotMatch(JSON.stringify(status) + diagnostics.join("\n"), leaked);
      // The held status keeps its existing shape: the class is a log field only.
      assert.equal(JSON.stringify(status).includes("failureClass"), false);
    });
  }
});

function loadClassifier() {
  // Count the characters every substring search reads, in the classifier's own realm.
  const context = vm.createContext({});
  vm.runInContext(
    `const scanned = { chars: 0 };
    const indexOf = String.prototype.indexOf;
    const includes = String.prototype.includes;
    String.prototype.indexOf = function (needle, from = 0) {
      const at = indexOf.call(this, needle, from);
      scanned.chars += (at === -1 ? this.length : at + needle.length) - Math.min(from, this.length);
      return at;
    };
    String.prototype.includes = function (needle) {
      scanned.chars += this.length;
      return includes.call(this, needle);
    };
    this.scanned = scanned;
    ${CODEX_FAILURE_OUTPUT_CLASS_HELPER}
    this.classify = codexFailureOutputClass;
    this.classifyProbe = codexProbeFailureClass;
    this.eventText = codexFailureEventText;
    this.window = CODEX_FAILURE_OUTPUT_WINDOW;`,
    context,
  );
  return context;
}

test("the Codex failure output classifier maps output to a closed class", () => {
  const { classify } = loadClassifier();
  const cases = [
    ["Error: error sending request for url", undefined, "network"],
    ["connection reset by peer", undefined, "network"],
    ["tcp connect error: Connection refused (os error 111)", undefined, "network"],
    ["Temporary failure in name resolution", undefined, "network"],
    ["operation timed out", { code: "ETIMEDOUT" }, "network"],
    ["unexpected status 500 Internal Server Error", undefined, "http_5xx"],
    ["status: 504", undefined, "http_5xx"],
    ["HTTP 502", undefined, "http_5xx"],
    ["status=403", undefined, "http_401_403"],
    // A rejection outranks a server error and transport text in the same output.
    ["status 503 then status 401 Unauthorized; connection reset", undefined, "http_401_403"],
    ["status 404 Not Found", undefined, "http_other"],
    ["error sending request: invalid peer certificate", undefined, "tls"],
    ["", { code: "ETIMEDOUT" }, "timeout"],
    ["   \n", undefined, "empty"],
    [undefined, undefined, "empty"],
    [null, { code: "ENOENT" }, "empty"],
    // Near misses name no status: a process exit status, four digits, a URL scheme.
    ["exit status 127", undefined, "unknown"],
    ["status 4011", undefined, "unknown"],
    ["see https://status.example.invalid/401", undefined, "unknown"],
    ["status  : 503", undefined, "unknown"],
    // A status word inside a URL or another word names no status.
    ["GET /v1/x?status=500&http=503 failed", undefined, "unknown"],
    ["httpstatus 503", undefined, "unknown"],
    ["(status 503)", undefined, "http_5xx"],
    [fakeSecrets.join(" "), undefined, "unknown"],
  ];
  for (const [output, error, expected] of cases) {
    const actual = classify(output, error);
    assert.equal(actual, expected, JSON.stringify(output));
    assert.ok(CODEX_FAILURE_OUTPUT_CLASSES.includes(actual));
  }
});

test("the Codex failure output classifier reads a bounded tail in linear time", () => {
  const context = loadClassifier();
  const { classify, scanned, window } = context;
  // Repeated and near-miss markers, the worst shapes for a substring or status scan.
  const adversarial = [
    "status",
    "status:",
    "status 50",
    "status 5000",
    "http ",
    "connection refuse",
    "certificat",
    "a",
  ];
  // Every search reads at most the window once per marker; Codex's maxBuffer is 256 KiB.
  const budget = 32 * window;
  for (const unit of adversarial) {
    for (const length of [window, 262144, 1048576]) {
      const output = unit.repeat(Math.ceil(length / unit.length));
      scanned.chars = 0;
      const actual = classify(output);
      assert.ok(CODEX_FAILURE_OUTPUT_CLASSES.includes(actual));
      assert.ok(
        scanned.chars <= budget,
        `${JSON.stringify(unit)} x ${length}: read ${scanned.chars} > ${budget}`,
      );
      // Only the tail is read: the result equals that of the last window alone.
      assert.equal(actual, classify(output.slice(-window)));
    }
  }
  // A marker before the tail is never read.
  assert.equal(classify("status 503\n" + "x".repeat(window)), "unknown");
  assert.equal(classify("x".repeat(window) + "\nstatus 503"), "http_5xx");
});

// Finding 2043: codex exec --json reports a failed turn or a fatal error on stdout, as a
// turn.failed or error event, often with nothing on stderr. The model check's class reads
// those events' messages too, still logging only the class.
test("Codex runtime classifies a failed model check's stdout error events, never logging them", async (t) => {
  const started = { type: "turn.started" };
  const quiet = { status: 1, stderr: "" };
  // Fake secrets without a credential marker, so a transient failure keeps its retry.
  const transientSecrets = (text) =>
    `${text} (https://api.example.invalid/v1/responses?key=${fakeSecrets[0]}) ` +
    `Bearer ${fakeSecrets[1]} token ${fakeSecrets[2]}`;
  const held = (detail, provider) => probeFailure({ kind: "PROBE_STATUS", detail }, provider);
  const networkWait = errorEvent(
    "Reconnecting... waiting for network (Connection failed: error sending request)",
  );
  const unreachable = probe([started, networkWait, networkWait], timedOut, 30000);
  const scenarios = [
    {
      name: "a 401 failed turn with empty stderr is http_401_403",
      events: [
        started,
        failedTurn(secretOutput("unexpected status 401 Unauthorized: Incorrect API key provided")),
      ],
      result: quiet,
      expect: probeAuthenticationFailure,
      failureClass: "http_401_403",
    },
    {
      name: "a 5xx error event with empty stderr is http_5xx",
      events: [started, errorEvent(secretOutput("unexpected status 502 Bad Gateway"))],
      result: quiet,
      expect: held("error-event", { status: 502 }),
      failureClass: "http_5xx",
    },
    {
      name: "a retried 5xx failed turn is http_5xx on each attempt",
      native: [
        login(),
        probe(
          [started, failedTurn(transientSecrets("unexpected status 503 Service Unavailable"))],
          quiet,
        ),
        probe(
          [started, failedTurn(transientSecrets("unexpected status 503 Service Unavailable"))],
          quiet,
        ),
      ],
      retryAfterMs: 1000,
      expect: held("turn-failed-attempt2", { status: 503 }),
      lastProbeCause: { kind: "PROBE_STATUS", detail: "turn-failed" },
      probeCodes: ["MODEL_PROBE_FAILED", "MODEL_PROBE_FAILED"],
      probeFailureClasses: ["http_5xx", "http_5xx"],
    },
    {
      name: "a failed turn naming a transport error is network",
      events: [
        started,
        failedTurn(
          secretOutput("stream disconnected before completion: error sending request for url"),
        ),
      ],
      result: quiet,
      expect: held("turn-failed"),
      failureClass: "network",
    },
    {
      name: "a TLS error event is tls",
      events: [started, errorEvent(secretOutput("invalid peer certificate: UnknownIssuer"))],
      result: quiet,
      expect: held("error-event"),
      failureClass: "tls",
    },
    {
      // Codex waits for the network until the wrapper's timeout: the wait names the cause.
      name: "a network wait until the timeout is network, not timeout",
      native: [login(), unreachable, unreachable],
      retryAfterMs: 1000,
      expect: held("error-event-attempt2"),
      lastProbeCause: { kind: "PROBE_STATUS", detail: "error-event" },
      probeCodes: ["MODEL_PROBE_FAILED", "MODEL_PROBE_FAILED"],
      probeFailureClasses: ["network", "network"],
    },
    {
      name: "a failed turn without a known marker is unknown",
      events: [started, failedTurn(secretOutput("something else went wrong"))],
      result: quiet,
      expect: held("turn-failed"),
      failureClass: "unknown",
    },
    {
      // A status on stderr outranks transport text in an event, and the reverse.
      name: "the more specific class wins across stderr and events",
      events: [started, failedTurn(secretOutput("error sending request for url"))],
      result: { status: 1, stderr: secretOutput("Error: unexpected status 403 Forbidden") },
      expect: held("turn-failed"),
      failureClass: "http_401_403",
    },
    {
      // A recovered stream notice names nothing; the held error event after it does.
      // A recovered notice is read too: the class names the output, the cause the failure.
      name: "a recovered stream notice naming a transport error classifies a later tool event",
      events: [
        started,
        errorEvent(
          "Reconnecting... 1/3 stream disconnected before completion: error sending request for url",
        ),
        { type: "item.completed", item: { type: "command_execution" } },
      ],
      result: quiet,
      expect: held("tool-event"),
      failureClass: "network",
    },
    {
      name: "a held error event after a recovered stream notice names its own class",
      events: [
        started,
        errorEvent("Reconnecting... 1/3 stream disconnected before completion"),
        errorEvent("Reconnecting... 2/3 error sending request"),
      ],
      result: quiet,
      expect: held("error-event"),
      failureClass: "network",
    },
    // Malformed stdout is not read: the class comes from stderr alone, as before.
    {
      name: "malformed stdout naming a status classifies stderr alone",
      events: [],
      result: {
        status: 1,
        stdout: `${JSON.stringify(failedTurn("unexpected status 401 Unauthorized"))}\nnot-json`,
        stderr: "",
      },
      expect: probeFailure({ kind: "INVALID_OUTPUT", detail: "json" }),
      failureClass: "empty",
    },
    {
      name: "non-event stdout naming a status classifies stderr alone",
      events: [],
      result: {
        status: 1,
        stdout: `${JSON.stringify(failedTurn("unexpected status 401 Unauthorized"))}\nnull`,
        stderr: secretOutput("error sending request for url"),
      },
      expect: probeFailure({ kind: "INVALID_OUTPUT", detail: "shape" }),
      failureClass: "network",
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const { status, diagnostics } = await checkCodexStartup(t, scenario);
      assert.doesNotMatch(JSON.stringify(status) + diagnostics.join("\n"), leaked);
      assert.equal(JSON.stringify(status).includes("failureClass"), false);
    });
  }
});

test("the Codex model check classifier reads only error event messages, most specific first", () => {
  const { classify, classifyProbe, eventText, window } = loadClassifier();
  const advisory = {
    type: "item.completed",
    item: { type: "error", message: "unexpected status 401 Unauthorized" },
  };
  const answer = {
    type: "item.completed",
    item: { type: "agent_message", text: "unexpected status 401 Unauthorized" },
  };
  const cases = [
    // [stderr, events, error, expected]
    ["", [failedTurn("unexpected status 401 Unauthorized")], undefined, "http_401_403"],
    ["", [errorEvent("unexpected status 500")], undefined, "http_5xx"],
    ["", [errorEvent("status 429 Too Many Requests")], undefined, "http_other"],
    ["", [failedTurn("dns error: failed to lookup address")], undefined, "network"],
    ["", [failedTurn("certificate verify failed")], undefined, "tls"],
    ["", [failedTurn("odd")], undefined, "unknown"],
    ["", [], undefined, "empty"],
    ["", [], { code: "ETIMEDOUT" }, "timeout"],
    // A transport marker outranks the wrapper's timeout, which outranks unknown text.
    ["", [errorEvent("connection reset")], { code: "ETIMEDOUT" }, "network"],
    ["odd", [errorEvent("odd")], { code: "ETIMEDOUT" }, "timeout"],
    // Each source's most specific class competes in one precedence.
    ["connection reset", [failedTurn("status 503")], undefined, "http_5xx"],
    ["status 503", [failedTurn("status 401 Unauthorized")], undefined, "http_401_403"],
    ["status 401", [failedTurn("status 503")], undefined, "http_401_403"],
    ["certificate", [failedTurn("connection reset")], undefined, "tls"],
    ["odd", [], undefined, "unknown"],
    ["", [failedTurn("odd")], undefined, "unknown"],
    // Only error and turn.failed messages are read: advisory items, answers and
    // non-string messages name nothing, nor do events the probe never parsed.
    ["", [advisory, answer], undefined, "empty"],
    ["", [{ type: "error", message: { text: "status 401" } }], undefined, "empty"],
    ["", [{ type: "turn.failed", error: "status 401" }], undefined, "empty"],
    ["", [{ type: "turn.failed", message: "status 401" }], undefined, "empty"],
    ["", undefined, undefined, "empty"],
    ["connection reset", undefined, undefined, "network"],
  ];
  for (const [stderr, events, error, expected] of cases) {
    const actual = classifyProbe(stderr, events, error);
    assert.equal(actual, expected, JSON.stringify([stderr, events, error]));
    assert.ok(CODEX_FAILURE_OUTPUT_CLASSES.includes(actual));
  }
  // The two sources rank like one output holding both texts, in either order.
  const samples = [
    "status 401",
    "status 503",
    "status 404",
    "certificate",
    "connection reset",
    "odd",
    "",
  ];
  for (const first of samples) {
    for (const second of samples) {
      assert.equal(
        classifyProbe(first, [errorEvent(second)]),
        classify(`${first}\n${second}`),
        JSON.stringify([first, second]),
      );
    }
  }
  // The newest messages fill one window, each from its head; older ones are never read.
  assert.equal(
    classifyProbe("", [failedTurn("status 401 Unauthorized"), errorEvent("x".repeat(window))]),
    "unknown",
  );
  assert.equal(classifyProbe("", [errorEvent(`status 503 ${"x".repeat(2 * window)}`)]), "http_5xx");
  assert.equal(eventText([errorEvent("a"), { type: "turn.started" }, failedTurn("b")]), "a\nb");
});

test("the Codex model check classifier reads a bounded share of stdout events in linear time", () => {
  const context = loadClassifier();
  const { classifyProbe, eventText, scanned, window } = context;
  // Two sources, each searched at most once per marker over at most one window.
  const budget = 2 * 32 * window;
  const shapes = [
    // One huge message, many short ones, many empty ones and many non-error events.
    (unit, length) => [errorEvent(unit.repeat(Math.ceil(length / unit.length)))],
    (unit, length) =>
      Array.from({ length: Math.ceil(length / (unit.length + 16)) }, () => failedTurn(unit)),
    (_, length) => Array.from({ length: length / 16 }, () => errorEvent("")),
    (_, length) => Array.from({ length: length / 16 }, () => ({ type: "turn.started" })),
  ];
  for (const unit of ["status", "status 50", "http ", "connection refuse", "certificat", "a"]) {
    for (const length of [window, 262144]) {
      for (const shape of shapes) {
        const events = shape(unit, length);
        assert.ok(eventText(events).length <= window);
        scanned.chars = 0;
        const actual = classifyProbe("", events);
        assert.ok(CODEX_FAILURE_OUTPUT_CLASSES.includes(actual));
        assert.ok(
          scanned.chars <= budget,
          `${JSON.stringify(unit)} x ${length}: read ${scanned.chars} > ${budget}`,
        );
      }
    }
  }
});
