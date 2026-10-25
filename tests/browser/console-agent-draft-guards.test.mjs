import assert from "node:assert/strict";
import test from "node:test";
import { NAMESPACE_NOT_READY_MESSAGE } from "../../apps/controller/src/console/agents/list.mts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture, backendFixtures } from "../helpers/console-app.mjs";
import { createConsoleRepositoryLaunchFixture } from "../helpers/console-repository-launch.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  accessBindingPostRequests,
  apiRequests,
  detailUrl,
  hasFocus,
  holdRequests,
  login,
  loginThroughForm,
  nativeValues,
  newPage,
  pathRequests,
  recordFocusTrail,
  repositoryCheckbox,
  routeFailedDeployment,
  secretOptionLabel,
  selectSecret,
  setSlackSelection,
  settlePageRequests,
  stopFocusTrail,
  waitForCondition,
  waitForEnabled,
  waitForInputValue,
  writeRequests,
} from "./console-agents-browser-helpers.mjs";
import {
  createRepositoryLaunchFixture,
  focusedDescription,
  focusedText,
  withholdPermissionSummary,
} from "./console-agents-test-support.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import { createPolicyConsole } from "./console-sandbox-policy-fixture.ts";
import {
  AGENT_SAVE_DENIED,
  CHANNEL_SECRETS_CONFIGURATION_CHANGED,
  CONFIGURATION_SAVE_DENIED,
  DEPENDENCY_UNAVAILABLE,
  GENERIC_DENIAL,
  NAMESPACE_NOT_READY,
  READ_UNAVAILABLE,
  REPOSITORY_EDITS_PENDING,
  RESOURCE_CONFLICT,
} from "../helpers/refusal-text.mjs";

test("Agent policy ceiling rejection is announced in view and preserves unsaved additions", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t);
  // No operator ceiling delegates access. The actual OCC admission path must reject the preview;
  // no response interception or provider behavior is substituted for that decision.
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 1440, height: 600 } },
  });
  // Through the sign-in form: a cold deep link to a draft's tab keeps its Namespace, revision
  // and tab across password sign-in.
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "policy");
  await loginThroughForm(page, fixture, url);
  await page.waitForURL(url.href);
  const requests = apiRequests(page, fixture.origin);
  await page.getByRole("button", { name: "Add Network rules", exact: true }).click();
  await page.getByRole("button", { name: "Remove Network rules 1", exact: true }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "Executable path", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Add Network rules", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Executable path", exact: true })
    .fill("/usr/bin/python3.11");
  await page
    .getByRole("textbox", { name: "Destination hostname", exact: true })
    .fill("outside.example.org");
  await page.getByRole("textbox", { name: "Rule ID", exact: true }).fill("outside");
  await page.getByRole("button", { name: "Add Port ranges", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Start port", exact: true }).fill("443");
  await page.getByRole("spinbutton", { name: "End port", exact: true }).fill("443");
  const rejected = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith(`${base}/validate`),
  );
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  assert.equal(pathRequests(requests, "PUT", base).length, 0, "proposing rules does not save");
  assert.equal(pathRequests(requests, "POST", `${base}/apply`).length, 0);
  assert.equal((await rejected).status(), 200);
  const message = "Review the configuration errors. Your proposal has not been saved or applied.";
  const alert = page.getByText(message, { exact: true });
  await alert.waitFor();
  const displayed = await alert.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return {
      inView: bounds.top >= 0 && bounds.bottom <= globalThis.innerHeight,
      focused: globalThis.document.activeElement === node,
      role: node.getAttribute("role"),
    };
  });
  assert.equal(
    displayed.inView,
    true,
    "a rejected preview must show its reason without manual scrolling",
  );
  assert.equal(displayed.role, "alert");
  assert.equal(displayed.focused, true);
  assert.equal(
    await page.getByRole("textbox", { name: "Destination hostname", exact: true }).inputValue(),
    "outside.example.org",
  );
  const unchanged = await fixture.request("GET", base);
  assert.equal(unchanged.data.policy.version, 1);
  assert.deepEqual(unchanged.data.policy.additions, []);
});

// Without a Sandbox Driver that supports per-Agent network policy there is no Sandbox log source
// and no suggestions. The tab read both, showed their refusals and a full editor (finding 2060).
test("Policy denials says once that the Sandbox Driver lacks per-Agent network policy", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("No policy driver", { ready: true });
  const created = await fixture.createAgent(
    namespace.id,
    "No policy driver",
    createHarnessConfiguration("codex", "gpt-5.1"),
    { executionMode: "dedicated" },
  );
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, created.id);
  const base = `/namespaces/${namespace.id}/agents/${created.id}/sandbox-policy/networking`;
  // The real API answers the policy read with no capability.
  assert.equal((await fixture.request("GET", base)).data.capability, null);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, created.id, revision.id, "policy"));
  const tab = page.locator(".sandbox-policy");
  await tab
    .getByRole("status")
    .filter({ hasText: "This Sandbox Driver does not support per-Agent network policy." })
    .waitFor();
  assert.equal(await page.getByText("does not support per-Agent network policy").count(), 1);
  for (const name of [
    "Enable policy editing",
    "Refresh denials",
    "Refresh suggestions",
    "Refresh policy",
    "Add proposed rule",
  ]) {
    assert.equal(await tab.getByRole("button", { name }).count(), 0, name);
  }
  assert.equal(await tab.getByRole("alert").count(), 0);
  // Neither unavailable read is made.
  assert.deepEqual(
    requests
      .map(({ path }) => path)
      .filter((path) => path.includes("/runtime/logs") || path.endsWith("/recommendations")),
    [],
  );
  // The draft tab reads neither, but says the same instead of offering the editor.
  await page.goto(detailUrl(fixture, namespace.id, created.id, "draft", "policy").href);
  await tab
    .getByRole("status")
    .filter({ hasText: "This Sandbox Driver does not support per-Agent network policy." })
    .waitFor();
  assert.equal(await tab.getByRole("button", { name: "Enable policy editing" }).count(), 0);
  assert.equal(await page.getByText("does not support per-Agent network policy").count(), 1);
});

// A version a Sandbox Driver provisioned names it in its snapshot, so the Policy denials tab reads
// its Sandbox log. Only a version without one skips the read (finding 2484).
test("Policy denials reads the Sandbox log of a version a Sandbox Driver provisioned", async (t) => {
  const { fixture, namespace, agent } = await createPolicyConsole(t);
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const snapshot = await fixture.request("GET", `${agentPath}/revisions/${revision.id}`);
  assert.equal(snapshot.data.sandboxDriverId, "policy-openshell");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "policy"));
  await waitForCondition(
    () =>
      requests.some(({ path }) =>
        path.startsWith(`${agentPath}/deployments/${revision.id}/runtime/logs?source=sandbox`),
      ),
    "the Sandbox log is read",
  );
  assert.equal(await page.getByText(/runs without a Sandbox/).count(), 0);
});

// A member whose grants do not include the Agent's SandboxPolicy gets a refusal; Retry would only
// ask again for the same answer (finding 2060). With a permission answer the console skips the
// read instead (finding 2454), so the answer is withheld here to reach the API's refusal.
test("A refused policy read offers no Retry", async (t) => {
  const { fixture, namespace, agent } = await createPolicyConsole(t);
  const member = await fixture.createAccountWithPolicy("policy-member", (principal) => {
    fixture.policy.roles.push({
      id: "role-policy-member",
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-policy-member",
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-policy-member",
    });
  });
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "policy"),
    member.credentials,
  );
  const tab = page.locator(".sandbox-policy");
  await tab
    .getByRole("alert")
    .filter({ hasText: "You do not have permission to read this Agent’s policy." })
    .waitFor();
  await tab.getByText("You do not have permission to read policy suggestions.").waitFor();
  assert.equal(await tab.getByRole("button", { name: "Retry policy read" }).count(), 0);
  assert.equal(await tab.getByRole("button", { name: "Refresh suggestions" }).count(), 0);
  // No policy descriptor is visible, but the independent log read must not wait forever.
  await waitForCondition(
    () => requests.some(({ path }) => path.includes("/runtime/logs")),
    "Independent log reads must continue without a policy descriptor.",
  );
  // Only the refusals stand in for the omitted controls.
  assert.equal(await tab.getByText("null", { exact: true }).count(), 0);
});

