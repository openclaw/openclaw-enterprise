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
import { keycloakRealmAdmin, rotateKeycloakClientSecret } from "../helpers/ci-keycloak-realm.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
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
    method: "GET" | "POST" | "DELETE",
    url: string,
    body?: Record<string, unknown>,
    target = app,
  ) =>
    target.inject({
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
    // Keycloak issues real tokens for the saved accounts.
    const secretDriver = { ...createTestSecretDriver(), capability: "secret" as const };
    const preparedTokens = new TokenService(
      new OAuthConnectionTokens(secretDriver, refreshPinnedOAuthGrant),
    );
    const serverUrl = "https://api.connections.test/mcp";
    const tokenUrl = `${tokenOrigin}/realms/oce/protocol/openid-connect/token`;
    let skew = 0;
    const { app, controller, state, principal, computeDriver, inject, pool, adminAccount } =
      await createPostgresAgentApp(t, {
        label: "saved-account",
        authSecret: "saved-account-test-auth-secret-minimum-32-bytes",
        secretDriver,
        controllerOptions: { preparedTokens, now: () => new Date(Date.now() + skew) },
        appOptions: {
          // Discovery metadata is controlled; authorization, consent and token exchange reach Keycloak.
          discoverMcpAuthorization: async () => ({
            serverUrl,
            resource: serverUrl,
            issuers: [issuer],
            issuer,
            authorizationUrl: `${issuer}/protocol/openid-connect/auth`,
            tokenUrl,
            requestedScopes: ["openid"],
            resourceScopes: ["openid", "profile"],
            supportedScopes: ["openid", "profile"],
            tokenEndpointAuthMethods: ["client_secret_basic", "client_secret_post"],
          }),
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
    const { providers, refresh } = selectTemplateDrivers(controller, { selectGateway: false });
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
    const recipient = { host: "api.connections.test", port: 443, path: "/mcp" };
    const manualDestinations = [
      recipient,
      { host: "files.connections.test", port: 443, path: "/exports/**" },
    ];
    const manualConfig = {
      mode: "manual",
      issuer,
      authorizationUrl: `${issuer}/protocol/openid-connect/auth`,
      tokenUrl,
      destinations: manualDestinations,
      scopes: ["openid"],
    };
    const template = await inject("POST", "/connection-templates", {
      ...manualConfig,
      namespaceId,
      displayName: "Keycloak",
      revocationUrl: `${issuer}/protocol/openid-connect/revoke`,
    });
    assert.equal(template.statusCode, 201, template.body);
    const registered = await inject("POST", "/oauth-clients", {
      connectionTemplateId: template.json().data.id,
      connectionTemplateVersion: template.json().data.current.version,
      displayName: "Saved accounts",
      clientId,
      clientSecret,
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const oauthClientId = registered.json().data.id;
    const manual = { connectionTemplateId: template.json().data.id };
    // Registering the first client makes the current template ready for consent.
    const manualStart = await inject("POST", connections, manual);
    assert.equal(manualStart.statusCode, 201, manualStart.body);
    const mcpConfig = {
      displayName: "Scope selection",
      namespaceId,
      mode: "mcp_discovery",
      issuer,
      serverUrl,
      scopes: ["openid", "profile"],
      oauthClientId,
    };
    const mcp = await inject("POST", "/connection-templates", mcpConfig);
    assert.equal(mcp.statusCode, 201, mcp.body);
    const input = { connectionTemplateId: mcp.json().data.id, selectedScopes: ["openid"] };
    for (const selectedScopes of [undefined, ["profile"], ["openid", "other"]]) {
      const refused = await inject("POST", connections, {
        connectionTemplateId: input.connectionTemplateId,
        ...(selectedScopes && { selectedScopes }),
      });
      assert.equal(refused.statusCode, 400, refused.body);
    }
    // With no configured scope list, discovery suggests scopes and its challenge still requires openid.
    const unrestrictedMcp = await inject("POST", "/connection-templates", {
      ...mcpConfig,
      scopes: [],
      displayName: "Open MCP scope selection",
    });
    assert.equal(unrestrictedMcp.statusCode, 201, unrestrictedMcp.body);
    const unrestrictedId = unrestrictedMcp.json().data.id;
    assert.equal(
      (await inject("POST", connections, { connectionTemplateId: unrestrictedId })).statusCode,
      400,
    );
    const manyScopes = ["openid", ...Array.from({ length: 32 }, (_, i) => "custom." + i)];
    const freeStart = await inject("POST", connections, {
      connectionTemplateId: unrestrictedId,
      selectedScopes: manyScopes,
    });
    assert.equal(freeStart.statusCode, 201, freeStart.body);
    assert.equal(
      new URL(freeStart.json().data.authorizationUrl).searchParams.get("scope"),
      manyScopes.join(" "),
    );
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
    // Let Keycloak choose a default on this isolated registration. The account must record it
    // as a provider grant while preserving that the person did not request an explicit scope.
    const unrestrictedManual = await inject("POST", "/connection-templates", {
      ...manualConfig,
      namespaceId,
      oauthClientId,
      scopes: [],
      displayName: "Provider defaults",
    });
    assert.equal(unrestrictedManual.statusCode, 201, unrestrictedManual.body);
    const [keycloakClient] = await keycloakRealmAdmin(
      issuer,
      secrets.admin,
      "GET",
      "/clients?clientId=" + clientId,
    );
    const realmScopes = await keycloakRealmAdmin(issuer, secrets.admin, "GET", "/client-scopes");
    const profile = realmScopes.find((scope: { name: string }) => scope.name === "profile");
    assert.ok(profile);
    const defaultPath = "/clients/" + keycloakClient.id + "/default-client-scopes/" + profile.id;
    await keycloakRealmAdmin(issuer, secrets.admin, "PUT", defaultPath);
    const defaults = await owner("POST", connections, {
      connectionTemplateId: unrestrictedManual.json().data.id,
      selectedScopes: [],
    });
    assert.equal(defaults.statusCode, 201, defaults.body);
    const defaultsUrl = defaults.json().data.authorizationUrl;
    assert.equal(new URL(defaultsUrl).searchParams.has("scope"), false);
    assert.equal(new URL(defaultsUrl).searchParams.has("resource"), false);
    const defaultCallback = await owner(
      "GET",
      await consentRedirect(defaultsUrl, secrets.users.alice.password),
    );
    assert.match(String(defaultCallback.headers.location), /connection=connected/);
    const defaultsId = defaults.json().data.credentialSourceId;
    const defaultAccounts = await owner("GET", connections);
    const defaultAccount = defaultAccounts
      .json()
      .data.find(
        (account: { credentialSourceId: string }) => account.credentialSourceId === defaultsId,
      );
    assert.deepEqual(defaultAccount.requestedScopes, []);
    assert.deepEqual(defaultAccount.grantedScopes, ["profile"]);
    assert.deepEqual(defaultAccount.destinations, manualDestinations);
    // New destinations require new consent. The pinned version also rejects a forged wider receipt.
    const widened = [
      ...manualDestinations,
      { host: "other.connections.test", port: 443, path: "/**" },
    ];
    const updated = await inject(
      "PATCH",
      "/connection-templates/" + defaultAccount.connectionTemplateId,
      {
        ...manualConfig,
        oauthClientId,
        scopes: [],
        destinations: widened,
      },
    );
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(updated.json().data.current.destinations, widened);
    const savedAgain = await owner("GET", connections);
    assert.equal(savedAgain.statusCode, 200, savedAgain.body);
    const approved = savedAgain
      .json()
      .data.find((row: { credentialSourceId: string }) => row.credentialSourceId === defaultsId);
    assert.deepEqual(approved.destinations, manualDestinations);
    assert.ok(approved.connectionTemplateVersion < updated.json().data.current.version);
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.saved_connections
         SELECT (jsonb_populate_record(NULL::occ.saved_connections,
           to_jsonb(s) || jsonb_build_object('destinations', $2::jsonb))).*
         FROM occ.saved_connections s WHERE credential_source_id = $1`,
        [defaultsId, JSON.stringify(widened)],
      ),
      { code: "23514", message: /approved template version/ },
    );
    await keycloakRealmAdmin(issuer, secrets.admin, "DELETE", defaultPath);
    const disconnected = await owner("DELETE", connections + "/" + defaultsId);
    assert.equal(disconnected.statusCode, 204, disconnected.body);
    async function begin() {
      const response = await owner("POST", connections, input);
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(
        new URL(response.json().data.authorizationUrl).searchParams.get("scope"),
        "openid",
      );
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
    const account = accounts.json().data[0];
    assert.deepEqual(
      [
        account.oauthClientId,
        account.clientId,
        account.issuer,
        account.tokenUrl,
        account.destinations,
        account.requestedScopes,
        account.grantedScopes,
      ],
      [oauthClientId, clientId, issuer, tokenUrl, [recipient], ["openid"], ["openid"]],
    );
    // The trusted Token Service consumer can use the grant. Saving/rotating alone creates no sender.
    async function prepared() {
      const custody = await state.read((view) =>
        view.savedConnections.findTokenCustody(namespaceId, id),
      );
      assert.ok(custody);
      const token = await preparedTokens.oauthConnections!.warm(
        custody,
        new AbortController().signal,
      );
      assert.ok(token);
      return token.accessToken;
    }
    const hasSender = () =>
      [...providers.values()].some((provider) => provider.name.startsWith("oce-cs-"));
    assert.equal(hasSender(), false);
    const subject = async (bearer: string) => {
      const result = await fetch(`${issuer}/protocol/openid-connect/userinfo`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      assert.equal(
        result.status,
        200,
        "Keycloak accepts the Token Service's prepared access token",
      );
      return (await result.json()).sub;
    };
    const original = await prepared();
    const alice = await subject(original);
    assert.ok(alice);
    // Lose access to the operator's registration before dispatch. The scheduler must back off
    // without losing the user's grant, and the owner can retry as soon as access returns.
    const unavailable = t.mock.method(refresh, "readClientSecret", async () => {
      throw new Error("registration store unavailable");
    });
    assert.equal((await owner("POST", source + "/rotate")).statusCode, 503);
    unavailable.mock.restore();
    const unavailableStatus = (await owner("GET", source)).json().data.status.refresh;
    assert.deepEqual(
      [unavailableStatus.state, unavailableStatus.failureCode, unavailableStatus.recoveryAction],
      ["failed", "client_unavailable", "retry"],
    );
    const deferred = await pool.query(
      "SELECT next_refresh_at > now() AS deferred FROM occ.connection_token_custody WHERE namespace_id=$1 AND credential_source_id=$2",
      [namespaceId, id],
    );
    assert.equal(deferred.rows[0].deferred, true);
    assert.equal((await owner("POST", source + "/rotate")).statusCode, 200);
    assert.equal(await subject(await prepared()), alice);
    // The original grant must refresh after the provider and the OCE administrator rotate the client.
    const replacement = await rotateKeycloakClientSecret(
      issuer,
      secrets.admin,
      clientId,
      clientSecret,
      tokenUrl,
    );
    // A failed refresh during the rotation window requires an administrator, and the user retains the grant.
    const clientRefused = await owner("POST", source + "/rotate");
    assert.equal(clientRefused.statusCode, 503);
    const repair = await owner("GET", source);
    assert.equal(repair.statusCode, 200, repair.body);
    const clientFailure = repair.json().data.status.refresh;
    assert.deepEqual(
      [clientFailure.state, clientFailure.failureCode, clientFailure.recoveryAction],
      ["failed", "client_refused", "fix_configuration"],
    );
    const updatedClient = await inject("POST", `/oauth-clients/${oauthClientId}/rotate-secret`, {
      clientSecret: replacement,
    });
    assert.equal(updatedClient.statusCode, 200);
    assert.equal(updatedClient.json().data.id, oauthClientId);
    const rotated = await inject("POST", `${source}/rotate`, undefined);
    assert.equal(rotated.statusCode, 200, rotated.body);
    const renewed = await prepared();
    assert.equal(renewed !== original, true);
    assert.equal(await subject(renewed), alice);
    const afterRotation = await owner("GET", connections);
    assert.equal(afterRotation.statusCode, 200, afterRotation.body);
    assert.deepEqual(
      afterRotation
        .json()
        .data.map((saved: { credentialSourceId: string }) => saved.credentialSourceId),
      [id],
    );
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
    assert.equal(hasSender(), false);
    // A peer can revoke a browser session after its callback has already passed admission.
    const peer = await createPostgresAgentApp(t, {
      label: "saved-account",
      authSecret: "saved-account-test-auth-secret-minimum-32-bytes",
    });
    const waiting = await begin();
    const exchange = t.mock.method(refresh, "completeBrowserAuthorization");
    const lock = await pool.connect();
    let blocked;
    try {
      await lock.query("BEGIN");
      const held = await lock.query(
        "DELETE FROM occ.connection_sessions WHERE credential_source_id=$1 RETURNING pg_backend_pid() AS pid",
        [waiting.id],
      );
      blocked = owner("GET", waiting.callback);
      await waitForLockWaiter(
        pool,
        held.rows[0].pid,
        "OAuth callback waiting to consume its private attempt",
      );
      const signedOut = await owner("POST", "/api/auth/sign-out", {}, peer.app);
      assert.equal(signedOut.statusCode, 200, signedOut.body);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    const refused = await blocked;
    assert.match(String(refused.headers.location), /reason=session_required/);
    assert.equal(
      exchange.mock.callCount(),
      0,
      "the code must not reach the Refresh Driver after logout",
    );
  },
);
