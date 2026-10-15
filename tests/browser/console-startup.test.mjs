import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { newPage } from "./console-agents-browser-helpers.mjs";

// Holds matching requests until release(); requested resolves when the first one arrives.
async function holdRequests(t, page, pattern) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let markRequested;
  const requested = new Promise((resolve) => {
    markRequested = resolve;
  });
  await page.route(pattern, async (route) => {
    markRequested();
    await held;
    await route.continue().catch(() => {});
  });
  t.after(() => release());
  return { requested, release };
}

const firstContentfulPaint = () =>
  globalThis.performance.getEntriesByName("first-contentful-paint").length > 0;

// On a slow link the console's module graph takes seconds. The shell's static status paints
// before any script runs, so the page is never blank, and it names nothing signed-in. The
// console then takes that status over in place: it never blanks, moves or flashes navigation
// (finding 1444, a regression from removing the static status for chat links).
test("the console shell paints a neutral status before any script runs and keeps it in place", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  const key = "0123456789abcdef0123456789abcdef";
  for (const path of ["/console/agents", "/console/login", `/console/#native-agent=${key}`]) {
    const script = await holdRequests(t, page, "**/console/console.mjs");
    const session = await holdRequests(t, page, "**/api/auth/session");
    await page.goto(`${fixture.origin}${path}`, { waitUntil: "commit" });
    await script.requested;
    const status = page.locator("#app > p.startup[role='status']");
    // Text paints while the entry script is still held, after the loading delay.
    await page.waitForFunction(firstContentfulPaint, null, { timeout: 5_000 });
    await status.getByText("Loading OpenClaw Enterprise…", { exact: true }).waitFor();
    assert.equal(await page.locator("nav, .content, #namespace-selector").count(), 0, path);
    assert.equal(await page.getByLabel("Username").count(), 0, path);
    const box = await status.boundingBox();
    await status.evaluate((node) => {
      node.dataset.staticShell = "kept";
    });

    // The script runs; the session check is still pending. The same node becomes the session
    // status without moving, and no signed-in chrome or sign-in form is drawn before it settles.
    script.release();
    await session.requested;
    await status.getByText("Checking session…", { exact: true }).waitFor();
    assert.equal(await status.getAttribute("data-static-shell"), "kept", path);
    assert.deepEqual(await status.boundingBox(), box, path);
    assert.equal(await page.locator("nav, .content, #namespace-selector").count(), 0, path);
    assert.equal(await page.getByLabel("Username").count(), 0, path);
    session.release();
    await page.getByLabel("Username").waitFor();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

