import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import {
  detailUrl,
  fileBrowser,
  login,
  nativeValues,
  newPage,
  settledView,
} from "./console-agents-browser-helpers.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// The page header (UX plan D3, spec 3.2): collections show the Namespace selector as one compact
// 32 px control beside Refresh; an Agent's page and Create Agent lead with ← Agents and carry the
// Agent ID and the selector in a meta row under the title, so a long Agent name never runs into
// the header's controls and the phone header ends by 240 px.

// One Chromium for the file; each case still gets its own context.
const browser = fileBrowser();

// A 40-character Agent name, the length the plan row measures at 1024 px.
const LONG_NAME = "Quarterly release review and signoff bot";

// The header's layout: its bottom on the page, the title, every visible control in it (with the
// region it sits in), and the Namespace selector's box.
const headerLayout = (page: Page) =>
  page.locator(".content .page-header").evaluate((header) => {
    const box = (node: Element | Range) => {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        height: rect.height,
      };
    };
    const select = header.querySelector("#namespace-selector");
    const selector = select?.closest(".namespace-selector");
    const label = selector?.querySelector("label");
    if (!select || !selector || !label) {
      throw new Error("Page header has no labelled Namespace selector");
    }
    const title = header.querySelector("h1");
    // The title's text, not the block: an h1 is as wide as its column.
    const range = globalThis.document.createRange();
    if (!title) {
      throw new Error("Page header has no title");
    }
    range.selectNodeContents(title);
    return {
      bottom: header.getBoundingClientRect().bottom + globalThis.scrollY,
      title: { text: title.textContent, ...box(title), lines: range.getClientRects().length },
      titleText: box(range),
      controls: Array.from(
        header.querySelectorAll<HTMLAnchorElement | HTMLButtonElement | HTMLSelectElement>(
          "a, button, select",
        ),
      )
        .filter((node) => node.getClientRects().length)
        .map((node) => ({
          name:
            node.getAttribute("aria-label") ||
            ("labels" in node && node.labels?.[0]?.textContent) ||
            node.textContent,
          region: node.closest(".page-meta")
            ? "meta"
            : node.closest(".page-actions")
              ? "actions"
              : "header",
          ...box(node),
        })),
      selector: {
        region: selector.closest(".page-meta")
          ? "meta"
          : selector.closest(".page-actions")
            ? "actions"
            : "header",
        ...box(selector),
        labelInside:
          label.getBoundingClientRect().left >= selector.getBoundingClientRect().left &&
          label.getBoundingClientRect().right <= select.getBoundingClientRect().left + 1 &&
          Math.abs(label.getBoundingClientRect().top - select.getBoundingClientRect().top) <
            selector.getBoundingClientRect().height,
      },
    };
  });

type Box = Pick<DOMRect, "top" | "bottom" | "left" | "right">;

const overlaps = (a: Box, b: Box) =>
  a.left < b.right - 0.5 &&
  b.left < a.right - 0.5 &&
  a.top < b.bottom - 0.5 &&
  b.top < a.bottom - 0.5;

test("collections show a compact Namespace selector beside Refresh and Settings shows none", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Header scope");
  await fixture.createAgent(namespace.id, "Header Agent", nativeValues("collection"));
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const size = `${viewport.width}x${viewport.height}`;
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await page.locator(settledView).getByRole("link", { name: "Header Agent" }).waitFor();
    const selector = page.getByRole("combobox", { name: "Namespace", exact: true });
    await page.locator("#namespace-selector:not(:disabled)").waitFor();
    assert.equal(await selector.inputValue(), namespace.id, size);

    const layout = await headerLayout(page);
    t.diagnostic(`${size} ${JSON.stringify(layout.selector)}`);
    assert.equal(layout.selector.region, "actions", size);
    assert.equal(layout.selector.height, 32, `${size}: the selector is one 32 px control`);
    assert.ok(layout.selector.right - layout.selector.left <= 240, size);
    assert.equal(layout.selector.labelInside, true, `${size}: the label is the control's prefix`);
    const refresh = layout.controls.find((control) => control.name === "Refresh");
    assert.ok(refresh, `${size}: Refresh is present`);
    assert.equal(refresh.region, "actions", size);
    assert.ok(
      Math.abs(
        (refresh.top + refresh.bottom) / 2 - (layout.selector.top + layout.selector.bottom) / 2,
      ) < 1,
      `${size}: Refresh and the selector share a line`,
    );

    await page.goto(new URL(`/console/settings?namespace=${namespace.id}`, fixture.origin).href);
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    await page.locator(settledView).waitFor();
    assert.equal(await page.locator("#namespace-selector").count(), 0, `${size}: Settings`);
  }
});

