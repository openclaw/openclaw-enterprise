#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanupResourceIds } from "./cleanup.mjs";

function statePath(argv) {
  const index = argv.indexOf("--state");
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--state is required.");
  }
  return resolve(value);
}

async function main() {
  const path = statePath(process.argv.slice(2));
  const state = JSON.parse(await readFile(path, "utf8"));
  assert.equal(state.lane, "gateway-routing", "Reset requires owned gateway-routing state.");
  const databaseIds = state.resources
    .filter(({ kind }) => kind === "postgres-database")
    .map(({ id }) => id);
  await cleanupResourceIds(path, databaseIds);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
