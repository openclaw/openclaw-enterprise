import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexLaunchEntrypoint } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { inspectOpenShellCodexCommand } from "../fixtures/openshell-codex-command.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import { startSupervisor } from "./workspace-node-supervisor-fixture.ts";
import { pluginRuntimeEnvironment } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import {
  checkCodexStartup,
  createCodexStartup,
  login,
  probe,
  timedOut,
} from "../fixtures/codex-native-startup.mjs";
import {
  checkBoundedOutputTail,
  checkBoundedProbeEvents,
  checkFailureOutputClasses,
  checkNoRetryOutput,
  checkProbeEventPrecedence,
  codexProbeEvents,
} from "./codex-failure-output-classifier-cases.ts";
import { openShellUpgradeDenial } from "../fixtures/codex-rest-fallback.mjs";
import { registerCodexPatLoginRetryCases } from "./codex-native-startup-login-retry-cases.ts";

/** @type {import("../fixtures/codex-native-startup-types.ts").StartupExpectation & { code: "READY" }} */
const ready = {
  phases: [
    ["codex-login", "ok"],
    ["model-probe", "ok"],
    ["native-spawn", "ok"],
  ],
  code: "READY",
};
/**
 * @param {import("../fixtures/codex-native-startup-types.ts").LoginFailureCode} [code]
 * @returns {import("../fixtures/codex-native-startup-types.ts").StartupExpectation & { check: "login"; code: import("../fixtures/codex-native-startup-types.ts").LoginFailureCode }}
 */
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

const { errorEvent, failedTurn } = codexProbeEvents;

test("verifier-only Codex refuses enabled plugins with API-key login before app-server spawn", (t) => {
  // Login/probe output is scripted here; the generated wrapper owns this refusal.
  // No fake plugin response is used to establish installation behavior.
  const runtime = createCodexStartup(t, {
    transportToken: "verifier",
    native: [
      login(),
      probe([
        { type: "turn.started" },
        { type: "item.completed", item: { type: "agent_message", text: "READY" } },
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      ]),
    ],
    environment: pluginRuntimeEnvironment({
      kind: "codex",
      selections: { "codex-plugin:linear@openai-curated-remote": { enabled: true } },
    }),
  });
  assert.throws(() => runtime.start(), /API-key authentication cannot install them/);
  assert.equal(runtime.appServerStarts, 0);
  assert.equal(runtime.marker(), undefined);
  runtime.assertNativeScriptConsumed();
});

