import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import type {
  CreateIAMAccessBindingBody,
  CreateIAMRoleBody,
  ErrorResponse,
  UpdateAgentBody,
} from "../../packages/contracts/src/api/common.ts";
import type {
  IAMAccessBindingResponse,
  IAMRoleResponse,
  NamespaceListResponse,
  NamespaceWire,
  SecretDetailResponse,
  SecretListResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { consoleStorage } from "../helpers/console-storage.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  apiRequests,
  expectWriteAsksBeforeUnload,
  fileBrowser,
  hasFocus,
  holdRequests,
  login,
  newPage,
  pathRequests,
  settledView,
} from "./console-agents-browser-helpers.mjs";

const browser = fileBrowser();
type Namespace = Pick<NamespaceWire, "id">;
type SecretWriteMethod = "POST" | "PATCH" | "DELETE";

const secretsUrl = (namespace: Namespace) => `/console/secrets?namespace=${namespace.id}`;
const secretPath = (namespace: Namespace) => `/namespaces/${namespace.id}/secrets`;
const dialog = (page: Page, name: string) => page.getByRole("dialog", { name, exact: true });

async function createFromConsole(page: Page, name: string, value: string) {
  await page.getByRole("button", { name: "Create Secret", exact: true }).click();
  const form = dialog(page, "Create Secret");
  await form.getByLabel("Secret name", { exact: true }).fill(name);
  await form.getByLabel("Value", { exact: true }).fill(value);
  await form.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog(page, "Secret created").getByRole("button", { name: "Close" }).click();
}

test("console Secret creation, replacement, Agent consumers and cleanup use real API and IAM", async (t) => {
  const audit = new InMemoryAuditSink();
  const storage = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, { auditSink: audit, secretDriver: storage });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Secret editors", { ready: true });
  const other = await fixture.createNamespace("Other tenant", { ready: true });
  await fixture.createSecret(other.id, "Other tenant credential", "synthetic-other-value");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, secretsUrl(namespace));
  await page.locator(settledView).getByRole("heading", { name: "No Secrets yet" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Other tenant credential" }).count(), 0);

  // New material is opaque: spaces, Unicode and newlines must reach storage unchanged.
  const original = "  synthetic-console-credential\nsecond line π  ";
  await createFromConsole(page, "Shared model", original);
  const listed = await fixture.request("GET", secretPath(namespace));
  assert.equal(listed.status, 200);
  const { data: secrets }: SecretListResponse = listed.body;
  const secret = secrets.find((item) => item.name === "Shared model");
  assert.ok(secret, "the created Secret must be in the Namespace list");
  assert.equal(storage.valueFor(secret), original);
  assert.doesNotMatch(
    JSON.stringify(await fixture.request("GET", `${secretPath(namespace)}/${secret.id}`)),
    /synthetic-console-credential/,
  );
  assert.deepEqual(await consoleStorage(page), { local: {}, session: {} });

  await page.getByRole("button", { name: "Shared model", exact: true }).click();
  await dialog(page, "Shared model")
    .getByRole("button", { name: "Replace value", exact: true })
    .click();
  const replacement = dialog(page, "Replace Secret value");
  assert.equal(await replacement.getByLabel("Value", { exact: true }).inputValue(), "");
  await replacement.getByLabel("Value", { exact: true }).fill("synthetic-console-replacement");
  await replacement.getByRole("button", { name: "Replace value", exact: true }).click();
  await dialog(page, "Secret value replaced").getByRole("button", { name: "Close" }).click();
  assert.equal(storage.valueFor(secret), "synthetic-console-replacement");

  // Bind the UI-created Secret through ordinary Agent admission. Its real reference blocks
  // deletion; this is not a fixture-invented consumer or deletion response.
  const agent = await fixture.createAgent(
    namespace.id,
    "Shared model consumer",
    {},
    { harnessAuth: { method: "api_key", source: secret.ref } },
  );
  await page.getByRole("button", { name: "Shared model", exact: true }).click();
  const detail = dialog(page, "Shared model");
  await detail.getByRole("link", { name: agent.id, exact: true }).waitFor();
  assert.equal(
    await detail.getByRole("button", { name: "Delete Secret", exact: true }).isDisabled(),
    true,
  );
  await detail.getByRole("link", { name: agent.id, exact: true }).click();
  await page.waitForURL(new RegExp(`/console/agents/${agent.id}`));
  await page.getByRole("heading", { name: "Shared model consumer", exact: true }).waitFor();

  // Clear the Agent draft reference through its supported API before deleting the Secret.
  const unbound = await fixture.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
    body: { configurationId: agent.configurationId, harnessAuth: null } satisfies UpdateAgentBody,
  });
  assert.equal(unbound.status, 200);
  await page.getByRole("link", { name: "Secrets", exact: true }).click();
  await page.getByRole("button", { name: "Shared model", exact: true }).click();
  await dialog(page, "Shared model")
    .getByRole("button", { name: "Delete Secret", exact: true })
    .click();
  await dialog(page, "Delete Secret")
    .getByRole("button", { name: "Permanently delete Secret", exact: true })
    .click();
  await dialog(page, "Secret deleted").getByRole("button", { name: "Close" }).click();
  assert.equal((await fixture.request("GET", `${secretPath(namespace)}/${secret.id}`)).status, 404);
  assert.equal(storage.has(secret), false);
  for (const action of ["create", "update", "delete"]) {
    assert.ok(
      audit
        .list()
        .some(
          (event) =>
            event.action === `openclaw.secrets.${action}` &&
            event.resource.id === secret.id &&
            event.actorId,
        ),
    );
  }
  assert.doesNotMatch(JSON.stringify(audit.list()), /synthetic-console-(credential|replacement)/);
});

