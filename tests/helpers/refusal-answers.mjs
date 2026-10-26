import assert from "node:assert/strict";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import { sentIdHidden } from "./refusal-text.mjs";

/**
 * The HTTP answer the API gives for what `work` throws: its status, code and message, as
 * apps/controller/src/http/errors.ts maps them. `options` goes to requestFailure (the IDs the
 * request sent and the caller), so a caller's own denial names the grant it checked. Fails when
 * `work` succeeds.
 */
export async function refusedAnswer(work, options) {
  const error = await Promise.resolve()
    .then(work)
    .then(
      () => assert.fail("the request must be refused"),
      (rejection) => rejection,
    );
  const { status, code, message } = requestFailure(error, options);
  return { status, code, message };
}

/**
 * Sends the same refused request once per ID in `ids` (first a resource that exists but that the
 * caller may not read, then IDs that do not exist) and asserts that every answer is the same once
 * each answer's own ID is hidden: a refusal must not tell the caller whether the resource exists.
 * A denial may echo the ID its request sent (`sentIdHidden`), and nothing else may differ.
 *
 * `send(id)` returns an HTTP response with `status` and its error in `error` or `body.error`, or
 * a flat `{ status, code, message }` such as `refusedAnswer` gives. The first answer must have
 * `status` (403 by default), so two identical successes or two not-founds cannot pass.
 * Returns that answer.
 */
export async function assertSameAnswer(send, ids, { status = 403, label = "" } = {}) {
  assert.ok(ids.length >= 2, "compare an existing ID with at least one missing ID");
  const answers = [];
  for (const id of ids) {
    const response = await send(id);
    const error = response.error ?? response.body?.error ?? response;
    answers.push({
      status: response.status,
      code: error.code,
      message: typeof error.message === "string" ? sentIdHidden(error.message, id) : undefined,
    });
  }
  const prefix = label === "" ? "" : `${label}: `;
  assert.equal(answers[0].status, status, `${prefix}${JSON.stringify(answers[0])}`);
  for (const answer of answers.slice(1)) {
    assert.deepEqual(answer, answers[0], `${prefix}a missing ID must get the same answer`);
  }
  return answers[0];
}
