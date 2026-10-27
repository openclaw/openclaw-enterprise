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

// The oracle passes only when the first answer is the expected refusal and there is a missing ID
// to compare it with: two identical not-founds, or one answer alone, prove nothing.
test("assertSameAnswer refuses a first answer that is not the expected refusal, or one ID", async () => {
  const notFound = async (id) => ({
    status: 404,
    body: { error: { code: "NOT_FOUND", message: `Configuration ${id} was not found.` } },
  });
  await assert.rejects(assertSameAnswer(notFound, ["cfg_used", "cfg_unknown"]), {
    name: "AssertionError",
    message: /"status":404/,
  });
  await assert.rejects(
    assertSameAnswer(async (id) => refusal(id), ["cfg_used"], { status: 400 }),
    {
      name: "AssertionError",
      message: /compare an existing ID with at least one missing ID/,
    },
  );
});

// refusedAnswer gives a flat `{ status, code, message }`; its message is compared too.
test("assertSameAnswer compares a flat answer's message", async () => {
  const flat = (id) => ({
    status: 403,
    code: "FORBIDDEN",
    message:
      id === "agt_used"
        ? `Your access does not include reading Agent ${id}.`
        : `Your access does not include Agent read on ${id}.`,
  });
  await assert.rejects(
    assertSameAnswer(async (id) => flat(id), ["agt_used", "agt_unknown"]),
    {
      name: "AssertionError",
      message: /a missing ID must get the same answer/,
    },
  );
});
