import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  detailUrl,
  expectNoText,
  fileBrowser,
  login,
  nativeValues,
  newPage,
  secretOptionLabel,
  selectSecret,
  waitForInputValue,
} from "./console-agents-browser-helpers.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

const UNSAVED_SECRETS_GATE =
  "Save the channel Secret choices before deploying, or reload the page to discard unsaved changes.";

// A Slack token binding as the API stores it.
const envBinding = (secret) => ({ source: secret.ref, delivery: { type: "env" } });

// The Deploy gate names a missing Slack binding before an unsaved Secret choice, so first-time
// setup still says what is missing while another token is being changed (#2714 review). Saving
// the choice alone would not make the draft deployable.
test("the Deploy gate names a missing Slack binding before an unsaved Secret choice", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Missing and unsaved", { ready: true });
  const bot = await fixture.createSecret(namespace.id, "Missing and unsaved bot", "xoxb-gate");
  const secondBot = await fixture.createSecret(namespace.id, "Second bot token", "xoxb-gate-2");
  // Slack names both tokens, but only the bot token is bound.
  const agent = await fixture.createAgent(
    namespace.id,
    "Missing and unsaved",
    nativeValues("channels", {
      harnessId: "codex",
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          channels: {},
        },
      },
    }),
    {
      executionMode: "dedicated",
      secretBindings: { SLACK_BOT_TOKEN: envBinding(bot) },
    },
  );
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 1280, height: 600 } },
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Missing and unsaved" }).waitFor();
  const missing = page.getByText(
    /^Complete these in Credentials before deploying: Slack Secret bindings/,
  );
  await missing.waitFor();
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  assert.equal(await deploy.isDisabled(), true);
  const gate = await missing.textContent();
  // Changing the bound token leaves the app token missing: the gate keeps naming it.
  await selectSecret(page, "Slack bot token", secondBot);
  await waitForInputValue(page.getByLabel("Slack bot token"), secretOptionLabel(secondBot));
  await expectNoText(page, UNSAVED_SECRETS_GATE);
  assert.equal(await page.getByText(gate, { exact: true }).count(), 1);
  assert.equal(await deploy.isDisabled(), true);
});
