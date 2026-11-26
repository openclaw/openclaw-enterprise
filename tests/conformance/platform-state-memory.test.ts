import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import {
  completeAgentDeletion,
  isolateRevisionHistory,
  refuseGrantsAfterDeletion,
  refuseInvalidBackendIds,
} from "./platform-state-memory-cases.ts";
import { verifyPlatformStateStoreContract } from "./platform-state-store.contract.ts";

test(
  "memory policy refuses new grants to an Agent after deletion admission",
  refuseGrantsAfterDeletion,
);
test(
  "memory Agent deletion completion removes the AccessBindings the PostgreSQL finalizer removes",
  completeAgentDeletion,
);
test("the memory platform state adapter satisfies the shared ownership and atomicity contract", async () => {
  await verifyPlatformStateStoreContract(new InMemoryPlatformState());
});
test(
  "memory revision histories stay isolated across committed and rolled-back appends",
  isolateRevisionHistory,
);
test(
  "memory state refuses an Agent backendId outside the API's Backend ID rule",
  refuseInvalidBackendIds,
);
