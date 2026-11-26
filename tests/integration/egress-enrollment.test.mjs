import assert from "node:assert/strict";
import test from "node:test";
import { protectedMetadataFixture } from "../helpers/static-egress.mjs";
import { PROXY_REGISTRATION_UNAVAILABLE } from "../helpers/refusal-text.mjs";

test("zero-route admission has no business allow and an older supplier cannot claim its execution authority", async (t) => {
  const f = await protectedMetadataFixture(t, { recordInstallation: false });
  const plan = { ...f.context.plan, routes: [] };
  const context = { ...f.context, plan, revision: { ...f.revision, egressPlan: plan } };
  const { configuration } = await f.egress.configureRevision(context);
  assert.deepEqual(
    configuration.network_policies,
    {},
    "empty protected routes do not select an unprotected default",
  );
  const middleware = configuration.network_middlewares["oce-egress"];
  assert.equal(middleware.execution_authority, true);
  assert.deepEqual(middleware.endpoints.include, ["deny-egress.invalid"]);
  const policy = { ...f.attachment.configuration, ...configuration };
  const attachment = { plan, configuration: policy };
  const observed = f.observed;
  observed.policy = policy;
  observed.observation.effective_policy = policy;
  const installed = await f.egress.wiringStatus(context, attachment);
  assert.equal(installed?.enforcement.authorityScope, "execution");
  assert.ok(await f.egress.verifyInstallation(context, installed));
  const current = observed.evidence.enforced_capabilities;
  const old = current.filter((cap) => !cap.endsWith(".protected-no-material.v1"));
  observed.evidence.enforced_capabilities = old;
  assert.equal(
    await f.egress.wiringStatus(context, attachment),
    undefined,
    "fresh gateway, old loaded supervisor",
  );
  assert.equal(await f.egress.verifyInstallation(context, installed), false);
  observed.evidence.enforced_capabilities = [...current].sort();
  assert.equal(
    await f.egress.wiringStatus(context, attachment),
    undefined,
    "loaded enforcement evidence must retain its canonical order",
  );
  observed.evidence.enforced_capabilities = current;
  const widened = {
    ...policy,
    network_policies: { unexpected: { endpoints: [{ host: "deny-egress.invalid" }] } },
  };
  await assert.rejects(
    f.egress.wiringStatus(context, { plan, configuration: widened }),
    /changed protected egress routes/,
  );
  const assertAvailable = () => f.egress.sourceControl.assertAvailable(AbortSignal.timeout(5000));
  await assertAvailable();
  // A gateway state an operator fixes: a 503 that names it (finding 2536).
  const unavailable = { name: "RetryLaterError", message: PROXY_REGISTRATION_UNAVAILABLE };
  observed.requiredCapabilities = old;
  await assert.rejects(assertAvailable, unavailable, "complete supported, incomplete required");
  delete observed.requiredCapabilities;
  observed.supportedCapabilities = [...current, current[0]];
  await assert.rejects(assertAvailable, unavailable, "complete required, duplicate in supported");
});
