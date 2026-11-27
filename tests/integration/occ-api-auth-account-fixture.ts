import assert from "node:assert/strict";
import { Type } from "typebox";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { ErrorResponse, RequestId, type ErrorCode } from "../../packages/contracts/src/index.ts";
import {
  checkedInjectedBody,
  createInjectedControllerFixture,
  requestForFixture,
  withoutBackendSummaries,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type FixtureOptions = Parameters<typeof createInjectedControllerFixture>[0];
type Reply = Awaited<ReturnType<FixtureRequest>>;
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const PublicUser = Type.Object({ id: Type.String(), email: Type.String(), name: Type.String() });
export const SessionResponse = Type.Object({
  data: Type.Union([
    Type.Null(),
    Type.Object({ authenticated: Type.Literal(true), sessionKey: Type.String(), user: PublicUser }),
  ]),
  meta: Type.Object({ requestId: RequestId }),
});
export const AccountResponse = Type.Object({
  data: Type.Object({
    id: Type.String(),
    email: Type.String(),
    name: Type.String(),
    principalId: Type.String(),
  }),
  meta: Type.Object({ requestId: RequestId }),
});

export function assertApiError(reply: Reply, status: number, code: ErrorCode, label?: string) {
  const body = checkedInjectedBody(reply, status, ErrorResponse);
  assert.equal(body.error.code, code, label ?? JSON.stringify(body));
}

export async function configuredController(options: FixtureOptions = {}) {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createInjectedControllerFixture(
    { ...options, auditSink },
    withoutBackendSummaries,
  );
  return { fixture, request: requestForFixture(fixture), auditSink };
}
