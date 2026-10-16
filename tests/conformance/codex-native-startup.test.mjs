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
      name: "external SIGKILL is not a timeout or retried",
      events: [],
      result: { status: null, signal: "SIGKILL" },
      expect: probeFailure({ kind: "PROCESS_EXIT", detail: "signal-SIGKILL" }),
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
    {
      name: "provider server error is not an authentication failure",
      events: [started, failedTurn("unexpected status 503 Service Unavailable")],
      result: { status: 1 },
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "turn-failed" }, { status: 503 }),
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
