import assert from "node:assert/strict";

/**
 * Asserts that an API `response` (`{ status, body }`) is the error envelope with `status` and
 * `body.error.code`. Each failure names `label` (when given) and the response body, so a
 * refusal that answered differently shows what came back.
 */
export function assertApiError(response, status, code, label) {
  const body = JSON.stringify(response.body);
  const message = label === undefined ? body : `${label}: ${body}`;
  assert.equal(response.status, status, message);
  assert.equal(response.body.error.code, code, message);
}
