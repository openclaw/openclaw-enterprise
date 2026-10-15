import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { detailUrl, login, nativeValues, newPage } from "./console-agents-browser-helpers.mjs";

// Holds the next session reads until release(); requested resolves when the first arrives.
async function holdSession(t, page) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let requestedResolve;
  const requested = new Promise((resolve) => {
    requestedResolve = resolve;
  });
  await page.route("**/api/auth/session", async (route) => {
    requestedResolve();
    await held;
    await route.continue().catch(() => {});
  });
  t.after(() => release());
  return { requested, release };
}

const activeView = '.content [aria-live="polite"]:not([inert])';

test("Refocusing a loaded page keeps it steady while access is rechecked", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Steady return", { ready: true });
  await fixture.createAgent(namespace.id, "Steady Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByRole("link", { name: "Steady Agent" }).waitFor();
  await page.locator(activeView).waitFor();
  const selector = page.locator("#namespace-selector");
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  const create = page.getByRole("button", { name: "Create Agent" });
  const lookOf = (node) => {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    return { opacity: style.opacity, color: style.color, background: style.backgroundColor };
  };
  const createLook = await create.evaluate(lookOf);

  const session = await holdSession(t, page);
  // Refocusing the window rechecks the session and Namespace access before the page is reused.
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await session.requested;
  await page.locator('.content [aria-live="polite"][inert]').waitFor();
  // The selector hides its choices until access is confirmed, but keeps naming the Namespace
  // instead of flashing a placeholder, and the inert page keeps its look.
  assert.equal(await selector.isDisabled(), true);
  assert.equal(await selector.locator('option:not([value=""])').count(), 0);
  assert.equal(
    await selector.evaluate((node) => node.selectedOptions[0]?.textContent),
    "Steady return",
  );
  assert.deepEqual(await create.evaluate(lookOf), createLook);

  session.release();
  await page.locator(activeView).waitFor();
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  assert.equal(await selector.locator(`option[value="${namespace.id}"]`).count(), 1);
  await create.click();
  await page.waitForURL("**/console/agents/new**");
});

test("Back after switching Namespace keeps the shown page until the return is admitted", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const first = await fixture.createNamespace("First scope", { ready: true });
  const second = await fixture.createNamespace("Second scope", { ready: true });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${first.id}`);
  await page.locator(activeView).waitFor();
  const selector = page.locator("#namespace-selector");
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  await selector.selectOption(second.id);
  await page.waitForURL(`**/console/agents?namespace=${second.id}`);
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  await page.locator(activeView).waitFor();

  const session = await holdSession(t, page);
  await page.goBack();
  await session.requested;
  await page.locator('.content [aria-live="polite"][inert]').waitFor();
  // The shown page keeps its scope; the disabled selector already names the destination.
  assert.equal(await page.locator(".content .scope").textContent(), "Namespace · Second scope");
  assert.equal(
    await selector.evaluate((node) => node.selectedOptions[0]?.textContent),
    "First scope",
  );
  assert.equal(await selector.locator('option:not([value=""])').count(), 0);

  session.release();
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  assert.equal(await selector.inputValue(), first.id);
  assert.equal(await page.locator(".content .scope").textContent(), "Namespace · First scope");
});

test("Back to a retained Agent page after access was revoked never shows the cached page", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revoked scope", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Revoked Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  await summary.waitFor();
  await page.locator(activeView).waitFor();
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("link", { name: "Revoked Agent" }).waitFor();
  await page.locator(activeView).waitFor();

  fixture.policy.restrictions.push({
    id: "revoke-retained-agent-namespace",
    namespaceId: namespace.id,
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
  // Record every DOM state and painted frame from Back until the refusal.
  await page.evaluate((configurationId) => {
    const seen = [];
    globalThis.__cachedAgentSeen = seen;
    const check = (when) => {
      const document = globalThis.document;
      if (
        document.querySelector(".agent-current-summary, .deployment-status, .agent-tabs") ||
        document.body.textContent.includes(configurationId)
      ) {
        seen.push(when);
      }
    };
    new globalThis.MutationObserver(() => check("mutation")).observe(globalThis.document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    const frame = () => {
      check("frame");
      globalThis.requestAnimationFrame(frame);
    };
    globalThis.requestAnimationFrame(frame);
  }, agent.configurationId);
  await page.goBack();
  await page.getByRole("heading", { name: "Namespace unavailable" }).waitFor();
  await page.locator(activeView).waitFor();
  assert.deepEqual(
    await page.evaluate(() => globalThis.__cachedAgentSeen.slice(0, 5)),
    [],
    "the retained Agent page was painted or mounted after its access was revoked",
  );
  assert.equal(await page.locator(".agent-current-summary").count(), 0);
});
