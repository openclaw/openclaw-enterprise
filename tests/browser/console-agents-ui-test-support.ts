import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { Check } from "typebox/value";
import { AgentResponse, SecretResponse } from "../../packages/contracts/src/api/resources.ts";
import type { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createFixtureResponse } from "../helpers/console-fixture-response.ts";
import { settledFetches, waitForIdleFetches } from "./console-fetch-accounting.ts";

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;

export async function openCreateSecretDialog(
  scope: Page | Locator,
  label: string,
  options: { query?: string } = {},
) {
  const field = scope.getByLabel(label, { exact: true });
  await field.fill(options.query ?? "Create a new Secret");
  await scope.getByRole("option", { name: "Create new Secret...", exact: true }).click();
}

export async function createModelCredentialSecret(page: Page, secretValue: string) {
  // Preset quick-start reads the installed template before rendering its credential fields.
  await page.locator("#create-agent-form").waitFor();
  const picker = page.locator("#provider-credential-secret");
  if ((await picker.count()) === 0 || !(await picker.isVisible())) {
    const legacyCredential = page.getByLabel("API key", { exact: true });
    await legacyCredential.fill(secretValue);
    await legacyCredential.press("Tab");
    return null;
  }
  const created = page.waitForResponse((response) => {
    if (response.request().method() !== "POST" || !response.url().includes("/secrets")) {
      return false;
    }
    const body: unknown = response.request().postDataJSON();
    return (
      typeof body === "object" && body !== null && "value" in body && body.value === secretValue
    );
  });
  await picker.fill("Create a new Secret");
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create model credential Secret" });
  await dialog.getByLabel("Value", { exact: true }).fill(secretValue);
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const response = await created;
  assert.equal(response.status(), 201, "Create Secret: unexpected HTTP status");
  const body: unknown = await response.json();
  if (!Check(SecretResponse, body)) {
    throw new Error("Create Secret: invalid response envelope");
  }
  return body.data;
}

export async function enterManualModel(page: Page, apiKey: string, modelId = "gpt-4.1") {
  const secret = await createModelCredentialSecret(page, apiKey);
  const model = page.getByLabel("Model ID", { exact: true });
  if (!(await model.isVisible())) {
    await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  }
  await model.fill(modelId);
  await model.press("Tab");
  return secret;
}

