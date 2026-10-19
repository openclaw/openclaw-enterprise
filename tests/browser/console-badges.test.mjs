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

// Status badges share one pattern (UX plan C4): a word or two of human copy in `.badge`, with a
// tone. The version list's "Current version" label read as "Currentversion" (audit 2.2), and the
// Credentials tab's Slack token states had their own chrome.

// One Chromium for the file; each test still gets its own context.
const browser = fileBrowser();

// A badge's words, tone and paint, and the gap to the element before it.
const badgeState = (locator) =>
  locator.evaluate((node) => {
    const style = globalThis.getComputedStyle(node);
    const before = node.previousElementSibling?.getBoundingClientRect();
    return {
      className: node.className,
      text: node.textContent,
      tone: node.dataset.tone ?? null,
      gap: before ? Math.round(node.getBoundingClientRect().left - before.right) : null,
      sameLine: before
        ? Math.abs(node.getBoundingClientRect().top - before.top) < before.height
        : null,
      tinted: style.backgroundColor !== "rgba(0, 0, 0, 0)",
    };
  });

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`the current version shows a Current badge after a visible space at ${viewport.width}px`, async (t) => {
    const { fixture, namespace } = await createReadyConsoleNamespace(t, "Version badge");
    const agent = await fixture.createAgent(namespace.id, "Badge Agent", nativeValues("badge"));
    await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
    const version = page.getByRole("button", {
      name: "View version v1, current version",
      exact: true,
    });
    await version.waitFor();
    const badge = version.locator(".badge");
    const state = await badgeState(badge);
    assert.deepEqual(
      { ...state, gap: state.gap >= 4 },
      {
        className: "badge",
        text: "Current",
        tone: "success",
        gap: true,
        sameLine: true,
        tinted: true,
      },
      `badge ${JSON.stringify(state)}`,
    );
    // Rendered text: the badge follows the version number after a space.
    assert.match(await version.innerText(), /^v1 Current\n/);
  });
}

// Each Slack token binding reads Bound or Missing in the shared badge, with a tone.
test("Credentials shows Slack token bindings as Bound and Missing badges", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Credential badges");
  const bot = await fixture.createSecret(namespace.id, "Badge bot token", "xoxb-badge");
  const agent = await fixture.createAgent(
    namespace.id,
    "Credential badges",
    nativeValues("channels", {
      harnessId: "codex",
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          channels: {},
        },
      },
    }),
    {
      executionMode: "dedicated",
      secretBindings: { SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } } },
    },
  );
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  const list = page.locator(".credential-status-list").filter({ hasText: "Slack bot token" });
  await list.waitFor();
  const status = (label) =>
    list.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]/span");
  for (const [label, text, tone] of [
    ["Slack app token", "Missing", "danger"],
    ["Slack bot token", "Bound", "success"],
  ]) {
    const state = await badgeState(status(label));
    assert.deepEqual(
      { className: state.className, text: state.text, tone: state.tone, tinted: state.tinted },
      { className: "badge", text, tone, tinted: true },
      label,
    );
  }
});

// Namespace rows are cards: the shared card surface, edge and radius.
test("Namespaces rows use the card pattern", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Card rows");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/namespaces?namespace=${namespace.id}`);
  const row = page
    .getByRole("list", { name: "Namespaces", exact: true })
    .getByRole("listitem")
    .filter({ hasText: namespace.id });
  await row.waitFor();
  assert.deepEqual(
    await row.evaluate((node) => {
      const style = globalThis.getComputedStyle(node);
      return {
        card: node.classList.contains("card"),
        radius: style.borderTopLeftRadius,
        padding: style.paddingTop,
        edge: style.borderTopWidth,
      };
    }),
    { card: true, radius: "14px", padding: "24px", edge: "1px" },
  );
  const { className, text, tone, tinted } = await badgeState(row.locator(".badge"));
  assert.deepEqual(
    { className, text, tone, tinted },
    { className: "badge", text: "Ready", tone: "success", tinted: true },
  );
});
