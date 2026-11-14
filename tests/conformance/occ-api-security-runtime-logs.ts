import assert from "node:assert/strict";
import test from "node:test";
import { grantRole } from "../helpers/iam-grants.mjs";
import {
  createRuntimeLogComputeDriver,
  createRuntimeLogFixture,
  operateGrants,
} from "../helpers/runtime-logs.ts";
import { responseError } from "./occ-api-security-fixture.ts";

export function registerRuntimeLogAdmissionCase() {
  test("runtime log reads are rate limited per principal and Agent with Retry-After", async () => {
    const computeDriver = createRuntimeLogComputeDriver();
    const fixture = await createRuntimeLogFixture({ computeDriver });
    const target = await fixture.deployAgent();
    let limited: Awaited<ReturnType<typeof fixture.request>> | undefined;
    for (let attempt = 0; attempt < 12 && limited === undefined; attempt += 1) {
      const response = await fixture.request("GET", target.runtimePath);
      if (response.status === 429) {
        limited = response;
      } else {
        assert.equal(response.status, 200, response.text);
      }
    }
    assert.ok(limited, "the burst of 10 is exhausted within 12 immediate requests");
    assert.equal(responseError(limited.body).code, "RUNTIME_LOGS_RATE_LIMITED");
    assert.match(limited.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);

    // Authorization runs before the limiter: an unauthorized principal past the burst is
    // still refused with 403 and audited every time, takes no token and never reaches the
    // Driver. (A limiter answering first would hide denials behind unaudited 429s.)
    const outsider = await fixture.createPrincipal("runtime-outsider", target, []);
    computeDriver.calls.length = 0;
    const deniedBefore = fixture.auditSink.events.filter(
      (event) => event.kind === "authorization_denial" && event.actorId === outsider.principal.id,
    ).length;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      for (const path of [target.runtimePath, target.logsPath()]) {
        statuses.push((await fixture.request("GET", path, { session: outsider.session })).status);
      }
    }
    assert.deepEqual(new Set(statuses), new Set([403]));
    assert.equal(
      fixture.auditSink.events.filter(
        (event) => event.kind === "authorization_denial" && event.actorId === outsider.principal.id,
      ).length - deniedBefore,
      statuses.length,
    );
    assert.equal(computeDriver.calls.length, 0);
    // The denials took no token: once granted, the same principal still has its full burst.
    for (const grant of operateGrants) {
      grantRole(fixture.policy, outsider.principal.id, {
        id: `runtime-outsider-${grant.resourceKind}-${grant.action}`,
        namespaceId: target.namespace.id,
        permissions: { [grant.resourceKind]: [grant.action] },
        resource: {
          kind: grant.resourceKind,
          id: grant.resourceKind === "agent_revision" ? target.revisionId : target.agent.id,
        },
      });
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const granted = await fixture.request("GET", target.runtimePath, {
        session: outsider.session,
      });
      assert.equal(granted.status, 200, granted.text);
    }
    const operator = await fixture.createPrincipal("runtime-limit-operator", target, operateGrants);
    const unaffected = await fixture.request("GET", target.runtimePath, {
      session: operator.session,
    });
    assert.equal(unaffected.status, 200, unaffected.text);
  });
}
