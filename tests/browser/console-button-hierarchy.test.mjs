import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import {
  detailUrl,
  fileBrowser,
  holdRequests,
  login,
  nativeValues,
  newPage,
  persistedDeploymentError,
} from "./console-agents-browser-helpers.mjs";
import { openAdvancedSettings } from "./console-agents-test-support.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// The console's button hierarchy (UX plan C2): each view shows at most one primary action, a
// secondary button's edge is visible against its surface, and a button waiting on its own request
// says it is busy instead of looking permanently disabled (finding 1927).

// One Chromium for the file; each test still gets its own context.
const browser = fileBrowser();
const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';

// The visible controls painted as a primary action: filled with the accent, or with the strong
// text colour the Agent page's older black primary used. Counted by paint, not class, so an
// older class name or a page rule cannot hide a second primary.
const filledActions = (page) =>
  page.evaluate(() => {
    const document = globalThis.document;
    const resolve = (value) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = value;
      document.body.append(probe);
      const color = globalThis.getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    const fills = new Set([resolve("var(--color-accent)"), resolve("var(--color-text-strong)")]);
    return [...document.querySelectorAll("button, a, summary, [role='button']")]
      .filter((node) => {
        const style = globalThis.getComputedStyle(node);
        return (
          node.getClientRects().length > 0 &&
          style.visibility !== "hidden" &&
          fills.has(style.backgroundColor)
        );
      })
      .map((node) => node.textContent.trim().replace(/\s+/g, " "));
  });

// An Agent whose v1 serves while its v2 redeploy failed with DEPENDENCY_UNAVAILABLE.
async function failedRedeploy(t, fixture, namespace, page) {
  const agent = await fixture.createAgent(namespace.id, "Failed Agent", nativeValues("failed"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const failed = await fixture.deployAgent(namespace.id, agent.id);
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
            error: persistedDeploymentError("DEPENDENCY_UNAVAILABLE"),
            warnings: [],
            progress: null,
          },
          meta: { requestId: "req_test_button_hierarchy" },
        }),
      }),
  );
  return { agent, active };
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`Agents, Agent detail, Create Agent and Logs each show at most one primary action at ${size}`, async (t) => {
    const { fixture, namespace } = await createReadyConsoleNamespace(t, `Primary ${size}`, {
      computeDriver: createRuntimeLogComputeDriver(),
      agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
    });
    const draft = await fixture.createAgent(namespace.id, "Draft Agent", nativeValues("draft"));
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    const { agent: failed, active } = await failedRedeploy(t, fixture, namespace, page);
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);

    const views = [
      {
        name: "Agents",
        url: new URL(`/console/agents?namespace=${namespace.id}`, fixture.origin),
        ready: () => page.getByRole("link", { name: "Draft Agent" }).waitFor(),
        primary: "Create Agent",
      },
      {
        name: "Agent detail, draft",
        url: detailUrl(fixture, namespace.id, draft.id),
        ready: () => page.getByRole("button", { name: "Deploy new version" }).waitFor(),
        primary: "Deploy new version",
      },
      {
        name: "Agent detail, failed",
        url: detailUrl(fixture, namespace.id, failed.id),
        ready: () =>
          page
            .getByRole("region", { name: "Deployment needs attention" })
            .getByRole("link", { name: "Deploy again" })
            .waitFor(),
        primary: "Deploy again",
      },
      {
        // The failed version's recovery outranks the draft's own Deploy new version.
        name: "Agent detail, failed, draft",
        url: detailUrl(fixture, namespace.id, failed.id, "draft", "configuration"),
        ready: async () => {
          await page.getByRole("button", { name: "Deploy new version" }).waitFor();
          await page
            .getByRole("region", { name: "Deployment needs attention" })
            .getByRole("link", { name: "Deploy again" })
            .waitFor();
        },
        primary: "Deploy again",
      },
      {
        name: "Create Agent",
        url: new URL(`/console/agents/new?namespace=${namespace.id}`, fixture.origin),
        ready: async () => {
          await page.getByRole("button", { name: "Start without Preset", exact: true }).click();
          await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();
        },
        primary: "Create Agent",
      },
      {
        name: "Logs",
        url: detailUrl(fixture, namespace.id, failed.id, active.revision.id, "logs"),
        // Deploy again follows the recovery's own Configuration read.
        ready: async () => {
          await page.getByRole("button", { name: "Refresh logs" }).waitFor();
          await page
            .getByRole("region", { name: "Deployment needs attention" })
            .getByRole("link", { name: "Deploy again" })
            .waitFor();
        },
        primary: "Deploy again",
      },
    ];
    for (const view of views) {
      await page.goto(view.url.href);
      await view.ready();
      await page.locator(settledView).waitFor();
      // Park the pointer so no hover repaints a control.
      await page.mouse.move(0, 0);
      assert.deepEqual(await filledActions(page), [view.primary], view.name);
    }
    // The recovery's secondary link is a button of the same size as its primary, not bare text.
    const recovery = page.getByRole("region", { name: "Deployment needs attention" });
    const [primaryBox, secondaryBox] = await Promise.all(
      ["Deploy again", "Open v2 Logs"].map((name) =>
        recovery.getByRole("link", { name }).boundingBox(),
      ),
    );
    assert.equal(secondaryBox.height, primaryBox.height);
    assert.equal(
      await recovery
        .getByRole("link", { name: "Open v2 Logs" })
        .evaluate((link) => globalThis.getComputedStyle(link).textDecorationLine),
      "none",
    );
  });
}

