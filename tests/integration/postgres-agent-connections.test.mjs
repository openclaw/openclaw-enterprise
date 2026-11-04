import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { refreshPinnedOAuthGrant } from "../../apps/controller/src/drivers/credential-refresh/oauth-token-endpoint.ts";
import { OAuthConnectionTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import { OpenShellProviderAlreadyExistsError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import { PostgresHumanAuthentication } from "../../packages/occ/src/index.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

// RFC-0023 connections through the production Fastify app, PostgreSQL State, Native IAM, and
// the real OpenShell Credential Gateway and Refresh Drivers, against a real Keycloak issuer.
// The test completes Keycloak's real login form and the Refresh Driver performs a real
// authorization-code + PKCE exchange. Keycloak validates the prepared access token the OCC
// Token Service sends to the recording OpenShell gRPC transport. Worker substitution needs k3d.

const issuer = process.env.OCC_TEST_KEYCLOAK_ISSUER;
const secretsFile = process.env.OCC_TEST_KEYCLOAK_SECRETS_FILE;
// The OpenShell gateway refuses `localhost` token hosts, so the token endpoint uses another
// name for the same Keycloak, as Google's token host differs from its issuer.
const tokenOrigin = process.env.OCC_TEST_KEYCLOAK_TOKEN_ORIGIN;
const requiresKeycloak = {
  skip:
    requiresPostgres.skip ||
    (issuer && secretsFile && tokenOrigin
      ? false
      : "Prepare the keycloak-oidc lane for OCC_TEST_KEYCLOAK_ISSUER, OCC_TEST_KEYCLOAK_SECRETS_FILE and OCC_TEST_KEYCLOAK_TOKEN_ORIGIN (docs/testing/ci.md)."),
};

const publicOrigin = "https://occ-connections.test";
const redirectUri = `${publicOrigin}/oauth/callback`;
const clientWorkspace = "oce-oauth-clients";

/** Keycloak admin REST calls as the lane's bootstrap administrator. */
async function keycloakAdmin(secrets, method, path, body) {
  const base = new URL(issuer).origin;
  const token = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: secrets.admin.username,
      password: secrets.admin.password,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(token.status, 200, "the lane administrator signs in to Keycloak");
  const response = await fetch(`${base}/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${(await token.json()).access_token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    assert.fail(`Keycloak ${method} ${path} answered ${response.status}: ${await response.text()}`);
  }
  return response.status === 200 ? response.json() : undefined;
}

/** A confidential standard-flow client with S256 PKCE and OCC's exact callback URI. */
async function createConnectionClient(secrets, realm, clientId) {
  const secret = `client-secret-${randomUUID()}`;
  await keycloakAdmin(secrets, "POST", `/realms/${realm}/clients`, {
    clientId,
    enabled: true,
    publicClient: false,
    secret,
    standardFlowEnabled: true,
    // This template requests only openid. Suppress the realm-wide default profile/email grants.
    defaultClientScopes: [],
    directAccessGrantsEnabled: false,
    redirectUris: [redirectUri],
    attributes: { "pkce.code.challenge.method": "S256", "access.token.lifespan": "12" },
  });
  return secret;
}

/**
 * Completes Keycloak's real login form over HTTP, the way a browser would, and returns the
 * redirect to OCC's callback with the authorization code and `state`, without following it.
 */
async function approveConsent(authorizationUrl, username, password) {
  const cookies = new Map();
  const remember = (response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  };
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  const login = await fetch(authorizationUrl, { redirect: "manual" });
  remember(login);
  assert.equal(login.status, 200, "Keycloak shows its login form");
  const form = (await login.text()).match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/);
  assert.ok(form, "the login page has Keycloak's login form");
  const submitted = await fetch(form[1].replaceAll("&amp;", "&"), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
    body: new URLSearchParams({ username, password, credentialId: "" }),
  });
  assert.equal(submitted.status, 302, "Keycloak redirects back after sign-in");
  const location = new URL(submitted.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, redirectUri);
  return location;
}

/** Records the OpenShell RPCs the Drivers send; never mints or substitutes credentials. */
function recordingOpenShell() {
  const providers = new Map();
  const updates = new EventEmitter();
  const profiles = new Map();
  const key = (workspace, name) => `${workspace}/${name}`;
  const client = {
    async getProviderProfile(workspace, id) {
      return profiles.get(key(workspace, id));
    },
    async importProviderProfile(workspace, profile) {
      profiles.set(key(workspace, profile.id), structuredClone(profile));
    },
    async updateProviderProfile(workspace, profile) {
      profiles.set(key(workspace, profile.id), structuredClone(profile));
    },
    async deleteProviderProfile(workspace, id) {
      profiles.delete(key(workspace, id));
    },
    async createProvider(input) {
      const id = key(input.workspace, input.name);
      if (providers.has(id)) {
        throw new OpenShellProviderAlreadyExistsError();
      }
      providers.set(id, {
        ...structuredClone(input),
        config: input.config ?? {},
        uid: randomUUID(),
        resourceVersion: "1",
      });
      return providers.get(id);
    },
    async getProvider(workspace, name) {
      return providers.get(key(workspace, name));
    },
    async listProviders(workspace) {
      return [...providers.values()].filter((provider) => provider.workspace === workspace);
    },
    async deleteProvider(workspace, name) {
      providers.delete(key(workspace, name));
    },
    async updateProviderCredentials(workspace, name, credentials) {
      Object.assign(providers.get(key(workspace, name)).credentials, credentials);
    },
    async getProviderCredential(workspace, name, credentialKey) {
      return { value: providers.get(key(workspace, name)).credentials[credentialKey] };
    },
    async updateProviderCredentialsConditionally(input, expectedResourceVersion) {
      const provider = providers.get(key(input.workspace, input.name));
      assert.equal(provider.resourceVersion, expectedResourceVersion);
      Object.assign(provider, {
        credentials: structuredClone(input.credentials),
        credentialExpirationTimes: structuredClone(input.credentialExpirationTimes),
        config: input.config ?? provider.config,
        resourceVersion: String(Number(expectedResourceVersion) + 1),
      });
      updates.emit(input.name);
      return provider;
    },
    close() {},
  };
  return { client, providers, updates };
}

function selectConnectionDrivers(controller) {
  const openShell = recordingOpenShell();
  const backend = createOpenShellBackend(
    {
      id: "openshell-test",
      type: "openshell",
      configuration: { endpoint: "http://127.0.0.1:1" },
      drivers: {
        credential_gateway: "openshell-credentials",
        sandbox: "openshell-sandbox",
        credential_refresh: "openshell-refresh",
      },
    },
    { gatewayClient: openShell.client },
  );
  const gateway = new OpenShellCredentialGatewayDriver(
    { binaries: ["/app/bin/codex"], toolBinaries: ["/usr/local/bin/gog"] },
    { id: "openshell-credentials", backend },
  );
  const refresh = new OpenShellCredentialRefreshDriver(
    { clientWorkspace },
    { id: "openshell-refresh", backend },
  );
  controller.registerDriver(gateway);
  controller.selectDriver("credential_gateway", gateway.id);
  controller.registerDriver(refresh);
  controller.selectDriver("credential_refresh", refresh.id);
  return { openShell, gateway, refresh };
}

test(
  "one consent supplies independently authorized Agent connections in a Namespace",
  requiresKeycloak,
  async (t) => {
    const secrets = JSON.parse(await readFile(secretsFile, "utf8"));
    let provision;
    // Source deletion waits out the Credential Gateway's registration fence (70 seconds), so
    // the test moves OCC's clock forward instead of sleeping.
    let skewMs = 0;
    const secretDriver = createTestSecretDriver();
    const tokenService = new TokenService(
      new OAuthConnectionTokens(secretDriver, refreshPinnedOAuthGrant),
    );
    const fixture = await createPostgresAgentApp(t, {
      secretDriver,
      controllerOptions: {
        now: () => new Date(Date.now() + skewMs),
        preparedTokens: tokenService,
      },
      label: `connections-${randomUUID().slice(0, 8)}`,
      authSecret: "openclaw-connections-test-auth-secret-minimum-32-bytes",
      appOptions: {
        publicOrigin,
        provisionAuthAccount: (...input) => provision(...input),
      },
    });
    const { app, controller, state, pool, inject } = fixture;
    const installation = await state.loadInstallation();
    const humanAuthentication = new PostgresHumanAuthentication(
      state,
      installation.id,
      betterAuthIssuer(installation.id),
    );
    provision = async (seed, auditEvent, prepared, external) => {
      validateAuthAccountPrincipalSeed(
        seed,
        await state.loadNativeIAMState(installation.id),
        installation.id,
      );
      await humanAuthentication.provisionPasswordAccount(prepared, seed, auditEvent, external);
    };

    // The Agent is deployed before the Credential Gateway is selected: with a gateway, OCC
    // refuses the API-key Harness binding this fixture uses.
    const { namespace, agent } = await fixture.deployAgent("connections");
    const other = await fixture.deployAgent("connections other");
    const makeAgent = async (name) => {
      const result = await inject("POST", `/namespaces/${namespace.id}/agents`, {
        name,
        configurationId: agent.configurationId,
        harnessAuth: agent.harnessAuth,
      });
      assert.equal(result.statusCode, 201, result.body);
      return result.json().data;
    };
    const agentB = await makeAgent("Second Agent");
    const agentC = await makeAgent("Unattached Agent");

    // Only the Kubernetes Compute Driver places Credential Gateway sources; like it, this
    // placement names the Namespace's Sandbox view with a short Kubernetes namespace label,
    // which OpenShell operator mode uses as the Workspace name.
    fixture.computeDriver.resolveSandboxNamespace = async (namespace) => ({
      ...namespace,
      name: `oce-${namespace.id.slice(3, 11)}`,
    });
    const { openShell, gateway, refresh } = selectConnectionDrivers(controller);

    // Bob and Carol are ordinary people with no Installation grant.
    const people = {};
    for (const name of ["bob", "carol"]) {
      const email = `connections-${name}-${randomUUID()}@example.com`;
      const password = `generated-password-${randomUUID()}`;
      const created = await inject("POST", "/api/auth/accounts", { email, password, name });
      assert.equal(created.statusCode, 201, created.body);
      const signIn = () =>
        signInWithEmailPassword({
          fetch: async (request) => {
            const url = new URL(request.url);
            const headers = Object.fromEntries(request.headers);
            const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
            const result = await app.inject({
              method: request.method,
              url: `${url.pathname}${url.search}`,
              headers: { ...headers, host: "127.0.0.1" },
              ...(body === undefined ? {} : { payload: body }),
            });
            return new Response(result.statusCode === 204 ? null : result.rawPayload, {
              status: result.statusCode,
              headers: Object.entries(result.headers).flatMap(([name, value]) =>
                (Array.isArray(value) ? value : [value]).map((entry) => [name, String(entry)]),
              ),
            });
          },
          email,
          password,
        });
      const requestAs = (session) => (method, url, body) =>
        app.inject({
          method,
          url,
          headers: {
            host: "127.0.0.1",
            ...authenticatedHeaders(session),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
        });
      people[name] = {
        principalId: created.json().data.principalId,
        request: requestAs(await signIn()),
        signInAgain: async () => requestAs(await signIn()),
      };
    }
    const { bob, carol } = people;

    // Two realms register the same client ID; RFC 6749 scopes a client ID to its issuer.
    const realmB = `oce-connections-${randomUUID().slice(0, 8)}`;
    await keycloakAdmin(secrets, "POST", "/realms", { realm: realmB, enabled: true });
    t.after(() => keycloakAdmin(secrets, "DELETE", `/realms/${realmB}`).catch(() => {}));
    const clientId = `oce-connect-${randomUUID().slice(0, 8)}`;
    const clientSecretA = await createConnectionClient(secrets, "oce", clientId);
    const clientSecretB = await createConnectionClient(secrets, realmB, clientId);
    t.after(async () => {
      const clients = await keycloakAdmin(
        secrets,
        "GET",
        `/realms/oce/clients?clientId=${clientId}`,
      );
      for (const client of clients ?? []) {
        await keycloakAdmin(secrets, "DELETE", `/realms/oce/clients/${client.id}`).catch(() => {});
      }
    });

    const templateBody = (realm, clientSecret) => ({
      displayName: `Keycloak ${realm}`,
      issuer: `${new URL(issuer).origin}/realms/${realm}`,
      authorizationUrl: `${new URL(issuer).origin}/realms/${realm}/protocol/openid-connect/auth`,
      tokenUrl: `${tokenOrigin}/realms/${realm}/protocol/openid-connect/token`,
      clientId,
      clientSecret,
      scopes: ["openid"],
      endpoint: { host: "api.connections.test", port: 443, path: "/**" },
      envVar: "CONNECTION_TOKEN",
    });
    // The template refuses loopback token URLs before a person can start consent.
    const unreachable = await inject("POST", "/connection-templates", {
      ...templateBody("oce", clientSecretA),
      tokenUrl: `${new URL(issuer).origin}/realms/oce/protocol/openid-connect/token`,
    });
    assert.equal(unreachable.statusCode, 400, unreachable.body);
    assert.match(unreachable.json().error.message, /token_url host/);
    const narrow = templateBody("oce", clientSecretA);
    const unsupportedAccess = await inject("POST", "/connection-templates", {
      ...narrow,
      endpoint: { ...narrow.endpoint, access: "read-only" },
    });
    assert.equal(unsupportedAccess.statusCode, 400, unsupportedAccess.body);
    assert.match(unsupportedAccess.json().error.message, /read-only/);
    assert.deepEqual((await inject("GET", "/connection-templates")).json().data, []);
    assert.equal(
      Array.from(openShell.providers.values()).filter(
        (provider) => provider.workspace === clientWorkspace,
      ).length,
      0,
    );
    const createdA = await inject(
      "POST",
      "/connection-templates",
      templateBody("oce", clientSecretA),
    );
    assert.equal(createdA.statusCode, 201, createdA.body);
    const templateA = createdA.json().data;
    assert.equal(templateA.redirectUri, redirectUri);
    assert.equal("clientSecret" in templateA.current, false, "the secret is write-only");
    const createdB = await inject(
      "POST",
      "/connection-templates",
      templateBody(realmB, clientSecretB),
    );
    assert.equal(createdB.statusCode, 201, createdB.body);
    const templateB = createdB.json().data;
    assert.notEqual(
      templateA.current.clientRegistrationId,
      templateB.current.clientRegistrationId,
      "the same client ID at another issuer is a separate registration",
    );

    // Bob may connect templateA for Agents in this Namespace through a Namespace binding.
    const nsBinding = await inject("POST", "/iam/access-bindings", {
      subjectKind: "namespace",
      subjectId: namespace.id,
      roleId: "role_connection_template_user",
      resourceKind: "connection_template",
      resourceId: templateA.id,
    });
    assert.equal(nsBinding.statusCode, 201, nsBinding.body);
    const usable = await bob.request("GET", `/namespaces/${namespace.id}/connection-templates`);
    assert.equal(usable.statusCode, 403, "Bob cannot read the Namespace yet");

    // Bob can read the Namespace and update one exact Agent.
    const role = await inject("POST", `/namespaces/${namespace.id}/iam/roles`, {
      name: "Namespace reader",
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    assert.equal(role.statusCode, 201, role.body);
    for (const [roleId, resourceKind, resourceId] of [
      [role.json().data.id, "namespace", namespace.id],
    ]) {
      const bound = await inject("POST", `/namespaces/${namespace.id}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId: bob.principalId,
        roleId,
        resourceKind,
        resourceId,
      });
      assert.equal(bound.statusCode, 201, bound.body);
    }
    // Bob's exact-Agent grant comes through the same Namespace policy API the console uses.
    const agentRole = await inject("POST", `/namespaces/${namespace.id}/iam/roles`, {
      name: "Agent owner",
      permissions: ["read", "update", "deploy", "operate", "administer"].map((action) => ({
        action,
        resourceKind: "agent",
      })),
    });
    assert.equal(agentRole.statusCode, 201, agentRole.body);
    const agentGrant = await inject("POST", `/namespaces/${namespace.id}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: bob.principalId,
      roleId: agentRole.json().data.id,
      resourceKind: "agent",
      resourceId: agent.id,
    });
    assert.equal(agentGrant.statusCode, 201, agentGrant.body);
    const listed = await bob.request("GET", `/namespaces/${namespace.id}/connection-templates`);
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      listed.json().data.map((template) => template.id),
      [templateA.id],
      "only the template bound to this Namespace is usable",
    );

    // A service key cannot consent for a person.
    const serviceKeyStart = await app.inject({
      method: "POST",
      url: `/namespaces/${namespace.id}/agents/${agent.id}/connections`,
      headers: {
        host: "127.0.0.1",
        "x-api-key": "not-a-session",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ connectionTemplateId: templateA.id }),
    });
    assert.equal(serviceKeyStart.statusCode === 401 || serviceKeyStart.statusCode === 403, true);

    // Carol has no binding for templateA in any Namespace context.
    const carolStart = await carol.request(
      "POST",
      `/namespaces/${namespace.id}/agents/${agent.id}/connections`,
      { connectionTemplateId: templateA.id },
    );
    assert.equal(carolStart.statusCode, 403, carolStart.body);

    const namespaceConnections = `/namespaces/${namespace.id}/connections`;
    const started = await bob.request("POST", namespaceConnections, {
      connectionTemplateId: templateA.id,
    });
    assert.equal(started.statusCode, 201, started.body);
    const { authorizationUrl, credentialSourceId } = started.json().data;
    const account = `${namespaceConnections}/${credentialSourceId}`;
    const agentPath = (target) => `/namespaces/${namespace.id}/agents/${target.id}`;
    const attachment = (target) => `${agentPath(target)}/connections/${credentialSourceId}`;
    const pending = await inject("POST", attachment(agentB));
    assert.equal(pending.statusCode, 409, pending.body);
    const bypass = await inject("PATCH", agentPath(agentB), {
      configurationId: agentB.configurationId,
      credentialSources: [{ sourceId: credentialSourceId }],
    });
    assert.ok(bypass.statusCode >= 400 && bypass.statusCode < 500, bypass.body);
    const consentUrl = new URL(authorizationUrl);
    assert.equal(consentUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(consentUrl.searchParams.get("redirect_uri"), redirectUri);
    const approved = await approveConsent(authorizationUrl, "alice", secrets.users.alice.password);
    const callbackPath = `/oauth/callback${approved.search}`;

    // Another person's session cannot complete Bob's connection, and it is not consumed.
    const stolen = await carol.request("GET", callbackPath);
    assert.equal(stolen.statusCode, 303, stolen.body);
    assert.match(stolen.headers.location, /connection=failed&reason=unknown_session/);
    const refusedAudit = await pool.query(
      `SELECT actor_id, details FROM occ.audit_events
       WHERE action = 'openclaw.agents.connections.complete' AND outcome = 'failure'`,
    );
    assert.deepEqual(
      refusedAudit.rows.map((row) => [row.actor_id, row.details?.__occAuditMetadata?.reasonCode]),
      [[carol.principalId, "UNKNOWN_SESSION"]],
      "the refused callback is audited with its reason and the person who sent it",
    );

    const otherBob = await bob.signInAgain();
    const anotherLogin = await otherBob("GET", callbackPath);
    assert.match(anotherLogin.headers.location, /connection=failed&reason=unknown_session/);
    const completed = await bob.request("GET", callbackPath);
    assert.equal(completed.statusCode, 303, completed.body);
    assert.equal(completed.headers["referrer-policy"], "no-referrer");
    assert.match(completed.headers.location, /connection=connected$/);
    assert.equal(completed.headers.location.includes("code="), false);

    // A replayed callback never exchanges the code twice.
    const replayed = await bob.request("GET", callbackPath);
    assert.match(replayed.headers.location, /reason=unknown_session/);

    const prepared = [...openShell.providers.values()].find((entry) =>
      entry.name.startsWith("oce-cs-"),
    );
    assert.ok(prepared, "the Token Service installed a worker provider");
    assert.deepEqual(
      Object.keys(prepared.credentials),
      ["CONNECTION_TOKEN"],
      "the worker receives only its access token",
    );
    assert.ok(Date.parse(prepared.credentialExpirationTimes.CONNECTION_TOKEN) > Date.now());
    const accessToken = prepared.credentials.CONNECTION_TOKEN;
    const subjectFor = async (bearer) => {
      const response = await fetch(`${issuer}/protocol/openid-connect/userinfo`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      assert.equal(response.status, 200, "Keycloak accepts the prepared bearer from the sender");
      return (await response.json()).sub;
    };
    const subject = await subjectFor(accessToken);
    assert.ok(subject);

    // Pause the public rotate action at its first Secret read, after it commits the due marker.
    // A competing maintenance pass must fulfill that request even though the original bearer is
    // still fresh. Both callers must deliver the same replacement.
    const resourceVersion = prepared.resourceVersion;
    const reading = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const readSecret = secretDriver.withValue.bind(secretDriver);
    t.mock.method(
      secretDriver,
      "withValue",
      async (...args) => {
        reading.resolve();
        await resume.promise;
        return readSecret(...args);
      },
      { times: 1 },
    );
    const rotating = inject(
      "POST",
      `/namespaces/${namespace.id}/credential-sources/${credentialSourceId}/rotate`,
    );
    let workerToken;
    try {
      await Promise.race([
        reading.promise,
        rotating.then(() => {
          throw new Error("Rotation ended before reading custody.");
        }),
      ]);
      await controller.maintainConnectionToken(namespace.id, credentialSourceId);
      workerToken = prepared.credentials.CONNECTION_TOKEN;
      assert.equal(
        workerToken !== accessToken,
        true,
        "the competing worker fulfilled the rotation",
      );
    } finally {
      resume.resolve();
      await rotating;
    }
    const rotateSource = await rotating;
    assert.equal(rotateSource.statusCode, 200, rotateSource.body);
    assert.equal(
      prepared.credentials.CONNECTION_TOKEN === workerToken,
      true,
      "the API reused the worker's replacement",
    );
    const updatedProvider = openShell.providers.get(`${prepared.workspace}/${prepared.name}`);
    assert.notEqual(updatedProvider.resourceVersion, resourceVersion);
    const renewedToken = updatedProvider.credentials.CONNECTION_TOKEN;
    assert.equal(renewedToken !== accessToken, true, "Keycloak issued a different bearer");
    assert.ok(Date.parse(updatedProvider.credentialExpirationTimes.CONNECTION_TOKEN) > Date.now());
    assert.equal(await subjectFor(renewedToken), subject);
    const privateWrite = secretDriver.calls.find(
      (entry) => entry.operation === "compareAndSwap" && entry.value.includes('"refreshToken"'),
    );
    assert.ok(privateWrite, "the Token Service durably accepted the refresh grant");
    const { refreshToken } = JSON.parse(privateWrite.value);
    assert.ok(refreshToken);
    const providerEvidence = JSON.stringify(prepared);
    assert.equal(
      providerEvidence.includes(refreshToken) || providerEvidence.includes(clientSecretA),
      false,
      "no refresh grant or client secret reached the worker provider",
    );

    const accounts = await bob.request("GET", namespaceConnections);
    assert.equal(accounts.statusCode, 200, accounts.body);
    assert.deepEqual(
      accounts
        .json()
        .data.map((row) => [
          row.credentialSourceId,
          row.ownerPrincipalId,
          row.connectionTemplateVersion,
        ]),
      [[credentialSourceId, bob.principalId, 1]],
    );
    const attachedTo = async (target) => {
      const response = await inject("GET", `${agentPath(target)}/connections`);
      assert.equal(response.statusCode, 200, response.body);
      return response.json().data.map(({ credentialSourceId }) => credentialSourceId);
    };
    assert.deepEqual(await attachedTo(agent), [], "consent did not attach the source to any Agent");
    const ownerAttach = await bob.request("POST", attachment(agent));
    assert.equal(ownerAttach.statusCode, 204, ownerAttach.body);
    const unauthorized = await bob.request("POST", attachment(agentC));
    assert.equal(unauthorized.statusCode, 403, unauthorized.body);
    // The administrator can use this source and update B. Granting C's editor only read
    // access to the source must still refuse the same operation.
    const share = await inject("POST", attachment(agentB));
    assert.equal(share.statusCode, 204, share.body);
    for (const [target, id] of [
      [agent, credentialSourceId],
      [agentB, credentialSourceId],
      [agentC, undefined],
    ]) {
      assert.deepEqual(await attachedTo(target), id ? [id] : []);
    }
    const readRole = await inject("POST", `/namespaces/${namespace.id}/iam/roles`, {
      name: "View connected account",
      permissions: [{ action: "read", resourceKind: "credential_source" }],
    });
    assert.equal(readRole.statusCode, 201, readRole.body);
    for (const [roleId, resourceKind, resourceId] of [
      [readRole.json().data.id, "credential_source", credentialSourceId],
      [agentRole.json().data.id, "agent", agentC.id],
    ]) {
      const permission = await inject("POST", `/namespaces/${namespace.id}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId: carol.principalId,
        roleId,
        resourceKind,
        resourceId,
      });
      assert.equal(permission.statusCode, 201, permission.body);
    }
    const carolNs = await inject("POST", `/namespaces/${namespace.id}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: carol.principalId,
      roleId: role.json().data.id,
      resourceKind: "namespace",
      resourceId: namespace.id,
    });
    assert.equal(carolNs.statusCode, 201, carolNs.body);
    const visibleIds = async (user, path) => {
      const result = await user.request("GET", path);
      assert.equal(result.statusCode, 200, result.body);
      return result.json().data.map((connection) => connection.credentialSourceId);
    };
    assert.deepEqual(
      await visibleIds(carol, namespaceConnections),
      [credentialSourceId],
      "source-read makes the saved account visible before it can be attached",
    );
    const bypassAttach = await inject("PATCH", agentPath(agentC), {
      configurationId: agentC.configurationId,
      credentialSources: [{ sourceId: credentialSourceId }],
    });
    assert.equal(bypassAttach.statusCode, 409, bypassAttach.body);
    const bypassDetach = await inject("PATCH", agentPath(agentB), {
      configurationId: agentB.configurationId,
      credentialSources: [],
    });
    assert.equal(bypassDetach.statusCode, 409, bypassDetach.body);
    const readOnlyAttach = await carol.request("POST", attachment(agentC));
    assert.equal(readOnlyAttach.statusCode, 403, readOnlyAttach.body);
    // Operate permits attachment by known ID. Both picker endpoints still require source read.
    const bindingsApi = `/namespaces/${namespace.id}/iam/access-bindings`;
    const accessBindings = (await inject("GET", bindingsApi)).json().data;
    const carolRead = accessBindings.find(
      (binding) =>
        binding.subjectId === carol.principalId && binding.roleId === readRole.json().data.id,
    );
    assert.equal((await inject("DELETE", `${bindingsApi}/${carolRead.id}`)).statusCode, 204);
    const useRole = await inject("POST", `/namespaces/${namespace.id}/iam/roles`, {
      name: "Use saved account",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    });
    assert.equal(useRole.statusCode, 201, useRole.body);
    const useOnly = await inject("POST", bindingsApi, {
      subjectKind: "identity",
      subjectId: carol.principalId,
      roleId: useRole.json().data.id,
      resourceKind: "credential_source",
      resourceId: credentialSourceId,
    });
    assert.equal(useOnly.statusCode, 201, useOnly.body);
    assert.deepEqual(await visibleIds(carol, namespaceConnections), []);
    assert.equal((await carol.request("POST", attachment(agentC))).statusCode, 204);
    assert.deepEqual(await visibleIds(carol, `${agentPath(agentC)}/connections`), []);
    assert.equal((await carol.request("DELETE", attachment(agentC))).statusCode, 200);
    const foreign = await inject(
      "POST",
      `/namespaces/${other.namespace.id}/agents/${other.agent.id}/connections/${credentialSourceId}`,
    );
    assert.ok(foreign.statusCode >= 400 && foreign.statusCode < 500, foreign.body);

    // An edit creates version 2; Bob's connection keeps the version he approved.
    const edited = await inject("PATCH", `/connection-templates/${templateA.id}`, {
      endpoint: { host: "other.connections.test", port: 443, path: "/**" },
    });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().data.current.version, 2);
    const kept = await state.read((view) =>
      view.agentConnections.findAgentConnection(namespace.id, credentialSourceId),
    );
    assert.equal(kept.connectionTemplateVersion, 1);
    const source = await state.read((view) =>
      view.credentialSources.findCredentialSource(namespace.id, credentialSourceId),
    );
    assert.equal(source.config.host, "api.connections.test", "the approved endpoint is unchanged");

    // Rotating realm B's secret leaves realm A's stored secret untouched.
    const clientProviders = () =>
      [...openShell.providers.values()].filter(
        (provider) => provider.workspace === clientWorkspace,
      );
    const before = clientProviders().map((provider) => ({ ...provider.credentials }));
    const rotated = await inject(
      "POST",
      `/connection-templates/${templateB.id}/rotate-client-secret`,
      {
        clientSecret: `rotated-${randomUUID()}`,
      },
    );
    assert.equal(rotated.statusCode, 200, rotated.body);
    const after = clientProviders().map((provider) => ({ ...provider.credentials }));
    assert.equal(
      after.filter(
        (credentials, index) => credentials.OCE_CLIENT_SECRET !== before[index].OCE_CLIENT_SECRET,
      ).length,
      1,
      "only the rotated registration changed",
    );

    // A template that a connection uses cannot be deleted.
    const deleteUsed = await inject("DELETE", `/connection-templates/${templateA.id}`);
    assert.equal(deleteUsed.statusCode, 409, deleteUsed.body);

    skewMs = 71_000;
    const removed = await bob.request("DELETE", attachment(agent));
    assert.equal(removed.statusCode, 200, removed.body);
    assert.deepEqual(removed.json().data, { withdrawalRequested: false, deleted: false });
    assert.deepEqual(await attachedTo(agent), []);
    assert.deepEqual(await attachedTo(agentB), [credentialSourceId]);
    const bobSourceGrant = accessBindings.find(
      (binding) =>
        binding.subjectId === bob.principalId && binding.resourceId === credentialSourceId,
    );
    assert.ok(bobSourceGrant);
    assert.equal((await inject("DELETE", `${bindingsApi}/${bobSourceGrant.id}`)).statusCode, 204);
    assert.equal(
      (await bob.request("POST", attachment(agent))).statusCode,
      403,
      "the original consent owner also needs a current source-use grant to attach",
    );

    const grants = await state.read((view) => view.iamPolicy.listAccessBindings(namespace.id));
    assert.deepEqual(
      grants
        .filter(
          (binding) =>
            binding.resourceId === credentialSourceId &&
            binding.roleId.endsWith("_agent_credential_source_operate"),
        )
        .map((binding) => binding.subjectId),
      [agentB.servicePrincipalId],
    );
    const readOnlyDelete = await carol.request("DELETE", account);
    assert.equal(readOnlyDelete.statusCode, 403, readOnlyDelete.body);
    const sandbox = {
      id: "openshell-sandbox",
      capability: "sandbox",
      implementation: "openshell",
      displayName: "OpenShell test Sandbox",
      facets: ["networking"],
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      async cleanup() {},
    };
    controller.registerDriver(sandbox);
    controller.selectDriver("sandbox", sandbox.id);
    const config = await inject("POST", `/namespaces/${namespace.id}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("codex", "gpt-4.1"),
    });
    assert.equal(config.statusCode, 201, config.body);
    const prepareB = await inject("PATCH", agentPath(agentB), {
      configurationId: config.json().data.id,
      executionMode: "dedicated",
      harnessAuth: { method: "runtime" },
    });
    assert.equal(prepareB.statusCode, 200, prepareB.body);
    const admission = await inject("POST", `${agentPath(agentB)}/deploy`);
    assert.ok([201, 202].includes(admission.statusCode), admission.body);
    const bRevision = admission.json().data;
    const readWithdrawal = () =>
      state.read((view) =>
        view.credentialSources.findCredentialWithdrawal(
          namespace.id,
          bRevision.id,
          credentialSourceId,
        ),
      );
    assert.deepEqual(
      bRevision.credentialSources.map((binding) => binding.sourceId),
      [credentialSourceId],
    );
    assert.equal(await readWithdrawal(), undefined);
    const bSource = `${agentPath(agentB)}/credential-sources/${credentialSourceId}`;
    // A candidate alone cannot start a generic withdrawal. Detach records the request
    // while B's first deployment is queued, so it can then be inspected and replayed.
    const firstRequest = await inject("POST", `${bSource}/withdraw`);
    assert.equal(firstRequest.statusCode, 409, firstRequest.body);
    const selected = await inject("DELETE", attachment(agentB));
    assert.equal(selected.statusCode, 200, selected.body);
    assert.equal(selected.json().data.withdrawalRequested, true);
    assert.equal((await readWithdrawal()).state, "pending");
    const status = await inject("GET", `${bSource}/withdrawal`);
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().data.revisionId, bRevision.id);
    assert.equal(status.json().data.state, "pending");
    const retry = await inject("POST", `${bSource}/withdraw`);
    assert.equal(retry.statusCode, 202, retry.body);
    assert.equal(retry.json().data.revisionId, bRevision.id);
    assert.equal(retry.json().data.withdrawalInProgress, true);
    assert.equal((await inject("POST", attachment(agentB))).statusCode, 204);

    // The owner can globally revoke the grant even while B has a pending revision and Bob
    // cannot edit B. Fail its first external removal after the durable revocation commits.
    const originalRemoval = openShell.client.deleteProvider;
    openShell.client.deleteProvider = async () => {
      throw new Error("injected gateway outage");
    };
    const interrupted = await bob.request("DELETE", account);
    assert.ok(interrupted.statusCode >= 500, interrupted.body);
    openShell.client.deleteProvider = originalRemoval;
    const retired = () =>
      state.read((view) =>
        view.agentConnections.findAgentConnection(namespace.id, credentialSourceId),
      );
    const startedRetirement = await retired();
    assert.equal(startedRetirement.revocationRequestedBy, bob.principalId);
    assert.equal(startedRetirement.revokedAt, undefined);
    assert.deepEqual(await attachedTo(agentB), []);
    assert.deepEqual((await bob.request("GET", namespaceConnections)).json().data, []);
    const stillBlocked = await inject("POST", attachment(agentB));
    assert.equal(stillBlocked.statusCode, 409, stillBlocked.body);
    const ordinaryDelete = await inject(
      "DELETE",
      `/namespaces/${namespace.id}/credential-sources/${credentialSourceId}`,
    );
    assert.equal(ordinaryDelete.statusCode, 409, ordinaryDelete.body);
    const revoked = await bob.request("DELETE", account);
    assert.equal(revoked.statusCode, 204, revoked.body);
    assert.ok(
      (await retired()).revokedAt,
      "retain the confirmed revocation for the pending revision",
    );
    assert.equal((await readWithdrawal()).requestedBy, bob.principalId);
    assert.equal(openShell.providers.has(`${prepared.workspace}/${prepared.name}`), false);
    assert.ok(
      !(await state.read((view) => view.iamPolicy.listAccessBindings(namespace.id))).some(
        (binding) =>
          binding.resourceId === credentialSourceId &&
          binding.subjectId === agentB.servicePrincipalId,
      ),
    );
    // Replaying maintenance for a retired account is safe while withdrawal still holds it.
    await controller.finishConnectionRevocation(namespace.id, credentialSourceId);
    assert.equal((await readWithdrawal()).state, "pending");

    // Model the worker's persisted confirmation. Its provider enforcement and retry
    // paths are exercised in postgres-worker-agent-revision-credential-sources.test.mjs.
    await controller.transact((unit) =>
      unit.credentialSources.markCredentialWithdrawalRevoked(
        namespace.id,
        bRevision.id,
        credentialSourceId,
        new Date().toISOString(),
      ),
    );
    await controller.finishConnectionRevocation(namespace.id, credentialSourceId);
    assert.equal(await retired(), undefined);
    assert.equal(
      await state.read((view) =>
        view.credentialSources.findCredentialSource(namespace.id, credentialSourceId),
      ),
      undefined,
    );

    // The Agent-scoped start route keeps its browser return context. Even that route
    // cannot attach an account when the provider reports that consent was denied.
    const contextualStart = await bob.request("POST", `${agentPath(agent)}/connections`, {
      connectionTemplateId: templateA.id,
    });
    assert.equal(contextualStart.statusCode, 201, contextualStart.body);
    const stateParameter = new URL(contextualStart.json().data.authorizationUrl).searchParams.get(
      "state",
    );
    const denied = await bob.request(
      "GET",
      `/oauth/callback?${new URLSearchParams({ state: stateParameter, error: "access_denied" })}`,
    );
    assert.equal(denied.statusCode, 303, denied.body);
    assert.match(denied.headers.location, /reason=consent_denied/);
    assert.deepEqual(await attachedTo(agent), []);

    const findSource = (id) =>
      state.read((view) => view.credentialSources.findCredentialSource(namespace.id, id));
    assert.equal(
      await findSource(contextualStart.json().data.credentialSourceId),
      undefined,
      "denied consent releases the register-only reservation immediately",
    );

    const beginAttempt = async () => {
      const started = await bob.request("POST", namespaceConnections, {
        connectionTemplateId: templateA.id,
      });
      assert.equal(started.statusCode, 201, started.body);
      return started.json().data;
    };
    // Even a callback with the correct state cannot exchange against a different issuer.
    const mixed = await beginAttempt();
    const mixedState = new URL(mixed.authorizationUrl).searchParams.get("state");
    const mismatch = await bob.request(
      "GET",
      `/oauth/callback?${new URLSearchParams({ state: mixedState, code: "unused", iss: "https://wrong.example" })}`,
    );
    assert.match(mismatch.headers.location, /reason=issuer_mismatch/);
    assert.equal(await findSource(mixed.credentialSourceId), undefined);

    // A closed popup has no callback. The worker expires the attempt and its pending source.
    const unnamedIssuer = await beginAttempt();
    const unnamedState = new URL(unnamedIssuer.authorizationUrl).searchParams.get("state");
    const missingIssuer = await bob.request(
      "GET",
      `/oauth/callback?${new URLSearchParams({ state: unnamedState, code: "unused" })}`,
    );
    assert.match(missingIssuer.headers.location, /reason=issuer_required/);
    assert.equal(await findSource(unnamedIssuer.credentialSourceId), undefined);
    const abandoned = await beginAttempt();
    skewMs += 11 * 60_000;
    const late = await bob.request(
      "GET",
      `/oauth/callback?${new URLSearchParams({
        state: new URL(abandoned.authorizationUrl).searchParams.get("state"),
        code: "unused",
      })}`,
    );
    assert.match(late.headers.location, /reason=unknown_session/);
    await controller.expireConnectionSessions(10);
    assert.equal(await findSource(abandoned.credentialSourceId), undefined);
    const leftover = await pool.query(
      "SELECT count(*)::int AS count FROM occ.connection_sessions WHERE namespace_id = $1",
      [namespace.id],
    );
    assert.equal(leftover.rows[0].count, 0, "finished and expired attempts leave no PKCE material");

    skewMs = 0;
    // With a single issuer configured, OCC accepts a legacy callback without iss and
    // exchanges the code with the issuer and client registration pinned at start.
    const removeSecondIssuer = await inject("DELETE", `/connection-templates/${templateB.id}`);
    assert.equal(removeSecondIssuer.statusCode, 204, removeSecondIssuer.body);
    const legacy = await beginAttempt();
    const legacyApproval = await approveConsent(
      legacy.authorizationUrl,
      "alice",
      secrets.users.alice.password,
    );
    legacyApproval.searchParams.delete("iss");
    const legacyDone = await bob.request("GET", `/oauth/callback?${legacyApproval.searchParams}`);
    assert.match(legacyDone.headers.location, /connection=connected$/);
    // Give the normal worker its own database pool and the same selected senders. Keycloak's
    // short token lifetime makes this persisted source come due without changing either clock.
    const sender = [...openShell.providers.values()].find((entry) =>
      entry.name.startsWith("oce-cs-"),
    );
    assert.ok(sender);
    const previousToken = sender.credentials.CONNECTION_TOKEN;
    const previousVersion = sender.resourceVersion;
    const originalUpdate = openShell.client.updateProviderCredentialsConditionally;
    openShell.client.updateProviderCredentialsConditionally = async () => {
      throw new Error("injected sender outage");
    };
    const failedPublish = await inject(
      "POST",
      `/namespaces/${namespace.id}/credential-sources/${legacy.credentialSourceId}/rotate`,
    );
    openShell.client.updateProviderCredentialsConditionally = originalUpdate;
    assert.ok(failedPublish.statusCode >= 500, failedPublish.body);
    assert.equal(previousVersion, sender.resourceVersion, "sender still holds the original bearer");
    const due = await pool.query(
      "SELECT next_refresh_at <= now() AS due FROM occ.connection_token_custody WHERE credential_source_id = $1",
      [legacy.credentialSourceId],
    );
    assert.equal(due.rows[0]?.due, true, "failed publication committed an immediate retry");

    const { computeDriver } = fixture;
    const configurationDriver = controller.selectedDriver("configuration");
    const iamDriver = controller.selectedDriver("iam");
    const workerDrivers = [
      computeDriver,
      configurationDriver,
      iamDriver,
      secretDriver,
      gateway,
      refresh,
      sandbox,
    ];
    const worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl }),
      drivers: {
        installation: {
          drivers: Object.fromEntries(
            workerDrivers.map((driver) => [
              driver.capability,
              { id: driver.id, configuration: {} },
            ]),
          ),
        },
        computeDriver,
        configurationDriver,
        createIAMDriver: () => iamDriver,
        secretDriver,
        sandboxDriver: sandbox,
        credentialGatewayDriver: gateway,
        credentialRefreshDriver: refresh,
        tokenService,
      },
      pollIntervalMs: 100,
      emit() {},
    });
    const workerProjection = once(openShell.updates, sender.name, {
      signal: AbortSignal.timeout(30_000),
    });
    try {
      await Promise.all([worker.start(), workerProjection]);
      assert.equal(sender.credentials.CONNECTION_TOKEN !== previousToken, true);
      assert.equal(await subjectFor(sender.credentials.CONNECTION_TOKEN), subject);
      const recoveredToken = sender.credentials.CONNECTION_TOKEN;
      // The next publication must come from normal scheduled renewal, with no operator call.
      await once(openShell.updates, sender.name, { signal: AbortSignal.timeout(30_000) });
      assert.equal(sender.credentials.CONNECTION_TOKEN !== recoveredToken, true);
    } finally {
      await worker.stop();
    }
    const scheduledToken = sender.credentials.CONNECTION_TOKEN;
    assert.equal(scheduledToken !== previousToken, true, "the worker delivered a renewed bearer");
    assert.notEqual(sender.resourceVersion, previousVersion);
    assert.ok(Date.parse(sender.credentialExpirationTimes.CONNECTION_TOKEN) > Date.now());
    assert.equal(await subjectFor(scheduledToken), subject);
    const retiredLegacy = await bob.request(
      "DELETE",
      `${namespaceConnections}/${legacy.credentialSourceId}`,
    );
    assert.equal(retiredLegacy.statusCode, 204, retiredLegacy.body);

    // No authorization code, refresh token, or client secret reaches the audit log.
    const audit = await pool.query("SELECT details::text AS details FROM occ.audit_events");
    const recorded = audit.rows.map((row) => row.details ?? "").join("\n");
    for (const value of [
      approved.searchParams.get("code"),
      refreshToken,
      accessToken,
      renewedToken,
      scheduledToken,
      clientSecretA,
      clientSecretB,
    ]) {
      assert.equal(recorded.includes(value), false);
    }
  },
);

