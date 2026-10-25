/// <reference lib="es2024.promise" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";
import type { Locator, Page, Response, Route } from "playwright";

import type {
  CreateAgentBody,
  CreateSecretBody,
  ProvisionAgentBody,
} from "../../packages/contracts/src/api/common.ts";
import type {
  AgentProvisioningStatusWire as ProvisioningStatus,
  AgentWire,
  IAMAccessBindingWire,
  NamespaceWire,
  PresetSummaryWire,
} from "../../packages/contracts/src/api/resources.ts";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { WORKSPACE_DEFAULTS_ID } from "../../packages/contracts/src/workspace-defaults.mjs";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture as createBaseConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  apiRequests,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  pathRequests,
  persistedDeploymentError,
  recordLayoutShifts,
  secretOptionLabel,
  secretPostRequests,
  selectSecret,
  settledFetches,
  takeLayoutShifts,
  trackSettledFetches,
  waitForCondition,
  waitForEnabled,
  waitForIdleFetches,
  waitForSettledFetches,
} from "./console-agents-browser-helpers.mjs";
import {
  openCreateSecretDialog,
  createModelCredentialSecret,
  enterManualModel,
  openAdvancedSettings,
  configurationPostRequests,
  routeInstallationProvisioning,
  routeInstallationWithoutProvisioning,
  agentPostRequests,
  assertAgentNameTaken,
  optionValues,
  raceAgentName,
  waitForProvisioningFailure,
} from "./console-agents-test-support.mjs";
import {
  GENERIC_DENIAL,
  NAMESPACE_NOT_READY,
  RESOURCE_CONFLICT,
} from "../helpers/refusal-text.mjs";

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);
const createConsoleAppFixture = (t: TestContext, options = {}) =>
  createBaseConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset], ...options });

type ProvisioningMessage = NonNullable<ProvisioningStatus["error"]>;

declare global {
  var provisioningWrites: string[];
}

// Runs in the page. Keep repeated writes: the status is live and each update can be announced.
function recordProvisioningWrites(prefixes: string[]) {
  const writes: string[] = [];
  globalThis.provisioningWrites = writes;
  new MutationObserver((records) => {
    for (const { target, addedNodes } of records) {
      if (target instanceof Element && target.getAttribute("role") === "status") {
        const text = Array.from(addedNodes, (node) => node.textContent).join("");
        if (prefixes.some((prefix) => text.startsWith(prefix))) {
          writes.push(text);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

function admission(requests: readonly ProvisionAgentBody[], attempt: number): ProvisionAgentBody {
  const request = requests[attempt - 1];
  assert.ok(request, `expected provisioning request ${attempt}`);
  return request;
}

// Cases moved unchanged from the first console-agents test file: provisioning retries, model
// selection, creation conflicts and duplicate-write guards. The file was split so the two parts run
// side by side in the Console Browser 2 lane. Name sibling test files only by suffix: CI Impact
// runs full CI for a test file that another file names.

// The Installation provisions dedicated Agents and the Namespace offers no repository choices.
async function routeDedicatedProvisioning(
  page: Page,
  fixture: Awaited<ReturnType<typeof createConsoleAppFixture>>,
  namespace: NamespaceWire,
) {
  await routeInstallationProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], meta: { requestId: "req_repository_choices" } }),
    }),
  );
}

test("Create keeps provisioning reads and retries on the admitted job", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision response identity", { ready: true });
  const { page } = await newPage(t, fixture);
  await routeDedicatedProvisioning(page, fixture, namespace);
  const root = `/namespaces/${namespace.id}/agents/provision`;
  const url = `${root}/work_create`;
  const other = `${root}/work_other`;
  const job = { workId: "work_create", status: "queued", url };
  const requests = apiRequests(page, fixture.origin);
  const admissions: ProvisionAgentBody[] = [];
  const failure = { code: "PROVISIONING_FAILED", message: "Another job failed." };
  const otherJob = { workId: "work_other", url: other, status: "failed", error: failure };
  await page.route(`**${root}`, (route) => {
    const body: ProvisionAgentBody = route.request().postDataJSON();
    admissions.push(body);
    const { requestId } = body;
    const responses = [
      // An internally consistent admission for another request by the same caller.
      { ...otherJob, status: "queued", requestId: `req_${randomUUID()}` },
      // An older controller that did not identify the request.
      job,
      // The expected request and work ID with another job's URL.
      { ...job, requestId, url: other },
      { ...job, requestId },
    ];
    const provisioning = responses[admissions.length - 1];
    assert.ok(provisioning);
    return route.fulfill({ status: 202, json: { data: { provisioning } } });
  });
  await page.route(`**${other}*`, (route) => route.fulfill({ json: { data: otherJob } }));
  // The honest admission's first poll then returns a complete response for that other job.
  await page.route(`**${url}`, (route) =>
    route.fulfill({
      json: { data: { ...otherJob, requestId: admission(admissions, 1).requestId } },
    }),
  );
  await page.route(`**${url}/retry`, (route) =>
    route.fulfill({
      status: 202,
      json: {
        data: {
          ...job,
          requestId: admission(admissions, 1).requestId,
          status: "failed",
          error: {
            code: "PROVISIONING_REJECTED",
            message: "This job ended.",
          },
        },
      },
    }),
  );

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Provision response identity");
  await enterManualModel(page, "test-model-key");
  await page.getByRole("button", { name: "Create Agent" }).click();
  const alert = page.getByRole("alert");
  const retry = page.getByRole("button", { name: "Retry provisioning request" });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await alert
      .filter({
        hasText: "Retry resubmits the same request ID",
      })
      .waitFor();
    assert.equal(pathRequests(requests, "GET", other).length, 0);
    assert.equal(pathRequests(requests, "GET", url).length, 0);
    assert.equal(admissions.length, attempt);
    await retry.click();
  }
  await alert.filter({ hasText: "Outcome unknown after provisioning admission" }).waitFor();
  assert.equal(admissions.length, 4);
  for (const body of admissions) {
    assert.deepEqual(body, admissions[0]);
  }
  await retry.click();
  await alert.filter({ hasText: /This job ended/ }).waitFor();
  assert.equal(pathRequests(requests, "POST", `${url}/retry`).length, 1);
  assert.equal(pathRequests(requests, "POST", `${other}/retry`).length, 0);
});

