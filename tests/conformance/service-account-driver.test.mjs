import assert from "node:assert/strict";
import test from "node:test";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  DriverSelectionError,
  OpenClawController,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

const administrator = "service-account-driver-administrator";
const reader = "service-account-driver-reader";
const installation = Object.freeze({
  id: "installation-service-account-driver",
  name: "ServiceAccount Driver OCC conformance",
  createdAt: "2026-08-24T00:00:00.000Z",
});
const backend = Object.freeze({
  id: "openai",
  type: "chatgpt",
  configuration: Object.freeze({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    apiKeyPath: "/unused-conformance-chatgpt-admin-key",
    credentialTtlSeconds: 3600,
  }),
  drivers: Object.freeze({ service_account: "service-account-driver-conformance" }),
});

async function fixture() {
  const administrators = {
    namespace: ["create", "read"],
    service_account: ["create", "read", "update", "delete"],
    configuration: ["create", "read"],
    agent: ["create", "read", "deploy"],
  };
  const iam = new NativeIAMDriver(
    {
      loadNativeIAMState: async () => ({
        identities: [administrator, reader].map((id) => ({
          kind: "principal",
          id,
          issuer: "service-account-driver-conformance",
          subject: id,
        })),
        groups: [],
        memberships: [],
        roles: [
          {
            id: "service-account-driver-administrator-role",
            permissions: Object.entries(administrators).flatMap(([resourceKind, actions]) =>
              actions.map((action) => ({ action, resourceKind })),
            ),
          },
          {
            id: "service-account-driver-reader-role",
            permissions: [{ action: "read", resourceKind: "service_account" }],
          },
        ],
        bindings: ["administrator", "reader"].map((kind) => ({
          id: `service-account-driver-${kind}-binding`,
          subjectKind: "identity",
          subjectId: kind === "administrator" ? administrator : reader,
          roleId: `service-account-driver-${kind}-role`,
        })),
        restrictions: [],
      }),
    },
    { id: "service-account-driver-iam" },
  );
  const controller = new OpenClawController(installation, { backends: [backend] });
  const compute = createDevelopmentComputeDriver();
  const configuration = createTestConfigurationDriver();
  const externalAccounts = new Set();
  const externalCredentials = new Set();
  const driver = {
    id: "service-account-driver-conformance",
    capability: "service_account",
    implementation: "occ-conformance-service-account",
    backendId: backend.id,
    async create(account) {
      externalAccounts.add(account.id);
      controller.registerRollback(async () => {
        externalAccounts.delete(account.id);
      });
    },
    async createCredential(account) {
      externalCredentials.add(account.id);
      controller.registerRollback(async () => {
        externalCredentials.delete(account.id);
      });
      return {
        kind: "access_token",
        secretRef: { name: `account-${account.id.slice(3)}`, key: "token" },
      };
    },
    async delete(account) {
      externalCredentials.delete(account.id);
      externalAccounts.delete(account.id);
    },
  };
  for (const selected of [iam, compute, configuration, driver]) {
    controller.registerDriver(selected);
    controller.selectDriver(selected.capability, selected.id);
  }
  const namespace = await controller.createNamespace(administrator, {
    name: "ServiceAccount Driver conformance tenant",
  });

  return { controller, driver, externalAccounts, externalCredentials, namespace };
}

test("a selected ServiceAccount Driver owns authorized account and credential lifecycle", async () => {
  const { controller, driver, externalAccounts, externalCredentials, namespace } = await fixture();

  assert.equal(controller.selectedDriver("service_account"), driver);
  assert.throws(
    () =>
      controller.registerDriver({
        id: "service-account-driver-invalid",
        capability: "service_account",
        implementation: "invalid",
        create: async () => {},
        delete: async () => {},
      }),
    DriverSelectionError,
  );
  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "backend-managed-account",
  });
  assert.equal(externalAccounts.has(account.id), true);

  // An exact account read grant cannot issue its credential or trigger Driver effects.
  await assert.rejects(
    controller.createServiceAccountCredential(reader, namespace.id, account.id),
    AuthorizationDeniedError,
  );
  assert.equal(externalCredentials.size, 0);

  const issued = await controller.createServiceAccountCredential(
    administrator,
    namespace.id,
    account.id,
  );
  assert.equal(issued.credential.kind, "access_token");
  assert.equal(externalCredentials.has(account.id), true);
  assert.deepEqual(
    await controller.getServiceAccount(administrator, namespace.id, account.id),
    issued,
  );
  await assert.rejects(
    controller.createServiceAccountCredential(administrator, namespace.id, account.id),
    ResourceConflictError,
  );
  await assert.rejects(
    controller.updateServiceAccountCredential(administrator, namespace.id, account.id, {
      kind: "api_key",
      secretRef: { name: "replacement-secret", key: "token" },
    }),
    ResourceConflictError,
  );

  await controller.deleteServiceAccount(administrator, namespace.id, account.id);
  assert.equal(externalAccounts.has(account.id), false);
  assert.equal(externalCredentials.has(account.id), false);
  await assert.rejects(
    controller.getServiceAccount(administrator, namespace.id, account.id),
    ScopeViolationError,
  );
});

test("outer transaction failure compensates selected Driver account and credential effects", async () => {
  const { controller, externalAccounts, externalCredentials, namespace } = await fixture();
  let abortedAccount;

  // HTTP audit append runs after the inner OCC mutation in this same outer transaction.
  await assert.rejects(
    controller.transact(async () => {
      abortedAccount = await controller.createServiceAccount(administrator, {
        namespaceId: namespace.id,
        name: "aborted-account",
      });
      throw new Error("transactional audit append failed");
    }),
    /transactional audit append failed/,
  );
  assert.equal(externalAccounts.has(abortedAccount.id), false);
  await assert.rejects(
    controller.getServiceAccount(administrator, namespace.id, abortedAccount.id),
    ScopeViolationError,
  );

  const account = await controller.createServiceAccount(administrator, {
    namespaceId: namespace.id,
    name: "aborted-credential",
  });
  await assert.rejects(
    controller.transact(async () => {
      await controller.createServiceAccountCredential(administrator, namespace.id, account.id);
      throw new Error("credential audit append failed");
    }),
    /credential audit append failed/,
  );
  assert.equal(externalAccounts.has(account.id), true);
  assert.equal(externalCredentials.has(account.id), false);
  assert.equal(
    (await controller.getServiceAccount(administrator, namespace.id, account.id)).credential,
    undefined,
  );
});

test("the ChatGPT account name is cut by whole characters, never half of a surrogate pair", async () => {
  const { ChatGPTServiceAccountDriver } =
    await import("../../apps/controller/src/drivers/service-account/chatgpt.ts");
  const names = [];
  const stop = new Error("stop after the provider call");
  const driver = new ChatGPTServiceAccountDriver(
    {
      id: "openai",
      drivers: { service_account: "chatgpt-service-accounts" },
      client: {
        async createServiceAccount({ name }) {
          names.push(name);
          throw stop;
        },
      },
    },
    {},
    {},
    {},
  );
  const id = "sa_11111111-1111-4111-8111-111111111111";
  // One ASCII character puts every emoji on an odd UTF-16 offset, so a 160-unit cut would
  // fall inside the last emoji that starts before it.
  const name = `x${"\u{1F600}".repeat(199)}`;
  await assert.rejects(driver.create({ id, namespaceId: "ns_x", name }), stop);
  const [sent] = names;
  assert.equal(sent, `x${"\u{1F600}".repeat(79)}-${id}`);
  assert.ok(sent.length <= 200);
  assert.doesNotMatch(sent, /\p{Cs}/u);
});
