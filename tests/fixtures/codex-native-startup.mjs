import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  COMPUTE_RELEASE_PUBLIC_KEY,
  computeReleasePublicKey,
  harnessEgressEnrollment,
  signComputeExecutionRelease,
} from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { pluginRuntimeEnvironment } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { CODEX_FAILURE_OUTPUT_CLASSES } from "../../packages/contracts/src/runtime-failure.mjs";

const nodeRequire = createRequire(import.meta.url);
const revisionId = "revision-runtime-auth-gate";
const transportToken = "fixture-transport-token";
const tokenDigest = createHash("sha256").update(transportToken).digest("hex");
const providerPlaceholder = "openshell:resolve:env:v7_CODEX_ACCESS_TOKEN";
const modelCredentials = ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_CHATGPT_WORKSPACE_ID"];
const transportCredentials = ["APP_SERVER_TOKEN", "APP_TOKEN_SHA"];

export const timedOut = { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" } };
// elapsed advances the fixture clock by a login's run time when it does not time out.
export function login(result = { status: 0 }, timeout, elapsed) {
  return { operation: "login", result, timeout, elapsed };
}
// elapsed advances the fixture clock by a probe's run time when it does not time out.
export function probe(events, result = {}, timeout, elapsed) {
  return {
    operation: "probe",
    result: {
      status: 0,
      stdout: events.map((event) => JSON.stringify(event)).join("\n"),
      ...result,
    },
    timeout,
    elapsed,
  };
}

export function readStatusFromHandler(handler, path = "/openclaw/plugin-runtime/status") {
  let body = "";
  handler(
    { method: "GET", url: path },
    {
      writeHead() {},
      end(chunk) {
        body += chunk;
      },
    },
  );
  return JSON.parse(body);
}

export function readRuntimeStatusFromHandler(handler) {
  return readStatusFromHandler(handler, "/openclaw/runtime/status");
}

// Substitute only native process output; execute the production login/probe
// parser and readiness control flow unmodified. No native provider is contacted.
export function createCodexStartup(
  t,
  {
    native,
    providerPat = false,
    loginMode = providerPat ? "codex_pat" : "api_key",
    protectedInference,
    transportToken: tokenMode = protectedInference ? "verifier" : "raw",
    // The retry jitter's Math.random() value, fixed so a retry's delay is exact.
    random = 0,
    // How much later than asked a login retry wait wakes (a throttled or stopped process).
    lateWakeMs = 0,
  },
) {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-plugin-ready-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, "ready");
  const codexHome = join(directory, "codex");
  writeFileSync(marker, "stale\n", { mode: 0o600 });
  const diagnostics = [];
  const idleTimers = [];
  const retryTimers = [];
  const loginPauses = [];
  const boundaryErrors = [];
  let statusHandler;
  let enrollmentHandler;
  const plan = {
    id: "fixture-plan",
    generation: 1,
    routes: [{ binding: { grant: { kind: "inference" } } }],
    execution: {
      installationId: "installation",
      namespaceId: "namespace",
      agentId: "agent",
      servicePrincipalId: "principal",
      revisionId,
      executionId: "execution",
    },
  };
  const releaseKey = protectedInference && generateKeyPairSync("ed25519").privateKey;
  if (protectedInference) {
    mkdirSync(codexHome);
  }

  let appServerStarts = 0;
  let nativeCalls = 0;
  let clock = 0;
  const absent = (environment, names) => {
    for (const name of names) {
      assert.equal(
        Object.hasOwn(environment, name),
        false,
        `${name} must not reach this environment`,
      );
    }
  };
  const sandbox = {
    URL,
    Buffer,
    performance,
    Math: Object.create(Math, { random: { value: () => random } }),
    // A login retry waits synchronously; the fake records the wait and advances the clock.
    Atomics: {
      wait(array, index, value, milliseconds) {
        loginPauses.push(milliseconds);
        clock += milliseconds + lateWakeMs;
        return "timed-out";
      },
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      retryTimers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = retryTimers.indexOf(timer);
      if (index !== -1) {
        retryTimers.splice(index, 1);
      }
    },
    console: {
      error(message) {
        diagnostics.push(message);
      },
    },
    setInterval(callback, delay) {
      idleTimers.push({ callback, delay });
    },
    process: {
      env: {
        CODEX_HOME: codexHome,
        OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
        CODEX_LOGIN_MODE: loginMode,
        ...(providerPat ? { OCE_CODEX_CREDENTIAL_SOURCE: "1" } : {}),
        ...(loginMode === "codex_pat"
          ? { CODEX_ACCESS_TOKEN: providerPat ? providerPlaceholder : "at-fixture-token" }
          : { OPENAI_API_KEY: "fixture-api-key" }),
        OPENCLAW_HARNESS_MODEL: "codex/gpt-4.1",
        OPENCLAW_AGENT_REVISION_ID: revisionId,
        ...(protectedInference
          ? {
              OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: revisionId,
              [COMPUTE_RELEASE_PUBLIC_KEY]: computeReleasePublicKey(releaseKey),
              ...pluginRuntimeEnvironment({
                kind: "codex",
                selections: {},
                providerTools: "none",
                egressEnrollment:
                  protectedInference === "missing" ? undefined : harnessEgressEnrollment(plan),
                modelEndpoint: {
                  modelProvider: "openai-compatible",
                  baseUrl: "https://provider.example.test/v1",
                },
              }),
            }
          : {}),
        OPENCLAW_RUNTIME_STATUS_CONTAINER: "agent",
        OPENCLAW_RUNTIME_STATUS_PORT: "18791",
        OPENCLAW_POD_UID: "pod-runtime-auth-gate",
        OPENCLAW_PLUGIN_READY_MARKER: marker,
        ...(tokenMode === "verifier"
          ? { APP_TOKEN_SHA: tokenDigest }
          : { APP_SERVER_TOKEN: transportToken }),
        APP_SERVER_PORT: "4500",
      },
      on() {},
      exit() {
        assert.fail("startup must either remain unready or start the app server");
      },
    },
    require(specifier) {
      if (specifier === "node:perf_hooks") {
        return { performance: { now: () => clock } };
      }
      if (specifier === "node:fs") {
        return {
          mkdirSync,
          mkdtempSync: () => mkdtempSync(join(directory, "probe-")),
          rmSync,
          readFileSync() {
            throw new Error("no plugin runtime payload is configured");
          },
          writeFileSync,
        };
      }
      if (specifier === "node:http") {
        return {
          createServer(handler) {
            return {
              listen(port) {
                if (port === 4500) {
                  enrollmentHandler = handler;
                } else {
                  statusHandler = handler;
                }
              },
              on() {},
              close(callback) {
                callback();
              },
              closeAllConnections() {},
            };
          },
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawnSync(command, args, options) {
            const step = native[nativeCalls++];
            try {
              assert.ok(step, "unexpected native invocation after script exhausted");
              assert.equal(command, "codex");
              assert.equal(args.includes("login") ? "login" : "probe", step.operation);
              const childEnvironment = options.env ?? sandbox.process.env;
              absent(childEnvironment, transportCredentials);
              if (step.operation === "login") {
                assert.equal(childEnvironment.CODEX_LOGIN_MODE, loginMode);
                // The wrapper retains its transport input; native login must not inherit it.
                assert.equal(
                  tokenMode === "verifier"
                    ? sandbox.process.env.APP_TOKEN_SHA
                    : sandbox.process.env.APP_SERVER_TOKEN,
                  tokenMode === "verifier" ? tokenDigest : transportToken,
                );
                assert.deepEqual(Array.from(args), [
                  "-c",
                  "cli_auth_credentials_store=file",
                  "login",
                  providerPat
                    ? "status"
                    : loginMode === "codex_pat"
                      ? "--with-access-token"
                      : "--with-api-key",
                ]);
                if (providerPat) {
                  // Native login reads the provider's exact placeholder from typed, private storage.
                  absent(childEnvironment, ["CODEX_ACCESS_TOKEN"]);
                  assert.equal(childEnvironment.CODEX_HOME, codexHome);
                  const authFile = join(codexHome, "auth.json");
                  assert.deepEqual(JSON.parse(readFileSync(authFile, "utf8")), {
                    personal_access_token: providerPlaceholder,
                  });
                  assert.equal(statSync(authFile).mode & 0o777, 0o600);
                } else {
                  assert.equal(
                    options.input,
                    loginMode === "codex_pat" ? "at-fixture-token" : "fixture-api-key",
                  );
                }
                assert.ok(options.timeout > 0 && options.timeout <= 30000);
                if (step.timeout !== undefined) {
                  assert.equal(options.timeout, step.timeout);
                }
                if (step.result.error?.code === "ETIMEDOUT" && step.result.signal === "SIGKILL") {
                  clock += options.timeout;
                }
                clock += step.elapsed ?? 0;
              } else {
                assert.ok(args.includes("exec"));
                if (protectedInference) {
                  for (const argument of [
                    "--ignore-user-config",
                    "model_providers.openai-compatible.request_max_retries=0",
                    "model_providers.openai-compatible.stream_max_retries=0",
                  ]) {
                    assert.ok(args.includes(argument), argument);
                  }
                }
                // Check the gate while the probe is running, before any app-server spawn.
                assert.equal(appServerStarts, 0);
                assert.equal(
                  existsSync(marker),
                  false,
                  "stale readiness must be removed before probing",
                );
                // Probe isolation and wrapper credential clearing are separate boundaries.
                absent(childEnvironment, modelCredentials);
                absent(sandbox.process.env, modelCredentials);
                if (providerPat) {
                  assert.equal(childEnvironment.CODEX_HOME, codexHome);
                  assert.ok(args.includes("cli_auth_credentials_store=file"));
                }
                assert.ok(options.timeout > 0 && options.timeout <= 30000);
                if (step.timeout !== undefined) {
                  assert.equal(options.timeout, step.timeout);
                }
                if (step.result.error?.code === "ETIMEDOUT" && step.result.signal === "SIGKILL") {
                  clock += options.timeout;
                }
                clock += step.elapsed ?? 0;
              }
              return step.result;
            } catch (error) {
              // The production probe catches process errors. Preserve fixture violations
              // so a caught assertion can never masquerade as an expected failed probe.
              boundaryErrors.push(error);
              throw error;
            }
          },
          spawn(command, args, options) {
            assert.equal(command, "codex");
            assert.ok(args.includes("app-server"));
            // Plugin reviewer validation must observe the admitted model, not a native default.
            assert.ok(args.includes('model="gpt-4.1"'));
            assert.equal(args[args.indexOf("--ws-token-sha256") + 1], tokenDigest);
            absent(options.env, [...transportCredentials, ...modelCredentials]);
            if (providerPat) {
              assert.equal(options.env.CODEX_HOME, codexHome);
              assert.ok(args.includes("cli_auth_credentials_store=file"));
            }
            appServerStarts++;
            return { on() {}, kill() {} };
          },
        };
      }
      return nodeRequire(specifier);
    },
  };
  return {
    diagnostics,
    idleTimers,
    retryTimers,
    loginPauses,
    get appServerStarts() {
      return appServerStarts;
    },
    start() {
      vm.runInNewContext(AGENT_RUNTIME_ENTRYPOINT, sandbox);
    },
    async releaseProtectedExecution() {
      // Exercise the generated Harness. Even an authenticated peer cannot release it by
      // echoing the challenge; only the fresh Compute signature may start native login.
      const exchange = async (method, body, expectedStatus) => {
        let result;
        await enrollmentHandler(
          {
            method,
            url: "/openclaw/runtime/egress-enrollment",
            headers: {
              authorization: "Bearer " + transportToken,
              "content-type": "application/json",
            },
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(JSON.stringify(body));
            },
          },
          {
            writeHead(status) {
              assert.equal(status, expectedStatus);
            },
            on(_event, listener) {
              this.finished = listener;
            },
            end(raw) {
              result = JSON.parse(raw);
              this.finished?.();
            },
          },
        );
        return result;
      };
      const challenge = await exchange("GET", undefined, 200);
      assert.equal((await exchange("POST", challenge, 409)).error, "stale_enrollment");
      assert.equal(nativeCalls, 0, "no native login or probe before signed release");
      const release = signComputeExecutionRelease(releaseKey, challenge.startupId, {
        plan,
        sandboxId: "sandbox",
        enforcement: {
          instanceId: "instance",
          configurationId: "configuration",
          peerKeyId: "enrolled-key",
        },
      });
      await exchange("POST", release, 200);
      await new Promise((resolve) => setImmediate(resolve));
    },
    retryAfter(milliseconds) {
      clock += milliseconds;
      retryTimers[0].callback();
    },
    status() {
      assert.ok(statusHandler);
      return readRuntimeStatusFromHandler(statusHandler);
    },
    marker() {
      return existsSync(marker) ? readFileSync(marker, "utf8") : undefined;
    },
    assertNativeScriptConsumed() {
      if (boundaryErrors.length) {
        throw boundaryErrors[0];
      }
      assert.equal(
        nativeCalls,
        native.length,
        "every scripted native invocation must be consumed exactly once",
      );
    },
  };
}

