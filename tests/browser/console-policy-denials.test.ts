import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Page } from "playwright";
import type { RuntimeLogRecord, SandboxNetworkGrant } from "../../packages/contracts/src/index.ts";
import { createPolicyConsole } from "./console-sandbox-policy-fixture.ts";
import {
  callerDenied,
  DEPLOY_SANDBOX_POLICY_READ_DENIED,
  PLACEHOLDER_DESTINATION,
} from "../helpers/refusal-text.mjs";
import { openShellSandboxRecords } from "../helpers/runtime-logs.mjs";

import {
  apiRequests,
  detailUrl,
  focusKeptOverClose,
  hasFocus,
  login,
  newPage,
  nextFrames,
  pathRequests,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";
import { restrict } from "../helpers/iam-grants.mjs";

const grants: SandboxNetworkGrant[] = ["one", "two", "three"].map((name) => ({
  id: `python-${name}`,
  binary: "/usr/bin/python3.11",
  host: `${name}.example.org`,
  ports: [{ from: 443, to: 443 }],
}));

function denial(grant: SandboxNetworkGrant, index: number, port = 443): RuntimeLogRecord {
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
      port,
      reason: "Destination not allowed",
    },
  };
}

// The status lines of the collapsed Policy details, after the Installation defaults.
function policyDetailLines(page: Page) {
  return page
    .locator(".sandbox-policy-versions > p.hint")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent));
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
  const viewLimits = card.getByRole("button", { name: "View network limits", exact: true });
  assert.equal(await hasFocus(viewLimits), true);
  // Focus the reader moves on before the close event fires stays where they put it.
  const tab = page.getByRole("tab", { selected: true });
  await viewLimits.click();
  assert.equal(
    await focusKeptOverClose(limits.getByRole("button", { name: "Done", exact: true }), tab),
    true,
    "closing Network limits keeps focus on the tab",
  );
  assert.equal(await page.getByLabel("Select page", { exact: true }).isVisible(), false);
  const manage = card.getByRole("button", { name: /^(Manage|View) rules$/ });
  await manage.click();
  const dialog = page.getByRole("dialog", { name: /^(Manage|View) network rules$/ });
  assert.equal(await dialog.getByRole("switch", { name: "Policy editing" }).count(), 0);
  assert.equal(
    await dialog.getByRole("button", { name: "Add rule", exact: true }).isVisible(),
    false,
  );
  // Closing redraws the policy card, which moves its rules button, yet focus returns to it.
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await hasFocus(manage), true);
  await manage.click();
  assert.equal(
    await focusKeptOverClose(dialog.getByRole("button", { name: "Done", exact: true }), tab),
    true,
    "closing the rules dialog keeps focus on the tab",
  );
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
  restrict(fixture.policy, "administer", "agent", {
    namespaceId: namespace.id,
    resourceId: agent.id,
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
  // Refresh denials replaces the window, so a selection of the old records must not survive it:
  // Allow selected would otherwise stage denials that are no longer displayed.
  await tab.getByLabel("Select page", { exact: true }).check();
  await tab.getByRole("button", { name: "Allow selected (5)", exact: true }).waitFor();
  const refreshed = page.waitForResponse(
    (response) =>
      response
        .url()
        .startsWith(`${fixture.origin}${agentPath}/deployments/${revision.id}/runtime/logs?`) &&
      !new URL(response.url()).searchParams.has("cursor"),
  );
  await tab.getByRole("button", { name: "Refresh denials", exact: true }).click();
  await refreshed;
  await nextFrames(page);
  assert.equal(await tab.locator(".sandbox-selection-actions").isVisible(), false);
  assert.equal(await tab.getByRole("button", { name: /^Allow selected/ }).count(), 0);
  assert.equal(await tab.getByLabel(/^Select page/).isChecked(), false);
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

test("Allow this opens the editor at its new rule and a covered suggestion adds none", async (t) => {
  // The saved rule allows one.example.org on 443 only; the ceiling also delegates 8443.
  const alternatePort: SandboxNetworkGrant = {
    ...grants[0]!,
    id: "python-one-alternate",
    ports: [{ from: 8443, to: 8443 }],
  };
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, [
    ...grants,
    alternatePort,
  ]);
  assert.equal(
    (await fixture.request("PUT", base, { body: { expectedVersion: 1, additions: [grants[0]] } }))
      .status,
    200,
  );
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  await logWindow(page, fixture.origin, agentPath, revision.id, [
    denial(grants[0]!, 1),
    denial(grants[0]!, 2, 8443),
  ]);
  // Like the log window, only the provider's observed suggestion is simulated: it repeats the
  // saved rule, so reviewing it must not propose another.
  await page.route(
    `${fixture.origin}${agentPath}/revisions/${revision.id}/sandbox-policy/networking/recommendations`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          data: {
            recommendations: [
              { id: "suggested-one", status: "pending", grant: grants[0], observations: 2 },
            ],
            truncated: false,
          },
        },
      }),
  );
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "policy"));
  const tab = page.locator(".sandbox-policy");
  await tab.getByText("2 in loaded window", { exact: true }).waitFor();
  // Policy v2 was saved before the deploy, so the running version enforces it: nothing is saved
  // for later (D773).
  await page
    .locator(".sandbox-policy-rule-status")
    .getByText("Deployed", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".sandbox-application-feedback").count(), 0);

  // A denial on a second port of an allowed host is not covered: Allow this opens the editor
  // at the new rule (index 1, port 8443), not at the saved rule for the same host.
  await tab
    .locator(".sandbox-decision", { hasText: `${grants[0]!.host}:8443` })
    .getByRole("button", { name: "Allow this", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit network rule", exact: true });
  await dialog.getByText(/^Rules added to your proposal\./).waitFor();
  assert.equal(
    await dialog.getByRole("textbox", { name: "Destination hostname", exact: true }).inputValue(),
    grants[0]!.host,
  );
  assert.equal(await dialog.getByLabel("Start port", { exact: true }).inputValue(), "8443");
  assert.equal(pathRequests(requests, "POST", `${base}/validate`).length, 0, "prefill only");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review policy changes", exact: true });
  await review.getByText("Rules to add or update · 1", { exact: true }).waitFor();
  await review.getByRole("button", { name: "Save for later", exact: true }).click();
  await page.getByText(/Policy v3 saved\./).waitFor();
  const saved = (await fixture.request("GET", base)).data.policy;
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.additions[0], grants[0]);
  assert.deepEqual(
    saved.additions.slice(1).map(({ binary, host, ports }: SandboxNetworkGrant) => ({
      binary,
      host,
      ports,
    })),
    [{ binary: alternatePort.binary, host: alternatePort.host, ports: alternatePort.ports }],
  );
  // Saving closes the dialog.
  await review.waitFor({ state: "hidden" });

  // The suggestion repeats a saved rule: the rules list opens unchanged with the covered
  // feedback, nothing is validated or saved, and closing returns focus to the suggestion.
  const suggestion = tab.getByRole("button", { name: "Review suggestion", exact: true });
  await suggestion.click();
  const rules = page.getByRole("dialog", { name: "Manage network rules", exact: true });
  await rules
    .getByText(/^These requests are already covered by saved or proposed rules\./)
    .waitFor();
  await rules.getByText("Agent-specific rules · 2", { exact: true }).waitFor();
  await rules.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await suggestion.evaluate((node) => node === document.activeElement), true);
  assert.equal(pathRequests(requests, "POST", `${base}/validate`).length, 1);
  assert.equal(pathRequests(requests, "PUT", base).length, 1);
  assert.equal((await fixture.request("GET", base)).data.policy.version, 3);
});

