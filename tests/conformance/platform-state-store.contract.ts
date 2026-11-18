import type { Installation } from "@openclaw-enterprise/contracts";
import type { PlatformStateStore } from "../../packages/occ/src/index.ts";
import { verifyDeletedResourceAccessBindingContract } from "./platform-state-access-binding-contract.ts";
import { seedPlatformState } from "./platform-state-contract-fixture.ts";
import { verifyCredentialSourceContract } from "./platform-state-credential-source-contract.ts";
import { verifyEgressSendReceiptContract } from "./platform-state-egress-receipt-contract.ts";
import { verifyPlatformStateLifecycle } from "./platform-state-lifecycle-contract.ts";
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
  const lifecycle = await verifyPlatformStateLifecycle(store, seed);

  await verifyCredentialSourceContract(store, {
    namespace: seed.namespace,
    harnessSecret: seed.harnessSecret,
    accountNamespace: lifecycle.accountNamespace,
    accountConfiguration: lifecycle.accountConfiguration,
    accountAgent: lifecycle.accountAgent,
    revision: seed.revision,
  });
  await verifyEgressSendReceiptContract(
    store,
    seed.installation,
    seed.namespace,
    seed.harnessSecret,
  );
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
    serviceAccountRevision: lifecycle.serviceAccountRevision,
    lifecycleNamespace: lifecycle.lifecycleNamespace,
    deletedAt: lifecycle.deletedAt,
  };
}
