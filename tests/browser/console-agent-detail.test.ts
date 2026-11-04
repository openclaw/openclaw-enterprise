import "./console-agent-detail-deployment.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Locator, Page, Route, Request } from "playwright";
import type { TSchema } from "typebox";
import { IsSchema } from "typebox/schema";
import { Check } from "typebox/value";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import type { ControllerWorkspaceFileReadRequest } from "../../apps/controller/src/gateway/contracts.ts";
import {
  AgentResponse,
  AgentRevisionResponse,
  AgentRevisionListResponse,
  AgentCallerPermissionsResponse,
  AgentSecretPermissionsResponse,
  ConfigurationResponse,
  SecretResponse,
  SecretDetailResponse,
  SecretListResponse,
  IAMAccessBindingListResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { apiErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  accessBindingPostRequests,
  accessibleDescription,
  AGENT_READ,
  apiRequests,
  deniedCreateSecretOption,
  detailUrl,
  expectNoText,
  expectReachableReason,
  expireSessionsWhenSettled,
  grantMember,
  grantSecretOperate,
  hasFocus,
  holdRequests,
  isMaskedSecretValue,
  login,
  MEMBER_WRITE,
  nativeValues,
  newPage,
  nextFrames,
  nonAuthWriteRequests,
  operateDeniedSecretOption,
  pathRequests,
  persistedDeploymentError,
  recordLayoutShifts,
  revealNativeConfiguration,
  revokeMemberGrant,
  secretOptionLabel,
  secretPostRequests,
  selectSecret,
  settledFetches,
  settlePageRequests,
  statusTone,
  takeLayoutShifts,
  trackSettledFetches,
  versionChooser,
  waitForChosenVersion,
  waitForEnabled,
  waitForInputValue,
  waitForSettledFetches,
} from "./console-agents-browser-helpers.mjs";
import { FIRST_ACTIVITY_WAIT_MS } from "../../apps/controller/src/console/agents/detail.mts";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import {
  LIVE_BUTTON,
  openAdvancedSettings,
  withholdPermissionSummary,
  agentStopRequests,
  replyWithDifferentAgentId,
  configurationPatchRequests,
} from "./console-agents-test-support.mjs";
import {
  AGENT_CREATE_DENIED,
  AGENT_DEPLOY_NOT_INCLUDED,
  AGENT_SOURCES_DENIED,
  AGENT_UPDATE_DENIED,
  CONFIGURATION_EDITS_PENDING,
  CONFIGURATION_UPDATE_DENIED,
  CONSOLE_NAMESPACE_NOT_READY,
  CONFIGURATION_SAVE_DENIED,
  GENERIC_DENIAL,
  NAMESPACE_NOT_READY,
  NEW_SECRET_OPERATE_DENIED,
  NEW_SECRET_OPERATE_REMEDY,
  RESOURCE_CONFLICT,
  SECRET_CREATE_DENIED,
  SECRET_NAME_CONFLICT,
  SECRET_OPERATE_DENIED,
  STOP_CONFIRMATION,
  STOP_REPEAT_CONFIRMATION,
  STOP_REQUESTED,
  STOP_RUNNING_VERSION,
  STOP_STATUS_REFRESH_FAILED,
  STOPPED_NO_VERSION,
  WORKSPACE_FILES_UNAVAILABLE,
  credentialCheckedAtDeploy,
  namespaceListDenied,
  notIncluded,
  secretOperateRefused,
  stopRefused,
  stopStatusRefreshFailed,
  PLUGINS_READ_ONLY,
  READ_ONLY_DRAFT_NOTICE,
} from "../helpers/refusal-text.mjs";
import { liftRestriction, restrict } from "../helpers/iam-grants.mjs";

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;

function wireBody<T extends TSchema>(fixture: ConsoleFixture, schema: T, value: unknown) {
  const schemas = Object.fromEntries(
    Object.entries(fixture.app.getSchemas()).map(([id, entry]): [string, TSchema] => {
      assert.ok(IsSchema(entry));
      return [id, entry];
    }),
  );
  assert.ok(Check(schemas, schema, value), "Expected the controller response schema");
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}

function bindingSource(configuration: ConfigurationResponse["data"], key: string) {
  const binding = configuration.secretBindings?.[key];
  assert.ok(binding, `Expected Secret binding ${key}`);
  return binding.source;
}

function secretSource(auth: AgentResponse["data"]["harnessAuth"]) {
  assert.ok(auth && "source" in auth && auth.source.kind === "secret");
  return auth.source;
}

function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

declare global {
  interface Window {
    reloadedText?: (string | null)[];
    __createStates?: ("disabled" | "enabled")[];
  }
}

test("Agent credentials choose existing Secrets for harness authentication", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Harness Secret picker", { ready: true });
  const originalSecret = await fixture.createSecret(
    namespace.id,
    "Original harness Secret",
    "hidden-original-harness",
  );
  const replacementSecret = await fixture.createSecret(
    namespace.id,
    "Replacement harness Secret",
    "hidden-replacement-harness",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Harness Picker Agent",
    nativeValues("harness-picker", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: originalSecret.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Harness Picker Agent" }).waitFor();
  requests.length = 0;
  await selectSecret(page, "API key Secret", replacementSecret);
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  const saveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal((await saveResponse).status(), 200);
  // The saved source re-renders the picker, which reloads the Secret list before naming it.
  // The old, disabled picker already shows the staged Secret, so wait for the rebuilt form.
  await page.waitForFunction(() => {
    const method = globalThis.document.querySelector("#harness-auth-method");
    return method instanceof HTMLSelectElement && method.disabled === false;
  });
  await waitForInputValue(page.getByLabel("API key Secret"), secretOptionLabel(replacementSecret));

  const current = wireBody(
    fixture,
    AgentResponse,
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).body,
  );
  assert.deepEqual(current.data.harnessAuth, {
    method: "api_key",
    source: replacementSecret.ref,
  });
  assert.deepEqual(secretPostRequests(requests, namespace.id), []);

  await page.getByLabel("Authentication source").selectOption("codex_pat");
  const serviceAccountSecret = page.getByLabel("Service account token Secret");
  assert.equal(
    await serviceAccountSecret.evaluate((node) => {
      if (!(node instanceof HTMLInputElement)) {
        throw new Error("Expected an input");
      }
      return node.value;
    }),
    "",
  );
  await page.getByLabel("Authentication source").selectOption("api_key");
  await waitForInputValue(page.getByLabel("API key Secret"), secretOptionLabel(replacementSecret));

  await page.route(`**/namespaces/${namespace.id}/secrets`, async (route) => {
    await route.fulfill({ status: 403, contentType: "application/json", body: "{}" });
  });
  await page.reload();
  // A refused Secret list names the Namespace read it checks, not a bare "Access denied".
  const unavailableSecrets = page.getByText(
    `Secrets unavailable. ${namespaceListDenied("Secrets")}`,
    { exact: true },
  );
  await unavailableSecrets.waitFor();
  assert.deepEqual(await statusTone(unavailableSecrets), {
    className: "status",
    tone: "danger",
    role: "alert",
  });
  const unreadableSecret = page.getByLabel("API key Secret", { exact: true });
  assert.equal(await unreadableSecret.inputValue(), "Bound Secret");
  await unreadableSecret.click();
  await page.getByRole("option", { name: "Bound Secret", exact: true }).waitFor();
  // A Secret no list read shows gets no metadata link (finding D757).
  assert.equal(
    await page.getByRole("link", { name: /View harness authentication Secret metadata/ }).count(),
    0,
  );
});

test("Agent credentials bind a Secret typed by its exact name without picking the suggestion", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Typed Secret name", { ready: true });
  const originalSecret = await fixture.createSecret(namespace.id, "Original key", "hidden-a");
  const typedSecret = await fixture.createSecret(namespace.id, "Typed key", "hidden-b");
  const enteredSecret = await fixture.createSecret(namespace.id, "Entered key", "hidden-c");
  const agent = await fixture.createAgent(
    namespace.id,
    "Typed Secret Agent",
    nativeValues("typed-secret", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: originalSecret.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
  await login(page, fixture, url);
  await page.getByText("Choose an existing Secret or create a new one.").waitFor();
  const picker = page.getByLabel("API key Secret", { exact: true });
  const savedSource = async () =>
    secretSource(
      wireBody(
        fixture,
        AgentResponse,
        (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).body,
      ).data.harnessAuth,
    );
  // A successful save checks Secret access, then re-renders the tab. Until the new picker has
  // loaded the Secrets again it can only restore "Bound Secret", so wait for that load.
  const save = async () => {
    const savedPicker = await picker.elementHandle();
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}`) &&
        response.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Save authentication source" }).click();
    assert.equal((await saved).status(), 200);
    await page.waitForFunction((node) => !node.isConnected, savedPicker);
    await page.getByText("Choose an existing Secret or create a new one.").waitFor();
  };

  // Clicking Save straight after typing the full name used to keep the old Secret silently.
  await picker.fill(typedSecret.name);
  await save();
  assert.deepEqual(await savedSource(), typedSecret.ref);
  assert.equal(await picker.inputValue(), typedSecret.name);

  // Enter commits an exact name the same way, before any save.
  await picker.fill(`  ${enteredSecret.name} `);
  await picker.press("Enter");
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  assert.equal(await picker.inputValue(), enteredSecret.name);
  await save();
  assert.deepEqual(await savedSource(), enteredSecret.ref);

  // A partial name is not a choice: leaving the field restores the bound Secret.
  await picker.fill("Origin");
  await picker.blur();
  assert.equal(await picker.inputValue(), enteredSecret.name);
});

test("Agent credential Secret picker distinguishes action labels from Secret names", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Secret action names", { ready: true });
  const original = await fixture.createSecret(namespace.id, "Hidden binding", "original-value");
  const bound = await fixture.createSecret(namespace.id, "Bound Secret", "bound-value");
  await fixture.createSecret(namespace.id, "No Secret bound", "none-value");
  const create = await fixture.createSecret(namespace.id, "Create new Secret...", "create-value");
  await fixture.createSecret(namespace.id, "Create new Secret... (action)", "action-value");
  await fixture.createSecret(
    namespace.id,
    "Create new Secret... (action)  (action)",
    "whitespace-value",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Action Name Agent",
    nativeValues("secret-action-names", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: original.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await page.route(`**/namespaces/${namespace.id}/secrets`, async (route) => {
    const response = await route.fetch();
    const body = wireBody(fixture, SecretListResponse, await response.json());
    body.data = body.data.filter((secret) => secret.id !== original.id);
    await route.fulfill({ response, json: body });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Action Name Agent" }).waitFor();
  const apiKey = page.getByLabel("API key Secret", { exact: true });
  await apiKey.click();
  await page.getByRole("option", { name: "Bound Secret (current binding)", exact: true }).waitFor();
  await page.getByRole("option", { name: "Bound Secret", exact: true }).click();
  assert.equal(await apiKey.inputValue(), bound.name);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal((await saved).status(), 200);
  const current = wireBody(
    fixture,
    AgentResponse,
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).body,
  );
  assert.deepEqual(secretSource(current.data.harnessAuth), bound.ref);

  await page.getByLabel("Authentication source").selectOption("codex_pat");
  const token = page.getByLabel("Service account token Secret", { exact: true });
  await token.click();
  await page.getByRole("option", { name: "No Secret bound (no binding)", exact: true }).waitFor();
  await page.getByRole("option", { name: "No Secret bound", exact: true }).waitFor();
  await page
    .getByRole("option", { name: "Create new Secret... (action) (action) (action)", exact: true })
    .waitFor();
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  assert.equal(await token.inputValue(), create.name);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await token.press("ArrowDown");
  await page
    .getByRole("option", { name: "Create new Secret... (action) (action) (action)", exact: true })
    .click();
  await page.getByRole("dialog", { name: "Create harness authentication Secret" }).waitFor();
});

test("Tab leaves a scrolling Secret list for the next control, and the list keeps focus in the picker", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Scrolling Secret list", { ready: true });
  const secrets = [];
  // Nine readable Secrets overflow the open list, which then scrolls.
  for (let index = 1; index <= 9; index += 1) {
    secrets.push(
      await fixture.createSecret(namespace.id, `Scrolling Secret ${index}`, `value-${index}`),
    );
  }
  assert.ok(secrets[0]);
  assert.ok(secrets[8]);
  const agent = await fixture.createAgent(
    namespace.id,
    "Scrolling List Agent",
    nativeValues("scrolling-secret-list", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: secrets[0].ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByText("Choose an existing Secret or create a new one.").waitFor();
  const picker = page.getByLabel("API key Secret", { exact: true });
  const listbox = page.getByRole("listbox", { name: "Available Secrets" });
  await picker.focus();
  await listbox.waitFor();
  assert.ok(await listbox.evaluate((node) => node.scrollHeight > node.clientHeight));

  // The list is not a Tab stop: focus used to enter it, the list hid, and focus fell to the
  // page (finding 1919).
  await picker.fill("Scrolling");
  await page.keyboard.press("Tab");
  assert.equal(
    await hasFocus(page.getByRole("link", { name: /View harness authentication Secret metadata/ })),
    true,
  );
  await listbox.waitFor({ state: "hidden" });
  assert.equal(await picker.inputValue(), secrets[0].name);

  // Focus that still reaches the list, as a press on its scrollbar can, returns to the input
  // with the list and the search kept.
  await page.keyboard.press("Shift+Tab");
  await picker.fill("Secret 9");
  await listbox.focus();
  assert.equal(await hasFocus(picker), true);
  assert.equal(await picker.inputValue(), "Secret 9");
  assert.deepEqual(await listbox.getByRole("option").allTextContents(), [
    secrets[8].name,
    "Create new Secret...",
    "Refresh Secret list",
  ]);
  await page.keyboard.press("Escape");
  await listbox.waitFor({ state: "hidden" });
});

// A failed list read must not replace the staged hint with an error either (finding 1748).
for (const listOutcome of ["arrives", "fails"]) {
  test(`a Secret created before the picker's Secret list ${listOutcome} stays staged and listed`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Slow Secret list", { ready: true });
    const original = await fixture.createSecret(namespace.id, "Original binding", "original-value");
    const agent = await fixture.createAgent(
      namespace.id,
      "Slow List Agent",
      nativeValues("slow-secret-list", { harnessId: "codex" }),
      { harnessAuth: { method: "api_key", source: original.ref }, executionMode: "dedicated" },
    );
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    const secretsPath = `/namespaces/${namespace.id}/secrets`;
    // The API answers the list read; the page sees that answer only after the create.
    const { promise: listGate, resolve: releaseList } = Promise.withResolvers<void>();
    t.after(() => releaseList());
    let listReads = 0;
    await page.route(`${fixture.origin}${secretsPath}`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      listReads += 1;
      const response = await route.fetch();
      await listGate;
      await route.fulfill(
        listOutcome === "arrives"
          ? { response }
          : { status: 500, contentType: "application/json", body: "{}" },
      );
    });
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
    const apiKeySecret = page.getByLabel("API key Secret", { exact: true });
    await apiKeySecret.fill("no matching create target");
    const create = page.getByRole("option", { name: "Create new Secret...", exact: true });
    await apiKeySecret.press("ArrowDown");
    assert.equal(
      await apiKeySecret.getAttribute("aria-activedescendant"),
      await create.getAttribute("id"),
    );
    assert.equal(await hasFocus(apiKeySecret), true);
    await apiKeySecret.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Create harness authentication Secret" });
    await dialog.getByLabel("Name", { exact: true }).fill("Created while loading");
    await dialog.getByLabel("Value", { exact: true }).fill("created-while-loading");
    await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const staged = page.getByText("Secret binding staged. Save changes to apply it.");
    await staged.waitFor();
    assert.equal(await hasFocus(apiKeySecret), true);
    assert.equal(await apiKeySecret.getAttribute("aria-expanded"), "false");
    assert.ok(listReads > 0);
    releaseList();
    // Every held list read and the create have now reached the page's own code.
    await waitForSettledFetches(page, secretsPath, listReads + 1);
    assert.equal(await staged.count(), 1);
    assert.equal(await hasFocus(apiKeySecret), true);
    assert.equal(await apiKeySecret.getAttribute("aria-expanded"), "false");
    assert.deepEqual(await statusTone(staged), { className: "hint", tone: null, role: "status" });
    const created = wireBody(
      fixture,
      SecretListResponse,
      (await fixture.request("GET", secretsPath)).body,
    ).data.find((secret) => secret.name === "Created while loading");
    assert.ok(created);
    assert.equal(await apiKeySecret.inputValue(), secretOptionLabel(created));
    await apiKeySecret.fill("Created while");
    await page
      .getByRole("option", { name: text(secretOptionLabel(created)), exact: true })
      .waitFor();
  });
}

test("a different Secret in a create response cannot stage a binding or repeat the write", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unconfirmed Secret", { ready: true });
  const original = await fixture.createSecret(namespace.id, "Original picker Secret", "synthetic");
  const agent = await fixture.createAgent(
    namespace.id,
    "Unconfirmed picker Agent",
    nativeValues("unconfirmed-picker", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: original.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  const picker = page.getByLabel("API key Secret", { exact: true });
  await waitForInputValue(picker, original.name);
  const path = `/namespaces/${namespace.id}/secrets`;
  const name = "New picker Secret";
  await page.route(`**${path}`, async (route, request) => {
    if (request.method() !== "POST") {
      return route.continue();
    }
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    const body = wireBody(fixture, SecretResponse, await response.json());
    assert.equal(body.data.name, name);
    // The create succeeded. Substitute valid metadata for a different Secret in its reply.
    await route.fulfill({ response, json: { ...body, data: original } });
  });
  await picker.fill("no matching Secret");
  const create = page.getByRole("option", { name: "Create new Secret...", exact: true });
  await create.click();
  const dialog = page.getByRole("dialog", { name: "Create harness authentication Secret" });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  const value = dialog.getByLabel("Value", { exact: true });
  await value.fill("synthetic-new-value");
  const submit = dialog.getByRole("button", { name: "Create Secret", exact: true });
  await submit.click();
  await dialog
    .getByText("Secret creation outcome could not be confirmed.", { exact: false })
    .waitFor({ timeout: 5_000 });
  assert.equal(await value.inputValue(), "");
  assert.equal(await submit.isDisabled(), true);
  await submit.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement) || !button.form) {
      throw new Error("Expected a form button");
    }
    button.form.requestSubmit();
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await waitForInputValue(picker, original.name);
  assert.equal(secretPostRequests(requests, namespace.id).length, 1);
});

