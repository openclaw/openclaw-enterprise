import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import type { Page } from "playwright";
import { CreatePresetBody, JsonValue } from "../../packages/contracts/src/api/common.ts";
import { Check } from "typebox/value";
import type { ProvisionAgentBody } from "../../packages/contracts/src/api/common.ts";
import type { PresetTemplate } from "../../packages/contracts/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { PROVISIONING_NOT_COMPLETED } from "../helpers/refusal-text.mjs";
import { trackSettledFetches } from "./console-fetch-accounting.ts";
import { fileBrowser, login, newPage } from "./console-agents-browser-helpers.ts";
import { routeInstallationProvisioning } from "./console-agents-test-support.ts";
import { provisioningJob, routeProvisioningJob } from "./console-provisioning-job-fixture.ts";
import {
  createModelCredentialSecret,
  runProvisioningPolls,
  waitForProvisioningFailure,
} from "./console-agents-ui-test-support.ts";

// Create Agent's provisioning step meter (provisioning-progress.mts). Steps come only from the
// polled job's status, phase and recorded revision; the current step's marker is an
// indeterminate throbber, static under reduced motion, and the elapsed line stays silent.

const browser = fileBrowser();

const defaultCodexPreset: { name: string; template: PresetTemplate } = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);
assert.equal(
  Reflect.apply(Check, undefined, [
    { SafeJsonValue: JsonValue },
    CreatePresetBody,
    defaultCodexPreset,
  ]),
  true,
  "Invalid default Codex Preset",
);

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;

declare global {
  var meterPaints: { states: string[]; elapsed: string }[];
}

async function readyNamespace(fixture: ConsoleFixture, name: string) {
  const created: unknown = await fixture.createNamespace(name, { ready: true });
  const id = (created as { id?: unknown }).id;
  assert.ok(typeof id === "string" && id.length > 0, "Expected a Namespace ID");
  return { id };
}

// Codex with its "Service Accounts" sign-in, a new model Secret and a listed model.
async function pickCodexCredential(page: Page) {
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, "model-secret-progress");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
}

// Opens the ready form with fetch accounting installed, so runProvisioningPolls can drive the
// page clock through its polls.
async function openCreateForm(t: TestContext, fixture: ConsoleFixture, namespace: { id: string }) {
  const { page } = await newPage(t, fixture, { browser });
  await routeInstallationProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], meta: { requestId: "req_repository_choices" } }),
    }),
  );
  await trackSettledFetches(page);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  // Wide enough that the page is wider than the form (finding 2423).
  await page.setViewportSize({ width: 1440, height: 900 });
  await pickCodexCredential(page);
  await page.getByLabel("Agent name").fill("Progress meter");
  return page;
}

// The meter's live answer: the current step line, its failure reason and each step's state.
function meterState(page: Page) {
  return page.evaluate(() => {
    const section = globalThis.document.querySelector(".provisioning-progress");
    if (!(section instanceof HTMLElement)) {
      throw new Error("Expected the provisioning step meter");
    }
    return {
      hidden: section.hidden,
      label: section.getAttribute("aria-label"),
      outcome: section.dataset.outcome ?? null,
      inActionBar: section.closest(".form-actions") !== null,
      phase: section.querySelector(".provisioning-phase")?.textContent ?? null,
      reason: section.querySelector(".provisioning-reason")?.textContent ?? null,
      reasonHidden: section.querySelector(".provisioning-reason")?.hasAttribute("hidden") ?? null,
      phaseRole: section.querySelector(".provisioning-phase")?.getAttribute("role"),
      elapsed: section.querySelector(".provisioning-elapsed")?.textContent ?? null,
      elapsedRole: section.querySelector(".provisioning-elapsed")?.getAttribute("role"),
      steps: [...section.querySelectorAll(".provisioning-step")].map((item) => ({
        state: item.getAttribute("data-state"),
        current: item.getAttribute("aria-current"),
        label: item.querySelector(".provisioning-step-label")?.textContent ?? null,
      })),
    };
  });
}

// The sticky bar's answer for a finished request: whether the meter, its reason and the Retry
// button all sit inside the same bar, on screen without scrolling.
function barState(page: Page) {
  return page.evaluate(() => {
    const meter = globalThis.document.querySelector(".provisioning-progress");
    const bar = meter?.closest(".form-actions");
    const reason = meter?.querySelector(".provisioning-reason");
    const retry = [...globalThis.document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry provisioning request",
    );
    const rect = (node?: Element | null) => {
      if (!(node instanceof HTMLElement)) {
        return null;
      }
      const box = node.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    };
    const inBar = (node?: Element | null) =>
      node instanceof Element ? bar?.contains(node) === true : false;
    return {
      viewportHeight: globalThis.window.innerHeight,
      meter: rect(meter),
      reason: rect(reason),
      retry: rect(retry),
      reasonInBar: inBar(reason),
      retryInBar: inBar(retry),
    };
  });
}

