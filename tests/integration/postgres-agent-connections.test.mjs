import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { OpenShellProviderAlreadyExistsError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import { PostgresHumanAuthentication } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

// RFC-0023 connections through the production Fastify app, PostgreSQL State, Native IAM, and
// the real OpenShell Credential Gateway and Refresh Drivers, against a real Keycloak issuer.
// The test completes Keycloak's real login form and the Refresh Driver performs a real
// authorization-code + PKCE exchange. Only the OpenShell gRPC transport is a recording
// double: it stores providers and refresh material but does not mint tokens, so this test
// does not prove OpenShell refresh or substitution (the k3d OpenShell suite does).

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
    directAccessGrantsEnabled: false,
    redirectUris: [redirectUri],
    attributes: { "pkce.code.challenge.method": "S256" },
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
  const profiles = new Map();
  const refresh = new Map();
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
      providers.set(id, { ...structuredClone(input), config: input.config ?? {} });
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
    async configureProviderRefresh(request) {
      refresh.set(key(request.workspace, request.provider), structuredClone(request));
      return { status: "configured" };
    },
    // The double reports a mint; real minting is out of scope here (see the file header).
    async rotateProviderCredential() {
      return { status: "refreshed" };
    },
    async getProviderRefreshStatus(workspace, name) {
      return refresh.has(key(workspace, name)) ? { status: "refreshed" } : undefined;
    },
    async deleteProviderRefresh(workspace, name) {
      refresh.delete(key(workspace, name));
    },
    close() {},
  };
  return { client, providers, refresh };
}

