import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { scheduleTokenServiceMaintenance } from "../../apps/controller/src/composition/token-service.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { managedCliInstalls } from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import type { PrivateSecretRef } from "../../packages/contracts/src/index.ts";
import { validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import {
  CredentialDeliveryFailedError,
  DependencyUnavailableError,
  PostgresHumanAuthentication,
  ResourceStateConflictError,
} from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import {
  keycloakRealmAdmin,
  keycloakRealmRows,
  rotateKeycloakClientSecret,
} from "../helpers/ci-keycloak-realm.ts";
import { waitForLockWaiter } from "../helpers/postgres-locks.ts";
import { createBackendFixture } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { installDeviceTokenService } from "../helpers/device-token-service.ts";
import { controlledOAuthIssuer, oauthIssuerWithTransport } from "../helpers/oauth-issuer.ts";

const issuer = process.env.OCC_TEST_KEYCLOAK_ISSUER;
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
    headers: Record<string, string> = {},
  ) =>
    target.inject({
      method,
      url,
      headers: { host: new URL(session.origin).host, ...authenticatedHeaders(session), ...headers },
      ...(body === undefined ? {} : { payload: body }),
    });
}

test(
  "OAuth callback persists issuer-granted initial scopes and refuses refresh escalation",
  requiresPostgres,
  async (t) => {
    const controlled = await controlledOAuthIssuer(t);
    const localIssuer = controlled.issuer;
    const tokenUrl = controlled.tokenUrl;
    const destinations = [{ host: "api.scope.test", port: 443, path: "/resource" }];
    const secrets = {
      ...createTestSecretDriver({ id: "scope-pg-secret" }),
      capability: "secret" as const,
    };
    const { app, adminAccount, controller, state, principal, inject, pool } =
      await createPostgresAgentApp(t, {
        label: "scope-grant",
        authSecret: "scope-grant-test-auth-secret-minimum-32-bytes",
        secretDriver: secrets,
        appOptions: { publicOrigin },
        controllerOptions: { oauthIssuer: controlled.operations },
      });
    const deliveries: { version: string; due: boolean }[] = [];
    await installDeviceTokenService(
      controller,
      state,
      secrets,
      "scope-token-service",
      async (ref, version) => {
        const custody = await state.read(({ oauthCredentials }) =>
          oauthCredentials.findTokenCustody(ref.namespaceId, ref.sourceId),
        );
        assert.ok(custody);
        deliveries.push({ version, due: custody.due });
        if (deliveries.length < 3) {
          throw new CredentialDeliveryFailedError();
        }
      },
    );
    const namespace = await inject("POST", "/namespaces", { name: `Scopes ${randomUUID()}` });
    assert.equal(namespace.statusCode, 201, namespace.body);
    const namespaceId = namespace.json().data.id;
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const forged = await inject("POST", "/connection-templates", {
      mode: "manual",
      namespaceId,
      displayName: "Forged issuer endpoint",
      issuer: localIssuer,
      authorizationUrl: controlled.authorizationUrl,
      tokenUrl: `${localIssuer}/forged-token`,
      destinations,
      scopes: ["read"],
    });
    assert.equal(forged.statusCode, 400, forged.body);
    assert.equal(
      controlled.requests.length,
      0,
      "approval never sends a code or credential to the forged endpoint",
    );
    const templateInput = {
      mode: "manual",
      namespaceId,
      displayName: "Issuer scope grant",
      issuer: localIssuer,
      authorizationUrl: controlled.authorizationUrl,
      tokenUrl,
      destinations,
      scopes: ["read"],
    };
    for (const capabilities of [
      { grant_types_supported: ["refresh_token"] },
      { code_challenge_methods_supported: ["plain"] },
    ]) {
      controlled.setMetadataCapabilities(capabilities);
      const incompatible = await inject("POST", "/connection-templates", templateInput);
      assert.equal(incompatible.statusCode, 400, incompatible.body);
    }
    controlled.setMetadataCapabilities({});
    const template = await inject("POST", "/connection-templates", templateInput);
    assert.equal(template.statusCode, 201, template.body);
    const selectedSecret = randomUUID();
    const client = await inject("POST", "/credential-clients", {
      kind: "oauth2",
      namespaceId,
      issuer: localIssuer,
      displayName: "Scope client",
      clientId: "scope-client",
      tokenEndpointAuthMethod: "client_secret_basic",
      clientSecret: selectedSecret,
    });
    assert.equal(client.statusCode, 201, client.body);
    const clientId = client.json().data.id;
    const second = await inject("POST", "/credential-clients", {
      kind: "oauth2",
      namespaceId,
      issuer: localIssuer,
      displayName: "Second scope client",
      clientId: "scope-client-2",
      tokenEndpointAuthMethod: "none",
    });
    assert.equal(second.statusCode, 201, second.body);
    const incompatible = await inject("POST", "/credential-clients", {
      kind: "oauth2",
      namespaceId,
      issuer: "https://other.oauth.test",
      displayName: "Other issuer",
      clientId: "scope-other",
      tokenEndpointAuthMethod: "none",
    });
    assert.equal(incompatible.statusCode, 201, incompatible.body);
    const eligibility = await inject(
      "GET",
      `/namespaces/${namespaceId}/connections/oauth-clients?connectionTemplateId=${template.json().data.id}`,
    );
    assert.equal(eligibility.statusCode, 200, eligibility.body);
    assert.deepEqual(
      eligibility
        .json()
        .data.map((value: { id: string }) => value.id)
        .sort(),
      [clientId, second.json().data.id].sort(),
    );
    assert.ok(
      eligibility
        .json()
        .data.every((value: Record<string, unknown>) => !("tokenServiceInstanceId" in value)),
    );
    const missingSelection = await inject("POST", `/namespaces/${namespaceId}/connections`, {
      connectionTemplateId: template.json().data.id,
    });
    assert.equal(missingSelection.statusCode, 400);
    const wrongIssuer = await inject("POST", `/namespaces/${namespaceId}/connections`, {
      connectionTemplateId: template.json().data.id,
      oauthClientId: incompatible.json().data.id,
    });
    assert.notEqual(wrongIssuer.statusCode, 201);
    const stale = await inject("POST", `/namespaces/${namespaceId}/connections`, {
      connectionTemplateId: template.json().data.id,
      oauthClientId: clientId,
    });
    assert.equal(stale.statusCode, 201, stale.body);
    const staleState = new URL(stale.json().data.authorizationUrl).searchParams.get("state");
    assert.ok(staleState);
    const secretRead = t.mock.method(secrets.privateSecrets, "withValue");
    const readsBefore = secretRead.mock.calls.length;
    controlled.setMetadataTokenUrl(`${localIssuer}/changed-token`);
    const refusedCallback = await inject(
      "GET",
      `/oauth/callback?${new URLSearchParams({ state: staleState, code: "unspent-code", iss: localIssuer })}`,
    );
    controlled.setMetadataTokenUrl(undefined);
    assert.match(String(refusedCallback.headers.location), /connection=failed/);
    assert.equal(
      secretRead.mock.calls.length,
      readsBefore,
      "revalidation fails before opening the Client secret",
    );
    assert.equal(controlled.requests.length, 0, "revalidation fails before sending the code");
    secretRead.mock.restore();
    const started = await inject("POST", `/namespaces/${namespaceId}/connections`, {
      connectionTemplateId: template.json().data.id,
      oauthClientId: clientId,
    });
    assert.equal(started.statusCode, 201, started.body);
    const secondAdmin = await accountSession(app, adminAccount.email, adminAccount.password);
    const stateValue = new URL(started.json().data.authorizationUrl).searchParams.get("state");
    assert.ok(stateValue);
    let grantType: string | null = null;
    let refreshCalls = 0;
    let refreshScopes = "read issuer.default";
    const exchangeReached = Promise.withResolvers<void>();
    const resumeExchange = Promise.withResolvers<void>();
    t.after(() => resumeExchange.resolve());
    // Fastify, IAM, TokenService custody, PostgreSQL and the HTTPS transport are real.
    controlled.setTokenHandler(async ({ authorization, parameters: body }) => {
      if (
        authorization !==
        "Basic " + Buffer.from(`scope-client:${selectedSecret}`).toString("base64")
      ) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      grantType = body.get("grant_type");
      if (grantType === "authorization_code") {
        exchangeReached.resolve();
        await resumeExchange.promise;
        // Once the code has been consumed, storing its grant must not depend on another
        // issuer metadata request. The next issuer operation will revalidate independently.
        controlled.setMetadataTokenUrl(`${localIssuer}/changed-token`);
      }
      if (grantType === "refresh_token") {
        refreshCalls++;
      }
      return Response.json({
        access_token: randomUUID(),
        token_type: "Bearer",
        expires_in: 120,
        refresh_token: randomUUID(),
        scope: grantType === "authorization_code" ? "read issuer.default" : refreshScopes,
      });
    });
    const callbackPromise = inject(
      "GET",
      `/oauth/callback?${new URLSearchParams({ state: stateValue, code: "controlled-code", iss: localIssuer })}`,
    );
    await Promise.race([
      exchangeReached.promise,
      callbackPromise.then((reply) => {
        throw new Error(
          `Callback returned before exchange: ${reply.statusCode} ${reply.headers.location ?? ""}`,
        );
      }),
    ]);
    // Consumption is one-time, while the same pending row still protects the selected Client through exchange.
    const held = await pool.query(
      "SELECT oauth_client_id, oauth_consumed_at IS NOT NULL AS consumed FROM occ.authentication_states WHERE id=$1",
      [createHash("sha256").update(stateValue).digest("hex")],
    );
    assert.deepEqual(held.rows, [{ oauth_client_id: clientId, consumed: true }]);
    const inUse = await secondAdmin("DELETE", `/credential-clients/${clientId}`);
    assert.equal(inUse.statusCode, 409, inUse.body);
    resumeExchange.resolve();
    const callback = await callbackPromise;
    controlled.setMetadataTokenUrl(undefined);
    assert.match(String(callback.headers.location), /connection=connected/);
    assert.equal(grantType, "authorization_code");
    const sources = `/namespaces/${namespaceId}/credential-sources`;
    const listed = await inject("GET", sources);
    assert.equal(listed.statusCode, 200, listed.body);
    const source = listed
      .json()
      .data.find(
        (entry: { connectionTemplateId?: string }) =>
          entry.connectionTemplateId === template.json().data.id,
      );
    assert.ok(source);
    assert.equal(source.consent.oauthClientId, clientId);
    assert.deepEqual(source.consent.requestedScopes, ["read"]);
    assert.deepEqual(source.consent.grantedScopes, ["read", "issuer.default"]);
    assert.deepEqual(source.consent.destinations, destinations);
    const receipt = await pool.query(
      "SELECT oauth_requested_scopes, oauth_granted_scopes FROM occ.credential_sources WHERE id=$1",
      [source.id],
    );
    assert.deepEqual(receipt.rows[0], {
      oauth_requested_scopes: ["read"],
      oauth_granted_scopes: ["read", "issuer.default"],
    });
    const rotate = () => inject("POST", `${sources}/${source.id}/rotate`);
    const refreshSecretReads = t.mock.method(secrets.privateSecrets, "withValue");
    const clientSecretReads = () =>
      refreshSecretReads.mock.calls.filter((call) => call.arguments[0].id.includes(clientId))
        .length;
    const clientReadsBefore = clientSecretReads();
    const requestsBefore = controlled.requests.length;
    controlled.setMetadataTokenUrl(`${localIssuer}/changed-token`);
    const rejectedRefresh = await rotate();
    controlled.setMetadataTokenUrl(undefined);
    assert.equal(rejectedRefresh.statusCode, 503, rejectedRefresh.body);
    assert.equal(clientSecretReads(), clientReadsBefore, "refusal does not open the Client secret");
    assert.equal(controlled.requests.length, requestsBefore, "refusal does not send the grant");
    refreshSecretReads.mock.restore();
    const schedule = () =>
      state.read(({ oauthCredentials }) =>
        oauthCredentials.findTokenCustody(namespaceId, source.id),
      );
    // A manual renewal leaves a fresh schedule out of the Worker's scan until delivery fails.
    assert.equal((await schedule())?.due, false);
    const failedDelivery = await rotate();
    assert.equal(failedDelivery.statusCode, 503, failedDelivery.body);
    assert.match(failedDelivery.json().error.message, /source was updated/);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.due, false);
    assert.equal((await schedule())?.due, true);
    // Retry enters the same owner with the committed grant and the old scheduled version.
    const failedRetry = await rotate();
    assert.equal(failedRetry.statusCode, 503, failedRetry.body);
    assert.match(failedRetry.json().error.message, /already held by the source/);
    const failedRetryId = failedRetry.headers["x-request-id"];
    assert.equal(typeof failedRetryId, "string");
    const retryAudit = await pool.query(
      `SELECT outcome, details->'__occAuditMetadata'->>'reasonCode' AS reason
       FROM occ.audit_events WHERE resource_id=$1 AND action='openclaw.credential_sources.rotate'
         AND details->'__occAuditMetadata'->>'requestId'=$2`,
      [source.id, failedRetryId],
    );
    assert.deepEqual(retryAudit.rows, [
      { outcome: "failure", reason: "CREDENTIAL_DELIVERY_FAILED" },
    ]);
    const retried = await rotate();
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(refreshCalls, 1, "redeliver without a second rotating issuer exchange");
    assert.equal(deliveries.length, 3);
    assert.equal(deliveries[1]?.version, deliveries[0]?.version);
    assert.equal(deliveries[2]?.version, deliveries[0]?.version);
    assert.equal((await schedule())?.due, false);

    refreshScopes = "read issuer.default later.addition";
    const refreshed = await rotate();
    assert.equal(refreshed.statusCode, 503, refreshed.body);
    assert.equal(refreshed.json().error.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(grantType, "refresh_token");
    const afterRefresh = await inject("GET", `${sources}/${source.id}`);
    assert.equal(afterRefresh.statusCode, 200, afterRefresh.body);
    assert.equal(afterRefresh.json().data.status.refresh.failureCode, "grant_scope_mismatch");
    assert.deepEqual(afterRefresh.json().data.consent.grantedScopes, ["read", "issuer.default"]);
    await assert.rejects(
      pool.query(
        "UPDATE occ.credential_sources SET oauth_granted_scopes=array_append(oauth_granted_scopes,$2) WHERE id=$1",
        [source.id, "later.addition"],
      ),
      { code: "55000" },
    );
    const retired = await inject("DELETE", `${sources}/${source.id}`);
    assert.equal(retired.statusCode, 204, retired.body);
    const removedTemplate = await inject(
      "DELETE",
      `/connection-templates/${template.json().data.id}`,
    );
    assert.equal(removedTemplate.statusCode, 204, removedTemplate.body);
    for (const id of [clientId, second.json().data.id, incompatible.json().data.id]) {
      const removed = await inject("DELETE", `/credential-clients/${id}`);
      assert.equal(removed.statusCode, 204, removed.body);
    }
    await controller.cleanupCredentialClients();
  },
);