test("Dedicated Agent creation offers Retry only for a transient provisioning failure", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision outcomes", { ready: true });
  const { page } = await newPage(t, fixture);
  await routeDedicatedProvisioning(page, fixture, namespace);
  const updatedAt = new Date().toISOString();
  const json = (data: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify({
      data,
      meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
    }),
  });
  // Each accepted request fails in the worker: first a taken name (permanent), then an
  // unavailable dependency (transient). Its retry is then rejected after the job created
  // the Agent, which only the job's retry can finish, and the next retry is refused
  // because the Agent's lifecycle changed. The third job is cancelled by deleting the Agent
  // it created (permanent; the Agent is gone, so the name is free again). The fourth job's
  // status is first unreadable, then it has succeeded.
  // Each job that gets far enough creates its own Agent.
  const agentIds = [2, 3, 4].map((job) => `agt_00000000-0000-4000-8000-00000000c0d${job}`);
  const failures = [
    {
      code: "PROVISIONING_REJECTED",
      message: "An Agent with this name already exists in this Namespace. Choose a different name.",
    },
    {
      code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
      message: "Agent provisioning could not complete.",
    },
    {
      code: "PROVISIONING_CANCELLED",
      message: "Provisioning was cancelled because the Agent was deleted.",
      agentId: agentIds[1],
    },
  ];
  const bodies: ProvisionAgentBody[] = [];
  let provisionPosts = 0;
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, async (route, request) => {
    provisionPosts += 1;
    // The first request is lost in transit and its resend is rejected at admission, so
    // the API never admitted that request ID.
    if (provisionPosts === 1) {
      await route.abort("failed");
      return;
    }
    if (provisionPosts === 2) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "INVALID_REQUEST",
            message: "The request does not match the operation contract.",
          },
          meta: { requestId: "req_00000000-0000-4000-8000-000000000400" },
        }),
      });
      return;
    }
    const body: ProvisionAgentBody = request.postDataJSON();
    // Like the API, a known request ID returns its existing job.
    const work =
      bodies.findIndex((earlier) => earlier.requestId === body.requestId) + 1 || bodies.length + 1;
    bodies.push(body);
    const url = `/namespaces/${namespace.id}/agents/provision/work_${work}`;
    await route.fulfill(
      json(
        {
          provisioning: {
            requestId: body.requestId,
            workId: `work_${work}`,
            status: "queued",
            phase: "accepted",
            attemptCount: 0,
            updatedAt,
            url,
          },
        },
        202,
      ),
    );
  });
  let retries = 0;
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_2/retry`, async (route) => {
    retries += 1;
    if (retries > 1) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "RESOURCE_CONFLICT",
            message: RESOURCE_CONFLICT,
          },
          meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
        }),
      });
      return;
    }
    await route.fulfill(
      json(
        {
          provisioning: {
            requestId: admission(bodies, 2).requestId,
            workId: "work_2",
            status: "failed",
            phase: "transport",
            attemptCount: 2,
            updatedAt,
            agentId: agentIds[0],
            url: `/namespaces/${namespace.id}/agents/provision/work_2`,
            error: {
              code: "PROVISIONING_REJECTED",
              message: "Agent provisioning could not complete.",
            },
          },
        },
        202,
      ),
    );
  });
  // The job succeeded while its status was unreadable, so the API refuses its retry.
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_4/retry`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "RESOURCE_CONFLICT",
          message: "Provisioning cannot retry after cancellation or deployment handoff.",
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
      }),
    }),
  );
  let work4Reads = 0;
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_*`, async (route) => {
    const index = Number(new URL(route.request().url()).pathname.split("_").at(-1));
    const url = `/namespaces/${namespace.id}/agents/provision/work_${index}`;
    if (index === 4) {
      work4Reads += 1;
      await route.fulfill(
        work4Reads === 1
          ? {
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({
                error: { code: "DEPENDENCY_UNAVAILABLE", message: "Unavailable." },
                meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
              }),
            }
          : json({
              requestId: admission(bodies, 4).requestId,
              workId: "work_4",
              status: "succeeded",
              phase: "handoff",
              attemptCount: 1,
              updatedAt,
              agentId: agentIds[2],
              revisionId: "rev_00000000-0000-4000-8000-00000000c0de",
              url,
            }),
      );
      return;
    }
    const failure = failures[index - 1];
    assert.ok(failure, `unexpected request for provisioning job ${index}`);
    const { agentId: createdAgentId, ...error } = failure;
    await route.fulfill(
      json({
        requestId: admission(bodies, index).requestId,
        workId: `work_${index}`,
        status: "failed",
        phase: "accepted",
        attemptCount: 1,
        updatedAt,
        ...(createdAgentId === undefined ? {} : { agentId: createdAgentId }),
        url,
        error,
      }),
    );
  });

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Taken name");
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, "model-secret-value");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  const retry = page.getByRole("button", { name: "Retry provisioning request" });
  // The stub refuses the resend at admission.
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByText(/^Outcome unknown\. Retry resubmits the same request ID and saved references\./)
    .waitFor();
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);
  // A 400 to the resend shows the request was never admitted, so the form unlocks.
  await retry.click();
  await page.getByText(/^The request does not match the operation contract\./).waitFor();
  assert.equal(await retry.isVisible(), false);
  await waitForEnabled(page.getByLabel("Agent name"));
  await page.getByLabel("Agent name").fill("Taken name");
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByText(
      "An Agent with this name already exists in this Namespace. Choose a different name. Select Create Agent to submit a new request.",
    )
    .waitFor();
  assert.equal(await retry.isVisible(), false);
  await waitForEnabled(page.getByLabel("Agent name"));
  // A job that lost the name to another request marks the field, as admission's 409 does.
  await assertAgentNameTaken(page);

  await page.getByLabel("Agent name").fill("Free name");
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByText("Agent provisioning could not complete. Retry uses the accepted provisioning job.")
    .waitFor();
  assert.equal(await retry.isVisible(), true);
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);
  assert.equal(bodies.length, 2);
  const taken = admission(bodies, 1);
  const available = admission(bodies, 2);
  assert.equal(available.name, "Free name");
  // The failed job keeps its request ID, so the edited form submits a new one with the
  // same saved credential.
  assert.notEqual(available.requestId, taken.requestId);
  assert.deepEqual(available.harnessAuth, taken.harnessAuth);

  const retried = page.waitForResponse((response) => response.url().endsWith("/work_2/retry"));
  await retry.click();
  await retried;
  await page.getByRole("button", { name: "Retry provisioning request", disabled: false }).waitFor();
  assert.equal(retries, 1);
  assert.equal(await retry.isVisible(), true);
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);

  // A refused retry ends that job: Create Agent submits a new request ID instead of
  // replaying the failed job.
  await retry.click();
  await page
    .getByText(
      "The provisioning job can no longer be retried. Select Create Agent to submit a new request.",
    )
    .waitFor();
  assert.equal(retries, 2);
  assert.equal(await retry.isVisible(), false);
  await waitForEnabled(page.getByLabel("Agent name"));
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByText(
      "Provisioning was cancelled because the Agent was deleted. Select Create Agent to submit a new request.",
    )
    .waitFor();
  assert.equal(bodies.length, 3);
  const cancelled = admission(bodies, 3);
  assert.notEqual(cancelled.requestId, available.requestId);
  // A cancelled job cannot be retried either; the next submit uses a new request ID.
  assert.equal(await retry.isVisible(), false);
  await waitForEnabled(page.getByLabel("Agent name"));
  await page.getByRole("button", { name: "Create Agent" }).click();
  // Retry calls the job's retry endpoint, which cannot recover a finished job; the text
  // must point at Create Agent for that case.
  await page
    .getByText(
      /^Outcome unknown after provisioning admission\. Retry resumes the accepted provisioning job, or retries it if it failed\. If the API refuses because the job finished, select Create Agent to resend the same request ID\./,
    )
    .waitFor();
  assert.equal(bodies.length, 4);
  const finished = admission(bodies, 4);
  assert.notEqual(finished.requestId, cancelled.requestId);
  // After an unknown outcome a refused retry may mean the job succeeded, so the request
  // ID is kept and Create Agent recovers the job instead of starting a new one.
  await retry.click();
  await page
    .getByText(
      /^The provisioning job can no longer be retried; it may have finished\. Select Create Agent to resend the same request ID and open its result\./,
    )
    .waitFor();
  // The kept request ID names the admitted job, so the plan stays locked: an edited
  // form would get 409 "different plan" from the API on every Create Agent.
  assert.equal(await retry.isVisible(), false);
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);
  assert.equal(await page.getByLabel("Service account token Secret").isDisabled(), true);
  await waitForEnabled(page.getByRole("button", { name: "Create Agent" }));
  await waitForEnabled(page.getByRole("button", { name: "Start over" }));
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page.waitForURL(new RegExp(`/agents/${agentIds[2]}\\?`));
  assert.equal(bodies.length, 5);
  assert.equal(admission(bodies, 5).requestId, finished.requestId);
});

test("Dedicated Agent creation shows the API's named reason when a provisioning retry is refused", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision retry refusals", { ready: true });
  const { page } = await newPage(t, fixture);
  await routeDedicatedProvisioning(page, fixture, namespace);
  const updatedAt = new Date().toISOString();
  const meta = { requestId: "req_00000000-0000-4000-8000-000000000001" };
  const jobUrl = (work: number) => `/namespaces/${namespace.id}/agents/provision/work_${work}`;
  // Each job fails transiently, then the API refuses its retry: first with the generic
  // conflict text (a store race; controller refusals name a reason), then naming the
  // Secret that was deleted.
  const refusals = [
    RESOURCE_CONFLICT,
    "Secret sec_00000000-0000-4000-8000-00000000dead, which this provisioning request uses, was deleted. Submit a new Agent provisioning request.",
  ];
  const requestIds: string[] = [];
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, async (route) => {
    const { requestId }: ProvisionAgentBody = route.request().postDataJSON();
    const jobs = requestIds.push(requestId);
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          provisioning: {
            requestId,
            workId: `work_${jobs}`,
            status: "queued",
            phase: "accepted",
            attemptCount: 0,
            updatedAt,
            url: jobUrl(jobs),
          },
        },
        meta,
      }),
    });
  });
  const routeJob = async (route: Route) => {
    const work = Number(new URL(route.request().url()).pathname.split("/")[5]?.split("_")[1]);
    await route.fulfill(
      route.request().method() === "POST"
        ? {
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "RESOURCE_CONFLICT", message: refusals[work - 1] },
              meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
            }),
          }
        : {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              data: {
                requestId: requestIds[work - 1],
                workId: `work_${work}`,
                status: "failed",
                phase: "accepted",
                attemptCount: 1,
                updatedAt,
                url: jobUrl(work),
                error: {
                  code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
                  message: "Agent provisioning could not complete.",
                },
              },
              meta,
            }),
          },
    );
  };
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_*`, routeJob);
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_*/retry`, routeJob);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Refused retry");
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, "model-secret-value");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  const retry = page.getByRole("button", { name: "Retry provisioning request" });
  for (const expected of ["The provisioning job can no longer be retried.", refusals[1]]) {
    await page.getByRole("button", { name: "Create Agent" }).click();
    await page
      .getByText("Agent provisioning could not complete. Retry uses the accepted provisioning job.")
      .waitFor();
    await retry.click();
    await page
      .getByText(
        `${expected} Select Create Agent to submit a new request. Request ID: req_00000000-0000-4000-8000-000000000409`,
        { exact: true },
      )
      .waitFor();
    assert.equal(await retry.isVisible(), false);
    await waitForEnabled(page.getByLabel("Agent name"));
  }
  assert.equal(requestIds.length, 2);
});

// The stopped guidance is not an error, so neither its text nor its block's stripe takes the
// error colour.
async function assertNotErrorColour(locator: Locator) {
  const [colour, stripe, errorColour] = await locator.evaluate((node) => {
    const status = node.closest(".status");
    const view = node.ownerDocument.defaultView;
    if (!status || !view) {
      throw new Error("Expected the status inside the document");
    }
    const probe = node.ownerDocument.createElement("span");
    probe.style.color = "var(--color-danger)";
    node.ownerDocument.body.append(probe);
    const danger = view.getComputedStyle(probe).color;
    probe.remove();
    return [
      view.getComputedStyle(node).color,
      view.getComputedStyle(status).borderLeftColor,
      danger,
    ];
  });
  assert.notEqual(colour, errorColour);
  assert.notEqual(stripe, errorColour);
}

// An owner's Stop during the first deployment fails provisioning with REVISION_STOPPED. A Stop
// before the first revision is admitted cancels it (PROVISIONING_CANCELLED) but keeps the stopped
// Agent and its name, so "create a new Agent" would be refused as a duplicate. The create page
// names the stop without a cause to correct and links the kept Agent (finding 1376); it reads the
// Agent a cancelled job names to tell a Stop from a deletion.
test("Dedicated Agent creation reports a stop during or before the first deployment and links the kept Agent", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision stopped", { ready: true });
  // The Agent a cancelled job created and kept: stopped, with no versions.
  const kept = await fixture.createAgent(namespace.id, "Kept Agent", nativeValues("v1"));
  const stop = await fixture.request("POST", `/namespaces/${namespace.id}/agents/${kept.id}/stop`);
  assert.equal(stop.status, 202, JSON.stringify(stop.body));
  // An Agent whose job was cancelled by deleting it: still deleting, its name not yet free.
  const removed = await fixture.createAgent(namespace.id, "Removed Agent", nativeValues("v1"));
  const deletion = await fixture.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${removed.id}`,
  );
  assert.equal(deletion.status, 202, JSON.stringify(deletion.body));
  const { page } = await newPage(t, fixture);
  await routeDedicatedProvisioning(page, fixture, namespace);
  const updatedAt = new Date().toISOString();
  const meta = { requestId: "req_00000000-0000-4000-8000-000000000001" };
  const url = `/namespaces/${namespace.id}/agents/provision/work_stopped`;
  let clientRequestId: ProvisionAgentBody["requestId"];
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, (route) => {
    clientRequestId = route.request().postDataJSON().requestId;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          provisioning: {
            requestId: clientRequestId,
            workId: "work_stopped",
            status: "queued",
            phase: "admitted",
            attemptCount: 0,
            updatedAt,
            url,
          },
        },
        meta,
      }),
    });
  });
  const cancelled = (agentId: string, by: "stopped" | "deleted") => ({
    agentId,
    error: {
      code: "PROVISIONING_CANCELLED",
      message: `Provisioning was cancelled because the Agent was ${by}.`,
    },
  });
  const unreadable = (status: number, code: string, message: string) => ({
    status,
    error: { code, message },
  });
  const keptHref = `/console/agents/${kept.id}?namespace=${namespace.id}`;
  const unknown =
    "Provisioning was cancelled because the Agent was stopped. If the Agent still exists, open it and deploy a version; otherwise select Create Agent to submit a new request.";
  // Each submit returns the same job; each case changes which Agent it names, how it ended and
  // how that Agent reads. `href` is the Open Agent link, null when there is none. The retryable
  // failure stays last: the page keeps its accepted job, so the next Create Agent would retry it.
  const cases = [
    {
      // Someone stopped the Agent while its first deployment was rolling out.
      job: {
        agentId: "agt_00000000-0000-4000-8000-00000000c0de",
        revisionId: "rev_00000000-0000-4000-8000-00000000c0de",
        error: {
          code: "REVISION_STOPPED",
          message: "The Agent was stopped before its first deployment finished.",
        },
      },
      text: "The Agent was stopped before its first deployment finished. Open this Agent and deploy a new version when you want it running.",
      stopped: true,
      link: "Open Agent and deployment details",
      href: `/console/agents/agt_00000000-0000-4000-8000-00000000c0de?revision=rev_00000000-0000-4000-8000-00000000c0de&namespace=${namespace.id}`,
    },
    {
      job: cancelled(kept.id, "stopped"),
      text: "Provisioning was cancelled because the Agent was stopped. Open this Agent and deploy a version when you want it running.",
      stopped: true,
      href: keptHref,
    },
    {
      // When the Agent cannot be read, the page cannot tell a Stop from a deletion: it offers both.
      job: cancelled(kept.id, "stopped"),
      read: unreadable(503, "DEPENDENCY_UNAVAILABLE", "A dependency is unavailable."),
      text: unknown,
      href: keptHref,
    },
    {
      // A deleted Agent is not kept: the page says so and offers a new request, with no link.
      job: cancelled(removed.id, "deleted"),
      text: "Provisioning was cancelled because the Agent was deleted. Select Create Agent to submit a new request.",
      href: null,
    },
    {
      // Only a 404 means the Agent is gone. A caller who may not read it (403) cannot tell a
      // Stop from a deletion either.
      job: cancelled(kept.id, "stopped"),
      read: unreadable(403, "FORBIDDEN", GENERIC_DENIAL),
      text: unknown,
      href: keptHref,
    },
    {
      // A job that created its Agent and then failed after its retries did not stop, even
      // though that Agent is kept.
      job: {
        agentId: kept.id,
        error: {
          code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
          message: "Agent provisioning could not complete.",
        },
      },
      text: "Agent provisioning could not complete. Retry uses the accepted provisioning job.",
      href: null,
    },
  ];
  let current = cases[0]!;
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_stopped`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          requestId: clientRequestId,
          workId: "work_stopped",
          status: "failed",
          phase: "configuration",
          attemptCount: 1,
          updatedAt,
          url,
          ...current.job,
        },
        meta,
      }),
    }),
  );
  await page.route(`**/namespaces/${namespace.id}/agents/${kept.id}`, (route) =>
    current.read
      ? route.fulfill({
          status: current.read.status,
          contentType: "application/json",
          body: JSON.stringify({ error: current.read.error, meta }),
        })
      : route.fallback(),
  );

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Stopped first deployment");
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, "model-secret-value");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  for (const c of cases) {
    current = c;
    await page.getByRole("button", { name: "Create Agent" }).click();
    await page.getByText(c.text).waitFor();
    if (c.stopped) {
      await page.getByText("Provisioning stopped.", { exact: true }).waitFor();
      assert.equal(
        await page.getByText(/Provisioning failed|Create a new Agent|correct the cause/i).count(),
        0,
      );
      await assertNotErrorColour(page.locator(".provisioning-stopped"));
      assert.equal(
        await page.getByRole("button", { name: "Retry provisioning request" }).isVisible(),
        false,
      );
    } else {
      await waitForProvisioningFailure(page);
      assert.equal(await page.locator(".provisioning-stopped").count(), 0);
    }
    const open = page.getByRole("link", { name: c.link ?? "Open Agent", exact: true });
    if (c.href) {
      assert.equal(await open.getAttribute("href"), c.href);
    } else {
      assert.equal(await open.count(), 0);
    }
  }

  // The kept Agent's page has nothing failed to show: it simply has no deployment yet.
  await page.goto(new URL(keptHref, fixture.origin).href);
  await page.getByRole("heading", { name: "Kept Agent" }).waitFor();
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("No readable deployments.", { exact: true }).waitFor();
  assert.equal(await summary.getByText(/failed/i).count(), 0);
});

// Create rereads the provisioning job every second, and a started job goes back to queued
// between worker retries. The status line keeps one label once the job has started and is
// written only when that label changes (finding 1424: it flipped between "Provisioning
// Agent…" and "Provisioning queued…" and was rewritten on every read).
test("Dedicated Agent creation keeps one provisioning label while the job retries", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision label", { ready: true });
  const { page } = await newPage(t, fixture);
  await routeDedicatedProvisioning(page, fixture, namespace);
  const updatedAt = new Date().toISOString();
  const meta = { requestId: "req_00000000-0000-4000-8000-000000000001" };
  const url = `/namespaces/${namespace.id}/agents/provision/work_label`;
  let clientRequestId: ProvisionAgentBody["requestId"];
  const job = (
    status: ProvisioningStatus["status"],
    extra: Partial<ProvisioningStatus> = {},
  ): ProvisioningStatus => ({
    workId: "work_label",
    status,
    phase: "configuration",
    attemptCount: 1,
    updatedAt,
    url,
    ...extra,
  });
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, (route) => {
    clientRequestId = route.request().postDataJSON().requestId;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: { provisioning: { ...job("queued"), requestId: clientRequestId } },
        meta,
      }),
    });
  });
  // The worker starts the job, waits to retry it, then retries it twice before it fails.
  const reads = [
    job("running"),
    job("queued"),
    job("running"),
    job("running"),
    job("failed", {
      error: {
        code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
        message: "Agent provisioning could not complete.",
      },
    }),
  ];
  let read = 0;
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_label`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { ...reads[Math.min(read++, reads.length - 1)], requestId: clientRequestId },
        meta,
      }),
    }),
  );

  await trackSettledFetches(page);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Provision label");
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, "model-secret-value");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  await page.evaluate(recordProvisioningWrites, ["Provisioning"]);
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 1_000);
  await page.getByRole("button", { name: "Create Agent" }).click();
  // Advance each poll only after the page has consumed the preceding response.
  for (let poll = 0; poll < reads.length; poll += 1) {
    await waitForCondition(() => clientRequestId && read === poll, `job read ${poll}`);
    await waitForIdleFetches(page);
    await page.clock.runFor(1_000);
  }
  await waitForProvisioningFailure(page);
  assert.equal(read, reads.length);
  assert.deepEqual(await page.evaluate(() => globalThis.provisioningWrites), [
    "Provisioning request accepted.",
    "Provisioning queued…",
    "Provisioning Agent…",
  ]);
});

