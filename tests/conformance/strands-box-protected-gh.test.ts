import assert from "node:assert/strict";
import test from "node:test";
import { gh, stageBEndToEnd } from "../helpers/strands-box-protected-fixture.ts";

// Manual lane strands-box-native (docs/testing/strands-box.md): stock gh is a
// host input CI does not stage, so this case runs only when the lane selects it
// and then fails, never skips, without gh. The same steps without gh run in
// checks-baseline-1 (strands-box-protected.test.ts).
const selection =
  process.env.OCC_TEST_STRANDS_BOX_NATIVE === "1"
    ? false
    : "select the strands-box-native lane (OCC_TEST_STRANDS_BOX_NATIVE=1)";

test(
  "Box asks OCE for every request: stock git and gh push and open one draft with one decision per request, and after withdrawal OCE refuses the next request before any provider connection",
  { timeout: 90_000, skip: selection },
  async (t) => {
    assert.ok(
      gh,
      "install stock gh at /usr/local/bin/gh or /usr/bin/gh, as the runtime image does",
    );
    await stageBEndToEnd(t, gh);
  },
);
