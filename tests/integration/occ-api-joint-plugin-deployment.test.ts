import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { listManagedMcpToolNames } from "../../apps/controller/src/connections/mcp-tool-discovery.ts";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import type { CredentialGatewayDriver, SandboxDriver } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import {
  createInjectedControllerFixture,
  identifier,
  injectedRequest,
} from "./occ-api-injected-fixture.ts";

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
  const gateway: CredentialGatewayDriver & { rotateSource: typeof unexpectedGatewayCall } = {
    id: "credential-gateway-slack-admission",
    capability: "credential_gateway",
    implementation: "openshell",
    validateSourceConfig() {},
    async listSourceTypes() {
      return [
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
  for (const driver of [sandbox, gateway]) {
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
  const credentialSources = [{ sourceId: modelId }, { sourceId }];
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
  const { credentialSlots } = record(capabilities.data);
  assert(Array.isArray(credentialSlots));
  const slot = record(
    credentialSlots.find((entry: unknown) => asRecord(entry)?.pluginId === pluginId),
  );
  assert.deepEqual(slot.sources, [{ id: sourceId, name: "Slack account" }]);
  assert.equal(slot.toolDiscovery, true);
  const google = { "occ-plugin:google@1.0.0": { enabled: true } };
  const pluginsFor = (toolNames: string[]) => ({
    ...google,
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
  // Discovery offers both tools. The operator selects one, and deployment freezes that subset.
  const approved = pluginsFor(["slack_send_message"]);
  const saved = await save(approved);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const savedSlack = record(record(record(saved.data).plugins)[pluginId]);
  assert.deepEqual(record(savedSlack.driverPolicy).toolNames, ["slack_send_message"]);
  const deployed = await request("POST", `${agentPath}/deploy`);
  assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
  assert.deepEqual(record(record(deployed.data).plugins).plugins, approved);
  assert.deepEqual(record(deployed.data).credentialSources, credentialSources);

  const cleared = await save(google);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.deepEqual(record(cleared.data).plugins, google);
  assert.deepEqual(record(cleared.data).credentialSources, credentialSources);
  const revision = await request(
    "GET",
    `${agentPath}/revisions/${string(record(deployed.data).id)}`,
  );
  assert.equal(revision.status, 200, JSON.stringify(revision.body));
  assert.deepEqual(record(record(revision.data).plugins).plugins, approved);
});
