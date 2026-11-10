import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TestContext } from "node:test";
import type { BrowserContext, Page, Request } from "playwright";
import { within } from "./wait-for.mjs";

// CI sets this only for lanes whose browser tests use disposable fixtures. When
// it is unset, nothing is tracked.
export const browserFailureDirectoryVariable = "OPENCLAW_CI_BROWSER_FAILURE_DIR";
// Opt-in Playwright tracing for local investigation. CI leaves it off: tracing
// slows the page enough to make timing-sensitive console tests fail far more
// often (known Namespace revocation: 6/12 local runs with a full trace, 2/12
// without snapshots, 0/12 with event tracking only).
export const browserFailureTraceVariable = "OPENCLAW_CI_BROWSER_FAILURE_TRACE";

const eventLimit = 500;
const screenshotTimeoutMs = 5_000;
const traceTimeoutMs = 20_000;
type PendingRequest = {
  startMs: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
};

type PageTracker = {
  elapsed: () => number;
  lastUrl: string;
  navigations: { atMs: number; url: string }[];
  console: { atMs: number; type: string; text: string }[];
  pageErrors: { atMs: number; message: string; stack: string | undefined }[];
  requests: (PendingRequest & {
    outcome: "finished" | "failed";
    detail?: string;
    endMs: number;
  })[];
  notes: { atMs: number; text: string }[];
  pending: Map<Request, PendingRequest>;
};

const trackers = new WeakMap<Page, PageTracker>();

function failureDirectory() {
  const value = process.env[browserFailureDirectoryVariable];
  return value === undefined || value.length === 0 ? undefined : value;
}

function keep<T>(list: T[], entry: T) {
  list.push(entry);
  if (list.length > eventLimit) {
    list.shift();
  }
}

