/// <reference lib="es2024.collection" />
/// <reference lib="es2024.promise" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page, Route } from "playwright";

import type { AgentWire, NamespaceWire } from "../../packages/contracts/src/api/resources.ts";
import type {
  AgentRuntimeEvent,
  AgentRuntimeLogChunk,
  ComputeDriver,
  Permission,
  PermissionAction,
  SandboxLogLine,
} from "../../packages/contracts/src/index.ts";
import { createConsoleAppFixture, fileConsoleApp } from "../helpers/console-app.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";
import {
  createProviderSandboxDriver,
  createRuntimeLogComputeDriver,
} from "../helpers/runtime-logs.mjs";
import {
  apiRequests,
  detailUrl,
  fileBrowser,
  holdRequests,
  login,
  nativeValues,
  newPage,
  settlePageRequests,
  trackSettledFetches,
  waitForCondition,
  waitForEnabled,
  waitForIdleFetches,
} from "./console-agents-browser-helpers.mjs";

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type LogLine = AgentRuntimeLogChunk["lines"][number];
type LogsView = typeof import("../../apps/controller/src/console/agents/logs-view.mts");
type FixtureRole = { permissions: Permission[] };
type LogTestWindow = typeof globalThis & {
  shownScroll: number[];
  inFlightFetchCount(): number;
};

// The JavaScript Compute fixture adds these test controls to its ready Driver.
type LogTestDriver = ReturnType<typeof createRuntimeLogComputeDriver> & {
  state: {
    lines: LogLine[];
    previousLines: LogLine[];
    harnessLines: LogLine[];
    harnessPod: { ready: boolean; stale?: boolean } | { created: false } | undefined;
    events: AgentRuntimeEvent[];
    extraPods: { name: string; uid: string }[];
    restartCount: number;
    observedAt?: string;
    readPodUid?: string;
    describeError: Error | undefined;
    readError: Error | undefined;
  };
  calls: { operation: string; revisionId?: string }[];
  podName(revision: { id: string }): string;
  runtimeLogging?: ComputeDriver["runtimeLogging"];
};

// The console runs against the production controller app, IAM, cursor signing and
// sanitizer. The Compute Driver serves in-memory Pod state in place of a cluster.
// The tests share one app (fileConsoleApp) and its Compute Driver: each test gets its own
// Namespace, Agent and revision, and starts and ends with the Driver's Pod state, calls and
// properties as they were when it was made. The Driver's methods hold its `state` and `calls`, so
// tests change those in place and never replace them.
const computeDriver = createRuntimeLogComputeDriver() as LogTestDriver;
const initialDriver = { ...computeDriver, state: structuredClone(computeDriver.state) };
const logsApp = fileConsoleApp({
  computeDriver,
  agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
});
let logsNamespaces = 0;

function resetComputeDriver() {
  for (const key of Object.keys(computeDriver)) {
    if (!Object.hasOwn(initialDriver, key)) {
      Reflect.deleteProperty(computeDriver, key);
    }
  }
  Object.assign(computeDriver, initialDriver, { state: computeDriver.state });
  for (const key of Object.keys(computeDriver.state)) {
    Reflect.deleteProperty(computeDriver.state, key);
  }
  Object.assign(computeDriver.state, structuredClone(initialDriver.state));
  computeDriver.calls.length = 0;
}

async function logsFixture(t: TestContext) {
  const fixture: ConsoleFixture = await logsApp(t);
  resetComputeDriver();
  t.after(resetComputeDriver);
  logsNamespaces += 1;
  const namespace = await fixture.createNamespace(`Runtime logs ${logsNamespaces}`, {
    ready: true,
  });
  const agent = await fixture.createAgent(namespace.id, "Logs Agent", nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  return { fixture, computeDriver, namespace, agent, revisionId: active.revision.id };
}

function line(second: number, raw: string) {
  return { time: `2026-09-30T12:00:${String(second).padStart(2, "0")}.000000001Z`, raw };
}

// Enough earlier output that the pane scrolls.
function earlierOutput(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    time: `2026-09-30T11:59:00.${String(index + 1).padStart(9, "0")}Z`,
    raw: `earlier output ${index + 1}`,
  }));
}

// A recorded deployment result, which keeps the Agent view cacheable for Back.
function succeededDeployment(namespace: NamespaceWire, agent: AgentWire, revisionId: string) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: {
        deploymentId: revisionId,
        namespaceId: namespace.id,
        agentId: agent.id,
        status: "succeeded",
        error: null,
        warnings: [],
        progress: null,
      },
      meta: { requestId: "req_logs_deployment" },
    }),
  };
}

// The locale cases open one context each in a single Chromium instead of launching ten.
const browser = fileBrowser();

const atBottom = (node: Element) => node.scrollTop + node.clientHeight >= node.scrollHeight - 24;

function logRequests(requests: ReturnType<typeof apiRequests>, revisionId: string) {
  return requests.filter(({ path }) => path.includes(`/deployments/${revisionId}/runtime/logs`));
}

test("a failed deployment's Logs link opens its version in view without reloading", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  const failed = await fixture.deployAgent(namespace.id, agent.id);
  computeDriver.state.lines = [line(1, "startup failed before activation")];
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 1440, height: 900 } },
  });
  // Simulate a recorded startup failure; navigation and runtime-log reads use the real app.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${failed.id}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            deploymentId: failed.id,
            namespaceId: namespace.id,
            agentId: agent.id,
            status: "failed",
            error: { code: "DEPENDENCY_UNAVAILABLE", message: "Deployment reconciliation failed." },
            warnings: [],
            progress: null,
          },
          meta: { requestId: "req_test_logs_navigation" },
        }),
      }),
  );

  // Draft and current-version views must both open the failed version; its own
  // Configuration view switches tabs without replacing the document either.
  for (const [index, selected] of ["draft", revisionId, failed.id].entries()) {
    const url = detailUrl(fixture, namespace.id, agent.id, selected, "configuration");
    if (index === 0) {
      await login(page, fixture, url);
    } else {
      await page.goto(url.href);
    }
    const link = page.getByRole("link", { name: "Open v2 Logs" });
    await link.waitFor();
    await page.evaluate(() => {
      globalThis.document.documentElement.dataset.logsNavigationMarker = "true";
    });
    await link.click();
    await page.waitForURL(
      (url) =>
        url.searchParams.get("revision") === failed.id && url.searchParams.get("tab") === "logs",
    );
    const pane = page.getByRole("log", { name: "Runtime log output" });
    await pane.getByText("startup failed before activation").waitFor();
    assert.equal(
      await page.evaluate(() => globalThis.document.documentElement.dataset.logsNavigationMarker),
      "true",
    );
    await page.waitForFunction(() => {
      const tab = globalThis.document.querySelector('.agent-tabs button[aria-selected="true"]');
      const panel = globalThis.document.querySelector(".agent-logs");
      if (!tab || !panel) {
        return false;
      }
      const bounds = panel.getBoundingClientRect();
      return (
        tab.textContent === "Logs" &&
        globalThis.document.activeElement === tab &&
        bounds.top >= 0 &&
        bounds.top < globalThis.innerHeight
      );
    });
    assert.ok(
      computeDriver.calls.some(
        ({ operation, revisionId }) => operation === "read" && revisionId === failed.id,
      ),
    );
  }
});

// Clicking the Logs tab scrolled the page 357 px (307 px at 390x844) up to a second later,
// moving the strip the reader had just used (finding 1518).
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`the Logs tab opens under the strip it was clicked in at ${viewport.width}x${viewport.height}`, async (t) => {
    const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
    computeDriver.state.lines = [line(1, "tab click output")];
    const { page } = await newPage(t, fixture, { context: { viewport } });
    await trackSettledFetches(page);
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, revisionId, "configuration"),
    );
    await page.getByRole("heading", { name: "Configuration snapshot", exact: true }).waitFor();
    await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
    // The overview shows after at most 2 s even if its deployment read is still out; when that
    // read lands it grows the status above the strip. Measure the strip once the reads are in.
    await waitForIdleFetches(page);
    const logsTab = page.getByRole("tab", { name: "Logs", exact: true });
    // The strip sits in the middle of the viewport, as after reading the overview.
    await page.evaluate(() => {
      const strip = globalThis.document.querySelector(".agent-tabs")!.getBoundingClientRect();
      globalThis.scrollBy(0, strip.top - globalThis.innerHeight / 2);
    });
    const before = await page.evaluate(() => ({
      scrollY: globalThis.scrollY,
      strip: globalThis.document.querySelector(".agent-tabs")!.getBoundingClientRect().top,
    }));
    assert.ok(before.scrollY > 0, "the page scrolled to put the strip mid-viewport");
    await logsTab.click();
    await page
      .getByRole("log", { name: "Runtime log output" })
      .getByText("tab click output")
      .waitFor();
    // The scroll came after the Logs view's first reads and two more frames; wait past them.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    const after = await page.evaluate(() => ({
      scrollY: globalThis.scrollY,
      strip: globalThis.document.querySelector(".agent-tabs")!.getBoundingClientRect().top,
    }));
    assert.ok(
      Math.abs(after.strip - before.strip) <= 1,
      `the tab strip moved from ${before.strip} to ${after.strip} (scroll ${before.scrollY} -> ${after.scrollY})`,
    );
    assert.equal(
      await logsTab.evaluate((node) => node === globalThis.document.activeElement),
      true,
    );
  });
}

test("phone-width routes, resizing and history keep the selected Agent tab visible", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [line(1, "phone-width output")];
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 390, height: 844 } },
  });
  await trackSettledFetches(page);
  // Simulate a terminal deployment record so Back can retain the whole mounted view.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revisionId}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            deploymentId: revisionId,
            namespaceId: namespace.id,
            agentId: agent.id,
            status: "succeeded",
            error: null,
            warnings: [],
            progress: null,
          },
          meta: { requestId: "req_tabs_back" },
        }),
      }),
  );
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url);
  await page
    .getByRole("log", { name: "Runtime log output" })
    .getByText("phone-width output")
    .waitFor();

  // An emulated resize applies without waiting for a frame, so script can lay the page out at a
  // size that never renders. A visibility check at 1440 px forces a layout at that width, where
  // every tab fits, which clamps the strip's scroll to 0. A 390 px resize applied before the next
  // frame then leaves the strip's ResizeObserver, which reveals the selected tab, nothing to
  // report: the strip's width at 390 px is the last size it reported (finding 1727). A browser
  // window's resize reaches the page with a rendered frame, so each resize here waits for the
  // frame in which the console's observer sees the new width.
  async function resize(width: number, height: number) {
    await page.setViewportSize({ width, height });
    const rendered = await page.evaluate(
      () =>
        new Promise((resolve) => {
          // Observers report in creation order, so in the same frame this one reports after the
          // console's.
          const observer = new globalThis.ResizeObserver(() => {
            observer.disconnect();
            resolve(globalThis.innerWidth);
          });
          observer.observe(globalThis.document.querySelector(".agent-tabs")!);
        }),
    );
    assert.equal(rendered, width);
  }

  async function assertSelectedTabVisible(name: string) {
    const selected = page.locator('.agent-tabs button[aria-selected="true"]');
    assert.equal(await selected.textContent(), name);
    await page.waitForFunction(() => {
      const button = globalThis.document.querySelector('.agent-tabs button[aria-selected="true"]');
      if (!button) {
        throw new Error("Missing selected Agent tab");
      }
      const strip = button.closest(".agent-tabs")!.getBoundingClientRect();
      const bounds = button.getBoundingClientRect();
      // Scroll extents are integer CSS pixels; DOMRects retain subpixels.
      // Keep the visibility check strict beyond that rounding uncertainty.
      return bounds.left >= strip.left - 1 && bounds.right <= strip.right + 1;
    });
  }

  // A direct route has no pointer action to scroll its off-screen selected tab.
  await assertSelectedTabVisible("Logs");
  const output = await page.getByRole("log", { name: "Runtime log output" }).elementHandle();
  await resize(1440, 900);
  await assertSelectedTabVisible("Logs");
  // Resizing the mounted view must also reveal the selection without recreating its panel.
  await resize(390, 844);
  await assertSelectedTabVisible("Logs");
  assert.equal(await output.evaluate((node) => node.isConnected), true);
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByText("View admitted native configuration", { exact: true }).click();
  await waitForIdleFetches(page);
  const disclosure = await page.locator(".native-document").elementHandle();

  // Browser history also selects tabs without scrolling them through a click.
  await page.goBack();
  await page
    .getByRole("log", { name: "Runtime log output" })
    .getByText("phone-width output")
    .waitFor();
  await assertSelectedTabVisible("Logs");
  await page.goForward();
  await page.getByRole("heading", { name: "Configuration snapshot", exact: true }).waitFor();
  await assertSelectedTabVisible("Configuration");
  assert.equal(
    await disclosure.evaluate(
      (node) => node.isConnected && node instanceof HTMLDetailsElement && node.open,
    ),
    true,
  );

  // A whole view retained for Back must resume observing after its tab strip was detached.
  await page.goBack();
  await page.getByRole("log", { name: "Runtime log output" }).waitFor();
  await resize(1440, 900);
  const strip = await page.locator(".agent-tabs").elementHandle();
  await waitForIdleFetches(page);
  await page.getByRole("link", { name: "← Agents", exact: true }).click();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
  assert.equal(await strip.evaluate((node) => node.isConnected), false);
  await page.goBack();
  await page.locator('.agent-tabs button[aria-selected="true"]:enabled').waitFor();
  assert.equal(await strip.evaluate((node) => node.isConnected), true);
  await resize(390, 844);
  await assertSelectedTabVisible("Logs");
});

