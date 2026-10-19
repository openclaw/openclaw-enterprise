import assert from "node:assert/strict";
import test from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  detailUrl,
  fileBrowser,
  login,
  nativeValues,
  newPage,
} from "./console-agents-browser-helpers.mjs";

// Errors, warnings and notices share one status block (UX plan C1): a stripe and wash in the
// tone's design-token colours, with the text in the body colour. A refusal after a request takes
// focus and comes into view; Share Agent left its refusal unfocused above the form, so a reader
// at phone width heard nothing (findings 1862, 1864).

// One Chromium for the file; each test still gets its own context.
const browser = fileBrowser();

// A status block's tone, whether its stripe and wash are the tone's tokens, and the contrast of
// its text with the wash laid over the surface beneath it.
const statusPaint = (locator) =>
  locator.evaluate((node) => {
    const view = globalThis;
    const tokenColor = (name, property = "color") => {
      const probe = globalThis.document.createElement("span");
      probe.style[property] = `var(--color-${name})`;
      globalThis.document.body.append(probe);
      const value = view.getComputedStyle(probe)[property];
      probe.remove();
      return value;
    };
    const rgba = (value) => {
      const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number);
      return { r, g, b, a };
    };
    // The wash is translucent: lay each background over the one beneath until an opaque one.
    const layers = [];
    for (let at = node; at; at = at.parentElement) {
      const color = rgba(view.getComputedStyle(at).backgroundColor);
      if (color.a > 0) {
        layers.push(color);
        if (color.a === 1) {
          break;
        }
      }
    }
    const backdrop = layers.reverse().reduce(
      (below, above) => ({
        r: above.r * above.a + below.r * (1 - above.a),
        g: above.g * above.a + below.g * (1 - above.a),
        b: above.b * above.a + below.b * (1 - above.a),
      }),
      { r: 255, g: 255, b: 255 },
    );
    const luminance = ({ r, g, b }) => {
      const [lr, lg, lb] = [r, g, b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    const contrast = (color) => {
      const [light, dark] = [luminance(color), luminance(backdrop)].sort((a, b) => b - a);
      return (light + 0.05) / (dark + 0.05);
    };
    const style = view.getComputedStyle(node);
    const tone = node.dataset.tone;
    return {
      status: node.classList.contains("status"),
      tone,
      stripe: style.borderLeftColor === tokenColor(tone) && style.borderLeftWidth === "3px",
      wash: style.backgroundColor === tokenColor(`${tone}-subtle`, "backgroundColor"),
      bodyText: style.color === tokenColor("text"),
      contrast: Math.round(contrast(rgba(style.color)) * 100) / 100,
    };
  });

function assertPaint(paint, tone, label) {
  assert.deepEqual(
    { ...paint, contrast: paint.contrast >= 4.5 },
    { status: true, tone, stripe: true, wash: true, bodyText: true, contrast: true },
    `${label}: ${JSON.stringify(paint)}`,
  );
}

// Whether a refusal has focus and is on screen.
const refusalView = (locator) =>
  locator.evaluate((node) => {
    const { top, bottom } = node.getBoundingClientRect();
    return {
      focused: globalThis.document.activeElement === node,
      // Sub-pixel layout can end the block a fraction past the viewport it was aligned to.
      inView: top >= -1 && top < globalThis.innerHeight && bottom <= globalThis.innerHeight + 1,
      rect: [Math.round(top), Math.round(bottom), globalThis.innerHeight, globalThis.scrollY],
    };
  });

// The API's 403 for a policy write.
const forbidden = async (route) => {
  if (route.request().method() === "GET") {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 403,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Forbidden" } }),
  });
};

// An Agent page at `viewport` with its Share Agent panel's form filled in for a provisioned
// person.
async function sharingPage(t, viewport) {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["status-recipient"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Status refusal");
  const agent = await fixture.createAgent(namespace.id, "Status Agent", nativeValues("status"));
  const { page } = await newPage(t, fixture, { browser, context: { viewport } });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel
    .getByLabel("Existing person’s Principal ID")
    .fill(fixture.provisionedAccounts[0].principal.id);
  await panel.getByRole("checkbox").check();
  return { page, panel, policyPath: `${fixture.origin}/namespaces/${namespace.id}/iam` };
}

const SHARE_REFUSAL =
  "Sharing policy requires Installation administration. Your other Agent controls remain available according to their own permissions.";

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`a Share Agent refusal is a focused danger block on screen at ${viewport.width}px`, async (t) => {
    const { page, panel, policyPath } = await sharingPage(t, viewport);
    // The policy read succeeds; the first write is refused.
    await page.route(`${policyPath}/roles`, forbidden);
    // Submitted from the keyboard, as a reader who then hears the outcome would.
    await panel.getByRole("button", { name: "Share Agent", exact: true }).focus();
    await page.keyboard.press("Enter");
    const alert = panel.getByRole("alert").filter({ hasText: SHARE_REFUSAL });
    await alert.waitFor();
    const view = await refusalView(alert);
    t.diagnostic(JSON.stringify(view));
    assert.equal(view.focused, true, "the refusal has focus");
    assert.equal(view.inView, true, "the refusal is on screen");
    // Every existing word is kept.
    assert.equal(
      await alert.textContent(),
      `${SHARE_REFUSAL} Refresh sharing to inspect current policy before another change.`,
    );
    assertPaint(await statusPaint(alert), "danger", "Share refusal");
  });
}

// Remove binding sits below the grants list, and its refusal shows above the form. On a phone
// whose visible area is short (a small screen, or the browser's bars shown), the refusal was
// above the fold and unfocused: the reader saw the list collapse and nothing else.
test("a refused binding removal at 390px brings its refusal on screen with focus", async (t) => {
  const { page, panel, policyPath } = await sharingPage(t, { width: 390, height: 560 });
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  await page.route(`${policyPath}/access-bindings/*`, forbidden);
  const remove = panel.getByRole("button", { name: "Remove binding", exact: true }).first();
  await remove.focus();
  await page.keyboard.press("Enter");
  const alert = panel.getByRole("alert").filter({ hasText: SHARE_REFUSAL });
  await alert.waitFor();
  const view = await refusalView(alert);
  t.diagnostic(JSON.stringify(view));
  assert.equal(view.focused, true, "the refusal has focus");
  assert.equal(view.inView, true, "the refusal is on screen");
  assertPaint(await statusPaint(alert), "danger", "removal refusal");
});

// A warning and an informational notice on the same tab: the API-key plugin warning and the
// note on which version the tab edits.
test("warning and info notices use their tone's token colours with readable text", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Status notices", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Status notices",
    nativeValues("status-notices", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
  const warning = page.getByText(
    "Codex plugins need a ChatGPT login. This Agent uses an API key, so each selected plugin is disabled when it deploys (PLUGIN_AUTH_REQUIRED). Change its Harness authentication under Credentials to use plugins.",
    { exact: true },
  );
  await warning.waitFor();
  assertPaint(await statusPaint(warning), "warning", "API-key plugin warning");
  const info = page.locator(".version-selection-notice");
  assert.equal(
    await info.textContent(),
    "Plugin changes to this Agent appear in the next deployment. Existing versions stay unchanged.",
  );
  assert.equal(await info.getAttribute("role"), "status");
  assertPaint(await statusPaint(info), "info", "version notice");
});
