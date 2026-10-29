import assert from "node:assert/strict";
import test from "node:test";
import { credentialFreeOnlineGrantFixture } from "../helpers/credential-free-online-grant.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

// The signed RPC and OCC policy are real. The association with a sandbox is test-owned;
// this does not qualify a stock release, authenticate a supervisor instance, or permit dispatch.
test("signed stock request observes an OCC credential-free grant and its withdrawal", async (t) => {
  const f = await credentialFreeOnlineGrantFixture(t);
  assert.deepEqual(await f.evaluate(), { decision: 1 }, "only a current grant observation");
  const denied = { decision: 2, reason_code: "online_authorization_denied" };
  for (const change of [{ host: "wrong.fixture.test" }, { path: "/repos/other/repository" }]) {
    assert.deepEqual(await f.evaluate(change), denied);
  }
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
  const f = await staticEgressFixture(t, { admitRevision: false });
  const { namespace, agent, controller } = f;
  const { id } = await f.deployAgent(namespace.id, agent.id);
  await f.activateRevision(namespace.id, agent.id, id);
  const revision = await controller.transact((unit) =>
    unit.revisions.findRevision(namespace.id, agent.id, id),
  );
  const { binding, method, origin, path } = revision.egressPlan.routes[0];
  assert.equal(
    binding.grant.kind,
    "inference",
    "exercise a real admitted credential-bearing source",
  );
  assert.equal(
    // Supply its actual operation, even bypassing the typed GET input, so a target mismatch
    // cannot be the reason this credential-bearing source was refused.
    await controller.observeCredentialFreeMetadataGrant(binding, { method, origin, path }),
    "not_current",
  );
});