test(
  "a person connects their Keycloak account to their personal Agent and nobody else can use it",
  requiresKeycloak,
  async (t) => {
    const secrets = JSON.parse(await readFile(secretsFile, "utf8"));
    let provision;
    // Source deletion waits out the Credential Gateway's registration fence (70 seconds), so
    // the test moves OCC's clock forward instead of sleeping.
    let skewMs = 0;
    const fixture = await createPostgresAgentApp(t, {
      controllerOptions: { now: () => new Date(Date.now() + skewMs) },
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

    // Only the Kubernetes Compute Driver places Credential Gateway sources; like it, this
    // placement names the Namespace's Sandbox view with a short Kubernetes namespace label,
    // which OpenShell operator mode uses as the Workspace name.
    fixture.computeDriver.resolveSandboxNamespace = async (namespace) => ({
      ...namespace,
      name: `oce-${namespace.id.slice(3, 11)}`,
    });
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

    // Bob and Carol are ordinary people with no Installation grant.
    const people = {};
    for (const name of ["bob", "carol"]) {
      const email = `connections-${name}-${randomUUID()}@example.com`;
      const password = `generated-password-${randomUUID()}`;
      const created = await inject("POST", "/api/auth/accounts", { email, password, name });
      assert.equal(created.statusCode, 201, created.body);
      const session = await signInWithEmailPassword({
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
      people[name] = {
        principalId: created.json().data.principalId,
        request: (method, url, body) =>
          app.inject({
            method,
            url,
            headers: {
              host: "127.0.0.1",
              ...authenticatedHeaders(session),
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
          }),
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
    // The OpenShell gateway, not OCC, refreshes at the token URL, and a `localhost` name would
    // reach the gateway itself. The administrator sees that refusal before anyone connects.
    const unreachable = await inject("POST", "/connection-templates", {
      ...templateBody("oce", clientSecretA),
      tokenUrl: `${new URL(issuer).origin}/realms/oce/protocol/openid-connect/token`,
    });
    assert.equal(unreachable.statusCode, 400, unreachable.body);
    assert.match(unreachable.json().error.message, /token_url host/);
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

    // Bob gets the Namespace and exact-Agent grants a personal Agent's owner needs.
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
    // Bob can edit this Agent and use its existing configuration and model Secret. These exact
    // grants do not give him general access to credential sources.
    const agentRole = await inject("POST", `/namespaces/${namespace.id}/iam/roles`, {
      name: "Agent owner",
      permissions: [
        ...["read", "update", "deploy", "operate", "administer"].map((action) => ({
          action,
          resourceKind: "agent",
        })),
        { action: "read", resourceKind: "configuration" },
        { action: "operate", resourceKind: "secret" },
      ],
    });
    assert.equal(agentRole.statusCode, 201, agentRole.body);
    for (const [resourceKind, resourceId] of [
      ["agent", agent.id],
      ["configuration", agent.configurationId],
      ["secret", agent.harnessAuth.source.id],
    ]) {
      const grant = await inject("POST", `/namespaces/${namespace.id}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId: bob.principalId,
        roleId: agentRole.json().data.id,
        resourceKind,
        resourceId,
      });
      assert.equal(grant.statusCode, 201, grant.body);
    }
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

    // Bob starts the connection and approves on Keycloak's real consent page.
    const started = await bob.request(
      "POST",
      `/namespaces/${namespace.id}/agents/${agent.id}/connections`,
      { connectionTemplateId: templateA.id },
    );
    assert.equal(started.statusCode, 201, started.body);
    const { authorizationUrl, credentialSourceId } = started.json().data;
    // Diffs is the bundled OpenClaw catalog entry. This checks binding admission and persistence;
    // it does not claim Diffs consumes the credential or that an Agent is running.
    const pluginDriver = new OCCPluginDriver();
    controller.registerDriver(pluginDriver);
    controller.selectDriver("plugin", pluginDriver.id);
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const pluginId = "occ-plugin:diffs";
    const plugins = { [pluginId]: { enabled: true, credentialSourceId } };
    const selectPlugin = () =>
      bob.request("PATCH", agentPath, { configurationId: agent.configurationId, plugins });
    const beforeConsent = await selectPlugin();
    assert.equal(beforeConsent.statusCode, 404, beforeConsent.body);
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

    const completed = await bob.request("GET", callbackPath);
    assert.equal(completed.statusCode, 303, completed.body);
    assert.equal(completed.headers["referrer-policy"], "no-referrer");
    assert.match(completed.headers.location, /connection=connected$/);
    assert.equal(completed.headers.location.includes("code="), false);

    const selectedPlugin = await selectPlugin();
    assert.equal(selectedPlugin.statusCode, 200, selectedPlugin.body);
    const savedAgent = await bob.request("GET", agentPath);
    assert.equal(savedAgent.statusCode, 200, savedAgent.body);
    assert.deepEqual(savedAgent.json().data.plugins, plugins);

    // Turning off a plugin must not lock the connection owner out of ordinary Agent edits.
    const disabledPlugin = await bob.request("PATCH", agentPath, {
      configurationId: agent.configurationId,
      plugins: { [pluginId]: { enabled: false, credentialSourceId } },
    });
    assert.equal(disabledPlugin.statusCode, 200, disabledPlugin.body);
    const editedAgent = await bob.request("PATCH", agentPath, {
      configurationId: agent.configurationId,
    });
    assert.equal(editedAgent.statusCode, 200, editedAgent.body);
    assert.equal(editedAgent.json().data.plugins[pluginId].enabled, false);
    assert.deepEqual(editedAgent.json().data.credentialSources, [{ sourceId: credentialSourceId }]);
    // Retaining the connected source does not grant permission to remove it outside disconnect.
    const removedSource = await bob.request("PATCH", agentPath, {
      configurationId: agent.configurationId,
      credentialSources: [],
      plugins: {},
    });
    assert.equal(removedSource.statusCode, 403, removedSource.body);

    // A replayed callback never exchanges the code twice.
    const replayed = await bob.request("GET", callbackPath);
    assert.match(replayed.headers.location, /reason=session_used_or_expired/);

    // OCC handed OpenShell a real Keycloak grant: redeeming the recorded material works.
    const configured = [...openShell.refresh.values()].find((entry) =>
      entry.provider.startsWith("oce-cs-"),
    );
    assert.ok(configured, "the Refresh Driver configured OpenShell refresh custody");
    // OpenShell mints into this key and substitutes it for the template's variable; the
    // recording double accepts any key, so the test checks it.
    assert.equal(configured.credentialKey, "CONNECTION_TOKEN");
    const redeemed = await fetch(templateBody("oce").tokenUrl, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: configured.material.refresh_token,
        client_id: configured.material.client_id,
        client_secret: configured.material.client_secret,
      }),
    });
    assert.equal(redeemed.status, 200, "the handed-over refresh token is a usable grant");

    const connections = await bob.request(
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/connections`,
    );
    assert.deepEqual(
      connections
        .json()
        .data.map(({ credentialSourceId: id, ownerPrincipalId, connectionTemplateVersion }) => ({
          id,
          ownerPrincipalId,
          connectionTemplateVersion,
        })),
      [{ id: credentialSourceId, ownerPrincipalId: bob.principalId, connectionTemplateVersion: 1 }],
    );

    // The Agent is now personal to Bob: no grant to Carol, and the admin cannot deploy it.
    const share = await inject("POST", `/namespaces/${namespace.id}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: carol.principalId,
      roleId: role.json().data.id,
      resourceKind: "agent",
      resourceId: agent.id,
    });
    assert.equal(share.statusCode, 409, share.body);
    const adminDeploy = await inject(
      "POST",
      `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
    );
    assert.equal(adminDeploy.statusCode, 403, adminDeploy.body);

    // Neither an Agent-level source reference nor a plugin selection can transfer the grant.
    for (const selection of [
      { credentialSources: [{ sourceId: credentialSourceId }] },
      { plugins },
    ]) {
      const moved = await inject(
        "PATCH",
        `/namespaces/${other.namespace.id}/agents/${other.agent.id}`,
        { configurationId: other.agent.configurationId, ...selection },
      );
      assert.equal(moved.statusCode, 404, moved.body);
    }

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

    // Disconnect removes the source from the Agent and the gateway. A source this new keeps its
    // record (a late gateway create could still appear), so the Agent stays personal.
    const disconnectPath = `/namespaces/${namespace.id}/agents/${agent.id}/connections/${credentialSourceId}`;
    const shareCarol = () =>
      inject("POST", `/namespaces/${namespace.id}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId: carol.principalId,
        roleId: agentRole.json().data.id,
        resourceKind: "agent",
        resourceId: agent.id,
      });
    const early = await bob.request("DELETE", disconnectPath);
    assert.equal(early.statusCode, 200, early.body);
    assert.deepEqual(early.json().data, { withdrawalRequested: false, deleted: false });
    const afterDisconnect = await selectPlugin();
    assert.equal(afterDisconnect.statusCode, 404, afterDisconnect.body);
    assert.equal((await shareCarol()).statusCode, 409, "still personal until the source is gone");

    // Disconnecting again after the fence deletes the source, which lifts the restriction.
    skewMs = 71_000;
    const disconnected = await bob.request("DELETE", disconnectPath);
    assert.equal(disconnected.statusCode, 200, disconnected.body);
    assert.deepEqual(disconnected.json().data, { withdrawalRequested: false, deleted: true });
    const shareAfter = await shareCarol();
    assert.equal(shareAfter.statusCode, 201, shareAfter.body);

    // No authorization code, refresh token, or client secret reaches the audit log.
    const audit = await pool.query("SELECT details::text AS details FROM occ.audit_events");
    const recorded = audit.rows.map((row) => row.details ?? "").join("\n");
    for (const value of [
      approved.searchParams.get("code"),
      configured.material.refresh_token,
      clientSecretA,
      clientSecretB,
    ]) {
      assert.equal(recorded.includes(value), false);
    }
  },
);
