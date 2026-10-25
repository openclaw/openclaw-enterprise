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
  selectSecret,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";
import { waitForCreateFormReads } from "./console-agents-test-support.mjs";
import { GENERIC_DENIAL } from "../helpers/refusal-text.mjs";

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