// Records each step-state layout the meter paints, with the elapsed line beside it, so one run
// can assert the whole progression. runProvisioningPolls pauses the page clock, so each layout
// is deterministic; the elapsed values only need to move forward. A layout the meter repaints
// unchanged is not recorded twice.
async function recordMeterPaints(page: Page) {
  await page.evaluate(() => {
    globalThis.meterPaints = [];
    const snapshot = () => {
      const section = globalThis.document.querySelector(".provisioning-progress");
      if (!(section instanceof HTMLElement) || section.hidden) {
        return;
      }
      const states = [...section.querySelectorAll(".provisioning-step")].map(
        (item) => item.getAttribute("data-state") ?? "",
      );
      const last = globalThis.meterPaints.at(-1);
      if (last?.states.join() === states.join()) {
        return;
      }
      globalThis.meterPaints.push({
        states,
        elapsed: section.querySelector(".provisioning-elapsed")?.textContent ?? "",
      });
    };
    new globalThis.MutationObserver(snapshot).observe(globalThis.document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
  });
}

function stepStates(states: readonly string[]) {
  const labels = [
    "Waiting for the controller worker",
    "Creating the Configuration and Agent",
    "Creating runtime credentials",
    "Starting the first deployment",
    "Agent ready",
  ];
  return states.map((state, index) => ({
    state,
    current: state === "current" ? "step" : null,
    label: labels[index],
  }));
}

test("Create Agent advances the provisioning step meter through each reported phase", async (t) => {
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, "Progress phases");
  const page = await openCreateForm(t, fixture, namespace);
  const work = provisioningJob(namespace.id, "work_progress_phases");
  const agentId = "agt_00000000-0000-4000-8000-00000000b637";
  const revisionId = "rev_00000000-0000-4000-8000-00000000b637";
  const handedOff = { agentId, configurationId: "cfg_progress", revisionId };
  // One phase per poll: the worker step, the Configuration and Agent, runtime credentials, the
  // first deployment, then success. The job's phase names the last completed phase, so the
  // meter must stay one step behind it. The queued read after handoff is the normal deferral
  // between worker checks: it keeps its completed phases and revision, so the meter must not
  // repaint every step pending.
  const reads = [
    work.job("running", { phase: "admitted" }),
    work.job("running", { phase: "configuration" }),
    work.job("running", { phase: "transport" }),
    work.job("running", { phase: "handoff", ...handedOff }),
    work.job("queued", { phase: "handoff", ...handedOff }),
    work.job("succeeded", { phase: "handoff", ...handedOff }),
  ];
  const served = await routeProvisioningJob(page, fixture, work, reads);
  // The deployment read after handoff is refused, so the status line keeps its bare sentence.
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/deployments/${revisionId}`,
    (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "NOT_FOUND", message: "No such deployment." },
          meta: { requestId: "req_deployment_missing" },
        }),
      }),
  );

  await recordMeterPaints(page);
  await runProvisioningPolls(
    page,
    () => page.getByRole("button", { name: "Create Agent", exact: true }).click(),
    work.url,
    reads.length,
  );
  assert.equal(served.reads, reads.length);
  // Success opens the created Agent, so the meter's final paint is only in the record.
  await page.waitForURL((url) => new URL(url).searchParams.get("revision") === revisionId);
  const paints = await page.evaluate(() => globalThis.meterPaints);
  assert.deepEqual(
    paints.map((paint) => paint.states),
    [
      ["current", "pending", "pending", "pending", "pending"],
      ["done", "current", "pending", "pending", "pending"],
      ["done", "done", "current", "pending", "pending"],
      ["done", "done", "done", "current", "pending"],
      ["done", "done", "done", "done", "done"],
    ],
  );
  // The elapsed line counts the same polls and moves with them, silently.
  const first = paints[0];
  const last = paints.at(-1);
  assert.ok(first && last, "Expected the meter's first and final paints");
  assert.match(first.elapsed, /^Elapsed \d+:\d\d$/u);
  assert.notEqual(first.elapsed, last.elapsed);
});

test("a failed provisioning job marks its step failed and a retry starts the meter over", async (t) => {
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, "Progress failure");
  const page = await openCreateForm(t, fixture, namespace);
  const work = provisioningJob(namespace.id, "work_progress_failed");
  const reads = [
    work.job("running", { phase: "admitted" }),
    work.job("running", { phase: "configuration" }),
    // The worker completed the Configuration phase and failed while creating runtime credentials.
    work.failed({ phase: "configuration" }),
  ];
  const served = await routeProvisioningJob(page, fixture, work, reads);
  // The retry is accepted as the same job, queued with the Configuration phase it completed
  // (the PostgreSQL retry keeps the checkpoint and resets the attempt count).
  let releaseRetry: ((value: unknown) => void) | undefined;
  const retryHeld = new Promise((release) => {
    releaseRetry = release;
  });
  await page.route(`**${work.url}/retry`, async (route) => {
    await retryHeld;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          requestId: served.requestId ?? "",
          workId: work.workId,
          status: "queued",
          phase: "configuration",
          attemptCount: 2,
          updatedAt: work.updatedAt,
          url: work.url,
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000002" },
      }),
    });
  });

  await recordMeterPaints(page);
  await runProvisioningPolls(
    page,
    () => page.getByRole("button", { name: "Create Agent", exact: true }).click(),
    work.url,
    reads.length,
  );
  await waitForProvisioningFailure(page);
  assert.equal(served.reads, reads.length);
  // The failure marks the step the job was on; the error line below owns the reason (finding
  // 2423), so the meter itself never says provisioning failed.
  const failed = await meterState(page);
  assert.equal(failed.hidden, false);
  assert.equal(failed.label, "Agent provisioning progress");
  assert.equal(failed.outcome, "failed");
  // The meter stays in the sticky action bar, where the reader selected Create Agent, and its
  // heading names the failure and the step it failed on, with the job's own reason beside it.
  assert.equal(failed.inActionBar, true);
  assert.equal(failed.phase, "Failed while creating runtime credentials.");
  assert.equal(failed.reason, PROVISIONING_NOT_COMPLETED);
  assert.equal(failed.reasonHidden, false);
  assert.equal(failed.phaseRole, "status");
  assert.equal(failed.elapsedRole, null);
  assert.match(failed.elapsed ?? "", /^Elapsed \d+:\d\d$/u);
  assert.deepEqual(failed.steps, stepStates(["done", "done", "failed", "pending", "pending"]));
  // The reason and the Retry button sit in the same sticky bar, on screen without scrolling.
  const bar = await barState(page);
  assert.equal(bar.reasonInBar, true);
  assert.equal(bar.retryInBar, true);
  assert.ok(bar.reason && bar.retry && bar.meter, "Expected the meter, reason and Retry");
  assert.ok(bar.reason.top >= 0 && bar.reason.bottom <= bar.viewportHeight, "reason off screen");
  assert.ok(bar.retry.top >= 0 && bar.retry.bottom <= bar.viewportHeight, "Retry off screen");
  assert.ok(bar.meter.top >= 0 && bar.meter.bottom <= bar.viewportHeight, "meter off screen");

  // The retry resets the meter on the click itself — not only the first submission, whose
  // layout this recorder also holds — so its record starts over here. Retry is offered only
  // now that the request ended; the retried request hides it again for its own run.
  const retryButton = page.getByRole("button", { name: "Retry provisioning request" });
  assert.equal(await retryButton.isVisible(), true);
  await page.evaluate(() => {
    globalThis.meterPaints = [];
  });
  await retryButton.click();
  assert.equal(await retryButton.isVisible(), false);
  // The retry POST is held: the reset is the retry's own doing, not the response's.
  const reset = await meterState(page);
  assert.equal(reset.phase, "Waiting for the controller worker…");
  assert.equal(reset.elapsed, "Elapsed 0:00");
  assert.deepEqual(
    reset.steps,
    stepStates(["current", "pending", "pending", "pending", "pending"]),
  );
  releaseRetry?.(null);
  await runProvisioningPolls(page, () => Promise.resolve(), work.url, reads.length + 1);
  await waitForProvisioningFailure(page);
  // The busy flag cleared with the attempt: Retry returns enabled and can run the same job
  // again, and Create Agent is no longer held busy.
  assert.equal(await retryButton.isVisible(), true);
  assert.equal(await retryButton.isEnabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Create Agent", exact: true }).getAttribute("aria-busy"),
    "false",
  );
  const paints = await page.evaluate(() => globalThis.meterPaints);
  const layouts = paints.map((paint) => paint.states.join());
  // The record starts at the retry click: its first layout is the retry's own reset, then the
  // queued answer resumes at the Configuration phase the retry kept, before the refailure.
  assert.equal(layouts[0], "current,pending,pending,pending,pending");
  assert.ok(
    layouts.includes("done,done,current,pending,pending"),
    "the retry resumes at the Configuration phase it kept",
  );
  assert.equal(layouts.at(-1), "done,done,failed,pending,pending");
});

for (const failureAt of ["admission", "first poll", "after transport"] as const) {
  test(`a failed reply without a phase at ${failureAt} keeps only confirmed steps`, async (t) => {
    const fixture = await createConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });
    await fixture.bootstrap();
    const namespace = await readyNamespace(fixture, "Failure without a phase");
    const page = await openCreateForm(t, fixture, namespace);
    const work = provisioningJob(namespace.id, "work_unattributed");
    const failed = work.failed({ phase: undefined });
    const reads =
      failureAt === "after transport"
        ? [work.job("running", { phase: "transport" }), failed]
        : [failed];
    const served = await routeProvisioningJob(page, fixture, work, reads);
    const admissionPath = `/namespaces/${namespace.id}/agents/provision`;
    if (failureAt === "admission") {
      await page.route(`**${admissionPath}`, (route) => {
        const { requestId }: ProvisionAgentBody = route.request().postDataJSON();
        return route.fulfill({
          status: 202,
          json: { data: { provisioning: { ...failed, requestId } } },
        });
      });
    }
    const admission = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === admissionPath,
    );
    const firstRead = () =>
      page.waitForResponse(
        (r) => r.request().method() === "GET" && new URL(r.url()).pathname === work.url,
      );
    let terminal = failureAt === "admission" ? admission : firstRead();
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    const accepted = await admission;
    assert.equal(accepted.status(), 202);
    const { requestId }: ProvisionAgentBody = accepted.request().postDataJSON();
    assert.ok(requestId);
    if (failureAt === "after transport") {
      const previous = await terminal;
      terminal = firstRead();
      assert.equal(previous.status(), 200);
      const { data } = await previous.json();
      assert.equal(data.requestId, requestId);
      assert.equal(data.workId, work.workId);
      assert.equal(data.phase, "transport");
      assert.equal(data.status, "running");
    }
    const response = await terminal;
    assert.equal(response.status(), failureAt === "admission" ? 202 : 200);
    const { data } = await response.json();
    const job = failureAt === "admission" ? data.provisioning : data;
    assert.equal(job.status, "failed");
    assert.equal(job.requestId, requestId);
    assert.equal(job.workId, work.workId);
    assert.equal(job.url, work.url);
    assert.equal(Object.hasOwn(job, "phase"), false);
    assert.equal(Object.hasOwn(job, "revisionId"), false);
    await waitForProvisioningFailure(page);
    const state = await meterState(page);
    assert.equal(state.outcome, "failed");
    assert.equal(state.phase, "Agent provisioning failed.");
    assert.deepEqual(
      state.steps,
      stepStates(
        failureAt === "after transport"
          ? ["done", "done", "done", "pending", "pending"]
          : ["pending", "pending", "pending", "pending", "pending"],
      ),
    );
    assert.equal(state.reason, PROVISIONING_NOT_COMPLETED);
    assert.equal(state.reasonHidden, false);
    assert.equal(
      await page.getByRole("button", { name: "Retry provisioning request" }).isEnabled(),
      true,
    );
    assert.equal(served.reads, failureAt === "admission" ? 0 : reads.length);
  });
}

test("a superseded first deployment keeps its own meter outcome", async (t) => {
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, "Progress superseded");
  const page = await openCreateForm(t, fixture, namespace);
  const work = provisioningJob(namespace.id, "work_progress_superseded");
  const agentId = "agt_00000000-0000-4000-8000-00000000b637";
  const revisionId = "rev_00000000-0000-4000-8000-00000000b637";
  const handedOff = { agentId, configurationId: "cfg_superseded", revisionId };
  // A newer deployment took over before the first was ready: a neutral ending, not a stop.
  const reads = [
    work.job("running", { phase: "admitted" }),
    work.job("running", { phase: "handoff", ...handedOff }),
    work.job("failed", {
      phase: "handoff",
      ...handedOff,
      error: {
        code: "REVISION_SUPERSEDED",
        message: "Deployment was superseded by a newer revision.",
      },
    }),
  ];
  await routeProvisioningJob(page, fixture, work, reads);
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/deployments/${revisionId}`,
    (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "NOT_FOUND", message: "No such deployment." },
          meta: { requestId: "req_deployment_missing" },
        }),
      }),
  );
  await runProvisioningPolls(
    page,
    () => page.getByRole("button", { name: "Create Agent", exact: true }).click(),
    work.url,
    reads.length,
  );
  const state = await meterState(page);
  assert.equal(state.outcome, "superseded");
  assert.equal(state.phase, "Superseded while starting the first deployment.");
  assert.equal(state.reason, "");
  assert.equal(state.reasonHidden, true);
  assert.deepEqual(state.steps, stepStates(["done", "done", "done", "superseded", "pending"]));
});