// Selects Create Agent and returns the API's answer to the form's POST to `path` in the
// Namespace: "agents" (an embedded Agent) by default, or "agents/provision" or
// "agents/validate". With `status`, that answer must have it.
export async function submitCreateAgent(
  page: Page,
  fixture: Pick<ConsoleFixture, "origin">,
  namespaceId: string,
  { path = "agents", status }: { path?: string; status?: number } = {},
) {
  const url = `${fixture.origin}/namespaces/${namespaceId}/${path}`;
  const answer = page.waitForResponse(
    (response) => response.url() === url && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await answer;
  if (status !== undefined) {
    assert.equal(response.status(), status, `POST ${path}: ${await response.text()}`);
  }
  return response;
}

// Selects Create Agent, which must create the Agent (201), and returns the created Agent.
export async function createAgentThroughForm(
  page: Page,
  fixture: Pick<ConsoleFixture, "origin" | "app">,
  namespaceId: string,
) {
  const response = await submitCreateAgent(page, fixture, namespaceId, { status: 201 });
  const body: unknown = await response.json();
  return createFixtureResponse(fixture.app.getSchemas())(
    { status: response.status(), body },
    201,
    AgentResponse,
    "Create Agent",
  ).data;
}

export async function openAdvancedSettings(page: Page) {
  const summary = page.locator(".launch-advanced:not([open]) > summary");
  if (await summary.count()) {
    await summary.click();
  }
}

// Create Agent's access slot above the form. A refused Installation read's answer is one status
// block there, never the grey hint under the fields (finding 2092): its text appears once on the
// page. `retry` says whether the block offers Retry permission check as its action.
export async function expectCreateAccess(
  page: Page,
  { tone, body, retry = false }: { tone: string; body: string; retry?: boolean },
) {
  const access = page.locator("#create-agent-access");
  await access.locator(".status-body").getByText(body, { exact: true }).waitFor();
  assert.deepEqual(
    await access.evaluate((node) => ({
      role: node.getAttribute("role"),
      tone: node.getAttribute("data-tone"),
      label: node.querySelector(".status-label")?.textContent,
      body: [...node.querySelectorAll(".status-body")].map((line) => line.textContent),
      next: node.nextElementSibling?.id,
    })),
    {
      role: tone === "info" ? "status" : "alert",
      tone,
      label: "Your access",
      body: [body],
      next: "create-agent-form",
    },
  );
  assert.equal(await page.getByText(body, { exact: true }).count(), 1);
  assert.equal(
    await access.getByRole("button", { name: "Retry permission check", exact: true }).isVisible(),
    retry,
  );
  // The capability retry under the fields never stands in for the permission retry.
  assert.equal(
    await page.getByRole("button", { name: "Retry capability check", exact: true }).count(),
    0,
  );
  return access;
}

// Create Agent with a permission answer that refuses Agent create: the refusal takes the form's
// place, with no start choices and no access block, whether the page loaded with that answer or a
// permission retry brought it (findings 1521, 2908). Returns the refusal.
export async function expectCreateRefused(page: Page, body: string) {
  const refusal = page.locator(".state-panel").filter({
    has: page.getByRole("heading", { name: "Creating Agents is not available", exact: true }),
  });
  await refusal.waitFor();
  assert.deepEqual(
    await refusal.evaluate((node) => ({
      status: [...node.querySelectorAll('[role="status"]')].map((line) => line.textContent),
      form: node.ownerDocument.querySelectorAll("#create-agent-form").length,
      access: node.ownerDocument.querySelectorAll("#create-agent-access").length,
    })),
    { status: [body], form: 0, access: 0 },
  );
  assert.equal(await page.getByRole("button", { name: /^Start (with|without) / }).count(), 0);
  return refusal;
}

// Create Agent stays disabled while the form reads Installation capabilities and repository
// choices. Waits until the live form has both; a retained preview of an earlier form is inert
// and shows that form's settled reads. A capability retry keeps the failure text until it ends.
export async function waitForCreateFormReads(page: Page) {
  await page.waitForFunction(() => {
    const form = globalThis.document.querySelector("#create-agent-form");
    return (
      form !== null &&
      form.closest("[inert]") === null &&
      form.querySelector('.repository-options[aria-busy="false"]') !== null &&
      ![...form.querySelectorAll('[role="status"]')].some(
        (node) => node.textContent === "Checking installation capabilities…",
      )
    );
  });
}

// A failed provisioning job's reason is the form's one error line; the status line under it
// does not repeat that provisioning failed (finding 2423).
export async function waitForProvisioningFailure(page: Page) {
  await page.locator("#create-agent-form ~ p[role=alert]").filter({ hasText: /\S/ }).waitFor();
  assert.equal(await page.getByText("Provisioning failed.", { exact: true }).count(), 0);
  // The error line is as wide as the form above it, not the page.
  const { form, error } = await page.evaluate(() => {
    const form = globalThis.document.querySelector("#create-agent-form");
    const error = globalThis.document.querySelector("#create-agent-form ~ p[role=alert]");
    if (form === null || error === null) {
      throw new Error("Expected the Create Agent form and provisioning error");
    }
    return {
      form: form.getBoundingClientRect().width,
      error: error.getBoundingClientRect().width,
    };
  });
  assert.ok(error <= form + 0.5, `error line ${error}px, form ${form}px`);
}

// Create Agent rereads an accepted provisioning job once a second (waitForProvisioning in
// create.mts). This runs `submit` (the click that sends or retries the job) with the page clock
// paused, then runs that clock one second at a time, each step only once no fetch is in flight,
// until the page has read `jobPath` `reads` times in all. The clock then runs in real time again.
// So the test skips each one-second wait, and the page still handles each answer, and the
// optional deployment read between polls, before the next poll. Call trackSettledFetches before
// the page loads.
const pollClocks = new WeakSet<Page>();

export async function runProvisioningPolls(
  page: Page,
  submit: () => Promise<unknown>,
  jobPath: string,
  reads: number,
) {
  if (!pollClocks.has(page)) {
    await page.clock.install();
    pollClocks.add(page);
  }
  // The clock runs between calls, so pause it a little ahead of the page's time. On a loaded host
  // it can pass that time before pauseAt arrives, which pauseAt refuses: read the time again.
  for (let attempt = 1; ; attempt += 1) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + 100);
      break;
    } catch (error) {
      if (attempt === 5 || !String(error).includes("Cannot fast-forward to the past")) {
        throw error;
      }
    }
  }
  await submit();
  for (let polls = 0; ; polls += 1) {
    await waitForIdleFetches(page);
    if ((await settledFetches(page, jobPath)) >= reads) {
      break;
    }
    assert.ok(polls < 10, `the page read ${jobPath} ${reads} times`);
    await page.clock.runFor(1_000);
  }
  await page.clock.resume();
}