test("unknown console Secret writes erase entered material and never replay mutations", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Interrupted writes", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, secretsUrl(namespace));
  let interrupt: SecretWriteMethod | null = "POST";
  await page.route(`${fixture.origin}${secretPath(namespace)}**`, async (route) => {
    if (route.request().method() !== interrupt) {
      return route.continue();
    }
    interrupt = null;
    // The real server commits before its reply is lost. Retrying would create a second write.
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Create Secret", exact: true }).click();
  const create = dialog(page, "Create Secret");
  await create.getByLabel("Secret name").fill("Uncertain Secret");
  await create.getByLabel("Value", { exact: true }).fill("synthetic-interrupted-value");
  await create.getByRole("button", { name: "Create Secret", exact: true }).click();
  await create.getByText(/Outcome unknown/).waitFor();
  assert.equal(await create.getByLabel("Value", { exact: true }).inputValue(), "");
  assert.equal(
    await create.getByRole("button", { name: "Create Secret", exact: true }).isDisabled(),
    true,
  );
  await create.locator("form").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
  });
  assert.equal(pathRequests(requests, "POST", secretPath(namespace)).length, 1);
  await create.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Uncertain Secret", exact: true }).click();
  await dialog(page, "Uncertain Secret")
    .getByRole("button", { name: "Replace value", exact: true })
    .click();
  interrupt = "PATCH";
  const replace = dialog(page, "Replace Secret value");
  await replace.getByLabel("Value", { exact: true }).fill("synthetic-interrupted-replacement");
  await replace.getByRole("button", { name: "Replace value", exact: true }).click();
  await replace.getByText(/Outcome unknown/).waitFor();
  assert.equal(await replace.getByLabel("Value", { exact: true }).inputValue(), "");
  assert.equal(
    await replace.getByRole("button", { name: "Replace value", exact: true }).isDisabled(),
    true,
  );
  await replace.locator("form").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
  });
  assert.equal(
    requests.filter(
      (item) => item.method === "PATCH" && item.path.startsWith(secretPath(namespace)),
    ).length,
    1,
  );
  await replace.getByRole("button", { name: "Close" }).click();
  const uncertainRow = page.locator(".secret-row").filter({ hasText: "Uncertain Secret" });
  assert.equal(await uncertainRow.count(), 1);
  await page.getByRole("button", { name: "Uncertain Secret", exact: true }).click();
  await dialog(page, "Uncertain Secret")
    .getByRole("button", { name: "Delete Secret", exact: true })
    .click();
  interrupt = "DELETE";
  const remove = dialog(page, "Delete Secret");
  await remove.getByRole("button", { name: "Permanently delete Secret", exact: true }).click();
  await remove.getByText(/Outcome unknown/).waitFor();
  await remove.getByRole("button", { name: "Check deletion status" }).click();
  await remove.getByText(/Secret is no longer available/).waitFor();
  assert.equal(
    requests.filter(
      (item) => item.method === "DELETE" && item.path.startsWith(secretPath(namespace)),
    ).length,
    1,
  );
  // The check found it deleted, so the list behind the dialog drops it without a Refresh.
  assert.equal(await uncertainRow.count(), 0);
});

