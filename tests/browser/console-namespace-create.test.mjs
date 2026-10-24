import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";
import {
  apiRequests,
  expectWriteAsksBeforeUnload,
  fileBrowser,
  login,
  newPage,
  settledView,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";

const browser = fileBrowser();
const REFUSED =
  "Your access does not include creating Namespaces in this Installation. After an administrator grants access, select Refresh to try again.";
const isPrimary = (locator) =>
  locator.evaluate((node) => node.classList.contains("button--primary"));
const creates = (requests) =>
  requests.filter(({ method, path }) => method === "POST" && path === "/namespaces");
// After the dialog closes and the list reloads, focus is on the new Create Namespace button
// (finding 2045). Bounded, so a lost focus fails here rather than at the test timeout.
const focusReturnsToOpener = (page) =>
  page.waitForFunction(
    () => {
      const active = globalThis.document.activeElement;
      return (
        active?.isConnected &&
        active.tagName === "BUTTON" &&
        active.textContent === "Create Namespace" &&
        !active.closest("dialog")
      );
    },
    null,
    { timeout: 5_000 },
  );

test("create a Namespace from the console, then open its Agent workflow", async (t) => {
  const audit = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink: audit });
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, "/console/namespaces");
  const opener = page.getByRole("button", { name: "Create Namespace", exact: true });
  // An Installation administrator gets creation as the page's primary action.
  assert.equal(await isPrimary(opener), true);
  await opener.click();
  let dialog = page.getByRole("dialog", { name: "Create Namespace", exact: true });
  await dialog.getByLabel("Namespace name").fill("Cancelled team");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await opener.evaluate((node) => node === node.ownerDocument.activeElement), true);
  assert.equal(creates(requests).length, 0);

  await opener.click();
  dialog = page.getByRole("dialog", { name: "Create Namespace", exact: true });
  const name = dialog.getByLabel("Namespace name");
  assert.equal(await name.inputValue(), "");
  await name.fill("   ");
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  await dialog.getByText("Namespace name is required.").waitFor();
  assert.equal(await name.getAttribute("aria-invalid"), "true");
  assert.equal(creates(requests).length, 0);

  // Hold the real controller's response: Escape and repeated submission cannot abandon or
  // replay a write while its result is still pending.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(`${fixture.origin}/namespaces`, async (route) => {
    if (route.request().method() !== "POST") {
      return route.continue();
    }
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await name.fill("  Support team  ");
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  await dialog.getByRole("button", { name: "Creating…", exact: true }).waitFor();
  assert.equal(await name.isDisabled(), true);
  assert.equal(await dialog.getByRole("button", { name: "Cancel" }).isDisabled(), true);
  // requestSubmit() fires submit even with the button disabled, so only the pending guard
  // stops a second write here.
  await dialog.locator("form").evaluate((form) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true);
  release();

  dialog = page.getByRole("dialog", { name: "Namespace created", exact: true });
  await dialog.getByText(/Provisioning is in progress/).waitFor();
  assert.equal(creates(requests).length, 1);
  assert.deepEqual(creates(requests)[0].body, { name: "Support team" });
  const listed = await fixture.request("GET", "/namespaces");
  const created = listed.data.find((item) => item.name === "Support team");
  assert.equal(created.status, "provisioning");
  assert.ok(
    audit
      .list()
      .some(
        (event) =>
          event.action === "openclaw.namespaces.create" &&
          event.resource.id === created.id &&
          event.actorId,
      ),
  );

  await dialog.getByRole("button", { name: "Open Agents" }).click();
  await page.waitForURL(new RegExp(`/console/agents\\?namespace=${created.id}`));
  const view = page.locator(settledView);
  await view.getByRole("heading", { name: "No Agents yet", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Namespace", { exact: true }).inputValue(), created.id);
  await view.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("button", { name: "Start without Preset", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("namespace"), created.id);
});

test("a Namespace name conflict keeps the form editable for correction", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  await fixture.createNamespace("Existing team");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, "/console/namespaces");
  await page.getByRole("button", { name: "Create Namespace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Namespace", exact: true });
  const name = dialog.getByLabel("Namespace name");
  await name.fill("Existing team");
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: /Choose a different name/ })
    .waitFor();
  // A taken name is the reader's to fix: no request ID beside it (finding 2102).
  assert.equal(await dialog.getByText(/Request ID/).count(), 0);
  assert.equal(await name.inputValue(), "Existing team");
  await waitForEnabled(name);
  assert.equal(await name.evaluate((node) => node === node.ownerDocument.activeElement), true);
  await name.fill("New team");
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Namespace created", exact: true })
    .getByRole("button", { name: "Done" })
    .click();
  await page.locator(settledView).getByRole("link", { name: "New team", exact: true }).waitFor();
  await focusReturnsToOpener(page);
});

