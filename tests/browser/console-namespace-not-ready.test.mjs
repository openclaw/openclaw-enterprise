import assert from "node:assert/strict";
import test from "node:test";

import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { apiErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { NAMESPACE_UNAVAILABLE } from "../helpers/refusal-text.mjs";
import {
  AGENT_READ,
  expireSessions,
  holdRequests,
  revokeAdministratorGrant,
  revokeMemberGrant,
  apiRequests,
  expectReachableReason,
  fileBrowser,
  fulfillPatchedJson,
  hasFocus,
  login,
  nativeValues,
  newPage,
  secretPostRequests,
  settledView,
  statusTone,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";
import { routeInstallationProvisioning } from "./console-agents-test-support.mjs";
import { refocus } from "./console-refocus-helpers.mjs";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.mjs";

// On a first run the only Namespace is still provisioning. The Agents page and Create Agent never
// said so, and the first sign was the Secret dialog's refusal; a deleting Namespace could be the
// default pick (finding 1895). A provisioning Namespace still accepts Agent drafts, so only the
// statuses the API refuses for every new Agent disable creation.
const NOT_READY = /This Namespace is not ready yet\. Check its status on the Namespaces page/;
const DRAFTS =
  "Until then, Agents can be saved as drafts that need no new Secret or sign-in, but none can be deployed.";
const INVITATION = "Create an Agent in this Namespace using an editable Configuration template.";
const DRAFT_INVITATION =
  "You can save an Agent draft here now. It can be deployed once this Namespace is ready.";

// The note is a warning status block (UX plan C1), still a polite status: it is there on load,
// not the answer to an action (finding 1990).
const WARNING = { className: "status", tone: "warning", role: "status" };

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

// Answers GET /namespaces from the real API with the listed Namespaces' fields replaced; a null
// patch leaves the Namespace out, as a list read after it was deleted or access was removed.
async function reportNamespaces(page, patches) {
  await page.route(
    (url) => url.pathname === "/namespaces",
    (route) =>
      fulfillPatchedJson(route, (body) => {
        body.data = body.data
          .filter((item) => patches.get(item.id) !== null)
          .map((item) => (patches.has(item.id) ? { ...item, ...patches.get(item.id) } : item));
        return body;
      }),
  );
}

test("a first run's provisioning Namespace names its status and still offers drafts", async (t) => {
  const { fixture } = await firstRun(t);
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, "/console/");
  const view = page.locator(settledView);
  await view.getByRole("heading", { name: "No Agents yet", exact: true }).waitFor();
  const noteBlock = view.getByRole("status").filter({ hasText: NOT_READY });
  const note = await noteBlock.textContent();
  assert.match(note, /^Namespace status: Provisioning\. /);
  assert.ok(note.endsWith(` ${DRAFTS}`), note);
  assert.deepEqual(await statusTone(noteBlock), WARNING);
  // Create Agent still saves drafts (#2867); it points at the note, and the empty state says
  // what will happen instead of the plain invitation (finding 1990).
  const create = view.getByRole("button", { name: "Create Agent" });
  await waitForEnabled(create);
  assert.equal(await create.getAttribute("aria-describedby"), "namespace-not-ready");
  await view.getByText(DRAFT_INVITATION).waitFor();
  assert.equal(await view.getByText(INVITATION).count(), 0);
});

test("Create Agent names a provisioning Namespace's status before any start", async (t) => {
  const { fixture, namespaces } = await firstRun(t);
  const { page } = await newPage(t, fixture, { browser });
  // An Installation that provisions Dedicated Agents as they are created.
  await routeInstallationProvisioning(page, fixture);
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
  assert.deepEqual(await statusTone(note), WARNING);
  // The form keeps the note, and says a Dedicated Agent waits for the Namespace instead of
  // promising it deploys when created (finding 1990).
  await start.click();
  await view.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
  const formNote = view.getByRole("status").filter({ hasText: NOT_READY });
  assert.match(await formNote.textContent(), /^Namespace status: Provisioning\. /);
  assert.deepEqual(await statusTone(formNote), WARNING);
  await view
    .getByText(
      "Dedicated Agents are provisioned and deployed when created, so this Namespace must be ready first. Create Agent is unavailable until then.",
      { exact: true },
    )
    .waitFor();
  // Every step of that plan needs a ready Namespace, so the API would refuse it: Create Agent
  // waits, described by why (finding 2007).
  const create = view.getByRole("button", { name: "Create Agent", exact: true });
  assert.equal(await create.isDisabled(), true);
  assert.equal(await create.getAttribute("aria-describedby"), "create-agent-capability-status");
  // It stays in the Tab order, described by that reason, and submits nothing (class of finding
  // 2899).
  await expectReachableReason(
    page,
    create,
    (await page.locator("#create-agent-capability-status").textContent())?.trim(),
  );
  // An Embedded OpenClaw draft still saves (#2867).
  await view.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await view
    .getByText(
      "Embedded Agents are saved as drafts. Deploy them from the Agent page after creation.",
      { exact: true },
    )
    .waitFor();
  // The status line follows the harness at once; Create Agent also waits for the form's
  // repository discovery, which can still be loading.
  await waitForEnabled(create);
  assert.equal(await create.getAttribute("aria-describedby"), null);
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
      root: "/var/lib/ssh-runtime-test",
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
  const panelNote = view.getByRole("status").filter({ hasText: NOT_READY });
  assert.match(await panelNote.textContent(), /^Namespace status: Provisioning\. /);
  assert.deepEqual(await statusTone(panelNote), WARNING);
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

// Deleting and failed Namespaces take no new Agent and neither becomes ready by waiting; each
// names its own reason (finding 1932 for failed).
const UNAVAILABLE = [
  [
    "deleting",
    "Namespace status: Deleting. This Namespace is being deleted, so it cannot hold new Agents. Choose another Namespace.",
  ],
  [
    "failed",
    "Namespace status: Failed. Provisioning this Namespace failed, so it cannot hold new Agents. Ask an operator to check it on the Namespaces page, or choose another Namespace.",
  ],
];

for (const [status, reason] of UNAVAILABLE) {
  test(`with only a ${status} Namespace, the pick names it and offers no wait`, async (t) => {
    const { fixture, namespaces } = await firstRun(t);
    const { page } = await newPage(t, fixture, { browser });
    await reportNamespaces(page, new Map([[namespaces.default.id, { status }]]));
    await login(page, fixture, "/console/");
    const view = page.locator(settledView);
    await view.getByRole("heading", { name: "No Agents yet" }).waitFor();
    const note = view.getByRole("status").filter({ hasText: reason.split(".")[0] });
    assert.equal(await note.textContent(), reason);
    await view.getByText("Agents cannot be created in this Namespace.").waitFor();
    assert.equal(await view.getByText(INVITATION).count(), 0);
    assert.equal(await view.getByText(DRAFT_INVITATION).count(), 0);
    assert.deepEqual(await statusTone(note), WARNING);
    const create = view.getByRole("button", { name: "Create Agent" });
    assert.equal(await create.isDisabled(), true);
    assert.equal(await create.getAttribute("aria-describedby"), "namespace-not-ready");

    // Create Agent itself refuses to start, with the same reason.
    await page.goto(
      new URL(`/console/agents/new?namespace=${namespaces.default.id}`, fixture.origin).href,
    );
    await view.getByRole("heading", { name: "Creating Agents is not available" }).waitFor();
    assert.equal(await view.getByRole("status").filter({ hasText: reason }).count(), 1);
    assert.equal(await view.getByRole("button", { name: "Start without Preset" }).count(), 0);
  });
}

test("a return to the Agents list and Create Agent shows a Namespace that became ready", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "team");
  const { page } = await newPage(t, fixture, { browser });
  // The Namespace reads as an adopted, provisioning one until it is released.
  const patches = new Map([[namespace.id, { status: "provisioning", existingNamespace: "team" }]]);
  await reportNamespaces(page, patches);
  await routeInstallationProvisioning(page, fixture);
  const view = page.locator(settledView);
  // Both views are kept for a return while the Namespace is provisioning.
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await view.getByRole("heading", { name: "Creating Agents is not available" }).waitFor();
  await page
    .locator(".content .page-header")
    .getByRole("link", { name: "← Agents", exact: true })
    .click();
  await view.getByRole("status").filter({ hasText: NOT_READY }).waitFor();
  assert.equal(await view.getByRole("button", { name: "Create Agent" }).isDisabled(), true);

  patches.delete(namespace.id);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces" }).waitFor();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await view.getByText(INVITATION).waitFor();
  assert.equal(await view.getByText(NOT_READY).count(), 0);
  await view.getByRole("button", { name: "Create Agent" }).click();
  await view.getByRole("button", { name: "Start without Preset" }).click();
  assert.equal(await view.getByText("Creating Agents is not available").count(), 0);
  // A ready Namespace's form keeps its plain promise and shows no note.
  await view.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
  await view
    .getByText("Dedicated Agents are provisioned and deployed when created.", { exact: true })
    .waitFor();
  assert.equal(await view.getByText(NOT_READY).count(), 0);
});

// A reader who stays on the Agents list, with no refocus, return or Refresh, kept seeing the
// provisioning note after the Namespace turned ready (finding 2058). The list rereads the
// Namespace at Create Agent's cadence while the note waits, updates it in place so the search
// text and focus stay, reads nothing while the tab is hidden, and stops once it is ready.
test("the Agents list sees its Namespace become ready without a Refresh", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "team");
  const { page } = await newPage(t, fixture, { browser });
  await page.clock.install({ time: new Date("2026-10-20T12:00:00Z") });
  const patches = new Map([[namespace.id, { status: "provisioning" }]]);
  await reportNamespaces(page, patches);
  await routeInstallationProvisioning(page, fixture);
  const view = page.locator(settledView);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await view.getByRole("status").filter({ hasText: NOT_READY }).waitFor();
  await view.getByText(DRAFT_INVITATION).waitFor();
  const reads = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/namespaces") {
      reads.push(response);
    }
  });
  // One check: its read must arrive, so its answer, not the absence of one, keeps the note.
  const poll = async () => {
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/namespaces",
    );
    await page.clock.runFor(10_000);
    await read;
  };
  await poll();
  await view.getByRole("status").filter({ hasText: NOT_READY }).waitFor();
  // A hidden tab reads nothing. Only the property changes, so the page's own visibility
  // recheck stays out of this.
  const hidden = (value) =>
    page.evaluate((shown) => {
      Object.defineProperty(globalThis.document, "hidden", {
        configurable: true,
        get: () => shown,
      });
    }, value);
  await hidden(true);
  const beforeHidden = reads.length;
  await page.clock.runFor(30_000);
  assert.equal(reads.length, beforeHidden);
  await hidden(false);
  // The reader is typing a search when the Namespace turns ready.
  const search = view.getByRole("searchbox", { name: "Search Agents" });
  await search.fill("Probe");
  release();
  await poll();
  const readyNote = view
    .getByRole("status")
    .filter({ hasText: "Namespace status: Ready. Agents created here can be deployed now." });
  await readyNote.waitFor();
  assert.deepEqual(await statusTone(readyNote), { ...WARNING, tone: "success" });
  assert.equal(await view.getByText(NOT_READY).count(), 0);
  const create = view.getByRole("button", { name: "Create Agent" });
  await waitForEnabled(create);
  assert.equal(await create.getAttribute("aria-describedby"), null);
  assert.equal(await search.inputValue(), "Probe");
  assert.equal(await hasFocus(search), true);
  await search.fill("");
  await view.getByText(INVITATION).waitFor();
  // A ready Namespace needs no more checks.
  const settled = reads.length;
  await page.clock.runFor(30_000);
  assert.equal(reads.length, settled);

  function release() {
    patches.delete(namespace.id);
  }
});

