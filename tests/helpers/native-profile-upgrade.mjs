import assert from "node:assert/strict";
import { prepareNativeProfileUpgradeDatabase } from "../../scripts/ci/prepare.ts";
import { withBoundedTeardown } from "./bounded-teardown.ts";
import { runOidcAgentChatUpgradeScenario } from "./native-admin-browser.mjs";

export async function runNativeProfileUpgradeScenario(testContext) {
  // Resolve the selected baseline and acquire a private, never-bootstrapped DB
  // before the scenario can create any cluster resources or make model calls.
  assert.ok(
    process.env.OPENCLAW_ENTERPRISE_CI_STATE,
    "upgrade requires its owned prepared Gateway Routing state",
  );
  const context = withBoundedTeardown(testContext, { label: "native upgrade teardown" });
  const prepared = await prepareNativeProfileUpgradeDatabase(
    process.env.OPENCLAW_ENTERPRISE_CI_STATE,
  );
  context.after(prepared.cleanup);
  await runOidcAgentChatUpgradeScenario(context, prepared);
}