test("the Logs tab shows runtime status, sanitized output and follows with a cursor", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  const secret = `ghp_${randomUUID().replaceAll("-", "")}`;
  computeDriver.state.restartCount = 1;
  computeDriver.state.events = [
    {
      type: "Warning",
      container: "gateway",
      reason: "BackOff",
      message: "Back-off restarting failed container",
      count: 3,
      lastObservedAt: "2026-09-30T11:59:00Z",
    },
  ];
  computeDriver.state.lines = [
    line(
      1,
      '{"event":"runtime.startup_phase","container":"gateway","phase":"config","outcome":"ok","ms":12,"sinceStartMs":40}',
    ),
    line(2, `pushing with ${secret}`),
    line(3, '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"hi"}}'),
    // A pretty-printed JSON value, as Codex prints it: withheld as one run, never called corrupt.
    line(3, "{"),
    line(3, '  "id": 7,'),
    line(3, '  "result": {}'),
    line(3, "}"),
    line(
      4,
      '{"event":"codex.model_probe","attempt":1,"elapsedMs":900,"exitCode":1,"signal":null,"code":"AUTHENTICATION_FAILED"}',
    ),
  ];
  computeDriver.state.previousLines = [line(0, "output before the restart")];

  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url);

  const card = page.locator(".runtime-pod");
  await card.getByRole("heading", { name: "Gateway" }).waitFor();
  await card.getByText("OOMKilled · exit 137", { exact: false }).waitFor();
  // Events name the container they concern.
  await card.getByText("gateway · BackOff ×3: Back-off restarting failed container").waitFor();
  // A container that restarted keeps its warnings styled as current.
  await card.getByRole("list", { name: "Recent warning Events" }).waitFor();
  assert.equal(await card.getByText("Earlier warnings.", { exact: false }).count(), 0);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("runtime.startup_phase").waitFor();
  await pane.getByText("pushing with [redacted:token]").waitFor();
  // The reason code in parentheses is the one `occ agent logs` prints for the same rows.
  await pane.getByText("1 structured output line withheld (unrecognised_structured)").waitFor();
  await pane
    .getByText("4 multi-line, unparseable or deeply nested JSON lines withheld (malformed)")
    .waitFor();
  assert.equal(await pane.getByText(/malformed structured/).count(), 0);
  // A failure code shows on the collapsed row, not only after expanding it.
  const probe = pane.locator(".log-row", { hasText: "codex.model_probe" });
  assert.equal(
    await probe.locator("summary .log-code").textContent(),
    "code=AUTHENTICATION_FAILED",
  );
  assert.equal(await probe.locator("summary .log-code").isVisible(), true);
  assert.equal(await page.getByText(secret).count(), 0);
  await page.getByText("Kubernetes keeps the current and the previous instance.").waitFor();

  // Follow polls with the view's cursor and labels a restart instead of hiding it.
  computeDriver.state.restartCount = 2;
  computeDriver.state.lines = [line(4, "after the restart")];
  await page.getByRole("button", { name: "Follow" }).click();
  await pane.getByText("after the restart").waitFor();
  await pane.getByText("Container restarted", { exact: true }).waitFor();
  assert.ok(logRequests(requests, revisionId).some(({ path }) => path.includes("cursor=v2.")));
  await page.getByRole("button", { name: "Following" }).click();

  // The previous instance is a separate view and disables follow.
  await page.getByLabel("Previous instance").check();
  await pane.getByText("output before the restart").waitFor();
  assert.equal(await page.getByRole("button", { name: "Follow" }).isDisabled(), true);
  assert.ok(logRequests(requests, revisionId).some(({ path }) => path.includes("previous=true")));

  // Drafts have no runtime and no Logs tab.
  await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "logs").href);
  await page.getByRole("tab", { name: "Configuration", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "Logs", exact: true }).count(), 0);
});

test("log timestamps distinguish the repeated hour when daylight saving time ends", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [
    { time: "2026-11-01T05:30:00Z", raw: "before the clocks went back" },
    { time: "2026-11-01T06:30:00Z", raw: "after the clocks went back" },
  ];
  const { page } = await newPage(t, fixture, {
    context: { locale: "en-US", timezoneId: "America/New_York" },
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revisionId, "logs"));

  const log = page.getByRole("log", { name: "Runtime log output" });
  const timestamp = (hasText: string) =>
    log.locator(".log-row", { hasText }).locator(".log-time").innerText();
  assert.match(await timestamp("before the clocks went back"), /1:30:00\s+AM\s+GMT-4$/u);
  assert.match(await timestamp("after the clocks went back"), /1:30:00\s+AM\s+GMT-5$/u);
});

// The UTC offset made timestamps wrap onto a second line in the fixed 170 px (150 px at 1100 px
// and below) time column above 760 px, so every log row took two lines (findings 1681, 1697).
// In a Logs card under 662 px (a 1000 px window and below, or about 1101-1280 px beside the
// version list) the message moves below the time instead of shrinking to a sliver. At 521-527 px
// the phone layout squeezed the time column, and under about 400 px the level beside it did
// (finding 1844): there the time takes its own line, down to a 320 px window. The column was
// sized for en-US, so ko-KR wrapped at every width, and es-MX and ar-EG with a long UTC offset
// (finding 1861): the console now measures the widest timestamp of the locale and time zone,
// and a cell too narrow for it shrinks the text rather than wrapping it.
test("log timestamps with their UTC offset stay on one line", async (t) => {
  const { fixture, computeDriver, namespace } = await logsFixture(t);
  // 12/31, a two-digit hour: the longest en-US form, with Adelaide's GMT+10:30. The other lines
  // have another level or a shorter timestamp, and their columns line up with the first.
  computeDriver.state.lines = [
    { time: "2026-12-31T02:29:59Z", raw: "longest timestamp" },
    {
      time: "2026-01-01T20:00:00Z",
      raw: JSON.stringify({ level: "error", message: "shorter timestamp" }),
    },
    // Lord Howe's GMT+10:30 applies only in the southern winter.
    { time: "2026-07-31T02:29:59Z", raw: "winter timestamp" },
  ];
  // The first case signs in; later contexts start with its session cookie.
  const locales = [
    ["en-US", "Australia/Adelaide", /^12\/31\/2026, 12:59:59\sPM\sGMT\+10:30$/u],
    ["en-US", "Asia/Kolkata", /^12\/31\/2026, 7:59:59\sAM\sGMT\+5:30$/u],
    ["en-US", "America/New_York", /^12\/30\/2026, 9:29:59\sPM\sGMT-5$/u],
    ["fr-FR", "Europe/Paris", /^31\/12\/2026\s03:29:59\sUTC\+1$/u],
    ["de-DE", "Europe/Berlin", /^31\.12\.2026,\s03:29:59\sGMT\+1$/u],
    ["ko-KR", "Asia/Seoul", /^2026\.\s12\.\s31\.\s오전\s11시\s29분\s59초\sGMT\+9$/u],
    ["ko-KR", "Australia/Adelaide", /^2026\.\s12\.\s31\.\s오후\s12시\s59분\s59초\sGMT\+10:30$/u],
    ["ar-EG", "Australia/Adelaide", /^٣١\S*\/١٢\S*\/٢٠٢٦،?\s١٢:٥٩:٥٩\sم\sغرينتش\+١٠:٣٠$/u],
    ["en-AU", "Australia/Lord_Howe", /^31\/12\/2026, 1:29:59\spm\sGMT\+11$/u],
    ["es-MX", "Australia/Adelaide", /^31\/12\/2026, 12:59:59\sp\.\s?m\.\sGMT\+10:30$/u],
  ] as const;
  let signedIn;
  for (const [index, [locale, timezoneId, shown]] of locales.entries()) {
    // Each case reads its own Agent's logs: one Agent's reads are rate limited per principal
    // (burst 10, then 2 a second), and ten cases in one Chromium read faster than that.
    const agent = await fixture.createAgent(
      namespace.id,
      `Logs Agent ${index}`,
      nativeValues("v1"),
    );
    const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const { page } = await newPage(t, fixture, {
      browser,
      context: {
        locale,
        timezoneId,
        ...(signedIn === undefined ? {} : { storageState: signedIn }),
      },
    });
    const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "logs");
    if (signedIn === undefined) {
      await login(page, fixture, url);
      signedIn = await page.context().storageState();
    } else {
      await page.goto(url.href);
    }
    const log = page.getByRole("log", { name: "Runtime log output" });
    const time = log.locator(".log-row", { hasText: "longest timestamp" }).locator(".log-time");
    assert.match(await time.innerText(), shown);
    await log.getByText("winter timestamp").waitFor();
    for (const width of [
      1440, 1300, 1200, 1101, 1100, 1001, 1000, 761, 760, 662, 600, 527, 524, 521, 520, 480, 404,
      402, 397, 390, 360, 320,
    ]) {
      await page.setViewportSize({ width, height: 900 });
      const where = `${locale} ${timezoneId} at ${width}px`;
      // One read of the laid-out pane per width: 220 cases, so round trips set the test's time.
      const seen = await log.evaluate((pane) => {
        const all = (selector: string) => [...pane.querySelectorAll(selector)];
        const cells = all(".log-time");
        const longest = all(".log-row")
          .find((row) => row.textContent.includes("longest timestamp"))
          ?.querySelector(".log-time");
        if (!longest) {
          throw new Error("no time cell in the longest timestamp's row");
        }
        const content = longest.closest(".log-line")!.querySelector(".log-content")!;
        const box = content.getBoundingClientRect();
        return {
          cells: cells.map((cell) => {
            const range = cell.ownerDocument.createRange();
            range.selectNodeContents(cell);
            const rects = [...range.getClientRects()];
            const box = cell.getBoundingClientRect();
            return {
              text: cell.textContent,
              lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
              left: Math.min(...rects.map((rect) => rect.left)) - box.left,
              right: box.right - Math.max(...rects.map((rect) => rect.right)),
            };
          }),
          starts: Object.fromEntries(
            [".log-time", ".log-level", ".log-origin"].map((column) => [
              column,
              all(column).map((cell) => cell.getBoundingClientRect().left),
            ]),
          ),
          times: cells.map((cell) => {
            const { width } = cell.getBoundingClientRect();
            return `${width} ${getComputedStyle(cell.firstElementChild!).fontSize}`;
          }),
          overflow: pane.scrollWidth > pane.clientWidth,
          message: {
            beside: box.top < longest.getBoundingClientRect().bottom,
            width: box.width,
          },
        };
      });
      assert.equal(seen.cells.length, 3);
      for (const cell of seen.cells) {
        assert.equal(cell.lines, 1, `one line for ${cell.text}, ${where}`);
        // The text stays inside its cell, so it never runs into the level beside it.
        assert.ok(
          cell.left >= -0.5 && cell.right >= -0.5,
          `${cell.text} inside its cell, ${where}`,
        );
      }
      // Rows with different levels and timestamp lengths keep one time width and font size.
      for (const [column, starts] of Object.entries(seen.starts)) {
        assert.equal(new Set(starts).size, 1, `${column} aligned, ${where}`);
      }
      assert.equal(new Set(seen.times).size, 1, `one time width and size, ${where}: ${seen.times}`);
      assert.ok(!seen.overflow, `no horizontal log overflow, ${where}`);
      // A message beside the time keeps about 200 px (196 px beside en-US's at a 662 px card);
      // beside a longer timestamp, in a card up to 762 px, it moves below.
      assert.ok(
        !seen.message.beside || seen.message.width >= 195,
        `message ${seen.message.width}px wide beside the time, ${where}`,
      );
    }
  }
});

// Each Logs pane probed 288 timestamps to size its time column, although the width depends
// only on the locale, time zone and font: 2-9 ms per pane, a 78 ms long task in ar-EG without an
// Arabic font (finding 1867). Later panes reuse the first measurement.
test("later Logs panes reuse the measured time column width", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [{ time: "2026-12-31T02:29:59Z", raw: "longest timestamp" }];
  const { page } = await newPage(t, fixture, {
    context: { locale: "ko-KR", timezoneId: "Australia/Adelaide" },
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revisionId, "logs"));
  const log = page.getByRole("log", { name: "Runtime log output" });
  await log.getByText("longest timestamp").waitFor();
  const reused = await log.evaluate(async (shown) => {
    // The module instance the page runs, not a second copy.
    const resource = globalThis.performance
      .getEntriesByType("resource")
      .find((entry) => new URL(entry.name).pathname.endsWith("/agents/logs-view.mjs"));
    if (!resource) {
      throw new Error("The Console did not load agents/logs-view.mjs");
    }
    const { fitLogTimeColumn }: LogsView = await import(resource.name);
    let probes = 0;
    const observer = new globalThis.MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          probes += node instanceof Element && node.classList.contains("log-time-probe") ? 1 : 0;
        }
      }
    });
    observer.observe(globalThis.document.body, { childList: true, subtree: true });
    // What sizes the column: its width, the text in 11px ems, and the long-time layout.
    const sizing = (pane: HTMLElement | SVGElement) => [
      pane.style.getPropertyValue("--log-time-width"),
      pane.style.getPropertyValue("--log-time-ems"),
      pane.hasAttribute("data-long-time"),
    ];
    const panes = [];
    for (let index = 0; index < 2; index += 1) {
      const pane = globalThis.document.createElement("div");
      pane.className = "log-pane";
      shown.after(pane);
      panes.push([fitLogTimeColumn(pane), ...sizing(pane)]);
      pane.remove();
    }
    const missed = observer.takeRecords();
    observer.disconnect();
    for (const record of missed) {
      for (const node of record.addedNodes) {
        probes += node instanceof Element && node.classList.contains("log-time-probe") ? 1 : 0;
      }
    }
    return { probes, panes, shown: sizing(shown) };
  });
  // ko-KR with GMT+10:30 is wider than en-US, so the long-time layout applies too.
  assert.equal(reused.shown[2], true);
  assert.deepEqual(reused, {
    probes: 0,
    panes: [
      [true, ...reused.shown],
      [true, ...reused.shown],
    ],
    shown: reused.shown,
  });
});

// Above 1100 px the Logs card sits beside the version list, narrower than at 1001-1100 px.
// Breakpoints on the window squeezed the message column to 0 px at 1101 px, one character per
// line (finding 1713); the rows now follow the card's width. The test above keeps timestamps whole.
test("the log message column stays readable beside the version list", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [
    { time: "2026-12-31T02:29:59Z", raw: "failed to resolve remote control preferences" },
  ];
  const { page } = await newPage(t, fixture, {
    context: { locale: "en-US", timezoneId: "Australia/Adelaide" },
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revisionId, "logs"));
  const log = page.getByRole("log", { name: "Runtime log output" });
  await log.getByText("failed to resolve remote control preferences").waitFor();
  for (const width of [390, 1000, 1101, 1200, 1300, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const message = await log
      .locator(".log-content")
      .evaluate((cell) => cell.getBoundingClientRect().width);
    assert.ok(message >= 200, `message column ${message}px wide at ${width}px`);
  }
});