test("an unreadable phase keeps the meter's confirmed steps", async (t) => {
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, "Progress unreadable phase");
  const page = await openCreateForm(t, fixture, namespace);
  const work = provisioningJob(namespace.id, "work_progress_unreadable");
  // The first poll confirms runtime credentials; the second reports the same running job with
  // no readable phase and no revision. The meter must keep the confirmed steps and switch to
  // the generic running heading instead of naming an earlier step again.
  const reads = [
    work.job("running", { phase: "transport" }),
    work.job("running", { phase: undefined }),
  ];
  await routeProvisioningJob(page, fixture, work, reads);
  await trackSettledFetches(page);
  await recordMeterPaints(page);
  await runProvisioningPolls(
    page,
    () => page.getByRole("button", { name: "Create Agent", exact: true }).click(),
    work.url,
    reads.length,
  );
  const state = await meterState(page);
  assert.equal(state.phase, "Provisioning Agent…");
  assert.deepEqual(state.steps, stepStates(["done", "done", "done", "current", "pending"]));
  const paints = await page.evaluate(() => globalThis.meterPaints);
  const layouts = paints.map((paint) => paint.states.join());
  assert.equal(layouts.at(-1), "done,done,done,current,pending");
});

test("a refused provisioning request shows no step meter", async (t) => {
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, "Progress refusal");
  const page = await openCreateForm(t, fixture, namespace);
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "INVALID_REQUEST",
          message: "The request does not match the operation contract.",
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000003" },
      }),
    }),
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.locator("#create-agent-form ~ p[role=alert]").filter({ hasText: /\S/ }).waitFor();
  assert.equal((await meterState(page)).hidden, true);
});

