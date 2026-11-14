import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { OpenShellSandboxDriverOptions } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  ConfigurationValidationError,
  type OpenShellBackendConfiguration,
} from "../../packages/contracts/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.ts";

type RefusalDetail = ConfigurationValidationError["error"]["details"][number];

export function openShellWorkspaceHarnessConfiguration() {
  const gateway: { workspaceMode: OpenShellSandboxDriverOptions["gateway"]["workspaceMode"] } = {
    workspaceMode: "operator",
  };
  const configuration = {
    gateway,
    kubernetes: {
      runtimeClassName: "openshell-sandbox",
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
        drivers: { sandbox: "openshell-sandbox", credential_gateway: "openshell-credentials" },
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
      credential_gateway: {
        id: "openshell-credentials",
        configuration: { binaries: ["/app/bin/model-client"] },
      },
      sandbox: {
        id: "openshell-sandbox",
        configuration: openShellWorkspaceHarnessConfiguration(),
      },
    },
  };
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
