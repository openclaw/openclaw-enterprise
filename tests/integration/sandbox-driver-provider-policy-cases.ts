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
import { openShellPluginPolicy } from "../../apps/controller/src/drivers/sandbox/openshell-plugin-policy.ts";
import type {
  AgentRevision,
  HarnessWorkloadRequirements,
  ProxyPlan,
  RepositoryRevisionState,
  SandboxNetworkGrant,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { verifyManagedMcpProjection } from "./sandbox-driver-managed-mcp-rules-cases.ts";
import { openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import { completeSandboxRevision } from "./sandbox-driver-revision-fixture.ts";
import { runtimeSandboxFixture } from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

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

export function registerManagedPluginPolicyCases(): void {
  // The launch policy takes network_middlewares from the egress policy or the plugin guard,
  // never both: only this refusal keeps the two maps apart.
  test("a managed Google plugin is refused with repository credentials, proxy wiring or an egress plan", () => {
    const { revision: fixture, requirements } = runtimeSandboxFixture(
      openShellDriver(workspaceGatewayClient()),
      { harnessId: "openclaw" },
    );
    const sourceId = "cs_00000000-0000-4000-8000-000000000005";
    const revision: AgentRevision = {
      ...completeSandboxRevision(fixture),
      plugins: {
        driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
        plugins: {
          [managedGoogleInstall.id]: {
            enabled: true,
            driverPolicy: {
              releaseSha256: managedGoogleInstall.releaseSha256,
              credentials: { account: sourceId },
            },
          },
        },
      },
    };
    const admitted = {
      ...requirements,
      credentialAttachments: [
        {
          sourceId,
          ref: openShellProviderName(sourceId),
          requestScope: {
            host: "gmail.googleapis.com",
            port: 443,
            path: "/gmail/v1/users/me/messages",
            scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          },
        },
      ],
    };
    const endpoint = "https://authority.test:443";
    assert.ok(openShellPluginPolicy(revision, admitted, endpoint, [])?.middlewares);
    const repositoryCredentials: RepositoryRevisionState = {
      driver: { id: "repository", implementation: "github" },
      deadlineWallMs: Date.now() + 600_000,
      bindings: [],
    };
    const plan: ProxyPlan = {
      id: "00000000-0000-4000-8000-000000000001",
      generation: 1,
      routes: [],
      sandboxDriverId: "openshell",
      egressDriverId: "openshell",
      execution: {
        installationId: "ins_fixture",
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        servicePrincipalId: revision.servicePrincipalId,
        revisionId: revision.id,
        executionId: "00000000-0000-4000-8000-000000000002",
      },
    };
    const cases: Array<[string, AgentRevision, HarnessWorkloadRequirements]> = [
      ["repository credentials", { ...revision, repositoryCredentials }, admitted],
      ["proxy wiring", revision, { ...admitted, proxyWiring: { plan, configuration: {} } }],
      ["an egress plan", { ...revision, egressPlan: plan }, admitted],
    ];
    for (const [condition, refused, launch] of cases) {
      assert.throws(
        () => openShellPluginPolicy(refused, launch, endpoint, []),
        {
          code: "SANDBOX_HARNESS_UNSUPPORTED",
          message: /requires its selected OpenShell provider, the dedicated OpenClaw worker/,
        },
        `A managed Google plugin must be refused with ${condition}.`,
      );
    }
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