// The page read its answer before a policy read grant. Opening Policy denials compares the
// remembered denial with a fresh answer, which is not audited, so the policy shows on the first
// visit instead of only after a reload (finding 2454).
test("A policy read grant after the page loaded shows the policy on the first visit", async (t) => {
  const { fixture, namespace, agent } = await createPolicyConsole(t);
  const role = {
    id: "role-policy-granted-later",
    namespaceId: namespace.id,
    permissions: ["namespace", "agent", "agent_revision", "configuration"].map((resourceKind) => ({
      action: "read",
      resourceKind,
    })),
  };
  const member = await fixture.createAccountWithPolicy("policy-granted-later", (principal) => {
    fixture.policy.roles.push(role);
    fixture.policy.bindings.push({
      id: "binding-policy-granted-later",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: role.id,
    });
  });
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const answer = page.waitForResponse((r) => r.url().endsWith(`/agents/${agent.id}/permissions`));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
    member.credentials,
  );
  assert.equal((await (await answer).json()).data.sandboxPolicyRead, false);
  await settlePageRequests(page);

  role.permissions.push({ action: "read", resourceKind: "sandbox_policy" });
  await page.getByRole("tab", { name: "Policy denials", exact: true }).click();
  const tab = page.locator(".sandbox-policy");
  await tab.getByText(/^Policy v\d+ · Editing/).waitFor();
  await settlePageRequests(page);
  assert.equal(await tab.getByText(/Your access does not include reading/).count(), 0);
  assert.equal(
    pathRequests(
      requests,
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`,
    ).length,
    1,
  );
});

// The draft has no deployment of its own. With a current version, its denials and suggestions
// are on that version; without one (never deployed, stopped, or first deployment running) the
// tab says so instead of telling every reader to deploy.
test("Policy denials on the draft says where denials and suggestions come from", async (t) => {
  const { fixture, namespace, agent } = await createPolicyConsole(t);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "policy"));
  const tab = page.locator(".sandbox-policy");
  await tab
    .getByText("Policy denials come from deployed versions. This Agent has no current version.")
    .waitFor();
  await tab
    .getByText("Suggestions come from deployed versions. This Agent has no current version.")
    .waitFor();
  assert.equal(await tab.getByText(/^Deploy an Agent/).count(), 0);

  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await page.reload();
  await tab
    .getByText("Policy denials come from deployed versions. Open the current version to see them.")
    .waitFor();
  await tab
    .getByText("Suggestions come from deployed versions. Open the current version to see them.")
    .waitFor();
});

const delegatedPolicyGrant = {
  id: "python-demo",
  binary: "/usr/bin/python3.11",
  host: "example.org",
  ports: [{ from: 443, to: 443 }],
};

test("Agent policy proposals save separately or save then apply the newly saved version", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, [delegatedPolicyGrant]);
  // A real admitted revision is activated for presentation. This proves browser/HTTP/IAM
  // admission and the pending application record, not worker dispatch or provider enforcement.
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "policy"));
  await page.getByRole("button", { name: "Add Network rules", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Executable path", exact: true })
    .fill(delegatedPolicyGrant.binary);
  await page
    .getByRole("textbox", { name: "Destination hostname", exact: true })
    .fill(delegatedPolicyGrant.host);
  await page.getByRole("textbox", { name: "Rule ID", exact: true }).fill(delegatedPolicyGrant.id);
  await page.getByRole("button", { name: "Add Port ranges", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Start port", exact: true }).fill("443");
  await page.getByRole("spinbutton", { name: "End port", exact: true }).fill("443");
  assert.equal(
    await page
      .getByRole("button", { name: "Apply saved policy to current revision", exact: true })
      .isDisabled(),
    true,
  );
  // Delay a real successful preview while the user edits; the old response must not replace the draft.
  const preview = await holdRequests(t, page, `${fixture.origin}${base}/validate`, {
    once: true,
    method: "POST",
    afterServer: true,
  });
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await preview.requested;
  await page.getByRole("textbox", { name: "Rule ID", exact: true }).fill("newer-draft");
  const previewResponse = page.waitForResponse((response) =>
    response.url().endsWith(`${base}/validate`),
  );
  preview.release();
  await previewResponse;
  await page.getByText("Draft changed. Review again before saving.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Save", exact: true }).count(), 0);
  assert.equal(
    await page.getByRole("textbox", { name: "Rule ID", exact: true }).inputValue(),
    "newer-draft",
  );
  await page.getByRole("textbox", { name: "Rule ID", exact: true }).fill(delegatedPolicyGrant.id);
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  // Returning from review must retain the proposal and permit further edits.
  await page.getByRole("button", { name: "Back to editing", exact: true }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "Destination hostname", exact: true }).inputValue(),
    delegatedPolicyGrant.host,
  );
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText(/Policy v2 saved\. The current revision is unchanged\./).waitFor();
  const saved = (await fixture.request("GET", base)).data.policy;
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.additions, [delegatedPolicyGrant]);
  assert.equal(saved.application, undefined);
  assert.equal(
    pathRequests(requests, "POST", `${base}/apply`).length,
    0,
    "Save must not enqueue live application",
  );

  // The combined action must submit the accepted version, rather than applying the
  // old saved version while silently leaving a local proposal behind.
  await page.getByRole("textbox", { name: "Rule ID", exact: true }).fill("python-reviewed");
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await page
    .getByRole("button", { name: "Save and apply to current revision", exact: true })
    .click();
  await page
    .getByText(/Policy v3 saved\. Application to the current revision is pending\./)
    .waitFor();
  const applied = (await fixture.request("GET", base)).data.policy;
  assert.equal(applied.version, 3);
  assert.equal(applied.additions[0].id, "python-reviewed");
  assert.equal(applied.application.state, "pending");
  assert.equal(applied.application.policyVersion, 3);
  assert.equal(applied.application.revisionId, revision.id);
  assert.deepEqual(
    pathRequests(requests, "POST", `${base}/apply`).map(({ body }) => body),
    [{ expectedVersion: 3, revisionId: revision.id }],
  );
});

test("Agent policy proposals preserve valid Unicode executable paths through review and save", async (t) => {
  // JSON Schema counts Unicode code points. Each path segment also fits the native
  // filesystem byte limit, although this valid path exceeds 512 UTF-16 code units.
  const grant = {
    ...delegatedPolicyGrant,
    id: "unicode-tool",
    binary: `/${Array(6).fill("𐐀".repeat(45)).join("/")}/tool`,
  };
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, [grant]);
  const initial = (await fixture.request("GET", base)).data.policy;
  assert.equal(initial.version, 1);
  const accepted = await fixture.request("POST", `${base}/validate`, {
    body: { expectedVersion: initial.version, additions: [grant] },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.data, { success: true, data: { additions: [grant] } });

  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "policy"));
  await page.getByRole("button", { name: "Add Network rules", exact: true }).click();
  await page.getByRole("textbox", { name: "Rule ID", exact: true }).fill(grant.id);
  await page.getByRole("textbox", { name: "Destination hostname", exact: true }).fill(grant.host);
  await page.getByRole("button", { name: "Add Port ranges", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Start port", exact: true }).fill("443");
  await page.getByRole("spinbutton", { name: "End port", exact: true }).fill("443");
  const executable = page.getByRole("textbox", { name: "Executable path", exact: true });
  await executable.click();
  // Keyboard insertion exercises native maxlength handling; fill() can bypass it.
  await page.keyboard.insertText(grant.binary);
  const entered = await executable.inputValue();
  t.diagnostic(
    `Executable path: expected ${[...grant.binary].length} code points / ${grant.binary.length} UTF-16 units; entered ${[...entered].length} code points / ${entered.length} UTF-16 units.`,
  );
  assert.equal(entered, grant.binary, "the editor must retain the complete accepted path");

  const preview = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith(`${base}/validate`),
  );
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  const previewResponse = await preview;
  assert.equal(previewResponse.status(), 200);
  assert.deepEqual((await previewResponse.json()).data, {
    success: true,
    data: { additions: [grant] },
  });
  const saved = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url().endsWith(base),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page.getByText(/Policy v2 saved\. The current revision is unchanged\./).waitFor();
  const persisted = (await fixture.request("GET", base)).data.policy;
  assert.equal(persisted.version, initial.version + 1);
  assert.deepEqual(persisted.additions, [grant]);
  assert.equal(persisted.application, undefined);
  for (const [method, path] of [
    ["POST", `${base}/validate`],
    ["PUT", base],
  ]) {
    assert.deepEqual(
      pathRequests(requests, method, path).map(({ body }) => body),
      [{ expectedVersion: initial.version, additions: [grant] }],
    );
  }

  // Keep the schema owner's limit: exceeding 512 code points is an explicit
  // validation refusal, not a truncated input or a second saved policy.
  const tooLong = grant.binary + "a".repeat(232);
  await executable.click();
  await executable.press("ControlOrMeta+A");
  await page.keyboard.insertText(tooLong);
  assert.equal(await executable.inputValue(), tooLong);
  const rejected = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith(`${base}/validate`),
  );
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  const rejectedResponse = await rejected;
  assert.equal(rejectedResponse.status(), 200);
  const refusal = (await rejectedResponse.json()).data;
  assert.equal(refusal.success, false);
  assert.deepEqual(refusal.error.details, [
    {
      path: "/additions/0/binary",
      code: "TOO_LONG",
      message: "Configuration does not satisfy maxLength.",
    },
  ]);
  await page.getByText("Configuration does not satisfy maxLength.", { exact: true }).waitFor();
  assert.equal(await executable.inputValue(), tooLong);
  assert.equal(await page.getByRole("button", { name: "Save", exact: true }).count(), 0);
  assert.equal(pathRequests(requests, "PUT", base).length, 1);
  const unchanged = (await fixture.request("GET", base)).data.policy;
  assert.equal(unchanged.version, 2);
  assert.deepEqual(unchanged.additions, [grant]);
});

test("Agent policy under protected execution offers only removal of saved network rules", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, [delegatedPolicyGrant]);
  // Rules saved before protected execution applied block every protected deploy. This fixture
  // selects no Credential Proxy, so only the view's protectedExecution flag is set on the read;
  // the removal itself goes through real HTTP, IAM and OCC admission.
  const saved = await fixture.request("PUT", base, {
    body: { expectedVersion: 1, additions: [delegatedPolicyGrant] },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const { page } = await newPage(t, fixture);
  await page.route(`${fixture.origin}${base}`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    body.data.protectedExecution = true;
    await route.fulfill({ response, json: body });
  });
  const requests = apiRequests(page, fixture.origin);
  const read = page.waitForResponse(
    (response) => response.request().method() === "GET" && response.url().endsWith(base),
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "policy"));
  const readResponse = await read;
  t.diagnostic(`Policy GET status: ${readResponse.status()}`);
  assert.equal(readResponse.status(), 200);
  await page
    .getByText(
      "Protected execution uses Credential Proxy routes. You can remove saved network rules, but cannot add new ones. Saving does not change the running revision.",
      { exact: true },
    )
    .waitFor();
  // Neither adding a rule nor widening a saved rule is available under protected execution.
  for (const [role, name] of [
    ["button", "Add Network rules"],
    ["button", "Add Port ranges"],
    ["textbox", "Rule ID"],
    ["textbox", "Executable path"],
    ["textbox", "Destination hostname"],
    ["spinbutton", "Start port"],
    ["spinbutton", "End port"],
  ]) {
    assert.equal(await page.getByRole(role, { name, exact: true }).isDisabled(), true, name);
  }
  const preview = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith(`${base}/validate`),
  );
  await page.getByRole("button", { name: "Remove saved network rules", exact: true }).click();
  const previewResponse = await preview;
  t.diagnostic(`Policy preview POST status: ${previewResponse.status()}`);
  assert.equal(previewResponse.status(), 200);
  assert.deepEqual((await previewResponse.json()).data, {
    success: true,
    data: { additions: [] },
  });
  await page.getByRole("heading", { name: "Review policy changes", exact: true }).waitFor();
  await page.getByText("Remove all Agent-specific rules.", { exact: true }).waitFor();
  assert.deepEqual(
    pathRequests(requests, "POST", `${base}/validate`).map(({ body }) => body),
    [{ expectedVersion: 2, additions: [] }],
  );
  // Removal is only a proposal until explicit Save; preview must preserve the saved grants.
  assert.equal(pathRequests(requests, "PUT", base).length, 0);
  const unchanged = await fixture.request("GET", base);
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.data.policy.version, 2);
  assert.deepEqual(unchanged.data.policy.additions, [delegatedPolicyGrant]);
  assert.equal(
    await page
      .getByRole("button", { name: "Save and apply to current revision", exact: true })
      .isDisabled(),
    true,
  );
  const removal = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url().endsWith(base),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const removalResponse = await removal;
  t.diagnostic(`Policy removal PUT status: ${removalResponse.status()}`);
  assert.equal(removalResponse.status(), 200);
  await page.getByText(/Policy v3 saved without network rules\./).waitFor();
  assert.deepEqual(
    pathRequests(requests, "PUT", base).map(({ body }) => body),
    [{ expectedVersion: 2, additions: [] }],
  );
  const cleared = await fixture.request("GET", base);
  t.diagnostic(`Policy readback GET status: ${cleared.status}`);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.policy.version, 3);
  assert.deepEqual(cleared.data.policy.additions, []);
  assert.equal(cleared.data.policy.application, undefined);
  assert.equal(pathRequests(requests, "POST", `${base}/apply`).length, 0);
  assert.equal(
    await page.getByRole("button", { name: "Remove saved network rules", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "Add Network rules", exact: true }).isDisabled(),
    true,
  );
});

test("Agent policy combined save distinguishes ceiling rejection from a saved policy whose application is rejected", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, [delegatedPolicyGrant]);
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "policy"));
  await page.getByRole("button", { name: "Add Network rules", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Executable path", exact: true })
    .fill(delegatedPolicyGrant.binary);
  await page
    .getByRole("textbox", { name: "Destination hostname", exact: true })
    .fill("outside.example.org");
  await page.getByRole("textbox", { name: "Rule ID", exact: true }).fill(delegatedPolicyGrant.id);
  await page.getByRole("button", { name: "Add Port ranges", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Start port", exact: true }).fill("443");
  await page.getByRole("spinbutton", { name: "End port", exact: true }).fill("443");
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "The grant exceeds the Installation delegation ceiling" })
    .first()
    .waitFor();
  assert.equal(
    pathRequests(requests, "POST", `${base}/apply`).length,
    0,
    "a rejected save must never apply the previous policy",
  );
  assert.equal((await fixture.request("GET", base)).data.policy.version, 1);

  await page
    .getByRole("textbox", { name: "Destination hostname", exact: true })
    .fill(delegatedPolicyGrant.host);
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  // Another operator stops the Agent after review. Saving remains valid, while the
  // exact running-revision check must reject application without concealing the saved change.
  const stopped = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  await page
    .getByRole("button", { name: "Save and apply to current revision", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({
      hasText: "Policy v2 was saved, but application to the current revision was not confirmed.",
    })
    .waitFor();
  const persisted = (await fixture.request("GET", base)).data.policy;
  assert.equal(persisted.version, 2);
  assert.equal(persisted.additions[0].host, delegatedPolicyGrant.host);
  assert.equal(persisted.application, undefined);
  assert.equal(pathRequests(requests, "POST", `${base}/apply`).length, 1);
});

test("Agent policy conflict reload retains the draft and revalidates the new version", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, [delegatedPolicyGrant]);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "policy"));
  await page.getByRole("button", { name: "Add Network rules", exact: true }).click();
  await page.getByRole("textbox", { name: "Rule ID", exact: true }).fill(delegatedPolicyGrant.id);
  await page
    .getByRole("textbox", { name: "Executable path", exact: true })
    .fill(delegatedPolicyGrant.binary);
  await page
    .getByRole("textbox", { name: "Destination hostname", exact: true })
    .fill(delegatedPolicyGrant.host);
  await page.getByRole("button", { name: "Add Port ranges", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Start port", exact: true }).fill("443");
  await page.getByRole("spinbutton", { name: "End port", exact: true }).fill("443");
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).waitFor();
  // A separate supported API save advances the version after this browser's successful preview.
  assert.equal(
    (await fixture.request("PUT", base, { body: { expectedVersion: 1, additions: [] } })).status,
    200,
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "The policy changed" }).waitFor();
  await page.getByRole("button", { name: "Refresh policy", exact: true }).click();
  await page.getByText(/Policy v2 reloaded. Your draft is retained/).waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Rule ID", exact: true }).inputValue(),
    delegatedPolicyGrant.id,
  );
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText(/Policy v3 saved/).waitFor();
  assert.deepEqual((await fixture.request("GET", base)).data.policy.additions, [
    delegatedPolicyGrant,
  ]);
});

test("overlapping policy refreshes retain the newest read and continue pending polling", async (t) => {
  const { fixture, namespace, agent, base } = await createPolicyConsole(t, [delegatedPolicyGrant]);
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "policy"));
  await page.getByText("Matches saved policy v1.", { exact: false }).waitFor();
  const url = `${fixture.origin}${base}`;
  const first = await holdRequests(t, page, url, { once: true, method: "GET", afterServer: true });
  await page.getByRole("button", { name: "Refresh policy", exact: true }).click();
  await first.requested;
  // Another operator saves between the two reads. The older successful response arrives
  // first and must not invalidate the later read or overwrite its version.
  assert.equal(
    (
      await fixture.request("PUT", base, {
        body: { expectedVersion: 1, additions: [delegatedPolicyGrant] },
      })
    ).status,
    200,
  );
  const second = await holdRequests(t, page, url, { once: true, method: "GET", afterServer: true });
  await page.getByRole("button", { name: "Refresh policy", exact: true }).click();
  await second.requested;
  const firstResponse = page.waitForResponse((response) => response.url() === url);
  first.release();
  await (await firstResponse).finished();
  await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
  const secondResponse = page.waitForResponse((response) => response.url() === url);
  second.release();
  await secondResponse;
  await page.getByText("Matches saved policy v2.", { exact: false }).waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Rule ID", exact: true }).inputValue(),
    delegatedPolicyGrant.id,
  );

  await page
    .getByRole("button", { name: "Apply saved policy to current revision", exact: true })
    .click();
  await page.getByText(/Application to the current revision is pending/).waitFor();
  const reads = pathRequests(requests, "GET", base).length;
  // This fixture has no worker: real admission stays pending, so observing multiple polls
  // proves refresh continues rather than claiming provider enforcement or confirmation.
  await waitForCondition(
    () => pathRequests(requests, "GET", base).length >= reads + 2,
    "pending policy stopped polling",
    10_000,
  );
  assert.equal((await fixture.request("GET", base)).data.policy.application.state, "pending");
});

test("Agent deployment requires a reload after repository access changes", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1600",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(
    namespace.id,
    "Repository deploy review",
    nativeValues("repository-deploy-review"),
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const initial = await fixture.request("PATCH", path, {
    body: {
      configurationId: agent.configurationId,
      repositoryBindings: [{ repositoryRef: "application", profile: "git-read" }],
    },
  });
  assert.equal(initial.status, 200);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
  );
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await page.getByText("application · Read-only", { exact: true }).waitFor();
  await waitForEnabled(deploy);

  // A second operator changes effective access after this draft was loaded.
  const bindingChange = await fixture.request("PATCH", path, {
    body: {
      configurationId: agent.configurationId,
      repositoryBindings: [{ repositoryRef: "application", profile: "git-full" }],
    },
  });
  assert.equal(bindingChange.status, 200);
  const staleMessage = "Repository access changed. Reload this draft before deploying.";
  const staleOutcome = Promise.race([
    page
      .getByText(staleMessage, { exact: true })
      .waitFor()
      .then(() => "blocked"),
    page
      .waitForRequest(
        (request) => request.method() === "POST" && request.url().endsWith(`${path}/deploy`),
      )
      .then(() => "deployed"),
  ]);
  await deploy.click();
  assert.equal(await staleOutcome, "blocked", "stale access must not be deployed");
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);

  await page.reload();
  await page.getByText("application · Contributor", { exact: true }).waitFor();
  await waitForEnabled(deploy);
  // Intent can change even when the resolved permissions stay the same.
  const intentChange = await fixture.request("PATCH", path, {
    body: {
      configurationId: agent.configurationId,
      repositoryAccess: {
        defaultProfile: "git-full",
        repositories: [{ repositoryRef: "application" }],
      },
    },
  });
  assert.equal(intentChange.status, 200);
  assert.deepEqual(intentChange.data.repositoryBindings, bindingChange.data.repositoryBindings);
  await deploy.click();
  await page.getByText(staleMessage, { exact: true }).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);

  await page.reload();
  await page.getByText("application · Contributor", { exact: true }).waitFor();
  await waitForEnabled(deploy);
});

test("Agent deployment reports preflight errors and requires reload for changed draft state", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Deployment preflight");
  const agent = await fixture.createAgent(
    namespace.id,
    "Deployment preflight",
    nativeValues("before-preflight"),
    { harnessAuth: { method: "runtime" } },
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
  );
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
  await page.route(`${fixture.origin}${path}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "Read unavailable" },
      }),
    }),
  );
  await deploy.click();
  await page.getByText(READ_UNAVAILABLE).waitFor();
  await waitForEnabled(deploy);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
  await page.unroute(`${fixture.origin}${path}`);

  // Changes to Configuration and authentication each require a fresh review.
  await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("changed"));
  await deploy.click();
  const stale = "Configuration or authentication changed. Reload this draft before deploying.";
  await page.getByText(stale, { exact: true }).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
  await page.reload();
  await page.getByText(/generation 2/).waitFor();
  await waitForEnabled(deploy);
  const authChange = await fixture.request("PATCH", path, {
    body: { configurationId: agent.configurationId, harnessAuth: null },
  });
  assert.equal(authChange.status, 200);
  await deploy.click();
  // Removed authentication is reported before the stale-draft comparison.
  await page
    .getByText("Select a harness authentication source in Credentials before deployment.", {
      exact: true,
    })
    .first()
    .waitFor();
  assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
});