// Component conformance: scripted native output, real generated entrypoint and status handler.
test("Codex runtime gates startup and readiness on a successful native authentication turn", async (t) => {
  const started = { type: "turn.started" };
  const assistant = { type: "item.completed", item: { type: "agent_message", text: "READY" } };
  const completed = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
  const missingModelMessage =
    "unexpected status 404 Not Found: The model `gpt-4.1` does not exist or you do not have access to it.";
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
  // The pinned CLI reports the denied upgrade as retry errors and the HTTPS switch
  // as an advisory item. The fixture replays those events through the real wrapper.
  const threadStarted = { type: "thread.started", thread_id: "fixture-thread" };
  const completedFallbackTurn = (...events) => [threadStarted, ...completedTurn(...events)];
  const deniedUpgrade = openShellUpgradeDenial;
  const detailFirstDenial =
    'unexpected status 403 Forbidden: {"detail":"HTTP upgrade is not supported for REST endpoints; use a separate protocol: websocket endpoint with explicit message rules","error":"unsupported_l7_protocol"}, url: wss://chatgpt.com/backend-api/codex/responses';
  const reconnectUpgrade = (cause = deniedUpgrade, attempts = "2/5") =>
    errorEvent("Reconnecting... " + attempts + " (" + cause + ")");
  const fallbackAdvisory = (cause) => ({
    type: "item.completed",
    item: {
      id: "item_0",
      ...errorEvent("Falling back from WebSockets to HTTPS transport. " + cause),
    },
  });
  const httpsFallback = fallbackAdvisory(deniedUpgrade);
  const denialWithExtraField = deniedUpgrade.replace('{"error"', '{"policy":"denied","error"');
  const forbiddenUpgradeFailure = probeFailure(
    { kind: "PROBE_STATUS", detail: "error-event" },
    { status: 403 },
  );
  const scenarios = [
    {
      name: "protected profile without enrollment refuses before any native process",
      protectedInference: "missing",
      native: [],
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
      name: "OpenShell provider PAT accepts the released error-first denial after HTTPS answers",
      providerPat: true,
      events: completedFallbackTurn(
        ...["2/5", "3/5", "4/5", "5/5"].map((attempts) =>
          reconnectUpgrade(deniedUpgrade, attempts),
        ),
        httpsFallback,
      ),
      expect: ready,
    },
    {
      name: "OpenShell provider PAT also accepts the equivalent detail-first denial",
      providerPat: true,
      events: completedFallbackTurn(
        reconnectUpgrade(detailFirstDenial),
        fallbackAdvisory(detailFirstDenial),
      ),
      expect: ready,
    },
    {
      name: "ordinary Codex authentication cannot recover an OpenShell upgrade denial",
      events: completedFallbackTurn(reconnectUpgrade(), httpsFallback),
      expect: forbiddenUpgradeFailure,
    },
    {
      name: "protected PAT authentication cannot recover an OpenShell upgrade denial",
      protectedInference: "signed",
      providerPat: true,
      events: completedFallbackTurn(reconnectUpgrade(), httpsFallback),
      expect: forbiddenUpgradeFailure,
    },
    ...[
      ["wrong host", deniedUpgrade.replace("chatgpt.com", "example.com")],
      ["wrong path", deniedUpgrade.replace("/responses", "/models")],
      ["query parameter", deniedUpgrade + "?fixture=1"],
      ["URL user information", deniedUpgrade.replace("wss://", "wss://fixture@")],
      ["wrong status", deniedUpgrade.replace("403 Forbidden", "401 Unauthorized")],
      [
        "method denied",
        deniedUpgrade.replace(
          "HTTP upgrade is not supported for REST endpoints; use a separate protocol: websocket endpoint with explicit message rules",
          "POST is not allowed for this endpoint",
        ),
      ],
      ["wrong protocol code", deniedUpgrade.replace("unsupported_l7_protocol", "policy_denied")],
      ["an unexpected body field", denialWithExtraField],
    ].map(([label, cause]) => ({
      name: "OpenShell provider PAT refuses a reconnect with " + label,
      providerPat: true,
      events: completedFallbackTurn(reconnectUpgrade(cause), httpsFallback),
      expect:
        label === "wrong status"
          ? probeFailure({ kind: "PROBE_STATUS", detail: "error-event" }, { status: 401 })
          : forbiddenUpgradeFailure,
    })),
    ...[
      [
        "an invalid native retry limit",
        completedFallbackTurn(reconnectUpgrade(deniedUpgrade, "2/11"), httpsFallback),
      ],
      [
        "too many retry events",
        completedFallbackTurn(
          ...Array.from({ length: 11 }, () => reconnectUpgrade()),
          httpsFallback,
        ),
      ],
      [
        "an unrelated reconnect",
        completedFallbackTurn(reconnectUpgrade(), httpsFallback, recoveredStreamError),
      ],
      ["no fallback advisory", completedFallbackTurn(reconnectUpgrade())],
      ["a different fallback advisory", completedFallbackTurn(reconnectUpgrade(), advisory)],
      [
        "an unexpected field in the fallback advisory",
        completedFallbackTurn(reconnectUpgrade(), fallbackAdvisory(denialWithExtraField)),
      ],
      [
        "a second thread",
        completedFallbackTurn(
          reconnectUpgrade(),
          { ...threadStarted, thread_id: "second-thread" },
          httpsFallback,
        ),
      ],
      ["no thread marker", completedTurn(reconnectUpgrade(), httpsFallback)],
      [
        "a reconnect after the fallback advisory",
        completedFallbackTurn(reconnectUpgrade(), httpsFallback, reconnectUpgrade(), httpsFallback),
      ],
      [
        "a second turn",
        [...completedFallbackTurn(reconnectUpgrade(), httpsFallback), ...completedTurn()],
      ],
      [
        "a nonfinal turn completion",
        [...completedFallbackTurn(reconnectUpgrade(), httpsFallback), advisory],
      ],
      [
        "no turn completion",
        [threadStarted, started, reconnectUpgrade(), httpsFallback, assistant],
      ],
      [
        "no answer after the transport failure",
        [threadStarted, started, assistant, reconnectUpgrade(), httpsFallback, completed],
      ],
    ].map(([label, events]) => ({
      name: "OpenShell provider PAT remains unready with " + label,
      providerPat: true,
      events,
      expect: forbiddenUpgradeFailure,
    })),
    ...[
      ["a nonzero exit", { status: 1 }],
      ["a signal", { status: null, signal: "SIGTERM" }],
      ["a timeout", timedOut],
    ].map(([label, result]) => ({
      name: "OpenShell provider PAT remains unready after " + label,
      providerPat: true,
      events: completedFallbackTurn(reconnectUpgrade(), httpsFallback),
      result,
      expect: forbiddenUpgradeFailure,
    })),
    ...[
      failedTurn("unexpected status 403 Forbidden: credential rejected"),
      errorEvent("unexpected status 401 Unauthorized: credential rejected"),
    ].map((refusal) => ({
      name:
        "OpenShell provider PAT rejects a terminal HTTPS authorization failure in " + refusal.type,
      providerPat: true,
      events: [threadStarted, started, reconnectUpgrade(), httpsFallback, refusal],
      expect: probeAuthenticationFailure,
    })),
    {
      name: "OpenShell provider PAT rejects a tool event after fallback",
      providerPat: true,
      events: completedFallbackTurn(reconnectUpgrade(), httpsFallback, {
        type: "item.completed",
        item: { type: "command_execution" },
      }),
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "tool-event" }),
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
        { kind: "PROBE_STATUS", detail: "model_not_found" },
        { status: 404, code: "model_not_found" },
      ),
    },
    // Stock Codex renders the provider's 404 message without its structured code.
    ...[
      ["the pinned CLI error names the requested model", missingModelMessage, 404, true],
      [
        "a reconnect repeats that refusal",
        `Reconnecting... 1/5 (${missingModelMessage}, request id: example)`,
        404,
        true,
      ],
      [
        "a missing endpoint is not a missing model",
        "unexpected status 404 Not Found: Unknown endpoint.",
        404,
        false,
      ],
      [
        "the provider names a different model",
        missingModelMessage.replace("gpt-4.1", "gpt-4.10"),
        404,
        false,
      ],
      [
        "a different status keeps its own cause",
        missingModelMessage.replace("404 Not Found", "400 Bad Request"),
        400,
        false,
      ],
      [
        "quoted status text is not a provider response",
        `example: ${missingModelMessage}`,
        404,
        false,
      ],
    ].map(([name, message, status, unavailable]) => ({
      name,
      events: [started, errorEvent(message)],
      result: { status: 1 },
      expect: probeFailure(
        { kind: "PROBE_STATUS", detail: unavailable ? "model_not_found" : "error-event" },
        unavailable ? { status, code: "model_not_found" } : { status },
      ),
    })),
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
  // Both credentials cross the same transparent REST proxy, but only a newly
  // selected OpenShell OAuth launcher may recover its exact upgrade refusal.
  const oauthScenarios = scenarios
    .filter((scenario) => scenario.providerPat && scenario.events !== undefined)
    .map((scenario) => ({
      ...scenario,
      name: scenario.name.replace("provider PAT", "OAuth"),
      providerPat: false,
      loginMode: "chatgptAuthTokens",
      openShellOAuth: true,
    }));
  oauthScenarios.push({
    name: "ordinary OAuth cannot recover an OpenShell upgrade denial",
    loginMode: "chatgptAuthTokens",
    events: completedFallbackTurn(reconnectUpgrade(), httpsFallback),
    expect: forbiddenUpgradeFailure,
  });
  oauthScenarios.push(
    {
      name: "OAuth rate limiting after HTTPS fallback is not recovered",
      loginMode: "chatgptAuthTokens",
      openShellOAuth: true,
      events: [
        ...completedFallbackTurn(reconnectUpgrade(), httpsFallback).slice(0, -2),
        failedTurn("unexpected status 429 Too Many Requests"),
      ],
      expect: probeFailure({ kind: "PROBE_STATUS", detail: "rate_limit" }, { status: 429 }),
    },
    {
      name: "OAuth malformed native output never reaches readiness",
      loginMode: "chatgptAuthTokens",
      openShellOAuth: true,
      events: [],
      result: { stdout: "not-json" },
      expect: probeFailure({ kind: "INVALID_OUTPUT", detail: "json" }),
    },
  );
  // Category replay, NOT reconstruction of the live text: the closed receipt
  // retained an initial item.error advisory but not its message or native phase.
  // Existing classification only distinguishes an exact HTTPS-fallback advisory
  // from other item.error entries. Deliberately omit the unknown message and
  // exercise all item phases; do not invent a reassuring catalog-warning text.
  for (const phase of ["item.started", "item.updated", "item.completed"]) {
    for (const denial of [deniedUpgrade, detailFirstDenial]) {
      oauthScenarios.push({
        name:
          "OAuth category replay with an opaque initial advisory: " +
          phase +
          (denial === deniedUpgrade ? " error-first" : " detail-first"),
        loginMode: "chatgptAuthTokens",
        openShellOAuth: true,
        events: [
          threadStarted,
          { type: phase, item: { type: "error" } },
          started,
          ...["2/5", "3/5", "4/5", "5/5"].map((attempt) => reconnectUpgrade(denial, attempt)),
          fallbackAdvisory(denial),
          assistant,
          completed,
        ],
        expect: ready,
      });
    }
  }
  for (const [initial, detail] of [
    [{ type: "error" }, "error-event"],
    [{ type: "turn.failed", error: {} }, "turn-failed"],
    [{ type: "item.completed", item: { type: "command_execution" } }, "tool-event"],
  ]) {
    oauthScenarios.push({
      name: "OAuth category replay preserves an initial fatal event: " + detail,
      loginMode: "chatgptAuthTokens",
      openShellOAuth: true,
      events: [
        threadStarted,
        initial,
        started,
        reconnectUpgrade(),
        httpsFallback,
        assistant,
        completed,
      ],
      expect: probeFailure({ kind: "PROBE_STATUS", detail }),
    });
  }
  for (const scenario of [...scenarios, ...oauthScenarios]) {
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

// A Sandbox whose egress is an explicit proxy (loopback only, HTTPS_PROXY in the Harness
// environment) can reach the model only through it, so the program Compute renders for a
// provider-owned Sandbox other than OpenShell carries the standard proxy settings into the
// authentication probe when they are set. OpenShell's egress is transparent and its admitted
// commands keep their bytes, so its programs never carry them.
test("Codex authentication probe carries proxy settings only for an explicit-proxy launch", (t) => {
  const readyTurn = probe([
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "READY" } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ]);
  const proxy = {
    HTTPS_PROXY: "http://127.0.0.1:3128",
    https_proxy: "http://127.0.0.1:3129",
    HTTP_PROXY: "http://127.0.0.1:3130",
    http_proxy: "http://127.0.0.1:3131",
    ALL_PROXY: "socks5://127.0.0.1:1080",
    all_proxy: "socks5://127.0.0.1:1081",
    NO_PROXY: "127.0.0.1,.fixture-no-proxy.test",
    no_proxy: ".fixture-lower-no-proxy.test",
  };
  const fixed = ["CODEX_HOME", "HOME", "PATH", "RUST_LOG"];
  const unrelated = { FTP_PROXY: "http://127.0.0.1:2121", OPENCLAW_UNRELATED: "1" };
  const openShellCa = { SSL_CERT_FILE: "/run/openshell/ca-bundle.crt" };
  const explicitProxy = codexLaunchEntrypoint({
    providerOwned: true,
    protected: false,
    explicitProxy: true,
  });
  for (const [name, entrypoint, environment, expected] of [
    [
      "an OpenShell launch keeps its probe environment",
      undefined,
      { ...openShellCa, ...proxy, ...unrelated },
      openShellCa,
    ],
    [
      "an explicit-proxy launch without proxy settings keeps the same environment",
      explicitProxy,
      { ...openShellCa, ...unrelated },
      openShellCa,
    ],
    ["an explicit proxy reaches the probe", explicitProxy, { ...proxy, ...unrelated }, proxy],
    [
      "empty proxy settings stay out",
      explicitProxy,
      Object.fromEntries(Object.keys(proxy).map((key) => [key, ""])),
      {},
    ],
  ]) {
    const runtime = createCodexStartup(t, { native: [login(), readyTurn], environment });
    runtime.start(entrypoint);
    runtime.assertNativeScriptConsumed();
    assert.equal(runtime.probeSpawns.length, 1, name);
    const [{ env }] = runtime.probeSpawns;
    assert.deepEqual(Object.keys(env).sort(), [...fixed, ...Object.keys(expected)].sort(), name);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(env[key], value, name);
    }
    // The serving app-server inherits the Harness environment as before.
    assert.equal(runtime.appServerSpawns.length, 1, name);
    for (const [key, value] of Object.entries(environment)) {
      assert.equal(runtime.appServerSpawns[0].env[key], value, name);
    }
    // No proxy value reaches a diagnostic line.
    for (const value of Object.values(proxy)) {
      assert.ok(!runtime.diagnostics.some((line) => line.includes(value)), name);
    }
  }
});

