import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import type { OpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { OpenShellSandboxDriverOptions } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  ConfigurationValidationError,
  type OpenShellBackendConfiguration,
} from "../../packages/contracts/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";

type RefusalDetail = ConfigurationValidationError["error"]["details"][number];

export function openShellWorkspaceHarnessConfiguration() {
  const configuration = {
    integrationMode: "legacy" as NonNullable<OpenShellSandboxDriverOptions["integrationMode"]>,
    gateway: {},
    kubernetes: {
      userNamespaces: false,
      serviceAccount: {
        mode: "gatewayConfigured",
      } satisfies OpenShellSandboxDriverOptions["kubernetes"]["serviceAccount"],
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
  };
  return configuration satisfies OpenShellSandboxDriverOptions;
}

export function buildSandboxInstallation() {
  const base = createInstallationDriverConfiguration();
  return {
    ...base,
    backend: [
      {
        id: "openshell",
        type: "openshell",
        configuration: {
          serviceName: "openshell-gateway",
          port: 50051,
          insecureTransport: "network-policy",
        } satisfies OpenShellBackendConfiguration,
        drivers: { sandbox: "openshell-sandbox" },
      },
    ],
    drivers: {
      ...base.drivers,
      compute: {
        ...base.drivers.compute,
        configuration: {
          ...base.drivers.compute.configuration,
          servicePrincipalCredentials: { mode: "disabled" },
        },
      },
      sandbox: {
        id: "openshell-sandbox",
        configuration: openShellWorkspaceHarnessConfiguration(),
      },
    },
  };
}

// Exercise the production Installation loader and selected Compute with controlled external SDK transports.
export async function loadSelectedOpenShellAgentInstallation(
  t: TestContext,
  {
    installation,
    computeId,
    tokenServiceId,
    core,
    gatewayClient,
  }: {
    installation: ReturnType<typeof buildSandboxInstallation>;
    computeId: string;
    tokenServiceId: string;
    core: object;
    gatewayClient: OpenShellGatewayClient;
  },
) {
  Object.assign(installation.drivers, {
    token_service: { id: tokenServiceId, configuration: {} },
  });
  installation.drivers.compute.id = computeId;
  Reflect.deleteProperty(installation.drivers.compute.configuration.network, "gatewayClients");
  Object.assign(installation.drivers.compute.configuration, {
    gatewayRouting: {
      hostname: "agents.example.test",
      gatewayName: "gateways",
      gatewayNamespace: "occ-system",
      envoyNamespace: "envoy",
    },
  });
  const runtime = await loadInstallationFile(t, installation, {
    createOpenShellBackend: (definition) => createOpenShellBackend(definition, { gatewayClient }),
  });
  assert.ok(runtime);
  // The loader constructs Compute itself and does not expose an SDK factory; inject only its cached transport.
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
        version: {
          async getCode() {
            return { gitVersion: "v1.35.0" };
          },
        },
      }),
    ),
  );
  return runtime;
}

export function buildEndpointInstallation(endpoint: string) {
  const configuration = buildSandboxInstallation();
  const [backend] = configuration.backend;
  assert.ok(backend);
  return {
    ...configuration,
    backend: [
      {
        ...backend,
        configuration: {
          endpoint,
          insecureTransport: "network-policy",
        } satisfies OpenShellBackendConfiguration,
      },
    ],
  };
}

export function makeStructuralRefusal(
  path: string,
  keyword: string,
  code: RefusalDetail["code"] = "INVALID_VALUE",
): RefusalDetail[] {
  return [{ path, code, message: `Configuration does not satisfy ${keyword}.` }];
}

export async function assertStartupRefusal(
  testContext: TestContext,
  configuration: unknown,
  expected: RegExp | readonly RefusalDetail[],
): Promise<void> {
  if (expected instanceof RegExp) {
    await assert.rejects(loadInstallationFile(testContext, configuration), expected);
    return;
  }
  await assert.rejects(loadInstallationFile(testContext, configuration), (error: unknown) => {
    assert.ok(error instanceof ConfigurationValidationError);
    assert.deepEqual(error.error.details, expected);
    return true;
  });
}