// Show the Pod quota reason while the deployment reports it. If the reason changes or the
// reader loses access, show generic progress again. A cancelled poll or a temporary outage
// does not establish either change (findings 1617, 1637). The page clock drives the one-second
// polls, so the four modes don't wait for them in real time.
test("Dedicated Agent creation names a full Namespace Pod quota while it waits", async (t) => {
  const quotaFull =
    "The Namespace's Pod quota is full. Stop or delete an Agent, or ask an administrator to raise the quota.";
  for (const mode of ["readable", "refused", "interrupted", "access lost"] as const) {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace(`Pod quota ${mode}`, {
      ready: true,
    });
    const { page } = await newPage(t, fixture);
    await routeDedicatedProvisioning(page, fixture, namespace);
    const updatedAt = new Date().toISOString();
    const meta = { requestId: "req_00000000-0000-4000-8000-000000000001" };
    const url = `/namespaces/${namespace.id}/agents/provision/work_quota`;
    let clientRequestId: ProvisionAgentBody["requestId"];
    const agentId = "agt_00000000-0000-4000-8000-00000000a617";
    const revisionId = "rev_00000000-0000-4000-8000-00000000a617";
    const job = (
      status: ProvisioningStatus["status"],
      extra: Partial<ProvisioningStatus> = {},
    ): ProvisioningStatus => ({
      workId: "work_quota",
      status,
      phase: "configuration",
      attemptCount: 1,
      updatedAt,
      url,
      ...extra,
    });
    const handedOff = {
      phase: "handoff",
      agentId,
      configurationId: "cfg_quota",
      revisionId,
    } as const;
    let submitted = false;
    await page.route(`**/namespaces/${namespace.id}/agents/provision`, (route) => {
      submitted = true;
      clientRequestId = route.request().postDataJSON().requestId;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: { provisioning: { ...job("queued"), requestId: clientRequestId } },
          meta,
        }),
      });
    });
    // The job starts, creates its Agent, hands off its first deployment, which waits on the
    // quota for two reads and then on the runtime, and the job then fails.
    const reads = [
      job("running"),
      job("running", { phase: "transport", agentId }),
      job("running", handedOff),
      job("running", handedOff),
      job("running", handedOff),
      job("failed", {
        ...handedOff,
        error: {
          code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
          message: "Agent provisioning could not complete.",
        },
      }),
    ];
    let read = 0;
    await page.route(`**/namespaces/${namespace.id}/agents/provision/work_quota`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { ...reads[Math.min(read++, reads.length - 1)], requestId: clientRequestId },
          meta,
        }),
      }),
    );
    const attempts: (ProvisioningMessage | "stalled" | "unavailable")[] =
      mode === "interrupted"
        ? [{ code: "NAMESPACE_POD_QUOTA_EXCEEDED", message: quotaFull }, "stalled", "unavailable"]
        : [
            { code: "NAMESPACE_POD_QUOTA_EXCEEDED", message: quotaFull },
            { code: "NAMESPACE_POD_QUOTA_EXCEEDED", message: quotaFull },
            { code: "REVISION_INCOMPLETE", message: "Waiting for the runtime to become ready." },
          ];
    const deploymentReads: number[] = [];
    const deploymentRequests = [];
    const stalledRead = Promise.withResolvers<void>();
    let stalledCancelled = Promise.resolve(false);
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.includes("/deployments/")) {
        deploymentRequests.push(new URL(request.url()).pathname);
      }
    });
    await page.route(
      `**/namespaces/${namespace.id}/agents/${agentId}/deployments/${revisionId}`,
      async (route) => {
        // The job read that handed this deployment off is the one this read follows.
        deploymentReads.push(read);
        const lastAttempt = attempts[Math.min(deploymentReads.length - 1, attempts.length - 1)];
        if (lastAttempt === "stalled") {
          // Hold this read until the next poll cancels it.
          stalledCancelled = page
            .waitForEvent("requestfailed", {
              predicate: (failed) => failed === route.request(),
              timeout: 10_000,
            })
            .then(
              () => true,
              () => false,
            );
          stalledRead.resolve();
          await stalledCancelled;
          await route.abort().catch(() => {});
          return;
        }
        if (lastAttempt === "unavailable") {
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable." },
              meta,
            }),
          });
        }
        const deploymentReadable =
          mode !== "refused" && (mode !== "access lost" || deploymentReads.length === 1);
        return route.fulfill(
          deploymentReadable
            ? {
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                  data: {
                    deploymentId: revisionId,
                    namespaceId: namespace.id,
                    agentId,
                    status: "queued",
                    error: null,
                    warnings: [],
                    progress: {
                      lastAttempt: { at: updatedAt, ...lastAttempt },
                      nextAttemptAt: updatedAt,
                    },
                  },
                  meta,
                }),
              }
            : {
                status: 404,
                contentType: "application/json",
                body: JSON.stringify({
                  error: { code: "NOT_FOUND", message: "Resource not found." },
                  meta,
                }),
              },
        );
      },
    );

    await trackSettledFetches(page);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("heading", { name: "Create Agent" }).waitFor();
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await page.getByLabel("Agent name").fill("Pod quota");
    await page.getByLabel("Authentication method").selectOption("codex_pat");
    await createModelCredentialSecret(page, "model-secret-value");
    await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
    await page.evaluate(recordProvisioningWrites, ["Provisioning", "The Namespace"]);
    const start = Date.now();
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start + 1_000);
    await page.getByRole("button", { name: "Create Agent" }).click();
    // Each poll waits one second, spent on an optional deployment read. Advance the clock only
    // once the page has handled this poll's job read and its deployment read, so it waits on the
    // poll timer alone. The stalled read is still pending when the clock moves, so the next poll
    // cancels it. Job reads 3 to 5 hand off the deployment.
    for (let poll = 0; poll < reads.length; poll += 1) {
      await waitForCondition(() => submitted && read === poll, `job read ${poll} in ${mode}`);
      const deploymentRead = poll - 2;
      if (deploymentRead > 0) {
        await waitForCondition(
          () => deploymentReads.length === deploymentRead,
          `deployment read ${deploymentRead} in ${mode}`,
        );
      }
      if (deploymentRead > 0 && attempts[deploymentRead - 1] === "stalled") {
        await stalledRead.promise;
      } else {
        await waitForIdleFetches(page);
      }
      await page.clock.runFor(1_000);
    }
    await waitForProvisioningFailure(page);
    assert.equal(read, reads.length);
    // Only a running job that handed off its deployment reads it, once per job read.
    assert.deepEqual(deploymentReads, [3, 4, 5]);
    assert.equal(deploymentRequests.length, 3);
    assert.equal(
      await stalledCancelled,
      mode === "interrupted",
      "the next poll must cancel the stalled deployment read",
    );
    assert.deepEqual(
      await page.evaluate(() => globalThis.provisioningWrites),
      {
        readable: [
          "Provisioning request accepted.",
          "Provisioning queued…",
          "Provisioning Agent…",
          quotaFull,
          "Provisioning Agent…",
        ],
        refused: ["Provisioning request accepted.", "Provisioning queued…", "Provisioning Agent…"],
        interrupted: [
          "Provisioning request accepted.",
          "Provisioning queued…",
          "Provisioning Agent…",
          quotaFull,
        ],
      }[mode === "access lost" ? "readable" : mode],
      `deployment reads: ${mode}`,
    );
  }
});

