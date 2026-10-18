import assert from "node:assert/strict";
import test from "node:test";

import { fileBrowser, login, nativeValues, newPage } from "./console-agents-browser-helpers.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

// The ring the design tokens describe: --focus-ring at --focus-offset, or at
// --focus-offset-inset for rows and panes that opt in. Resolved through a probe so the test
// follows the tokens instead of copying their values.
const tokenRings = (page) =>
  page.evaluate(() => {
    const document = globalThis.document;
    const probe = document.createElement("div");
    probe.style.outline = "var(--focus-ring)";
    document.body.append(probe);
    const ring = (offset) => {
      probe.style.outlineOffset = `var(${offset})`;
      const style = globalThis.getComputedStyle(probe);
      return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset].join(
        " ",
      );
    };
    const rings = [ring("--focus-offset"), ring("--focus-offset-inset")];
    probe.remove();
    return rings;
  });

// The ring the focused control shows: its own outline, or the outline of the nearest wrapper
// that draws it for a borderless child.
const focusedRing = (page) =>
  page.evaluate(() => {
    const document = globalThis.document;
    const focused = document.activeElement;
    if (!focused || focused === document.body) {
      return null;
    }
    const name = (
      focused.getAttribute("aria-label") ||
      focused.textContent ||
      focused.getAttribute("name") ||
      focused.tagName
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
    for (let node = focused; node && node !== document.body; node = node.parentElement) {
      const style = globalThis.getComputedStyle(node);
      if (style.outlineStyle !== "none" && style.outlineWidth !== "0px") {
        const ring = [
          style.outlineStyle,
          style.outlineWidth,
          style.outlineColor,
          style.outlineOffset,
        ];
        return { name, ring: ring.join(" ") };
      }
    }
    return { name, ring: "none" };
  });

// Tab from the top of the page until focus leaves the document, and record every stop.
async function tabStops(page) {
  await page.evaluate(() => globalThis.document.activeElement?.blur());
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
  await fixture.createAgent(namespace.id, "Ring Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const agentLink = page.getByRole("link", { name: "Ring Agent" });
  await agentLink.waitFor();
  await page.getByText("Reading deployment…").first().waitFor({ state: "detached" });
  const [ring, insetRing] = await tokenRings(page);
  assert.match(ring, /^solid 3px rgb\(189, 69, 49\) 2px$/, "the tokens resolve to a visible ring");

  const pages = [
    ["Agents", "Ring Agent", async () => {}],
    [
      "Agent detail",
      "Edit Configuration",
      async () => {
        await agentLink.click();
        await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
      },
    ],
    [
      "Create Agent",
      "Start without Preset",
      async () => {
        await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
        await page.getByRole("heading", { name: "Create Agent" }).waitFor();
        await page.getByRole("button", { name: "Start without Preset" }).waitFor();
      },
    ],
  ];
  for (const [label, landmark, open] of pages) {
    await open();
    const stops = await tabStops(page);
    assert.ok(
      stops.some(({ name }) => name.includes(landmark)),
      `${label}: Tab reaches ${landmark} (${stops.map(({ name }) => name).join(", ")})`,
    );
    const off = stops.filter((stop) => stop.ring !== ring && stop.ring !== insetRing);
    assert.deepEqual(off, [], `${label}: every stop shows "${ring}" (or the inset ring)`);
  }
});
