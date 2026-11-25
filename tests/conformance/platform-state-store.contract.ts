import { randomUUID } from "node:crypto";

import type { Installation } from "@openclaw-enterprise/contracts";
import type { PlatformStateStore } from "../../packages/occ/src/index.ts";
import { verifyDeletedResourceAccessBindingContract } from "./platform-state-access-binding-contract.ts";
import { seedPlatformState } from "./platform-state-contract-fixture.ts";
import { verifyCredentialSourceContract } from "./platform-state-credential-source-contract.ts";
import { verifyPlatformStateLifecycle } from "./platform-state-lifecycle-contract.ts";
import { verifyStandaloneCredentialStateContract } from "./platform-state-standalone-credential-contract.ts";
import {
  verifyDuplicateNameContract,
  verifyNameLengthContract,
} from "./platform-state-name-contract.ts";
import { verifyPlatformStateTransactions } from "./platform-state-transaction-contract.ts";

export async function verifyPlatformStateStoreContract(
  store: PlatformStateStore,
  options: { installation?: Readonly<Installation> } = {},
) {
  const seed = await seedPlatformState(store, options.installation);
  await verifyPlatformStateTransactions(store, seed);
  await verifyStandaloneCredentialStateContract(store, seed);
  const instance = await store.transact((transaction) =>
    transaction.installations.selectTokenServiceInstance({
      id: randomUUID(),
      driverId: "platform-state-token-service",
      storeIdentity: "platform-state-contract",
    }),
  );
  const lifecycle = await verifyPlatformStateLifecycle(store, seed, instance.id);
  await verifyCredentialSourceContract(store, seed, instance.id);
  await verifyDeletedResourceAccessBindingContract(store, seed.revision);
  await verifyDuplicateNameContract(store);
  await verifyNameLengthContract(store);

  return {
    installation: seed.installation,
    namespace: seed.namespace,
    agent: seed.agent,
    configuration: seed.configuration,
    revision: seed.revision,
    audit: seed.audit,
    operation: seed.operation,
    lifecycleAgent: lifecycle.lifecycleAgent,
    serviceAccount: lifecycle.serviceAccount,
    serviceAccountNamespace: lifecycle.accountNamespace,
    lifecycleNamespace: lifecycle.lifecycleNamespace,
    deletedAt: lifecycle.deletedAt,
  };
}
