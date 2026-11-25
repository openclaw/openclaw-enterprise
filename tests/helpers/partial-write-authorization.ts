import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";

import type { AuditEvent, AuthorizationRequest } from "../../packages/contracts/src/index.ts";
import { authenticatedHeaders } from "./auth-session.mjs";

type PartialWriteOptions = {
  origin: string;
  transportOrigin: string;
  method: string;
  path: string;
  session: Parameters<typeof authenticatedHeaders>[0];
  declaredBytes: number;
  bodyPrefix: string;
};

type PartialWriteResponse = { status: number; body: unknown };

// Send a route-specific opening and 64 KiB, leaving the declared body unfinished.
// Resolve with null if the controller is still waiting for the rest after the deadline.
export async function partialWrite({
  origin,
  transportOrigin,
  method,
  path,
  session,
  declaredBytes,
  bodyPrefix,
}: PartialWriteOptions): Promise<PartialWriteResponse | null> {
  const request = httpRequest(new URL(path, transportOrigin), {
    method,
    headers: {
      ...authenticatedHeaders(session, { origin }),
      host: new URL(origin).host,
      "content-type": "application/json",
      "content-length": String(declaredBytes),
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await new Promise<PartialWriteResponse | null>(
      (resolve, reject: (error: unknown) => void) => {
        timer = setTimeout(() => resolve(null), 15_000);
        request.on("response", (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            try {
              const status = response.statusCode;
              assert.ok(status !== undefined, "Expected an HTTP response status");
              const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              resolve({ status, body });
            } catch (error) {
              reject(error);
            }
          });
          response.on("error", reject);
        });
        request.on("error", reject);
        request.write(`${bodyPrefix}${"x".repeat(64 * 1024)}`);
      },
    );
  } finally {
    clearTimeout(timer);
    request.destroy();
  }
}

type ExpectedWriteDenial = Pick<AuthorizationRequest, "principalId" | "resource"> & {
  action: AuditEvent["action"];
  grant: AuthorizationRequest["action"];
};

export function assertWriteAuthorizationDenial(
  events: readonly AuditEvent[],
  { principalId, action, grant, resource }: ExpectedWriteDenial,
  method: string,
): void {
  const recorded = events.filter(
    (event) =>
      event.kind === "authorization_denial" &&
      event.actor?.principalId === principalId &&
      event.action === action,
  );
  assert.equal(recorded.length, 1, method);
  const [denial] = recorded;
  assert.ok(denial, method);
  assert.equal(denial.reasonCode, "AUTHORIZATION_DENIED", method);
  assert.deepEqual(denial.resource, resource, method);
  assert.deepEqual(denial.authorization, { principalId, action: grant, resource }, method);
}