test(
  "connection templates keep their OAuth clients after a lost commit acknowledgement",
  requiresPostgres,
  async (t) => {
    for (const method of ["POST", "PATCH"]) {
      await t.test(method, async (t) => {
        const proxy = await commitAckProxy(databaseUrl);
        t.after(() => proxy.close());
        const { controller, inject } = await createPostgresAgentApp(t, {
          label: "template-commit",
          authSecret: "connection-template-commit-test-auth-secret",
          transportDatabaseUrl: proxy.url,
          appOptions: { publicOrigin },
        });
        const { refresh } = selectConnectionDrivers(controller);
        const client = () => ({ clientId: randomUUID(), clientSecret: randomUUID() });
        const input = {
          displayName: `Template ${randomUUID()}`,
          issuer: "https://issuer.example.test",
          authorizationUrl: "https://issuer.example.test/authorize",
          tokenUrl: "https://token.example.test/token",
          scopes: ["openid"],
          endpoint: { host: "api.connections.test", port: 443, path: "/**" },
          envVar: "CONNECTION_TOKEN",
          ...client(),
        };
        let path = "/connection-templates";
        if (method === "PATCH") {
          const initial = await inject("POST", path, input);
          assert.equal(initial.statusCode, 201, initial.body);
          path += `/${initial.json().data.id}`;
        }

        // Stage the new secret through the real Driver, then drop the database's next
        // COMMIT response on the wire. The application cannot know the template version persisted.
        const registerClient = refresh.registerClient.bind(refresh);
        t.mock.method(
          refresh,
          "registerClient",
          async (...args) => {
            await registerClient(...args);
            proxy.arm();
          },
          { times: 1 },
        );
        const registration = client();
        const response = await inject(
          method,
          path,
          method === "POST" ? { ...input, ...registration } : registration,
        );
        assert.equal(response.statusCode, 503, response.body);
        assert.ok(proxy.observedCommit);
        const list = await inject("GET", "/connection-templates");
        assert.equal(list.statusCode, 200, list.body);
        const saved = list
          .json()
          .data.find((template) => template.displayName === input.displayName);
        assert.equal(saved?.current.clientId, registration.clientId);

        // Rotate through the public API. OpenShell requires the originally stored client
        // to exist, so this distinguishes an intact registration from orphaned metadata.
        const rotation = await inject(
          "POST",
          `/connection-templates/${saved.id}/rotate-client-secret`,
          { clientSecret: randomUUID() },
        );
        assert.equal(rotation.statusCode, 200, rotation.body);
        const deleted = await inject("DELETE", `/connection-templates/${saved.id}`);
        assert.equal(deleted.statusCode, 204, deleted.body);
      });
    }
  },
);
