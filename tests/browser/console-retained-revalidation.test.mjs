import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { login, nativeValues, newPage } from "./console-agents-browser-helpers.mjs";

test("Returning to a loaded page keeps its header selection and controls steady while access is rechecked", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Steady return", { ready: true });
  await fixture.createAgent(namespace.id, "Steady Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByRole("link", { name: "Steady Agent" }).waitFor();
  const view = page.locator('.content [aria-live="polite"]');
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  const selector = page.locator("#namespace-selector");
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  const create = page.getByRole("button", { name: "Create Agent" });
  assert.equal(await create.isEnabled(), true);

  let releaseSession;
  const sessionHeld = new Promise((resolve) => {
    releaseSession = resolve;
  });
  let sessionRequested;
  const requested = new Promise((resolve) => {
    sessionRequested = resolve;
  });
  await page.route("**/api/auth/session", async (route) => {
    sessionRequested();
    await sessionHeld;
    await route.continue();
  });
  t.after(() => releaseSession());
  // Refocusing the window rechecks the session and Namespace access before the
  // retained Agents view is reused.
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await requested;
  await page.locator('.content [aria-live="polite"][inert]').waitFor();

  // Choices stay hidden and the selector stays disabled until access is confirmed ...
  assert.equal(await selector.isDisabled(), true);
  assert.equal(await selector.locator('option:not([value=""])').count(), 0);
  // ... but it keeps naming the Namespace the view shows instead of flashing a placeholder,
  assert.equal(
    await selector.evaluate((node) => node.selectedOptions[0]?.textContent),
    "Steady return",
  );
  // and the inert view blocks its controls without restyling them as disabled.
  assert.equal(await view.evaluate((node) => node.inert), true);
  assert.equal(await create.isEnabled(), true);
  assert.equal(await page.locator(".content [aria-live] :disabled").count(), 0);

  releaseSession();
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  assert.equal(await selector.locator(`option[value="${namespace.id}"]`).count(), 1);
  assert.equal(await create.isEnabled(), true);
  await create.click();
  await page.waitForURL("**/console/agents/new**");
});
