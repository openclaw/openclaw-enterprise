import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import type { RuntimeLogRecord, SandboxNetworkGrant } from "../../packages/contracts/src/index.ts";
import { createPolicyConsole } from "./console-sandbox-policy-fixture.ts";
import {
  apiRequests,
  detailUrl,
  login,
  newPage,
  pathRequests,
} from "./console-agents-browser-helpers.mjs";

const grants: SandboxNetworkGrant[] = ["one", "two", "three"].map((name) => ({
  id: `python-${name}`,
  binary: "/usr/bin/python3.11",
  host: `${name}.example.org`,
  ports: [{ from: 443, to: 443 }],
}));

function denial(grant: SandboxNetworkGrant, index: number): RuntimeLogRecord {
  return {
    type: "line",
    time: new Date(Date.UTC(2026, 9, 22, 10, 0, index)).toISOString(),
    stream: { source: "sandbox", sandbox: "browser-policy" },
    contentClass: "activity",
    kind: "sandbox",
    level: "warn",
    message: "Network request denied",
    decision: {
      decision: "denied",
      enforcement: "blocked",
      binary: grant.binary,
      host: grant.host,
      port: 443,
      reason: "Destination not allowed",
    },
  };
}

async function logWindow(
  page: Page,
  origin: string,
  agentPath: string,
  revisionId: string,
  records: RuntimeLogRecord[],
) {
  let followed = false;
  // Only the observed log input is simulated. Admission, saves, IAM checks, and application
  // requests below pass through the real controller with its in-memory storage and test Drivers.
  await page.route(
    `${origin}${agentPath}/deployments/${revisionId}/runtime/logs?*`,
    async (route) => {
      const next = new URL(route.request().url()).searchParams.has("cursor");
      const updates =
        next && !followed
          ? Array.from({ length: 12 }, (_, index) => denial(grants[1]!, 201 + index))
          : [];
      if (next) {
        followed = true;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          data: {
            revisionId,
            source: "sandbox",
            stream: { source: "sandbox", sandbox: "browser-policy" },
            records: next ? updates : records,
            cursor: "browser-policy-window",
            observedAt: new Date().toISOString(),
            withheld: 0,
            truncated: false,
          },
        },
      });
    },
  );
}

