import type { BrowserContext } from "playwright";

// Playwright turns Chromium request interception on when a page or context gains its first
// route and off when the last one is removed. A request the page sends while interception is
// being turned off is never continued: it stalls without reaching the server until the page
// aborts it. Tests that remove a route while the Console is still loading (for example right
// after releasing a held session check) hit that window. A route that matches no URL keeps
// interception on for the context's lifetime, so later route and unroute calls only change
// which handlers run. Playwright continues unmatched requests itself, without calling back
// into the test process.
const noUrl = /(?!)/;

export async function keepRequestInterceptionEnabled(context: BrowserContext) {
  await context.route(noUrl, (route) => route.fallback());
}
