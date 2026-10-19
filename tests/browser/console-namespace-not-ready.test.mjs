import assert from "node:assert/strict";
import test from "node:test";

import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  fileBrowser,
  login,
  nativeValues,
  newPage,
  secretPostRequests,
  settledView,
} from "./console-agents-browser-helpers.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

// On a first run the only Namespace is still provisioning. The Agents page and Create Agent never
// said so, and the first sign was the Secret dialog's refusal; a deleting Namespace could be the
// default pick (finding 1895). A provisioning Namespace still accepts Agent drafts, so only the
// statuses the API refuses for every new Agent disable creation.
const NOT_READY = /This Namespace is not ready yet\. Check its status on the Namespaces page/;
const DRAFTS =
  "Until then, Agents can be saved as drafts that need no new Secret or sign-in, but none can be deployed.";
const INVITATION = "Create an Agent in this Namespace using an editable Configuration template.";

// One Chromium for the file; each test still gets its own context.
const browser = fileBrowser();

// A bootstrapped Installation: its only Namespace is "default", still provisioning, plus any
// named ones (also provisioning).
async function firstRun(t, names = [], fixtureOptions = {}) {
  const fixture = await createConsoleAppFixture(t, fixtureOptions);
  await fixture.bootstrap();
  for (const name of names) {
    await fixture.createNamespace(name);
  }
  const listed = await fixture.request("GET", "/namespaces");
  assert.equal(listed.status, 200);
  const namespaces = Object.fromEntries(listed.data.map((item) => [item.name, item]));
  assert.equal(namespaces.default.status, "provisioning");
  assert.equal(namespaces.default.existingNamespace, undefined);
  return { fixture, namespaces };
}

// Answers GET /namespaces from the real API with the listed Namespaces' fields replaced.
async function reportNamespaces(page, patches) {
  await page.route(
    (url) => url.pathname === "/namespaces",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.data = body.data.map((item) =>
        patches.has(item.id) ? { ...item, ...patches.get(item.id) } : item,
      );
      await route.fulfill({ response, json: body });
    },
  );
}

test("a first run's provisioning Namespace names its status and still offers drafts", async (t) => {
  const { fixture } = await firstRun(t);
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, "/console/");
  const view = page.locator(settledView);
  await view.getByRole("heading", { name: "No Agents yet", exact: true }).waitFor();
  const note = await view.getByRole("status").filter({ hasText: NOT_READY }).textContent();
  assert.match(note, /^Namespace status: Provisioning\. /);
  assert.ok(note.endsWith(` ${DRAFTS}`), note);
  const create = view.getByRole("button", { name: "Create Agent" });
  assert.equal(await create.isDisabled(), false);
  assert.equal(await create.getAttribute("aria-describedby"), null);
  await view.getByText(INVITATION).waitFor();
});