test("OpenShell placeholder denials show and propose the mapped hostname, never the placeholder", async (t) => {
  // D771/D772 (dogfood-r52): records come from the captured OpenShell lines through the
  // Driver's parser and OCC's sanitizer. A second port of a host that has a rule is denied
  // with the placeholder address its policy DNS answered; the record before it names the host.
  const host = "fake-model.oce-r52-fake.svc.cluster.local";
  const python = "/usr/bin/python3.11";
  const reachable: SandboxNetworkGrant = {
    id: "fake-model-ports",
    binary: python,
    host,
    ports: [{ from: 8083, to: 8084 }],
  };
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, [reachable]);
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { lines } = JSON.parse(
    readFileSync(
      new URL(
        "../fixtures/runtime-logs/replay/sandbox-openshell-placeholder-denials.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { lines: { time: string; message: string }[] };
  const mapped = lines.findIndex(({ message }) => message.includes("-> 198.18.0.2:8083 "));
  const refusal = lines.findIndex(({ message }) => message.startsWith("NET:REFUSE"));
  const records = [
    // The mapping record and the denial it resolves, then the DNS refusal and its observation.
    ...openShellSandboxRecords(lines.slice(mapped - 2, mapped + 1)),
    ...openShellSandboxRecords(lines.slice(refusal, refusal + 2)),
    // A placeholder whose mapping record is not in the read names no host.
    ...openShellSandboxRecords([
      {
        ...lines[mapped]!,
        time: "2026-10-26T20:48:00.000000000Z",
        message:
          "NET:OPEN [MED] DENIED /usr/bin/python3.11(0) -> 198.18.0.4:8084 [reason:transparent_tcp_mapping_denied]",
      },
    ]),
    // A record that carries the placeholder as its host is still not proposed.
    denial({ ...reachable, host: "198.19.0.9" }, 1, 8084),
  ];
  const { page } = await newPage(t, fixture);
  await logWindow(
    page,
    fixture.origin,
    `/namespaces/${namespace.id}/agents/${agent.id}`,
    revision.id,
    records,
  );
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "policy"));
  const tab = page.locator(".sandbox-policy");
  await tab.getByText("4 in loaded window", { exact: true }).waitFor();
  // Newest first. A DNS refusal names its host and no executable.
  assert.deepEqual(await tab.locator(".sandbox-denial-binary").allInnerTexts(), [
    "python3.11",
    "python3.11",
    "DNS lookup",
    "python3.11",
  ]);
  assert.deepEqual(await tab.locator(".sandbox-denial-destination").allInnerTexts(), [
    "Hostname not logged · 198.19.0.9:8084",
    "Hostname not logged · 198.18.0.4:8084",
    "example.com",
    `${host}:8083`,
  ]);
  // Only the mapped denial can become a rule: the placeholders and the refusal propose none.
  await tab.getByText("Select page (1)", { exact: true }).waitFor();
  for (const address of ["198.19.0.9", "198.18.0.4"]) {
    const row = tab.locator(".sandbox-decision", { hasText: address });
    assert.equal(await row.getByRole("button", { name: "Allow this", exact: true }).count(), 0);
    assert.equal(await row.locator(".sandbox-denial-select input").isDisabled(), true);
  }
  const unmapped = tab.locator(".sandbox-decision", { hasText: "198.18.0.4" });
  await unmapped.getByRole("button", { name: "Show denial details", exact: true }).click();
  await unmapped.getByText(PLACEHOLDER_DESTINATION, { exact: true }).waitFor();

  await tab
    .locator(".sandbox-decision", { hasText: `${host}:8083` })
    .getByRole("button", { name: "Allow this", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit network rule", exact: true });
  await dialog.getByText(/^Rules added to your proposal\./).waitFor();
  assert.equal(
    await dialog.getByRole("textbox", { name: "Destination hostname", exact: true }).inputValue(),
    host,
  );
  assert.equal(await dialog.getByLabel("Start port", { exact: true }).inputValue(), "8083");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  // The real validate route admits the hostname inside the ceiling.
  const review = page.getByRole("dialog", { name: "Review policy changes", exact: true });
  await review.getByText("Rules to add or update · 1", { exact: true }).waitFor();
  const validations = pathRequests(requests, "POST", `${base}/validate`);
  assert.equal(validations.length, 1);
  const { additions } = validations[0]!.body as { additions: SandboxNetworkGrant[] };
  assert.deepEqual(
    additions.map((grant) => [grant.binary, grant.host, grant.ports]),
    [[python, host, [{ from: 8083, to: 8083 }]]],
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
  // A fresh deploy carries policy v1 into its Sandbox, and no live change was requested: the
  // card says so instead of "Application unconfirmed" (D773).
  const view = (await fixture.request("GET", base)).data;
  assert.deepEqual(
    [view.defaultsRevisionId, view.deployedPolicyVersion, view.policy.application],
    [revision.id, 1, undefined],
  );
  await page
    .locator(".sandbox-policy-rule-status")
    .getByText("Deployed", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator(".sandbox-policy-versions")
      .getByText("Deployed with policy v1; no live change requested.", { exact: true })
      .count(),
    1,
  );
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
  // The failed apply sent the deployed v1 again. A requested application keeps its own status:
  // Policy details does not say that no live change was requested (D773).
  assert.deepEqual(await policyDetailLines(page), [
    `Application: failed · Revision ${revision.id} · SANDBOX_POLICY_UNCONFIRMED`,
    "Saved version: v1",
    "Live version unconfirmed",
  ]);
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

// D773 says "Deployed" only for the running version deployed with the saved policy and with no
// live application requested for it. An older version's tab and a pending apply of the same
// version keep the unconfirmed and applying states.
test("an older version and a same-version apply do not claim the deployed policy", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t);
  const { revision: older } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id, older.id);
  const view = (await fixture.request("GET", base)).data;
  assert.deepEqual(
    [view.defaultsRevisionId, view.deployedPolicyVersion, view.policy.version],
    [revision.id, 1, 1],
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, older.id, "policy"));
  const status = page.locator(".sandbox-policy-rule-status").getByRole("status");
  await status.getByText("Application unconfirmed", { exact: true }).waitFor();
  assert.deepEqual(await policyDetailLines(page), [
    "Saved version: v1",
    "Live version unconfirmed",
  ]);

  // A pending live application of the deployed v1 to the running version.
  assert.equal(
    (
      await fixture.request("POST", `${base}/apply`, {
        body: { expectedVersion: 1, revisionId: revision.id },
      })
    ).status,
    202,
  );
  await page.goto(detailUrl(fixture, namespace.id, agent.id, revision.id, "policy").href);
  await status.getByText("Applying…", { exact: true }).waitFor();
  assert.deepEqual(await policyDetailLines(page), [
    `Application: pending · Revision ${revision.id}`,
    "Saved version: v1",
    "Live version unconfirmed",
  ]);
});

// Finding 2874: live application also needs SandboxPolicy read, since it admits and returns the
// saved rules. A read revoked after the page loaded is refused by the real API, and the refusal
// names every grant apply checks, not only the ones a save checks.
test("an application refused for a revoked SandboxPolicy read names the read grant", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, grants);
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  assert.equal(
    (await fixture.request("PUT", base, { body: { expectedVersion: 1, additions: [grants[0]] } }))
      .status,
    200,
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "policy"));
  const card = page.locator(".sandbox-network-card");
  const apply = card.getByRole("button", { name: "Apply saved rules", exact: true });
  await apply.waitFor();
  restrict(fixture.policy, "read", "sandbox_policy", { namespaceId: namespace.id });
  await apply.click();
  await card
    .getByRole("alert")
    .filter({
      hasText:
        "Your access does not include applying this Agent’s policy. Ask an Installation administrator for Agent manage_policy and SandboxPolicy update and read on it.",
    })
    .waitFor();
  assert.equal(pathRequests(requests, "POST", `${base}/apply`).length, 1);
  fixture.policy.restrictions.pop();
  assert.equal((await fixture.request("GET", base)).data.policy.application, undefined);
});

