import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createConsoleAppFixture as createBaseConsoleAppFixture } from "../helpers/console-app.mjs";
import { login, newPage, selectSecret } from "./console-agents-browser-helpers.mjs";
import { waitForCreateFormReads } from "./console-agents-test-support.mjs";

// Create Agent for a Namespace member (UX plan A2, spec 3.11; findings 1901, 493). The real
// Native IAM Driver answers every read and write: the member's GET /installation is refused, and
// the Namespace's permission answer says whether it may create Agents.

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);
const createConsoleAppFixture = (t) =>
  createBaseConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });

// What a member who writes Agents holds in one Namespace (the ux-audit-1018 member-write persona).
const MEMBER_WRITE = [
  ["read", "namespace"],
  ["read", "agent"],
  ["update", "agent"],
  ["deploy", "agent"],
  ["operate", "agent"],
  ["read", "agent_revision"],
  ["read", "configuration"],
  ["update", "configuration"],
  ["read", "secret"],
  ["operate", "secret"],
  ["create", "agent"],
  ["create", "configuration"],
  ["create", "secret"],
  ["read", "preset"],
];

function member(fixture, namespaceId, label, actions) {
  return fixture.createAccountWithPolicy(label, (principal) => {
    fixture.policy.roles.push({
      id: `role-${label}`,
      namespaceId,
      permissions: actions.map(([action, resourceKind]) => ({ action, resourceKind })),
    });
    fixture.policy.bindings.push({
      id: `binding-${label}`,
      namespaceId,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: `role-${label}`,
    });
  });
}

const ACCESS_FROM_PRESET =
  "You can create Agents in Member team. Installation-wide capabilities are not readable with your access, so the options below come from this Namespace's Presets.";
const MEMBER_CREDENTIAL_ACCESS =
  "Giving a new Agent access to its Secrets needs an Installation administrator.";
const INSTALLATION_REFUSAL =
  "Creating an Agent needs Installation access that your account does not have. Ask an Installation administrator to create this Agent.";

// Every console API answer, as "METHOD path status".
function apiResponses(page, origin) {
  const answers = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && !url.pathname.startsWith("/console")) {
      answers.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
    }
  });
  return answers;
}

async function setup(t) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Member team", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Team OpenAI key", "sk-member-team");
  return { fixture, namespace, secret };
}

// Start from the default Preset with the Namespace's model Secret and a manual model ID.
async function fillDefaultPreset(page, secret, name) {
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
  const writer = await member(fixture, namespace.id, "member-write", MEMBER_WRITE);
  const { page } = await newPage(t, fixture);
  const answers = apiResponses(page, fixture.origin);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`, writer.credentials);
  const open = page.getByRole("button", { name: "Create Agent", exact: true });
  assert.equal(await open.isEnabled(), true);
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
    ACCESS_FROM_PRESET,
    MEMBER_CREDENTIAL_ACCESS,
  ]);
  assert.equal(await access.isVisible(), true);
  // Above the form, not mid-form.
  assert.equal(await access.evaluate((node) => node.nextElementSibling?.id), "create-agent-form");
  assert.equal(await page.getByText(INSTALLATION_REFUSAL).count(), 0);
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
  const created = (await response.json()).data;
  assert.equal(created.name, "Member Agent");
  assert.deepEqual(created.harnessAuth, { method: "api_key", source: secret.ref });
  // Granting the Agent's credential access is Installation administration, which the API refuses
  // the member: the form names who finishes it instead of a generic denial.
  await page
    .getByRole("alert")
    .filter({
      hasText: `The Agent was created as a draft. ${MEMBER_CREDENTIAL_ACCESS} Open the saved Agent and ask one to grant it access to its saved model and channel Secrets.`,
    })
    .waitFor();
  assert.match(
    await page.getByRole("link", { name: "Open saved Agent" }).getAttribute("href"),
    new RegExp(created.id),
  );
  // Every write the console tried was the member's own Namespace work, then the IAM read the
  // API refuses; nothing touched the Installation.
  assert.deepEqual(
    answers.filter((answer) => !answer.startsWith("GET ") && !answer.includes("/auth/")),
    [
      `POST /namespaces/${namespace.id}/agents/validate 204`,
      `POST /namespaces/${namespace.id}/configurations 201`,
      `POST /namespaces/${namespace.id}/agents 201`,
    ],
  );
  assert.ok(answers.includes(`GET /namespaces/${namespace.id}/iam/roles 403`), answers.join("\n"));
});

test("a member without Agent create never sees the form, and Create Agent names why", async (t) => {
  const { fixture, namespace } = await setup(t);
  const actions = MEMBER_WRITE.filter(
    ([action, kind]) => !(action === "create" && kind === "agent"),
  );
  const limited = await member(fixture, namespace.id, "member-no-create", actions);
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
