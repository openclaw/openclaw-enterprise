import assert from "node:assert/strict";
import test from "node:test";

import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { seedInventoryAgent } from "../helpers/postgres-inventory-agent.ts";

test(
  "deployment inventory refuses a settled revision row with an empty actor",
  requiresPostgres,
  async (t) => {
    const { appendHistory, inject } = await seedInventoryAgent(t, "inventory-empty-actor");
    const inventoryPath = "/installation/deployment-inventory";
    assert.equal((await inject("GET", inventoryPath)).statusCode, 200);

    // PostgreSQL permits an empty actor, but the work decoder refuses it, so the inventory
    // must refuse rather than treat the finished row as settled history.
    await appendHistory(1, 1, "failed_permanent", "reconcile", "");
    const refused = await inject("GET", inventoryPath);
    assert.equal(refused.statusCode, 503, refused.body);
  },
);
