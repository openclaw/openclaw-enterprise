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
  const lookOf = (node) => {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    return { opacity: style.opacity, color: style.color, background: style.backgroundColor };
  };
  const createLook = await create.evaluate(lookOf);

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
    await route.continue().catch(() => {});
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
  // and the view's controls are blocked (inert and disabled) without being restyled as
  // disabled, so an unchanged page does not dim and brighten on every return.
  assert.equal(await view.evaluate((node) => node.inert), true);
  assert.equal(await create.isDisabled(), true);
  assert.deepEqual(await create.evaluate(lookOf), createLook);

  releaseSession();
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  assert.equal(await selector.locator(`option[value="${namespace.id}"]`).count(), 1);
  assert.equal(await create.isEnabled(), true);
  assert.equal(await create.getAttribute("data-admission-blocked"), null);
  await create.click();
  await page.waitForURL("**/console/agents/new**");
});

test("Back after switching Namespace names the retained page's own Namespace while access is rechecked", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const first = await fixture.createNamespace("First scope", { ready: true });
  const second = await fixture.createNamespace("Second scope", { ready: true });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${first.id}`);
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  const selector = page.locator("#namespace-selector");
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  await selector.selectOption(second.id);
  await page.waitForURL(`**/console/agents?namespace=${second.id}`);
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();

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
    await route.continue().catch(() => {});
  });
  t.after(() => releaseSession());
  await page.goBack();
  await requested;
  await page.locator('.content [aria-live="polite"][inert]').waitFor();
  assert.equal(await page.locator(".content .scope").textContent(), "Namespace · First scope");
  assert.equal(
    await selector.evaluate((node) => node.selectedOptions[0]?.textContent),
    "First scope",
  );
  assert.equal(await selector.locator('option:not([value=""])').count(), 0);

  releaseSession();
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  assert.equal(await selector.inputValue(), first.id);
});
