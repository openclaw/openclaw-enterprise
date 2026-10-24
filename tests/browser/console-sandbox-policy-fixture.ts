import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { SandboxNetworkGrant } from "../../packages/contracts/src/sandbox-policy.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

export async function createPolicyConsole(t: TestContext, ceiling: SandboxNetworkGrant[] = []) {
  const sandboxDriver = new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
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
            name: "python-default",
            binaries: [{ path: "/usr/bin/python3.11" }],
            endpoints: [{ host: "example.com", ports: [443], tls: "skip" }],
          },
        ],
      },
    },
    {
      id: "policy-openshell",
      implementation: "openshell",
      backend: {
        id: "openshell",
        drivers: { sandbox: "policy-openshell", credential_gateway: "policy-credentials" },
        client: new OpenShellGateway({ serviceName: "openshell-gateway" }),
      },
    },
  );
  const fixture = await createConsoleAppFixture(t, {
    sandboxDriver,
    sandboxNetworkPolicyCeiling: ceiling,
    driverConfigurations: [
      {
        capability: "sandbox",
        driverId: sandboxDriver.id,
        implementation: sandboxDriver.implementation,
        definition: OpenShellSandboxDriver,
      },
    ],
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Policy rejection", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Policy rejection",
    createHarnessConfiguration("codex", "gpt-5.1"),
    { executionMode: "dedicated" },
  );
  const base = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
  assert.equal(
    (await fixture.request("PATCH", `${base}/editing`, { body: { enabled: true } })).status,
    200,
  );
  return { fixture, namespace, agent, base };
}
