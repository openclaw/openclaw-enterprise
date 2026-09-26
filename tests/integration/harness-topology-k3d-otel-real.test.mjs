import assert from "node:assert/strict";
import test from "node:test";
import {
  arrangeProductionTopology,
  assertActualModelTurn,
  assertKubernetesOtelLogs,
  requiresProductionClusterOtelLogs,
} from "../helpers/harness-topology-k3d-real.mjs";

test(
  "production embedded runtime emits actual OTLP logs during a real model turn",
  { ...requiresProductionClusterOtelLogs, timeout: 600_000 },
  async (context) => {
    const topology = await arrangeProductionTopology(context, "embedded");
    assert.equal(topology.harnessPod, undefined, "embedded execution must not create a Codex Pod");
    await assertActualModelTurn(topology);
    await assertKubernetesOtelLogs(topology);
  },
);

test(
  "production dedicated runtime emits actual OTLP logs during a real model turn",
  { ...requiresProductionClusterOtelLogs, timeout: 600_000 },
  async (context) => {
    const topology = await arrangeProductionTopology(context, "dedicated");
    assert.ok(topology.harnessPod, "dedicated production must start a real separate Codex Pod");
    await assertActualModelTurn(topology);
    await assertKubernetesOtelLogs(topology);
  },
);
