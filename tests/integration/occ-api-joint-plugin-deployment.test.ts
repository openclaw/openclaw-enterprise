import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { listManagedMcpToolNames } from "../../apps/controller/src/connections/mcp-tool-discovery.ts";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import type {
  CredentialGatewayDriver,
  CredentialRefreshDriver,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import {
  createInjectedControllerFixture,
  identifier,
  injectedRequest,
} from "./occ-api-injected-fixture.ts";
import { credentialGatewayOverProviders } from "./sandbox-driver-credential-fixture.ts";

function record(value: unknown) {
  const result = asRecord(value);
  assert(result, "expected an object");
  return result;
}

function string(value: unknown) {
  assert(typeof value === "string", "expected a string");
  return value;
}

test("deploying Google Workspace and Slack together freezes both selections and preserves independent credentials", async (t) => {
  const sourceConfig = {
    protocol: "mcp",
    host: "mcp.slack.com",
    port: "443",
    path: "/mcp",
    env_var: "SLACK_MCP_TOKEN",
  };
  // Exercise Agent admission and immutable revision storage. Provider registration and MCP
  // enforcement are covered at the OpenShell boundary.
  function unexpectedGatewayCall(): never {
    assert.fail("the admission fixture must not access credential material");
  }
  const token = "fixture-slack-discovery-token";
  const upstream: { method: unknown; authenticated: boolean }[] = [];
  let tokenReads = 0;
  let beforeTokenUse = () => {};
  let echoToken = false;
  const peerErrors: unknown[] = [];
  const peer = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const parsed: unknown = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      const body = asRecord(parsed);
      const method = body?.method ?? request.method;
      const authenticated = request.headers.authorization === `Bearer ${token}`;
      upstream.push({ method, authenticated });
      assert.equal(request.url, "/mcp");
      assert.equal(authenticated, true);
      if (method === "GET" || method === "DELETE") {
        response.writeHead(405).end();
        return;
      }
      if (method !== "initialize") {
        assert.equal(request.headers["mcp-session-id"], "fixture-session");
      }
      if (method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      assert.ok(method === "initialize" || method === "tools/list");
      const result =
        method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "Managed MCP HTTP fixture", version: "1" },
            }
          : {
              tools: [
                "slack_search_public",
                "slack_send_message",
                ...(echoToken ? [token] : []),
              ].map((name) => ({ name, inputSchema: { type: "object" } })),
            };
      assert(body);
      response
        .writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "fixture-session",
        })
        .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    } catch (error) {
      peerErrors.push(error);
      response.writeHead(500).end();
    }
  });
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
    assert.deepEqual(peerErrors, []);
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  const peerAddress = peer.address();
  assert(peerAddress && typeof peerAddress === "object");
  const peerUrl = `http://127.0.0.1:${peerAddress.port}/mcp`;
  const secretDriver = createTestSecretDriver({ id: "secret-slack-admission" });
  const readValue = secretDriver.withValue;
  secretDriver.withValue = (secret, use) =>
    readValue(secret, (value) => {
      tokenReads += 1;
      beforeTokenUse();
      return use(value);
    });
  const googleGateway = credentialGatewayOverProviders({
    refresh: true,
    toolBinaries: ["/usr/local/lib/oce/plugins/google/bin/gog"],
  }).driver;
  const gateway: CredentialGatewayDriver & { rotateSource: typeof unexpectedGatewayCall } = {
    id: "credential-gateway-slack-admission",
    capability: "credential_gateway",
    implementation: "openshell",
    validateSourceConfig(input) {
      if (input.type === "oauth2-refresh-token") {
        return googleGateway.validateSourceConfig(input);
      }
    },
    async listSourceTypes(context) {
      const googleType = (await googleGateway.listSourceTypes(context)).find(
        ({ type }) => type === "oauth2-refresh-token",
      );
      assert.ok(googleType);
      return [
        googleType,
        {
          type: "openai",
          config: [],
          secrets: [],
          rotation: "none",
          harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
        },
        {
          type: "bearer-token",
          config: Object.keys(sourceConfig).map((name) => ({ name, required: true })),
          secrets: [{ name: "token", required: true }],
          rotation: "none",
        },
      ];
    },
    async registerSource() {
      return { state: "ready" };
    },
    updateSource: unexpectedGatewayCall,
    rotateSource: unexpectedGatewayCall,
    removeSource: unexpectedGatewayCall,
    attachForRevision: unexpectedGatewayCall,
    attachmentStatus: unexpectedGatewayCall,
    withdraw: unexpectedGatewayCall,
    async sourceStatus() {
      return { state: "ready" };
    },
    withSourceToken: unexpectedGatewayCall,
  };
  // OCC registers the Google source normally. This fixture reports the first refresh as
  // ready so the test can exercise deployment without contacting Google's token endpoint.
  const refresh: CredentialRefreshDriver = {
    id: "credential-refresh-openshell",
    capability: "credential_refresh",
    implementation: "openshell",
    async configureRefresh() {
      return { state: "pending" };
    },
    async rotate() {
      return { state: "ready" };
    },
    refreshStatus: unexpectedGatewayCall,
    removeRefresh: unexpectedGatewayCall,
  };
  const sandbox: SandboxDriver = {
    id: "sandbox-slack-admission",
    capability: "sandbox",
    implementation: "openshell",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async provisionHarness() {
      return assert.fail("the admission fixture must not provision a Sandbox");
    },
    async cleanup() {},
  };
  const compute = createTestKubernetesComputeDriver("compute-slack-admission", {
    gatewayRuntime: true,
    sandboxDriver: sandbox,
    credentialGatewayDriver: gateway,
  });
  compute.resolveSandboxNamespace = async (namespace) => namespace;
  compute.getAgentRuntimeCredentialStatus = async () => ({ transportConfigured: true });
  const fixture = await createInjectedControllerFixture(
    {
      computeDriver: compute,
      secretDriver,
      readManagedMcpToolNames(endpoint, accessToken, signal) {
        return listManagedMcpToolNames(endpoint, accessToken, signal, {
          async resolveHost(host) {
            assert.equal(host, "mcp.slack.com");
            return [{ address: "8.8.8.8", family: 4 }];
          },
          fetch(target, request) {
            assert(target instanceof URL);
            assert.equal(target.href, "https://mcp.slack.com/mcp");
            // The real reader and MCP SDK send HTTP to this counted peer. Only DNS/routing
            // are controlled: this does not qualify public DNS, TLS, or live Slack access.
            const loopbackRequest = { ...request, dispatcher: undefined };
            return fetch(peerUrl, loopbackRequest);
          },
        });
      },
    },
    {
      wrapPlatformState: (state) => state,
      invokeApplication(factory, { backendSummaries, ...options }) {
        return factory(backendSummaries === undefined ? options : { ...options, backendSummaries });
      },
    },
  );
  const request = (
    method: string,
    pathname: string,
    options?: Parameters<typeof injectedRequest>[3],
  ) => injectedRequest(fixture.app, method, pathname, options);
  const installationName = "Enterprise development";
  const bootstrap = await request("POST", "/installation/bootstrap", {
    body: { name: installationName },
  });
  assert.equal(bootstrap.status, 201);
  const installation = record(bootstrap.data);
  assert.equal(installation.name, installationName);
  assert.match(string(installation.id), identifier("ins"));
  assert.equal(Number.isNaN(Date.parse(string(installation.createdAt))), false);

  const { controller, platformState } = fixture;
  assert(controller && platformState);
  const pluginDriver = new OCCPluginDriver();
  for (const driver of [sandbox, gateway, refresh]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  // A saved Agent selects the MCP credential and endpoint from its own Harness catalog.
  controller.installPluginDrivers([new CodexPluginDriver(), pluginDriver]);
  const namespaceName = "slack-mcp-admission";
  const namespaceResponse = await request("POST", "/namespaces", { body: { name: namespaceName } });
  assert.equal(namespaceResponse.status, 201);
  const namespace = record(namespaceResponse.data);
  assert.equal(namespace.name, namespaceName);
  const namespaceId = string(namespace.id);
  assert.match(namespaceId, identifier("ns"));
  assert.equal(namespace.status, "provisioning");
  assert.equal(Object.hasOwn(namespace, "installationId"), false);
  await platformState.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespaceId, "provisioning", "ready"),
  );
  const base = `/namespaces/${namespaceId}`;
  const secret = await request("POST", `${base}/secrets`, {
    body: { name: "Slack access token", value: token },
  });
  assert.equal(secret.status, 201, JSON.stringify(secret.body));
  const source = await request("POST", `${base}/credential-sources`, {
    body: {
      name: "Slack account",
      type: "bearer-token",
      config: sourceConfig,
      secrets: { token: { kind: "secret", id: string(record(secret.data).id), namespaceId } },
    },
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const sourceId = string(record(source.data).id);
  const googleSecret = await request("POST", `${base}/secrets`, {
    body: { name: "Google refresh token", value: "fixture-google-refresh-token" },
  });
  assert.equal(googleSecret.status, 201, JSON.stringify(googleSecret.body));
  const googleSource = await request("POST", `${base}/credential-sources`, {
    body: {
      name: "Google account",
      type: "oauth2-refresh-token",
      config: {
        host: "gmail.googleapis.com",
        path: "/gmail/**",
        env_var: "GOG_ACCESS_TOKEN",
        client_id: "google-admission-fixture",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        token_url: "https://oauth2.googleapis.com/token",
      },
      secrets: {
        refresh_token: { kind: "secret", namespaceId, id: string(record(googleSecret.data).id) },
      },
    },
  });
  assert.equal(googleSource.status, 201, JSON.stringify(googleSource.body));
  const googleSourceId = string(record(googleSource.data).id);
  tokenReads = 0;
  const model = await request("POST", `${base}/credential-sources`, {
    body: { name: "Model account", type: "openai" },
  });
  assert.equal(model.status, 201, JSON.stringify(model.body));
  const modelId = string(record(model.data).id);
  const configurationValues = createHarnessConfiguration("openclaw", "gpt-5.1");
  const configurationResponse = await request("POST", `/namespaces/${namespaceId}/configurations`, {
    body: { kind: "agent", values: configurationValues },
  });
  assert.equal(configurationResponse.status, 201);
  const configuration = record(configurationResponse.data);
  const configurationId = string(configuration.id);
  assert.match(configurationId, identifier("cfg"));
  assert.equal(configuration.namespaceId, namespaceId);
  assert.deepEqual(configuration.values, configurationValues);
  const credentialSources = [{ sourceId: modelId }, { sourceId: googleSourceId }, { sourceId }];
  const created = await request("POST", `${base}/agents`, {
    body: {
      name: "Slack Agent",
      executionMode: "dedicated",
      configurationId,
      harnessAuth: { method: "credential_source", sourceId: modelId },
      credentialSources,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const agent = record(created.data);
  const agentId = string(agent.id);
  const servicePrincipalId = string(agent.servicePrincipalId);
  const { state } = fixture;
  const roleId = `slack-mcp-source-${agentId}`;
  state.roles.push({
    id: roleId,
    namespaceId,
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  state.identities.push({
    kind: "service_principal",
    id: servicePrincipalId,
    namespaceId,
    agentId,
  });
  for (const { sourceId } of credentialSources) {
    state.bindings.push({
      id: `${roleId}-${sourceId}`,
      namespaceId,
      subjectKind: "identity",
      subjectId: servicePrincipalId,
      roleId,
      resourceKind: "credential_source",
      resourceId: sourceId,
    });
  }

  const agentPath = `${base}/agents/${agentId}`;
  const pluginId = "occ-plugin:slack@1.0.0";
  const discovery = { pluginId, managedConnection: { slot: "account", sourceId } };
  const discover = (body: unknown = discovery) =>
    request("POST", `${agentPath}/plugins/details`, { body });
  const detail = await discover();
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.headers.get("cache-control"), "no-store");
  assert.deepEqual(record(detail.data).tools, [
    { id: "slack_search_public", name: "slack_search_public", ownerId: pluginId },
    { id: "slack_send_message", name: "slack_send_message", ownerId: pluginId },
  ]);
  assert.equal(JSON.stringify(detail.body).includes(token), false);
  assert.deepEqual(
    upstream.filter(({ method }) => method !== "GET"),
    ["initialize", "notifications/initialized", "tools/list", "DELETE"].map((method) => ({
      method,
      authenticated: true,
    })),
  );
  assert.equal(tokenReads, 1);
  upstream.length = 0;
  tokenReads = 0;

  const editor = await fixture.createAuthPrincipal("managed-mcp-editor");
  assert(editor.session);
  state.identities.push(editor.principal);
  state.roles.push({
    id: "managed-mcp-editor",
    namespaceId,
    permissions: (["read", "update"] as const).map((action) => ({ action, resourceKind: "agent" })),
  });
  state.bindings.push({
    id: "managed-mcp-editor",
    namespaceId,
    subjectKind: "identity",
    subjectId: editor.principal.id,
    roleId: "managed-mcp-editor",
    resourceKind: "agent",
    resourceId: agentId,
  });
  const forbidden = await request("POST", `${agentPath}/plugins/details`, {
    body: discovery,
    session: editor.session,
  });
  assertApiError(forbidden, 403, "FORBIDDEN");
  assert.match(string(record(record(forbidden.body).error).message), /CredentialSource operate/);
  assert.equal(tokenReads, 0);
  assert.deepEqual(upstream, []);
  // The editor loses source access while the external Configuration Driver resolves the
  // pre-dispatch placement. Their grant must be checked again before the peer sees a bearer.
  const editorSource: (typeof state.bindings)[number] = {
    id: "editor-slack",
    namespaceId,
    subjectKind: "identity",
    subjectId: editor.principal.id,
    roleId,
    resourceKind: "credential_source",
    resourceId: sourceId,
  };
  state.bindings.push(editorSource);
  const { configurationDriver } = fixture;
  const readConfiguration = configurationDriver.read;
  beforeTokenUse = () => {
    configurationDriver.read = async (...args) => {
      const saved = await readConfiguration.apply(configurationDriver, args);
      configurationDriver.read = readConfiguration;
      assert.equal(state.bindings.pop(), editorSource);
      return saved;
    };
  };
  const revoked = await request("POST", `${agentPath}/plugins/details`, {
    body: discovery,
    session: editor.session,
  });
  assertApiError(revoked, 403, "FORBIDDEN");
  assert.equal(tokenReads, 1);
  assert.deepEqual(upstream, []);
  beforeTokenUse = () => {};
  tokenReads = 0;
  state.bindings.pop();

  const agentBinding = state.bindings.pop();
  assert(agentBinding);
  assert.equal(agentBinding.resourceId, sourceId);
  assertApiError(await discover(), 403, "FORBIDDEN");
  assert.equal(tokenReads, 0);
  assert.deepEqual(upstream, []);

  state.bindings.push(agentBinding);
  assertApiError(
    await discover({
      ...discovery,
      managedConnection: { ...discovery.managedConnection, slot: "wrong" },
    }),
    409,
    "RESOURCE_CONFLICT",
  );
  assertApiError(
    await discover({
      ...discovery,
      credentialSource: {
        kind: "credential_source",
        id: sourceId,
        namespaceId,
      },
    }),
    400,
    "INVALID_REQUEST",
  );
  assert.equal(tokenReads, 0);

  const detached = await request("PATCH", agentPath, {
    body: {
      configurationId,
      credentialSources: [{ sourceId: modelId }],
    },
  });
  assert.equal(detached.status, 200, JSON.stringify(detached.body));
  assertApiError(await discover(), 409, "RESOURCE_CONFLICT");
  assert.equal(tokenReads, 0);
  assert.deepEqual(upstream, []);
  const restored = await request("PATCH", agentPath, {
    body: { configurationId, credentialSources },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));

  // An Agent's grant may change during the backend read. Recheck it before calling Slack.
  beforeTokenUse = () => state.bindings.pop();
  assertApiError(await discover(), 403, "FORBIDDEN");
  assert.equal(tokenReads, 1);
  assert.deepEqual(upstream, []);
  beforeTokenUse = () => {};
  state.bindings.push(agentBinding);

  // A server that echoes the bearer in its inventory must not expose it through the picker.
  echoToken = true;
  const echoed = await discover();
  assertApiError(echoed, 503, "PLUGIN_DISCOVERY_INVALID_RESPONSE");
  assert.equal(JSON.stringify(echoed.body).includes(token), false);
  echoToken = false;
  const capabilities = await request("GET", `${agentPath}/plugins/capabilities`);
  assert.equal(capabilities.status, 200, JSON.stringify(capabilities.body));
  assert.equal(
    record(record(capabilities.data).policyScopeByPlugin)[pluginId],
    "tool_human_approval",
  );
  const { credentialSlots } = record(capabilities.data);
  assert(Array.isArray(credentialSlots));
  const slot = record(
    credentialSlots.find((entry: unknown) => asRecord(entry)?.pluginId === pluginId),
  );
  assert.deepEqual(slot.sources, [{ id: sourceId, name: "Slack account" }]);
  assert.equal(slot.toolDiscovery, true);
  const googleId = "occ-plugin:google@1.0.0";
  const google = { [googleId]: { enabled: true } };
  const googleSlot = record(
    credentialSlots.find((entry: unknown) => asRecord(entry)?.pluginId === googleId),
  );
  assert.deepEqual(googleSlot.sources, [{ id: googleSourceId, name: "Google account" }]);
  const pluginsFor = (toolNames: string[]) => ({
    [googleId]: {
      enabled: true,
      driverPolicy: {
        releaseSha256: googleSlot.releaseSha256,
        credentials: { account: googleSourceId },
      },
    },
    [pluginId]: {
      enabled: true,
      driverPolicy: {
        releaseSha256: slot.releaseSha256,
        credentials: { account: sourceId },
        toolNames,
      },
    },
  });
  const save = (plugins: unknown) =>
    request("PATCH", agentPath, {
      body: { configurationId, plugins },
    });
  const refused = await save(pluginsFor(["slack_*"]));
  assertApiError(refused, 400, "INVALID_REQUEST");
  assert.match(
    string(record(record(refused.body).error).message),
    /Select distinct literal Slack tool names/,
  );
  const unselectedApproval = pluginsFor(["slack_search_public"]);
  Object.assign(unselectedApproval[pluginId], {
    tools: { slack_send_message: { approval: "all_actions" } },
  });
  assertApiError(await save(unselectedApproval), 400, "INVALID_REQUEST");
  // Discovery offers both tools. The operator selects one, and deployment freezes that subset.
  const approved = pluginsFor(["slack_send_message"]);
  Object.assign(approved[pluginId], {
    tools: { slack_send_message: { approval: "all_actions" } },
  });
  const saved = await save(approved);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const savedSlack = record(record(record(saved.data).plugins)[pluginId]);
  assert.deepEqual(record(savedSlack.driverPolicy).toolNames, ["slack_send_message"]);
  // Deployment consumes these internal Driver results. Record the real implementation's
  // returns so the test also exercises OCC's selection and source-reference mapping.
  const describe = t.mock.method(pluginDriver, "describeDeployment");
  const deployed = await request("POST", `${agentPath}/deploy`);
  assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
  assert.deepEqual(record(record(deployed.data).plugins).plugins, approved);
  assert.deepEqual(record(deployed.data).credentialSources, credentialSources);

  const descriptionFor = (id: string) => {
    const call = describe.mock.calls.find(({ arguments: [input] }) => input.plugin.pluginId === id);
    assert.ok(call?.result, `deployment must describe ${id}`);
    assert.deepEqual(call.arguments[0].plugin, { catalog: "driver", pluginId: id });
    return call.result;
  };
  const catalog = new URL("../../apps/controller/plugins/", import.meta.url);
  const fileDigest = async (path: string) =>
    createHash("sha256")
      .update(await readFile(new URL(path, catalog)))
      .digest("hex");
  const slack = await descriptionFor(pluginId);
  assert.equal(slack.releaseSha256, slot.releaseSha256);
  const [server] = slack.tools;
  assert.ok(server);
  assert.equal(server.kind, "installation");
  assert.equal(server.role, "harness");
  assert.deepEqual(server.installation, {
    kind: "hosted-mcp",
    endpoint: "https://mcp.slack.com/mcp",
    configuration: {
      kind: "image-manifest",
      path: "/usr/local/lib/oce/plugin-catalog/oce-slack/mcp.json",
      server: "slack",
      sha256: await fileDigest("oce-slack/mcp.json"),
    },
  });
  assert.deepEqual(server.selectedTools, ["slack_send_message"]);
  const account = slack.credentials.account?.default;
  assert.ok(account);
  assert.deepEqual(account.sourceRef, { kind: "credential_source", namespaceId, id: sourceId });
  assert.deepEqual(account.toolIds, [server.id]);
  assert.deepEqual(account.projection, { environment: "SLACK_MCP_TOKEN", presentation: "bearer" });
  const calls = slack.networkRequirements.filter(
    (rule) =>
      account.networkRequirementIds.includes(rule.id) &&
      rule.match.requestPolicy?.type === "mcp" &&
      rule.match.requestPolicy.method === "tools/call",
  );
  assert.deepEqual(
    calls.map(({ toolId, purpose, match }) => ({ toolId, purpose, match })),
    [
      {
        toolId: server.id,
        purpose: "invocation",
        match: {
          binary: "/usr/local/bin/node",
          host: "mcp.slack.com",
          ports: [{ from: 443, to: 443 }],
          requestPolicy: {
            type: "mcp",
            path: "/mcp",
            method: "tools/call",
            toolName: "slack_send_message",
          },
        },
      },
    ],
  );

  const workspace = await descriptionFor(googleId);
  const googleAccount = workspace.credentials.account?.default;
  assert.ok(googleAccount);
  assert.deepEqual(googleAccount.sourceRef, {
    kind: "credential_source",
    namespaceId,
    id: googleSourceId,
  });
  assert.deepEqual(googleAccount.projection, {
    environment: "GOG_ACCESS_TOKEN",
    presentation: "bearer",
  });
  // Both requests use the same worker executable and Gmail host. Only the Gmail action
  // needs this account's bearer; discovery fetches the public API description.
  const gmailGet = workspace.networkRequirements.filter(
    ({ purpose, match }) =>
      purpose === "invocation" &&
      match.host === "gmail.googleapis.com" &&
      match.binary === "/usr/local/lib/oce/plugins/google/bin/gog" &&
      match.requestPolicy?.type === "http" &&
      match.requestPolicy.method === "GET",
  );
  const action = gmailGet.find(({ match }) => match.requestPolicy?.path === "/gmail/v1/users/**");
  assert.ok(action);
  assert.ok(googleAccount.networkRequirementIds.includes(action.id));
  assert.deepEqual(googleAccount.toolIds, [action.toolId]);
  const discoveryRules = gmailGet.filter(
    ({ match }) => match.requestPolicy?.path === "/$discovery/rest",
  );
  assert.ok(discoveryRules.length > 0);
  assert.ok(discoveryRules.every((rule) => !googleAccount.networkRequirementIds.includes(rule.id)));
  for (const { id, match } of workspace.networkRequirements) {
    if (match.host === "gmail.googleapis.com" && googleAccount.networkRequirementIds.includes(id)) {
      assert.ok(match.requestPolicy?.type === "http");
      assert.match(
        match.requestPolicy.path,
        /^\/gmail\//,
        "the bearer must stay under the Gmail API path",
      );
    }
  }
  // This description covers the release before OCC intersects it with a source. Chat
  // expands resource names across segments. A grant on /v1/** would also cover custom emojis.
  const chatPaths = workspace.networkRequirements.flatMap(({ id, match }) =>
    googleAccount.networkRequirementIds.includes(id) &&
    match.host === "chat.googleapis.com" &&
    match.requestPolicy?.type === "http" &&
    match.requestPolicy.method === "GET"
      ? [match.requestPolicy.path]
      : [],
  );
  assert.ok(chatPaths.includes("/v1/spaces/**"));
  assert.ok(chatPaths.includes("/v1/users/**"));
  assert.ok(!chatPaths.includes("/v1/**"));
  const release = record(
    JSON.parse(
      await readFile(new URL("oce-google-workspace/ai.openclaw.oce/release.json", catalog), "utf8"),
    ),
  );
  const binaryPins = Object.fromEntries(
    Object.entries(record(release.artifacts)).map(([platform, artifact]) => [
      platform,
      string(record(artifact).binarySha256),
    ]),
  );
  assert.deepEqual(
    workspace.tools.map(({ kind, role, installation }) => ({ kind, role, installation })),
    [
      {
        kind: "installation",
        role: "gateway",
        installation: {
          kind: "image-skill",
          sha256: await fileDigest("oce-google-workspace/skills/oce-google/SKILL.md"),
          path: "/usr/local/lib/oce/plugin-catalog/oce-google-workspace/skills/oce-google/SKILL.md",
        },
      },
      {
        kind: "installation",
        role: "harness",
        installation: {
          kind: "image-executable",
          path: "/usr/local/lib/oce/plugins/google/bin/gog",
          binarySha256ByPlatform: binaryPins,
        },
      },
    ],
  );

  describe.mock.resetCalls();
  // Keep all three sources attached while removing both plugin connections from the draft.
  const cleared = await request("PATCH", agentPath, {
    body: { configurationId, plugins: google, credentialSources },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.deepEqual(record(cleared.data).plugins, google);
  assert.deepEqual(record(cleared.data).credentialSources, credentialSources);
  const unconnected = await descriptionFor(googleId);
  assert.deepEqual(unconnected.credentials, { account: {} });
  // A plugin's reviewed network-only requests do not depend on an account connection.
  assert.ok(unconnected.networkRequirements.length > 0);
  assert.ok(
    unconnected.networkRequirements.every(
      ({ match }) => match.requestPolicy?.type === "http" && match.requestPolicy.method === "GET",
    ),
  );
  assert.ok(
    unconnected.networkRequirements.some(
      ({ match }) =>
        match.host === "gmail.googleapis.com" && match.requestPolicy?.path === "/$discovery/rest",
    ),
  );
  assert.ok(
    !unconnected.networkRequirements.some(({ id }) =>
      googleAccount.networkRequirementIds.includes(id),
    ),
  );
  const revision = await request(
    "GET",
    `${agentPath}/revisions/${string(record(deployed.data).id)}`,
  );
  assert.equal(revision.status, 200, JSON.stringify(revision.body));
  assert.deepEqual(record(record(revision.data).plugins).plugins, approved);
});
