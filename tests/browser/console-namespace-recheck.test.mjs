import assert from "node:assert/strict";
import test from "node:test";

import {
  fileBrowser,
  fulfillPatchedJson,
  login,
  newPage,
  settledFetches,
  settledView,
  trackSettledFetches,
  waitForEnabled,
  waitForIdleFetches,
  waitForSettledFetches,
} from "./console-agents-browser-helpers.mjs";
import { apiErrorResponse } from "../helpers/api-error.mjs";
import { NAMESPACE_UNAVAILABLE } from "../helpers/refusal-text.mjs";
import { routeInstallationProvisioning } from "./console-agents-test-support.mjs";
import { refocus } from "./console-refocus-helpers.mjs";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.mjs";

// Create Agent open on a provisioning Namespace rechecks it every 10 s while a Dedicated plan
// waits for it (finding 2012). These cases pin when that recheck runs and stops: a failed read
// keeps it going (finding 2021), a failed or deleting Namespace ends it (finding 2022), the note
// changes in place so the field being edited stays put (finding 2024), and the stop and resume
// rules bughunt-129 found unpinned (finding 2023).
const WAITS =
  "Dedicated Agents are provisioned and deployed when created, so this Namespace must be ready first. Create Agent is unavailable until then.";
const READY_PLAN = "Dedicated Agents are provisioned and deployed when created.";
const DRAFT_PLAN =
  "Embedded Agents are saved as drafts. Deploy them from the Agent page after creation.";
const NOT_READY = /This Namespace is not ready yet\. Check its status on the Namespaces page/;
const READY_NOTE = "Namespace status: Ready. Agents created here can be deployed now.";
const REFUSES = "This Namespace cannot hold new Agents, so Create Agent is unavailable.";
const ADOPTED_WAITS = "Create Agent is unavailable until this Namespace is ready.";
const MISSING = `${NAMESPACE_UNAVAILABLE}. Choose another Namespace.`;
const MISSING_LINE = "Create Agent is unavailable until you choose another Namespace.";

const browser = fileBrowser();

// Answers GET /namespaces from the real API with the Namespace's status replaced while `status`
// is set, and `fields` merged in; `absent` leaves it out of the list. `fail` answers that many reads with a 503; `hold()` keeps the next reads unanswered
// until its release. `reads` counts the reads the page started.
async function routeNamespace(page, namespaceId) {
  const state = {
    status: "provisioning",
    fields: {},
    absent: false,
    fail: 0,
    reads: 0,
    held: null,
  };
  state.hold = () => {
    let release;
    state.held = new Promise((resolve) => {
      release = resolve;
    });
    return () => {
      state.held = null;
      release();
    };
  };
  await page.route(
    (url) => url.pathname === "/namespaces",
    async (route) => {
      state.reads += 1;
      await state.held;
      if (state.fail > 0) {
        state.fail -= 1;
        await route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Try again."));
        return;
      }
      await fulfillPatchedJson(route, (body) => {
        body.data = body.data.filter((item) => !(state.absent && item.id === namespaceId));
        body.data = body.data.map((item) =>
          item.id === namespaceId && state.status
            ? { ...item, ...state.fields, status: state.status }
            : item,
        );
        return body;
      });
    },
  );
  return state;
}