// WCAG 2 contrast between two sRGB colours given as [r, g, b] in 0-255.
function contrast(a, b) {
  const luminance = (rgb) => {
    const [r, g, bl] = rgb.map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// A secondary button's own edge, its fill and the first opaque background behind it.
const edgeColours = (locator) =>
  locator.evaluate((node) => {
    const rgba = (value) => {
      const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number);
      return { rgb: [r, g, b], a };
    };
    let parent = node.parentElement;
    let behind = rgba(globalThis.getComputedStyle(parent).backgroundColor);
    while (behind.a < 1 && parent.parentElement) {
      parent = parent.parentElement;
      behind = rgba(globalThis.getComputedStyle(parent).backgroundColor);
    }
    const style = globalThis.getComputedStyle(node);
    return {
      edge: rgba(style.borderTopColor),
      fill: rgba(style.backgroundColor),
      behind: behind.a < 1 ? { rgb: [255, 255, 255], a: 1 } : behind,
      width: style.borderTopWidth,
    };
  });

// A secondary button is a white control on a white or near-white card, so its edge is what marks
// it as a control (WCAG 1.4.11). The old 1.27:1 line edge left a grey slab with no edge.
test("Secondary buttons have an edge of at least 3:1 against their fill and the surface behind", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Secondary edge", {
    computeDriver: createRuntimeLogComputeDriver(),
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  });
  const agent = await fixture.createAgent(namespace.id, "Edge Agent", nativeValues("edge"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);

  const checks = [
    [
      new URL(`/console/agents/new?namespace=${namespace.id}`, fixture.origin),
      "Start without Preset",
    ],
    [detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"), "Edit Configuration"],
    [detailUrl(fixture, namespace.id, agent.id, active.revision.id, "logs"), "Download"],
  ];
  for (const [url, name] of checks) {
    await page.goto(url.href);
    const control = page.getByRole("button", { name, exact: true });
    await control.waitFor();
    await page.locator(settledView).waitFor();
    await page.mouse.move(0, 0);
    const { edge, fill, behind, width } = await edgeColours(control);
    assert.equal(width, "1px", name);
    assert.equal(edge.a, 1, name);
    for (const [against, colour] of [
      ["fill", fill],
      ["surface", behind],
    ]) {
      const ratio = contrast(edge.rgb, colour.rgb);
      assert.ok(
        ratio >= 3,
        `${name}: edge ${edge.rgb} is ${ratio.toFixed(2)}:1 against its ${against}`,
      );
    }
  }
});

// The cursor and busy state a pending button shows while its request is held.
const busyState = (locator) =>
  locator.evaluate((node) => ({
    busy: node.getAttribute("aria-busy"),
    cursor: globalThis.getComputedStyle(node).cursor,
    disabled: node.disabled,
    text: node.textContent,
  }));

// Stopping…, Deleting… and Save while saving are disabled while their request runs; they are
// busy, not unavailable, so they say so and show the progress cursor (finding 1927).
test("Stop, Delete and Save Configuration show busy, not only disabled, while their request runs", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Busy buttons");
  const agent = await fixture.createAgent(namespace.id, "Busy Agent", nativeValues("busy"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const editable = await fixture.createAgent(namespace.id, "Saving Agent", nativeValues("save"));
  const { page } = await newPage(t, fixture, { browser });
  const path = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`;
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));

  const stop = await holdRequests(t, page, `${path}/stop`, { method: "POST", once: true });
  await page
    .getByRole("region", { name: "Stop Agent", exact: true })
    .getByRole("button", { name: "Stop Agent", exact: true })
    .click();
  const stopDialog = page.getByRole("dialog", { name: "Stop this Agent?" });
  await stopDialog.getByRole("button", { name: "Stop Agent", exact: true }).click();
  await stop.requested;
  assert.deepEqual(await busyState(stopDialog.getByRole("button", { name: "Stopping…" })), {
    busy: "true",
    cursor: "progress",
    disabled: true,
    text: "Stopping…",
  });
  stop.release();
  await stopDialog.waitFor({ state: "detached" });

  const remove = await holdRequests(t, page, path, { method: "DELETE", once: true });
  await page.getByRole("button", { name: "Delete Agent", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete Busy Agent?" });
  await deleteDialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  await remove.requested;
  assert.deepEqual(await busyState(deleteDialog.getByRole("button", { name: "Deleting…" })), {
    busy: "true",
    cursor: "progress",
    disabled: true,
    text: "Deleting…",
  });
  remove.release();
  await deleteDialog.waitFor({ state: "detached" });

  await page.goto(detailUrl(fixture, namespace.id, editable.id, "draft", "configuration").href);
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nativeValues("edited")));
  const save = page.getByRole("button", { name: "Save Configuration" });
  // Idle: available, and not busy.
  assert.equal(await save.getAttribute("aria-busy"), "false");
  const patch = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/configurations/${editable.configurationId}`,
    { method: "PATCH", once: true },
  );
  await save.click();
  await patch.requested;
  assert.deepEqual(await busyState(save), {
    busy: "true",
    cursor: "progress",
    disabled: true,
    text: "Save Configuration",
  });
  patch.release();
  await page.getByText("Configuration saved.", { exact: true }).waitFor();
});
