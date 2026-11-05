import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
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
const trackers = new WeakMap();

function failureDirectory() {
  const value = process.env[browserFailureDirectoryVariable];
  return value === undefined || value.length === 0 ? undefined : value;
}

function keep(list, entry) {
  list.push(entry);
  if (list.length > eventLimit) {
    list.shift();
  }
}

function trackPage(page, startedAt) {
  const elapsed = () => Date.now() - startedAt;
  const tracker = {
    elapsed,
    lastUrl: page.url(),
    navigations: [],
    console: [],
    pageErrors: [],
    requests: [],
    notes: [],
    pending: new Map(),
  };
  function settle(request, outcome, detail) {
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
export function pendingBrowserRequests(page) {
  const tracker = trackers.get(page);
  if (tracker === undefined) {
    return undefined;
  }
  const now = tracker.elapsed();
  return [...tracker.pending.values()].map((entry) => ({ ...entry, ageMs: now - entry.startMs }));
}

/** Formats pendingBrowserRequests for an error message. */
export function describePendingBrowserRequests(page) {
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
export function noteBrowserEvent(page, text) {
  const tracker = trackers.get(page);
  if (tracker !== undefined) {
    keep(tracker.notes, { atMs: tracker.elapsed(), text });
  }
}

function describeError(error, depth = 0) {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (typeof error !== "object") {
    return { message: String(error) };
  }
  return {
    name: error.name,
    code: error.code,
    message: error.message,
    stack: error.stack,
    ...(depth < 3 && error.cause !== undefined
      ? { cause: describeError(error.cause, depth + 1) }
      : {}),
  };
}

function slug(value) {
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
 * $OPENCLAW_CI_BROWSER_FAILURE_DIR. Passing tests write nothing.
 */
export async function watchBrowserContext(t, context) {
  const root = failureDirectory();
  if (root === undefined) {
    return { capture: async () => {} };
  }
  const startedAt = Date.now();
  const pages = [];
  function attach(page) {
    pages.push(page);
    trackPage(page, startedAt);
  }
  context.pages().forEach(attach);
  context.on("page", attach);
  let tracing = false;
  try {
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
      if (captured || t.passed !== false) {
        return;
      }
      captured = true;
      const file = t.filePath ?? process.argv[1] ?? "unknown";
      const testName = t.fullName ?? t.name;
      const directory = join(root, slug(basename(file)), slug(testName));
      const summary = {
        test: testName,
        file,
        capturedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        error: describeError(t.error),
        pages: [],
        captureErrors: [],
      };
      try {
        await mkdir(directory, { recursive: true });
        for (const [index, page] of pages.entries()) {
          const tracker = trackers.get(page);
          const closed = page.isClosed();
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
            const screenshot = `page-${index}.png`;
            try {
              await within(
                page.screenshot({
                  path: join(directory, screenshot),
                  fullPage: true,
                  timeout: screenshotTimeoutMs,
                }),
                "screenshot",
                screenshotTimeoutMs + 1_000,
              );
              entry.screenshot = screenshot;
            } catch (error) {
              summary.captureErrors.push(`page ${index} screenshot: ${error.message}`);
            }
          }
          summary.pages.push(entry);
        }
        if (tracing) {
          try {
            await within(
              context.tracing.stop({ path: join(directory, "trace.zip") }),
              "trace export",
              traceTimeoutMs,
            );
            summary.trace = "trace.zip";
          } catch (error) {
            summary.captureErrors.push(`trace: ${error.message}`);
          }
        }
        await writeFile(join(directory, "failure.json"), `${JSON.stringify(summary, null, 2)}\n`);
      } catch (error) {
        // Diagnostics must never replace the test's own failure.
        process.stderr.write(`browser failure diagnostics failed: ${error.message}\n`);
      }
    },
  };
}
