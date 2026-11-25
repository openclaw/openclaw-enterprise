import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import test, { type TestContext } from "node:test";
import type { Locator, Page, Route } from "playwright";

import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import type { GitHubAppIssuerOptions } from "../../apps/controller/src/drivers/token-service/github-app-issuer.ts";
import { OpenClawController, type PlatformStateStore } from "../../packages/occ/src/index.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.ts";
import {
  createGitHubProtocol,
  fixtureAppId,
} from "../fixtures/repository-credentials/github/protocol.ts";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.ts";
import { sharedRsaKeyPair } from "../fixtures/repository-credentials/shared-keys.ts";

import {
  NamespaceCallerPermissionsResponse,
  SecretDetailResponse,
} from "../../packages/contracts/src/api/resources.ts";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import type {
  CreateIAMAccessBindingBody,
  CreateIAMRoleBody,
  ErrorResponse,
  UpdateAgentBody,
} from "../../packages/contracts/src/api/common.ts";
import type {
  AgentListResponse,
  IAMAccessBindingResponse,
  IAMRoleResponse,
  NamespaceListResponse,
  NamespaceWire,
  SecretListResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { apiErrorResponse, proxyErrorResponse } from "../helpers/api-error-response.ts";
import {
  CONSOLE_NAMESPACE_NOT_READY,
  RESOURCE_NOT_FOUND,
  SECRET_CREATE_MEMBER_DENIED,
  SECRET_NAME_CONFLICT,
  tooManyRequestsIn,
} from "../helpers/refusal-text.mjs";
import {
  SECRET_DELETE_DENIED,
  SECRET_LINK_UNLISTED,
  secretLinkUnlistedAdministrator,
  SECRET_UPDATE_DENIED,
} from "../helpers/refusal-access.ts";
import { liftRestriction, restrict } from "../helpers/iam-grants.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.ts";
import { consoleStorage } from "../helpers/console-storage.ts";
import { fixtureOAuthIssuer } from "../helpers/oauth-issuer.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  accessibleDescription,
  apiRequests,
  expectReachableReason,
  expectWriteAsksBeforeUnload,
  fileBrowser,
  hasFocus,
  holdRequests,
  login,
  newPage,
  pathRequests,
  settledView,
} from "./console-agents-browser-helpers.ts";
import { fulfillPatchedJson } from "./console-patched-response.ts";
import { responseTo } from "./console-action-helpers.ts";
import { refocusHeld } from "./console-refocus-helpers.ts";

const browser = fileBrowser();
type Namespace = Pick<NamespaceWire, "id">;
type SecretWriteMethod = "POST" | "PATCH" | "DELETE";

const secretsUrl = (namespace: Namespace) => `/console/secrets?namespace=${namespace.id}`;
const secretPath = (namespace: Namespace) => `/namespaces/${namespace.id}/secrets`;
const dialog = (page: Page, name: string) => page.getByRole("dialog", { name, exact: true });
const SECRET_REFERENCED = "This Secret is referenced.";
const directoryIssuer = {
  issuer: "https://identity.example.test",
  authorizationUrl: "https://identity.example.test/authorize",
  tokenUrl: "https://identity.example.test/token",
};
const googleIssuer = {
  issuer: "https://accounts.google.com",
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revocationUrl: "https://oauth2.googleapis.com/revoke",
};

async function expectSecretFocusInView(control: Locator, stop: string) {
  const { focused, outlined, clearance } = await control.evaluate((node) => {
    const dialog = node.closest("dialog");
    if (!dialog) {
      throw new Error("The Secret control is outside its dialog");
    }
    const box = node.getBoundingClientRect();
    const bounds = dialog.getBoundingClientRect();
    const left = bounds.left + dialog.clientLeft;
    const top = bounds.top + dialog.clientTop;
    const style = globalThis.getComputedStyle(node);
    const outlineWidth = Number.parseFloat(style.outlineWidth);
    const outlineReach = Math.max(0, outlineWidth + Number.parseFloat(style.outlineOffset));
    // The outline must fit inside both the dialog's scrollport and the viewport.
    const clearance =
      Math.min(
        box.left - Math.max(left, 0),
        box.top - Math.max(top, 0),
        Math.min(left + dialog.clientWidth, globalThis.innerWidth) - box.right,
        Math.min(top + dialog.clientHeight, globalThis.innerHeight) - box.bottom,
      ) - outlineReach;
    return {
      focused: node === globalThis.document.activeElement && node.matches(":focus-visible"),
      outlined: style.outlineStyle !== "none" && outlineWidth > 0,
      clearance,
    };
  });
  assert.equal(focused, true, `${stop} has visible keyboard focus`);
  assert.equal(outlined, true, `${stop} draws a focus outline`);
  assert.ok(
    clearance >= -0.5,
    `${stop} must fit with its focus outline (${clearance}px clearance)`,
  );
}

async function fillDirectoryTemplate(editor: Locator) {
  await editor.getByLabel("Template name").fill("Directory OAuth");
  await editor.getByLabel("Issuer URL", { exact: true }).fill("https://identity.example.test");
  await editor.getByLabel("Authorization URL").fill("https://identity.example.test/authorize");
  await editor.getByLabel("Token URL").fill("https://identity.example.test/token");
  await editor.getByRole("textbox", { name: "Host", exact: true }).fill("directory.example.test");
}

async function clientConsoleFixture(
  t: TestContext,
  options: NonNullable<Parameters<typeof createConsoleAppFixture>[1]> = {},
  issuer?: GitHubAppIssuerOptions,
) {
  let state: PlatformStateStore | undefined;
  const fixture = await createConsoleAppFixture(t, {
    oauthIssuer: fixtureOAuthIssuer(directoryIssuer, ["none", "client_secret_basic"]),
    ...options,
    wrapState(current: PlatformStateStore) {
      state = current;
      return current;
    },
  });
  await fixture.bootstrap();
  const controller = fixture.controller;
  assert.ok(controller instanceof OpenClawController);
  assert.ok(state);
  const store = controller.selectedDriver("secret").privateSecrets;
  assert.ok(store);
  const instance = await controller.activateTokenServiceInstance("console-clients", randomUUID());
  const owner = new OCCTokenServiceDriver(
    "console-clients",
    controller.installation.id,
    store,
    instance,
    state,
    undefined,
    undefined,
    issuer,
  );
  controller.registerDriver(owner);
  controller.selectDriver("token_service", owner.id);
  return fixture;
}

