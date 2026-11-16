import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import test from "node:test";
import { getSystemErrorMap } from "node:util";
import vm from "node:vm";

import {
  AGENT_RUNTIME_ENTRYPOINT,
  AGENT_WITH_NODE_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  PROCESS_EXIT_ERROR_CODES,
  PROCESS_EXIT_SIGNALS,
  RUNTIME_COMPONENTS,
  RUNTIME_DIAGNOSTIC_CHECKS,
  RUNTIME_DIAGNOSTIC_CODES,
  RUNTIME_FAILURE_CHECKS,
  WORKSPACE_SETUP_CHECK,
  WORKSPACE_SETUP_FAILED,
} from "../../packages/contracts/src/runtime-failure.ts";
import { deploymentDiagnostics } from "../../packages/occ/src/deployment-diagnostics.ts";
import {
  validateFailureData,
  validateRuntimeFailureEvidence,
} from "../../packages/occ/src/state/controller-work.ts";
import type { RuntimeDiagnosticCheck } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

// Findings 1660 and 1673-1675: the runtime failure vocabulary lives in the contract. The
// Kubernetes runtime programs get it injected and refuse anything else, and OCC records, and
// reads back, a value outside it as UNRECOGNIZED: a provider-owned Harness serves runtime
// evidence from inside its Sandbox, where Agent code can answer in its place.

const runtimeSources = [
  "../../apps/controller/src/drivers/compute/gateway-tool-policy.ts",
  "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts",
  "../../apps/controller/src/drivers/compute/runtime-startup.ts",
];
const driverRoot = new URL("../../apps/controller/src/drivers/", import.meta.url);

async function runtimeSourceText() {
  return (
    await Promise.all(
      runtimeSources.map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    )
  ).join("\n");
}
const runtimeCheckedAt = "2026-10-17T12:00:00.000Z";

