import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import {
  consoleViewports,
  detailUrl,
  fileBrowser,
  login,
  nativeValues,
  newPage,
  repositoryCheckbox,
  selectSecret,
  settledView,
} from "./console-agents-browser-helpers.mjs";
import {
  createRepositoryLaunchFixture,
  openAdvancedSettings,
} from "./console-agents-test-support.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

// The two rings the design tokens describe (--focus-ring at --focus-offset, and at
// --focus-offset-inset for rows and items inside a scroller), resolved through a probe so the
// test follows the tokens instead of copying their values.
const tokenRings = (page) =>
  page.evaluate(() => {
    const document = globalThis.document;
    const ring = (offset, inverse = false) => {
      const probe = document.createElement("div");
      probe.style.outline = "var(--focus-ring)";
      if (inverse) {
        probe.style.outlineColor = "var(--color-focus-inverse)";
      }
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
    return {
      outer: ring("--focus-offset"),
      inset: ring("--focus-offset-inset"),
      inverse: ring("--focus-offset", true),
    };
  });

// The rows that draw a second ring around their focused control, a small checkbox or radio, and
// the ring each draws.
const FRAMES = {
  ".repository-result": "inset",
  ".repository-option": "outer",
  ".repository-profile": "outer",
};

// The focused control, the ring drawn for it, and every scrolling ancestor that cuts into that
// ring. A borderless input's ring is drawn by its wrapper, so the ring belongs to the nearest
// element, the control or one of its two closest ancestors, that has an outline. `selector`
// measures an element that shows focus without holding it, such as an aria-activedescendant option.
const focusedRing = (page, selector = null) =>
  page.evaluate(
    ([selector, frameSelectors]) => {
      const document = globalThis.document;
      const focused = selector ? document.querySelector(selector) : document.activeElement;
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
      const tag = focused.getAttribute("role") === "tab" ? "tab" : focused.tagName.toLowerCase();
      let owner = focused;
      for (let depth = 0; owner && depth < 3; depth += 1) {
        if (globalThis.getComputedStyle(owner).outlineStyle !== "none") {
          break;
        }
        owner = owner.parentElement;
      }
      if (!owner || globalThis.getComputedStyle(owner).outlineStyle === "none") {
        return { name, tag, ring: "none", clipped: [], frames: [] };
      }
      const style = globalThis.getComputedStyle(owner);
      const ring = [
        style.outlineStyle,
        style.outlineWidth,
        style.outlineColor,
        style.outlineOffset,
      ];
      // The outline reaches offset + width past the border box; a scroller clips at its client box
      // (inside its borders and scrollbars). This walks DOM ancestors, which is right for everything
      // the test visits; a fixed or top-layer element would need its containing blocks instead.
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
        const left = rect.left + scroller.clientLeft;
        const top = rect.top + scroller.clientTop;
        // clientWidth and clientHeight round to whole pixels, so the far edges come from the
        // fractional box, less its borders and its (whole-pixel) scrollbars.
        const right = rect.right - Number.parseFloat(edge.borderRightWidth);
        const bottom = rect.bottom - Number.parseFloat(edge.borderBottomWidth);
        // A gap under 2px is the rounding alone: any real scrollbar is wider.
        const gapX = right - left - scroller.clientWidth;
        const gapY = bottom - top - scroller.clientHeight;
        const barWidth = gapX >= 2 ? Math.round(gapX) : 0;
        const barHeight = gapY >= 2 ? Math.round(gapY) : 0;
        const cutX = Math.max(left - (box.left - reach), box.right + reach - (right - barWidth));
        const cutY = Math.max(top - (box.top - reach), box.bottom + reach - (bottom - barHeight));
        // Scroll offsets snap to whole pixels, so a scrolled-to row can overhang its scroller by
        // a fraction of a pixel on the axis it was scrolled along; only a whole pixel or more
        // counts as hidden there. On an axis the scroller has not scrolled along the cut is
        // layout alone, and more than half a pixel of it shows when painted (finding 1977: a
        // 0.9px sideways cut passed).
        const hides = (cut, scrolled) => (scrolled ? cut >= 1 : cut > 0.5);
        for (const [axis, cut, scrolled] of [
          ["x", cutX, scroller.scrollLeft !== 0],
          ["y", cutY, scroller.scrollTop !== 0],
        ]) {
          if (hides(cut, scrolled)) {
            clipped.push(
              `.${[...scroller.classList].join(".")} hides ${cut.toFixed(1)}px (${axis})`,
            );
          }
        }
      }
      // Every other ring around the stop: an ancestor that draws an outline frames it. Only the
      // rows that frame a small control may, and the test names those (finding 1960).
      const frames = [];
      for (let node = owner.parentElement; node; node = node.parentElement) {
        const frameStyle = globalThis.getComputedStyle(node);
        if (frameStyle.outlineStyle !== "none") {
          frames.push({
            frame:
              frameSelectors.find((frame) => node.matches(frame)) ??
              `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`,
            ring: [
              frameStyle.outlineStyle,
              frameStyle.outlineWidth,
              frameStyle.outlineColor,
              frameStyle.outlineOffset,
            ].join(" "),
          });
        }
      }
      const inverse = owner.closest(".sidebar, .topbar, .dialog-header") && !owner.closest(".menu");
      return { name, tag, ring: ring.join(" "), inverse: Boolean(inverse), clipped, frames };
    },
    [selector, Object.keys(FRAMES)],
  );

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