// The Agents list waiting on a provisioning Namespace, with the page clock held: `poll()` runs one
// check and waits for its read to arrive, so its answer, not the absence of one, is what shows.
async function waitingList(t) {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "team");
  const { page } = await newPage(t, fixture, { browser });
  await page.clock.install({ time: new Date("2026-10-20T12:00:00Z") });
  const patches = new Map([[namespace.id, { status: "provisioning" }]]);
  await reportNamespaces(page, patches);
  await routeInstallationProvisioning(page, fixture);
  const view = page.locator(settledView);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await view.getByRole("status").filter({ hasText: NOT_READY }).waitFor();
  await view.getByText(DRAFT_INVITATION).waitFor();
  const reads = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/namespaces") {
      reads.push(response.status());
    }
  });
  // Requests, not answers: a check started but not yet answered still counts.
  let requested = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/namespaces") {
      requested += 1;
    }
  });
  const poll = async () => {
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/namespaces",
    );
    await page.clock.runFor(10_000);
    await read;
  };
  // No check comes over three more cadences.
  const assertStopped = async () => {
    const settled = requested;
    await page.clock.runFor(30_000);
    assert.equal(requested, settled);
  };
  const create = view.getByRole("button", { name: "Create Agent" });
  const set = (patch) => patches.set(namespace.id, patch);
  return { fixture, namespace, page, view, reads, poll, assertStopped, create, set };
}

