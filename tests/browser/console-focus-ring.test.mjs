import assert from "node:assert/strict";
import test from "node:test";

import {
  detailUrl,
  fileBrowser,
  login,
  nativeValues,
  newPage,
} from "./console-agents-browser-helpers.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();
const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';

// The ring the design tokens describe (--focus-ring at --focus-offset), resolved through a probe
// so the test follows the tokens instead of copying their values.
const tokenRing = (page) =>
  page.evaluate(() => {
    const document = globalThis.document;
    const probe = document.createElement("div");
    probe.style.outline = "var(--focus-ring)";
    probe.style.outlineOffset = "var(--focus-offset)";
    document.body.append(probe);
    const style = globalThis.getComputedStyle(probe);
    const ring = [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset];
    probe.remove();
    return ring.join(" ");
  });

// The focused control and the outline it draws itself.
const focusedRing = (page) =>
  page.evaluate(() => {
    const document = globalThis.document;
    const focused = document.activeElement;
    if (!focused || focused === document.body) {
      return null;
    }
    const name = (focused.getAttribute("aria-label") || focused.textContent || focused.tagName)
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
    const style = globalThis.getComputedStyle(focused);
    const ring = [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset];
    return { name, ring: ring.join(" ") };
  });

// Tab from the top of the page until focus leaves the document, and record every stop.
async function tabStops(page) {
  const stops = [];
  for (let step = 0; step < 60; step += 1) {
    await page.keyboard.press("Tab");
    const stop = await focusedRing(page);
    if (stop === null) {
      return stops;
    }
    stops.push(stop);
  }
  assert.fail(`Tab never left the page: ${stops.map(({ name }) => name).join(", ")}`);
}

test("every keyboard stop on Agents, Agent detail and Create Agent shows the token focus ring", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Focus ring");
  const agent = await fixture.createAgent(namespace.id, "Ring Agent", nativeValues("v1"));
  // Each page gets its own tab: tabbing past the last stop leaves the window, and returning to
  // it rechecks the session, which could hold the next page inert under the first Tab.
  const detail = detailUrl(fixture, namespace.id, agent.id);
  const pages = [
    ["Agents", `/console/agents?namespace=${namespace.id}`, "link", "Ring Agent"],
    ["Agent detail", `${detail.pathname}${detail.search}`, "button", "Edit Configuration"],
    [
      "Create Agent",
      `/console/agents/new?namespace=${namespace.id}`,
      "button",
      "Start without Preset",
    ],
  ];
  for (const [label, path, role, landmark] of pages) {
    const { page } = await newPage(t, fixture, { browser });
    await login(page, fixture, path);
    await page.getByRole(role, { name: landmark, exact: true }).waitFor();
    await page.locator(settledView).waitFor();
    const ring = await tokenRing(page);
    assert.match(
      ring,
      /^solid 3px rgb\(\d+, \d+, \d+\) 2px$/,
      "the tokens describe a visible ring",
    );
    const stops = await tabStops(page);
    assert.ok(
      stops.some(({ name }) => name === landmark),
      `${label}: Tab reaches ${landmark} (${stops.map(({ name }) => name).join(", ")})`,
    );
    const off = stops.filter((stop) => stop.ring !== ring);
    assert.deepEqual(off, [], `${label}: every stop shows "${ring}"`);
  }
});
