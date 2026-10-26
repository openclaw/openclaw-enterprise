import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { newPage, nativeValues } from "./console-agents-browser-helpers.mjs";
import { nativeAdminComputeDriver, nativeAdminValues } from "./console-agents-test-support.mjs";

// One Installation with two Agents in one Namespace: Product Claw serves a native admin UI and
// Research Claw has never been deployed. Discovery, sessions and IAM run through the real
// Fastify app, Better Auth, controller and native IAM; only the native gateway's document is a
// stand-in.
async function setup(t) {
  const fixture = await createConsoleAppFixture(t, {
    originHost: "console.oce.example.test",
    publicOrigin: true,
    authCookieDomain: "oce.example.test",
    development: { enabled: false },
    https: true,
    authSecureCookies: true,
    nativeAdmin: {
      enabled: true,
      domain: "agents.oce.example.test",
      sharedCookieDomain: "oce.example.test",
    },
    nativeAdminGatewayApiKey: async () => "fixture-native-key",
    computeDriver: nativeAdminComputeDriver("wss://private-gateway.example.invalid/shared"),
  });
  const installation = await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Product", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Product Claw", nativeValues("launcher"));
  const initialRevision = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`;
  const initial = await fixture.request("GET", path);
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeAdminValues("launcher", initial.data.origin),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id, initialRevision.revision.id);
  const access = (await fixture.request("GET", path)).data;
  assert.equal(access.status, "available");
  const other = await fixture.createAgent(namespace.id, "Research Claw", nativeValues("other"));
  const { page } = await newPage(t, fixture, {
    args: [
      ...fixture.browserArgs,
      "--host-resolver-rules=MAP console.oce.example.test 127.0.0.1,MAP *.agents.oce.example.test 127.0.0.1",
    ],
  });
  await page
    .context()
    .route(`${access.origin}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Native workspace reached</h1>" }),
    );
  // An account whose grants are [resourceKind, resourceId, actions] bindings in this Namespace.
  async function person(label, grants = []) {
    return fixture.createAccountWithPolicy(label, (principal) => {
      for (const [resourceKind, resourceId, actions] of grants) {
        const id = randomUUID();
        fixture.policy.roles.push({
          id,
          namespaceId: namespace.id,
          permissions: actions.map((action) => ({ action, resourceKind })),
        });
        fixture.policy.bindings.push({
          id,
          namespaceId: namespace.id,
          subjectKind: "identity",
          subjectId: principal.id,
          roleId: id,
          resourceKind,
          resourceId,
        });
      }
    });
  }
  return {
    fixture,
    installation,
    namespace,
    agent,
    other,
    access,
    path,
    page,
    person,
    namespaceGrant: ["namespace", namespace.id, ["read"]],
    agentGrant: ["agent", agent.id, ["read", "administer"]],
  };
}

async function signIn(page, credentials) {
  await page.getByLabel("Email", { exact: true }).fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function login(page, fixture, credentials, path = "/console/launch") {
  await page.goto(`${fixture.origin}${path}`);
  await signIn(page, credentials);
}

test("launcher opens the only authorized Claw after sign-in, and chooser mode never redirects", async (t) => {
  const s = await setup(t);
  const owner = await s.person("workspace-owner", [s.namespaceGrant, s.agentGrant]);
  await login(s.page, s.fixture, owner.credentials);
  await s.page.getByRole("heading", { name: "Native workspace reached" }).waitFor();
  assert.equal(new URL(s.page.url()).origin, s.access.origin);
  await s.page.goto(`${s.fixture.origin}/console/launch?choose=1`);
  await s.page.getByRole("link", { name: "Open Claw" }).waitFor();
  assert.equal(await s.page.locator(".launcher-destination").count(), 1);
  assert.equal(await s.page.getByText("Research Claw").count(), 0);
  assert.equal(await s.page.getByText("Fleet administration", { exact: true }).count(), 0);
  assert.equal(
    await s.page.getByRole("link", { name: "Open Claw" }).getAttribute("href"),
    s.access.url,
  );
  await s.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await s.page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
    true,
  );
  // A console deep link is not redirected, and its account menu opens chooser-only mode.
  await s.page.setViewportSize({ width: 1100, height: 800 });
  await s.page.goto(`${s.fixture.origin}/console/agents?namespace=${s.namespace.id}`);
  await s.page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
  await s.page.locator(".sidebar .account-toggle").click();
  await s.page.getByRole("menuitem", { name: "Switch destination" }).click();
  await s.page.getByRole("link", { name: "Open Claw" }).waitFor();
  assert.equal(new URL(s.page.url()).searchParams.get("choose"), "1");
  await s.page.getByRole("button", { name: "Sign out" }).click();
  await s.page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await s.page.getByText("Product Claw", { exact: true }).count(), 0);
  // Signing back in from the sign-out screen has no destination. It rediscovers this
  // account's destination instead of falling into administration.
  assert.equal(new URL(s.page.url()).pathname, "/console/login");
  assert.equal(new URL(s.page.url()).search, "");
  await signIn(s.page, owner.credentials);
  await s.page.getByRole("heading", { name: "Native workspace reached" }).waitFor();
  assert.equal(new URL(s.page.url()).origin, s.access.origin);
  // An authenticated visit to the bare sign-in page uses the same default.
  await s.page.goto(`${s.fixture.origin}/console/login`);
  await s.page.getByRole("heading", { name: "Native workspace reached" }).waitFor();
  assert.equal(new URL(s.page.url()).origin, s.access.origin);
});

