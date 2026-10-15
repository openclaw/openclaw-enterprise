import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { detailUrl, login, nativeValues, newPage } from "./console-agents-browser-helpers.mjs";

// Hold matching reads until release(); requested resolves when the first arrives.
async function holdRead(t, page, path = "**/api/auth/session") {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let requestedResolve;
  let timer;
  // Fails instead of hanging the run when the page never starts the read.
  const requested = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`No ${path} read was requested`)), 10_000);
    requestedResolve = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  requested.catch(() => {});
  await page.route(path, async (route) => {
    requestedResolve();
    await held;
    await route.continue().catch(() => {});
  });
  t.after(() => {
    clearTimeout(timer);
    release();
  });
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

  const session = await holdRead(t, page);
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
  const firstRow = "First scope Agent";
  const secondRow = "Second scope Agent";
  await fixture.createAgent(first.id, firstRow, nativeValues("v1"));
  await fixture.createAgent(second.id, secondRow, nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${first.id}`);
  await page.locator(activeView).waitFor();
  const selector = page.locator("#namespace-selector");
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  await page.locator(activeView).getByText(firstRow, { exact: true }).waitFor();
  await selector.selectOption(second.id);
  await page.waitForURL(`**/console/agents?namespace=${second.id}`);
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  await page.locator(activeView).getByText(secondRow, { exact: true }).waitFor();
  const scope = page.locator(".content .scope");
  const heldView = page.locator('.content [aria-live="polite"][inert]');

  const session = await holdRead(t, page);
  const collection = await holdRead(t, page, `**/namespaces/${first.id}/agents`);
  await page.goBack();
  await session.requested;
  await heldView.waitFor();
  // The shown page keeps its scope; the disabled selector already names the destination.
  assert.equal(await scope.textContent(), "Namespace · Second scope");
  assert.equal(
    await selector.evaluate((node) => node.selectedOptions[0]?.textContent),
    "First scope",
  );
  assert.equal(await selector.locator('option:not([value=""])').count(), 0);

  // Admission enables the destination selector before its collection read finishes.
  // Until the rows change, the content's scope must still describe the rows on screen.
  session.release();
  await collection.requested;
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  assert.equal(await selector.inputValue(), first.id);
  await heldView.getByText(secondRow, { exact: true }).waitFor();
  assert.equal(await scope.textContent(), "Namespace · Second scope");
  assert.equal(await heldView.getByText(firstRow, { exact: true }).count(), 0);

  collection.release();
  const visibleView = page.locator(activeView);
  await visibleView.getByText(firstRow, { exact: true }).waitFor();
  assert.equal(await scope.textContent(), "Namespace · First scope");
  assert.equal(await visibleView.getByText(secondRow, { exact: true }).count(), 0);
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

test("Back during an Agent refocus check keeps the held page inert until the return is admitted", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Interrupted check", { ready: true });
  await fixture.createAgent(namespace.id, "Interrupted Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.locator(activeView).getByRole("link", { name: "Interrupted Agent" }).waitFor();
  await page.getByRole("link", { name: "Interrupted Agent" }).click();
  await page.getByRole("region", { name: "Agent state at a glance" }).waitFor();
  // Only a finished detail rechecks in place on refocus.
  await page.locator('.content [aria-live="polite"][aria-busy="false"]:not([inert])').waitFor();

  const session = await holdRead(t, page);
  // Refocusing Agent detail rechecks access in place; Back cuts that check short.
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await session.requested;
  await page.goBack();
  await page.waitForURL(`**/console/agents?namespace=${namespace.id}`);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve));
      }),
  );
  assert.equal(await page.locator('.content [aria-live="polite"][inert]').count(), 1);
  assert.equal(await page.locator(activeView).count(), 0);

  session.release();
  await page.locator(activeView).getByRole("link", { name: "Interrupted Agent" }).waitFor();
});