test("Compute preserves admitted Codex commands and forwards proxy settings on new provider launches", async (t) => {
  const environment = {
    HTTPS_PROXY: "http://127.0.0.1:3128",
    https_proxy: "http://127.0.0.1:3129",
    FTP_PROXY: "ignored",
  };
  for (const [label, implementation, legacy, forwards] of [
    ["existing non-OpenShell Sandbox", "fixture-provider", true, false],
    ["new non-OpenShell Sandbox", "fixture-provider", false, true],
    ["new OpenShell Sandbox", "openshell", false, false],
  ]) {
    await t.test(label, async (t) => {
      const fixture = providerEndpointFixture();
      // The fixture's original revision was admitted for OpenShell. Its pre-marker
      // provider snapshot is the same one non-OpenShell revisions used before this change.
      const prior = fixture.revision.compute.admission;
      assert.ok(prior?.endsWith("openshell-codex-launch:v1:"));
      const legacyAdmission = prior.slice(0, -"openshell-codex-launch:v1:".length);
      Object.assign(fixture.sandbox, { implementation });
      const revision = {
        ...fixture.revision,
        compute: {
          ...fixture.revision.compute,
          admission: legacy ? legacyAdmission : fixture.driver.admitRevision(fixture.revision),
        },
      };
      await fixture.prepare(revision);
      fixture.setGatewayServing();
      await fixture.prepare(revision);
      assert.equal(fixture.provisions.length, 1);
      const { command } = fixture.provisions[0].requirements;
      if (legacy) {
        // Retry must replay the entire old command, not merely omit a proxy.
        // Full command captured from the same fixture on pre-proxy main (5563280bd8); it
        // embeds the startup schema thresholds, so it moves with the pin.
        assert.equal(
          createHash("sha256").update(JSON.stringify(command)).digest("hex"),
          "a7412cefc1b7f4cfa68243b92e3f9ea789376c9182e4291e1af2872c2bb216a0",
          "a stored Sandbox must keep its admitted command byte for byte",
        );
      }
      const { supervisor, codex } = inspectOpenShellCodexCommand(t, command, {
        compact: false,
        current: false,
      });
      const runtime = createCodexStartup(t, {
        environment,
        native: [
          login(),
          probe([
            { type: "turn.started" },
            { type: "item.completed", item: { type: "agent_message", text: "READY" } },
            { type: "turn.completed" },
          ]),
        ],
      });
      runtime.start(codex);
      runtime.assertNativeScriptConsumed();
      assert.equal(runtime.appServerStarts, 1);
      const [{ env }] = runtime.probeSpawns;
      assert.equal(env.HTTPS_PROXY, forwards ? environment.HTTPS_PROXY : undefined);
      assert.equal(env.https_proxy, forwards ? environment.https_proxy : undefined);
      assert.equal(env.FTP_PROXY, undefined);
      if (forwards) {
        // Observe both children of the delivered supervisor, before native code
        // runs. Only Codex should inherit the provider's proxy, not the file worker.
        const directory = await mkdtemp(join(tmpdir(), "codex-proxy-supervisor-"));
        const observed = await startSupervisor(t, directory, {
          entrypoint: supervisor,
          env: { ...environment, OPENCLAW_NODE_SETUP_CODE: "fixture-node-setup" },
          child: [
            "const [events, kind] = process.argv.slice(2);",
            "const args = Object.keys(process.env).filter(key => /_proxy$/i.test(key)).sort();",
            'require("node:fs").appendFileSync(events, JSON.stringify({ kind, args, pid: process.pid }) + "\\n");',
            "setInterval(() => {}, 60_000);",
          ],
        });
        const rows = await observed.waitFor("Codex and file worker reported proxy keys", (events) =>
          ["codex", "node"].every((kind) => events.some((event) => event.kind === kind)),
        );
        assert.deepEqual(rows.find((row) => row.kind === "node")?.args, []);
        assert.deepEqual(
          rows.find((row) => row.kind === "codex")?.args,
          Object.keys(environment).sort(),
        );
      }
    });
  }
});