// Ordinary scenarios log in successfully and run one probe; native scripts retain
// explicit control over login failures, retries, process results, and timeouts.
export async function checkCodexStartup(t, scenario) {
  const runtime = createCodexStartup(t, {
    ...scenario,
    native: scenario.native ?? [login(), probe(scenario.events, scenario.result)],
  });
  if (scenario.protectedInference === "missing") {
    assert.throws(() => runtime.start(), /protected inference profile is invalid/);
    runtime.assertNativeScriptConsumed();
    assert.equal(runtime.marker(), undefined);
    return;
  }
  runtime.start();
  if (scenario.protectedInference) {
    await runtime.releaseProtectedExecution();
  }
  if (scenario.retryAfterMs !== undefined) {
    assert.equal(runtime.appServerStarts, 0);
    assert.equal(runtime.marker(), undefined);
    assert.equal(runtime.status().runtimeFailure, undefined);
    assert.equal(runtime.retryTimers.length, 1);
    assert.equal(runtime.retryTimers[0].delay, scenario.retryDelayMs ?? 1000);
    runtime.retryAfter(scenario.retryAfterMs);
  }
  assert.equal(
    runtime.retryTimers.length,
    scenario.retryAfterMs === undefined ? 0 : 1,
    "no unexpected retry",
  );
  runtime.assertNativeScriptConsumed();
  assert.deepEqual(runtime.loginPauses, scenario.loginPauses ?? [], "login retry waits");
  const expected = scenario.expect;
  const probes = checkStartupDiagnostics(runtime, scenario);
  const messages = runtime.diagnostics.filter((line) => !line.startsWith("{"));
  const status = runtime.status();
  assert.equal(status.revisionId, "revision-runtime-auth-gate");
  assert.equal(status.container, "agent");
  assert.equal(status.podUid, "pod-runtime-auth-gate");
  if (expected.code === "READY") {
    assert.equal(runtime.appServerStarts, 1);
    assert.deepEqual(messages, []);
    assert.equal(runtime.idleTimers.length, 0);
    assert.equal(runtime.marker(), "ready\n");
    assert.equal(status.runtimeFailure, undefined);
  } else {
    assert.equal(runtime.appServerStarts, 0);
    assert.deepEqual(messages, ["Harness model authentication probe failed."]);
    assert.equal(runtime.idleTimers.length, 1);
    assert.equal(typeof runtime.idleTimers[0].callback, "function");
    assert.ok(runtime.idleTimers[0].delay > 0);
    assert.equal(runtime.marker(), undefined);
    assert.equal(status.runtimeFailure.component, "agent");
    assert.equal(status.runtimeFailure.check, expected.check);
    assert.equal(status.runtimeFailure.code, expected.code);
    assert.match(status.runtimeFailure.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    // Only a failed model probe carries a cause: a closed kind and a fixed
    // token, never native output, provider text or the credential.
    if (expected.code === "MODEL_PROBE_FAILED") {
      assert.ok(expected.cause);
    }
    assert.deepEqual(status.runtimeFailure.cause, expected.cause);
    // The probe log line names each attempt's own cause; only the held cause says
    // that the check was retried.
    assert.deepEqual(probes.at(-1)?.cause, scenario.lastProbeCause ?? expected.cause);
    assert.deepEqual(
      [probes.at(-1)?.providerStatus, probes.at(-1)?.providerCode],
      [expected.provider?.status, expected.provider?.code],
    );
  }
  assert.doesNotMatch(
    JSON.stringify(status) + runtime.diagnostics.join("\n"),
    /fixture-api-key|at-fixture-token|fixture-transport-token|openshell:resolve:env|Bad Request|Unauthorized|Unavailable|Reconnecting|usage limit|Too Many|quota exceeded/i,
  );
  return { status, diagnostics: runtime.diagnostics };
}

function checkStartupDiagnostics(runtime, scenario) {
  const expected = scenario.expect;
  const json = runtime.diagnostics.filter((line) => line.startsWith("{")).map(JSON.parse);
  const phases = json.filter(({ event }) => event === "runtime.startup_phase");
  const logins = json.filter(({ event }) => event === "codex.login");
  const probes = json.filter(
    ({ event }) => event !== "runtime.startup_phase" && event !== "codex.login",
  );
  // Each failed native login attempt logs its number, exit code and output class only.
  assert.deepEqual(
    logins.map(({ failureClass }) => failureClass),
    scenario.loginClasses ?? [],
  );
  for (const [index, attempt] of logins.entries()) {
    assert.deepEqual(Object.keys(attempt), [
      "event",
      "attempt",
      "elapsedMs",
      "exitCode",
      "failureClass",
    ]);
    assert.equal(attempt.attempt, index + 1);
    assert.ok(Number.isInteger(attempt.elapsedMs) && attempt.elapsedMs >= 0);
    assert.ok(CODEX_FAILURE_OUTPUT_CLASSES.includes(attempt.failureClass));
  }
  assert.deepEqual(
    probes.map(({ code }) => code),
    scenario.probeCodes ?? (expected.check === "login" ? [] : [expected.code]),
  );
  if (scenario.probeCauses !== undefined) {
    assert.deepEqual(
      probes.map(({ cause }) => cause),
      scenario.probeCauses,
    );
  }
  for (const [index, diagnostic] of probes.entries()) {
    assert.equal(diagnostic.event, "codex.model_probe");
    assert.equal(diagnostic.attempt, index + 1);
    assert.ok(diagnostic.elapsedMs >= 0);
    if (diagnostic.code === "READY") {
      assert.equal(Object.hasOwn(diagnostic, "failureClass"), false);
    } else {
      assert.ok(CODEX_FAILURE_OUTPUT_CLASSES.includes(diagnostic.failureClass));
    }
  }
  if (scenario.probeFailureClasses !== undefined) {
    assert.deepEqual(
      probes.map(({ failureClass }) => failureClass),
      scenario.probeFailureClasses,
    );
  }
  if (expected.check === "model-probe" && scenario.failureClass !== undefined) {
    assert.equal(probes.at(-1)?.failureClass, scenario.failureClass);
  }
  // Startup timing reports fixed phase names and outcomes only: no model,
  // provider, credential or path value can appear in these lines.
  assert.deepEqual(
    phases.map(({ phase, outcome }) => [phase, outcome]),
    scenario.protectedInference
      ? [
          ["egress-enrollment", "ok"],
          ...expected.phases,
          ...(expected.code === "READY" ? [["plugin-install", "ok"]] : []),
        ]
      : expected.phases,
  );
  // A failed native login, like a failed probe that ran, adds only the closed-list
  // class of Codex's error output (finding 2017).
  for (const phase of phases) {
    const classified = phase.phase === "codex-login" && phase.outcome === "failed";
    assert.deepEqual(Object.keys(phase), [
      "event",
      "container",
      "phase",
      "outcome",
      "ms",
      "sinceStartMs",
      ...(classified ? ["failureClass"] : []),
    ]);
    if (classified) {
      assert.ok(CODEX_FAILURE_OUTPUT_CLASSES.includes(phase.failureClass));
      if (scenario.failureClass !== undefined) {
        assert.equal(phase.failureClass, scenario.failureClass);
      }
    }
    assert.equal(phase.container, "agent");
    assert.ok(Number.isInteger(phase.ms) && phase.ms >= 0);
    assert.ok(phase.sinceStartMs >= phase.ms);
  }
  return probes;
}
