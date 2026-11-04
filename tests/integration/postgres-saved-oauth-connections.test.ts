import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { PluginDriver } from "@openclaw-enterprise/contracts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { OAuthConnectionTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { refreshPinnedOAuthGrant } from "../../apps/controller/src/drivers/credential-refresh/oauth-token-endpoint.ts";
import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import { NativeIAMDriver, validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import { PostgresHumanAuthentication } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { keycloakRealmAdmin } from "../helpers/ci-keycloak-realm.mjs";
import { selectTemplateDrivers } from "../helpers/connection-template-drivers.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const issuer = process.env.OCC_TEST_KEYCLOAK_ISSUER;
const tokenOrigin = process.env.OCC_TEST_KEYCLOAK_TOKEN_ORIGIN;
const secretsFile = process.env.OCC_TEST_KEYCLOAK_SECRETS_FILE;
const publicOrigin = "https://occ-connections.test";
const redirectUri = `${publicOrigin}/oauth/callback`;

async function consentRedirect(authorizationUrl: string, password: string) {
  const login = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(login.status, 200);
  const form = (await login.text()).match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/);
  assert.ok(form?.[1], "Keycloak shows its login form");
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const accepted = await fetch(form[1].replaceAll("&amp;", "&"), {
    method: "POST",
    redirect: "manual",
    headers: { cookie },
    body: new URLSearchParams({ username: "alice", password, credentialId: "" }),
  });
  assert.equal(accepted.status, 302);
  const callback = new URL(accepted.headers.get("location")!);
  assert.equal(callback.origin + callback.pathname, redirectUri);
  return callback.pathname + callback.search;
}

async function accountSession(
  app: Awaited<ReturnType<typeof createPostgresAgentApp>>["app"],
  email: string,
  password: string,
) {
  const session = await signInToControllerApp(
    app,
    { email, password },
    { origin: "http://127.0.0.1" },
  );
  return (
    method: "GET" | "POST" | "DELETE" | "PATCH",
    url: string,
    body?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url,
      headers: { host: "127.0.0.1", ...authenticatedHeaders(session) },
      ...(body === undefined ? {} : { payload: body }),
    });
}

const lane = {
  skip:
    requiresPostgres.skip ||
    (!(issuer && tokenOrigin && secretsFile) && "Prepare the keycloak-oidc CI lane."),
};
async function oauthAccounts(t: TestContext) {
  assert.ok(issuer && tokenOrigin && secretsFile);
  const secrets = JSON.parse(await readFile(secretsFile, "utf8"));
  const clientId = `oce-saved-${randomUUID()}`;
  const clientSecret = randomUUID();
  await keycloakRealmAdmin(issuer, secrets.admin, "POST", "/clients", {
    clientId,
    secret: clientSecret,
    enabled: true,
    publicClient: false,
    standardFlowEnabled: true,
    defaultClientScopes: [],
    directAccessGrantsEnabled: false,
    redirectUris: [redirectUri],
    attributes: { "pkce.code.challenge.method": "S256" },
  });
  t.after(async () => {
    const [client] = await keycloakRealmAdmin(
      issuer,
      secrets.admin,
      "GET",
      `/clients?clientId=${clientId}`,
    );
    if (client) {
      await keycloakRealmAdmin(issuer, secrets.admin, "DELETE", `/clients/${client.id}`);
    }
  });

  // The real Token Service and OpenShell Drivers run against recording Secret/OpenShell stores.
  // Only Keycloak issues and validates access tokens.
  const secretDriver = { ...createTestSecretDriver(), capability: "secret" as const };
  const preparedTokens = new TokenService(
    new OAuthConnectionTokens(secretDriver, refreshPinnedOAuthGrant),
  );
  let skew = 0;
  const { app, controller, state, principal, computeDriver, inject, pool, adminAccount } =
    await createPostgresAgentApp(t, {
      label: "saved-account",
      authSecret: "saved-account-test-auth-secret-minimum-32-bytes",
      secretDriver,
      controllerOptions: { preparedTokens, now: () => new Date(Date.now() + skew) },
      appOptions: {
        publicOrigin,
        provisionAuthAccount: (...args: Parameters<typeof provision>) => provision(...args),
      },
    });
  const auth = new PostgresHumanAuthentication(
    state,
    controller.installation.id,
    betterAuthIssuer(controller.installation.id),
  );
  const provision: NonNullable<ControllerAppOptions["provisionAuthAccount"]> = async (
    seed,
    audit,
    prepared,
    external,
  ) => {
    validateAuthAccountPrincipalSeed(
      seed,
      await state.loadNativeIAMState(controller.installation.id),
      controller.installation.id,
    );
    await auth.provisionPasswordAccount(prepared, seed, audit, external);
  };
  Object.assign(computeDriver, {
    resolveSandboxNamespace: async (namespace: { id: string }) => ({
      ...namespace,
      name: `oce-${namespace.id.slice(3, 11)}`,
    }),
  });
  const { providers } = selectTemplateDrivers(controller);
  const makeNamespace = async () => {
    const result = await inject("POST", "/namespaces", { name: `Accounts ${randomUUID()}` });
    assert.equal(result.statusCode, 201, result.body);
    const id: string = result.json().data.id;
    await controller.handleNamespaceLifecycle(principal.id, id, "ready");
    return id;
  };
  const namespaceId = await makeNamespace();
  const base = `/namespaces/${namespaceId}`;
  const connections = `${base}/connections`;
  const template = await inject("POST", "/connection-templates", {
    displayName: "Keycloak",
    namespaceId,
    clientId,
    clientSecret,
    issuer,
    authorizationUrl: `${issuer}/protocol/openid-connect/auth`,
    tokenUrl: `${tokenOrigin}/realms/oce/protocol/openid-connect/token`,
    scopes: ["openid"],
    envVar: "CONNECTION_TOKEN",
    endpoint: { host: "api.connections.test", port: 443, path: "/**" },
  });
  assert.equal(template.statusCode, 201, template.body);
  const input = { connectionTemplateId: template.json().data.id };
  const ownerId = principal.id;
  const owner = await accountSession(app, adminAccount.email, adminAccount.password);
  async function begin(path = connections, body: Record<string, unknown> = input) {
    const response = await owner("POST", path, body);
    assert.equal(response.statusCode, 201, response.body);
    return {
      id: response.json().data.credentialSourceId as string,
      callback: await consentRedirect(
        response.json().data.authorizationUrl,
        secrets.users.alice.password,
      ),
    };
  }
  return {
    app,
    controller,
    state,
    principal,
    pool,
    adminAccount,
    inject,
    providers,
    makeNamespace,
    secretDriver,
    namespaceId,
    base,
    connections,
    input,
    owner,
    ownerId,
    begin,
    advanceRegistrationFence() {
      skew = 120_000;
    },
  };
}

