import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type {
  CredentialSource,
  Namespace,
  Preset,
  Secret,
  ServiceAccount,
} from "../../packages/contracts/src/index.ts";
import type { PlatformStateStore, PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import {
  NAMESPACE_NAME_CONFLICT,
  PRESET_NAME_CONFLICT,
  SECRET_NAME_CONFLICT,
  SERVICE_ACCOUNT_NAME_CONFLICT,
} from "../helpers/refusal-text.mjs";
import { identifier } from "./platform-state-contract-fixture.ts";

// A duplicate caller-chosen name is a ResourceStateConflictError whose message names the
// taken kind, alike in both adapters; a server-generated identity collision stays generic.
export async function verifyDuplicateNameContract(store: PlatformStateStore) {
  const createdAt = new Date().toISOString();
  const namespace: Namespace = {
    id: identifier("ns"),
    name: "Duplicate names " + randomUUID(),
    status: "ready",
    createdAt,
  };
  const secret: Secret = {
    id: identifier("sec"),
    namespaceId: namespace.id,
    name: "Taken secret " + randomUUID(),
    driverId: "secret-contract",
    backendRef: {
      namespaceName: "contract",
      name: "duplicate-names",
      key: "value",
      uid: randomUUID(),
    },
    createdAt,
  };
  const presetFor = (name: string): Preset => ({
    id: identifier("pre"),
    namespaceId: namespace.id,
    name: name + " " + randomUUID(),
    createdAt,
    template: {
      variables: {},
      agent: { name: "Assistant", executionMode: "embedded" },
      configuration: { values: {} },
    },
  });
  const preset = presetFor("Taken preset");
  const otherPreset = presetFor("Other preset");
  const account: ServiceAccount = {
    id: identifier("sa"),
    namespaceId: namespace.id,
    name: "Taken account " + randomUUID(),
  };
  const source: CredentialSource = {
    id: identifier("cs"),
    namespaceId: namespace.id,
    name: "Taken source " + randomUUID(),
    type: "openai",
    config: { base_url: "https://api.openai.com/v1" },
    secrets: {},
    ownerCapability: "credential_gateway",
    driverId: "credential-gateway-contract",
    state: "ready",
    createdAt,
  };

  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(namespace);
    await transaction.secrets.createSecret(secret);
    await transaction.presets.createPreset(preset);
    await transaction.presets.createPreset(otherPreset);
    await transaction.serviceAccounts.createServiceAccount(account);
    await transaction.credentialSources.createCredentialSource(source);
  });
  // Preset summaries list the same Presets in the same order, without their templates.
  await store.read(async (state) => {
    const summaries = await state.presets.listPresetSummaries(namespace.id);
    assert.deepEqual(
      summaries,
      (await state.presets.listPresets(namespace.id)).map(
        ({ id, namespaceId, name, createdAt }) => ({
          id,
          namespaceId,
          name,
          createdAt,
        }),
      ),
    );
    assert.equal(summaries.length, 2);
    assert.deepEqual(await state.presets.listPresetSummaries(identifier("ns")), []);
  });

  const conflicts: [
    write: (transaction: PlatformUnitOfWork) => Promise<unknown>,
    message: string,
  ][] = [
    [
      (transaction) =>
        transaction.namespaces.createNamespace({ ...namespace, id: identifier("ns") }),
      NAMESPACE_NAME_CONFLICT,
    ],
    [
      (transaction) => transaction.secrets.createSecret({ ...secret, id: identifier("sec") }),
      SECRET_NAME_CONFLICT,
    ],
    [
      (transaction) => transaction.presets.createPreset({ ...preset, id: identifier("pre") }),
      PRESET_NAME_CONFLICT,
    ],
    [
      (transaction) =>
        transaction.presets.updatePreset(namespace.id, otherPreset.id, { name: preset.name }),
      PRESET_NAME_CONFLICT,
    ],
    [
      (transaction) =>
        transaction.serviceAccounts.createServiceAccount({ ...account, id: identifier("sa") }),
      SERVICE_ACCOUNT_NAME_CONFLICT,
    ],
    [
      (transaction) =>
        transaction.credentialSources.createCredentialSource({ ...source, id: identifier("cs") }),
      "A credential source with this name already exists in this Namespace. Choose a different name.",
    ],
  ];
  for (const [write, message] of conflicts) {
    await assert.rejects(store.transact(write), { name: "ResourceStateConflictError", message });
  }

  // The server chose the identity, so its collision keeps the generic conflict.
  await assert.rejects(
    store.transact((transaction) =>
      transaction.secrets.createSecret({ ...secret, name: "Fresh secret " + randomUUID() }),
    ),
    { name: "ResourceConflictError" },
  );
}