test("checking an uncertain deletion cannot mistake another Secret for the deleted one", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Deletion status", { ready: true });
  const selected = await fixture.createSecret(
    namespace.id,
    "Selected Secret",
    "synthetic-selected",
  );
  const other = await fixture.createSecret(namespace.id, "Different Secret", "synthetic-different");
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, secretsUrl(namespace));
  await page.getByRole("button", { name: selected.name, exact: true }).click();
  await dialog(page, selected.name)
    .getByRole("button", { name: "Delete Secret", exact: true })
    .click();

  const path = `${secretPath(namespace)}/${selected.id}`;
  await page.route(`${fixture.origin}${path}`, async (route) => {
    const response = await route.fetch();
    if (route.request().method() === "DELETE") {
      assert.equal(response.status(), 204);
      return route.abort("failed");
    }
    // The delete committed. Answer its status check with a real, well-formed read of another Secret.
    assert.equal(response.status(), 404);
    const url = `${fixture.origin}${secretPath(namespace)}/${other.id}`;
    const different = await route.fetch({ url });
    assert.equal(different.status(), 200);
    const { data }: SecretDetailResponse = await different.json();
    assert.equal(data.id, other.id);
    return route.fulfill({ response: different });
  });
  const remove = dialog(page, "Delete Secret");
  const confirm = remove.getByRole("button", { name: "Permanently delete Secret", exact: true });
  await confirm.click();
  await remove.getByText(/Outcome unknown/).waitFor();
  await remove.getByRole("button", { name: "Check deletion status" }).click();
  const outcome = remove.getByText(/Could not confirm deletion|The Secret still exists/);
  assert.match(await outcome.innerText(), /Could not confirm deletion/);
  assert.equal(await remove.getByText(other.id, { exact: false }).count(), 0);
  assert.equal(await confirm.count(), 0);
  assert.equal(pathRequests(requests, "DELETE", path).length, 1);
});

