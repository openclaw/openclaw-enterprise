import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { AgentPluginCredentialSlot, PluginDriver } from "@openclaw-enterprise/contracts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { assertWorkerAccountRelease } from "../helpers/worker-account-release.mjs";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  managedCliInstalls,
  managedMcpInstalls,
  managedPluginAccountSlot,
} from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { OAuthConnectionTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { refreshPinnedOAuthGrant } from "../../apps/controller/src/drivers/credential-refresh/oauth-token-endpoint.ts";
import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import { NativeIAMDriver, validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import { PostgresHumanAuthentication } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { keycloakRealmAdmin, rotateKeycloakClientSecret } from "../helpers/ci-keycloak-realm.mjs";
import { selectTemplateDrivers } from "../helpers/connection-template-drivers.mjs";
import { connectFixtureGoogleAccount } from "../helpers/google-api-saved-account.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { createProviderSandboxDriver } from "../helpers/runtime-logs.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const issuer = process.env.OCC_TEST_KEYCLOAK_ISSUER;
const tokenOrigin = process.env.OCC_TEST_KEYCLOAK_TOKEN_ORIGIN;
const secretsFile = process.env.OCC_TEST_KEYCLOAK_SECRETS_FILE;
const publicOrigin = "https://occ-connections.test";
const redirectUri = `${publicOrigin}/oauth/callback`;

async function consentRedirect(authorizationUrl: string, username: string, password: string) {
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
    body: new URLSearchParams({ username, password, credentialId: "" }),
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
    selectedApp = app,
  ) =>
    selectedApp.inject({
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
const reportsUrl = "https://reports.example.test/mcp";

const gmailRead = "https://www.googleapis.com/auth/gmail.readonly";
const gmailModify = "https://www.googleapis.com/auth/gmail.modify";

async function oauthAccounts(t: TestContext, pluginWorkflow = false) {
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
  const scopes = ["openid"];
  let optionalScopeId: string | undefined;
  if (pluginWorkflow) {
    // This disposable issuer grants the names used by the real Gmail request policy.
    // Reading remains allowed while the optional modification scope varies on refresh.
    const [client] = await keycloakRealmAdmin(
      issuer,
      secrets.admin,
      "GET",
      `/clients?clientId=${clientId}`,
    );
    for (const name of [gmailRead, gmailModify]) {
      await keycloakRealmAdmin(issuer, secrets.admin, "POST", "/client-scopes", {
        name,
        protocol: "openid-connect",
        attributes: { "include.in.token.scope": String(name === gmailRead) },
      });
      const registered = await keycloakRealmAdmin(issuer, secrets.admin, "GET", "/client-scopes");
      const scope = registered.find((item: { name: string }) => item.name === name);
      assert.ok(scope);
      t.after(() =>
        keycloakRealmAdmin(issuer, secrets.admin, "DELETE", `/client-scopes/${scope.id}`),
      );
      await keycloakRealmAdmin(
        issuer,
        secrets.admin,
        "PUT",
        `/clients/${client.id}/optional-client-scopes/${scope.id}`,
      );
      scopes.push(name);
      if (name === gmailModify) {
        optionalScopeId = scope.id;
      }
    }
  }
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
  // Keycloak issues real tokens for this issuer. A separate Google case controls only the token endpoint.
  const secretDriver = { ...createTestSecretDriver(), capability: "secret" as const };
  const preparedTokens = new TokenService(
    new OAuthConnectionTokens(secretDriver, refreshPinnedOAuthGrant),
  );
  const tokenUrl = `${tokenOrigin}/realms/oce/protocol/openid-connect/token`;
  let discoveredResource = "https://api.connections.test/mcp";
  let skew = 0;
  const { app, controller, state, principal, computeDriver, inject, pool, adminAccount } =
    await createPostgresAgentApp(t, {
      label: "saved-account",
      authSecret: "saved-account-test-auth-secret-minimum-32-bytes",
      secretDriver,
      ...(pluginWorkflow && {
        sandboxDriver: createProviderSandboxDriver({ id: "openshell-sandbox" }).driver,
      }),
      controllerOptions: {
        preparedTokens,
        ...(pluginWorkflow && { nativeWorkerSupport: "custom-image" }),
        now: () => new Date(Date.now() + skew),
      },
      appOptions: {
        publicOrigin,
        // Only the fixture MCP metadata is supplied locally. OCC creates the template and
        // Keycloak serves authorization, token exchange, and user logins for this issuer.
        async discoverMcpAuthorization(serverUrl: string, selectedIssuer?: string) {
          if (pluginWorkflow) {
            assert.equal(serverUrl, reportsUrl);
          }
          assert.equal(selectedIssuer, issuer);
          return {
            serverUrl,
            resource: pluginWorkflow ? new URL(reportsUrl).origin : discoveredResource,
            issuers: [issuer],
            requestedScopes: ["openid"],
            resourceScopes: ["openid", "profile"],
            supportedScopes: ["openid", "profile"],
            issuer,
            authorizationUrl: `${issuer}/protocol/openid-connect/auth`,
            tokenUrl,
            tokenEndpointAuthMethods: ["client_secret_basic"],
          };
        },

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
      name: kubernetesNamespaceName(namespace.id),
    }),
  });
  const { providers, transport, refresh, gateway } = selectTemplateDrivers(controller, {
    selectGateway: pluginWorkflow,
  });
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
    destinations: pluginWorkflow
      ? [{ host: "gmail.googleapis.com", port: 443, path: "/**" }]
      : manualDestinations,
    scopes,
  };
  const template = await inject("POST", "/connection-templates", {
    ...manualConfig,
    displayName: "Keycloak",
    namespaceId,
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
  const input: { connectionTemplateId: string; selectedScopes?: string[] } = { ...manual };
  const ownerId = principal.id;
  const owner = await accountSession(app, adminAccount.email, adminAccount.password);
  const mcpConfig = {
    displayName: "Scope selection",
    mode: "mcp_discovery",
    issuer,
    serverUrl: "https://api.connections.test/mcp",
    scopes: ["openid", "profile"],
    oauthClientId,
  };
  if (!pluginWorkflow) {
    // Registering the first client makes the current template ready for consent.
    const manualStart = await inject("POST", connections, manual);
    assert.equal(manualStart.statusCode, 201, manualStart.body);
    const mcp = await inject("POST", "/connection-templates", { ...mcpConfig, namespaceId });
    assert.equal(mcp.statusCode, 201, mcp.body);
    input.connectionTemplateId = mcp.json().data.id;
    input.selectedScopes = ["openid"];
    for (const choice of [undefined, ["profile"], ["openid", "other"]]) {
      const refused = await inject("POST", connections, {
        connectionTemplateId: input.connectionTemplateId,
        ...(choice && { selectedScopes: choice }),
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
    // Let Keycloak choose a default on this isolated registration. The account must record it
    // as a provider grant while preserving that the person did not request an explicit scope.
    const unrestrictedManual = await inject("POST", "/connection-templates", {
      ...manualConfig,
      oauthClientId,
      scopes: [],
      displayName: "Provider defaults",
      namespaceId,
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
    const defaultCallback = await owner(
      "GET",
      await consentRedirect(defaultsUrl, "alice", secrets.users.alice.password),
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
  }
  async function begin(
    path = connections,
    body: Record<string, unknown> = input,
    username: "alice" | "carol" = "alice",
  ) {
    const response = await owner("POST", path, body);
    assert.equal(response.statusCode, 201, response.body);
    if (body.selectedScopes) {
      assert.equal(
        new URL(response.json().data.authorizationUrl).searchParams.get("scope"),
        (body.selectedScopes as string[]).join(" "),
      );
    }
    return {
      id: response.json().data.credentialSourceId as string,
      callback: await consentRedirect(
        response.json().data.authorizationUrl,
        username,
        secrets.users[username].password,
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
    refresh,
    transport,
    gateway,
    rotateClientSecret: async (source: string) => {
      const replacement = await rotateKeycloakClientSecret(
        issuer!,
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
    },
    setOptionalScopeVisible: async (visible: boolean) => {
      assert.ok(optionalScopeId);
      const path = "/client-scopes/" + optionalScopeId;
      const scope = await keycloakRealmAdmin(issuer!, secrets.admin, "GET", path);
      await keycloakRealmAdmin(issuer!, secrets.admin, "PUT", path, {
        ...scope,
        attributes: { ...scope.attributes, "include.in.token.scope": String(visible) },
      });
    },
    preparedTokens,
    mcpConfig,
    setDiscoveredResource(resource: string) {
      discoveredResource = resource;
    },
    oauthClientId,
    tokenUrl,
    clientId,
    scopes,
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
      preparedTokens,
      rotateClientSecret,
      oauthClientId,
      tokenUrl,
      clientId,
      makeNamespace,
      secretDriver,
      refresh,
      namespaceId,
      base,
      connections,
      input,
      owner,
      ownerId,
      begin,
      advanceRegistrationFence,
      mcpConfig,
      setDiscoveredResource,
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
    const account = accounts.json().data[0];
    // Google is the controlled exchange in this case. A receipt for an exact Google
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
      [
        oauthClientId,
        clientId,
        issuer,
        tokenUrl,
        [{ host: "api.connections.test", port: 443, path: "/mcp" }],
        ["openid"],
        ["openid"],
      ],
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
    // A new default registration is for future consent, even when its credentials are unusable.
    const futureRegistration = await inject("POST", "/oauth-clients", {
      connectionTemplateId: input.connectionTemplateId,
      connectionTemplateVersion: (
        await inject("GET", "/connection-templates/" + input.connectionTemplateId)
      ).json().data.current.version,
      displayName: "Future consent",
      clientId: clientId + "-future",
      clientSecret: randomUUID(),
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    assert.equal(futureRegistration.statusCode, 201, futureRegistration.body);
    const switchRegistration = await inject(
      "PATCH",
      "/connection-templates/" + input.connectionTemplateId,
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
    assert.deepEqual((await currentMcp()).destinations, [
      { host: "api.connections.test", port: 443, path: "/mcp" },
    ]);
    assert.equal((await currentMcp()).oauthClientId, oauthClientId);
    const futureConsent = await owner("POST", connections, input);
    assert.equal(futureConsent.statusCode, 201, futureConsent.body);
    assert.equal(
      new URL(futureConsent.json().data.authorizationUrl).searchParams.get("client_id"),
      clientId + "-future",
    );
    // An MCP transport/resource change stops delivery rather than retargeting the saved grant.
    setDiscoveredResource("https://resource.connections.test");
    const otherResource = await inject(
      "PATCH",
      "/connection-templates/" + input.connectionTemplateId,
      mcpConfig,
    );
    assert.equal(otherResource.statusCode, 200, otherResource.body);
    assert.deepEqual((await currentMcp()).destinations, []);
    setDiscoveredResource("https://api.connections.test/mcp");
    const otherMcp = await inject("PATCH", "/connection-templates/" + input.connectionTemplateId, {
      ...mcpConfig,
      serverUrl: "https://other.connections.test/mcp",
    });
    assert.equal(otherMcp.statusCode, 200, otherMcp.body);
    assert.deepEqual((await currentMcp()).destinations, []);
    // The original grant must refresh after the provider and the OCE administrator rotate the client.
    await rotateClientSecret(source);
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
    const restoreMcp = await inject(
      "PATCH",
      "/connection-templates/" + input.connectionTemplateId,
      mcpConfig,
    );
    assert.equal(restoreMcp.statusCode, 200, restoreMcp.body);
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
test(
  "Plugin consent attaches its saved account only while the Agent still permits the requested binding",
  lane,
  async (t) => {
    const {
      controller,
      state,
      transport,
      providers,
      gateway,
      refresh,
      preparedTokens,
      secretDriver,
      principal,
      rotateClientSecret,
      setOptionalScopeVisible,
      pool,
      inject,
      namespaceId,
      base,
      connections,
      input,
      owner,
      begin,
      oauthClientId,
      tokenUrl,
      scopes,
    } = await oauthAccounts(t, true);
    assert.ok(issuer);
    const pluginId = "test-keycloak";
    const slotId = "account";
    const releaseSha256 = "a".repeat(64);
    const cli = managedCliInstalls[0]!;
    const cliAccount = cli.credentials.account!;
    const mcp = managedMcpInstalls[0]!;
    const reportAccount = mcp.credentials[mcp.slotId]!;
    const primary = {
      ...cli,
      id: pluginId,
      releaseSha256,
      credentials: {
        account: {
          ...cliAccount,
          issuer,
          tokenEndpoint: tokenUrl,
          delivery: { ...cliAccount.delivery, envAliases: ["SECONDARY_COMPAT_TOKEN"] },
        },
        secondary: {
          ...cliAccount,
          issuer,
          tokenEndpoint: tokenUrl,
          delivery: { ...cliAccount.delivery, env: "SECONDARY_MAIL_TOKEN" },
        },
      },
    };
    const reports = {
      ...mcp,
      id: pluginId,
      releaseSha256,
      url: reportsUrl,
      endpoint: { host: new URL(reportsUrl).hostname, port: 443, path: "/mcp" },
      credentials: {
        reports: {
          ...reportAccount,
          issuer,
          mcp: { ...reportAccount.mcp, resource: new URL(reportsUrl).origin },
        },
        unrelated: {
          ...reportAccount,
          issuer: "https://unrelated.example.test",
          mcp: reportAccount.mcp,
        },
      },
    };
    // A pluggable release declares a receiver per named slot. The production dispatcher supplies
    // issuer, recipient, binding and delivery logic. No bundled multi-MCP package is assumed.
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
          return [
            { id: slotId, label: "Mail" },
            { id: "secondary", label: "Secondary mail" },
            { id: "reports", label: "Reports" },
            { id: "unrelated", label: "Unrelated service" },
          ].map((slot) => ({ ...slot, pluginId, releaseSha256, sources: [] }));
        },
        validate() {},
        connectionSlot(selections, requestedPlugin, requestedSlot) {
          if (requestedPlugin !== pluginId) {
            return undefined;
          }
          const directory = Object.hasOwn(primary.credentials, requestedSlot);
          const admitted = managedPluginAccountSlot(
            directory ? primary : reports,
            selections,
            requestedSlot,
          );
          if (!directory || !admitted) {
            return admitted;
          }
          return {
            ...admitted,
            delivery(target, grantedScopes) {
              const delivery = admitted.delivery(target, grantedScopes);
              const [receiver] = target.destinations;
              // This test Driver presents its Keycloak account through the normal single-target
              // sender. The bundled Google sender below requires Google's own issuer and client.
              const { destinations: _, ...config } = delivery.config;
              return {
                ...delivery,
                config: {
                  ...config,
                  host: receiver!.host,
                  port: String(receiver!.port),
                  path: receiver!.path,
                },
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
        executionMode: "dedicated",
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
        connectionTemplateVersion: 2,
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
    const reportTemplate = await inject("POST", "/connection-templates", {
      mode: "mcp_discovery",
      namespaceId,
      displayName: "Reports",
      serverUrl: reportsUrl,
      issuer,
      oauthClientId,
      scopes: ["openid"],
    });
    assert.equal(reportTemplate.statusCode, 201, reportTemplate.body);
    const reportInput = {
      connectionTemplateId: reportTemplate.json().data.id,
      selectedScopes: ["openid"],
    };
    const report = await begin(connections, reportInput, "carol");
    assert.match(
      String((await owner("GET", report.callback)).headers.location),
      /connection=connected/,
    );
    const slotAgent = await agent("Slot assignments");
    const choices = await owner("GET", `${path(slotAgent)}/plugins/capabilities`);
    assert.equal(choices.statusCode, 200, choices.body);
    const choicesFor = (id: string, sourceId: string) =>
      (choices.json().data.credentialSlots as AgentPluginCredentialSlot[])
        .find((slot) => slot.id === id)
        ?.sources.find((source) => source.id === sourceId);
    assert.ok(choicesFor(slotId, grant.id));
    assert.equal(choicesFor(slotId, grant.id)?.authorization, undefined);
    assert.equal(choicesFor("reports", grant.id)?.authorization, "required");
    assert.equal(choicesFor("unrelated", grant.id), undefined);
    assert.equal(choicesFor("reports", report.id)?.id, report.id);
    assert.equal(choicesFor("reports", report.id)?.authorization, undefined);
    const saveBindings = (credentials: Record<string, string>) =>
      owner("PATCH", path(slotAgent), {
        configurationId: config.json().data.id,
        plugins: { [pluginId]: { enabled: true, driverPolicy: { releaseSha256, credentials } } },
      });
    // Hand-writing a source ID bypasses the picker but cannot send either token to the
    // wrong recipient. The valid first binding must roll back with the rejected second one.
    const rejected = await saveBindings({ account: grant.id, reports: grant.id });
    assert.equal(rejected.statusCode, 409, rejected.body);
    const wrongIssuer = await saveBindings({ unrelated: report.id });
    assert.equal(wrongIssuer.statusCode, 409, wrongIssuer.body);
    assert.deepEqual(await attached(slotAgent), []);
    assert.equal(await canUse(slotAgent, grant.id), false);
    assert.equal(await canUse(slotAgent, report.id), false);
    // Alice's saved mail connection and Carol's saved reporting connection both belong to
    // the signed-in OCE user. Assigning them commits the exact grants and two independent IDs.
    const narrowAccount = accounts
      .json()
      .data.find((row: { credentialSourceId: string }) => row.credentialSourceId === grant.id);
    assert.deepEqual(narrowAccount.requestedScopes, scopes);
    assert.deepEqual([...narrowAccount.grantedScopes].sort(), [gmailRead, "openid"]);
    const bindings = { account: grant.id, reports: report.id };
    const updated = await saveBindings(bindings);
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual((await draft(slotAgent)).plugins[pluginId].driverPolicy.credentials, bindings);
    assert.deepEqual((await attached(slotAgent)).sort(), [grant.id, report.id].sort());
    assert.equal(await canUse(slotAgent, grant.id), true);
    assert.equal(await canUse(slotAgent, report.id), true);

    // Replacing an already-saved slot requires the previous ID and fresh consent. Other
    // bindings and previously delegated usage survive the replacement.
    const replacement = await begin(`${path(slotAgent)}/connections`, {
      ...reportInput,
      connectionTemplateVersion: 1,
      pluginId,
      slotId: "reports",
      releaseSha256,
      expectedCredentialSourceId: report.id,
    });
    const replaced = await owner("GET", replacement.callback);
    assert.match(String(replaced.headers.location), /connection=attached/);
    assert.deepEqual((await draft(slotAgent)).plugins[pluginId].driverPolicy.credentials, {
      account: grant.id,
      reports: replacement.id,
    });
    assert.equal(await canUse(slotAgent, report.id), true);
    assert.equal(await canUse(slotAgent, replacement.id), true);
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

    // Keycloak issues the same real user's grant to two separately admitted revisions.
    // A transient write failure during one handoff must leave the account renewable for the other.
    await setOptionalScopeVisible(true);
    const shared = await begin(connections, input, "alice");
    assert.match(
      String((await owner("GET", shared.callback)).headers.location),
      /connection=connected/,
    );
    const modelSecret = await owner("POST", base + "/secrets", {
      name: "Harness key",
      value: randomUUID(),
    });
    assert.equal(modelSecret.statusCode, 201, modelSecret.body);
    const modelSource = await owner("POST", base + "/credential-sources", {
      name: "Model credential",
      type: "openai",
      config: {},
      secrets: { api_key: modelSecret.json().data.ref },
    });
    assert.equal(modelSource.statusCode, 201, modelSource.body);
    const modelSourceId = modelSource.json().data.id;
    const modelRole = await owner("POST", base + "/iam/roles", {
      name: "Use model credential",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    });
    assert.equal(modelRole.statusCode, 201, modelRole.body);
    const revisions = new Map<string, string>();
    for (const id of [b, c]) {
      const agent = await state.read((v) => v.agents.findAgent(namespaceId, id));
      assert.ok(agent);
      const modelGrant = await owner("POST", base + "/iam/access-bindings", {
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: modelRole.json().data.id,
        resourceKind: "credential_source",
        resourceId: modelSourceId,
      });
      assert.equal(modelGrant.statusCode, 201, modelGrant.body);
      const bound = await owner("PATCH", path(id), {
        configurationId: config.json().data.id,
        harnessAuth: { method: "credential_source", sourceId: modelSourceId },
        credentialSources: [...(agent.credentialSources ?? []), { sourceId: modelSourceId }],
        plugins: {
          [pluginId]: {
            enabled: true,
            driverPolicy: {
              releaseSha256,
              credentials: { [id === b ? slotId : "secondary"]: shared.id },
            },
          },
        },
      });
      assert.equal(bound.statusCode, 200, bound.body);
      const deployed = await owner("POST", path(id) + "/deploy");
      assert.equal(deployed.statusCode, 202, deployed.body);
      revisions.set(id, deployed.json().data.id);
    }
    const prepare = async (agentId: string) => {
      const source = await controller.prepareRevisionAccount(
        namespaceId,
        agentId,
        revisions.get(agentId)!,
        shared.id,
      );
      if (source) {
        // This fixture Compute does not run a Sandbox. The controller boundary below
        // proves prepared policy and fresh release checks; native guard proof is separate.
        await controller.releaseRevisionAccount(
          namespaceId,
          agentId,
          revisions.get(agentId)!,
          source,
        );
      }
      return source;
    };
    // Different placeholders in the same release produce distinct sender profiles.
    const senderFor = async (id: string) => {
      assert.ok(await prepare(id));
      const revision = await state.read((v) =>
        v.revisions.findRevision(namespaceId, id, revisions.get(id)!),
      );
      const delivery = revision?.credentialSources?.find(
        (ref) => ref.sourceId === shared.id,
      )?.accountDelivery;
      assert.ok(delivery);
      return openShellProviderName(delivery.profileId);
    };
    const primarySender = await senderFor(b);
    const secondarySender = await senderFor(c);
    assert.notEqual(primarySender, secondarySender);
    const provider = (name: string) => [...providers.values()].find((p) => p.name === name);
    const usable = async (name: string) => {
      const current = provider(name);
      const keys =
        name === primarySender
          ? [
              primary.credentials.account.delivery.env,
              ...primary.credentials.account.delivery.envAliases,
            ]
          : [primary.credentials.secondary.delivery.env];
      assert.deepEqual(Object.keys(current.credentials).sort(), [...keys].sort());
      assert.deepEqual(Object.keys(current.credentialExpirationTimes).sort(), [...keys].sort());
      const bearer = current.credentials[keys[0]!];
      for (const key of keys) {
        assert.ok(
          current.credentials[key] === bearer,
          "each authorized alias carries the same access token",
        );
        assert.ok(Date.parse(current.credentialExpirationTimes[key]) > Date.now());
      }
      const result = await fetch(issuer + "/protocol/openid-connect/userinfo", {
        headers: { authorization: "Bearer " + bearer },
      });
      assert.equal(result.status, 200);
      return bearer;
    };
    const admitted = await prepare(b);
    assert.ok(admitted?.config.scope);
    assert.deepEqual(admitted.config.scope.split(" ").sort(), [gmailModify, gmailRead]);
    const original = await usable(primarySender);
    assert.ok((await usable(secondarySender)) === original);
    const rotate = () => owner("POST", base + "/credential-sources/" + shared.id + "/rotate");
    // Both Agents already use this account. Rotate the OAuth client before refreshing their existing grant.
    await rotateClientSecret(base + "/credential-sources/" + shared.id);
    const rotated = await rotate();
    assert.equal(rotated.statusCode, 200, rotated.body);
    const grants = await state.read((view) =>
      view.savedConnections.listAgentConnections(namespaceId, b),
    );
    assert.ok(grants.some((account) => account.credentialSourceId === shared.id));
    // Keep the secondary sender unavailable throughout both operations. The primary
    // sender receives the renewed token while the failed sender keeps the old receipt.
    const write = transport.updateProviderCredentialsConditionally.bind(transport);
    const fault = t.mock.method(
      transport,
      "updateProviderCredentialsConditionally",
      (...params: Parameters<typeof write>) => {
        if (params[0].name === secondarySender) {
          throw new Error("sender unavailable");
        }
        return write(...params);
      },
    );
    try {
      await assert.rejects(prepare(c), { name: "DependencyUnavailableError" });
      assert.ok(await prepare(b));
      assert.ok(
        (await usable(primarySender)) !== original,
        "the primary sender replaced its token",
      );
      assert.ok(
        provider(secondarySender).credentials[primary.credentials.secondary.delivery.env] ===
          original,
        "the unavailable sender kept its original token",
      );
    } finally {
      fault.mock.restore();
    }
    const revoked = await owner("DELETE", path(c) + "/connections/" + shared.id);
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(await prepare(c), undefined);
    assert.ok(await prepare(b));

    // A renewed provider grant can narrow while the same revision retains its remaining API access.
    await setOptionalScopeVisible(false);
    assert.equal((await rotate()).statusCode, 200);
    const refreshedAccounts = (await owner("GET", connections)).json().data;
    const refreshed = refreshedAccounts.find(
      (account: { credentialSourceId: string }) => account.credentialSourceId === shared.id,
    );
    assert.deepEqual([...refreshed.grantedScopes].sort(), [gmailRead, "openid"]);
    const narrowed = await prepare(b);
    assert.ok(narrowed?.config.scope);
    assert.deepEqual(narrowed.config.scope.split(" "), [gmailRead]);
    assert.ok(provider(primarySender).credentials[primary.credentials.account.delivery.env]);

    // The fixture Compute does not place Kubernetes plugins. Keep its placement Driver
    // and delegate every slot and source decision to the bundled Google credential policy.
    controller.registerDriver({
      ...plugin,
      id: "google-slot-fixture",
      credentials: new OCCPluginDriver().credentials,
    });
    controller.selectDriver("plugin", "google-slot-fixture");
    const google = await connectFixtureGoogleAccount(t, owner, namespaceId, [
      gmailRead,
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
    ]);
    const receipt = (await owner("GET", connections))
      .json()
      .data.find(
        (row: { credentialSourceId: string }) =>
          row.credentialSourceId === google.credentialSourceId,
      );
    const templateId = receipt.connectionTemplateId;
    const calendar = { host: "www.googleapis.com", port: 443, path: "/calendar/v3/**" };
    const drive = { host: "www.googleapis.com", port: 443, path: "/drive/v3/files/**" };
    const docs = { host: "docs.googleapis.com", port: 443, path: "/v1/documents/**" };
    const templateInput: Record<string, unknown> = { ...google.templateInput };
    delete templateInput.namespaceId;
    const initialRoutes = await owner("PATCH", "/connection-templates/" + templateId, {
      ...templateInput,
      destinations: [...google.templateInput.destinations, drive],
    });
    assert.equal(initialRoutes.statusCode, 200, initialRoutes.body);
    const created = await owner("POST", agents, {
      name: "Google APIs",
      executionMode: "dedicated",
      configurationId: config.json().data.id,
      plugins: { [cli.id]: { enabled: true } },
    });
    assert.equal(created.statusCode, 201, created.body);
    const googleAgent = created.json().data.id;
    const granted = await owner(
      "POST",
      path(googleAgent) + "/connections/" + google.credentialSourceId,
    );
    assert.equal(granted.statusCode, 204, granted.body);
    const modelGrant = await owner("POST", base + "/iam/access-bindings", {
      subjectKind: "identity",
      subjectId: created.json().data.servicePrincipalId,
      roleId: modelRole.json().data.id,
      resourceKind: "credential_source",
      resourceId: modelSourceId,
    });
    assert.equal(modelGrant.statusCode, 201, modelGrant.body);
    const bound = await owner("PATCH", path(googleAgent), {
      configurationId: config.json().data.id,
      harnessAuth: { method: "credential_source", sourceId: modelSourceId },
      credentialSources: [{ sourceId: google.credentialSourceId }, { sourceId: modelSourceId }],
      plugins: {
        [cli.id]: {
          enabled: true,
          driverPolicy: {
            releaseSha256: cli.releaseSha256,
            credentials: { account: google.credentialSourceId },
          },
        },
      },
    });
    assert.equal(bound.statusCode, 200, bound.body);
    const deployed = await owner("POST", path(googleAgent) + "/deploy");
    assert.equal(deployed.statusCode, 202, deployed.body);
    const revisionId = deployed.json().data.id;
    const prepareGoogle = () =>
      controller.prepareRevisionAccount(
        namespaceId,
        googleAgent,
        revisionId,
        google.credentialSourceId,
      );
    const initialSource = await prepareGoogle();
    assert.ok(initialSource);
    await controller.releaseRevisionAccount(namespaceId, googleAgent, revisionId, initialSource);
    const revision = await state.read((v) =>
      v.revisions.findRevision(namespaceId, googleAgent, revisionId),
    );
    const delivered = revision?.credentialSources?.find(
      (source) => source.sourceId === google.credentialSourceId,
    )?.accountDelivery;
    assert.ok(delivered);
    const sender = provider(openShellProviderName(delivered.profileId));
    const googleProfile = await transport.getProviderProfile(sender.workspace, sender.type);
    assert.deepEqual(
      googleProfile.endpoints
        .map(({ host, port, path }: { host: string; port: number; path: string }) => [
          host,
          port,
          path,
        ])
        .sort(),
      [
        ["gmail.googleapis.com", 443, "/gmail/v1/users/me/messages"],
        ["www.googleapis.com", 443, "/calendar/v3/**"],
        ["www.googleapis.com", 443, "/drive/v3/files/**"],
      ],
    );
    assert.ok(
      sender.credentials[cliAccount.delivery.env] === google.accessToken,
      "only the prepared Google access token reaches the selected revision",
    );
    const changed = await owner("PATCH", "/connection-templates/" + templateId, {
      ...templateInput,
      destinations: [calendar, docs],
    });
    assert.equal(changed.statusCode, 200, changed.body);
    const currentSource = await prepareGoogle();
    assert.ok(currentSource);
    assert.deepEqual(
      Object.keys(sender.credentials),
      [],
      "changed routes cannot reuse the prior bearer",
    );
    const currentProfile = await transport.getProviderProfile(sender.workspace, sender.type);
    assert.deepEqual(
      currentProfile.endpoints
        .map(({ host, port, path }: { host: string; port: number; path: string }) => [
          host,
          port,
          path,
        ])
        .sort(),
      [
        [calendar.host, calendar.port, calendar.path],
        [docs.host, docs.port, docs.path],
      ].sort(),
    );
    await assert.rejects(
      controller.releaseRevisionAccount(namespaceId, googleAgent, revisionId, initialSource),
      { name: "ResourceStateConflictError" },
    );
    await controller.releaseRevisionAccount(namespaceId, googleAgent, revisionId, currentSource);
    assert.ok(
      sender.credentials[cliAccount.delivery.env] === google.accessToken,
      "current routes use the original consent grant without reconnect",
    );
    assert.equal(
      (await state.read((v) => v.revisions.findRevision(namespaceId, googleAgent, revisionId)))?.id,
      revisionId,
    );
    // This Agent's first revision uses real Kubernetes admission; earlier fixture deployments
    // intentionally omit runtime registration and cannot be adopted as historical native launches.
    const workerAgent = await owner("POST", agents, {
      name: "Worker release ordering",
      executionMode: "dedicated",
      configurationId: config.json().data.id,
      plugins: { [cli.id]: { enabled: true } },
    });
    assert.equal(workerAgent.statusCode, 201, workerAgent.body);
    const workerAgentId = workerAgent.json().data.id;
    const workerAccount = await owner(
      "POST",
      path(workerAgentId) + "/connections/" + google.credentialSourceId,
    );
    assert.equal(workerAccount.statusCode, 204, workerAccount.body);
    const workerModelGrant = await owner("POST", base + "/iam/access-bindings", {
      subjectKind: "identity",
      subjectId: workerAgent.json().data.servicePrincipalId,
      roleId: modelRole.json().data.id,
      resourceKind: "credential_source",
      resourceId: modelSourceId,
    });
    assert.equal(workerModelGrant.statusCode, 201, workerModelGrant.body);
    const workerBinding = await owner("PATCH", path(workerAgentId), {
      configurationId: config.json().data.id,
      harnessAuth: { method: "credential_source", sourceId: modelSourceId },
      credentialSources: [{ sourceId: google.credentialSourceId }, { sourceId: modelSourceId }],
      plugins: {
        [cli.id]: {
          enabled: true,
          driverPolicy: {
            releaseSha256: cli.releaseSha256,
            credentials: { account: google.credentialSourceId },
          },
        },
      },
    });
    assert.equal(workerBinding.statusCode, 200, workerBinding.body);
    await assertWorkerAccountRelease(t, {
      controller,
      state,
      pool,
      principal,
      secretDriver,
      gateway,
      refresh,
      preparedTokens,
      plugin: new OCCPluginDriver(),
      namespaceId,
      agentId: workerAgentId,
      sourceId: google.credentialSourceId,
      expectedToken: google.accessToken,
      transport,
      providers,
    });
  },
);