// The Secrets page disables Create Secret when the Namespace's permission answer denies Secret
// create; the inline Create Secret action in the Credentials tab offered the same refused write
// (finding 2442). It stays listed, disabled with the reason, until a grant.
test("the Credentials tab's inline Create Secret follows the Secret create answer", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Inline create answer", { ready: true });
  const bound = await fixture.createSecret(namespace.id, "Bound harness Secret", "synthetic");
  const agent = await fixture.createAgent(
    namespace.id,
    "Inline create Agent",
    nativeValues("inline-create", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: bound.ref }, executionMode: "dedicated" },
  );
  const member = await fixture.createNamespaceMember(
    "inline-create-member",
    namespace.id,
    MEMBER_WRITE.filter(([action, kind]) => !(action === "create" && kind === "secret")),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  const picker = page.getByLabel("API key Secret", { exact: true });
  await waitForInputValue(picker, bound.name);
  await waitForEnabled(picker);
  await picker.fill("no matching Secret");
  const denied = page.getByRole("option", {
    name: `Create new Secret... ${SECRET_CREATE_DENIED}`,
    exact: true,
  });
  await denied.waitFor();
  assert.equal(await denied.getAttribute("aria-disabled"), "true");
  // A forced click skips the disabled check: choosing the action still opens nothing.
  await denied.click({ force: true });
  assert.equal(await page.getByRole("dialog").count(), 0);
  await picker.press("Escape");
  await page.getByText(`Choose an existing Secret. ${SECRET_CREATE_DENIED}`).waitFor();
  assert.equal(secretPostRequests(requests, namespace.id).length, 0);

  // A Secret create grant restores the action on the next page load.
  grantMember(fixture, "inline-create-member", [["create", "secret"]]);
  await page.reload();
  await waitForInputValue(picker, bound.name);
  await waitForEnabled(picker);
  await picker.fill("no matching Secret");
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  await page.getByRole("dialog", { name: "Create harness authentication Secret" }).waitFor();
});

test("session expiry clears the unsent value in the Secret picker dialog", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Secret picker session expiry", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Expiring picker Agent",
    nativeValues("expiring-picker", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  // Let the picker open before its list read discovers the session has expired.
  const path = `/namespaces/${namespace.id}/secrets`;
  const list = await holdRequests(t, page, `**${path}`);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByLabel("API key Secret", { exact: true }).fill("no matching Secret");
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create harness authentication Secret" });
  const field = dialog.getByLabel("Value", { exact: true });
  await field.fill("synthetic-unsent-value");
  const input = await field.evaluateHandle((node) => node);
  // Only the held list read may find the expiry: another read that found it first would sign
  // the page out and abort the held read, which then never answers.
  await expireSessionsWhenSettled(page, fixture, { except: path });
  const refused = page.waitForResponse((response) => new URL(response.url()).pathname === path);
  list.release();
  assert.equal((await refused).status(), 401);
  await page.getByText("Your session has expired").waitFor();
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    await input.evaluate((node) => {
      if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement)) {
        throw new Error("Expected a Secret value field");
      }
      return node.value === "";
    }),
    true,
  );
  assert.equal(secretPostRequests(requests, namespace.id).length, 0);
});

