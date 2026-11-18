import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { RecoveryFixture } from "./production-upgrade-recovery-fixture.ts";
import { yamlFile } from "./production-upgrade-recovery-render.ts";
import { requireRecoveryPreflight } from "./production-upgrade-recovery-state.ts";
import { injectedFault } from "./production-upgrade-recovery-tools.ts";

export function evidenceFiles(evidence: string) {
  return {
    evidence,
    readEvidence: (...parts: string[]) => readFile(join(evidence, ...parts), "utf8"),
  };
}

export async function runWithInjectedFault(
  fixture: Pick<RecoveryFixture, "failNext" | "run">,
  name: string,
  ...args: string[]
) {
  await fixture.failNext(name);
  await assert.rejects(fixture.run(...args), injectedFault);
}

export async function assertPrivateReceipt(path: string, expected: string) {
  const file = await open(path, "r");
  try {
    assert.equal((await file.stat()).mode & 0o777, 0o600);
    assert.equal(await file.readFile("utf8"), expected);
  } finally {
    await file.close();
  }
}

export async function assertHelmIntent(
  fixture: ReturnType<typeof evidenceFiles>,
  previousRevision: number,
  expectedRevision: number,
) {
  const intent = asRecord(JSON.parse(await fixture.readEvidence("helm-started")));
  assert.ok(intent, "expected the published Helm intent");
  assert.equal(intent.previousRevision, previousRevision);
  assert.equal(intent.expectedRevision, expectedRevision);
  const attempt = asRecord(intent.attempt);
  assert.ok(attempt, "expected a Helm attempt in the published intent");
  const { nonce, valuesSha256 } = attempt;
  assert.ok(
    typeof nonce === "string" && /^[a-z0-9-]+$/.test(nonce),
    "expected a Helm attempt nonce",
  );
  assert.ok(typeof valuesSha256 === "string", "expected the values digest in the Helm attempt");

  // The published intent must refer to the same private attempt and values that Helm can use.
  const directory = join(fixture.evidence, "helm-attempts", nonce);
  const values = await yamlFile(join(directory, "values.yaml"));
  assert.equal(asRecord(asRecord(values)?.installation)?.upgradeAttemptId, nonce);
  const saved: unknown = JSON.parse(await readFile(join(directory, "intent.json"), "utf8"));
  assert.deepEqual(saved, intent);
  return {
    ...intent,
    previousRevision,
    expectedRevision,
    attempt: { ...attempt, nonce, valuesSha256 },
  };
}

export async function assertStoppedBeforeWriters(
  fixture: Pick<RecoveryFixture, "state" | "events">,
) {
  const state = await fixture.state();
  assert.equal(state.api, 1);
  assert.equal(state.worker, 1);
  assert.equal(state.version, 1);
  assert.deepEqual(await fixture.events(), []);
  const preflight = requireRecoveryPreflight(state);
  assert.deepEqual(preflight.secrets, {});
  assert.deepEqual(preflight.pods, {});
  assert.deepEqual(preflight.jobs, {});
  assert.deepEqual(preflight.networkpolicies, {});
  return state;
}
