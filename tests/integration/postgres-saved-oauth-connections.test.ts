import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import type { AgentPluginCredentialSlot, PluginDriver } from "@openclaw-enterprise/contracts";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  managedCliInstalls,
  managedMcpInstalls,
  managedPluginAccountSlot,
} from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createRuntimeComputeDriver } from "../helpers/provisioning-compute.mjs";
import { claimIsolatedWork } from "../helpers/postgres-work-claim.mjs";
import { createSavedAccountOrigin } from "../helpers/saved-account-origin.ts";
import {
  installSavedAccountPlacement,
  savedAccountProxyFixture,
  installSavedAccountProxy,
  savedAccountSandboxRegistration,
} from "../helpers/saved-account-proxy.ts";
import { CREDENTIAL_GATEWAY_FIXTURE_ID } from "../helpers/postgres-worker-revision-fixture.mjs";
import { grantAgentSecretOperate } from "../helpers/postgres-harness-auth.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import { NativeIAMDriver, validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import {
  DependencyUnavailableError,
  OpenClawController,
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { keycloakRealmAdmin, rotateKeycloakClientSecret } from "../helpers/ci-keycloak-realm.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { openShellProviderStore } from "../helpers/openshell-provider-store.mjs";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { createBackendFixture } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
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