test("Credentials opens the unified inventory and lets an Installation administrator manage shared templates", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Template editors", {
    oauthIssuer: fixtureOAuthIssuer(googleIssuer),
  });
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, "/console/settings");
  await page.getByRole("heading", { name: "Signed-in account" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create connection template" }).count(), 0);
  await page.getByRole("link", { name: "Credentials", exact: true }).click();
  const sections = page.getByRole("navigation", { name: "Credential sections" });
  await sections
    .getByRole("link", { name: "Credentials", exact: true })
    .and(page.locator('[aria-current="page"]'))
    .waitFor();
  await sections.getByRole("link", { name: "Connection templates" }).click();
  await page.getByText("https://accounts.google.com · Unverified", { exact: true }).waitFor();
  const editGoogle = page.getByRole("button", { name: "Edit Google OAuth", exact: true });
  await editGoogle.click();
  const googleEditor = dialog(page, "Edit connection template");
  assert.equal(
    await googleEditor.getByLabel("Template availability").locator("option:checked").textContent(),
    "Installation-wide",
  );
  // Edit the installed template in place. Saving must not append another Google template.
  const summary = googleEditor.locator("summary").filter({ hasText: /^API destinations \(26\)$/ });
  const table = googleEditor.getByRole("table", { name: "HTTPS destinations" });
  assert.equal(await table.isVisible(), false);
  await summary.press("Enter");
  const gmail = table
    .getByRole("row")
    .filter({ has: page.locator('input[value="gmail.googleapis.com"]') });
  await gmail.getByRole("button", { name: "Remove destination" }).click();
  await googleEditor.getByText("API destinations (25)", { exact: true }).waitFor();
  assert.equal(await googleEditor.getByLabel("OAuth scope limit").inputValue(), "unrestricted");
  const patch = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname.startsWith("/connection-templates/"),
  );
  await googleEditor.getByRole("button", { name: "Save new version", exact: true }).click();
  const result = await patch;
  assert.equal(result.status(), 200, await result.text());
  const template = (await result.json()).data;
  const savedDestinations: { host: string; path: string }[] = template.current.destinations;
  assert.equal(
    savedDestinations.some(({ host }) => host === "gmail.googleapis.com"),
    false,
  );
  assert.ok(
    savedDestinations.some(
      ({ host, path }) => host === "www.googleapis.com" && path === "/calendar/**",
    ),
  );
  assert.ok(
    savedDestinations.some(
      ({ host, path }) => host === "www.googleapis.com" && path === "/drive/**",
    ),
  );
  assert.equal(template.current.oauthClientId, undefined);
  assert.deepEqual(template.current.issuerVerification, {
    tokenEndpointAuthMethods: ["client_secret_basic"],
  });
  assert.equal(template.current.version, 2);
  await page.getByText("Saved Google OAuth, version 2.", { exact: true }).waitFor();
  const googleRow = page.getByRole("row").filter({
    has: page.getByRole("rowheader", { name: "Google OAuth", exact: true }),
  });
  await googleRow.getByRole("cell", { name: "2", exact: true }).waitFor();
  await page.getByRole("button", { name: "Create connection template" }).click();
  const editor = dialog(page, "Create connection template");
  const availability = editor.getByLabel("Template availability");
  assert.equal(await availability.inputValue(), namespace.id);
  assert.equal(await editor.getByLabel("OAuth client", { exact: true }).count(), 0);
  await editor.getByRole("button", { name: "Create template and register OAuth client" }).waitFor();
  await editor.getByRole("button", { name: "Cancel" }).click();
  await page.goBack();
  await sections
    .getByRole("link", { name: "Credentials", exact: true })
    .and(page.locator('[aria-current="page"]'))
    .waitFor();
  // A bookmark naming an unavailable Namespace must not silently select the readable one.
  await page.goto(
    fixture.origin +
      "/console/credentials/connection-templates?namespace=ns_00000000-0000-4000-8000-000000000999",
  );
  await page.getByRole("button", { name: "Create connection template" }).click();
  assert.equal(await editor.getByLabel("Template availability").inputValue(), "");
});

test("an administrator manages static Bearer templates without OAuth client registration", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Static template owners");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/secrets?namespace=${namespace.id}`);
  await page
    .getByRole("navigation", { name: "Credential sections" })
    .getByRole("link", { name: "Connection templates" })
    .click();
  await page.getByRole("button", { name: "Create connection template" }).click();
  const editor = dialog(page, "Create connection template");
  const authentication = editor.getByLabel("Authentication method");
  // This is the missing production control on the previous OAuth-only editor.
  assert.equal(await authentication.count(), 1);
  await authentication.selectOption({ label: "Static Bearer" });
  await editor.getByLabel("Template name").fill("Reports API");
  const destinations = editor.getByRole("table", { name: "HTTP destinations" });
  await destinations.getByLabel("Method", { exact: true }).fill("REPORT-1");
  await destinations.getByLabel("Host", { exact: true }).fill("reports.example.test");
  await destinations.getByLabel("Path", { exact: true }).fill("/reports/**");
  assert.equal(await editor.getByLabel("OAuth client", { exact: true }).isVisible(), false);
  const posted = responseTo(page, "POST", fixture.origin + "/connection-templates");
  await editor.getByRole("button", { name: "Create template", exact: true }).click();
  const created = await posted;
  assert.equal(created.status(), 201, await created.text());
  const template = (await created.json()).data;
  assert.equal(template.current.mode, "static_bearer");
  assert.deepEqual(template.current.destinations, [
    { method: "REPORT-1", host: "reports.example.test", port: 443, path: "/reports/**" },
  ]);
  await page.getByText("Saved Reports API, version 1.", { exact: true }).waitFor();
  const row = () =>
    page
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: "Reports API", exact: true }) });
  await row().getByRole("cell", { name: "Static Bearer", exact: true }).waitFor();

  // A rename preserves the template version; editing a destination advances it.
  await row().getByRole("button", { name: "Edit Reports API" }).click();
  const edit = dialog(page, "Edit connection template");
  await edit.getByLabel("Template name").fill("Reporting service");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await page.getByText("Saved Reporting service, version 1.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Reporting service" }).click();
  await edit
    .getByRole("table", { name: "HTTP destinations" })
    .getByLabel("Path", { exact: true })
    .fill("/reports/export");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await page.getByText("Saved Reporting service, version 2.", { exact: true }).waitFor();

  // Client registration is independent of both OAuth and static Templates.
  const sections = page.getByRole("navigation", { name: "Credential sections" });
  await sections.getByRole("link", { name: "Credential clients", exact: true }).click();
  await page.getByRole("button", { name: "Register client" }).click();
  const registration = dialog(page, "Register credential client");
  assert.equal(await registration.getByLabel("Connection template").count(), 0);
  await registration.getByRole("button", { name: "Cancel" }).click();
  await sections.getByRole("link", { name: "Connection templates", exact: true }).click();
  await page.getByRole("button", { name: /Delete Reporting service/ }).click();
  const deletion = dialog(page, "Delete connection template");
  await deletion
    .getByText("This permanently deletes the template and its saved versions.", { exact: true })
    .waitFor();
  assert.equal(await deletion.getByText("Its registered OAuth clients stay available.").count(), 0);
  await deletion.getByRole("button", { name: "Delete connection template", exact: true }).click();
  await page.getByText("Deleted Reporting service.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Reporting service" }).count(), 0);
});

