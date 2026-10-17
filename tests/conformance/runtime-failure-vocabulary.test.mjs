import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
