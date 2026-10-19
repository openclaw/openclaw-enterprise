import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { fileBrowser, login, newPage, settledView } from "./console-agents-browser-helpers.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

const desktop = { viewport: { width: 1440, height: 900 } };
const phone = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

async function openAgents(t, context) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Shell", { ready: true });
  await fixture.createAgent(namespace.id, "Shell Agent");
  const { page } = await newPage(t, fixture, { browser, context });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.locator(settledView).getByText("Shell Agent", { exact: true }).waitFor();
  return { fixture, page };
}

// A colour token resolved to the computed form the browser reports.
const tokenColor = (page, token) =>
  page.evaluate((name) => {
    const probe = globalThis.document.createElement("div");
    probe.style.color = `var(${name})`;
    globalThis.document.body.append(probe);
    const value = globalThis.getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);

const style = (locator, ...properties) =>
  locator.evaluate(
    (node, names) =>
      Object.fromEntries(names.map((name) => [name, globalThis.getComputedStyle(node)[name]])),
    properties,
  );

// Warm-quiet shell (UX spec 3.1): the sidebar is a surface-2 panel with a hairline, the current
// page is a white pill with a 3 px accent bar, the wordmark is ink, and the account row names the
// signed-in person.
test("the desktop shell shows the sidebar surface, the current-page bar and the account row", async (t) => {
  const { fixture, page } = await openAgents(t, desktop);
  const { email, name } = fixture.credentials;
  const [surface2, surface, accent, border, strong] = await Promise.all(
    [
      "--color-surface-2",
      "--color-surface",
      "--color-accent",
      "--color-border",
      "--color-text-strong",
    ].map((token) => tokenColor(page, token)),
  );
  assert.equal(surface2, "rgb(244, 241, 236)");

  const sidebar = page.locator(".sidebar");
  assert.deepEqual(
    await style(sidebar, "backgroundColor", "borderRightColor", "borderRightWidth"),
    { backgroundColor: surface2, borderRightColor: border, borderRightWidth: "1px" },
  );
  const brand = sidebar.locator(".brand");
  assert.equal(await brand.textContent(), "OpenClaw Enterprise");
  assert.deepEqual(await style(brand, "color", "textTransform"), {
    color: strong,
    textTransform: "none",
  });

  const current = page.locator('.nav a[aria-current="page"]');
  assert.equal(await current.textContent(), "◇Agents");
  assert.deepEqual(await style(current, "backgroundColor", "color", "boxShadow", "height"), {
    backgroundColor: surface,
    color: strong,
    boxShadow: `${accent} 3px 0px 0px 0px inset`,
    height: "36px",
  });
  const other = page.locator(".nav a", { hasText: "Namespaces" });
  assert.deepEqual(await style(other, "backgroundColor", "boxShadow"), {
    backgroundColor: "rgba(0, 0, 0, 0)",
    boxShadow: "none",
  });

  // The account row: initials, name and email; its menu offers Settings and Sign out.
  const account = page.getByRole("button", { name: `${name} ${email}`, exact: true });
  assert.equal(await account.locator(".account-avatar").textContent(), "CA");
  assert.equal(await account.locator(".account-name").textContent(), name);
  assert.equal(await account.locator(".account-email").textContent(), email);
  assert.equal(await page.locator(".topbar").isVisible(), false, "no top bar on desktop");
  await account.click();
  assert.deepEqual(
    await page.getByRole("menu", { name: "Account" }).getByRole("menuitem").allTextContents(),
    ["Settings", "Sign out"],
  );
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Login", exact: true }).waitFor();
});

// The focus ring is navy, not accent, so it does not read as a validation error (spec 6.1).
test("the focus ring is a 2 px focus-colour outline", async (t) => {
  const { page } = await openAgents(t, desktop);
  const focus = await tokenColor(page, "--color-focus");
  assert.equal(focus, await tokenColor(page, "--color-info"));
  assert.notEqual(focus, await tokenColor(page, "--color-accent"));
  const search = page.getByRole("searchbox", { name: "Search Agents", exact: true });
  await search.focus();
  assert.deepEqual(await style(search, "outlineStyle", "outlineWidth", "outlineColor"), {
    outlineStyle: "solid",
    outlineWidth: "2px",
    outlineColor: focus,
  });
});

// At phone width a 56 px top bar holds the navigation toggle, the wordmark and the account
// avatar, whose menu opens without the drawer. Every control keeps a 44 px target.
test("the phone top bar opens the account menu from its avatar and the drawer from its toggle", async (t) => {
  const { fixture, page } = await openAgents(t, phone);
  const topbar = page.locator(".topbar");
  assert.equal(Math.round((await topbar.boundingBox()).height), 56);
  assert.equal(await topbar.locator(".brand").textContent(), "OpenClaw Enterprise");
  const header = await page
    .locator(".page-header")
    .evaluate((node) => node.getBoundingClientRect().bottom + globalThis.scrollY);
  assert.ok(header <= 240, `the Agents header ends at ${header}px, above 240px`);

  const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
  const avatar = page.getByRole("button", {
    name: `Account: ${fixture.credentials.name}`,
    exact: true,
  });
  for (const control of [navigation, avatar]) {
    const box = await control.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `${JSON.stringify(box)} is a 44 px target`);
  }
  const circle = await avatar.locator(".account-avatar").boundingBox();
  assert.deepEqual([circle.width, circle.height], [32, 32]);
  assert.equal(await avatar.textContent(), "CA");

  await avatar.click();
  const menu = page.locator("#account-menu-top");
  assert.equal(await menu.isVisible(), true);
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Settings", "Sign out"]);
  assert.equal(await navigation.getAttribute("aria-expanded"), "false", "the drawer stays shut");
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await page.keyboard.press("Escape");
  assert.equal(await menu.isVisible(), false);
  assert.equal(await avatar.evaluate((node) => node === globalThis.document.activeElement), true);

  // Opening the drawer closes the avatar's menu; the drawer is the surface-2 sidebar.
  await avatar.click();
  await navigation.click();
  assert.equal(await menu.isVisible(), false);
  assert.equal(await avatar.getAttribute("aria-expanded"), "false");
  const sidebar = page.locator("#navigation-drawer");
  await sidebar.waitFor({ state: "visible" });
  assert.equal(
    (await style(sidebar, "backgroundColor")).backgroundColor,
    await tokenColor(page, "--color-surface-2"),
  );
  for (const link of await sidebar.locator(".nav a").all()) {
    assert.ok((await link.boundingBox()).height >= 44, "drawer links keep a 44 px target");
  }
  await page.keyboard.press("Escape");
  assert.equal(
    await navigation.evaluate((node) => node === globalThis.document.activeElement),
    true,
  );

  await avatar.click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
});