test("a template needs an explicit availability when the administrator has no Namespace", async (t) => {
  const fixture = await clientConsoleFixture(t);
  restrict(fixture.policy, "read", "namespace");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, "/console/secrets");
  await page
    .getByRole("navigation", { name: "Credential sections" })
    .getByRole("link", { name: "Connection templates" })
    .click();
  await page.getByRole("button", { name: "Create connection template" }).click();
  const editor = dialog(page, "Create connection template");
  const availability = editor.getByLabel("Template availability");
  assert.equal(await availability.inputValue(), "");
  assert.equal(
    await availability.getByRole("option", { name: "Choose availability" }).isDisabled(),
    true,
  );
  await editor.getByLabel("Template name").fill("Company tools");
  await editor.getByLabel("Issuer URL", { exact: true }).fill("https://identity.example.test");
  await editor.getByLabel("Authorization URL").fill("https://identity.example.test/authorize");
  await editor.getByLabel("Token URL").fill("https://identity.example.test/token");
  await editor.getByRole("textbox", { name: "Host", exact: true }).fill("tools.example.test");
  await editor.getByRole("button", { name: "Add destination" }).click();
  const archive = editor.getByRole("row").last();
  await archive.getByLabel("Host", { exact: true }).fill("archive.example.test");
  await archive.getByLabel("Port", { exact: true }).fill("8443");
  await archive.getByLabel("Path", { exact: true }).fill("/reports/**");
  const register = editor.getByRole("button", {
    name: "Create template and register OAuth client",
  });
  const save = editor.getByRole("button", { name: "Create template", exact: true });
  const requests = apiRequests(page, fixture.origin);
  for (const action of [register, save]) {
    await action.click();
    assert.equal(await availability.evaluate((el) => el === document.activeElement), true);
    assert.deepEqual(
      requests.filter((req) => req.method === "POST"),
      [],
    );
  }
  // Only the administrator's explicit selection permits saving an Installation-wide client.
  await availability.selectOption({ label: "Installation-wide" });
  const policy = editor.getByLabel("OAuth scope limit");
  assert.equal(await policy.locator("option:checked").textContent(), "No template limit");
  await policy.selectOption({ label: "Limit to approved scopes" });
  // Whitespace in a restricted allowlist can never turn into an unrestricted template.
  const scopes = editor.getByLabel("Approved OAuth scopes");
  await scopes.fill("   ");
  await save.click();
  assert.equal(await scopes.evaluate((el) => el === document.activeElement), true);
  assert.deepEqual(pathRequests(requests, "POST", "/connection-templates"), []);
  await policy.selectOption({ label: "No template limit" });
  const created = responseTo(page, "POST", fixture.origin + "/connection-templates");
  await register.click();
  const response = await created;
  assert.equal(response.status(), 201, await response.text());
  const template = (await response.json()).data;
  assert.deepEqual(template.current.scopes, []);
  assert.deepEqual(template.current.destinations, [
    { host: "archive.example.test", port: 8443, path: "/reports/**" },
    { host: "tools.example.test", port: 443, path: "/**" },
  ]);
  assert.equal(template.namespaceId, undefined);
  const registration = dialog(page, "Register credential client");
  assert.equal(await registration.getByLabel("Availability").inputValue(), "installation");
  assert.equal(await registration.getByLabel("Issuer URL").inputValue(), template.current.issuer);
  assert.equal(await registration.getByLabel("Token URL").count(), 0);
  assert.equal(await registration.getByLabel("Revocation URL").count(), 0);
  await registration.getByLabel("Client name").fill("Tools client");
  await registration.getByLabel("Client ID", { exact: true }).fill("tools-client");
  const publicMethod = registration.getByLabel("Token endpoint authentication method", {
    exact: true,
  });
  await publicMethod.selectOption("none");
  assert.equal(await publicMethod.inputValue(), "none");
  assert.equal(await registration.getByLabel("Client secret", { exact: true }).isVisible(), false);
  const registered = responseTo(page, "POST", fixture.origin + "/credential-clients");
  await registration.getByRole("button", { name: "Register client" }).click();
  const regResult = await registered;
  assert.equal(regResult.status(), 201, await regResult.text());
  assert.deepEqual(pathRequests(requests, "POST", "/credential-clients")[0]?.body, {
    kind: "oauth2",
    displayName: "Tools client",
    issuer: template.current.issuer,
    clientId: "tools-client",
    tokenEndpointAuthMethod: "none",
  });
  const editing = dialog(page, "Edit connection template");
  assert.equal(await editing.getByLabel("OAuth client", { exact: true }).count(), 0);
  assert.equal(await editing.getByLabel("Template availability").isDisabled(), true);
  assert.equal(
    await editing.getByLabel("Template availability").locator("option:checked").textContent(),
    "Installation-wide",
  );
  const savedPolicy = editing.getByLabel("OAuth scope limit");
  assert.equal(await savedPolicy.locator("option:checked").textContent(), "No template limit");
  await savedPolicy.selectOption({ label: "Limit to approved scopes" });
  await editing.getByLabel("Approved OAuth scopes").fill("tools.read");
  const updated = responseTo(
    page,
    "PATCH",
    fixture.origin + "/connection-templates/" + template.id,
  );
  await editing.getByRole("button", { name: "Save new version" }).click();
  const patch = await updated;
  assert.equal(patch.status(), 200, await patch.text());
  assert.deepEqual((await patch.json()).data.current.scopes, ["tools.read"]);
  await page.getByRole("button", { name: "Edit Company tools" }).click();
  const reopened = dialog(page, "Edit connection template");
  assert.equal(await reopened.getByLabel("OAuth scope limit").inputValue(), "restricted");
  assert.equal(await reopened.getByLabel("Approved OAuth scopes").inputValue(), "tools.read");
});

test("an administrator registers independent OAuth clients with exact availability", async (t) => {
  const fixture = await clientConsoleFixture(t, { publicOrigin: true });
  const namespace = await fixture.createNamespace("OAuth client owners", { ready: true });
  const other = await fixture.createNamespace("Other client owners", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, secretsUrl(namespace));
  const sections = page.getByRole("navigation", { name: "Credential sections" });
  await sections.getByRole("link", { name: "Credential clients", exact: true }).click();
  await page.getByRole("button", { name: "Register client" }).click();
  const form = dialog(page, "Register credential client");
  assert.equal(await form.getByLabel("Connection template").count(), 0);
  assert.equal(
    await form.getByLabel("Redirect URI").inputValue(),
    fixture.origin + "/oauth/callback",
  );
  await form.getByLabel("Availability").selectOption(namespace.id);
  await form.getByLabel("Client name").fill("Engineering directory");
  await form.getByLabel("Issuer URL").fill("https://identity.example.test");
  assert.equal(await form.getByLabel("Token URL").count(), 0);
  await form.getByLabel("Client ID", { exact: true }).fill("engineering-directory");
  const privateValue = "browser-write-only-client-material";
  await form.getByLabel("Client secret", { exact: true }).fill(privateValue);
  const registered = responseTo(page, "POST", fixture.origin + "/credential-clients");
  await form.getByRole("button", { name: "Register client" }).click();
  const response = await registered;
  assert.equal(response.status(), 201, await response.text());
  const client = (await response.json()).data;
  assert.equal(client.kind, "oauth2");
  assert.equal(client.namespaceId, namespace.id);
  assert.equal(Object.hasOwn(client, "clientSecret"), false);
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "Engineering directory", exact: true }) });
  await row.getByRole("cell", { name: "OAuth 2.0", exact: true }).waitFor();
  await row.getByRole("cell", { name: "Namespace · OAuth client owners", exact: true }).waitFor();
  assert.equal((await page.locator("body").innerText()).includes(privateValue), false);

  // Client availability is independent of Template storage and follows the selected Namespace.
  const selector = page.getByRole("combobox", { name: "Namespace", exact: true });
  await selector.selectOption(other.id);
  await page
    .getByText("No credential clients are available for this selection.", { exact: true })
    .waitFor();
  assert.equal(await row.count(), 0);
  restrict(fixture.policy, "administer", "installation");
  await page.goto(
    fixture.origin + "/console/credentials/credential-clients?namespace=" + namespace.id,
  );
  await page.getByRole("heading", { name: "Installation administrator access required" }).waitFor();
  assert.equal(
    await sections.getByRole("link", { name: "Credential clients", exact: true }).count(),
    0,
  );
  assert.equal(await page.getByRole("button", { name: "Register client" }).count(), 0);
});

