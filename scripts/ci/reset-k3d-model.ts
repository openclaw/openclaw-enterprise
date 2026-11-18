#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanupResourceIds } from "./cleanup.ts";
import { withStateLock } from "./state-lock.ts";

function statePath(argv: readonly string[]) {
  const index = argv.indexOf("--state");
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--state is required.");
  }
  return resolve(value);
}

function resetDatabaseIds(state: unknown) {
  assert.ok(
    state &&
      typeof state === "object" &&
      "lane" in state &&
      (state.lane === "gateway-routing" || state.lane === "openshell"),
    "Reset requires owned gateway-routing or openshell state.",
  );
  assert.ok(
    "resources" in state && Array.isArray(state.resources),
    "Cleanup state resources must be an array.",
  );
  const resources: unknown[] = state.resources;
  const resourceIds = new Set<string>();
  const databaseIds: string[] = [];
  for (const resource of resources) {
    assert.ok(
      resource &&
        typeof resource === "object" &&
        "id" in resource &&
        typeof resource.id === "string" &&
        resource.id.length > 0 &&
        "kind" in resource &&
        typeof resource.kind === "string",
      "Cleanup state resources must have a string ID and kind.",
    );
    assert.ok(!resourceIds.has(resource.id), "Cleanup state resource IDs must be unique.");
    resourceIds.add(resource.id);
    if (resource.kind === "postgres-database") {
      databaseIds.push(resource.id);
    }
  }
  return databaseIds;
}

async function main() {
  const path = statePath(process.argv.slice(2));
  // Keep the resource IDs valid across the cleanup owner's journal reads.
  await withStateLock(path, async () => {
    const state: unknown = JSON.parse(await readFile(path, "utf8"));
    await cleanupResourceIds(path, resetDatabaseIds(state));
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