// Finding D801. Deploy checks SandboxPolicy read on the Agent's network policy when it has saved
// rules (finding 2151). The API's denial names that policy by its raw ID; the Deploy alert names
// it in words and who grants the read. The permission answer cannot tell whether saved rules
// exist, so Deploy stays enabled up front and the API decides.
test("a deploy refused for SandboxPolicy read names the network policy in words", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, grants);
  assert.equal(
    (await fixture.request("PUT", base, { body: { expectedVersion: 1, additions: [grants[0]] } }))
      .status,
    200,
  );
  restrict(fixture.policy, "read", "sandbox_policy", { namespaceId: namespace.id });
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const deploy = page.getByRole("button", { name: "Deploy new version", exact: true });
  await waitForEnabled(deploy);
  const refused = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${path}/deploy` &&
      response.request().method() === "POST",
  );
  await deploy.click();
  const response = await refused;
  assert.equal(response.status(), 403);
  const policyId = `sbp_${agent.id.slice(4)}`;
  assert.equal(
    (await response.json()).error.message,
    callerDenied("SandboxPolicy read", `SandboxPolicy ${policyId}`),
  );
  const alert = page.getByRole("alert").filter({ hasText: DEPLOY_SANDBOX_POLICY_READ_DENIED });
  await alert.waitFor();
  assert.equal(await alert.textContent(), DEPLOY_SANDBOX_POLICY_READ_DENIED);
  assert.equal(await page.locator("main").getByText(policyId).count(), 0);
  // Nothing was admitted, so Deploy is available again once the read is granted.
  await waitForEnabled(deploy);
  assert.equal((await fixture.request("GET", `${path}/revisions`)).data.length, 0);
});
