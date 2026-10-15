import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "../backend-contracts.ts";

const SAFE_CODES = new Set([
  "limit-exceeded",
  "unsupported-request",
  "authentication-required",
  "unavailable",
  "exchange-uncertain",
  "exchange-failed",
  "session-unavailable",
  "exchange-capacity",
  "invalid-request",
  "request-expired",
  "invalid-credential",
  "invalid-binding",
  "route-denied",
  "push-ref-limit-exceeded",
]);

function writeErrorHead(
  response: ServerResponse,
  status: number,
  code: string,
  headers: Readonly<Record<string, string>>,
  message?: string,
): Buffer {
  const safe = SAFE_CODES.has(code);
  const body = Buffer.from(
    JSON.stringify({
      error: {
        code: safe ? code : "unavailable",
        ...(safe && message !== undefined ? { message } : {}),
      },
    }),
  );
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store",
    connection: "close",
  });
  return body;
}

/** All error text is service-owned; no upstream exception is serialized. */
export function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  headers: Readonly<Record<string, string>> = {},
  message?: string,
): void {
  if (response.destroyed) {
    return;
  }
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.end(writeErrorHead(response, status, code, headers, message));
}

/**
 * Answer a request whose body is still arriving. Closing a socket with unread input
 * makes the kernel send a reset that can overtake the answer, so the client would see
 * only "connection reset". The complete answer is written first (Connection: close),
 * then the rest of the body is discarded, never buffered, until the client finishes or
 * goes away, for at most `lingerMs`.
 */
export function refuseUnreadInput(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  code: string,
  clock: Clock,
  lingerMs: number,
): void {
  if (request.readableEnded) {
    sendError(response, status, code);
    return;
  }
  if (response.destroyed || response.headersSent) {
    request.destroy();
    response.destroy();
    return;
  }
  let closed = false;
  const close = (completed: boolean) => {
    if (closed) {
      return;
    }
    closed = true;
    stop();
    request.off("end", ended);
    request.off("close", aborted);
    if (completed) {
      response.end();
    } else {
      request.destroy();
      response.destroy();
    }
  };
  const ended = () => close(true);
  const aborted = () => close(request.readableEnded);
  const stop = clock.schedule(lingerMs, () => close(false));
  response.write(writeErrorHead(response, status, code, {}));
  request.once("end", ended);
  request.once("close", aborted);
  request.on("error", () => {});
  request.resume();
}
