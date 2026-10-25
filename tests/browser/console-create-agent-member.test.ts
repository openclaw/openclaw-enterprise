import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page, Route } from "playwright";

import type {
  AgentResponse,
  NamespaceListResponse,
  NamespaceWire,
  SecretWire,
} from "../../packages/contracts/src/api/resources.ts";

import { apiErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  holdRequests,
  login,
  MEMBER_WRITE,
  newPage,
  operateDeniedSecretOption,
  selectSecret,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";
import { waitForCreateFormReads } from "./console-agents-test-support.mjs";
import { GENERIC_DENIAL, SECRET_OPERATE_DENIED } from "../helpers/refusal-text.mjs";

// Create Agent for a Namespace member (UX plan A2, spec 3.11; findings 1901, 493). The real
// Native IAM Driver answers every read and write: the member's GET /installation is refused, and
// the Namespace's permission answer says whether it may create Agents.

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);

const ACCESS_FROM_PRESET =
  "You can create Agents in Member team. Installation-wide capabilities are not readable with your access, so the options below come from this Namespace's Presets.";
const MEMBER_CREDENTIAL_ACCESS =
  "An Installation administrator then gives the new Agent access to its Secrets.";
const MEMBER_GRANT_REFUSED =
  "The Agent was created as a draft. Giving it access to its saved model and channel Secrets needs Installation administration access: open the saved Agent and ask an Installation administrator to grant it.";
const INSTALLATION_REFUSAL =
  "Creating an Agent needs Installation access that your account does not have. Ask an Installation administrator to create this Agent.";

// Every console API answer, as "METHOD path status".
function apiResponses(page: Page, origin: string) {
  const answers: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && !url.pathname.startsWith("/console")) {
      answers.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
    }
  });
  return answers;
}

async function setup(t: TestContext) {
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Member team", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Team OpenAI key", "sk-member-team");
  return { fixture, namespace, secret };
}

// Start from the default Preset with the Namespace's model Secret and a manual model ID.
async function fillDefaultPreset(page: Page, secret: SecretWire, name: string) {
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).fill(name);
  await selectSecret(page, "API key Secret", secret);
  const model = page.getByLabel("Model ID", { exact: true });
  if (!(await model.isVisible())) {
    await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  }
  await model.fill("gpt-5.1");
  await model.press("Tab");
  await waitForCreateFormReads(page);
}

