import assert from "node:assert/strict";
import test from "node:test";
import { boxTurnPolicy } from "../helpers/strands-box-turn-policy.ts";

test("a protected Box turn uses the same external policy as an ordinary Box turn", async () => {
  // Compute mounts the same three-key binding for both; the patch has no protected branch.
  assert.deepEqual(await boxTurnPolicy(), {
    type: "externalSandbox",
    networkAccess: "restricted",
  });
});
