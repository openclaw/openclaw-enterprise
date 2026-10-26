import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { createRequire } from "node:module";

import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";

const require = createRequire(new URL("../../packages/contracts/package.json", import.meta.url));
const { Check, Errors } = require("typebox/value");

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

/**
 * A Playwright `route.fulfill()` answer carrying the API's error envelope:
 * `{ error: { code, message, details? }, meta: { requestId } }`. The envelope is checked
 * against the contract's ErrorResponse schema, so a faked refusal cannot use a code, detail or
 * request ID the API never sends. A refusal from something in front of the API uses
 * proxyErrorResponse instead.
 *
 * @param {number} status
 * @param {import("../../packages/contracts/src/api/common.ts").ErrorCode} code
 * @param {string} message
 * @param {{ details?: import("../../packages/contracts/src/api/common.ts").ErrorDetail[], requestId?: string }} [options]
 */
export function apiErrorResponse(status, code, message, { details, requestId } = {}) {
  const envelope = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
    meta: { requestId: requestId ?? `req_${randomUUID()}` },
  };
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new Error(`An API error answers with a 4xx or 5xx status, not ${status}`);
  }
  if (!Check(ErrorResponse, envelope)) {
    const problems = new Set(
      [...Errors(ErrorResponse, envelope)].map(
        (problem) => `${problem.instancePath || "/"} ${problem.message}`,
      ),
    );
    throw new Error(
      `Not an API error envelope (${[...problems].join("; ")}): ${JSON.stringify(envelope)}`,
    );
  }
  return { status, contentType: "application/json", body: JSON.stringify(envelope) };
}

/**
 * A Playwright `route.fulfill()` answer from a proxy or gateway in front of the API, such as an
 * ingress rate limit (429) or an unreachable upstream (502): the proxy's HTML page, not the
 * API's error envelope, so the Console has only the status to go on. Use it for a status the
 * route itself never sends; an answer the API sends uses apiErrorResponse.
 *
 * @param {number} status
 */
export function proxyErrorResponse(status) {
  const reason = STATUS_CODES[status];
  if (status < 400 || status > 599 || reason === undefined) {
    throw new Error(`A proxy refusal answers with a known 4xx or 5xx status, not ${status}`);
  }
  const title = `${status} ${reason}`;
  return {
    status,
    contentType: "text/html",
    body: `<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`,
  };
}