test("a member with Agent create completes the default Preset path without Installation access", async (t) => {
  const { fixture, namespace, secret } = await setup(t);
  const writer = await fixture.createNamespaceMember("member-write", namespace.id, MEMBER_WRITE);
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`, writer.credentials);
  const open = page.getByRole("button", { name: "Create Agent", exact: true });
  await waitForEnabled(open);
  await open.click();
  await fillDefaultPreset(page, secret, "Member Agent");

  // The real API refused the Installation read; the form goes on and says why, above the form.
  assert.deepEqual(
    answers.filter((answer) => answer.startsWith("GET /installation ")),
    ["GET /installation 403"],
  );
  const access = page.locator("#create-agent-access");
  assert.equal(await access.getAttribute("role"), "status");
  assert.equal(await access.getAttribute("data-tone"), "info");
  assert.equal(await access.locator(".status-label").textContent(), "Your access");
  assert.deepEqual(await access.locator(".status-body").allTextContents(), [
    `${ACCESS_FROM_PRESET} ${MEMBER_CREDENTIAL_ACCESS}`,
  ]);
  assert.equal(await access.isVisible(), true);
  // Above the form, not mid-form.
  assert.equal(await access.evaluate((node) => node.nextElementSibling?.id), "create-agent-form");
  assert.equal(await page.getByText(INSTALLATION_REFUSAL).count(), 0);
  // Without the Installation's capabilities the line under the fields claims no deploy outcome.
  assert.equal(
    await page.locator("#create-agent-capability-status").textContent(),
    "Agents you create here are saved as drafts for later deployment.",
  );
  assert.equal(await page.getByRole("button", { name: "Retry capability check" }).isHidden(), true);
  // The form names the Preset it started from.
  assert.equal(
    await page.locator("#create-agent-form .badge").first().textContent(),
    "From Preset · default-codex",
  );

  // Create is enabled with no unexplained refusal, and the real API creates the Agent.
  const submit = page.getByRole("button", { name: "Create Agent", exact: true });
  assert.equal(await submit.isEnabled(), true);
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await submit.click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const { data: created }: AgentResponse = await response.json();
  assert.equal(created.name, "Member Agent");
  assert.deepEqual(created.harnessAuth, { method: "api_key", source: secret.ref });
  // Granting the Agent's credential access is Installation administration, which the API refuses
  // the member: the form names who finishes it instead of a generic denial.
  await page.getByRole("alert").filter({ hasText: MEMBER_GRANT_REFUSED }).waitFor();
  const agentLink = await page.getByRole("link", { name: "Open saved Agent" }).getAttribute("href");
  assert.ok(agentLink);
  assert.match(agentLink, new RegExp(created.id));
  // Every write the console tried was the member's own Namespace work; nothing touched the
  // Installation.
  assert.deepEqual(
    answers.filter((answer) => !answer.startsWith("GET ") && !answer.includes("/auth/")),
    [
      `POST /namespaces/${namespace.id}/agents/validate 204`,
      `POST /namespaces/${namespace.id}/configurations 201`,
      `POST /namespaces/${namespace.id}/agents 201`,
    ],
  );
  // The session's /observability read already found Installation administration refused, so the
  // form sends no IAM read the API is certain to refuse and audit as a denial, and offers no
  // retry of it (finding 2109).
  assert.ok(answers.includes("GET /observability 403"), answers.join("\n"));
  assert.deepEqual(
    answers.filter((answer) => answer.includes("/iam/")),
    [],
  );
  assert.equal(await page.getByRole("button", { name: "Retry credential access" }).count(), 0);
  assert.equal(
    await page
      .getByText(/retr(?:y|ies)/i)
      .filter({ visible: true })
      .count(),
    0,
  );
});

test("a member without Agent create never sees the form, and Create Agent names why", async (t) => {
  const { fixture, namespace } = await setup(t);
  const actions = MEMBER_WRITE.filter(
    ([action, kind]) => !(action === "create" && kind === "agent"),
  );
  const limited = await fixture.createNamespaceMember("member-no-create", namespace.id, actions);
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`, limited.credentials);
  const open = page.getByRole("button", {
    name: "Create Agent",
    exact: true,
    description: "Your access does not include creating Agents in this Namespace.",
  });
  await open.waitFor();
  assert.equal(await open.isDisabled(), true);

  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Creating Agents is not available" }).waitFor();
  assert.equal(await page.locator("#create-agent-form").count(), 0);
  assert.equal(await page.locator("#create-agent-access").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Start with default Preset" }).count(), 0);
  assert.deepEqual(
    answers.filter((answer) => answer.startsWith("GET /installation ")),
    [],
  );
});

test("an administrator's form reads the Installation and shows no access note", async (t) => {
  const { fixture, namespace, secret } = await setup(t);
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await fillDefaultPreset(page, secret, "Administrator Agent");
  assert.deepEqual(
    answers.filter((answer) => answer.startsWith("GET /installation ")),
    ["GET /installation 200"],
  );
  assert.equal(await page.locator("#create-agent-access").isHidden(), true);
  assert.equal(
    await page.locator("#create-agent-form .badge").first().textContent(),
    "From Preset · default-codex",
  );
  assert.equal(
    await page.getByRole("button", { name: "Create Agent", exact: true }).isEnabled(),
    true,
  );
});

const ACCESS_WITHOUT_PRESET =
  "You can create Agents in Member team. Installation-wide capabilities are not readable with your access, so Create Agent checks the Configuration with the server before saving it.";
const PERMISSIONS_UNREAD =
  "Your permissions in this Namespace could not be checked, and Installation-wide capabilities are not readable with your access. Retry the permission check before creating an Agent.";
const CREDENTIAL_ACCESS_UNCONFIRMED =
  "The Agent was created, but credential access is not confirmed.";

function unavailable(route: Route) {
  return route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Try again."));
}