// Only the provisioning-to-ready turn was pinned (finding 2082). A Namespace that fails or starts
// deleting while the list waits takes no new Agent: the gate, its note and the empty state follow,
// and the wait ends.
for (const [status, reason] of [
  ["failed", "Namespace status: Failed. Provisioning this Namespace failed"],
  ["deleting", "Namespace status: Deleting. This Namespace is being deleted"],
]) {
  test(`the Agents list turns its gate off when its Namespace turns ${status}`, async (t) => {
    const { view, poll, assertStopped, create, set } = await waitingList(t);
    assert.equal(await create.isEnabled(), true);
    set({ status });
    await poll();
    const note = view.getByRole("status").filter({ hasText: reason });
    await note.waitFor();
    assert.deepEqual(await statusTone(note), WARNING);
    assert.equal(await create.isDisabled(), true);
    assert.equal(await create.getAttribute("aria-describedby"), "namespace-not-ready");
    assert.equal(await note.getAttribute("id"), "namespace-not-ready");
    await view.getByText("Agents cannot be created in this Namespace.", { exact: true }).waitFor();
    assert.equal(await view.getByText(DRAFT_INVITATION).count(), 0);
    await assertStopped();
  });
}

// A list read without the selected Namespace (deleted, or access removed) ended the wait and left
// "Provisioning" with Create Agent enabled for as long as the reader stayed (finding 2081). It
// now says the Namespace is missing, as Create Agent does, and disables Create Agent.
test("the Agents list names a Namespace that left the list while it waited", async (t) => {
  const { view, poll, assertStopped, create, set } = await waitingList(t);
  set(null);
  await poll();
  const note = view.getByRole("status").filter({
    hasText: `${NAMESPACE_UNAVAILABLE}. Choose another Namespace.`,
  });
  await note.waitFor();
  assert.deepEqual(await statusTone(note), WARNING);
  assert.equal(await view.getByText(NOT_READY).count(), 0);
  assert.equal(await create.isDisabled(), true);
  assert.equal(await create.getAttribute("aria-describedby"), "namespace-not-ready");
  assert.equal(await view.getByRole("heading", { name: /No .*Agents/ }).count(), 0);
  await assertStopped();
});

