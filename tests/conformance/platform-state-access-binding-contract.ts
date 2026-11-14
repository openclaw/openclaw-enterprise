import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type {
  AccessBinding,
  AgentRevision,
  CredentialSource,
  Namespace,
  Preset,
  ResourceKind,
  Role,
  Secret,
  ServiceAccount,
  ServicePrincipal,
} from "../../packages/contracts/src/index.ts";
import type { PlatformStateStore, PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { identifier } from "./platform-state-contract-fixture.ts";

type ConfigurationInput = Parameters<
  PlatformUnitOfWork["configurations"]["createConfiguration"]
>[0];

// Deleting a Configuration, Preset, Secret, credential source or ServiceAccount
// removes the AccessBindings that grant on it, so none outlives its target or
// keeps the Role it references from being deleted.
export async function verifyDeletedResourceAccessBindingContract(
  store: PlatformStateStore,
  revision: Readonly<AgentRevision>,
) {
  const createdAt = new Date().toISOString();
  const namespace: Namespace = {
    id: identifier("ns"),
    name: "Binding cleanup " + randomUUID(),
    status: "ready",
    createdAt,
  };
  const secretFor = (name: string): Secret => ({
    id: identifier("sec"),
    namespaceId: namespace.id,
    name: name + " " + randomUUID(),
    driverId: "secret-contract",
    backendRef: {
      namespaceName: "contract",
      name: "binding-cleanup",
      key: "value",
      uid: randomUUID(),
    },
    createdAt,
  });
  const configurationFor = (): ConfigurationInput => ({
    id: identifier("cfg"),
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt,
  });
  const agentConfiguration = configurationFor();
  const agentSecret = secretFor("Agent key");
  const agent = {
    id: identifier("agt"),
    namespaceId: namespace.id,
    name: "Binding subject " + randomUUID(),
    configurationId: agentConfiguration.id,
    backendId: null,
    harnessAuth: {
      method: "api_key",
      source: { kind: "secret", namespaceId: namespace.id, id: agentSecret.id },
    },
    executionMode: "embedded",
    servicePrincipalId: identifier("service-agent"),
    desiredRuntimeState: "stopped",
    status: "active",
    createdAt,
  } satisfies Parameters<PlatformUnitOfWork["agents"]["createAgent"]>[0];
  const secret = secretFor("Bound secret");
  const configuration: ConfigurationInput = {
    ...configurationFor(),
    secretBindings: {
      SLACK_BOT_TOKEN: { source: { kind: "secret", namespaceId: namespace.id, id: secret.id } },
    },
  };
  const secondConfiguration = { ...configuration, ...configurationFor() };
  const configurationIds = [configuration.id, secondConfiguration.id].sort();
  const preset: Preset = {
    id: identifier("pre"),
    namespaceId: namespace.id,
    name: "Bound preset " + randomUUID(),
    createdAt,
    template: {
      variables: {},
      agent: { name: "Assistant", executionMode: "embedded" },
      configuration: { values: {} },
    },
  };
  const source: CredentialSource = {
    id: identifier("cs"),
    namespaceId: namespace.id,
    name: "Bound source " + randomUUID(),
    type: "openai",
    config: { base_url: "https://api.openai.com/v1" },
    secrets: { api_key: { kind: "secret", namespaceId: namespace.id, id: secret.id } },
    ownerCapability: "credential_gateway",
    driverId: "credential-gateway-contract",
    state: "ready",
    createdAt,
  };
  const account: ServiceAccount = {
    id: identifier("sa"),
    namespaceId: namespace.id,
    name: "Bound " + randomUUID(),
  };
  const role: Role = {
    id: identifier("role"),
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "configuration" }],
  };
  const bindingOn = (resourceKind: ResourceKind, resourceId: string): AccessBinding => ({
    id: identifier("binding"),
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind,
    resourceId,
  });
  const surviving = bindingOn("configuration", agentConfiguration.id);

  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(namespace);
    await transaction.configurations.createConfiguration(agentConfiguration);
    await transaction.secrets.createSecret(agentSecret);
    await transaction.secrets.createSecret(secret);
    await transaction.configurations.createConfiguration(configuration);
    await transaction.configurations.createConfiguration(secondConfiguration);
    await transaction.agents.createAgent(agent);
    await transaction.revisions.createRevision({
      ...revision,
      id: identifier("rev"),
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agentConfiguration.id,
      servicePrincipalId: agent.servicePrincipalId,
      harnessAuth: { ...agent.harnessAuth, secretDriverId: agentSecret.driverId },
    });
    await transaction.presets.createPreset(preset);
    await transaction.credentialSources.createCredentialSource(source);
    await transaction.serviceAccounts.createServiceAccount(account);
    await transaction.iamPolicy.createRole(role);
    for (const binding of [
      bindingOn("configuration", configuration.id),
      bindingOn("preset", preset.id),
      bindingOn("secret", secret.id),
      bindingOn("credential_source", source.id),
      bindingOn("service_account", account.id),
      surviving,
    ]) {
      await transaction.iamPolicy.createAccessBinding(binding);
    }
  });

  // Each reference comes back once, ordered by kind then ID; a full page says more exist.
  const references = [
    ...configurationIds.map((id) => ({ kind: "configuration", id })),
    { kind: "credential_source", id: source.id },
  ];
  await store.read(async (state) => {
    assert.deepEqual(await state.secrets.listReferences(namespace.id, secret.id, 50), {
      references,
      truncated: false,
    });
    // A page that holds exactly every reference is not truncated.
    assert.deepEqual(await state.secrets.listReferences(namespace.id, secret.id, 3), {
      references,
      truncated: false,
    });
    assert.deepEqual(await state.secrets.listReferences(namespace.id, secret.id, 1), {
      references: [references[0]],
      truncated: true,
    });
    assert.deepEqual(await state.secrets.listReferences(namespace.id, agentSecret.id, 50), {
      references: [{ kind: "agent", id: agent.id }],
      truncated: false,
    });
  });

  // The credential source and the Configuration reference the Secret, so they go first.
  await store.transact(async (transaction) => {
    assert.equal(
      await transaction.credentialSources.deleteCredentialSource(namespace.id, source.id),
      true,
    );
    for (const id of configurationIds) {
      assert.equal(await transaction.configurations.deleteConfiguration(namespace.id, id), true);
    }
    assert.equal(await transaction.secrets.deleteSecret(namespace.id, secret.id), true);
    assert.equal(await transaction.presets.deletePreset(namespace.id, preset.id), true);
    assert.equal(
      await transaction.serviceAccounts.deleteServiceAccount(namespace.id, account.id),
      true,
    );
  });

  await store.read(async (state) => {
    assert.deepEqual(await state.iamPolicy.listAccessBindings(namespace.id), [surviving]);
  });
  // Only the binding on a live resource still holds the Role.
  await assert.rejects(
    store.transact((transaction) => transaction.iamPolicy.deleteRole(namespace.id, role.id)),
    /referenced by AccessBindings/,
  );
  await store.transact(async (transaction) => {
    assert.equal(await transaction.iamPolicy.deleteAccessBinding(namespace.id, surviving.id), true);
    assert.equal(await transaction.iamPolicy.deleteRole(namespace.id, role.id), true);
  });

  // A Namespace ServicePrincipal is listed and read only in its own Namespace. The Agent's
  // own ServicePrincipal is not a Namespace ServicePrincipal, so it is never listed or read.
  const principal: ServicePrincipal = {
    kind: "service_principal",
    id: identifier("spn"),
    namespaceId: namespace.id,
  };
  await store.transact((transaction) => transaction.iamPolicy.createServicePrincipal(principal));
  const otherNamespaceId = identifier("ns");
  await store.read(async (state) => {
    assert.deepEqual(await state.iamPolicy.listServicePrincipals(namespace.id), [principal]);
    assert.deepEqual(
      await state.iamPolicy.getServicePrincipal(namespace.id, principal.id),
      principal,
    );
    assert.equal(
      await state.iamPolicy.getServicePrincipal(namespace.id, agent.servicePrincipalId),
      undefined,
    );
    assert.deepEqual(await state.iamPolicy.listServicePrincipals(otherNamespaceId), []);
    assert.equal(
      await state.iamPolicy.getServicePrincipal(otherNamespaceId, principal.id),
      undefined,
    );
  });
}