function capture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  assert.ok(value !== undefined, `Expected capture ${index} in ${match[0]}`);
  return value;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function isRuntimeHelper(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function callRuntimeHelper(
  sandbox: Record<string, unknown>,
  name: string,
  ...args: unknown[]
): unknown {
  const helper = sandbox[name];
  assert.ok(isRuntimeHelper(helper), `Expected runtime helper ${name}`);
  return Reflect.apply(helper, sandbox, args);
}

function injectedRuntimeList(program: string, name: string): unknown {
  const match = new RegExp(`const ${name} = new Set\\((\\[[^\\n]*\\])\\);`, "u").exec(program);
  assert.ok(match, `${name} is not injected from the contract; update this test`);
  return parseJson(capture(match, 1));
}

function recordedRuntimeFailure(runtimeFailure: unknown): unknown {
  const stored = validateFailureData("CONVERGENCE_DEADLINE_EXCEEDED", {
    timeoutMs: 1,
    runtimeFailure,
  });
  assert.ok(stored);
  return stored.runtimeFailure;
}

function returnedDiagnostics(checks: readonly RuntimeDiagnosticCheck[]) {
  return deploymentDiagnostics(
    { revisionId: "rev_1", observedAt: runtimeCheckedAt, checks },
    "rev_1",
  ).checks;
}

// Every brace-free object literal with a check key in a Compute driver source, outside the
// runtime programs: evidence (or, with a state, a diagnostic check) the driver builds itself. A
// copy of what the runtime published (failed.check) adds no value of its own. As a backstop for
// objects this cannot read (nested braces, say), every literal check must belong to one it read.
async function driverBuiltRuntimeValues() {
  const files = (await readdir(driverRoot, { recursive: true }))
    .filter((path) => path.endsWith(".ts"))
    .filter((path) => !runtimeSources.some((source) => source.endsWith(`/drivers/${path}`)));
  const records: { path: string; diagnostic: boolean; check: string; code: string }[] = [];
  for (const path of files) {
    const text = await readFile(new URL(path, driverRoot), "utf8");
    const readCheckOffsets = new Set<number>();
    for (const object of text.matchAll(/\{[^{}]*\}/gu)) {
      const literal = object[0];
      const checkKey = /\bcheck\s*:/u.exec(literal);
      if (!checkKey) {
        continue;
      }
      readCheckOffsets.add(object.index + checkKey.index);
      const value = (key: string) =>
        new RegExp(`\\b${key}\\s*:\\s*("[^"\\n]*"|[^,\\n}]+)`, "u").exec(literal)?.[1]?.trim();
      const [check, code] = [value("check"), value("code")];
      // Continuity comparisons are emitted as telemetry, not runtime failures.
      // Limit this exemption to their exact event or the owning report call.
      if (
        path === "egress-proxy/openshell-git-runtime.ts" &&
        code === undefined &&
        value("state") === undefined &&
        (value("event") === '"worker.openshell-git-continuity-refused"' ||
          (/^"(held-startup-(recorded|observed)|sandbox-(restart-count|restart-policy-never|id-changed))"$/u.test(
            check ?? "",
          ) &&
            /this\.reportContinuity\([^;]*$/su.test(
              text.slice(Math.max(0, object.index - 512), object.index),
            )))
      ) {
        continue;
      }
      if (
        /^[A-Za-z_$][\w$]*\.check$/u.test(check ?? "") &&
        /^[A-Za-z_$][\w$]*\.code$/u.test(code ?? "")
      ) {
        continue;
      }
      assert.match(
        `${check} ${code}`,
        /^"[^"]+" "[^"]+"$/u,
        `${path} builds a runtime check this test cannot read; update it:\n${literal}`,
      );
      const diagnostic = /\bstate\s*:/u.test(literal);
      assert.ok(check !== undefined && code !== undefined);
      const parsedCheck = parseJson(check);
      const parsedCode = parseJson(code);
      assert.ok(typeof parsedCheck === "string" && typeof parsedCode === "string");
      records.push({ path, diagnostic, check: parsedCheck, code: parsedCode });
    }
    for (const match of text.matchAll(/\bcheck\s*:\s*("[^"\n]*")/gu)) {
      assert.ok(
        readCheckOffsets.has(match.index),
        `${path} sets check ${match[1]} in a shape this test cannot read; update it`,
      );
    }
  }
  return records;
}

export function registerRuntimeDiagnosticCases(): void {
  test("every check and code a runtime entrypoint publishes is recorded as published", async () => {
    // The runtime programs check what they publish against the contract's lists, injected as is.
    for (const program of [
      GATEWAY_RUNTIME_ENTRYPOINT,
      AGENT_RUNTIME_ENTRYPOINT,
      AGENT_WITH_NODE_ENTRYPOINT,
      NATIVE_WORKER_ENTRYPOINT,
    ]) {
      assert.deepEqual(injectedRuntimeList(program, "RUNTIME_DIAGNOSTIC_CODES"), [
        ...RUNTIME_DIAGNOSTIC_CODES,
      ]);
      assert.deepEqual(injectedRuntimeList(program, "RUNTIME_FAILURE_CHECKS"), [
        ...RUNTIME_FAILURE_CHECKS,
      ]);
      assert.deepEqual(injectedRuntimeList(program, "RUNTIME_DIAGNOSTIC_CHECKS"), [
        ...RUNTIME_DIAGNOSTIC_CHECKS,
      ]);
    }
    // Every literal they hold a failure or report a check under is in those lists, so none
    // throws instead of holding.
    const text = await runtimeSourceText();
    const held = [
      ...text.matchAll(
        /(?:publishRuntimeFailure|holdFailedAuthentication|holdStartupFailure|serveHeldRuntimeFailureToTransportPeer)\(\s*"([^"]+)"(?:,\s*"([^"]+)")?/gu,
      ),
      ...text.matchAll(/function holdFailedAuthentication\(check = "([^"]+)", code = "([^"]+)"/gu),
    ];
    const diagnosed = [
      ...text.matchAll(/(?:runtimeDiagnosticCheck|statusCheckFromBoolean)\(\s*"([^"]+)"/gu),
    ];
    // Guards the extraction itself: an empty match would prove nothing.
    assert.ok(new Set(held.map(([, check]) => check)).size >= 5, JSON.stringify(held));
    assert.ok(new Set(diagnosed.map(([, check]) => check)).size >= 3, JSON.stringify(diagnosed));
    for (const match of held) {
      const check = capture(match, 1);
      const code = match[2];
      assert.ok(
        RUNTIME_FAILURE_CHECKS.some((allowed) => allowed === check),
        check,
      );
      if (code !== undefined) {
        assert.ok(
          RUNTIME_DIAGNOSTIC_CODES.some((allowed) => allowed === code),
          code,
        );
      }
    }
    for (const match of diagnosed) {
      const check = capture(match, 1);
      assert.ok(
        RUNTIME_DIAGNOSTIC_CHECKS.some((allowed) => allowed === check),
        check,
      );
    }
    // Compute names the status container by its role; the provider-owned transport says "agent".
    for (const component of RUNTIME_COMPONENTS) {
      for (const check of RUNTIME_FAILURE_CHECKS) {
        for (const code of RUNTIME_DIAGNOSTIC_CODES) {
          const evidence = { component, check, checkedAt: runtimeCheckedAt, code };
          assert.deepEqual(recordedRuntimeFailure(evidence), evidence);
          const diagnostic: RuntimeDiagnosticCheck = {
            component,
            check,
            state: "failed",
            checkedAt: runtimeCheckedAt,
            code,
          };
          assert.deepEqual(returnedDiagnostics([diagnostic]), [diagnostic]);
        }
      }
      for (const check of RUNTIME_DIAGNOSTIC_CHECKS) {
        const diagnostic: RuntimeDiagnosticCheck = {
          component,
          check,
          state: "unknown",
          checkedAt: null,
        };
        assert.deepEqual(returnedDiagnostics([diagnostic]), [diagnostic]);
      }
    }
  });

  test("a runtime program refuses to publish a check or code outside the contract", () => {
    const env: Record<string, string> = {};
    const sandbox: Record<string, unknown> = {
      require: createRequire(import.meta.url),
      process: { env },
      Buffer,
      console,
    };
    vm.runInNewContext(PLUGIN_RUNTIME_HELPERS, sandbox);
    // Compute-owned: the status port serves held failures and diagnostic checks.
    Object.assign(env, {
      OPENCLAW_RUNTIME_STATUS_PORT: "18791",
      OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
    });
    assert.throws(
      () => callRuntimeHelper(sandbox, "publishRuntimeFailure", "see.evil.example", "UNAVAILABLE"),
      /check is invalid/,
    );
    assert.throws(
      () => callRuntimeHelper(sandbox, "publishRuntimeFailure", "model-probe", "CALL_ME"),
      /code is invalid/,
    );
    callRuntimeHelper(sandbox, "publishRuntimeFailure", "model-probe", "UNAVAILABLE");
    assert.throws(
      () =>
        callRuntimeHelper(sandbox, "runtimeDiagnosticCheck", "see.evil.example", "unknown", null),
      /check is invalid/,
    );
    assert.throws(
      () =>
        callRuntimeHelper(
          sandbox,
          "runtimeDiagnosticCheck",
          "connectivity",
          "unknown",
          null,
          "CALL_ME",
        ),
      /code is invalid/,
    );
    const diagnostic = asRecord(
      callRuntimeHelper(sandbox, "runtimeDiagnosticCheck", "connectivity", "unknown", null),
    );
    assert.equal(diagnostic?.check, "connectivity");
    // Provider-owned: the held failure is served on the Harness port instead.
    delete env.OPENCLAW_RUNTIME_STATUS_PORT;
    Object.assign(env, { APP_TOKEN_SHA: "a".repeat(64), APP_SERVER_PORT: "4500" });
    assert.throws(
      () =>
        callRuntimeHelper(
          sandbox,
          "serveHeldRuntimeFailureToTransportPeer",
          "see.evil.example",
          "UNAVAILABLE",
        ),
      /check is invalid/,
    );
    assert.throws(
      () =>
        callRuntimeHelper(
          sandbox,
          "serveHeldRuntimeFailureToTransportPeer",
          "model-probe",
          "CALL_ME",
        ),
      /code is invalid/,
    );
  });

  test("every check and code a Compute driver builds itself is recorded as built", async () => {
    const records = await driverBuiltRuntimeValues();
    // Guards the extraction itself: Kubernetes Compute's workspace-setup record and its
    // unreadable-status diagnostic must be found.
    const found = (check: string, code: string, diagnostic: boolean) =>
      records.some(
        (record) =>
          record.path.startsWith("compute/kubernetes/") &&
          record.check === check &&
          record.code === code &&
          record.diagnostic === diagnostic,
      );
    assert.ok(found(WORKSPACE_SETUP_CHECK, WORKSPACE_SETUP_FAILED, false), JSON.stringify(records));
    assert.ok(found("runtime-status", "UNAVAILABLE", true), JSON.stringify(records));
    for (const component of RUNTIME_COMPONENTS) {
      for (const { diagnostic, check, code } of records) {
        if (diagnostic) {
          const built: RuntimeDiagnosticCheck = {
            component,
            check,
            state: "unknown",
            checkedAt: null,
            code,
          };
          assert.deepEqual(returnedDiagnostics([built]), [built]);
        } else {
          const evidence = { component, check, checkedAt: runtimeCheckedAt, code };
          assert.deepEqual(recordedRuntimeFailure(evidence), evidence);
        }
      }
    }
  });

  test("a failed workspace setup keeps its check and code through record and read", () => {
    const evidence = {
      component: "agent",
      check: "workspace-setup",
      checkedAt: runtimeCheckedAt,
      code: "WORKSPACE_SETUP_FAILED",
    };
    // The worker records the deadline failure with this evidence, and the status read validates
    // the stored row again.
    const stored = validateFailureData("CONVERGENCE_DEADLINE_EXCEEDED", {
      timeoutMs: 900_000,
      runtimeFailure: evidence,
    });
    assert.deepEqual(stored, { timeoutMs: 900_000, runtimeFailure: evidence });
    assert.deepEqual(validateFailureData("CONVERGENCE_DEADLINE_EXCEEDED", stored), stored);
  });

  test("recorded failure data refuses a cause off the model probe's failure, a cause in deadline data, and another code as a held model-probe failure", () => {
    const probe = {
      component: "agent",
      check: "model-probe",
      checkedAt: runtimeCheckedAt,
      code: "MODEL_PROBE_FAILED",
    };
    const cause = { kind: "PROBE_STATUS", detail: "turn-failed" };
    assert.throws(
      () => validateRuntimeFailureEvidence({ ...probe, code: "STARTUP_FAILED", cause }),
      {
        name: "ScopeViolationError",
        message: "Runtime failure cause is invalid.",
      },
    );
    // The deadline records its runtime failure without the cause, so a stored cause is refused.
    assert.throws(
      () =>
        validateFailureData("CONVERGENCE_DEADLINE_EXCEEDED", {
          timeoutMs: 1,
          runtimeFailure: { ...probe, cause },
        }),
      { message: "Convergence deadline failure data cannot carry a cause." },
    );
    // A held model-probe failure must be the model probe's own failure, not another one.
    assert.throws(
      () =>
        validateFailureData("RUNTIME_MODEL_PROBE_FAILED", {
          runtimeFailure: { ...probe, code: "STARTUP_FAILED" },
        }),
      { message: "Model probe failure data requires its runtime failure." },
    );
  });

  test("runtime failure evidence outside that vocabulary is recorded as UNRECOGNIZED", () => {
    const served = {
      component: "sidecar",
      check: "see.evil.example:443",
      checkedAt: runtimeCheckedAt,
      code: "STARTUP_FAILED",
    };
    assert.deepEqual(recordedRuntimeFailure(served), {
      component: "UNRECOGNIZED",
      check: "UNRECOGNIZED",
      checkedAt: served.checkedAt,
      code: "UNRECOGNIZED",
    });
    // A held model-probe failure keeps its known code and classified cause; only the unknown
    // component and check are replaced.
    assert.deepEqual(
      validateFailureData("RUNTIME_MODEL_PROBE_FAILED", {
        runtimeFailure: {
          ...served,
          code: "MODEL_PROBE_FAILED",
          cause: { kind: "PROBE_STATUS", detail: "turn-failed" },
        },
      }),
      {
        runtimeFailure: {
          component: "UNRECOGNIZED",
          check: "UNRECOGNIZED",
          checkedAt: served.checkedAt,
          code: "MODEL_PROBE_FAILED",
          cause: { kind: "PROBE_STATUS", detail: "turn-failed" },
        },
      },
    );
  });

  test("a PROCESS_EXIT cause outside the contract's statuses, signals and error codes is recorded without its detail", () => {
    const failure = (detail: string | undefined) => ({
      runtimeFailure: {
        component: "agent",
        check: "model-probe",
        checkedAt: runtimeCheckedAt,
        code: "MODEL_PROBE_FAILED",
        cause: detail === undefined ? { kind: "PROCESS_EXIT" } : { kind: "PROCESS_EXIT", detail },
      },
    });
    for (const [served, recorded] of [
      ["exit-1", "exit-1"],
      ["exit-255", "exit-255"],
      ["signal-SIGKILL-attempt2", "signal-SIGKILL-attempt2"],
      ["error-ENOBUFS", "error-ENOBUFS"],
      // Shaped like a token, but text the Sandbox chose.
      ["exit-256", undefined],
      ["error-EVILEXAMPLECOM", undefined],
      ["signal-SIGSEEEXAMPLE-attempt2", undefined],
      // What #2763 recorded, or a runtime serves as text: rows holding it still read, without
      // the detail, and none is recorded (finding 1706).
      ["UNRECOGNIZED", undefined],
      ["UNRECOGNIZED-attempt2", undefined],
    ]) {
      assert.ok(served !== undefined);
      // Recorded once, then read back from the stored row.
      const stored = validateFailureData("RUNTIME_MODEL_PROBE_FAILED", failure(served));
      assert.deepEqual(stored, failure(recorded), served);
      assert.deepEqual(validateFailureData("RUNTIME_MODEL_PROBE_FAILED", stored), stored, served);
    }
  });

  test("a PROCESS_EXIT cause recorded today reads under a controller from before the closed vocabulary", () => {
    // The cause check of a controller before #2763, which a rollback or rolling upgrade runs
    // against rows this one records: a detail must match it, or the read is refused.
    const earlierReader =
      /^(?:exit-[1-9][0-9]{0,2}|signal-SIG[A-Z0-9]{1,10}|error-E[A-Z0-9]{1,15})$/u;
    const readsEarlier = (value: unknown) => {
      const cause = asRecord(value);
      return (
        cause?.kind === "PROCESS_EXIT" &&
        Object.keys(cause).every((key) => key === "kind" || key === "detail") &&
        (cause.detail === undefined ||
          (typeof cause.detail === "string" &&
            earlierReader.test(cause.detail.replace(/-attempt2$/u, ""))))
      );
    };
    // What #2763 first recorded fails it, so this test catches a return to writing it.
    assert.equal(readsEarlier({ kind: "PROCESS_EXIT", detail: "UNRECOGNIZED" }), false);
    assert.equal(readsEarlier({ kind: "PROCESS_EXIT", detail: "UNRECOGNIZED-attempt2" }), false);
    for (const served of [
      "exit-1",
      "signal-SIGKILL-attempt2",
      "error-ENOBUFS",
      "exit-256",
      "exit-999",
      "error-EVILEXAMPLECOM",
      "signal-SIGSEEEXAMPLE-attempt2",
      // A runtime can serve the literal text too (finding 1706).
      "UNRECOGNIZED",
      "UNRECOGNIZED-attempt2",
    ]) {
      const stored = validateFailureData("RUNTIME_MODEL_PROBE_FAILED", {
        runtimeFailure: {
          component: "agent",
          check: "model-probe",
          checkedAt: runtimeCheckedAt,
          code: "MODEL_PROBE_FAILED",
          cause: { kind: "PROCESS_EXIT", detail: served },
        },
      });
      const row = asRecord(parseJson(JSON.stringify(stored)));
      const cause = asRecord(row?.runtimeFailure)?.cause;
      assert.ok(readsEarlier(cause), `${served} -> ${JSON.stringify(cause)}`);
    }
  });

  test("every model-probe cause a runtime program publishes is recorded as published", async () => {
    const text = await runtimeSourceText();
    // Each call shape a model-probe failure is built in, read for the detail tokens it publishes.
    const read = new Set<number>();
    const causes: { kind: string; detail?: string }[] = [];
    const extract = (pattern: RegExp, toCauses: (match: RegExpExecArray) => typeof causes) => {
      for (const match of text.matchAll(pattern)) {
        read.add(match.index);
        causes.push(...toCauses(match));
      }
    };
    extract(/probeFailure\(\s*"([A-Z_]+)"\s*\)/gu, (match) => [{ kind: capture(match, 1) }]);
    extract(/probeFailure\(\s*"([A-Z_]+)",\s*"([^"]+)"\s*\)/gu, (match) => [
      { kind: capture(match, 1), detail: capture(match, 2) },
    ]);
    // A choice between two tokens, as for the Codex check's unexpected events.
    extract(/probeFailure\(\s*"([A-Z_]+)",[^?\n]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\s*\)/gu, (match) =>
      match.slice(2).map((detail) => ({ kind: capture(match, 1), detail })),
    );
    // The OpenClaw check's provider statuses, and "other" for the rest.
    extract(
      /probeFailure\(\s*"PROBE_STATUS",\s*\[([^\]]+)\]\.includes\(status\) \? status : "([^"]+)"\)/gu,
      (match) => {
        const parsed = parseJson(`[${capture(match, 1)}]`);
        assert.ok(Array.isArray(parsed));
        const details: readonly unknown[] = parsed;
        return [...details, capture(match, 2)].map((detail) => {
          assert.ok(typeof detail === "string");
          return { kind: "PROBE_STATUS", detail };
        });
      },
    );
    // The Codex helper can report a rate limit, replace a detail with a provider code,
    // or keep its caller's token.
    extract(
      /probeFailure\(\s*"PROBE_STATUS",\s*codexRateLimited\(message\) \? "([^"]+)" : detail\)/gu,
      (match) => [{ kind: "PROBE_STATUS", detail: capture(match, 1) }],
    );
    extract(/if \(summary\.providerCode === "[^"]+"\) detail = "([^"]+)";/gu, (match) => [
      { kind: "PROBE_STATUS", detail: capture(match, 1) },
    ]);
    extract(/codexProbeStatusFailure\([^"\n]*,\s*"([^"]+)",\s*modelId\)/gu, (match) => [
      { kind: "PROBE_STATUS", detail: capture(match, 1) },
    ]);
    // A backstop for shapes none of these read. PROCESS_EXIT details are built at run time and
    // pinned by the PROCESS_EXIT tests above.
    for (const call of text.matchAll(
      /probeFailure\(\s*"(?!PROCESS_EXIT")|(?<!function )codexProbeStatusFailure\(/gu,
    )) {
      assert.ok(
        read.has(call.index),
        `a probe failure is built in a shape this test cannot read; update it:\n${text.slice(call.index, call.index + 120)}`,
      );
    }
    // Guards the extraction itself: an empty or partial match would prove nothing.
    const found = new Set(
      causes.map(({ kind, detail }) => (detail === undefined ? kind : `${kind}/${detail}`)),
    );
    for (const expected of [
      "INVALID_OUTPUT/json",
      "INVALID_OUTPUT/shape",
      "PROBE_STATUS/no-reply",
      "PROBE_STATUS/turn-failed",
      "PROBE_STATUS/error-event",
      "PROBE_STATUS/tool-event",
      "PROBE_STATUS/unexpected-event",
      "PROBE_STATUS/rate_limit",
      "PROBE_STATUS/no_model",
      "PROBE_STATUS/model_not_found",
      "PROBE_STATUS/other",
      "WRAPPER_ERROR",
    ]) {
      assert.ok(found.has(expected), `${expected} not found in ${JSON.stringify([...found])}`);
    }
    for (const cause of causes) {
      // The retried check holds its second failure with the "-attempt2" suffix on its detail.
      for (const held of cause.detail === undefined
        ? [cause]
        : [cause, { ...cause, detail: `${cause.detail}-attempt2` }]) {
        const failure = {
          runtimeFailure: {
            component: "agent",
            check: "model-probe",
            checkedAt: runtimeCheckedAt,
            code: "MODEL_PROBE_FAILED",
            cause: held,
          },
        };
        const stored = validateFailureData("RUNTIME_MODEL_PROBE_FAILED", failure);
        assert.deepEqual(stored, failure, JSON.stringify(held));
        assert.deepEqual(
          validateFailureData("RUNTIME_MODEL_PROBE_FAILED", stored),
          stored,
          JSON.stringify(held),
        );
      }
    }
  });

  test("every signal and system error code Node names on Linux is in the PROCESS_EXIT vocabulary", (t) => {
    if (process.platform !== "linux") {
      t.skip("the runtime runs on Linux; other platforms name other codes");
      return;
    }
    for (const signal of Object.keys(osConstants.signals)) {
      assert.ok(
        PROCESS_EXIT_SIGNALS.some((allowed) => allowed === signal),
        signal,
      );
    }
    // Node names spawn errors by libuv's names, which add a few to errno's. The runtime keeps
    // only names of this shape.
    for (const code of [
      ...Object.keys(osConstants.errno),
      ...[...getSystemErrorMap().values()].map(([name]) => name),
    ].filter((name) => /^E[A-Z0-9]{1,15}$/u.test(name))) {
      assert.ok(
        PROCESS_EXIT_ERROR_CODES.some((allowed) => allowed === code),
        code,
      );
    }
  });

  test("runtime diagnostics outside that vocabulary are returned as UNRECOGNIZED", () => {
    const known: RuntimeDiagnosticCheck = {
      component: "gateway",
      check: "connectivity",
      state: "failed",
      checkedAt: runtimeCheckedAt,
      code: "DISCONNECTED",
    };
    assert.deepEqual(
      returnedDiagnostics([
        {
          component: "sidecar",
          check: "see.evil.example:443",
          state: "failed",
          checkedAt: null,
          code: "CALL_ME",
        },
        { ...known, check: "workspace-setup", code: "WORKSPACE_SETUP_FAILED" },
        { component: "agent", check: "runtime-status", state: "unknown", checkedAt: null },
        known,
      ]),
      [
        {
          component: "UNRECOGNIZED",
          check: "UNRECOGNIZED",
          state: "failed",
          checkedAt: null,
          code: "UNRECOGNIZED",
        },
        // Only Compute builds this record, from Pod status; a runtime cannot report it.
        { ...known, check: "UNRECOGNIZED", code: "UNRECOGNIZED" },
        { component: "agent", check: "runtime-status", state: "unknown", checkedAt: null },
        known,
      ],
    );
  });
}
