import assert from "node:assert/strict";
import test from "node:test";
import { stageBRealBox } from "../helpers/strands-box-native-source.ts";

// Manual lane strands-box-native (docs/testing/strands-box.md): a real Box build with the
// request-time credential source, stock git and gh, and the controlled GitHub origin on
// 127.0.0.1:443 are host inputs CI does not stage. Selected, a missing input fails the case.
const selection =
  process.env.OCC_TEST_STRANDS_BOX_NATIVE === "1"
    ? false
    : "select the strands-box-native lane (OCC_TEST_STRANDS_BOX_NATIVE=1)";

test(
  "a real Box asks OCE for every GitHub request: stock git and gh, renewal without a restart, and refusals before any provider byte",
  { timeout: 360_000, skip: selection },
  async (t) => {
    const boxBin = process.env.STRANDS_BOX_SOURCE_BOX;
    const gh = process.env.STRANDS_BOX_SOURCE_GH;
    assert.ok(boxBin, "set STRANDS_BOX_SOURCE_BOX to a strands-box built with credential sources");
    assert.ok(gh, "set STRANDS_BOX_SOURCE_GH to stock gh");
    const result = await stageBRealBox(t, { boxBin, gh });
    t.diagnostic(JSON.stringify(result));
  },
);
