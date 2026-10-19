import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import {
  detailUrl,
  fileBrowser,
  login,
  nativeValues,
  newPage,
  repositoryCheckbox,
} from "./console-agents-browser-helpers.mjs";
import {
  createRepositoryLaunchFixture,
  openAdvancedSettings,
} from "./console-agents-test-support.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();
const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';
const widths = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

// The two rings the design tokens describe (--focus-ring at --focus-offset, and at
// --focus-offset-inset for rows and items inside a scroller), resolved through a probe so the
// test follows the tokens instead of copying their values.
const tokenRings = (page) =>
  page.evaluate(() => {
    const document = globalThis.document;
    const ring = (offset) => {
      const probe = document.createElement("div");
      probe.style.outline = "var(--focus-ring)";
      probe.style.outlineOffset = `var(${offset})`;
      document.body.append(probe);
      const style = globalThis.getComputedStyle(probe);
      const value = [
        style.outlineStyle,
        style.outlineWidth,
        style.outlineColor,
        style.outlineOffset,
      ];
      probe.remove();
      return value.join(" ");
    };
    return { outer: ring("--focus-offset"), inset: ring("--focus-offset-inset") };
  });

// The focused control, the ring drawn for it, and every scrolling ancestor that cuts into that
// ring. A borderless input's ring is drawn by its wrapper, so the ring belongs to the nearest
// element, the control or one of its two closest ancestors, that has an outline.
const focusedRing = (page) =>
  page.evaluate(() => {
    const document = globalThis.document;
    const focused = document.activeElement;
    if (!focused || focused === document.body) {
      return null;
    }
    const labelledBy = (focused.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const name = (
      focused.getAttribute("aria-label") ||
      labelledBy.trim() ||
      focused.labels?.[0]?.textContent ||
      focused.textContent ||
      focused.tagName
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
    let owner = focused;
    for (let depth = 0; owner && depth < 3; depth += 1) {
      if (globalThis.getComputedStyle(owner).outlineStyle !== "none") {
        break;
      }
      owner = owner.parentElement;
    }
    if (!owner || globalThis.getComputedStyle(owner).outlineStyle === "none") {
      return { name, ring: "none", clipped: [] };
    }
    const style = globalThis.getComputedStyle(owner);
    const ring = [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset];
    // The outline reaches offset + width past the border box; a scroller clips at its padding box.
    const reach = Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth);
    const box = owner.getBoundingClientRect();
    const clipped = [];
    for (
      let scroller = owner.parentElement;
      scroller && scroller !== document.documentElement;
      scroller = scroller.parentElement
    ) {
      const edge = globalThis.getComputedStyle(scroller);
      if (edge.overflowX === "visible" && edge.overflowY === "visible") {
        continue;
      }
      const rect = scroller.getBoundingClientRect();
      const cut = Math.max(
        rect.left + Number.parseFloat(edge.borderLeftWidth) - (box.left - reach),
        rect.top + Number.parseFloat(edge.borderTopWidth) - (box.top - reach),
        box.right + reach - (rect.right - Number.parseFloat(edge.borderRightWidth)),
        box.bottom + reach - (rect.bottom - Number.parseFloat(edge.borderBottomWidth)),
      );
      if (cut > 0.5) {
        clipped.push(`.${[...scroller.classList].join(".")} hides ${cut.toFixed(1)}px`);
      }
    }
    // A row that frames its focused control draws a second ring around the whole row.
    const frame = owner.parentElement?.closest(".repository-result");
    const frameStyle = frame ? globalThis.getComputedStyle(frame) : null;
    const framed = frameStyle
      ? [
          frameStyle.outlineStyle,
          frameStyle.outlineWidth,
          frameStyle.outlineColor,
          frameStyle.outlineOffset,
        ].join(" ")
      : undefined;
    return { name, ring: ring.join(" "), clipped, ...(frame ? { framed } : {}) };
  });

// Tab from the current focus until focus leaves the document (or `until` matches a stop), and
// record every stop.
async function tabStops(page, until = () => false) {
  const stops = [];
  for (let step = 0; step < 80; step += 1) {
    await page.keyboard.press("Tab");
    const stop = await focusedRing(page);
    if (stop === null) {
      return stops;
    }
    stops.push(stop);
    if (until(stop)) {
      return stops;
    }
  }
  assert.fail(`Tab never left the page: ${stops.map(({ name }) => name).join(", ")}`);
}

// Every stop draws one of the token rings, and no scroller hides any part of it.
async function assertVisibleRings(page, label, stops) {
  const { outer, inset } = await tokenRings(page);
  assert.match(outer, /^solid 3px rgb\(\d+, \d+, \d+\) 2px$/, "the tokens describe a visible ring");
  assert.match(
    inset,
    /^solid 3px rgb\(\d+, \d+, \d+\) -3px$/,
    "the inset ring sits just inside the edge",
  );
  const off = stops.filter(({ ring }) => ring !== outer && ring !== inset);
  assert.deepEqual(off, [], `${label}: every stop shows "${outer}" or "${inset}"`);
  const hidden = stops.filter(({ clipped }) => clipped.length > 0);
  assert.deepEqual(hidden, [], `${label}: no scroller hides part of a focus ring`);
}

function logLine(index) {
  const time = `2026-09-30T12:00:${String(index % 60).padStart(2, "0")}.000000001Z`;
  // Structured lines render as expandable rows whose summary takes focus.
  const raw =
    index % 3 === 0
      ? JSON.stringify({
          event: "runtime.startup_phase",
          phase: "config",
          outcome: "ok",
          ms: index,
        })
      : `plain output ${index}`;
  return { time, raw };
}

test("every keyboard stop on Agents, Agent detail, its logs and Create Agent shows an unclipped token ring", async (t) => {
  const computeDriver = createRuntimeLogComputeDriver();
  computeDriver.state.lines = Array.from({ length: 40 }, (_, index) => logLine(index));
  const fixture = await createConsoleAppFixture(t, {
    computeDriver,
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Focus ring", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Ring Agent", nativeValues("v1"));
  // An active version fills the version picker, a scrolling list beside the tabs.
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const detail = detailUrl(fixture, namespace.id, agent.id, active.revision.id);
  const logs = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "logs");
  const pages = [
    ["Agents", `/console/agents?namespace=${namespace.id}`, "link", "Ring Agent"],
    [
      "Agent detail",
      `${detail.pathname}${detail.search}`,
      "button",
      "View version v1, current version",
    ],
    ["Agent logs", `${logs.pathname}${logs.search}`, "log", "Runtime log output"],
    [
      "Create Agent",
      `/console/agents/new?namespace=${namespace.id}`,
      "button",
      "Start without Preset",
    ],
  ];
  for (const viewport of widths) {
    for (const [title, path, role, landmark] of pages) {
      const label = `${title} at ${viewport.width}`;
      // Each page gets its own tab: tabbing past the last stop leaves the window, and returning
      // to it rechecks the session, which could hold the next page inert under the first Tab.
      const { page } = await newPage(t, fixture, { browser, context: { viewport } });
      await login(page, fixture, path);
      await page.getByRole(role, { name: landmark, exact: true }).waitFor();
      await page.locator(settledView).waitFor();
      const stops = await tabStops(page);
      assert.ok(
        stops.some(({ name }) => name === landmark),
        `${label}: Tab reaches ${landmark} (${stops.map(({ name }) => name).join(", ")})`,
      );
      await assertVisibleRings(page, label, stops);
    }
  }
});

test("repository rows and the Slack people search on Create Agent show an unclipped token ring", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) =>
    ["app", "docs"].map((repositoryRef, index) => ({
      repositoryRef,
      repositoryId: String(1700 + index),
      repository: `example/${repositoryRef}`,
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    })),
  );
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  for (const viewport of widths) {
    const label = `Create Agent at ${viewport.width}`;
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start with default Preset" }).click();
    await repositoryCheckbox(page, "example/app").waitFor();
    // Each repository result draws its ring around the whole row for its borderless checkbox.
    await page.getByRole("heading", { level: 1 }).first().focus();
    const repositories = await tabStops(page, ({ name }) => name.includes("example/docs"));
    assert.ok(
      repositories.some(({ name }) => name.includes("example/app")),
      `${label}: Tab reaches example/app (${repositories.map(({ name }) => name).join(", ")})`,
    );
    await openAdvancedSettings(page);
    await page.getByLabel("Default plugin approvers mode").selectOption("chosen");
    // The people search input has no outline of its own; its chip field draws the ring.
    await page.getByLabel("Default plugin approvers mode").focus();
    const people = await tabStops(page, ({ name }) => name === "Default plugin approvers people");
    assert.equal(people.at(-1).name, "Default plugin approvers people");
    await assertVisibleRings(page, label, [...repositories, ...people]);
    // The 18 px checkbox alone is easy to miss, so its whole result row draws the inset ring.
    const { inset } = await tokenRings(page);
    const app = repositories.find(({ name }) => name.includes("example/app"));
    assert.equal(app.framed, inset, `${label}: the example/app row draws the inset ring`);
  }
});