test("a Template neither assigns nor fences an independent credential client", async (t) => {
  const fixture = await clientConsoleFixture(t);
  const namespace = await fixture.createNamespace("Customer support", { ready: true });
  const google = (await fixture.request("GET", "/connection-templates")).data.find(
    (template: { displayName: string }) => template.displayName === "Google OAuth",
  );
  assert.ok(google);
  const registered = await fixture.request("POST", "/credential-clients", {
    body: {
      kind: "oauth2",
      displayName: "Google app",
      clientId: "google-app",
      issuer: google.current.issuer,
      tokenEndpointAuthMethod: "none",
    },
  });
  assert.equal(registered.status, 201);
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 390, height: 844 } },
  });
  await login(page, fixture, secretsUrl(namespace));
  const sections = page.getByRole("navigation", { name: "Credential sections" });
  await sections.getByRole("link", { name: "Credential clients", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete Google app (Installation-wide)", exact: true })
    .click();
  const deletion = dialog(page, "Delete credential client");
  assert.match(await deletion.innerText(), /Installation-wide/);
  const removed = responseTo(
    page,
    "DELETE",
    fixture.origin + "/credential-clients/" + registered.data.id,
  );
  await deletion.getByRole("button", { name: "Delete credential client", exact: true }).click();
  assert.equal((await removed).status(), 204);
  await page.getByText("Deleted Google app.", { exact: true }).waitFor();
  await sections.getByRole("link", { name: "Connection templates", exact: true }).click();
  await page.getByRole("button", { name: "Edit Google OAuth" }).waitFor();
  const current = await fixture.request("GET", "/connection-templates/" + google.id);
  assert.equal(current.data.current.version, google.current.version);
  assert.equal(Object.hasOwn(current.data.current, "oauthClientId"), false);
});

test("an administrator registers and rotates a verified GitHub App signing key", async (t) => {
  // Exercise the real TokenService verifier against the existing signed TLS issuer fixture.
  const clock = createControlledClock();
  const tls = await createTlsMaterial(t);
  const github = createGitHubProtocol({ clock });
  let current = github;
  const apiOrigin = await listen(
    t,
    createServer(tls, (request, response) => current.handleRequest(request, response)),
  );
  const fixture = await clientConsoleFixture(t, {}, { apiOrigin, ca: tls.cert, clock });
  const namespace = await fixture.createNamespace("Git client owners", { ready: true });
  const other = await fixture.createNamespace("Other Git clients", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, secretsUrl(namespace));
  await page
    .getByRole("navigation", { name: "Credential sections" })
    .getByRole("link", { name: "Credential clients", exact: true })
    .click();
  await page.getByRole("button", { name: "Register client" }).click();
  const form = dialog(page, "Register credential client");
  await form.getByLabel("Client type").selectOption("github-app");
  const availability = form.getByLabel("Availability");
  assert.equal(await availability.inputValue(), "installation");
  await availability.selectOption(namespace.id);
  await form.getByLabel("Client name").fill("Repository App");
  await form.getByLabel("GitHub App ID").fill(String(Number(fixtureAppId) + 1));
  const privateKey = github.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await form.getByLabel("Private key file").setInputFiles({
    name: "app.pem",
    mimeType: "application/x-pem-file",
    buffer: Buffer.from(privateKey),
  });
  // A real signing-key verification refusal leaves the form retryable without a catalog refresh.
  const refused = responseTo(page, "POST", fixture.origin + "/credential-clients");
  const submit = form.getByRole("button", { name: "Register client" });
  await submit.click();
  assert.equal((await refused).status(), 404);
  await form
    .getByText(
      "GitHub App verification failed. Check the App ID and matching private key, and OCC connectivity to GitHub.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await submit.isEnabled(), true);
  assert.equal(await form.getByRole("button", { name: /Refresh/i }).count(), 0);
  await form.getByLabel("GitHub App ID").fill(fixtureAppId);
  await form.getByLabel("Private key file").setInputFiles({
    name: "app.pem",
    mimeType: "application/x-pem-file",
    buffer: Buffer.from(privateKey),
  });
  const registration = responseTo(page, "POST", fixture.origin + "/credential-clients");
  await form.getByRole("button", { name: "Register client" }).click();
  const response = await registration;
  assert.equal(response.status(), 201, await response.text());
  const client = (await response.json()).data;
  assert.deepEqual(
    { kind: client.kind, appId: client.appId, namespaceId: client.namespaceId },
    { kind: "github-app", appId: fixtureAppId, namespaceId: namespace.id },
  );
  assert.equal(Object.hasOwn(client, "privateKey"), false);
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "Repository App", exact: true }) });
  await row.getByRole("cell", { name: "GitHub App", exact: true }).waitFor();
  const scope = row.getByRole("cell", { name: "Namespace · Git client owners", exact: true });
  await scope.waitFor();
  const namespaceSelector = page.getByRole("combobox", { name: "Namespace", exact: true });
  await namespaceSelector.selectOption(other.id);
  await page
    .getByText("No credential clients are available for this selection.", { exact: true })
    .waitFor();
  assert.equal(await row.count(), 0);
  await namespaceSelector.selectOption(namespace.id);
  await scope.waitFor();
  await row.getByRole("button", { name: "Rotate Repository App" }).click();
  const rotation = dialog(page, "Rotate GitHub App key");
  // The issuer now recognizes a second real key for the same App; rotation must verify it.
  current = createGitHubProtocol({ clock, keyPair: sharedRsaKeyPair("github-app-rotation") });
  const replacement = current.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.notEqual(replacement, privateKey);
  await rotation.getByLabel("New private key file").setInputFiles({
    name: "rotated.pem",
    mimeType: "application/x-pem-file",
    buffer: Buffer.from(replacement),
  });
  const replaced = responseTo(
    page,
    "POST",
    fixture.origin + "/credential-clients/" + client.id + "/rotate",
  );
  await rotation.getByRole("button", { name: "Rotate", exact: true }).click();
  const rotated = await replaced;
  assert.equal(rotated.status(), 200);
  assert.equal((await rotated.json()).data.namespaceId, namespace.id);
  await page.getByText("Rotated Repository App.", { exact: true }).waitFor();
  assert.equal((await page.locator("body").innerText()).includes("BEGIN PRIVATE KEY"), false);
});

