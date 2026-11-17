import assert from "node:assert/strict";
import test from "node:test";
import { gh, stageAEndToEnd } from "../helpers/strands-box-protected-fixture.ts";

// Manual lane strands-box-native (docs/testing/strands-box.md): stock gh is a
// host input CI does not stage, so this case runs only when the lane selects it
// and then fails, never skips, without gh. The same steps without gh run in
// checks-baseline-1 (strands-box-protected.test.ts).
const selection =
  process.env.OCC_TEST_STRANDS_BOX_NATIVE === "1"
    ? false
    : "select the strands-box-native lane (OCC_TEST_STRANDS_BOX_NATIVE=1)";

test(
  "after activation the Worker installs OCE's token in Box once; stock git and gh push and open one draft, and withdrawal refuses fresh requests while the execution runs",
  { timeout: 90_000, skip: selection },
  async (t) => {
    assert.ok(
      gh,
      "install stock gh at /usr/local/bin/gh or /usr/bin/gh, as the runtime image does",
    );
    await stageAEndToEnd(t, gh);
  },
);
