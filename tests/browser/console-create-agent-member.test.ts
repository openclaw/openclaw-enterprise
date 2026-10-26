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
  deniedCreateSecretOption,
  grantMember,
  grantSecretOperate,
  holdRequests,
  login,
  MEMBER_WRITE,
  memberWriteWithout,
  newPage,
  operateDeniedSecretOption,
  revokeMemberGrant,
  selectSecret,
  waitForCondition,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";
import { waitForCreateFormReads } from "./console-agents-test-support.mjs";
import {
  AGENT_CREATE_DENIED,
  GENERIC_DENIAL,
  SECRET_CREATE_DENIED,
  NEW_SECRET_OPERATE_DENIED,
  NEW_SECRET_OPERATE_REMEDY,
  SECRET_OPERATE_DENIED,
  AGENT_CREATE_INSTALLATION_DENIED,
} from "../helpers/refusal-text.mjs";

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
  "The Agent was created as a draft. Giving it access to its saved model and channel Secrets needs Installation administration. Ask an Installation administrator to open the saved Agent and grant it.";
const INSTALLATION_REFUSAL = AGENT_CREATE_INSTALLATION_DENIED;

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

const standardCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
);

// The shipped standard Preset, whose model Secret the member chooses or creates.
async function createStandardPreset(
  fixture: Awaited<ReturnType<typeof createConsoleAppFixture>>,
  namespaceId: string,
) {
  const preset = await fixture.request("POST", `/namespaces/${namespaceId}/presets`, {
    body: standardCodexPreset,
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  return preset;
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
  const limited = await fixture.createNamespaceMember(
    "member-no-create",
    namespace.id,
    memberWriteWithout(["create", "agent"]),
  );
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`, limited.credentials);
  const open = page.getByRole("button", {
    name: "Create Agent",
    exact: true,
    // The list's reason gives the Create Agent page's next step (finding 2508).
    description: AGENT_CREATE_DENIED,
  });
  await open.waitFor();
  assert.equal(await open.isDisabled(), true);

  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Creating Agents is not available" }).waitFor();
  // Namespace Roles cannot grant Agent create, so the note sends the member to whoever can
  // create the Agent rather than promising access (finding 2496).
  await page.getByRole("status").getByText(AGENT_CREATE_DENIED, { exact: true }).waitFor();
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

const ADMINISTRATOR_GRANT_REQUEST = "req_00000000-0000-4000-8000-000000002543";
const ADMINISTRATOR_GRANT_REFUSED = `${CREDENTIAL_ACCESS_UNCONFIRMED} Access denied. You do not have permission for this operation. Retry credential access, or open the saved Agent and ask an administrator to check access to its saved model and channel Secrets. Request ID: ${ADMINISTRATOR_GRANT_REQUEST}`;

test("an administrator's refused credential grant keeps the retry and the API's answer", async (t) => {
  const { fixture, namespace, secret } = await setup(t);
  const { page } = await newPage(t, fixture);
  await page.route(`${fixture.origin}/namespaces/${namespace.id}/iam/roles`, (route) =>
    route.fulfill(
      apiErrorResponse(403, "FORBIDDEN", GENERIC_DENIAL, {
        requestId: ADMINISTRATOR_GRANT_REQUEST,
      }),
    ),
  );
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await fillDefaultPreset(page, secret, "Administrator Agent");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  // Only a member's refusal names an Installation administrator (finding 2113): the
  // administrator is one, so the whole alert names nobody to ask for the grant (finding 2543).
  const alert = page.getByRole("alert").filter({ hasText: CREDENTIAL_ACCESS_UNCONFIRMED });
  await alert.waitFor();
  const alertText = await alert.textContent();
  assert.doesNotMatch(alertText ?? "", /Installation administrat/);
  assert.equal(alertText, ADMINISTRATOR_GRANT_REFUSED);
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
    memberWriteWithout(["create", "configuration"]),
  );
  const noSecretRead = await fixture.createNamespaceMember(
    "member-no-secret-read",
    namespace.id,
    memberWriteWithout(["read", "secret"]),
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
        "You do not have permission to create this Agent's Configuration. It needs Configuration create in this Namespace, which only an Installation administrator holds, plus Secret operate on each Secret it binds. Ask an Installation administrator to create this Agent.",
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
      "No Secrets you can read in this Namespace. Create a new Secret to bind this field, or ask an Installation administrator for Secret read and operate on an existing one.",
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
    memberWriteWithout(["create", "secret"]),
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
  const denial = SECRET_CREATE_DENIED;
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
  // Its hints offer no Secret create either (finding 2483).
  await drawer
    .getByText("Choose existing Slack token Secrets before creating the Agent.", { exact: true })
    .waitFor();
  assert.equal(await drawer.getByText(/or create/).count(), 0);
  assert.deepEqual(
    answers.filter((answer) => answer.startsWith("POST ") && answer.includes("/secrets")),
    [],
  );
});

// A Preset's Harness authentication Secret offered "Create new Secret" as its source, and said
// "Create a new Secret instead", to a member the API would refuse Secret create (finding 2483).
// The source is listed disabled with the reason, and the field binds an existing Secret.
test("a Preset's Secret source follows the member's Secret create answer", async (t) => {
  const { fixture, namespace, secret } = await setup(t);
  const noSecretCreate = await fixture.createNamespaceMember(
    "member-preset-no-secret-create",
    namespace.id,
    memberWriteWithout(["create", "secret"]),
  );
  const preset = await createStandardPreset(fixture, namespace.id);
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    `/console/agents/new?namespace=${namespace.id}`,
    noSecretCreate.credentials,
  );
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  const denial = SECRET_CREATE_DENIED;
  await page.getByText(`Choose an existing Secret. ${denial}`, { exact: true }).waitFor();
  const source = page.getByLabel("Secret source for Model Secret", { exact: true });
  assert.equal(await source.inputValue(), "existing");
  const create = source.locator('option[value="new"]');
  assert.equal(await create.isDisabled(), true);
  assert.equal(await create.textContent(), `Create new Secret (${denial})`);
  const existing = page.getByLabel("Existing Secret for Model Secret", { exact: true });
  await waitForEnabled(existing);
  await existing.selectOption(secret.id);
  await page.getByLabel("Name", { exact: true }).fill("Preset choose-only Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page
    .getByText("Preset authentication: API key · Secret configured", { exact: true })
    .waitFor();
});

// A failed permission read leaves the Secret create answer unknown, not refused: the Preset keeps
// Create new Secret as its source, and the API decides when the Agent is created. Only a known
// denial, as above, limits the field to existing Secrets.
test("an unknown Secret create answer keeps a Preset's Create new Secret", async (t) => {
  const { fixture, namespace } = await setup(t);
  const preset = await createStandardPreset(fixture, namespace.id);
  const { page } = await newPage(t, fixture);
  // An administrator's form reads the Installation, so it goes on without the permission answer.
  const permissionsUrl = `${fixture.origin}/namespaces/${namespace.id}/permissions`;
  await page.route(permissionsUrl, unavailable);
  const answered = page.waitForResponse(permissionsUrl);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  assert.equal((await answered).status(), 503);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  const status = page.locator("#preset-variable-modelSecret-existing-secret-hint");
  await waitForCondition(
    async () => (await status.textContent()) !== "Loading existing Secrets…",
    "the Preset's Secret list loads",
    10_000,
  );
  assert.equal(
    await status.textContent(),
    "Existing Secrets in this Namespace are available. Secret values are never shown.",
  );
  const source = page.getByLabel("Secret source for Model Secret", { exact: true });
  assert.equal(await source.inputValue(), "new");
  const createNew = source.locator('option[value="new"]');
  assert.equal(await createNew.isDisabled(), false);
  assert.equal(await createNew.textContent(), "Create new Secret");
  // The typed key reaches the form's API key field.
  await page.getByLabel("Name", { exact: true }).fill("Unknown answer Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model Secret", { exact: true }).fill("sk-unknown-answer");
  await page.getByRole("button", { name: "Use Preset" }).click();
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "sk-unknown-answer");
});

// Agent create needs Secret operate on its Harness authentication Secret and on each Secret its
// Configuration binds. A member with operate on only some readable Secrets was offered the others
// in Create Agent and met a 403 after the click (finding 2469). Each Create Agent Secret field
// lists them disabled with the reason and never stages one. The people search field, which only
// a reader of the Installation sees, is covered in console-agent-plugin-approvers.
// A member with every Create Agent grant except Secret operate, which it has on the team key
// only.
async function operateTeamKeySetup(t: TestContext) {
  const { fixture, namespace, secret } = await setup(t);
  const member = await fixture.createNamespaceMember(
    "member-operate-some",
    namespace.id,
    memberWriteWithout(["operate", "secret"]),
  );
  const operate = grantSecretOperate(fixture, namespace.id, member.principal, [secret.id]);
  const answerPath = `/namespaces/${namespace.id}/permissions/secrets`;
  return { fixture, namespace, secret, member, operate, answerPath };
}

// That member, and a readable spare key it may not operate.
async function operateSomeSetup(t: TestContext) {
  const setupResult = await operateTeamKeySetup(t);
  const { fixture, namespace } = setupResult;
  const spare = await fixture.createSecret(namespace.id, "Spare key", "sk-member-spare");
  return { ...setupResult, spare };
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
  // Operate is per Secret, so a new Secret would get none: Create new Secret is listed disabled
  // with the reason the Preset's choice gives, before any Secret is created (finding 2500).
  const create = await deniedCreateSecretOption(page, "API key Secret", NEW_SECRET_OPERATE_DENIED);
  await create.click({ force: true });
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByLabel("API key Secret", { exact: true }).press("Escape");

  // The Slack token fields in the Channels drawer list both the same way, and its hint offers no
  // Secret create.
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Configure Slack" });
  for (const label of ["Slack app token", "Slack bot token"]) {
    const option = await operateDeniedSecretOption(dialog, label, spare);
    await option.click({ force: true });
    await deniedCreateSecretOption(dialog, label, NEW_SECRET_OPERATE_DENIED);
    await dialog.getByLabel(label, { exact: true }).press("Escape");
  }
  await dialog
    .getByText("Choose existing Slack token Secrets before creating the Agent.", { exact: true })
    .waitFor();
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
  const preset = await createStandardPreset(fixture, namespace.id);
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
  const { fixture, namespace, secret, member, operate, answerPath } = await operateSomeSetup(t);
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`, member.credentials);
  await fillDefaultPreset(page, secret, "Refused member Agent");
  // Configuration create and operate on the chosen key are revoked after it is staged.
  revokeMemberGrant(fixture, "member-operate-some", ["create", "configuration"]);
  operate.revoke(secret.id);
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

// Creating a Secret does not grant operate on it. The field read the operate answer when its list
// opened, before the new Secret existed, so it staged the Secret and Agent create answered 403
// (finding 2486). After an inline create the field reads the answer again and refuses the new
// Secret in place, keeping the key it had. Operate covers every readable Secret, so the answer is
// empty until the Secret exists and the create action stays enabled (finding 2499).
test("a Secret created inline that the member cannot operate is not staged", async (t) => {
  const { fixture, namespace, secret, member, answerPath } = await operateTeamKeySetup(t);
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`, member.credentials);
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Inline member Agent");
  await selectSecret(page, "API key Secret", secret);
  const staged = page.getByText("Secret selected. Create Agent binds it.");
  await staged.waitFor();
  const field = page.getByLabel("API key Secret", { exact: true });
  await field.fill("no matching Secret");
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create model credential Secret" });
  await dialog.getByLabel("Name", { exact: true }).fill("Inline member key");
  await dialog.getByLabel("Value", { exact: true }).fill("sk-inline-member");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page
    .getByText(`Inline member key cannot be chosen. ${SECRET_OPERATE_DENIED}`, { exact: true })
    .waitFor();
  assert.equal(await field.inputValue(), secret.name);
  // The answer was read when the list opened and again after the create.
  assert.deepEqual(
    answers.filter((answer) => answer.includes(answerPath)),
    [`GET ${answerPath} 200`, `GET ${answerPath} 200`],
  );
  // The new Secret is listed disabled with the reason.
  const list = await fixture.request("GET", `/namespaces/${namespace.id}/secrets`);
  const created = (list.data as SecretWire[]).find((item) => item.name === "Inline member key");
  assert.ok(created);
  await operateDeniedSecretOption(page, "API key Secret", created);
  await field.press("Escape");
  // The only write is the Secret create.
  assert.deepEqual(
    answers.filter((answer) => !answer.startsWith("GET ") && !answer.includes("/auth/")),
    [`POST /namespaces/${namespace.id}/secrets 201`],
  );
});

// The Preset's Create new Secret choice saves the typed key as a new Secret when Create Agent is
// pressed, and the next requests bind it. Creating a Secret grants no Secret operate on it, so
// this member met a 403 from Agent create after the Secret and Configuration were saved
// (finding 2492). Its operate is per Secret (one readable Secret is denied), so the choice is
// listed disabled with the reason, and a typed key is refused before any write.
test("a member whose Secret operate covers only some Secrets cannot save a typed model key", async (t) => {
  const { fixture, namespace, spare, member, answerPath } = await operateSomeSetup(t);
  const preset = await createStandardPreset(fixture, namespace.id);
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`, member.credentials);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Typed key Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  const source = page.getByLabel("Secret source for Model Secret", { exact: true });
  const status = page.locator("#preset-variable-modelSecret-existing-secret-hint");
  await waitForCondition(
    async () => (await status.textContent()) !== "Loading existing Secrets…",
    "the Preset's Secret list loads",
    10_000,
  );
  // Namespace Roles grant Secret operate per Secret, so the remedy names that grant, not one
  // across the Namespace (finding 2507).
  assert.equal(
    await status.textContent(),
    `Choose an existing Secret. ${NEW_SECRET_OPERATE_DENIED} ${NEW_SECRET_OPERATE_REMEDY}`,
  );
  const createNew = source.locator('option[value="new"]');
  assert.equal(await createNew.isDisabled(), true);
  assert.equal(await createNew.textContent(), `Create new Secret (${NEW_SECRET_OPERATE_DENIED})`);
  assert.equal(await source.inputValue(), "existing");
  // A choice the list cannot offer, as a scripted value, reaches the form's API key field; Create
  // Agent refuses the typed key before the preflight or any write.
  await source.evaluate((select: HTMLSelectElement) => {
    select.value = "new";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.getByLabel("Model Secret", { exact: true }).fill("sk-typed-key");
  await page.getByRole("button", { name: "Use Preset" }).click();
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "sk-typed-key");
  const submit = page.getByRole("button", { name: "Create Agent", exact: true });
  const refusal = page.getByText(
    `${NEW_SECRET_OPERATE_DENIED} Select Start over and use an existing Secret. ${NEW_SECRET_OPERATE_REMEDY}`,
    { exact: true },
  );
  await submit.click();
  await refusal.waitFor();
  const writes = () =>
    answers.filter((answer) => !answer.startsWith("GET ") && !answer.includes("/auth/"));
  assert.deepEqual(writes(), []);

  // A retry whose fresh read fails (an IAM outage answers 503) keeps the last answer and is
  // refused too. The failed read used to stand for an unknown answer for the whole page, so the
  // key was saved and Agent create answered 403, and every field forgot its marks (finding 2501).
  const answerUrl = `${fixture.origin}${answerPath}`;
  await page.route(answerUrl, unavailable);
  const failedRead = page.waitForResponse((response) => response.url() === answerUrl);
  await waitForEnabled(submit);
  await submit.click();
  assert.equal((await failedRead).status(), 503);
  await refusal.waitFor();
  assert.deepEqual(writes(), []);
  // While reads still fail, a Slack token field keeps the last answer's marks, and asks again
  // rather than reusing the failed read.
  const failedReads = () => answers.filter((answer) => answer === `GET ${answerPath} 503`).length;
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Configure Slack" });
  const botToken = dialog.getByLabel("Slack bot token", { exact: true });
  await operateDeniedSecretOption(dialog, "Slack bot token", spare);
  await deniedCreateSecretOption(dialog, "Slack bot token", NEW_SECRET_OPERATE_DENIED);
  await waitForCondition(async () => failedReads() >= 2, "the field reads the answer again");
  await botToken.press("Escape");

  // An administrator grants Secret operate across the Namespace, which covers a new Secret too.
  // The next answer read replaces the marks: the spare key is choosable again.
  await page.unroute(answerUrl, unavailable);
  grantMember(fixture, "member-operate-some", [["operate", "secret"]]);
  await botToken.fill(spare.name);
  const spareOption = dialog.getByRole("option", { name: spare.name, exact: true });
  await spareOption.waitFor();
  assert.equal(await spareOption.getAttribute("aria-disabled"), null);
  await botToken.press("Escape");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // The retry reads the answer again, saves the key as a Secret, and Agent create binds it.
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await waitForEnabled(submit);
  await submit.click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const { data: created }: AgentResponse = await response.json();
  const secrets = await fixture.request("GET", `/namespaces/${namespace.id}/secrets`);
  const saved = (secrets.data as SecretWire[]).find((item) => item.name === "Typed key Agent");
  assert.ok(saved);
  assert.deepEqual(created.harnessAuth, { method: "api_key", source: saved.ref });
});