// The Pod cards share the status strip's width. Fixed-width columns left a dedicated Agent's two
// cards at about 265 px each beside the version list, Pod names and container states wrapping
// over 3-4 lines next to about 280 px of blank strip (finding 2100, at 1440 on a live install).
// Here the strip is a little narrower, so the old layout leaves that gap from 1600 px.
test("runtime Pod cards fill the status strip at desktop and phone widths", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.harnessPod = { ready: true };
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revisionId, "logs"));
  const strip = page.locator(".runtime-strip");
  await strip.getByRole("heading", { name: "Agent (Harness)" }).waitFor();
  await strip.getByRole("heading", { name: "Gateway" }).waitFor();
  for (const width of [1440, 1600, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const { row, tracks, cards } = await strip.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return {
        row: { left: box.left, right: box.right },
        tracks: globalThis.getComputedStyle(node).gridTemplateColumns.split(" "),
        cards: [...node.querySelectorAll(".runtime-pod")].map((card) => {
          const rect = card.getBoundingClientRect();
          return { top: rect.top, left: rect.left, right: rect.right };
        }),
      };
    });
    assert.equal(cards.length, 2);
    // No column is left without a card, whatever the strip's width.
    const used = tracks.filter((track) => Number.parseFloat(track) > 0);
    assert.ok(used.length <= cards.length, `columns ${tracks.join(" ")} at ${width}px`);
    // Each row of cards starts at the strip's left edge and its last card ends at its right edge.
    const rows = Map.groupBy(cards, ({ top }) => Math.round(top));
    assert.equal(rows.size, width === 390 ? 2 : 1, `card rows at ${width}px`);
    for (const rowCards of rows.values()) {
      const first = rowCards[0];
      const last = rowCards.at(-1);
      assert.ok(first && last);
      assert.ok(Math.abs(first.left - row.left) <= 1, `first card starts at ${width}px`);
      assert.ok(
        Math.abs(last.right - row.right) <= 1,
        `cards end ${row.right - last.right}px before the strip's edge at ${width}px`,
      );
    }
  }
});

test("log levels stay on one line and keep log columns aligned", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  const levels = ["error", "warn", "info", "debug"];
  computeDriver.state.lines = [
    ...levels.map((level, i) =>
      line(i, JSON.stringify({ level, subsystem: "gateway", message: level + " message" })),
    ),
    line(4, "plain output with a long token " + "x".repeat(160)),
  ];
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revisionId, "logs"));
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("error message", { exact: true }).waitFor();
  await page.getByLabel("Include debug").check();
  await pane.getByText("debug message", { exact: true }).waitFor();

  for (const width of [320, 390, 524, 700, 780, 900, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const fittingLevels = await pane.locator(".log-level").evaluateAll((badges) =>
      badges.flatMap((badge) => {
        const range = badge.ownerDocument.createRange();
        range.selectNodeContents(badge);
        const [word, wrapped] = range.getClientRects();
        const box = badge.getBoundingClientRect();
        return word && !wrapped && word.left >= box.left && word.right <= box.right
          ? [badge.textContent]
          : [];
      }),
    );
    // Plain output has no declared level; its UNKNOWN label needs to fit, too.
    assert.deepEqual(
      fittingLevels,
      [...levels, "unknown"],
      "whole level labels at " + width + "px",
    );
    for (const column of [".log-origin", ".log-content"]) {
      const starts = await pane
        .locator(column)
        .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().left));
      assert.equal(
        new Set(starts).size,
        1,
        column + " stays aligned across log levels at " + width + "px",
      );
    }
    assert.ok(
      await pane.evaluate((log) => log.scrollWidth <= log.clientWidth),
      "no horizontal log overflow",
    );
  }
});

test("invisible and bidirectional characters in log text show as visible escapes", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.events = [
    {
      type: "Warning",
      container: "gateway",
      reason: "BackOff",
      message: "pulling report\u202egnp.exe",
      count: 1,
      lastObservedAt: "2026-09-30T11:59:00Z",
    },
  ];
  computeDriver.state.lines = [
    // U+202E would display the rest of the line reversed ("invoice for exe.pdf").
    line(1, "invoice for \u202efdp.exe, zero\u200bwidth and \u2066isolate\u2069 end"),
    line(
      2,
      '{"event":"runtime.startup_phase","container":"gateway","phase":"conf\u202eig","outcome":"ok","ms":12,"sinceStartMs":40}',
    ),
    line(3, "plain text, emoji \u{1f600} and \u6f22\u5b57 stay as they are"),
    // A tag character hides ASCII outside the Basic Multilingual Plane.
    line(4, "tagged\u{e0041} line"),
  ];

  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url);

  const pane = page.getByRole("log", { name: "Runtime log output" });
  const text = pane.locator(".log-message", { hasText: "invoice for" });
  await text.waitFor();
  assert.equal(
    await text.textContent(),
    "invoice for \\u202efdp.exe, zero\\u200bwidth and \\u2066isolate\\u2069 end",
  );
  // The filter matches what the row shows.
  assert.match(
    (await pane.locator(".log-row", { hasText: "invoice for" }).getAttribute("data-search")) ?? "",
    /invoice for \\u202efdp\.exe/,
  );
  const phase = pane.locator(".log-row", { hasText: "runtime.startup_phase" });
  await phase.locator("summary").click();
  await phase.locator("dd", { hasText: "conf" }).waitFor();
  assert.equal(await phase.locator("dd", { hasText: "conf" }).textContent(), "conf\\u202eig");
  assert.equal(
    await pane.locator(".log-message", { hasText: "plain text" }).textContent(),
    "plain text, emoji \u{1f600} and \u6f22\u5b57 stay as they are",
  );
  assert.equal(
    await pane.locator(".log-message", { hasText: "tagged" }).textContent(),
    "tagged\\U000e0041 line",
  );
  // Pasting the original text into the filter still finds the escaped row.
  await page.getByLabel("Filter", { exact: true }).fill("for \u202efdp");
  await pane.locator(".log-row", { hasText: "invoice for" }).waitFor({ state: "visible" });
  await page
    .locator(".runtime-pod")
    .getByText("gateway · BackOff: pulling report\\u202egnp.exe")
    .waitFor();
});

test("startup warnings on a Ready Pod without restarts read as history", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  // A healthy first deploy: readiness probes failed while the Gateway started, then it
  // became Ready with no restarts.
  computeDriver.state.events = [
    {
      type: "Warning",
      container: "gateway",
      reason: "Unhealthy",
      message: "Readiness probe failed: Gateway /readyz unavailable: ECONNREFUSED",
      count: 8,
      lastObservedAt: "2026-09-30T11:00:20Z",
    },
  ];
  computeDriver.state.lines = [line(1, "gateway ready")];
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url);

  const card = page.locator(".runtime-pod");
  const earlier = card.getByRole("list", { name: "Earlier warning Events" });
  await earlier
    .getByText("gateway · Unhealthy ×8: Readiness probe failed: Gateway /readyz unavailable")
    .waitFor();
  await card.getByText("Earlier warnings. The Pod is Ready now and has not restarted.").waitFor();
  assert.equal(await card.getByRole("list", { name: "Recent warning Events" }).count(), 0);
  // The muted text color, not the warning color, marks them as recovered.
  const colors = await earlier.evaluate((list) => {
    const view = list.ownerDocument.defaultView!;
    const probe = list.ownerDocument.createElement("span");
    probe.style.color = "var(--warning)";
    list.append(probe);
    const warning = view.getComputedStyle(probe).color;
    probe.remove();
    return { list: view.getComputedStyle(list).color, warning };
  });
  assert.notEqual(colors.list, colors.warning);
});

// Runtime status is reread every 10 s and usually comes back unchanged. Rebuilding the
// aria-live status strip, the Source and Pod pickers and the retention text with the same
// content made screen readers announce them again on every poll (finding 1420), and the
// "Observed <time>" status line changed on every poll (finding 1425).
test("an unchanged runtime status poll leaves the status strip and pickers untouched", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [line(1, "steady output")];
  // A second Pod shows the Pod picker as well.
  computeDriver.state.extraPods = [
    { name: "gateway-second", uid: "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" },
  ];
  const { page } = await newPage(t, fixture);
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revisionId, "logs"));
  await page.getByRole("log", { name: "Runtime log output" }).getByText("steady output").waitFor();
  const strip = page.locator(".runtime-strip");
  await strip.locator(".runtime-pod").nth(1).waitFor();
  await page.locator("#runtime-log-pod:not([hidden])").waitFor();
  const observed = ["#runtime-log-source", "#runtime-log-pod", ".runtime-strip", ".log-retention"];
  const rewrites = await page.evaluateHandle((selectors) => {
    const changes: string[] = [];
    const observer = new globalThis.MutationObserver((records) => {
      for (const record of records) {
        const node =
          record.target instanceof Element ? record.target : record.target.parentElement!;
        changes.push(`${record.type} ${node.id || node.className}`);
      }
    });
    const announcing = [...globalThis.document.querySelectorAll(".agent-logs [role='status']")];
    for (const node of [
      ...selectors.map((selector) => globalThis.document.querySelector(selector)),
      ...announcing,
    ]) {
      observer.observe(node!, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    return changes;
  }, observed);
  // The observation time sits outside every status region, with aria-live=off, because it
  // changes on every poll and a status region would announce each one (finding 1425).
  const observedLine = page.locator(".agent-logs [aria-live='off']");
  assert.match((await observedLine.textContent()) ?? "", /^Observed /);

  // Only the observation time changes; it shows outside the observed regions.
  computeDriver.state.observedAt = "2026-09-30T12:00:10.000Z";
  const before = await observedLine.textContent();
  await page.clock.runFor(10_000);
  await page.waitForFunction(
    (text) =>
      globalThis.document.querySelector(".agent-logs [aria-live='off']")!.textContent !== text,
    before,
  );
  assert.deepEqual(await rewrites.jsonValue(), []);

  // A real change still updates the strip.
  computeDriver.state.restartCount = 4;
  await page.clock.runFor(10_000);
  await strip.getByText("4", { exact: true }).first().waitFor();
  assert.ok((await rewrites.jsonValue()).length > 0);
  await rewrites.dispose();
});

test("a status poll that changes the log source starts its tail; retaining the source spends no read", async (t) => {
  const logs = await logsFixture(t);
  const state = logs.computeDriver.state;
  state.harnessPod = { ready: true };
  state.harnessLines = [line(1, "output from the selected Agent")];
  state.lines = [line(2, "output from the remaining Gateway")];
  const { page, requests } = await openRetainedLogs(t, logs, logs.fixture.credentials);
  const source = page.locator("#runtime-log-source");
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await source.selectOption("agent");
  const agentLine = pane.getByText("output from the selected Agent");
  await agentLine.waitFor();
  const reads = () => logRequests(requests, logs.revisionId);
  const before = reads().length;

  // The status changes, but the selected Agent stream still exists.
  state.extraPods = [{ name: "another-gateway-pod", uid: randomUUID() }];
  await page.clock.runFor(10_000);
  await page.locator(".runtime-pod").getByText("another-gateway-pod").waitFor();
  await waitForIdleFetches(page);
  assert.equal(await source.inputValue(), "agent");
  assert.equal(await agentLine.isVisible(), true);
  assert.equal(reads().length, before);

  // The Agent Pod goes away. The picker already falls back to Gateway; the output must too.
  state.harnessPod = { created: false };
  await page.clock.runFor(10_000);
  await source.locator('option[value="agent"]:disabled').waitFor({ state: "attached" });
  await waitForIdleFetches(page);
  assert.equal(await source.inputValue(), "gateway");
  const next = reads().slice(before);
  assert.equal(next.length, 1, "read the new source once");
  const { searchParams } = new URL(next[0]!.path, logs.fixture.origin);
  assert.equal(searchParams.get("source"), "gateway");
  assert.equal(searchParams.get("tailLines"), "200");
  assert.equal(searchParams.has("cursor"), false);
  assert.equal(await agentLine.count(), 0);
  await pane.getByText("output from the remaining Gateway").waitFor();
});

test("a status poll that replaces the selected Pod drops even an in-flight page from it", async (t) => {
  const logs = await logsFixture(t);
  const state = logs.computeDriver.state;
  const old = { name: "gateway-before-rollout", uid: randomUUID() };
  state.extraPods = [old];
  const { page, requests } = await openRetainedLogs(t, logs, logs.fixture.credentials);
  const picker = page.locator("#runtime-log-pod");
  const pane = page.getByRole("log", { name: "Runtime log output" });
  state.readPodUid = old.uid;
  state.lines = [line(1, "output from the selected Pod")];
  await picker.selectOption({ label: old.name + " / gateway" });
  const oldLine = pane.getByText("output from the selected Pod");
  await oldLine.waitFor();

  const url = "**/runtime/logs?*cursor=*";
  const held = await holdRequests(t, page, url, { once: true, afterServer: true });
  const late = "last output from the old Pod";
  state.lines.push(line(2, late));
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await page.clock.runFor(2_000);
  await held.requested;
  const reads = () => logRequests(requests, logs.revisionId);
  const before = reads().length;
  const wasPainted = await watchPainted(page, { text: late });

  state.extraPods = [];
  delete state.readPodUid;
  state.lines = [line(3, "first output from the remaining Pod")];
  await page.clock.runFor(10_000);
  await picker
    .getByRole("option", { name: old.name + " / gateway" })
    .waitFor({ state: "detached" });
  assert.equal(await oldLine.count(), 0, "do not label the old output as the new selection");

  const delivered = page.waitForResponse(url);
  held.release();
  const oldResponse = await delivered;
  assert.equal(oldResponse.status(), 200);
  assert.ok((await oldResponse.text()).includes(late), "the old response really arrived");
  await pane.getByText("first output from the remaining Pod").waitFor();
  const next = reads().slice(before);
  assert.equal(next.length, 1, "read the replacement Pod once");
  const { searchParams } = new URL(next[0]!.path, logs.fixture.origin);
  assert.equal(searchParams.has("cursor"), false);
  assert.equal(searchParams.get("tailLines"), "200");
  assert.deepEqual(JSON.parse(await picker.inputValue()), [searchParams.get("pod"), "gateway"]);
  assert.equal(await wasPainted(), false, "the old response never repainted");
});