test("Agent credential Secret picker searches, validates, and preserves duplicate create input", async (t) => {
  const secretDriver = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, { secretDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Credential Secret picker UX", { ready: true });
  const originalSecret = await fixture.createSecret(
    namespace.id,
    "Original picker Secret",
    "hidden-original-picker",
  );
  const keyboardSecret = await fixture.createSecret(
    namespace.id,
    "Keyboard replacement Secret",
    "hidden-keyboard-picker",
  );
  const duplicateNameSecret = await fixture.createSecret(
    namespace.id,
    "Duplicate picker Secret",
    "hidden-duplicate-picker",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Combobox Agent",
    nativeValues("credential-picker-ux", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: originalSecret.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Combobox Agent" }).waitFor();
  const apiKeySecret = page.getByLabel("API key Secret", { exact: true });
  await apiKeySecret.fill(keyboardSecret.id);
  await page.getByRole("option", { name: keyboardSecret.name, exact: true }).waitFor();
  await apiKeySecret.fill("keyboard");
  const keyboardOption = page.getByRole("option", {
    name: text(secretOptionLabel(keyboardSecret)),
    exact: true,
  });
  await apiKeySecret.press("ArrowDown");
  assert.equal(await keyboardOption.getAttribute("aria-selected"), "false");
  assert.equal(
    await keyboardOption.evaluate((node) => node.classList.contains("secret-typeahead-active")),
    true,
  );
  assert.equal(
    await apiKeySecret.getAttribute("aria-activedescendant"),
    await keyboardOption.getAttribute("id"),
  );
  await apiKeySecret.press("Enter");
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  assert.equal(await apiKeySecret.inputValue(), secretOptionLabel(keyboardSecret));
  await apiKeySecret.fill("");
  assert.equal(await keyboardOption.getAttribute("aria-selected"), "true");
  await apiKeySecret.press("ArrowDown");
  assert.equal(await keyboardOption.getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("listbox").getByRole("option", { selected: true }).count(), 1);
  await apiKeySecret.fill("does-not-exist");
  await page.getByText("No matching Secrets.", { exact: true }).waitFor();
  await apiKeySecret.press("Escape");
  assert.equal(await apiKeySecret.inputValue(), secretOptionLabel(keyboardSecret));

  await page.getByLabel("Authentication source").selectOption("codex_pat");
  const serviceAccountSecret = page.getByLabel("Service account token Secret", { exact: true });
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal(
    await serviceAccountSecret.evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Expected an input");
      }
      return input.validity.customError;
    }),
    true,
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  await serviceAccountSecret.fill("no matching create target");
  await page.getByText("No matching Secrets.", { exact: true }).waitFor();
  await serviceAccountSecret.press("ArrowDown");
  await serviceAccountSecret.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Create harness authentication Secret" });
  await dialog.waitFor();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Combobox Agent harness authentication",
  );
  assert.equal(await isMaskedSecretValue(dialog.getByLabel("Value", { exact: true })), true);
  await dialog.getByLabel("Name", { exact: true }).fill(duplicateNameSecret.name);
  await dialog.getByLabel("Value", { exact: true }).fill("synthetic-duplicate-value");
  const duplicate = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/secrets` &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  assert.equal((await duplicate).status(), 409);
  // The API's own sentence for a taken name (finding 2538).
  await dialog.getByRole("alert").filter({ hasText: SECRET_NAME_CONFLICT }).waitFor();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    duplicateNameSecret.name,
  );
  assert.equal(
    await dialog.getByLabel("Value", { exact: true }).inputValue(),
    "synthetic-duplicate-value",
  );
  assert.equal(secretDriver.valueFor(duplicateNameSecret), "hidden-duplicate-picker");

  // Simulate documented controller conflict responses; duplicate rejection above uses the real route.
  let createStatus = 409;
  let conflictCode = "NAMESPACE_NOT_READY";
  const failSecretCreate = (route: Route, request: Request) => {
    if (request.method() !== "POST") {
      return route.fallback();
    }
    return route.fulfill({
      status: createStatus,
      contentType: "application/json",
      body: JSON.stringify({
        // The API's own messages: a taken name is the generic conflict, so the dialog guesses.
        error: {
          code: conflictCode,
          message: conflictCode === "NAMESPACE_NOT_READY" ? NAMESPACE_NOT_READY : RESOURCE_CONFLICT,
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
      }),
    });
  };
  await page.route(`**/namespaces/${namespace.id}/secrets`, failSecretCreate);
  await dialog.getByLabel("Name", { exact: true }).fill("Namespace not ready picker Secret");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: CONSOLE_NAMESPACE_NOT_READY }).waitFor();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Namespace not ready picker Secret",
  );
  assert.equal(
    await dialog.getByLabel("Value", { exact: true }).inputValue(),
    "synthetic-duplicate-value",
  );

  conflictCode = "RESOURCE_CONFLICT";
  await dialog.getByLabel("Name", { exact: true }).fill("Backend conflict picker Secret");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "Secret creation conflicted" }).waitFor();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Backend conflict picker Secret",
  );
  assert.equal(
    await dialog.getByLabel("Value", { exact: true }).inputValue(),
    "synthetic-duplicate-value",
  );
  assert.equal(await dialog.getByRole("alert").filter({ hasText: "may already exist" }).count(), 1);

  // A denied create is a known rejection: it names the permission and keeps the input editable.
  createStatus = 403;
  conflictCode = "FORBIDDEN";
  await dialog.getByLabel("Name", { exact: true }).fill("Denied picker Secret");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: SECRET_CREATE_DENIED }).waitFor();
  await waitForEnabled(dialog.getByLabel("Name", { exact: true }));
  assert.equal(
    await dialog.getByLabel("Value", { exact: true }).inputValue(),
    "synthetic-duplicate-value",
  );
  await waitForEnabled(dialog.getByRole("button", { name: "Create Secret", exact: true }));
  await page.unroute(`**/namespaces/${namespace.id}/secrets`, failSecretCreate);

  const distinctName = "Combobox Agent corrected service account token";
  await dialog.getByLabel("Name", { exact: true }).fill(distinctName);
  const created = page.waitForResponse((response) => {
    if (
      response.url() !== `${fixture.origin}/namespaces/${namespace.id}/secrets` ||
      response.request().method() !== "POST"
    ) {
      return false;
    }
    const body: unknown = response.request().postDataJSON();
    return isObject(body) && body.name === distinctName;
  });
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  const createdSecret = wireBody(fixture, SecretResponse, await (await created).json()).data;
  await dialog.waitFor({ state: "hidden" });
  assert.notEqual(createdSecret.id, duplicateNameSecret.id);
  assert.equal(createdSecret.name, distinctName);
  assert.equal(secretDriver.valueFor(createdSecret), "synthetic-duplicate-value");
  assert.equal(await serviceAccountSecret.inputValue(), secretOptionLabel(createdSecret));
});

// The shared grant wording for the harness authentication source (findings 1920, 2259).
const HARNESS_GRANT_REFUSED =
  "Authentication source saved, but the request to grant this Agent access to the selected Secret was refused. Granting it needs Installation administration access: ask an Installation administrator to open this Agent's Credentials and select Save authentication source. Select Retry credential access once you have that access.";
// An Installation administrator's console read the IAM policy and found no grant (finding 2260).
const HARNESS_GRANT_MISSING =
  "This Agent has no access to its authentication Secret, so deploying it would be refused. Select Save authentication source to grant it.";
// A member's save sends no grant: the deploy checks the Agent's access (finding D748).
const HARNESS_SAVED_FOR_MEMBER = `Authentication source saved. ${credentialCheckedAtDeploy("Secret")}`;

test("Agent credentials report partial harness Secret grant failure", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Harness Secret grant failure", {
    ready: true,
  });
  const originalSecret = await fixture.createSecret(
    namespace.id,
    "Original denied harness Secret",
    "hidden-denied-original",
  );
  const replacementSecret = await fixture.createSecret(
    namespace.id,
    "Denied harness Secret",
    "hidden-denied-replacement",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Harness Grant Failure Agent",
    nativeValues("harness-grant-failure"),
    { harnessAuth: { method: "api_key", source: originalSecret.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**/namespaces/${namespace.id}/iam/access-bindings`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill(
      apiErrorResponse(403, "FORBIDDEN", "masked IAM denial", {
        requestId: "req_00000000-0000-4000-8000-000000000633",
      }),
    );
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Harness Grant Failure Agent" }).waitFor();
  requests.length = 0;
  await selectSecret(page, "API key Secret", replacementSecret);
  await page.getByRole("button", { name: "Save authentication source" }).click();
  // The grant request itself was refused: the warning says so, names who grants it, and keeps
  // Retry for when the reader's access is restored (finding 2259).
  await page
    .getByText(`${HARNESS_GRANT_REFUSED} Request ID: req_00000000-0000-4000-8000-000000000633`, {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByLabel("Authentication source").isDisabled(), true);
  await waitForEnabled(page.getByRole("button", { name: "Retry credential access" }));
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);

  const current = wireBody(
    fixture,
    AgentResponse,
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).body,
  );
  assert.deepEqual(current.data.harnessAuth, {
    method: "api_key",
    source: replacementSecret.ref,
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map(({ body }) => [
      object(body).subjectId,
      object(body).resourceId,
    ]),
    [[agent.servicePrincipalId, replacementSecret.id]],
  );

  // A denied retry read must retain the prior saved fact, but retire revoked metadata.
  const deniedRead = restrict(fixture.policy, "read", "agent", { resourceId: agent.id });
  requests.length = 0;
  const refusedRead = page.waitForResponse(
    (response) => response.url().endsWith(`/agents/${agent.id}`) && response.status() === 403,
  );
  await page.getByRole("button", { name: "Retry credential access" }).click();
  const requestId = text(object(object(await (await refusedRead).json()).meta).requestId);
  await page
    .getByText(
      "Authentication source saved. Could not read the Agent before retrying credential access. No access grant was sent.",
      { exact: true },
    )
    .waitFor();
  await page.getByText(`Request ID: ${requestId}`, { exact: true }).waitFor();
  assert.equal((await page.locator("body").innerText()).split(requestId).length - 1, 1);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const html = await page.content();
  for (const value of [
    agent.name,
    originalSecret.name,
    originalSecret.id,
    replacementSecret.name,
    replacementSecret.id,
  ]) {
    assert.equal(html.includes(value), false);
  }
  assert.equal(await page.getByRole("button", { name: "Retry credential access" }).count(), 0);
  liftRestriction(fixture.policy, deniedRead);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await waitForEnabled(page.getByRole("button", { name: "Save authentication source" }));
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // Freshly read saved authentication must still refuse a changed service principal.
  const other = await fixture.createAgent(namespace.id, "Other Agent", nativeValues("other"));
  assert.notEqual(other.servicePrincipalId, agent.servicePrincipalId);
  const agentUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`;
  await page.route(agentUrl, async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const { data, meta } = wireBody(fixture, AgentResponse, await response.json());
    assert.equal(data.servicePrincipalId, agent.servicePrincipalId);
    await route.fulfill({
      response,
      json: { data: { ...data, servicePrincipalId: other.servicePrincipalId }, meta },
    });
  });
  requests.length = 0;
  const reread = page.waitForResponse(agentUrl);
  const retry = page.getByRole("button", { name: "Save authentication source" });
  await retry.click();
  assert.equal((await reread).status(), 200);
  await waitForEnabled(page.getByRole("button", { name: "Reload authentication source" }));
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  assert.equal(await retry.isDisabled(), true);
  await page.getByText(/Agent identity changed. Reload authentication source/).waitFor();
});

// Granting the Agent its authentication Secret writes IAM policy, which needs Installation
// administration. A member's save sends no IAM request, whether or not an administrator already
// granted it. The card settles to one saved state that says the deploy checks the Agent's access
// and who gives it, and stays editable (finding D748). An administrator's save grants it.
test("Agent credentials settle a member's harness Secret save and say who grants access", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Member harness grant", { ready: true });
  const replacementSecret = await fixture.createSecret(
    namespace.id,
    "Member harness Secret",
    "hidden-member-harness",
  );
  const otherSecret = await fixture.createSecret(namespace.id, "Other member Secret", "hidden");
  const ungranted = await fixture.createAgent(
    namespace.id,
    "Member Harness Agent",
    nativeValues("member-harness"),
  );
  // An administrator already granted this Agent the Secret the member is about to select.
  const granted = await fixture.createAgent(
    namespace.id,
    "Member Granted Agent",
    nativeValues("member-granted"),
  );
  await fixture.grantAgentSecretOperate(granted, replacementSecret.ref);
  const writer = await fixture.createNamespaceMember("member-write", namespace.id, MEMBER_WRITE);

  for (const agent of [ungranted, granted]) {
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(page, fixture, url, writer.credentials);
    await page.getByRole("heading", { name: agent.name }).waitFor();
    // The Namespace permission answer already said this account is no administrator, so the
    // session sends no probe.
    assert.deepEqual(
      requests.filter(({ path }) => path === "/observability"),
      [],
    );
    await selectSecret(page, "API key Secret", replacementSecret);
    const save = page.getByRole("button", { name: "Save authentication source" });
    await save.click();
    const notice = page.getByRole("status").filter({ hasText: HARNESS_SAVED_FOR_MEMBER });
    await notice.waitFor();
    assert.equal(await notice.textContent(), HARNESS_SAVED_FOR_MEMBER);
    assert.deepEqual(await statusTone(notice), { className: "hint", tone: null, role: "status" });
    // The Agent saved its new source; no IAM request went out that the API would refuse and
    // audit.
    const saved = wireBody(
      fixture,
      AgentResponse,
      (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).body,
    );
    assert.deepEqual(saved.data.harnessAuth, { method: "api_key", source: replacementSecret.ref });
    assert.deepEqual(
      requests.filter(({ path }) => path.includes("/iam/")),
      [],
    );
    // No dead Retry, and the card stays editable: the save finished and nothing this member
    // can do confirms the grant, so Deploy is not held either: the API checks the Agent's access
    // when it deploys (findings 2547, D748).
    assert.equal(await page.getByRole("button", { name: "Retry credential access" }).count(), 0);
    await waitForEnabled(save);
    await waitForEnabled(page.getByRole("button", { name: "Reload authentication source" }));
    await waitForEnabled(page.locator("#harness-auth-method"));
    await waitForEnabled(page.getByLabel("API key Secret", { exact: true }));
    const deploy = page.getByRole("button", { name: "Deploy new version" });
    await expectNoText(page, "Confirm authentication and Secret access in Credentials", () =>
      waitForEnabled(deploy),
    );
    // The rebuilt tab still offers no Retry, still holds nothing and stays editable.
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("tab", { name: "Credentials", exact: true }).click();
    await waitForEnabled(save);
    assert.equal(await page.getByRole("button", { name: "Retry credential access" }).count(), 0);
    assert.equal(await deploy.isDisabled(), false);
    // Another selection is staged, and the card says only that, not "saved" beside it.
    await selectSecret(page, "API key Secret", otherSecret);
    await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
    assert.equal(await page.getByText(HARNESS_SAVED_FOR_MEMBER).count(), 0);
  }

  // The administrator the warning names opens the Agent's Credentials: its IAM policy read finds
  // the grant missing, so the tab names the same step and Deploy waits (finding 2260).
  const { page: adminPage } = await newPage(t, fixture);
  await login(
    adminPage,
    fixture,
    detailUrl(fixture, namespace.id, ungranted.id, "draft", "credentials"),
  );
  await adminPage.getByRole("heading", { name: "Member Harness Agent" }).waitFor();
  await waitForInputValue(
    adminPage.getByLabel("API key Secret", { exact: true }),
    secretOptionLabel(replacementSecret),
  );
  const missing = adminPage.getByText(HARNESS_GRANT_MISSING, { exact: true });
  await missing.waitFor();
  assert.equal(await missing.getAttribute("data-tone"), "warning");
  await adminPage
    .getByText("Confirm authentication and Secret access in Credentials before deploying.")
    .waitFor();
  assert.equal(
    await adminPage.getByRole("button", { name: "Deploy new version" }).isDisabled(),
    true,
  );
  // The named step grants the Agent its Secret; the rebuilt tab reads the grant and clears both.
  await adminPage.getByRole("button", { name: "Save authentication source" }).click();
  await adminPage.getByRole("status").filter({ hasText: "Authentication source saved." }).waitFor();
  await waitForEnabled(adminPage.getByRole("button", { name: "Deploy new version" }));
  assert.equal(await adminPage.getByText(HARNESS_GRANT_MISSING, { exact: true }).count(), 0);
  const grants = wireBody(
    fixture,
    IAMAccessBindingListResponse.properties.data,
    await fixture.addedAccessBindings(namespace.id),
  );
  assert.deepEqual(
    grants
      .filter(({ subjectId }) => subjectId === ungranted.servicePrincipalId)
      .map((binding) => [
        "resourceKind" in binding ? binding.resourceKind : undefined,
        "resourceId" in binding ? binding.resourceId : undefined,
      ]),
    [["secret", replacementSecret.id]],
  );
});

// The IAM read can finish after the administrator has left Credentials. Deploy already waits,
// and the parked form must still explain Save authentication source when they come back.
test("a harness grant found while Credentials is parked is shown on return", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Parked harness grant", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Parked harness Secret", "hidden");
  const agent = await fixture.createAgent(
    namespace.id,
    "Parked Grant Agent",
    nativeValues("parked-grant"),
  );
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  const { page } = await newPage(t, fixture);
  const held = await holdRequests(t, page, `**/namespaces/${namespace.id}/iam/**`);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Parked Grant Agent" }).waitFor();
  await held.requested;
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
  held.release();
  await page
    .getByText("Confirm authentication and Secret access in Credentials before deploying.")
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByText(HARNESS_GRANT_MISSING, { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Authentication source").isDisabled(), false);
});

// The missing-grant warning names the Secret Save would grant. Selecting another Secret
// clears it, and selecting the saved Secret again restores it (review of PR 3476).
test("a missing harness grant warning follows the selected Secret", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Selected harness grant", { ready: true });
  const savedSecret = await fixture.createSecret(namespace.id, "Saved harness Secret", "hidden-a");
  const otherSecret = await fixture.createSecret(namespace.id, "Other harness Secret", "hidden-b");
  const agent = await fixture.createAgent(
    namespace.id,
    "Selected Grant Agent",
    nativeValues("selected-grant"),
  );
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: savedSecret.ref },
  });
  const { page } = await newPage(t, fixture);
  const held = await holdRequests(t, page, `**/namespaces/${namespace.id}/iam/**`);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Selected Grant Agent" }).waitFor();
  await held.requested;
  await waitForInputValue(
    page.getByLabel("API key Secret", { exact: true }),
    secretOptionLabel(savedSecret),
  );
  await selectSecret(page, "API key Secret", otherSecret);
  held.release();
  await page
    .getByText("Confirm authentication and Secret access in Credentials before deploying.")
    .waitFor();
  await expectNoText(page, HARNESS_GRANT_MISSING, () =>
    page
      .getByText("Confirm authentication and Secret access in Credentials before deploying.")
      .waitFor(),
  );
  assert.equal(
    await page.getByLabel("API key Secret", { exact: true }).inputValue(),
    secretOptionLabel(otherSecret),
  );

  await selectSecret(page, "API key Secret", savedSecret);
  await page.getByText(HARNESS_GRANT_MISSING, { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("API key Secret", { exact: true }).inputValue(),
    secretOptionLabel(savedSecret),
  );

  await selectSecret(page, "API key Secret", otherSecret);
  await expectNoText(page, HARNESS_GRANT_MISSING, () =>
    page.getByLabel("API key Secret", { exact: true }).inputValue(),
  );
  assert.equal(
    await page.getByLabel("API key Secret", { exact: true }).inputValue(),
    secretOptionLabel(otherSecret),
  );
});

// The harness grant check reads Namespace IAM; a refused read proves nothing missing, so an
// administrator's Deploy stays as it was and no warning appears (finding 2260).
test("A refused harness grant read leaves an administrator's Deploy alone", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unread harness grant", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Unread Grant Agent", nativeValues("u"));
  // The Agent's binding moved to a Secret it holds no grant for.
  const ungranted = await fixture.createSecret(namespace.id, "Ungranted model key", "hidden");
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: ungranted.ref },
  });
  const { page } = await newPage(t, fixture);
  await page.route(`**/namespaces/${namespace.id}/iam/roles`, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "FORBIDDEN", message: "Access denied." },
        meta: { requestId: "req_00000000-0000-4000-8000-000000002260" },
      }),
    }),
  );
  const read = page.waitForResponse((response) =>
    response.url().endsWith(`/namespaces/${namespace.id}/iam/roles`),
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Unread Grant Agent" }).waitFor();
  assert.equal((await read).status(), 403);
  await settlePageRequests(page);
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
  assert.equal(await page.getByText(HARNESS_GRANT_MISSING, { exact: true }).count(), 0);
});

test("Agent detail blocks repeat Configuration saves after an uncertain draft update", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Uncertain Configuration", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Uncertain Configuration Agent",
    nativeValues("before-unknown"),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  let interceptedPatches = 0;
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    interceptedPatches += 1;
    await route.fetch();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked Configuration response" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
      }),
    });
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Uncertain Configuration Agent" }).waitFor();
  requests.length = 0;

  const nextValues = nativeValues("after-unknown");
  await page.locator(LIVE_BUTTON, { hasText: "Deploy new version" }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nextValues, null, 2));
  await page.getByText(CONFIGURATION_EDITS_PENDING).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  await page.getByRole("button", { name: "Save Configuration" }).click();

  await page.getByText("Outcome unknown. Configuration may have been saved.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Save Configuration" }).isDisabled(), true);
  assert.equal(await page.getByRole("tab", { name: "Channels" }).isDisabled(), true);
  await page.evaluate(() => {
    const next = new URL(globalThis.location.href);
    next.searchParams.set("tab", "channels");
    globalThis.history.pushState(globalThis.history.state, "", next);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  });
  await page.getByText("Outcome unknown. Reload this draft before leaving the editor.").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("tab"), "configuration");
  assert.match(
    await page.getByLabel("Configuration JSON").inputValue(),
    /"marker": "after-unknown"/,
  );
  assert.equal(interceptedPatches, 1);
  assert.equal(configurationPatchRequests(requests, namespace.id, agent.configurationId).length, 1);
  const saved = wireBody(
    fixture,
    ConfigurationResponse,
    (await fixture.request("GET", configurationPath)).body,
  );
  assert.equal(saved.data.generation, 2);
  assert.deepEqual(saved.data.values, nextValues);

  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await page.getByLabel("Configuration JSON").waitFor();
  assert.equal(await page.getByRole("button", { name: "Save Configuration" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  await page.getByRole("button", { name: "Reload draft" }).click();
  await page.getByText(/generation 2/).waitFor();
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "after-unknown"').waitFor();
  assert.equal(interceptedPatches, 1);

  // The controller accepts this next edit, but the 200 describes another Configuration.
  // Require the same no-repeat recovery as a lost reply; confirm exactly one write reached OCC.
  const otherValues = nativeValues("after-unconfirmed-success");
  await page.unroute(`**${configurationPath}`);
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      return route.continue();
    }
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const { data, meta } = wireBody(fixture, ConfigurationResponse, await response.json());
    assert.equal(data.id, agent.configurationId);
    assert.deepEqual(data.values, otherValues);
    await route.fulfill({ response, json: { data: { ...data, id: `cfg_${randomUUID()}` }, meta } });
  });
  const save = page.getByRole("button", { name: "Save Configuration", exact: true });
  const editor = page.getByLabel("Configuration JSON");
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await editor.fill(JSON.stringify(otherValues));
  await save.click();
  const unknown = page.getByText("Outcome unknown. Configuration may have been saved.");
  const incorrectlySaved = page.getByText("Configuration saved.", { exact: true });
  await unknown.or(incorrectlySaved).first().waitFor();
  assert.equal(await unknown.isVisible(), true);
  assert.equal(await save.isDisabled(), true);
  assert.equal(configurationPatchRequests(requests, namespace.id, agent.configurationId).length, 1);
  const confirmed = wireBody(
    fixture,
    ConfigurationResponse,
    (await fixture.request("GET", configurationPath)).body,
  );
  assert.equal(confirmed.data.generation, saved.data.generation + 1);
  assert.deepEqual(confirmed.data.values, otherValues);
});

test("Agent stop confirmation uses the real API, preserves Agent state, and deploy resumes", async (t) => {
  const { fixture, namespace, state } = await createRuntimeAuthFixture(t, "Stop success");
  const agent = await fixture.createAgent(namespace.id, "Stop Candidate", nativeValues("stop"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace"),
  );
  await page.getByRole("heading", { name: "Stop Candidate" }).waitFor();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  // A slow permission answer reveals the page at FIRST_ACTIVITY_WAIT_MS, before the native admin
  // status read it gates is sent. Clear the log only after that first read, so the reread below
  // is the only one after the stop.
  await waitForSettledFetches(
    page,
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
    1,
  );
  requests.length = 0;

  await page.getByRole("button", { name: "Stop Agent" }).click();
  let dialog = page.getByRole("dialog", { name: "Stop this Agent?" });
  await dialog
    .getByText(/Configuration, versions, Credentials, and workspace data are retained/i)
    .waitFor();
  // The dialog names its target Agent as text, and in its accessible description.
  await dialog.getByText("Stop Candidate", { exact: true }).waitFor();
  assert.equal(await accessibleDescription(dialog), `Agent: Stop Candidate ${STOP_CONFIRMATION}`);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 0);
  await page.getByRole("button", { name: "Stop Agent" }).click();
  dialog = page.getByRole("dialog", { name: "Stop this Agent?" });
  await dialog
    .getByText(/Configuration, versions, Credentials, and workspace data are retained/i)
    .waitFor();
  const stopResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/stop` &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Stop Agent" }).click();
  const response = await stopResponse;
  assert.equal(response.status(), 202);
  const stoppedBody = wireBody(fixture, AgentResponse, await response.json());
  assert.equal(stoppedBody.data.desiredRuntimeState, "stopped");
  assert.equal(stoppedBody.data.activeRevisionId, active.revision.id);

  await page.getByRole("status").getByText("Stop requested.").waitFor();
  await page.getByText(STOP_REQUESTED, { exact: true }).waitFor();
  // The card names the version as the page does, and the overview reports the request
  // (finding 1899).
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRegion.getByText("v1", { exact: true }).waitFor();
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  await summary.getByText("Stop requested", { exact: true }).waitFor();
  await summary
    .getByText(
      "Shutdown completion is not shown here. Deploy a new version to start this Agent again.",
    )
    .waitFor();
  // Only Request Stop again and Refresh remain; no disabled Stop beside them.
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).count(), 0);
  assert.deepEqual(await stopRegion.getByRole("button").allTextContents(), [
    "Request Stop again",
    "Refresh stop status",
  ]);
  assert.deepEqual(
    agentStopRequests(requests, namespace.id, agent.id).map((request) => [
      request.method,
      request.path,
      request.body,
    ]),
    [["POST", `/namespaces/${namespace.id}/agents/${agent.id}/stop`, null]],
  );
  const stopped = wireBody(
    fixture,
    AgentResponse,
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).body,
  );
  assert.equal(stopped.data.desiredRuntimeState, "stopped");
  assert.equal(stopped.data.activeRevisionId, active.revision.id);
  assert.deepEqual(stopped.data.harnessAuth, { method: "runtime" });
  assert.equal(stopped.data.configurationId, agent.configurationId);
  // Changing only the requested runtime state must reload dependent panels,
  // even while the selected revision remains unchanged pending worker shutdown.
  const stopIndex = requests.findIndex((request) => request.path.endsWith("/stop"));
  assert.ok(
    requests.findIndex((request) => request.path.endsWith("/native-admin")) > stopIndex,
    "native admin status must be reread after stop admission",
  );
  const revisions = wireBody(
    fixture,
    AgentRevisionListResponse,
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}/revisions`)).body,
  );
  assert.deepEqual(
    revisions.data.map((revision) => revision.id),
    [active.revision.id],
  );
  await page.getByRole("tab", { name: "Workspace files" }).click();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  // The standing explainer is quiet: an info block that announces nothing.
  assert.deepEqual(
    await statusTone(page.getByText(/^These files belong to the Agent's live workspace\./)),
    { className: "status", tone: "info", role: null },
  );

  const cleared = await state.transact((unit) =>
    unit.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  assert.ok(cleared);
  assert.equal(cleared.desiredRuntimeState, "stopped");
  assert.equal(cleared.activeRevisionId, undefined);
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Refresh stop status" }).click();
  await page
    .getByRole("region", { name: "Stop Agent", exact: true })
    .getByText("No current version", { exact: true })
    .waitFor();
  await page.getByText(STOPPED_NO_VERSION).waitFor();
  // A completed stop also clears the selected version, but no deployment is in progress: a new
  // stop intent must not say it cancels one, nor report one cancelled (finding D691). No gateway
  // runs either, so it says it only repeats the stop request (finding D815).
  await page.getByRole("button", { name: "Request Stop again", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Stop this Agent?" });
  await dialog.getByText(STOP_REPEAT_CONFIRMATION, { exact: true }).waitFor();
  assert.equal(await dialog.getByText(/runtime gateway/).count(), 0);
  assert.equal(await dialog.getByText(/deployment in progress/).count(), 0);
  const repeated = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/stop` &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Stop Agent" }).click();
  assert.equal((await repeated).status(), 202);
  await dialog.waitFor({ state: "hidden" });
  await page.getByText(STOPPED_NO_VERSION).waitFor();
  assert.equal(await page.getByText(/deployment in progress is cancelled/).count(), 0);

  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Open draft", exact: true }).last().click();
  await page.getByRole("button", { name: "Deploy new version" }).click();
  await page.waitForURL(/revision=rev_/);
  const running = wireBody(
    fixture,
    AgentResponse,
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).body,
  );
  assert.equal(running.data.desiredRuntimeState, "running");
  assert.equal(running.data.configurationId, agent.configurationId);
  assert.deepEqual(running.data.harnessAuth, { method: "runtime" });
});