for (const outcome of ["lost", "versionless"]) {
  test(`a ${outcome} Template creation response does not start Client registration`, async (t) => {
    const { fixture, namespace } = await createReadyConsoleNamespace(t, "Registration recovery", {
      oauthIssuer: fixtureOAuthIssuer(directoryIssuer),
    });
    const { page } = await newPage(t, fixture, { browser });
    await login(page, fixture, secretsUrl(namespace));
    await page
      .getByRole("navigation", { name: "Credential sections" })
      .getByRole("link", { name: "Connection templates", exact: true })
      .click();
    await page.getByRole("button", { name: "Create connection template" }).click();
    const editor = dialog(page, "Create connection template");
    await fillDirectoryTemplate(editor);
    await page.route(fixture.origin + "/connection-templates", async (route) => {
      if (route.request().method() !== "POST") {
        return route.continue();
      }
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      if (outcome === "lost") {
        return route.abort("failed");
      }
      const payload: { data: { current: { version?: number } } } = await response.json();
      delete payload.data.current.version;
      await route.fulfill({ response, json: payload });
    });
    await editor.getByRole("button", { name: "Create template and register OAuth client" }).click();
    await editor.getByText(/The template may have been saved/).waitFor();
    assert.equal(await dialog(page, "Register credential client").count(), 0);
    const reloaded = responseTo(page, "GET", fixture.origin + "/connection-templates");
    await editor.getByRole("button", { name: "Close" }).click();
    const committed = (await (await reloaded).json()).data.filter(
      (template: { namespaceId?: string }) => template.namespaceId === namespace.id,
    );
    assert.equal(committed.length, 1);
    await page.getByRole("button", { name: "Edit Directory OAuth" }).waitFor();
  });
}

test("refocusing a changed Secret library keeps the search and follows only readable results", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Library readers");
  const other = await fixture.createNamespace("Second library", { ready: true });
  await fixture.createSecret(namespace.id, "Signing key", "synthetic-signing-value");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, secretsUrl(namespace));
  const search = page.getByRole("searchbox", { name: "Search Secrets" });
  const empty = page.getByRole("heading", { name: "No matching Secrets" });
  await search.fill("model");
  await empty.waitFor();
  await search.press("Shift+ArrowLeft");

  // Another session adds a match while the reader is editing the query.
  const match = await fixture.createSecret(namespace.id, "Model key", "synthetic-model-value");
  const result = page.getByRole("button", { name: match.name, exact: true });
  await refocusHeld(t, page);
  await result.waitFor();
  assert.equal(await search.inputValue(), "model");
  assert.equal(await hasFocus(search), true);
  await page.keyboard.type("L");
  assert.equal(await search.inputValue(), "modeL", "typing replaces the selected letter");
  assert.equal(await page.getByRole("list", { name: "Secrets" }).getByRole("button").count(), 1);

  // Follow the focused result across a permission change, but never restore a revoked row.
  await result.focus();
  restrict(fixture.policy, "create", "secret", { namespaceId: namespace.id });
  await refocusHeld(t, page);
  assert.equal(await page.getByRole("button", { name: "Create Secret" }).isDisabled(), true);
  assert.equal(await hasFocus(result), true);
  const revoked = restrict(fixture.policy, "read", "secret", {
    namespaceId: namespace.id,
    resourceId: match.id,
  });
  await refocusHeld(t, page);
  await empty.waitFor();
  assert.equal(await result.count(), 0);
  assert.equal(await search.inputValue(), "modeL");
  assert.equal(await hasFocus(search), true);

  // The other Namespace starts unfiltered. Returning applies the old query to current access.
  const selector = page.getByRole("combobox", { name: "Namespace", exact: true });
  await selector.selectOption(other.id);
  await page.getByRole("heading", { name: "No Secrets yet" }).waitFor();
  assert.equal(await search.inputValue(), "");
  liftRestriction(fixture.policy, revoked);
  await selector.selectOption(namespace.id);
  await result.waitFor();
  assert.equal(await search.inputValue(), "modeL");
});