test("Create Agent names a provisioning Namespace's status before any start", async (t) => {
  const { fixture, namespaces } = await firstRun(t);
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/agents/new?namespace=${namespaces.default.id}`);
  const view = page.locator(settledView);
  const start = view.getByRole("button", { name: "Start without Preset" });
  await start.waitFor();
  const note = view.getByRole("status").filter({ hasText: NOT_READY });
  assert.match(await note.textContent(), /^Namespace status: Provisioning\. /);
  // The note comes before the start controls in reading order.
  const startHandle = await start.elementHandle();
  assert.equal(
    await note.evaluate(
      (node, control) =>
        Boolean(
          node.compareDocumentPosition(control) & globalThis.Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      startHandle,
    ),
    true,
  );
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await view.getByText("Creating Agents is not available").count(), 0);
});

test("a provisioning Namespace saves an Agent draft from a seeded runtime-auth Preset", async (t) => {
  // Operator-managed credentials need no Secret, so this create never meets the readiness gate.
  const computeDriver = new SshComputeDriver({
    ssh: { identityFile: "/tmp/ssh-test-key", knownHostsFile: "/tmp/ssh-test-hosts" },
    hosts: { runtime: { address: "127.0.0.1", user: "root" } },
    runtime: {
      nodePath: "/usr/bin/node",
      openclawPath: "/opt/openclaw/index.js",
      user: "openclaw",
      root: "/tmp/ssh-runtime-test",
    },
    network: { gatewayPortRange: { start: 18800, end: 18899 } },
  });
  const preset = {
    name: "Operator-managed credentials",
    template: {
      agent: {
        name: "Runtime draft Agent",
        executionMode: "embedded",
        harnessAuth: { method: "runtime" },
      },
      configuration: { values: nativeValues("provisioning-draft") },
    },
  };
  const { fixture, namespaces } = await firstRun(t, [], {
    computeDriver,
    state: new InMemoryPlatformState(),
    defaultPresets: [preset],
  });
  const namespace = namespaces.default;
  const seeded = await fixture.request("GET", `/namespaces/${namespace.id}/presets`);
  const seededPreset = seeded.data.find((item) => item.name === preset.name);
  assert.ok(seededPreset, "Namespace creation seeds the Installation's Presets");
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const view = page.locator(settledView);
  await view.getByRole("status").filter({ hasText: NOT_READY }).waitFor();
  await view.getByRole("button", { name: "Create Agent" }).click();
  await page.getByLabel("Preset template").selectOption(seededPreset.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await created;
  assert.equal(response.status(), 201);
  assert.deepEqual((await response.json()).data.harnessAuth, { method: "runtime" });
  assert.equal(secretPostRequests(requests, namespace.id).length, 0);
});

test("a Namespace that takes no new Agent disables Create Agent with its reason", async (t) => {
  // A provisioning Namespace that adopts an existing Kubernetes namespace takes no Configuration
  // until it is ready.
  const { fixture, namespaces } = await firstRun(t);
  const { page } = await newPage(t, fixture, { browser });
  await reportNamespaces(page, new Map([[namespaces.default.id, { existingNamespace: "team-a" }]]));
  await login(page, fixture, "/console/");
  const view = page.locator(settledView);
  await view.getByRole("heading", { name: "No Agents yet", exact: true }).waitFor();
  const note = await view.getByRole("status").filter({ hasText: NOT_READY }).textContent();
  assert.match(note, /^Namespace status: Provisioning\. /);
  assert.ok(!note.includes(DRAFTS), note);
  const create = view.getByRole("button", { name: "Create Agent" });
  assert.equal(await create.isDisabled(), true);
  assert.equal(await create.getAttribute("aria-describedby"), "namespace-not-ready");
  assert.equal(await view.getByText(INVITATION).count(), 0);
  await view.getByText("You can create Agents here once this Namespace is ready.").waitFor();

  await page.goto(
    new URL(`/console/agents/new?namespace=${namespaces.default.id}`, fixture.origin).href,
  );
  await view.getByRole("heading", { name: "Creating Agents is not available" }).waitFor();
  assert.match(
    await view.getByRole("status").filter({ hasText: NOT_READY }).textContent(),
    /^Namespace status: Provisioning\. /,
  );
  assert.equal(await view.getByRole("button", { name: "Start without Preset" }).count(), 0);
  assert.equal(await page.getByRole("dialog").count(), 0);
});

test("a deleting Namespace is never the default pick while another remains", async (t) => {
  // Sorted by name, the deleting Namespace comes first; none is ready.
  const { fixture, namespaces } = await firstRun(t, ["alpha"]);
  const { page } = await newPage(t, fixture, { browser });
  await reportNamespaces(page, new Map([[namespaces.alpha.id, { status: "deleting" }]]));
  await login(page, fixture, "/console/");
  await page.locator(settledView).getByRole("heading", { name: "No Agents yet" }).waitFor();
  await page.getByText("Namespace · default", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("namespace"), namespaces.default.id);
});

test("with only a deleting Namespace, the pick names it and offers no wait", async (t) => {
  const { fixture, namespaces } = await firstRun(t);
  const { page } = await newPage(t, fixture, { browser });
  await reportNamespaces(page, new Map([[namespaces.default.id, { status: "deleting" }]]));
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
  const { page } = await newPage(t, fixture, { browser });
  // The Namespace reads as an adopted, provisioning one until it is released.
  const patches = new Map([[namespace.id, { status: "provisioning", existingNamespace: "team" }]]);
  await reportNamespaces(page, patches);
  const view = page.locator(settledView);
  // Both views are kept for a return while the Namespace is provisioning.
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await view.getByRole("heading", { name: "Creating Agents is not available" }).waitFor();
  await view.getByRole("link", { name: "← Agents", exact: true }).click();
  await view.getByRole("status").filter({ hasText: NOT_READY }).waitFor();
  assert.equal(await view.getByRole("button", { name: "Create Agent" }).isDisabled(), true);

  patches.delete(namespace.id);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces" }).waitFor();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await view.getByText(INVITATION).waitFor();
  assert.equal(await view.getByText(NOT_READY).count(), 0);
  await view.getByRole("button", { name: "Create Agent" }).click();
  await view.getByRole("button", { name: "Start without Preset" }).waitFor();
  assert.equal(await view.getByText("Creating Agents is not available").count(), 0);
});
