import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialFreeOnlineGrantFixture,
  undeployedStockGrantFixture,
} from "../helpers/credential-free-online-grant.ts";

// The signed RPC and OCC policy are real. The association with a sandbox is test-owned;
// this does not qualify a stock release, authenticate a supervisor instance, or permit dispatch.
test("signed stock request observes an OCC credential-free grant and its withdrawal", async (t) => {
  const f = await credentialFreeOnlineGrantFixture(t);
  assert.deepEqual(await f.evaluate(), { decision: 1 }, "only a current grant observation");
  const denied = { decision: 2, reason_code: "online_authorization_denied" };
  for (const change of [
    { host: "wrong.fixture.test" },
    { path: "/repos/other/repository" },
    { port: 8443 },
    { method: "POST" },
    { query: "scope=other" },
  ]) {
    assert.deepEqual(await f.evaluate(change), denied);
  }
  assert.deepEqual(await f.evaluate({}, Buffer.from("payload")), denied);
  assert.deepEqual(await f.evaluate({ query: "" }), { decision: 1 });
  await f.withdraw();
  assert.deepEqual(await f.evaluate(), denied, "the same unexpired signed identity lost the grant");
});

test("a signed stock request cannot carry a credential-free grant across revision replacement", async (t) => {
  const f = await credentialFreeOnlineGrantFixture(t);
  assert.deepEqual(await f.evaluate(), { decision: 1 });
  await f.replaceRevision();
  assert.equal(
    (await f.evaluate()).decision,
    2,
    "the original execution cannot borrow its successor's grant",
  );
});

test("a signed stock request loses a credential-free grant when OCC IAM access is removed", async (t) => {
  const f = await credentialFreeOnlineGrantFixture(t);
  assert.deepEqual(await f.evaluate(), { decision: 1 });
  await f.revokeAccess();
  assert.equal(
    (await f.evaluate()).decision,
    2,
    "live source and revision do not replace operate permission",
  );
});

test("OCC cannot observe a live credential grant as credential-free metadata", async (t) => {
  const { controller, namespaceId, agentId, deploy, activate } =
    await undeployedStockGrantFixture(t);
  const id = await deploy();
  await activate(id);
  const revision = await controller.transact((unit) =>
    unit.revisions.findRevision(namespaceId, agentId, id),
  );
  const route = revision?.egressPlan?.routes[0];
  assert.ok(route, "expected the admitted inference route");
  const { binding, method, origin, path } = route;
  assert.equal(method, "POST", "use the admitted inference operation");
  assert.equal(
    binding.grant.kind,
    "inference",
    "exercise a real admitted credential-bearing source",
  );
  // Exercise the JavaScript boundary with the admitted POST and exact target.
  // The stock observation must refuse the actual inference plan, which has multiple routes.
  const verdict: unknown = await Reflect.apply(
    controller.observeCredentialFreeMetadataGrant,
    controller,
    [binding, { method, origin, path }],
  );
  assert.equal(verdict, "not_current");
});