// An unchanged or failed read changes nothing on screen, and the next check still comes
// (finding 2082).
test("the Agents list keeps checking its Namespace after a failed read", async (t) => {
  const { page, view, reads, poll, create, set } = await waitingList(t);
  // An unchanged answer leaves the note as it is: the same node, not announced again.
  const note = view.getByRole("status").filter({ hasText: NOT_READY });
  await note.evaluate((node) => {
    node.dataset.kept = "";
  });
  await poll();
  assert.equal(await view.locator("#namespace-not-ready[data-kept]").count(), 1);
  await page.route(
    (url) => url.pathname === "/namespaces",
    (route) => route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Try again.")),
    { times: 1 },
  );
  await poll();
  assert.deepEqual(reads, [200, 503]);
  await view.getByRole("status").filter({ hasText: NOT_READY }).waitFor();
  set({ status: "ready" });
  await poll();
  await view
    .getByRole("status")
    .filter({ hasText: "Namespace status: Ready. Agents created here can be deployed now." })
    .waitFor();
  await waitForEnabled(create);
});

// A list kept for a return comes back with its check stopped; it starts again on the return
// (finding 2082). The check that came due while the reader was away found the page gone.
test("a return to a kept Agents list mid-wait keeps checking its Namespace", async (t) => {
  const { page, view, poll, create, set } = await waitingList(t);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces" }).waitFor();
  await page.clock.runFor(10_000);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await view.getByRole("status").filter({ hasText: NOT_READY }).waitFor();
  set({ status: "ready" });
  await poll();
  await view
    .getByRole("status")
    .filter({ hasText: "Namespace status: Ready. Agents created here can be deployed now." })
    .waitFor();
  await waitForEnabled(create);
});

