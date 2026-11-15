import assert from "node:assert/strict";
import test from "node:test";
import { tenantRequest as request } from "../helpers/tenant-reader-app.ts";
import {
  bootstrap,
  createAgent,
  createFixture,
  createNamespace,
  expectProvisioningDeployRefusal,
  installationId,
  responseError,
  restrictionIds,
} from "./occ-api-security-fixture.ts";

export function registerRestrictionAuditCase() {
  test("Restriction denials retain sanitized native IAM evidence in audit", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    fixture.state.restrictions.push({
      id: "restriction-no-namespace-create",
      action: "create",
      resourceKind: "namespace",
      effect: "deny",
    });
    const denied = await request(fixture.app, "/namespaces", {
      body: { name: "blocked-by-restriction" },
    });
    assert.equal(denied.response.status, 403);
    const event = fixture.auditSink.events.at(-1);
    assert.equal(event?.kind, "authorization_denial");
    assert.equal(event?.iamDriverId, "iam-security");
    assert.deepEqual(restrictionIds(event), ["restriction-no-namespace-create"]);
    assert.equal(JSON.stringify(event).includes("blocked-by-restriction"), false);
  });
}

export function registerAuditFailureCase() {
  test("a denial whose audit cannot be written answers 503, not 403", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    await createNamespace(fixture, "Tenant A");
    const namespace = await createNamespace(fixture, "Tenant B");
    const readerApp = fixture.createApp(fixture.tenantAReader);
    const read = () => request(readerApp, `/namespaces/${namespace.id}`);

    const append = fixture.auditSink.append;
    fixture.auditSink.append = async (event) => {
      if (event.kind === "authorization_denial") {
        throw new Error("audit sink unavailable");
      }
      return append.call(fixture.auditSink, event);
    };
    try {
      const unaudited = await read();
      assert.equal(unaudited.response.status, 503);
      assert.equal(responseError(unaudited.payload).code, "DEPENDENCY_UNAVAILABLE");
    } finally {
      fixture.auditSink.append = append;
    }
    const audited = await read();
    assert.equal(audited.response.status, 403);
    assert.equal(fixture.auditSink.events.at(-1)?.kind, "authorization_denial");
  });
}

export function registerMutationAuditCase() {
  test("mutations are attributable and authorization failures never leak credentials", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const namespace = await createNamespace(fixture, "Audited tenant");
    const agent = await createAgent(fixture, namespace, "Audited agent");
    await expectProvisioningDeployRefusal(fixture, namespace, agent);

    assert.deepEqual(
      fixture.auditSink.events
        .filter((event) => ["bootstrap", "mutation"].includes(event.kind))
        .map((event) => [event.kind, event.resource.kind]),
      [
        ["bootstrap", "installation"],
        ["mutation", "namespace"],
        ["mutation", "configuration"],
        ["mutation", "agent"],
        ["mutation", "agent"],
      ],
    );
    for (const event of fixture.auditSink.events.slice(0, -1)) {
      assert.equal(event.actorId, fixture.administrator.id);
      assert.equal(event.installationId, installationId);
      assert.equal(event.outcome, "success");
    }
    assert.equal(fixture.auditSink.events.at(-1)?.outcome, "failure");
    assert.equal(fixture.auditSink.events.at(-1)?.reasonCode, "NAMESPACE_NOT_READY");
    assert.equal(fixture.auditSink.events.at(-1)?.resource.id, agent.id);

    const secret = "sk-security-provider-credential-123456789";
    const authorize = fixture.iamDriver.authorize;
    fixture.iamDriver.authorize = async () => {
      throw new Error(`Backend credentials failed: ${secret}`);
    };
    try {
      const denied = await request(fixture.app, "/namespaces", {
        body: { name: "Must fail closed" },
      });
      assert.equal(denied.response.status, 503);
      assert.equal(responseError(denied.payload).code, "DEPENDENCY_UNAVAILABLE");
      assert.doesNotMatch(JSON.stringify(denied.payload), new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(fixture.auditSink.events), new RegExp(secret));
      assert.equal(fixture.auditSink.events.at(-1)?.resource.id, agent.id);
    } finally {
      fixture.iamDriver.authorize = authorize;
    }
  });
}