// A computed ring as its style, width and offset (the colour sits between them).
function ringParts(ring) {
  const [style, width, ...rest] = ring.split(" ");
  return { style, width: Number.parseFloat(width), offset: Number.parseFloat(rest.at(-1)) };
}

// Every stop draws one of the token rings, and no scroller hides any part of it.
async function assertVisibleRings(page, label, stops) {
  const { outer, inset, inverse } = await tokenRings(page);
  const outerRing = ringParts(outer);
  const insetRing = ringParts(inset);
  assert.ok(
    outerRing.style === "solid" && outerRing.width >= 2 && outerRing.offset >= 0,
    `the tokens describe a visible ring outside the edge (${outer})`,
  );
  assert.ok(
    insetRing.style === "solid" && insetRing.width >= 2 && insetRing.offset + insetRing.width <= 0,
    `the inset ring sits inside the edge (${inset})`,
  );
  const off = stops.filter((stop) =>
    stop.inverse ? stop.ring !== inverse : stop.ring !== outer && stop.ring !== inset,
  );
  assert.deepEqual(off, [], `${label}: every stop shows the focus ring for its surface`);
  const hidden = stops.filter(({ clipped }) => clipped.length > 0);
  assert.deepEqual(hidden, [], `${label}: no scroller hides part of a focus ring`);
  // One ring per stop: a second ring comes only from a listed row frame, in its token ring.
  const rings = { outer, inset };
  const framed = stops.filter(({ frames }) =>
    frames.some(({ frame, ring }) => rings[FRAMES[frame]] !== ring),
  );
  assert.deepEqual(framed, [], `${label}: no stop has a second ring beyond its row's frame`);
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
  // Enough lines that the log pane scrolls at both widths.
  computeDriver.state.lines = Array.from({ length: 20 }, (_, index) => logLine(index));
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
    ["Agents", `/console/agents?namespace=${namespace.id}`, "link", "Ring Agent", "a"],
    [
      "Agent detail",
      `${detail.pathname}${detail.search}`,
      "button",
      "View version v1, current version",
      "button",
    ],
    // Log row summaries scroll the pane as focus reaches them.
    ["Agent logs", `${logs.pathname}${logs.search}`, "log", "Runtime log output", "summary"],
    [
      "Create Agent",
      `/console/agents/new?namespace=${namespace.id}`,
      "button",
      "Start without Preset",
      "button",
    ],
  ];
  for (const viewport of consoleViewports) {
    for (const [title, path, role, landmark, tag] of pages) {
      const label = `${title} at ${viewport.width}`;
      // Each page gets its own tab: tabbing past the last stop leaves the window, and returning
      // to it rechecks the session, which could hold the next page inert under the first Tab.
      const { page } = await newPage(t, fixture, { browser, context: { viewport } });
      await login(page, fixture, path);
      await page.getByRole(role, { name: landmark, exact: true }).waitFor();
      await page.locator(settledView).waitFor();
      await page.locator(settledView).locator(`${tag}:visible`).first().waitFor();
      const stops = await tabStops(page);
      assert.ok(
        stops.some(({ name }) => name === landmark),
        `${label}: Tab reaches ${landmark} (${stops.map(({ name }) => name).join(", ")})`,
      );
      assert.ok(
        stops.some((stop) => stop.tag === tag),
        `${label}: Tab reaches a ${tag}`,
      );
      await assertVisibleRings(page, label, stops);
    }
  }
});