test("the Policy denials page controls policy editing and disabling preserves saved rules", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, grants);
  assert.equal(
    (await fixture.request("PUT", base, { body: { expectedVersion: 1, additions: [grants[0]] } }))
      .status,
    200,
  );
  assert.equal(
    (await fixture.request("PATCH", `${base}/editing`, { body: { enabled: false } })).status,
    200,
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, undefined, "policy"));
  const card = page.locator(".sandbox-network-card");
  // Editing can be enabled from the page before opening the rule-management dialog.
  const enable = card.getByRole("switch", { name: "Policy editing", checked: false });
  await enable.waitFor({ state: "visible", timeout: 3000 });
  await card.getByRole("button", { name: "View network limits", exact: true }).click();
  const limits = page.getByRole("dialog", { name: "Network limits", exact: true });
  await limits.getByText("Installation ceiling", { exact: true }).waitFor();
  await limits.getByText(grants[0]!.binary, { exact: true }).first().waitFor();
  assert.equal(await limits.getByRole("button", { name: "Add rule", exact: true }).count(), 0);
  await limits.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(
    await card
      .getByRole("button", { name: "View network limits", exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(await page.getByLabel("Select page", { exact: true }).isVisible(), false);
  await card.getByRole("button", { name: /^(Manage|View) rules$/ }).click();
  const dialog = page.getByRole("dialog", { name: /^(Manage|View) network rules$/ });
  assert.equal(await dialog.getByRole("switch", { name: "Policy editing" }).count(), 0);
  assert.equal(
    await dialog.getByRole("button", { name: "Add rule", exact: true }).isVisible(),
    false,
  );
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await enable.click();
  const disable = card.getByRole("switch", { name: "Policy editing", checked: true });
  await disable.waitFor();
  assert.equal((await fixture.request("GET", base)).data.editingEnabled, true);
  await card.getByRole("button", { name: /^(Manage|View) rules$/ }).click();
  assert.equal(
    await dialog.getByRole("button", { name: "Add rule", exact: true }).isEnabled(),
    true,
  );
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await disable.click();
  await enable.waitFor();
  const disabled = (await fixture.request("GET", base)).data;
  assert.equal(disabled.editingEnabled, false);
  assert.equal(disabled.policy.version, 2);
  assert.deepEqual(disabled.policy.additions, [grants[0]]);
  const reloadPolicy = page.waitForResponse(
    (response) => response.request().method() === "GET" && response.url() === fixture.origin + base,
  );
  await page.reload();
  const reloaded = await reloadPolicy;
  assert.equal(reloaded.status(), 200, await reloaded.text());
  await enable.waitFor();
  await card.getByRole("button", { name: /^(Manage|View) rules$/ }).click();
  assert.equal(
    await dialog.getByRole("button", { name: "Add rule", exact: true }).isVisible(),
    false,
  );
  await dialog.getByText("Agent-specific rules · 1", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();

  // A successful toggle followed by a failed read cannot establish the new editing state.
  // Drop the read response after the real controller answers; recover through an explicit read.
  await page.route(fixture.origin + base, async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.fulfill({
      status: 503,
      json: { error: { code: "SERVICE_UNAVAILABLE", message: "Policy read interrupted" } },
    });
  });
  await enable.click();
  await card.getByRole("alert").waitFor();
  const retry = card.getByRole("button", { name: "Retry policy read", exact: true });
  await retry.waitFor();
  assert.equal((await fixture.request("GET", base)).data.editingEnabled, true);
  assert.equal(await card.getByRole("switch", { name: "Policy editing" }).count(), 0);
  await page.unroute(fixture.origin + base);
  await retry.click();
  await disable.waitFor();
  await disable.click();
  await enable.waitFor();

  // Administration can be revoked after the page read. The real IAM refusal must remain
  // visible and focused on the page, with the saved editing setting unchanged.
  fixture.policy.restrictions.push({
    id: "deny-policy-editing-administration",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: agent.id,
    action: "administer",
    effect: "deny",
  });
  await enable.click();
  const alert = card.getByRole("alert");
  await alert.waitFor();
  assert.equal(await alert.evaluate((node) => node === document.activeElement), true);
  assert.equal((await fixture.request("GET", base)).data.editingEnabled, false);
});

test("denial selection spans pages, keeps the inspected window, and saves a deduplicated batch before application", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, grants);
  // An existing admitted rule must survive a batch: the API saves a complete desired policy.
  assert.equal(
    (await fixture.request("PUT", base, { body: { expectedVersion: 1, additions: [grants[0]] } }))
      .status,
    200,
  );
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const records = Array.from({ length: 200 }, (_, index) =>
    denial(grants[Math.floor(index / 2) % grants.length]!, index),
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  await logWindow(page, fixture.origin, agentPath, revision.id, records);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "policy"));
  const tab = page.locator(".sandbox-policy");
  await tab.getByText("200 in loaded window", { exact: true }).waitFor();
  assert.equal(await tab.locator(".sandbox-decision").count(), 5);
  await tab.getByLabel("Select page", { exact: true }).check();
  await tab.getByRole("button", { name: "Allow selected (5)", exact: true }).waitFor();
  await tab.getByRole("button", { name: "Next", exact: true }).click();
  await tab.locator(".sandbox-denial-select input").first().check();
  await tab.getByRole("button", { name: "Allow selected (6)", exact: true }).waitFor();
  assert.match(await tab.locator(".sandbox-selection-actions").innerText(), /5 outside this page/);

  // Polling must not replace rows, close their details, or change the explicit selection.
  await tab.getByRole("button", { name: "Show denial details", exact: true }).first().click();
  const inspected = await tab.locator(".sandbox-decisions").innerText();
  await tab.getByRole("checkbox", { name: "Follow policy denials", exact: true }).check();
  await tab.getByRole("button", { name: "12 new denials · Show newest", exact: true }).waitFor();
  assert.equal(await tab.locator(".sandbox-decisions").innerText(), inspected);
  assert.equal(await tab.locator(".sandbox-decision-details:visible").count(), 1);
  await tab.getByRole("checkbox", { name: "Follow policy denials", exact: true }).uncheck();

  await tab.getByRole("button", { name: "Allow selected (6)", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review policy changes", exact: true });
  await dialog.waitFor();
  await dialog.getByText("6 denials selected → 2 new rules", { exact: true }).waitFor();
  await dialog.getByText("How the selection becomes rules", { exact: true }).click();
  assert.match(await dialog.locator(".sandbox-selection-breakdown").innerText(), /already covered/);
  assert.equal(pathRequests(requests, "PUT", base).length, 0, "review cannot save or apply");
  const validations = pathRequests(requests, "POST", `${base}/validate`);
  assert.equal(validations.length, 1);
  const validationBody = validations[0]!.body;
  assert.ok(validationBody && typeof validationBody === "object" && "additions" in validationBody);
  const proposed = validationBody.additions;
  assert.ok(Array.isArray(proposed));
  assert.equal(
    proposed.length,
    3,
    "repeated denials and the saved grant must not create duplicate rules",
  );
  assert.deepEqual(proposed[0], grants[0]);
  await dialog
    .getByRole("button", { name: "Save and apply to current revision", exact: true })
    .click();
  await page
    .locator(".sandbox-network-card")
    .getByText(/Application to the current revision is pending/)
    .waitFor();
  const saved = (await fixture.request("GET", base)).data.policy;
  assert.equal(saved.version, 3);
  assert.equal(saved.additions.length, 3);
  assert.deepEqual(saved.additions[0], grants[0]);
  assert.equal(saved.application.state, "pending");
  assert.equal(saved.application.policyVersion, 3);
  assert.deepEqual(
    pathRequests(requests, "POST", `${base}/apply`).map(({ body }: { body: unknown }) => body),
    [{ expectedVersion: 3, revisionId: revision.id }],
  );
});