// Create Agent open on a provisioning Namespace with a Dedicated plan waits for the Namespace.
// The page skips its own recheck while a form is open, so the form rechecks the Namespace itself
// and updates only the gate: the typed name, its caret and focus stay (finding 2012).
const WAITS =
  "Dedicated Agents are provisioned and deployed when created, so this Namespace must be ready first. Create Agent is unavailable until then.";
const READY_PLAN = "Dedicated Agents are provisioned and deployed when created.";

async function openGatedForm(t, { fixture, namespace }, { clock = false } = {}) {
  const { page } = await newPage(t, fixture, { browser });
  if (clock) {
    await page.clock.install({ time: new Date("2026-10-19T12:00:00Z") });
  }
  // The Namespace reads as provisioning, and takes drafts, until it is released.
  const patches = new Map([[namespace.id, { status: "provisioning" }]]);
  await reportNamespaces(page, patches);
  await routeInstallationProvisioning(page, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  const view = page.locator(settledView);
  await view.getByRole("button", { name: "Start without Preset" }).click();
  await view.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
  await view.getByText(WAITS, { exact: true }).waitFor();
  const create = view.getByRole("button", { name: "Create Agent", exact: true });
  assert.equal(await create.isDisabled(), true);
  // The reader is mid-edit: the caret sits inside the typed name.
  const name = view.getByLabel("Agent name");
  await name.fill("Probe Agent");
  await name.evaluate((input) => input.setSelectionRange(5, 5));
  return { page, view, create, name, release: () => patches.delete(namespace.id) };
}

async function assertDraftIntact(name) {
  assert.equal(await name.inputValue(), "Probe Agent");
  assert.deepEqual(
    await name.evaluate((input) => [
      globalThis.document.activeElement === input,
      input.selectionStart,
      input.selectionEnd,
    ]),
    [true, 5, 5],
  );
}

// One console for the gated-form cases; each case's page reads the Namespace as provisioning
// until it releases it.
test("Create Agent waiting on a provisioning Namespace", async (t) => {
  const team = await createReadyConsoleNamespace(t, "team");

  await t.test(
    "a refocus re-enables Create Agent once the Namespace is ready, keeping the draft",
    async (t) => {
      const { page, view, create, name, release } = await openGatedForm(t, team);
      release();
      await refocus(page);
      await view.getByText(READY_PLAN, { exact: true }).waitFor();
      // Create Agent also waits for the form's repository discovery.
      await waitForEnabled(create);
      assert.equal(await create.getAttribute("aria-describedby"), null);
      assert.equal(await view.getByText(WAITS).count(), 0);
      assert.equal(await view.getByText(NOT_READY).count(), 0);
      await assertDraftIntact(name);
    },
  );

  await t.test(
    "an open form waiting on the Namespace sees it become ready without a refocus",
    async (t) => {
      const { page, view, create, name, release } = await openGatedForm(t, team, { clock: true });
      // One poll: its read must arrive, so its answer, not the absence of one, keeps the gate.
      const poll = async () => {
        const read = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/namespaces",
        );
        await page.clock.runFor(10_000);
        await read;
      };
      // A Namespace still provisioning keeps the gate.
      await poll();
      await view.getByText(WAITS, { exact: true }).waitFor();
      assert.equal(await create.isDisabled(), true);
      release();
      await poll();
      await view.getByText(READY_PLAN, { exact: true }).waitFor();
      await waitForEnabled(create);
      assert.equal(await view.getByText(NOT_READY).count(), 0);
      await assertDraftIntact(name);
    },
  );

  await t.test("Start over leaves one Namespace poll, not one per form", async (t) => {
    const { page, view } = await openGatedForm(t, team, { clock: true });
    page.once("dialog", (dialog) => void dialog.accept());
    await view.getByRole("button", { name: "Start over", exact: true }).click();
    await view.getByRole("button", { name: "Start without Preset" }).click();
    await view.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
    await view.getByText(WAITS, { exact: true }).waitFor();
    const reads = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/namespaces") {
        reads.push(response);
      }
    });
    // Two polls: by the time the second one's read arrives, a read any replaced form started on
    // the first one has arrived too.
    for (let poll = 0; poll < 2; poll += 1) {
      const read = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/namespaces",
      );
      await page.clock.runFor(10_000);
      await read;
    }
    assert.equal(reads.length, 2);
  });
});

