import { login, probe, timedOut } from "../fixtures/codex-native-startup.mjs";
import type {
  FailureClass,
  JsonValue,
  NativeProcessResult,
  NativeStep,
  StartupExpectation,
  StartupScenario,
} from "../fixtures/codex-native-startup-types.ts";
import { codexProbeEvents } from "./codex-failure-output-classifier-cases.ts";

export type Ready = StartupExpectation & { readonly code: "READY" };

type FailureCause = NonNullable<StartupExpectation["cause"]>;
type Provider = NonNullable<StartupExpectation["provider"]>;
type ProbeFailureExpectation = StartupExpectation & {
  readonly check: "model-probe";
  readonly code: "MODEL_PROBE_FAILED";
};
type ProbeFailure = (cause?: FailureCause, provider?: Provider) => ProbeFailureExpectation;
type ModelProbeScenario = Extract<
  StartupScenario,
  { native: readonly NativeStep[]; expect: StartupExpectation }
> & {
  readonly name: string;
};
type ProbeFailureRow = readonly [
  description: string,
  first: NativeStep<"probe">,
  detail: string,
  provider?: Provider | undefined,
  kind?: "PROBE_STATUS" | "PROCESS_EXIT",
];
type NetworkWaitAttempt = readonly [
  description: string,
  events: readonly JsonValue[],
  result?: Partial<NativeProcessResult> | undefined,
  detail?: string,
];
type RecoveredNotice = readonly [order: string, events: readonly JsonValue[]];
type ProbeRefusal = readonly [description: string, stderr: string, failureClass: FailureClass];

export function probeFailure(cause?: FailureCause, provider?: Provider): ProbeFailureExpectation {
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

export const probeTimeout = {
  ...probeFailure(),
  code: "MODEL_PROBE_TIMEOUT",
} satisfies StartupExpectation & { readonly code: "MODEL_PROBE_TIMEOUT" };

const { errorEvent, failedTurn } = codexProbeEvents;

export function transientProbeRetryCases({
  killed,
  ready,
  probeFailure,
}: {
  readonly killed: NativeStep<"probe">;
  readonly ready: Ready;
  readonly probeFailure: ProbeFailure;
}): readonly ModelProbeScenario[] {
  const started = { type: "turn.started" };
  const assistant = { type: "item.completed", item: { type: "agent_message", text: "READY" } };
  const completed = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
  const success = probe([started, assistant, completed]);
  const failedWith = (message: string, elapsed?: number) =>
    probe([started, failedTurn(message)], { status: 1 }, undefined, elapsed);
  const erroredWith = (message: string) => probe([started, errorEvent(message)], { status: 1 });
  const recoveredNotice = errorEvent("Reconnecting... 1/3 stream disconnected before completion");
  // Finding 1618: the pinned Codex build prints this for a provider it cannot connect to
  // (refused, unresolvable or failed TLS alike) and keeps waiting until the probe times out.
  // Finding 1621: only this exact text is transient; any other cause is held.
  const networkWait = (cause = "Connection failed: error sending request") =>
    errorEvent(`Reconnecting... waiting for network (${cause})`);
  const unreachable = probe([started, networkWait(), networkWait()], timedOut, 30000);
  // Each transient class, by the one marker that makes it transient.
  const transient: readonly ProbeFailureRow[] = [
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
  const heldAtOnce: readonly ProbeFailureRow[] = [
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
    ].map<ProbeFailureRow>((cause) => [
      `a network wait for "${cause}"`,
      erroredWith(networkWait(cause).message),
      "error-event",
    ]),
  ];
  const scenarios: readonly ModelProbeScenario[] = [
    ...heldAtOnce.map<ModelProbeScenario>(([description, first, detail, provider]) => ({
      name: `${description} is held at once, with no second probe`,
      native: [login(), first],
      expect: probeFailure({ kind: "PROBE_STATUS", detail }, provider),
    })),
    ...transient.map<ModelProbeScenario>(([description, first]) => ({
      name: `${description} recovers on the second attempt`,
      native: [login(), first, success],
      retryAfterMs: 1000,
      expect: ready,
      probeCodes: ["MODEL_PROBE_FAILED", "READY"],
    })),
    ...transient.map<ModelProbeScenario>(
      ([description, first, detail, provider, kind = "PROBE_STATUS"]) => ({
        name: `${description} twice holds the second cause, marked as retried`,
        native: [login(), first, first],
        retryAfterMs: 1000,
        expect: probeFailure({ kind, detail: `${detail}-attempt2` }, provider),
        lastProbeCause: { kind, detail },
        probeCodes: ["MODEL_PROBE_FAILED", "MODEL_PROBE_FAILED"],
      }),
    ),
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
    ...(
      [
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
      ] satisfies readonly NetworkWaitAttempt[]
    ).map<ModelProbeScenario>(
      ([description, events, result, detail = "error-event"]: NetworkWaitAttempt) => ({
        name: `${description} in one attempt is still retried`,
        native: [login(), probe(events, result), success],
        retryAfterMs: 1000,
        expect: ready,
        probeCodes: ["MODEL_PROBE_FAILED", "READY"],
        probeCauses: [{ kind: "PROBE_STATUS", detail }, undefined],
      }),
    ),
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
    ...(
      [
        ["before", [recoveredNotice, errorEvent("unexpected status 503")]],
        ["after", [errorEvent("unexpected status 503"), recoveredNotice]],
      ] satisfies readonly RecoveredNotice[]
    ).map<ModelProbeScenario>(([order, events]: RecoveredNotice) => ({
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
  ];
  return scenarios;
}

export function modelProbeReliabilityCases({
  started,
  success,
  ready,
  probeFailure,
  probeTimeout,
}: {
  readonly started: JsonValue;
  readonly success: NativeStep<"probe">;
  readonly ready: Ready;
  readonly probeFailure: ProbeFailure;
  readonly probeTimeout: StartupExpectation & { readonly code: "MODEL_PROBE_TIMEOUT" };
}): readonly ModelProbeScenario[] {
  // Codex exits 1 before printing any event: the 2017 model check shape.
  const exited = (stderr: string, result?: Partial<NativeProcessResult>) =>
    probe([], { status: 1, stderr, ...result });
  const exitCause = (detail: string): FailureCause => ({ kind: "PROCESS_EXIT", detail });
  const exitFailure = (detail: string) => probeFailure(exitCause(detail));
  const probeScenarios: readonly ModelProbeScenario[] = [
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
    ...(
      [
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
      ] satisfies readonly ProbeRefusal[]
    ).map<ModelProbeScenario>(([description, stderr, failureClass]: ProbeRefusal) => ({
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
  return probeScenarios;
}
