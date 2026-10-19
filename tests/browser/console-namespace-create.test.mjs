import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  fileBrowser,
  login,
  newPage,
  settledView,
} from "./console-agents-browser-helpers.mjs";

const browser = fileBrowser();
const creates = (requests) =>
  requests.filter(({ method, path }) => method === "POST" && path === "/namespaces");

test("create a Namespace from the console, then open its Agent workflow", async (t) => {
  const audit = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink: audit });
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, "/console/namespaces");
  const opener = page.getByRole("button", { name: "Create Namespace", exact: true });
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
  assert.equal(await name.inputValue(), "Existing team");
  assert.equal(await name.isEnabled(), true);
  await name.fill("New team");
  await dialog.getByRole("button", { name: "Create Namespace", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Namespace created", exact: true })
    .getByRole("button", { name: "Done" })
    .click();
  await page.locator(settledView).getByRole("link", { name: "New team", exact: true }).waitFor();
});

test("an empty Namespace list offers creation and reports the real IAM denial", async (t) => {
  const audit = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink: audit });
  await fixture.bootstrap();
  const limited = await fixture.createAccountWithPolicy("namespace-member", () => {});
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 390, height: 844 } },
  });
  await login(page, fixture, "/console/namespaces", limited.credentials);
  await page.getByRole("heading", { name: "No accessible namespaces", exact: true }).waitFor();
  await page.getByRole("button", { name: "Create Namespace", exact: true }).click();
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
  await dialog.getByRole("button", { name: "Cancel" }).click();
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
});