test(
  "OAuth consent saves the account for its owner and refreshes it through the Token Service",
  lane,
  async (t) => {
    const {
      app,
      state,
      controller,
      pool,
      adminAccount,
      inject,
      providers,
      makeNamespace,
      secretDriver,
      namespaceId,
      base,
      connections,
      input,
      owner,
      ownerId,
      begin,
      advanceRegistrationFence,
    } = await oauthAccounts(t);
    const otherId = await makeNamespace();
    // Even an Installation administrator cannot use a Namespace-scoped template elsewhere.
    const wrongScope = await inject("POST", `/namespaces/${otherId}/connections`, input);
    assert.equal(wrongScope.statusCode, 404, wrongScope.body);

    // Native IAM currently grants resource creation to the Installation administrator.
    // A separately enrolled Namespace reader can browse the Namespace without accessing its accounts.
    const email = `reader-${randomUUID()}@example.test`;
    const password = randomUUID();
    const human = await inject("POST", "/api/auth/accounts", { name: "Reader", email, password });
    assert.equal(human.statusCode, 201, human.body);
    const reader = await accountSession(app, email, password);
    const role = await inject("POST", `${base}/iam/roles`, {
      name: "Namespace reader",
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    assert.equal(role.statusCode, 201, role.body);
    const binding = await inject("POST", `${base}/iam/access-bindings`, {
      roleId: role.json().data.id,
      subjectKind: "identity",
      subjectId: human.json().data.principalId,
      resourceKind: "namespace",
      resourceId: namespaceId,
    });
    assert.equal(binding.statusCode, 201, binding.body);
    assert.equal((await reader("POST", connections, input)).statusCode, 403);
    const secondSession = await accountSession(app, adminAccount.email, adminAccount.password);
    const visible = await owner("GET", `${base}/connection-templates`);
    assert.equal(visible.statusCode, 200, visible.body);
    assert.ok(
      visible.json().data.some((value: { id: string }) => value.id === input.connectionTemplateId),
    );
    // The same user in a second browser cannot spend the first browser's state or code.
    const { id, callback } = await begin();
    const stolen = await secondSession("GET", callback);
    assert.match(String(stolen.headers.location), /reason=unknown_session/);
    const completed = await owner("GET", callback);
    assert.equal(completed.statusCode, 303, completed.body);
    assert.match(String(completed.headers.location), /connection=connected/);
    assert.match(String((await owner("GET", callback)).headers.location), /reason=unknown_session/);
    const accounts = await owner("GET", connections);
    assert.equal(accounts.statusCode, 200, accounts.body);
    assert.deepEqual(
      accounts
        .json()
        .data.map((value: { credentialSourceId: string; ownerPrincipalId: string }) => [
          value.credentialSourceId,
          value.ownerPrincipalId,
        ]),
      [[id, ownerId]],
    );
    const policy = await state.loadNativeIAMState(controller.installation.id);
    const exactOwnerGrant = policy.bindings.find(
      (grant) =>
        grant.namespaceId === namespaceId &&
        grant.subjectId === ownerId &&
        grant.resourceKind === "credential_source" &&
        grant.resourceId === id,
    );
    assert.ok(exactOwnerGrant);
    assert.deepEqual(
      policy.roles.find((entry) => entry.id === exactOwnerGrant.roleId)?.permissions,
      [
        { resourceKind: "credential_source", action: "read" },
        { resourceKind: "credential_source", action: "operate" },
      ],
    );
    const source = `${base}/credential-sources/${id}`;
    assert.equal((await owner("GET", source)).statusCode, 200);
    const readerAccounts = await reader("GET", connections);
    assert.equal(readerAccounts.statusCode, 200, readerAccounts.body);
    assert.deepEqual(readerAccounts.json().data, []);
    assert.equal((await reader("GET", source)).statusCode, 403);
    assert.equal((await reader("DELETE", `${connections}/${id}`)).statusCode, 403);
    const custody = await pool.query(
      "SELECT secret_ref FROM occ.connection_token_custody WHERE namespace_id=$1 AND credential_source_id=$2",
      [namespaceId, id],
    );
    assert.equal(custody.rowCount, 1);
    const privateRef = custody.rows[0].secret_ref;
    assert.ok(secretDriver.has(privateRef));
    const sender = [...providers.values()].find((value) => value.name.startsWith("oce-cs-"));
    assert.ok(sender);
    assert.deepEqual(Object.keys(sender.credentials), ["CONNECTION_TOKEN"]);
    const subject = async (bearer: string) => {
      const result = await fetch(`${issuer}/protocol/openid-connect/userinfo`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      assert.equal(result.status, 200, "Keycloak accepts the sender's prepared access token");
      return (await result.json()).sub;
    };
    const original = sender.credentials.CONNECTION_TOKEN;
    const alice = await subject(original);
    assert.ok(alice);
    const rotated = await inject("POST", `${source}/rotate`, undefined);
    assert.equal(rotated.statusCode, 200, rotated.body);
    const renewed = sender.credentials.CONNECTION_TOKEN;
    assert.equal(renewed !== original, true);
    assert.equal(await subject(renewed), alice);
    // Advancing OCC's clock clears the credential registration fence without delaying the test.
    advanceRegistrationFence();
    assert.equal((await owner("DELETE", `${connections}/${id}`)).statusCode, 204);
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM occ.connection_token_custody WHERE credential_source_id=$1",
          [id],
        )
      ).rowCount,
      0,
    );
    assert.equal(secretDriver.has(privateRef), false);
    assert.equal(
      [...providers.values()].some((entry) => entry.name === sender.name),
      false,
    );
  },
);

