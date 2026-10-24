import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { BrowserContextOptions, Locator, Page } from "playwright";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { fileBrowser, login, newPage, settledView } from "./console-agents-browser-helpers.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

const desktop = { viewport: { width: 1440, height: 900 } };
const phone = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

async function openAgents(t: TestContext, context: BrowserContextOptions) {
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
const tokenColor = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = globalThis.document.createElement("div");
    probe.style.color = `var(${name})`;
    globalThis.document.body.append(probe);
    const value = globalThis.getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);

const style = (locator: Locator, ...properties: (keyof CSSStyleDeclaration)[]) =>
  locator.evaluate(
    (node, names) =>
      Object.fromEntries(names.map((name) => [name, globalThis.getComputedStyle(node)[name]])),
    properties,
  );

async function visibleBox(locator: Locator) {
  const box = await locator.boundingBox();
  assert.ok(box, "expected a visible element to measure");
  return box;
}

// The navigation uses an inverse surface, but its account menu uses the regular surface.
test("the desktop shell shows the sidebar surface, the current-page bar and the account row", async (t) => {
  const { fixture, page } = await openAgents(t, desktop);
  const { email, name } = fixture.credentials;
  const [surface, text, selected, marker] = await Promise.all(
    [
      "--color-surface-inverse",
      "--color-on-inverse",
      "--color-inverse-selected",
      "--color-inverse-marker",
    ].map((token) => tokenColor(page, token)),
  );

  const sidebar = page.locator(".sidebar");
  assert.equal((await style(sidebar, "backgroundColor")).backgroundColor, surface);
  const brand = sidebar.locator(".brand");
  assert.equal(await brand.textContent(), "OpenClaw Enterprise");
  assert.deepEqual(await style(brand, "color", "textTransform"), {
    color: text,
    textTransform: "none",
  });

  const current = page.locator('.nav a[aria-current="page"]');
  assert.equal(await current.textContent(), "◇Agents");
  assert.deepEqual(await style(current, "backgroundColor", "color", "height"), {
    backgroundColor: selected,
    color: text,
    height: "36px",
  });
  const pageMarker = (link: Locator) =>
    link.evaluate((node) => globalThis.getComputedStyle(node, "::before").borderInlineStart);
  assert.equal(await pageMarker(current), `3px solid ${marker}`);
  const other = page.locator(".nav a", { hasText: "Namespaces" });
  assert.equal((await style(other, "backgroundColor")).backgroundColor, "rgba(0, 0, 0, 0)");
  assert.match(await pageMarker(other), /^0px none/);

  // The account row: initials, name and email; its menu offers Settings and Sign out.
  const account = page.getByRole("button", { name: `${name} ${email}`, exact: true });
  assert.equal(await account.locator(".account-avatar").textContent(), "CA");
  assert.equal(await account.locator(".account-name").textContent(), name);
  assert.equal(await account.locator(".account-email").textContent(), email);
  assert.equal(await page.locator(".topbar").isVisible(), false, "no top bar on desktop");
  await account.press("ArrowDown");
  const settings = page.getByRole("menuitem", { name: "Settings", exact: true });
  assert.deepEqual(await style(settings, "color", "outlineColor"), {
    color: await tokenColor(page, "--color-text"),
    outlineColor: await tokenColor(page, "--color-focus"),
  });
  assert.deepEqual(
    await page.getByRole("menu", { name: "Account" }).getByRole("menuitem").allTextContents(),
    ["Settings", "Sign out"],
  );
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
});