test("arrowing through the Agent tabs at 390 px keeps each tab and its ring clear of the strip's edges", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Focus ring tabs");
  const agent = await fixture.createAgent(namespace.id, "Tab ring Agent", nativeValues("v1"));
  const detail = detailUrl(fixture, namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 390, height: 844 } },
  });
  await login(page, fixture, `${detail.pathname}${detail.search}`);
  await page.locator(settledView).waitFor();
  const count = await page.getByRole("tab").count();
  // The strip is one Tab stop; the arrows move through the rest.
  const stops = await tabStops(page, ({ tag }) => tag === "tab");
  for (let step = 1; step < count; step += 1) {
    await page.keyboard.press("ArrowRight");
    stops.push(await focusedRing(page));
  }
  assert.equal(
    new Set(stops.filter(({ tag }) => tag === "tab").map(({ name }) => name)).size,
    count,
  );
  await assertVisibleRings(page, "Agent tabs at 390", stops);
  // Back at the far end, arrowing again wraps to the first tab. Every arrowed-to tab sits clear
  // of the faded edges too, once the strip's scroll has settled the fades.
  const faded = [];
  for (let step = 0; step < count; step += 1) {
    await page.keyboard.press("ArrowRight");
    const tab = await page.evaluate(async () => {
      await new Promise((resolve) => {
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve));
      });
      const focused = globalThis.document.activeElement;
      const strip = focused.closest('[role="tablist"]');
      const style = globalThis.getComputedStyle(strip);
      const before = Number.parseFloat(style.getPropertyValue("--agent-tabs-fade-before")) || 0;
      const after = Number.parseFloat(style.getPropertyValue("--agent-tabs-fade-after")) || 0;
      const box = focused.getBoundingClientRect();
      const edge = strip.getBoundingClientRect();
      const under = Math.max(edge.left + before - box.left, box.right - (edge.right - after));
      return { name: focused.textContent.trim(), under: Math.round(under) };
    });
    if (tab.under > 0) {
      faded.push(tab);
    }
  }
  assert.deepEqual(faded, [], "no arrowed-to tab sits under a faded edge");
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
  const bot = await fixture.createSecret(namespace.id, "Search bot", "synthetic-slack-token");
  for (const viewport of consoleViewports) {
    const label = `Create Agent at ${viewport.width}`;
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    // Only the provider directory is simulated: one person matches any search.
    await page.route(
      `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              workspaceId: "TTEST123",
              workspaceName: "Test workspace",
              candidates: [{ id: "UTEST123", name: "freeman", displayName: "Freeman Example" }],
              complete: true,
            },
            meta: { requestId: "req_00000000-0000-4000-8000-000000001963" },
          }),
        }),
    );
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
    // A selected repository's access options frame their checkbox and radios with the outer
    // ring (finding 1960).
    await repositoryCheckbox(page, "example/app").check();
    const toggle = page.getByRole("button", { name: "Access for example/app", exact: true });
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true", `${label}: access is open`);
    await toggle.focus();
    const access = await tabStops(page, ({ name }) => name === "Use Agent default");
    // Customizing the access adds the profile radios after the checkbox.
    await page.keyboard.press("Space");
    await page
      .getByRole("group", { name: "Access for example/app", exact: true })
      .locator(".repository-profile input")
      .first()
      .waitFor();
    access.push(
      ...(await tabStops(page, ({ frames }) =>
        frames.some(({ frame }) => frame === ".repository-profile"),
      )),
    );
    const accessFrames = access.flatMap(({ frames }) => frames.map(({ frame }) => frame));
    for (const frame of [".repository-option", ".repository-profile"]) {
      assert.ok(
        accessFrames.includes(frame),
        `${label}: an access option is framed by ${frame} (${JSON.stringify(access)})`,
      );
    }
    await openAdvancedSettings(page);
    await page.getByLabel("Default plugin approvers mode").selectOption("chosen");
    // The people search input has no outline of its own; its chip field draws the ring.
    await page.getByLabel("Default plugin approvers mode").focus();
    const people = await tabStops(page, ({ name }) => name === "Default plugin approvers people");
    assert.equal(people.at(-1).name, "Default plugin approvers people");
    await assertVisibleRings(page, label, [...repositories, ...access, ...people]);
    // The 18 px checkbox alone is easy to miss, so its whole result row draws the inset ring.
    const { inset } = await tokenRings(page);
    const app = repositories.find(({ name }) => name.includes("example/app"));
    assert.deepEqual(
      app.frames,
      [{ frame: ".repository-result", ring: inset }],
      `${label}: the example/app row draws the inset ring`,
    );
    // The arrowed-to result keeps focus in the search input, so measure the active option itself
    // against its results scroller (finding 1963).
    await selectSecret(page, "Slack bot token Secret for people search", bot);
    const search = page.getByRole("combobox", {
      name: "Default plugin approvers people",
      exact: true,
    });
    await search.fill("free");
    await page.getByRole("option", { name: /Freeman Example/ }).waitFor();
    await search.press("ArrowDown");
    const result = await focusedRing(page, ".slack-directory-result.active");
    assert.match(result?.name ?? "", /Freeman Example/, `${label}: ArrowDown activates a result`);
    assert.equal(result.ring, inset, `${label}: the active result draws the inset ring`);
    await assertVisibleRings(page, `${label} people results`, [result]);
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
  for (const viewport of consoleViewports) {
    const label = `Configure plugins at ${viewport.width}`;
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
    // Open it from the keyboard, so the control the dialog focuses first shows its ring too.
    await page.getByRole("button", { name: "Configure plugins", exact: true }).press("Enter");
    const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
    await dialog.getByRole("button", { name: "Linear", exact: true }).waitFor();
    // Walk the settled dialog, so a slow run and a fast one measure the same layout. Only the
    // dialog's own open animation: a spinner inside it never finishes.
    await dialog.evaluate(async (node) => {
      await Promise.all(node.getAnimations().map((animation) => animation.finished));
    });
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