test(
  "Plugin consent attaches its saved account only while the Agent still permits the requested binding",
  lane,
  async (t) => {
    const { controller, state, namespaceId, base, connections, input, pool, owner, begin } =
      await oauthAccounts(t);
    const pluginId = "test-keycloak";
    const slotId = "account";
    const releaseSha256 = "a".repeat(64);
    // The selected test plugin describes the fixture issuer. OCC handles the real intent,
    // callback, grant and draft. The managed Google release has separate Driver conformance.
    const plugin: PluginDriver = {
      id: "keycloak-plugin-driver",
      capability: "plugin",
      implementation: "keycloak-fixture",
      policyCapabilities: new OCCPluginDriver().policyCapabilities,
      validatePolicies() {},
      async listCatalog() {
        return [];
      },
      credentials: {
        choices() {
          return [];
        },
        validate() {},
        connectionSlot(selections, requestedPlugin, requestedSlot) {
          const selected = selections[requestedPlugin];
          if (requestedPlugin !== pluginId || requestedSlot !== slotId || !selected?.enabled) {
            return undefined;
          }
          const bound = selected.driverPolicy?.credentials as { account?: string } | undefined;
          return {
            releaseSha256,
            credentialSourceId: bound?.account ?? null,
            acceptsTemplate(version) {
              return version.issuer === issuer && version.envVar === "CONNECTION_TOKEN";
            },
            bind(source) {
              return {
                ...selected,
                driverPolicy: { releaseSha256, credentials: { account: source.id } },
              };
            },
          };
        },
      },
    };
    controller.registerDriver(plugin);
    controller.selectDriver("plugin", plugin.id);
    const config = await owner("POST", `${base}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-5.1"),
    });
    assert.equal(config.statusCode, 201, config.body);
    const agents = `${base}/agents`;
    const agent = async (name: string) => {
      const created = await owner("POST", agents, {
        name,
        configurationId: config.json().data.id,
        plugins: { [pluginId]: { enabled: true } },
      });
      assert.equal(created.statusCode, 201, created.body);
      return created.json().data.id as string;
    };
    const a = await agent("Primary");
    const b = await agent("Second");
    const path = (id: string) => `${agents}/${id}`;
    const draft = async (id: string) => {
      const response = await owner("GET", path(id));
      assert.equal(response.statusCode, 200, response.body);
      return response.json().data;
    };
    const attached = async (id: string) =>
      (await draft(id)).credentialSources?.map((ref: { sourceId: string }) => ref.sourceId) ?? [];
    const authority = new NativeIAMDriver(state);
    const canUse = async (agentId: string, sourceId: string) => {
      const agent = await state.read((view) => view.agents.findAgent(namespaceId, agentId));
      assert.ok(agent);
      return (
        await authority.authorize({
          principalId: agent.servicePrincipalId,
          action: "operate",
          resource: { kind: "credential_source", namespaceId, id: sourceId },
        })
      ).allowed;
    };
    const grant = await begin();
    assert.equal((await owner("GET", grant.callback)).statusCode, 303);
    assert.deepEqual(await attached(a), []);
    assert.deepEqual(await attached(b), []);
    const scoped = await owner(
      "GET",
      `${path(a)}/plugins/${pluginId}/credentials/${slotId}/connection-templates`,
    );
    assert.equal(scoped.statusCode, 200, scoped.body);
    assert.deepEqual(
      scoped.json().data.map((row: { id: string }) => row.id),
      [input.connectionTemplateId],
    );
    const pluginConsent = (expected: string | null) =>
      begin(`${path(a)}/connections`, {
        ...input,
        connectionTemplateVersion: 1,
        pluginId,
        slotId,
        releaseSha256,
        expectedCredentialSourceId: expected,
      });
    const first = await pluginConsent(null);
    const competing = await pluginConsent(null);
    async function finish(callback: string, outcome: "attached" | "saved") {
      const response = await owner("GET", callback);
      assert.equal(response.statusCode, 303, response.body);
      const location = new URL(String(response.headers.location), publicOrigin);
      assert.equal(location.pathname, `/console/agents/${a}`);
      assert.equal(location.searchParams.get("connection"), outcome);
    }
    await finish(first.callback, "attached");
    assert.deepEqual(await attached(a), [first.id]);
    assert.equal(await canUse(a, first.id), true);
    await finish(competing.callback, "saved");
    assert.equal(await canUse(a, competing.id), false);
    assert.equal((await draft(a)).plugins[pluginId].driverPolicy.credentials.account, first.id);
    assert.deepEqual(await attached(a), [first.id]);
    // The native IAM authority adds an exact Agent restriction while Keycloak consent is open.
    // The valid account remains the user's even though changing this Agent now fails.
    const denied = await pluginConsent(first.id);
    const restrictionId = `restriction_${randomUUID()}`;
    await pool.query(
      "INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id) VALUES ($1,$2,'update','agent',$3)",
      [restrictionId, namespaceId, a],
    );
    const verifyRefusal = await owner("POST", `${path(a)}/connections/${grant.id}`);
    assert.equal(verifyRefusal.statusCode, 403, verifyRefusal.body);
    await finish(denied.callback, "saved");
    assert.equal(await canUse(a, denied.id), false);
    assert.deepEqual(await attached(a), [first.id]);
    assert.equal((await draft(a)).plugins[pluginId].driverPolicy.credentials.account, first.id);
    const accounts = await owner("GET", connections);
    assert.equal(accounts.statusCode, 200, accounts.body);
    assert.deepEqual(
      accounts
        .json()
        .data.map((row: { credentialSourceId: string }) => row.credentialSourceId)
        .sort(),
      [grant.id, first.id, competing.id, denied.id].sort(),
    );
    // The restriction on A stays in force. Two independently authorized Agents share the
    // standalone account. Detaching from C leaves B's operate decision and the account intact.
    const c = await agent("Third");
    for (const target of [b, c]) {
      const updated = await owner("POST", `${path(target)}/connections/${grant.id}`);
      assert.equal(updated.statusCode, 204, updated.body);
    }
    const detached = await owner("DELETE", `${path(c)}/connections/${grant.id}`);
    assert.equal(detached.statusCode, 200, detached.body);
    assert.deepEqual(await attached(c), []);
    assert.deepEqual(await attached(b), [grant.id]);
    assert.equal(await canUse(c, grant.id), false);
    assert.equal(await canUse(b, grant.id), true);
    const stillSaved = await owner("GET", connections);
    assert.ok(
      stillSaved
        .json()
        .data.some((row: { credentialSourceId: string }) => row.credentialSourceId === grant.id),
    );
  },
);