test(
  "OAuth consent creates an owner-bound Source and refreshes it through the TokenService",
  {
    skip:
      requiresPostgres.skip || (!(issuer && secretsFile) && "Prepare the keycloak-oidc CI lane."),
  },
  async (t) => {
    assert.ok(issuer && secretsFile);
    const secrets = JSON.parse(await readFile(secretsFile, "utf8"));
    const discovery = await fetch(`${issuer}/.well-known/openid-configuration`);
    assert.equal(discovery.status, 200);
    const advertised = asRecord(await discovery.json());
    assert.equal(advertised?.issuer, issuer);
    assert.equal(typeof advertised?.token_endpoint, "string");
    const tokenUrl = advertised.token_endpoint as string;
    const secondIssuer = "https://second-issuer.example.test";
    // The lane maps its private Keycloak hostname/port through the test global dispatcher.
    // MCP's public DNS classification is controlled here; the issuer metadata, TLS and token
    // exchange still reach Keycloak, and the separate controlled issuer test exercises pinning.
    const keycloakOperations = oauthIssuerWithTransport({
      resolveHost: async () => [{ address: "1.1.1.1", family: 4 }],
      async fetchMetadata(value, request) {
        if (String(value) === `${secondIssuer}/.well-known/oauth-authorization-server`) {
          return Response.json({
            issuer: secondIssuer,
            authorization_endpoint: secondIssuer + "/authorize",
            token_endpoint: secondIssuer + "/token",
            response_types_supported: ["code"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        }
        const { dispatcher: _dispatcher, ...mapped } = request as RequestInit & {
          dispatcher?: unknown;
        };
        return fetch(value, mapped);
      },
    });
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
      const [client] = keycloakRealmRows(
        await keycloakRealmAdmin(issuer, secrets.admin, "GET", `/clients?clientId=${clientId}`),
      );
      if (client) {
        await keycloakRealmAdmin(issuer, secrets.admin, "DELETE", `/clients/${client.id}`);
      }
    });

    // The API and Token Service use the fixture Secret store. Keycloak authenticates the
    // registration and issues actual tokens without OpenShell or a Credential Refresh Driver.
    const secretDriver = {
      ...createTestSecretDriver(),
      capability: "secret" as const,
    };
    const privateStore = secretDriver.privateSecrets;
    const serverUrl = "https://api.connections.test/mcp";
    let discoveredResource = serverUrl;
    const { app, createApp, controller, state, principal, inject, pool, adminAccount } =
      await createPostgresAgentApp(t, {
        label: "saved-account",
        poolOptions: { max: 1, connectionTimeoutMillis: 5000 },
        authSecret: "saved-account-test-auth-secret-minimum-32-bytes",
        secretDriver,
        controllerOptions: { oauthIssuer: keycloakOperations },
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
    await privateStore.create(
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
      privateStore,
      instanceId,
      state,
      undefined,
      new OAuthAccountTokens(state, privateStore, resolveClient),
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
    const manualTemplateId = template.json().data.id;
    const listsManualTemplate = async (path: string) => {
      const result = await inject("GET", path);
      assert.equal(result.statusCode, 200, result.body);
      return result.json().data.some((entry: { id: string }) => entry.id === manualTemplateId);
    };
    // The Template is available independently of Client registration; no consent can omit its explicit Client selection.
    assert.equal(await listsManualTemplate("/connection-templates"), true);
    assert.equal(await listsManualTemplate(`${base}/connection-templates`), true);
    assert.equal(
      (await inject("POST", connections, { connectionTemplateId: manualTemplateId })).statusCode,
      400,
    );
    const registered = await inject("POST", "/credential-clients", {
      kind: "oauth2",
      namespaceId,
      issuer,
      displayName: "Saved accounts",
      clientId,
      clientSecret,
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const oauthClientId = registered.json().data.id;
    const manual = { connectionTemplateId: manualTemplateId, oauthClientId };
    const eligible = await inject(
      "GET",
      `${connections}/oauth-clients?connectionTemplateId=${manualTemplateId}`,
    );
    assert.equal(eligible.statusCode, 200, eligible.body);
    assert.deepEqual(
      eligible.json().data.map((client: { id: string }) => client.id),
      [oauthClientId],
    );
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
    const unavailableCreate = t.mock.method(privateStore, "create", async () => {
      throw new DependencyUnavailableError("Secret store unavailable");
    });
    try {
      const failedCallback = await inject("GET", failedCallbackPath);
      assert.match(String(failedCallback.headers.location), /connection=failed/);
      assert.equal(
        new URL(String(failedCallback.headers.location), publicOrigin).searchParams.has("sourceId"),
        false,
        "failed consent cannot advertise an account for the editor to attach",
      );
      const failedSources = await inject("GET", sources);
      assert.equal(failedSources.statusCode, 200, failedSources.body);
      assert.equal(
        failedSources.json().data.some((entry: { state: string }) => entry.state === "ready"),
        false,
        "failed custody cannot produce a ready Source",
      );
    } finally {
      unavailableCreate.mock.restore();
    }
    const mcpConfig = {
      displayName: "Scope selection",
      mode: "mcp_discovery",
      issuer,
      serverUrl,
      scopes: ["openid", "profile"],
    };
    const mcp = await inject("POST", "/connection-templates", { ...mcpConfig, namespaceId });
    assert.equal(mcp.statusCode, 201, mcp.body);
    const input = {
      connectionTemplateId: mcp.json().data.id,
      oauthClientId,
      selectedScopes: ["openid"],
    };
    for (const selectedScopes of [undefined, ["profile"], ["openid", "other"]]) {
      const refused = await inject("POST", connections, {
        connectionTemplateId: input.connectionTemplateId,
        oauthClientId,
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
      (await inject("POST", connections, { connectionTemplateId: unrestrictedId, oauthClientId }))
        .statusCode,
      400,
    );
    const manyScopes = ["openid", ...Array.from({ length: 32 }, (_, i) => "custom." + i)];
    const freeStart = await inject("POST", connections, {
      connectionTemplateId: unrestrictedId,
      oauthClientId,
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
      scopes: [],
      displayName: "Provider defaults",
    });
    assert.equal(unrestrictedManual.statusCode, 201, unrestrictedManual.body);
    const [keycloakClient] = keycloakRealmRows(
      await keycloakRealmAdmin(issuer, secrets.admin, "GET", "/clients?clientId=" + clientId),
    );
    const realmScopes = keycloakRealmRows(
      await keycloakRealmAdmin(issuer, secrets.admin, "GET", "/client-scopes"),
    );
    assert.ok(keycloakClient);
    const profile = realmScopes.find((scope) => scope.name === "profile");
    assert.ok(profile);
    const defaultPath = "/clients/" + keycloakClient.id + "/default-client-scopes/" + profile.id;
    await keycloakRealmAdmin(issuer, secrets.admin, "PUT", defaultPath);
    const defaults = await owner("POST", connections, {
      connectionTemplateId: unrestrictedManual.json().data.id,
      oauthClientId,
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
    assert.equal(defaultConsent.kind, "connection_template");
    assert.equal(defaultConsent.version, unrestrictedManual.json().data.current.version);
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
      issuer: secondIssuer,
      authorizationUrl: secondIssuer + "/authorize",
      tokenUrl: secondIssuer + "/token",
      scopes: [],
    });
    assert.equal(incompatible.statusCode, 200, incompatible.body);
    // Refresh keeps using the original grant, but a Plugin cannot admit it under a new issuer.
    controller.installPluginDrivers([new OCCPluginDriver()]);
    const google = managedCliInstalls.find(
      ({ packageName }) => packageName === "oce-google-workspace",
    );
    assert.ok(google);
    const changedIssuer = await inject("POST", `${base}/agents/validate`, {
      configuration: { kind: "agent", values: createHarnessConfiguration("openclaw", "gpt-4.1") },
      executionMode: "dedicated",
      harnessAuth: { method: "api_key" },
      plugins: {
        [google.id]: {
          enabled: true,
          driverPolicy: {
            releaseSha256: google.releaseSha256,
            credentials: { account: defaultsId },
          },
        },
      },
    });
    assert.equal(changedIssuer.statusCode, 409, changedIssuer.body);
    assert.match(changedIssuer.json().error.message, /Reconnect.*issuer.*changes/);
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
    const { callback, stateId } = await begin();

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
    const beforeCallback = await inject("POST", `/credential-clients/${oauthClientId}/rotate`, {
      kind: "oauth2",
      clientSecret: callbackSecret,
    });
    assert.equal(beforeCallback.statusCode, 200, beforeCallback.body);
    const completed = await owner("GET", callback, undefined, app, { accept: "text/html" });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.match(String(completed.headers["content-type"]), /^text\/html/);
    assert.match(
      String(completed.headers["content-security-policy"]),
      /default-src 'none'; script-src 'nonce-/,
    );
    assert.match(String((await owner("GET", callback)).headers.location), /reason=unknown_session/);
    const savedSource = await oauthSource(input.connectionTemplateId);
    const id = savedSource.id;
    assert.ok(completed.body.includes(id), "the verified callback confirms the newly saved Source");
    assert.ok(completed.body.includes(stateId), "the callback confirms the initiating attempt");
    const callbackQuery = new URL(callback, publicOrigin).searchParams;
    assert.equal(completed.body.includes(callbackQuery.get("state")!), false);
    assert.equal(completed.body.includes(callbackQuery.get("code")!), false);
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
    const custody = await pool.query<{
      secret_ref: PrivateSecretRef;
      driver_id: string | null;
      token_service_instance_id: string;
    }>(
      `SELECT custody.secret_ref, source.driver_id, source.token_service_instance_id FROM occ.connection_token_custody custody
       JOIN occ.credential_sources source ON source.namespace_id = custody.namespace_id AND source.id = custody.credential_source_id
       WHERE custody.namespace_id=$1 AND custody.credential_source_id=$2`,
      [namespaceId, id],
    );
    assert.equal(custody.rowCount, 1);
    const [custodyRow] = custody.rows;
    assert.ok(custodyRow);
    assert.equal(custodyRow.driver_id, null);
    assert.equal(custodyRow.token_service_instance_id, instanceId);
    const privateRef = custodyRow.secret_ref;
    assert.equal(privateRef.installationId, controller.installation.id);
    assert.equal(await privateStore.withValue(privateRef, async () => true), true);
    const tenantSecrets = await inject("GET", `${base}/secrets`);
    assert.equal(tenantSecrets.statusCode, 200, tenantSecrets.body);
    assert.deepEqual(tenantSecrets.json().data, []);
    assert.deepEqual(secretDriver.calls, [], "OAuth consent uses only the private store");
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
      const [client] = keycloakRealmRows(
        await keycloakRealmAdmin(issuer!, secrets.admin, "GET", `/clients?clientId=${clientId}`),
      );
      assert.ok(client);
      const attributes = asRecord(client.attributes);
      assert.ok(
        client.attributes === undefined || client.attributes === null || attributes,
        "invalid Keycloak client attributes",
      );
      await keycloakRealmAdmin(issuer!, secrets.admin, "PUT", `/clients/${client.id}`, {
        ...client,
        attributes: { ...attributes, "access.token.lifespan": String(seconds) },
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
    const readPrivate = privateStore.withValue.bind(privateStore);
    const unavailable = t.mock.method(
      privateStore,
      "withValue",
      async <T>(ref: PrivateSecretRef, use: (value: string) => Promise<T>) => {
        if (ref.id !== privateRef.id) {
          throw new Error("registration store unavailable");
        }
        return readPrivate(ref, use);
      },
    );
    try {
      assert.equal((await owner("POST", source + "/rotate")).statusCode, 503);
    } finally {
      unavailable.mock.restore();
    }
    // Source metadata remains readable when TokenService cannot inspect its private custody.
    const unavailableCustody = t.mock.method(privateStore, "withValue", async () => {
      throw new DependencyUnavailableError("Secret store unavailable");
    });
    try {
      const metadataDuringOutage = await owner("GET", source);
      assert.equal(metadataDuringOutage.statusCode, 200, metadataDuringOutage.body);
      assert.deepEqual(metadataDuringOutage.json().data.consent, savedConsent);
    } finally {
      unavailableCustody.mock.restore();
    }
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
    // Future consent can select a different Client without changing an existing Source's pair.
    const futureRegistration = await inject("POST", "/credential-clients", {
      kind: "oauth2",
      namespaceId,
      issuer,
      displayName: "Future consent",
      clientId: clientId + "-future",
      clientSecret: randomUUID(),
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    assert.equal(futureRegistration.statusCode, 201, futureRegistration.body);
    const switchRegistration = await inject(
      "PATCH",
      "/connection-templates/" + mcp.json().data.id,
      { ...mcpConfig, authorizationParameters: { prompt: "login" } },
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
    const futureConsent = await owner("POST", connections, {
      ...input,
      oauthClientId: futureRegistration.json().data.id,
    });
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
    const updatedClient = await inject("POST", `/credential-clients/${oauthClientId}/rotate`, {
      kind: "oauth2",
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
    // Let this short-lived token actually expire before maintenance starts. A normal API resolve
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
    // Make the saved grant due before starting the API lifecycle. With no Worker or resolve
    // request in flight, the API must renew the grant and publish the new schedule.
    const prior = await state.read((view) =>
      view.oauthCredentials.findTokenCustody(namespaceId, id),
    );
    assert.ok(prior?.scheduledVersion);
    await state.transact((unit) =>
      unit.oauthCredentials.recordTokenSchedule(namespaceId, id, "due"),
    );
    const maintenanceApp = createApp(controller);
    const stopMaintenance = scheduleTokenServiceMaintenance(maintenanceApp, tokenOwner);
    maintenanceApp.addHook("onClose", stopMaintenance);
    try {
      await maintenanceApp.ready();
      await waitFor("API renewal to publish a new scheduled version", async () => {
        const current = await state.read((view) =>
          view.oauthCredentials.findTokenCustody(namespaceId, id),
        );
        return current?.scheduledVersion && current.scheduledVersion !== prior.scheduledVersion
          ? true
          : undefined;
      });
      const background = await prepared();
      assert.notEqual(background, afterExpiry);
      assert.equal(await subject(background), alice);
    } finally {
      await maintenanceApp.close();
    }
    const observed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const slowRead = t.mock.method(
      privateStore,
      "withValue",
      async (...args: Parameters<typeof readPrivate>) => {
        const selected = await readPrivate(...args);
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
    const unavailableDelete = t.mock.method(privateStore, "delete", async () => {
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
    assert.equal(await privateStore.withValue(privateRef, async () => true), true);
    // Releasing a read after OCC committed revocation must withhold the already-read bearer.
    release.resolve();
    await assert.rejects(resolving, ResourceStateConflictError);
    slowRead.mock.restore();
    unavailableDelete.mock.restore();
    const recovery = await createBackendFixture(t);
    const { worker } = recovery.startWorker({
      backends: [],
      secretDriver,
      tokenServiceDriverId: tokenOwner.id,
    });
    await worker.start();

    await waitFor("the worker to retire the disconnected account", async () => {
      const remaining = await state.read((view) =>
        view.credentialSources.findCredentialSource(namespaceId, id),
      );
      return remaining === undefined ? true : undefined;
    });
    const workerCompletion = await waitFor("the worker retirement audit", async () => {
      const result = await pool.query(
        `SELECT actor_id, details->'removedAccessBindings' AS removed FROM occ.audit_events
         WHERE action='openclaw.credential_sources.delete' AND resource_id=$1 AND outcome='success'`,
        [id],
      );
      return result.rowCount === 1 ? result : undefined;
    });
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
    await assert.rejects(
      privateStore.withValue(privateRef, async () => true),
      /Secret does not exist/,
    );
    // A second issuer becomes eligible after the first browser obtained its code. Even after the
    // template changes, callbacks from both usable versions could still be in flight.
    const pending = await begin();
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
    const secondClient = await inject("POST", "/credential-clients", {
      kind: "oauth2",
      namespaceId,
      issuer: secondIssuer,
      displayName: "Second server public registration",
      clientId: randomUUID(),
      tokenEndpointAuthMethod: "none",
    });
    assert.equal(secondClient.statusCode, 201, secondClient.body);
    const secondStart = await inject("POST", connections, {
      connectionTemplateId: secondTemplateId,
      oauthClientId: secondClient.json().data.id,
    });
    assert.equal(secondStart.statusCode, 201, secondStart.body);
    const secondState = new URL(secondStart.json().data.authorizationUrl).searchParams.get(
      "state",
    )!;
    const switchIssuer = await inject(
      "PATCH",
      "/connection-templates/" + secondTemplateId,
      manualConfig,
    );
    assert.equal(switchIssuer.statusCode, 200, switchIssuer.body);
    const ambiguous = await owner("GET", pending.callback);
    assert.match(String(ambiguous.headers.location), /reason=issuer_required/);
    const cancelSecond = await inject(
      "GET",
      `/oauth/callback?${new URLSearchParams({ state: secondState, error: "access_denied", iss: secondIssuer })}`,
    );
    assert.match(String(cancelSecond.headers.location), /reason=consent_denied/);
    assert.equal(
      (await inject("DELETE", "/connection-templates/" + secondTemplateId)).statusCode,
      204,
    );
    assert.equal(
      (await inject("DELETE", "/credential-clients/" + secondClient.json().data.id)).statusCode,
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