test("console Secret writes honor read-only access, revocation and a new Agent reference", async (t) => {
  const audit = new InMemoryAuditSink();
  const storage = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, {
    auditSink: audit,
    secretDriver: storage,
    provisionedPeople: ["secret-reader"],
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Restricted operations", { ready: true });
  const original = "synthetic-restricted-value";
  const secret = await fixture.createSecret(namespace.id, "Shared credential", original);
  const privateSecret = await fixture.createSecret(
    namespace.id,
    "Private consumers",
    "synthetic-private-value",
  );
  const privateAgent = await fixture.createAgent(
    namespace.id,
    "Private Agent",
    {},
    { harnessAuth: { method: "api_key", source: privateSecret.ref } },
  );
  const [member] = fixture.provisionedAccounts;
  assert.ok(member, "the fixture must provision the Secret reader");
  const memberId = member.principal.id;
  const iam = `/namespaces/${namespace.id}/iam`;
  async function grant(
    action: CreateIAMRoleBody["permissions"][number]["action"],
    resourceKind: CreateIAMAccessBindingBody["resourceKind"],
    resourceId: string,
  ) {
    const createdRole = await fixture.request("POST", `${iam}/roles`, {
      body: { permissions: [{ action, resourceKind }] } satisfies CreateIAMRoleBody,
    });
    assert.equal(createdRole.status, 201, JSON.stringify(createdRole.body));
    const { data: role }: IAMRoleResponse = createdRole.body;
    const bindings = `${iam}/access-bindings`;
    const createdBinding = await fixture.request("POST", bindings, {
      body: {
        subjectKind: "identity",
        subjectId: memberId,
        roleId: role.id,
        resourceKind,
        resourceId,
      } satisfies CreateIAMAccessBindingBody,
    });
    assert.equal(createdBinding.status, 201, JSON.stringify(createdBinding.body));
    const { data: binding }: IAMAccessBindingResponse = createdBinding.body;
    return `${bindings}/${binding.id}`;
  }
  await grant("read", "namespace", namespace.id);
  await grant("read", "secret", privateSecret.id);
  await grant("read", "secret", secret.id);
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, secretsUrl(namespace), member.credentials);
  await page.getByRole("button", { name: privateSecret.name, exact: true }).click();
  const privateDetail = dialog(page, privateSecret.name);
  await privateDetail.getByText(/1 additional consumer/).waitFor();
  assert.equal(await privateDetail.getByText(privateAgent.id, { exact: true }).count(), 0);
  assert.equal(
    await privateDetail.getByRole("button", { name: "Delete Secret", exact: true }).isDisabled(),
    true,
  );
  await privateDetail.getByRole("button", { name: "Close" }).click();

  // Match the browser's 403 to the exact IAM denial. A denial returned after a storage
  // side effect would still look correct in the dialog, even if the write were then undone.
  const form = page.getByRole("dialog");
  const value = form.getByLabel("Value", { exact: true });
  const collection = fixture.origin + secretPath(namespace);
  async function expectDenied(
    name: string,
    method: SecretWriteMethod,
    action: "create" | "update" | "delete",
    storedValue = original,
  ) {
    const creating = action === "create";
    const url = creating ? collection : `${collection}/${secret.id}`;
    const callCount = storage.calls.length;
    const response = page.waitForResponse(
      (result) => result.url() === url && result.request().method() === method,
    );
    const submit = form.getByRole("button", { name, exact: true });
    await submit.click();
    const refused = await response;
    assert.equal(refused.status(), 403);
    const { error, meta }: ErrorResponse = await refused.json();
    assert.equal(error.code, "FORBIDDEN");
    const denial = audit
      .list()
      .find((event) => event.requestId === meta.requestId && event.outcome === "denied");
    assert.deepEqual(denial?.authorization, {
      principalId: memberId,
      action,
      resource: {
        kind: "secret",
        id: creating ? namespace.id : secret.id,
        namespaceId: namespace.id,
      },
    });
    assert.equal(
      storage.calls.length,
      callCount,
      "a denied write must not reach the Secret Driver",
    );
    assert.equal(storage.valueFor(secret), storedValue);
    await form
      .getByRole("alert")
      .filter({ hasText: /Your access does not include/ })
      .waitFor();
    assert.equal(await submit.isDisabled(), true);
    const close = form.getByRole("button", { name: "Close" });
    if (method !== "DELETE") {
      assert.equal(await value.inputValue(), "");
      assert.equal(await value.isDisabled(), true, "do not invite another value after a refusal");
      assert.equal(await form.getByRole("button", { name: "Show value" }).isDisabled(), true);
      if (creating) {
        assert.equal(await form.getByLabel("Secret name").isDisabled(), true);
      }
      assert.equal(await hasFocus(close), true, "Close is the next available action");
    }
    await close.click();
  }
  await page.getByRole("button", { name: "Create Secret", exact: true }).click();
  await form.getByLabel("Secret name").fill("Reader cannot create this");
  await value.fill("synthetic-denied-create");
  await expectDenied("Create Secret", "POST", "create");

  async function openAction(name: string) {
    await page.getByRole("button", { name: secret.name, exact: true }).click();
    await dialog(page, secret.name).getByRole("button", { name, exact: true }).click();
  }
  await openAction("Replace value");
  await value.fill("synthetic-denied-replacement");
  await expectDenied("Replace value", "PATCH", "update");
  await openAction("Delete Secret");
  await expectDenied("Permanently delete Secret", "DELETE", "delete");

  // This member can now replace this Secret. Remove just that grant while the next edit is
  // open: the same session and Secret must use the permission in effect when Save is pressed.
  const updateGrant = await grant("update", "secret", secret.id);
  const allowed = "synthetic-authorized-replacement";
  await openAction("Replace value");
  await value.fill(allowed);
  await form.getByRole("button", { name: "Replace value", exact: true }).click();
  await dialog(page, "Secret value replaced").getByRole("button", { name: "Close" }).click();
  assert.equal(storage.valueFor(secret), allowed);

  await openAction("Replace value");
  await value.fill("synthetic-revoked-replacement");
  assert.equal((await fixture.request("DELETE", updateGrant)).status, 204);
  await expectDenied("Replace value", "PATCH", "update", allowed);

  // Return to an administrator and read an unreferenced Secret, then race a valid Agent
  // binding against its confirmation. The DELETE route must recheck dependencies.
  await page.context().clearCookies();
  await page.goto(fixture.origin + "/console/login");
  await login(page, fixture, secretsUrl(namespace));
  await page.getByRole("button", { name: secret.name, exact: true }).click();
  await dialog(page, secret.name)
    .getByRole("button", { name: "Delete Secret", exact: true })
    .click();
  await fixture.createAgent(
    namespace.id,
    "Concurrent consumer",
    {},
    { harnessAuth: { method: "api_key", source: secret.ref } },
  );
  await dialog(page, "Delete Secret")
    .getByRole("button", { name: "Permanently delete Secret", exact: true })
    .click();
  await dialog(page, "Delete Secret")
    .getByText(/Deletion is blocked/)
    .waitFor();
  assert.equal((await fixture.request("GET", `${secretPath(namespace)}/${secret.id}`)).status, 200);
});

