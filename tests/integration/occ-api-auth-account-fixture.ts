import { Type } from "typebox";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { RequestId } from "../../packages/contracts/src/index.ts";
import {
  createInjectedControllerFixture,
  requestForFixture,
  withoutBackendSummaries,
} from "./occ-api-injected-fixture.ts";

export { checkedInjectedError as assertApiError } from "./occ-api-injected-fixture.ts";

type FixtureOptions = Parameters<typeof createInjectedControllerFixture>[0];
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

export async function configuredController(options: FixtureOptions = {}) {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createInjectedControllerFixture(
    { ...options, auditSink },
    withoutBackendSummaries,
  );
  return { fixture, request: requestForFixture(fixture), auditSink };
}
