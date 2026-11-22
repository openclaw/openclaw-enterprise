import {
  registerPredecessorStopRecoveryCases,
  registerQueueLeaseRecoveryCases,
} from "./postgres-queue-lease-recovery-cases.ts";
import { registerRepositoryCleanupAuthorityCases } from "./postgres-repository-cleanup-authority-cases.ts";
import { registerRepositoryCleanupTransferCases } from "./postgres-repository-cleanup-transfer-cases.ts";

registerQueueLeaseRecoveryCases();
registerRepositoryCleanupTransferCases();
registerRepositoryCleanupAuthorityCases();
registerPredecessorStopRecoveryCases();