test("every stop in the Configure plugins dialog shows an unclipped token ring", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Focus ring plugins", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Plugin ring Agent",
    nativeValues("plugin-ring", { harnessId: "codex" }),
    // No API key: Codex serves plugins only to ChatGPT logins.
    { executionMode: "dedicated", harnessAuth: null },
  );
  for (const viewport of widths) {
    const label = `Configure plugins at ${viewport.width}`;
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
    // Open it from the keyboard, so the control the dialog focuses first shows its ring too.
    await page.getByRole("button", { name: "Configure plugins", exact: true }).press("Enter");
    const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
    await dialog.getByRole("button", { name: "Linear", exact: true }).waitFor();
    const stops = [await focusedRing(page), ...(await tabStops(page))];
    for (const name of ["Search plugins", "Linear"]) {
      assert.ok(
        stops.some((stop) => stop.name === name),
        `${label}: Tab reaches ${name} (${stops.map((stop) => stop.name).join(", ")})`,
      );
    }
    await assertVisibleRings(page, label, stops);
  }
});

test("a permanently disabled button says not allowed, not busy", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Disabled cursor", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "API-key plugin Agent",
    nativeValues("api-key-cursor", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  assert.equal(agent.harnessAuth.method, "api_key");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog.getByText("Plugin browsing is unavailable with API-key authentication.").waitFor();
  // An API key can never browse the catalog, so Load plugins stays disabled: nothing is pending.
  const load = dialog.getByRole("button", { name: "Load plugins" });
  assert.equal(await load.isDisabled(), true);
  assert.deepEqual(
    await load.evaluate((node) => {
      const style = globalThis.getComputedStyle(node);
      return [style.cursor, style.opacity];
    }),
    ["not-allowed", "0.6"],
  );
});
