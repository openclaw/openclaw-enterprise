import {
  registerInitialTransactionOutcomeCases,
  registerCommitCleanupOutcomeCases,
} from "./postgres-transaction-commit-outcome-cases.ts";
import {
  registerTransactionClientCases,
  registerProxyAndReadCases,
} from "./postgres-transaction-client-cases.ts";

registerInitialTransactionOutcomeCases();
registerTransactionClientCases();
registerCommitCleanupOutcomeCases();
registerProxyAndReadCases();
