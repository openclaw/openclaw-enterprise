import assert from "node:assert/strict";
import test from "node:test";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import {
  managedMcpInstalls,
  type ManagedMcpInstall,
} from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxCreateRequest,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  AgentRevision,
  CredentialSource,
  CredentialSourceInput,
  SandboxNetworkGrant,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { CredentialProviderFixture } from "./sandbox-driver-credential-fixture.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { verifyManagedMcpProjection } from "./sandbox-driver-managed-mcp-rules-cases.ts";
import { openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import { completeSandboxRevision } from "./sandbox-driver-revision-fixture.ts";
import { buildSandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import { runtimeSandboxFixture } from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

export const negotiatedGoogleGuard = () => ({
  kind: 4,
  configured_name: "oce-plugin-requests",
  implementation_name: "oce/managed-plugin-requests",
  implementation_version: managedGoogleInstall.releaseSha256,
  protocol_major: 1,
  supported_capabilities: ["openshell.supervisor-middleware.contract"],
  required_capabilities: ["openshell.supervisor-middleware.contract"],
});

type PolicyRevision = Omit<AgentRevision, "plugins" | "sandboxPolicy" | "credentialSources"> & {
  -readonly [Key in "plugins" | "sandboxPolicy" | "credentialSources"]?: NonNullable<
    AgentRevision[Key]
  >;
};

function observedRecord(value: unknown, field: string) {
  const record = asRecord(value);
  assert.ok(record, `Expected an object at ${field}.`);
  return record;
}

function observedRecords(value: unknown, field: string) {
  assert.ok(Array.isArray(value), `Expected an array at ${field}.`);
  return value.map((entry: unknown) => observedRecord(entry, field));
}

function observedEndpoints(route: unknown) {
  return observedRecords(observedRecord(route, "network route").endpoints, "endpoints");
}

function observedSlackEndpoint(route: unknown) {
  const [endpoint] = observedEndpoints(route);
  assert.ok(endpoint, "Expected the Slack endpoint in the launch policy.");
  return endpoint;
}

function observedProviders(spec: OpenShellSandboxCreateRequest["spec"]) {
  const { providers } = spec;
  assert.ok(Array.isArray(providers));
  const entries: unknown[] = providers;
  assert.ok(
    entries.every((ref) => typeof ref === "string"),
    "Expected provider refs as strings.",
  );
  return entries;
}

function networkPolicies(policy: Record<string, unknown>) {
  return observedRecord(policy.network_policies, "network_policies");
}

// Model OpenShell's effective wire policy after attaching a Slack provider. The saved
// Sandbox keeps its original uncredentialed launch rule.
function admitSlackProvider(
  routes: Record<string, unknown>,
  ref: string,
  install: ManagedMcpInstall,
) {
  const providerName = "_provider_" + ref.replaceAll("-", "_");
  const endpoint = observedSlackEndpoint(routes["oce-slack-mcp"]);
  endpoint.provider_credentialed = true;
  observedRecord(endpoint.mcp, "mcp")._strict_tool_names = "strict_tool_names";
  routes[providerName] = {
    name: providerName,
    binaries: [{ path: "/usr/local/bin/node" }],
    endpoints: [
      {
        host: "mcp.slack.com",
        port: 443,
        path: "/mcp",
        protocol: "mcp",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        mcp: { strict_tool_names: true, versions: [...install.mcpVersions] },
        rules: [{ allow: { method: "ping" } }],
        provider_credentialed: true,
      },
    ],
  };
}

type CredentialGatewayFactory = (options: {
  toolBinaries: readonly string[];
  refresh: boolean;
}) => Pick<CredentialProviderFixture, "source" | "driver"> & {
  client: Pick<OpenShellGatewayClient, "getGatewayInfo">;
};

export function registerManagedPluginPolicyCases(
  credentialGatewayOverProviders: CredentialGatewayFactory,
): void {
  test("a selected Google account keeps its request guard alongside an independently bound Slack MCP server", async () => {
    const managedSlackInstall = managedMcpInstalls.find(
      ({ id }) => id === "occ-plugin:slack@1.0.0",
    );
    assert.ok(managedSlackInstall);
    const registration = "oce-plugin-requests";
    const configuration = buildSandboxInstallation().drivers.sandbox.configuration;
    const managedPluginMiddleware = "https://authority.test:443";
    const client = workspaceGatewayClient();
    const driver = openShellDriver(client, {
      ...configuration,
      gateway: { ...configuration.gateway, managedPluginMiddleware },
    });
    const {
      context,
      revision: fixture,
      requirements,
    } = runtimeSandboxFixture(driver, {
      harnessId: "openclaw",
    });
    const revision: PolicyRevision = completeSandboxRevision(fixture);
    const sourceId = "cs_00000000-0000-4000-8000-000000000005";
    const slackId = "cs_00000000-0000-4000-8000-000000000006";
    revision.plugins = {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      plugins: {
        [managedGoogleInstall.id]: {
          enabled: true,
          driverPolicy: {
            releaseSha256: managedGoogleInstall.releaseSha256,
            credentials: { account: sourceId },
          },
        },
        [managedSlackInstall.id]: {
          enabled: true,
          driverPolicy: {
            releaseSha256: managedSlackInstall.releaseSha256,
            credentials: { account: slackId },
            toolNames: ["slack_search_public"],
          },
        },
      },
    };
    const gateway = credentialGatewayOverProviders({
      toolBinaries: [managedGoogleInstall.binaryPath, "/usr/local/bin/node"],
      refresh: true,
    });
    gateway.client.getGatewayInfo = async () => ({ extensions: [negotiatedGoogleGuard()] });
    const googleSource: CredentialSource = {
      ...gateway.source(sourceId, context.namespace.id),
      type: "oauth2-refresh-token",
      config: {
        host: "gmail.googleapis.com",
        path: "/gmail/v1/users/me/messages",
        token_url: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        client_id: "test-client",
        env_var: "GOG_ACCESS_TOKEN",
        binary: managedGoogleInstall.binaryPath,
      },
    };
    const slackSource: CredentialSource = {
      ...gateway.source(slackId, context.namespace.id),
      type: "bearer-token",
      secrets: { token: { kind: "secret", id: "sec_slack", namespaceId: context.namespace.id } },
      config: { protocol: "mcp", host: "mcp.slack.com", path: "/mcp", env_var: "SLACK_MCP_TOKEN" },
    };
    const register = (source: CredentialSource, secrets: CredentialSourceInput["secrets"]) =>
      gateway.driver.registerSource(
        { ...context, source },
        { type: source.type, config: source.config, secrets },
      );
    await register(googleSource, {});
    await register(slackSource, { token: "synthetic-slack-bearer" });
    const [google, slack] = await gateway.driver.attachForRevision({
      ...context,
      revision,
      sources: [googleSource, slackSource],
    });
    assert.ok(google?.requestScope);
    assert.ok(slack);
    const { requestScope } = google;
    requirements.credentialAttachments = [google, slack];
    const provision = () => driver.provisionHarness({ ...context, revision, requirements });
    let created: ReturnType<typeof storedSandbox> | undefined;
    const getCreated = () => {
      assert.ok(created, "Expected the gateway to have recorded CreateSandbox.");
      return created;
    };
    let observedGuard = true;
    const credentialedHosts = new Set<string>();
    let endpoint = managedPluginMiddleware;
    const provider = "_provider_" + openShellProviderName(sourceId).replaceAll("-", "_");
    const providerEndpoint = {
      host: "gmail.googleapis.com",
      port: 443,
      path: "/gmail/v1/users/me/messages",
      protocol: "rest",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      access: "NETWORK_ACCESS_PRESET_READ_WRITE",
      provider_credentialed: true,
    };
    const providerRule = {
      name: provider,
      binaries: [{ path: managedGoogleInstall.binaryPath }],
      endpoints: [providerEndpoint],
    };
    const independentEndpoint = {
      host: "independent.example",
      ports: [8443],
      provider_credentialed: true,
    };
    const independentProvider = {
      name: "_provider_independent",
      binaries: [{ path: "/usr/bin/curl" }],
      endpoints: [independentEndpoint],
    };
    client.createSandbox = async (request) => {
      created = storedSandbox(request, { serviceUrls: {} });
      return created;
    };
    client.getSandbox = async () => created;
    client.getSandboxConfig = async (workspace) => {
      const { spec } = getCreated();
      const policy = observedRecord(structuredClone(spec.policy), "policy");
      const routes = networkPolicies(policy);
      if (observedProviders(spec).includes(openShellProviderName(sourceId))) {
        for (const ep of observedEndpoints(routes["oce-google-requests"])) {
          const { host } = ep;
          assert.ok(typeof host === "string");
          if (credentialedHosts.has(host)) {
            ep.provider_credentialed = true;
          }
        }
        routes[provider] = providerRule;
      }
      admitSlackProvider(routes, slack.ref, managedSlackInstall);
      routes[independentProvider.name] = independentProvider;
      if (!observedGuard) {
        policy.network_middlewares = {};
      }
      return {
        workspace,
        policy_source: 1,
        configuration_admitted: true,
        policy_validation_failure_mode: "fail_closed",
        extension_authentication_enabled: true,
        supervisor_middleware_services: [
          {
            name: registration,
            grpc_endpoint: endpoint,
            audience: "urn:openshell:extension:middleware:" + registration,
          },
        ],
        policy,
      };
    };
    await driver.ensureNamespace(context);
    await assert.rejects(
      () =>
        driver.provisionHarness({
          ...context,
          revision,
          requirements: { ...requirements, credentialAttachments: [] },
        }),
      /selected OpenShell provider/,
    );
    // A lookalike extension cannot authorize creation or provider reconciliation.
    const service = negotiatedGoogleGuard();
    client.getGatewayInfo = async () => ({ extensions: [service] });
    service.implementation_name = "other/response-only";
    await assert.rejects(provision, /has not negotiated/);
    assert.equal(created, undefined);
    assert.equal(client.providers.size, 0);
    assert.equal(client.profiles.size, 0);
    Object.assign(service, negotiatedGoogleGuard());
    revision.sandboxPolicy = driver.admitNetworkPolicy(
      [
        {
          id: "wide",
          host: "gmail.googleapis.com",
          ports: [{ from: 443, to: 443 }],
          binary: "/usr/bin/curl",
        },
      ],
      1,
      {},
    );
    await assert.rejects(provision, /bypass the managed plugin/);
    delete revision.sandboxPolicy;
    await provision();
    const { spec } = getCreated();
    const providers = observedProviders(spec);
    assert.ok(providers.includes(openShellProviderName(sourceId)));
    assert.ok(providers.includes(slack.ref));
    const policy = observedRecord(spec.policy, "policy");
    const routes = networkPolicies(policy);
    const slackNetwork = routes["oce-slack-mcp"];
    const slackRules = observedRecords(observedSlackEndpoint(slackNetwork).rules, "Slack rules");
    assert.deepEqual(slackRules.at(-1), {
      allow: { method: "tools/call", params: { name: { glob: "slack_search_public" } } },
    });
    const environment = observedRecord(spec.environment, "environment");
    assert.equal(environment.OPENCLAW_MANAGED_CREDENTIAL_ENV, "GOG_ACCESS_TOKEN");
    assert.equal(environment.GOG_ACCESS_TOKEN, undefined);
    const middlewares = observedRecord(policy.network_middlewares, "network_middlewares");
    const guard = observedRecord(middlewares[registration], registration);
    const fields = observedRecord(observedRecord(guard.config, "guard config").fields, "fields");
    assert.equal(
      observedRecord(fields.binding_id, "binding_id").stringValue,
      managedGoogleInstall.releaseSha256,
    );
    assert.equal(guard.on_error, "fail_closed");
    assert.deepEqual(observedRecord(guard.endpoints, "guard endpoints").include, [
      "gmail.googleapis.com",
      "www.googleapis.com",
    ]);
    const rule = observedRecord(routes["oce-google-requests"], "Google route");
    assert.deepEqual(rule.binaries, [{ path: managedGoogleInstall.binaryPath }]);
    const [gmail, discovery] = observedEndpoints(rule);
    assert.ok(gmail && discovery);
    assert.deepEqual(observedRecords(gmail.rules, "Gmail rules")[0]?.allow, {
      method: "GET",
      path: "/gmail/v1/users/me/messages",
    });
    assert.deepEqual(
      observedRecords(discovery.rules, "discovery rules").map(
        ({ allow }) => observedRecord(allow, "allow").path,
      ),
      ["/discovery/v1/apis", "/discovery/v1/apis/gmail/v1/rest"],
    );
    independentEndpoint.host = "gmail.googleapis.com";
    await assert.rejects(provision, /Another credential provider uses a guarded Google host/);
    independentEndpoint.host = "independent.example";
    providerEndpoint.path = "/**";
    await assert.rejects(provision, /exact Google provider route/);
    providerEndpoint.path = "/gmail/v1/users/me/messages";
    endpoint = "https://other.test:443";
    await assert.rejects(provision, /has not admitted.*request guard/);
    endpoint = managedPluginMiddleware;
    observedGuard = false;
    await assert.rejects(provision, /has not admitted.*request guard/);
    observedGuard = true;

    // For a host-wide source, stock OpenShell also marks the matching operation
    // endpoint credentialed in GetSandboxConfig. The saved CreateSandbox spec stays raw.
    requirements.credentialAttachments = [
      { ...google, requestScope: { ...requestScope, path: "/**" } },
      slack,
    ];
    providerEndpoint.path = "/**";
    created = undefined;
    await assert.rejects(provision, /pinned Google request routes/);
    credentialedHosts.add(requestScope.host);
    await provision();
    assert.ok(
      observedEndpoints(
        networkPolicies(observedRecord(getCreated().spec.policy, "policy"))["oce-google-requests"],
      ).every((ep) => ep.provider_credentialed === undefined),
    );
    credentialedHosts.add("www.googleapis.com");
    await assert.rejects(provision, /pinned Google request routes/);
    credentialedHosts.delete("www.googleapis.com");

    // The worker dispatches the same admitted revision without the withdrawn tool source.
    revision.credentialSources = [
      { sourceId, credentialGatewayId: gateway.driver.id, sourceType: googleSource.type },
      { sourceId: slackId, credentialGatewayId: gateway.driver.id, sourceType: slackSource.type },
    ];
    requirements.credentialAttachments = [
      ...(await gateway.driver.attachForRevision({
        ...context,
        revision,
        sources: [slackSource],
      })),
    ];
    await assert.rejects(provision, /exact AgentRevision ownership and content/);
    // OpenShell's detach removes the provider from a standing Sandbox. Its immutable launch
    // environment and policy still describe the original request. It can be safely adopted.
    const standing = getCreated();
    created = {
      ...standing,
      spec: {
        ...standing.spec,
        providers: observedProviders(standing.spec).filter(
          (ref) => ref !== openShellProviderName(sourceId),
        ),
      },
    };
    await provision();
    created = undefined;
    await provision();
    const { spec: detached } = getCreated();
    const detachedProviders = observedProviders(detached);
    const detachedPolicy = observedRecord(detached.policy, "policy");
    const detachedNetworks = networkPolicies(detachedPolicy);
    assert.ok(detachedProviders.includes(slack.ref));
    assert.deepEqual(detachedNetworks["oce-slack-mcp"], slackNetwork);
    assert.ok(!detachedProviders.includes(openShellProviderName(sourceId)));
    assert.equal(
      observedRecord(detached.environment, "environment").OPENCLAW_MANAGED_CREDENTIAL_ENV,
      undefined,
    );
    assert.equal(asRecord(detachedPolicy.network_middlewares)?.[registration], undefined);
    assert.equal(detachedNetworks["oce-google-requests"], undefined);
  });

  test("OpenShell builds managed MCP rules for the declared endpoint and upstream tool name", () => {
    verifyManagedMcpProjection();
  });

  test("OpenShell limits a Slack connection to the revision's exact MCP tools and recovers after detach", async () => {
    const managedSlackInstall = managedMcpInstalls.find(
      ({ id }) => id === "occ-plugin:slack@1.0.0",
    );
    assert.ok(managedSlackInstall);
    const client = workspaceGatewayClient();
    const driver = openShellDriver(client);
    const {
      context,
      revision: fixture,
      requirements,
    } = runtimeSandboxFixture(driver, {
      harnessId: "openclaw",
    });
    const revision: PolicyRevision = completeSandboxRevision(fixture);
    const sourceId = "cs_00000000-0000-4000-8000-000000000091";
    const ref = openShellProviderName(sourceId);
    const routeName = "oce-slack-mcp";
    const broadGrant: SandboxNetworkGrant = {
      id: "slack-bypass",
      host: "*.slack.com",
      ports: [{ from: 443, to: 443 }],
      binary: "/usr/bin/curl",
    };
    const selection = {
      enabled: true,
      driverPolicy: {
        releaseSha256: managedSlackInstall.releaseSha256,
        credentials: { account: sourceId },
        toolNames: ["slack_search_public", "slack_search_emojis"],
      },
    };
    revision.plugins = {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      plugins: { [managedSlackInstall.id]: selection },
    };
    const requestScope = {
      host: "mcp.slack.com",
      port: 443,
      path: "/mcp",
      scopes: ["search:read.public"],
    };
    requirements.credentialAttachments = [{ sourceId, ref, requestScope }];
    requirements.environment.push({ name: "SLACK_MCP_TOKEN", value: "arbitrary-unbound-value" });
    let created: ReturnType<typeof storedSandbox> | undefined;
    const getCreated = () => {
      assert.ok(created, "Expected the gateway to have recorded CreateSandbox.");
      return created;
    };
    let broadenEffective = false;
    const policyUpdates: Parameters<NonNullable<OpenShellGatewayClient["updatePolicy"]>>[0][] = [];
    client.createSandbox = async (request) => {
      created = storedSandbox(
        { ...request, spec: structuredClone(request.spec) },
        {
          serviceUrls: {},
          resourceVersion: "1",
        },
      );
      return created;
    };
    client.getSandbox = async () => created;
    client.updatePolicy = async (request) => {
      policyUpdates.push(request);
    };
    client.getSandboxConfig = async (workspace) => {
      const policy = observedRecord(structuredClone(getCreated().spec.policy), "policy");
      const routes = networkPolicies(policy);
      admitSlackProvider(routes, ref, managedSlackInstall);
      if (broadenEffective) {
        routes.unexpected = { endpoints: [{ host: "mcp.slack.com", port: 443 }] };
      }
      return {
        workspace,
        policy_source: 1,
        configuration_admitted: true,
        policy_validation_failure_mode: "fail_closed",
        policy,
      };
    };
    const provision = () => driver.provisionHarness({ ...context, revision, requirements });
    await driver.ensureNamespace(context);
    revision.sandboxPolicy = driver.admitNetworkPolicy([broadGrant], 1, {});
    await assert.rejects(provision, /overlaps the credentialed managed MCP endpoint/);
    assert.equal(created, undefined);
    revision.sandboxPolicy = driver.admitNetworkPolicy([], 2, {});
    const plugins = revision.plugins;
    delete revision.plugins;
    await provision();
    const { spec: unbound } = getCreated();
    const unboundNetworks = networkPolicies(observedRecord(unbound.policy, "policy"));
    assert.deepEqual(observedSlackEndpoint(unboundNetworks[routeName]).rules, [
      { allow: { method: "ping" } },
    ]);
    assert.ok(observedProviders(unbound).includes(ref));
    created = undefined;
    revision.plugins = plugins;
    revision.credentialSources = [
      { sourceId, credentialGatewayId: "openshell-credentials", sourceType: "bearer-token" },
    ];
    requestScope.port = 8443;
    await assert.rejects(
      provision,
      /requires its reviewed OpenShell provider and an isolated endpoint/,
    );
    assert.equal(created, undefined);
    requestScope.port = 443;
    await provision();
    const { spec } = getCreated();
    const policy = observedRecord(spec.policy, "policy");
    const route = networkPolicies(policy)[routeName];
    const slackEndpoint = observedSlackEndpoint(route);
    assert.equal(slackEndpoint.protocol, "mcp");
    assert.deepEqual(slackEndpoint.ports, [443]);
    assert.deepEqual(slackEndpoint.rules, [
      { allow: { method: "ping" } },
      { allow: { method: "initialize" } },
      { allow: { method: "notifications/initialized" } },
      { allow: { method: "tools/list" } },
      { allow: { method: "tools/call", params: { name: { glob: "slack_search_public" } } } },
      { allow: { method: "tools/call", params: { name: { glob: "slack_search_emojis" } } } },
    ]);
    assert.equal(observedRecord(spec.environment, "environment").SLACK_MCP_TOKEN, undefined);
    assert.equal(policy.network_middlewares, undefined);

    const snapshot = driver.admitNetworkPolicy([broadGrant], 3, {});
    await assert.rejects(
      () =>
        driver.applyNetworkPolicy(
          { ...context, revision },
          { snapshot, expectedProviderVersion: "1", operationId: "slack-policy-update" },
        ),
      /overlaps the credentialed managed MCP endpoint/,
    );
    assert.equal(policyUpdates.length, 0);
    const unrelated = driver.admitNetworkPolicy(
      [{ ...broadGrant, host: "docs.example.test" }],
      3,
      {},
    );
    await driver.applyNetworkPolicy(
      { ...context, revision },
      { snapshot: unrelated, expectedProviderVersion: "1", operationId: "unrelated-policy-update" },
    );
    assert.equal(policyUpdates.length, 1);
    const [update] = policyUpdates;
    assert.ok(update);
    assert.equal(update.requestId, "unrelated-policy-update");
    assert.equal(update.expectedResourceVersion, "1");
    assert.deepEqual(networkPolicies(update.policy)[routeName], route);
    broadenEffective = true;
    await assert.rejects(provision, /overlaps the credentialed managed MCP endpoint/);
    broadenEffective = false;

    // Keep the launch rule while reflecting OpenShell's independent provider detach.
    requirements.credentialAttachments = [];
    await assert.rejects(provision, /exact AgentRevision ownership and content/);
    const standing = getCreated();
    observedRecord(slackEndpoint.mcp, "mcp")._strict_tool_names = "strict_tool_names";
    created = {
      ...standing,
      spec: {
        ...standing.spec,
        providers: observedProviders(standing.spec).filter((name) => name !== ref),
      },
    };
    await provision();
    created = undefined;
    await provision();
    const { spec: detached } = getCreated();
    assert.equal(networkPolicies(observedRecord(detached.policy, "policy"))[routeName], undefined);
    assert.ok(!observedProviders(detached).includes(ref));
  });
}