// Stop changes only the Agent's runtime state and current version, so the page updates those
// regions in place. Reloading the page for it collapsed the version detail to its loading state,
// scrolled the Stop result away and dropped focus to the page (finding 1419).
test("Agent stop and Refresh stop status update the page in place and keep focus", async (t) => {
  const { fixture, namespace, state } = await createRuntimeAuthFixture(t, "Stop in place", {
    publicOrigin: true,
    workspaceFilesAccess: {
      async read({ filename }: ControllerWorkspaceFileReadRequest) {
        return { status: "ok", file: { name: filename, content: `Saved ${filename}` } };
      },
    },
  });
  const agent = await fixture.createAgent(namespace.id, "In Place Stop", nativeValues("in-place"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 1280, height: 720 } },
  });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  await waitForChosenVersion(page);
  await page.waitForFunction(
    () => !globalThis.document.body.textContent.includes("Loading configuration…"),
  );
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  const stop = stopRegion.getByRole("button", { name: "Stop Agent", exact: true });
  await stop.scrollIntoViewIfNeeded();
  // Mark the rendered version detail and record any loading state the page shows again.
  await page.evaluate(() => {
    const doc = globalThis.document;
    const detail = doc.querySelector(".agent-version-detail");
    if (!(detail instanceof HTMLElement)) {
      throw new Error("Expected version detail");
    }
    detail.dataset.stopMarker = "kept";
    const reloadedText: (string | null)[] = [];
    globalThis.window.reloadedText = reloadedText;
    new globalThis.MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (/Loading (version details|configuration)/.test(node.textContent ?? "")) {
            reloadedText.push(node.textContent);
          }
        }
      }
    }).observe(doc.body, { childList: true, subtree: true });
  });
  const requests = apiRequests(page, fixture.origin);
  const scrollBefore = await page.evaluate(() => globalThis.scrollY);
  assert.ok(scrollBefore > 0);
  const focusedText = () => page.evaluate(() => globalThis.document.activeElement?.textContent);
  const keptInPlace = () =>
    page.evaluate(() => {
      const detail = globalThis.document.querySelector(".agent-version-detail");
      if (detail !== null && !(detail instanceof HTMLElement)) {
        throw new Error("Expected version detail");
      }
      return { marker: detail?.dataset.stopMarker, reloadedText: globalThis.window.reloadedText };
    });

  await stop.click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await stopRegion.getByRole("status").getByText("Stop requested.").waitFor();
  // A closed dialog has no dialog role, so wait for its close handler to remove the element.
  await page.locator("dialog.agent-stop-dialog").waitFor({ state: "detached" });
  assert.deepEqual(await keptInPlace(), { marker: "kept", reloadedText: [] });
  assert.equal(await focusedText(), "Refresh stop status");
  // The page did not jump back up to rebuild above the reader.
  assert.ok((await page.evaluate(() => globalThis.scrollY)) >= scrollBefore - 1);

  // Stop acceptance does not clear the current version. Open Workspace in the interval
  // before the worker clears it, and keep an unsaved edit in the mounted editor.
  const workspace = page.getByRole("tab", { name: "Workspace files", exact: true });
  const file = page.getByLabel("AGENTS.md", { exact: true });
  const draft = "Unsaved workspace edit during Stop";
  await workspace.click();
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  await file.fill(draft);
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();

  // The worker clears the current version; Refresh stop status shows it without a reload too.
  await state.transact((unit) =>
    unit.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  await stopRegion.getByRole("button", { name: "Refresh stop status" }).click();
  await stopRegion.getByText("No current version", { exact: true }).waitFor();
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  await summary.getByText("None", { exact: true }).waitFor();
  // The overview still reports the stop request once no version is selected.
  await summary
    .getByText("Deploy a new version to start this Agent again.", { exact: true })
    .waitFor();
  assert.equal(await summary.getByText("Stop requested", { exact: true }).isVisible(), true);
  assert.deepEqual(await keptInPlace(), { marker: "kept", reloadedText: [] });
  assert.equal(await focusedText(), "Refresh stop status");
  // The viewed version is no longer current, and tabs built from the old state are rebuilt.
  const unavailable = page.getByText(WORKSPACE_FILES_UNAVAILABLE, { exact: true });

  await page.getByText(/^Historical version · read-only admitted snapshot/).waitFor();
  assert.equal(
    await page
      .getByRole("combobox", { name: "Viewing version", exact: true })
      .getByRole("option")
      .filter({ hasText: "Selected for service" })
      .count(),
    0,
  );
  await workspace.click();
  await unavailable.waitFor();
  assert.equal(await file.count(), 0, "returning must not resurrect the old editor");

  // Files are live Agent data, not a revision snapshot. A later serving revision restores
  // the unsaved draft, but must not silently write it to the workspace.
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await stopRegion.getByRole("button", { name: "Refresh stop status" }).click();
  await workspace.click();
  await page
    .getByText("Unsaved edits restored. Reload replaces them with the current file.")
    .waitFor();
  assert.equal(await file.inputValue(), draft);
  assert.equal(
    requests.filter((r) => r.method === "PUT" && r.path.includes("/workspace/files/")).length,
    0,
  );
});

test("Refresh stop status switches to deletion recovery when another actor starts deletion", async (t) => {
  const { fixture, namespace, state } = await createRuntimeAuthFixture(t, "Deletion discovered");
  const agent = await fixture.createAgent(
    namespace.id,
    "Deletion Candidate",
    nativeValues("deletion"),
    { harnessAuth: { method: "runtime" } },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await state.transact((unit) =>
    unit.agents.transitionAgentDesiredRuntimeState(namespace.id, agent.id, "running", "stopped"),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, active.revision.id));
  const refreshStop = page.getByRole("button", { name: "Refresh stop status" });
  await refreshStop.waitFor();
  requests.length = 0;

  // Another actor changes lifecycle state after this page loads; the operator only reads it.
  const deleting = await state.transact((unit) =>
    unit.agents.transitionAgentStatus(namespace.id, agent.id, "active", "deleting"),
  );
  assert.ok(deleting);
  assert.equal(deleting.status, "deleting");
  await refreshStop.click();
  await page.getByText(/Deletion was requested\./).waitFor();
  assert.equal(await page.getByRole("button", { name: "Delete Agent", exact: true }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Request deletion again" }).isVisible(),
    true,
  );
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.textContent),
    "Refresh deletion status",
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// An Agent created through the API starts with desiredRuntimeState stopped and no version,
// so no stop was ever requested and nothing runs to stop (finding 1394). The page shows no
// Stop card and reports no stop request until a deploy creates a version (finding 1899).
test("Agent detail has no Stop row for an Agent that was never deployed", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Never deployed");
  const agent = await fixture.createAgent(namespace.id, "Never Deployed", nativeValues("never"), {
    harnessAuth: { method: "runtime" },
  });
  assert.equal(agent.desiredRuntimeState, "stopped");
  assert.equal(agent.activeRevisionId, undefined);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Never Deployed" }).waitFor();
  // The version list loaded empty, so the console knows there is no version to stop.
  await page.getByText(/^No readable versions\. Creating an Agent alone does not create/).waitFor();
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await page.locator("section.stop-note").waitFor({ state: "hidden" });
  assert.equal(await stopRegion.count(), 0);
  assert.equal(await page.getByText("Requested runtime state").isVisible(), false);
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  assert.equal(await summary.getByText("Stop requested").isVisible(), false);
  // The danger zone keeps its Delete row (UX spec 3.9).
  await waitForDangerZoneRows(page, { stop: false, delete: true });
  assert.deepEqual(
    await page
      .getByRole("region", { name: "Danger zone", exact: true })
      .getByRole("heading", { level: 3 })
      .allTextContents(),
    ["Delete Agent"],
  );

  // Once a deployed version is selected for service, something runs, so Stop returns.
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await page.goto(detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration").href);
  await waitForChosenVersion(page);
  await stopRegion.getByRole("button", { name: "Stop Agent", exact: true }).waitFor();
  assert.equal(await stopRegion.getByText("No version is selected.").count(), 0);
});

// A viewer who reads no version of a deployed Agent sees the Stop card while a version is
// selected. Once the worker clears it, that viewer cannot tell the Agent from a never-deployed
// one, but a card they just used stays in place with focus on its heading (finding 1899).
test("Agent stop keeps a used card for a viewer who reads no version", async (t) => {
  const { fixture, namespace, state } = await createRuntimeAuthFixture(t, "Stop unreadable");
  const agent = await fixture.createAgent(namespace.id, "Unreadable Stop", nativeValues("unread"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const operator = await fixture.createNamespaceMember("agent-stop-unreadable", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
    ["read", "configuration"],
    ["operate", "agent"],
  ]);
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}`,
    operator.credentials,
  );
  await page.getByRole("heading", { name: "Unreadable Stop" }).waitFor();
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRegion.getByRole("button", { name: "Stop Agent", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await stopRegion.getByRole("status").getByText("Stop requested.").waitFor();
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  await summary.getByText("Stop requested", { exact: true }).waitFor();

  await state.transact((unit) =>
    unit.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  await stopRegion.getByRole("button", { name: "Refresh stop status" }).click();
  await stopRegion.getByText("No current version", { exact: true }).waitFor();
  assert.equal(await stopRegion.getByRole("button").count(), 0);
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.id),
    "agent-stop-title",
  );
  assert.equal(await summary.getByText("Stop requested", { exact: true }).count(), 0);
});

test("Agent stop uncertainty requires refresh before another stop request", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Stop uncertainty");
  const agent = await fixture.createAgent(
    namespace.id,
    "Uncertain Stop Candidate",
    nativeValues("uncertain-stop"),
    {
      harnessAuth: { method: "runtime" },
    },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const stopPath = `${agentPath}/stop`;
  await trackSettledFetches(page);
  let interceptedStops = 0;
  await page.route(`**${stopPath}`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    interceptedStops += 1;
    await replyWithDifferentAgentId(route, agent.id, 202);
  });

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  await page.getByRole("heading", { name: "Uncertain Stop Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Stop Agent" }).click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await page.getByText("Outcome unknown. Stop may have been accepted.").waitFor();
  // Only Refresh is offered until a readback settles the outcome.
  const stopControls = page
    .getByRole("region", { name: "Stop Agent", exact: true })
    .getByRole("button");
  assert.deepEqual(await stopControls.allTextContents(), ["Refresh stop status"]);
  assert.equal(interceptedStops, 1);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  const stopped = wireBody(
    fixture,
    AgentResponse,
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).body,
  );
  assert.equal(stopped.data.desiredRuntimeState, "stopped");

  // A read for a different Agent cannot unlock another destructive request either.
  await page.route(
    fixture.origin + agentPath,
    (route) => replyWithDifferentAgentId(route, agent.id, 200),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Refresh stop status" }).click();
  await page.getByText(STOP_STATUS_REFRESH_FAILED).waitFor();
  assert.deepEqual(await stopControls.allTextContents(), ["Refresh stop status"]);

  // A refused status read names the Agent read it checks, not a bare denial (finding 2538).
  await page.route(
    fixture.origin + agentPath,
    (route) => route.fulfill(apiErrorResponse(403, "FORBIDDEN", GENERIC_DENIAL)),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Refresh stop status" }).click();
  await page
    .getByText(
      stopStatusRefreshFailed(notIncluded("reading this Agent's status", "Agent read on it")),
      { exact: true },
    )
    .waitFor();
  assert.deepEqual(await stopControls.allTextContents(), ["Refresh stop status"]);

  // Even this Agent's active status cannot tell us whether it is requested to run or stop.
  // Omit only the desired state from the controller's real, committed Stop readback.
  await page.route(
    fixture.origin + agentPath,
    async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      const { data, meta } = wireBody(fixture, AgentResponse, await response.json());
      const { desiredRuntimeState, ...rest } = data;
      assert.equal(rest.id, agent.id);
      assert.equal(rest.namespaceId, namespace.id);
      assert.equal(rest.status, "active");
      assert.equal(desiredRuntimeState, "stopped");
      await route.fulfill({ response, json: { data: rest, meta } });
    },
    { times: 1 },
  );
  const reads: unknown = await settledFetches(page, agentPath);
  assert.ok(typeof reads === "number");
  await page.getByRole("button", { name: "Refresh stop status" }).click();
  await waitForSettledFetches(page, agentPath, reads + 1);
  assert.deepEqual(await stopControls.allTextContents(), ["Refresh stop status"]);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);

  const refresh = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Refresh stop status" }).click();
  assert.equal((await refresh).status(), 200);
  await page.getByRole("status").getByText("Stop requested.").waitFor();
  assert.equal(interceptedStops, 1);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  // Readback permits an explicit new intent; it never resends the masked request.
  await waitForEnabled(page.getByRole("button", { name: "Request Stop again" }));
});

test("An uncertain repeated Stop offers only Refresh stop status", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Repeat uncertainty");
  const agent = await fixture.createAgent(namespace.id, "Repeat Unknown", nativeValues("rep-unk"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const stopPath = `/namespaces/${namespace.id}/agents/${agent.id}/stop`;
  assert.equal((await fixture.request("POST", stopPath)).status, 202);
  const { page } = await newPage(t, fixture);
  await page.route(`**${stopPath}`, (route, request) =>
    request.method() === "POST"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked stop response" },
            meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
          }),
        })
      : route.continue(),
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRegion.getByRole("button", { name: "Request Stop again", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await stopRegion.getByText("Outcome unknown. Stop may have been accepted.").waitFor();
  // No disabled Request Stop again beside Refresh (finding 1899).
  assert.deepEqual(await stopRegion.getByRole("button").allTextContents(), ["Refresh stop status"]);
});

// A Stop whose answer was lost before it reached the API leaves the Agent running; the readback
// says so as information, not a warning, and offers Stop again (finding 2035).
test("an uncertain Stop the API never received reads back as still requested to run", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Unsent stop");
  const agent = await fixture.createAgent(namespace.id, "Unsent Stop", nativeValues("unsent"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const stopPath = `/namespaces/${namespace.id}/agents/${agent.id}/stop`;
  const { page } = await newPage(t, fixture);
  await page.route(`**${stopPath}`, (route, request) =>
    request.method() === "POST"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked stop response" },
            meta: { requestId: "req_00000000-0000-4000-8000-000000002035" },
          }),
        })
      : route.continue(),
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRegion.getByRole("button", { name: "Stop Agent", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await stopRegion.getByText("Outcome unknown. Stop may have been accepted.").waitFor();
  const current = wireBody(
    fixture,
    AgentResponse,
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).body,
  );
  assert.equal(current.data.desiredRuntimeState, "running");
  await stopRegion.getByRole("button", { name: "Refresh stop status", exact: true }).click();
  const notice = stopRegion.getByText("The Agent is still requested to run.", { exact: true });
  await notice.waitFor();
  assert.deepEqual(await statusTone(notice), { className: "status", tone: "info", role: "status" });
  await waitForEnabled(stopRegion.getByRole("button", { name: "Stop Agent", exact: true }));
});

test("Agent stop denial keeps the Agent running with permission feedback", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Stop denial");
  const agent = await fixture.createAgent(
    namespace.id,
    "Denied Stop Candidate",
    nativeValues("stop-denied"),
    {
      harnessAuth: { method: "runtime" },
    },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const limited = await fixture.createNamespaceMember(
    "agent-stop-denied",
    namespace.id,
    AGENT_READ,
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    limited.credentials,
  );
  await page.getByRole("heading", { name: "Denied Stop Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Stop Agent" }).click();
  const denied = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/stop` &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  assert.equal((await denied).status(), 403);

  await page.getByText(stopRefused("Denied Stop Candidate")).waitFor();
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  // Stop stays reachable but unavailable: the API would refuse it again (finding 2955).
  assert.equal(
    await page.getByRole("button", { name: "Stop Agent" }).getAttribute("aria-disabled"),
    "true",
  );
  const current = wireBody(
    fixture,
    AgentResponse,
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).body,
  );
  assert.equal(current.data.desiredRuntimeState, "running");
  assert.equal(current.data.activeRevisionId, active.revision.id);
});

test("a read-only principal sees Agent mutation controls disabled or absent before any denial", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Read-only controls", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Read-only Agent", nativeValues("ro"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const viewer = await fixture.createNamespaceMember(
    "agent-controls-viewer",
    namespace.id,
    AGENT_READ,
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents?namespace=${namespace.id}`, viewer.credentials);
  await page.getByText(AGENT_CREATE_DENIED).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);

  const current = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await page.goto(current.href);
  await page.getByRole("heading", { name: "Read-only Agent" }).waitFor();
  const openDraft = page
    .locator(".agent-toolbar-actions")
    .getByRole("button", { name: "Open draft" });
  await openDraft.waitFor();
  await waitForEnabled(openDraft);
  // The answer denies operate and delete, so the page has no danger zone at all (UX spec 3.9):
  // a reader is not offered Stop or Delete, disabled or not.
  await waitForDangerZoneRows(page, { stop: false, delete: false });
  assert.equal(await page.getByRole("region", { name: "Danger zone" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Delete Agent" }).count(), 0);
  for (const reason of ["stopping", "deleting"]) {
    const text = page.getByText(`Your access does not include ${reason} this Agent.`);
    assert.equal(await text.isVisible(), false, reason);
  }

  const draft = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await page.goto(draft.href);
  await page.getByText(AGENT_DEPLOY_NOT_INCLUDED, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Turn off managed mode for next deployment" }).count(),
    0,
  );
  // A caller without the control learns who can change the setting (finding 2690).
  await page
    .getByText("Only an Installation administrator can change Gateway managed mode.", {
      exact: true,
    })
    .waitFor();

  // The summary is a probe, not an attempted operation: no write was sent and nothing was
  // audited as a denial for the summary or the gated operations.
  assert.equal(nonAuthWriteRequests(requests).length, 0);
  const auditSink: unknown = fixture.auditSink;
  assert.ok(auditSink instanceof InMemoryAuditSink);
  const auditEvents = auditSink.list();
  const deniedActions = auditEvents
    .filter((event) => event.kind === "authorization_denial")
    .map((event) => event.action);
  for (const action of [
    "openclaw.namespaces.permissions.read",
    "openclaw.agents.permissions.read",
    "openclaw.agents.delete",
    "openclaw.agents.stop",
    "openclaw.agents.deploy",
  ]) {
    assert.equal(deniedActions.includes(action), false, action);
  }
});

// Waits until the danger zone shows exactly the given rows. The zone is attached at the end of
// the page build and the view is held back while it loads, so neither a missing zone nor a
// pending view counts: a row is judged by the hidden flag its component sets, the zone by
// whether it renders.
async function waitForDangerZoneRows(page: Page, rows: { stop: boolean; delete: boolean }) {
  await page.waitForFunction(({ stop, delete: remove }) => {
    const zone = globalThis.document.querySelector("section.danger-zone");
    const stopRow = zone?.querySelector("section.stop-note");
    const deleteRow = zone?.querySelector("section.deletion-note");
    if (
      !zone ||
      !(stopRow instanceof HTMLElement) ||
      !(deleteRow instanceof HTMLElement) ||
      zone.closest(".agent-detail-pending")
    ) {
      return false;
    }
    return (
      !stopRow.hidden === stop &&
      !deleteRow.hidden === remove &&
      zone.getClientRects().length > 0 === (stop || remove)
    );
  }, rows);
}

// Stop and Delete were two full cards, each a heading, a paragraph and one button (finding
// 1910). They are now the two rows of one danger zone card; the paragraphs moved into the
// confirmations, and only a confirmation's own button is filled (UX spec 3.9, plan D2).
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Only Configuration shows the Stop and Delete danger zone at ${viewport.width}px`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Danger zone", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Danger Zone Agent", nativeValues("dz"));
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const { page } = await newPage(t, fixture, { context: { viewport } });
    const requests = apiRequests(page, fixture.origin);
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace"),
    );
    await page.getByRole("heading", { name: "Danger Zone Agent" }).first().waitFor();
    const zone = page.getByRole("region", { name: "Danger zone", exact: true });
    await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
    assert.equal(await zone.count(), 0);
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await zone.waitFor();
    const tabs = page.getByRole("tablist", { name: "Agent configuration views" });
    for (const name of await tabs.getByRole("tab", { selected: false }).allTextContents()) {
      await tabs.getByRole("tab", { name, exact: true }).click();
      await tabs.getByRole("tab", { name, selected: true, exact: true }).waitFor();
      assert.equal(await zone.count(), 0, name);
    }
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await waitForDangerZoneRows(page, { stop: true, delete: true });
    assert.equal(await page.locator(".card--danger").count(), 1);
    assert.equal(await zone.locator(".card--danger").count(), 1);
    assert.deepEqual(await zone.getByRole("heading", { level: 3 }).allTextContents(), [
      "Stop Agent",
      "Delete Agent",
    ]);
    // The zone closes the page: nothing renders below it.
    assert.equal(await zone.evaluate((node) => node.nextElementSibling === null), true);

    const rows = [
      {
        name: "Stop Agent",
        sentence: STOP_RUNNING_VERSION,
        dialog: "Stop this Agent?",
        confirm: "Stop Agent",
        prose: /Configuration, versions, Credentials, and workspace data are retained\./,
      },
      {
        name: "Delete Agent",
        sentence:
          "Permanently deletes this Agent, its versions and its workspace data. Cannot be undone.",
        dialog: "Delete Danger Zone Agent?",
        confirm: "Permanently delete Agent",
        prose:
          /This permanently deletes the Agent, its version history, and its workspace data\. This cannot be undone\./,
      },
    ];
    const danger = "rgb(185, 28, 28)";
    for (const row of rows) {
      const region = zone.getByRole("region", { name: row.name, exact: true });
      // One sentence under the title, and the confirmation's prose is not on the page.
      assert.deepEqual(await region.locator(".danger-zone-text p").allTextContents(), [
        row.sentence,
      ]);
      assert.equal(await page.getByText(row.prose).count(), 0);
      const action = region.getByRole("button", { name: row.name, exact: true });
      const [title, button] = await Promise.all([
        region.getByRole("heading", { name: row.name, exact: true }).boundingBox(),
        action.boundingBox(),
      ]);
      assert.ok(title);
      assert.ok(button);
      if (viewport.width >= 1440) {
        // Title and sentence at the left, the button at the right of the same row.
        assert.ok(button.x > title.x + title.width, `${row.name} button beside its text`);
        assert.ok(button.y < title.y + 60, `${row.name} button on the title's row`);
      } else {
        assert.ok(button.y > title.y + title.height, `${row.name} button under its text`);
      }
      // The row's button is outlined; only the confirmation's is filled.
      const paint = (locator: Locator) =>
        locator.evaluate((node) => {
          const style = globalThis.getComputedStyle(node);
          return { color: style.color, border: style.borderTopColor, fill: style.backgroundColor };
        });
      const outlined = await paint(action);
      assert.equal(outlined.color, danger);
      assert.equal(outlined.border, danger);
      assert.notEqual(outlined.fill, danger);

      await action.click();
      const dialog = page.getByRole("dialog", { name: row.dialog });
      await dialog.getByText(row.prose).waitFor();
      const confirm = dialog.getByRole("button", { name: row.confirm, exact: true });
      assert.deepEqual(await paint(confirm), {
        color: "rgb(255, 255, 255)",
        border: danger,
        fill: danger,
      });
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await page.locator("dialog[open]").waitFor({ state: "detached" });
    }
    assert.deepEqual(nonAuthWriteRequests(requests), []);
  });
}