test("a Secret name conflict allows correction, but a Namespace that stops being ready ends create and replacement", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Changing Secret availability", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Existing Secret", "synthetic-original");
  const path = secretPath(namespace);
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, secretsUrl(namespace));

  await page.getByRole("button", { name: "Create Secret", exact: true }).click();
  const create = dialog(page, "Create Secret");
  const createValue = create.getByLabel("Value", { exact: true });
  const createName = create.getByLabel("Secret name");
  await createName.fill(secret.name);
  await createValue.fill("synthetic-conflicting");
  const duplicate = page.waitForResponse(
    (r) => r.url() === fixture.origin + path && r.request().method() === "POST",
  );
  await create.getByRole("button", { name: "Create Secret", exact: true }).click();
  const conflict = await duplicate;
  assert.equal(conflict.status(), 409);
  const { error }: ErrorResponse = await conflict.json();
  assert.equal(error.code, "RESOURCE_CONFLICT");
  await create
    .getByRole("alert")
    .filter({ hasText: /name may already be in use/ })
    .waitFor();
  assert.equal(await createValue.inputValue(), "");
  assert.equal(await hasFocus(createName), true, "the duplicate name can be corrected here");
  await createName.fill("Another Secret");
  await createValue.fill("synthetic-correction");

  // Another operator removes the last Secret and starts Namespace deletion while both forms are open.
  const other = await page.context().newPage();
  await other.goto(fixture.origin + secretsUrl(namespace));
  await other.getByRole("button", { name: secret.name, exact: true }).click();
  await dialog(other, secret.name)
    .getByRole("button", { name: "Replace value", exact: true })
    .click();
  const replace = dialog(other, "Replace Secret value");
  await replace.getByLabel("Value", { exact: true }).fill("synthetic-replacement");
  assert.equal((await fixture.request("DELETE", path + "/" + secret.id)).status, 204);
  assert.equal((await fixture.request("DELETE", "/namespaces/" + namespace.id)).status, 202);

  for (const [form, action, url, method] of [
    [create, "Create Secret", path, "POST"],
    [replace, "Replace value", path + "/" + secret.id, "PATCH"],
  ] as const) {
    const submit = form.getByRole("button", { name: action, exact: true });
    const refused = form
      .page()
      .waitForResponse((r) => r.url() === fixture.origin + url && r.request().method() === method);
    await submit.click();
    const response = await refused;
    assert.equal(response.status(), 409);
    const { error }: ErrorResponse = await response.json();
    assert.equal(error.code, "NAMESPACE_NOT_READY");
    // Both writes were refused because the Namespace changed, not because the name is taken.
    await form
      .getByRole("alert")
      .filter({ hasText: /Namespace.*not ready.*Close and Refresh/ })
      .waitFor();
    const value = form.getByLabel("Value", { exact: true });
    assert.equal(await value.inputValue(), "");
    assert.equal(await value.isDisabled(), true, "a Namespace conflict needs a fresh read");
    assert.equal(await submit.isDisabled(), true);
    assert.equal(await hasFocus(form.getByRole("button", { name: "Close" })), true);
  }
});