test("console Secret creation, replacement, Agent consumers and cleanup use real API and IAM", async (t) => {
  const audit = new InMemoryAuditSink();
  const storage = createTestSecretDriver();
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Secret editors", {
    auditSink: audit,
    secretDriver: storage,
  });
  const other = await fixture.createNamespace("Other tenant", { ready: true });
  await fixture.createSecret(other.id, "Other tenant credential", "synthetic-other-value");
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 640, height: 360 }, reducedMotion: "reduce" },
  });
  await login(page, fixture, secretsUrl(namespace));
  await page.locator(settledView).getByRole("heading", { name: "No Secrets yet" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Other tenant credential" }).count(), 0);

  await page.getByRole("button", { name: "Create Secret", exact: true }).press("Enter");
  const creation = dialog(page, "Create Secret");
  const name = creation.getByLabel("Secret name", { exact: true });
  const value = creation.getByLabel("Value", { exact: true });
  assert.equal(await hasFocus(name), true);
  await page.keyboard.press("Tab");
  await expectSecretFocusInView(
    creation.getByRole("button", { name: "Show value" }),
    "Create Show value",
  );
  // On the short sheet, Chromium can focus the caret while the bottom of Value is clipped.
  await page.keyboard.press("Tab");
  await expectSecretFocusInView(value, "Create Value after Tab");
  await page.keyboard.press("Tab");
  await expectSecretFocusInView(creation.getByRole("button", { name: "Close" }), "Create Close");
  await page.keyboard.press("Shift+Tab");
  await expectSecretFocusInView(value, "Create Value after Shift+Tab");

  // New material is opaque: spaces, Unicode and newlines must reach storage unchanged.
  const original = "  synthetic-console-credential\nsecond line π  ";
  await name.fill("Shared model");
  await value.fill(original);
  await creation.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog(page, "Secret created").getByRole("button", { name: "Close" }).click();
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

  // In a short desktop window, Replace focuses Value before any Tab event.
  await page.setViewportSize({ width: 761, height: 300 });
  await page.getByRole("button", { name: "Shared model", exact: true }).click();
  await dialog(page, "Shared model")
    .getByRole("button", { name: "Replace value", exact: true })
    .press("Enter");
  const replacement = dialog(page, "Replace Secret value");
  const replacementValue = replacement.getByLabel("Value", { exact: true });
  assert.equal(await replacementValue.inputValue(), "");
  await replacement.evaluate(async (node) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished));
  });
  await expectSecretFocusInView(replacementValue, "Replace Value on opening");
  await page.setViewportSize({ width: 640, height: 360 });
  await page.keyboard.press("Tab");
  await expectSecretFocusInView(
    replacement.getByRole("button", { name: "Close" }),
    "Replace Close",
  );
  await page.keyboard.press("Shift+Tab");
  await expectSecretFocusInView(replacementValue, "Replace Value after Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expectSecretFocusInView(
    replacement.getByRole("button", { name: "Show value" }),
    "Replace Show value",
  );
  await replacementValue.fill("synthetic-console-replacement");
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
  // Keep several readable matches in the library so Back has a real scroll position to restore.
  for (let index = 1; index <= 8; index += 1) {
    await fixture.createSecret(namespace.id, `Shared key ${index}`, "synthetic-library-value");
  }
  await page.setViewportSize({ width: 640, height: 600 });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .locator(settledView)
    .getByRole("button", { name: "Shared key 8", exact: true })
    .waitFor();

  const requests = apiRequests(page, fixture.origin);
  const query = "Shared";
  const search = page.getByRole("searchbox", { name: "Search Secrets" });
  const shared = page.getByRole("button", { name: "Shared model", exact: true });
  const heading = page.getByRole("heading", { name: "Credentials", level: 1 });
  const intersectsViewport = (locator: Locator) =>
    locator.evaluate((node) => {
      const { top, bottom } = node.getBoundingClientRect();
      return top < globalThis.innerHeight && bottom > 0;
    });
  await search.fill(query);
  await shared.focus();
  await shared.evaluate((row) => row.scrollIntoView({ block: "end" }));
  const libraryScroll = await page.evaluate(() => globalThis.scrollY);
  assert.equal(
    await intersectsViewport(heading),
    false,
    "the library is scrolled past its heading",
  );
  const detailRead = responseTo(
    page,
    "GET",
    `${fixture.origin}${secretPath(namespace)}/${secret.id}`,
  );
  await shared.press("Enter");
  const detailResponse = await detailRead;
  assert.equal(detailResponse.status(), 200);
  const { data: opened }: SecretDetailResponse = await detailResponse.json();
  assert.equal(opened.callerPermissions?.delete, true);
  const detail = dialog(page, "Shared model");
  // Consumers name the Agent, its ID beside it (finding D761).
  const consumer = detail.getByRole("link", { name: agent.name, exact: true });
  await consumer.waitFor();
  await detail.getByText(agent.id, { exact: true }).waitFor();
  // A keyboard reader reaches the blocked Delete Secret and hears why (finding 2925).
  await expectReachableReason(
    page,
    detail.getByRole("button", { name: "Delete Secret", exact: true }),
    SECRET_REFERENCED,
  );
  assert.doesNotMatch(await detail.innerText(), /remove .*references|remove them/i);
  const openConsumer = async () => {
    await consumer.press("Enter");
    await page.waitForURL(`**/console/agents/${agent.id}?namespace=${namespace.id}`);
    await page.getByRole("heading", { name: agent.name, exact: true }).waitFor();
    await page.locator(settledView).waitFor();
  };
  const returnToLibrary = async () => {
    await page.goBack();
    await page.waitForURL(`**${secretsUrl(namespace)}`);
    await page.locator(settledView).getByRole("searchbox", { name: "Search Secrets" }).waitFor();
    assert.equal(await search.inputValue(), query);
    assert.equal(await detail.count(), 0, "Back leaves the Secret inspector closed");
  };

  await openConsumer();
  await returnToLibrary();
  assert.equal(await hasFocus(shared), true, "Back focuses the originating Secret row");
  assert.equal(await shared.evaluate((row) => row.matches(":focus-visible")), true);
  assert.equal(await page.evaluate(() => globalThis.scrollY), libraryScroll);

  // Another session adds matches before the originating row while the reader is away.
  await page.keyboard.press("Enter");
  await openConsumer();
  await fixture.createSecret(namespace.id, "Shared backup 1", "synthetic-library-value");
  await fixture.createSecret(namespace.id, "Shared backup 2", "synthetic-library-value");
  await returnToLibrary();
  assert.equal(await hasFocus(shared), true);
  assert.equal(await intersectsViewport(shared), true, "Back reveals the shifted row");
  assert.equal(
    await shared.evaluate(
      (row, oldScroll) =>
        row.getBoundingClientRect().top + globalThis.scrollY >= oldScroll + globalThis.innerHeight,
      libraryScroll,
    ),
    true,
    "the old scroll offset would leave the row below the viewport",
  );

  // The same return has no row to focus when the real list withdraws access while away.
  await page.keyboard.press("Enter");
  await openConsumer();
  const revoked = restrict(fixture.policy, "read", "secret", {
    namespaceId: namespace.id,
    resourceId: secret.id,
  });
  await returnToLibrary();
  assert.equal(await shared.count(), 0);
  assert.equal(await page.getByRole("list", { name: "Secrets" }).getByRole("button").count(), 10);
  assert.equal(await hasFocus(heading), true);
  assert.equal(await intersectsViewport(heading), true, "Back reveals the fallback heading");
  liftRestriction(fixture.policy, revoked);
  assert.ok(
    requests.every((request) => request.method === "GET"),
    "inspection and navigation must be read-only",
  );

  // Clear the Agent draft reference through its supported API before deleting the Secret.
  const unbound = await fixture.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
    body: { configurationId: agent.configurationId, harnessAuth: null } satisfies UpdateAgentBody,
  });
  assert.equal(unbound.status, 200);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await shared.click();
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

  // An administrator's link to a Secret the list leaves out, here the one just deleted, says it
  // is not in her readable list and asks nothing: she is the administrator the member text
  // sends readers to (finding D769). A malformed ID is not repeated on the page.
  for (const [linkedId, shown] of [
    [secret.id, `Secret ${secret.id}`],
    ["sec_not-a-secret-id", "such Secret"],
  ] satisfies [string, string][]) {
    await page.goto(`${fixture.origin}${secretsUrl(namespace)}&secret=${linkedId}`);
    await page
      .getByRole("status")
      .getByText(secretLinkUnlistedAdministrator(shown), { exact: true })
      .waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
  }
});

