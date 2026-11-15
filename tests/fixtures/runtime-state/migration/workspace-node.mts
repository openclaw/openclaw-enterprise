import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseObservation, readDeviceId, record, text, wholeNumber } from "./observations.mts";

const state = "/home/node/.openclaw-node";
const databasePath = state + "/state/openclaw.sqlite";
const maxBuffer = 1_000_000;
const [, , launcher, entrypoint, timeout, environmentJson] = process.argv;
assert.ok(launcher === "harness" || launcher === "worker", "Expected a workspace launcher");
assert.ok(entrypoint && timeout && environmentJson, "Expected entrypoint, timeout and environment");
const timeoutMs = wholeNumber(Number(timeout));
assert.ok(timeoutMs > 0, "Expected a positive launcher timeout");
const environment = parseObservation(environmentJson, (value) =>
  Object.fromEntries(Object.entries(record(value)).map(([name, setting]) => [name, text(setting)])),
);

// A retained node-state root can carry the setgid bit inherited from a PVC.
// Both launchers must prepare it before Doctor opens the old database.
chmodSync(state, 0o2755);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPublicKey = Buffer.from(text(publicKey.export({ format: "jwk" }).x), "base64url");
const savedDeviceId = createHash("sha256").update(rawPublicKey).digest("hex");
const savedAt = Date.now();
const older = new DatabaseSync(databasePath);
try {
  // This is the released schema's primary client identity. The current CLI must
  // read the same device ID after migrating these credentials to the new store.
  older
    .prepare("INSERT INTO device_identities VALUES ('primary', ?, ?, ?, ?, ?)")
    .run(
      savedDeviceId,
      publicKey.export({ type: "spki", format: "pem" }),
      privateKey.export({ type: "pkcs8", format: "pem" }),
      savedAt,
      savedAt,
    );
} finally {
  older.close();
}

function processStatus(result: SpawnSyncReturns<string>, command: string): number {
  if (result.error) {
    throw new Error(command + " could not complete", { cause: result.error });
  }
  assert.equal(result.signal, null, command + " exited on a signal");
  assert.ok(result.status !== null, command + " has no exit status");
  return result.status;
}

function start(program: string) {
  const result = spawnSync(
    process.execPath,
    ["--require", "/runtime-state-fixture/workspace-children.mts", "-e", program],
    {
      env: {
        PATH: process.env.PATH,
        HOME: "/home/node",
        OPENCLAW_NODE_STATE_DIR: state,
        OPENCLAW_NODE_SETUP_CODE: "synthetic-setup",
        OPENCLAW_WORKSPACE_DIR: "/home/node/workspace",
        ...environment,
        OCE_TEST_WORKSPACE_LAUNCHER: launcher,
      },
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer,
    },
  );
  return {
    status: processStatus(result, "Workspace launcher"),
    output: result.stdout + result.stderr,
  };
}

function schema(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const header = wholeNumber(database.prepare("PRAGMA user_version").get()?.user_version);
    const hasTable = database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
    );
    const row = hasTable.get("config_machine_state")
      ? database
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
          )
          .get()
      : undefined;
    const marker = row === undefined ? 0 : parseObservation(text(row.value_json), wholeNumber);
    // The current schema keeps client credentials elsewhere; only an older copy has this table.
    const identity = hasTable.get("device_identities")
      ? database
          .prepare("SELECT device_id FROM device_identities WHERE identity_key = 'primary'")
          .get()
      : undefined;
    return {
      version: Math.max(header, marker),
      deviceId: identity === undefined ? undefined : readDeviceId(identity.device_id),
    };
  } finally {
    database.close();
  }
}

const upgraded = start(entrypoint);
assert.equal(statSync(state).mode & 0o7777, 0o700);
const identity = spawnSync(process.execPath, ["/app/openclaw.mjs", "node", "identity", "--json"], {
  env: {
    PATH: process.env.PATH,
    HOME: "/home/node",
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: state + "/openclaw.json",
    OPENCLAW_NO_AUTO_UPDATE: "1",
  },
  encoding: "utf8",
  timeout: 60_000,
  maxBuffer,
});
const identityStatus = processStatus(identity, "OpenClaw node identity");
assert.equal(identityStatus, 0, "OpenClaw must read the migrated device identity");
const deviceId = parseObservation(identity.stdout, (value) => readDeviceId(record(value).deviceId));
const backupNames = readdirSync(state + "/state").filter(
  (name) => name.startsWith("openclaw.sqlite.pre-startup-migration-") && name.endsWith(".bak"),
);
const current = start(entrypoint);
const ancestor = statSync("/home/node");
process.stdout.write(
  JSON.stringify({
    savedDeviceId,
    upgraded,
    deviceId,
    identityStatus,
    migrated: schema(databasePath).version,
    backups: backupNames.map((name) => ({ name, ...schema(state + "/state/" + name) })),
    current,
    ancestor: { uid: ancestor.uid, mode: ancestor.mode & 0o7777 },
  }),
);