// A Dedicated plan waiting on the provisioning Namespace, on a controlled clock, with a name
// being typed: the caret sits inside it.
async function openGatedForm(t, { fixture, namespace }, { viewport, keepable = false } = {}) {
  const { page } = await newPage(t, fixture, { browser });
  if (viewport) {
    await page.setViewportSize(viewport);
  }
  await page.clock.install({ time: new Date("2026-10-19T12:00:00Z") });
  // Settled reads, for a late answer; and started ones: the console calls fetch as a read starts,
  // so that count is exact once a tick returns.
  await trackSettledFetches(page);
  await page.addInitScript(() => {
    globalThis.namespaceReads = 0;
    const fetch = globalThis.fetch;
    globalThis.fetch = (resource, ...rest) => {
      if (new URL(String(resource), globalThis.location.href).pathname === "/namespaces") {
        globalThis.namespaceReads += 1;
      }
      return fetch(resource, ...rest);
    };
  });
  const namespaces = await routeNamespace(page, namespace.id);
  await routeInstallationProvisioning(page, fixture);
  if (keepable) {
    // A return reuses the form only if every read it made succeeded and reads the same again:
    // this fixture has no GitHub App, and the shared route stamps each answer anew.
    await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
      route.fulfill({ json: { data: [], meta: { requestId: "req_repository_choices" } } }),
    );
    await page.route(`${fixture.origin}/installation`, (route) =>
      route.fulfill({
        json: {
          data: {
            id: "ins_00000000-0000-4000-8000-000000000001",
            name: "Console test installation",
            createdAt: "2026-10-19T12:00:00.000Z",
            capabilities: { agentProvisioning: { executionModes: ["dedicated"] } },
          },
          meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
        },
      }),
    );
  }
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  const view = page.locator(settledView);
  await view.getByRole("button", { name: "Start without Preset" }).click();
  await view.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
  await view.getByText(WAITS, { exact: true }).waitFor();
  const create = view.getByRole("button", { name: "Create Agent", exact: true });
  assert.equal(await create.isDisabled(), true);
  const name = view.getByLabel("Agent name");
  await name.fill("Probe Agent");
  await name.evaluate((input) => input.setSelectionRange(5, 5));
  namespaces.reads = 0;
  const started = () => page.evaluate(() => globalThis.namespaceReads);
  // One 10 s tick whose read must arrive, so its answer, not the absence of one, decides. It
  // returns once the page has read the answer, so the next tick is already scheduled.
  const poll = async () => {
    const before = namespaces.reads;
    const answered = await settledFetches(page, "/namespaces");
    await page.clock.runFor(10_000);
    await waitForSettledFetches(page, "/namespaces", answered + 1);
    assert.equal(namespaces.reads, before + 1);
  };
  // Ticks that must start no read.
  const idle = async (ticks = 3) => {
    const before = await started();
    for (let tick = 0; tick < ticks; tick += 1) {
      await page.clock.runFor(10_000);
    }
    assert.equal(await started(), before);
  };
  return { page, view, create, name, namespaces, poll, idle, started };
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

async function setHidden(page, hidden) {
  await page.evaluate((value) => {
    for (const [key, shown] of [
      ["hidden", value],
      ["visibilityState", value ? "hidden" : "visible"],
    ]) {
      Object.defineProperty(globalThis.document, key, { configurable: true, get: () => shown });
    }
    globalThis.document.dispatchEvent(new globalThis.Event("visibilitychange"));
  }, hidden);
}