// A provisioning Namespace accepts drafts. Losing access during its idle check must also
// remove those already-visible Agents, including when search redraws the collection.
for (const reader of [false, true]) {
  for (const width of [1440, 390]) {
    test(`idle collection removes revoked Namespace rows for ${reader ? "reader" : "admin"} at ${width}px`, async (t) => {
      const { fixture, namespaces } = await firstRun(t, ["Idle collection"]);
      const namespace = namespaces["Idle collection"];
      const agent = await fixture.createAgent(namespace.id, "Private draft", nativeValues("idle"));
      const member = reader
        ? await fixture.createNamespaceMember("idle-reader", namespace.id, AGENT_READ)
        : null;
      const { page } = await newPage(t, fixture, { browser });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.clock.install();
      await login(
        page,
        fixture,
        `/console/agents?namespace=${namespace.id}`,
        member?.credentials ?? fixture.credentials,
      );
      const search = page.getByRole("searchbox", { name: "Search Agents" });
      await page.getByRole("link", { name: agent.name, exact: true }).waitFor();
      await search.fill("Private");
      const focused = reader ? search : page.getByRole("link", { name: agent.name, exact: true });
      await focused.focus();
      const held = await holdRequests(t, page, (url) => url.pathname === "/namespaces", {
        once: true,
      });
      await page.clock.runFor(10_000);
      await held.requested;
      // The slow read keeps the focused control until IAM supplies its new answer.
      assert.equal(await hasFocus(focused), true);
      if (reader) {
        revokeMemberGrant(fixture, "idle-reader", ["read", "namespace"]);
      } else {
        revokeAdministratorGrant(fixture, ["read", "namespace"]);
      }
      held.release();
      await page
        .getByText(`${NAMESPACE_UNAVAILABLE}. Choose another Namespace.`, { exact: true })
        .waitFor();
      assert.equal(await page.getByRole("link", { name: agent.name, exact: true }).count(), 0);
      assert.equal(await hasFocus(search), true);
      assert.equal(await page.getByRole("heading", { name: /No .*Agents/ }).count(), 0);
      await search.fill("");
      assert.equal(await page.getByRole("heading", { name: /No .*Agents/ }).count(), 0);
      assert.equal(await page.getByText(agent.id, { exact: true }).count(), 0);
      assert.equal(
        await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
        true,
      );
    });
  }
}