function trackPage(page: Page, startedAt: number) {
  const elapsed = () => Date.now() - startedAt;
  const tracker: PageTracker = {
    elapsed,
    lastUrl: page.url(),
    navigations: [],
    console: [],
    pageErrors: [],
    requests: [],
    notes: [],
    pending: new Map<Request, PendingRequest>(),
  };
  function settle(request: Request, outcome: "finished" | "failed", detail?: string) {
    const entry = tracker.pending.get(request);
    if (entry === undefined) {
      return;
    }
    tracker.pending.delete(request);
    keep(tracker.requests, {
      ...entry,
      outcome,
      ...(detail === undefined ? {} : { detail }),
      endMs: elapsed(),
    });
  }
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      tracker.lastUrl = frame.url();
      keep(tracker.navigations, { atMs: elapsed(), url: frame.url() });
    }
  });
  page.on("console", (message) => {
    keep(tracker.console, { atMs: elapsed(), type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => {
    keep(tracker.pageErrors, { atMs: elapsed(), message: error.message, stack: error.stack });
  });
  page.on("request", (request) => {
    tracker.pending.set(request, {
      startMs: elapsed(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
    });
  });
  page.on("response", (response) => {
    const entry = tracker.pending.get(response.request());
    if (entry !== undefined) {
      entry.status = response.status();
    }
  });
  page.on("requestfinished", (request) => settle(request, "finished"));
  page.on("requestfailed", (request) => settle(request, "failed", request.failure()?.errorText));
  trackers.set(page, tracker);
}

/**
 * Requests the page has sent that have not finished or failed yet, oldest
 * first. Returns undefined when failure diagnostics are disabled.
 */
export function pendingBrowserRequests(page: Page) {
  const tracker = trackers.get(page);
  if (tracker === undefined) {
    return undefined;
  }
  const now = tracker.elapsed();
  return [...tracker.pending.values()].map((entry) => ({ ...entry, ageMs: now - entry.startMs }));
}

/** Formats pendingBrowserRequests for an error message. */
export function describePendingBrowserRequests(page: Page) {
  const pending = pendingBrowserRequests(page);
  if (pending === undefined) {
    return `not tracked (set ${browserFailureDirectoryVariable})`;
  }
  if (pending.length === 0) {
    return "none";
  }
  return pending
    .map((entry) => {
      const url = new URL(entry.url);
      const status = entry.status === undefined ? "" : ` status ${entry.status}`;
      return `${entry.method} ${url.pathname}${url.search}${status} (${entry.ageMs}ms)`;
    })
    .join(", ");
}

/** Adds a line to the page's failure timeline; a no-op when diagnostics are disabled. */
export function noteBrowserEvent(page: Page, text: string) {
  const tracker = trackers.get(page);
  if (tracker !== undefined) {
    keep(tracker.notes, { atMs: tracker.elapsed(), text });
  }
}

type ErrorDescription = {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  stack?: unknown;
  cause?: ErrorDescription | undefined;
};

function describeError(error: unknown, depth = 0): ErrorDescription | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (typeof error !== "object") {
    return { message: String(error) };
  }
  return {
    name: "name" in error ? error.name : undefined,
    code: "code" in error ? error.code : undefined,
    message: "message" in error ? error.message : undefined,
    stack: "stack" in error ? error.stack : undefined,
    ...(depth < 3 && "cause" in error && error.cause !== undefined
      ? { cause: describeError(error.cause, depth + 1) }
      : {}),
  };
}

function slug(value: string) {
  const text = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${text}-${hash}`;
}

/**
 * Records console, network and navigation events (and, when opted in, a
 * Playwright trace) for one test's browser context. Call capture() from
 * cleanup before the context closes: only when the test failed, it writes a
 * screenshot per open page, failure.json and any trace into
 * $OPENCLAW_CI_BROWSER_FAILURE_DIR/<file>/<test>/context-<unique>/.
 * Each failing context atomically allocates its own directory under the existing
 * file/test prefix, so overlapping captures cannot overwrite one another.
 * Passing tests allocate no directory and write nothing.
 */
export async function watchBrowserContext(t: TestContext, context: BrowserContext) {
  const root = failureDirectory();
  if (root === undefined) {
    return { capture: async () => {} };
  }
  const startedAt = Date.now();
  const pages: Page[] = [];
  function attach(page: Page) {
    try {
      trackPage(page, startedAt);
      pages.push(page);
    } catch {
      // A page can close while diagnostics attach; preserve the test outcome.
    }
  }
  let tracing = false;
  try {
    context.pages().forEach(attach);
    context.on("page", attach);
    if (process.env[browserFailureTraceVariable] === "1") {
      await context.tracing.start({ screenshots: true, snapshots: true, title: t.name });
      tracing = true;
    }
  } catch {
    // Diagnostics must never fail the test; failure.json still records events.
  }

  let captured = false;
  return {
    async capture() {
      try {
        if (captured || t.passed !== false) {
          return;
        }
        captured = true;
        const file = t.filePath ?? process.argv[1] ?? "unknown";
        const testName = t.fullName ?? t.name;
        const testDirectory = join(root, slug(basename(file)), slug(testName));
        const capturedAt = new Date().toISOString();
        const elapsedMs = Date.now() - startedAt;
        const error = describeError(t.error);
        const pageEntries = [];
        const captureErrors: string[] = [];
        let trace: string | undefined;
        await mkdir(testDirectory, { recursive: true });
        const directory = await mkdtemp(join(testDirectory, "context-"));
        for (const [index, page] of pages.entries()) {
          const tracker = trackers.get(page);
          if (tracker === undefined) {
            continue;
          }
          const closed = page.isClosed();
          let screenshot: string | undefined;
          const entry = {
            index,
            url: closed ? tracker.lastUrl : page.url(),
            closed,
            pendingRequests: pendingBrowserRequests(page),
            notes: tracker.notes,
            navigations: tracker.navigations,
            pageErrors: tracker.pageErrors,
            console: tracker.console,
            requests: tracker.requests,
          };
          if (!closed) {
            const screenshotName = `page-${index}.png`;
            try {
              await within(
                page.screenshot({
                  path: join(directory, screenshotName),
                  fullPage: true,
                  timeout: screenshotTimeoutMs,
                }),
                "screenshot",
                screenshotTimeoutMs + 1_000,
              );
              screenshot = screenshotName;
            } catch (error) {
              captureErrors.push(
                `page ${index} screenshot: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          pageEntries.push({ ...entry, screenshot });
        }
        if (tracing) {
          try {
            await within(
              context.tracing.stop({ path: join(directory, "trace.zip") }),
              "trace export",
              traceTimeoutMs,
            );
            trace = "trace.zip";
          } catch (error) {
            captureErrors.push(`trace: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const summary = {
          test: testName,
          file,
          capturedAt,
          elapsedMs,
          error,
          pages: pageEntries,
          captureErrors,
          trace,
        };
        await writeFile(join(directory, "failure.json"), `${JSON.stringify(summary, null, 2)}\n`);
      } catch (error) {
        // Diagnostics must never replace the test's own failure.
        try {
          process.stderr.write(
            `browser failure diagnostics failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        } catch {
          // Even reporting a diagnostic error must not replace the test failure.
        }
      }
    },
  };
}