test("the meter's throbber is static under reduced motion", async (t) => {
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });
  await fixture.bootstrap();
  const namespace = await readyNamespace(fixture, "Progress reduced motion");
  const page = await openCreateForm(t, fixture, namespace);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const work = provisioningJob(namespace.id, "work_progress_reduced_motion");
  // The last read repeats, so the job stays running while the page is inspected.
  await routeProvisioningJob(page, fixture, work, [work.job("running", { phase: "admitted" })]);
  // The taller sticky bar must raise the page's focus-scroll clearance while the meter is in
  // it: the meter-specific rule wins the cascade over the base html:has(#create-agent-form).
  const clearanceBefore = await page.evaluate(() =>
    parseFloat(
      globalThis.getComputedStyle(globalThis.document.documentElement).scrollPaddingBottom,
    ),
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector(".provisioning-phase")?.textContent ===
      "Creating the Configuration and Agent…",
  );
  const state = await meterState(page);
  assert.equal(state.phaseRole, "status");
  assert.equal(state.elapsedRole, null);
  const clearanceAfter = await page.evaluate(() =>
    parseFloat(
      globalThis.getComputedStyle(globalThis.document.documentElement).scrollPaddingBottom,
    ),
  );
  assert.ok(
    clearanceAfter - clearanceBefore >= 200,
    `scroll clearance grew only ${clearanceAfter - clearanceBefore}px with the meter visible`,
  );
  // The meter pins in the sticky action bar (the bar the reader selected Create Agent from),
  // and Retry stays hidden while the request is still in flight.
  assert.equal(state.inActionBar, true);
  const bar = await page.evaluate(() => {
    const meter = globalThis.document.querySelector(".provisioning-progress");
    const bar = meter?.closest(".form-actions");
    return bar instanceof HTMLElement ? globalThis.getComputedStyle(bar).position : null;
  });
  assert.equal(bar, "sticky");
  assert.equal(
    await page.getByRole("button", { name: "Retry provisioning request" }).isVisible(),
    false,
  );
  assert.deepEqual(state.steps, stepStates(["done", "current", "pending", "pending", "pending"]));
  // prefers-reduced-motion keeps the current step's marker a static ring, not a spin.
  const animation = await page.evaluate(() => {
    const marker = globalThis.document.querySelector(
      ".provisioning-step[data-state='current'] .provisioning-step-marker",
    );
    return marker instanceof Element ? globalThis.getComputedStyle(marker).animationName : null;
  });
  assert.equal(animation, "none");
});
