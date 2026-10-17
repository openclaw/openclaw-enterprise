import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  fileBrowser,
  holdRequests,
  login,
  nativeValues,
  newPage,
} from "./console-agents-browser-helpers.mjs";
import {
  nativeSandboxDriver,
  routeInstallationWithoutProvisioning,
} from "./console-agents-test-support.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

// Create Agent preselects an OpenClaw execution mode the Installation admits, but only one the
// form chose itself (#2670): a mode the reader picked, or one fixed by Anthropic credentials,
// stays as it is and shows its refusal. Each case reads the form before the Installation answers.
// The Sandbox Driver provisions dedicated OpenClaw, so the Installation admits Dedicated only.
test("Create Agent switches only a mode it chose itself when the Installation answers", async (t) => {
  const fixture = await createConsoleAppFixture(t, { sandboxDriver: nativeSandboxDriver() });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Mode defaults", { ready: true });
  const cases = [
    {
      name: "a mode the reader picked is kept",
      async before(page) {
        await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
        await page.locator(".launch-runtime:not([open]) > summary").click();
        await page.getByLabel("Execution mode").selectOption("dedicated");
        await page.getByLabel("Execution mode").selectOption("embedded");
      },
      mode: "embedded",
      alert:
        "Embedded OpenClaw is unavailable: this installation selects a Sandbox Driver, which requires Dedicated execution. Select Dedicated under Runtime details.",
    },
    {
      // Choosing the harness again hands the mode back to the form.
      name: "a picked mode followed by a harness change is the form's again",
      async before(page) {
        await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
        await page.locator(".launch-runtime:not([open]) > summary").click();
        await page.getByLabel("Execution mode").selectOption("dedicated");
        await page.getByLabel("Harness", { exact: true }).selectOption("codex");
        await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
      },
      mode: "dedicated",
    },
    {
      name: "Anthropic keeps Embedded",
      async before(page) {
        await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
        await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
      },
      mode: "embedded",
      alert:
        "Anthropic uses Embedded OpenClaw, which this installation refuses because it selects a Sandbox Driver. Choose OpenAI to use Dedicated execution.",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const { page } = await newPage(t, fixture, { browser });
      const installation = await holdRequests(t, page, `${fixture.origin}/installation`, {
        method: "GET",
      });
      await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
      await page.getByRole("button", { name: "Start without Preset" }).click();
      await installation.requested;
      await scenario.before(page);
      // Before the answer every choice is open and the form keeps Embedded.
      assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
      installation.release();
      await page.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
      assert.equal(await page.getByLabel("Execution mode").inputValue(), scenario.mode);
      const refusals = page.getByRole("alert").filter({ hasText: /OpenClaw/ });
      if (scenario.alert === undefined) {
        assert.equal(await refusals.count(), 0);
      } else {
        assert.equal(await refusals.textContent(), scenario.alert);
        assert.equal(
          await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
          true,
        );
      }
    });
  }
});

// A Preset with operator-managed credentials and no execution mode leaves the mode to the form,
// but those credentials need Embedded OpenClaw, so an Installation that admits only Dedicated
// does not switch it: the form names the Preset instead. The Installation answer is routed: an
// Installation that admits only Dedicated, over the SSH Compute Driver the fixture uses.
test("Operator-managed Preset credentials without a mode keep Embedded when the Installation refuses it", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Runtime Preset default", {
    filesystemConfiguration: true,
  });
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Operator-managed credentials without a mode",
      template: {
        agent: { name: "Runtime Agent", harnessAuth: { method: "runtime" } },
        configuration: { values: nativeValues("runtime-preset-default") },
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture, { browser });
  await routeInstallationWithoutProvisioning(page, fixture, {
    openclaw: { executionModes: ["dedicated"] },
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  const alert = page.getByRole("alert").filter({ hasText: /operator-managed credentials/ });
  await alert.waitFor();
  assert.equal(
    await alert.textContent(),
    "This Preset's operator-managed credentials require Embedded OpenClaw, which this installation refuses because it selects a Sandbox Driver. Ask an administrator, or start without a Preset.",
  );
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
});
