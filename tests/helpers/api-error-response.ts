import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { Check, Errors } from "typebox/value";

import {
  ErrorResponse,
  type ErrorCode,
  type ErrorDetail,
} from "../../packages/contracts/src/index.ts";

/** A Playwright fulfillment carrying a contract-validated API error envelope. */
export function apiErrorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  { details, requestId }: { details?: ErrorDetail[]; requestId?: string } = {},
) {
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

/** A proxy or gateway refusal with its raw HTML page instead of an API envelope. */
export function proxyErrorResponse(status: number) {
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
