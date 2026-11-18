import assert from "node:assert/strict";

export { apiErrorResponse, proxyErrorResponse } from "./api-error-response.ts";

/**
 * Asserts that an API `response` is the error envelope with `status` and `error.code`. The
 * response is `{ status, body }` with a parsed body, or a Fastify inject response (`statusCode`,
 * `json()`). Each failure names `label` (when given) and the response body, so a refusal that
 * answered differently shows what came back.
 */
export function assertApiError(response, status, code, label) {
  const injected = typeof response.statusCode === "number";
  const body = injected ? response.body : JSON.stringify(response.body);
  const message = label === undefined ? body : `${label}: ${body}`;
  assert.equal(injected ? response.statusCode : response.status, status, message);
  // An inject body is parsed only after the status matched, so a non-JSON answer fails on its status.
  assert.equal((injected ? response.json() : response.body).error.code, code, message);
}
