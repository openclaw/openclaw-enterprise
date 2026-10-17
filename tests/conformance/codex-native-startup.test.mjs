import test from "node:test";
import { checkCodexStartup, login, probe, timedOut } from "../fixtures/codex-native-startup.mjs";

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
    },
    {
      name: "access-token login refusal is not retried",
      loginMode: "codex_pat",
      native: [login({ status: 1 })],
      expect: loginFailure(),
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
    },
    {
      name: "access-token login transport error remains a login failure",
      loginMode: "codex_pat",
      native: [
        login({
          status: 1,
          stderr:
            "Error logging in with access token: failed to request personal access token metadata: error sending request for url (https://auth.openai.com/)\n",
        }),
      ],
      expect: loginFailure(),
    },
    {
      name: "access-token login recovers one timeout before probing",
      loginMode: "codex_pat",
      native: [login(timedOut), login(), probe(completedTurn())],
      expect: ready,
    },
    {
      name: "access-token login stops after three timeouts",
      loginMode: "codex_pat",
      native: [login(timedOut), login(timedOut), login(timedOut)],
      expect: loginFailure(),
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
      checkCodexStartup(t, scenario);
    });
  }
});

// Finding 1576: one provider 5xx or dropped stream must not fail a deployment for good.
// A transient failure gets the single retry a model timeout gets, inside the same 61 s
// budget; the held cause is the last attempt's, marked as retried.
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
    // notice the recovered-stream rule refused is held, even with a transient cause.
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
      "a network wait for a failed connection naming a credential",
      erroredWith(networkWait("Connection failed: invalid credential").message),
      "error-event",
    ],
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
    await t.test(scenario.name, (t) => {
      checkCodexStartup(t, scenario);
    });
  }
});