test("a rejected cursor starts one new view and later restarts wait for it", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [line(1, "first view line")];
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("first view line").waitFor();

  // Tamper with the first follow cursor, then hold the replacement view's read.
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  let state = "untouched";
  await page.route(`**/deployments/${revisionId}/runtime/logs?*`, async (route, request) => {
    const target = new URL(request.url());
    const cursor = target.searchParams.get("cursor");
    if (state === "untouched" && cursor !== null) {
      state = "tampered";
      const last = cursor.at(-1) === "A" ? "B" : "A";
      target.searchParams.set("cursor", `${cursor.slice(0, -1)}${last}`);
      await route.continue({ url: target.href });
      return;
    }
    if (state === "tampered" && cursor === null) {
      state = "holding";
      held.resolve();
      await release.promise;
      state = "released";
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Follow" }).click();
  await held.promise;
  // A restart while the replacement read is in flight waits for it.
  computeDriver.state.lines = [line(1, "first view line"), line(2, "debug floor line")];
  const readsWhileHeld = logRequests(requests, revisionId).length;
  await page.getByLabel("Include debug").check();
  await settlePageRequests(page);
  assert.equal(logRequests(requests, revisionId).length, readsWhileHeld);
  release.resolve();
  await pane.getByText("debug floor line").waitFor();
  // The queued restart read the new debug view.
  const after = logRequests(requests, revisionId).at(-1);
  assert.ok(after);
  assert.equal(new URL(after.path, fixture.origin).searchParams.has("minLevel"), false);
  await page.getByRole("button", { name: "Following" }).click();
});

test("level chips and the text filter narrow only the loaded window; download saves the sanitized tail", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  const secret = `ghp_${randomUUID().replaceAll("-", "")}`;
  computeDriver.state.lines = [
    line(
      1,
      '{"time":"2026-09-30T12:00:01Z","level":"error","message":"model call failed","subsystem":"agents"}',
    ),
    line(
      2,
      '{"time":"2026-09-30T12:00:02Z","level":"warn","message":"slow channel","subsystem":"slack"}',
    ),
    line(
      3,
      '{"time":"2026-09-30T12:00:03Z","level":"info","message":"Gateway ready","subsystem":"gateway"}',
    ),
    line(4, `plain output with ${secret}`),
    line(5, '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"hi"}}'),
    line(6, "Harness model authentication probe failed."),
    line(
      7,
      '{"time":"2026-09-30T12:00:07Z","level":"debug","message":"heartbeat tick","subsystem":"gateway"}',
    ),
  ];

  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("Gateway ready").waitFor();
  await page
    .getByText("Filters search only the lines loaded in this view, not the whole container log.")
    .waitFor();
  const reads = logRequests(requests, revisionId).length;
  // By default the server returns info and above; debug lines are never loaded.
  assert.ok(logRequests(requests, revisionId).every(({ path }) => path.includes("minLevel=info")));
  assert.equal(await pane.getByText("heartbeat tick").count(), 0);

  // Level chips hide lines client-side; withheld rows stay visible.
  const filters = page.getByRole("group", { name: "Log filters" });
  await filters.getByRole("button", { name: "info", exact: true }).click();
  await filters.getByRole("button", { name: "unknown", exact: true }).click();
  assert.equal(
    await filters.getByRole("button", { name: "info", exact: true }).getAttribute("aria-pressed"),
    "false",
  );
  await pane.getByText("Gateway ready").waitFor({ state: "hidden" });
  await pane.getByText(/plain output with/).waitFor({ state: "hidden" });
  // The wrapper's plain failure line is an error, so hiding `unknown` keeps it.
  await pane.getByText("Harness model authentication probe failed.").waitFor();
  assert.equal(await pane.getByText("model call failed").isVisible(), true);
  assert.equal(
    await pane.getByText("1 structured output line withheld (unrecognised_structured)").isVisible(),
    true,
  );
  await page
    .getByText(
      "Showing 3 of 5 loaded lines. Filters search only the lines loaded in this view, not the whole container log.",
    )
    .waitFor();

  // The text filter is case-insensitive over message, subsystem and fields.
  await filters.getByRole("button", { name: "info", exact: true }).click();
  await filters.getByRole("button", { name: "unknown", exact: true }).click();
  await page.getByLabel("Filter", { exact: true }).fill("SLACK");
  await pane.getByText("model call failed").waitFor({ state: "hidden" });
  assert.equal(await pane.getByText("slow channel").isVisible(), true);
  await page.getByText(/^Showing 1 of 5 loaded lines\./).waitFor();
  // Filtering never asks the server again.
  assert.equal(logRequests(requests, revisionId).length, reads);
  await page.getByLabel("Filter", { exact: true }).fill("");
  await pane.getByText("Gateway ready").waitFor();

  // Download: one request through the console session, saved under a stable name.
  const downloadRequest = page.waitForRequest((request) => request.url().includes("download=true"));
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const request = await downloadRequest;
  const saved = await downloadEvent;
  const requested = new URL(request.url());
  assert.equal(requested.pathname.endsWith(`/deployments/${revisionId}/runtime/logs`), true);
  assert.deepEqual(Object.fromEntries(requested.searchParams), {
    source: "gateway",
    pod: computeDriver.podName({ id: revisionId }),
    container: "gateway",
    minLevel: "info",
    download: "true",
  });
  assert.equal(request.method(), "GET");
  const pod = computeDriver.podName({ id: revisionId });
  assert.equal(saved.suggestedFilename(), `${agent.id}-${revisionId}-gateway-${pod}.log`);
  const body = await readFile(await saved.path(), "utf8");
  assert.match(body, /ERROR openclaw \[agents\] model call failed/);
  assert.match(body, /plain output with \[redacted:token\]/);
  assert.match(body, /WITHHELD 1 unrecognised_structured/);
  assert.equal(body.includes(secret), false);
  assert.equal(body.includes("jsonrpc"), false);
  assert.equal(body.includes("heartbeat tick"), false);

  // Include debug starts a new server read without the level floor.
  await page.getByLabel("Include debug").check();
  await pane.getByText("heartbeat tick").waitFor();
  assert.equal(logRequests(requests, revisionId).at(-1)?.path.includes("minLevel="), false);
});

test("an operator without administer sees status but no log text and is never re-polled", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [line(1, "operator must not see this")];
  const { account: operator } = await logsMember(fixture, namespace, "runtime-operator", [
    "read",
    "operate",
  ]);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  // A fake clock, so the 10 s status poll below runs without waiting it out in real time.
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url, operator.credentials);

  await page.locator(".runtime-pod").getByRole("heading", { name: "Gateway" }).waitFor();
  await page
    .getByText("Log text requires Agent read_logs (or administer) and read access.")
    .waitFor();
  assert.equal(await page.getByText("operator must not see this").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Follow" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Refresh logs" }).isDisabled(), true);
  const denied = logRequests(requests, revisionId).length;
  assert.equal(denied, 1);
  // Log text was never allowed, so the refusal revokes nothing: status is not asked again at
  // once (finding 1597's re-ask is for a revocation).
  await settlePageRequests(page);
  assert.equal(
    requests.filter(({ path }) => path.endsWith(`/deployments/${revisionId}/runtime`)).length,
    1,
  );
  // Status keeps polling every 10 s; the denied log view is not requested again.
  await page.clock.runFor(10_000);
  await waitForCondition(
    () =>
      requests.filter(({ path }) => path.endsWith(`/deployments/${revisionId}/runtime`)).length >=
      2,
    "the runtime strip refreshes",
  );
  await waitForIdleFetches(page);
  assert.equal(logRequests(requests, revisionId).length, denied);
});

test("a log reader without operate reads log text in the Logs tab without runtime status", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.restartCount = 1;
  computeDriver.state.lines = [line(1, "log reader can see this")];
  computeDriver.state.previousLines = [line(0, "output before the restart")];
  const { account: reader } = await logsMember(fixture, namespace, "runtime-log-reader", [
    "read",
    "read_logs",
  ]);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url, reader.credentials);

  // Runtime status needs operate; log text needs only read_logs, so the tab still reads it.
  await page
    .getByText(
      "Runtime status requires Agent operate and read access plus read access to this version.",
    )
    .waitFor();
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("log reader can see this").waitFor();
  const pod = computeDriver.podName({ id: revisionId });
  await page.getByText(`Showing gateway in ${pod}.`).waitFor();
  assert.equal(await page.locator(".runtime-pod").count(), 0);
  await waitForEnabled(page.locator("#runtime-log-source"));
  // Without status the console names no Pod; OCC reads the source's current Pod.
  const [first] = logRequests(requests, revisionId);
  assert.ok(first);
  assert.equal(new URL(first.path, fixture.origin).searchParams.has("pod"), false);
  // The download is named after the Pod the page read, as with a Pod picker.
  const downloadResponse = page.waitForResponse((response) =>
    response.url().includes("download=true"),
  );
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const saved = await downloadEvent;
  assert.equal(saved.suggestedFilename(), `${agent.id}-${revisionId}-gateway-${pod}.log`);
  const currentResponse = await downloadResponse;
  assert.equal(currentResponse.status(), 200);
  assert.equal(
    currentResponse.headers()["content-disposition"],
    `attachment; filename="${agent.id}-${revisionId}-gateway-${pod}.log"`,
  );
  const currentBody = await readFile(await saved.path(), "utf8");
  assert.equal(currentBody, await currentResponse.text());
  assert.match(currentBody.split("\n")[0] ?? "", / instance=current /);
  assert.match(currentBody, /log reader can see this/);
  assert.equal(currentBody.includes("output before the restart"), false);

  // A Pod can disappear after the page read but before this separate audited read.
  // The real Compute fixture reports no current Harness Pod; OCC emits stream:null.
  computeDriver.state.harnessPod = { ready: true };
  computeDriver.state.harnessLines = [line(1, "last Harness Pod output")];
  await page.locator("#runtime-log-source").selectOption("agent");
  await pane.getByText("last Harness Pod output").waitFor();
  computeDriver.state.harnessPod = { created: false };
  const noPodResponse = page.waitForResponse((response) =>
    response.url().includes("download=true"),
  );
  const noPodDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const emptyResponse = await noPodResponse;
  const emptyDownload = await noPodDownload;
  assert.equal(emptyResponse.status(), 200);
  const downloadQuery = new URL(emptyResponse.url()).searchParams;
  assert.equal(downloadQuery.has("pod"), false);
  assert.equal(downloadQuery.has("cursor"), false);
  const emptyBytes = await emptyResponse.body();
  const [header] = emptyBytes.toString("utf8").split("\n");
  assert.ok(header);
  assert.ok(header.startsWith(`# agent=${agent.id} revision=${revisionId} source=agent `));
  assert.equal(header.includes(" pod="), false);
  assert.match(header, / instance=current /);
  assert.equal(emptyBytes.includes("last Harness Pod output"), false);
  assert.equal(emptyDownload.suggestedFilename(), `${agent.id}-${revisionId}-agent-no-pod.log`);
  assert.deepEqual(await readFile(await emptyDownload.path()), emptyBytes);
  computeDriver.state.harnessPod = undefined;
  await page.locator("#runtime-log-source").selectOption("gateway");
  await pane.getByText("log reader can see this").waitFor();

  // The page's stream reports the restart, so the previous instance is readable.
  await page.getByLabel("Previous instance").check();
  await pane.getByText("output before the restart").waitFor();
  // Both the API attachment and the Console save identify this separate instance.
  const previousResponse = page.waitForResponse((response) =>
    response.url().includes("download=true"),
  );
  const previousDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const priorResponse = await previousResponse;
  const priorDownload = await previousDownload;
  assert.equal(priorResponse.status(), 200);
  assert.equal(new URL(priorResponse.url()).searchParams.get("previous"), "true");
  assert.equal(
    priorResponse.headers()["content-disposition"],
    `attachment; filename="${agent.id}-${revisionId}-gateway-${pod}-previous.log"`,
  );
  assert.equal(
    priorDownload.suggestedFilename(),
    `${agent.id}-${revisionId}-gateway-${pod}-previous.log`,
  );
  const priorBody = await readFile(await priorDownload.path(), "utf8");
  assert.equal(priorBody, await priorResponse.text());
  assert.match(priorBody.split("\n")[0] ?? "", / instance=previous /);
  assert.match(priorBody, /output before the restart/);
  assert.equal(priorBody.includes("log reader can see this"), false);
  await page.getByLabel("Previous instance").uncheck();
  await pane.getByText("log reader can see this").waitFor();

  // Follow continues the view with its cursor.
  computeDriver.state.lines = [line(1, "log reader can see this"), line(2, "a later line")];
  await page.getByRole("button", { name: "Follow" }).click();
  await pane.getByText("a later line").waitFor();
  assert.ok(logRequests(requests, revisionId).some(({ path }) => path.includes("cursor=v2.")));
  await page.getByRole("button", { name: "Following" }).click();

  // A source this version does not have is explained, not a generic failure.
  await page.locator("#runtime-log-source").selectOption("sandbox");
  await page.getByText(/This version has no sandbox log source/).waitFor();

  // Reopening the tab remembers the status denial and still reads log text; with no
  // Pod list there is no Harness hint.
  const statusReads = () =>
    requests.filter(({ path }) => path.endsWith(`/deployments/${revisionId}/runtime`)).length;
  const before = statusReads();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await pane.getByText("log reader can see this").waitFor();
  await waitForEnabled(page.locator("#runtime-log-source"));
  assert.equal(statusReads(), before);
  assert.equal(await page.getByRole("note").count(), 0);
});

test("the Logs tab explains cluster RBAC, unsupported Drivers and unavailable reads", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  const { RuntimeLogsForbiddenByClusterError } = await import("../../packages/occ/src/index.ts");
  computeDriver.state.readError = new RuntimeLogsForbiddenByClusterError();
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url);
  await page
    .getByText(/Ask your platform operator to enable agentRuntimeLogs in the Helm chart/)
    .waitFor();

  computeDriver.state.readError = new Error(`private detail ${randomUUID()}`);
  await page.getByRole("button", { name: "Refresh logs" }).click();
  await page.getByText(/Runtime status or logs are unavailable/).waitFor();
  assert.equal(await page.getByText(/private detail/).count(), 0);

  computeDriver.state.readError = undefined;
  computeDriver.state.describeError = new Error("cluster unreachable");
  computeDriver.runtimeLogging = "driver";
  await page.reload();
  await page
    .getByText(/This Compute Driver does not expose runtime status or logs/)
    .first()
    .waitFor();
});

const rateLimitRequestId = "req_12345678-1234-1234-1234-123456789abc";

function rateLimitedResponse(retryAfter?: number) {
  return {
    status: 429,
    contentType: "application/json",
    headers: retryAfter ? { "Retry-After": String(retryAfter) } : {},
    body: JSON.stringify({
      error: {
        code: "RUNTIME_LOGS_RATE_LIMITED",
        message: "Too many runtime log requests. Wait for Retry-After and try again.",
      },
      meta: { requestId: rateLimitRequestId },
    }),
  };
}

async function logsBeforeRateLimit(t: TestContext) {
  const logs = await logsFixture(t);
  logs.computeDriver.state.lines = [line(1, "output before the rate limit")];
  const { page } = await openRetainedLogs(t, logs);
  await page.getByRole("log").getByText("output before the rate limit").waitFor();
  return page;
}