// The dialog holds in-app navigation while Namespace creation is in flight; a reload or tab
// close asks first too, and stops asking once the answer comes, created or refused (finding 2181).
test("a reload asks first only while Namespace creation is in flight", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  await fixture.createNamespace("Existing team");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, "/console/namespaces");
  await page.getByRole("button", { name: "Create Namespace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Namespace", exact: true });
  const name = dialog.getByLabel("Namespace name");
  const submit = () =>
    dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  const url = `${fixture.origin}/namespaces`;
  await name.fill("Existing team");
  await expectWriteAsksBeforeUnload(t, page, url, {
    method: "POST",
    start: submit,
    settled: () =>
      dialog
        .getByRole("alert")
        .filter({ hasText: /Choose a different name/ })
        .waitFor(),
  });
  await name.fill("Reload team");
  await expectWriteAsksBeforeUnload(t, page, url, {
    method: "POST",
    start: submit,
    settled: () =>
      page
        .getByRole("dialog", { name: "Namespace created", exact: true })
        .getByText(/Provisioning is in progress/)
        .waitFor(),
  });
});

test("the Namespace name is checked at the field with the API's own rule", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, "/console/namespaces");
  await page.getByRole("button", { name: "Create Namespace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Namespace", exact: true });
  const name = dialog.getByLabel("Namespace name");
  const describedError = () =>
    name.evaluate(
      (node) =>
        (node.getAttribute("aria-describedby") ?? "")
          .split(" ")
          .map((id) => node.ownerDocument.getElementById(id))
          .find((described) => described?.classList.contains("field-error") && !described.hidden)
          ?.textContent ?? null,
    );

  // A pasted tab is refused as it arrives, before any submit.
  await name.fill("Tab\tteam");
  await dialog.getByText("Remove tabs, line breaks and other control characters").waitFor();
  assert.equal(await name.getAttribute("aria-invalid"), "true");
  assert.match(await describedError(), /Remove tabs/);
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  // Clearing the name replaces the shown error with the required one.
  await name.fill("");
  await dialog.getByText("Namespace name is required.").waitFor();
  assert.match(await describedError(), /is required/);

  // The API counts characters (code points), and a longer name is refused, not cut.
  const tooLong = "n".repeat(201);
  await name.fill(tooLong);
  await dialog.getByText("Use at most 200 characters.").waitFor();
  assert.equal(await name.inputValue(), tooLong);
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  assert.equal(creates(requests).length, 0);

  // A real server refusal (the client check bypassed on the wire) marks the field and links
  // the API's reason to it; an edit clears it.
  await page.route(`${fixture.origin}/namespaces`, (route) =>
    route.request().method() === "POST"
      ? route.continue({ postData: JSON.stringify({ name: "Tab\tteam" }) })
      : route.continue(),
  );
  await name.fill("Wire team");
  assert.equal(await name.getAttribute("aria-invalid"), null);
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  await page.waitForFunction(
    () =>
      globalThis.document.getElementById("namespace-name")?.getAttribute("aria-invalid") === "true",
  );
  assert.match(await describedError(), /operation contract.*\/name/);
  assert.equal(await dialog.getByText(/Request ID/).count(), 0);
  assert.equal(await name.isEnabled(), true);
  assert.equal(await name.evaluate((node) => node === node.ownerDocument.activeElement), true);
  await name.fill("Wire team 2");
  assert.equal(await name.getAttribute("aria-invalid"), null);
  await page.unroute(`${fixture.origin}/namespaces`);

  // 200 emoji are 400 UTF-16 code units but 200 characters: accepted and sent whole.
  const emoji = "\u{1F680}".repeat(200);
  await name.fill(emoji);
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  await page.getByRole("dialog", { name: "Namespace created", exact: true }).waitFor();
  // The page records the body it sent; the route rewrote the first one on the wire.
  assert.deepEqual(
    creates(requests).map(({ body }) => body),
    [{ name: "Wire team" }, { name: emoji }],
  );
  await page.keyboard.press("Escape");
  await focusReturnsToOpener(page);
});

