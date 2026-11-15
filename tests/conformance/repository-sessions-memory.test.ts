import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { verifyRepositorySessions } from "./repository-sessions.contract.mjs";

test("in-memory repository sessions preserve admission and transaction semantics", async (t) => {
  await verifyRepositorySessions(t, new InMemoryPlatformState());
});

import "./standing-approval-history-cases.ts";
