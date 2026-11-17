import assert from "node:assert/strict";
import test from "node:test";
import { modelRealBox } from "../helpers/strands-box-native-model.ts";

// Manual lane strands-box-native (docs/testing/strands-box.md): a real Box build with
// request-time credential sources, the controlled GitHub origin on 127.0.0.1:443, and a model
// fixture on an operator name pinned to a private IPv4 of this host are host inputs CI does not
// stage. Selected, a missing input fails the case.
const selection =
  process.env.OCC_TEST_STRANDS_BOX_NATIVE === "1"
    ? false
    : "select the strands-box-native lane (OCC_TEST_STRANDS_BOX_NATIVE=1)";

test(
  "a real Box injects the package's model key per request: placeholder only in the workload, Box refuses other routes, withdrawal and rotation without a restart, SSE and a near-cap body unchanged",
  { timeout: 420_000, skip: selection },
  async (t) => {
    const boxBin = process.env.STRANDS_BOX_SOURCE_BOX;
    const modelHost = process.env.STRANDS_BOX_MODEL_HOST;
    const modelAddress = process.env.STRANDS_BOX_MODEL_ADDRESS;
    assert.ok(boxBin, "set STRANDS_BOX_SOURCE_BOX to a strands-box built with credential sources");
    assert.ok(
      modelHost && modelAddress,
      "set STRANDS_BOX_MODEL_HOST and STRANDS_BOX_MODEL_ADDRESS",
    );
    const result = await modelRealBox(t, {
      boxBin,
      modelHost,
      modelAddress,
      modelPort: Number(process.env.STRANDS_BOX_MODEL_PORT ?? 9444),
      ...(process.env.STRANDS_BOX_MODEL_CODEX
        ? { codexBin: process.env.STRANDS_BOX_MODEL_CODEX }
        : {}),
    });
    t.diagnostic(JSON.stringify(result));
  },
);