// Since #2744 a job past handoff names its first deployment's wait, but Create Agent showed one
// "Provisioning Agent…" line until the job ended, about 48 s on oce-dogfood-b (finding 1690). It
// now adds the wait's sentence, the one the deployment status shows. A fresh deployment read's
// quota or image pull wait (finding 1881) comes first and stands alone, a refused read clears
// the detail, and an unavailable one keeps the job's newer wait. A member who can't read the
// deployment gets only the job's own pending code, which adds nothing, so the line stays as is.
test("Dedicated Agent creation names the first deployment's wait while it provisions", async (t) => {
  const runtime = "Waiting for the runtime to become ready.";
  const node = "Workloads are ready; waiting for the workspace node to connect to the Gateway.";
  const quotaFull =
    "The Namespace's Pod quota is full. Stop or delete an Agent, or ask an administrator to raise the quota.";
  const pullFailed =
    "Kubernetes cannot pull a container image for this Agent and keeps retrying. Ask an administrator to check the runtime image reference and that the cluster's nodes can pull from its registry.";
  const stopping =
    "The Agent was stopped; its gateway is finishing active work before the stop completes.";
  for (const reader of ["deployment reader", "member without deployment access"]) {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace(`Named wait ${reader}`, { ready: true });
    const { page } = await newPage(t, fixture);
    await routeDedicatedProvisioning(page, fixture, namespace);
    const updatedAt = new Date().toISOString();
    const meta = { requestId: "req_00000000-0000-4000-8000-000000000001" };
    const url = `/namespaces/${namespace.id}/agents/provision/work_named`;
    let clientRequestId: ProvisionAgentBody["requestId"];
    const agentId = "agt_00000000-0000-4000-8000-00000000a690";
    const revisionId = "rev_00000000-0000-4000-8000-00000000a690";
    const job = (
      status: ProvisioningStatus["status"],
      extra: Partial<ProvisioningStatus> = {},
    ): ProvisioningStatus => ({
      workId: "work_named",
      status,
      phase: "configuration",
      attemptCount: 1,
      updatedAt,
      url,
      ...extra,
    });
    const handedOff = {
      phase: "handoff",
      agentId,
      configurationId: "cfg_named",
      revisionId,
    } as const;
    const pending = {
      code: "PROVISIONING_DEPLOYMENT_PENDING",
      message: "Waiting for the initial deployment to complete.",
    };
    const waiting = (lastAttempt: ProvisioningMessage | null) => ({
      ...handedOff,
      progress: {
        phase: "deployment" as const,
        lastAttempt: lastAttempt && { at: updatedAt, ...lastAttempt },
      },
    });
    const deploymentReader = reader === "deployment reader";
    let submitted = false;
    await page.route(`**/namespaces/${namespace.id}/agents/provision`, (route) => {
      submitted = true;
      clientRequestId = route.request().postDataJSON().requestId;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: { provisioning: { ...job("queued"), requestId: clientRequestId } },
          meta,
        }),
      });
    });
    // Each poll: the job's named wait, then what the deployment read that follows it answers.
    // The job hands off its first deployment, which waits for the runtime. The read names an
    // image pull failure before the job does. The deployment then waits for the Pod quota, then
    // the job names the image pull and the workspace node while the read is briefly unavailable
    // (503). Then the job still names the runtime wait while the read already reports the Pod
    // quota, and then the reader loses access (403). The refusal cleared the quota the earlier
    // read named, so a later unavailable read, while the job names only its own pending code,
    // adds nothing to the line. A stop's gateway drain follows, then no recorded wait, and the job
    // fails. The image pull, the quota and the stop stand alone. A member can't read the
    // deployment and gets the job's own code.
    const runtimeWait = { code: "REVISION_INCOMPLETE", message: runtime };
    const quotaWait = { code: "NAMESPACE_POD_QUOTA_EXCEEDED", message: quotaFull };
    const pullWait = { code: "REVISION_IMAGE_PULL_FAILED", message: pullFailed };
    const stopWait = { code: "AGENT_STOP_YIELDED", message: stopping };
    const polls: [ProvisioningMessage, ProvisioningMessage | 403 | 503][] = deploymentReader
      ? [
          [runtimeWait, runtimeWait],
          [runtimeWait, pullWait],
          [quotaWait, quotaWait],
          [pullWait, 503],
          [{ code: "WORKSPACE_NODE_PENDING", message: node }, 503],
          [runtimeWait, quotaWait],
          [runtimeWait, 403],
          // Writes nothing: the refusal dropped the quota, and the pending code adds no detail.
          [pending, 503],
          [stopWait, stopWait],
        ]
      : Array.from({ length: 6 }, () => [pending, 403]);
    const reads = [
      job("running"),
      job("queued", waiting(null)),
      ...polls.map(([wait]) => job("queued", waiting(wait))),
      job("queued", waiting(null)),
      job("failed", {
        ...handedOff,
        error: {
          code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
          message: "Agent provisioning could not complete.",
        },
      }),
    ];
    let read = 0;
    await page.route(`**/namespaces/${namespace.id}/agents/provision/work_named`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { ...reads[Math.min(read++, reads.length - 1)], requestId: clientRequestId },
          meta,
        }),
      }),
    );
    await page.route(
      `**/namespaces/${namespace.id}/agents/${agentId}/deployments/${revisionId}`,
      (route) => {
        // Job reads from 2 on carry the polls; the first handed-off one and the last name no wait.
        const answer = deploymentReader ? (polls[read - 3]?.[1] ?? null) : 403;
        if (typeof answer === "number") {
          return route.fulfill({
            status: answer,
            contentType: "application/json",
            body: JSON.stringify({
              error:
                answer === 503
                  ? { code: "SERVICE_UNAVAILABLE", message: "Service unavailable." }
                  : { code: "FORBIDDEN", message: "Access denied." },
              meta,
            }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              deploymentId: revisionId,
              namespaceId: namespace.id,
              agentId,
              status: "queued",
              error: null,
              warnings: [],
              progress: answer && {
                lastAttempt: { at: updatedAt, ...answer },
                nextAttemptAt: updatedAt,
              },
            },
            meta,
          }),
        });
      },
    );

    await trackSettledFetches(page);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("heading", { name: "Create Agent" }).waitFor();
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await page.getByLabel("Agent name").fill("Named wait");
    await page.getByLabel("Authentication method").selectOption("codex_pat");
    await createModelCredentialSecret(page, "model-secret-value");
    await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
    await page.evaluate(recordProvisioningWrites, ["Provisioning", "The ", "Kubernetes "]);
    const start = Date.now();
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start + 1_000);
    await page.getByRole("button", { name: "Create Agent" }).click();
    // Advance the clock only once the page has handled this poll's reads.
    for (let poll = 0; poll < reads.length; poll += 1) {
      await waitForCondition(() => submitted && read === poll, `job read ${poll} for a ${reader}`);
      await waitForIdleFetches(page);
      await page.clock.runFor(1_000);
    }
    await waitForProvisioningFailure(page);
    assert.equal(read, reads.length);
    assert.deepEqual(
      await page.evaluate(() => globalThis.provisioningWrites),
      deploymentReader
        ? [
            "Provisioning request accepted.",
            "Provisioning queued…",
            "Provisioning Agent…",
            `Provisioning Agent… ${runtime}`,
            pullFailed,
            quotaFull,
            pullFailed,
            `Provisioning Agent… ${node}`,
            quotaFull,
            "Provisioning Agent…",
            stopping,
            "Provisioning Agent…",
          ]
        : ["Provisioning request accepted.", "Provisioning queued…", "Provisioning Agent…"],
      `provisioning lines for a ${reader}`,
    );
  }
});

