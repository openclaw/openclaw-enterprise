import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import { validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import {
  DependencyUnavailableError,
  PostgresHumanAuthentication,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { keycloakRealmAdmin, rotateKeycloakClientSecret } from "../helpers/ci-keycloak-realm.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { createBackendFixture } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
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
      attributes: {
        "pkce.code.challenge.method": "S256",
        "exclude.issuer.from.auth.response": "true",
        "access.token.lifespan": "90",
      },
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

    // The API and Token Service use the fixture Secret store. Keycloak authenticates the
    // registration and issues actual tokens without OpenShell or a Credential Refresh Driver.
    const secretDriver = { ...createTestSecretDriver(), capability: "secret" as const };
    const preparedTokens = new TokenService();
    const serverUrl = "https://api.connections.test/mcp";
    let discoveredResource = serverUrl;
    const tokenUrl = `${tokenOrigin}/realms/oce/protocol/openid-connect/token`;
    const { app, controller, state, principal, inject, pool, adminAccount } =
      await createPostgresAgentApp(t, {
        label: "saved-account",
        poolOptions: { max: 1, connectionTimeoutMillis: 5000 },
        authSecret: "saved-account-test-auth-secret-minimum-32-bytes",
        secretDriver,
        controllerOptions: { preparedTokens },
        appOptions: {
          // Discovery metadata is controlled; authorization, consent and token exchange reach Keycloak.
          discoverMcpAuthorization: async (discoveredUrl: string) => ({
            serverUrl: discoveredUrl,
            resource: discoveredResource,
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
    const resolveClient = controller.resolveConnectionClient.bind(controller);
    preparedTokens.registerIssuer(new OAuthAccountTokens(state, secretDriver, resolveClient));
    // A second issuer must not take custody of grants assigned to the installed one.
    assert.throws(
      () =>
        preparedTokens.registerIssuer(
          new OAuthAccountTokens(state, createTestSecretDriver(), resolveClient),
        ),
      /already owns this registration/,
    );
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
    const manual = { connectionTemplateId: template.json().data.id };
    const listsManualTemplate = async (path: string) => {
      const result = await inject("GET", path);
      assert.equal(result.statusCode, 200, result.body);
      return result
        .json()
        .data.some((entry: { id: string }) => entry.id === manual.connectionTemplateId);
    };
    // Admins can configure a saved template before a person can use it to start consent.
    assert.equal(await listsManualTemplate("/connection-templates"), true);
    assert.equal(await listsManualTemplate(`${base}/connection-templates`), false);
    assert.equal((await inject("POST", connections, manual)).statusCode, 409);
    const registered = await inject("POST", "/oauth-clients", {
      connectionTemplateId: manual.connectionTemplateId,
      connectionTemplateVersion: template.json().data.current.version,
      displayName: "Saved accounts",
      clientId,
      clientSecret,
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const oauthClientId = registered.json().data.id;
    // Registering the first client makes the current template ready for consent.
    assert.equal(await listsManualTemplate(`${base}/connection-templates`), true);
    const manualStart = await inject("POST", connections, manual);
    assert.equal(manualStart.statusCode, 201, manualStart.body);
    // A cancelled browser attempt has no outstanding gateway write. An admin can retire it immediately.
    const pendingId = manualStart.json().data.credentialSourceId;
    const removed = await inject("DELETE", `${base}/credential-sources/${pendingId}`);
    assert.equal(removed.statusCode, 204, removed.body);
    const pendingSession = await pool.query(
      "SELECT 1 FROM occ.connection_sessions WHERE credential_source_id=$1",
      [pendingId],
    );
    assert.equal(pendingSession.rowCount, 0);
    const mcpConfig = {
      displayName: "Scope selection",
      mode: "mcp_discovery",
      issuer,
      serverUrl,
      scopes: ["openid", "profile"],
      oauthClientId,
    };
    const mcp = await inject("POST", "/connection-templates", { ...mcpConfig, namespaceId });
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
      namespaceId,
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
    // Administrators change delivery for existing accounts without rewriting the consent receipt.
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
    assert.deepEqual(approved.destinations, widened);
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
    // Replacing and removing rows take effect through the same public account response.
    const changedDestinations = [{ host: recipient.host, port: 8443, path: "/reports/**" }];
    const templatePath = "/connection-templates/" + defaultAccount.connectionTemplateId;
    const changed = await inject("PATCH", templatePath, {
      ...manualConfig,
      scopes: [],
      oauthClientId,
      destinations: changedDestinations,
    });
    assert.equal(changed.statusCode, 200, changed.body);
    const effectiveDefault = async () => {
      const result = await owner("GET", connections);
      assert.equal(result.statusCode, 200, result.body);
      return result
        .json()
        .data.find((row: { credentialSourceId: string }) => row.credentialSourceId === defaultsId);
    };
    assert.deepEqual((await effectiveDefault()).destinations, changedDestinations);
    // Delivery stops on an issuer or mode change, while the provider grant remains usable.
    const incompatible = await inject("PATCH", templatePath, {
      ...manualConfig,
      issuer: issuer + "/different",
      scopes: [],
    });
    assert.equal(incompatible.statusCode, 200, incompatible.body);
    assert.deepEqual((await effectiveDefault()).destinations, []);
    const modeChanged = await inject("PATCH", templatePath, mcpConfig);
    assert.equal(modeChanged.statusCode, 200, modeChanged.body);
    assert.deepEqual((await effectiveDefault()).destinations, []);
    const originalReceipt = await pool.query(
      `SELECT destinations, oauth_client_id, client_id, issuer, token_url,
              connection_template_version, requested_scopes, granted_scopes
       FROM occ.saved_connections WHERE credential_source_id=$1`,
      [defaultsId],
    );
    assert.deepEqual(originalReceipt.rows[0], {
      destinations: manualDestinations,
      oauth_client_id: oauthClientId,
      client_id: clientId,
      issuer,
      token_url: tokenUrl,
      connection_template_version: defaultAccount.connectionTemplateVersion,
      requested_scopes: [],
      granted_scopes: ["profile"],
    });
    const refreshIncompatible = await owner(
      "POST",
      `${base}/credential-sources/${defaultsId}/rotate`,
    );
    assert.equal(refreshIncompatible.statusCode, 200, refreshIncompatible.body);
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
    // Both templates select this client in the same Namespace, but the person approved the MCP
    // resource. A substituted manual template must be rejected before a private Secret is created.
    const manualTemplate = await inject(
      "GET",
      `/connection-templates/${manual.connectionTemplateId}`,
    );
    assert.equal(manualTemplate.statusCode, 200, manualTemplate.body);
    const beforeSubstitution = secretDriver.calls.length;
    await assert.rejects(
      preparedTokens.register(
        {
          kind: "oauth_refresh_token",
          namespaceId,
          sourceId: id,
          approval: {
            ...manual,
            connectionTemplateVersion: manualTemplate.json().data.current.version,
            oauthClientId,
          },
          grant: {
            accessToken: randomUUID(),
            refreshToken: randomUUID(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            requestedScopes: ["openid"],
            grantedScopes: ["openid"],
          },
        },
        t.signal,
      ),
      { code: "client_registration_mismatch" },
    );
    assert.equal(secretDriver.calls.length, beforeSubstitution);

    // Only Keycloak can start a flow. The built-in Google template still has no OAuth client.
    assert.equal(new URL(callback, publicOrigin).searchParams.has("iss"), false);
    const stolen = await secondSession("GET", callback);
    assert.match(String(stolen.headers.location), /reason=unknown_session/);
    // The code was issued while A was current. Keycloak now rejects A, so redeeming it proves
    // the callback resolves this registration's current secret after the owner's consent.
    const callbackSecret = await rotateKeycloakClientSecret(
      issuer,
      secrets.admin,
      clientId,
      clientSecret,
      tokenUrl,
    );
    const beforeCallback = await inject("POST", `/oauth-clients/${oauthClientId}/rotate-secret`, {
      clientSecret: callbackSecret,
    });
    assert.equal(beforeCallback.statusCode, 200, beforeCallback.body);
    const grantHandoff = t.mock.method(preparedTokens, "register");
    const completed = await owner("GET", callback);
    assert.equal(completed.statusCode, 303, completed.body);
    assert.match(String(completed.headers.location), /connection=connected/);
    assert.match(String((await owner("GET", callback)).headers.location), /reason=unknown_session/);
    const accountRef = { kind: "oauth_refresh_token", namespaceId, sourceId: id } as const;
    const [recorded] = grantHandoff.mock.calls;
    assert.ok(recorded);
    const issuedRef: unknown = await recorded.result;
    assert.deepEqual(issuedRef, accountRef);
    grantHandoff.mock.restore();
    // A reference or registration from the saved account cannot become a GitHub input by changing kind.
    const issuerLookup = t.mock.method(preparedTokens, "issuer");
    try {
      assert.equal(
        await preparedTokens.resolve(
          // @ts-expect-error A relabeled OAuth reference lacks the required prepared source key.
          { ...issuedRef, kind: "github_app_installation" },
          {
            signal: t.signal,
            deadlineAt: new Date(Date.now() + 10_000).toISOString(),
            minimumValidityMs: 0,
          },
        ),
        undefined,
      );
      await assert.rejects(
        preparedTokens.register(
          { ...recorded.arguments[0], kind: "github_app_installation" },
          t.signal,
        ),
        {
          message: /requires a source and issuer Secret/,
        },
      );
      assert.equal(issuerLookup.mock.callCount(), 0);
    } finally {
      issuerLookup.mock.restore();
    }
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
    const sourceDetails = await owner("GET", source);
    assert.equal(sourceDetails.statusCode, 200, sourceDetails.body);
    assert.equal(sourceDetails.json().data.ownerCapability, "token_service");
    const readerAccounts = await reader("GET", connections);
    assert.equal(readerAccounts.statusCode, 200, readerAccounts.body);
    assert.deepEqual(readerAccounts.json().data, []);
    assert.equal((await reader("GET", source)).statusCode, 403);
    assert.equal((await reader("DELETE", `${connections}/${id}`)).statusCode, 403);
    const custody = await pool.query(
      `SELECT custody.secret_ref, source.driver_id FROM occ.connection_token_custody custody
       JOIN occ.credential_sources source ON source.namespace_id = custody.namespace_id AND source.id = custody.credential_source_id
       WHERE custody.namespace_id=$1 AND custody.credential_source_id=$2`,
      [namespaceId, id],
    );
    assert.equal(custody.rowCount, 1);
    assert.equal(custody.rows[0].driver_id, null);
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
    async function prepared(minimumValidityMs = 0) {
      const token = await preparedTokens.resolve(
        { kind: "oauth_refresh_token", namespaceId, sourceId: id },
        {
          signal: t.signal,
          deadlineAt: new Date(Date.now() + 10_000).toISOString(),
          minimumValidityMs,
        },
      );
      assert.ok(token);
      return token.accessToken;
    }
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
    async function setIssuedLifetime(seconds: number) {
      const [client] = await keycloakRealmAdmin(
        issuer!,
        secrets.admin,
        "GET",
        `/clients?clientId=${clientId}`,
      );
      await keycloakRealmAdmin(issuer!, secrets.admin, "PUT", `/clients/${client.id}`, {
        ...client,
        attributes: { ...client.attributes, "access.token.lifespan": String(seconds) },
      });
    }
    // Only a newly issued token can satisfy this request's minimum remaining lifetime.
    await setIssuedLifetime(300);
    const [resolved, joined] = await Promise.all([prepared(120_000), prepared(120_000)]);
    assert.equal(joined, resolved);
    assert.notEqual(resolved, original);
    assert.equal(await subject(resolved), alice);

    // Lose access to the operator's registration before dispatch. The scheduler must back off
    // without losing the user's grant, and the owner can retry as soon as access returns.
    const unavailable = t.mock.method(secretDriver.installationSecrets, "withValue", async () => {
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
    // A new default registration is for future consent, even when its credentials are unusable.
    const futureRegistration = await inject("POST", "/oauth-clients", {
      connectionTemplateId: mcp.json().data.id,
      connectionTemplateVersion: mcp.json().data.current.version,
      displayName: "Future consent",
      clientId: clientId + "-future",
      clientSecret: randomUUID(),
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    assert.equal(futureRegistration.statusCode, 201, futureRegistration.body);
    const switchRegistration = await inject(
      "PATCH",
      "/connection-templates/" + mcp.json().data.id,
      { ...mcpConfig, oauthClientId: futureRegistration.json().data.id },
    );
    assert.equal(switchRegistration.statusCode, 200, switchRegistration.body);
    const currentMcp = async () => {
      const result = await owner("GET", connections);
      assert.equal(result.statusCode, 200, result.body);
      return result
        .json()
        .data.find((row: { credentialSourceId: string }) => row.credentialSourceId === id);
    };
    assert.deepEqual((await currentMcp()).destinations, [recipient]);
    assert.equal((await currentMcp()).oauthClientId, oauthClientId);
    const futureConsent = await owner("POST", connections, input);
    assert.equal(futureConsent.statusCode, 201, futureConsent.body);
    assert.equal(
      new URL(futureConsent.json().data.authorizationUrl).searchParams.get("client_id"),
      clientId + "-future",
    );
    // An MCP transport/resource change stops delivery rather than retargeting the saved grant.
    discoveredResource = "https://resource.connections.test";
    const otherResource = await inject(
      "PATCH",
      "/connection-templates/" + mcp.json().data.id,
      mcpConfig,
    );
    assert.equal(otherResource.statusCode, 200, otherResource.body);
    assert.deepEqual((await currentMcp()).destinations, []);
    discoveredResource = serverUrl;
    const otherMcp = await inject("PATCH", "/connection-templates/" + mcp.json().data.id, {
      ...mcpConfig,
      serverUrl: "https://other.connections.test/mcp",
    });
    assert.equal(otherMcp.statusCode, 200, otherMcp.body);
    assert.deepEqual((await currentMcp()).destinations, []);
    // The original grant must refresh after the provider and the OCE administrator rotate the client.
    const replacement = await rotateKeycloakClientSecret(
      issuer,
      secrets.admin,
      clientId,
      callbackSecret,
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
    await setIssuedLifetime(10);
    const rotated = await inject("POST", `${source}/rotate`, undefined);
    assert.equal(rotated.statusCode, 200, rotated.body);
    const renewed = await prepared();
    assert.equal(renewed !== original, true);
    assert.equal(await subject(renewed), alice);
    // Let this short-lived token actually expire before any worker starts. A normal resolve
    // must obtain its replacement with the current client secret and the original user's grant.
    await setIssuedLifetime(300);
    const oauth = preparedTokens.issuer("oauth_refresh_token");
    assert.ok(oauth);
    const expiring = await oauth.status(
      { kind: "oauth_refresh_token", namespaceId, sourceId: id },
      t.signal,
    );
    await waitFor(
      "Keycloak's access token to expire",
      async () => (Date.now() >= Date.parse(expiring.expiresAt!) ? true : undefined),
      { timeoutMs: 20_000, intervalMs: 100 },
    );
    const afterExpiry = await prepared();
    assert.notEqual(afterExpiry, renewed);
    assert.equal(await subject(afterExpiry), alice);
    const afterRotation = await owner("GET", connections);
    assert.equal(afterRotation.statusCode, 200, afterRotation.body);
    assert.deepEqual(
      afterRotation
        .json()
        .data.map((saved: { credentialSourceId: string }) => saved.credentialSourceId),
      [id],
    );
    const restoreMcp = await inject(
      "PATCH",
      "/connection-templates/" + mcp.json().data.id,
      mcpConfig,
    );
    assert.equal(restoreMcp.statusCode, 200, restoreMcp.body);
    // Publish the due schedule used for rotation but make no resolve request. A separate worker
    // must use the saved account's refresh grant and publish a new version before it is read.
    const prior = await state.read((view) =>
      view.savedConnections.findTokenCustody(namespaceId, id),
    );
    await state.transact((unit) =>
      unit.savedConnections.recordTokenSchedule(namespaceId, id, "due"),
    );
    async function startAccountWorker() {
      const fixture = await createBackendFixture(t);
      const { worker } = fixture.startWorker({
        backends: [],
        secretDriver,
        tokenService: new TokenService(),
      });
      await worker.start();
      return worker;
    }
    const worker = await startAccountWorker();
    await waitFor("background renewal to publish a new scheduled version", async () => {
      const current = await state.read((view) =>
        view.savedConnections.findTokenCustody(namespaceId, id),
      );
      return current?.scheduledVersion && current.scheduledVersion !== prior?.scheduledVersion
        ? true
        : undefined;
    });
    const background = await prepared();
    assert.notEqual(background, afterExpiry);
    assert.equal(await subject(background), alice);
    await worker.stop();
    const observed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = secretDriver.withValue.bind(secretDriver);
    const slowRead = t.mock.method(
      secretDriver,
      "withValue",
      async (...args: Parameters<typeof read>) => {
        const selected = await read(...args);
        observed.resolve();
        await release.promise;
        return selected;
      },
      { times: 1 },
    );
    const resolving = preparedTokens.resolve(
      { kind: "oauth_refresh_token", namespaceId, sourceId: id },
      {
        signal: t.signal,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
        minimumValidityMs: 0,
      },
    );
    await observed.promise;
    // The SQL revocation survives a transient custody failure. A worker with the same
    // Secret store and Token Service finishes it after the API request has returned.
    const unavailableDelete = t.mock.method(secretDriver, "delete", async () => {
      throw new DependencyUnavailableError("Secret store unavailable");
    });
    const interrupted = await owner("DELETE", `${connections}/${id}`);
    assert.equal(interrupted.statusCode, 503, interrupted.body);
    assert.ok(secretDriver.has(privateRef));
    // Releasing a read after OCC committed revocation must withhold the already-read bearer.
    release.resolve();
    assert.equal(await resolving, undefined);
    slowRead.mock.restore();
    unavailableDelete.mock.restore();
    await startAccountWorker();

    await waitFor("the worker to retire the disconnected account", async () => {
      const remaining = await state.read((view) =>
        view.savedConnections.findSavedConnection(namespaceId, id),
      );
      return remaining === undefined ? true : undefined;
    });
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
    // A second issuer becomes eligible after the first browser obtained its code. Even after the
    // template changes, callbacks from both usable versions could still be in flight.
    const pending = await begin();
    const secondIssuer = "https://second-issuer.example.test";
    const secondTemplate = await inject("POST", "/connection-templates", {
      ...manualConfig,
      namespaceId,
      displayName: "Second authorization server",
      issuer: secondIssuer,
      authorizationUrl: secondIssuer + "/authorize",
      tokenUrl: secondIssuer + "/token",
    });
    assert.equal(secondTemplate.statusCode, 201, secondTemplate.body);
    const secondTemplateId = secondTemplate.json().data.id;
    const secondClient = await inject("POST", "/oauth-clients", {
      connectionTemplateId: secondTemplateId,
      connectionTemplateVersion: 1,
      displayName: "Second server public registration",
      clientId: randomUUID(),
      tokenEndpointAuthMethod: "none",
    });
    assert.equal(secondClient.statusCode, 201, secondClient.body);
    const switchIssuer = await inject("PATCH", "/connection-templates/" + secondTemplateId, {
      ...manualConfig,
      oauthClientId,
    });
    assert.equal(switchIssuer.statusCode, 200, switchIssuer.body);
    const ambiguous = await owner("GET", pending.callback);
    assert.match(String(ambiguous.headers.location), /reason=issuer_required/);
    assert.equal(
      (await inject("DELETE", "/connection-templates/" + secondTemplateId)).statusCode,
      204,
    );
    assert.equal(
      (await inject("DELETE", "/oauth-clients/" + secondClient.json().data.id)).statusCode,
      204,
    );
    // A peer can revoke a browser session after its callback has already passed admission.
    const peer = await createPostgresAgentApp(t, {
      label: "saved-account",
      authSecret: "saved-account-test-auth-secret-minimum-32-bytes",
    });
    const waiting = await begin();
    const lock = await peer.pool.connect();
    let blocked;
    let verifier: string;
    try {
      await lock.query("BEGIN");
      const held = await lock.query(
        "DELETE FROM occ.connection_sessions WHERE credential_source_id=$1 RETURNING pg_backend_pid() AS pid, pkce_verifier",
        [waiting.id],
      );
      verifier = held.rows[0].pkce_verifier;
      blocked = owner("GET", waiting.callback);
      await waitForLockWaiter(
        peer.pool,
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
    // Keycloak still accepts this one-time code. A callback that exchanged it after logout would consume it.
    const unspent = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(`${clientId}:${replacement}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(waiting.callback, publicOrigin).searchParams.get("code")!,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
      signal: t.signal,
    });
    await unspent.body?.cancel();
    assert.equal(unspent.status, 200, "logout prevents OCE from redeeming the authorization code");
  },
);