test("unknown console Secret writes erase entered material and never replay mutations", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Interrupted writes");
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
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Deletion status");
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
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Restricted operations", {
    auditSink: audit,
    secretDriver: storage,
    provisionedPeople: ["secret-reader"],
  });
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
  const sharedAgent = await fixture.createAgent(
    namespace.id,
    "Shared Agent",
    {},
    { harnessAuth: { method: "api_key", source: privateSecret.ref } },
  );
  const hiddenSecret = await fixture.createSecret(
    namespace.id,
    "Hidden credential",
    "synthetic-hidden-value",
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
  await grant("read", "agent", sharedAgent.id);
  const privateAgentRead = await grant("read", "agent", privateAgent.id);
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, secretsUrl(namespace), member.credentials);
  // Without Secret create the page never offers creation that the API would refuse after the
  // dialog is filled in (finding 2365): Create Secret is disabled and the note names why.
  const createSecret = page.getByRole("button", { name: "Create Secret", exact: true });
  const createReason = page.getByRole("status").filter({ hasText: SECRET_CREATE_MEMBER_DENIED });
  await createReason.waitFor();
  assert.equal(await createSecret.isDisabled(), true);
  assert.equal(
    await createSecret.getAttribute("aria-describedby"),
    await createReason.getAttribute("id"),
  );
  // Hold the name lookup before it reaches IAM, after the Secret read has listed both
  // consumers. Revoking one exact grant must not turn that older ID into a current identity.
  const requests = apiRequests(page, fixture.origin);
  const detailUrl = `${fixture.origin}${secretPath(namespace)}/${privateSecret.id}`;
  const agentsUrl = `${fixture.origin}/namespaces/${namespace.id}/agents`;
  const heldNames = await holdRequests(t, page, agentsUrl, {
    method: "GET",
    once: true,
  });
  const initialRead = responseTo(page, "GET", detailUrl);
  await page.getByRole("button", { name: privateSecret.name, exact: true }).click();
  const initialResponse = await initialRead;
  assert.equal(initialResponse.status(), 200, "the first Secret read must succeed");
  const { data: initial }: SecretDetailResponse = await initialResponse.json();
  assert.deepEqual([...initial.consumers.agents].sort(), [privateAgent.id, sharedAgent.id].sort());
  assert.equal(initial.consumers.unreadable, 0);
  await heldNames.requested;
  // fixture.request uses the separate administrator session, not the scoped browser member.
  assert.equal((await fixture.request("DELETE", privateAgentRead)).status, 204);
  const nameRead = responseTo(page, "GET", agentsUrl);
  heldNames.release();
  const nameResponse = await nameRead;
  assert.equal(nameResponse.status(), 200, "the subsequent genuine Agent list must succeed");
  const { data: namedAgents }: AgentListResponse = await nameResponse.json();
  assert.deepEqual(
    namedAgents.map((agent) => agent.id),
    [sharedAgent.id],
  );
  const raceDetail = dialog(page, privateSecret.name);
  const readableLink = raceDetail.getByRole("link", { name: sharedAgent.name, exact: true });
  await readableLink.waitFor();
  assert.equal(
    new URL((await readableLink.getAttribute("href"))!, fixture.origin).pathname,
    `/console/agents/${sharedAgent.id}`,
  );
  const missingRow = raceDetail.locator(".secret-consumers").first().locator("li").filter({
    hasNotText: sharedAgent.id,
  });
  const missingText = await missingRow.innerText();
  const missingOutput = `${missingText}\n${await missingRow.ariaSnapshot()}\n${await missingRow.innerHTML()}`;
  for (const name of ["Replace value", "Delete Secret"]) {
    assert.equal(await raceDetail.getByRole("button", { name, exact: true }).isDisabled(), true);
  }
  await raceDetail.getByRole("button", { name: "Close" }).click();

  // A fresh read is the control: IAM now counts the hidden consumer without returning its ID.
  const freshRead = responseTo(page, "GET", detailUrl);
  await page.getByRole("button", { name: privateSecret.name, exact: true }).click();
  const freshResponse = await freshRead;
  assert.equal(freshResponse.status(), 200);
  const { data: fresh }: SecretDetailResponse = await freshResponse.json();
  assert.deepEqual(fresh.consumers.agents, [sharedAgent.id]);
  assert.equal(fresh.consumers.unreadable, 1);
  assert.equal(fresh.callerPermissions?.delete, false);
  const privateDetail = dialog(page, privateSecret.name);
  await privateDetail.getByText(/1 additional consumer/).waitFor();
  assert.equal(await privateDetail.getByText(privateAgent.id, { exact: true }).count(), 0);
  // A consumer the member may read shows by name, its ID beside it (finding D761).
  await privateDetail.getByRole("link", { name: sharedAgent.name, exact: true }).waitFor();
  await privateDetail.getByText(sharedAgent.id, { exact: true }).waitFor();
  // Both reasons describe Delete Secret: the references and the missing grant (finding 2925).
  await expectReachableReason(
    page,
    privateDetail.getByRole("button", { name: "Delete Secret", exact: true }),
    `${SECRET_REFERENCED} ${SECRET_DELETE_DENIED}`,
  );
  assert.doesNotMatch(await privateDetail.innerText(), /remove .*references|remove them/i);
  await privateDetail.getByRole("button", { name: "Close" }).click();
  assert.ok(
    requests.every((request) => request.method === "GET"),
    "inspection must be read-only",
  );
  // Assert the captured race row after the fresh-read control, so a red identifies the
  // stale renderer output rather than a failed grant, interception, or server response.
  for (const identity of [privateAgent.id, privateAgent.name]) {
    assert.equal(
      missingOutput.includes(identity),
      false,
      "the unresolved Agent row exposes stale identity in text, accessibility or markup",
    );
  }
  assert.doesNotMatch(missingText, /cannot read|denied|no access|permission|delet/i);
  assert.match(
    missingText,
    /reopen|recheck/i,
    "the unresolved Agent row must explain how to check usage again",
  );

  // The Secret read's answer disables what the member may not do, and each button names why,
  // before any value is typed (finding D761).
  await page.getByRole("button", { name: secret.name, exact: true }).click();
  const readOnly = dialog(page, secret.name);
  for (const [name, reason] of [
    ["Replace value", SECRET_UPDATE_DENIED],
    ["Delete Secret", SECRET_DELETE_DENIED],
  ] as const) {
    const action = readOnly.getByRole("button", { name, exact: true, description: reason });
    await action.waitFor();
    assert.equal(await action.isDisabled(), true, name);
    // Still in the Tab order, so a keyboard reader hears why (finding 2925).
    await expectReachableReason(page, action, reason);
  }
  await readOnly.getByRole("button", { name: "Close" }).click();

  // A link to a Secret the member may not read, or to none at all, opens nothing and says why,
  // in the same words, without reading it.
  for (const linkedId of [hiddenSecret.id, "sec_00000000-0000-4000-8000-000000000999"]) {
    await page.goto(`${fixture.origin}${secretsUrl(namespace)}&secret=${linkedId}`);
    await page.getByRole("status").getByText(SECRET_LINK_UNLISTED, { exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
  }
  assert.deepEqual(
    audit.list().filter((event) => event.outcome === "denied"),
    [],
    "reading the answers, the consumers' names and the links audits no denial",
  );

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
    const response = responseTo(page, method, url);
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
    const expected = creating ? SECRET_CREATE_MEMBER_DENIED : /Your access does not include/;
    await form.getByRole("alert").filter({ hasText: expected }).waitFor();
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
    // The refused submit and fields stay in the Tab order, described by the refusal after their
    // own help, and send nothing (finding 2935).
    const refusal = (await form.getByRole("alert").textContent())?.trim() ?? "";
    await expectReachableReason(page, submit, refusal);
    const fields: (typeof value)[] = method === "DELETE" ? [] : [value];
    if (creating) {
      fields.push(form.getByLabel("Secret name"));
    }
    for (const field of fields) {
      const description = await accessibleDescription(field);
      assert.ok(description.endsWith(refusal), description);
      await expectReachableReason(page, field, description);
    }
    assert.equal(storage.calls.length, callCount);
    await close.click();
  }
  // A page that read the permission answer before a revocation still offers creation, as the
  // API's answer to a creator does; the API refuses the POST.
  await page.route(`**/namespaces/${namespace.id}/permissions`, (route) =>
    fulfillPatchedJson(route, NamespaceCallerPermissionsResponse, (body) => ({
      ...body,
      data: { ...body.data, secrets: { create: true } },
    })),
  );
  // The POST response can carry arbitrary text. A named denial must not echo
  // the submitted value or replace the local description of the refused controls.
  const canary = "synthetic-post-response-canary";
  const inventedAdvice = "Follow the invented recovery step.";
  const reflected = `Not authorized: reflected ${canary}. ${inventedAdvice}`;
  const postRequests = apiRequests(page, fixture.origin);
  const requestMask = `**${secretPath(namespace)}`;
  const interceptCreate = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    assert.equal(route.request().postDataJSON().value, canary);
    await route.fulfill(apiErrorResponse(403, "FORBIDDEN", reflected));
  };
  await page.route(requestMask, interceptCreate);
  await page.reload();
  await createSecret.click();
  const createName = form.getByLabel("Secret name");
  const submitCreate = form.getByRole("button", { name: "Create Secret", exact: true });
  await createName.fill("Synthetic response check");
  await value.fill(canary);
  const post = responseTo(page, "POST", collection);
  await submitCreate.click();
  const returned = await post;
  assert.equal(returned.status(), 403);
  const reflectedBody: ErrorResponse = await returned.json();
  assert.equal(reflectedBody.error.code, "FORBIDDEN");
  assert.equal(reflectedBody.error.message, reflected);
  const closeCreate = form.getByRole("button", { name: "Close" });
  await closeCreate.waitFor();
  const alert = form.getByRole("alert");
  assert.equal(await alert.textContent(), SECRET_CREATE_MEMBER_DENIED);
  assert.equal(await value.inputValue(), "");
  assert.equal(await hasFocus(closeCreate), true);
  for (const control of [
    submitCreate,
    createName,
    value,
    form.getByRole("button", { name: "Show value" }),
  ]) {
    const description = await accessibleDescription(control);
    assert.ok(description.endsWith(SECRET_CREATE_MEMBER_DENIED), description);
    assert.equal(description.includes(canary), false);
    assert.equal(description.includes(inventedAdvice), false);
    assert.equal(await control.isDisabled(), true);
    await expectReachableReason(page, control, description);
  }
  await submitCreate.focus();
  await page.keyboard.press("Enter");
  await submitCreate.click({ force: true });
  assert.equal(pathRequests(postRequests, "POST", secretPath(namespace)).length, 1);
  await closeCreate.click();
  await page.unroute(requestMask, interceptCreate);

  await page.reload();
  await createSecret.click();
  await form.getByLabel("Secret name").fill("Reader cannot create this");
  await value.fill("synthetic-denied-create");
  await expectDenied("Create Secret", "POST", "create");
  await expectReachableReason(
    page,
    createSecret,
    `${SECRET_CREATE_MEMBER_DENIED} Then select Refresh.`,
  );

  async function openAction(name: string) {
    await page.getByRole("button", { name: secret.name, exact: true }).click();
    await dialog(page, secret.name).getByRole("button", { name, exact: true }).click();
  }
  // A dialog whose answer predates a revocation still offers both writes; the API refuses each.
  const secretUrl = `**${secretPath(namespace)}/${secret.id}`;
  await page.route(secretUrl, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillPatchedJson(route, SecretDetailResponse, (body) => ({
      ...body,
      data: { ...body.data, callerPermissions: { update: true, delete: true } },
    }));
  });
  // A fresh page: a refused replace concerns only this Secret, so Create Secret stays available.
  await page.reload();
  await openAction("Replace value");
  await value.fill("synthetic-denied-replacement");
  await expectDenied("Replace value", "PATCH", "update");
  assert.equal(await createSecret.getAttribute("aria-disabled"), null);
  await openAction("Delete Secret");
  await expectDenied("Permanently delete Secret", "DELETE", "delete");
  await page.unroute(secretUrl);

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
  const blockedDelete = responseTo(
    page,
    "DELETE",
    `${fixture.origin}${secretPath(namespace)}/${secret.id}`,
  );
  await dialog(page, "Delete Secret")
    .getByRole("button", { name: "Permanently delete Secret", exact: true })
    .click();
  // The API's 409 names the reference the recheck found (finding 2538).
  assert.equal((await blockedDelete).status(), 409);
  await dialog(page, "Delete Secret")
    .getByText(
      /^Could not delete this Secret\. The Secret is still referenced by Agent agt_\S+\. Remove those references first\. Close and reopen the Secret to inspect its current consumers\.$/,
    )
    .waitFor();
  assert.equal((await fixture.request("GET", `${secretPath(namespace)}/${secret.id}`)).status, 200);
});

