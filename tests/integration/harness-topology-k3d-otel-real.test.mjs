import assert from "node:assert/strict";
import test from "node:test";
import {
  arrangeProductionTopology,
  assertActualModelTurn,
  assertKubernetesOtelLogs,
  requiresProductionClusterOtelLogs,
} from "../helpers/harness-topology-k3d-real.mjs";
import { boundedTeardown } from "../helpers/kubernetes-real.mjs";

// The topology registers its platform Namespace delete before the worker and port-forward stops.
// Run them newest-first, each bounded and all attempted (finding 1711).
const topologyTeardown = (testContext) =>
  boundedTeardown(testContext, { label: "production topology teardown" });

test(
  "production embedded runtime emits actual OTLP logs during a real model turn",
  { ...requiresProductionClusterOtelLogs, timeout: 600_000 },
  async (testContext) => {
    const { context } = topologyTeardown(testContext);
    const topology = await arrangeProductionTopology(context, "embedded");
    assert.equal(topology.harnessPod, undefined, "embedded execution must not create a Codex Pod");
    await assertActualModelTurn(topology);
    await assertKubernetesOtelLogs(topology);
  },
);

test(
  "production dedicated runtime emits actual OTLP logs during a real model turn",
  { ...requiresProductionClusterOtelLogs, timeout: 600_000 },
  async (testContext) => {
    const { context } = topologyTeardown(testContext);
    const topology = await arrangeProductionTopology(context, "dedicated");
    assert.ok(topology.harnessPod, "dedicated production must start a real separate Codex Pod");
    await assertActualModelTurn(topology);
    await assertKubernetesOtelLogs(topology);
  },
);
