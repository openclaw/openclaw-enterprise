import type { TestContext } from "node:test";
import type { Page, Route } from "playwright";
import { holdRequests, settledView } from "./console-agents-browser-helpers.mjs";

// Coming back to the window rechecks the session and Namespace access and holds the shown view,
// inert, until the recheck finishes. These helpers drive that recheck and tell whether it
// reused the shown view or rebuilt it.

// The content view; only one is shown at a time.
const contentView = '.content [aria-live="polite"]';

// The attribute tagView writes and viewTag and taggedView read.
const TAG = "data-nav-tag";

// The shown view while a refocus recheck holds it.
export const heldView = `${contentView}[inert]`;

/**
 * Refocusing the window rechecks the session and Namespace access.
 */
export const refocus = (page: Page) =>
  page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));

/**
 * Holds the recheck's session read so the held view can be observed, runs `during` while it is
 * held, then lets it finish and waits for the settled view.
 */
export async function refocusHeld(t: TestContext, page: Page, during?: () => Promise<void>) {
  const read = await holdRequests(t, page, "**/api/auth/session", { once: true });
  await refocus(page);
  await read.requested;
  await page.locator(heldView).waitFor();
  await during?.();
  read.release();
  await page.locator(settledView).waitFor();
}

/**
 * Tags the shown view, so a view the page reuses (it keeps the tag) can be told from one it
 * rebuilds (the tag is gone).
 */
export const tagView = (page: Page, tag = "kept") =>
  page.evaluate<void, [string, string, string]>(
    ([selector, attribute, value]) => {
      const view = globalThis.document.querySelector(selector);
      if (view === null) {
        throw new TypeError(`tagView: expected a shown view matching ${selector}`);
      }
      view.setAttribute(attribute, value);
    },
    [contentView, TAG, tag],
  );

/**
 * The shown view's tag, read in one step: null once the view was rebuilt.
 */
export const viewTag = (page: Page): Promise<string | null> =>
  page.evaluate<string | null, [string, string]>(
    ([selector, attribute]) =>
      globalThis.document.querySelector(selector)?.getAttribute(attribute) ?? null,
    [contentView, TAG],
  );

/**
 * The view tagged `tag`, wherever it is (detached once a rebuild replaced it).
 */
export const taggedView = (page: Page, tag = "kept") => page.locator(`[${TAG}="${tag}"]`);

/**
 * The focused control's aria-label, read in one step in the page. A locator resolved before a
 * rebuild names the old, detached control, so checking focus through it races the rebuild
 * (finding 2970).
 */
export const focusedLabel = (page: Page): Promise<string | null> =>
  page.evaluate(() => globalThis.document.activeElement?.getAttribute("aria-label") ?? null);

/**
 * Waits in the page until the focused control's aria-label is `label`.
 */
export const waitForFocusedLabel = (page: Page, label: string | null) =>
  page.waitForFunction(
    (expected) => globalThis.document.activeElement?.getAttribute("aria-label") === expected,
    label,
  );

/**
 * Answers every `method` request to `url` with `answer` (or what `answer()` returns at that
 * moment); other methods fall through to the next route or the server.
 */
export const fulfillMethod = (
  page: Page,
  url: string,
  method: string,
  answer: Parameters<Route["fulfill"]>[0] | (() => Parameters<Route["fulfill"]>[0]),
) =>
  page.route(url, (route) =>
    route.request().method() === method
      ? route.fulfill(typeof answer === "function" ? answer() : answer)
      : route.fallback(),
  );