// A deployment read is optional. Even an unfinished response body gets only the time until
// the next provisioning poll; a second full interval after cancelling it would also be wrong.
for (const [name, leave] of [
  [
    "Create observes successful provisioning at the next poll despite stalled deployment details",
    false,
  ],
  ["Leaving Create Agent during a stalled deployment detail read stops polling the old job", true],
] as const) {
  test(name, async (t) => {
    const agentId = "agt_00000000-0000-4000-8000-00000000a681";
    const revisionId = "rev_00000000-0000-4000-8000-00000000a681";
    const detailPath = `/agents/${agentId}/deployments/${revisionId}`;
    const bodyStarted = Promise.withResolvers<void>();
    const fixture = await createConsoleAppFixture(t, {
      async onSend(
        request: { url: string },
        reply: { hijack(): void; raw: ServerResponse },
        payload: unknown,
      ) {
        if (!request.url.endsWith(detailPath)) {
          return payload;
        }
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "application/json" });
        reply.raw.write('{"data":', () => bodyStarted.resolve());
      },
    });
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Slow deployment details", { ready: true });
    const { page } = await newPage(t, fixture);
    await routeDedicatedProvisioning(page, fixture, namespace);

    const provision = `/namespaces/${namespace.id}/agents/provision`;
    const url = `${provision}/work_slow_detail`;
    const job = {
      workId: "work_slow_detail",
      url,
      agentId,
      revisionId,
      phase: "handoff",
      status: "running",
    };
    let requestId: string;
    await page.route(`**${provision}`, (route) => {
      requestId = route.request().postDataJSON().requestId;
      return route.fulfill({
        status: 202,
        json: { data: { provisioning: { ...job, requestId } } },
      });
    });
    const finishPoll = Promise.withResolvers<void>();
    await page.route(`**${url}`, async (route) => {
      // Let the browser report cancellation before navigation can cancel the detail read itself.
      await finishPoll.promise;
      await route.fulfill({
        json: { data: { provisioning: { ...job, requestId, status: "succeeded" } } },
      });
    });

    await trackSettledFetches(page);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await page.getByLabel("Agent name").fill("Slow deployment details");
    await page.getByLabel("Authentication method").selectOption("codex_pat");
    await createModelCredentialSecret(page, "model-secret-value");
    await page.getByLabel("Model", { exact: true }).selectOption({ index: 1 });
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1_000);
    await page.getByRole("button", { name: "Create Agent" }).click();
    await bodyStarted.promise;

    const detailCancelled = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url().endsWith(detailPath),
      timeout: 5_000,
    });
    if (leave) {
      finishPoll.resolve();
      await page.getByRole("link", { name: "Agents", exact: true }).click();
      await detailCancelled;
      await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
      await waitForSettledFetches(page, `/namespaces/${namespace.id}${detailPath}`, 1);
      await page.clock.runFor(2_000);
      await waitForIdleFetches(page);
      assert.equal(
        await settledFetches(page, url),
        0,
        "A departed view must not poll the old job.",
      );
      return;
    }

    try {
      await Promise.all([
        detailCancelled,
        page.waitForRequest((request) => request.url().endsWith(url), { timeout: 5_000 }),
        page.clock.runFor(1_000),
      ]);
    } finally {
      finishPoll.resolve();
    }
    await page.waitForURL((location) => location.pathname.endsWith(`/agents/${agentId}`));
  });
}

test("Agent creation rejects non-object native Configuration JSON before Configuration or Agent writes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Invalid JSON", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  requests.length = 0;

  await enterManualModel(page, "unused-invalid-config-key", "gpt-4.1");
  await page.getByLabel("Agent name").fill("Broken Agent");
  await openAdvancedSettings(page);
  const json = page.getByLabel("Configuration JSON");
  const jsonError = page.locator("#configuration-json-error");
  await json.fill("[]");
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByRole("button", { name: "Create Agent" }).click();

  // One persistent message under the field, linked to it; no browser bubble (finding 1903).
  await jsonError
    .getByText("Enter a valid JSON object, not an array or a single value.", { exact: true })
    .waitFor();
  assert.equal(await json.evaluate((node: HTMLTextAreaElement) => node.validationMessage), "");
  assert.equal(await json.getAttribute("aria-invalid"), "true");
  assert.match((await json.getAttribute("aria-describedby")) ?? "", /\bconfiguration-json-error\b/);
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.id),
    "configuration-json",
  );
  assert.equal(await json.isVisible(), true);

  // Editing clears the message; a parse error names its line and column.
  await json.fill('{\n  "model": 1,\n}');
  assert.equal(await jsonError.isHidden(), true);
  assert.equal(await json.getAttribute("aria-invalid"), null);
  assert.doesNotMatch(
    (await json.getAttribute("aria-describedby")) ?? "",
    /\bconfiguration-json-error\b/,
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  await jsonError
    .getByText("Invalid JSON at line 3, column 1. Enter a valid JSON object.", { exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.id),
    "configuration-json",
  );
  assert.equal(secretPostRequests(requests, namespace.id).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
});

test("Agent creation offers mainline Anthropic models before credentials and saves an explicit selection", async (t) => {
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const secretDriver = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, {
    state,
    secretDriver,
    backendSummaries: undefined,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Anthropic authoring", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  const serviceAccountSecret = page.getByLabel("Service account token Secret", { exact: true });
  await serviceAccountSecret.waitFor();
  assert.equal(await serviceAccountSecret.inputValue(), "");
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.deepEqual(
    await page
      .getByLabel("Harness", { exact: true })
      .locator("option:not([disabled])")
      .evaluateAll((options: HTMLOptionElement[]) => options.map((option) => option.value)),
    ["openclaw"],
  );
  const apiKeySecret = page.getByLabel("API key Secret", { exact: true });
  await apiKeySecret.waitFor();
  assert.equal(await apiKeySecret.inputValue(), "");
  assert.equal(await page.getByRole("link", { name: "OpenAI admin", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  assert.equal(
    await page.getByLabel("Authentication method", { exact: true }).inputValue(),
    "api_key",
  );
  const authMethod = page.getByLabel("Authentication method", { exact: true });
  await waitForEnabled(authMethod);
  assert.deepEqual(
    await authMethod
      .locator("option:not([disabled])")
      .evaluateAll((options: HTMLOptionElement[]) => options.map((option) => option.value)),
    ["api_key"],
  );
  await authMethod.selectOption("api_key");
  assert.equal(await apiKeySecret.inputValue(), "");
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByLabel("Authentication source").count(), 0);
  assert.equal(await page.getByLabel("Model", { exact: true }).isVisible(), true);
  assert.equal(await page.getByLabel("Model ID", { exact: true }).isVisible(), false);
  assert.equal(
    JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents?.defaults?.model,
    undefined,
  );
  const choice = page.getByLabel("Model", { exact: true });
  assert.deepEqual(
    (await optionValues(choice)).map(({ value }) => value),
    [
      "",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-mythos-5-1",
      "claude-opus-5",
      "claude-fable-5",
      "claude-mythos-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-mythos-preview",
    ],
  );
  assert.equal(await choice.inputValue(), "");
  await choice.selectOption("claude-fable-5-1");
  const selectedConfiguration = await page.getByLabel("Configuration JSON").inputValue();
  await page.getByLabel("Agent name").fill("Anthropic Agent");
  const credentialSecret = await createModelCredentialSecret(page, "test-anthropic-api-key");
  assert.equal(await choice.inputValue(), "claude-fable-5-1");
  assert.equal(await page.getByLabel("Configuration JSON").inputValue(), selectedConfiguration);
  assert.deepEqual(
    secretPostRequests(requests, namespace.id).map((request) => request.body),
    [{ name: "Anthropic Agent model credential", value: "test-anthropic-api-key" }],
  );
  assert.equal(secretDriver.calls.filter((call) => call.operation === "create").length, 1);
  assert.equal(JSON.stringify(audit.events).includes("test-anthropic-api-key"), false);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const agent: AgentWire = (await response.json()).data;
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
  assert.equal(agent.executionMode, "embedded");
  assert.equal(agent.backendId, null);
  assert.deepEqual(agent.harnessAuth, { method: "api_key", source: credentialSecret.ref });
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.data.values.agents.defaults.model, "anthropic/claude-fable-5-1");
  assert.deepEqual(configuration.data.values.models.providers.anthropic, {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [{ id: "claude-fable-5-1", name: "claude-fable-5-1" }],
  });
  assert.equal(
    configuration.data.values.agents.defaults.models["anthropic/claude-fable-5-1"].agentRuntime.id,
    "openclaw",
  );
  assert.equal(pathRequests(requests, "GET", "/backends").length, 0);
  assert.equal(
    pathRequests(requests, "GET", `/namespaces/${namespace.id}/service-accounts`).length,
    0,
  );
  assert.equal(JSON.stringify(configuration.data).includes("test-anthropic-api-key"), false);
});

test("Static model selection survives credential edits and resets for provider or authentication changes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Static model choices", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  const key = page.getByLabel("API key Secret", { exact: true });
  const choice = page.getByLabel("Model", { exact: true });
  const configuration = page.getByLabel("Configuration JSON");
  assert.equal(await key.inputValue(), "");
  assert.equal(await choice.isVisible(), true);
  assert.equal(await choice.isEnabled(), true);
  assert.deepEqual(
    (await optionValues(choice)).map(({ value }) => value),
    ["", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  );
  assert.equal(await choice.locator('option[value=""]').textContent(), "Choose a model");
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents?.defaults?.model, undefined);
  await choice.selectOption("gpt-6-astra");
  const selectedConfiguration = await configuration.inputValue();
  assert.equal(JSON.parse(selectedConfiguration).agents.defaults.model, "codex/gpt-6-astra");
  for (const credential of ["first-openai-key", "replacement-openai-key"]) {
    await page.getByLabel("Agent name").fill(`Static model ${credential}`);
    await createModelCredentialSecret(page, credential);
    assert.equal(await choice.inputValue(), "gpt-6-astra");
    assert.equal(await configuration.inputValue(), selectedConfiguration);
  }

  // Switching compatible harnesses changes the native transport without clearing the model.
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  assert.equal(await choice.inputValue(), "gpt-6-astra");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "openai/gpt-6-astra",
  );
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  assert.equal(await choice.inputValue(), "gpt-6-astra");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-6-astra",
  );

  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  const patSecret = page.getByLabel("Service account token Secret", { exact: true });
  assert.equal(await patSecret.inputValue(), "");
  assert.equal(await choice.isVisible(), true);
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);
  await choice.selectOption("gpt-5.6-terra");
  await page.getByLabel("Agent name").fill("Static model service account token");
  await createModelCredentialSecret(page, "at-static-model-token");
  assert.equal(await choice.inputValue(), "gpt-5.6-terra");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-5.6-terra",
  );
  await page.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
  assert.equal(await key.inputValue(), "");
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);

  await choice.selectOption("gpt-5.6-luna");
  await page.getByLabel("Agent name").fill("Static model discarded OpenAI key");
  await createModelCredentialSecret(page, "discarded-openai-key");
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await key.inputValue(), "");
  assert.equal(await choice.isVisible(), true);
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);
  await choice.selectOption("claude-opus-5-5");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "anthropic/claude-opus-5-5",
  );
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);
  await choice.selectOption("gpt-5.6-luna");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-5.6-luna",
  );
  assert.deepEqual(
    secretPostRequests(requests, namespace.id).map(({ body }) => (body as CreateSecretBody).value),
    ["first-openai-key", "replacement-openai-key", "at-static-model-token", "discarded-openai-key"],
  );
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
});

