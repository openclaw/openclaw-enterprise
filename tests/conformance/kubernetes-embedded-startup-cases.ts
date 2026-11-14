import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import {
  createKubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { RuntimeFailureCause } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  authContext,
  options,
  routedRevision,
  tenant,
} from "../helpers/kubernetes-routed-scenarios.mjs";

type ProbeFixture = {
  responseProvider?: string;
  upfront?: boolean;
  processFailure?: "nonzero" | "buffer" | "invalid-json" | "cap";
  windowCpuWaitMs?: number;
  cpuCountersGrow?: boolean;
  pressureUnavailable?: boolean;
  cleanupFails?: boolean;
};

type ProbeExpectation = {
  cpuWait?: [total: number, pressure: number | null, throttled: number];
  timeoutWindow?: [duration: number, cpuWait: number, idle: number];
  cleanupError?: string;
};

type ProbeCase = [
  name: string,
  probeStatus: string | undefined,
  failureCode: string | undefined,
  cause?: RuntimeFailureCause | undefined,
  fixture?: ProbeFixture,
  expected?: ProbeExpectation,
];

type ProbeCall = {
  command: string;
  args: string[];
  environment: Record<string, string>;
  timeout: number;
};

type StatusHandler = (
  request: { method: string; url: string },
  response: { writeHead(): void; end(chunk: string): void },
) => void;

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type EnvironmentVariable = InstanceType<KubernetesSdk["V1EnvVar"]>;

function jsonRecord(text: string | undefined) {
  assert.ok(typeof text === "string", "expected a JSON string");
  const value = asRecord(JSON.parse(text));
  assert.ok(value, "expected a JSON object");
  return value;
}