// Input focus uses its own colour so it does not read as a validation error.
test("the focus ring is a 2 px focus-colour outline", async (t) => {
  const { page } = await openAgents(t, desktop);
  const focus = await tokenColor(page, "--color-focus");
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
  assert.equal(Math.round((await visibleBox(topbar)).height), 56);
  assert.equal(await topbar.locator(".brand").textContent(), "OpenClaw Enterprise");
  const mark = topbar.locator(".brand img");
  const selectedMark = () =>
    mark.evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      return { path: new URL(img.currentSrc).pathname, width: img.width, height: img.height };
    });
  assert.deepEqual(await selectedMark(), {
    path: "/console/oce-mascot-inverse.png",
    width: 48,
    height: 38,
  });
  await page.emulateMedia({ forcedColors: "active" });
  assert.deepEqual(await selectedMark(), {
    path: "/console/oce-mascot.png",
    width: 20,
    height: 20,
  });
  await page.emulateMedia({ forcedColors: "none" });
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
    const box = await visibleBox(control);
    assert.ok(box.width >= 44 && box.height >= 44, `${JSON.stringify(box)} is a 44 px target`);
  }
  const circle = await visibleBox(avatar.locator(".account-avatar"));
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

  // Opening the drawer closes the avatar's menu and brings the desktop navigation into reach.
  await page.setViewportSize({ width: 320, height: phone.viewport.height });
  await avatar.click();
  await navigation.click();
  assert.equal(await menu.isVisible(), false);
  assert.equal(await avatar.getAttribute("aria-expanded"), "false");
  const sidebar = page.locator("#navigation-drawer");
  await sidebar.waitFor({ state: "visible" });
  const name = await visibleBox(sidebar.locator(".brand-name"));
  const close = await visibleBox(sidebar.locator(".drawer-close"));
  assert.ok(name.x + name.width <= close.x, "the wordmark leaves the close target clear at 320px");
  assert.equal(
    (await style(sidebar, "backgroundColor")).backgroundColor,
    await tokenColor(page, "--color-surface-inverse"),
  );
  for (const link of await sidebar.locator(".nav a").all()) {
    assert.ok((await visibleBox(link)).height >= 44, "drawer links keep a 44 px target");
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

// Settings (UX spec 3.10): an account card with the avatar, name and email, and a Session card
// whose secondary Sign out ends this session, in a 720 px column without a Namespace selector.
// The session read carries no sign-in method or expiry, so neither row is shown.
test("Settings shows the account and session cards, and its Sign out ends the session", async (t) => {
  for (const context of [desktop, phone]) {
    const size = `${context.viewport.width}px`;
    const { fixture, page } = await openAgents(t, context);
    const { email, name } = fixture.credentials;
    await page.goto(new URL("/console/settings", fixture.origin).href);
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    const view = page.locator(settledView);
    await view.waitFor();
    assert.equal(await page.locator(".page-header .scope").textContent(), "Your account", size);
    assert.equal(await page.locator("#namespace-selector").count(), 0, `${size}: no selector`);

    const card = (heading: string) =>
      view.locator("section.card", {
        has: page.getByRole("heading", { name: heading, exact: true }),
      });
    const account = card("Signed-in account");
    const avatar = account.locator(".account-avatar");
    assert.equal(await avatar.textContent(), "CA", size);
    const circle = await visibleBox(avatar);
    assert.deepEqual([circle.width, circle.height], [64, 64], `${size}: a 64 px avatar`);
    assert.deepEqual(
      await account
        .locator("dl.settings")
        .evaluate((list) => [...list.children].map((node) => node.textContent)),
      ["Name", name, "Email", email],
      `${size}: name and email only`,
    );

    const session = card("Session");
    const signOut = session.getByRole("button", { name: "Sign out", exact: true });
    assert.equal(
      await signOut.evaluate(
        (node) =>
          globalThis.document.getElementById(node.getAttribute("aria-describedby") ?? "")
            ?.textContent,
      ),
      "Signing out ends this session on this device only.",
      size,
    );
    // Secondary: the plain button, not the primary fill or the danger edge.
    assert.deepEqual(
      await style(signOut, "backgroundColor", "borderTopColor"),
      {
        backgroundColor: await tokenColor(page, "--color-surface"),
        borderTopColor: await tokenColor(page, "--color-border-strong"),
      },
      size,
    );
    assert.equal(await view.getByText("No configurable settings", { exact: false }).count(), 0);
    assert.equal(await view.getByRole("button", { name: "Back", exact: true }).count(), 0);

    const column = await visibleBox(view.locator(".settings-page"));
    const button = await visibleBox(signOut);
    if (context === desktop) {
      assert.equal(column.width, 720, "the Settings column is 720 px wide");
      assert.ok(button.width < column.width / 2, "Sign out keeps its own width on desktop");
    } else {
      // Full width inside the card at phone width, with a 44 px target.
      const inner = await session.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const padding = globalThis.getComputedStyle(node);
        return box.width - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight) - 2;
      });
      assert.equal(button.width, inner, "Sign out spans the card at phone width");
      assert.ok(button.height >= 44, `Sign out is ${button.height}px tall, at least 44`);
    }

    const signedOut = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/sign-out" &&
        response.request().method() === "POST",
    );
    await signOut.click();
    assert.equal((await signedOut).ok(), true, `${size}: the sign-out request succeeds`);
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    assert.equal(
      (await page.evaluate(async () => (await globalThis.fetch("/api/auth/session")).json())).data,
      null,
      `${size}: the session has ended`,
    );
  }
});

