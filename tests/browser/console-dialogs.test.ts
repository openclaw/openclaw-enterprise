import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Page } from "playwright";

import { loadConsoleTheme } from "../../apps/controller/src/composition/console-theme.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import {
  consoleViewports,
  detailUrl,
  fileBrowser,
  hasFocus,
  login,
  nativeValues,
  newPage,
} from "./console-agents-browser-helpers.mjs";
import { openCreateSecretDialog } from "./console-agents-test-support.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

// The open modal dialog's chrome and box, read once its open animation has finished, and whether
// it holds focus.
const openDialog = (page: Page) =>
  page.evaluate(async () => {
    const document = globalThis.document;
    const dialog = document.querySelector("dialog:modal");
    if (!dialog) {
      throw new Error("Expected an open modal dialog");
    }
    await Promise.all(
      dialog
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
    const style = globalThis.getComputedStyle(dialog);
    const corners = (["TopLeft", "TopRight", "BottomRight", "BottomLeft"] as const).map(
      (corner) => style[`border${corner}Radius`],
    );
    const box = dialog.getBoundingClientRect();
    // The area a fixed box can cover: the window less any classic scrollbar gutter (finding 1520).
    const probe = document.createElement("div");
    probe.style.cssText = "position: fixed; inset: 0; visibility: hidden";
    document.body.append(probe);
    const area = probe.getBoundingClientRect();
    probe.remove();
    const viewport = { width: area.right, height: area.bottom };
    return {
      chrome: {
        backdrop: globalThis.getComputedStyle(dialog, "::backdrop").backgroundColor,
        shadow: style.boxShadow,
        radius: corners.slice(0, 2).join(" "),
        border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
      },
      clientWidth: document.documentElement.clientWidth,
      bottomRadius: corners.slice(2).join(" "),
      animation: `${style.animationName} ${style.animationDuration}`,
      box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      viewport,
      focusInside: dialog !== document.activeElement && dialog.contains(document.activeElement),
      actions: Array.from(dialog.querySelectorAll(".dialog-actions button"), (button) =>
        button.textContent.trim(),
      ),
    };
  });

test("Stop, Delete, Plugins, Slack and Secret dialogs share one chrome, become bottom sheets on a phone and return focus to their opener", async (t) => {
  // A transparent page background exposes a backdrop painted twice on the page but once in the gutter.
  const directory = await temporaryDirectory(t, "console-dialog-canvas-");
  await writeFile(
    join(directory, "theme.json"),
    JSON.stringify({ schemaVersion: 1, colors: { bg: "#f7f5f000" } }),
  );
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Dialog pattern", {
    consoleTheme: await loadConsoleTheme(directory),
  });
  const agent = await fixture.createAgent(namespace.id, "Dialog Agent", nativeValues("dialogs"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const slackAgent = await fixture.createAgent(
    namespace.id,
    "Slack Dialog Agent",
    nativeValues("slack-dialogs", {
      harnessId: "codex",
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
        },
      },
    }),
    { executionMode: "dedicated" },
  );
  const { page, artifacts } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 1440, height: 900 } },
  });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);

  const detail = (id: string, tab?: string) =>
    detailUrl(fixture, namespace.id, id, undefined, tab).href;
  // Each case loads its page, opens its dialog and returns the control that opened it.
  const cases = [
    {
      name: "stop",
      actions: ["Cancel", "Stop Agent"],
      async open() {
        await page.goto(detail(agent.id));
        const region = page.getByRole("region", { name: "Stop Agent", exact: true });
        const opener = region.getByRole("button", { name: "Stop Agent", exact: true });
        await opener.click();
        await page.getByRole("dialog", { name: "Stop this Agent?" }).waitFor();
        return opener;
      },
    },
    {
      name: "delete",
      actions: ["Cancel", "Permanently delete Agent"],
      async open() {
        await page.goto(detail(agent.id));
        const opener = page.getByRole("button", { name: "Delete Agent", exact: true });
        await opener.click();
        await page.getByRole("dialog", { name: "Delete Dialog Agent?" }).waitFor();
        return opener;
      },
    },
    {
      // Plugins has no confirming row: its Done button sits in the header.
      name: "plugins",
      actions: [],
      async open() {
        await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "plugins").href);
        const opener = page.getByRole("button", { name: "Configure plugins", exact: true });
        await opener.click();
        await page.getByRole("dialog", { name: "Configure plugins" }).waitFor();
        return opener;
      },
    },
    {
      name: "slack",
      actions: ["Cancel", "Save configuration"],
      async open() {
        await page.goto(detail(slackAgent.id, "channels"));
        const opener = page.getByRole("button", { name: "Edit Slack", exact: true });
        await opener.click();
        await page.getByRole("dialog", { name: "Edit Slack" }).waitFor();
        return opener;
      },
    },
    {
      name: "secret",
      actions: ["Cancel", "Create Secret"],
      async open() {
        await page.goto(
          new URL(`/console/agents/new?namespace=${namespace.id}`, fixture.origin).href,
        );
        await page.getByRole("button", { name: "Start without Preset" }).click();
        await openCreateSecretDialog(page, "API key Secret");
        await page.getByRole("dialog", { name: "Create model credential Secret" }).waitFor();
        return page.getByLabel("API key Secret", { exact: true });
      },
    },
  ] as const;

  const seen = new Map<string, Awaited<ReturnType<typeof openDialog>>>();
  for (const viewport of consoleViewports) {
    await page.setViewportSize(viewport);
    for (const { name, actions, open } of cases) {
      const opener = await open();
      const state = await openDialog(page);
      await page.screenshot({ path: join(artifacts, `dialog-${name}-${viewport.width}.png`) });
      seen.set(`${name} ${viewport.width}`, state);
      assert.equal(state.focusInside, true, `${name}: focus moves into the dialog`);
      // Every confirming dialog shares one action row: Cancel first, its confirming action last
      // (finding 1942: Delete kept the page's form-actions row).
      assert.deepEqual(state.actions, actions, `${name}: its .dialog-actions row`);
      // Escape keeps today's rule (it closes an idle dialog), and focus returns to the opener.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !globalThis.document.querySelector("dialog:modal"));
      assert.equal(await hasFocus(opener), true, `${name}: focus returns to its opener`);
    }
  }

  const desktop = cases.map(({ name }) => {
    const state = seen.get(`${name} 1440`);
    assert.ok(state, `${name} was measured at desktop width`);
    return [name, state] as const;
  });
  const first = seen.get("stop 1440");
  assert.ok(first, "Stop dialog was measured at desktop width");
  assert.notEqual(first.chrome.shadow, "none");
  assert.notEqual(first.chrome.backdrop, "rgba(0, 0, 0, 0)");
  assert.notEqual(first.chrome.radius, "0px 0px");
  for (const [name, state] of desktop) {
    assert.deepEqual(state.chrome, first.chrome, `${name} shares the Stop dialog's chrome at 1440`);
    assert.notEqual(state.bottomRadius, "0px 0px", `${name} is not a sheet at 1440`);
  }
  for (const [name, state] of desktop) {
    assert.equal(state.animation, "dialog-open 0.2s", `${name} opens with --duration-base`);
    const { box, viewport } = state;
    const gaps = [
      box.left,
      viewport.width - box.right,
      box.top,
      viewport.height - box.bottom,
    ] as const;
    if (name === "slack") {
      // The drawer floats --space-4 from the right, top and bottom edges.
      assert.deepEqual(gaps.slice(1).map(Math.round), [16, 16, 16], "the drawer is full height");
      assert.ok(gaps[0] > 16, "the drawer sits at the right edge");
    } else {
      assert.ok(Math.abs(gaps[0] - gaps[1]) <= 1, `${name} is centred`);
    }
  }
  for (const { name } of cases) {
    const phone = seen.get(`${name} 390`);
    assert.ok(phone, `${name} was measured at phone width`);
    // clientWidth excludes a real scrollbar, but not an unnecessarily reserved empty gutter.
    const { box, viewport, clientWidth, chrome, bottomRadius } = phone;
    assert.deepEqual(
      { left: box.left, right: box.right, bottom: Math.round(box.bottom) },
      { left: 0, right: clientWidth, bottom: viewport.height },
      `${name} is a full-width sheet on the bottom edge at 390`,
    );
    assert.ok(box.top > 0, `${name} leaves the page visible above the sheet`);
    if (name === "stop" || name === "delete") {
      assert.ok(box.top > viewport.height / 3, `${name} is only as tall as its content`);
    }
    assert.equal(chrome.radius, first.chrome.radius, `${name} keeps rounded top corners at 390`);
    assert.equal(bottomRadius, "0px 0px", `${name} has square bottom corners at 390`);
  }

  // A breakpoint change while a dialog is open does not replay its open animation.
  await page.setViewportSize({ width: 1440, height: 900 });
  await cases[2].open();
  await openDialog(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const replayed = await page
    .locator("dialog:modal")
    .evaluate((dialog) => dialog.getAnimations({ subtree: true }).length);
  assert.equal(replayed, 0, "resizing an open dialog to a phone does not restart its animation");
  await page.keyboard.press("Escape");

  // Reduced motion turns the open animation off.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await cases[0].open();
  assert.match((await openDialog(page)).animation, /^none /);

  // A short desktop page has an empty, stable scrollbar gutter outside the native backdrop.
  // Compare its actual paint to the adjacent canvas, without assuming a scrollbar width or colour.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${fixture.origin}/console/secrets?namespace=${namespace.id}`);
  const create = page.getByRole("button", { name: "Create Secret", exact: true });
  await create.click();
  const { viewport, clientWidth } = await openDialog(page);
  const pageHeight = await page.locator("html").evaluate((html) => html.scrollHeight);
  assert.equal(pageHeight, viewport.height, "the page has no vertical scrollbar");
  if (viewport.width < clientWidth) {
    const column = (x: number) =>
      page.screenshot({ clip: { x, y: 10, width: 1, height: 10 }, scale: "css" });
    const canvas = await column(viewport.width - 1);
    const gutter = await column(clientWidth - 1);
    assert.ok(gutter.equals(canvas), "the backdrop reaches across the empty scrollbar gutter");
  }
  await page.keyboard.press("Escape");
  assert.equal(await hasFocus(create), true);
});