test("rate-limited manual log reads explain when to retry without reading again", async (t) => {
  const page = await logsBeforeRateLimit(t);
  const reads: string[] = [];
  let seconds: number | undefined;
  await page.route("**/runtime/logs?*", (route) => {
    reads.push(
      new URL(route.request().url()).searchParams.has("download") ? "Download" : "Refresh logs",
    );
    return route.fulfill(rateLimitedResponse(seconds));
  });

  for (const [action, retryAfter, advice] of [
    ["Refresh logs", 7, "Try again in 7 seconds."],
    ["Download", 1, "Try again in 1 second."],
    ["Refresh logs", undefined, "Try again shortly."],
  ] as const) {
    seconds = retryAfter;
    await page.getByRole("button", { name: action }).click();
    await waitForIdleFetches(page);
    assert.equal(
      await page.locator(".log-error").textContent(),
      `Too many requests. ${advice} Request ID: ${rateLimitRequestId}`,
    );
    // Runtime status keeps polling, but a manual log read is audited and must not repeat.
    await page.clock.runFor(15_000);
    await waitForIdleFetches(page);
    assert.deepEqual(reads.splice(0), [action]);
    assert.equal(
      await page.getByRole("button", { name: "Follow" }).getAttribute("aria-pressed"),
      "false",
    );
  }
});

test("rate limits keep Follow and status automatic, but not a download made while following", async (t) => {
  const page = await logsBeforeRateLimit(t);
  const counts = { follow: 0, status: 0, download: 0 };
  await page.route(/\/runtime(?:\/logs\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const read = url.searchParams.has("download")
      ? "download"
      : url.pathname.endsWith("/logs")
        ? "follow"
        : "status";
    counts[read]++;
    return route.fulfill(rateLimitedResponse(read === "follow" ? 1 : 13));
  });
  const logError = page.locator(".log-error");
  const waiting = `Too many requests. Waiting before the next read. Request ID: ${rateLimitRequestId}`;
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await page.clock.runFor(2_000);
  await waitForIdleFetches(page);
  assert.equal(await logError.textContent(), waiting);
  // A one-second Retry-After does not shorten Follow's two-second minimum.
  await page.clock.runFor(1_999);
  assert.equal(counts.follow, 1);
  await page.clock.runFor(1);
  await waitForIdleFetches(page);
  assert.equal(counts.follow, 2);

  await page.getByRole("button", { name: "Download" }).click();
  await waitForIdleFetches(page);
  assert.match(
    (await logError.textContent()) ?? "",
    /Too many requests\. Try again in 13 seconds\./,
  );

  // Status has its own ten-second poll. Neither automatic read repeats the download.
  await page.clock.runFor(6_000);
  await waitForIdleFetches(page);
  assert.equal(await page.getByRole("status").filter({ hasText: waiting }).textContent(), waiting);
  assert.equal(counts.status, 1);
  await page.clock.runFor(10_000);
  await waitForIdleFetches(page);
  assert.equal(counts.status, 2);
  assert.equal(counts.download, 1);
});

// A rate-limited Refresh logs emptied the pane before its read, so only the error remained, and
// "Try again in 1 second" stayed long after that second had passed (finding 1715).
test("a rate-limited Refresh logs keeps the loaded lines and says when to try again", async (t) => {
  const page = await logsBeforeRateLimit(t);
  const log = page.getByRole("log", { name: "Runtime log output" });
  const logError = page.locator(".log-error");
  const outputStatus = page.locator(".log-output-status");
  const shownStatus = await outputStatus.textContent();
  assert.match(shownStatus ?? "", /^Showing /u);
  let answer: ReturnType<typeof rateLimitedResponse> | null = rateLimitedResponse(7);
  await page.route("**/runtime/logs?*", (route) =>
    answer ? route.fulfill(answer) : route.fallback(),
  );

  await page.getByRole("button", { name: "Refresh logs" }).click();
  await waitForIdleFetches(page);
  assert.equal(
    await logError.textContent(),
    `Too many requests. Try again in 7 seconds. Request ID: ${rateLimitRequestId}`,
  );
  assert.equal(await log.locator(".log-row").count(), 1);
  await log.getByText("output before the rate limit").waitFor();
  assert.equal(await outputStatus.textContent(), shownStatus);
  await page.clock.runFor(6_999);
  assert.match((await logError.textContent()) ?? "", /Try again in 7 seconds\./u);
  await page.clock.runFor(1);
  assert.equal(
    await logError.textContent(),
    `Too many requests. You can try again now. Request ID: ${rateLimitRequestId}`,
  );

  // The next refresh replaces the kept lines with its own page.
  answer = null;
  await page.getByRole("button", { name: "Refresh logs" }).click();
  await waitForIdleFetches(page);
  assert.equal(await logError.isHidden(), true);
  assert.equal(await log.locator(".log-row").count(), 1);
  await log.getByText("output before the rate limit").waitFor();

  // A second Refresh while one reads queues another. When that one is rate limited, the status
  // still names the lines shown, not "Reading output…".
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  let doubleReads = 0;
  const doubleRefresh = async (route: Route) => {
    doubleReads += 1;
    if (doubleReads === 1) {
      await held;
      return route.fallback();
    }
    return route.fulfill(rateLimitedResponse(2));
  };
  await page.route("**/runtime/logs?*", doubleRefresh);
  await page.getByRole("button", { name: "Refresh logs" }).click();
  await waitForCondition(() => doubleReads === 1, "the first refresh is held");
  await page.getByRole("button", { name: "Refresh logs" }).click();
  release();
  await waitForCondition(() => doubleReads === 2, "the queued refresh reads");
  await waitForIdleFetches(page);
  assert.match((await logError.textContent()) ?? "", /Try again in 2 seconds\./u);
  assert.equal(await outputStatus.textContent(), shownStatus);
  assert.equal(await log.locator(".log-row").count(), 1);
  await page.unroute("**/runtime/logs?*", doubleRefresh);

  // Following lines whose cursor was rejected cannot be read on from, so the new view clears them
  // first, even when it is rate limited: the next read would repeat them.
  let followReads = 0;
  const rejectCursor = (route: Route) => {
    followReads += 1;
    return route.fulfill(
      followReads === 1
        ? {
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "RUNTIME_LOGS_CURSOR_INVALID", message: "Start a new view." },
              meta: { requestId: rateLimitRequestId },
            }),
          }
        : rateLimitedResponse(5),
    );
  };
  await page.route("**/runtime/logs?*", rejectCursor);
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await page.clock.runFor(2_000);
  await waitForCondition(() => followReads === 2, "the rejected cursor starts a new view");
  await waitForIdleFetches(page);
  assert.equal(await log.locator(".log-row").count(), 0);
  await page.getByRole("button", { name: "Following", exact: true }).click();
  await page.unroute("**/runtime/logs?*", rejectCursor);

  // A read for another selection still clears the lines first: they belong to the old one.
  await page.getByRole("button", { name: "Refresh logs" }).click();
  await waitForIdleFetches(page);
  await log.getByText("output before the rate limit").waitFor();
  answer = rateLimitedResponse(3);
  await page.getByLabel("Include debug").check();
  await waitForIdleFetches(page);
  assert.match((await logError.textContent()) ?? "", /Try again in 3 seconds\./u);
  assert.equal(await log.locator(".log-row").count(), 0);
  assert.equal(await outputStatus.textContent(), "");
});

// A refresh keeps its lines until its page arrives, but only for the selection they belong to:
// another source picked while that refresh is still reading clears them at once, before any read
// for it lands (owner review of #2792).
test("a source picked while a refresh reads clears the kept lines at once", async (t) => {
  const logs = await logsFixture(t);
  logs.computeDriver.state.lines = [line(1, "gateway output")];
  logs.computeDriver.state.harnessPod = { ready: true };
  logs.computeDriver.state.harnessLines = [line(1, "agent output")];
  const { page } = await openRetainedLogs(t, logs);
  const log = page.getByRole("log", { name: "Runtime log output" });
  const outputStatus = page.locator(".log-output-status");
  await log.getByText("gateway output").waitFor();
  await page.locator("#runtime-log-source").selectOption("agent");
  await log.getByText("agent output").waitFor();
  await waitForIdleFetches(page);

  const refresh = await holdRequests(t, page, "**/runtime/logs?*", { once: true });
  await page.getByRole("button", { name: "Refresh logs" }).click();
  try {
    await refresh.requested;
    // A refresh of the same source keeps the Agent line while it reads.
    assert.equal(await log.getByText("agent output").count(), 1);
    await page.locator("#runtime-log-source").selectOption("gateway");
    // Checked while the refresh is still held: the Agent line is gone under the Gateway picker.
    assert.equal(await log.locator(".log-row").count(), 0);
    assert.equal(await outputStatus.textContent(), "Reading output…");
  } finally {
    refresh.release();
  }
  await log.getByText("gateway output").waitFor();
  await waitForIdleFetches(page);
  assert.equal(await log.getByText("agent output").count(), 0);
  assert.match((await outputStatus.textContent()) ?? "", /^Showing gateway in /u);
});

test("the Sandbox source shows redacted policy decisions without a Pod picker", async (t) => {
  const computeDriver = createRuntimeLogComputeDriver({ sandboxNamespace: "tenant-console" });
  const secret = `Zq9${randomUUID().replaceAll("-", "")}`;
  const sandbox = createProviderSandboxDriver();
  const sandboxState: { lines: SandboxLogLine[]; error: Error | undefined } = sandbox.state;
  const fixture = await createConsoleAppFixture(t, {
    computeDriver,
    sandboxDriver: sandbox.driver,
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Sandbox logs", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Sandbox Agent",
    nativeValues("v1", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const sandboxLine = (
    second: number,
    message: string,
    fields: Record<string, string> = {},
  ): SandboxLogLine => ({
    sandboxId: "7c0e5d4a-1b2c-4d3e-8f90-a1b2c3d4e5f6",
    time: `2026-09-30T12:00:0${second}.000000000Z`,
    level: "OCSF",
    target: "ocsf",
    message,
    source: "sandbox",
    fields,
  });
  sandboxState.lines = [
    sandboxLine(
      1,
      `PROC:LAUNCH [INFO] git(42) [cmd:git clone https://x-access-token:${secret}@github.com/acme/repo.git]`,
    ),
    sandboxLine(
      2,
      "NET:OPEN [MED] DENIED python3(7) -> blocked.example.com:443 [policy:default engine:opa]",
    ),
    sandboxLine(
      3,
      "NET:OPEN [MED] DENIED curl(9) -> 169.254.169.254:80 [policy:- engine:ssrf] [reason:resolves to always-blocked address]",
    ),
    sandboxLine(
      4,
      "HTTP:GET [INFO] ALLOWED GET https://api.github.com/zen [policy:github_api engine:opa]",
      { policy_generation: "12" },
    ),
  ];

  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "logs");
  await login(page, fixture, url);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await page.locator("#runtime-log-source").selectOption("sandbox");
  await pane
    .getByText("NET:OPEN [MED] DENIED python3(7) -> blocked.example.com:443", {
      exact: false,
    })
    .waitFor();
  await page.getByText(/OpenShell keeps the last 2000 lines per sandbox/).waitFor();
  // Every decision names its rule and engine; a missing policy generation reads "unknown"
  // and a sandbox decision is never presented as attributed to a Gateway line.
  const rows = pane.locator(".log-row");
  const rowFor = (text: string) => rows.filter({ hasText: text });
  assert.equal(
    await rowFor("blocked.example.com").locator(".log-provenance").textContent(),
    "rule default · engine opa · policy generation unknown",
  );
  assert.equal(
    await rowFor("169.254.169.254").locator(".log-provenance").textContent(),
    "rule no matching rule · engine ssrf · policy generation unknown",
  );
  assert.equal(
    await rowFor("api.github.com/zen").locator(".log-provenance").textContent(),
    "rule github_api · engine opa · policy generation 12",
  );
  assert.equal(await rows.locator(".log-join").count(), 3);
  assert.equal(
    await rowFor("blocked.example.com").locator(".log-join").textContent(),
    "Gateway lines: inferred (time window)",
  );
  assert.match(
    (await rowFor("blocked.example.com").locator(".log-join").getAttribute("title")) ?? "",
    /does not record which Agent turn made this request/,
  );
  // A process launch is not a policy decision: no provenance, no join label.
  assert.equal(await rowFor("PROC:LAUNCH").locator(".log-provenance").count(), 0);
  await page.getByText(/Showing policy decisions and supervisor output of sandbox sb-/).waitFor();
  assert.equal(await page.getByText(secret).count(), 0);
  assert.equal(await page.locator("#runtime-log-pod").isVisible(), false);
  assert.equal(await page.getByLabel("Previous instance").isDisabled(), true);
  assert.equal(sandbox.logRequests.at(-1)?.namespace, "tenant-console");

  const { RuntimeLogsForbiddenByClusterError } = await import("../../packages/occ/src/index.ts");
  sandboxState.error = new RuntimeLogsForbiddenByClusterError();
  await page.getByRole("button", { name: "Refresh logs" }).click();
  await page
    .getByText(/grant the OpenClaw Enterprise gateway identity the sandbox:read scope/)
    .waitFor();
});

test("a Gateway view points at an unready Harness Pod instead of reading as a network fault", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.harnessPod = { ready: false };
  computeDriver.state.lines = [
    line(1, "codex app-server remote WebSocket connection failed: connect ECONNREFUSED"),
  ];
  computeDriver.state.harnessLines = [line(2, "Harness model authentication probe failed.")];
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url);
  await page.locator("#runtime-log-source").selectOption("gateway");
  await page
    .getByRole("log", { name: "Runtime log output" })
    .getByText(/ECONNREFUSED/)
    .waitFor();
  const hint = page.getByRole("note").filter({ hasText: "The Agent (Harness) Pod is not ready" });
  await hint.waitFor();
  assert.match((await hint.textContent()) ?? "", /read the Agent \(Harness\) source for the cause/);

  await page.locator("#runtime-log-source").selectOption("agent");
  await hint.waitFor({ state: "hidden" });
  await page
    .getByRole("log", { name: "Runtime log output" })
    .getByText("Harness model authentication probe failed.")
    .waitFor();
  assert.equal(await page.getByText(/ECONNREFUSED/).count(), 0);

  // A ready Harness adds no hint to the Gateway view.
  computeDriver.state.harnessPod = { ready: true };
  await page.reload();
  await page.locator("#runtime-log-source").selectOption("gateway");
  await page
    .getByRole("log", { name: "Runtime log output" })
    .getByText(/ECONNREFUSED/)
    .waitFor();
  assert.equal(await hint.count(), 0);
});