test("a policy batch outside the Installation ceiling retains its draft and does not save or apply", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t);
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 390, height: 844 } },
  });
  await logWindow(
    page,
    fixture.origin,
    `/namespaces/${namespace.id}/agents/${agent.id}`,
    revision.id,
    [denial(grants[1]!, 1), denial(grants[1]!, 2)],
  );
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "policy"));
  await page.getByText("2 in loaded window", { exact: true }).waitFor();
  // A fresh policy has no confirmed provider version and was never saved for later.
  await page
    .locator(".sandbox-policy-rule-status")
    .getByText("Application unconfirmed", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".sandbox-application-feedback").count(), 0);

  await page.getByLabel("Select page", { exact: true }).check();
  await page.getByRole("button", { name: "Allow selected (2)", exact: true }).click();
  // The real validate route rejects an undelegated addition. Its error stays visible inside
  // the modal and the single deduplicated proposal remains available for correction.
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Your proposal has not been saved or applied" });
  await alert.waitFor();
  assert.equal(await alert.evaluate((node) => node === document.activeElement), true);
  assert.equal(pathRequests(requests, "PUT", base).length, 0);
  assert.equal(pathRequests(requests, "POST", `${base}/apply`).length, 0);
  const saved = (await fixture.request("GET", base)).data.policy;
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.additions, []);
  await page.getByLabel("Actions for network rule 1", { exact: true }).click();
  await page.getByRole("button", { name: "Edit rule", exact: true }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "Destination hostname", exact: true }).inputValue(),
    grants[1]!.host,
  );
});

test("unconfirmed application requires status inspection before an explicit retry and displays retry refusal", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, grants);
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  assert.equal(
    (
      await fixture.request("POST", `${base}/apply`, {
        body: { expectedVersion: 1, revisionId: revision.id },
      })
    ).status,
    202,
  );
  const { page } = await newPage(t, fixture);
  // Simulate only the observed failed status: this fixture has no worker. The retry still
  // reaches real HTTP/IAM/admission, which refuses the actually pending application.
  await page.route(fixture.origin + base, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.policy.application.state = "failed";
    payload.data.policy.application.reason = "SANDBOX_POLICY_UNCONFIRMED";
    // A failed application re-enables the public action hints; preserve a coherent view.
    for (const action of ["validate", "save", "apply"]) {
      payload.data.configuration.actions[action].available = true;
    }
    await route.fulfill({ response, json: payload });
  });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "policy"));
  const card = page.locator(".sandbox-network-card");
  const outcome = card.locator(".sandbox-application-feedback");
  await outcome.getByRole("heading", { name: "Application unconfirmed", exact: true }).waitFor();
  assert.equal(
    await card.getByRole("button", { name: "Retry application", exact: true }).count(),
    0,
  );
  await outcome.getByRole("button", { name: "Refresh status", exact: true }).click();
  await outcome.getByRole("button", { name: "Retry application", exact: true }).waitFor();
  assert.equal(
    pathRequests(requests, "POST", `${base}/apply`).length,
    0,
    "refresh must never request application",
  );
  await outcome.getByRole("button", { name: "Retry application", exact: true }).click();
  await card
    .getByRole("alert")
    .filter({ hasText: "A policy application is already pending." })
    .waitFor();
  assert.equal(pathRequests(requests, "POST", `${base}/apply`).length, 1);
  assert.equal((await fixture.request("GET", base)).data.policy.application.state, "pending");
});
