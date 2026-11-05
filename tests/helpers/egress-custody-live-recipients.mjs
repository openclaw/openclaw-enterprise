import assert from "node:assert/strict";
import {
  admitRepositoryAgent,
  activateRepositoryAgent,
} from "./egress-custody-installed-agent.mjs";
import { assertIdentityResponse, refusal } from "./egress-custody-observations.mjs";

// A workload cannot sign or inject a supervisor opening. Here we control *actual*
// provider timing and identify each installed recipient by its complete, deliberately
// different result. The lane exercises the copied opening at the TLS gRPC authority.
export async function verifyLiveRecipients({
  setup,
  stack,
  evidence,
  owned,
  installed: a,
  clientFor,
  rows,
}) {
  const { provider } = owned;
  const admittedB = await admitRepositoryAgent(
    setup,
    stack,
    evidence,
    owned,
    "custody-b-" + evidence.runId,
  );
  const b = await activateRepositoryAgent(setup, stack, evidence, owned, admittedB);
  const execution = (i) => i.installation.plan.execution;
  for (const key of ["agentId", "revisionId", "servicePrincipalId"]) {
    assert.notEqual(execution(a)[key], execution(b)[key], "separately authorized " + key);
  }
  assert.notEqual(a.installation.sandboxId, b.installation.sandboxId);
  assert.notEqual(a.installation.enforcement.instanceId, b.installation.enforcement.instanceId);

  const origin = provider.observations.length;
  const preparse = provider.wireRequests;
  const pendingA = await open(a, "normal");
  const pendingB = await open(b, "forbidden-final");
  try {
    await evidence.checkpoint("two-authorized-installed-replies-suspended-at-origin", {
      a: pendingA.id,
      b: pendingB.id,
      authenticatedReads: 2,
      releasedSendPermits: 2,
    });
    // B finishes *first* with exactly the local refusal through TLS FIN; a splice
    // exchanging the two replies would give approved identity to the wrong recipient.
    await finish(pendingB, false);
    assert.equal(
      pendingA.entry.finished,
      false,
      "A response still withheld, not a sequential exercise",
    );
    assert.equal((await receiptFor(a, pendingA.id)).observation, null);
    await finish(pendingA, true);
  } finally {
    pendingB.release();
    pendingA.release();
  }
  assert.equal(
    provider.observations.length,
    origin + 2,
    "one authenticated read for each recipient",
  );
  assert.equal(
    provider.wireRequests,
    preparse + 2,
    "pre-parse observer excludes even an unparsed extra send",
  );

  // The denied recipient has the grant *throughout* and now gets an approved
  // identity on its own fresh operation. No IAM edit or replacement between them.
  const fresh = await open(b, "normal");
  await finish(fresh, true);
  assert.notEqual(fresh.id, pendingB.id);
  assert.equal(provider.wireRequests, preparse + 3);
  await evidence.checkpoint("two-authorized-installed-recipients-through-fin", {
    a: { id: pendingA.id, result: "exact-approved-identity" },
    b: { id: pendingB.id, result: "fixed-local-refusal", providerBytes: 0 },
    bOwnPositive: { id: fresh.id, result: "exact-approved-identity" },
    authenticatedOriginReads: 3,
    requestsAtPreparseOrigin: 3,
  });

  async function receiptFor(i, id) {
    const r = (await rows(i)).find((row) => row.id === id);
    assert.ok(
      r?.exact,
      "dispatch receipt binds this exact installed response and prepared material family",
    );
    return r;
  }
  async function open(i, shape) {
    const before = await i.custodyTransitions.snapshot();
    const prior = await rows(i);
    const gate = provider.holdNext(shape);
    // Both recipients read through FIN: ordinary curl at A, an independent Node TLS client at B.
    const client = clientFor(i);
    const read = i === a ? client.curl() : client.throughFin();
    // Attach a failure observer immediately. An early client exit is not evidence
    // of a held response; only the independent authenticated origin can establish it.
    const entry = await Promise.race([
      gate.arrived,
      read.then(() => assert.fail("recipient ended before origin hold")),
    ]);
    assert.ok(entry.exactRead && !entry.finished);
    const id = await i.custodyTransitions.expectAfter(before, [
      "resolve_accepted",
      "permit_accepted",
    ]);
    const newRows = (await rows(i)).filter((r) => !prior.some((p) => p.id === r.id));
    assert.equal(newRows.length, 1);
    assert.ok(
      newRows[0].id === id && newRows[0].exact && newRows[0].observation === null,
      "an acknowledged permit for this authorized execution's prepared material; not an IAM denial",
    );
    return { ...gate, id, entry, read, before, i };
  }
  async function finish(p, allow) {
    p.release();
    const raw = await p.read;
    if (allow) {
      assertIdentityResponse(raw);
    } else {
      assert.ok(raw === refusal, "complete local refusal through FIN and zero provider bytes at B");
    }
    const last = allow ? "response_released" : "response_blocked";
    assert.equal(
      await p.i.custodyTransitions.expectAfter(p.before, [
        "resolve_accepted",
        "permit_accepted",
        last,
      ]),
      p.id,
    );
    assert.ok(
      p.entry.finished && p.entry.actualLastTrailer === (allow ? null : "x-fixture-forbidden-last"),
    );
    const { observation } = await receiptFor(p.i, p.id);
    if (allow) {
      assert.equal(observation.kind, "response");
    } else {
      assert.deepEqual(observation, {
        kind: "response_blocked",
        dispatch: "confirmed",
        code: "response_policy",
      });
    }
  }
}