// A slow initial Namespace response can still say provisioning after the Namespace becomes
// ready and an Agent is deployed. Keep that real response while later reads use current state.
for (const kind of ["stop", "delete"]) {
  for (const outcome of ["unsubmitted", "accepted", "unknown", "failed", "expired", "previous"]) {
    test(`collection ${kind} dialog closes on Namespace loss with ${outcome} request`, async (t) => {
      const { fixture, namespaces } = await firstRun(t, ["Dialog race"]);
      const namespace = namespaces["Dialog race"];
      const { page } = await newPage(t, fixture, { browser });
      await page.clock.install();
      const initial = await holdRequests(t, page, (url) => url.pathname === "/namespaces", {
        once: true,
        afterServer: true,
      });
      const opening = login(page, fixture, `/console/agents?namespace=${namespace.id}`);
      await initial.requested;
      const admin = fixture.policy.roles.find((role) => role.name === "Installation administrator");
      const actor = fixture.policy.bindings.find(
        (binding) => binding.roleId === admin.id,
      ).subjectId;
      await fixture.controller.handleNamespaceLifecycle(actor, namespace.id, "ready");
      const agent = await fixture.createAgent(namespace.id, "Dialog Agent", nativeValues("dialog"));
      await fixture.seedActiveAgentRevision(namespace.id, agent.id);
      initial.release();
      await opening;
      const row = page.getByRole("row").filter({ hasText: agent.name });
      await row.waitFor();
      await row
        .getByRole("button", {
          name: `${kind === "stop" ? "Stop" : "Delete"} ${agent.name}`,
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      const confirm = dialog.getByRole("button", {
        name: kind === "stop" ? "Stop Agent" : "Permanently delete Agent",
        exact: true,
      });
      const method = kind === "stop" ? "POST" : "DELETE";
      const path = `/namespaces/${namespace.id}/agents/${agent.id}${kind === "stop" ? "/stop" : ""}`;
      let writes = 0;
      page.on("request", (request) => {
        if (request.method() === method && new URL(request.url()).pathname === path) {
          writes += 1;
        }
      });
      let mutation;
      let priorRequestId;
      if (outcome === "failed" || outcome === "previous") {
        revokeAdministratorGrant(fixture, [kind === "stop" ? "operate" : "delete", "agent"]);
      }
      if (outcome !== "unsubmitted") {
        // Hold the real API answer across access loss. A lost answer stays unknown;
        // a refusal stays refused. Neither outcome may trigger another write.
        mutation = await holdRequests(t, page, (url) => url.pathname === path, {
          once: true,
          method,
          afterServer: outcome !== "expired",
          loseResponse: outcome === "unknown",
        });
        await confirm.click();
        const response = await mutation.requested;
        if (outcome !== "expired") {
          assert.equal(
            response.status(),
            outcome === "failed" || outcome === "previous" ? 403 : 202,
          );
        }
        // Existing feedback contains both the Agent name and the refusal request ID.
        if (outcome === "previous") {
          mutation.release();
          await page.getByRole("alert").filter({ hasText: agent.name }).waitFor();
          await dialog.waitFor({ state: "detached" });
          priorRequestId = await page.getByText(/^Request ID:/).innerText();
        }
      }
      revokeAdministratorGrant(fixture, ["read", "namespace"]);
      await page.clock.runFor(10_000);
      // A modal makes the collection inaccessible; observe the actual note without relying
      // on accessibility-tree visibility to detect that the background read has completed.
      await page.waitForFunction(() =>
        globalThis.document
          .querySelector("#namespace-not-ready")
          ?.textContent.includes("your access does not include it"),
      );
      t.diagnostic(
        `dialog open=${await dialog.count()}, submission enabled=${outcome === "unsubmitted" && (await dialog.count()) ? await confirm.isEnabled() : false}`,
      );
      assert.equal(await dialog.count(), 0);
      // The closed dialog leaves the page in its close event, a task after it closes. The page
      // text checked below includes hidden elements, so wait until it is gone.
      await page.locator(`dialog.agent-${kind}-dialog`).waitFor({ state: "detached" });
      const search = page.getByRole("searchbox", { name: "Search Agents" });
      assert.equal(await hasFocus(search), true);
      // Expire the session after the Namespace poll, before the pending write reaches IAM.
      if (outcome === "expired") {
        expireSessions(fixture);
      }
      mutation?.release();
      if (outcome === "accepted") {
        await page
          .getByText(
            kind === "stop"
              ? "Stop request accepted. This Namespace is no longer available."
              : "Deletion request accepted. This Namespace is no longer available.",
          )
          .waitFor();
      } else if (outcome === "unknown") {
        await page.getByText(/^Outcome unknown\./).waitFor();
      }
      if (outcome === "failed") {
        await page
          .getByText("The request was not accepted. This Namespace is no longer available.", {
            exact: true,
          })
          .waitFor();
      }
      if (outcome === "expired") {
        await page.getByText("Your session has expired", { exact: false }).waitFor();
        assert.equal(writes, 1);
        return;
      }
      const visible = await page.locator("body").textContent();
      assert.equal(visible.includes(agent.name), false);
      assert.equal(visible.includes(agent.id), false);
      assert.equal(visible.includes("Request ID:"), false);
      if (priorRequestId) {
        assert.equal(visible.includes(priorRequestId), false);
      }
      assert.equal(
        /Select Refresh|View Agent|No Agents yet|No matching Agents/.test(visible),
        false,
      );
      assert.equal(writes, outcome === "unsubmitted" ? 0 : 1);
      assert.equal(await page.getByRole("link", { name: agent.name, exact: true }).count(), 0);
      assert.equal(await hasFocus(search), true);
    });
  }
}
