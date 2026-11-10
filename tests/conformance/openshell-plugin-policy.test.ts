import assert from "node:assert/strict";
import test from "node:test";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  googleRequestPolicy,
  reconcileObsoleteGoogleRequestRules,
} from "../../apps/controller/src/drivers/sandbox/openshell-plugin-policy.ts";
import { allowsPluginRequest } from "../../apps/controller/src/drivers/plugin/managed-request-policies.ts";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import {
  eligibleGoogleOperations,
  googleDiscoveryRequests,
  type GoogleRequestScope,
} from "../../apps/controller/src/drivers/plugin/google-workspace/operations.ts";
import type { OpenShellOnlineHttpRequest } from "../../apps/controller/src/drivers/egress-proxy/openshell-online-authority.ts";
import { wirePolicy } from "../../apps/controller/src/drivers/egress-proxy/openshell-wire-policy.ts";

const adsenseScope: GoogleRequestScope = {
  host: "adsense.googleapis.com",
  port: 443,
  path: "/v2/**",
  scopes: ["https://www.googleapis.com/auth/adsense.readonly"],
};
const gmailScope: GoogleRequestScope = {
  host: "gmail.googleapis.com",
  port: 443,
  path: "/gmail/v1/**",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
};

function legacyAllowPath(opPath: string, scope: GoogleRequestScope): string {
  const literal = opPath.split("{")[0]!;
  const inside =
    scope.path === "/**" ||
    (scope.path.endsWith("/**") && literal.startsWith(scope.path.slice(0, -2)));
  return inside ? opPath.replace(/\{\+?\w+\}/g, "*") : scope.path;
}

function storedLegacyPolicy(scope: GoogleRequestScope) {
  const current = googleRequestPolicy(scope);
  const allows = new Map<string, Map<string, { method: string; path: string }>>();
  const permit = (host: string, method: string, path: string) => {
    const rules = allows.get(host) ?? new Map();
    rules.set(`${method} ${path}`, { method, path });
    allows.set(host, rules);
  };
  const operations = eligibleGoogleOperations(scope);
  for (const [, op] of operations) {
    permit(scope.host, op.method, legacyAllowPath(op.path, scope));
  }
  for (const discovery of googleDiscoveryRequests(scope, operations)) {
    permit(discovery.host, "GET", discovery.path);
  }
  return {
    network_middlewares: current.middlewares,
    network_policies: {
      "oce-google-requests": {
        name: "oce-google-requests",
        binaries: [{ path: managedGoogleInstall.binaryPath }],
        endpoints: [...allows].map(([host, rules]) => ({
          host,
          ports: [443],
          protocol: "rest",
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          rules: [...rules.values()].map((allow) => ({ allow })),
        })),
      },
    },
  };
}

function allowPaths(scope: GoogleRequestScope): string[] {
  const endpoints = googleRequestPolicy(scope).networks["oce-google-requests"].endpoints as {
    host: string;
    rules: { allow: { method: string; path: string } }[];
  }[];
  return endpoints.flatMap((endpoint) =>
    endpoint.host === scope.host
      ? endpoint.rules.map((rule) => `${rule.allow.method} ${rule.allow.path}`)
      : [],
  );
}

function allowPathsFrom(policy: {
  network_policies: {
    "oce-google-requests": {
      endpoints: { rules?: { allow: { method: string; path: string } }[] }[];
    };
  };
}): string[] {
  return policy.network_policies["oce-google-requests"].endpoints.flatMap((endpoint) =>
    (endpoint.rules ?? []).map((rule) => `${rule.allow.method} ${rule.allow.path}`),
  );
}

function httpRequest(
  scope: GoogleRequestScope,
  path: string,
  bindingId = managedGoogleInstall.releaseSha256,
): OpenShellOnlineHttpRequest {
  return {
    sandboxId: "fixture-runtime-1",
    bindingId,
    bindingConfig: JSON.stringify(scope),
    requestId: "trace-1",
    workspace: "oce-cutover",
    target: {
      reportedScheme: "https",
      host: scope.host,
      port: 443,
      method: "GET",
      path,
      query: "",
    },
    headers: [],
    body: new Uint8Array(),
    deadlineAt: "2099-01-01T00:00:00.000Z",
  };
}

test("one-segment parameters and literal routes stay exact", () => {
  const gmail = allowPaths(gmailScope);
  assert.ok(gmail.includes("GET /gmail/v1/users/*/messages"));
  assert.equal(gmail.includes("GET /gmail/v1/users/**/messages"), false);
  const adsense = allowPaths(adsenseScope);
  assert.ok(adsense.includes("GET /v2/accounts"));
  assert.ok(adsense.includes("GET /v2/**"));
  assert.equal(adsense.includes("GET /v2/*"), false);
  assert.equal(
    adsense.some((allow) => allow.includes("*:")),
    false,
  );
});