test("an Agent's page leads with ← Agents and keeps its ID and Namespace under a long name", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Header detail");
  const agent = await fixture.createAgent(namespace.id, LONG_NAME, nativeValues("detail"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    const size = `${viewport.width}x${viewport.height}`;
    const { page } = await newPage(t, fixture, {
      browser,
      context: { viewport, permissions: ["clipboard-read", "clipboard-write"] },
    });
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, active.revision.id).href);
    await page.getByRole("heading", { name: LONG_NAME, level: 1 }).waitFor();
    await page
      .locator(".content .page-header")
      .getByRole("button", { name: "Create new version" })
      .waitFor();
    await page.locator("#namespace-selector:not(:disabled)").waitFor();

    const header = page.locator(".content .page-header");
    // One way back, in the header: the page view no longer repeats it.
    assert.equal(await page.getByRole("link", { name: "← Agents", exact: true }).count(), 1);
    assert.equal(await header.getByRole("link", { name: "← Agents", exact: true }).count(), 1);
    assert.equal(
      await header.locator(".page-meta").getByText(agent.id, { exact: true }).count(),
      1,
      `${size}: the ID is in the meta row`,
    );

    const layout = await headerLayout(page);
    t.diagnostic(`${size} ${JSON.stringify(layout)}`);
    const regions = Object.fromEntries(
      layout.controls.map((control) => [control.name, control.region]),
    );
    assert.deepEqual(
      regions,
      {
        "← Agents": "header",
        Refresh: "actions",
        "Create new version": "actions",
        "Copy Agent ID": "meta",
        Namespace: "meta",
      },
      size,
    );
    assert.equal(layout.selector.height, 32, size);
    // ← Agents comes first, the title's text runs into no control, and the meta row is under it.
    const back = layout.controls.find((control) => control.name === "← Agents");
    assert.ok(back, `${size}: back link is present`);
    assert.ok(back.bottom <= layout.title.top, `${size}: ← Agents is above the title`);
    for (const control of layout.controls) {
      assert.equal(
        overlaps(layout.titleText, control),
        false,
        `${size}: title over ${control.name}`,
      );
    }
    assert.ok(
      layout.selector.top >= layout.title.bottom,
      `${size}: the selector is under the title`,
    );
    if (viewport.width === 390) {
      // Phone: back row (with the actions), title, meta. A name this long takes two lines; the
      // header still ends well before the old 8-row header did.
      assert.ok(layout.bottom <= 240 + 34 * (layout.title.lines - 1), `${size}: ${layout.bottom}`);
    } else {
      const actions = layout.controls.filter((control) => control.region === "actions");
      for (const action of actions) {
        assert.ok(
          action.left >= layout.title.right,
          `${size}: ${action.name} is right of the title`,
        );
      }
    }

    // The Versions card pads like the card above it at every width; on a phone it kept 24 px
    // while the other cards narrowed to 16 px (finding 2423).
    const cards = [".agent-stat-card", ".revision-selector"];
    for (const selector of cards) {
      await page.locator(selector).waitFor();
    }
    const paddings = await page.evaluate(
      (selectors) =>
        selectors.map(
          (selector) =>
            globalThis.getComputedStyle(globalThis.document.querySelector(selector)!).padding,
        ),
      cards,
    );
    assert.equal(paddings[0], paddings[1], `${size}: ${paddings.join(" vs ")}`);

    // The copy button puts the ID on the clipboard and says so.
    await header.getByRole("button", { name: "Copy Agent ID" }).click();
    await header.getByRole("status").filter({ hasText: "Copied" }).waitFor();
    assert.equal(await page.evaluate(() => globalThis.navigator.clipboard.readText()), agent.id);
  }
});