// An account with no display name has its email as its name, and Settings showed it twice: Name
// and Email both nora@example.test (finding 2099). Settings now shows the email once.
test("Settings shows an account without a display name by its email once", async (t) => {
  const { fixture, page } = await openAgents(t, desktop);
  const { email } = fixture.credentials;
  await page.route("**/api/auth/session", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.data?.user) {
      body.data.user.name = body.data.user.email;
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto(new URL("/console/settings", fixture.origin).href);
  const list = page.locator(settledView).locator(".settings-page dl.settings");
  await list.waitFor();
  assert.deepEqual(
    await list.evaluate((node) => [...node.children].map((child) => child.textContent)),
    ["Email", email],
  );
});

// Each layout has its own account menu; the one a resize hides closes, so it does not reappear
// open in the drawer or on a return to desktop.
test("changing between desktop and phone layouts closes the account menu left behind", async (t) => {
  const { fixture, page } = await openAgents(t, desktop);
  const sideMenu = page.locator("#account-menu");
  await page.locator(".account-toggle").click();
  assert.equal(await sideMenu.isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  // Checked before any click: a click outside the menu would close it anyway.
  await page.waitForFunction(
    () => globalThis.document.querySelector(".account-toggle")?.ariaExpanded === "false",
  );
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.locator("#navigation-drawer").waitFor({ state: "visible" });
  assert.equal(await sideMenu.isVisible(), false, "the drawer opens with its menu closed");
  await page.keyboard.press("Escape");

  const avatar = page.getByRole("button", {
    name: `Account: ${fixture.credentials.name}`,
    exact: true,
  });
  await avatar.click();
  assert.equal(await page.locator("#account-menu-top").isVisible(), true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(
    () => globalThis.document.querySelector(".topbar-avatar")?.ariaExpanded === "false",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#account-menu-top").isVisible(), false);
});

// Sign-in (UX spec 3.12): "Sign in" with the email hint as its one muted line, Email and
// Password, a full-width primary, the ink wordmark, and the build in a muted footer.
test("the sign-in page says Sign in, labels the email field and names the build", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const revision = "0123456789abcdef0123456789abcdef01234567";
  const { page } = await newPage(t, fixture, { browser, context: desktop });
  // Published images bake their commit into this meta tag; the fixture serves it empty.
  await page.route("**/console/login", async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    assert.match(html, /<meta name="occ-build-revision" content="" \/>/);
    await route.fulfill({
      response,
      body: html.replace(
        '<meta name="occ-build-revision" content="" />',
        `<meta name="occ-build-revision" content="${revision}" />`,
      ),
    });
  });
  await page.goto(new URL("/console/login", fixture.origin).href);
  const title = page.getByRole("heading", { level: 1 });
  await title.waitFor();
  assert.equal(await title.textContent(), "Sign in");
  assert.equal((await style(title, "fontSize")).fontSize, "24px");
  assert.equal(await page.getByText("Welcome back").count(), 0);

  const email = page.getByLabel("Email", { exact: true });
  assert.equal(await email.getAttribute("type"), "email");
  assert.equal(await email.getAttribute("autocomplete"), "username");
  // The muted line under the title is the field's description, not a second hint.
  assert.equal(
    await email.evaluate(
      (node) =>
        globalThis.document.getElementById(node.getAttribute("aria-describedby") ?? "")
          ?.textContent,
    ),
    "Use your account email.",
  );
  assert.equal(await page.locator(".auth .hint").count(), 0);
  await page.getByLabel("Password", { exact: true }).waitFor();
  const submit = page.getByRole("button", { name: "Sign in", exact: true });
  assert.equal(await submit.evaluate((node) => node.classList.contains("button--primary")), true);
  assert.equal((await visibleBox(submit)).width, (await visibleBox(email)).width);

  const brand = page.locator(".auth .brand");
  assert.equal(await brand.textContent(), "OpenClaw Enterprise");
  assert.deepEqual(await style(brand, "color", "textTransform"), {
    color: await tokenColor(page, "--color-text-strong"),
    textTransform: "none",
  });

  const footer = page.locator(".auth-footer");
  assert.equal(await footer.textContent(), "OpenClaw Enterprise · build 01234567");
  assert.deepEqual(await style(footer, "fontSize", "color"), {
    fontSize: "12px",
    color: await tokenColor(page, "--color-text-muted"),
  });

  // A phone keeps a 16 px gutter on each side of the card.
  await page.setViewportSize({ width: 390, height: 844 });
  const card = await visibleBox(page.locator(".auth"));
  assert.ok(card.x >= 16 && card.x + card.width <= 390 - 16, JSON.stringify(card));

  await email.fill(fixture.credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.credentials.password);
  await submit.click();
  await page.waitForURL(/\/console\/agents/);
});

// A development build has no commit to name, so the sign-in page has no footer.
test("the sign-in page leaves the footer out without a build commit", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture, { browser, context: desktop });
  await page.goto(new URL("/console/login", fixture.origin).href);
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await page.locator(".auth-footer").count(), 0);
  assert.equal(await page.locator("#app").evaluate((node) => node.lastChild?.nodeType), 1);
});

