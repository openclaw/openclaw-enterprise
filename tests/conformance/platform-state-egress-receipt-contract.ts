import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type {
  Installation,
  Namespace,
  Secret,
  StaticMaterialEvidence,
} from "../../packages/contracts/src/index.ts";
import {
  EgressSendReceipts,
  type SendAttempt,
} from "../../packages/occ/src/egress-send-receipts.ts";
import type { PlatformStateStore } from "../../packages/occ/src/index.ts";

export async function verifyEgressSendReceiptContract(
  store: PlatformStateStore,
  installation: Readonly<Installation>,
  namespace: Readonly<Namespace>,
  harnessSecret: Readonly<Secret>,
) {
  const receipts = new EgressSendReceipts(store);
  const ref = () => ({ id: randomUUID(), generation: 1 });
  const sender = ref();
  const evidence: StaticMaterialEvidence = {
    kind: "static",
    source: {
      installationId: installation.id,
      namespaceId: namespace.id,
      source: ref(),
      backend: ref(),
      provider: ref(),
    },
    binding: ref(),
    grantHash: "receipt-contract",
    isolationId: randomUUID(),
    adoption: "live",
    materialRefId: randomUUID(),
    secret: { kind: "secret", namespaceId: namespace.id, id: harnessSecret.id },
    secretDriver: ref(),
    materialId: randomUUID(),
    materialVersion: "N",
    authoritativeObservedAt: new Date().toISOString(),
    usableUntil: "2099-01-01T00:00:00.000Z",
    retention: "none",
  };
  const input = {
    sender,
    instanceId: randomUUID(),
    useId: randomUUID(),
    attemptId: randomUUID(),
    material: evidence,
    deadlineAt: evidence.usableUntil,
  } satisfies SendAttempt;
  const starts = await Promise.all([receipts.begin(sender, input), receipts.begin(sender, input)]);
  assert.equal(starts.filter((value) => value.created).length, 1);
  const rejected = { kind: "provider_rejected", dispatch: "confirmed", status: 401 };
  const feedback = { classification: "credential_rejected" as const, evidence };
  // Observation commits the fence but cannot claim that a remote sender applied the decision.
  const observed = await receipts.observe(sender, input, rejected, feedback);
  assert.deepEqual(observed.outcome, { kind: "uncertain", dispatch: "possible" });
  assert.deepEqual(observed.observation, rejected);
  assert.equal(observed.feedback, "fenced");
  assert.equal(observed.settled, false);
  assert.deepEqual(await receipts.observe(sender, input, rejected, feedback), observed);
  assert.equal((await receipts.begin(sender, input)).created, false);
  assert.equal(await receipts.recover(sender, { ...input, instanceId: randomUUID() }), undefined);
  for (const changed of [
    { ...input, deadlineAt: "2099-01-02T00:00:00.000Z" },
    { ...input, material: { ...evidence, materialVersion: "N+1" } },
    { ...input, material: { ...evidence, secretDriver: ref() } },
    { ...input, material: { ...evidence, value: "forbidden" } },
    { ...input, operation_handle: "forbidden" },
  ]) {
    await assert.rejects(receipts.begin(sender, changed), { name: "ResourceStateConflictError" });
  }
  for (const invalid of [
    { ...rejected, body: "forbidden" },
    { ...rejected, headers: [] },
    { ...rejected, key: "forbidden" },
  ]) {
    await assert.rejects(receipts.observe(sender, input, invalid, feedback), {
      name: "ResourceStateConflictError",
    });
  }
  await store.read(async (view) => {
    assert.equal(await view.credentialSources.isEgressMaterialRejected(evidence), true);
    assert.equal(
      await view.credentialSources.isEgressMaterialRejected({
        ...evidence,
        materialVersion: "N+1",
      }),
      false,
    );
    assert.equal(
      await view.credentialSources.isEgressMaterialRejected({ ...evidence, secretDriver: ref() }),
      false,
    );
    assert.equal(
      "egressSendReceipts" in view ? view.egressSendReceipts : undefined,
      undefined,
      "receipt mutation stays in the transaction owner",
    );
  });
  // Once final uncertainty is recorded, neither a retry nor invented refusal is permitted.
  await receipts.record(sender, input, { kind: "uncertain", dispatch: "possible" });
  await assert.rejects(receipts.record(sender, input, rejected, feedback), {
    name: "ResourceStateConflictError",
  });
  await assert.rejects(
    receipts.record(sender, input, {
      kind: "refused",
      dispatched: false,
      error: { kind: "cancelled" },
    }),
    { name: "ResourceStateConflictError" },
  );
  const rollback = {
    ...input,
    useId: randomUUID(),
    material: { ...evidence, materialVersion: "rollback" },
  };
  await assert.rejects(
    store.transact(async (unit) => {
      await unit.egressSendReceipts.insert(rollback);
      await unit.credentialSources.rejectEgressMaterial(rollback.material);
      throw new Error("abort receipt and fence");
    }),
    /abort receipt and fence/,
  );
  assert.equal(await receipts.recover(sender, rollback), undefined);
  assert.equal(
    await store.read((view) => view.credentialSources.isEgressMaterialRejected(rollback.material)),
    false,
  );
  const refused = { ...input, useId: randomUUID() };
  await receipts.begin(sender, refused);
  const final = await receipts.record(sender, refused, {
    kind: "refused",
    dispatched: false,
    error: { kind: "cancelled" },
  });
  assert.equal(final.observation, null);
  assert.equal(final.feedback, null);
  await assert.rejects(receipts.reject(sender, refused, evidence), {
    name: "ResourceStateConflictError",
  });
}
