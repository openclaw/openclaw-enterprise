import assert from "node:assert/strict";
import test from "node:test";

import { fileBrowser, login, newPage, settledView } from "./console-agents-browser-helpers.mjs";
import { routeInstallationProvisioning } from "./console-agents-test-support.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

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

const browser = fileBrowser();

// Answers GET /namespaces from the real API with the Namespace's status replaced while `status`
// is set. `fail` answers that many reads with a 503; `hold()` keeps the next reads unanswered
// until its release. `reads` counts the reads the page started.
async function routeNamespace(page, namespaceId) {
  const state = { status: "provisioning", fail: 0, reads: 0, held: null };
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
        await route.fulfill({
          status: 503,
          json: { error: { code: "DEPENDENCY_UNAVAILABLE", message: "Try again." } },
        });
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      body.data = body.data.map((item) =>
        item.id === namespaceId && state.status ? { ...item, status: state.status } : item,
      );
      await route.fulfill({ response, json: body });
    },
  );
  return state;
}

// A Dedicated plan waiting on the provisioning Namespace, on a controlled clock, with a name
// being typed: the caret sits inside it.
async function openGatedForm(t, { fixture, namespace }, viewport) {
  const { page } = await newPage(t, fixture, { browser });
  if (viewport) {
    await page.setViewportSize(viewport);
  }
  await page.clock.install({ time: new Date("2026-10-19T12:00:00Z") });
  // The console calls fetch as a read starts, so this count is exact once a tick returns. Its
  // answer's handlers run in the microtasks after the body is read, before the next evaluation.
  await page.addInitScript(() => {
    globalThis.__namespaceReads = 0;
    globalThis.__namespaceAnswers = 0;
    const fetch = globalThis.fetch;
    globalThis.fetch = (resource, ...rest) => {
      const answer = fetch(resource, ...rest);
      if (new URL(String(resource), globalThis.location.href).pathname !== "/namespaces") {
        return answer;
      }
      globalThis.__namespaceReads += 1;
      return answer.then((response) => {
        const json = response.json.bind(response);
        response.json = () =>
          json().finally(() => {
            globalThis.__namespaceAnswers += 1;
          });
        return response;
      });
    };
  });
  const namespaces = await routeNamespace(page, namespace.id);
  await routeInstallationProvisioning(page, fixture);
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
  const started = () => page.evaluate(() => globalThis.__namespaceReads);
  // Waits until the page has read `count` answers' bodies (bounded by the test's own timeout).
  const answered = async (count) => {
    while ((await page.evaluate(() => globalThis.__namespaceAnswers)) < count) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  // One 10 s tick whose read must arrive, so its answer, not the absence of one, decides.
  const poll = async () => {
    const before = namespaces.reads;
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/namespaces",
    );
    await page.clock.runFor(10_000);
    await read;
    assert.equal(namespaces.reads, before + 1);
  };
  // Ticks that must start no read: the reads count is checked after each.
  const idle = async (ticks = 3) => {
    const before = await started();
    for (let tick = 0; tick < ticks; tick += 1) {
      await page.clock.runFor(10_000);
    }
    assert.equal(await started(), before);
  };
  await page.evaluate(() => {
    globalThis.__namespaceAnswers = 0;
  });
  return { page, view, create, name, namespaces, poll, idle, started, answered };
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
    assert.equal(await create.isDisabled(), false);
    await assertDraftIntact(name);
  });

  await t.test("a Namespace that turns failed ends the recheck and says why", async (t) => {
    const { view, create, name, namespaces, poll, idle } = await openGatedForm(t, team);
    namespaces.status = "failed";
    await poll();
    await view.getByRole("status").filter({ hasText: "Namespace status: Failed." }).waitFor();
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
    await idle();
  });

  await t.test("the note changes in place, so the field being edited stays put", async (t) => {
    const { page, view, create, name, namespaces, poll } = await openGatedForm(t, team, {
      width: 1440,
      height: 900,
    });
    await page.evaluate(() => globalThis.scrollTo(0, 0));
    const top = () => name.evaluate((input) => input.getBoundingClientRect().top);
    const before = await top();
    namespaces.status = null;
    await poll();
    await view.getByText(READY_PLAN, { exact: true }).waitFor();
    assert.equal(await create.isDisabled(), false);
    const note = view.getByRole("status").filter({ hasText: READY_NOTE });
    assert.equal(await note.textContent(), READY_NOTE);
    assert.equal(await note.getAttribute("data-tone"), "success");
    assert.equal(await view.getByText(NOT_READY).count(), 0);
    assert.equal(await top(), before);
    await assertDraftIntact(name);
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
    assert.equal(await create.isDisabled(), false);
  });

  await t.test("the recheck runs only while Create Agent waits on the Namespace", async (t) => {
    const { view, create, poll, idle } = await openGatedForm(t, team);
    // An Embedded draft saves on a provisioning Namespace: nothing waits, so nothing polls.
    await view.getByLabel("Harness", { exact: true }).selectOption("openclaw");
    await view.getByText(DRAFT_PLAN, { exact: true }).waitFor();
    assert.equal(await create.isDisabled(), false);
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
    await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event("focus")));
    await page.clock.runFor(10_000);
    await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event("focus")));
    assert.equal(await started(), before + 1);
    namespaces.status = null;
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/namespaces",
    );
    release();
    await read;
    await view.getByText(READY_PLAN, { exact: true }).waitFor();
    assert.equal(await create.isDisabled(), false);
    assert.equal(await started(), before + 1);
  });

  await t.test("a return to the kept form rechecks the Namespace", async (t) => {
    const { page, view, create, name, namespaces } = await openGatedForm(t, team);
    await page.getByRole("link", { name: "Namespaces", exact: true }).click();
    await page.getByRole("list", { name: "Namespaces" }).waitFor();
    // The form's pending tick passes while it is away.
    await page.clock.runFor(10_000);
    namespaces.status = null;
    namespaces.reads = 0;
    await page.goBack();
    await name.waitFor();
    await view.getByText(READY_PLAN, { exact: true }).waitFor();
    assert.equal(await create.isDisabled(), false);
    assert.equal(await name.inputValue(), "Probe Agent");
    assert.ok(namespaces.reads >= 1);
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
    const { page, view, create, namespaces, started, answered } = await openGatedForm(t, team);
    const release = namespaces.hold();
    const before = await started();
    await page.clock.runFor(10_000);
    assert.equal(await started(), before + 1);
    // The replaced form's controls, kept to inspect after its read is answered.
    const replaced = await create.elementHandle();
    page.once("dialog", (dialog) => void dialog.accept());
    await view.getByRole("button", { name: "Start over", exact: true }).click();
    await view.getByRole("button", { name: "Start without Preset" }).waitFor();
    namespaces.status = null;
    release();
    await answered(1);
    assert.deepEqual(await replaced.evaluate((node) => [node.isConnected, node.disabled]), [
      false,
      true,
    ]);
  });
});