test("a rate-limited or malformed creation answer is reported, not shown as created", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture, { browser });
  const answers = [
    {
      status: 429,
      json: { error: { code: "RATE_LIMITED", message: "Too many requests." }, meta: {} },
    },
    // A 201 whose Namespace is not provisioning does not match the creation contract.
    { status: 201, json: { data: { id: "ns_fake", name: "Odd team", status: "ready" } } },
  ];
  await page.route(`${fixture.origin}/namespaces`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ ...answers.shift(), contentType: "application/json" })
      : route.continue(),
  );
  await login(page, fixture, "/console/namespaces");
  await page.getByRole("button", { name: "Create Namespace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Namespace", exact: true });
  const name = dialog.getByLabel("Namespace name");
  const submit = dialog.getByRole("button", { name: "Create Namespace", exact: true });
  await name.fill("Odd team");
  await submit.click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "Too many requests. Wait before trying again." })
    .waitFor();
  await waitForEnabled(name);
  await waitForEnabled(submit);
  await submit.click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: /Outcome unknown/ })
    .waitFor();
  assert.equal(await page.getByRole("dialog", { name: "Namespace created" }).count(), 0);
  assert.equal(await submit.isDisabled(), true);
  await dialog.getByRole("button", { name: "Check Namespaces" }).click();
  await focusReturnsToOpener(page);
});

test("a creator who cannot read Namespaces is told so instead of offered Open Agents", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  fixture.policy.roles.push({
    id: "role-namespace-creator",
    permissions: [{ action: "create", resourceKind: "namespace" }],
  });
  const creator = await fixture.createAccountWithPolicy("namespace-creator", (principal) => {
    fixture.policy.bindings.push({
      id: "binding-namespace-creator",
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-namespace-creator",
    });
  });
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, "/console/namespaces", creator.credentials);
  // Not an administrator, so not the primary action, but a create grant still works from it.
  const opener = page.getByRole("button", { name: "Create Namespace", exact: true });
  assert.equal(await isPrimary(opener), false);
  await opener.click();
  await page
    .getByRole("dialog", { name: "Create Namespace", exact: true })
    .getByLabel("Namespace name")
    .fill("Creator team");
  await page.getByRole("dialog").getByRole("button", { name: "Create Namespace" }).click();
  const dialog = page.getByRole("dialog", { name: "Namespace created", exact: true });
  await dialog
    .getByRole("status")
    .filter({ hasText: "Your access does not include viewing this Namespace." })
    .waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Open Agents" }).count(), 0);
  const done = dialog.getByRole("button", {
    name: "Done",
    description: /Your access does not include viewing this Namespace/,
  });
  assert.equal(await done.evaluate((node) => node === node.ownerDocument.activeElement), true);
  assert.ok(
    (await fixture.request("GET", "/namespaces")).data.some((item) => item.name === "Creator team"),
  );
  await done.click();
  await page.getByRole("heading", { name: "No accessible namespaces", exact: true }).waitFor();
  await focusReturnsToOpener(page);
});

