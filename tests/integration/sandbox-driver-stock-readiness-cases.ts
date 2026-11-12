import assert from "node:assert/strict";

import type { MessageTypeDefinition } from "../../apps/controller/node_modules/@grpc/proto-loader/build/src/index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function verifyStockReadinessEvidence(
  product: MessageTypeDefinition<object, unknown>,
  stock: MessageTypeDefinition<object, unknown>,
): void {
  const evidence = {
    state: "PROVIDER_READINESS_STATE_READY",
    network_instance_id: "network-one",
    receipt: {
      provider: "provider-one",
      workspace: "workspace-one",
      kind: "PROVIDER_MUTATION_KIND_OBSERVE",
      desired: { sandbox_id: "sandbox-one", attachment_epoch: "epoch-one" },
    },
    observed: {
      session_id: "session-one",
      sequence: "1",
      attachment_epoch: "epoch-one",
      credentials_installed: true,
      policy_active: true,
      launch_environment_installed: true,
      process_instance_id: "process-one",
    },
    observed_time: { seconds: "100" },
    evaluated_time: { seconds: "101" },
  };
  const readinessBytes = product.serialize(evidence);
  assert.deepEqual(product.deserialize(readinessBytes), evidence);
  const stockDecoded = stock.deserialize(readinessBytes);
  assert.ok(isRecord(stockDecoded));
  assert.ok(isRecord(stockDecoded.receipt));
  assert.equal(stockDecoded.state, evidence.state);
  assert.equal(stockDecoded.network_instance_id, evidence.network_instance_id);
  assert.equal(stockDecoded.receipt.provider, evidence.receipt.provider);
  assert.equal(stockDecoded.receipt.workspace, evidence.receipt.workspace);
  assert.equal(stockDecoded.receipt.kind, 4, "unknown enum number is not negotiated support");
  assert.equal(stockDecoded.receipt.desired, undefined);
  for (const key of ["observed", "observed_time", "evaluated_time"]) {
    assert.equal(stockDecoded[key], undefined, key);
  }
  const received = product.deserialize(stock.serialize(stockDecoded));
  assert.ok(isRecord(received));
  assert.ok(isRecord(received.receipt));
  assert.equal(received.state, evidence.state);
  assert.equal(received.network_instance_id, evidence.network_instance_id);
  assert.equal(received.receipt.provider, evidence.receipt.provider);
  assert.equal(received.receipt.workspace, evidence.receipt.workspace);
  assert.equal(received.receipt.desired, undefined);
  assert.equal(received.observed, undefined);
  assert.equal(received.observed_time, undefined);
  assert.equal(received.evaluated_time, undefined);
}