test("Agent creation can return from manual model entry to the list and save the selected model", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Model selection round trip", { ready: true });
  const { page } = await newPage(t, fixture);
  // Save through the regular draft workflow; this case does not exercise provisioning.
  await routeInstallationWithoutProvisioning(page, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Agent name").fill("Model selection round trip");
  const credential = page.getByLabel("API key Secret", { exact: true });
  const choice = page.getByLabel("Model", { exact: true });
  const model = page.getByLabel("Model ID", { exact: true });
  const configuration = page.getByLabel("Configuration JSON");

  // JSON edits can change the provider; returning to the list must show its models.
  await choice.selectOption("gpt-6-astra");
  const values = JSON.parse(await configuration.inputValue());
  values.agents.defaults.model = "anthropic/custom-model-id";
  await openAdvancedSettings(page);
  await configuration.fill(JSON.stringify(values));
  await configuration.press("Tab");
  await page.getByRole("button", { name: "Choose a model from the list", exact: true }).click();
  assert.equal(
    (await optionValues(choice)).some(({ value }) => value === "claude-opus-5-5"),
    true,
  );
  assert.equal(
    (await optionValues(choice)).some(({ value }) => value === "gpt-6-astra"),
    false,
  );
  await choice.selectOption("claude-opus-5-5");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "anthropic/claude-opus-5-5",
  );
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents?.defaults?.model, undefined);
  const secret = await createModelCredentialSecret(page, "round-trip-model-key");
  await choice.selectOption("gpt-6-astra");
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  assert.equal(await choice.isVisible(), false);
  assert.equal(await model.evaluate((input) => input.ownerDocument.activeElement === input), true);
  assert.equal(await model.inputValue(), "gpt-6-astra");
  assert.equal(await model.evaluate((input: HTMLInputElement) => input.required), true);
  assert.equal(await choice.evaluate((input: HTMLSelectElement) => input.required), false);
  // A manual edit replaces the previous list selection in the same Configuration.
  await model.fill("gpt-6-sol");
  await model.press("Tab");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-6-sol",
  );
  await page.getByRole("button", { name: "Choose a model from the list", exact: true }).click();
  assert.equal(await choice.inputValue(), "gpt-6-sol");
  assert.equal(await model.isVisible(), false);
  assert.equal(await choice.isVisible(), true);
  assert.equal(await model.evaluate((input: HTMLInputElement) => input.required), false);
  assert.equal(await choice.evaluate((input: HTMLSelectElement) => input.required), true);
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-6-sol",
  );
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await model.fill("custom-model-id");
  await model.press("Tab");

  // Changing entry mode clears the custom model, but keeps the credential and other settings.
  await page.getByRole("button", { name: "Choose a model from the list", exact: true }).click();
  assert.equal(await model.isVisible(), false);
  assert.equal(await choice.isVisible(), true);
  assert.equal(await choice.evaluate((input) => input.ownerDocument.activeElement === input), true);
  assert.equal(await choice.inputValue(), "");
  assert.equal(
    await choice.evaluate((input: HTMLSelectElement) => input.validity.valueMissing),
    true,
  );
  assert.equal(JSON.parse(await configuration.inputValue()).agents?.defaults?.model, undefined);
  assert.equal(await credential.inputValue(), secretOptionLabel(secret));
  assert.equal(await page.getByLabel("Agent name").inputValue(), "Model selection round trip");
  await choice.selectOption("gpt-6-sol");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-6-sol",
  );

  // Repeated switches must still offer both modes without leaving a hidden required input.
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  assert.equal(await model.inputValue(), "gpt-6-sol");
  await page.getByRole("button", { name: "Choose a model from the list", exact: true }).click();
  assert.equal(await choice.inputValue(), "gpt-6-sol");
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const agent: AgentWire = (await response.json()).data;
  assert.deepEqual(agent.harnessAuth, { method: "api_key", source: secret.ref });
  const savedConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(savedConfiguration.data.values.agents.defaults.model, "codex/gpt-6-sol");
});

test("Agent creation accepts a manual model outside the static list and saves through the real Agent API", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Manual model override", { ready: true });
  const presets = await fixture.request("GET", `/namespaces/${namespace.id}/presets`);
  const starter = (presets.data as PresetSummaryWire[]).find(
    (preset) => preset.name === "default-codex",
  );
  assert.ok(starter, "expected the default Codex Preset");
  const template = structuredClone(
    (await fixture.request("GET", `/namespaces/${namespace.id}/presets/${starter.id}`)).data
      .template,
  );
  template.configuration.values.browser = { enabled: false };
  assert.equal(
    (
      await fixture.request("PATCH", `/namespaces/${namespace.id}/presets/${starter.id}`, {
        body: { template },
      })
    ).status,
    200,
  );
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Agent name").fill("Manual model Agent");
  assert.equal(
    JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).browser.enabled,
    false,
  );
  // Later Preset updates must not change the draft or the Configuration saved from it.
  template.configuration.values.browser.enabled = true;
  assert.equal(
    (
      await fixture.request("PATCH", `/namespaces/${namespace.id}/presets/${starter.id}`, {
        body: { template },
      })
    ).status,
    200,
  );
  // Submit manual entry after a different list choice; only the manual model may be saved.
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-astra");
  const selectedSecret = await enterManualModel(
    page,
    "manual-model-key",
    "gpt-manual-account-model",
  );
  assert.deepEqual(
    secretPostRequests(requests, namespace.id).map((request) => request.body),
    [{ name: "Manual model Agent model credential", value: "manual-model-key" }],
  );
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const agent: AgentWire = (await response.json()).data;
  assert.deepEqual(agent.harnessAuth, { method: "api_key", source: selectedSecret.ref });
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.data.values.agents.defaults.model, "codex/gpt-manual-account-model");
  assert.equal(JSON.stringify(configuration.data).includes("manual-model-key"), false);
  assert.equal(configuration.data.values.browser.enabled, false);
  assert.equal(
    configuration.data.values.plugins.entries.codex.config.appServer.sandbox,
    "read-only",
  );
  assert.equal(
    configuration.data.values.plugins.entries.codex.config.appServer.approvalPolicy,
    "on-request",
  );
  assert.equal(
    pathRequests(requests, "GET", `/namespaces/${namespace.id}/presets/${starter.id}`).length,
    1,
  );
});

test("Agent creation recognizes its saved Configuration when JSON serializes negative zero as zero", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Configuration wire values", { ready: true });
  const root = `/namespaces/${namespace.id}`;
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Agent name").fill("Model temperature");
  await enterManualModel(page, "test-model-temperature-key", "gpt-4.1");
  await openAdvancedSettings(page);
  const editor = page.getByLabel("Configuration JSON");
  const values = JSON.parse(await editor.inputValue());
  const model = values.agents.defaults.model;
  values.agents.defaults.models[model].params = { temperature: "zero" };
  // The input contains -0. The browser serializes that JSON number as 0 on the wire.
  await editor.fill(JSON.stringify(values).replace('"temperature":"zero"', '"temperature":-0'));
  const saved = page.waitForResponse(
    (response) =>
      response.url() === fixture.origin + root + "/configurations" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const { data } = await response.json();
  assert.equal(data.values.agents.defaults.models[model].params.temperature, 0);
  const details = page.getByRole("button", {
    name: "View new version, editable Configuration",
    exact: true,
  });
  await details.or(page.getByRole("alert").filter({ hasText: "Outcome unknown" })).waitFor();
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(
    agentPostRequests(requests, namespace.id).length,
    1,
    "the matching saved Configuration was recognized",
  );
  await details.waitFor();
});

test("Agent creation names the Configuration field that holds an inline model credential without showing it", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    filesystemConfiguration: true,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Create inline credential", { ready: true });
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Inline credential Agent");
  await enterManualModel(page, "inline-credential-model-key", "gpt-inline-credential");
  await openAdvancedSettings(page);
  // A pasted provider key is a value, not the Secret reference the field requires.
  const sentinel = `synthetic-inline-key-${randomUUID()}`;
  const configuration = page.getByLabel("Configuration JSON");
  const edited = JSON.parse(await configuration.inputValue());
  edited.models = {
    ...edited.models,
    providers: { ...edited.models?.providers, openai: { apiKey: sentinel } },
  };
  await configuration.fill(JSON.stringify(edited, null, 2));
  // The preflight checks the selected model credential Secret against the Configuration as Agent
  // save would (finding 2391), so it refuses the inline key before the Configuration is saved.
  const rejected = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/validate` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await rejected).status(), 400);
  const feedback = page.getByRole("alert").filter({
    hasText:
      "Configuration setting models.providers.openai.apiKey must be unset: Dedicated Codex receives model credentials from the Agent's Harness authentication binding.",
  });
  await feedback.waitFor();
  // Only the editor holds the key; the explanation never repeats it.
  const explanation = await feedback.textContent();
  assert.ok(explanation, "expected the explanation of the credential field");
  assert.equal(explanation.includes(sentinel), false);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  await waitForEnabled(configuration);
});

test("Agent creation reports unavailable Secret storage before creating Configuration or Agent", async (t) => {
  const fixture = await createConsoleAppFixture(t, { secretDriver: null });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Missing Secret storage", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Agent name").fill("Unavailable Agent");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  const failed = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/secrets` &&
      response.request().method() === "POST",
  );
  await openCreateSecretDialog(page, "API key Secret");
  const dialog = page.getByRole("dialog", { name: "Create model credential Secret" });
  await dialog.getByLabel("Value", { exact: true }).fill("unused-no-driver-key");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  assert.equal((await failed).status(), 503);
  await dialog
    .getByRole("alert")
    .filter({ hasText: /outcome could not be confirmed/i })
    .waitFor();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
});