test("launcher counts unavailable destinations and rechecks revoked Agent administration", async (t) => {
  const s = await setup(t);
  const owner = await s.person("two-workspaces", [
    s.namespaceGrant,
    s.agentGrant,
    ["agent", s.other.id, ["read", "administer"]],
  ]);
  await login(s.page, s.fixture, owner.credentials);
  await s.page.getByRole("heading", { name: "Research Claw" }).waitFor();
  assert.equal(await s.page.locator(".launcher-destination").count(), 2);
  assert.equal(await s.page.getByRole("link", { name: "Open Claw" }).count(), 1);
  assert.match(
    await s.page.getByRole("article").filter({ hasText: "Research Claw" }).innerText(),
    /Stopped/,
  );
  // Read access stays; without administer a readable Agent is no destination, and the
  // launcher learns that from the advisory answer without an audited native-admin denial.
  s.fixture.policy.restrictions.push({
    id: "deny-product-administer",
    namespaceId: s.namespace.id,
    resourceKind: "agent",
    resourceId: s.agent.id,
    action: "administer",
    effect: "deny",
  });
  const nativeReads = [];
  s.page.on("request", (request) => {
    if (new URL(request.url()).pathname === s.path) {
      nativeReads.push(request.url());
    }
  });
  await s.page.getByRole("button", { name: "Refresh availability" }).click();
  await s.page.getByRole("heading", { name: "Your workspace is unavailable" }).waitFor();
  assert.equal(await s.page.getByText("Product Claw", { exact: true }).count(), 0);
  assert.deepEqual(nativeReads, []);
});

test("launcher never mistakes partial discovery or an unknown administration answer for a complete list", async (t) => {
  const s = await setup(t);
  const owner = await s.person("workspace-owner", [s.namespaceGrant, s.agentGrant]);
  const failure = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "DEPENDENCY_UNAVAILABLE" }, meta: {} }),
    });
  const permissions = `${s.fixture.origin}/namespaces/${s.namespace.id}/permissions`;
  await s.page.route(permissions, failure);
  await login(s.page, s.fixture, owner.credentials);
  await s.page.getByRole("heading", { name: "We couldn’t load your workspaces" }).waitFor();
  assert.equal(await s.page.getByText("No access assigned").count(), 0);
  await s.page.unroute(permissions, failure);
  await s.page.route(`${s.fixture.origin}${s.path}`, failure);
  await s.page.getByRole("button", { name: "Try again" }).click();
  await s.page.getByRole("heading", { name: "We couldn’t load your workspaces" }).waitFor();
  assert.equal(new URL(s.page.url()).pathname, "/console/launch");
  await s.page.unroute(`${s.fixture.origin}${s.path}`, failure);
  await s.page.getByRole("button", { name: "Try again" }).click();
  await s.page.getByRole("heading", { name: "Native workspace reached" }).waitFor();
});

test("launcher shows no access intentionally and ignores a return URL on the sign-in page", async (t) => {
  const s = await setup(t);
  const empty = await s.person("Unassigned");
  await login(s.page, s.fixture, empty.credentials);
  await s.page.getByRole("heading", { name: "No access assigned" }).waitFor();
  assert.equal(await s.page.getByText("Product Claw", { exact: true }).count(), 0);
  await s.page.getByRole("button", { name: "Check again" }).click();
  await s.page.getByRole("heading", { name: "No access assigned" }).waitFor();
  await s.page.getByRole("button", { name: "Sign out" }).click();
  await s.page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await login(
    s.page,
    s.fixture,
    empty.credentials,
    "/console/login?return=" + encodeURIComponent("//attacker.example.test/console/launch"),
  );
  await s.page.getByRole("heading", { name: "No access assigned" }).waitFor();
  assert.equal(new URL(s.page.url()).origin, s.fixture.origin);
});

test("launcher checks Installation administration separately from Agent permissions", async (t) => {
  const s = await setup(t);
  await login(s.page, s.fixture, s.fixture.credentials);
  await s.page.getByRole("heading", { name: "Fleet administration" }).waitFor();
  assert.equal(await s.page.locator(".launcher-destination").count(), 3);
  // Installation administration alone grants no Claw, but administration remains available
  // and, as the only destination, opens.
  const role = randomUUID();
  const operator = await s.fixture.createAccountWithPolicy("installation-operator", (principal) => {
    s.fixture.policy.roles.push({
      id: role,
      permissions: [{ action: "administer", resourceKind: "installation" }],
    });
    s.fixture.policy.bindings.push({
      id: role,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: role,
      resourceKind: "installation",
      resourceId: s.installation.id,
    });
  });
  await s.page.getByRole("button", { name: "Sign out" }).click();
  await s.page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await signIn(s.page, operator.credentials);
  await s.page.waitForURL(/\/console\/namespaces/);
  await s.page.goto(`${s.fixture.origin}/console/launch?choose=1`);
  await s.page.getByRole("link", { name: "Open administration" }).waitFor();
  assert.equal(await s.page.locator(".launcher-destination").count(), 1);
});