// Names hold up to 200 characters counted as code points, as the API contract and
// PostgreSQL char_length count them: a name of astral characters (two UTF-16 code units
// each) is accepted at 200 by both adapters, and a Secret, ServiceAccount or credential
// source name is refused at 201 (the memory adapter has no Preset name length check).
export async function verifyNameLengthContract(store: PlatformStateStore) {
  const createdAt = new Date().toISOString();
  // 190 emoji and a 10-character unique suffix: 200 code points, 390 UTF-16 code units.
  const nameOf = (count: number) => "\u{1F600}".repeat(count) + randomUUID().slice(0, 10);
  const namespace: Namespace = {
    id: identifier("ns"),
    name: nameOf(190),
    status: "ready",
    createdAt,
  };
  const secret = (name: string): Secret => ({
    id: identifier("sec"),
    namespaceId: namespace.id,
    name,
    driverId: "secret-contract",
    backendRef: { namespaceName: "contract", name: "long-names", key: "value", uid: randomUUID() },
    createdAt,
  });
  const account = (name: string): ServiceAccount => ({
    id: identifier("sa"),
    namespaceId: namespace.id,
    name,
  });
  const source = (name: string): CredentialSource => ({
    id: identifier("cs"),
    namespaceId: namespace.id,
    name,
    type: "openai",
    config: { base_url: "https://api.openai.com/v1" },
    secrets: {},
    ownerCapability: "credential_gateway",
    driverId: "credential-gateway-contract",
    state: "ready",
    createdAt,
  });
  const preset = (name: string): Preset => ({
    id: identifier("pre"),
    namespaceId: namespace.id,
    name,
    createdAt,
    template: { variables: {}, configuration: { values: {} } },
  });
  const accepted = {
    secret: secret(nameOf(190)),
    account: account(nameOf(190)),
    source: source(nameOf(190)),
    preset: preset(nameOf(190)),
  };
  await store.transact(async (transaction) => {
    await transaction.namespaces.createNamespace(namespace);
    await transaction.secrets.createSecret(accepted.secret);
    await transaction.serviceAccounts.createServiceAccount(accepted.account);
    await transaction.credentialSources.createCredentialSource(accepted.source);
    await transaction.presets.createPreset(accepted.preset);
  });
  await store.read(async (transaction) => {
    assert.equal(
      (await transaction.secrets.findSecret(namespace.id, accepted.secret.id))?.name,
      accepted.secret.name,
    );
    assert.equal(
      (await transaction.serviceAccounts.findServiceAccount(namespace.id, accepted.account.id))
        ?.name,
      accepted.account.name,
    );
    assert.equal(
      (await transaction.credentialSources.findCredentialSource(namespace.id, accepted.source.id))
        ?.name,
      accepted.source.name,
    );
    assert.equal(
      (await transaction.presets.findPreset(namespace.id, accepted.preset.id))?.name,
      accepted.preset.name,
    );
  });

  const writes: ((transaction: PlatformUnitOfWork) => Promise<unknown>)[] = [
    (transaction) => transaction.secrets.createSecret(secret(nameOf(191))),
    (transaction) => transaction.serviceAccounts.createServiceAccount(account(nameOf(191))),
    (transaction) => transaction.credentialSources.createCredentialSource(source(nameOf(191))),
  ];
  for (const write of writes) {
    await assert.rejects(store.transact(write), { name: "ScopeViolationError" });
  }
}