async function oauthAccounts(
  t: TestContext,
  reports?: {
    url: string;
    readTools: NonNullable<ControllerAppOptions["readManagedMcpToolNames"]>;
  },
) {
  const pluginWorkflow = reports !== undefined;
  assert.ok(issuer && tokenOrigin && secretsFile);
  const secrets = JSON.parse(await readFile(secretsFile, "utf8"));
  const clientId = `oce-saved-${randomUUID()}`;
  let clientSecret = randomUUID();
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
      ...(!pluginWorkflow && {
        "exclude.issuer.from.auth.response": "true",
        "access.token.lifespan": "90",
      }),
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

  const secretDriver = { ...createTestSecretDriver(), capability: "secret" as const };
  const preparedTokens = new TokenService();
  const tokenUrl = `${tokenOrigin}/realms/oce/protocol/openid-connect/token`;
  let discoveredResource = "https://api.connections.test/mcp";
  const { app, controller, state, principal, inject, pool, adminAccount } =
    await createPostgresAgentApp(t, {
      label: "saved-account",
      poolOptions: { max: 1, connectionTimeoutMillis: 5000 },
      authSecret: "saved-account-test-auth-secret-minimum-32-bytes",
      secretDriver,
      ...(pluginWorkflow && {
        sandboxDriver: createProviderSandboxDriver({ id: "openshell-sandbox" }).driver,
      }),
      controllerOptions: {
        preparedTokens,
        ...(pluginWorkflow && {
          nativeWorkerSupport: "custom-image",
          credentialProxyCapacity: { sandboxOperations: 1 },
          driverConfigurations: [savedAccountSandboxRegistration],
        }),
      },
      appOptions: {
        publicOrigin,
        ...(reports && { readManagedMcpToolNames: reports.readTools }),
        // Only the fixture MCP metadata is supplied locally. OCC creates the template and
        // Keycloak serves authorization, token exchange, and user logins for this issuer.
        async discoverMcpAuthorization(serverUrl: string, selectedIssuer?: string) {
          if (pluginWorkflow) {
            assert.equal(serverUrl, reports.url);
          }
          assert.equal(selectedIssuer, issuer);
          return {
            serverUrl,
            resource: reports ? new URL(reports.url).origin : discoveredResource,
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
    scopes: ["openid"],
  };
  const template = await inject("POST", "/connection-templates", {
    ...manualConfig,
    displayName: "Keycloak",
    namespaceId,
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
    connectionTemplateId: template.json().data.id,
    connectionTemplateVersion: template.json().data.current.version,
    displayName: "Saved accounts",
    clientId,
    clientSecret,
    tokenEndpointAuthMethod: "client_secret_basic",
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const oauthClientId = registered.json().data.id;
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
    // Keycloak also grants this client's default profile scope when the person requests only
    // openid. Completing the real callback must retain both the request and what Keycloak granted.
    const broader = await owner("POST", connections, {
      connectionTemplateId: unrestrictedManual.json().data.id,
      selectedScopes: ["openid"],
    });
    assert.equal(broader.statusCode, 201, broader.body);
    const { authorizationUrl, credentialSourceId: broaderId } = broader.json().data;
    assert.equal(new URL(authorizationUrl).searchParams.get("scope"), "openid");
    const callback = await owner(
      "GET",
      await consentRedirect(authorizationUrl, "alice", secrets.users.alice.password),
    );
    assert.match(String(callback.headers.location), /connection=connected/);
    const connection = (await owner("GET", connections))
      .json()
      .data.find((row: { credentialSourceId: string }) => row.credentialSourceId === broaderId);
    assert.deepEqual(connection.requestedScopes, ["openid"]);
    assert.deepEqual([...connection.grantedScopes].sort(), ["openid", "profile"]);
    // The database still forbids widening an existing grant after a renewal narrowed it.
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const setGrant = (scopes: string[]) =>
        db.query(
          "UPDATE occ.saved_connections SET granted_scopes=$2 WHERE credential_source_id=$1",
          [broaderId, scopes],
        );
      await setGrant(["profile"]);
      await assert.rejects(setGrant(["openid", "profile"]), { code: "55000" });
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
    assert.equal((await owner("DELETE", connections + "/" + broaderId)).statusCode, 204);
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
    manual,
    recipient,
    issuerAdmin: secrets.admin,
    async setIssuedLifetime(seconds: number) {
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
    },
    rotateClientSecret: async (source?: string) => {
      const replacement = await rotateKeycloakClientSecret(
        issuer!,
        secrets.admin,
        clientId,
        clientSecret,
        tokenUrl,
      );
      clientSecret = replacement;
      if (source) {
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
      }
      const updatedClient = await inject("POST", `/oauth-clients/${oauthClientId}/rotate-secret`, {
        clientSecret: replacement,
      });
      assert.equal(updatedClient.statusCode, 200);
      assert.equal(updatedClient.json().data.id, oauthClientId);
      return replacement;
    },
    preparedTokens,
    manualConfig,
    mcpConfig,
    setDiscoveredResource(resource: string) {
      discoveredResource = resource;
    },
    oauthClientId,
    tokenUrl,
    clientId,
    makeNamespace,
    secretDriver,
    namespaceId,
    base,
    connections,
    input,
    owner,
    ownerId,
    begin,
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
      manual,
      recipient,
      setIssuedLifetime,
      preparedTokens,
      rotateClientSecret,
      oauthClientId,
      tokenUrl,
      clientId,
      makeNamespace,
      secretDriver,
      namespaceId,
      base,
      connections,
      input,
      owner,
      ownerId,
      begin,
      manualConfig,
      mcpConfig,
      setDiscoveredResource,
    } = await oauthAccounts(t);
    assert.ok(issuer);
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
    await rotateClientSecret();
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
    const mcp = await inject("GET", "/connection-templates/" + input.connectionTemplateId);
    assert.equal(mcp.statusCode, 200, mcp.body);
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
    setDiscoveredResource("https://resource.connections.test");
    const otherResource = await inject(
      "PATCH",
      "/connection-templates/" + mcp.json().data.id,
      mcpConfig,
    );
    assert.equal(otherResource.statusCode, 200, otherResource.body);
    assert.deepEqual((await currentMcp()).destinations, []);
    setDiscoveredResource(mcpConfig.serverUrl);
    const otherMcp = await inject("PATCH", "/connection-templates/" + mcp.json().data.id, {
      ...mcpConfig,
      serverUrl: "https://other.connections.test/mcp",
    });
    assert.equal(otherMcp.statusCode, 200, otherMcp.body);
    assert.deepEqual((await currentMcp()).destinations, []);
    // The original grant must refresh after the provider and the OCE administrator rotate the client.
    const replacement = await rotateClientSecret(source);
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

test(
  "Plugin consent attaches its saved account only while the Agent still permits the requested binding",
  lane,
  async (t) => {
    assert.ok(issuer);
    const origin = await createSavedAccountOrigin(t, issuer);
    const reportsUrl = String(origin.url);
    const subjects: string[] = [];
    // Only the MCP tool reader is controlled. Keycloak must accept the real
    // bearer supplied by OCC and identify the user who granted this account.
    const readTools = t.mock.fn(async (endpoint: string, token: string) => {
      assert.equal(endpoint, reportsUrl);
      const user = await fetch(`${issuer}/protocol/openid-connect/userinfo`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(user.status, 200);
      subjects.push((await user.json()).sub);
      return new Set(["list_reports", "publish_report"]);
    });
    const {
      app,
      makeNamespace,
      controller,
      state,
      pool,
      secretDriver,
      preparedTokens,
      inject,
      namespaceId,
      base,
      connections,
      input,
      owner,
      ownerId,
      begin,
      oauthClientId,
      tokenUrl,
      issuerAdmin,
      setIssuedLifetime,
    } = await oauthAccounts(t, { url: reportsUrl, readTools });
    const pluginId = "test-keycloak";
    const remoteId = "catalog/reports-and-mail";
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
        },
      },
    };
    const reports = {
      ...mcp,
      id: pluginId,
      releaseSha256,
      url: reportsUrl,
      slotId: "reports",
      endpoint: {
        host: new URL(reportsUrl).hostname,
        port: Number(new URL(reportsUrl).port),
        path: "/mcp",
      },
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
    // issuer, recipient and binding checks for each slot.
    const plugin: PluginDriver = {
      id: "keycloak-plugin-driver",
      harnessId: "openclaw",
      capability: "plugin",
      implementation: "keycloak-fixture",
      discoveryCredential: "none",
      policyCapabilities: new OCCPluginDriver().policyCapabilities,
      validatePolicies() {},
      async listCatalog() {
        return [];
      },
      async getCatalogPlugin({ pluginId: requested }) {
        assert.ok(requested === pluginId || requested === remoteId);
        return { id: pluginId, remoteId, name: "Reports and mail", tools: [] };
      },
      credentials: {
        choices() {
          return [
            { id: slotId, label: "Mail" },
            { id: "reports", label: "Reports", toolDiscovery: true as const },
            { id: "unrelated", label: "Unrelated service" },
          ].map((slot) => ({ ...slot, pluginId, releaseSha256, sources: [] }));
        },
        validate() {},
        connectionSlot(selections, requestedPlugin, requestedSlot) {
          if (requestedPlugin !== pluginId) {
            return undefined;
          }
          return managedPluginAccountSlot(
            Object.hasOwn(primary.credentials, requestedSlot) ? primary : reports,
            selections,
            requestedSlot,
          );
        },
      },
    };
    const codexCatalog = new CodexPluginDriver({ catalogSource: "openai-curated" });
    // Register Codex first: saved OpenClaw slots must never depend on catalog order.
    controller.installPluginDrivers([codexCatalog, plugin]);
    const config = await owner("POST", `${base}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-5.1"),
    });
    assert.equal(config.statusCode, 201, config.body);
    const agents = `${base}/agents`;
    const codexConfig = await owner("POST", `${base}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("codex", "gpt-5.1"),
    });
    assert.equal(codexConfig.statusCode, 201, codexConfig.body);
    const codexDraft = await owner("POST", agents, {
      name: "Codex catalog isolation",
      executionMode: "dedicated",
      configurationId: codexConfig.json().data.id,
    });
    assert.equal(codexDraft.statusCode, 201, codexDraft.body);
    const codexCapabilities = await owner(
      "GET",
      `${agents}/${codexDraft.json().data.id}/plugins/capabilities`,
    );
    assert.equal(codexCapabilities.statusCode, 200, codexCapabilities.body);
    assert.equal(codexCapabilities.json().data.driver.id, codexCatalog.id);
    assert.equal(codexCapabilities.json().data.credentialSlots, undefined);

    const modelKey = randomUUID();
    const harnessSecret = await owner("POST", base + "/secrets", {
      name: "Harness key",
      value: modelKey,
    });
    assert.equal(harnessSecret.statusCode, 201, harnessSecret.body);
    const harnessRef = harnessSecret.json().data.ref;
    const agent = async (name: string) => {
      const created = await owner("POST", agents, {
        name,
        executionMode: "dedicated",
        configurationId: config.json().data.id,
        harnessAuth: { method: "api_key", source: harnessRef },
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
    // Consent belongs to the reviewed OpenClaw slot. A changed draft must not attach
    // that account through a different Harness catalog when the browser returns.
    const changingConfig = await owner("POST", `${base}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-5.1"),
    });
    assert.equal(changingConfig.statusCode, 201, changingConfig.body);
    const changingAgent = await owner("POST", agents, {
      name: "Consent catalog change",
      executionMode: "dedicated",
      configurationId: changingConfig.json().data.id,
      plugins: { [pluginId]: { enabled: true } },
    });
    assert.equal(changingAgent.statusCode, 201, changingAgent.body);
    const changingId = changingAgent.json().data.id;
    const changingConsent = await begin(`${path(changingId)}/connections`, {
      ...input,
      connectionTemplateVersion: 2,
      pluginId,
      slotId,
      releaseSha256,
      expectedCredentialSourceId: null,
    });
    const changedConfig = await owner(
      "PATCH",
      `${base}/configurations/${changingConfig.json().data.id}`,
      { values: createHarnessConfiguration("codex", "gpt-5.1") },
    );
    assert.equal(changedConfig.statusCode, 200, changedConfig.body);
    const returned = await owner("GET", changingConsent.callback);
    assert.equal(returned.statusCode, 303, returned.body);
    const returnedLocation = new URL(String(returned.headers.location), publicOrigin);
    assert.equal(returnedLocation.pathname, `/console/agents/${changingId}`);
    assert.equal(returnedLocation.searchParams.get("connection"), "saved");
    assert.deepEqual(await attached(changingId), []);
    assert.equal(await canUse(changingId, changingConsent.id), false);
    assert.ok(
      (await owner("GET", connections))
        .json()
        .data.some(
          (row: { credentialSourceId: string }) => row.credentialSourceId === changingConsent.id,
        ),
      "the completed account stays available to its owner",
    );
    const reportValues = {
      mode: "mcp_discovery",
      serverUrl: reportsUrl,
      issuer,
      scopes: ["openid"],
    };
    const reportTemplate = await inject("POST", "/connection-templates", {
      ...reportValues,
      namespaceId,
      displayName: "Reports",
    });
    assert.equal(reportTemplate.statusCode, 201, reportTemplate.body);
    const reportTemplateId = reportTemplate.json().data.id as string;
    await t.test(
      "only administrators can configure a missing OAuth client from a compatible plugin slot",
      async () => {
        const reportsSlot = (slots: readonly AgentPluginCredentialSlot[]) => {
          const slot = slots.find(
            (choice) => choice.pluginId === pluginId && choice.id === "reports",
          );
          assert.ok(slot);
          return slot;
        };
        const details = (actor = owner) =>
          actor("POST", agents + "/plugins/details", {
            harnessId: "openclaw",
            executionMode: "dedicated",
            pluginId: remoteId,
          });
        // One matching template is shared by the Installation, one by this Namespace.
        // A third belongs to a different Namespace. The registered Google-style manual
        // template has the same issuer but cannot authorize this MCP recipient.
        const global = await inject("POST", "/connection-templates", {
          ...reportValues,
          displayName: "Reports",
        });
        assert.equal(global.statusCode, 201, global.body);
        const elsewhere = await inject("POST", "/connection-templates", {
          ...reportValues,
          displayName: "Other reports",
          namespaceId: await makeNamespace(),
        });
        assert.equal(elsewhere.statusCode, 201, elsewhere.body);
        const before = await details();
        assert.equal(before.statusCode, 200, before.body);
        const slots = before.json().data.credentialSlots as NonNullable<
          import("@openclaw-enterprise/contracts").NamespaceAgentPluginDetails["credentialSlots"]
        >;
        const target = reportsSlot(slots);
        const setup = target.templateSetup;
        assert.ok(setup);
        const savedEditor = await owner("GET", path(b) + "/plugins/capabilities");
        assert.equal(savedEditor.statusCode, 200, savedEditor.body);
        assert.deepEqual(reportsSlot(savedEditor.json().data.credentialSlots).templateSetup, setup);
        assert.deepEqual(setup.issuers, [issuer]);
        assert.equal(setup.mcpServerUrl, reportsUrl);
        assert.deepEqual(
          [...setup.unregisteredTemplates].sort((a, b) => a.id.localeCompare(b.id)),
          [
            { id: global.json().data.id, displayName: "Reports" },
            { id: reportTemplateId, displayName: "Reports", namespaceId },
          ].sort((a, b) => a.id.localeCompare(b.id)),
        );
        assert.deepEqual(slots.find((slot) => slot.id === "reports")?.connectionTemplates, []);
        assert.deepEqual(
          slots.find((slot) => slot.id === "unrelated")?.templateSetup?.unregisteredTemplates,
          [],
        );
        const unavailable = await owner("POST", connections, {
          connectionTemplateId: reportTemplateId,
          selectedScopes: ["openid"],
        });
        assert.equal(unavailable.statusCode, 409, unavailable.body);

        // Enroll a second user with a configured Role that can create Agents and
        // credentials. Being able to connect an account must not expose admin setup.
        const email = `slot-editor-${randomUUID()}@example.test`;
        const password = randomUUID();
        const human = await inject("POST", "/api/auth/accounts", {
          name: "Slot editor",
          email,
          password,
        });
        assert.equal(human.statusCode, 201, human.body);
        // The exact-resource IAM API cannot grant collection create. Seed the Namespace
        // Role and binding that a configured Agent/credential creator holds.
        await pool.query(
          `WITH role AS (
             INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
             VALUES ($1, $2, 'Agent and connection creator', $3::jsonb) RETURNING id
           )
           INSERT INTO occ.iam_access_bindings (id, namespace_id, identity_subject_id, role_id)
           SELECT $4, $2, $5, id FROM role`,
          [
            `role_slot_creator_${randomUUID()}`,
            namespaceId,
            JSON.stringify([
              { action: "create", resourceKind: "agent" },
              { action: "create", resourceKind: "credential_source" },
            ]),
            `binding_${randomUUID()}`,
            human.json().data.principalId,
          ],
        );
        const member = await accountSession(app, email, password);
        const memberDetails = await details(member);
        assert.equal(memberDetails.statusCode, 200, memberDetails.body);
        const memberSlot = reportsSlot(memberDetails.json().data.credentialSlots);
        assert.equal(memberSlot.connectAccount, true);
        assert.equal(memberSlot.templateSetup, undefined);
        assert.equal((await member("GET", "/connection-templates")).statusCode, 403);

        // Assigning a registered client makes only that template eligible at the next read.
        const updated = await inject("PATCH", "/connection-templates/" + reportTemplateId, {
          ...reportValues,
          oauthClientId,
        });
        assert.equal(updated.statusCode, 200, updated.body);
        const after = await details();
        assert.equal(after.statusCode, 200, after.body);
        const ready = (after.json().data.credentialSlots as typeof slots).find(
          (slot) => slot.id === "reports",
        );
        assert.deepEqual(
          ready?.connectionTemplates?.map(({ id }) => id),
          [reportTemplateId],
        );
        assert.equal(ready?.templateSetup, undefined);
      },
    );
    const reportInput = {
      connectionTemplateId: reportTemplate.json().data.id,
      selectedScopes: ["openid"],
    };
    const report = await begin(connections, reportInput, "carol");
    assert.match(
      String((await owner("GET", report.callback)).headers.location),
      /connection=connected/,
    );
    const [carol] = await keycloakRealmAdmin(
      issuer,
      issuerAdmin,
      "GET",
      "/users?username=carol&exact=true",
    );
    await t.test(
      "standalone consent stages a slot until Agent creation grants access",
      async (createTest) => {
        const readAgents = async () => {
          const result = await owner("GET", agents);
          assert.equal(result.statusCode, 200, result.body);
          return result
            .json()
            .data.map((entry: { id: string }) => entry.id)
            .sort();
        };
        const originalAgents = await readAgents();
        const details = await owner("POST", agents + "/plugins/details", {
          harnessId: "openclaw",
          executionMode: "dedicated",
          pluginId: remoteId,
        });
        assert.equal(details.statusCode, 200, details.body);
        const slots = details.json().data.credentialSlots as NonNullable<
          import("@openclaw-enterprise/contracts").NamespaceAgentPluginDetails["credentialSlots"]
        >;
        const reportsSlot = slots.find((slot) => slot.id === "reports");
        assert.equal(reportsSlot?.releaseSha256, releaseSha256);
        assert.equal(
          reportsSlot?.sources.find((source) => source.id === report.id)?.toolDiscovery,
          "caller",
        );
        assert.ok(
          reportsSlot.connectionTemplates?.some(
            (template) => template.id === reportInput.connectionTemplateId,
          ),
        );
        async function enroll(name: string) {
          const email = `discovery-${randomUUID()}@example.test`;
          const password = randomUUID();
          const human = await inject("POST", "/api/auth/accounts", { name, email, password });
          assert.equal(human.statusCode, 201, human.body);
          const principalId = human.json().data.principalId;
          const request = await accountSession(app, email, password);
          async function grantExact(kind: string, actions: string[], ids: string[]) {
            const role = await inject("POST", base + "/iam/roles", {
              name,
              permissions: actions.map((action) => ({ action, resourceKind: kind })),
            });
            assert.equal(role.statusCode, 201, role.body);
            for (const resourceId of ids) {
              const binding = await inject("POST", base + "/iam/access-bindings", {
                roleId: role.json().data.id,
                subjectKind: "identity",
                subjectId: principalId,
                resourceKind: kind,
                resourceId,
              });
              assert.equal(binding.statusCode, 201, binding.body);
            }
          }
          return { principalId, request, grantExact };
        }
        const operator = await enroll("Reports account operator");
        const endpoint = (id: string) => `${base}/credential-sources/${id}/mcp-tools`;
        const discover = (sourceId: string, slot = "reports", request = operator.request) =>
          request("POST", endpoint(sourceId), { pluginId: remoteId, slot });
        const resolve = createTest.mock.method(preparedTokens, "resolve");
        // Authorization and recipient matching must precede resolving or sending any bearer.
        const denied = await discover(report.id);
        assert.equal(denied.statusCode, 403, denied.body);
        for (const refused of [
          await discover(grant.id, "reports", owner),
          await discover(report.id, "unrelated", owner),
        ]) {
          assert.ok(refused.statusCode >= 400 && refused.statusCode < 500, refused.body);
        }
        assert.equal(resolve.mock.callCount(), 0);
        assert.equal(readTools.mock.callCount(), 0);
        // The operator can use this reference but cannot browse its source metadata or create Agents.
        await operator.grantExact("credential_source", ["operate"], [report.id]);
        const inventory = await discover(report.id);
        assert.equal(inventory.statusCode, 200, inventory.body);
        const tools = ["list_reports", "publish_report"].map((name) => ({
          id: name,
          name,
          ownerId: pluginId,
        }));
        assert.deepEqual(inventory.json().data.tools, tools);
        assert.deepEqual(subjects, [carol.id]);
        assert.equal(resolve.mock.callCount(), 1);
        resolve.mock.restore();
        assert.equal(await canUse(a, report.id), false);
        assert.deepEqual(await readAgents(), originalAgents);
        const selection = (sourceId: string, toolNames: string[] = ["list_reports"]) => ({
          [pluginId]: {
            enabled: true,
            driverPolicy: { releaseSha256, credentials: { reports: sourceId }, toolNames },
          },
        });
        const fields = {
          name: "Reports from Create",
          executionMode: "dedicated",
          harnessAuth: { method: "api_key", source: harnessRef },
        };
        const configuration = {
          kind: "agent",
          values: createHarnessConfiguration("openclaw", "gpt-5.1"),
        };
        const plan = { ...fields, configuration, plugins: selection(report.id) };
        const cannotCreate = await operator.request("POST", agents + "/validate", plan);
        assert.equal(cannotCreate.statusCode, 403, cannotCreate.body);
        const validated = await owner("POST", agents + "/validate", plan);
        assert.equal(validated.statusCode, 204, validated.body);

        // A credential for another recipient cannot grant a new Agent access. Browsing,
        // preflight and the failed save leave the user's standalone account available.
        const create = (sourceId: string) =>
          owner("POST", agents, {
            ...fields,
            configurationId: config.json().data.id,
            plugins: selection(sourceId),
          });
        const wrongRecipient = await create(grant.id);
        assert.equal(wrongRecipient.statusCode, 409, wrongRecipient.body);
        assert.deepEqual(await readAgents(), originalAgents);
        assert.equal(await canUse(a, report.id), false);
        const created = await create(report.id);
        assert.equal(created.statusCode, 201, created.body);
        const verifyBinding = async (id: string, expectedTools: string[]) => {
          const policy = (await draft(id)).plugins[pluginId].driverPolicy;
          assert.equal(policy.credentials.reports, report.id);
          assert.deepEqual(policy.toolNames, expectedTools);
          assert.deepEqual(await attached(id), [report.id]);
          assert.equal(await canUse(id, report.id), true);
          assert.equal(await canUse(id, grant.id), false);
        };
        await verifyBinding(created.json().data.id, ["list_reports"]);

        await createTest.test(
          "an Agent editor discovers through that Agent's grant until it is detached",
          async () => {
            const savedAgent = created.json().data.id;
            const editor = await enroll("Reports Agent editor");
            await editor.grantExact("agent", ["read", "update"], [savedAgent, b]);
            const direct = () => discover(report.id, "reports", editor.request);
            const throughAgent = (id: string) =>
              editor.request("POST", path(id) + "/plugins/details", {
                pluginId,
                managedConnection: { slot: "reports", sourceId: report.id },
              });
            const before = readTools.mock.callCount();
            const noPersonalAccess = await direct();
            assert.equal(noPersonalAccess.statusCode, 403, noPersonalAccess.body);
            const wrongAgent = await throughAgent(b);
            assert.ok(wrongAgent.statusCode >= 400 && wrongAgent.statusCode < 500, wrongAgent.body);
            assert.equal(readTools.mock.callCount(), before);

            const capabilities = await editor.request(
              "GET",
              path(savedAgent) + "/plugins/capabilities",
            );
            assert.equal(capabilities.statusCode, 200, capabilities.body);
            const account = (
              capabilities.json().data.credentialSlots as AgentPluginCredentialSlot[]
            )
              .find((slot) => slot.id === "reports")
              ?.sources.find((source) => source.id === report.id);
            assert.equal(account?.name, report.id);
            assert.equal(account?.toolDiscovery, "agent");
            const permitted = await throughAgent(savedAgent);
            assert.equal(permitted.statusCode, 200, permitted.body);
            assert.deepEqual(
              permitted.json().data.tools.map((tool: { name: string }) => tool.name),
              ["list_reports", "publish_report"],
            );
            assert.equal(
              (await direct()).statusCode,
              403,
              "discovering with an Agent grant must not give its editor personal use",
            );
            const clear = await owner("PATCH", path(savedAgent), {
              configurationId: config.json().data.id,
              plugins: { [pluginId]: { enabled: true } },
            });
            assert.equal(clear.statusCode, 200, clear.body);
            const detach = await owner("DELETE", `${path(savedAgent)}/connections/${report.id}`);
            assert.equal(detach.statusCode, 204, detach.body);
            assert.equal(await canUse(savedAgent, report.id), false);
            const after = await throughAgent(savedAgent);
            assert.ok(after.statusCode >= 400 && after.statusCode < 500, after.body);
            assert.equal(readTools.mock.callCount(), before + 1);
          },
        );

        // Dedicated installations can queue Create instead. The queue request and an
        // identical retry precede the worker's Agent row, slot binding and IAM grant.
        const originalCompute = controller.selectedDriver("compute");
        const originalConfiguration = controller.selectedDriver("configuration");
        const compute = createRuntimeComputeDriver();
        const configDriver = createTestConfigurationDriver({
          id: "provision-saved-account",
          exact: true,
        });
        controller.registerDriver(compute);
        controller.registerDriver(configDriver);
        controller.selectDriver("compute", compute.id);
        controller.selectDriver("configuration", configDriver.id);
        try {
          const queuedInput = {
            ...plan,
            plugins: selection(report.id, []),
            name: "Queued Reports Agent",
            requestId: `req_${randomUUID()}`,
          };
          const queued = await owner("POST", agents + "/provision", queuedInput);
          assert.equal(queued.statusCode, 202, queued.body);
          const job = queued.json().data.provisioning;
          const replay = await owner("POST", agents + "/provision", queuedInput);
          assert.equal(replay.statusCode, 202, replay.body);
          assert.equal(replay.json().data.provisioning.workId, job.workId);
          assert.equal((await readAgents()).length, originalAgents.length + 1);
          const runJob = async (workId: string) => {
            // Use a separate test queue to lock other jobs. OCC still creates Agents
            // and grants through its single-connection application pool.
            const queuePool = new Pool({ ...pool.options, max: 2 });
            const claim = await claimIsolatedWork(queuePool, { workId }).finally(() =>
              queuePool.end(),
            );
            assert.ok(claim);
            return controller.processAgentProvisioning(claim, resolveApprovedHarness);
          };
          await runJob(job.workId);
          const status = await owner("GET", job.url);
          assert.equal(status.statusCode, 200, status.body);
          const queuedAgent = status.json().data.agentId;
          assert.ok(queuedAgent, status.body);
          await verifyBinding(queuedAgent, []);

          // Withdraw use of a separate saved account after queue admission. Its
          // durable IAM restriction must apply when the worker attempts Agent creation.
          const withdrawn = await begin(connections, reportInput);
          assert.equal((await owner("GET", withdrawn.callback)).statusCode, 303);
          const later = await owner("POST", agents + "/provision", {
            ...queuedInput,
            plugins: selection(withdrawn.id),
            requestId: `req_${randomUUID()}`,
            name: "Access withdrawn before Create",
          });
          assert.equal(later.statusCode, 202, later.body);
          const beforeWithdrawal = await readAgents();
          await pool.query(
            "INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id) VALUES ($1,$2,'operate','credential_source',$3)",
            [`restriction_${randomUUID()}`, namespaceId, withdrawn.id],
          );
          const outcome = await runJob(later.json().data.provisioning.workId);
          assert.equal(outcome.outcome, "permanent");
          assert.deepEqual(await readAgents(), beforeWithdrawal);
        } finally {
          controller.selectDriver("configuration", originalConfiguration.id);
          controller.selectDriver("compute", originalCompute.id);
        }
        const accounts = await owner("GET", connections);
        assert.equal(accounts.statusCode, 200, accounts.body);
        assert.equal(
          accounts
            .json()
            .data.find(
              (item: { credentialSourceId: string }) => item.credentialSourceId === report.id,
            ).ownerPrincipalId,
          ownerId,
        );
      },
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
    const bindings = { account: grant.id, reports: report.id };
    const updated = await saveBindings(bindings);
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual((await draft(slotAgent)).plugins[pluginId].driverPolicy.credentials, bindings);
    assert.deepEqual((await attached(slotAgent)).sort(), [grant.id, report.id].sort());
    assert.equal(await canUse(slotAgent, grant.id), true);
    assert.equal(await canUse(slotAgent, report.id), true);

    // Replacing an already-saved slot requires the previous ID and fresh consent. Other
    // bindings and previously delegated usage survive the replacement.
    const currentOptions = await owner(
      "GET",
      `${path(slotAgent)}/plugins/${pluginId}/credentials/reports/connection-templates`,
    );
    assert.equal(currentOptions.statusCode, 200, currentOptions.body);
    const currentReport = currentOptions
      .json()
      .data.find((item: { id: string }) => item.id === reportTemplateId);
    assert.ok(currentReport);
    const replacement = await begin(`${path(slotAgent)}/connections`, {
      ...reportInput,
      connectionTemplateVersion: currentReport.version,
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
    assert.equal(detached.statusCode, 204, detached.body);
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

    // Grant both Agents their Harness key so only the selected plugin account
    // distinguishes the two deployments. OpenShell is unconfigured.
    for (const id of [slotAgent, b]) {
      await grantAgentSecretOperate(pool, { namespaceId, id }, harnessRef.id);
    }
    const refused = await owner("POST", path(slotAgent) + "/deploy");
    assert.equal(refused.statusCode, 409, refused.body);
    assert.match(refused.json().error.message, /Credential Proxy.*request-time injection/);
    const revisions = await owner("GET", path(slotAgent) + "/revisions");
    assert.equal(revisions.statusCode, 200, revisions.body);
    assert.deepEqual(revisions.json().data, []);

    // An account grant alone authorizes future use. It installs no credential
    // on this revision and leaves the other Agent's grant intact.
    const admitted = await owner("POST", path(b) + "/deploy");
    assert.equal(admitted.statusCode, 202, admitted.body);
    assert.deepEqual(admitted.json().data.credentialSources ?? [], []);
    assert.equal(await canUse(b, grant.id), true);
    assert.equal(await canUse(slotAgent, grant.id), true);

    // Install the selected terminal authority and admit two actual revisions for the same
    // saved grant. The fixture stands in for Compute activation and Gateway inventory.
    // Register the model keys only after both delivery drivers are selected, as the
    // Create Agent form does. Only the external OpenShell provider RPC store is controlled.
    const proxyFixture = await savedAccountProxyFixture(t);
    const runtime = await installSavedAccountProxy(proxyFixture, controller);
    const gatewayId = CREDENTIAL_GATEWAY_FIXTURE_ID;
    const store = openShellProviderStore({
      id: "gateway-model-provider",
      type: "openshell",
      configuration: { endpoint: "http://127.0.0.1:9" },
      drivers: {
        sandbox: savedAccountSandboxRegistration.driverId,
        credential_gateway: gatewayId,
      },
    });
    t.after(() => store.backend.client.close());
    const gateway = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/local/bin/openclaw"], toolBinaries: ["/usr/bin/curl"] },
      { id: gatewayId, backend: store.backend },
    );
    controller.registerDriver(gateway);
    controller.selectDriver("credential_gateway", gateway.id);
    const kubernetes = installSavedAccountPlacement(controller, runtime.owner, gateway);
    const selectedPlugin = {
      [pluginId]: {
        enabled: true,
        driverPolicy: {
          releaseSha256,
          credentials: { reports: report.id },
          toolNames: ["list_reports"],
        },
      },
    };
    // The Console validates the login method first, then registers the saved Secret
    // and supplies the returned source ID to Create.
    const preflight = await owner("POST", agents + "/validate", {
      name: "Agent keeping access",
      executionMode: "dedicated",
      configuration: { kind: "agent", values: createHarnessConfiguration("openclaw", "gpt-5.1") },
      harnessAuth: { method: "api_key" },
      plugins: selectedPlugin,
    });
    assert.equal(preflight.statusCode, 204, preflight.body);
    // A separate ordinary tool gets its own credential and API receiver.
    const toolToken = randomUUID();
    const toolSecret = await owner("POST", base + "/secrets", {
      name: "Reports tool token",
      value: toolToken,
    });
    assert.equal(toolSecret.statusCode, 201, toolSecret.body);
    const model = await owner("POST", base + "/credential-sources", {
      name: "Harness model",
      type: "openai",
      config: {},
      secrets: { api_key: harnessRef },
    });
    const tool = await owner("POST", base + "/credential-sources", {
      name: "Reports API",
      type: "bearer-token",
      config: { host: "tools.example.test", path: "/reports/**", env_var: "REPORTS_TOOL_TOKEN" },
      secrets: { token: toolSecret.json().data.ref },
    });
    assert.equal(model.statusCode, 201, model.body);
    assert.equal(tool.statusCode, 201, tool.body);
    const modelSource: string = model.json().data.id;
    const toolSource: string = tool.json().data.id;
    for (const [sourceId, key, value] of [
      [modelSource, "OPENAI_API_KEY", modelKey],
      [toolSource, "REPORTS_TOOL_TOKEN", toolToken],
    ] as const) {
      const registered = await state.read((unit) =>
        unit.credentialSources.findCredentialSource(namespaceId, sourceId),
      );
      assert.equal(registered?.ownerCapability, "credential_gateway");
      assert.equal(registered?.egress, undefined);
      const provider = [...store.providers.values()].find(
        (entry) => entry.name === openShellProviderName(sourceId),
      );
      assert.ok(
        provider?.credentials[key] === value,
        "the Gateway received the selected source material",
      );
    }
    assert.equal(store.mutations.filter((operation) => operation === "createProvider").length, 2);
    const modelRole = await owner("POST", base + "/iam/roles", {
      name: "Use model credential",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    });
    assert.equal(modelRole.statusCode, 201, modelRole.body);
    const ns = await state.read((view) => view.namespaces.findNamespace(namespaceId));
    assert.ok(ns);
    const admittedPeers = [];
    // Stable test Sandbox IDs let an external SPIRE authority attest distinct supervisor processes.
    for (const [name, sandboxId] of [
      ["Agent with renewed access", "00000000-0000-4000-8000-000000000001"],
      ["Agent keeping access", "00000000-0000-4000-8000-000000000002"],
    ] as const) {
      const withTool = name === "Agent with renewed access";
      const modelSelection = {
        configurationId: config.json().data.id,
        harnessAuth: { method: "credential_source", sourceId: modelSource },
        credentialSources: [{ sourceId: modelSource }],
      };
      const created = await owner("POST", agents, {
        name,
        executionMode: "dedicated",
        ...modelSelection,
        ...(withTool ? {} : { plugins: selectedPlugin }),
      });
      assert.equal(created.statusCode, 201, created.body);
      const { id, servicePrincipalId } = created.json().data;
      async function grantGatewaySource(sourceId: string) {
        const permission = await owner("POST", base + "/iam/access-bindings", {
          roleId: modelRole.json().data.id,
          subjectKind: "identity",
          subjectId: servicePrincipalId,
          resourceKind: "credential_source",
          resourceId: sourceId,
        });
        assert.equal(permission.statusCode, 201, permission.body);
      }
      await grantGatewaySource(modelSource);
      if (withTool) {
        // A plugin-only Proxy also permits a normal model-only Create and deploy.
        const modelOnly = await owner("POST", path(id) + "/deploy");
        assert.equal(modelOnly.statusCode, 202, modelOnly.body);
        const revision = await state.read((unit) =>
          unit.revisions.findRevision(namespaceId, id, modelOnly.json().data.id),
        );
        assert.ok(revision);
        kubernetes.validateExecutionAdmission(revision, "stored");
        assert.deepEqual(revision.credentialSources, [
          { sourceId: modelSource, credentialGatewayId: gateway.id, sourceType: "openai" },
        ]);
        assert.equal(revision.plugins?.savedAccounts, undefined);
        const save = await owner("PATCH", path(id), {
          ...modelSelection,
          plugins: selectedPlugin,
          credentialSources: [modelSource, toolSource].map((sourceId) => ({ sourceId })),
        });
        assert.equal(save.statusCode, 200, save.body);
        await grantGatewaySource(toolSource);
      }
      const deployment = await owner("POST", path(id) + "/deploy");
      assert.equal(deployment.statusCode, 202, deployment.body);
      const revision = await state.read((view) =>
        view.revisions.findRevision(namespaceId, id, deployment.json().data.id),
      );
      assert.ok(revision);
      kubernetes.validateExecutionAdmission(revision, "stored");
      if (withTool) {
        // An older v2 row without this Compute admission must stop before any workload is prepared.
        const { admission: _admission, ...computeIdentity } = revision.compute;
        const unapproved = { ...revision, compute: computeIdentity };
        await assert.rejects(
          kubernetes.prepareRevision(unapproved),
          /exact paired Compute release/,
        );
        await assert.rejects(
          kubernetes.activateRevision(unapproved),
          /exact paired Compute release/,
        );
      }
      assert.deepEqual(revision.credentialSources, [
        { sourceId: modelSource, credentialGatewayId: gateway.id, sourceType: "openai" },
        ...(withTool
          ? [{ sourceId: toolSource, credentialGatewayId: gateway.id, sourceType: "bearer-token" }]
          : []),
      ]);
      assert.deepEqual(revision.plugins?.savedAccounts, {
        driver: runtime.driver,
        sourceIds: [report.id],
      });
      assert.ok(
        await state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(namespaceId, id, undefined, revision.id),
        ),
      );
      admittedPeers.push({
        id,
        revision,
        peer: runtime.peer(ns, revision, pluginId, "reports", report.id, sandboxId),
      });
    }
    const [agentA, agentB] = admittedPeers;
    assert.ok(agentA && agentB);
    const allowed = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_reports", arguments: {} },
    };
    const call = (peer: typeof agentA.peer) => origin.dispatch(peer, allowed);
    const tokenVersion = async () => {
      const custody = await state.read((view) =>
        view.savedConnections.findTokenCustody(namespaceId, report.id),
      );
      assert.ok(custody?.scheduledVersion);
      return custody.scheduledVersion;
    };
    // Give the running Agents a genuinely expired token and keep their refresh grant valid.
    // With one database connection the signed request can finish only if authorization releases
    // its transaction before Token Service refreshes and the original request resumes.
    const source = base + "/credential-sources/" + report.id;
    await setIssuedLifetime(5);
    const shortLived = await owner("POST", source + "/rotate");
    assert.equal(shortLived.statusCode, 200, shortLived.body);
    const oauth = preparedTokens.issuer("oauth_refresh_token");
    assert.ok(oauth);
    const expiring = await oauth.status(
      { kind: "oauth_refresh_token", namespaceId, sourceId: report.id },
      t.signal,
    );
    assert.ok(expiring.expiresAt);
    const expiresAt = Date.parse(expiring.expiresAt);
    const expiredVersion = await tokenVersion();
    await setIssuedLifetime(300);
    await waitFor(
      "the plugin's saved access token to expire",
      async () => Date.now() >= expiresAt || undefined,
      { timeoutMs: 15_000, intervalMs: 100 },
    );
    assert.equal(await call(agentA.peer), true);
    const approval = await pool.query<{ expires_at: Date }>(
      "SELECT expires_at FROM occ.request_credential_approvals WHERE recipient_id = $1 AND binding_id = $2 AND consumed",
      [agentA.peer.sandboxId, agentA.peer.bindingConfig.binding_id],
    );
    assert.equal(approval.rowCount, 1);
    assert.ok(
      origin.requests[0]!.receivedAt < approval.rows[0]!.expires_at.getTime(),
      "the resource received the replacement bearer within the original approval",
    );
    assert.equal(origin.requests.length, 1, "the first signed request reached the resource once");
    assert.notEqual(
      await tokenVersion(),
      expiredVersion,
      "that request refreshed the expired token",
    );
    assert.equal(await call(agentB.peer), true);
    assert.deepEqual(
      origin.requests.map((r) => r.subject),
      [carol.id, carol.id],
    );
    const before = origin.requests[0]!.tokenHash;
    assert.equal(before, origin.requests[1]!.tokenHash);
    // A valid Sandbox signature for another registration or audience cannot release a token.
    const target = new URL(origin.url);
    for (const wire of [{ middlewareName: "other-registration" }, { audience: "other-audience" }]) {
      assert.equal(await agentA.peer.authorize(target, allowed, wire), undefined);
    }
    // Token release needs the same authenticated Sandbox, slot and request, once.
    const receipt = await agentA.peer.authorize(target, allowed);
    assert.ok(receipt);
    assert.equal(
      await agentB.peer.redeem(receipt, { bindingId: agentA.peer.bindingConfig.binding_id }),
      undefined,
    );
    assert.equal(
      await agentA.peer.redeem(receipt, { svidAudience: "https://other.example.test/token" }),
      undefined,
    );
    assert.equal(
      await agentA.peer.redeem(receipt, { bindingId: agentB.peer.bindingConfig.binding_id }),
      undefined,
    );
    assert.equal(typeof (await agentA.peer.redeem(receipt)), "string");
    assert.equal(await agentA.peer.redeem(receipt), undefined);
    assert.equal(
      await origin.dispatch(agentA.peer, {
        ...allowed,
        params: { name: "delete_reports", arguments: {} },
      }),
      false,
    );
    assert.equal(origin.requests.length, 2, "a disabled tool never reached the issuer's resource");

    // Refresh the stored grant using the normal API and real issuer, then use the unchanged deployments.
    const initialVersion = await tokenVersion();
    const renewed = await owner("POST", source + "/rotate");
    assert.equal(renewed.statusCode, 200, renewed.body);
    const renewedVersion = await tokenVersion();
    assert.notEqual(
      renewedVersion,
      initialVersion,
      "Token Service committed a new version for the existing grant",
    );
    assert.equal(await call(agentA.peer), true);
    assert.equal(origin.requests[2]!.subject, carol.id);
    const after = origin.requests[2]!.tokenHash;
    assert.notEqual(before, after, "the first request after renewal presented the new bearer");

    // Pause a real token read after Secret Driver returned its value. Commit detach before
    // Credential Proxy's final authorization so even the in-flight request must withhold it.
    const observed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = secretDriver.withValue.bind(secretDriver);
    const pendingRead = t.mock.method(
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
    const inFlight = call(agentA.peer);
    try {
      await Promise.race([
        observed.promise,
        inFlight.then(() => {
          throw new Error("The request finished before selecting its access token.");
        }),
      ]);
      assert.equal(
        await call(agentA.peer),
        false,
        "one held request fills this Sandbox’s configured operation share",
      );
      const clear = await owner("PATCH", path(agentA.id), {
        configurationId: config.json().data.id,
        plugins: { [pluginId]: { enabled: true } },
      });
      assert.equal(clear.statusCode, 200, clear.body);
      const revoke = await owner("DELETE", path(agentA.id) + "/connections/" + report.id);
      assert.equal(revoke.statusCode, 204, revoke.body);
    } finally {
      release.resolve();
      pendingRead.mock.restore();
    }
    assert.equal(await inFlight, false);
    const beforeDenied = secretDriver.calls.length;
    assert.equal(await call(agentA.peer), false);
    assert.equal(
      secretDriver.calls.length,
      beforeDenied,
      "a detached Agent was refused before another token read",
    );
    assert.equal(origin.requests.length, 3, "the detached Agent never reached the resource");
    assert.equal(await call(agentB.peer), true);
    assert.partialDeepStrictEqual(origin.requests[3], {
      subject: carol.id,
      tokenHash: after,
      tool: "list_reports",
    });
    // Route the two calls to distinct OCC instances sharing PostgreSQL and trust configuration.
    // Only the same installed Driver can consume the decision; either instance rejects a replay.
    for (const [registration, accepted] of [
      ["oauth-credential", true],
      ["replacement-credential", false],
    ] as const) {
      const replicaState = new PostgresPlatformState(pool);
      const restarted = new OpenClawController(controller.installation, {
        state: replicaState,
        preparedTokens,
        driverConfigurations: [savedAccountSandboxRegistration],
      });
      // Each replica's native IAM reads from that replica's current transaction.
      const { id, implementation } = controller.selectedDriver("iam");
      const iam = new NativeIAMDriver(replicaState, { id, implementation });
      const compute = controller.selectedDriver("compute");
      for (const driver of [iam, compute]) {
        restarted.registerDriver(driver);
        restarted.selectDriver(driver.capability, driver.id);
      }
      restarted.installPluginDrivers([codexCatalog, plugin]);
      const pair = await installSavedAccountProxy(
        proxyFixture,
        restarted,
        registration,
        "127.0.0.2",
      );
      const peer = pair.peer(
        ns,
        agentB.revision,
        pluginId,
        "reports",
        report.id,
        agentB.peer.sandboxId,
      );
      const firstReplicaReceipt: string | undefined = await agentB.peer.authorize(target, allowed);
      assert.ok(firstReplicaReceipt);
      assert.equal(typeof (await peer.redeem(firstReplicaReceipt)) === "string", accepted);
      assert.equal(typeof (await agentB.peer.redeem(firstReplicaReceipt)) === "string", !accepted);
      assert.equal(typeof (await peer.authorize(target, allowed)) === "string", accepted);
      await pair.close();
    }
    t.diagnostic(
      process.env.OCC_TEST_OPENSHELL_CREDENTIAL_SENDER
        ? "Native OpenShell relay sent four accepted requests and withheld four denied requests."
        : "Signed middleware and SPIFFE token-grant client sent four accepted requests and withheld four denied requests.",
    );
  },
);
