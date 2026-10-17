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

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';
const heldView = '.content [aria-live="polite"][inert]';
// Refocusing the window rechecks the session and Namespace access.
const refocus = (page) => page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));

// A navigation that holds the shown page keeps focus on its heading (findings 1626, 1636), but a
// refocus recheck does not: switching back to the tab must not send the reader to the heading
// (#2712 review). The held page stays inert until the session check answers.
test("a refocus recheck of the Agents list does not move focus to its heading", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Refocus focus", { ready: true });
  await fixture.createAgent(namespace.id, "Refocus Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const link = page.locator(settledView).getByRole("link", { name: "Refocus Agent" });
  await link.waitFor();
  // The rows' deployment reads finish first, so the held check is the session's.
  await page.getByText("Reading deployment…").first().waitFor({ state: "detached" });
  await link.focus();
  const onHeading = () =>
    page.evaluate(
      () => globalThis.document.activeElement === globalThis.document.querySelector(".content h1"),
    );
  const read = await holdRequests(t, page, "**/api/auth/session", { once: true });
  await refocus(page);
  await read.requested;
  await page.locator(heldView).waitFor();
  assert.equal(await onHeading(), false, "the held list leaves focus off its heading");
  read.release();
  await page.locator(settledView).waitFor();
  assert.equal(await onHeading(), false, "the remounted list leaves focus off its heading");
});
