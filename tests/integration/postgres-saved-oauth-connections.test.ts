import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { OAuthConnectionTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { refreshPinnedOAuthGrant } from "../../apps/controller/src/drivers/credential-refresh/oauth-token-endpoint.ts";
import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import { validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
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
  return (method: "GET" | "POST" | "DELETE", url: string, body?: Record<string, unknown>) =>
    app.inject({
      method,
      url,
      headers: { host: "127.0.0.1", ...authenticatedHeaders(session) },
      ...(body === undefined ? {} : { payload: body }),
    });
}

test(
  "OAuth consent saves the account for its owner and refreshes it through the Token Service",
  {
    skip:
      requiresPostgres.skip ||
      (!(issuer && tokenOrigin && secretsFile) && "Prepare the keycloak-oidc CI lane."),
  },
  async (t) => {
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
    const otherId = await makeNamespace();
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
    const ownerId = principal.id;
    const owner = await accountSession(app, adminAccount.email, adminAccount.password);
    const secondSession = await accountSession(app, adminAccount.email, adminAccount.password);
    const visible = await owner("GET", `${base}/connection-templates`);
    assert.equal(visible.statusCode, 200, visible.body);
    assert.ok(
      visible.json().data.some((value: { id: string }) => value.id === input.connectionTemplateId),
    );
    async function begin() {
      const response = await owner("POST", connections, input);
      assert.equal(response.statusCode, 201, response.body);
      return {
        id: response.json().data.credentialSourceId as string,
        callback: await consentRedirect(
          response.json().data.authorizationUrl,
          secrets.users.alice.password,
        ),
      };
    }
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
    skew = 120_000;
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
