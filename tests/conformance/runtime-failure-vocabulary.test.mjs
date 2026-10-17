import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { validateFailureData } from "../../packages/occ/src/state/controller-work.ts";

// Finding 1660: OCC records runtime failure evidence only in the vocabulary the runtime
// entrypoints publish, and records anything else as UNRECOGNIZED. These lists are maintained
// apart from that vocabulary, so a check or code the runtime gains must be added to OCC too, or
// a real failure would show as UNRECOGNIZED.

const sources = [
  "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts",
  "../../apps/controller/src/drivers/compute/runtime-startup.ts",
];

async function runtimeVocabulary() {
  const text = (
    await Promise.all(sources.map((path) => readFile(new URL(path, import.meta.url), "utf8")))
  ).join("\n");
  const codeList = /const RUNTIME_DIAGNOSTIC_CODES = new Set\(\[([^\]]*)\]\)/u.exec(text);
  assert.ok(codeList, "the runtime's diagnostic code set moved; update this test");
  const codes = [...codeList[1].matchAll(/"([A-Z0-9_]+)"/gu)].map((match) => match[1]);
  const checks = new Set(
    [
      ...text.matchAll(
        /(?:publishRuntimeFailure|holdFailedAuthentication|serveHeldRuntimeFailureToTransportPeer)\(\s*"([^"]+)"/gu,
      ),
      ...text.matchAll(/function holdFailedAuthentication\(check = "([^"]+)"/gu),
    ].map((match) => match[1]),
  );
  return { codes, checks: [...checks] };
}

// Finding 1675: a Compute driver also builds runtime failure evidence itself, from what its
// platform reports (Kubernetes Compute reads a failed initialize-workspace init container from
// Pod status). Every object literal in a driver source that carries a check and a code, and no
// diagnostic state, is such a record. Its literal values must be recorded as built too.
const driverRoot = new URL("../../apps/controller/src/drivers/", import.meta.url);

async function driverBuiltEvidence() {
  const files = (await readdir(driverRoot, { recursive: true }))
    .filter((path) => path.endsWith(".ts"))
    .filter((path) => !sources.some((source) => source.endsWith(`/drivers/${path}`)));
  const records = [];
  for (const path of files) {
    const text = await readFile(new URL(path, driverRoot), "utf8");
    for (const [literal] of text.matchAll(/\{[^{}]*\}/gu)) {
      if (!/\bcheck\s*:/u.test(literal) || /\bstate\s*:/u.test(literal)) {
        // Not runtime failure evidence, or a diagnostic check (finding 1673).
        continue;
      }
      const value = (key) => {
        const match = new RegExp(`\\b${key}\\s*:\\s*([^,\\n]+)`, "u").exec(literal);
        return match?.[1].trim();
      };
      const check = value("check");
      const code = value("code");
      // Copying evidence the runtime published (failed.check) adds no value of its own.
      if (/^[A-Za-z_$][\w$]*\.check$/u.test(check)) {
        continue;
      }
      assert.match(
        `${check} ${code}`,
        /^"[^"]+" "[^"]+"$/u,
        `${path} builds runtime failure evidence this test cannot read; update it:\n${literal}`,
      );
      records.push({ path, check: JSON.parse(check), code: JSON.parse(code) });
    }
  }
  return records;
}

function recorded(runtimeFailure) {
  return validateFailureData("CONVERGENCE_DEADLINE_EXCEEDED", { timeoutMs: 1, runtimeFailure })
    .runtimeFailure;
}

test("every check and code a runtime entrypoint publishes is recorded as published", async () => {
  const { codes, checks } = await runtimeVocabulary();
  // Guards the extraction itself: an empty match would make the loop below prove nothing.
  assert.ok(codes.length >= 10, `runtime codes: ${codes.join(", ")}`);
  assert.ok(checks.length >= 5, `runtime checks: ${checks.join(", ")}`);
  // Compute names the status container by its role; the provider-owned transport says "agent".
  for (const component of ["agent", "gateway"]) {
    for (const check of checks) {
      for (const code of codes) {
        const evidence = { component, check, checkedAt: "2026-10-17T12:00:00.000Z", code };
        assert.deepEqual(recorded(evidence), evidence);
      }
    }
  }
});

test("every check and code a Compute driver builds itself is recorded as built", async () => {
  const records = await driverBuiltEvidence();
  // Guards the extraction itself: Kubernetes Compute's workspace-setup record must be found.
  assert.ok(
    records.some(
      ({ path, check, code }) =>
        path === "compute/kubernetes/index.ts" &&
        check === "workspace-setup" &&
        code === "WORKSPACE_SETUP_FAILED",
    ),
    `driver-built evidence: ${JSON.stringify(records)}`,
  );
  for (const component of ["agent", "gateway"]) {
    for (const { check, code } of records) {
      const evidence = { component, check, checkedAt: "2026-10-17T12:00:00.000Z", code };
      assert.deepEqual(recorded(evidence), evidence);
    }
  }
});

test("a failed workspace setup keeps its check and code through record and read", () => {
  const evidence = {
    component: "agent",
    check: "workspace-setup",
    checkedAt: "2026-10-17T12:00:00.000Z",
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

test("runtime failure evidence outside that vocabulary is recorded as UNRECOGNIZED", () => {
  const served = {
    component: "sidecar",
    check: "see.evil.example:443",
    checkedAt: "2026-10-17T12:00:00.000Z",
    code: "STARTUP_FAILED",
  };
  assert.deepEqual(recorded(served), {
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