/**
 * Asserts that the Agent name field shows the API's duplicate-name refusal under it and holds
 * focus (finding 2420).
 */
export async function assertAgentNameTaken(page: Page) {
  const name = page.getByLabel("Agent name", { exact: true });
  await page.waitForFunction(() => {
    const input = globalThis.document.querySelector("#agent-name");
    return (
      input?.getAttribute("aria-invalid") === "true" && globalThis.document.activeElement === input
    );
  });
  const describedBy = (await name.getAttribute("aria-describedby")) ?? "";
  const errors = await Promise.all(
    describedBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => page.locator(`[id="${id}"]`).textContent()),
  );
  assert.ok(
    errors.includes("Another Agent in this Namespace has this name."),
    `expected the duplicate-name error under the field, got ${JSON.stringify(errors)}`,
  );
}

export async function optionValues(locator: Locator) {
  return locator.evaluate((element) => {
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Expected a select element");
    }
    return Array.from(element.options).map((option) => ({
      value: option.value,
      text: option.textContent,
    }));
  });
}

export const focusedText = (page: Page) =>
  page.evaluate(() => globalThis.document.activeElement?.textContent ?? null);

// The saved status a focused control is described by, so a screen reader names it.
export const focusedDescription = (page: Page) =>
  page.evaluate(() => {
    const id = globalThis.document.activeElement?.getAttribute("aria-describedby");
    return id ? globalThis.document.getElementById(id)?.textContent : null;
  });

// Owned by watchForReload in the browser page, including its observer callback.
declare global {
  var reloadedText: (string | null)[] | undefined;
}

// A button the reader can press: an unavailable one is natively disabled, or aria-disabled
// while a visible reason says why (finding 2878).
export const LIVE_BUTTON = 'button:not([disabled], [aria-disabled="true"])';

// Back, in-app navigation and reloads can first restore an inert copy of the old view with its
// controls disabled, until revalidation re-enables it or replaces it with a rebuilt view. Only a
// live control shows the current view, including any draft it restored.
export async function waitForLiveControls(page: Page, ids: readonly string[]) {
  await page.waitForFunction(
    (controlIds) =>
      controlIds.every((id) => {
        const control = globalThis.document.getElementById(id);
        return (
          control &&
          !("disabled" in control && control.disabled) &&
          control.getAttribute("aria-disabled") !== "true" &&
          !control.closest("[inert]")
        );
      }),
    ids,
  );
}

// Marks the rendered Agent page and records any loading state it shows again, so a test can
// tell an in-place update from a page reload.
export async function watchForReload(page: Page) {
  await page.evaluate(() => {
    const doc = globalThis.document;
    const summary = doc.querySelector(".agent-current-summary");
    if (!(summary instanceof HTMLElement)) {
      throw new Error("Expected the rendered Agent summary");
    }
    summary.dataset.saveMarker = "kept";
    globalThis.reloadedText = [];
    new globalThis.MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (/Loading (version details|configuration)/.test(node.textContent ?? "")) {
            const reloadedText = globalThis.reloadedText;
            if (reloadedText === undefined) {
              throw new Error("Expected the reload observer's text collection");
            }
            reloadedText.push(node.textContent);
          }
        }
      }
    }).observe(doc.body, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(() => {
      const summary = globalThis.document.querySelector(".agent-current-summary");
      return {
        marker: summary instanceof HTMLElement ? summary.dataset.saveMarker : undefined,
        reloadedText: globalThis.reloadedText,
      };
    });
}