test("an existing AdSense Sandbox replaces only its obsolete generated rules", async () => {
  const stored = storedLegacyPolicy(adsenseScope);
  const storedPaths = allowPathsFrom(stored);
  assert.ok(storedPaths.includes("GET /v2/*"));
  assert.ok(storedPaths.includes("GET /v2/*:listChildAccounts"));
  const replaced = reconcileObsoleteGoogleRequestRules(stored) as typeof stored;
  assert.deepEqual(
    wirePolicy(replaced.network_policies["oce-google-requests"]),
    wirePolicy(googleRequestPolicy(adsenseScope).networks["oce-google-requests"]),
  );
  const tampered = structuredClone(stored);
  tampered.network_policies["oce-google-requests"].endpoints[0]!.rules.push({
    allow: { method: "GET", path: "/v2/not-generated" },
  });
  assert.equal(reconcileObsoleteGoogleRequestRules(tampered), tampered);

  const sandboxConfiguration = {
    gateway: { workspaceMode: "operator" },
    kubernetes: {
      runtimeClassName: "openshell-sandbox",
      userNamespaces: false,
      serviceAccount: { mode: "gatewayConfigured" },
      sandboxDataMount: {
        subPath: "workspace",
        mountPath: "/sandbox/enterprise",
        readOnly: false,
      },
    },
    policy: {
      process: { runAsUser: "1000", runAsGroup: "1000" },
      networkPolicies: [
        {
          name: "model-egress",
          endpoints: [{ host: "api.openai.com", ports: [443] }],
          binaries: [{ path: "/app/bin/model-client" }],
        },
      ],
    },
  } as ConstructorParameters<typeof OpenShellSandboxDriver>[0];
  const updated: unknown[] = [];
  let policy: typeof stored | { network_policies: Record<string, unknown> } = stored;
  const gatewayClient = {
    async getSandbox() {
      return {
        name: "pending",
        workspace: "oce-cutover",
        labels: {},
        annotations: {
          "openclaw.dev/namespace-id": "ns_00000000-0000-4000-8000-000000000001",
          "openclaw.dev/agent-id": "agt_00000000-0000-4000-8000-000000000003",
          "openclaw.dev/revision-id": "rev_00000000-0000-4000-8000-000000000003",
        },
        resourceVersion: "4",
        serviceUrls: {},
        spec: { policy },
      };
    },
    async updatePolicy(input: { policy: typeof policy }) {
      updated.push(input.policy);
      policy = input.policy;
    },
  };
  const driver = new OpenShellSandboxDriver(sandboxConfiguration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: {
      id: "openshell",
      drivers: { sandbox: "openshell-sandbox" },
      client: new OpenShellGateway(
        { serviceName: "openshell-gateway" },
        { gatewayClient: gatewayClient as never },
      ),
    },
  });
  const namespace = {
    id: "ns_00000000-0000-4000-8000-000000000001",
    name: "oce-cutover",
    status: "ready" as const,
    createdAt: "2026-09-23T00:00:00.000Z",
  };
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000003",
    namespaceId: namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000003",
    sandboxDriverId: driver.id,
    harness: {
      id: "openclaw",
      version: "1.0.0",
      mode: "dedicated" as const,
      overrides: {},
      configuration: {},
    },
    executionAdmission: { mode: "standard" as const },
  };
  const loaded = await gatewayClient.getSandbox();
  assert.ok(allowPathsFrom(loaded.spec.policy as typeof stored).includes("GET /v2/*"));
  const sandboxName = driver.harnessResource({
    namespace,
    revision: revision as never,
  }).resourceName;
  gatewayClient.getSandbox = async () => ({
    ...(await Promise.resolve({
      name: sandboxName,
      workspace: "oce-cutover",
      labels: {},
      annotations: {
        "openclaw.dev/namespace-id": namespace.id,
        "openclaw.dev/agent-id": revision.agentId,
        "openclaw.dev/revision-id": revision.id,
      },
      resourceVersion: "4",
      serviceUrls: {},
      spec: { policy },
    })),
  });
  await driver.applyNetworkPolicy(
    { namespace, revision, signal: AbortSignal.timeout(5_000), kubernetes: {} } as never,
    {
      snapshot: {
        driverId: driver.id,
        implementation: driver.implementation,
        version: 1,
        defaults: {},
        additions: [
          {
            id: "docs",
            binary: "/usr/bin/curl",
            host: "docs.example.test",
            ports: [{ from: 443, to: 443 }],
          },
        ],
      },
      expectedProviderVersion: "4",
      operationId: "cutover-edit",
    },
  );
  assert.equal(updated.length, 1);
  const written = JSON.stringify(policy);
  assert.match(written, /\/v2\/\*\*/);
  assert.equal(written.includes('"/v2/*"'), false);
  assert.match(written, /docs\.example\.test/);
});

test("widened grants stop unbound, uncatalogued, and withdrawn requests before upstream", () => {
  const upstream: string[] = [];
  const trace = (label: string, path: string, bindingId?: string, scope?: GoogleRequestScope) => {
    const admitted =
      scope === undefined ? false : allowsPluginRequest(httpRequest(scope, path, bindingId));
    if (admitted) {
      upstream.push(path);
    }
    return { label, path, guard: admitted ? "allow" : "deny", upstream: [...upstream] };
  };
  const account = trace("expanded resource", "/v2/accounts/pub-1", undefined, adsenseScope);
  const children = trace(
    "colon-suffixed resource",
    "/v2/accounts/pub-1:listChildAccounts",
    undefined,
    adsenseScope,
  );
  const uncatalogued = trace(
    "uncatalogued",
    "/v2/not-a-catalog-operation",
    undefined,
    adsenseScope,
  );
  const unbound = trace("unbound worker", "/v2/accounts/pub-1", "0".repeat(64), adsenseScope);
  const withdrawn = trace("withdrawn account", "/v2/accounts/pub-1");
  assert.equal(account.guard, "allow");
  assert.equal(children.guard, "allow");
  assert.equal(uncatalogued.guard, "deny");
  assert.equal(unbound.guard, "deny");
  assert.equal(withdrawn.guard, "deny");
  assert.deepEqual(upstream, ["/v2/accounts/pub-1", "/v2/accounts/pub-1:listChildAccounts"]);
  console.log(JSON.stringify({ account, children, uncatalogued, unbound, withdrawn }));
});
