import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  detailUrl,
  fileBrowser,
  login,
  nativeValues,
  newPage,
} from "./console-agents-browser-helpers.mjs";
import { openCreateSecretDialog } from "./console-agents-test-support.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();
const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';

// The open modal dialog's chrome and box, read once its open animation has finished, and whether
// it holds focus.
const openDialog = (page) =>
  page.evaluate(async () => {
    const document = globalThis.document;
    const dialog = document.querySelector("dialog:modal");
    if (!dialog) {
      return null;
    }
    await Promise.all(
      dialog
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
    const style = globalThis.getComputedStyle(dialog);
    const corners = ["TopLeft", "TopRight", "BottomRight", "BottomLeft"].map(
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
      bottomRadius: corners.slice(2).join(" "),
      animation: `${style.animationName} ${style.animationDuration}`,
      box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      viewport,
      focusInside: dialog !== document.activeElement && dialog.contains(document.activeElement),
    };
  });

const isFocused = (node) => node === node.ownerDocument.activeElement;

test("Stop, Delete, Plugins, Slack and Secret dialogs share one chrome, become bottom sheets on a phone and return focus to their opener", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Dialog pattern");
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

  const detail = (id, tab) => detailUrl(fixture, namespace.id, id, undefined, tab).href;
  // Each case loads its page, opens its dialog and returns the control that opened it.
  const cases = [
    {
      name: "stop",
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
      async open() {
        await page.goto(detail(agent.id));
        const opener = page.getByRole("button", { name: "Delete Agent", exact: true });
        await opener.click();
        await page.getByRole("dialog", { name: "Delete Dialog Agent?" }).waitFor();
        return opener;
      },
    },
    {
      name: "plugins",
      async open() {
        await page.goto(new URL(`/console/agents?namespace=${namespace.id}`, fixture.origin).href);
        await page.locator(settledView).waitFor();
        await page.evaluate(async () => {
          const { createPluginFields } = await import("/console/agents/plugin-fields.mjs");
          const input = globalThis.document.createElement("textarea");
          input.id = "dialog-pattern-plugins";
          input.value = "{}";
          const entries = [{ id: "alpha", name: "Alpha", tools: [] }];
          const fields = createPluginFields({
            input,
            catalog: { status: "ready", canLoad: true, entries },
          });
          globalThis.document.body.append(fields.section);
        });
        const opener = page.getByRole("button", { name: "Configure plugins", exact: true });
        await opener.click();
        await page.getByRole("dialog", { name: "Configure plugins" }).waitFor();
        return opener;
      },
    },
    {
      name: "slack",
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
  ];

  const seen = {};
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const { name, open } of cases) {
      const opener = await open();
      const state = await openDialog(page);
      assert.ok(state, `${name}: a modal dialog is open`);
      await page.screenshot({ path: join(artifacts, `dialog-${name}-${viewport.width}.png`) });
      seen[`${name} ${viewport.width}`] = state;
      assert.equal(state.focusInside, true, `${name}: focus moves into the dialog`);
      // Escape keeps today's rule (it closes an idle dialog), and focus returns to the opener.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !globalThis.document.querySelector("dialog:modal"));
      assert.equal(await opener.evaluate(isFocused), true, `${name}: focus returns to its opener`);
    }
  }

  const desktop = cases.map(({ name }) => [name, seen[`${name} 1440`]]);
  const [, first] = desktop[0];
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
    const gaps = [box.left, viewport.width - box.right, box.top, viewport.height - box.bottom];
    if (name === "slack") {
      // The drawer floats --space-4 from the right, top and bottom edges.
      assert.deepEqual(gaps.slice(1).map(Math.round), [16, 16, 16], "the drawer is full height");
      assert.ok(gaps[0] > 16, "the drawer sits at the right edge");
    } else {
      assert.ok(Math.abs(gaps[0] - gaps[1]) <= 1, `${name} is centred`);
    }
  }
  for (const { name } of cases) {
    const { box, viewport, chrome, bottomRadius } = seen[`${name} 390`];
    assert.deepEqual(
      { left: box.left, right: box.right, bottom: Math.round(box.bottom) },
      { left: 0, right: viewport.width, bottom: viewport.height },
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
  const replayed = await page.evaluate(
    () => globalThis.document.querySelector("dialog:modal").getAnimations({ subtree: true }).length,
  );
  assert.equal(replayed, 0, "resizing an open dialog to a phone does not restart its animation");
  await page.keyboard.press("Escape");

  // Reduced motion turns the open animation off.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await cases[0].open();
  assert.match((await openDialog(page)).animation, /^none /);
});
