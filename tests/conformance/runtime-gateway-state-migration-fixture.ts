import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";

import { temporaryDirectory } from "../helpers/temporary-directory.ts";

interface SharedState {
  readonly shared?: number;
  readonly marker?: number;
}

// Agent databases by ID, with an optional shared state database and content marker.
export async function stateDirectory(
  t: TestContext,
  databases: Readonly<Record<string, number>> = {},
  { shared, marker }: SharedState = {},
): Promise<string> {
  const directory = await temporaryDirectory(t, "oce-gateway-state-migration-");
  for (const [agentId, version] of Object.entries(databases)) {
    const path = databasePath(directory, agentId);
    await mkdir(dirname(path), { recursive: true });
    setVersion(path, version);
  }
  if (shared !== undefined) {
    const path = sharedPath(directory);
    await mkdir(dirname(path), { recursive: true });
    setVersion(path, shared, marker);
  }
  return directory;
}

export function databasePath(directory: string, agentId: string): string {
  return join(directory, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

export function sharedPath(directory: string): string {
  return join(directory, "state", "openclaw.sqlite");
}

// OpenClaw keeps the shared state content marker in config_machine_state.
export function setVersion(path: string, version: number, marker?: number): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(
      `CREATE TABLE IF NOT EXISTS fixture (id INTEGER); PRAGMA user_version = ${version}`,
    );
    if (marker !== undefined) {
      database.exec(
        "CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT)",
      );
      database
        .prepare(
          "INSERT OR REPLACE INTO config_machine_state VALUES ('state.schema.contentVersion', ?)",
        )
        .run(String(marker));
    }
  } finally {
    database.close();
  }
}

export function readVersion(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const version = database.prepare("PRAGMA user_version").get()?.user_version;
    assert.ok(
      typeof version === "number" && Number.isInteger(version),
      "Expected a schema version",
    );
    return version;
  } finally {
    database.close();
  }
}

interface DoctorCompletionTarget {
  stdout: { emit(event: "data", chunk: Buffer): boolean };
  emit(event: "exit" | "close", status: number, signal: null): boolean;
}

// Packaged integration tests exercise the real producer. Here the child reports
// a chosen record, including malformed records, on the wrapper's stdout boundary.
export function finishDoctor(
  child: DoctorCompletionTarget,
  result: Readonly<Record<string, unknown>> = { status: "ok" },
): void {
  child.stdout.emit(
    "data",
    Buffer.from("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH=" + JSON.stringify(result) + "\n"),
  );
  const status = result.status === "advisory" ? 86 : 0;
  child.emit("exit", status, null);
  child.emit("close", status, null);
}