// Each refusal keeps its own meaning: a 429 leaves the form for another try, a 404 is a known
// refusal rather than an unknown outcome, an incomplete consumer list cannot show deletion as
// safe, and a Namespace that is not ready offers no replacement.
test("Secret refusals keep their meaning, and incomplete consumers or a not-ready Namespace block changes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Secret refusal meanings", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Listed Secret", "synthetic-listed");
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  const refusals: { status: number; code: string }[] = [
    { status: 429, code: "RATE_LIMITED" },
    { status: 404, code: "NOT_FOUND" },
  ];
  await page.route(`${fixture.origin}${secretPath(namespace)}`, (route) => {
    const refusal = route.request().method() === "POST" ? refusals.shift() : undefined;
    return refusal
      ? route.fulfill({
          status: refusal.status,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: refusal.code, message: "refused" } }),
        })
      : route.fallback();
  });
  await login(page, fixture, secretsUrl(namespace));
  await page.getByRole("button", { name: "Create Secret", exact: true }).click();
  const create = dialog(page, "Create Secret");
  const value = create.getByLabel("Value", { exact: true });
  const submit = create.getByRole("button", { name: "Create Secret", exact: true });
  await create.getByLabel("Secret name").fill("Refused Secret");
  await value.fill("synthetic-rate-limited");
  await submit.click();
  await create
    .getByRole("alert")
    .filter({ hasText: "The value was not saved. Check the input and enter it again." })
    .waitFor();
  assert.equal(await value.inputValue(), "");
  assert.equal(await value.isDisabled(), false, "a 429 allows another try");
  assert.equal(await submit.isDisabled(), false);
  await value.fill("synthetic-not-found");
  await submit.click();
  await create
    .getByRole("alert")
    .filter({
      hasText: "This Secret or Namespace is no longer available. Close and Refresh the list.",
    })
    .waitFor();
  assert.equal(await create.getByText(/Outcome unknown/).count(), 0);
  assert.equal(await submit.isDisabled(), true, "a 404 needs a fresh read");
  assert.equal(pathRequests(requests, "POST", secretPath(namespace)).length, 2);
  await create.getByRole("button", { name: "Close" }).click();

  // A truncated consumer list names no consumer, yet more references exist than it shows.
  await page.route(
    `${fixture.origin}${secretPath(namespace)}/${secret.id}`,
    async (route) => {
      const response = await route.fetch();
      const body: SecretDetailResponse = await response.json();
      body.data.consumers = { ...body.data.consumers, truncated: true };
      await route.fulfill({ response, json: body });
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: secret.name, exact: true }).click();
  const detail = dialog(page, secret.name);
  await detail.getByText(/This consumer list is incomplete/).waitFor();
  await detail.getByText(/Deletion is blocked while references remain/).waitFor();
  assert.equal(
    await detail.getByRole("button", { name: "Delete Secret", exact: true }).isDisabled(),
    true,
  );
  await detail.getByRole("button", { name: "Close" }).click();

  // The same Secret in a Namespace that is no longer ready: its value cannot be replaced.
  await page.route(`${fixture.origin}/namespaces`, async (route) => {
    const response = await route.fetch();
    const body: NamespaceListResponse = await response.json();
    body.data = body.data.map((item) =>
      item.id === namespace.id ? { ...item, status: "provisioning" } : item,
    );
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await page
    .getByText("Secrets can be created or replaced after this Namespace is ready.")
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Create Secret", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: secret.name, exact: true }).click();
  const unready = dialog(page, secret.name);
  await unready.getByText(/No current consumers were found/).waitFor();
  assert.equal(
    await unready.getByRole("button", { name: "Replace value", exact: true }).isDisabled(),
    true,
  );
});

