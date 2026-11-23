import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import { validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import {
  DependencyUnavailableError,
  PostgresHumanAuthentication,
  ResourceStateConflictError,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { keycloakRealmAdmin, rotateKeycloakClientSecret } from "../helpers/ci-keycloak-realm.mjs";
import { waitForLockWaiter } from "../helpers/postgres-locks.ts";
import { createBackendFixture } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.ts";
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
  const session = await signInToControllerApp(app, { email, password });
  return (
    method: "GET" | "POST" | "DELETE",
    url: string,
    body?: Record<string, unknown>,
    target = app,
  ) =>
    target.inject({
      method,
      url,
      headers: { host: new URL(session.origin).host, ...authenticatedHeaders(session) },
      ...(body === undefined ? {} : { payload: body }),
    });
}

test(
  "OAuth consent creates an owner-bound Source and refreshes it through the TokenService",
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
    const secretOptions: { createError?: unknown } = {};
    const secretDriver = {
      ...createTestSecretDriver(secretOptions),
      capability: "secret" as const,
    };
    const serverUrl = "https://api.connections.test/mcp";
    let discoveredResource = serverUrl;
    const tokenUrl = `${tokenOrigin}/realms/oce/protocol/openid-connect/token`;
    const { app, controller, state, principal, inject, pool, adminAccount } =
      await createPostgresAgentApp(t, {
        label: "saved-account",
        poolOptions: { max: 1, connectionTimeoutMillis: 5000 },
        authSecret: "saved-account-test-auth-secret-minimum-32-bytes",
        secretDriver,
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
    const storeIdentity = randomUUID();
    await secretDriver.installationSecrets.create(
      {
        installationId: controller.installation.id,
        id: `token-service-store-identity:${secretDriver.id}`,
      },
      storeIdentity,
    );
    const instanceId = await controller.activateTokenServiceInstance("oauth-owner", storeIdentity);
    const tokenOwner = new OCCTokenServiceDriver(
      "oauth-owner",
      controller.installation.id,
      secretDriver.installationSecrets,
      instanceId,
      state,
      undefined,
      new OAuthAccountTokens(state, secretDriver, resolveClient),
    );
    controller.registerDriver(tokenOwner);
    controller.selectDriver("token_service", tokenOwner.id);
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
    const sources = `${base}/credential-sources`;
    async function oauthSource(templateId: string) {
      const result = await inject("GET", sources);
      assert.equal(result.statusCode, 200, result.body);
      const matches = result
        .json()
        .data.filter(
          (entry: { type: string; connectionTemplateId?: string }) =>
            entry.type === "oauth2-refresh-token" && entry.connectionTemplateId === templateId,
        );
      assert.equal(matches.length, 1, "completed consent creates one canonical OAuth Source");
      return matches[0];
    }
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
    // Starting consent creates only a browser-bound attempt; there is no Source to expose or retire.
    assert.deepEqual(Object.keys(manualStart.json().data).sort(), [
      "authorizationUrl",
      "expiresAt",
    ]);
    assert.deepEqual((await inject("GET", sources)).json().data, []);
    const manualState = new URL(manualStart.json().data.authorizationUrl).searchParams.get("state");
    assert.ok(manualState);
    const deniedManual = await inject(
      "GET",
      `/oauth/callback?${new URLSearchParams({ state: manualState, error: "access_denied" })}`,
    );
    assert.match(String(deniedManual.headers.location), /reason=consent_denied/);
    assert.deepEqual((await inject("GET", sources)).json().data, []);
    // A provider-authenticated callback must not publish a ready Source if private custody fails.
    const custodyFailure = await inject("POST", connections, manual);
    assert.equal(custodyFailure.statusCode, 201, custodyFailure.body);
    const failedCallbackPath = await consentRedirect(
      custodyFailure.json().data.authorizationUrl,
      secrets.users.alice.password,
    );
    secretOptions.createError = new DependencyUnavailableError("Secret store unavailable");
    try {
      const failedCallback = await inject("GET", failedCallbackPath);
      assert.match(String(failedCallback.headers.location), /connection=failed/);
      const failedSources = await inject("GET", sources);
      assert.equal(failedSources.statusCode, 200, failedSources.body);
      assert.equal(
        failedSources.json().data.some((entry: { state: string }) => entry.state === "ready"),
        false,
        "failed custody cannot produce a ready Source",
      );
    } finally {
      delete secretOptions.createError;
    }
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
    const peer = await createPostgresAgentApp(t, {
      label: "saved-account",
      authSecret: "saved-account-test-auth-secret-minimum-32-bytes",
    });
    // Consent cannot start on an API replica without its selected TokenService owner.
    const countAttempts = async () =>
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM occ.authentication_states WHERE namespace_id=$1 AND kind='oauth_connection'",
          [namespaceId],
        )
      ).rows[0].count;
    const attemptsBefore = await countAttempts();
    const noOwner = await owner("POST", connections, input, peer.app);
    assert.equal(noOwner.statusCode, 503, noOwner.body);
    assert.equal(noOwner.json().error.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(await countAttempts(), attemptsBefore);
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
    const defaultSource = await oauthSource(unrestrictedManual.json().data.id);
    const defaultsId = defaultSource.id;
    const defaultConsent = defaultSource.consent;
    assert.deepEqual(defaultConsent.requestedScopes, []);
    assert.deepEqual(defaultConsent.grantedScopes, ["profile"]);
    assert.deepEqual(defaultConsent.destinations, manualDestinations);
    // Template changes do not rewrite the original consent recorded on the Source.
    const widened = [
      ...manualDestinations,
      { host: "other.connections.test", port: 443, path: "/**" },
    ];
    const updated = await inject(
      "PATCH",
      "/connection-templates/" + defaultSource.connectionTemplateId,
      {
        ...manualConfig,
        oauthClientId,
        scopes: [],
        destinations: widened,
      },
    );
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(updated.json().data.current.destinations, widened);
    const approved = (await owner("GET", `${sources}/${defaultsId}`)).json().data;
    assert.deepEqual(approved.consent, defaultConsent);
    assert.ok(approved.consent.version < updated.json().data.current.version);
    const templatePath = "/connection-templates/" + defaultSource.connectionTemplateId;
    // The provider grant remains refreshable through its original consent even if the current issuer changes.
    const incompatible = await inject("PATCH", templatePath, {
      ...manualConfig,
      issuer: issuer + "/different",
      scopes: [],
    });
    assert.equal(incompatible.statusCode, 200, incompatible.body);
    assert.deepEqual(
      (await owner("GET", `${sources}/${defaultsId}`)).json().data.consent,
      defaultConsent,
    );
    const originalReceipt = await pool.query(
      `SELECT connection_template_id, oauth_consent_version, oauth_client_id,
              oauth_owner_principal_id, oauth_requested_scopes, oauth_granted_scopes
       FROM occ.credential_sources WHERE id=$1`,
      [defaultsId],
    );
    assert.deepEqual(originalReceipt.rows[0], {
      connection_template_id: defaultSource.connectionTemplateId,
      oauth_consent_version: defaultConsent.version,
      oauth_client_id: oauthClientId,
      oauth_owner_principal_id: ownerId,
      oauth_requested_scopes: [],
      oauth_granted_scopes: ["profile"],
    });
    const refreshIncompatible = await owner(
      "POST",
      `${base}/credential-sources/${defaultsId}/rotate`,
    );
    assert.equal(refreshIncompatible.statusCode, 200, refreshIncompatible.body);
    await keycloakRealmAdmin(issuer, secrets.admin, "DELETE", defaultPath);
    const disconnected = await owner("DELETE", `${sources}/${defaultsId}`);
    assert.equal(disconnected.statusCode, 204, disconnected.body);
    async function begin() {
      const response = await owner("POST", connections, input);
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(
        new URL(response.json().data.authorizationUrl).searchParams.get("scope"),
        "openid",
      );
      return {
        stateId: createHash("sha256")
          .update(new URL(response.json().data.authorizationUrl).searchParams.get("state")!)
          .digest("hex"),
        callback: await consentRedirect(
          response.json().data.authorizationUrl,
          secrets.users.alice.password,
        ),
      };
    }
    // The same user in a second browser cannot spend the first browser's state or code.
    const { callback } = await begin();

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
    const completed = await owner("GET", callback);
    assert.equal(completed.statusCode, 303, completed.body);
    assert.match(String(completed.headers.location), /connection=connected/);
    assert.match(String((await owner("GET", callback)).headers.location), /reason=unknown_session/);
    const savedSource = await oauthSource(input.connectionTemplateId);
    const id = savedSource.id;
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
    assert.equal(Object.hasOwn(sourceDetails.json().data, "ownerCapability"), false);
    assert.equal(Object.hasOwn(sourceDetails.json().data, "secrets"), false);
    // Exact Source reads expose the original non-secret consent, while the Source itself owns identity.
    const savedConsent = sourceDetails.json().data.consent;
    assert.equal(sourceDetails.json().data.type, "oauth2-refresh-token");
    assert.equal(sourceDetails.json().data.connectionTemplateId, input.connectionTemplateId);
    assert.equal(Object.hasOwn(sourceDetails.json().data, "connectionTemplateVersion"), false);
    assert.equal(Object.hasOwn(sourceDetails.json().data, "config"), false);
    const sourceList = await owner("GET", `${base}/credential-sources`);
    assert.equal(sourceList.statusCode, 200, sourceList.body);
    const listedSource = sourceList.json().data.find((entry: { id: string }) => entry.id === id);
    assert.equal(listedSource?.connectionTemplateId, input.connectionTemplateId);
    assert.deepEqual(listedSource?.consent, savedConsent);
    assert.equal(Object.hasOwn(listedSource, "connectionTemplateVersion"), false);
    assert.equal(Object.hasOwn(listedSource, "config"), false);
    // The saved source and its authorization must retain the Namespace consumed by the callback.
    const completedEvents = (await state.transact((unit) => unit.audit.list())).filter(
      (event) =>
        event.action === "openclaw.namespaces.connections.complete" &&
        event.outcome === "success" &&
        event.namespaceId === namespaceId &&
        event.resource.id === id,
    );
    assert.equal(completedEvents.length, 1);
    const [completedEvent] = completedEvents;
    assert.ok(completedEvent);
    assert.equal(completedEvent.kind, "mutation");
    assert.equal(completedEvent.actorId, ownerId);
    assert.equal(completedEvent.actor?.principalId, ownerId);
    assert.ok(completedEvent.admissionDecisionId);
    assert.deepEqual(completedEvent.resource, { kind: "credential_source", namespaceId, id });
    assert.deepEqual(completedEvent.authorization, {
      principalId: ownerId,
      action: "create",
      resource: { kind: "credential_source", id: namespaceId, namespaceId },
    });
    assert.equal((await owner("GET", connections)).statusCode, 405);
    assert.equal((await owner("DELETE", `${connections}/${id}`)).statusCode, 404);
    assert.equal((await reader("GET", source)).statusCode, 403);
    const hiddenSources = await reader("GET", `${base}/credential-sources`);
    assert.equal(hiddenSources.statusCode, 200, hiddenSources.body);
    assert.equal(
      hiddenSources.json().data.some((entry: { id: string }) => entry.id === id),
      false,
    );
    assert.equal((await reader("DELETE", source)).statusCode, 403);
    // Exact Source read grants expose non-secret consent without requiring broader Namespace visibility.
    const sourceReaderRole = await inject("POST", `${base}/iam/roles`, {
      name: "Exact OAuth Source reader",
      permissions: [{ action: "read", resourceKind: "credential_source" }],
    });
    assert.equal(sourceReaderRole.statusCode, 201, sourceReaderRole.body);
    const sourceReaderBinding = await inject("POST", `${base}/iam/access-bindings`, {
      roleId: sourceReaderRole.json().data.id,
      subjectKind: "identity",
      subjectId: human.json().data.principalId,
      resourceKind: "credential_source",
      resourceId: id,
    });
    assert.equal(sourceReaderBinding.statusCode, 201, sourceReaderBinding.body);
    const removeNamespaceRead = await inject(
      "DELETE",
      `${base}/iam/access-bindings/${binding.json().data.id}`,
    );
    assert.equal(removeNamespaceRead.statusCode, 204, removeNamespaceRead.body);
    const exactReaderSource = await reader("GET", source);
    assert.equal(exactReaderSource.statusCode, 200, exactReaderSource.body);
    assert.deepEqual(exactReaderSource.json().data.consent, savedConsent);
    assert.equal((await reader("GET", base)).statusCode, 403);
    assert.equal((await reader("GET", sources)).statusCode, 403);
    assert.equal((await reader("DELETE", source)).statusCode, 403);
    const custody = await pool.query(
      `SELECT custody.secret_ref, source.driver_id, source.token_service_instance_id FROM occ.connection_token_custody custody
       JOIN occ.credential_sources source ON source.namespace_id = custody.namespace_id AND source.id = custody.credential_source_id
       WHERE custody.namespace_id=$1 AND custody.credential_source_id=$2`,
      [namespaceId, id],
    );
    assert.equal(custody.rowCount, 1);
    assert.equal(custody.rows[0].driver_id, null);
    assert.equal(custody.rows[0].token_service_instance_id, instanceId);
    const privateRef = custody.rows[0].secret_ref;
    assert.ok(secretDriver.has(privateRef));
    assert.deepEqual(
      [
        savedConsent.oauthClientId,
        savedConsent.clientId,
        savedConsent.issuer,
        savedConsent.tokenUrl,
        savedConsent.destinations,
        savedConsent.resource,
        savedConsent.mcpServerUrl,
        savedConsent.ownerPrincipalId,
        savedConsent.requestedScopes,
        savedConsent.grantedScopes,
      ],
      [
        oauthClientId,
        clientId,
        issuer,
        tokenUrl,
        [recipient],
        serverUrl,
        serverUrl,
        ownerId,
        ["openid"],
        ["openid"],
      ],
    );
    // The trusted Token Service consumer can use the grant. Saving/rotating alone creates no sender.
    const sourceInstance = {
      sourceRef: { kind: "credential_source", namespaceId, id } as const,
      tokenServiceInstanceId: instanceId,
    };
    async function prepared() {
      const token = await tokenOwner.resolveCredential(sourceInstance, t.signal);
      return token.credential;
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
    assert.equal(
      sourceDetails.body.includes(original),
      false,
      "Source reads never return token material",
    );
    // An explicit Source rotation publishes a newly issued access token through the selected owner.
    await setIssuedLifetime(300);
    assert.equal((await owner("POST", source + "/rotate")).statusCode, 200);
    const resolved = await prepared();
    assert.notEqual(resolved, original);
    assert.equal(await subject(resolved), alice);

    // Lose access to the operator's registration before dispatch. The scheduler must back off
    // without losing the user's grant, and the owner can retry as soon as access returns.
    const unavailable = t.mock.method(secretDriver.installationSecrets, "withValue", async () => {
      throw new Error("registration store unavailable");
    });
    assert.equal((await owner("POST", source + "/rotate")).statusCode, 503);
    // Source metadata remains readable when TokenService cannot inspect its private custody.
    const unavailableCustody = t.mock.method(secretDriver, "withValue", async () => {
      throw new DependencyUnavailableError("Secret store unavailable");
    });
    try {
      const metadataDuringOutage = await owner("GET", source);
      assert.equal(metadataDuringOutage.statusCode, 200, metadataDuringOutage.body);
      assert.deepEqual(metadataDuringOutage.json().data.consent, savedConsent);
    } finally {
      unavailableCustody.mock.restore();
    }
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
    // Consent stays pinned to the original version and client when the Template advances.
    assert.notEqual(savedConsent.version, switchRegistration.json().data.current.version);
    const pinnedSource = await owner("GET", source);
    const pinnedList = await owner("GET", `${base}/credential-sources`);
    assert.equal(pinnedSource.statusCode, 200, pinnedSource.body);
    assert.equal(pinnedList.statusCode, 200, pinnedList.body);
    const pinnedListedSource = pinnedList
      .json()
      .data.find((entry: { id: string }) => entry.id === id);
    for (const projected of [pinnedSource.json().data, pinnedListedSource]) {
      assert.equal(projected?.connectionTemplateId, input.connectionTemplateId);
      assert.deepEqual(projected?.consent, savedConsent);
      assert.equal(Object.hasOwn(projected, "connectionTemplateVersion"), false);
    }
    const currentMcp = async () => {
      const result = await owner("GET", source);
      assert.equal(result.statusCode, 200, result.body);
      return result.json().data.consent;
    };
    assert.deepEqual((await currentMcp()).destinations, [recipient]);
    assert.equal((await currentMcp()).oauthClientId, oauthClientId);
    assert.equal((await currentMcp()).version, savedConsent.version);
    const futureConsent = await owner("POST", connections, input);
    assert.equal(futureConsent.statusCode, 201, futureConsent.body);
    assert.equal(
      new URL(futureConsent.json().data.authorizationUrl).searchParams.get("client_id"),
      clientId + "-future",
    );
    // Current MCP transport/resource changes cannot retarget the historical consent.
    discoveredResource = "https://resource.connections.test";
    const otherResource = await inject(
      "PATCH",
      "/connection-templates/" + mcp.json().data.id,
      mcpConfig,
    );
    assert.equal(otherResource.statusCode, 200, otherResource.body);
    assert.deepEqual(await currentMcp(), savedConsent);
    discoveredResource = serverUrl;
    const otherMcp = await inject("PATCH", "/connection-templates/" + mcp.json().data.id, {
      ...mcpConfig,
      serverUrl: "https://other.connections.test/mcp",
    });
    assert.equal(otherMcp.statusCode, 200, otherMcp.body);
    assert.deepEqual(await currentMcp(), savedConsent);
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
    assert.equal(rotated.json().data.connectionTemplateId, input.connectionTemplateId);
    assert.equal(Object.hasOwn(rotated.json().data, "connectionTemplateVersion"), false);
    assert.equal(Object.hasOwn(rotated.json().data, "config"), false);
    const renewed = await prepared();
    assert.equal(renewed !== original, true);
    assert.equal(await subject(renewed), alice);
    // Let this short-lived token actually expire before any worker starts. A normal resolve
    // must obtain its replacement with the current client secret and the original user's grant.
    await setIssuedLifetime(300);
    const expiring = rotated.json().data.status.refresh;
    await waitFor(
      "Keycloak's access token to expire",
      async () => (Date.now() >= Date.parse(expiring.expiresAt!) ? true : undefined),
      { timeoutMs: 20_000, intervalMs: 100 },
    );
    const afterExpiry = await prepared();
    assert.notEqual(afterExpiry, renewed);
    assert.equal(await subject(afterExpiry), alice);
    const afterRotation = await owner("GET", sources);
    assert.equal(afterRotation.statusCode, 200, afterRotation.body);
    assert.deepEqual(
      afterRotation
        .json()
        .data.filter((saved: { state: string }) => saved.state === "ready")
        .map((saved: { id: string }) => saved.id),
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
      view.oauthCredentials.findTokenCustody(namespaceId, id),
    );
    await state.transact((unit) =>
      unit.oauthCredentials.recordTokenSchedule(namespaceId, id, "due"),
    );
    async function startAccountWorker() {
      const fixture = await createBackendFixture(t);
      const { worker } = fixture.startWorker({
        backends: [],
        secretDriver,
        tokenServiceDriverId: tokenOwner.id,
      });
      await worker.start();
      return worker;
    }
    const worker = await startAccountWorker();
    await waitFor("background renewal to publish a new scheduled version", async () => {
      const current = await state.read((view) =>
        view.oauthCredentials.findTokenCustody(namespaceId, id),
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
    const resolving = tokenOwner.resolveCredential(sourceInstance, t.signal);
    await observed.promise;
    // The SQL revocation survives a transient custody failure. A worker with the same
    // Secret store and Token Service finishes it after the API request has returned.
    const unavailableDelete = t.mock.method(secretDriver, "delete", async () => {
      throw new DependencyUnavailableError("Secret store unavailable");
    });
    const bindingsBeforeRetirement = await pool.query<{ id: string }>(
      "SELECT id FROM occ.iam_access_bindings WHERE namespace_id=$1 AND resource_kind='credential_source' AND resource_id=$2 ORDER BY id",
      [namespaceId, id],
    );
    const interrupted = await owner("DELETE", source);
    assert.equal(interrupted.statusCode, 503, interrupted.body);
    const revokingList = await owner("GET", `${base}/credential-sources`);
    assert.equal(revokingList.statusCode, 200, revokingList.body);
    const revokingSource = revokingList
      .json()
      .data.find((entry: { id: string }) => entry.id === id);
    assert.equal(revokingSource?.state, "deleting");
    assert.equal(revokingSource.connectionTemplateId, input.connectionTemplateId);
    assert.equal(revokingSource.consent.revocationRequestedBy, ownerId);
    assert.equal(Object.hasOwn(revokingSource, "connectionTemplateVersion"), false);
    assert.equal(Object.hasOwn(revokingSource, "config"), false);
    const revokingExact = await owner("GET", source);
    assert.equal(revokingExact.statusCode, 200, revokingExact.body);
    assert.equal(revokingExact.json().data.connectionTemplateId, input.connectionTemplateId);
    assert.equal(Object.hasOwn(revokingExact.json().data, "connectionTemplateVersion"), false);
    assert.equal(Object.hasOwn(revokingExact.json().data, "config"), false);
    assert.ok(secretDriver.has(privateRef));
    // Releasing a read after OCC committed revocation must withhold the already-read bearer.
    release.resolve();
    await assert.rejects(resolving, ResourceStateConflictError);
    slowRead.mock.restore();
    unavailableDelete.mock.restore();
    await startAccountWorker();

    await waitFor("the worker to retire the disconnected account", async () => {
      const remaining = await state.read((view) =>
        view.credentialSources.findCredentialSource(namespaceId, id),
      );
      return remaining === undefined ? true : undefined;
    });
    const workerCompletion = await pool.query(
      `SELECT actor_id, details->'removedAccessBindings' AS removed FROM occ.audit_events
       WHERE action='openclaw.credential_sources.delete' AND resource_id=$1 AND outcome='success'`,
      [id],
    );
    assert.equal(workerCompletion.rowCount, 1);
    assert.equal(workerCompletion.rows[0].actor_id, ownerId);
    assert.deepEqual(
      workerCompletion.rows[0].removed.map((binding: { id: string }) => binding.id).sort(),
      bindingsBeforeRetirement.rows.map((binding) => binding.id),
    );
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
    const waiting = await begin();
    const lock = await peer.pool.connect();
    let blocked;
    let verifier: string;
    try {
      await lock.query("BEGIN");
      const held = await lock.query(
        "DELETE FROM occ.authentication_states WHERE kind='oauth_connection' AND id=$1 RETURNING pg_backend_pid() AS pid, binding->>'pkceVerifier' AS pkce_verifier",
        [waiting.stateId],
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