test("Agent creation shows the API's duplicate-name conflict, a not-ready Namespace, generic text for other conflicts, and keeps the form usable", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Duplicate Agent name", { ready: true });
  await fixture.createAgent(namespace.id, "Taken Agent");
  const { page } = await newPage(t, fixture);
  // The regular create path, which skips the provisioning job.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Taken Agent");
  await enterManualModel(page, "duplicate-name-model-key", "gpt-duplicate-name");
  const agentsUrl = `${fixture.origin}/namespaces/${namespace.id}/agents`;
  const agentPost = (response: Response) =>
    response.url() === agentsUrl && response.request().method() === "POST";
  const sentence =
    "An Agent with this name already exists in this Namespace. Choose a different name.";

  // The preflight refuses a name another Agent has with create's 409, before the form saves a
  // Configuration it could no longer change, and marks the name field (finding 2420).
  const preflight = page.waitForResponse(
    (response) =>
      response.url() === `${agentsUrl}/validate` && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await preflight).status(), 409);
  await page.getByRole("alert").filter({ hasText: sentence }).waitFor();
  await assertAgentNameTaken(page);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  // Another name clears the mark; the conflicts below come after the Configuration is saved.
  await page.getByLabel("Agent name").fill("Racing Agent");
  assert.equal(await page.getByLabel("Agent name").getAttribute("aria-invalid"), null);

  // Any other conflict keeps the generic text: plain conflicts reach the client as "The
  // requested platform resource already exists.", which would mislead on this form.
  const otherConflict = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "RESOURCE_CONFLICT",
          message: RESOURCE_CONFLICT,
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
      }),
    });
  };
  await page.route(agentsUrl, otherConflict);
  const conflicted = page.waitForResponse(agentPost);
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await conflicted).status(), 409);
  await page
    .getByRole("alert")
    .filter({
      hasText:
        "Agent creation conflicts with the saved state. Check the Agent name and selections, then try again. Request ID: req_00000000-0000-4000-8000-000000000409",
    })
    .waitFor();
  assert.equal(await page.getByText(RESOURCE_CONFLICT).count(), 0);
  await page.unroute(agentsUrl, otherConflict);
  await page.getByRole("button", { name: "Create Agent", disabled: false }).waitFor();

  // A Namespace that is still provisioning is named as the cause, not a saved-state conflict.
  const notReady = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "NAMESPACE_NOT_READY", message: NAMESPACE_NOT_READY },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000410" },
      }),
    });
  };
  await page.route(agentsUrl, notReady);
  const refused = page.waitForResponse(agentPost);
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await refused).status(), 409);
  await page
    .getByRole("alert")
    .filter({
      hasText:
        "This Namespace is not ready yet. Check its status on the Namespaces page: a provisioning Namespace becomes ready when its Kubernetes setup completes (on Kubernetes installs, after an operator grants the tenant RoleBindings). Request ID: req_00000000-0000-4000-8000-000000000410",
    })
    .waitFor();
  assert.equal(await page.getByText(/conflicts with the saved state/).count(), 0);
  await page.unroute(agentsUrl, notReady);
  await page.getByRole("button", { name: "Create Agent", disabled: false }).waitFor();

  // Another create takes the name after the preflight: the API's own 409 names it too.
  await raceAgentName(page, fixture, namespace.id, "Racing Agent");
  const rejected = page.waitForResponse(agentPost);
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await rejected).status(), 409);
  const feedback = page.getByRole("alert").filter({ hasText: sentence });
  await feedback.waitFor();
  assert.match(
    (await feedback.textContent()) ?? "",
    /^An Agent with this name already exists in this Namespace\. Choose a different name\.( Request ID: req_[0-9a-f-]+)?$/,
  );
  const name = page.getByLabel("Agent name");
  const create = page.getByRole("button", { name: "Create Agent" });
  await page.getByRole("button", { name: "Create Agent", disabled: false }).waitFor();
  await waitForEnabled(name);
  await waitForEnabled(create);
  await assertAgentNameTaken(page);

  // A new name saves through the same Configuration.
  await name.fill("Free Agent");
  const saved = page.waitForResponse(agentPost);
  await create.click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const agent: AgentWire = (await response.json()).data;
  assert.equal(agent.name, "Free Agent");
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
});

test("Agent creation reuses its saved Secret and Configuration after an Agent creation conflict", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const namespace = await fixture.createNamespace("Partial save retry", { ready: true });
  const discardedPatSecret = await fixture.createSecret(
    namespace.id,
    "Discarded service account token",
    "at-discarded-pat",
  );
  const values = nativeValues("partial-save", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  await selectSecret(page, "Service account token Secret", discardedPatSecret);
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("discarded-pat-model");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  // OpenClaw requires a new API key, never the previous service account token.
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  assert.equal(
    await page.getByLabel("Authentication method", { exact: true }).inputValue(),
    "api_key",
  );
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Model ID", { exact: true }).isVisible(), false);
  assert.equal(
    JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents.defaults.model,
    undefined,
  );
  assert.equal(
    await page
      .getByLabel("Authentication method", { exact: true })
      .locator('[value="codex_pat"]')
      .isDisabled(),
    true,
  );
  // Plugin catalog discovery is a read sent as POST. The codex_pat Secret above arms its
  // prefetch with a 300 ms debounce, so it may or may not have been sent before the switch.
  const pluginCatalogPath = `/namespaces/${namespace.id}/agents/plugins`;
  assert.deepEqual(
    nonAuthWriteRequests(requests).filter((request) => request.path !== pluginCatalogPath),
    [],
  );
  assert.deepEqual(pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`), []);
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  await selectSecret(page, "Service account token Secret", discardedPatSecret);
  await openAdvancedSettings(page);
  await page
    .getByLabel("Configuration JSON")
    .fill(JSON.stringify(createHarnessConfiguration("openclaw", "gpt-5.1")));
  // Manual Configuration changes obey the same credential boundary while keeping their model.
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(
    await page.getByLabel("Authentication method", { exact: true }).inputValue(),
    "api_key",
  );
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Model ID", { exact: true }).inputValue(), "gpt-5.1");
  assert.equal(
    JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents.defaults.model,
    "openai/gpt-5.1",
  );
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  requests.length = 0;
  await page.getByLabel("Agent name").fill("Retry Agent");
  const selectedSecret = await createModelCredentialSecret(page, "at-browser-pat");
  assert.equal(
    await page.getByLabel("Service account token Secret", { exact: true }).inputValue(),
    secretOptionLabel(selectedSecret),
  );
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  assert.deepEqual(pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`), []);
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByLabel("SOUL.md", { exact: true }).fill("# Keep this draft\n");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));

  const configurationResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  const deniedAgentResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  // Another create takes the name after the preflight, so the Secret and Configuration are saved
  // before the API refuses the Agent.
  await raceAgentName(page, fixture, namespace.id, "Retry Agent");
  await page.getByRole("button", { name: "Create Agent" }).click();
  const savedConfiguration = await (await configurationResponse).json();
  assert.equal((await deniedAgentResponse).status(), 409);
  await page
    .getByText(`Configuration saved: ${savedConfiguration.data.id}.`, { exact: false })
    .waitFor();
  await page
    .getByText("An Agent with this name already exists in this Namespace. Choose a different name.")
    .waitFor();
  assert.equal(
    await page
      .getByRole("heading", {
        name: "Recover from a rejected Agent save",
        includeHidden: true,
      })
      .isVisible(),
    false,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Reload repository choices", includeHidden: true })
      .isVisible(),
    false,
  );
  assert.equal(await page.getByLabel("Configuration JSON").isDisabled(), true);
  assert.equal(
    await page.getByLabel("Service account token Secret", { exact: true }).inputValue(),
    secretOptionLabel(selectedSecret),
  );
  assert.equal(
    await page.getByLabel("Service account token Secret", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "codex");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("Authentication method", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Reset template" }).isDisabled(), true);
  assert.deepEqual(
    configurationPostRequests(requests, namespace.id).map((request) => request.body),
    [{ kind: "agent", values }],
  );
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);

  assert.equal(
    await page.getByLabel("SOUL.md", { exact: true }).inputValue(),
    "# Keep this draft\n",
  );
  assert.equal(await page.getByLabel("SOUL.md", { exact: true }).isEnabled(), true);
  assert.equal(await page.getByLabel("Plugin selections JSON").isEnabled(), true);
  await page.getByLabel("SOUL.md", { exact: true }).fill("# Corrected draft\n");
  await openAdvancedSettings(page);
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  await page.getByLabel("Plugin selections JSON").fill(
    JSON.stringify({
      "codex-plugin:linear@openai-curated-remote": {
        enabled: true,
        toolDefaults: { approval: "none" },
      },
    }),
  );
  await page.getByLabel("Agent name").fill("Retry Agent Corrected");
  const retryResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const retried = await (await retryResponse).json();
  assert.equal(retried.data.name, "Retry Agent Corrected");
  assert.equal(retried.data.harnessAuth.method, "codex_pat");
  assert.equal(retried.data.configurationId, savedConfiguration.data.id);
  assert.equal(retried.data.activeRevisionId, undefined);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.deepEqual(
    secretPostRequests(requests, namespace.id).map(({ body }) => body),
    [{ name: "Retry Agent model credential", value: "at-browser-pat" }],
  );
  const attempts = agentPostRequests(requests, namespace.id).map(
    ({ body }) => body as CreateAgentBody,
  );
  assert.equal(attempts.length, 2);
  const [first, corrected] = attempts;
  assert.ok(first && corrected, "expected both Agent submissions");
  assert.deepEqual(first.harnessAuth, {
    method: "codex_pat",
    source: selectedSecret.ref,
  });
  assert.deepEqual(corrected.harnessAuth, {
    method: "codex_pat",
    source: selectedSecret.ref,
  });
  assert.deepEqual(retried.data.harnessAuth, { method: "codex_pat", source: selectedSecret.ref });
  assert.equal(first.initialWorkspaceFiles?.["SOUL.md"], "# Keep this draft\n");
  assert.equal(corrected.initialWorkspaceFiles?.["SOUL.md"], "# Corrected draft\n");
  assert.deepEqual(retried.data.plugins, {
    "codex-plugin:linear@openai-curated-remote": {
      enabled: true,
      toolDefaults: { approval: "none" },
    },
  });
  for (const body of attempts) {
    assert.equal(body.workspaceDefaultsId, WORKSPACE_DEFAULTS_ID);
  }
});