test("the Gateway hint skips a rollout's old Harness Pod and covers a Harness with no Pod", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  // A rollout keeps an unready old Harness Pod beside a ready one: no hint.
  computeDriver.state.harnessPod = { ready: true, stale: true };
  computeDriver.state.lines = [
    line(1, "codex app-server remote WebSocket connection failed: connect ECONNREFUSED"),
  ];
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url);
  await page
    .locator(".runtime-pod")
    .getByText(`agent-${revisionId.slice(4, 12)}-old`)
    .waitFor();
  await page.locator("#runtime-log-source").selectOption("gateway");
  await page
    .getByRole("log", { name: "Runtime log output" })
    .getByText(/ECONNREFUSED/)
    .waitFor();
  assert.equal(await page.getByRole("note").count(), 0);

  // A dedicated Harness whose Pod does not exist yet still explains the Gateway errors.
  computeDriver.state.harnessPod = { created: false };
  await page.reload();
  await page.locator("#runtime-log-source").selectOption("gateway");
  const missing = page.getByRole("note").filter({ hasText: "The Agent (Harness) has no Pod yet" });
  await missing.waitFor();
  assert.match((await missing.textContent()) ?? "", /see Deployment activity/);
});

test("a reader without operate learns what log text needs and is asked for status once per page", async (t) => {
  const { fixture, namespace, agent, revisionId } = await logsFixture(t);
  const { account: reader } = await logsMember(fixture, namespace, "runtime-reader", ["read"]);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url, reader.credentials);

  await page
    .getByText(
      /Runtime status requires Agent operate .* Log text needs Agent read_logs \(or administer\) and read access\./,
    )
    .waitFor();
  const statusReads = () =>
    requests.filter(({ path }) => path.endsWith(`/deployments/${revisionId}/runtime`)).length;
  assert.equal(statusReads(), 1);

  // Every denied read is an audited authorization denial: reopening the tab does not ask again.
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  // The reopened tab shows this text only after its status decision, so a repeat read has started.
  await page.getByText(/Log text needs Agent read_logs/).waitFor();
  await settlePageRequests(page);
  assert.equal(statusReads(), 1);
});

test("a status denial for one operator does not carry over to the next sign-in on the tab", async (t) => {
  const { fixture, namespace, agent, revisionId } = await logsFixture(t);
  const { account: reader } = await logsMember(fixture, namespace, "runtime-switch-reader", [
    "read",
  ]);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url, reader.credentials);
  await page.getByText(/Runtime status requires Agent operate/).waitFor();

  // Sign out and in as the administrator without reloading the page.
  await page.locator(".account-toggle").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/console\/agents/);
  const statusReads = () =>
    requests.filter(({ path }) => path.endsWith(`/deployments/${revisionId}/runtime`)).length;
  const before = statusReads();
  await page.evaluate((target) => {
    globalThis.history.pushState(null, "", target);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  }, url.pathname + url.search);

  await page.locator(".runtime-pod").getByRole("heading", { name: "Gateway" }).waitFor();
  await page.getByRole("log", { name: "Runtime log output" }).waitFor();
  assert.ok(statusReads() > before);
  assert.equal(await page.getByText(/Runtime status requires Agent operate/).count(), 0);
});

test("Back restores a followed Logs view without replaying its reads and keeps polling", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  // Detaching the scrolling pane for Back's cache resets its offset, which must not leave
  // follow paused as though the reader had scrolled up.
  computeDriver.state.lines = [...earlierOutput(120), line(1, "before leaving")];
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revisionId}`,
    (route) => route.fulfill(succeededDeployment(namespace, agent, revisionId)),
  );
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  await login(page, fixture, url);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("before leaving").waitFor();
  await page.getByRole("button", { name: "Follow" }).click();
  for (const [second, tick] of [
    [2, "first poll"],
    [3, "second poll"],
  ] as const) {
    computeDriver.state.lines = [...computeDriver.state.lines, line(second, tick)];
    await page.clock.runFor(2_000);
    await pane.getByText(tick).waitFor();
  }
  const panel = await pane.elementHandle();
  assert.equal(await panel.evaluate((node) => node.scrollHeight > node.clientHeight), true);
  const logPaths = () =>
    requests.filter(({ path }) => path.includes("/runtime/logs")).map(({ path }) => path);
  const statusReads = () => requests.filter(({ path }) => path.endsWith("/runtime")).length;
  const readBeforeLeaving = new Set(logPaths());
  const logReadsBeforeLeaving = logPaths().length;

  // Both timers fire while the view is cached and stop.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces" }).waitFor();
  // The heading shows before the Namespaces page has checked access. Advancing the clock past
  // the console's 15 s request timeout while a session or Namespace read is pending fails it
  // ("Session unavailable" or "Namespace access unavailable") and drops every cached view, so
  // let the page finish its reads first.
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  await waitForIdleFetches(page);
  await page.clock.runFor(25_000);
  const statusBeforeBack = statusReads();
  computeDriver.state.lines = [...computeDriver.state.lines, line(9, "after back")];
  await page.goBack();
  // The cached view stays inert, its controls disabled, until Back revalidates it.
  await page
    .locator(".agent-logs button[aria-pressed='true']:enabled", { hasText: "Following" })
    .waitFor();
  assert.equal(await panel.evaluate((node) => node.isConnected), true);

  // The restored view resumes from its cursor; Back replays none of its earlier reads.
  await page.clock.runFor(2_000);
  await pane.getByText("after back").waitFor();
  // The reader was at the bottom when leaving and stays there as new lines arrive.
  assert.equal(await panel.evaluate(atBottom), true);
  assert.ok(statusReads() > statusBeforeBack);
  const readAfterBack = logPaths().slice(logReadsBeforeLeaving);
  assert.ok(readAfterBack.length > 0);
  assert.deepEqual(
    readAfterBack.filter((path) => readBeforeLeaving.has(path) || path.includes("tailLines")),
    [],
  );
});

// An Agent page stays hidden behind the page it replaces until its overview's first reads
// settle (#2597). A Logs view whose first reads settled before that scrolled a pane with no
// layout, so it opened at its oldest line and Follow never read again: the pane looked scrolled
// up (finding 1536).
test("a Logs view that loads before its Agent page reveals opens at the newest output and follows", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [...earlierOutput(120), line(1, "newest before reveal")];
  const { page } = await newPage(t, fixture);
  // The overview reveals once its deployment read settles: hold that read.
  const deployment = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revisionId}`,
    { fulfill: succeededDeployment(namespace, agent, revisionId) },
  );
  // A paused clock keeps the overview's bounded wait from revealing the page instead.
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-30T12:00:01Z"));
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revisionId, "logs"));
  await deployment.requested;
  // The Logs view's first reads settle while the Agent page is still hidden.
  await page.locator(".agent-logs:not(.agent-logs-pending)").waitFor({ state: "attached" });
  assert.equal(await page.locator(".agent-detail-pending").count(), 1);
  deployment.release();

  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("newest before reveal").waitFor();
  assert.equal(await pane.evaluate((node) => node.scrollHeight > node.clientHeight), true);
  assert.equal(await pane.evaluate(atBottom), true);
  await page.getByRole("button", { name: "Follow" }).click();
  computeDriver.state.lines = [...computeDriver.state.lines, line(2, "followed output")];
  await page.clock.runFor(2_000);
  await pane.getByText("followed output").waitFor();
  assert.equal(await pane.evaluate(atBottom), true);
});

// Records the window's scroll offset whenever the Agent page is shown, from before the console's
// module runs: a page shown at the top and then scrolled to its output is a jump.
function recordShownScroll() {
  const seen: number[] = [];
  (globalThis as LogTestWindow).shownScroll = seen;
  const record = () => {
    const view = globalThis.document.querySelector('.content [aria-live="polite"]:not([hidden])');
    if (
      view?.querySelector(".agent-current-summary") &&
      !view.classList.contains("agent-detail-pending")
    ) {
      const offset = Math.round(globalThis.scrollY);
      if (seen.at(-1) !== offset) {
        seen.push(offset);
      }
    }
  };
  new globalThis.MutationObserver(record).observe(globalThis.document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  globalThis.addEventListener("scroll", record, { passive: true });
}

// A fresh load, reload or sign-in landing on an Agent's Logs URL showed the page at the top, then
// jumped 441-2448 px down to the output when the first log read landed (finding 1552). The page
// now waits for that output too, within the overview's bound, and shows already scrolled to it.
test("a Logs URL entry shows the page at its output, never at the top first", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [...earlierOutput(120), line(1, "newest on entry")];
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await page.addInitScript(
    `document.addEventListener("readystatechange", () => {
      if (document.readyState === "interactive") (${recordShownScroll})();
    });`,
  );
  // A paused clock keeps the bounded waits from revealing the page instead.
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-30T12:00:01Z"));
  const url = detailUrl(fixture, namespace.id, agent.id, revisionId, "logs");
  const pane = page.getByRole("log", { name: "Runtime log output" });
  for (const entry of ["sign-in landing", "reload"]) {
    // The first log read lands after every other read of the page has settled.
    const logRead = await holdRequests(t, page, `**/deployments/${revisionId}/runtime/logs?*`, {
      once: true,
    });
    if (entry === "reload") {
      await page.reload();
    } else {
      await login(page, fixture, url.href);
    }
    await logRead.requested;
    await page.waitForFunction(() => (globalThis as LogTestWindow).inFlightFetchCount() === 1);
    assert.equal(await page.locator(".agent-detail-pending").count(), 1, entry);
    logRead.release();

    await pane.getByText("newest on entry").waitFor();
    await page.locator(".agent-detail-pending").waitFor({ state: "detached" });
    // Let any later scroll (a frame after the output settles) run.
    await page.clock.runFor(100);
    const shown = await page.evaluate(() => (globalThis as LogTestWindow).shownScroll);
    assert.equal(shown.length, 1, `${entry}: the page moved after it showed (${shown})`);
    assert.ok(shown[0]! > 0, `${entry}: the output is below the fold, so the page scrolls to it`);
    // The version's detail, where the output starts, is at the top of the window.
    const detail = await page.locator(".agent-version-detail").boundingBox();
    assert.ok(detail);
    assert.ok(Math.abs(detail.y) <= 1, `${entry}: detail at ${detail.y}`);
    assert.equal(await pane.evaluate(atBottom), true, entry);
  }
});

// A member's Agent page always has reads it is refused (native administration, runtime status).
// Any failed read made the view non-reusable, so Back rebuilt it: Follow switched off and every
// read, a fresh 200-line tail included, replayed (finding 1553). A refusal the view shows is now a
// settled answer. Back still checks what the view shows, and output whose access was revoked since
// is never painted from the cached view.
test("a member's Back reuses a followed Logs view, and not once log access is revoked", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [...earlierOutput(120), line(1, "member before leaving")];
  const { account: member, role: memberRole } = await logsMember(
    fixture,
    namespace,
    "runtime-member",
    ["read", "read_logs"],
  );
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revisionId}`,
    (route) => route.fulfill(succeededDeployment(namespace, agent, revisionId)),
  );
  // A paused clock keeps a follow read from being in flight when the member leaves.
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-30T12:00:01Z"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revisionId, "logs"),
    member.credentials,
  );
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("member before leaving").waitFor();
  // The member is refused runtime status and native administration, and the view says so.
  await page.getByText(/Runtime status requires Agent operate/).waitFor();
  await page.getByRole("button", { name: "Follow" }).click();
  computeDriver.state.lines = [...computeDriver.state.lines, line(2, "member first poll")];
  await page.clock.runFor(2_000);
  await pane.getByText("member first poll").waitFor();
  await waitForIdleFetches(page);
  const panel = await pane.elementHandle();
  const nativeAdminReads = () =>
    requests.filter(({ path }) => path.endsWith(`/agents/${agent.id}/native-admin`)).length;
  assert.equal(nativeAdminReads(), 1);
  const logPaths = () =>
    requests.filter(({ path }) => path.includes("/runtime/logs")).map(({ path }) => path);

  const leave = async () => {
    await page.getByRole("link", { name: "Namespaces", exact: true }).click();
    await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
    await waitForIdleFetches(page);
  };
  await leave();
  const readBeforeLeaving = new Set(logPaths());
  const logReadsBeforeLeaving = logPaths().length;
  computeDriver.state.lines = [...computeDriver.state.lines, line(3, "member after back")];
  await page.goBack();
  // The cached view comes back with Follow still on, and resumes from its cursor.
  await page
    .locator(".agent-logs button[aria-pressed='true']:enabled", { hasText: "Following" })
    .waitFor();
  assert.equal(await panel.evaluate((node) => node.isConnected), true);
  await pane.getByText("member after back").waitFor();
  await waitForIdleFetches(page);
  const readAfterBack = logPaths().slice(logReadsBeforeLeaving);
  assert.deepEqual(
    readAfterBack.filter((path) => readBeforeLeaving.has(path) || path.includes("tailLines")),
    [],
  );
  // The remembered refusal is not asked again (each one is an audited denial).
  assert.equal(nativeAdminReads(), 1);

  // Log access is revoked while the member is away: Back must not paint the cached output.
  await leave();
  memberRole.permissions = memberRole.permissions.filter(
    ({ action, resourceKind }) => !(resourceKind === "agent" && action === "read_logs"),
  );
  const wasPainted = await watchPainted(page, { text: "member before leaving" });
  await page.goBack();
  await page.getByText(/Log text requires Agent read_logs/).waitFor();
  assert.equal(await wasPainted(), false);
  assert.equal(await panel.evaluate((node) => node.isConnected), false);
  assert.equal(await pane.getByText("member before leaving").count(), 0);
});

// Marks the Agent view node, so a test can tell a remounted retained view from a rebuilt one.
const tagView = (page: Page) =>
  page.evaluate(() => {
    globalThis.document.querySelector<HTMLElement>(
      '.content [aria-live="polite"]',
    )!.dataset.navTag = "kept";
  });
const viewKept = (page: Page) =>
  page.evaluate(
    () =>
      globalThis.document.querySelector<HTMLElement>('.content [aria-live="polite"]')?.dataset
        .navTag === "kept",
  );

// Back's check covers runtime status and the version's saved snapshot as well: once either is
// refused, the cached view is not mounted again (finding 1553).
test("Back rebuilds an Agent view whose runtime status or version read was refused since", async (t) => {
  const { fixture, computeDriver, namespace, agent, revisionId } = await logsFixture(t);
  computeDriver.state.lines = [line(1, "operator output")];
  const { account: operator, role: operatorRole } = await logsMember(
    fixture,
    namespace,
    "runtime-operator",
    ["read", "operate", "read_logs"],
  );
  const revoke = (kind: Permission["resourceKind"], revoked: PermissionAction) => {
    operatorRole.permissions = operatorRole.permissions.filter(
      ({ action, resourceKind }) => !(resourceKind === kind && action === revoked),
    );
  };
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revisionId}`,
    (route) => route.fulfill(succeededDeployment(namespace, agent, revisionId)),
  );
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-30T12:00:01Z"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revisionId, "logs"),
    operator.credentials,
  );
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("operator output").waitFor();
  await page.locator(".runtime-pod").first().waitFor();
  // The Logs tab settles a frame after its output shows; only a settled page is retained.
  await page.clock.runFor(100);
  const leave = async () => {
    await waitForIdleFetches(page);
    await tagView(page);
    await page.getByRole("link", { name: "Namespaces", exact: true }).click();
    await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
    await waitForIdleFetches(page);
  };

  // Unchanged access: Back mounts the same view.
  await leave();
  await page.goBack();
  await pane.getByText("operator output").waitFor();
  assert.equal(await viewKept(page), true);

  // Runtime status refused since (its operate grant also changes the Agent's permission answer):
  // the cached Pod cards are never mounted again.
  await leave();
  revoke("agent", "operate");
  const wasPainted = await watchPainted(page, { selector: ".runtime-pod" });
  await page.goBack();
  await page.getByText(/Runtime status requires Agent operate/).waitFor();
  await pane.getByText("operator output").waitFor();
  assert.equal(await viewKept(page), false);
  assert.equal(await wasPainted(), false);

  // The version's saved snapshot refused since: Back rebuilds the page.
  await leave();
  revoke("agent_revision", "read");
  await page.goBack();
  await page.getByText(/you cannot read this version/).waitFor();
  assert.equal(await viewKept(page), false);
});