test("a member is not invited to create, and a real IAM denial disables Create Namespace", async (t) => {
  const audit = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink: audit });
  await fixture.bootstrap();
  const limited = await fixture.createAccountWithPolicy("namespace-member", () => {});
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 390, height: 844 } },
  });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, "/console/namespaces", limited.credentials);
  await page.getByRole("heading", { name: "No accessible namespaces", exact: true }).waitFor();
  // Not an Installation administrator: no filled primary and no invitation to create, but the
  // control stays usable, since a role may still grant Namespace creation (finding 2059).
  const opener = page.getByRole("button", { name: "Create Namespace", exact: true });
  const emptyText = page.locator(settledView).locator(".state-panel p");
  await waitForEnabled(opener);
  assert.equal(await isPrimary(opener), false);
  assert.equal(
    await emptyText.textContent(),
    "Ask an administrator for access to an existing Namespace, or create one if your role allows it.",
  );
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Create Namespace", exact: true });
  await dialog.getByLabel("Namespace name").fill("Forbidden team");
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: /do not have permission to create Namespaces/ })
    .waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "Create Namespace", exact: true }).isDisabled(),
    true,
  );
  // Nothing in the form can succeed now, so the name is not left editable as if it could.
  assert.equal(await dialog.getByLabel("Namespace name").isDisabled(), true);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // The refusal is the API's answer for this person: the page stops offering creation, says
  // why, and keeps focus on that reason rather than on a disabled button.
  await page.getByRole("status").filter({ hasText: REFUSED }).waitFor();
  assert.equal(await opener.isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Create Namespace", description: REFUSED }).count(),
    1,
  );
  assert.equal(await page.evaluate(() => globalThis.document.activeElement?.textContent), REFUSED);
  assert.equal(
    await emptyText.textContent(),
    "Ask an administrator to create a Namespace or grant access to an existing one.",
  );
  // The page's Refresh offers creation again, as the refusal says (finding 2083); Escape after
  // the next refusal also leaves focus on it.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator(settledView).locator(".state-panel").waitFor();
  await waitForEnabled(opener);
  assert.equal(await page.locator("#namespace-create-refused").count(), 0);
  await opener.click();
  await dialog.getByLabel("Namespace name").fill("Forbidden team");
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: /do not have permission/ })
    .waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await opener.isDisabled(), true);
  assert.equal(await page.evaluate(() => globalThis.document.activeElement?.textContent), REFUSED);
  assert.equal(creates(requests).length, 2);
  assert.equal(
    (await fixture.request("GET", "/namespaces")).data.some(
      (item) => item.name === "Forbidden team",
    ),
    false,
  );
  assert.ok(
    audit
      .list()
      .some(
        (event) =>
          event.kind === "authorization_denial" && event.action === "openclaw.namespaces.create",
      ),
  );
});

// Creates a Namespace through the open page's dialog and returns its error alert, if any.
async function submitCreate(page, name) {
  await page.getByRole("button", { name: "Create Namespace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Namespace", exact: true });
  await dialog.getByLabel("Namespace name").fill(name);
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  return dialog;
}

// After a refusal, an administrator's grant was never seen: in-app navigation and Refresh kept
// Create Namespace disabled, and only a browser reload asked again (finding 2083). Navigation
// still keeps the refusal; Refresh offers creation again.
test("a Refresh after an administrator grants Namespace create offers creation again", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const team = await fixture.createNamespace("Alpha team", { ready: true });
  const member = await fixture.createAccountWithPolicy("namespace-reader", (principal) =>
    grantRole(fixture.policy, principal.id, {
      id: "role-namespace-reader",
      namespaceId: team.id,
      permissions: { namespace: ["read"], agent: ["read"] },
    }),
  );
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, "/console/namespaces", member.credentials);
  const opener = page.getByRole("button", { name: "Create Namespace", exact: true });
  const dialog = await submitCreate(page, "Granted team");
  await dialog
    .getByRole("alert")
    .filter({ hasText: /do not have permission to create Namespaces/ })
    .waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("status").filter({ hasText: REFUSED }).waitFor();
  assert.equal(await opener.isDisabled(), true);
  // Another page and back keeps the refusal.
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.locator(settledView).getByRole("button", { name: "Create Agent" }).waitFor();
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.locator(settledView).getByText(REFUSED).waitFor();
  assert.equal(await opener.isDisabled(), true);

  grantRole(fixture.policy, member.principal.id, {
    id: "role-namespace-creator",
    permissions: { namespace: ["create"] },
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .locator(settledView)
    .getByRole("link", { name: /Alpha team/ })
    .waitFor();
  assert.equal(await page.getByText(REFUSED).count(), 0);
  await waitForEnabled(opener);
  assert.equal(await opener.getAttribute("aria-describedby"), null);
  await submitCreate(page, "Granted team");
  await page.getByRole("dialog", { name: "Namespace created", exact: true }).waitFor();
  assert.ok(
    (await fixture.request("GET", "/namespaces")).data.some((item) => item.name === "Granted team"),
  );
});