test("a member whose permission check failed is told so and retries only that check", async (t) => {
  const { fixture, namespace } = await setup(t);
  const writer = await fixture.createNamespaceMember("member-write", namespace.id, MEMBER_WRITE);
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  const permissionsPath = `${fixture.origin}/namespaces/${namespace.id}/permissions`;
  await page.route(permissionsPath, unavailable);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`, writer.credentials);
  // An unknown answer keeps Create Agent; the API decides.
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("button", { name: "Start without Preset", exact: true }).click();

  // The refused Installation read and the failed permission check do not add up to "your account
  // lacks Installation access": the form says which check failed and offers it again (finding 2110).
  const status = page.locator("#create-agent-capability-status");
  await page.getByText(PERMISSIONS_UNREAD, { exact: true }).waitFor();
  assert.equal(await page.getByText(INSTALLATION_REFUSAL).count(), 0);
  assert.equal(await page.locator("#create-agent-access").isHidden(), true);
  const submit = page.getByRole("button", { name: "Create Agent", exact: true });
  assert.equal(await submit.isDisabled(), true);
  const retry = page.getByRole("button", { name: "Retry permission check", exact: true });
  await waitForEnabled(retry);
  const permissionReads = () =>
    answers.filter((answer) => answer.startsWith(`GET /namespaces/${namespace.id}/permissions `));
  const failedReads = permissionReads().length;

  // A retry that fails again says so again and stays available.
  const failing = await holdRequests(t, page, permissionsPath, {
    once: true,
    fulfill: apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "x"),
  });
  await retry.click();
  await failing.requested;
  assert.equal(await status.textContent(), "Checking your permissions in this Namespace…");
  assert.equal(await retry.isDisabled(), true);
  failing.release();
  await page.getByText(PERMISSIONS_UNREAD, { exact: true }).waitFor();
  await waitForEnabled(retry);
  assert.equal(await submit.isDisabled(), true);

  // The retry rereads the permission answer only: the Installation read stays refused.
  const reread = await holdRequests(t, page, permissionsPath, { once: true });
  await retry.click();
  await reread.requested;
  assert.equal(await status.textContent(), "Checking your permissions in this Namespace…");
  assert.equal(await retry.isDisabled(), true);
  reread.release();
  const access = page.locator("#create-agent-access");
  await access.waitFor();
  // The hidden retry hands focus to the answer, not the page.
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.id),
    "create-agent-access",
  );
  assert.deepEqual(await access.locator(".status-body").allTextContents(), [
    `${ACCESS_WITHOUT_PRESET} ${MEMBER_CREDENTIAL_ACCESS}`,
  ]);
  assert.equal(
    await status.textContent(),
    "Agents you create here are saved as drafts for later deployment.",
  );
  assert.equal(await retry.count(), 0);
  assert.deepEqual(
    answers.filter((answer) => answer.startsWith("GET /installation ")),
    ["GET /installation 403"],
  );
  assert.deepEqual(permissionReads().slice(failedReads), [
    `GET /namespaces/${namespace.id}/permissions 503`,
    `GET /namespaces/${namespace.id}/permissions 200`,
  ]);

  // Start over keeps the answer: the new form goes straight to the member path.
  await page.getByRole("button", { name: "Start over", exact: true }).click();
  await page.getByRole("button", { name: "Start without Preset", exact: true }).click();
  await page.locator("#create-agent-access").waitFor();
  assert.equal(await page.getByText(PERMISSIONS_UNREAD).count(), 0);
  assert.equal(permissionReads().length, failedReads + 2);
});

test("a temporary Installation read failure keeps an administrator off the member path", async (t) => {
  const { fixture, namespace } = await setup(t);
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  const installationPath = `${fixture.origin}/installation`;
  await page.route(installationPath, unavailable);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset", exact: true }).click();
  // The permission answer grants Agent create, but only a refusal means the Installation is not
  // readable with this access: an outage offers the retry (finding 2113).
  await page.getByText(/^Installation capabilities unavailable\. /).waitFor();
  assert.equal(await page.locator("#create-agent-access").isHidden(), true);
  assert.equal(
    await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
    true,
  );
  await page.unroute(installationPath, unavailable);
  await page.getByRole("button", { name: "Retry capability check", exact: true }).click();
  await waitForCreateFormReads(page);
  await page.getByText(/^Installation capabilities unavailable\. /).waitFor({ state: "detached" });
  assert.equal(await page.locator("#create-agent-access").isHidden(), true);
  assert.deepEqual(
    answers.filter((answer) => answer.startsWith("GET /installation ")),
    ["GET /installation 503", "GET /installation 200"],
  );
});

test("a member's unconfirmed credential grant offers a retry until the API refuses it", async (t) => {
  const { fixture, namespace, secret } = await setup(t);
  const writer = await fixture.createNamespaceMember("member-write", namespace.id, MEMBER_WRITE);
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  // The session never learns whether this account administers the Installation, so the form
  // tries the grant.
  await page.route(`${fixture.origin}/observability`, unavailable);
  const rolesPath = `${fixture.origin}/namespaces/${namespace.id}/iam/roles`;
  await page.route(rolesPath, unavailable);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`, writer.credentials);
  await fillDefaultPreset(page, secret, "Member Agent");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  // An outage is not a refusal: the grant is unconfirmed and can be retried (finding 2113).
  await page.getByRole("alert").filter({ hasText: CREDENTIAL_ACCESS_UNCONFIRMED }).waitFor();
  assert.equal(await page.getByText(MEMBER_GRANT_REFUSED).count(), 0);
  const saved = page.getByRole("status").filter({ hasText: "Agent saved:" });
  assert.match(await saved.innerText(), /Retries reuse these resources/);
  await page.unroute(rolesPath, unavailable);
  await page.getByRole("button", { name: "Retry credential access", exact: true }).click();
  // The API refuses it as Installation administration: no retry can succeed (finding 2109).
  await page.getByRole("alert").filter({ hasText: MEMBER_GRANT_REFUSED }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry credential access" }).count(), 0);
  assert.equal(
    await page
      .getByText(/retr(?:y|ies)/i)
      .filter({ visible: true })
      .count(),
    0,
  );
  assert.deepEqual(
    answers.filter((answer) => answer.includes("/iam/")),
    [
      `GET /namespaces/${namespace.id}/iam/roles 503`,
      `GET /namespaces/${namespace.id}/iam/roles 403`,
    ],
  );
});

