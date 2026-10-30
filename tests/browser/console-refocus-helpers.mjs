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
 *
 * @param {import("playwright").Page} page
 */
export const refocus = (page) => page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));

/**
 * Holds the recheck's session read so the held view can be observed, runs `during` while it is
 * held, then lets it finish and waits for the settled view.
 *
 * @param {import("node:test").TestContext} t
 * @param {import("playwright").Page} page
 * @param {() => Promise<void>} [during]
 */
export async function refocusHeld(t, page, during) {
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
 *
 * @param {import("playwright").Page} page
 * @param {string} [tag]
 */
export const tagView = (page, tag = "kept") =>
  page.evaluate(
    ([selector, attribute, value]) => {
      globalThis.document.querySelector(selector).setAttribute(attribute, value);
    },
    [contentView, TAG, tag],
  );

/**
 * The shown view's tag, read in one step: null once the view was rebuilt.
 *
 * @param {import("playwright").Page} page
 * @returns {Promise<string | null>}
 */
export const viewTag = (page) =>
  page.evaluate(
    ([selector, attribute]) =>
      globalThis.document.querySelector(selector)?.getAttribute(attribute) ?? null,
    [contentView, TAG],
  );

/**
 * The view tagged `tag`, wherever it is (detached once a rebuild replaced it).
 *
 * @param {import("playwright").Page} page
 * @param {string} [tag]
 */
export const taggedView = (page, tag = "kept") => page.locator(`[${TAG}="${tag}"]`);

/**
 * The focused control's aria-label, read in one step in the page. A locator resolved before a
 * rebuild names the old, detached control, so checking focus through it races the rebuild
 * (finding 2970).
 *
 * @param {import("playwright").Page} page
 * @returns {Promise<string | null>}
 */
export const focusedLabel = (page) =>
  page.evaluate(() => globalThis.document.activeElement?.getAttribute("aria-label") ?? null);

/**
 * Waits in the page until the focused control's aria-label is `label`.
 *
 * @param {import("playwright").Page} page
 * @param {string | null} label
 */
export const waitForFocusedLabel = (page, label) =>
  page.waitForFunction(
    (expected) => globalThis.document.activeElement?.getAttribute("aria-label") === expected,
    label,
  );

/**
 * Answers every `method` request to `url` with `answer` (or what `answer()` returns at that
 * moment); other methods fall through to the next route or the server.
 *
 * @param {import("playwright").Page} page
 * @param {string} url
 * @param {string} method
 * @param {Parameters<import("playwright").Route["fulfill"]>[0] | (() => Parameters<import("playwright").Route["fulfill"]>[0])} answer
 */
export const fulfillMethod = (page, url, method, answer) =>
  page.route(url, (route) =>
    route.request().method() === method
      ? route.fulfill(typeof answer === "function" ? answer() : answer)
      : route.fallback(),
  );