// Deploy new version disabled the pressed button, dropping keyboard focus to the document, and
// flashed "Checking Configuration…" then "Requesting deployment…" for a frame each (finding 1619).
// One delayed status now covers the request and holds focus until the outcome is known.
test("Deploy new version keeps keyboard focus and shows one delayed status", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Deployment focus");
  const agent = await fixture.createAgent(
    namespace.id,
    "Deployment focus",
    nativeValues("deployment-focus"),
    { harnessAuth: { method: "runtime" } },
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
  );
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  const status = page.locator(".agent-draft-actions p[role=status]");
  await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
  const focusedRole = () =>
    page.evaluate(() => globalThis.document.activeElement?.getAttribute("role") ?? null);
  const pressDeploy = async () => {
    await deploy.focus();
    await page.keyboard.press("Enter");
  };

  // A failed read re-enables Deploy: focus returns to it, described by the failure.
  const unavailable = READ_UNAVAILABLE;
  const failedRead = await holdRequests(t, page, `${fixture.origin}${path}`, {
    once: true,
    fulfill: {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "Read unavailable" },
      }),
    },
  });
  await pressDeploy();
  await failedRead.requested;
  assert.equal(await focusedRole(), "status");
  failedRead.release();
  await page.getByText(unavailable).waitFor();
  assert.equal(await focusedText(page), "Deploy new version");
  assert.equal(await focusedDescription(page), unavailable);

  // A reader who moved on while the read ran keeps their place.
  const movedOn = await holdRequests(t, page, `${fixture.origin}${path}`, {
    once: true,
    fulfill: {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "Read unavailable" },
      }),
    },
  });
  await pressDeploy();
  await movedOn.requested;
  await page.evaluate(() => globalThis.document.activeElement?.blur());
  movedOn.release();
  await page.locator("button:not([disabled])", { hasText: "Deploy new version" }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.document.activeElement?.tagName), "BODY");

  // A stale draft keeps Deploy disabled, so the refusal itself takes focus.
  await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("changed"));
  await pressDeploy();
  const stale = "Configuration or authentication changed. Reload this draft before deploying.";
  await page.getByText(stale, { exact: true }).waitFor();
  assert.equal(await deploy.isDisabled(), true);
  assert.equal(await focusedRole(), "status");
  assert.equal(await focusedText(page), stale);

  // A submitted request whose outcome is unknown keeps Deploy disabled, so the failure takes
  // focus. The API's catch-all outage names no refusal (finding 1638).
  await page.reload();
  await page.getByText(/generation 2/).waitFor();
  const unknownOutcome = await holdRequests(t, page, `${fixture.origin}${path}/deploy`, {
    once: true,
    method: "POST",
    fulfill: {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "DEPENDENCY_UNAVAILABLE",
          message: DEPENDENCY_UNAVAILABLE,
        },
      }),
    },
  });
  await pressDeploy();
  await unknownOutcome.requested;
  unknownOutcome.release();
  const failure = page.locator(".agent-draft-actions p[role=alert]");
  await page.waitForFunction(
    () => globalThis.document.activeElement?.getAttribute("role") === "alert",
  );
  assert.ok((await failure.textContent()).length > 0);
  assert.equal(await focusedText(page), await failure.textContent());
  assert.equal(await status.textContent(), "");
  assert.equal(await deploy.isDisabled(), true);

  // An admitted deployment shows one status while its request runs, and the status keeps
  // focus until the new version opens.
  await page.reload();
  await page.getByText(/generation 2/).waitFor();
  await page.evaluate(() => {
    const shown = [];
    const node = globalThis.document.querySelector(".agent-draft-actions p[role=status]");
    new globalThis.MutationObserver(() => {
      if (node.textContent && node.textContent !== shown.at(-1)) {
        shown.push(node.textContent);
      }
    }).observe(node, { childList: true, characterData: true, subtree: true });
    globalThis.deployStatusTexts = shown;
  });
  const admitted = await holdRequests(t, page, `${fixture.origin}${path}/deploy`, {
    method: "POST",
  });
  await pressDeploy();
  await admitted.requested;
  assert.equal(await focusedRole(), "status");
  assert.equal(await focusedText(page), "Deploying…");
  // The text sits in the 250 ms delayed-status span, so a quick request never shows it.
  assert.equal(await status.locator(".delayed-status").textContent(), "Deploying…");
  admitted.release();
  await page.waitForURL(/revision=rev_/);
  assert.deepEqual(await page.evaluate(() => globalThis.deployStatusTexts), ["Deploying…"]);
});