// Where the open sheet and its actions sit against the visible area, once the visual viewport's
// resize has been handled and the layout has followed it.
const sheetInView = (page: Page) =>
  page.evaluate(async () => {
    const viewport = globalThis.visualViewport;
    await new Promise<void>((resolve) => globalThis.requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => globalThis.requestAnimationFrame(() => resolve()));
    const dialog = globalThis.document.querySelector("dialog:modal");
    if (!dialog || !viewport) {
      throw new Error("Expected a modal in a visual viewport");
    }
    const vertical = (node: Element) => {
      const { top, bottom } = node.getBoundingClientRect();
      return { top: Math.round(top), bottom: Math.round(bottom) };
    };
    const actions = Array.from(dialog.querySelectorAll(".dialog-actions button"));
    return {
      visible: {
        top: Math.round(viewport.offsetTop),
        bottom: Math.round(viewport.offsetTop + viewport.height),
      },
      sheet: vertical(dialog),
      actions: Object.fromEntries(
        actions.map((button) => [button.textContent.trim(), vertical(button)] as const),
      ),
    };
  });

// A phone's on-screen keyboard shrinks the visual viewport, not the layout viewport the sheet sat
// on the bottom of, so Cancel and Create Secret were under the keyboard while the Name field had
// focus (finding 1957). Headless Chromium shows no keyboard and cannot shrink only the visual
// viewport's height, so this shrinks it two ways: a pinch zoom (Chromium's own visual viewport,
// checked on the vertical axis only, since zoom also narrows it) and a keyboard-shaped visual
// viewport (the page's view of it replaced, its resize event dispatched by hand).
test("On a phone the Secret sheet keeps its actions in the visible area above the keyboard", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Dialog keyboard");
  const { page, artifacts } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 390, height: 844 } },
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await openCreateSecretDialog(page, "API key Secret");
  await page.getByRole("dialog", { name: "Create model credential Secret" }).waitFor();
  await openDialog(page);
  const nameField = page
    .getByRole("dialog", { name: "Create model credential Secret" })
    .getByRole("textbox", { name: "Name", exact: true });
  const expectInView = async (
    state: Awaited<ReturnType<typeof sheetInView>>,
    label: string,
    { actions = true } = {},
  ) => {
    assert.equal(await hasFocus(nameField), true, `${label}: Name keeps focus`);
    assert.deepEqual(Object.keys(state.actions), ["Cancel", "Create Secret"], label);
    assert.equal(state.sheet.bottom, state.visible.bottom, `${label}: the sheet's bottom edge`);
    assert.ok(state.sheet.top >= state.visible.top, `${label}: the sheet's top is hidden`);
    if (!actions) {
      return;
    }
    for (const [name, box] of Object.entries(state.actions)) {
      assert.ok(
        box.top >= state.visible.top && box.bottom <= state.visible.bottom,
        `${label}: ${name} at ${box.top}-${box.bottom} is outside ${state.visible.top}-${state.visible.bottom}`,
      );
    }
  };
  const resting = await sheetInView(page);
  assert.deepEqual(resting.visible, { top: 0, bottom: 844 });
  await expectInView(resting, "no keyboard");

  const cdp = await page.context().newCDPSession(page);
  async function zoomTo(pageScaleFactor: number) {
    const resize = await page.evaluateHandle(() => {
      const viewport = globalThis.visualViewport;
      if (!viewport) {
        throw new Error("Expected a visual viewport");
      }
      const resized = new Promise<void>((resolve) =>
        viewport.addEventListener("resize", () => resolve(), { once: true }),
      );
      return { resized };
    });
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor });
    await resize.evaluate(({ resized }) => resized);
    await resize.dispose();
  }
  await zoomTo(1.5);
  const zoomed = await sheetInView(page);
  assert.ok(zoomed.visible.bottom < 600, "the zoom shrank the visual viewport");
  await page.screenshot({ path: join(artifacts, "dialog-secret-390-zoomed.png") });
  await expectInView(zoomed, "zoomed");
  await zoomTo(1);
  await expectInView(await sheetInView(page), "zoom undone");

  // A 336 px keyboard: the visible area keeps its width and starts at the top (a resize). iOS may
  // then scroll it 120 px down the page (a scroll, as only its offset changes). Above a taller
  // keyboard, or a short area scrolled down, the whole sheet still fits the visible area and
  // scrolls inside it.
  const fakeVisible = (
    visible: Pick<VisualViewport, "height" | "offsetTop"> | null,
    event = "resize",
  ) =>
    page.evaluate(
      ({ visible, event }) => {
        const viewport = globalThis.visualViewport;
        if (!viewport) {
          throw new Error("Expected a visual viewport");
        }
        for (const key of ["height", "offsetTop"] as const) {
          if (visible) {
            Object.defineProperty(viewport, key, { configurable: true, get: () => visible[key] });
          } else {
            Reflect.deleteProperty(viewport, key);
          }
        }
        viewport.dispatchEvent(new Event(event));
      },
      { visible, event },
    );
  for (const [height, offsetTop, event] of [
    [508, 0, "resize"],
    [508, 120, "scroll"],
    [400, 0, "resize"],
    [300, 200, "resize"],
  ] as const) {
    await fakeVisible({ height, offsetTop }, event);
    const keyboard = await sheetInView(page);
    const label = `${height} px visible, ${offsetTop} px down`;
    assert.deepEqual(keyboard.visible, { top: offsetTop, bottom: offsetTop + height }, label);
    await expectInView(keyboard, label, { actions: height === 508 });
    if (offsetTop === 0 && height === 508) {
      await page.screenshot({ path: join(artifacts, "dialog-secret-390-keyboard.png") });
    }
  }
  await fakeVisible(null);
  const closed = await sheetInView(page);
  assert.deepEqual(closed.visible, { top: 0, bottom: 844 });
  await expectInView(closed, "keyboard closed");
});
