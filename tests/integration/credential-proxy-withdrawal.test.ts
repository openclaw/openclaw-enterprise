import assert from "node:assert/strict";
import test from "node:test";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

// Use the same admitted execution and real Driver as the protected egress journey.
// An unsupported reduction is a caller decision, never permission to delete its Sandbox.
test("OpenShell requests explicit retirement when it cannot attest binding reduction", async (t) => {
  const f = await staticEgressFixture(t);
  assert.ok("context" in f && "egress" in f && "observed" in f);
  const binding = f.context.plan.routes[0].binding.binding;
  assert.equal(await f.egress.withdrawBinding(f.context, binding), "retire-runtime");
  assert.deepEqual(f.observed.deleted, []);
  assert.equal(await f.egress.withdrawBinding(f.context, binding), "retire-runtime");
  assert.deepEqual(f.observed.deleted, [], "rechecking does not retire the execution");
  await assert.rejects(
    f.egress.withdrawBinding(f.context, { ...binding, id: "unadmitted" }),
    /Unknown/,
  );
  assert.deepEqual(f.observed.deleted, []);
});