test("an administrator's refused credential grant keeps the retry and the API's answer", async (t) => {
  const { fixture, namespace, secret } = await setup(t);
  const { page } = await newPage(t, fixture);
  await page.route(`${fixture.origin}/namespaces/${namespace.id}/iam/roles`, (route) =>
    route.fulfill(apiErrorResponse(403, "FORBIDDEN", GENERIC_DENIAL)),
  );
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await fillDefaultPreset(page, secret, "Administrator Agent");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  // Only a member's refusal names an Installation administrator (finding 2113).
  await page
    .getByRole("alert")
    .filter({ hasText: `${CREDENTIAL_ACCESS_UNCONFIRMED} Access denied.` })
    .waitFor();
  assert.equal(await page.getByText(MEMBER_GRANT_REFUSED).count(), 0);
  await waitForEnabled(page.getByRole("button", { name: "Retry credential access", exact: true }));
});

test("a member's form links Create Agent to why a Namespace that turned failed refuses it", async (t) => {
  const { fixture, namespace } = await setup(t);
  const writer = await fixture.createNamespaceMember("member-write", namespace.id, MEMBER_WRITE);
  const { page } = await newPage(t, fixture);
  let status: NamespaceWire["status"] = "provisioning";
  await page.route(`${fixture.origin}/namespaces`, async (route) => {
    const response = await route.fetch();
    const body: NamespaceListResponse = await response.json();
    body.data = body.data.map((item) => (item.id === namespace.id ? { ...item, status } : item));
    await route.fulfill({ response, json: body });
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`, writer.credentials);
  await page.getByRole("button", { name: "Start without Preset", exact: true }).click();
  await page.locator("#create-agent-access").waitFor();
  const submit = page.getByRole("button", { name: "Create Agent", exact: true });
  assert.equal(await submit.getAttribute("aria-describedby"), null);
  status = "failed";
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event("focus")));
  await page
    .getByText("This Namespace cannot hold new Agents, so Create Agent is unavailable.", {
      exact: true,
    })
    .waitFor();
  // Settled without the Installation's capabilities, the member's form names why (finding 2113).
  assert.equal(await submit.isDisabled(), true);
  assert.equal(await submit.getAttribute("aria-describedby"), "create-agent-capability-status");
});

test("a member's refused Configuration create and empty Secret list name the access they need", async (t) => {
  const { fixture, namespace, secret } = await setup(t);
  const noConfiguration = await fixture.createNamespaceMember(
    "member-no-configuration",
    namespace.id,
    MEMBER_WRITE.filter(([action, kind]) => !(action === "create" && kind === "configuration")),
  );
  const noSecretRead = await fixture.createNamespaceMember(
    "member-no-secret-read",
    namespace.id,
    MEMBER_WRITE.filter(([action, kind]) => !(action === "read" && kind === "secret")),
  );

  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    `/console/agents/new?namespace=${namespace.id}`,
    noConfiguration.credentials,
  );
  await fillDefaultPreset(page, secret, "Member Agent");
  const configurationCreated = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal((await configurationCreated).status(), 403);
  // Not the generic "Access denied": the refused write and the grants it needs (finding 2111).
  await page
    .getByRole("alert")
    .filter({
      hasText:
        "You do not have permission to create this Agent's Configuration. Ask an administrator for Configuration create access in this Namespace, plus Secret operate on each Secret it binds.",
    })
    .waitFor();

  // The Secret list holds only readable Secrets, so an empty one is not "none exist".
  const { page: other } = await newPage(t, fixture);
  await login(
    other,
    fixture,
    `/console/agents/new?namespace=${namespace.id}`,
    noSecretRead.credentials,
  );
  await other.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  await other
    .getByText(
      "No Secrets you can read in this Namespace. Create a new Secret to bind this field, or ask an administrator for read access to an existing one.",
      { exact: true },
    )
    .first()
    .waitFor();
  assert.equal(await other.getByText(/^No readable Secrets yet\./).count(), 0);
});

// The Secrets page disables Create Secret when the Namespace's permission answer denies Secret
// create. Create Agent read the same answer but its inline Create Secret action still opened a
// dialog whose write the API refused (finding 2442). It stays listed, disabled with the reason.
test("a member without Secret create sees the inline Create Secret action disabled with the reason", async (t) => {
  const { fixture, namespace } = await setup(t);
  const noSecretCreate = await fixture.createNamespaceMember(
    "member-no-secret-create",
    namespace.id,
    MEMBER_WRITE.filter(([action, kind]) => !(action === "create" && kind === "secret")),
  );
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/new?namespace=${namespace.id}`,
    noSecretCreate.credentials,
  );
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  const denial = "Your access does not include creating Secrets in this Namespace.";
  await page.getByText(`Choose an existing Secret. ${denial}`, { exact: true }).first().waitFor();
  await page.getByLabel("API key Secret", { exact: true }).fill("no matching Secret");
  const action = page.getByRole("option", { name: `Create new Secret... ${denial}`, exact: true });
  await action.waitFor();
  assert.equal(await action.getAttribute("aria-disabled"), "true");
  // A forced click skips the disabled check: choosing the action still opens nothing.
  await action.click({ force: true });
  assert.equal(await page.getByRole("dialog").count(), 0);
  // The Configure Slack drawer's token fields get the same answer (finding 2451).
  await page.getByRole("button", { name: "Configure Slack", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Configure Slack" });
  await drawer.getByLabel("Slack app token", { exact: true }).fill("no matching Secret");
  const drawerAction = drawer.getByRole("option", {
    name: `Create new Secret... ${denial}`,
    exact: true,
  });
  await drawerAction.waitFor();
  assert.equal(await drawerAction.getAttribute("aria-disabled"), "true");
  assert.deepEqual(
    answers.filter((answer) => answer.startsWith("POST ") && answer.includes("/secrets")),
    [],
  );
});

// Agent create needs Secret operate on its Harness authentication Secret and on each Secret its
// Configuration binds. A member with operate on only some readable Secrets was offered the others
// in Create Agent and met a 403 after the click (finding 2469). Each Create Agent Secret field
// lists them disabled with the reason and never stages one. The people search field, which only
// a reader of the Installation sees, is covered in console-agent-plugin-approvers.
// A member with every Create Agent grant except Secret operate, which it has on the team key
// only, and a readable spare key it may not operate.
async function operateSomeSetup(t: TestContext) {
  const { fixture, namespace, secret } = await setup(t);
  const spare = await fixture.createSecret(namespace.id, "Spare key", "sk-member-spare");
  const member = await fixture.createNamespaceMember(
    "member-operate-some",
    namespace.id,
    MEMBER_WRITE.filter(([action, kind]) => !(action === "operate" && kind === "secret")),
  );
  fixture.policy.roles.push({
    id: "role-operate-team-key",
    namespaceId: namespace.id,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  fixture.policy.bindings.push({
    id: "binding-operate-team-key",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: member.principal.id,
    roleId: "role-operate-team-key",
    resourceKind: "secret",
    resourceId: secret.id,
  });
  const answerPath = `/namespaces/${namespace.id}/permissions/secrets`;
  return { fixture, namespace, secret, spare, member, answerPath };
}

test("Create Agent's Secret fields refuse a readable Secret the member cannot operate", async (t) => {
  const { fixture, namespace, secret, spare, member, answerPath } = await operateSomeSetup(t);
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  // The first pick is made before the answer arrives: it waits for the answer.
  const held = await holdRequests(t, page, `${fixture.origin}${answerPath}`, { once: true });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`, member.credentials);
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Operate-some Agent");
  const staged = page.getByText("Secret selected. Create Agent binds it.");
  await selectSecret(page, "API key Secret", spare);
  await held.requested;
  held.release();
  await page
    .getByText(`${spare.name} cannot be chosen. ${SECRET_OPERATE_DENIED}`, { exact: true })
    .waitFor();
  assert.equal(await staged.count(), 0);
  // Listed disabled with the reason. A forced click, Enter and the exact name on blur stage
  // nothing either.
  const denied = await operateDeniedSecretOption(page, "API key Secret", spare);
  await denied.click({ force: true });
  await page.getByLabel("API key Secret", { exact: true }).press("Enter");
  await page.getByLabel("API key Secret", { exact: true }).fill(spare.name);
  await page.getByLabel("API key Secret", { exact: true }).press("Tab");
  assert.equal(await staged.count(), 0);
  assert.notEqual(
    await page.getByLabel("API key Secret", { exact: true }).inputValue(),
    spare.name,
  );
  // The operable key stages as before.
  await selectSecret(page, "API key Secret", secret);
  await staged.waitFor();

  // The Slack token fields in the Channels drawer list it the same way.
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Configure Slack" });
  for (const label of ["Slack app token", "Slack bot token"]) {
    const option = await operateDeniedSecretOption(dialog, label, spare);
    await option.click({ force: true });
    await dialog.getByLabel(label, { exact: true }).press("Escape");
  }
  assert.equal(
    await dialog
      .getByText("Secret selected. Apply channel settings, then Create Agent binds it.")
      .count(),
    0,
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // One answer served every field, and nothing was written.
  assert.deepEqual(
    answers.filter((answer) => answer.includes(answerPath)),
    [`GET ${answerPath} 200`],
  );
  assert.deepEqual(
    answers.filter((answer) => !answer.startsWith("GET ") && !answer.includes("/auth/")),
    [],
  );
});

// The Preset's "Use existing Secret" choice becomes the Agent's Harness authentication Secret,
// which Agent create refuses without Secret operate on it (finding 2479). It lists the spare key
// disabled with the reason, and Use Preset refuses it, naming why, instead of staging it.
test("a Preset's existing Secret choice refuses a Secret the member cannot operate", async (t) => {
  const { fixture, namespace, secret, spare, member } = await operateSomeSetup(t);
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: JSON.parse(
      await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
    ),
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`, member.credentials);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Preset member Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Secret source for Model Secret", { exact: true }).selectOption("existing");
  const existing = page.getByLabel("Existing Secret for Model Secret", { exact: true });
  await waitForEnabled(existing);
  const spareOption = existing.locator(`option[value="${spare.id}"]`);
  assert.equal(await spareOption.isDisabled(), true);
  assert.equal(await spareOption.textContent(), `${spare.name} (${SECRET_OPERATE_DENIED})`);
  assert.equal(await existing.locator(`option[value="${secret.id}"]`).isDisabled(), false);
  // A choice the list cannot offer, as a restored or scripted value, is refused with the reason.
  await existing.evaluate((select: HTMLSelectElement, id: string) => {
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, spare.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page
    .getByText(`${spare.name} cannot be chosen. ${SECRET_OPERATE_DENIED}`, { exact: true })
    .waitFor();
  assert.equal(await page.locator("#create-agent-form").count(), 0);
  // The operable key is used as before.
  await existing.selectOption(secret.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page
    .getByText("Preset authentication: API key · Secret configured", { exact: true })
    .waitFor();
});

// A refused create can follow a revoked grant, so the form reads the Secret answer again when a
// field next opens, as the Agent page does after a refused save.
test("a refused Create reads the Secret answer again", async (t) => {
  const { fixture, namespace, secret, member, answerPath } = await operateSomeSetup(t);
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`, member.credentials);
  await fillDefaultPreset(page, secret, "Refused member Agent");
  // Configuration create and operate on the chosen key are revoked after it is staged.
  const role = fixture.policy.roles.find((item) => item.id === "role-member-operate-some");
  assert.ok(role);
  role.permissions = role.permissions.filter(
    (permission) =>
      !(permission.action === "create" && permission.resourceKind === "configuration"),
  );
  fixture.policy.bindings.splice(
    fixture.policy.bindings.findIndex((binding) => binding.id === "binding-operate-team-key"),
    1,
  );
  const refused = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal((await refused).status(), 403);
  // The field reads the answer again and now lists the key disabled with the reason.
  await operateDeniedSecretOption(page, "API key Secret", secret);
  assert.deepEqual(
    answers.filter((answer) => answer.includes(answerPath)),
    [`GET ${answerPath} 200`, `GET ${answerPath} 200`],
  );
});
