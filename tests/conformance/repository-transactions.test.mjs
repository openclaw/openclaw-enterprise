import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { verifyRepositoryLifetime } from "./repository-lifetime.contract.mjs";

test("memory repository lifetime and atomicity", async (t) => {
  const store = new InMemoryPlatformState();
  await store.transact((unit) =>
    unit.installations.createInstallation({
      id: `ins_${randomUUID()}`,
      name: "Repository tests",
      createdAt: new Date().toISOString(),
    }),
  );
  await verifyRepositoryLifetime(t, store);
});