// A member with `agentPermissions` on the Agent, plus read on its Namespace, Configuration and
// versions. Tests change `role.permissions` to grant or revoke while the page is open.
async function logsMember(
  fixture: ConsoleFixture,
  namespace: NamespaceWire,
  name: string,
  agentPermissions: PermissionAction[],
) {
  let role: FixtureRole | undefined;
  const account = await fixture.createAccountWithPolicy(name, (principal: { id: string }) => {
    ({ role } = grantRole(fixture.policy, principal.id, {
      id: `role-${name}`,
      bindingId: `binding-${name}`,
      namespaceId: namespace.id,
      resource: undefined,
      permissions: {
        namespace: ["read"],
        agent: agentPermissions,
        configuration: ["read"],
        agent_revision: ["read"],
      },
    }));
  });
  assert.ok(role, "created the log reader role");
  return { account, role };
}

const changeGrant = (role: FixtureRole, action: PermissionAction, granted: boolean) => {
  const others = role.permissions.filter(
    (permission) => !(permission.resourceKind === "agent" && permission.action === action),
  );
  role.permissions = granted ? [...others, { resourceKind: "agent", action }] : others;
};

// Opens the version's Logs tab (or `tab`) on a paused clock. The deployment read answers with
// `deployment.response`, a recorded result by default, which keeps the view cacheable for Back.
async function openRetainedLogs(
  t: TestContext,
  { fixture, namespace, agent, revisionId }: Awaited<ReturnType<typeof logsFixture>>,
  credentials = fixture.credentials,
  { tab = "logs", firstDeployment = succeededDeployment(namespace, agent, revisionId) } = {},
) {
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  const deployment = { response: firstDeployment };
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revisionId}`,
    (route) => route.fulfill(deployment.response),
  );
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-30T12:00:01Z"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revisionId, tab),
    credentials,
  );
  const leave = async () => {
    await waitForIdleFetches(page);
    // The Logs tab settles a frame after its output shows; only a settled page is retained.
    await page.clock.runFor(100);
    await waitForIdleFetches(page);
    await tagView(page);
    await page.getByRole("link", { name: "Namespaces", exact: true }).click();
    await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
    await waitForIdleFetches(page);
  };
  return { page, requests, deployment, leave };
}

// Record if the text or element appears at any point after this call. Checking only the final
// DOM would miss the Console briefly restoring revoked output from a cached view.
async function watchPainted(page: Page, target: { text: string } | { selector: string }) {
  const observation = await page.evaluateHandle((target) => {
    let painted = false;
    const text = "text" in target;
    const observer = new MutationObserver(() => {
      painted ||= text
        ? document.body.textContent.includes(target.text)
        : document.querySelector(target.selector) !== null;
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: text,
      attributes: !text,
    });
    return () => {
      observer.disconnect();
      return painted;
    };
  }, target);
  return async () => {
    try {
      return await observation.evaluate((read) => read());
    } finally {
      await observation.dispose();
    }
  };
}

const refusedRoute = (status: number) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ error: { code: status === 403 ? "FORBIDDEN" : "NOT_FOUND" } }),
});

// A follow poll refused on the page drops the output read before the refusal, and Back
// rebuilds the view rather than mount it again (findings 1562, 1565).
test("a refused follow poll clears the shown output, and Back rebuilds the view", async (t) => {
  const logs = await logsFixture(t);
  logs.computeDriver.state.lines = [line(1, "read before revoke")];
  const { account, role } = await logsMember(logs.fixture, logs.namespace, "refused-poll", [
    "read",
    "read_logs",
  ]);
  const { page, requests, leave } = await openRetainedLogs(t, logs, account.credentials);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("read before revoke").waitFor();
  await page.getByText(/Showing gateway in/).waitFor();
  await page.getByRole("button", { name: "Follow" }).click();
  changeGrant(role, "read_logs", false);
  await page.clock.runFor(2_000);
  await page.getByText(/Log text requires Agent read_logs/).waitFor();
  assert.equal(await page.getByText("read before revoke").count(), 0);
  assert.equal(await pane.locator(":scope > *").count(), 0);
  assert.equal(await page.getByText(/Showing gateway in/).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Follow" }).isDisabled(), true);
  const logReads = () => logRequests(requests, logs.revisionId).length;
  const readsAfterRefusal = logReads();

  await leave();
  const wasPainted = await watchPainted(page, { text: "read before revoke" });
  await page.goBack();
  await page.getByText(/Log text requires Agent read_logs/).waitFor();
  await waitForIdleFetches(page);
  assert.equal(await viewKept(page), false);
  assert.equal(await wasPainted(), false);
  // The refusal is remembered: neither Back's check nor the rebuilt view asks again.
  assert.equal(logReads(), readsAfterRefusal);
});

// Hold a real, authorized response in transit. The other read then gets a real 403 after
// read_logs is revoked; neither an old page nor an old download may undo that refusal.
for (const delayed of ["follow", "download"]) {
  test(`a log access refusal wins over a delayed successful ${delayed}`, async (t) => {
    const logs = await logsFixture(t);
    logs.computeDriver.state.lines = [line(1, "shown before revocation")];
    const { account, role } = await logsMember(logs.fixture, logs.namespace, `late-${delayed}`, [
      "read",
      "read_logs",
    ]);
    const { page, requests } = await openRetainedLogs(t, logs, account.credentials);
    const pane = page.getByRole("log", { name: "Runtime log output" });
    await pane.getByText("shown before revocation").waitFor();
    logs.computeDriver.state.lines.push(line(2, "authorized before revocation"));

    const follow = page.getByRole("button", { name: "Follow", exact: true });
    const download = page.getByRole("button", { name: "Download", exact: true });
    const startFollow = async () => {
      await follow.click();
      await page.clock.runFor(2_000);
    };
    const url =
      delayed === "follow" ? "**/runtime/logs?*cursor=*" : "**/runtime/logs?*download=true*";
    const held = await holdRequests(t, page, url, { once: true, afterServer: true });
    // Observe the download link click synchronously, without preventing it or relying on
    // when the browser reports a completed file. Do not count the user's Download button.
    await page.evaluate(() => {
      globalThis.document.addEventListener(
        "click",
        (event) => {
          if (
            event.target instanceof globalThis.HTMLAnchorElement &&
            event.target.hasAttribute("download")
          ) {
            globalThis.document.documentElement.dataset.logDownloaded = "true";
          }
        },
        true,
      );
    });
    if (delayed === "follow") {
      await startFollow();
    } else {
      await download.click();
    }
    await held.requested;

    changeGrant(role, "read_logs", false);
    const refusal = page.waitForResponse(
      (response) => response.url().includes("/runtime/logs?") && response.status() === 403,
    );
    if (delayed === "follow") {
      await download.click();
    } else {
      await startFollow();
    }
    await refusal;
    const denied = page.getByText(/Log text requires Agent read_logs/);
    await denied.waitFor();
    const arriving = page.waitForResponse(url);
    held.release();
    const ok = await arriving;
    assert.equal(ok.status(), 200);
    assert.match(await ok.text(), /authorized before revocation/);
    await waitForIdleFetches(page);

    assert.equal(
      await pane.locator(":scope > *").count(),
      0,
      "discard rows, including the delayed page",
    );
    assert.equal(
      await page.locator("[data-log-downloaded]").count(),
      0,
      "discard the delayed download",
    );
    assert.equal(await denied.isVisible(), true);
    assert.equal(await download.isDisabled(), true);
    const reads = logRequests(requests, logs.revisionId).length;
    await page.clock.runFor(4_000);
    assert.equal(logRequests(requests, logs.revisionId).length, reads, "do not retry the refusal");
  });
}

// Back checks runtime status itself, not only through the permission answer: a status read
// refused since, with that answer unchanged, keeps the cached Pod cards off screen. The answer
// still allows operate, so the refusal is not a lost grant: nothing asks again.
test("Back rebuilds a Logs view whose status read alone is refused since", async (t) => {
  const logs = await logsFixture(t);
  logs.computeDriver.state.lines = [line(1, "operator output")];
  const { account } = await logsMember(logs.fixture, logs.namespace, "status-refused", [
    "read",
    "operate",
    "read_logs",
  ]);
  const { page, leave } = await openRetainedLogs(t, logs, account.credentials);
  await page
    .getByRole("log", { name: "Runtime log output" })
    .getByText("operator output")
    .waitFor();
  await page.locator(".runtime-pod").first().waitFor();
  await leave();
  let refusals = 0;
  await page.route(
    `${logs.fixture.origin}/namespaces/${logs.namespace.id}/agents/${logs.agent.id}/deployments/${logs.revisionId}/runtime`,
    (route) => {
      refusals += 1;
      return route.fulfill(refusedRoute(403));
    },
  );
  const wasPainted = await watchPainted(page, { selector: ".runtime-pod" });
  await page.goBack();
  await page.getByText(/Runtime status requires Agent operate/).waitFor();
  await waitForIdleFetches(page);
  assert.equal(await viewKept(page), false);
  assert.equal(await wasPainted(), false);
  // Only Back's check asked: the rebuilt view takes its refusal.
  assert.equal(refusals, 1);
  await leave();
  await page.goBack();
  await page.getByText(/Runtime status requires Agent operate/).waitFor();
  await waitForIdleFetches(page);
  await page.clock.runFor(10_000);
  await waitForIdleFetches(page);
  assert.equal(refusals, 1);
});

// One revoke of a role holding both read_logs and operate cleared the refused output at once, but
// left the Pod cards under the log refusal until the next status poll refused, 1.4-3.8 s later
// (finding 1597). The log refusal now asks for status once at once, on no new timer; a first
// log read refused (log text never allowed) asks nothing more.
test("a follow poll refused with operate revoked too clears the Pod cards at once", async (t) => {
  const logs = await logsFixture(t);
  logs.computeDriver.state.lines = [line(1, "read before the revoke")];
  const { account, role } = await logsMember(logs.fixture, logs.namespace, "one-revoke", [
    "read",
    "operate",
    "read_logs",
  ]);
  const { page, requests } = await openRetainedLogs(t, logs, account.credentials);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("read before the revoke").waitFor();
  const pods = page.locator(".runtime-pod");
  await pods.first().waitFor();
  await page.getByRole("button", { name: "Follow" }).click();
  const statusReads = () =>
    requests.filter(({ path }) => path.endsWith(`/deployments/${logs.revisionId}/runtime`)).length;
  const before = statusReads();

  changeGrant(role, "read_logs", false);
  changeGrant(role, "operate", false);
  const statusRefused = page.waitForResponse(
    (response) => response.url().endsWith("/runtime") && response.status() === 403,
  );
  // Only the follow poll's timer runs, well short of the 10 s status poll.
  await page.clock.runFor(2_000);
  await page.getByText(/Log text requires Agent read_logs/).waitFor();
  await statusRefused;
  await page.getByText(/Runtime status requires Agent operate/).waitFor();
  await waitForIdleFetches(page);
  assert.equal(await pods.count(), 0, "the Pod cards clear with the log refusal");
  assert.equal(await pane.locator(":scope > *").count(), 0);
  assert.equal(statusReads(), before + 1);
  // The refusal is remembered: no status poll follows.
  await page.clock.runFor(20_000);
  await waitForIdleFetches(page);
  assert.equal(statusReads(), before + 1);
});

// A status read authorized before the revoke can answer after the log refusal. The refusal's
// own status read supersedes it, so its stale answer neither brings the Pod cards back after a
// refused status nor overrides a fresh one (finding 1597).
for (const { name, revoked, podsKept, staleFails = false } of [
  { name: "operate revoked too", revoked: ["read_logs", "operate"], podsKept: false },
  { name: "only read_logs revoked", revoked: ["read_logs"], podsKept: true },
  // A superseded failure is ignored too: no error over the fresh answer's Pod cards.
  {
    name: "only read_logs revoked, the stale read failing",
    revoked: ["read_logs"],
    podsKept: true,
    staleFails: true,
  },
] satisfies {
  name: string;
  revoked: PermissionAction[];
  podsKept: boolean;
  staleFails?: boolean;
}[]) {
  test(`a status read in flight at a log refusal yields to a fresh one: ${name}`, async (t) => {
    const logs = await logsFixture(t);
    logs.computeDriver.state.lines = [line(1, "read before the revoke")];
    const { account, role } = await logsMember(logs.fixture, logs.namespace, "stale-status", [
      "read",
      "operate",
      "read_logs",
    ]);
    const { page, requests } = await openRetainedLogs(t, logs, account.credentials);
    const pane = page.getByRole("log", { name: "Runtime log output" });
    await pane.getByText("read before the revoke").waitFor();
    const pods = page.locator(".runtime-pod");
    await pods.first().waitFor();
    await page.getByRole("button", { name: "Follow" }).click();
    const statusPath = `/deployments/${logs.revisionId}/runtime`;
    const statusReads = () => requests.filter(({ path }) => path.endsWith(statusPath)).length;
    // The next status poll is answered with the grants it was authorized under (or, in the
    // failing case, refused without reaching the server), then held.
    const stale = await holdRequests(t, page, `**${statusPath}`, {
      once: true,
      ...(staleFails
        ? {
            fulfill: {
              status: 504,
              contentType: "application/json",
              body: JSON.stringify({
                error: {
                  code: "RUNTIME_LOGS_TIMEOUT",
                  message: "The runtime status or log read timed out.",
                },
                meta: { requestId: "req_test_stale_status" },
              }),
            },
          }
        : { afterServer: true }),
    });
    await page.clock.runFor(10_000);
    await stale.requested;
    // The follow poll due at the same time settles first, so the next one is on the clock.
    await page.waitForFunction(() => (globalThis as LogTestWindow).inFlightFetchCount() === 1);
    const before = statusReads();

    for (const permission of revoked) {
      changeGrant(role, permission, false);
    }
    const fresh = page.waitForResponse(
      (response) =>
        response.url().endsWith(statusPath) && response.status() === (podsKept ? 200 : 403),
    );
    await page.clock.runFor(2_000);
    await page.getByText(/Log text requires Agent read_logs/).waitFor();
    await fresh;
    const arriving = page.waitForResponse(
      (response) =>
        response.url().endsWith(statusPath) && response.status() === (staleFails ? 504 : 200),
    );
    stale.release();
    await arriving;
    await waitForIdleFetches(page);
    assert.equal(await pane.locator(":scope > *").count(), 0);
    assert.equal(statusReads(), before + 1);
    if (podsKept) {
      assert.ok((await pods.count()) > 0, "a fresh status answer keeps the Pod cards");
      assert.equal(await page.getByText(/Runtime status requires Agent operate/).count(), 0);
      assert.equal(await page.getByText("The read timed out. Try again.").count(), 0);
    } else {
      assert.equal(await pods.count(), 0, "the stale answer does not bring the Pod cards back");
      await page.getByText(/Runtime status requires Agent operate/).waitFor();
    }
    // The fresh read alone schedules the next poll, one interval on; a refused status stops.
    await page.clock.runFor(9_000);
    await waitForIdleFetches(page);
    assert.equal(statusReads(), before + 1);
    await page.clock.runFor(1_000);
    await waitForIdleFetches(page);
    assert.equal(statusReads(), before + (podsKept ? 2 : 1));
  });
}

// Losing operate hides the last status, not log text the member still has permission to read.
test("a refused status poll clears the Pod details and keeps authorized log reads", async (t) => {
  const logs = await logsFixture(t);
  logs.computeDriver.state.lines = [line(1, "before losing operate")];
  const { account, role } = await logsMember(logs.fixture, logs.namespace, "lose-operate", [
    "read",
    "operate",
    "read_logs",
  ]);
  const { page, requests } = await openRetainedLogs(t, logs, account.credentials);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("before losing operate").waitFor();
  const pods = page.locator(".runtime-pod");
  await pods.first().waitFor();
  const reads = () => logRequests(requests, logs.revisionId);
  const initialReads = reads().length;

  changeGrant(role, "operate", false);
  const denied = page.waitForResponse(
    (response) => response.url().endsWith("/runtime") && response.status() === 403,
  );
  await page.clock.runFor(10_000);
  await denied;
  await page.getByText(/Runtime status requires Agent operate/).waitFor();
  await waitForIdleFetches(page);
  assert.equal(await pods.count(), 0, "do not keep showing the last authorized Pod status");
  assert.equal(await page.locator("#runtime-log-pod option").count(), 0);
  assert.equal(reads().length, initialReads, "a status denial must not spend a log read");

  logs.computeDriver.state.lines.push(line(2, "after losing operate"));
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await page.clock.runFor(2_000);
  await pane.getByText("after losing operate").waitFor();
  assert.equal(await pane.getByText("before losing operate").count(), 1, "keep the log cursor");
  const next = new URL(reads().at(-1)!.path, logs.fixture.origin).searchParams;
  assert.equal(next.has("pod"), false, "read logs without the old status-only Pod choice");
  assert.ok(next.get("cursor"));
});

// Back compares a read the view shows as refused or missing like data (finding 1553): an
// unchanged 404 keeps the view, a 403 granted since and a shown read refused since rebuild it
// (finding 1562). The Configuration tab keeps rate-limited runtime reads out of it.
test("Back keeps a view whose refusal is unchanged and rebuilds one granted or refused since", async (t) => {
  const logs = await logsFixture(t);
  const { page, deployment, leave } = await openRetainedLogs(t, logs, logs.fixture.credentials, {
    tab: "configuration",
    firstDeployment: refusedRoute(404),
  });
  const refresh = page.getByRole("button", { name: "Refresh deployment" });
  const back = async () => {
    await page.goBack();
    // A rebuilt page reveals once its first reads settle or the reveal wait passes.
    await waitForIdleFetches(page);
    await page.clock.runFor(2_000);
    await refresh.waitFor();
    await waitForIdleFetches(page);
    return viewKept(page);
  };
  await refresh.waitFor();

  // A missing deployment record is the read's answer, not a failure: Back reuses the view.
  await leave();
  assert.equal(await back(), true);

  // A refusal this tab does not remember is asked again: once granted, Back rebuilds.
  deployment.response = refusedRoute(403);
  await leave();
  assert.equal(await back(), false);
  await leave();
  deployment.response = succeededDeployment(logs.namespace, logs.agent, logs.revisionId);
  assert.equal(await back(), false);

  // A read refused after it showed data: Back rebuilds, even though the refusal still stands.
  deployment.response = refusedRoute(403);
  await refresh.click();
  await waitForIdleFetches(page);
  await leave();
  assert.equal(await back(), false);
});

// Log denials last for a sign-in, not for the tab. A status denial is asked once more when the
// permission answer allows operate again (finding 1563).
test("a restored operate grant shows status on Back, and a new sign-in asks for log text again", async (t) => {
  const logs = await logsFixture(t);
  logs.computeDriver.state.lines = [line(1, "granted output")];
  const { account, role } = await logsMember(logs.fixture, logs.namespace, "restored", ["read"]);
  const { page, requests, leave } = await openRetainedLogs(t, logs, account.credentials);
  await page.getByText(/Log text requires Agent read_logs/).waitFor();
  const statusReads = () =>
    requests.filter(({ path }) => path.endsWith(`/deployments/${logs.revisionId}/runtime`)).length;
  const logReads = () => logRequests(requests, logs.revisionId).length;
  const permissionReads = () =>
    requests.filter(({ path }) => path.endsWith(`/agents/${logs.agent.id}/permissions`)).length;
  assert.equal(statusReads(), 1);
  assert.equal(logReads(), 1);

  // Each Back that rebuilds the page reads the answer twice: Back's check and the page's own
  // read, which the rebuilt Logs view reuses while it is in flight.
  await leave();
  changeGrant(role, "operate", true);
  let permissionsBefore = permissionReads();
  await page.goBack();
  await page.locator(".runtime-pod").first().waitFor();
  await waitForIdleFetches(page);
  assert.equal(statusReads(), 2);
  assert.equal(permissionReads() - permissionsBefore, 2);
  // The permission answer has no read_logs bit, so the log text denial stands for this sign-in.
  assert.equal(logReads(), 1);
  await page.getByText(/Log text requires Agent read_logs/).waitFor();

  // Operate revoked: the status read is refused once, then remembered across Backs.
  await leave();
  changeGrant(role, "operate", false);
  permissionsBefore = permissionReads();
  await page.goBack();
  await page.getByText(/Runtime status requires Agent operate/).waitFor();
  await waitForIdleFetches(page);
  assert.equal(statusReads(), 3);
  assert.equal(permissionReads() - permissionsBefore, 2);
  // A kept view takes the answer Back's check read; it does not ask again.
  await leave();
  permissionsBefore = permissionReads();
  await page.goBack();
  await page.getByText(/Runtime status requires Agent operate/).waitFor();
  await waitForIdleFetches(page);
  assert.equal(statusReads(), 3);
  assert.equal(permissionReads() - permissionsBefore, 1);

  // Sign out and in again as the same member, without reloading the tab.
  changeGrant(role, "read_logs", true);
  await page.locator(".account-toggle").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByLabel("Email", { exact: true }).fill(account.credentials.email);
  await page.getByLabel("Password").fill(account.credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/console\/agents/);
  const url = detailUrl(logs.fixture, logs.namespace.id, logs.agent.id, logs.revisionId, "logs");
  await page.evaluate((target) => {
    globalThis.history.pushState(null, "", target);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  }, url.pathname + url.search);
  await page.getByRole("log", { name: "Runtime log output" }).getByText("granted output").waitFor();
  assert.equal(await page.getByText(/Log text requires Agent read_logs/).count(), 0);
});

// Switching tabs rebuilds Logs. A remembered status denial is compared with a fresh permission
// answer there, so an operate grant shows without a page rebuild; with nothing denied, the
// switch reads no permission answer (finding 1579).
test("a Logs tab rebuilt after an operate grant reads status again without a page rebuild", async (t) => {
  const logs = await logsFixture(t);
  const { account, role } = await logsMember(logs.fixture, logs.namespace, "regranted", [
    "read",
    "read_logs",
  ]);
  const { page, requests } = await openRetainedLogs(t, logs, account.credentials);
  await page.getByText(/Runtime status requires Agent operate/).waitFor();
  await waitForIdleFetches(page);
  const statusReads = () =>
    requests.filter(({ path }) => path.endsWith(`/deployments/${logs.revisionId}/runtime`)).length;
  const permissionReads = () =>
    requests.filter(({ path }) => path.endsWith(`/agents/${logs.agent.id}/permissions`)).length;
  const reopenLogs = async () => {
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
  };
  assert.equal(statusReads(), 1);

  changeGrant(role, "operate", true);
  await reopenLogs();
  await page.locator(".runtime-pod").first().waitFor();
  await waitForIdleFetches(page);
  assert.equal(statusReads(), 2);
  assert.equal(await page.getByText(/Runtime status requires Agent operate/).count(), 0);

  const permissionsBefore = permissionReads();
  await reopenLogs();
  await page.locator(".runtime-pod").first().waitFor();
  await waitForIdleFetches(page);
  assert.equal(statusReads(), 3);
  assert.equal(permissionReads(), permissionsBefore);
});

// The page read its answer before operate was revoked. The refusal is compared with a fresh
// answer, so it counts as a lost grant and a later grant shows status again.
test("a status refusal after a revocation the page did not read is asked again once granted", async (t) => {
  const logs = await logsFixture(t);
  const { account, role } = await logsMember(logs.fixture, logs.namespace, "revoked-unread", [
    "read",
    "operate",
    "read_logs",
  ]);
  const { page } = await openRetainedLogs(t, logs, account.credentials);
  await page.locator(".runtime-pod").first().waitFor();
  await waitForIdleFetches(page);
  const reopenLogs = async () => {
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
  };

  changeGrant(role, "operate", false);
  await reopenLogs();
  await page.getByText(/Runtime status requires Agent operate/).waitFor();
  await waitForIdleFetches(page);
  changeGrant(role, "operate", true);
  await reopenLogs();
  await page.locator(".runtime-pod").first().waitFor();
  assert.equal(await page.getByText(/Runtime status requires Agent operate/).count(), 0);
});

// A status refusal while the answer allows operate is not asked again on the page (a fresh
// answer that still allows operate changes nothing), but a new sign-in asks again.
test("a status refusal taken while operate is allowed is asked again after a new sign-in", async (t) => {
  const logs = await logsFixture(t);
  const { account } = await logsMember(logs.fixture, logs.namespace, "refused-with-operate", [
    "read",
    "operate",
    "read_logs",
  ]);
  const { page, requests } = await openRetainedLogs(t, logs, account.credentials);
  await page.locator(".runtime-pod").first().waitFor();
  await waitForIdleFetches(page);
  const statusPath = `/namespaces/${logs.namespace.id}/agents/${logs.agent.id}/deployments/${logs.revisionId}/runtime`;
  const statusReads = () => requests.filter(({ path }) => path === statusPath).length;
  const permissionReads = () =>
    requests.filter(({ path }) => path.endsWith(`/agents/${logs.agent.id}/permissions`)).length;
  const reopenLogs = async () => {
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
    await page.getByText(/Runtime status requires Agent operate/).waitFor();
    await waitForIdleFetches(page);
  };
  await page.route(`${logs.fixture.origin}${statusPath}`, (route) =>
    route.fulfill(refusedRoute(403)),
  );
  await reopenLogs();
  const refusedReads = statusReads();
  const permissionsBefore = permissionReads();
  await reopenLogs();
  assert.equal(statusReads(), refusedReads);
  assert.equal(permissionReads(), permissionsBefore + 1);

  await page.unroute(`${logs.fixture.origin}${statusPath}`);
  await page.locator(".account-toggle").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByLabel("Email", { exact: true }).fill(account.credentials.email);
  await page.getByLabel("Password").fill(account.credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/console\/agents/);
  const url = detailUrl(logs.fixture, logs.namespace.id, logs.agent.id, logs.revisionId, "logs");
  await page.evaluate((target) => {
    globalThis.history.pushState(null, "", target);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  }, url.pathname + url.search);
  await page.locator(".runtime-pod").first().waitFor();
  assert.equal(statusReads(), refusedReads + 1);
});

// An unfollowed view's Back check reads on from its cursor; the view shows that page instead
// of discarding an audited read (finding 1564).
test("Back shows the lines its check read in an unfollowed Logs view", async (t) => {
  const logs = await logsFixture(t);
  logs.computeDriver.state.lines = [line(1, "before leaving")];
  const { page, requests, leave } = await openRetainedLogs(t, logs, logs.fixture.credentials);
  const pane = page.getByRole("log", { name: "Runtime log output" });
  await pane.getByText("before leaving").waitFor();
  await leave();
  const logReads = () => logRequests(requests, logs.revisionId).length;
  const before = logReads();
  logs.computeDriver.state.lines = [...logs.computeDriver.state.lines, line(2, "while away")];
  await page.goBack();
  await pane.getByText("while away").waitFor();
  await waitForIdleFetches(page);
  assert.equal(await viewKept(page), true);
  assert.equal(logReads() - before, 1);
  assert.equal(await pane.getByText("before leaving").count(), 1);
});
