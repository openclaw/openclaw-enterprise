import assert from "node:assert/strict";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  bootstrapInstallation,
  createAgent as createInjectedAgent,
  createInjectedControllerFixture,
  requestForFixture,
  withoutBackendSummaries,
} from "./occ-api-injected-fixture.ts";

export {
  checkedInjectedBody as checkedBody,
  checkedInjectedError as assertApiError,
} from "./occ-api-injected-fixture.ts";

export async function configuredController() {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createInjectedControllerFixture({ auditSink }, withoutBackendSummaries);
  return { fixture, request: requestForFixture(fixture), auditSink };
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