// Namespaces (UX spec 3.12): one table card with Namespace, Status and Created columns. Rows stay
// list items that open the Namespace's Agents, from the pointer or the keyboard.
test("Namespaces read as a table whose rows open each Namespace's Agents", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const ready = await fixture.createNamespace("Table ready", { ready: true });
  const provisioning = await fixture.createNamespace("Table provisioning");
  const { page } = await newPage(t, fixture, { browser, context: desktop });
  await login(page, fixture, `/console/namespaces?namespace=${ready.id}`);
  const list = page.getByRole("list", { name: "Namespaces", exact: true });
  await list.waitFor();

  const table = page.locator(".namespace-table");
  assert.deepEqual(await style(table, "borderTopWidth", "borderTopLeftRadius"), {
    borderTopWidth: "1px",
    borderTopLeftRadius: "14px",
  });
  const head = table.locator(".namespace-table-head");
  assert.equal(await head.getAttribute("aria-hidden"), "true");
  assert.deepEqual(await head.locator("span").allTextContents(), [
    "Namespace",
    "Status",
    "Created",
  ]);
  assert.equal(
    (await style(head, "backgroundColor")).backgroundColor,
    await tokenColor(page, "--color-surface-2"),
  );
  const columns = await head
    .locator("span")
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)));

  for (const [namespace, label, tone] of [
    [ready, "Ready", "success"],
    [provisioning, "Provisioning", "warning"],
  ] as const) {
    const row = list.getByRole("listitem").filter({ hasText: namespace.id });
    assert.equal(await row.evaluate((node) => node.classList.contains("card")), false);
    assert.ok((await visibleBox(row)).height >= 56);
    const link = row.getByRole("link", { name: namespace.name, exact: true });
    assert.equal(
      await link.getAttribute("href"),
      `/console/agents?namespace=${encodeURIComponent(namespace.id)}`,
    );
    const badge = row.locator(".badge");
    assert.equal(await badge.textContent(), label);
    assert.equal(await badge.getAttribute("data-tone"), tone);
    const created = row.locator(".namespace-cell-created");
    // The column name is read with the value but shown only by the head row.
    assert.match((await created.textContent()) ?? "", /^Created \S/);
    assert.ok((await visibleBox(created.locator(".namespace-cell-label"))).width <= 1);
    // Each cell starts under its column's name.
    const lefts = await Promise.all(
      [link, badge, created].map(async (node) => Math.round((await visibleBox(node)).x)),
    );
    assert.deepEqual(lefts, columns);
  }

  // The keyboard reaches each row's link; the ring is drawn inside the table's clipped corners.
  const link = list.getByRole("link", { name: provisioning.name, exact: true });
  await page.locator("[data-create-namespace]").focus();
  for (let step = 0; step < 6; step += 1) {
    if (await link.evaluate((node) => node === globalThis.document.activeElement)) {
      break;
    }
    await page.keyboard.press("Tab");
  }
  assert.equal(await link.evaluate((node) => node === globalThis.document.activeElement), true);
  const row = list.getByRole("listitem").filter({ hasText: provisioning.id });
  assert.deepEqual(await style(row, "outlineStyle", "outlineOffset"), {
    outlineStyle: "solid",
    outlineOffset: "-3px",
  });
  await page.keyboard.press("Enter");
  await page.waitForURL(`**/console/agents?namespace=${provisioning.id}`);

  // A phone stacks each row: the badge beside the name and the labelled date beneath.
  await page.goBack();
  await list.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await head.isVisible(), false);
  const phoneRow = list.getByRole("listitem").filter({ hasText: ready.id });
  const label = phoneRow.locator(".namespace-cell-label");
  assert.ok((await visibleBox(label)).width > 1, "the date is labelled on a phone");
  const name = await visibleBox(phoneRow.locator(".resource-name"));
  const status = await visibleBox(phoneRow.locator(".badge"));
  const date = await visibleBox(phoneRow.locator(".namespace-cell-created"));
  assert.ok(status.x > name.x && Math.abs(status.y - name.y) < 16, "badge beside the name");
  assert.ok(date.y > name.y + name.height, "date beneath the name");
  assert.ok(
    (await page.evaluate(() => globalThis.document.documentElement.scrollWidth)) <= 390,
    "nothing scrolls sideways",
  );
});