// A viewer the answer allows to delete but not to operate gets the Delete row only.
test("the danger zone offers only the rows the caller's permission answer allows", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delete only", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Delete Only Agent", nativeValues("do"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const deleter = await fixture.createNamespaceMember("danger-zone-deleter", namespace.id, [
    ...AGENT_READ,
    ["delete", "agent"],
  ]);
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    deleter.credentials,
  );
  await page.getByRole("heading", { name: "Delete Only Agent" }).first().waitFor();
  await waitForDangerZoneRows(page, { stop: false, delete: true });
  const zone = page.getByRole("region", { name: "Danger zone", exact: true });
  assert.deepEqual(await zone.getByRole("heading", { level: 3 }).allTextContents(), [
    "Delete Agent",
  ]);
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).count(), 0);
  assert.equal(
    await zone.getByRole("button", { name: "Delete Agent", exact: true }).isEnabled(),
    true,
  );
  // The lone row has no divider above it.
  assert.equal(
    await zone
      .locator("section.deletion-note")
      .evaluate((node) => globalThis.getComputedStyle(node).borderTopStyle),
    "none",
  );
});

// Only a negative answer hides a row: without an answer the page keeps both, and the API decides.
test("the danger zone keeps both rows when the permission answer fails", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("No permission answer", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Unanswered Agent", nativeValues("ua"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const permissionPath = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`;
  await page.route(permissionPath, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "DEPENDENCY_UNAVAILABLE", message: "Unavailable." } }),
    }),
  );
  const answered = page.waitForResponse((response) => response.url() === permissionPath);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  assert.equal((await answered).status(), 503);
  await page.getByRole("heading", { name: "Unanswered Agent" }).first().waitFor();
  await waitForDangerZoneRows(page, { stop: true, delete: true });
  await settlePageRequests(page);
  const zone = page.getByRole("region", { name: "Danger zone", exact: true });
  for (const name of ["Stop Agent", "Delete Agent"]) {
    assert.equal(await zone.getByRole("button", { name, exact: true }).isEnabled(), true, name);
  }
});

// A member's full load of Agents painted Create Agent enabled, then disabled it and put the note
// above the table: 59 px at 390x844, 36 px on desktop (finding 1517). In an empty Namespace the
// copy then invited creating, and Create Agent by URL refused only at submit (finding 1521).
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`a member without Agent create is refused from the first paint at ${viewport.width}x${viewport.height}`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const listed = await fixture.createNamespace("Member list", { ready: true });
    const empty = await fixture.createNamespace("Member empty", { ready: true });
    await fixture.createAgent(listed.id, "Member visible Agent", nativeValues("m1"));
    const member = await fixture.createAccountWithPolicy("agent-list-member", (principal) => {
      for (const namespace of [listed, empty]) {
        fixture.policy.roles.push({
          id: `role-agent-list-member-${namespace.id}`,
          namespaceId: namespace.id,
          permissions: [
            { action: "read", resourceKind: "namespace" },
            { action: "read", resourceKind: "agent" },
          ],
        });
        fixture.policy.bindings.push({
          id: `binding-agent-list-member-${namespace.id}`,
          namespaceId: namespace.id,
          subjectKind: "identity",
          subjectId: principal.id,
          roleId: `role-agent-list-member-${namespace.id}`,
        });
      }
    });
    const { page } = await newPage(t, fixture, { context: { viewport } });
    await login(page, fixture, `/console/agents?namespace=${listed.id}`, member.credentials);
    await page.getByText("Member visible Agent", { exact: true }).waitFor();

    // A full load has no recent input to excuse a shift.
    await page.addInitScript(recordLayoutShifts);
    await page.addInitScript(() => {
      const states: ("disabled" | "enabled")[] = [];
      globalThis.window.__createStates = states;
      new globalThis.MutationObserver(() => {
        const create = [...globalThis.document.querySelectorAll("button")].find(
          (node) => node.textContent === "Create Agent",
        );
        // An unavailable Create Agent with its reason is aria-disabled (finding 2899).
        const unavailable = create?.disabled || create?.getAttribute("aria-disabled") === "true";
        const state = create ? (unavailable ? "disabled" : "enabled") : null;
        if (state && states.at(-1) !== state) {
          states.push(state);
        }
      }).observe(globalThis.document, { subtree: true, childList: true, attributes: true });
    });
    await page.reload();
    const note = page.getByText(AGENT_CREATE_DENIED);
    await note.waitFor();
    await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
    await page.getByText("Reading deployment…").first().waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => globalThis.window.__createStates), ["disabled"]);
    const { shifts } = await takeLayoutShifts(page);
    // Headless Chromium reports a body entry when the page gets shorter; the list must not move.
    const listShifts = shifts.filter((entry) =>
      entry.sources.some((source) => !source.node.startsWith("BODY")),
    );
    assert.deepEqual(listShifts, []);

    // An empty Namespace does not invite creating under the note.
    await page.goto(`${fixture.origin}/console/agents?namespace=${empty.id}`);
    await page.getByRole("heading", { name: "No Agents are shared with you" }).waitFor();
    await note.waitFor();
    await page
      .getByText("Agents in this Namespace that are shared with you appear here.")
      .waitFor();
    assert.equal(await page.getByText(/Create an Agent in this Namespace/).count(), 0);

    // Create Agent by URL refuses up front instead of at submit.
    await page.goto(`${fixture.origin}/console/agents/new?namespace=${empty.id}`);
    await page.getByRole("heading", { name: "Creating Agents is not available" }).waitFor();
    await page.getByText(AGENT_CREATE_DENIED).waitFor();
    assert.equal(await page.getByRole("button", { name: "Start without Preset" }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "← Agents" }).isVisible(), true);
  });
}

test("a version editor without Agent update can recover a failed deployment from the draft", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Version editor");
  const agent = await fixture.createAgent(
    namespace.id,
    "Version editor Agent",
    nativeValues("v1"),
    {
      harnessAuth: { method: "runtime" },
    },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const failed = await fixture.deployAgent(namespace.id, agent.id);
  const editor = await fixture.createNamespaceMember("version-editor", namespace.id, [
    ...AGENT_READ,
    ["deploy", "agent"],
    ["update", "configuration"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  // The fixture has no deployment worker; supply its persisted failure record for v2.
  await page.route(`${fixture.origin}${path}/deployments/${failed.id}`, (route) =>
    route.fulfill({
      status: 200,
      json: {
        data: {
          deploymentId: failed.id,
          namespaceId: namespace.id,
          agentId: agent.id,
          status: "failed",
          error: persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED"),
          warnings: [],
          progress: null,
        },
        meta: { requestId: "req_test_version_editor_failure" },
      },
    }),
  );
  const requests = apiRequests(page, fixture.origin);
  // Hold the permission answer until the Versions list is built: the draft entry and the chooser
  // option must be labelled again when it lands (finding 2405).
  const firstPermissions = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  await page.clock.install();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    editor.credentials,
  );
  await firstPermissions.requested;
  // The held answer keeps the page behind its stand-in until the overview's bounded wait runs
  // out; run it out rather than wait for it.
  await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
  await versionChooser(page).waitFor();
  const summary = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  firstPermissions.release();
  const response = await summary;
  assert.equal(response.status(), 200);
  assert.deepEqual(wireBody(fixture, AgentCallerPermissionsResponse, await response.json()).data, {
    update: false,
    deploy: true,
    operate: false,
    delete: false,
    administer: false,
    configurationUpdate: true,
    configurationRead: true,
    configurationSecretsOperate: true,
    configurationSecretsOperateDeniedBindings: [],
    agentSourcesOperate: false,
    sandboxPolicyRead: false,
    readLogs: false,
  });

  // The header label confirms the page applied the permission answer before recovery is used.
  await page
    .locator(".agent-toolbar-actions")
    .getByRole("button", { name: "Open draft" })
    .waitFor();
  // Without Agent update the Versions list's draft entry is not called editable, nor read-only:
  // this caller can save the Configuration (finding 2405).
  await versionChooser(page).locator('option[value="draft"]').waitFor({ state: "attached" });
  // The narrow-width version chooser names the draft the same way.
  assert.equal(
    await page.locator("#revision-selector option[value=draft]").textContent(),
    "Draft · Editable Configuration",
  );
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery
    .getByText("v2 failed its startup model check (RUNTIME_MODEL_PROBE_FAILED).", { exact: false })
    .waitFor();
  // This caller may edit the Configuration, so recovery opens it as such (finding 2450).
  await recovery.getByRole("link", { name: "Open Configuration", exact: true }).click();
  await recovery.getByRole("link", { name: "Open Configuration", exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nativeValues("edited")));
  // Hold the save's permission reread before it reaches the API, so the refreshed details render
  // first and the reread sees Configuration update revoked after the save.
  const permission = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    once: true,
  });
  const saving = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().endsWith("/configurations/" + agent.configurationId),
  );
  await page.getByRole("button", { name: "Save Configuration" }).click();
  const saved = await saving;
  assert.equal(saved.status(), 200);
  assert.deepEqual(
    wireBody(fixture, ConfigurationResponse, await saved.json()).data.values,
    nativeValues("edited"),
  );
  await permission.requested;
  await page.getByText("Configuration saved.", { exact: true }).waitFor();
  assert.equal(
    await recovery.getByRole("link", { name: "Open Configuration", exact: true }).isVisible(),
    true,
  );
  const restoreGrants = revokeMemberGrant(fixture, "version-editor", ["update", "configuration"]);
  const reread = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  permission.release();
  assert.equal(
    wireBody(fixture, AgentCallerPermissionsResponse, await (await reread).json()).data
      .configurationUpdate,
    false,
  );
  // The reread applies to recovery: the Configuration is now read-only, so this deployer is
  // offered the draft to read and deploy.
  await recovery
    .getByRole("link", { name: "Open Configuration", exact: true })
    .waitFor({ state: "detached" });
  await recovery.getByRole("link", { name: "Open draft", exact: true }).waitFor();

  restoreGrants();
  await page.reload();

  const deploying = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(path + "/deploy"),
  );
  await page.getByRole("button", { name: "Deploy new version" }).click();
  const deployed = await deploying;
  assert.equal(deployed.status(), 202);
  assert.equal(
    wireBody(fixture, AgentRevisionResponse, await deployed.json()).data.agentId,
    agent.id,
  );
  assert.equal(pathRequests(requests, "PATCH", path).length, 0);
});

// The Agent page's copy for a caller without Configuration update (finding 2421).
const CONFIGURATION_READ_ONLY = CONFIGURATION_UPDATE_DENIED;
const CHANNELS_READ_ONLY = `These are the version draft’s channel settings. ${CONFIGURATION_READ_ONLY}`;
// A channel save keeps a binding whose Secret the member may not operate (finding 2444).
const KEPT_SECRET_CHANNEL_SECRETS =
  "Each Configuration save needs Secret operate on every Secret it keeps bound. Your access does not include it for EXTERNAL_API_TOKEN, which channel saves keep.";
const REPLACE_BOT_TOKEN =
  "Your access does not include Secret operate on the Secret bound to Slack bot token. Each save needs it for every Secret it keeps bound, so choose another Secret for it before saving.";
const KEEPS_BOT_TOKEN =
  "This save keeps Slack bot token on a Secret your access cannot operate. Choose another Secret for it, then save.";
const DISABLE_KEEPS_BOT_TOKEN =
  "Disabling keeps Slack bot token on a Secret your access cannot operate. Choose another Secret for it in Edit Slack first, then disable.";
// Slack Socket Mode reading its tokens from SLACK_APP_TOKEN and SLACK_BOT_TOKEN, which a test
// binds to Secrets or leaves unbound.
const SOCKET_SLACK = {
  enabled: true,
  mode: "socket",
  appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
  botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
  dmPolicy: "allowlist",
  groupPolicy: "allowlist",
  allowFrom: ["U123"],
  channels: { C123: { requireMention: true } },
};

