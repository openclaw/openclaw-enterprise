import assert from "node:assert/strict";
import type {
  Agent,
  ComputeDriver,
  ConfigurationReference,
  OpenClawConfigurationDocument,
  PermissionAction,
  ResourceRef,
  ResourceKind,
} from "@openclaw-enterprise/contracts";
import { NativeIAMDriver, type NativeIAMState } from "../../packages/iam/src/index.ts";
import {
  InMemoryPlatformState,
  OpenClawController,
  type ControllerOptions,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import {
  createDevelopmentComputeDriver,
  registerAndSelectDrivers,
} from "../helpers/development.ts";
import { bindRole, grantRole, principalIAMState } from "../helpers/iam-grants.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";

export const administrator = "principal-configuration-administrator";
export const deployOnly = "principal-configuration-deploy-only";
export const installation = Object.freeze({
  id: "installation-configuration-occ",
  name: "Configuration OCC conformance",
  createdAt: "2026-08-19T00:00:00.000Z",
});

type MutableNativeIAMState = {
  [Key in keyof NativeIAMState]: Array<NativeIAMState[Key][number]>;
};

export function grantFixtureRole(
  state: MutableNativeIAMState,
  principalId: string,
  options: {
    id: string;
    bindingId?: string;
    permissions: Partial<Record<ResourceKind, PermissionAction[]>>;
    resource?: ResourceRef;
  },
): void {
  grantRole(state, principalId, { ...options, namespaceId: undefined, resource: options.resource });
}

export async function fixture(options: ControllerOptions = {}) {
  const iamState: MutableNativeIAMState = principalIAMState(
    [administrator, deployOnly],
    "configuration-conformance",
  );
  grantFixtureRole(iamState, administrator, {
    id: "configuration-administrator-role",
    bindingId: "configuration-administrator-binding",
    permissions: {
      secret: ["create", "operate"],
      namespace: ["create", "read", "delete"],
      configuration: ["create", "read", "update", "delete"],
      agent: ["create", "read", "update", "deploy"],
      agent_revision: ["read"],
      installation: ["read"],
    },
  });
  grantFixtureRole(iamState, deployOnly, {
    id: "configuration-deploy-only-role",
    bindingId: "configuration-deploy-only-binding",
    permissions: { agent: ["deploy"], secret: ["operate"] },
  });
  const iam = new NativeIAMDriver(
    { loadNativeIAMState: async () => iamState },
    { id: "configuration-occ-iam" },
  );
  const compute: ComputeDriver = {
    ...createDevelopmentComputeDriver(),
    id: "configuration-occ-compute",
    implementation: "configuration-conformance-compute",
  };
  const configurationDriver = createTestConfigurationDriver();
  const state = new InMemoryPlatformState();
  const controller = new OpenClawController(installation, { state, ...options });
  const secretDriver = createTestSecretDriver();
  registerAndSelectDrivers(controller, [iam, compute, configurationDriver, secretDriver]);
  const namespace = await controller.createNamespace(administrator, {
    name: "Configuration conformance tenant",
  });
  const configuration = await controller.createConfiguration(administrator, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "store", provider: "teamstore", id: "OPENAI_API_KEY" },
          },
        },
      },
      secrets: {
        providers: { teamstore: { source: "store" } },
        defaults: { store: "teamstore" },
      },
      agents: { defaults: { sandbox: { scope: "agent" } } },
      plugins: { entries: { example: { enabled: true, regions: ["west"], retryCount: 2 } } },
    },
  });
  let agent = await controller.createAgent(administrator, {
    namespaceId: namespace.id,
    name: "Configuration conformance agent",
    configurationId: configuration.id,
  });
  await controller.transact((transaction) =>
    transaction.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );

  const secret = await controller.createSecret(administrator, {
    namespaceId: namespace.id,
    name: "harness-key",
    value: "synthetic-harness-key",
  });
  async function bindHarnessAuth(target: Readonly<Agent>) {
    iamState.identities.push({
      kind: "service_principal",
      id: target.servicePrincipalId,
      namespaceId: target.namespaceId,
      agentId: target.id,
    });
    iamState.roles.push({
      id: `harness-role-${target.id}`,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    bindRole(iamState, target.servicePrincipalId, {
      id: `harness-binding-${target.id}`,
      roleId: `harness-role-${target.id}`,
      namespaceId: namespace.id,
      resource: { kind: "secret", id: secret.id },
    });
    return controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: target.id,
      configurationId: target.configurationId,
      harnessAuth: { method: "api_key", source: secret.ref },
    });
  }
  agent = await bindHarnessAuth(agent);
  return {
    agent,
    bindHarnessAuth,
    compute,
    configuration,
    configurationDriver,
    controller,
    iam,
    iamState,
    namespace,
    state,
    saveConfiguration: (values: OpenClawConfigurationDocument) =>
      controller.createConfiguration(administrator, {
        namespaceId: namespace.id,
        kind: "agent",
        values,
      }),
    replaceStoredValues: async (
      configuration: ConfigurationReference,
      values: OpenClawConfigurationDocument,
    ) => {
      const stored = configurationDriver.stored(configuration);
      assert.ok(stored);
      await configurationDriver.update({ ...stored, values });
    },
  };
}