test("pending Secret creation blocks navigation and replay, then session loss clears material", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Pending writes", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByRole("link", { name: "Secrets", exact: true }).click();
  const held = await holdRequests(t, page, `${fixture.origin}${secretPath(namespace)}`, {
    method: "POST",
    afterServer: true,
    once: true,
  });
  await page.getByRole("button", { name: "Create Secret", exact: true }).click();
  const create = dialog(page, "Create Secret");
  await create.getByLabel("Secret name").fill("Pending credential");
  await create.getByLabel("Value", { exact: true }).fill("synthetic-pending-value");
  await create.getByRole("button", { name: "Create Secret", exact: true }).click();
  await held.requested;
  await page.keyboard.press("Escape");
  assert.equal(await create.isVisible(), true);
  assert.equal(await create.getByRole("button", { name: "Close" }).isDisabled(), true);
  await create.locator("form").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
  });
  await page.goBack();
  await page.waitForURL(new RegExp(`/console/secrets\\?namespace=${namespace.id}`));
  await create.getByText(/Wait for the current request/).waitFor();
  assert.equal(pathRequests(requests, "POST", secretPath(namespace)).length, 1);
  held.release();
  await dialog(page, "Secret created").getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Create Secret", exact: true }).click();
  const value = dialog(page, "Create Secret").getByLabel("Value", { exact: true });
  await value.fill("synthetic-unsaved-material");
  // Revoke the actual browser session, then recheck. Neither a retained view nor storage
  // may keep the new material after authentication ends.
  await page.evaluate(async () => {
    await fetch("/api/auth/sign-out", { method: "POST" });
  });
  await page.keyboard.press("Escape");
  assert.equal(await value.count(), 0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await page.locator("[data-secret-value]").count(), 0);
  assert.deepEqual(await consoleStorage(page), { local: {}, session: {} });
});

// The dialog holds in-app navigation while its write is in flight; a reload or tab close asks
// first too, and stops asking once the answer comes, refused or saved (finding 2181).
test("a reload asks first only while a Secret write is in flight", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Reload writes", { ready: true });
  await fixture.createSecret(namespace.id, "Taken name", "synthetic-taken-value");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, secretsUrl(namespace));
  await page.getByRole("button", { name: "Create Secret", exact: true }).click();
  const create = dialog(page, "Create Secret");
  const submit = () => create.getByRole("button", { name: "Create Secret", exact: true }).click();
  const url = `${fixture.origin}${secretPath(namespace)}`;
  await create.getByLabel("Secret name").fill("Taken name");
  await create.getByLabel("Value", { exact: true }).fill("synthetic-refused-value");
  await expectWriteAsksBeforeUnload(t, page, url, {
    method: "POST",
    start: submit,
    settled: () => create.getByText(/choose a unique name/).waitFor(),
  });
  await create.getByLabel("Secret name").fill("Reload credential");
  await create.getByLabel("Value", { exact: true }).fill("synthetic-saved-value");
  await expectWriteAsksBeforeUnload(t, page, url, {
    method: "POST",
    start: submit,
    // The heading changes before the list is read again; Close is enabled once the write ends.
    settled: () =>
      dialog(page, "Secret created")
        .getByRole("button", { name: "Close", disabled: false })
        .waitFor(),
  });
});