test("Agent creation retries a denied credential grant without duplicating its saved resources", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  const installation = await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Credential grant retry", { ready: true });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  // Native IAM denies the administrator's grant authority after the session found it allowed. A
  // session that already knows it is refused sends no grant at all (finding 2109).
  fixture.policy.restrictions.push({
    id: "deny-credential-grant",
    resourceKind: "installation",
    resourceId: installation.id,
    action: "administer",
    effect: "deny",
  });
  await page.getByLabel("Agent name").fill("Grant retry Agent");
  await enterManualModel(page, "grant-retry-key", "gpt-4.1");
  const created = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await created;
  assert.equal(response.status(), 201);
  const agent: AgentWire = (await response.json()).data;
  await page
    .getByRole("alert")
    .filter({ hasText: /Agent was created, but credential access is not confirmed/ })
    .waitFor();
  assert.match(
    (await page.getByRole("link", { name: "Open saved Agent" }).getAttribute("href")) ?? "",
    new RegExp(agent.id),
  );
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);
  const bindingPath = `/namespaces/${namespace.id}/iam/access-bindings`;
  assert.equal(pathRequests(requests, "POST", bindingPath).length, 0);
  fixture.policy.restrictions.splice(
    fixture.policy.restrictions.findIndex((item) => item.id === "deny-credential-grant"),
    1,
  );

  // The binding is really committed; only its response is lost before the browser sees it.
  await page.route(`**${bindingPath}`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /credential access is not confirmed.*interrupted/ })
    .waitFor();
  await page.unroute(`**${bindingPath}`);
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
  const bindings = await fixture.request("GET", bindingPath);
  assert.equal(bindings.status, 200);
  const grants: IAMAccessBindingWire[] = bindings.data;
  assert.equal(grants.length, 1);
  const [grant] = grants;
  assert.ok(grant && "resourceId" in grant, "expected a resource-specific credential grant");
  assert.equal(grant.subjectId, agent.servicePrincipalId);
  assert.ok(agent.harnessAuth && "source" in agent.harnessAuth);
  assert.equal(grant.resourceId, agent.harnessAuth.source.id);
  assert.equal(pathRequests(requests, "POST", bindingPath).length, 1);
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/iam/roles`).length, 1);
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
});

for (const swapped of ["Agent", "service principal"]) {
  test(`Agent creation does not grant a model Secret to a different ${swapped} in the response`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Agent response identity", { ready: true });
    const other = await fixture.createAgent(namespace.id, "Another Agent", nativeValues("other"));
    const agents = `/namespaces/${namespace.id}/agents`;
    const bindings = `/namespaces/${namespace.id}/iam/access-bindings`;
    const { page } = await newPage(t, fixture);
    await routeInstallationWithoutProvisioning(page, fixture);
    const requests = apiRequests(page, fixture.origin);
    let created: AgentWire | undefined;
    await page.route(`**${agents}`, async (route) => {
      if (route.request().method() !== "POST") {
        return route.continue();
      }
      // Commit the requested Agent. Substitute a different real Agent, or only its service principal.
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      const { data, meta } = await response.json();
      assert.equal(data.name, "New Agent");
      assert.notEqual(data.configurationId, other.configurationId);
      assert.notEqual(data.servicePrincipalId, other.servicePrincipalId);
      created = data as AgentWire;
      const swappedData =
        swapped === "Agent" ? other : { ...data, servicePrincipalId: other.servicePrincipalId };
      await route.fulfill({ status: 201, json: { data: swappedData, meta } });
    });
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start with default Preset" }).click();
    await page.getByLabel("Agent name").fill("New Agent");
    const secret = await enterManualModel(page, "test-create-response-key");
    await page.getByRole("button", { name: "Create Agent" }).click();
    const warning = page.getByRole("alert").filter({
      hasText: swapped === "Agent" ? "Outcome unknown" : "service principal could not be confirmed",
    });
    // If creation incorrectly continues to Agent details, inspect the actual grant before failing.
    await warning
      .or(
        page.getByRole("button", { name: "View new version, editable Configuration", exact: true }),
      )
      .waitFor();
    const saved = await fixture.request("GET", bindings);
    assert.equal(saved.status, 200);
    const grants: IAMAccessBindingWire[] = saved.data;
    assert.equal(
      grants.some(
        (binding) =>
          binding.subjectId === other.servicePrincipalId &&
          "resourceId" in binding &&
          binding.resourceId === secret.id,
      ),
      false,
      "the unrelated Agent must not get access to this model Secret",
    );
    assert.equal(pathRequests(requests, "POST", bindings).length, 0);
    assert.equal(agentPostRequests(requests, namespace.id).length, 1);
    await warning.waitFor();
    if (swapped === "Agent") {
      assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
      return;
    }

    assert.ok(created);
    const agent = created;
    const path = `${agents}/${agent.id}`;
    assert.equal(pathRequests(requests, "GET", path).length, 1);
    const reread = page.waitForResponse((response) => response.url() === fixture.origin + path);
    await page.getByRole("button", { name: "Retry credential access" }).click();
    assert.equal((await reread).status(), 200);
    await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
    const recovered: IAMAccessBindingWire[] = await fixture.addedAccessBindings(namespace.id);
    assert.deepEqual(
      recovered.map((binding) => [
        binding.subjectId,
        "resourceId" in binding && binding.resourceId,
      ]),
      [[agent.servicePrincipalId, secret.id]],
      "the explicit retry grants only the saved Agent access to the selected Secret",
    );
    assert.equal(agentPostRequests(requests, namespace.id).length, 1);
    assert.equal(pathRequests(requests, "POST", bindings).length, 1);
  });
}

for (const collection of ["secrets", "configurations", "agents"]) {
  test(`Agent creation blocks duplicate writes after losing the committed ${collection} response`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace(`Uncertain ${collection}`, { ready: true });
    const { page } = await newPage(t, fixture);
    // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
    await routeInstallationWithoutProvisioning(page, fixture);
    const requests = apiRequests(page, fixture.origin);
    const path = `/namespaces/${namespace.id}/${collection}`;
    let committed: { id: string } | undefined;
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      committed = (await response.json()).data;
      await route.abort("failed");
    });
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start with default Preset" }).click();
    await page.getByLabel("Agent name").fill(`Uncertain ${collection} Agent`);
    if (collection === "secrets") {
      await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
      await openCreateSecretDialog(page, "API key Secret");
      const dialog = page.getByRole("dialog", { name: "Create model credential Secret" });
      await dialog.getByLabel("Value", { exact: true }).fill("uncertain-artifact-key");
      await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
      await dialog
        .getByRole("alert")
        .filter({ hasText: /outcome could not be confirmed/i })
        .waitFor();
      assert.ok(committed?.id);
      assert.equal((await fixture.request("GET", `${path}/${committed.id}`)).status, 200);
      assert.equal(pathRequests(requests, "POST", path).length, 1);
      assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
      assert.equal(agentPostRequests(requests, namespace.id).length, 0);
      return;
    }
    const selectedSecret = await enterManualModel(page, "uncertain-artifact-key", "gpt-4.1");
    assert.equal(
      await page.getByLabel("API key Secret", { exact: true }).inputValue(),
      secretOptionLabel(selectedSecret),
    );
    await page.getByRole("button", { name: "Create Agent" }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: /Outcome unknown/ })
      .waitFor();
    assert.ok(committed?.id);
    assert.equal((await fixture.request("GET", `${path}/${committed.id}`)).status, 200);
    assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), true);
    // Even programmatic form resubmission must respect the unknown-commit boundary.
    await page
      .locator("#create-agent-form")
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
    assert.equal(pathRequests(requests, "POST", path).length, 1);
    const sequence = ["secrets", "configurations", "agents"];
    for (const later of sequence.slice(sequence.indexOf(collection) + 1)) {
      assert.equal(
        pathRequests(requests, "POST", `/namespaces/${namespace.id}/${later}`).length,
        0,
      );
    }
  });
}

// The Agents list painted "Reading deployment…" in each row, then each failed row's 5-7 line
// error landed: the row grew from 93 to 208 px and the table re-flowed its columns, CLS
// 0.040-0.074 on every load (finding 1488). A settled cell is the outcome link and one note
// line, which fit the two lines the Agent cell gives the row: the error is on one line (its full
// text in the title and on the Agent page), and the columns keep their widths.
test("the Agents list does not move when failed deployments land", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Steady Agents list", { ready: true });
  const agents = [
    ["Alpha failed", "RUNTIME_MODEL_PROBE_FAILED", 500],
    ["Beta completed", null, 650],
    ["Gamma failed", "RUNTIME_AUTHENTICATION_FAILED", 800],
    ["Delta completed", null, 950],
    ["Epsilon failed", "CONVERGENCE_DEADLINE_EXCEEDED", 1100],
    ["Zeta completed", null, 1250],
  ] as const;
  const records = [];
  for (const [name, code, delay] of agents) {
    const agent = await fixture.createAgent(namespace.id, name, nativeValues(name));
    const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const error = code ? persistedDeploymentError(code) : null;
    records.push({
      name,
      error,
      delay,
      agentId: agent.id,
      revisionId: revision.id,
      url: `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`,
    });
  }
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    const { page } = await newPage(t, fixture, { context: { viewport } });
    // Each record settles on its own, as on a live cluster.
    for (const record of records) {
      await page.route(record.url, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, record.delay));
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              data: {
                deploymentId: record.revisionId,
                namespaceId: namespace.id,
                agentId: record.agentId,
                status: record.error ? "failed" : "succeeded",
                error: record.error,
                warnings: [],
                progress: null,
              },
              meta: { requestId: "req_test_steady_agents_list" },
            }),
          })
          .catch(() => {});
      });
    }
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await page.getByRole("link", { name: "Zeta completed" }).waitFor();
    await page.addInitScript(recordLayoutShifts);
    // A full load, so no recent input excuses a shift.
    await page.reload();
    for (const { name, error } of records) {
      const row = page.getByRole("row").filter({ hasText: name });
      await row
        .getByRole("link", { name: error ? "v1 · Failed" : "v1 · Completed", exact: true })
        .waitFor();
    }
    await page.evaluate(() => globalThis.document.fonts.ready);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { shift, shifts } = await takeLayoutShifts(page);
    t.diagnostic(`${viewport.width}x${viewport.height} shift ${shift}: ${JSON.stringify(shifts)}`);
    assert.ok(shift < 0.01, `${viewport.width}x${viewport.height} shift ${shift}`);
    // The whole error stays readable in the row.
    for (const { name, error } of records) {
      if (!error) {
        continue;
      }
      const note = page
        .getByRole("row")
        .filter({ hasText: name })
        .getByText(error.message, { exact: true });
      assert.equal(await note.getAttribute("title"), error.message);
    }
  }
});