// One console for every case; each case's page reads the Namespace as provisioning until it
// changes the status.
test("the open Create Agent form's Namespace recheck", async (t) => {
  const team = await createReadyConsoleNamespace(t, "team");

  await t.test("a failed read keeps the recheck going at its 10 s cadence", async (t) => {
    const { view, create, name, namespaces, poll } = await openGatedForm(t, team);
    namespaces.fail = 1;
    await poll();
    await view.getByText(WAITS, { exact: true }).waitFor();
    assert.equal(await create.isDisabled(), true);
    namespaces.status = null;
    await poll();
    await view.getByText(READY_PLAN, { exact: true }).waitFor();
    await waitForEnabled(create);
    await assertDraftIntact(name);
  });

  for (const status of ["failed", "deleting"]) {
    const label = `${status[0].toUpperCase()}${status.slice(1)}`;
    await t.test(`a Namespace that turns ${status} ends the recheck and says why`, async (t) => {
      const { view, create, name, namespaces, poll, idle } = await openGatedForm(t, team);
      namespaces.status = status;
      await poll();
      await view
        .getByRole("status")
        .filter({ hasText: `Namespace status: ${label}.` })
        .waitFor();
      await view.getByText(REFUSES, { exact: true }).waitFor();
      assert.equal(await view.getByText(WAITS).count(), 0);
      assert.equal(await create.isDisabled(), true);
      assert.equal(await create.getAttribute("aria-describedby"), "create-agent-capability-status");
      await assertDraftIntact(name);
      // It never becomes ready by waiting, and it takes no draft either.
      await idle();
      await view.getByLabel("Harness", { exact: true }).selectOption("openclaw");
      await view.getByText(REFUSES, { exact: true }).waitFor();
      assert.equal(await create.isDisabled(), true);
      // A draft plan waits on nothing, so only the refusal still names the reason (finding 2039).
      assert.equal(await create.getAttribute("aria-describedby"), "create-agent-capability-status");
      await idle();
    });
  }

  await t.test(
    "an adopted Namespace still provisioning takes no draft but is rechecked",
    async (t) => {
      const { view, create, namespaces, poll } = await openGatedForm(t, team);
      // It takes no Configuration until it is ready, so no Agent at all, but it becomes ready.
      namespaces.fields = { existingNamespace: "team" };
      await poll();
      await view.getByText(ADOPTED_WAITS, { exact: true }).waitFor();
      await view.getByLabel("Harness", { exact: true }).selectOption("openclaw");
      await view.getByText(ADOPTED_WAITS, { exact: true }).waitFor();
      assert.equal(await create.isDisabled(), true);
      assert.equal(await create.getAttribute("aria-describedby"), "create-agent-capability-status");
      await poll();
      namespaces.status = null;
      await poll();
      await view.getByText(DRAFT_PLAN, { exact: true }).waitFor();
      await waitForEnabled(create);
    },
  );

  await t.test(
    "a complete list without the Namespace ends the recheck and asks for another",
    async (t) => {
      const { page, view, create, name, namespaces, poll, idle } = await openGatedForm(t, team);
      // Deleted, or the reader lost access: the list says so by leaving it out.
      namespaces.absent = true;
      await poll();
      await view.getByRole("status").filter({ hasText: MISSING }).waitFor();
      await view.getByText(MISSING_LINE, { exact: true }).waitFor();
      assert.equal(await view.getByText(NOT_READY).count(), 0);
      assert.equal(await create.isDisabled(), true);
      await assertDraftIntact(name);
      await idle();
      await view.getByLabel("Harness", { exact: true }).selectOption("openclaw");
      assert.equal(await create.isDisabled(), true);
      assert.equal(await create.getAttribute("aria-describedby"), "create-agent-capability-status");
      await idle();
      // Start over discards the draft, not what the form learned about the Namespace.
      page.once("dialog", (dialog) => void dialog.accept());
      await view.getByRole("button", { name: "Start over", exact: true }).click();
      await view.getByRole("heading", { name: "Creating Agents is not available" }).waitFor();
      await view.getByRole("status").filter({ hasText: MISSING }).waitFor();
      assert.equal(await view.getByRole("button", { name: "Start without Preset" }).count(), 0);
    },
  );

  await t.test("a refocus that finds the missing Namespace again resumes the form", async (t) => {
    const { page, view, create, namespaces, poll } = await openGatedForm(t, team);
    namespaces.absent = true;
    await poll();
    await view.getByText(MISSING_LINE, { exact: true }).waitFor();
    namespaces.absent = false;
    namespaces.status = null;
    await refocus(page);
    await view.getByText(READY_PLAN, { exact: true }).waitFor();
    await view.getByRole("status").filter({ hasText: READY_NOTE }).waitFor();
    await waitForEnabled(create);
  });

  await t.test("the note changes in place, so the field being edited stays put", async (t) => {
    const { page, view, create, name, namespaces, poll } = await openGatedForm(t, team, {
      viewport: { width: 1440, height: 900 },
    });
    await page.evaluate(() => globalThis.scrollTo(0, 0));
    const top = () => name.evaluate((input) => input.getBoundingClientRect().top);
    const before = await top();
    namespaces.status = null;
    await poll();
    await view.getByText(READY_PLAN, { exact: true }).waitFor();
    await waitForEnabled(create);
    const note = view.getByRole("status").filter({ hasText: READY_NOTE });
    assert.equal(await note.textContent(), READY_NOTE);
    assert.equal(await note.getAttribute("data-tone"), "success");
    assert.equal(await view.getByText(NOT_READY).count(), 0);
    assert.equal(await top(), before);
    await assertDraftIntact(name);
    // The reserved height lasts until the width changes: the form reflows then anyway, and the
    // space would only stay empty (finding 2039).
    const minHeight = () => note.evaluate((node) => node.style.minHeight);
    assert.notEqual(await minHeight(), "");
    // Listen before resizing; the product's listener, added earlier, runs first.
    await page.evaluate(() => {
      globalThis.resized = new Promise((resolve) =>
        globalThis.addEventListener("resize", resolve, { once: true }),
      );
    });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => globalThis.resized);
    assert.equal(await minHeight(), "");
  });

  await t.test("a hidden tab starts no read, and showing it again rechecks", async (t) => {
    const { page, view, create, namespaces, idle } = await openGatedForm(t, team);
    await setHidden(page, true);
    namespaces.status = null;
    await idle();
    await view.getByText(WAITS, { exact: true }).waitFor();
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/namespaces",
    );
    await setHidden(page, false);
    await read;
    await view.getByText(READY_PLAN, { exact: true }).waitFor();
    await waitForEnabled(create);
  });

  await t.test("the recheck runs only while Create Agent waits on the Namespace", async (t) => {
    const { view, create, poll, idle } = await openGatedForm(t, team);
    // An Embedded draft saves on a provisioning Namespace: nothing waits, so nothing polls.
    await view.getByLabel("Harness", { exact: true }).selectOption("openclaw");
    await view.getByText(DRAFT_PLAN, { exact: true }).waitFor();
    await waitForEnabled(create);
    await idle();
    // Back to the Dedicated plan, the wait and its recheck resume.
    await view.getByLabel("Harness", { exact: true }).selectOption("codex");
    await view.getByText(WAITS, { exact: true }).waitFor();
    await poll();
  });

  await t.test("one read at a time, whatever asks for another", async (t) => {
    const { page, view, create, namespaces, started } = await openGatedForm(t, team);
    const release = namespaces.hold();
    const before = await started();
    await page.clock.runFor(10_000);
    await refocus(page);
    await page.clock.runFor(10_000);
    await refocus(page);
    assert.equal(await started(), before + 1);
    namespaces.status = null;
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/namespaces",
    );
    release();
    await read;
    await view.getByText(READY_PLAN, { exact: true }).waitFor();
    await waitForEnabled(create);
    assert.equal(await started(), before + 1);
  });

  await t.test("a return to the kept form resumes the recheck", async (t) => {
    const { page, view, create, name, namespaces, poll, idle } = await openGatedForm(t, team, {
      keepable: true,
    });
    // The same form comes back: only a view with no read in flight is kept for a return.
    await name.evaluate((input) => {
      input.dataset.kept = "true";
    });
    await waitForIdleFetches(page);
    await page.getByRole("link", { name: "Namespaces", exact: true }).click();
    await page.getByRole("list", { name: "Namespaces" }).waitFor();
    // The form's pending tick passes while it is away, and stops there.
    await page.clock.runFor(10_000);
    await page.goBack();
    await view.getByText(WAITS, { exact: true }).waitFor();
    assert.equal(await name.getAttribute("data-kept"), "true");
    await waitForIdleFetches(page);
    await poll();
    await view.getByText(WAITS, { exact: true }).waitFor();
    // A hidden tab stops the recheck there too, and showing it again restarts it: the return
    // registers the kept form's refocus recheck again (finding 2039).
    await setHidden(page, true);
    namespaces.status = null;
    await idle();
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/namespaces",
    );
    await setHidden(page, false);
    await read;
    await view.getByText(READY_PLAN, { exact: true }).waitFor();
    await waitForEnabled(create);
    assert.equal(await name.inputValue(), "Probe Agent");
  });

  await t.test("Start over after the Namespace became ready shows no wait", async (t) => {
    const { page, view, namespaces, poll } = await openGatedForm(t, team);
    namespaces.status = null;
    await poll();
    await view.getByText(READY_PLAN, { exact: true }).waitFor();
    page.once("dialog", (dialog) => void dialog.accept());
    await view.getByRole("button", { name: "Start over", exact: true }).click();
    await view.getByRole("button", { name: "Start without Preset" }).click();
    await view.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
    await view.getByText(READY_PLAN, { exact: true }).waitFor();
    assert.equal(await view.getByText(NOT_READY).count(), 0);
  });

  await t.test("a read answered after Start over leaves the replaced form alone", async (t) => {
    const { page, view, create, namespaces, started } = await openGatedForm(t, team);
    const release = namespaces.hold();
    const before = await started();
    await page.clock.runFor(10_000);
    assert.equal(await started(), before + 1);
    const answered = await settledFetches(page, "/namespaces");
    // The replaced form's controls, kept to inspect after its read is answered.
    const replaced = await create.elementHandle();
    page.once("dialog", (dialog) => void dialog.accept());
    await view.getByRole("button", { name: "Start over", exact: true }).click();
    await view.getByRole("button", { name: "Start without Preset" }).waitFor();
    namespaces.status = null;
    release();
    await waitForSettledFetches(page, "/namespaces", answered + 1);
    // Still unavailable: natively, or aria-disabled while its wait shows (class of finding 2899).
    assert.deepEqual(
      await replaced.evaluate((node) => [
        node.isConnected,
        node.disabled || node.getAttribute("aria-disabled") === "true",
      ]),
      [false, true],
    );
  });
});
