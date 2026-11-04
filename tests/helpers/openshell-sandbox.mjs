import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";

/** A real OpenShell Sandbox Driver whose Kubernetes settings `overrides` overrides (an
 * undefined value removes the setting), with extra `gateway` settings. */
export function openShellSandbox(t, overrides = {}, gateway = {}) {
  const kubernetes = {
    runtimeClassName: "openshell-sandbox",
    // Native OpenClaw workspace preparation requires it.
    userNamespaces: false,
    serviceAccount: { mode: "gatewayConfigured" },
    sandboxDataMount: { subPath: "workspace", mountPath: "/sandbox/enterprise", readOnly: false },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete kubernetes[key];
    } else {
      kubernetes[key] = value;
    }
  }
  const definition = {
    id: "workspace-openshell",
    type: "openshell",
    configuration: { endpoint: "http://127.0.0.1:9", insecureTransport: "network-policy" },
    drivers: {
      sandbox: "workspace-openshell-sandbox",
      credential_gateway: "workspace-openshell-credentials",
    },
  };
  const backend = createOpenShellBackend(definition);
  t.after(() => backend.client.close());
  const sandboxDriver = new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator", ...gateway },
      kubernetes,
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model-egress",
            endpoints: [{ host: "api.openai.com", ports: [443] }],
            binaries: [{ path: "/usr/local/bin/node" }],
          },
        ],
      },
    },
    { id: "workspace-openshell-sandbox", backend },
  );
  return {
    sandboxDriver,
    driverConfigurations: [
      {
        capability: "sandbox",
        driverId: sandboxDriver.id,
        implementation: sandboxDriver.implementation,
        definition: OpenShellSandboxDriver,
      },
    ],
  };
}
