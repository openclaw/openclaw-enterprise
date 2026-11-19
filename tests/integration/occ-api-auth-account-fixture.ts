import assert from "node:assert/strict";
import { Type } from "typebox";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  ErrorResponse,
  NamespaceListResponse,
  RequestId,
  type ErrorCode,
} from "../../packages/contracts/src/index.ts";
import { BOOTSTRAP_DEFAULT_NAMESPACE_NAME } from "../../packages/occ/src/index.ts";
import {
  checkedInjectedBody,
  createInjectedControllerFixture,
  injectedRequest,
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
    {
      wrapPlatformState: (state) => state,
      invokeApplication(factory, { backendSummaries, ...appOptions }) {
        assert.equal(backendSummaries, undefined);
        return factory(appOptions);
      },
    },
  );
  const request: FixtureRequest = (method, pathname, requestOptions) =>
    injectedRequest(fixture.app, method, pathname, requestOptions);
  return { fixture, request, auditSink };
}

type TestController = Awaited<ReturnType<typeof configuredController>>;

export async function defaultNamespace(controller: TestController) {
  const { data } = checkedInjectedBody(
    await controller.request("GET", "/namespaces"),
    200,
    NamespaceListResponse,
  );
  const found = data.find((namespace) => namespace.name === BOOTSTRAP_DEFAULT_NAMESPACE_NAME);
  assert.ok(found, "fresh bootstrap must create the default Namespace");
  assert.equal(found.status, "provisioning");
  return found;
}
