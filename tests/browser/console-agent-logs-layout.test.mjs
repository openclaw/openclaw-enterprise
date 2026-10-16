import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import { detailUrl, login, nativeValues, newPage } from "./console-agents-browser-helpers.mjs";

function line(second, raw) {
  return { time: `2026-09-30T12:00:${String(second).padStart(2, "0")}.000000001Z`, raw };
}

// Records layout shifts from the first paint, naming the elements that moved.
function recordLayoutShifts() {
  globalThis.__layoutShifts = [];
  new globalThis.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) {
        globalThis.__layoutShifts.push({
          value: entry.value,
          sources: entry.sources.map((source) => ({
            node: `${source.node?.nodeName}.${source.node?.className}`,
            text: source.node?.textContent?.slice(0, 40),
            from: [source.previousRect.y, source.previousRect.height],
            to: [source.currentRect.y, source.currentRect.height],
          })),
        });
      }
    }
  }).observe({ type: "layout-shift", buffered: true });
}

// Opening the Logs tab by URL scrolled to the log view before the runtime status strip above
// it had filled. The strip's Pod cards then pushed the output down, out of a phone screen:
// CLS 0.11-0.17 at desktop and 0.555 at 390x844 (finding 1413). At phone width the menu
// button's margin also collapsed through body and moved the whole page on every load.
test("opening the Logs tab by URL does not move the page", async (t) => {
  const computeDriver = createRuntimeLogComputeDriver();
  const fixture = await createConsoleAppFixture(t, {
    computeDriver,
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Steady logs", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Steady Logs Agent", nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  computeDriver.state.lines = Array.from({ length: 30 }, (_, index) =>
    line(index, `startup line ${index}`),
  );
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ]) {
    const { page } = await newPage(t, fixture, { context: { viewport } });
    // The runtime status read settles after the page has scrolled to the Logs tab, as on a
    // live cluster where it takes about a second.
    await page.route(
      `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${active.revision.id}/runtime`,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await route.continue().catch(() => {});
      },
    );
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await page.getByRole("link", { name: "Steady Logs Agent" }).waitFor();
    await page.addInitScript(recordLayoutShifts);
    // A full load, so no recent input excuses a shift.
    await page.goto(detailUrl(fixture, namespace.id, agent.id, active.revision.id, "logs").href);
    await page.getByText("startup line 29", { exact: false }).waitFor();
    await page.getByRole("heading", { name: "Version v1" }).waitFor();
    await page.evaluate(() => globalThis.document.fonts.ready);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const shifts = await page.evaluate(() => globalThis.__layoutShifts);
    const shift = shifts.reduce((sum, entry) => sum + entry.value, 0);
    t.diagnostic(`${viewport.width}x${viewport.height} shift ${shift}: ${JSON.stringify(shifts)}`);
    assert.ok(shift < 0.01, `${viewport.width}x${viewport.height} shift ${shift}`);
    // The output held back for the first reads still opens at its newest line.
    assert.ok(
      await page
        .getByRole("log", { name: "Runtime log output" })
        .evaluate((pane) => pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 24),
    );
  }
});