test("a rejected Codex proxy credential stays out of diagnostics and the held failure", (t) => {
  const sentinel = ["invented", "proxy", "password"].join("-");
  const url = syntheticCredentialUrl({
    protocol: "http",
    username: "fixture",
    password: sentinel,
    host: "127.0.0.1",
    port: 3128,
    pathname: "/",
  });
  const message = "unexpected status 407 Proxy Authentication Required: " + url;
  const runtime = createCodexStartup(t, {
    environment: { HTTPS_PROXY: url },
    native: [
      login(),
      probe([{ type: "turn.started" }, failedTurn(message)], { status: 1, stderr: message }),
    ],
  });
  runtime.start(
    codexLaunchEntrypoint({ providerOwned: true, protected: false, explicitProxy: true }),
  );
  runtime.assertNativeScriptConsumed();
  assert.equal(runtime.appServerStarts, 0);
  assert.equal(runtime.probeSpawns[0].env.HTTPS_PROXY, url);
  const failure = runtime.status().runtimeFailure;
  assert.equal(failure?.code, "MODEL_PROBE_FAILED");
  assert.deepEqual(failure.cause, { kind: "PROBE_STATUS", detail: "turn-failed" });
  assert.ok(!(JSON.stringify(failure) + runtime.diagnostics.join("\n")).includes(sentinel));
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
  // Codex exits 1 before printing any event: the 2017 model check shape.
  const exited = (stderr, result) => probe([], { status: 1, stderr, ...result });
  const exitCause = (detail) => ({ kind: "PROCESS_EXIT", detail });
  const exitFailure = (detail) => probeFailure(exitCause(detail));
  await registerCodexPatLoginRetryCases(t, { success, ready, loginFailure });
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
  for (const scenario of probeScenarios) {
    // checkCodexStartup is async since protected startup awaits its release.
    await t.test(scenario.name, (t) => checkCodexStartup(t, scenario));
  }
});

test("a no-retry marker anywhere in the output vetoes a retry, whatever its class", () => {
  checkNoRetryOutput();
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

test("the Codex failure output classifier maps output to a closed class", () => {
  checkFailureOutputClasses(fakeSecrets.join(" "));
});

test("the Codex failure output classifier reads a bounded tail in linear time", () => {
  checkBoundedOutputTail();
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
  checkProbeEventPrecedence();
});

test("the Codex model check classifier reads a bounded share of stdout events in linear time", () => {
  checkBoundedProbeEvents();
});