// An unknown administrator answer (the probe failed, not refused) keeps Create Namespace the
// page's primary action (finding 2087).
test("an unknown administrator answer keeps Create Namespace the primary action", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture, { browser });
  await page.route(`${fixture.origin}/observability`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "UNAVAILABLE", message: "Try again." } },
    }),
  );
  const probed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/observability",
  );
  await login(page, fixture, "/console/namespaces");
  assert.equal((await probed).status(), 503);
  await page.locator(settledView).locator(".namespace-toolbar").waitFor();
  const opener = page.getByRole("button", { name: "Create Namespace", exact: true });
  assert.equal(await isPrimary(opener), true);
});

// A refused administrator loses the primary action on the next render too, and the refusal
// belongs to the account the API refused: another account signed in later in the same tab is
// offered creation (finding 2087).
test("a refused administrator's refusal stays with that account", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const member = await fixture.createAccountWithPolicy("namespace-member", () => {});
  const { page } = await newPage(t, fixture, { browser });
  await page.route(`${fixture.origin}/namespaces`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 403,
          json: { error: { code: "FORBIDDEN", message: "Forbidden." } },
        })
      : route.fallback(),
  );
  await login(page, fixture, "/console/namespaces");
  const opener = page.getByRole("button", { name: "Create Namespace", exact: true });
  assert.equal(await isPrimary(opener), true);
  const dialog = await submitCreate(page, "Refused team");
  await dialog
    .getByRole("alert")
    .filter({ hasText: /do not have permission/ })
    .waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("status").filter({ hasText: REFUSED }).waitFor();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.locator(settledView).getByRole("button", { name: "Create Agent" }).waitFor();
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.locator(settledView).getByText(REFUSED).waitFor();
  assert.equal(await opener.isDisabled(), true);
  assert.equal(await isPrimary(opener), false);

  // Sign out and in as another account without reloading the tab.
  await page.locator(".account-toggle").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByLabel("Email", { exact: true }).fill(member.credentials.email);
  await page.getByLabel("Password").fill(member.credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "No accessible namespaces", exact: true }).waitFor();
  await waitForEnabled(opener);
  assert.equal(await page.getByText(REFUSED).count(), 0);

  // The refused administrator signs in again: a page built afresh still shows the refusal, and
  // not as the primary action.
  await page.locator(".account-toggle").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.locator(settledView).getByText(REFUSED).waitFor();
  assert.equal(await opener.isDisabled(), true);
  assert.equal(await isPrimary(opener), false);
});

test("a lost Namespace creation response requires inspection before another attempt", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  // Commit through the actual API, then lose only its response. This exercises an uncertain
  // outcome with a real saved Namespace, rather than a fabricated successful write.
  await page.route(`${fixture.origin}/namespaces`, async (route) => {
    if (route.request().method() !== "POST") {
      return route.continue();
    }
    await route.fetch();
    await route.abort("connectionreset");
  });
  await login(page, fixture, "/console/namespaces");
  await page.getByRole("button", { name: "Create Namespace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Namespace", exact: true });
  await dialog.getByLabel("Namespace name").fill("Uncertain team");
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: /Outcome unknown/ })
    .waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "Create Namespace", exact: true }).isDisabled(),
    true,
  );
  await dialog.getByRole("button", { name: "Check Namespaces" }).click();
  await page
    .locator(settledView)
    .getByRole("link", { name: "Uncertain team", exact: true })
    .waitFor();
  assert.equal(creates(requests).length, 1);
  await focusReturnsToOpener(page);
});

// An unexpected failure keeps its request ID for support, unlike a refusal the reader can fix.
test("an unexpected Namespace creation failure shows its request ID", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture, { browser });
  await page.route(`${fixture.origin}/namespaces`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          json: {
            error: { code: "UNAVAILABLE", message: "Try again later." },
            meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
          },
        })
      : route.continue(),
  );
  await login(page, fixture, "/console/namespaces");
  await page.getByRole("button", { name: "Create Namespace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Namespace", exact: true });
  await dialog.getByLabel("Namespace name").fill("Busy team");
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: /Outcome unknown/ })
    .waitFor();
  await dialog
    .getByText("Request ID: req_00000000-0000-4000-8000-000000000503", { exact: true })
    .waitFor();
});