test("a phone shows a short-named Agent's header in four rows, ending by 240 px", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Header phone");
  const agent = await fixture.createAgent(
    namespace.id,
    "Research assistant",
    nativeValues("phone"),
  );
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 390, height: 844 } },
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id).href);
  await page.getByRole("button", { name: "Deploy new version" }).waitFor();
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  const layout = await headerLayout(page);
  t.diagnostic(JSON.stringify(layout));
  assert.equal(layout.title.lines, 1);
  assert.ok(layout.bottom <= 240, `header bottom ${layout.bottom}`);
  // The selector spans the meta row on a phone.
  const content = await page
    .locator(".content .page-header")
    .evaluate((node) => node.getBoundingClientRect().width);
  assert.ok(layout.selector.right - layout.selector.left >= content - 1);
});

test("Create Agent leads with ← Agents and puts the Namespace under its title", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Header create");
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 1440, height: 900 } },
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent", level: 1 }).waitFor();
  await page.getByRole("button", { name: "Start without Preset", exact: true }).waitFor();
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  const layout = await headerLayout(page);
  t.diagnostic(JSON.stringify(layout));
  assert.deepEqual(
    Object.fromEntries(layout.controls.map((control) => [control.name, control.region])),
    { "← Agents": "header", Refresh: "actions", Namespace: "meta" },
  );
  assert.equal(await page.getByRole("link", { name: "← Agents", exact: true }).count(), 1);
  // The intro card's heading sits a step under the page title, not at its size (finding 2097).
  const sizes = await page.evaluate(() => {
    const size = (selector: string) => {
      const element = globalThis.document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing ${selector}`);
      }
      return globalThis.getComputedStyle(element).fontSize;
    };
    return { title: size(".page-header h1"), card: size(".launch-intro h2") };
  });
  assert.deepEqual(sizes, { title: "24px", card: "18px" });
  // The intro promises nothing the Installation may not offer: repository access needs
  // repository settings (finding 2404).
  assert.equal(
    await page.locator(".launch-intro > p.muted").textContent(),
    "Choose a model and give your Agent a place to work.",
  );
  // Both start cards use the card padding at every width; the intro kept 24px on a phone while
  // the Preset card narrowed to 16px (finding 2404).
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const paddings = await page.evaluate(() =>
      [".launch-intro", ".launch-preset"].map(
        (selector) =>
          globalThis.getComputedStyle(globalThis.document.querySelector(selector)!).padding,
      ),
    );
    assert.equal(paddings[0], paddings[1], `${width}: ${paddings.join(" vs ")}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("link", { name: "← Agents", exact: true }).click();
  await page.getByRole("heading", { name: "Agents", exact: true, level: 1 }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/console/agents");
});

// Settings has no Namespace control, so a Namespace that turned unreadable while it sat in the URL
// gets no recovery there: "Switch Namespace" would have nothing to focus. Backends still has the
// compact control, so its recovery keeps working.
test("Settings offers no Namespace recovery, which needs the selector it no longer has", async (t) => {
  const { fixture } = await createReadyConsoleNamespace(t, "Readable scope");
  const revoked = await fixture.createNamespace("Revoked scope", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/backends?namespace=${revoked.id}`);
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  fixture.policy.restrictions.push({
    id: "deny-revoked-read",
    namespaceId: revoked.id,
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const recover = page.getByRole("button", { name: "Switch Namespace", exact: true });
  await recover.click();
  assert.equal(
    await page
      .locator(".page-header #namespace-selector")
      .evaluate((node) => node === node.ownerDocument.activeElement),
    true,
    "Backends: Switch Namespace focuses the compact selector",
  );

  await page.goto(new URL(`/console/settings?namespace=${revoked.id}`, fixture.origin).href);
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.locator(settledView).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("namespace"), revoked.id);
  assert.equal(await page.locator("#namespace-selector").count(), 0);
  assert.equal(await recover.count(), 0, "Settings: no recovery without a selector");
  assert.equal(await page.getByText("Namespace unavailable", { exact: false }).count(), 0);
});