// A member who can only read the Agent views its draft: the saved JSON with no editor whose
// Save answers 403, and no editor's copy or checklist (finding 2421).
test("a reader without update views the version draft read-only", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Draft reader");
  const agent = await fixture.createAgent(namespace.id, "Draft reader Agent", nativeValues("v1"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const reader = await fixture.createNamespaceMember("draft-reader", namespace.id, AGENT_READ);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    reader.credentials,
  );
  assert.deepEqual(
    wireBody(fixture, AgentCallerPermissionsResponse, await (await permissions).json()).data,
    {
      update: false,
      deploy: false,
      operate: false,
      delete: false,
      administer: false,
      configurationUpdate: false,
      configurationRead: true,
      configurationSecretsOperate: false,
      configurationSecretsOperateDeniedBindings: [],
      agentSourcesOperate: false,
      sandboxPolicyRead: false,
      readLogs: false,
    },
  );
  await page.getByText(CONFIGURATION_READ_ONLY, { exact: true }).waitFor();
  await page.getByText("View native Configuration", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Configuration" }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Enable gateway password access" }).count(),
    0,
  );
  await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).waitFor();
  assert.equal(await page.getByText(/New version\. Changes affect/).count(), 0);
  // The draft card names the draft; Deploy says why it is disabled, with no editor's steps.
  await page
    .getByRole("heading", { name: "Version draft", exact: true, includeHidden: true })
    .waitFor({ state: "attached" });
  assert.equal(await page.getByRole("heading", { name: "Prepare this version" }).count(), 0);
  assert.equal(
    await page.getByText("Edit and save Configuration, plugins, or Channels").isVisible(),
    false,
  );
  await page.getByText(AGENT_DEPLOY_NOT_INCLUDED, { exact: true }).waitFor();
  const entry = versionChooser(page).locator('option[value="draft"]');
  await entry.filter({ hasText: "Read-only Configuration" }).waitFor({ state: "attached" });

  // Plugin selections are an Agent-side save. The reader reads them, with no editor's copy, and
  // the page does not ask for the policy capabilities, a read that needs Agent update and would
  // answer 403 (finding 2436).
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByText(PLUGINS_READ_ONLY, { exact: true }).waitFor();
  // The version notice addresses the reader too, not an editor whose changes reach the next
  // deployment (finding 2455).
  await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).waitFor();
  assert.equal(await page.getByText(/^Plugin changes to this Agent appear/).count(), 0);
  // A read-only summary: no editor, no disabled Save or Discard, no instructions (finding 2455).
  assert.equal(await page.getByLabel("Plugin selections JSON", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /Save plugin|Discard/ }).count(), 0);
  await expectNoText(
    page,
    /remains editable|Save selections on this Agent|No plugin changes|Select plugins/,
  );
  assert.deepEqual(pathRequests(requests, "GET", `${path}/plugins/capabilities`), []);

  // The current version's Configuration opens the draft to read it; it offers no editor.
  await page.goto(
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration").href,
  );
  const snapshot = page
    .locator("section.agent-card")
    .filter({ has: page.getByRole("heading", { name: "Configuration snapshot" }) });
  await snapshot.getByRole("button", { name: "Open draft", exact: true }).click();
  await page.getByText(CONFIGURATION_READ_ONLY, { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("revision"), "draft");
  assert.equal(await page.getByRole("button", { name: "Edit current Configuration" }).count(), 0);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// The permission answer can land after a version's page or the Plugins tab is drawn. A reader's
// Edit current Configuration turns into Open draft in place, and the Plugins tab waits
// for the answer before it reads the policy capabilities, which need Agent update (finding 2436).
test("a late permission answer relabels a reader's version entry and skips plugin capabilities", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Late plugin reader");
  const agent = await fixture.createAgent(namespace.id, "Late plugin Agent", nativeValues("v1"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const reader = await fixture.createNamespaceMember(
    "late-plugin-reader",
    namespace.id,
    AGENT_READ,
  );
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const capabilities = () => pathRequests(requests, "GET", `${path}/plugins/capabilities`);
  const firstAnswer = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  await page.clock.install();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    reader.credentials,
  );
  await firstAnswer.requested;
  // The held answer keeps the page behind its stand-in until the overview's bounded wait runs
  // out; run it out rather than wait for it.
  await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
  const snapshot = page
    .locator("section.agent-card")
    .filter({ has: page.getByRole("heading", { name: "Configuration snapshot" }) });
  // Until the answer lands the page assumes an editor.
  await snapshot.getByRole("button", { name: "Edit current Configuration", exact: true }).waitFor();
  firstAnswer.release();
  await snapshot.getByRole("button", { name: "Open draft", exact: true }).waitFor();

  const secondAnswer = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "plugins").href);
  await secondAnswer.requested;
  await page.getByLabel("Plugin selections JSON", { exact: true }).waitFor({ state: "attached" });
  assert.deepEqual(capabilities(), []);
  secondAnswer.release();
  await page.getByText(PLUGINS_READ_ONLY, { exact: true }).waitFor();
  assert.deepEqual(capabilities(), []);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// Agent update and Configuration update are separate grants. A member with only Agent update
// keeps the Agent's own editors, but the draft's Configuration, its Versions entry and Channels
// say they are read-only, so no Save answers 403 (finding 2421).
test("an Agent editor without Configuration update sees the Configuration read-only", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Agent-only editor");
  const agent = await fixture.createAgent(namespace.id, "Agent-only Agent", nativeValues("v1"), {
    harnessAuth: { method: "runtime" },
  });
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const member = await fixture.createNamespaceMember("agent-only-editor", namespace.id, [
    ...AGENT_READ,
    ["update", "agent"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    member.credentials,
  );
  assert.deepEqual(
    wireBody(fixture, AgentCallerPermissionsResponse, await (await permissions).json()).data,
    {
      update: true,
      deploy: false,
      operate: false,
      delete: false,
      administer: false,
      configurationUpdate: false,
      configurationRead: true,
      configurationSecretsOperate: false,
      configurationSecretsOperateDeniedBindings: [],
      agentSourcesOperate: true,
      sandboxPolicyRead: false,
      readLogs: false,
    },
  );
  await page.getByText(CONFIGURATION_READ_ONLY, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Configuration" }).count(), 0);
  // The draft stays a new version (this member can change the Agent's own settings), but its
  // Configuration is not called editable.
  const entry = page.locator("#revision-selector option[value=draft]");
  await entry.filter({ hasText: "Read-only Configuration" }).waitFor({ state: "attached" });
  assert.equal(
    await page.locator("#revision-selector option[value=draft]").textContent(),
    "Draft · Read-only Configuration",
  );
  // Agent update alone keeps the draft a member can change, so the notice is not a reader's.
  await page
    .getByText(
      "New version. Changes affect future deployments using this Configuration. Admitted versions stay unchanged.",
      { exact: true },
    )
    .waitFor();
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByText(CHANNELS_READ_ONLY, { exact: true }).waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// Each Configuration save and each Agent update also checks operate on every Secret the
// Configuration binds. A member with Agent update and Configuration update but no operate on the
// bound Secret had every editor disabled, yet the draft still read as a new version they could
// change (finding 2441). Its labels, notice and card now follow the combined answer.
test("an editor without operate on a bound Secret views the version draft read-only", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unoperated Secret editor", { ready: true });
  const bound = await fixture.createSecret(namespace.id, "Bound token", "bound-token-value");
  const agent = await fixture.createAgent(
    namespace.id,
    "Unoperated Secret Agent",
    nativeValues("v1"),
    {
      secretBindings: { EXTERNAL_API_TOKEN: { source: bound.ref, delivery: { type: "env" } } },
    },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const member = await fixture.createNamespaceMember("unoperated-secret-editor", namespace.id, [
    ...AGENT_READ,
    ["update", "agent"],
    ["update", "configuration"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    member.credentials,
  );
  assert.deepEqual(
    wireBody(fixture, AgentCallerPermissionsResponse, await (await permissions).json()).data,
    {
      update: true,
      deploy: false,
      operate: false,
      delete: false,
      administer: false,
      configurationUpdate: true,
      configurationRead: true,
      configurationSecretsOperate: false,
      configurationSecretsOperateDeniedBindings: ["EXTERNAL_API_TOKEN"],
      agentSourcesOperate: false,
      sandboxPolicyRead: false,
      readLogs: false,
    },
  );
  await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).waitFor();
  assert.equal(await page.getByText(/New version\. Changes affect/).count(), 0);
  const entry = versionChooser(page).locator('option[value="draft"]');
  await entry.filter({ hasText: "Read-only Configuration" }).waitFor({ state: "attached" });
  assert.equal(
    await page.locator("#revision-selector option[value=draft]").textContent(),
    "Draft · Read-only Configuration",
  );
  // No editor's checklist: this member can change nothing here and cannot deploy.
  await page
    .getByRole("heading", { name: "Version draft", exact: true, includeHidden: true })
    .waitFor({ state: "attached" });
  assert.equal(await page.getByRole("heading", { name: "Prepare this version" }).count(), 0);
  // The current version's header opens the draft rather than offering to create a version.
  await page.goto(
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration").href,
  );
  await page
    .locator(".agent-toolbar-actions")
    .getByRole("button", { name: "Open draft", exact: true })
    .waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// Deploy is its own grant. A member who can deploy the draft but change none of it reads it, and
// keeps the checklist of what the next deployment needs. Deploy's status says what is missing and
// that this member cannot change the draft to fix it (finding 2421).
test("a deployer without update keeps the draft checklist", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Draft deployer", { ready: true });
  // Slack is on and its token Secrets are not bound, so the draft is not ready to deploy.
  const agent = await fixture.createAgent(
    namespace.id,
    "Draft deployer Agent",
    nativeValues("slack", { harnessId: "codex", channels: { slack: SOCKET_SLACK } }),
    { executionMode: "dedicated" },
  );
  // Read and operate on the model credential Secret, so Deploy waits on the draft, not on a
  // Secret this member cannot read (finding D756).
  const deployer = await fixture.createNamespaceMember("draft-deployer", namespace.id, [
    ...AGENT_READ,
    ["deploy", "agent"],
    ["read", "secret"],
    ["operate", "secret"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    deployer.credentials,
  );
  const answer = wireBody(
    fixture,
    AgentCallerPermissionsResponse,
    await (await permissions).json(),
  ).data;
  assert.equal(answer.deploy, true);
  assert.equal(answer.update, false);
  assert.equal(answer.configurationUpdate, false);
  await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Prepare this version", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Version draft", exact: true }).count(), 0);
  await page
    .locator(".agent-draft-actions")
    .getByText(/\. Your access does not include changing this version draft\.$/)
    .waitFor();
});

// The permission answer can land after the draft is drawn; nothing waits for it. When it denies
// Configuration update, the Channels tab, the draft card and the Credentials tab's Channel
// Secrets panel turn read-only in place (findings 2421, 2432).
test("a late permission answer turns a reader's Channels and Channel Secrets read-only", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Late reader answer", { ready: true });
  // Slack is on and its token Secrets are not bound yet, so an editor's draft offers to set them.
  const agent = await fixture.createAgent(
    namespace.id,
    "Late reader Agent",
    nativeValues("slack", { harnessId: "codex", channels: { slack: SOCKET_SLACK } }),
    { executionMode: "dedicated" },
  );
  const reader = await fixture.createNamespaceMember("late-reader", namespace.id, [
    ...AGENT_READ,
    ["read", "secret"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const firstPermissions = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  await page.clock.install();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "channels"),
    reader.credentials,
  );
  await firstPermissions.requested;
  // The held answer keeps the page behind its stand-in until the overview's bounded wait runs
  // out; run it out rather than wait for it.
  await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
  // Until the answer lands the page assumes an editor.
  await page.getByText(/^Save and Disable update only the shared Configuration draft\./).waitFor();
  await page.getByRole("button", { name: "Set up credentials", exact: true }).waitFor();
  const answer = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  firstPermissions.release();
  assert.equal(
    wireBody(fixture, AgentCallerPermissionsResponse, await (await answer).json()).data
      .configurationUpdate,
    false,
  );
  await page.getByText(CHANNELS_READ_ONLY, { exact: true }).waitFor();
  await page.getByText("Read-only with your access.", { exact: true }).waitFor();
  // A reader's card offers no editor's action; Deploy says why it is disabled.
  await page
    .getByRole("button", { name: "Set up credentials", exact: true })
    .waitFor({ state: "hidden" });
  await page.getByText(AGENT_DEPLOY_NOT_INCLUDED, { exact: true }).waitFor();

  // The Channel Secrets panel was built before the answer, with enabled pickers.
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByRole("heading", { name: "Channel Secrets" }).waitFor();
  await page
    .getByText(
      "Your access does not include editing this Configuration, so its channel Secrets are read-only.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByLabel("Slack app token").isDisabled(), true);
  assert.equal(await page.getByLabel("Slack bot token").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).count(), 0);
  // A disabled picker says what is bound, not how to choose or create a Secret (finding 2438).
  const channelSecrets = page.locator("section.channel-secrets");
  await channelSecrets.getByText("No Secret is bound.", { exact: true }).nth(1).waitFor();
  assert.equal(
    await channelSecrets.getByText("Choose an existing Secret or create a new one.").count(),
    0,
  );
  // At desktop width the Channel Secrets card is as wide as the Harness authentication card
  // above it (finding 2438).
  await page.setViewportSize({ width: 1440, height: 900 });
  const width = (locator: Locator) =>
    locator.evaluate((node) => node.getBoundingClientRect().width);
  assert.equal(
    await width(channelSecrets),
    await width(page.locator("form:has(#harness-auth-method)")),
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// Every Configuration save also needs Secret operate on each Secret it keeps bound. A member with
// Configuration update but no Secret operate on a Secret bound to a name channel saves keep is
// told so up front: no picker, editor or Save whose PATCH would answer 403 (findings 2437, 2444).
test("a Configuration editor without Secret operate on a kept bound Secret reads the channel Secrets", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Bound Secrets editor", { ready: true });
  const app = await fixture.createSecret(namespace.id, "Bound app token", "xapp-bound-value");
  const bot = await fixture.createSecret(namespace.id, "Bound bot token", "xoxb-bound-value");
  const external = await fixture.createSecret(namespace.id, "External token", "external-value");
  const agent = await fixture.createAgent(
    namespace.id,
    "Bound Secrets Agent",
    nativeValues("bound", { harnessId: "codex", channels: { slack: SOCKET_SLACK } }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
        // Channel saves resubmit this binding, so they need operate on its Secret.
        EXTERNAL_API_TOKEN: { source: external.ref, delivery: { type: "env" } },
      },
    },
  );
  const member = await fixture.createNamespaceMember("bound-secrets-editor", namespace.id, [
    ...AGENT_READ,
    ["update", "configuration"],
    ["read", "secret"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  const answer = wireBody(
    fixture,
    AgentCallerPermissionsResponse,
    await (await permissions).json(),
  ).data;
  assert.equal(answer.configurationUpdate, true);
  assert.equal(answer.configurationSecretsOperate, false);
  assert.deepEqual(answer.configurationSecretsOperateDeniedBindings, [
    "EXTERNAL_API_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_BOT_TOKEN",
  ]);
  await page.getByRole("heading", { name: "Channel Secrets" }).waitFor();
  await page.getByText(KEPT_SECRET_CHANNEL_SECRETS, { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Slack app token").isDisabled(), true);
  assert.equal(await page.getByLabel("Slack bot token").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).count(), 0);

  // The Configuration editor's Save binds the same Secrets, so it is read-only too.
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page
    .getByText(
      "Saving this Configuration needs Secret operate on Bound app token, Bound bot token and External token, which your access does not include. Ask an Installation administrator to grant it.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Configuration" }).count(), 0);
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page
    .getByText(`These are the version draft’s channel settings. ${KEPT_SECRET_CHANNEL_SECRETS}`, {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Slack" }).count(), 0);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// The replace persona (finding 2444): a member with Configuration update who may operate the app
// token Secret and their own Secret, but not the administrator's bot token Secret, which the
// draft binds. `agentUpdate` adds Agent update and operate on the model key Secret, so only the
// bot token Secret refuses Agent-side saves (finding 2470).
async function replaceSecretFixture(t: TestContext, label: string, { agentUpdate = false } = {}) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(label, { ready: true });
  const app = await fixture.createSecret(namespace.id, "Admin app token", "xapp-admin-value");
  const bot = await fixture.createSecret(namespace.id, "Admin bot token", "xoxb-admin-value");
  const own = await fixture.createSecret(namespace.id, "Member bot token", "xoxb-member-value");
  const agent = await fixture.createAgent(
    namespace.id,
    `${label} Agent`,
    nativeValues("bound", { harnessId: "codex", channels: { slack: SOCKET_SLACK } }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
      },
    },
  );
  const slug = label.toLowerCase().replaceAll(" ", "-");
  const member = await fixture.createNamespaceMember(slug, namespace.id, [
    ...AGENT_READ,
    ["update", "configuration"],
    ["read", "secret"],
    ...(agentUpdate ? [["update", "agent"] as const] : []),
  ]);
  const operated = [app.id, own.id];
  if (agentUpdate) {
    const { data } = wireBody(
      fixture,
      AgentResponse,
      (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).body,
    );
    operated.push(secretSource(data.harnessAuth).id);
  }
  grantSecretOperate(fixture, namespace.id, member.principal, operated);
  return {
    fixture,
    namespace,
    agent,
    member,
    app,
    own,
    path: `/namespaces/${namespace.id}/agents/${agent.id}`,
    configurationPath: `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  };
}

test("Agent save hints name a denied Harness Secret without making Configuration read-only", async (t) => {
  const { fixture, namespace, agent, member, configurationPath, path } = await replaceSecretFixture(
    t,
    "Harness names",
    { agentUpdate: true },
  );
  const configuration = wireBody(
    fixture,
    ConfigurationResponse,
    (await fixture.request("GET", configurationPath)).body,
  );
  grantSecretOperate(fixture, namespace.id, member.principal, [
    bindingSource(configuration.data, "SLACK_BOT_TOKEN").id,
  ]);
  const readAgent = await fixture.request("GET", path);
  assert.equal(readAgent.status, 200, JSON.stringify(readAgent.body));
  const auth = wireBody(fixture, AgentResponse, readAgent.body).data.harnessAuth;
  const harnessId = secretSource(auth).id;
  const harnessName = wireBody(
    fixture,
    SecretDetailResponse,
    (await fixture.request("GET", `/namespaces/${namespace.id}/secrets/${harnessId}`)).body,
  ).data.name;
  const bindingIndex = fixture.policy.bindings.findIndex(
    (binding) => binding.resourceId === harnessId && binding.subjectId === member.principal.id,
  );
  assert.notEqual(bindingIndex, -1);
  fixture.policy.bindings.splice(bindingIndex, 1);
  const session = await fixture.signIn(member.credentials);
  // Both tabs save through Agent PATCH, which checks the current Harness even when replaced.
  for (const body of [{ plugins: {} }, { harnessAuth: auth }]) {
    const refused = await fixture.request("PATCH", path, {
      session,
      body: { configurationId: agent.configurationId, ...body },
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
  }
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"),
    member.credentials,
  );
  const reason = `${AGENT_SOURCES_DENIED} Missing Secret operate on ${harnessName}.`;
  await page.getByText(reason, { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByText(reason, { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Edit Configuration", exact: true }).waitFor();
  assert.equal(await page.getByText(reason, { exact: true }).count(), 0);
});

for (const heldMetadata of [false, true]) {
  test(`permission refocus replaces denied Secret names${heldMetadata ? " after obsolete metadata completes" : ""}`, async (t) => {
    const { fixture, namespace, agent, member, app, path, configurationPath } =
      await replaceSecretFixture(t, `Rechecked names ${heldMetadata}`, { agentUpdate: true });
    const configuration = wireBody(
      fixture,
      ConfigurationResponse,
      (await fixture.request("GET", configurationPath)).body,
    );
    const botId = bindingSource(configuration.data, "SLACK_BOT_TOKEN").id;
    const { page } = await newPage(t, fixture);
    const held = heldMetadata
      ? await holdRequests(
          t,
          page,
          `${fixture.origin}/namespaces/${namespace.id}/secrets/${botId}`,
          { method: "GET", once: true, afterServer: true },
        )
      : null;
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"),
      member.credentials,
    );
    if (held) {
      await held.requested;
    } else {
      await page
        .getByText(`${AGENT_SOURCES_DENIED} Missing Secret operate on Admin bot token.`, {
          exact: true,
        })
        .waitFor();
    }
    // An administrator swaps exact-resource grants while the member's page stays mounted.
    grantSecretOperate(fixture, namespace.id, member.principal, [botId]);
    const index = fixture.policy.bindings.findIndex(
      (binding) => binding.resourceId === app.id && binding.subjectId === member.principal.id,
    );
    assert.notEqual(index, -1);
    fixture.policy.bindings.splice(index, 1);
    const recheck = held
      ? await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
          method: "GET",
          once: true,
          afterServer: true,
        })
      : null;
    const permission = page.waitForResponse((response) =>
      response.url().endsWith(`${path}/permissions`),
    );
    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    if (held && recheck) {
      await recheck.requested;
      const oldResponse = page.waitForResponse((response) =>
        response.url().endsWith(`/secrets/${botId}`),
      );
      held.release();
      await oldResponse;
      await nextFrames(page);
      // No new metadata read has started: only the permission epoch can fence this completion.
      assert.equal(await page.getByText(AGENT_SOURCES_DENIED, { exact: true }).count(), 1);
      recheck.release();
    }
    assert.equal(
      wireBody(fixture, AgentCallerPermissionsResponse, await (await permission).json()).data
        .agentSourcesOperate,
      false,
    );
    const reason = `${AGENT_SOURCES_DENIED} Missing Secret operate on Admin app token.`;
    await page.getByText(reason, { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Credentials", exact: true }).click();
    await page.getByText(reason, { exact: true }).waitFor();
  });
}

for (const tab of ["plugins", "credentials"]) {
  test(`late ${tab} Secret names preserve the focused saved view`, async (t) => {
    const { fixture, namespace, agent, member, own, configurationPath } =
      await replaceSecretFixture(t, `Late ${tab} names`, { agentUpdate: true });
    const configuration = wireBody(
      fixture,
      ConfigurationResponse,
      (await fixture.request("GET", configurationPath)).body,
    );
    const botId = bindingSource(configuration.data, "SLACK_BOT_TOKEN").id;
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const held = await holdRequests(
      t,
      page,
      `${fixture.origin}/namespaces/${namespace.id}/secrets/${botId}`,
      {
        method: "GET",
        once: true,
        afterServer: true,
      },
    );
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", tab),
      member.credentials,
    );
    await held.requested;
    await page.getByText(AGENT_SOURCES_DENIED, { exact: true }).waitFor();
    // Metadata enrichment cannot replace the saved view or disturb an in-progress channel choice.
    const focus =
      tab === "plugins"
        ? page.getByRole("heading", { name: "Plugin selections", exact: true })
        : page.getByLabel("Slack bot token");
    if (tab === "plugins") {
      await focus.evaluate((node) => (node.tabIndex = 0));
    } else {
      await selectSecret(page, "Slack bot token", own);
    }
    await focus.focus();
    await focus.evaluate((node) => (node.dataset.retainedView = "yes"));
    held.release();
    await page
      .getByText(`${AGENT_SOURCES_DENIED} Missing Secret operate on Admin bot token.`, {
        exact: true,
      })
      .waitFor();
    assert.equal(await focus.getAttribute("data-retained-view"), "yes");
    assert.equal(await focus.evaluate((node) => node.ownerDocument.activeElement === node), true);
    assert.deepEqual(nonAuthWriteRequests(requests), []);
  });
}

test("late Configuration Secret names preserve an open focused native disclosure", async (t) => {
  const { fixture, namespace, agent, member } = await replaceSecretFixture(t, "Disclosure names");
  const { page } = await newPage(t, fixture);
  const configuration = wireBody(
    fixture,
    ConfigurationResponse,
    (
      await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      )
    ).body,
  );
  const botId = bindingSource(configuration.data, "SLACK_BOT_TOKEN").id;
  const held = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/secrets/${botId}`,
    {
      method: "GET",
      once: true,
      afterServer: true,
    },
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    member.credentials,
  );
  await held.requested;
  const summary = page.getByText("View native Configuration", { exact: true });
  await summary.click();
  await summary.focus();
  held.release();
  await page
    .getByText(
      "Saving this Configuration needs Secret operate on Admin bot token, which your access does not include. Ask an Installation administrator to grant it.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await summary.evaluate((node) => {
      if (!(node.parentElement instanceof HTMLDetailsElement)) {
        throw new Error("Expected details parent");
      }
      return node.parentElement.open;
    }),
    true,
  );
  assert.equal(await summary.evaluate((node) => node.ownerDocument.activeElement === node), true);
});

test("a superseded draft Secret metadata read cannot replace the current Configuration hint", async (t) => {
  const { fixture, namespace, agent, member, configurationPath } = await replaceSecretFixture(
    t,
    "Superseded names",
  );
  const replacement = await fixture.createSecret(
    namespace.id,
    "Current bot token",
    "xoxb-current-value",
  );
  const configuration = wireBody(
    fixture,
    ConfigurationResponse,
    (await fixture.request("GET", configurationPath)).body,
  );
  const botId = bindingSource(configuration.data, "SLACK_BOT_TOKEN").id;
  const { page } = await newPage(t, fixture);
  const held = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/secrets/${botId}`,
    {
      method: "GET",
      once: true,
      afterServer: true,
    },
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  await held.requested;
  // Another authorized editor changes the binding while the old draft's metadata read waits.
  const changed = await fixture.request("PATCH", configurationPath, {
    body: {
      values: configuration.data.values,
      expectedGeneration: configuration.data.generation,
      secretBindings: {
        ...configuration.data.secretBindings,
        SLACK_BOT_TOKEN: { source: replacement.ref, delivery: { type: "env" } },
      },
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  await page.getByRole("button", { name: "Reload authentication source", exact: true }).click();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  const reason =
    "Saving this Configuration needs Secret operate on Current bot token, which your access does not include. Ask an Installation administrator to grant it.";
  await page.getByText(reason, { exact: true }).waitFor();
  const oldResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/secrets/${botId}`),
  );
  held.release();
  await oldResponse;
  // Let the completed metadata read publish and the browser paint before inspecting the hint.
  await page.locator("body").evaluate(
    (node) =>
      new Promise((resolve) => {
        const view = node.ownerDocument.defaultView;
        if (!view) {
          throw new Error("Expected document window");
        }
        view.requestAnimationFrame(() => view.requestAnimationFrame(resolve));
      }),
  );
  assert.equal(await page.getByText(reason, { exact: true }).count(), 1);
});

// Save hints list the bound Secrets a member lacks operate on in name order, joined as a sentence,
// whatever order their metadata reads finish in. Plugins, drawn after the names arrive, shows them
// at once. Only the Secret-operate gap lists them: a member without Agent update gets that reason
// alone, since Secret grants would not let them save.
for (const agentUpdate of [false, true]) {
  test(`save hints name two denied Secrets in order${agentUpdate ? "" : " and not beside an Agent update denial"}`, async (t) => {
    const { fixture, namespace, agent, member, app, configurationPath } =
      await replaceSecretFixture(t, `Two names ${agentUpdate}`, { agentUpdate });
    // The member loses operate on the app token Secret too.
    const index = fixture.policy.bindings.findIndex(
      (binding) => binding.resourceId === app.id && binding.subjectId === member.principal.id,
    );
    assert.notEqual(index, -1);
    fixture.policy.bindings.splice(index, 1);
    const configuration = wireBody(
      fixture,
      ConfigurationResponse,
      (await fixture.request("GET", configurationPath)).body,
    );
    const botId = bindingSource(configuration.data, "SLACK_BOT_TOKEN").id;
    const { page } = await newPage(t, fixture);
    // The app token's metadata read finishes after the bot token's.
    const held = await holdRequests(
      t,
      page,
      `${fixture.origin}/namespaces/${namespace.id}/secrets/${app.id}`,
      {
        method: "GET",
        once: true,
        afterServer: true,
      },
    );
    const botRead = page.waitForResponse((response) =>
      response.url().endsWith(`/secrets/${botId}`),
    );
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
      member.credentials,
    );
    await held.requested;
    await botRead;
    await nextFrames(page);
    held.release();
    const names = "Admin app token and Admin bot token";
    await page
      .getByText(
        `Saving this Configuration needs Secret operate on ${names}, which your access does not include. Ask an Installation administrator to grant it.`,
        { exact: true },
      )
      .waitFor();
    await page.getByRole("tab", { name: "Plugins", exact: true }).click();
    await page.getByText(PLUGINS_READ_ONLY, { exact: true }).waitFor();
    const reason = agentUpdate
      ? `${AGENT_SOURCES_DENIED} Missing Secret operate on ${names}.`
      : AGENT_UPDATE_DENIED;
    await page.getByRole("status").filter({ hasText: reason }).waitFor();
    assert.equal(await page.getByText(reason, { exact: true }).count(), 1);
  });
}

// A save is checked on the Secrets it submits, not on the ones it replaces. A member who may not
// operate the administrator's bot token Secret, but may operate the app token Secret and their
// own, can bind their own Secret for the bot token. A save that keeps the administrator's Secret
// is refused before any request, naming the binding to replace (finding 2444).
test("a channel Secrets save may replace a bound Secret the member cannot operate", async (t) => {
  const { fixture, namespace, agent, member, app, own, path, configurationPath } =
    await replaceSecretFixture(t, "Replaced Secret editor");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  const answer = wireBody(
    fixture,
    AgentCallerPermissionsResponse,
    await (await permissions).json(),
  ).data;
  assert.equal(answer.configurationSecretsOperate, false);
  assert.deepEqual(answer.configurationSecretsOperateDeniedBindings, ["SLACK_BOT_TOKEN"]);
  // The panel stays editable and says which binding a save must replace, so the draft is not
  // called read-only.
  await page.getByText(REPLACE_BOT_TOKEN, { exact: true }).waitFor();
  await waitForEnabled(page.getByLabel("Slack app token"));
  assert.equal(await page.getByText(KEPT_SECRET_CHANNEL_SECRETS).count(), 0);
  await page
    .getByText(
      "New version. Changes affect future deployments using this Configuration. Admitted versions stay unchanged.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).count(), 0);
  // The Configuration editor submits no bindings, so its save keeps the administrator's Secret:
  // it stays read-only for this member.
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page
    .getByText(
      "Saving this Configuration needs Secret operate on Admin bot token, which your access does not include. Ask an Installation administrator to grant it.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Configuration" }).count(), 0);
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByText(REPLACE_BOT_TOKEN, { exact: true }).waitFor();

  // Changing only the app token keeps the administrator's bot token Secret: refused up front.
  await selectSecret(page, "Slack app token", own);
  requests.length = 0;
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .locator(".channel-secrets [role=alert]")
    .getByText(KEEPS_BOT_TOKEN, { exact: true })
    .waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // The app token back on its Secret and the member's own Secret for the bot token: saved.
  await selectSecret(page, "Slack app token", app);
  await selectSecret(page, "Slack bot token", own);
  const saving = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  assert.equal((await saving).status(), 200);
  const saved = wireBody(
    fixture,
    ConfigurationResponse,
    (await fixture.request("GET", configurationPath)).body,
  );
  assert.deepEqual(saved.data.secretBindings, {
    SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: own.ref, delivery: { type: "env" } },
  });
  // The bot token now binds the member's own Secret. The page reads the answer again, so nothing
  // is left to replace: neither the next panel save nor a Channels drawer save is refused
  // (finding 2457).
  await page.getByText(REPLACE_BOT_TOKEN, { exact: true }).waitFor({ state: "detached" });
  await selectSecret(page, "Slack app token", own);
  const resaving = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  assert.equal((await resaving).status(), 200);
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByLabel("Require a mention").waitFor();
  assert.equal(await dialog.getByText(/choose another Secret/).count(), 0);
  await dialog.getByLabel("Require a mention").setChecked(false);
  const drawerSaving = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  assert.equal((await drawerSaving).status(), 200);
});

// Binding a Secret needs Secret operate on it. A Configuration editor with operate on only the
// two bound Slack Secrets was offered a third readable Secret, saw it staged, and met a 403 that
// asked for the Configuration update they had (finding 2453, D710). Each Secret field now lists
// it disabled with the reason and never stages it; a save refused after a revocation names it.
test("Secret fields refuse a readable Secret the editor cannot operate", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Operate-only Secrets", { ready: true });
  const app = await fixture.createSecret(namespace.id, "Bound app token", "xapp-bound-value");
  const bot = await fixture.createSecret(namespace.id, "Bound bot token", "xoxb-bound-value");
  const spare = await fixture.createSecret(namespace.id, "Spare token", "xoxb-spare-value");
  const extra = await fixture.createSecret(namespace.id, "Extra token", "xoxb-extra-value");
  const other = await fixture.createSecret(namespace.id, "Other token", "xoxb-other-value");
  const agent = await fixture.createAgent(
    namespace.id,
    "Operate-only Agent",
    nativeValues("bound", { harnessId: "codex", channels: { slack: SOCKET_SLACK } }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
      },
    },
  );
  const member = await fixture.createNamespaceMember("operate-only-editor", namespace.id, [
    ...AGENT_READ,
    ["update", "agent"],
    ["update", "configuration"],
    ["read", "secret"],
  ]);
  // Secret operate on the bound Secrets, the Harness authentication Secret and the extra token:
  // every save is allowed, but binding the spare token is not.
  const operate = grantSecretOperate(fixture, namespace.id, member.principal, [
    app.id,
    bot.id,
    extra.id,
    other.id,
    secretSource(agent.harnessAuth).id,
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  // The draft reads the answer when it opens, for its Deploy gate; the pickers reuse it.
  const answer = page.waitForResponse((r) => r.url().endsWith(path + "/permissions/secrets"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  const save = page.getByRole("button", { name: "Save channel Secrets" });
  await waitForEnabled(page.getByLabel("Slack bot token", { exact: true }));
  const denied = await operateDeniedSecretOption(page, "Slack bot token", spare);
  assert.deepEqual(
    wireBody(fixture, AgentSecretPermissionsResponse, await (await answer).json()).data,
    {
      operateDenied: [spare.id],
      unreadableOperateDenied: 0,
    },
  );
  // A forced click skips the disabled check: choosing it still stages nothing.
  await denied.click({ force: true });
  await page.getByLabel("Slack bot token", { exact: true }).press("Enter");
  await page.getByLabel("Slack bot token", { exact: true }).press("Escape");
  assert.equal(await page.getByText("Secret binding staged. Save changes to apply it.").count(), 0);
  assert.equal(await save.isDisabled(), true);
  // The Harness authentication field and the Edit Slack drawer list it the same way.
  await waitForEnabled(page.getByLabel("API key Secret", { exact: true }));
  await operateDeniedSecretOption(page, "API key Secret", spare);
  await page.getByLabel("API key Secret", { exact: true }).press("Escape");
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await operateDeniedSecretOption(dialog, "Slack bot token", spare);
  await dialog.getByLabel("Slack bot token", { exact: true }).press("Escape");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // Nothing was saved: the drawer's only writes are its Slack directory lookups.
  assert.deepEqual(
    nonAuthWriteRequests(requests).filter(
      (request) => !request.path.endsWith("/channel-directory/lookup"),
    ),
    [],
  );

  // An operable Secret stages and saves as before. Operate on it is revoked after it is staged,
  // so the PATCH is refused: the refusal names the Secret and the grant, not Configuration
  // update, which this editor has.
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await selectSecret(page, "Slack bot token", extra);
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  operate.revoke(extra.id);
  const refused = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await save.click();
  assert.equal((await refused).status(), 403);
  await page
    .locator(".channel-secrets [role=alert]")
    .getByText(secretOperateRefused(extra.name), { exact: false })
    .waitFor();

  // With Configuration update revoked too, the answer cannot say operate is all that is missing:
  // the refusal keeps the text that names both grants.
  await selectSecret(page, "Slack bot token", other);
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  operate.revoke(other.id);
  revokeMemberGrant(fixture, "operate-only-editor", ["update", "configuration"]);
  const refusedAgain = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await save.click();
  assert.equal((await refusedAgain).status(), 403);
  const alert = page.locator(".channel-secrets [role=alert]");
  await alert.getByText(CONFIGURATION_SAVE_DENIED, { exact: false }).waitFor();
  assert.equal(
    await alert.getByText(secretOperateRefused(other.name), { exact: false }).count(),
    0,
  );
});

// An Agent whose harness key is bound, and a member with every write except Secret operate, which
// it holds on the bound key only. `withSpare` adds a readable Secret the member may not operate.
async function boundKeyMemberSetup(t: TestContext, name: string, { withSpare = false } = {}) {
  const slug = name.toLowerCase().replaceAll(" ", "-");
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  const bound = await fixture.createSecret(namespace.id, "Bound harness key", "sk-bound-value");
  const spare = withSpare
    ? await fixture.createSecret(namespace.id, "Spare key", "sk-spare-value")
    : undefined;
  const agent = await fixture.createAgent(
    namespace.id,
    `${name} Agent`,
    nativeValues(slug, { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: bound.ref }, executionMode: "dedicated" },
  );
  const member = await fixture.createNamespaceMember(
    `${slug}-member`,
    namespace.id,
    MEMBER_WRITE.filter(([action, kind]) => !(action === "operate" && kind === "secret")),
  );
  grantSecretOperate(fixture, namespace.id, member.principal, [bound.id]);
  return { fixture, namespace, bound, spare, agent, member };
}

// Creating a Secret does not grant operate on it. The picker read the operate answer when its list
// opened, before the Secret existed, so a member who may create and read Secrets but operate only
// the bound one saw the new Secret staged and the save refused with an audited 403 (finding 2486).
// After an inline create the picker reads the answer again and refuses the new Secret in place.
test("a Secret created inline that the member cannot operate is not staged", async (t) => {
  // Operate covers every readable Secret, so the answer is empty until the new Secret exists.
  const { fixture, namespace, bound, agent, member } = await boundKeyMemberSetup(
    t,
    "Inline operate",
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const answers: number[] = [];
  page.on("response", (response) => {
    if (response.url() === `${fixture.origin}${path}/permissions/secrets`) {
      answers.push(response.status());
    }
  });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  const picker = page.getByLabel("API key Secret", { exact: true });
  await waitForInputValue(picker, bound.name);
  await waitForEnabled(picker);
  await picker.fill("no matching Secret");
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create harness authentication Secret" });
  await dialog.getByLabel("Name", { exact: true }).fill("Inline new key");
  await dialog.getByLabel("Value", { exact: true }).fill("sk-inline-new-value");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  // The Secret exists, but the field keeps the bound Secret and names why the new one is refused.
  await page
    .getByText(`Inline new key cannot be chosen. ${SECRET_OPERATE_DENIED}`, { exact: true })
    .waitFor();
  assert.equal(await picker.inputValue(), bound.name);
  assert.equal(await page.getByText("Secret binding staged. Save changes to apply it.").count(), 0);
  // The answer was read once when the list opened and again after the create.
  assert.deepEqual(answers, [200, 200]);
  // The new Secret is listed disabled with the reason.
  const created = wireBody(
    fixture,
    SecretListResponse,
    (await fixture.request("GET", `/namespaces/${namespace.id}/secrets`)).body,
  ).data.find((secret) => secret.name === "Inline new key");
  assert.ok(created);
  await operateDeniedSecretOption(page, "API key Secret", created);
  await picker.press("Escape");
  // The only write is the Secret create: no save was sent, so no denial was audited.
  assert.deepEqual(
    nonAuthWriteRequests(requests).map(
      ({ method, path: requestPath }) => `${method} ${requestPath}`,
    ),
    [`POST /namespaces/${namespace.id}/secrets`],
  );
});

// A member denied operate on a readable Secret holds Secret operate per Secret, so a Secret it
// creates gets none. The picker offered Create new Secret anyway: the Secret was saved, then
// refused as a choice and left unused (finding 2500). The action is listed disabled with the
// reason the Preset's Create new Secret choice gives, before anything is created.
test("the picker's Create new Secret is disabled when operate covers only some Secrets", async (t) => {
  const { fixture, namespace, bound, spare, agent, member } = await boundKeyMemberSetup(
    t,
    "Operate some",
    { withSpare: true },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  const picker = page.getByLabel("API key Secret", { exact: true });
  await waitForInputValue(picker, bound.name);
  await waitForEnabled(picker);
  assert.ok(spare);
  await operateDeniedSecretOption(page, "API key Secret", spare);
  const create = await deniedCreateSecretOption(page, "API key Secret", NEW_SECRET_OPERATE_DENIED);
  // A forced click skips the disabled check: choosing the action still opens nothing.
  await create.click({ force: true });
  assert.equal(await page.getByRole("dialog").count(), 0);
  await picker.press("Escape");
  // The hint names the grant an administrator can give: operate on one Secret (finding 2507).
  await page
    .getByText(
      `Choose an existing Secret. ${NEW_SECRET_OPERATE_DENIED} ${NEW_SECRET_OPERATE_REMEDY}`,
      { exact: true },
    )
    .waitFor();
  assert.equal(await picker.inputValue(), bound.name);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// A tab parked before the answer landed is shown again with the answer applied (finding 2421).
test("a Channels tab parked before a reader's permission answer returns read-only", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Parked reader tab");
  const agent = await fixture.createAgent(namespace.id, "Parked reader Agent", nativeValues("v1"), {
    harnessAuth: { method: "runtime" },
  });
  const reader = await fixture.createNamespaceMember("parked-reader", namespace.id, AGENT_READ);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const firstPermissions = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  await page.clock.install();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "channels"),
    reader.credentials,
  );
  await firstPermissions.requested;
  // The held answer keeps the page behind its stand-in until the overview's bounded wait runs
  // out; run it out rather than wait for it.
  await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
  await page.getByText(/^Save and Disable update only the shared Configuration draft\./).waitFor();
  // Park the editor's Channels view, then let the answer land on the Configuration tab.
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
  firstPermissions.release();
  await page.getByText(CONFIGURATION_READ_ONLY, { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await expectNoText(page, /^Save and Disable update only the shared Configuration draft\./, () =>
    page.getByText(CHANNELS_READ_ONLY, { exact: true }).waitFor(),
  );
});

// A draft refresh reads the permission answer again. When the reread revokes Configuration
// update after the rebuilt tab was drawn, the notice, the Versions entry and the Configuration
// tab turn read-only without a page Refresh (finding 2421).
test("a permission reread after a save turns the draft read-only", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Reread revocation");
  const agent = await fixture.createAgent(namespace.id, "Reread Agent", nativeValues("v1"), {
    harnessAuth: { method: "runtime" },
  });
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const editor = await fixture.createNamespaceMember("reread-editor", namespace.id, [
    ...AGENT_READ,
    ["update", "configuration"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    editor.credentials,
  );
  assert.equal(
    wireBody(fixture, AgentCallerPermissionsResponse, await (await permissions).json()).data
      .configurationUpdate,
    true,
  );
  const entry = versionChooser(page).locator('option[value="draft"]');
  await entry.filter({ hasText: "Editable Configuration" }).waitFor({ state: "attached" });
  // Configuration update alone keeps the draft editable, so the notice is not a reader's.
  await page
    .getByText(
      "New version. Changes affect future deployments using this Configuration. Admitted versions stay unchanged.",
      { exact: true },
    )
    .waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nativeValues("edited")));
  // The save reaches the API with the grant; the grant is revoked before its answer returns, so
  // the draft refresh's reread denies Configuration update.
  const patch = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    { method: "PATCH", afterServer: true, once: true },
  );
  const reread = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await patch.requested;
  revokeMemberGrant(fixture, "reread-editor", ["update", "configuration"]);
  patch.release();
  await reread.requested;
  // The rebuilt tab is drawn from the previous answer while the reread is held.
  await page.getByText("Configuration saved.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
  const answer = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  reread.release();
  assert.equal(
    wireBody(fixture, AgentCallerPermissionsResponse, await (await answer).json()).data
      .configurationUpdate,
    false,
  );
  await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).waitFor();
  await entry.filter({ hasText: "Read-only Configuration" }).waitFor({ state: "attached" });
  await page.getByText(CONFIGURATION_READ_ONLY, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Configuration" }).count(), 0);
});

test("a negative permission answer reaching an open Stop or Delete dialog prevents submission", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Open confirmation");
  const agent = await fixture.createAgent(
    namespace.id,
    "Confirmation race Agent",
    nativeValues("race"),
    {
      harnessAuth: { method: "runtime" },
    },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const viewer = await fixture.createNamespaceMember(
    "confirmation-viewer",
    namespace.id,
    AGENT_READ,
  );
  const url = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  const permissionPath =
    fixture.origin + "/namespaces/" + namespace.id + "/agents/" + agent.id + "/permissions";
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.clock.install();
  for (const action of ["Stop", "Delete"]) {
    // Delay delivery, not authorization: these are the controller's actual flags for this viewer.
    const permissions = await holdRequests(t, page, permissionPath, {
      afterServer: true,
      timeout: 0,
    });
    if (action === "Stop") {
      await login(page, fixture, url, viewer.credentials);
    } else {
      await page.goto(url.href);
    }
    const received = await permissions.requested;
    assert.ok(received);
    // The held answer keeps the page behind its stand-in until the overview's bounded wait runs
    // out; run it out rather than wait for it.
    await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
    assert.deepEqual(
      {
        status: received.status(),
        data: wireBody(fixture, AgentCallerPermissionsResponse, await received.json()).data,
      },
      {
        status: 200,
        data: {
          update: false,
          deploy: false,
          operate: false,
          delete: false,
          administer: false,
          configurationUpdate: false,
          configurationRead: true,
          configurationSecretsOperate: false,
          configurationSecretsOperateDeniedBindings: [],
          agentSourcesOperate: false,
          sandboxPolicyRead: false,
          readLogs: false,
        },
      },
    );

    await page.getByRole("button", { name: action + " Agent", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", {
      name: action === "Stop" ? "Stop Agent" : "Permanently delete Agent",
    });
    await confirm.focus();
    permissions.release();
    const refusal = dialog.getByText(/Your access does not include/);
    await refusal.waitFor();
    const reason = text(await refusal.textContent()).trim();
    assert.equal(await confirm.isDisabled(), true);
    assert.equal(
      await page.evaluate(() => globalThis.document.activeElement?.textContent),
      "Cancel",
    );
    // The confirmation stays in the Tab order, described by the refusal, and sends nothing
    // (finding 2935).
    await expectReachableReason(page, confirm, reason);
    // Exercise the submit guard separately from the button's disabled behavior.
    await confirm.dispatchEvent("click");
    await settlePageRequests(page);
    assert.deepEqual(nonAuthWriteRequests(requests), []);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.locator("dialog[open]").waitFor({ state: "detached" });
    // The row this viewer used stays, with the reason, instead of vanishing under them.
    const row = page.getByRole("region", { name: action + " Agent", exact: true });
    await row
      .getByRole("status")
      .getByText(/Your access does not include/)
      .waitFor();
    const control = row.getByRole("button", { name: action + " Agent", exact: true });
    assert.equal(await control.isDisabled(), true);
    // Focus returns to the row's control, which stays focusable and says why, as on the Agents
    // list (findings 2926, 2935).
    await page
      .waitForFunction(
        (name) => {
          const active = globalThis.document.activeElement;
          return (
            active?.closest("section")?.querySelector("h3")?.textContent === name &&
            active.getAttribute("aria-disabled") === "true"
          );
        },
        action + " Agent",
        { timeout: 3000 },
      )
      .catch(async (error) => {
        const active = await page.evaluate(() => globalThis.document.activeElement?.outerHTML);
        throw new Error(`focus is on ${active?.slice(0, 200)}`, { cause: error });
      });
    await expectReachableReason(page, control, reason);
    await page.unroute(permissionPath);
  }
});

// A `null` passed to replaceChildren is painted as the text "null" (finding 1567).
test("the draft Configuration card paints no stray text beside its controls", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Configuration card", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Configuration Card Agent",
    nativeValues("card"),
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Configuration Card Agent" }).waitFor();
  const card = page.locator(".configuration-draft-editor");
  const strayText = () =>
    card.evaluate((node) =>
      [...node.childNodes]
        .filter((child) => child.nodeType === child.TEXT_NODE)
        .map((child) => child.textContent),
    );

  await card.getByText("View native Configuration").waitFor();
  assert.deepEqual(await strayText(), []);

  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await card.getByText("View native Configuration").waitFor();
  assert.deepEqual(await strayText(), []);
});

// Agent-side saves check operate on every Secret the Configuration binds, so the administrator's
// bot token Secret also makes Plugins, Repositories and the authentication source read-only for
// this member. Rebinding the bot token on the member's own Secret lifts that: the page reads the
// answer again and those tabs become editable without a reload (finding 2470).
test("a channel save that rebinds a denied Secret makes the Agent-side tabs editable", async (t) => {
  const { fixture, namespace, agent, member, app, own, path, configurationPath } =
    await replaceSecretFixture(t, "Rebound sources editor", { agentUpdate: true });
  const { page } = await newPage(t, fixture);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"),
    member.credentials,
  );
  assert.equal(
    wireBody(fixture, AgentCallerPermissionsResponse, await (await permissions).json()).data
      .agentSourcesOperate,
    false,
  );
  await page.getByText(PLUGINS_READ_ONLY, { exact: true }).waitFor();
  await page
    .getByText(`${AGENT_SOURCES_DENIED} Missing Secret operate on Admin bot token.`, {
      exact: true,
    })
    .waitFor();
  // Repositories is drawn now and parked, so its rebuild is proved too, not only a first draw.
  await page.getByRole("tab", { name: "Repositories", exact: true }).click();
  await page.getByText(AGENT_SOURCES_DENIED, { exact: true }).waitFor();
  assert.equal(await page.locator("#repository-selection-title").count(), 0);
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  const saveSource = page.getByRole("button", { name: "Save authentication source" });
  await page
    .getByText(`${AGENT_SOURCES_DENIED} Missing Secret operate on Admin bot token.`, {
      exact: true,
    })
    .waitFor();
  assert.equal(await saveSource.isDisabled(), true);

  await selectSecret(page, "Slack bot token", own);
  const saving = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  const reread = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  assert.equal((await saving).status(), 200);
  assert.equal(
    wireBody(fixture, AgentCallerPermissionsResponse, await (await reread).json()).data
      .agentSourcesOperate,
    true,
  );
  // The authentication source form is updated in place; the panel keeps its saved state.
  await expectNoText(page, AGENT_SOURCES_DENIED, () => waitForEnabled(saveSource));
  await waitForInputValue(page.getByLabel("Slack app token"), secretOptionLabel(app));
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("button", { name: "Save plugin selections" }).waitFor();
  assert.equal(await page.getByText(PLUGINS_READ_ONLY, { exact: true }).count(), 0);
  await page.getByRole("tab", { name: "Repositories", exact: true }).click();
  // The editor's selection, not the read-only summary with the sources note.
  await expectNoText(page, AGENT_SOURCES_DENIED, () =>
    page.locator("#repository-selection-title").waitFor(),
  );
});

// A tab drawn after the save but before the page's reread answers shows the old denial; the
// answer rebuilds it while it is shown (finding 2470).
test("a Plugins tab shown before the reread answers becomes editable when it lands", async (t) => {
  const { fixture, namespace, agent, member, own, path, configurationPath } =
    await replaceSecretFixture(t, "Held reread editor", { agentUpdate: true });
  const { page } = await newPage(t, fixture);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  await permissions;
  await selectSecret(page, "Slack bot token", own);
  const reread = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  const saving = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  assert.equal((await saving).status(), 200);
  await reread.requested;
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByText(PLUGINS_READ_ONLY, { exact: true }).waitFor();
  reread.release();
  await expectNoText(page, AGENT_SOURCES_DENIED, () =>
    page.getByRole("button", { name: "Save plugin selections" }).waitFor(),
  );
});

// Disable Slack saves no bindings, so it keeps the administrator's bot token Secret bound and the
// API would refuse it. The card offers it disabled, naming the binding to rebind first; after Edit
// Slack rebinds it, Disable saves (finding 2471). The Channels drawer saves the same bindings:
// while the administrator's bot token Secret stays bound, its save is refused before any request;
// replacing it saves (finding 2444).
test("the Channels drawer and Disable Slack wait until the replace persona rebinds the denied Secret", async (t) => {
  const { fixture, namespace, agent, member, app, own, configurationPath } =
    await replaceSecretFixture(t, "Replaced disable editor");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "channels"),
    member.credentials,
  );
  const disable = page.getByRole("button", { name: "Disable Slack" });
  await page.getByText(DISABLE_KEEPS_BOT_TOKEN, { exact: true }).waitFor();
  assert.equal(await disable.isDisabled(), true);
  // Disable stays in the Tab order, described by that hint (class of finding 2899).
  await expectReachableReason(page, disable, DISABLE_KEEPS_BOT_TOKEN);
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByText(REPLACE_BOT_TOKEN, { exact: false }).waitFor();
  // A channel setting alone keeps the administrator's Secret bound: refused up front.
  await dialog.getByLabel("Require a mention").setChecked(false);
  requests.length = 0;
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await dialog.getByText(KEEPS_BOT_TOKEN, { exact: true }).waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  // With the member's own Secret for the bot token the same save goes through.
  await selectSecret(dialog, "Slack bot token", own);
  const rebinding = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  assert.equal((await rebinding).status(), 200);
  const rebound = wireBody(
    fixture,
    ConfigurationResponse,
    (await fixture.request("GET", configurationPath)).body,
  );
  assert.equal(bindingSource(rebound.data, "SLACK_BOT_TOKEN").id, own.id);
  assert.equal(bindingSource(rebound.data, "SLACK_APP_TOKEN").id, app.id);
  await expectNoText(page, DISABLE_KEEPS_BOT_TOKEN, () => waitForEnabled(disable));
  const disabling = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await disable.click();
  assert.equal((await disabling).status(), 200);
  const saved = wireBody(
    fixture,
    ConfigurationResponse,
    (await fixture.request("GET", configurationPath)).body,
  );
  assert.equal(object(object(object(saved.data.values).channels).slack).enabled, false);
});