export async function checkEmbeddedStartupProbe(t: TestContext) {
  const nodeRequire = createRequire(import.meta.url);
  function assertProbeStageDiagnostics(
    lines: readonly string[],
    expectedOtherLines: readonly string[],
    elapsedMs: number,
    expectedStages = ["prepare", "preflight", "spawn", "returned", "cleanup", "complete"],
  ) {
    const stageLines = lines.filter((line) => line.includes('"openclaw.model_probe_stage"'));
    const stages = stageLines.map(jsonRecord);
    assert.deepEqual(
      stages.map(({ stage }) => stage),
      expectedStages,
    );
    let previousElapsedMs = 0;
    for (const stage of stages) {
      // Only this closed, nonsecret schema may leave the unexpected-stderr set.
      assert.deepEqual(Object.keys(stage).sort(), ["capMs", "elapsedMs", "event", "stage"]);
      assert.equal(stage.event, "openclaw.model_probe_stage");
      assert.equal(stage.capMs, 110_000);
      assert.ok(typeof stage.elapsedMs === "number" && Number.isSafeInteger(stage.elapsedMs));
      assert.ok(stage.elapsedMs >= previousElapsedMs && stage.elapsedMs <= elapsedMs);
      previousElapsedMs = stage.elapsedMs;
    }
    assert.deepEqual(
      lines.filter((line) => !stageLines.includes(line)),
      expectedOtherLines,
    );
  }
  for (const [provider, model, credentialName] of [
    ["openai", "gpt-5", "OPENAI_API_KEY"],
    ["anthropic", "claude-sonnet-4-5", "ANTHROPIC_API_KEY"],
  ] as const) {
    // A failed model probe publishes a classified cause from a closed vocabulary.
    const cases: readonly ProbeCase[] = [
      ["accepted", "ok", undefined],
      [
        "wrong provider result",
        "ok",
        "MODEL_PROBE_FAILED",
        { kind: "INVALID_OUTPUT", detail: "shape" },
        { responseProvider: "another-provider" },
      ],
      // OpenClaw buckets provider 401/403 and invalid-key responses as "auth".
      ["credentials rejected", "auth", "AUTHENTICATION_FAILED"],
      // The provider's 401 to the upfront request ends the probe before OpenClaw starts.
      [
        "credentials rejected upfront",
        undefined,
        "AUTHENTICATION_FAILED",
        undefined,
        { upfront: true },
      ],
      [
        "provider unavailable",
        "unknown",
        "MODEL_PROBE_FAILED",
        { kind: "PROBE_STATUS", detail: "unknown" },
      ],
      // A provider 429, usage limit or exhausted quota: OpenClaw's "rate_limit" bucket.
      [
        "provider rate limit",
        "rate_limit",
        "MODEL_PROBE_FAILED",
        { kind: "PROBE_STATUS", detail: "rate_limit" },
      ],
      // An unknown model or invalid provider settings: OpenClaw's "format" bucket.
      [
        "provider rejected the request format",
        "format",
        "MODEL_PROBE_FAILED",
        { kind: "PROBE_STATUS", detail: "format" },
      ],
      [
        "unrecognized probe status",
        "fixture-model-key",
        "MODEL_PROBE_FAILED",
        { kind: "PROBE_STATUS", detail: "other" },
      ],
      [
        "probe exited nonzero",
        undefined,
        "MODEL_PROBE_FAILED",
        { kind: "PROCESS_EXIT", detail: "exit-1" },
        { processFailure: "nonzero" },
      ],
      [
        "probe output exceeded its buffer",
        undefined,
        "MODEL_PROBE_FAILED",
        { kind: "PROCESS_EXIT", detail: "error-ENOBUFS" },
        { processFailure: "buffer" },
      ],
      [
        "probe output is not JSON",
        undefined,
        "MODEL_PROBE_FAILED",
        { kind: "INVALID_OUTPUT", detail: "json" },
        { processFailure: "invalid-json" },
      ],
      // OpenClaw's own 15 s timer ends the probe. Its window is judged on the CPU wait the
      // CLI preload read inside it, not on the whole run: a boot throttled at the CPU
      // limit before that timer started is not starvation (finding 2675).
      [
        "provider timeout",
        "timeout",
        "MODEL_PROBE_TIMEOUT",
        undefined,
        { windowCpuWaitMs: 500 },
        { timeoutWindow: [15_000, 500, 15_000] },
      ],
      [
        "provider timeout after a throttled boot",
        "timeout",
        "MODEL_PROBE_TIMEOUT",
        undefined,
        { cpuCountersGrow: true, windowCpuWaitMs: 500 },
        { cpuWait: [100_000, 100_000, 100_000], timeoutWindow: [15_000, 500, 15_000] },
      ],
      [
        "provider timeout while waiting for CPU in its window",
        "timeout",
        "MODEL_PROBE_CPU_STARVED",
        undefined,
        { cpuCountersGrow: true, windowCpuWaitMs: 9_000 },
        { cpuWait: [100_000, 100_000, 100_000], timeoutWindow: [15_000, 9_000, 0] },
      ],
      ["provider timeout without a window reading", "timeout", "MODEL_PROBE_TIMEOUT"],
      // The wrapper's cap ends the probe. Only CPU waiting for most of it makes
      // the failure CPU starvation, which fails the deployment at once.
      [
        "cap exceeded while waiting for CPU",
        undefined,
        "MODEL_PROBE_CPU_STARVED",
        undefined,
        { processFailure: "cap", cpuCountersGrow: true },
        { cpuWait: [100_000, 100_000, 100_000] },
      ],
      [
        "cap exceeded without CPU waiting",
        undefined,
        "MODEL_PROBE_TIMEOUT",
        undefined,
        { processFailure: "cap" },
      ],
      // Without pressure accounting, CPU-limit throttling is the waiting evidence.
      [
        "cap exceeded while throttled without pressure accounting",
        undefined,
        "MODEL_PROBE_CPU_STARVED",
        undefined,
        { processFailure: "cap", cpuCountersGrow: true, pressureUnavailable: true },
        { cpuWait: [100_000, null, 100_000] },
      ],
      // Children of the killed probe can still write into its directory, so its
      // removal fails; the classified result must still be logged and published.
      [
        "cap exceeded while waiting for CPU, cleanup fails",
        undefined,
        "MODEL_PROBE_CPU_STARVED",
        undefined,
        { processFailure: "cap", cpuCountersGrow: true, cleanupFails: true },
        { cpuWait: [100_000, 100_000, 100_000], cleanupError: "ENOTEMPTY" },
      ],
    ];
    for (const [name, probeStatus, failureCode, cause, fixture = {}, expected = {}] of cases) {
      const accepted = failureCode === undefined;
      const upfront = fixture.upfront === true;
      const providerText = "provider-detail: HTTP 404 for key fixture-model-key";
      await t.test(`${provider}: ${name}`, async () => {
        const driver = createKubernetesComputeDriver(options());
        const candidate = routedRevision(driver, {
          harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
          configuration: { agents: { defaults: { model: `${provider}/${model}` } } },
        });
        const prepared = driver["harnessAuthForRevision"](candidate, authContext(candidate), {
          name: kubernetesNamespaceName(tenant.id),
          plane: "control",
        });
        const files = new Map<string, string>();
        const calls: ProbeCall[] = [];
        const errors: string[] = [];
        const signals = new Map<NodeJS.Signals, () => void>();
        const childEvents = new Map<
          string,
          (code: number | null, signal: NodeJS.Signals | null) => void
        >();
        const childSignals: NodeJS.Signals[] = [];
        const exits: number[] = [];
        const timers: { callback: () => void; delay: number }[] = [];
        const removals: [string, Record<string, unknown>][] = [];
        let probeTemplate: string | undefined;
        let pressureReads = 0;
        let throttledReads = 0;
        let started = false;
        let held = false;
        let statusHandler: StatusHandler | undefined;
        // Stub native process I/O only: execute the complete generated startup
        // program and its real probe result validation, without claiming a model turn.
        runInNewContext(GATEWAY_RUNTIME_ENTRYPOINT, {
          Buffer,
          JSON,
          URL,
          console: { error: (value: string) => errors.push(value) },
          process: {
            env: Object.fromEntries([
              ...prepared.environment.map((entry: EnvironmentVariable) => [
                entry.name,
                entry.value ?? "fixture-model-key",
              ]),
              ["TMPDIR", "/approved-temporary"],
              ["NODE_EXTRA_CA_CERTS", "/run/openshell/ca.crt"],
              ["SSL_CERT_FILE", "/run/openshell/ca-bundle.crt"],
              ["OPENCLAW_AGENT_REVISION_ID", "revision-embedded-probe"],
              ["OPENCLAW_RUNTIME_STATUS_CONTAINER", "gateway"],
              ["OPENCLAW_RUNTIME_STATUS_PORT", "18791"],
              ["OPENCLAW_POD_UID", "pod-embedded-probe"],
            ]),
            on(signal: NodeJS.Signals, callback: () => void) {
              signals.set(signal, callback);
            },
            exit(code: number) {
              exits.push(code);
            },
            execPath: "/usr/local/bin/node",
          },
          setTimeout(callback: () => void, delay: number) {
            timers.push({ callback, delay });
            return { unref() {} };
          },
          setInterval() {
            held = true;
            return { unref() {} };
          },
          require(specifier: string) {
            if (specifier === "node:http") {
              return {
                createServer(handler: StatusHandler) {
                  statusHandler = handler;
                  return { listen() {} };
                },
              };
            }
            if (specifier === "node:fs") {
              return {
                mkdirSync() {},
                mkdtempSync(template: string) {
                  probeTemplate = template;
                  return "/isolated-probe";
                },
                // This fresh Gateway has no pending maintenance marker.
                lstatSync() {
                  throw Object.assign(new Error("File not found"), { code: "ENOENT" });
                },
                writeFileSync(path: string, value: string) {
                  files.set(path, value);
                },
                rmSync(path: string, options: Record<string, unknown>) {
                  removals.push([path, { ...options }]);
                  if (fixture.cleanupFails) {
                    throw Object.assign(new Error("directory not empty /isolated-probe"), {
                      code: "ENOTEMPTY",
                    });
                  }
                },
                // A 500m CPU limit; each wait counter grows 100 s across a starved probe.
                readFileSync(path: string) {
                  if (path === "/sys/fs/cgroup/cpu.max") {
                    return "50000 100000\n";
                  }
                  if (path === "/sys/fs/cgroup/cpu.pressure" && !fixture.pressureUnavailable) {
                    const total = fixture.cpuCountersGrow ? pressureReads++ * 1e8 : 0;
                    return `some avg10=0.00 avg60=0.00 avg300=0.00 total=${total}\nfull total=0\n`;
                  }
                  if (path === "/sys/fs/cgroup/cpu.stat") {
                    // 1000 throttled 100 ms periods bound the 100 s of throttled time.
                    const reads = fixture.cpuCountersGrow ? throttledReads++ : 0;
                    return `usage_usec 1\nnr_throttled ${reads * 1000}\nthrottled_usec ${reads * 1e8}\n`;
                  }
                  // The CLI preload's samples across OpenClaw's 15 s timeout window.
                  if (
                    path === "/isolated-probe/cpu-window.json" &&
                    fixture.windowCpuWaitMs !== undefined
                  ) {
                    const waitMs = fixture.windowCpuWaitMs;
                    return JSON.stringify([
                      [1_000, 0, 0, 0],
                      [16_000, waitMs, waitMs, 15_000],
                    ]);
                  }
                  throw Object.assign(new Error("unexpected read"), { code: "ENOENT" });
                },
              };
            }
            if (specifier === "node:child_process") {
              return {
                spawnSync(
                  command: string,
                  args: readonly string[],
                  options: { env: Record<string, string>; timeout: number },
                ) {
                  calls.push({
                    command,
                    args: Array.from(args),
                    environment: { ...options.env },
                    timeout: options.timeout,
                  });
                  if (args[0] === "-e") {
                    // The upfront request's child exits 3-6 (plus 10 or 20 for the
                    // responder) only on the provider's 401: 13 is an unclassified
                    // 401 that carried OpenAI's response headers. Its stdout names
                    // the body's shape and closed-set error code and type.
                    return {
                      status: upfront ? 13 : 0,
                      stdout: upfront ? '["json-error-code","other","invalid_request_error"]' : "",
                    };
                  }
                  if (fixture.processFailure === "cap") {
                    return {
                      status: null,
                      signal: "SIGKILL",
                      stdout: "",
                      error: { code: "ETIMEDOUT" },
                    };
                  }
                  // Native output and provider text that echo the credential
                  // must never reach the published cause or the probe log.
                  if (fixture.processFailure === "nonzero") {
                    return { status: 1, signal: null, stdout: "", stderr: providerText };
                  }
                  if (fixture.processFailure === "buffer") {
                    return {
                      status: null,
                      signal: "SIGTERM",
                      stdout: providerText,
                      error: { code: "ENOBUFS", message: providerText },
                    };
                  }
                  if (fixture.processFailure === "invalid-json") {
                    return { status: 0, stdout: providerText };
                  }
                  return {
                    status: 0,
                    stdout: JSON.stringify({
                      auth: {
                        probes: {
                          results: [
                            {
                              provider: fixture.responseProvider ?? provider,
                              model: `${provider}/${model}`,
                              source: "env",
                              status: probeStatus,
                              error: providerText,
                            },
                          ],
                        },
                      },
                    }),
                  };
                },
                spawn() {
                  started = true;
                  return {
                    kill(signal: NodeJS.Signals) {
                      childSignals.push(signal);
                    },
                    on(
                      event: string,
                      callback: (code: number | null, signal: NodeJS.Signals | null) => void,
                    ) {
                      childEvents.set(event, callback);
                    },
                  };
                },
              };
            }
            return nodeRequire(specifier);
          },
        });
        await Promise.resolve();
        assert.equal(calls.length, upfront ? 1 : 2);
        assert.equal(probeTemplate, "/approved-temporary/openclaw-auth-probe-");
        // The upfront request carries the credential as OpenClaw sends it to
        // the provider's default endpoint, the closed sets of error codes (C) and
        // types (T) it may name, and nothing else from the environment.
        const [upfrontCall, probeCall] = calls;
        assert.ok(upfrontCall, "expected the provider preflight child");
        assert.equal(upfrontCall.command, "/usr/local/bin/node");
        assert.equal(upfrontCall.timeout, 10_000);
        assert.deepEqual(Object.keys(upfrontCall.environment).sort(), [
          "C",
          "H",
          "NODE_EXTRA_CA_CERTS",
          "SSL_CERT_FILE",
          "T",
          "U",
        ]);
        assert.ok(upfrontCall.environment.C);
        const codes: unknown = JSON.parse(upfrontCall.environment.C);
        assert.ok(Array.isArray(codes) && codes.includes("invalid_api_key"));
        assert.ok(upfrontCall.environment.T);
        const types: unknown = JSON.parse(upfrontCall.environment.T);
        assert.ok(Array.isArray(types) && types.includes("invalid_request_error"));
        assert.equal(upfrontCall.environment.NODE_EXTRA_CA_CERTS, "/run/openshell/ca.crt");
        assert.deepEqual(
          [upfrontCall.environment.U, jsonRecord(upfrontCall.environment.H)],
          provider === "openai"
            ? [
                "https://api.openai.com/v1/responses",
                { authorization: "Bearer fixture-model-key", "content-type": "application/json" },
              ]
            : [
                "https://api.anthropic.com/v1/messages",
                {
                  "x-api-key": "fixture-model-key",
                  "anthropic-version": "2023-06-01",
                  "content-type": "application/json",
                },
              ],
        );
        if (!upfront) {
          assert.ok(probeCall, "expected the isolated probe child");
          assert.equal(probeCall.environment.TMPDIR, "/isolated-probe");
          // The CLI loads the CPU window preload from its own probe directory.
          assert.deepEqual(probeCall.args.slice(0, 3), [
            "--require",
            "/isolated-probe/cpu-window.cjs",
            "/app/openclaw.mjs",
          ]);
          const preload = files.get("/isolated-probe/cpu-window.cjs");
          assert.ok(preload, "expected the CPU window preload");
          assert.match(preload, /\/isolated-probe\/cpu-window\.json/);
          // OpenClaw's 15 s probe timeout (its whole isolated run), 5 s slack, and
          // 45 CPU-seconds at the 500m limit.
          assert.equal(probeCall.timeout, 110_000);
          assert.equal(probeCall.environment.NODE_EXTRA_CA_CERTS, "/run/openshell/ca.crt");
          assert.equal(probeCall.environment.SSL_CERT_FILE, "/run/openshell/ca-bundle.crt");
          assert.equal(probeCall.args[probeCall.args.indexOf("--probe-provider") + 1], provider);
          // Room for a reasoning model to finish thinking and still return text.
          assert.equal(probeCall.args[probeCall.args.indexOf("--probe-max-tokens") + 1], "256");
          assert.equal(probeCall.environment[credentialName], "fixture-model-key");
          assert.equal(
            probeCall.environment[provider === "openai" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"],
            undefined,
          );
          assert.equal(
            asRecord(
              asRecord(jsonRecord(files.get("/isolated-probe/openclaw.json")).agents)?.defaults,
            )?.model,
            `${provider}/${model}`,
          );
        }
        assert.equal(started, accepted);
        assert.equal(held, !accepted);
        const phaseLines = errors.filter((line) => line.includes('"runtime.startup_phase"'));
        const probeLines = errors.filter((line) => line.includes('"openclaw.model_probe"'));
        assert.equal(probeLines.length, 1);
        const [probeLine] = probeLines;
        assert.ok(probeLine, "expected the probe result log");
        const probeLog = jsonRecord(probeLine);
        const { elapsedMs } = probeLog;
        assert.ok(typeof elapsedMs === "number");
        const otherLines = errors.filter(
          (line) => !phaseLines.includes(line) && !probeLines.includes(line),
        );
        assertProbeStageDiagnostics(
          otherLines,
          accepted ? [] : ["Harness model authentication probe failed."],
          elapsedMs,
          upfront ? ["prepare", "preflight", "cleanup", "complete"] : undefined,
        );
        if (provider === "openai" && accepted) {
          // Mutate actual generated diagnostics: a permissive filter must not
          // conceal malformed fields, secret-bearing records or unexpected logs.
          const firstStage = jsonRecord(otherLines[0]);
          for (const [name, line] of [
            ["malformed JSON", '{"event":"openclaw.model_probe_stage"'],
            ["unknown event", JSON.stringify({ ...firstStage, event: "unexpected.event" })],
            ["unknown stage", JSON.stringify({ ...firstStage, stage: "unexpected" })],
            ["secret field", JSON.stringify({ ...firstStage, credential: "fixture-model-key" })],
            ["secret stage", JSON.stringify({ ...firstStage, stage: "fixture-model-key" })],
            ["string time", JSON.stringify({ ...firstStage, elapsedMs: "fixture-model-key" })],
            ["missing time", JSON.stringify({ ...firstStage, elapsedMs: undefined })],
            ["null time", JSON.stringify({ ...firstStage, elapsedMs: null })],
            ["negative time", JSON.stringify({ ...firstStage, elapsedMs: -1 })],
            ["fractional time", JSON.stringify({ ...firstStage, elapsedMs: 0.5 })],
            ["unsafe time", JSON.stringify({ ...firstStage, elapsedMs: Number.MAX_VALUE })],
            ["late time", JSON.stringify({ ...firstStage, elapsedMs: elapsedMs + 1 })],
            ["wrong cap", JSON.stringify({ ...firstStage, capMs: 600_000 })],
          ] as const) {
            assert.throws(
              () => assertProbeStageDiagnostics([line, ...otherLines.slice(1)], [], elapsedMs),
              { name: name === "malformed JSON" ? "SyntaxError" : "AssertionError" },
              name,
            );
          }
          const [prepare, preflight] = otherLines;
          assert.ok(prepare && preflight);
          for (const lines of [
            otherLines.slice(1),
            [...otherLines, prepare],
            [preflight, prepare, ...otherLines.slice(2)],
            [...otherLines, "unexpected fixture-model-key"],
          ]) {
            assert.throws(() => assertProbeStageDiagnostics(lines, [], elapsedMs), {
              name: "AssertionError",
            });
          }
        }
        assert.deepEqual([probeLog.code, probeLog.capMs], [failureCode ?? "READY", 110_000]);
        // The probe directory removal retries briefly; a failure that remains is
        // logged as its error code only, never its message or path.
        assert.deepEqual(removals, [
          ["/isolated-probe", { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }],
        ]);
        assert.equal(probeLog.cleanupError, expected.cleanupError);
        assert.doesNotMatch(probeLine, /isolated-probe|not empty/);
        const [cpuWaitMs, pressureWaitMs, throttledWaitMs] = expected.cpuWait ?? [0, 0, 0];
        assert.equal(probeLog.cpuWaitMs, cpuWaitMs);
        assert.deepEqual(
          [probeLog.timeoutWindowMs, probeLog.timeoutWindowCpuWaitMs, probeLog.timeoutWindowIdleMs],
          expected.timeoutWindow ?? [undefined, undefined, undefined],
        );
        // The event records each counter's delta; without pressure accounting PSI has none.
        assert.deepEqual(
          [probeLog.pressureWaitMs, probeLog.throttledWaitMs],
          [pressureWaitMs, throttledWaitMs],
        );
        const providerDetails = new RegExp(
          [provider, model, credentialName, "fixture-model-key"].join("|"),
        );
        assert.doesNotMatch(probeLine, providerDetails);
        // Startup timing names phases only, never the provider, model or credential.
        assert.deepEqual(
          phaseLines.map((line) => {
            const { container, phase, outcome } = jsonRecord(line);
            return [container, phase, outcome];
          }),
          [
            ["gateway", "model-probe", accepted ? "ok" : "failed"],
            ...(accepted ? [["gateway", "native-spawn", "ok"]] : []),
          ],
        );
        assert.doesNotMatch(phaseLines.join("\n"), providerDetails);
        let body = "";
        assert.ok(statusHandler, "expected the private runtime HTTP handler");
        statusHandler(
          { method: "GET", url: "/openclaw/runtime/status" },
          { writeHead() {}, end: (chunk) => (body += chunk) },
        );
        const runtimeFailure = asRecord(jsonRecord(body).runtimeFailure);
        assert.equal(runtimeFailure?.code, failureCode);
        assert.deepEqual(runtimeFailure?.cause, cause);
        assert.deepEqual(probeLog.cause, cause);
        // The log line keeps the provider's HTTP status from its error, never the text;
        // the upfront rejection names its 401, who answered it and only a
        // closed-vocabulary code.
        assert.equal(
          probeLog.providerStatus,
          upfront ? 401 : cause?.kind === "PROBE_STATUS" ? 404 : undefined,
        );
        assert.equal(probeLog.providerCode, undefined);
        assert.equal(probeLog.responseHeaderMarker, upfront ? "provider-like" : undefined);
        assert.equal(probeLog.bodyShape, upfront ? "json-error-code" : undefined);
        assert.equal(probeLog.providerErrorCode, upfront ? "other" : undefined);
        assert.equal(probeLog.providerErrorType, upfront ? "invalid_request_error" : undefined);
        assert.doesNotMatch(body + probeLine, /fixture-model-key|provider-detail/);
        if (accepted) {
          const terminate = signals.get("SIGTERM");
          assert.ok(terminate, "expected the Gateway termination handler");
          terminate();
          assert.deepEqual(childSignals, ["SIGTERM"]);
          // An admitted turn can take longer than the old eight-second wrapper
          // timeout to settle. Advance only the supervisor timers; native drain
          // and model completion are proved by the real-runtime acceptance.
          for (const timer of timers.filter(({ delay }) => delay <= 9_000)) {
            timer.callback();
          }
          assert.deepEqual(childSignals, ["SIGTERM"], "must allow a nine-second drain");
          assert.deepEqual(exits, [], "supervisor must wait for the child to finish");
          const exit = childEvents.get("exit");
          assert.ok(exit, "expected the native Gateway exit handler");
          exit(0, null);
          assert.deepEqual(exits, [0], "clean Gateway completion exits the supervisor");
        }
      });
    }
  }
}
