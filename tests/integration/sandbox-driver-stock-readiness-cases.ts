import assert from "node:assert/strict";

import type {
  MessageTypeDefinition,
  PackageDefinition,
} from "../../apps/controller/node_modules/@grpc/proto-loader/build/src/index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function verifyStockReadinessEvidence(
  productDefinitions: PackageDefinition,
  stockDefinitions: PackageDefinition,
): void {
  const readiness = "openshell.v1.ProviderReadinessStatus";
  const product = message(productDefinitions, readiness);
  const stock = message(stockDefinitions, readiness);
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

function verifyStockRoundTrip(
  product: MessageTypeDefinition<object, unknown>,
  stock: MessageTypeDefinition<object, unknown>,
  evidence: object,
  expectedStock: object,
): void {
  const bytes = product.serialize(evidence);
  assert.deepEqual(product.deserialize(bytes), evidence);
  const decoded = stock.deserialize(bytes);
  assert.ok(isRecord(decoded));
  assert.deepEqual(decoded, expectedStock);
  assert.deepEqual(product.deserialize(stock.serialize(decoded)), expectedStock);
}

function message(
  definitions: PackageDefinition,
  name: string,
): MessageTypeDefinition<object, unknown> {
  const definition = definitions[name];
  assert.ok(
    definition &&
      "format" in definition &&
      definition.format === "Protocol Buffer 3 DescriptorProto",
    `Missing protobuf message ${name}`,
  );
  return definition;
}

export function verifyStockExtensionRoundTrips(
  product: PackageDefinition,
  stock: PackageDefinition,
): void {
  const policyStatus = "openshell.v1.GetSandboxPolicyStatusResponse";
  const enforcement = {
    sandbox_id: "sandbox-one",
    enforced_capabilities: ["test-only-capability"],
  };
  verifyStockRoundTrip(
    message(product, policyStatus),
    message(stock, policyStatus),
    {
      active_version: 1,
      loaded_enforcement: enforcement,
      loaded_policy_observation: { source_policy_hash: "policy-one", enforcement },
    },
    { active_version: 1 },
  );
  const spec = "openshell.v1.SandboxSpec";
  verifyStockRoundTrip(
    message(product, spec),
    message(stock, spec),
    { provider_attachment_epoch: "epoch-one" },
    {},
  );
}