// After an admitted deployment the draft page stays on screen, inert, while the new version
// loads. Focus fell from the Deploying… status to the page body for 100-580 ms until the new
// version's heading took it (finding 1626). The held page's heading now keeps it, through the
// loading page when admission or the Agent read outlasts 250 ms, and hands it to the new
// version's heading as the page shows, even while the version is still being read. Going Back
// during the load keeps it too, until the draft's heading takes it. A reader who left the status
// during the request is not pulled back while the page is held.
for (const [scenario, heldRead, heldMs, reader] of [
  ["a quick Agent read", "agent", 100, "stays"],
  ["a slow Agent read", "agent", 700, "stays"],
  ["a slow Namespace access check", "namespaces", 700, "stays"],
  ["a version read that outlasts the 2 s reveal wait", "revision", 2600, "stays"],
  ["a reader who goes Back during a slow Agent read", "agent", 700, "goes back"],
  ["a reader who moved on", "agent", 700, "moves on"],
]) {
  test(`An admitted deployment keeps keyboard focus until the new version opens: ${scenario}`, async (t) => {
    const { fixture, namespace } = await createRuntimeAuthFixture(t, "Deployment hand-off");
    const agent = await fixture.createAgent(
      namespace.id,
      "Deployment hand-off",
      nativeValues("deployment-hand-off"),
      { harnessAuth: { method: "runtime" } },
    );
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const { page } = await newPage(t, fixture);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
    );
    await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
    const admitted = await holdRequests(t, page, `${fixture.origin}${path}/deploy`, {
      method: "POST",
    });
    await page.getByRole("button", { name: "Deploy new version" }).focus();
    await page.keyboard.press("Enter");
    await admitted.requested;
    assert.equal(await focusedText(page), "Deploying…");
    if (reader === "moves on") {
      await page.evaluate(() => globalThis.document.activeElement?.blur());
    }
    // Every focused node from admission until the new version shows (numbered, so a replaced
    // heading counts as a new one), and whether the loading page stood in.
    await recordFocusTrail(page, ["Reading this Agent.", "Checking Namespace access."]);
    const heldPath = {
      agent: path,
      namespaces: "/namespaces",
      revision: `${path}/revisions/rev_*`,
    }[heldRead];
    const versionRead = await holdRequests(t, page, `${fixture.origin}${heldPath}`, {
      once: true,
      method: "GET",
    });
    admitted.release();
    await versionRead.requested;
    if (reader === "goes back") {
      // Once the Loading page has replaced the held draft, Back returns to the draft.
      await page.waitForFunction(() => globalThis.focusFrames.loadingShown);
      await page.goBack({ waitUntil: "commit" });
      versionRead.release();
      await page.waitForURL(/revision=draft/);
    } else {
      await new Promise((resolve) => setTimeout(resolve, heldMs));
      versionRead.release();
      await page.waitForURL(/revision=rev_/);
    }
    await page.waitForFunction(
      () =>
        globalThis.document.activeElement?.tagName === "H1" &&
        globalThis.document.activeElement.isConnected &&
        !globalThis.document.querySelector(".agent-detail-pending, .holding, [aria-busy=true]") &&
        globalThis.document.querySelector(".agent-tabs [aria-selected=true]") !== null,
    );
    const { trail, loadingShown } = await stopFocusTrail(page);
    if (heldRead !== "revision" && heldMs > 250) {
      assert.ok(loadingShown, trail.join(" | "));
    }
    assert.match(trail.at(-1), /^H1#\d+: Deployment hand-off$/, trail.join(" | "));
    if (reader === "moves on") {
      // Nothing takes focus while the page is held; the new version's heading takes it once shown.
      assert.deepEqual(trail.slice(0, -1), ["BODY"], trail.join(" | "));
    } else {
      assert.match(trail[0], /^P#\d+: Deploying…$/, trail.join(" | "));
      assert.ok(!trail.includes("BODY"), trail.join(" | "));
      // The held heading shows the same name: the focused heading at the end is a later one.
      assert.notEqual(
        trail.at(-1),
        trail.find((entry) => entry.startsWith("H1#")),
        trail.join(" | "),
      );
    }
  });
}

for (const [field, change] of [
  ["execution mode", { executionMode: "dedicated" }],
  ["Backend", { backendId: backendFixtures[0].id }],
  [
    "plugin policy",
    {
      plugins: {
        "codex-plugin:linear@openai-curated-remote": {
          enabled: true,
          toolDefaults: { approval: "none" },
        },
      },
    },
  ],
]) {
  test(`Agent deployment requires a reload after ${field} changes`, async (t) => {
    // SSH Compute runs only embedded Agents, and Agent save refuses a change to dedicated, so
    // the execution mode case runs on Kubernetes Compute with a Secret-backed key.
    const kubernetes = field === "execution mode";
    const { fixture, namespace } = kubernetes
      ? await (async () => {
          const created = await createConsoleAppFixture(t);
          await created.bootstrap();
          return {
            fixture: created,
            namespace: await created.createNamespace(`Deployment ${field}`, { ready: true }),
          };
        })()
      : await createRuntimeAuthFixture(t, `Deployment ${field}`);
    const pluginDriver = new CodexPluginDriver();
    fixture.controller.registerDriver(pluginDriver);
    fixture.controller.selectDriver("plugin", pluginDriver.id);
    const agent = await fixture.createAgent(
      namespace.id,
      `Deployment ${field}`,
      nativeValues("deployment-settings"),
      kubernetes ? {} : { harnessAuth: { method: "runtime" } },
    );
    const ready = () =>
      kubernetes
        ? page.locator("button:not([disabled])", { hasText: "Deploy new version" }).waitFor()
        : page.getByText("Configured on the runtime host", { exact: false }).waitFor();
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const { page } = await newPage(t, fixture);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
    );
    const deploy = page.getByRole("button", { name: "Deploy new version" });
    await ready();
    await waitForEnabled(deploy);

    // A second operator changes the desired Agent state without editing its Configuration.
    const updated = await fixture.request("PATCH", path, {
      body: { configurationId: agent.configurationId, ...change },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const result = Promise.race([
      page
        .getByText("Agent settings changed. Reload this draft before deploying.", { exact: true })
        .waitFor()
        .then(() => "blocked"),
      page
        .waitForRequest(
          (request) => request.method() === "POST" && request.url().endsWith(`${path}/deploy`),
        )
        .then(() => "submitted"),
    ]);
    // Stop an unguarded candidate from creating a revision during the regression check.
    await page.route(`${fixture.origin}${path}/deploy`, (route) => route.abort());
    await deploy.click();
    assert.equal(await result, "blocked", `stale ${field} must not be submitted`);
    assert.equal(await deploy.isDisabled(), true);
    await page.reload();
    await ready();
    await waitForEnabled(deploy);
  });
}

async function deployableRepositoryAgent(t, name) {
  const { fixture, namespace, modelSecret, grantModelAccess } =
    await createConsoleRepositoryLaunchFixture(t);
  const configuration = await fixture.createConfiguration(
    namespace.id,
    createHarnessConfiguration("codex", "gpt-5.1"),
  );
  const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name,
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth: { method: "api_key", source: modelSecret.ref },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const agent = created.data;
  await grantModelAccess(agent);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const provisioned = await fixture.request("POST", `${path}/runtime-credentials`, {
    headers: { origin: fixture.origin },
    body: {},
  });
  assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
  return { fixture, namespace, agent, path };
}

test("A recovery link refused by unsaved repository changes preserves Back and Forward", async (t) => {
  const { fixture, namespace, agent } = await deployableRepositoryAgent(t, "Recovery Agent");
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  // The controller admitted this revision. Supply its failed status so the real recovery link
  // is available while the reader edits the draft; no worker or external service runs.
  await routeFailedDeployment(page, fixture, {
    namespaceId: namespace.id,
    agentId: agent.id,
    deploymentId: revision.id,
    code: "RUNTIME_MODEL_PROBE_FAILED",
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "channels"));
  const channels = page.getByRole("tab", { name: "Channels", selected: true });
  await channels.waitFor();
  const channelsUrl = page.url();
  const requests = apiRequests(page, fixture.origin);
  const repositories = page.getByRole("tab", { name: "Repositories" });
  await repositories.click();
  const choice = repositoryCheckbox(page, "example/application");
  await choice.check();
  const repositoriesUrl = page.url();

  await page
    .getByRole("region", { name: "Deployment needs attention" })
    .getByRole("link", { name: "Open Configuration" })
    .click();
  await page.getByText(REPOSITORY_EDITS_PENDING).waitFor();
  assert.equal(page.url(), repositoriesUrl);
  assert.equal(await hasFocus(repositories), true);
  assert.equal(await choice.isChecked(), true);

  // Cancel rereads the saved selection in place. Back should not revisit a duplicate entry.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await choice.and(page.locator("input:enabled:not(:checked)")).waitFor();
  await page.goBack();
  assert.equal(page.url(), channelsUrl, "one Back after Cancel returns to Channels");
  await channels.waitFor();
  await page.goForward();
  await page.getByRole("tab", { name: "Repositories", selected: true }).waitFor();
  assert.equal(page.url(), repositoriesUrl);
  await settlePageRequests(page);
  assert.deepEqual(writeRequests(requests), []);
});

for (const tab of ["configuration", "repositories"]) {
  test(`Agent deployment keeps ${tab} edits unavailable until the request finishes`, async (t) => {
    const { fixture, namespace, agent, path } = await deployableRepositoryAgent(
      t,
      `Deploying from ${tab}`,
    );
    const { page } = await newPage(t, fixture);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=${tab}`,
    );
    const edit =
      tab === "configuration"
        ? page.getByRole("button", { name: "Edit Configuration", exact: true })
        : repositoryCheckbox(page, "example/application");
    await edit.waitFor();
    const deploy = page.getByRole("button", { name: "Deploy new version" });
    await waitForEnabled(deploy);
    const preflight = await holdRequests(t, page, `${fixture.origin}${path}`, {
      method: "GET",
      timeout: 0,
    });
    const deployment = await holdRequests(t, page, `${fixture.origin}${path}/deploy`, {
      afterServer: true,
      timeout: 0,
    });
    const admitted = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}${path}/deploy` &&
        response.request().method() === "POST",
    );
    await deploy.click();
    await preflight.requested;
    // Edits made during an admitted deployment would otherwise block its revision navigation.
    await assert.rejects(edit.click({ timeout: 500 }), /Timeout/);
    preflight.release();
    const committed = await deployment.requested;
    assert.equal(committed.status(), 202, JSON.stringify(await committed.json()));
    await assert.rejects(edit.click({ timeout: 500 }), /Timeout/);
    deployment.release();
    assert.equal((await admitted).status(), 202);
    await page.waitForURL(/revision=rev_/);
  });
}

test("Agent deployment shows the API's typed 403 and 409 refusals", async (t) => {
  const { fixture, namespace, modelSecret, grantModelAccess } =
    await createConsoleRepositoryLaunchFixture(t);
  // A loopback listener cannot serve the Gateway Service's Pod-IP traffic, so deployment
  // refuses it. The Configuration itself saves, as it does for an operator.
  const values = createHarnessConfiguration("codex", "gpt-5.1");
  values.gateway.bind = "loopback";
  const configuration = await fixture.createConfiguration(namespace.id, values);
  const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Typed deploy refusals",
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth: { method: "api_key", source: modelSecret.ref },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const agent = created.data;
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
  );
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await page.getByRole("button", { name: "Edit Configuration", exact: true }).waitFor();
  await waitForEnabled(deploy);
  const deployResponse = () =>
    page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}${path}/deploy` &&
        response.request().method() === "POST",
    );
  async function refusal(status) {
    const response = deployResponse();
    await deploy.click();
    const body = await (await response).json();
    assert.equal((await response).status(), status, JSON.stringify(body));
    return body.error.message;
  }

  // The caller may operate the model Secret, but the Agent's own service principal may not.
  // The API names that principal and the grant to add; the console shows the same sentence.
  const denied = await refusal(403);
  assert.match(
    denied,
    new RegExp(`^The Agent service principal ${agent.servicePrincipalId} is not authorized`),
  );
  await page.getByText(denied, { exact: true }).waitFor();
  await waitForEnabled(deploy);

  // With that grant in place, the next refusal is the Configuration setting itself.
  await grantModelAccess(agent);
  const conflict = await refusal(409);
  assert.match(conflict, /^Configuration setting gateway\.bind /);
  await page.getByText(conflict, { exact: true }).waitFor();
  await waitForEnabled(deploy);
  const revisions = await fixture.request("GET", `${path}/revisions`);
  assert.equal(revisions.status, 200);
  assert.equal(revisions.data.length, 0, "a refused deployment creates no version");

  // The caller's own denial is generic by design: it names nothing the caller may not read,
  // and nothing to fix, so the console keeps its guidance about the grants deploy needs.
  fixture.policy.restrictions.push({
    id: "deny-typed-refusal-deploy",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: agent.id,
    action: "deploy",
    effect: "deny",
  });
  assert.equal(await refusal(403), GENERIC_DENIAL);
  // Granting these writes IAM policy, which only an Installation administrator can do (finding
  // 2260).
  await page
    .getByText(
      "Deployment denied. Check Agent deploy permission and access to selected Secrets. First deployment also needs Agent read and operate permissions to create connection credentials. Granting them needs Installation administration access: ask an Installation administrator to check these grants.",
      { exact: true },
    )
    .waitFor();
  await waitForEnabled(deploy);
  fixture.policy.restrictions.pop();

  // Deploys against a routed 409 with `body` and waits for `text`, with Deploy enabled again.
  async function routedConflict(body, text, exact) {
    await page.route(`${fixture.origin}${path}/deploy`, (route) =>
      route.fulfill({ status: 409, contentType: "application/json", body }),
    );
    await deploy.click();
    await page.getByText(text, { exact }).waitFor();
    await waitForEnabled(deploy);
    await page.unroute(`${fixture.origin}${path}/deploy`);
  }

  // An untyped conflict, or a proxy reply with no error envelope, also names nothing to fix.
  for (const body of [
    JSON.stringify({
      error: {
        code: "RESOURCE_CONFLICT",
        message: RESOURCE_CONFLICT,
      },
    }),
    "",
  ]) {
    await routedConflict(body, "Deployment conflicts with the saved Agent state.", false);
  }

  // A Namespace that isn't ready gets the console's pointer to the Namespaces page, not the
  // API's bare sentence.
  await routedConflict(
    JSON.stringify({
      error: { code: "NAMESPACE_NOT_READY", message: NAMESPACE_NOT_READY },
    }),
    NAMESPACE_NOT_READY_MESSAGE,
    true,
  );
});

for (const mutation of ["authentication", "channel Secrets"]) {
  test(`Agent deployment waits for ${mutation} writes and their recovery`, async (t) => {
    const { fixture, namespace, modelSecret, grantModelAccess, grantSecretAccess } =
      await createConsoleRepositoryLaunchFixture(
        t,
        mutation === "channel Secrets" ? { secretDriver: createTestSecretDriver() } : {},
      );
    const values = createHarnessConfiguration("codex", "gpt-5.1");
    let appSecret;
    let botSecret;
    let replacementSecret;
    let secretBindings;
    if (mutation === "channel Secrets") {
      appSecret = await fixture.createSecret(namespace.id, "Slack app", "xapp-original");
      botSecret = await fixture.createSecret(namespace.id, "Slack bot", "xoxb-original");
      replacementSecret = await fixture.createSecret(
        namespace.id,
        "Slack app replacement",
        "xapp-replacement",
      );
      values.channels = {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          allowFrom: ["U123"],
          channels: { C123: { requireMention: true } },
        },
      };
      secretBindings = {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      };
    }
    const configuration = await fixture.createConfiguration(namespace.id, values, {
      secretBindings,
    });
    const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: `Credential race ${mutation}`,
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "api_key", source: modelSecret.ref },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const agent = created.data;
    await grantModelAccess(agent);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const provisioned = await fixture.request("POST", `${path}/runtime-credentials`, {
      headers: { origin: fixture.origin },
      body: {},
    });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
    if (mutation === "channel Secrets") {
      // The replacement too: a reloaded draft must find every saved Secret granted to be ready.
      for (const secret of [appSecret, botSecret, replacementSecret]) {
        await grantSecretAccess(agent, secret);
      }
      await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    }
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
    );
    await page.getByText("Ready to deploy.", { exact: true }).waitFor();
    const deploy = page.getByRole("button", { name: "Deploy new version" });
    await waitForEnabled(deploy);
    if (mutation === "authentication") {
      fixture.policy.restrictions.push({
        id: "deny-authentication-save",
        namespaceId: namespace.id,
        resourceKind: "agent",
        resourceId: agent.id,
        action: "update",
        effect: "deny",
      });
      await page.getByRole("button", { name: "Save authentication source" }).click();
      // A refused Agent save names the grants it needs (finding 1530).
      await page.getByText(AGENT_SAVE_DENIED).waitFor();
      await waitForEnabled(deploy);
      fixture.policy.restrictions.pop();
    }
    const mutationPath =
      mutation === "authentication"
        ? path
        : `/namespaces/${namespace.id}/configurations/${configuration.id}`;
    // The server applies the write; the page loses its answer.
    const write = await holdRequests(t, page, `${fixture.origin}${mutationPath}`, {
      method: "PATCH",
      afterServer: true,
      loseResponse: true,
      timeout: 0,
    });
    if (mutation === "authentication") {
      await page.getByRole("button", { name: "Save authentication source" }).click();
    } else {
      await selectSecret(page, "Slack app token", replacementSecret);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
    }
    const result = await write.requested;
    assert.equal(result.status(), 200, JSON.stringify(await result.json()));
    assert.equal(
      await deploy.isDisabled(),
      true,
      "an in-flight credential write must block deployment",
    );
    if (mutation === "authentication") {
      assert.equal(
        await page.getByRole("tab", { name: "Configuration", exact: true }).isDisabled(),
        true,
      );
      // Without Slack there is no channel Secret panel to lock.
      assert.equal(await page.locator(".channel-secrets").count(), 0);
    } else {
      assert.equal(
        await page
          .getByRole("button", { name: "Save authentication source" })
          .evaluate((node) => Boolean(node.closest("[inert]"))),
        true,
      );
      for (const label of ["Configuration", "Repositories", "Channels", "Workspace files"]) {
        assert.equal(
          await page.getByRole("tab", { name: label, exact: true }).isDisabled(),
          true,
          `${label} must not be available while credentials are saving`,
        );
      }
      if (mutation === "channel Secrets") {
        assert.equal(await page.locator("#revision-selector").isDisabled(), true);
      }
    }
    assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
    write.release();
    await page
      .getByText(/Outcome unknown/)
      .first()
      .waitFor();
    const credentialsPanel = page.locator(".channel-secrets");
    const uncertaintyExplanation =
      "Credential changes may have been saved. Reload this draft and inspect the saved state before deploying.";
    if (mutation !== "authentication") {
      assert.equal(
        await credentialsPanel
          .getByText("Outcome unknown. Reload this Agent to confirm the saved Secret bindings.", {
            exact: false,
          })
          .count(),
        1,
      );
      // That line is the panel's only word on the unknown outcome, so it is a danger alert
      // (finding 2014).
      assert.deepEqual(
        await credentialsPanel
          .getByText("Outcome unknown. Reload this Agent to confirm the saved Secret bindings.", {
            exact: false,
          })
          .evaluate((node) => [node.getAttribute("role"), node.dataset.tone]),
        ["alert", "danger"],
      );
      assert.equal(
        await credentialsPanel.getByText(uncertaintyExplanation, { exact: true }).count(),
        0,
      );
      // The deploy status names the unknown outcome instead (finding 2032), and the Secret
      // pickers stay locked until a reload (finding 2033).
      await page.getByRole("status").getByText(uncertaintyExplanation, { exact: true }).waitFor();
      for (const label of ["Slack app token", "Slack bot token"]) {
        assert.equal(await page.getByLabel(label, { exact: true }).isDisabled(), true, label);
      }
      assert.equal(
        await page
          .getByRole("button", { name: "Save authentication source" })
          .evaluate((node) => node.ownerDocument.defaultView.getComputedStyle(node).opacity),
        "0.6",
      );
    }
    assert.equal(
      await deploy.isDisabled(),
      true,
      "an unconfirmed credential write must block deployment",
    );
    await page.unroute(`${fixture.origin}${mutationPath}`);
    if (mutation === "channel Secrets") {
      assert.equal(await page.locator("#revision-selector").isEnabled(), true);
    }
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("tab", { name: "Credentials", exact: true }).click();
    assert.equal(await deploy.isDisabled(), true);
    if (mutation === "authentication") {
      await page.getByRole("button", { name: "Reload authentication source" }).click();
      await page
        .getByText("Outcome unknown. Reload authentication source before saving again.")
        .waitFor({ state: "hidden" });
    } else {
      await page.getByRole("button", { name: "Reload draft", exact: true }).click();
    }
    await page
      .getByRole("button", { name: "Reload draft", exact: true })
      .waitFor({ state: "hidden" });
    await page.getByText("Ready to deploy.", { exact: true }).waitFor();
    await page.waitForFunction(() =>
      [...globalThis.document.querySelectorAll("button")].some(
        (button) => button.textContent === "Deploy new version" && !button.disabled,
      ),
    );
    assert.equal(await deploy.isEnabled(), true);
    assert.equal(pathRequests(requests, "POST", `${path}/deploy`).length, 0);
    if (mutation === "channel Secrets") {
      const configurationPath = `/namespaces/${namespace.id}/configurations/${configuration.id}`;
      const refusalText = CONFIGURATION_SAVE_DENIED;
      // A refused check before the save keeps its own text: nothing was written (finding 1839).
      const refusedCheck = (route) =>
        route.request().method() === "GET"
          ? route.fulfill({
              status: 403,
              contentType: "application/json",
              body: JSON.stringify({
                error: { code: "FORBIDDEN", message: "denied" },
                meta: { requestId: "req_00000000-0000-4000-8000-000000000434" },
              }),
            })
          : route.continue();
      await page.route(`${fixture.origin}${configurationPath}`, refusedCheck);
      const writesBeforeCheck = pathRequests(requests, "PATCH", configurationPath).length;
      await selectSecret(page, "Slack app token", appSecret);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
      const checkRefusal = credentialsPanel.getByText(
        "Could not check the saved Configuration. Try again before saving channel Secrets. Request ID: req_00000000-0000-4000-8000-000000000434",
        { exact: true },
      );
      await checkRefusal.first().waitFor();
      assert.equal(await checkRefusal.count(), 1);
      assert.equal(await credentialsPanel.getByText(refusalText).count(), 0);
      assert.equal(pathRequests(requests, "PATCH", configurationPath).length, writesBeforeCheck);
      await page.unroute(`${fixture.origin}${configurationPath}`, refusedCheck);
      const previousConfigurationWrites = pathRequests(requests, "PATCH", configurationPath).length;
      await page.route(`${fixture.origin}${configurationPath}`, (route) =>
        route.request().method() === "PATCH"
          ? route.fulfill({
              status: 403,
              contentType: "application/json",
              body: JSON.stringify({
                error: { code: "FORBIDDEN", message: "denied" },
                meta: { requestId: "req_00000000-0000-4000-8000-000000000433" },
              }),
            })
          : route.continue(),
      );
      await selectSecret(page, "Slack app token", appSecret);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
      const denial = credentialsPanel.getByText(
        // The refused Configuration update names its grants (finding 1839).
        `${refusalText} Request ID: req_00000000-0000-4000-8000-000000000433`,
        { exact: true },
      );
      await denial.first().waitFor();
      assert.equal(await denial.count(), 1);
      assert.equal(
        pathRequests(requests, "PATCH", configurationPath).length,
        previousConfigurationWrites + 1,
      );
      await waitForEnabled(deploy);
    }
  });
}

for (const changed of ["generation", "identity"]) {
  test(`Channel Secret save rejects a stale Configuration ${changed} before writing`, async (t) => {
    const { fixture, namespace, modelSecret, grantModelAccess, grantSecretAccess } =
      await createConsoleRepositoryLaunchFixture(t, { secretDriver: createTestSecretDriver() });
    const appSecret = await fixture.createSecret(namespace.id, "Slack app", "xapp-original");
    const botSecret = await fixture.createSecret(namespace.id, "Slack bot", "xoxb-original");
    const replacementSecret = await fixture.createSecret(
      namespace.id,
      "Slack app replacement",
      "xapp-replacement",
    );
    const values = createHarnessConfiguration("codex", "gpt-5.1");
    values.channels = {
      slack: { enabled: true, mode: "socket", channels: { COLD: { requireMention: true } } },
    };
    const configuration = await fixture.createConfiguration(namespace.id, values, {
      secretBindings: {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      },
    });
    const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "Stale channel Secret",
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "api_key", source: modelSecret.ref },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const agent = created.data;
    await grantModelAccess(agent);
    for (const secret of [appSecret, botSecret]) {
      await grantSecretAccess(agent, secret);
    }
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    assert.equal(
      (
        await fixture.request("POST", `${path}/runtime-credentials`, {
          headers: { origin: fixture.origin },
          body: {},
        })
      ).status,
      200,
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
    );
    await page.getByText("Ready to deploy.", { exact: true }).waitFor();
    const deploy = page.getByRole("button", { name: "Deploy new version" });
    await waitForEnabled(deploy);
    await selectSecret(page, "Slack app token", replacementSecret);

    const configurationPath = `/namespaces/${namespace.id}/configurations/${configuration.id}`;
    const secretPath = `/namespaces/${namespace.id}/secrets/${appSecret.id}`;
    if (changed === "generation") {
      await page.route(`${fixture.origin}${configurationPath}`, (route) =>
        route.fulfill({ status: 503, body: "Unavailable" }),
      );
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
      await page
        .getByText(
          "Could not check the saved Configuration. Try again before saving channel Secrets.",
        )
        .first()
        .waitFor();
      assert.equal(pathRequests(requests, "PATCH", secretPath).length, 0);
      // The failed save re-renders the panel; its pickers reload the Secret list before naming.
      await waitForInputValue(page.getByLabel("Slack app token"), secretOptionLabel(appSecret));
      await waitForEnabled(deploy);
      await page.unroute(`${fixture.origin}${configurationPath}`);
      await selectSecret(page, "Slack app token", replacementSecret);
    }

    // Another operator changes the shared Configuration after this page was opened.
    const newerValues = structuredClone(values);
    newerValues.channels.slack.channels = { CNEW: { requireMention: false } };
    if (changed === "generation") {
      const updated = await fixture.request("PATCH", configurationPath, {
        body: { values: newerValues },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
    } else {
      const replacement = await fixture.createConfiguration(namespace.id, newerValues, {
        secretBindings: configuration.secretBindings,
      });
      const updated = await fixture.request("PATCH", path, {
        body: { configurationId: replacement.id },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
    }
    await page.getByRole("button", { name: "Save channel Secrets" }).click();
    // A danger block, so an alert (finding 2005).
    await page
      .getByRole("alert")
      .getByText(CHANNEL_SECRETS_CONFIGURATION_CHANGED, {
        exact: true,
      })
      .waitFor();
    assert.equal(pathRequests(requests, "PATCH", secretPath).length, 0);
    assert.equal(pathRequests(requests, "PATCH", configurationPath).length, 0);
    assert.deepEqual(
      (await fixture.request("GET", configurationPath)).data.values,
      changed === "generation" ? newerValues : values,
    );
    // The chosen Secret stays shown, unsaved, for Reload draft to carry (finding 1512).
    await waitForInputValue(
      page.getByLabel("Slack app token"),
      secretOptionLabel(replacementSecret),
    );
    assert.equal(accessBindingPostRequests(requests, namespace.id).length, 0);
    assert.equal(await deploy.isDisabled(), true);
    assert.equal(
      await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(),
      true,
    );
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    assert.equal(await deploy.isDisabled(), true);
    await page.getByRole("tab", { name: "Credentials", exact: true }).click();
    await page.getByRole("button", { name: "Reload draft", exact: true }).click();
    if (changed === "generation") {
      // Reload draft reapplies the chosen Secret, still unsaved, so Deploy waits for its save
      // (finding 1640).
      await page
        .getByText(
          "Save the channel Secret choices before deploying, or reload the page to discard unsaved changes.",
          {
            exact: true,
          },
        )
        .waitFor();
      assert.equal(await deploy.isDisabled(), true);
      await page.getByRole("button", { name: "Save channel Secrets" }).click();
    }
    await page.getByText("Ready to deploy.", { exact: true }).waitFor();
    await waitForEnabled(deploy);
  });
}

// A dedicated Codex Agent whose Slack tokens are bound, so its draft is ready to deploy.
async function createSlackBoundAgent(fixture, namespace, name, marker) {
  const app = await fixture.createSecret(namespace.id, `${name} app token`, "xapp-draft-guard");
  const bot = await fixture.createSecret(namespace.id, `${name} bot token`, "xoxb-draft-guard");
  const agent = await fixture.createAgent(
    namespace.id,
    name,
    nativeValues(marker, {
      harnessId: "codex",
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          channels: {},
        },
      },
    }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
      },
    },
  );
  return agent;
}

for (const action of ["disable", "drawer"]) {
  test(`Channel ${action} blocks deployment and navigation while its Configuration write is pending`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace(`Pending channel ${action}`, { ready: true });
    const otherNamespace = await fixture.createNamespace(`Other ${action}`, { ready: true });
    const agent = await createSlackBoundAgent(
      fixture,
      namespace,
      `Pending channel ${action} Agent`,
      "pending-channel",
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const patch = await holdRequests(t, page, `**${configurationPath}`, {
      method: "PATCH",
      timeout: 0,
    });
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
    await login(page, fixture, url);
    await page.locator("button:not([disabled])", { hasText: "Deploy new version" }).waitFor();
    assert.equal(
      await page
        .locator(".channels-section")
        .evaluate((section) =>
          [...section.childNodes].some(
            (node) =>
              node.nodeType === globalThis.Node.TEXT_NODE && node.textContent.trim() === "null",
          ),
        ),
      false,
    );
    const deploy = page.getByRole("button", { name: "Deploy new version" });
    await waitForEnabled(deploy);
    if (action === "disable") {
      await page.getByRole("button", { name: "Disable Slack" }).click();
    } else {
      await page.getByRole("button", { name: "Edit Slack" }).click();
      await setSlackSelection(
        page.getByRole("combobox", { name: "Channels", exact: true }),
        "CPENDING123",
      );
      await setSlackSelection(
        page.getByRole("combobox", { name: "Allowed people in these channels", exact: true }),
        "UPENDING123",
      );
      await page.getByRole("button", { name: "Save configuration" }).click();
    }
    await patch.requested;
    // The write has not reached the server; Deploy must not capture the old draft.
    try {
      assert.equal(await deploy.isDisabled(), true);
      assert.equal(
        await page.getByRole("tab", { name: "Configuration", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`)
          .length,
        0,
      );
      await page.evaluate(() => {
        const next = new URL(globalThis.location.href);
        next.searchParams.set("tab", "configuration");
        globalThis.history.pushState(globalThis.history.state, "", next);
        globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
      });
      assert.equal(new URL(page.url()).searchParams.get("tab"), "channels");
      // The same note holds ← Agents and the Namespace selector (finding 1902). The open
      // drawer is modal, so only the disable path can reach them.
      if (action === "disable") {
        const pageUrl = page.url();
        await page.getByRole("link", { name: "← Agents" }).click();
        await page
          .getByText("Wait for channel settings save to finish before leaving the editor.")
          .waitFor();
        assert.equal(page.url(), pageUrl);
        const selector = page.getByLabel("Namespace", { exact: true });
        await selector.selectOption(otherNamespace.id);
        assert.equal(await selector.inputValue(), namespace.id);
        assert.equal(page.url(), pageUrl);
        assert.equal(await page.getByRole("heading", { name: "Agents", exact: true }).count(), 0);
      }
    } finally {
      patch.release();
    }
    await page.getByText(/Configuration .*generation 2/).waitFor();
    await waitForEnabled(deploy);
  });
}

