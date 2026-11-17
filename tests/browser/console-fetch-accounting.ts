import assert from "node:assert/strict";

import type { Page } from "playwright";

declare global {
  var settledFetchCount: ((path: string) => number) | undefined;
  var inFlightFetchCount: ((except?: string) => number) | undefined;
}

// Test-only page hook: counts, per URL path, the page's fetches that have settled, meaning the
// fetch rejected or the first wrapped body read finished (including rejection). It also
// counts fetches still in flight, in all and per path; for that count a response without a
// body ends its fetch at once. Install it before the page loads. A count observed by
// waitForSettledFetches() or waitForIdleFetches() is read in a later task, so the page's own
// continuation of that fetch (for example dropping a stale response, or finishing the view's
// read bookkeeping) has already run.
export async function trackSettledFetches(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const settled = new Map<string, number>();
    const pending = new Map<string, number>();
    let inFlight = 0;
    const pathOf = (input: RequestInfo | URL): string =>
      new URL(input instanceof Request ? input.url : String(input), globalThis.location.href)
        .pathname;
    const pageFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const path = pathOf(input);
      inFlight += 1;
      pending.set(path, (pending.get(path) ?? 0) + 1);
      let open = true;
      const finish = () => {
        if (open) {
          open = false;
          inFlight -= 1;
          pending.set(path, (pending.get(path) ?? 0) - 1);
        }
      };
      const record = () => {
        settled.set(path, (settled.get(path) ?? 0) + 1);
        finish();
      };
      let response: Response;
      try {
        response = await pageFetch(input, init);
      } catch (error) {
        record();
        throw error;
      }
      if (response.body === null) {
        finish();
      }
      let readClaimed = false;
      const wrapReader =
        <T>(read: () => Promise<T>): (() => Promise<T>) =>
        async () => {
          // Claim before awaiting: a second read can reject while the first is pending.
          const firstRead = !readClaimed;
          readClaimed = true;
          try {
            return await read();
          } finally {
            if (firstRead) {
              record();
            }
          }
        };
      response.arrayBuffer = wrapReader(response.arrayBuffer.bind(response));
      response.blob = wrapReader(response.blob.bind(response));
      response.json = wrapReader(response.json.bind(response));
      response.text = wrapReader(response.text.bind(response));
      return response;
    };
    globalThis.settledFetchCount = (path) => settled.get(path) ?? 0;
    // With `except`, fetches to that path (one a test holds, say) are not counted.
    globalThis.inFlightFetchCount = (except) =>
      inFlight - (except === undefined ? 0 : (pending.get(except) ?? 0));
  });
}

export async function settledFetches(page: Page, path: string): Promise<number> {
  const count: unknown = await page.evaluate((target) => {
    if (typeof globalThis.settledFetchCount !== "function") {
      throw new Error(
        "Missing fetch accounting setup: call trackSettledFetches before loading the page",
      );
    }
    return globalThis.settledFetchCount(target);
  }, path);
  assert.ok(typeof count === "number", "Settled fetch instrumentation returns a numeric count");
  return count;
}

export async function waitForSettledFetches(
  page: Page,
  path: string,
  count: number,
): Promise<void> {
  await page.waitForFunction<boolean, [string, number]>(
    ([target, expected]) => {
      if (typeof globalThis.settledFetchCount !== "function") {
        throw new Error(
          "Missing fetch accounting setup: call trackSettledFetches before loading the page",
        );
      }
      return globalThis.settledFetchCount(target) >= expected;
    },
    [path, count],
  );
}

// Waits until no fetch the page has started is still in flight (see trackSettledFetches). The
// console retains a view, or an Agent tab, for a later return only if none of its reads were
// still pending when the reader left it; otherwise the return rebuilds it. Call this before
// leaving a view whose DOM a test later expects to be reused. It checks one moment: a read the
// page starts later (after a timer) is not covered, so wait for the view's content first. With
// `except`, fetches to that URL path (a read the test holds) do not count.
export async function waitForIdleFetches(
  page: Page,
  { except }: { except?: string | undefined } = {},
): Promise<void> {
  await page.waitForFunction((path) => {
    if (typeof globalThis.inFlightFetchCount !== "function") {
      throw new Error(
        "Missing fetch accounting setup: call trackSettledFetches before loading the page",
      );
    }
    return globalThis.inFlightFetchCount(path) === 0;
  }, except);
}
