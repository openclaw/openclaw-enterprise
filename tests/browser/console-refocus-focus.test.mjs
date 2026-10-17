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
// refocus recheck does not: the list stays inert while we check access, then the reader can
// continue from the same link. Moving to the navigation during the check is a new focus choice.
test("refocusing the Agents list restores its focused link unless the reader moved on", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Refocus focus", { ready: true });
  await fixture.createAgent(namespace.id, "Refocus Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const link = page.locator(settledView).getByRole("link", { name: "Refocus Agent" });
  await link.waitFor();
  const onHeading = () =>
    page.evaluate(
      () => globalThis.document.activeElement === globalThis.document.querySelector(".content h1"),
    );
  const isFocused = (control) =>
    control.evaluate((node) => node === globalThis.document.activeElement);
  const navigation = page.getByRole("link", { name: "Namespaces", exact: true });
  for (const expectedFocus of [link, navigation]) {
    // Let the row reads finish so the held check is the session's, not a deployment's.
    await page.getByText("Reading deployment…").first().waitFor({ state: "detached" });
    await link.focus();
    assert.equal(await isFocused(link), true);
    const read = await holdRequests(t, page, "**/api/auth/session", { once: true });
    await refocus(page);
    await read.requested;
    await page.locator(heldView).waitFor();
    assert.equal(await onHeading(), false, "the held list leaves focus off its heading");
    if (expectedFocus === navigation) {
      await navigation.focus();
    }
    read.release();
    await link.waitFor();
    assert.equal(await isFocused(expectedFocus), true, "keep the reader's place after the check");
  }
});
