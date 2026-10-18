import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { login, newPage } from "./console-agents-browser-helpers.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// On a first run the only Namespace is still provisioning, which refuses Agent creation. The
// Agents page invited "Create an Agent…" with Create Agent enabled, the full form opened, and the
// first sign of trouble was the Secret dialog's refusal; a deleting Namespace could be the
// default pick (finding 1895).
const NOT_READY = /This Namespace is not ready yet\. Check its status on the Namespaces page/;
const INVITATION = "Create an Agent in this Namespace using an editable Configuration template.";
const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';

// A bootstrapped Installation: its only Namespace is "default", still provisioning, plus any
// named ones (also provisioning).
async function firstRun(t, ...names) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  for (const name of names) {
    await fixture.createNamespace(name);
  }
  const listed = await fixture.request("GET", "/namespaces");
  assert.equal(listed.status, 200);
  const namespaces = Object.fromEntries(listed.data.map((item) => [item.name, item]));
  assert.equal(namespaces.default.status, "provisioning");
  return { fixture, namespaces };
}

// Answers GET /namespaces from the real API with each listed Namespace's status replaced.
async function reportStatuses(page, statuses) {
  await page.route(
    (url) => url.pathname === "/namespaces",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.data = body.data.map((item) =>
        statuses.has(item.id) ? { ...item, status: statuses.get(item.id) } : item,
      );
      await route.fulfill({ response, json: body });
    },
  );
}

test("a first run's provisioning Namespace names its status instead of inviting creation", async (t) => {
  const { fixture } = await firstRun(t);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, "/console/");
  const view = page.locator(settledView);
  await view.getByRole("heading", { name: "No Agents yet", exact: true }).waitFor();
  const note = view.getByRole("status").filter({ hasText: NOT_READY });
  assert.match(await note.textContent(), /^Namespace status: Provisioning\. /);
  assert.equal(await view.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(await view.getByText(INVITATION).count(), 0);
  await view.getByText("You can create Agents here once this Namespace is ready.").waitFor();
});

test("Create Agent repeats the Namespace status and never opens the form", async (t) => {
  const { fixture, namespaces } = await firstRun(t);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespaces.default.id}`);
  const view = page.locator(settledView);
  await view.getByRole("heading", { name: "Creating Agents is not available" }).waitFor();
  assert.match(
    await view.getByRole("status").filter({ hasText: NOT_READY }).textContent(),
    /^Namespace status: Provisioning\. /,
  );
  assert.equal(await view.getByRole("button", { name: "Start without Preset" }).count(), 0);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await view.getByRole("link", { name: "← Agents" }).waitFor();
});

test("a deleting Namespace is never the default pick while another remains", async (t) => {
  // Sorted by name, the deleting Namespace comes first; none is ready.
  const { fixture, namespaces } = await firstRun(t, "alpha");
  const { page } = await newPage(t, fixture);
  await reportStatuses(page, new Map([[namespaces.alpha.id, "deleting"]]));
  await login(page, fixture, "/console/");
  await page.locator(settledView).getByRole("heading", { name: "No Agents yet" }).waitFor();
  await page.getByText("Namespace · default", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("namespace"), namespaces.default.id);
});

test("with only a deleting Namespace, the pick names it and offers no wait", async (t) => {
  const { fixture, namespaces } = await firstRun(t);
  const { page } = await newPage(t, fixture);
  await reportStatuses(page, new Map([[namespaces.default.id, "deleting"]]));
  await login(page, fixture, "/console/");
  const view = page.locator(settledView);
  await view.getByRole("heading", { name: "No Agents yet" }).waitFor();
  assert.equal(
    await view.getByRole("status").filter({ hasText: "Namespace status: Deleting." }).textContent(),
    "Namespace status: Deleting. This Namespace is being deleted, so it cannot hold new Agents. Choose another Namespace.",
  );
  await view.getByText("Agents cannot be created in this Namespace.").waitFor();
  const create = view.getByRole("button", { name: "Create Agent" });
  assert.equal(await create.isDisabled(), true);
  assert.equal(await create.getAttribute("aria-describedby"), "namespace-not-ready");
});

test("a return to the Agents list and Create Agent shows a Namespace that became ready", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "team");
  const { page } = await newPage(t, fixture);
  // The Namespace reads as provisioning until it is released.
  const statuses = new Map([[namespace.id, "provisioning"]]);
  await reportStatuses(page, statuses);
  const view = page.locator(settledView);
  // Both views are kept for a return while the Namespace is provisioning.
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await view.getByRole("heading", { name: "Creating Agents is not available" }).waitFor();
  await view.getByRole("link", { name: "← Agents", exact: true }).click();
  await view.getByRole("status").filter({ hasText: NOT_READY }).waitFor();
  assert.equal(await view.getByRole("button", { name: "Create Agent" }).isDisabled(), true);

  statuses.delete(namespace.id);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces" }).waitFor();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await view.getByText(INVITATION).waitFor();
  assert.equal(await view.getByText(NOT_READY).count(), 0);
  await view.getByRole("button", { name: "Create Agent" }).click();
  await view.getByRole("button", { name: "Start without Preset" }).waitFor();
  assert.equal(await view.getByText("Creating Agents is not available").count(), 0);
});
