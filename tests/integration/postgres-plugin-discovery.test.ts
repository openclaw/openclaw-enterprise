import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { installationRoles } from "../helpers/postgres-sign-in-installation.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { discoverMcpAuthorization } from "../../apps/controller/src/connections/mcp-discovery.ts";
import {
  credentialSourceDeliveryBinding,
  installationControllerOptions,
} from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import type {
  ConnectionEndpoint,
  ConnectionTemplate,
  DeploymentRequestPolicy,
} from "../../packages/contracts/src/index.ts";
import { OpenClawController, type UpdateAgentInput } from "../../packages/occ/src/index.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  managedCliInstalls,
  managedMcpInstalls,
} from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { deferred } from "../helpers/deferred.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "saved Agent catalog discovery releases the database connection while reading Configuration",
  requiresPostgres,
  async (t) => {
    const { controller, inject, pool, principal } = await createPostgresAgentApp(t, {
      label: "plugin-discovery",
      authSecret: "plugin-discovery-postgres-auth-secret-minimum-32",
      poolOptions: { max: 1 },
    });
    controller.installPluginDrivers([new OCCPluginDriver()]);
    const namespace = await inject("POST", "/namespaces", { name: `Plugins ${randomUUID()}` });
    assert.equal(namespace.statusCode, 201, namespace.body);
    const namespaceId = namespace.json().data.id;
    const path = `/namespaces/${namespaceId}`;
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const config = await inject("POST", `${path}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(config.statusCode, 201, config.body);
    const agent = await inject("POST", `${path}/agents`, {
      name: "Dedicated OpenClaw",
      executionMode: "dedicated",
      configurationId: config.json().data.id,
    });
    assert.equal(agent.statusCode, 201, agent.body);

    // A slow Configuration Driver must leave the only PostgreSQL connection available to other requests.
    const configuration = controller.selectedDriver("configuration");
    const read = configuration.read.bind(configuration);
    const entered = deferred();
    const resume = deferred();
    t.mock.method(configuration, "read", async (...args: Parameters<typeof read>) => {
      entered.resolve();
      await resume.promise;
      return read(...args);
    });
    const catalog = inject("POST", `${path}/agents/${agent.json().data.id}/plugins`, {});
    let result;
    try {
      await Promise.race([
        entered.promise,
        catalog.then((reply) =>
          assert.fail(`Discovery returned before reading Configuration: ${reply.body}`),
        ),
      ]);
      assert.equal(pool.idleCount, 1, "discovery held the sole database connection");
      const otherRequest = await inject("GET", path);
      assert.equal(otherRequest.statusCode, 200, otherRequest.body);
    } finally {
      resume.resolve();
      result = await catalog;
    }
    assert.equal(result.statusCode, 200, result.body);
  },
);

test(
  "a dedicated Agent saves Google and Slack OAuth selections and admits them with its required model",
  requiresPostgres,
  async (t) => {
    const cleanup: { restoreStarter?: () => Promise<void> } = {};
    // Test cleanup runs in registration order. Restore the shared starter before closing Fastify.
    t.after(async () => {
      await cleanup.restoreStarter?.();
    });
    const google = managedCliInstalls.find(({ id }) => id === "occ-plugin:google@1.0.0");
    assert.ok(google);
    const slack = managedMcpInstalls.find(({ id }) => id === "occ-plugin:slack@1.0.0");
    assert.ok(slack);
    const slot = slack.credentials[slack.slotId]!;
    const scope = "channels:read";
    const metadataUrl = slot.mcp.resource + "/.well-known/oauth-protected-resource";
    // Only the external discovery transport is controlled. The catalog supplies Slack's
    // reviewed server, protected resource and issuer; the API discovers and persists them.
    const transport = {
      resolveHost: async () => [{ address: "1.1.1.1", family: 4 }],
      async fetchMetadata(value: string | URL) {
        const url = String(value);
        if (url === slack!.url) {
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}", scope="${scope}"`,
            },
          });
        }
        if (url === metadataUrl) {
          return Response.json({
            resource: slot.mcp.resource,
            authorization_servers: [slot.issuer],
            scopes_supported: [scope],
          });
        }
        assert.equal(url, slot.issuer + "/.well-known/oauth-authorization-server");
        return Response.json({
          issuer: slot.issuer,
          authorization_endpoint: slot.issuer + "/authorize",
          token_endpoint: slot.issuer + "/token",
          response_types_supported: ["code"],
          scopes_supported: [scope],
          token_endpoint_auth_methods_supported: ["none"],
        });
      },
    };
    const { controller, createApp, inject, state, principal, pool } = await createPostgresAgentApp(
      t,
      {
        label: "plugin-slack-oauth",
        authSecret: "plugin-slack-oauth-postgres-auth-secret",
        appOptions: {
          provisionAuthAccount: (
            ...args: Parameters<ReturnType<typeof createPostgresAuthAccountProvisioner>>
          ) => provision(...args),
          discoverMcpAuthorization: (url: string, choice?: string) =>
            discoverMcpAuthorization(url, choice, undefined, transport),
        },
      },
    );
    const provision = createPostgresAuthAccountProvisioner({
      state,
      installationId: controller.installation.id,
    });
    const { core, driver } = useInstallationSecretDriver(controller);
    assert.ok(driver.installationSecrets);
    const ownerId = "occ";
    const storeIdentity = randomUUID();
    const instanceId = await controller.activateTokenServiceInstance(ownerId, storeIdentity);
    const owner = new OCCTokenServiceDriver(
      ownerId,
      controller.installation.id,
      driver.installationSecrets,
      instanceId,
      state,
      undefined,
      new OAuthAccountTokens(state, driver, controller.resolveConnectionClient.bind(controller)),
    );
    controller.registerDriver(owner);
    controller.selectDriver("token_service", ownerId);

    const namespace = await inject("POST", "/namespaces", { name: `Slack ${randomUUID()}` });
    assert.equal(namespace.statusCode, 201, namespace.body);
    const namespaceId = namespace.json().data.id;
    const namespaceName = core.addNamespace(namespaceId);
    const namespaceObject = core.namespaces.get(namespaceName);
    assert.ok(namespaceObject);
    Object.assign(namespaceObject, { apiVersion: "v1", kind: "Namespace" });
    await controller.handleNamespaceLifecycle(principal.id, namespaceId, "ready");
    const path = `/namespaces/${namespaceId}`;
    const template = await inject("POST", "/connection-templates", {
      namespaceId,
      displayName: "Slack for this Namespace",
      mode: "mcp_discovery",
      serverUrl: slack.url,
      issuer: slot.issuer,
      scopes: [scope],
    });
    assert.equal(template.statusCode, 201, template.body);
    const connectionTemplateId = template.json().data.id;
    const client = await inject("POST", "/oauth-clients", {
      connectionTemplateId,
      connectionTemplateVersion: template.json().data.current.version,
      displayName: "Slack public client",
      clientId: `slack-probe-${randomUUID()}`,
      tokenEndpointAuthMethod: "none",
    });
    assert.equal(client.statusCode, 201, client.body);
    const selected = await inject("GET", `/connection-templates/${connectionTemplateId}`);
    assert.equal(selected.statusCode, 200, selected.body);
    const pinned = selected.json().data.current;
    assert.equal(pinned.version, template.json().data.current.version + 1);
    assert.equal(pinned.oauthClientId, client.json().data.id);
    assert.equal(pinned.mode, "mcp_discovery");
    assert.deepEqual(pinned.mcp, { serverUrl: slack.url, resource: slot.mcp.resource });
    assert.deepEqual(pinned.destinations, [slack.endpoint]);

    // Enter at the TokenService's post-exchange boundary with controlled token material.
    // The real owner resolves the original registration, records custody and creates the Source.
    const { id: sourceId } = await owner.createSource(
      {
        kind: "oauth_refresh_token",
        namespaceId,
        name: "Slack account",
        connectionTemplateId,
        consent: {
          kind: "connection_template",
          ownerPrincipalId: principal.id,
          version: pinned.version,
          oauthClientId: pinned.oauthClientId,
        },
        grant: {
          accessToken: randomUUID(),
          refreshToken: randomUUID(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          requestedScopes: [scope],
          grantedScopes: [scope],
        },
      },
      t.signal,
    );
    const source = await inject("GET", `${path}/credential-sources/${sourceId}`);
    assert.equal(source.statusCode, 200, source.body);
    const metadata = source.json().data;
    assert.equal(metadata.state, "ready");
    assert.equal(metadata.type, "oauth2-refresh-token");
    assert.equal(metadata.connectionTemplateId, connectionTemplateId);
    assert.equal(metadata.consent.kind, "connection_template");
    assert.equal(metadata.consent.version, pinned.version);
    assert.equal(metadata.consent.oauthClientId, pinned.oauthClientId);
    assert.equal(metadata.consent.issuer, slot.issuer);
    assert.equal(metadata.consent.resource, slot.mcp.resource);
    assert.equal(metadata.consent.mcpServerUrl, slack.url);
    const googleTemplates = await inject("GET", "/connection-templates");
    assert.equal(googleTemplates.statusCode, 200, googleTemplates.body);
    const starter = (googleTemplates.json().data as ConnectionTemplate[]).find(
      ({ namespaceId, displayName }) => namespaceId === undefined && displayName === "Google OAuth",
    );
    assert.ok(starter && starter.current.mode === "manual");
    const {
      issuer,
      authorizationUrl,
      tokenUrl,
      revocationUrl,
      authorizationParameters,
      scopes,
      oauthClientId,
      destinations,
    } = starter.current;
    const original = {
      mode: "manual",
      issuer,
      authorizationUrl,
      tokenUrl,
      revocationUrl,
      authorizationParameters,
      scopes,
      oauthClientId,
      destinations,
    };
    const starterPath = `/connection-templates/${starter.id}`;
    cleanup.restoreStarter = async () => {
      const restored = await inject("PATCH", starterPath, original);
      assert.equal(restored.statusCode, 200, restored.body);
    };
    const googleClient = await inject("POST", "/oauth-clients", {
      connectionTemplateId: starter.id,
      connectionTemplateVersion: starter.current.version,
      displayName: "Google public client",
      clientId: `google-admission-${randomUUID()}`,
      tokenEndpointAuthMethod: "none",
    });
    assert.equal(googleClient.statusCode, 201, googleClient.body);
    const gmailScopes = ["https://www.googleapis.com/auth/gmail.modify"];
    const gmail = { host: "gmail.googleapis.com", port: 443, path: "/gmail/v1/users/me/messages" };
    const googleSettings = {
      ...original,
      oauthClientId: googleClient.json().data.id,
      scopes: gmailScopes,
    };
    const approved = await inject("PATCH", starterPath, {
      ...googleSettings,
      destinations: [gmail],
    });
    assert.equal(approved.statusCode, 200, approved.body);
    const gmailConsent = approved.json().data.current;
    const googleSource = await owner.createSource(
      {
        kind: "oauth_refresh_token",
        namespaceId,
        name: "Google Workspace account",
        connectionTemplateId: starter.id,
        consent: {
          kind: "connection_template",
          ownerPrincipalId: principal.id,
          version: gmailConsent.version,
          oauthClientId: gmailConsent.oauthClientId,
        },
        grant: {
          accessToken: randomUUID(),
          refreshToken: randomUUID(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          requestedScopes: gmailScopes,
          grantedScopes: gmailScopes,
        },
      },
      t.signal,
    );

    // Use the selected production Compute, Sandbox, Credential Proxy and policy qualifier.
    // Only the Kubernetes SDK transport for Namespace and deployment lookup is controlled.
    const modelGrant = {
      id: "model-egress",
      binary: "/app/bin/model-client",
      host: "api.openai.com",
      ports: [{ from: 443, to: 443 }],
    };
    const publicStorage = {
      id: "public-storage",
      binary: google.binaryPath,
      host: "storage.googleapis.com",
      ports: modelGrant.ports,
    };
    const installation = {
      ...buildSandboxInstallation(),
      sandboxNetworkPolicyCeiling: [
        modelGrant,
        {
          id: "google-apis",
          binary: google.binaryPath,
          host: "*.googleapis.com",
          ports: modelGrant.ports,
        },
        {
          id: "slack-mcp",
          binary: slack.binaryPath,
          host: slack.endpoint.host,
          ports: modelGrant.ports,
        },
      ],
      runtime: { nativeWorkerSupport: "custom-image" },
    };
    Reflect.deleteProperty(installation.drivers, "credential_gateway");
    Reflect.deleteProperty(installation.backend[0]!.drivers, "credential_gateway");
    Object.assign(installation.drivers, { token_service: { id: owner.id, configuration: {} } });
    installation.drivers.compute.id = controller.selectedDriver("compute").id;
    Reflect.deleteProperty(installation.drivers.compute.configuration.network, "gatewayClients");
    Object.assign(installation.drivers.compute.configuration, {
      gatewayRouting: {
        hostname: "agents.example.test",
        gatewayName: "gateways",
        gatewayNamespace: "occ-system",
        envoyNamespace: "envoy",
      },
    });
    const baseline = installation.drivers.sandbox.configuration.policy.networkPolicies[0]!;
    baseline.name = "baseline";
    baseline.endpoints[0]!.host = "baseline.example.test";
    const runtime = await loadInstallationFile(t, installation);
    assert.ok(runtime);
    assert.ok(
      Reflect.set(
        runtime.computeDriver,
        "apiClients",
        Promise.resolve({
          core,
          apps: {
            async listNamespacedDeployment() {
              return { items: [] };
            },
          },
        }),
      ),
    );
    const delivery = credentialSourceDeliveryBinding(runtime);
    assert.ok(delivery);
    const native = new OpenClawController(controller.installation, {
      state,
      ...installationControllerOptions(runtime.installation),
      credentialSourceDelivery: delivery,
      namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
      backends: runtime.installation.backend,
      recordOperations: true,
    });
    for (const capability of ["iam", "configuration", "secret", "token_service"] as const) {
      const selected = controller.selectedDriver(capability);
      native.registerDriver(selected);
      native.selectDriver(capability, selected.id);
    }
    native.registerDriver(runtime.computeDriver);
    native.selectDriver("compute", runtime.computeDriver.id);
    assert.equal(await native.activateTokenServiceInstance(owner.id, storeIdentity), instanceId);
    installSelectedSandboxDrivers(native, runtime);
    native.installPluginDrivers([new OCCPluginDriver()]);
    const app = createApp(native);
    const model = await inject(
      "POST",
      `${path}/credential-sources`,
      {
        name: "Staged model credential",
        type: "static",
        config: { provider_preset: "openai" },
        secret: { opaque: randomUUID() },
      },
      app,
    );
    assert.equal(model.statusCode, 201, model.body);
    const modelId = model.json().data.id;
    const config = await inject("POST", `${path}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(config.statusCode, 201, config.body);
    const configurationId = config.json().data.id;
    const explicit = [{ sourceId: modelId }];
    const agent = await inject(
      "POST",
      `${path}/agents`,
      {
        name: "Google and Slack Agent",
        executionMode: "dedicated",
        configurationId,
        harnessAuth: { method: "credential_source", sourceId: modelId },
        credentialSources: explicit,
      },
      app,
    );
    assert.equal(agent.statusCode, 201, agent.body);
    const agentId = agent.json().data.id;
    assert.deepEqual(agent.json().data.credentialSources, explicit);
    // The editing member starts with exact Agent and model grants, before either Plugin is delegated.
    const reader = (await installationRoles(state, pool)).reader;
    const credentials = {
      email: `plugin-author-${randomUUID()}@example.test`,
      password: randomUUID(),
    };
    const account = await inject(
      "POST",
      "/api/auth/accounts",
      { ...credentials, name: "Plugin editor", roleId: reader.id },
      app,
    );
    assert.equal(account.statusCode, 201, account.body);
    const subjectId = account.json().data.principalId;
    const editor = await native.createIAMRole(principal.id, {
      namespaceId,
      permissions: [
        { action: "update", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "operate", resourceKind: "credential_source" },
      ],
    });
    const namespaceReader = await native.createIAMRole(principal.id, {
      namespaceId,
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    const grant = (
      resourceKind: "namespace" | "agent" | "configuration" | "credential_source",
      resourceId: string,
      roleId = editor.id,
    ) =>
      native.createIAMAccessBinding(principal.id, {
        namespaceId,
        subjectKind: "identity",
        subjectId,
        roleId,
        resourceKind,
        resourceId,
      });
    await grant("namespace", namespaceId, namespaceReader.id);
    await grant("agent", agentId);
    await grant("configuration", configurationId);
    await grant("credential_source", modelId);
    const session = await signInToControllerApp(app, credentials);
    const url = `${path}/agents/${agentId}`;
    const selectSlack = (account: string) => ({
      configurationId,
      plugins: {
        [slack.id]: {
          enabled: true,
          driverPolicy: {
            releaseSha256: slack.releaseSha256,
            credentials: { [slack.slotId]: account },
            toolNames: ["slack_search_public"],
          },
        },
      },
    });
    const body = selectSlack(sourceId);
    const memberPatch = (payload: Omit<UpdateAgentInput, "namespaceId" | "agentId">) =>
      app.inject({
        method: "PATCH",
        url,
        headers: { host: new URL(session.origin).host, ...authenticatedHeaders(session) },
        payload,
      });
    const denied = await memberPatch(body);
    assert.equal(denied.statusCode, 403, denied.body);
    const deniedAudit = await pool.query(
      `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
       FROM occ.audit_events WHERE namespace_id=$1 AND resource_id=$2 AND actor_id=$3
       AND action='openclaw.agents.update' AND kind='authorization_denial'
       AND details->'__occAuditMetadata'->>'requestId'=$4`,
      [namespaceId, agentId, subjectId, denied.json().meta.requestId],
    );
    assert.deepEqual(deniedAudit.rows, [
      {
        authorization: {
          principalId: subjectId,
          action: "operate",
          resource: { kind: "credential_source", namespaceId, id: sourceId },
        },
      },
    ]);
    // With no revision and only the model attached, the saved Slack slot alone protects its bearer.
    const slackBearerTemplate = await inject("POST", "/connection-templates", {
      namespaceId,
      displayName: "Slack static bearer",
      mode: "static_bearer",
      destinations: [{ ...slack.endpoint, method: "POST" }],
    });
    assert.equal(slackBearerTemplate.statusCode, 201, slackBearerTemplate.body);
    const slackBearer = await inject(
      "POST",
      `${path}/credential-sources`,
      {
        name: "Slack static bearer",
        type: "static",
        connectionTemplateId: slackBearerTemplate.json().data.id,
        secret: { opaque: randomUUID() },
      },
      app,
    );
    assert.equal(slackBearer.statusCode, 201, slackBearer.body);
    const staticId = slackBearer.json().data.id;
    const staticPath = `${path}/credential-sources/${staticId}`;
    await grant("credential_source", staticId);
    const selectedStatic = await memberPatch(selectSlack(staticId));
    assert.equal(selectedStatic.statusCode, 200, selectedStatic.body);
    assert.deepEqual(selectedStatic.json().data.credentialSources, explicit);
    const deleteStatic = await inject("DELETE", staticPath, undefined, app);
    assert.equal(deleteStatic.statusCode, 409, deleteStatic.body);
    assert.match(deleteStatic.json().error.message, /still references the credential source/i);
    const retained = await inject("GET", staticPath, undefined, app);
    assert.equal(retained.statusCode, 200, retained.body);
    assert.equal(retained.json().data.state, "ready");

    const slackGrant = await grant("credential_source", sourceId);
    const patched = await memberPatch(body);
    assert.equal(patched.statusCode, 200, patched.body);
    const saved = await inject("GET", url, undefined, app);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().data.plugins, body.plugins);
    assert.deepEqual(saved.json().data.credentialSources, explicit);
    // Removing the selection permits retirement to begin. This admission fixture has no
    // native Proxy service, so retirement must retain custody instead of claiming deletion.
    const retired = await inject("DELETE", staticPath, undefined, app);
    assert.equal(retired.statusCode, 503, retired.body);
    assert.equal(retired.json().error.code, "DEPENDENCY_UNAVAILABLE");
    const retiring = await inject("GET", staticPath, undefined, app);
    assert.equal(retiring.statusCode, 200, retiring.body);
    assert.equal(retiring.json().data.state, "deleting");

    const plugins = {
      ...body.plugins,
      [google.id]: {
        enabled: true,
        driverPolicy: {
          releaseSha256: google.releaseSha256,
          credentials: { account: googleSource.id },
        },
      },
    };
    await grant("credential_source", googleSource.id);
    const combined = await memberPatch({ configurationId, plugins });
    assert.equal(combined.statusCode, 200, combined.body);
    // An editor who loses Slack Source access can still change approvers on the saved Agent.
    const revoked = await inject(
      "DELETE",
      `${path}/iam/access-bindings/${slackGrant.id}`,
      undefined,
      app,
    );
    assert.equal(revoked.statusCode, 204, revoked.body);
    const updated = await memberPatch({ configurationId, pluginApprovers: [] });
    assert.equal(updated.statusCode, 200, updated.body);
    const savedBoth = await inject("GET", url, undefined, app);
    assert.equal(savedBoth.statusCode, 200, savedBoth.body);
    assert.deepEqual(savedBoth.json().data.pluginApprovers, []);
    assert.deepEqual(savedBoth.json().data.plugins, plugins);
    assert.deepEqual(savedBoth.json().data.credentialSources, explicit);
    for (const selectedId of [googleSource.id, sourceId]) {
      const grants = await pool.query(
        `SELECT r.permissions FROM occ.iam_access_bindings b JOIN occ.iam_roles r ON b.role_id=r.id
         WHERE b.namespace_id=$1 AND b.identity_subject_id=$2 AND b.resource_kind='credential_source' AND b.resource_id=$3`,
        [namespaceId, agent.json().data.servicePrincipalId, selectedId],
      );
      assert.deepEqual(grants.rows, [
        { permissions: [{ action: "operate", resourceKind: "credential_source" }] },
      ]);
    }
    const networking = `${url}/sandbox-policy/networking`;
    const editing = await inject("PATCH", `${networking}/editing`, { enabled: true }, app);
    assert.equal(editing.statusCode, 200, editing.body);
    const network = await inject(
      "PUT",
      networking,
      { expectedVersion: 1, additions: [modelGrant, publicStorage] },
      app,
    );
    assert.equal(network.statusCode, 200, network.body);
    const deployed = await inject("POST", `${url}/deploy`, {}, app);
    assert.equal(deployed.statusCode, 202, deployed.body);
    const revisionId = deployed.json().data.id;
    const readRevision = (id: string) =>
      state.read((view) => view.revisions.findRevision(namespaceId, agentId, id));
    const revision = await readRevision(revisionId);
    assert.ok(revision?.credentialDeployment);
    const deployment = revision.credentialDeployment;
    assert.deepEqual(
      new Set(revision.credentialSources),
      new Set([
        { sourceId: modelId, sourceType: "static", tokenServiceInstanceId: instanceId },
        {
          sourceId: googleSource.id,
          sourceType: "oauth2-refresh-token",
          tokenServiceInstanceId: instanceId,
          connectionTemplate: { id: starter.id, version: gmailConsent.version },
        },
        {
          sourceId,
          sourceType: "oauth2-refresh-token",
          tokenServiceInstanceId: instanceId,
          connectionTemplate: { id: connectionTemplateId, version: pinned.version },
        },
      ]),
    );
    assert.deepEqual(revision.plugins?.plugins, plugins);
    assert.equal(deployment.bindings.length, 3);
    for (const [selectedId, plugin, environment] of [
      [sourceId, slack, "SLACK_MCP_TOKEN"],
      [googleSource.id, google, "GOG_ACCESS_TOKEN"],
    ] as const) {
      const binding = deployment.bindings.find(({ sourceRef }) => sourceRef.id === selectedId);
      assert.ok(binding);
      assert.deepEqual(binding.consumer, {
        kind: "plugin",
        pluginId: plugin.id,
        requirement: "account",
        connection: "default",
      });
      assert.deepEqual(binding.projection, { environment, presentation: "bearer" });
      const injection = deployment.injectionPolicies.find(
        ({ bindingRef }) => bindingRef === binding.bindingRef,
      );
      assert.ok(injection);
      const endpoint: ConnectionEndpoint = selectedId === sourceId ? slack.endpoint : gmail;
      const policies: DeploymentRequestPolicy[] =
        selectedId === sourceId
          ? [
              ...["ping", "initialize", "notifications/initialized", "tools/list"].map(
                (method): DeploymentRequestPolicy => ({ type: "mcp", method, path: endpoint.path }),
              ),
              {
                type: "mcp",
                method: "tools/call",
                toolName: "slack_search_public",
                path: endpoint.path,
              },
            ]
          : [{ type: "http", method: "GET", path: endpoint.path }];
      assert.deepEqual(
        new Set(injection.allowedRequests),
        new Set(
          policies.map((requestPolicy) => ({
            binary: plugin.binaryPath,
            host: endpoint.host,
            ports: modelGrant.ports,
            requestPolicy,
          })),
        ),
      );
    }
    const modelBinding = deployment.bindings.find(({ sourceRef }) => sourceRef.id === modelId);
    assert.deepEqual(modelBinding?.consumer, { kind: "model", providerId: "openai" });
    assert.ok(
      deployment.networkAccessPolicy.allowed.some(
        ({ host, requestPolicy }) => host === publicStorage.host && requestPolicy === undefined,
      ),
    );
    assert.ok(
      deployment.injectionPolicies.every(({ allowedRequests }) =>
        allowedRequests.every(({ host }) => host !== publicStorage.host),
      ),
    );

    // Restore the starter destinations and also approve Google's public discovery endpoint.
    // The admin changes only destinations. The existing account keeps its original grant.
    const discovery = { host: "www.googleapis.com", port: 443, path: "/discovery/v1/apis" };
    const broadened = await inject("PATCH", starterPath, {
      ...googleSettings,
      destinations: [...destinations, discovery],
    });
    assert.equal(broadened.statusCode, 200, broadened.body);
    const nextVersion = broadened.json().data.current.version;
    assert.equal(nextVersion, gmailConsent.version + 1);
    const redeployed = await inject("POST", `${url}/deploy`, {}, app);
    assert.equal(redeployed.statusCode, 202, redeployed.body);
    const next = await readRevision(redeployed.json().data.id);
    assert.ok(next?.credentialDeployment);
    assert.notEqual(next.id, revisionId);
    assert.deepEqual(
      next.credentialSources?.find(({ sourceId }) => sourceId === googleSource.id)
        ?.connectionTemplate,
      { id: starter.id, version: nextVersion },
    );
    const googleBinding = next.credentialDeployment.bindings.find(
      ({ sourceRef }) => sourceRef.id === googleSource.id,
    );
    assert.ok(googleBinding);
    const googleInjection = next.credentialDeployment.injectionPolicies.find(
      ({ bindingRef }) => bindingRef === googleBinding.bindingRef,
    );
    assert.ok(googleInjection);
    assert.deepEqual(
      googleInjection.allowedRequests.filter(
        ({ host, requestPolicy }) =>
          host === gmail.host && requestPolicy?.path === gmail.path + "/send",
      ),
      [
        {
          binary: google.binaryPath,
          host: gmail.host,
          ports: modelGrant.ports,
          requestPolicy: { type: "http", method: "POST", path: gmail.path + "/send" },
        },
      ],
    );
    assert.ok(
      next.credentialDeployment.networkAccessPolicy.allowed.some(
        ({ binary, host, requestPolicy }) =>
          binary === google.binaryPath &&
          host === discovery.host &&
          requestPolicy?.type === "http" &&
          requestPolicy.method === "GET" &&
          requestPolicy.path === discovery.path,
      ),
    );
    assert.ok(
      googleInjection.allowedRequests.every(
        ({ host, requestPolicy }) =>
          requestPolicy?.type === "http" &&
          !requestPolicy.path.includes("*") &&
          !(host === discovery.host && requestPolicy.path === discovery.path),
      ),
    );
    const readGoogle = await inject("GET", `${path}/credential-sources/${googleSource.id}`);
    assert.equal(readGoogle.statusCode, 200, readGoogle.body);
    const consent = readGoogle.json().data.consent;
    assert.equal(consent.version, gmailConsent.version);
    assert.equal(consent.issuer, issuer);
    assert.equal(consent.oauthClientId, googleSettings.oauthClientId);
    assert.deepEqual(consent.grantedScopes, gmailScopes);
    const frozen = await readRevision(revisionId);
    assert.deepEqual(frozen?.credentialSources, revision.credentialSources);
    assert.deepEqual(frozen?.credentialDeployment, deployment);
  },
);