test("a Secret name conflict allows correction, but a Namespace that stops being ready ends create and replacement", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(
    t,
    "Changing Secret availability",
  );
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
  const duplicate = responseTo(page, "POST", fixture.origin + path);
  await create.getByRole("button", { name: "Create Secret", exact: true }).click();
  const conflict = await duplicate;
  assert.equal(conflict.status(), 409);
  const { error }: ErrorResponse = await conflict.json();
  assert.equal(error.code, "RESOURCE_CONFLICT");
  // The API's sentence names the rule, so the page shows it instead of guessing (finding 2559).
  await create
    .getByRole("alert")
    .filter({ hasText: `The value was not saved. ${SECRET_NAME_CONFLICT} Enter the value again.` })
    .waitFor();
  assert.equal(await create.getByText(/name may already be in use/).count(), 0);
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
    const refused = responseTo(form.page(), method, fixture.origin + url);
    await submit.click();
    const response = await refused;
    assert.equal(response.status(), 409);
    const { error }: ErrorResponse = await response.json();
    assert.equal(error.code, "NAMESPACE_NOT_READY");
    // Both writes were refused because the Namespace changed, not because the name is taken.
    await form.getByRole("alert").filter({ hasText: CONSOLE_NAMESPACE_NOT_READY }).waitFor();
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
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Secret refusal meanings");
  const secret = await fixture.createSecret(namespace.id, "Listed Secret", "synthetic-listed");
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  // The Secret API never answers 429: that refusal comes from a rate limit in front of it (an
  // ingress or proxy), so it is the proxy's page with no API envelope. The 404 is the API's own.
  const refusals = [
    { ...proxyErrorResponse(429), headers: { "retry-after": "30" } },
    { ...proxyErrorResponse(429), headers: { "retry-after": "600" } },
    apiErrorResponse(404, "NOT_FOUND", RESOURCE_NOT_FOUND),
  ];
  await page.route(`${fixture.origin}${secretPath(namespace)}`, (route) => {
    const refusal = route.request().method() === "POST" ? refusals.shift() : undefined;
    return refusal ? route.fulfill(refusal) : route.fallback();
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
    // A rate limit is not an input problem: it says how long the proxy asked to wait.
    .filter({ hasText: `The value was not saved. ${tooManyRequestsIn(30)} Enter the value again.` })
    .waitFor();
  assert.equal(await value.inputValue(), "");
  assert.equal(await value.isDisabled(), false, "a 429 allows another try");
  assert.equal(await submit.isDisabled(), false);
  // A long wait reads in minutes.
  await value.fill("synthetic-rate-limited-longer");
  await submit.click();
  await create
    .getByRole("alert")
    .filter({
      hasText:
        "The value was not saved. Too many requests. Try again in about 10 minutes. Enter the value again.",
    })
    .waitFor();
  assert.equal(tooManyRequestsIn(600), "Too many requests. Try again in about 10 minutes.");
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
  assert.equal(pathRequests(requests, "POST", secretPath(namespace)).length, 3);
  await create.getByRole("button", { name: "Close" }).click();

  // A truncated consumer list names no consumer, yet more references exist than it shows.
  await page.route(
    `${fixture.origin}${secretPath(namespace)}/${secret.id}`,
    (route) =>
      fulfillPatchedJson(route, SecretDetailResponse, (body) => {
        body.data.consumers = { ...body.data.consumers, truncated: true };
        return body;
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: secret.name, exact: true }).click();
  const detail = dialog(page, secret.name);
  await detail.getByText(/This consumer list is incomplete/).waitFor();
  await detail.getByText(SECRET_REFERENCED, { exact: true }).waitFor();
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
  // The dialog shows no reason for it, so Replace value is natively disabled, out of the Tab order.
  assert.equal(
    await unready
      .getByRole("button", { name: "Replace value", exact: true })
      .evaluate((node: HTMLButtonElement) => node.disabled),
    true,
  );
});

test("pending Secret creation blocks navigation and replay, then session loss clears material", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Pending writes");
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByRole("link", { name: "Credentials", exact: true }).click();
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
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Reload writes");
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
    settled: () => create.getByText(SECRET_NAME_CONFLICT, { exact: false }).waitFor(),
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
