import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";

import { authenticatedHeaders } from "./auth-session.mjs";

// Send a route-specific opening and 64 KiB, leaving the declared body unfinished.
// Resolve with null if the controller is still waiting for the rest after the deadline.
export function partialWrite({ origin, method, path, session, declaredBytes, bodyPrefix }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        request.destroy();
        callback(value);
      }
    };
    const request = httpRequest(new URL(path, origin), {
      method,
      headers: {
        ...authenticatedHeaders(session, { origin }),
        "content-type": "application/json",
        "content-length": String(declaredBytes),
      },
    });
    const timer = setTimeout(() => settle(resolve, null), 15_000);
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          settle(resolve, { status: response.statusCode, body });
        } catch (error) {
          settle(reject, error);
        }
      });
      response.on("error", (error) => settle(reject, error));
    });
    request.on("error", (error) => settle(reject, error));
    request.write(`${bodyPrefix}${"x".repeat(64 * 1024)}`);
  });
}

export function assertWriteAuthorizationDenial(
  events,
  { principalId, action, grant, resource },
  method,
) {
  const recorded = events.filter(
    (event) =>
      event.kind === "authorization_denial" &&
      event.actor?.principalId === principalId &&
      event.action === action,
  );
  assert.equal(recorded.length, 1, method);
  assert.equal(recorded[0].reasonCode, "AUTHORIZATION_DENIED", method);
  assert.deepEqual(recorded[0].resource, resource, method);
  assert.deepEqual(recorded[0].authorization, { principalId, action: grant, resource }, method);
}
