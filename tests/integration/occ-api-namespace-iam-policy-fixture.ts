import assert from "node:assert/strict";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { ErrorResponse, type ErrorCode } from "../../packages/contracts/src/index.ts";
import {
  bootstrapInstallation,
  createAgent as createInjectedAgent,
  createInjectedControllerFixture,
  injectedRequest,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type Reply = Awaited<ReturnType<FixtureRequest>>;

export function checkedBody<Schema extends TSchema>(
  reply: Reply,
  status: number,
  schema: Schema,
  label?: string,
): Static<Schema> {
  const message =
    label === undefined ? JSON.stringify(reply.body) : `${label}: ${JSON.stringify(reply.body)}`;
  assert.equal(reply.status, status, message);
  assert(Check(schema, reply.body), message);
  return reply.body;
}

export function assertApiError(reply: Reply, status: number, code: ErrorCode, label?: string) {
  const body = checkedBody(reply, status, ErrorResponse, label);
  assert.equal(body.error.code, code, JSON.stringify(body));
  return body;
}

export async function configuredController() {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createInjectedControllerFixture(
    { auditSink },
    {
      wrapPlatformState: (state) => state,
      invokeApplication(factory, { backendSummaries, ...options }) {
        assert.equal(backendSummaries, undefined);
        return factory(options);
      },
    },
  );
  const request: FixtureRequest = (method, path, options) =>
    injectedRequest(fixture.app, method, path, options);
  return { fixture, request, auditSink };
}

export type TestController = Awaited<ReturnType<typeof configuredController>>;

export async function bootstrap(configured: TestController) {
  await bootstrapInstallation(configured);
  const { controller, platformState } = configured.fixture;
  assert(controller && platformState, "bootstrap must create OCC and its State");
  return { controller, platformState };
}

export async function createAgent(controller: TestController, namespaceId: string, name: string) {
  const data = await createInjectedAgent(controller, namespaceId, name);
  assert.equal(typeof data.servicePrincipalId, "string");
  assert.ok(data.servicePrincipalId.length > 0);
  return data;
}