test("Channel save with a lost response blocks deployment until the draft is reloaded", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Uncertain channel save", { ready: true });
  const agent = await createSlackBoundAgent(
    fixture,
    namespace,
    "Uncertain channel Agent",
    "uncertain-channel",
  );
  const { page } = await newPage(t, fixture);
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    // The API commits, but the browser cannot know that the response was lost.
    assert.equal((await route.fetch()).status(), 200);
    await route.abort("failed");
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
  await login(page, fixture, url);
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
  await page.getByRole("button", { name: "Disable Slack" }).click();
  await page
    .getByText(/Outcome unknown/)
    .first()
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.equal(
    await page.getByRole("tab", { name: "Configuration", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Reload draft" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();
  const saved = await fixture.request("GET", configurationPath);
  assert.equal(saved.data.values.channels.slack.enabled, false);
});

test("Channel Secrets withholds access grants when the save response contains other bindings", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unconfirmed channel bindings", { ready: true });
  const agent = await createSlackBoundAgent(fixture, namespace, "Unconfirmed Agent", "unconfirmed");
  const replacement = await fixture.createSecret(
    namespace.id,
    "Replacement app token",
    "synthetic",
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const path = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const original = await fixture.request("GET", path);
  assert.equal(original.status, 200);
  await page.route(`**${path}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      return route.continue();
    }
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const body = await response.json();
    const bindings = body.data.secretBindings;
    assert.equal(bindings.SLACK_APP_TOKEN.source.id, replacement.id);
    // Keep the new generation but replace the returned bindings with those from before the save.
    body.data.secretBindings = original.data.secretBindings;
    await route.fulfill({ response, json: body });
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await selectSecret(page, "Slack app token", replacement);
  const save = page.getByRole("button", { name: "Save channel Secrets" });
  await save.click();
  await page
    .getByText("Outcome unknown. Reload this Agent to confirm the saved Secret bindings.", {
      exact: true,
    })
    .waitFor({ timeout: 5_000 });
  assert.equal(await save.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  await page.getByRole("button", { name: "Reload draft" }).click();
  await waitForInputValue(page.getByLabel("Slack app token"), replacement.name);
  assert.equal(pathRequests(requests, "PATCH", path).length, 1);
  assert.equal(accessBindingPostRequests(requests, namespace.id).length, 0);
});

test("Agent credentials block tab changes until Slack Secret grants finish", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime Slack navigation grant", {
    ready: true,
  });
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Navigation Slack app token",
    "hidden-navigation-app",
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Navigation Slack bot token",
    "hidden-navigation-bot",
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CNAVIGATE123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Runtime Slack Navigation Agent",
    nativeValues("runtime-slack-navigation", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const patch = await holdRequests(
    t,
    page,
    `**/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    { method: "PATCH", afterServer: true, timeout: 0 },
  );
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Runtime Slack Navigation Agent" }).waitFor();
  requests.length = 0;
  await selectSecret(page, "Slack app token", slackAppSecret);
  await selectSecret(page, "Slack bot token", slackBotSecret);
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await patch.requested;
  const channelsTab = page.getByRole("tab", { name: "Channels", exact: true });
  assert.equal(await channelsTab.isDisabled(), true);
  patch.release();
  await waitForCondition(
    () => accessBindingPostRequests(requests, namespace.id).length === 2,
    "expected saved Slack Secret grants to finish",
  );
  await page
    .getByText("Channel Secret bindings saved. Deploy the new version to deliver them.")
    .waitFor();
  await channelsTab.click();
  await page.getByRole("button", { name: "Edit Slack", exact: true }).waitFor();

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: slackAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: slackBotSecret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [slackAppSecret.id, slackBotSecret.id],
  );
});

test("Agent deployment guides a rejected model credential and gates unsaved authentication edits", async (t) => {
  const { fixture, namespace, agent, path } = await deployableRepositoryAgent(
    t,
    "Rejected credential",
  );
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const failure = await routeFailedDeployment(page, fixture, {
    namespaceId: namespace.id,
    agentId: agent.id,
    deploymentId: revision.id,
    code: "RUNTIME_AUTHENTICATION_FAILED",
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
  await login(page, fixture, url);

  const activity = page.locator(".deployment-status");
  // The API's message carries the next step, so occ and HTTP clients get it too (finding
  // 1393); the console shows it once, in the failure's card, and adds only the link to
  // Credentials. The card folds Deployment details, which repeat it (finding 2094).
  assert.match(
    failure.message,
    /^The model provider rejected this version's credential \(HTTP 401 or 403\)\. .*update or replace the Agent's model credential, then deploy a new version\.$/,
  );
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery.getByText(failure.message, { exact: false }).waitFor();
  assert.equal(
    await activity
      .getByText(`RUNTIME_AUTHENTICATION_FAILED: ${failure.message}`, { exact: true })
      .isVisible(),
    false,
  );
  assert.match(
    await recovery.getByRole("link", { name: "Open Credentials" }).getAttribute("href"),
    /tab=credentials/,
  );
  // The draft has no Logs tab, so the failure links to the failed version's output.
  assert.match(
    await recovery
      .getByRole("link", { name: `Open v${revision.revision} Logs` })
      .getAttribute("href"),
    new RegExp(`revision=${revision.id}&tab=logs`),
  );
  // Secret values can be updated in place, so the rejected binding warns instead of blocking.
  // It never reads "Ready to deploy.", and the next step keeps the credentials step open:
  // deploying again does not fix a rejected credential (UX spec 3.7).
  await page
    .getByText(
      "The last deployment's model credential was rejected; update or replace it in Credentials before deploying again.",
      { exact: true },
    )
    .waitFor();
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await waitForEnabled(deploy);
  const nextStep = page.locator(".agent-draft-actions");
  assert.equal(await nextStep.getByText("Ready to deploy.").count(), 0);
  const credentialStep = nextStep.getByRole("listitem").filter({
    hasText: "Check authentication and credentials",
  });
  assert.equal(await credentialStep.getAttribute("data-state"), "pending");
  assert.equal(
    await credentialStep.locator(".checklist-detail").textContent(),
    "The last deployment's model credential was rejected",
  );

  // Creating a Secret from the picker stages it without reopening the listbox over Save.
  const apiKeySecret = page.getByLabel("API key Secret", { exact: true });
  await apiKeySecret.fill("no matching create target");
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create harness authentication Secret" });
  await dialog.getByLabel("Name", { exact: true }).fill("Replacement model key");
  await dialog.getByLabel("Value", { exact: true }).fill("replacement-model-key");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  assert.equal(await page.locator("#harness-auth-secret-listbox").isHidden(), true);
  assert.equal(await apiKeySecret.getAttribute("aria-expanded"), "false");
  await page
    .getByText("Save or reload the authentication source in Credentials before deploying.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await deploy.isDisabled(), true);

  const saved = page.waitForResponse(
    (response) => response.url().endsWith(path) && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal((await saved).status(), 200);
  // The saved binding differs from the rejected version's, so the warning clears.
  await page.getByText("Ready to deploy.", { exact: true }).waitFor();
  await waitForEnabled(deploy);
  assert.equal(await credentialStep.getAttribute("data-state"), "done");
});

test("a reload asks first while an Agent editor holds unsaved work", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unsaved reload", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Unsaved reload Agent",
    nativeValues("unsaved-reload"),
  );
  const { page } = await newPage(t, fixture);
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.type());
    await dialog.accept();
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const edit = page.getByRole("button", { name: "Edit Configuration" });
  const editor = page.getByLabel("Configuration JSON", { exact: true });
  await edit.click();
  await editor.waitFor();
  // An open but unchanged editor has nothing to lose (finding 1902).
  await page.reload();
  await edit.waitFor();
  assert.deepEqual(dialogs, []);

  await edit.click();
  await editor.fill('{"edited": true}');
  // The edit stays a draft while another page is shown; a reload would still lose it.
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
  assert.deepEqual(dialogs, ["beforeunload"]);
});
