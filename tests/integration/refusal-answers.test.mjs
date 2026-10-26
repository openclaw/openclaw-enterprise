import assert from "node:assert/strict";
import test from "node:test";

import { assertSameAnswer } from "../helpers/refusal-answers.mjs";

// assertSameAnswer is the oracle that a refusal does not tell a caller whether a resource exists.
// It compares the whole error, as the per-test checks it replaced did (finding 2628): a field
// such as `details` that appears only for the existing resource would tell the two apart.

const refusal = (id, error = {}) => ({
  status: 400,
  body: {
    error: {
      code: "INVALID_REQUEST",
      message: `Configuration ${id} must use the primary model's provider.`,
      ...error,
    },
  },
});

test("assertSameAnswer refuses answers whose details differ", async () => {
  await assert.rejects(
    assertSameAnswer(
      async (id) =>
        refusal(
          id,
          id === "cfg_used"
            ? { details: [{ path: "/agents/agt_used", code: "INVALID_VALUE" }] }
            : {},
        ),
      ["cfg_used", "cfg_unknown"],
      { status: 400 },
    ),
    { name: "AssertionError", message: /a missing ID must get the same answer/ },
  );
});

test("assertSameAnswer hides the sent ID in every string of the error", async () => {
  const answer = await assertSameAnswer(
    async (id) =>
      refusal(id, { details: [{ path: `/configurations/${id}`, code: "INVALID_VALUE" }] }),
    ["cfg_used", "cfg_unknown"],
    { status: 400 },
  );
  assert.deepEqual(answer, {
    status: 400,
    code: "INVALID_REQUEST",
    message: "Configuration <id> must use the primary model's provider.",
    details: [{ path: "/configurations/<id>", code: "INVALID_VALUE" }],
  });
});
