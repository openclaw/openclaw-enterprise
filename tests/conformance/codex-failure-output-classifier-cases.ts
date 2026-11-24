import assert from "node:assert/strict";
import vm from "node:vm";
import { CODEX_FAILURE_OUTPUT_CLASS_HELPER } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { CODEX_FAILURE_OUTPUT_CLASSES } from "../../packages/contracts/src/runtime-failure.ts";

type Output = string | null | undefined;
type ProcessError = Pick<NodeJS.ErrnoException, "code">;
// The wrapper checks the event type before classifying; message and payload fields
// can have any JSON shape, including the malformed shapes in these cases.
type ProbeEvent = { type: string; message?: unknown; error?: unknown; item?: unknown };
type ScanCounter = { chars: number };
type FailureClass = (typeof CODEX_FAILURE_OUTPUT_CLASSES)[number];

function errorEvent(message: string) {
  return { type: "error", message } as const;
}

function failedTurn(message: string) {
  return { type: "turn.failed", error: { message } } as const;
}

export const codexProbeEvents = { errorEvent, failedTurn };

function isScanCounter(value: unknown): value is ScanCounter {
  return (
    typeof value === "object" &&
    value !== null &&
    "chars" in value &&
    typeof value.chars === "number"
  );
}

function readFailureClass(value: unknown): FailureClass {
  assert.ok(typeof value === "string" && CODEX_FAILURE_OUTPUT_CLASSES.includes(value));
  return value;
}

function loadClassifier() {
  // Count the characters every substring search reads, in the classifier's own realm.
  const context = vm.createContext({});
  const loaded: unknown = vm.runInContext(
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
    ${CODEX_FAILURE_OUTPUT_CLASS_HELPER}
    ({
      classify: codexFailureOutputClass,
      classifyProbe: codexProbeFailureClass,
      eventText: codexFailureEventText,
      noRetry: codexNoRetryOutput,
      scanned,
      window: CODEX_FAILURE_OUTPUT_WINDOW,
    });`,
    context,
  );
  assert.ok(typeof loaded === "object" && loaded !== null);
  assert.ok("classify" in loaded && typeof loaded.classify === "function");
  assert.ok("classifyProbe" in loaded && typeof loaded.classifyProbe === "function");
  assert.ok("eventText" in loaded && typeof loaded.eventText === "function");
  assert.ok("noRetry" in loaded && typeof loaded.noRetry === "function");
  assert.ok("scanned" in loaded && isScanCounter(loaded.scanned));
  assert.ok("window" in loaded && typeof loaded.window === "number");

  const { classify, classifyProbe, eventText, noRetry, scanned, window } = loaded;
  return {
    classify(output: Output, error?: ProcessError): FailureClass {
      return readFailureClass(classify(output, error));
    },
    classifyProbe(
      stderr: Output,
      events?: readonly ProbeEvent[],
      error?: ProcessError,
    ): FailureClass {
      return readFailureClass(classifyProbe(stderr, events, error));
    },
    eventText(events: readonly ProbeEvent[]): string {
      const result: unknown = eventText(events);
      assert.ok(typeof result === "string");
      return result;
    },
    noRetry(...texts: Output[]): boolean {
      const result: unknown = noRetry(...texts);
      assert.ok(typeof result === "boolean");
      return result;
    },
    scanned,
    window,
  };
}

export function checkNoRetryOutput(): void {
  const { noRetry } = loadClassifier();
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
    assert.equal(noRetry(text), true, text);
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
    assert.equal(noRetry(text), false, text);
  }
  assert.equal(noRetry(undefined, "connection reset", "Unauthorized"), true);
  assert.equal(noRetry(undefined, null), false);
}

export function checkFailureOutputClasses(secretOutput: string): void {
  const { classify } = loadClassifier();
  const cases: readonly [Output, ProcessError | undefined, FailureClass][] = [
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
    [secretOutput, undefined, "unknown"],
  ];
  for (const [output, error, expected] of cases) {
    const actual = classify(output, error);
    assert.equal(actual, expected, JSON.stringify(output));
  }
}

export function checkBoundedOutputTail(): void {
  const { classify, scanned, window } = loadClassifier();
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
}

export function checkProbeEventPrecedence(): void {
  const { classify, classifyProbe, eventText, window } = loadClassifier();
  const advisory = {
    type: "item.completed",
    item: { type: "error", message: "unexpected status 401 Unauthorized" },
  };
  const answer = {
    type: "item.completed",
    item: { type: "agent_message", text: "unexpected status 401 Unauthorized" },
  };
  const cases: readonly [
    stderr: Output,
    events: readonly ProbeEvent[] | undefined,
    error: ProcessError | undefined,
    expected: FailureClass,
  ][] = [
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
}

export function checkBoundedProbeEvents(): void {
  const { classifyProbe, eventText, scanned, window } = loadClassifier();
  // Two sources, each searched at most once per marker over at most one window.
  const budget = 2 * 32 * window;
  const shapes: readonly ((unit: string, length: number) => ProbeEvent[])[] = [
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
        classifyProbe("", events);
        assert.ok(
          scanned.chars <= budget,
          `${JSON.stringify(unit)} x ${length}: read ${scanned.chars} > ${budget}`,
        );
      }
    }
  }
}
