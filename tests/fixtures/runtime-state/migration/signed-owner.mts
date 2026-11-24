import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  parseObservation,
  readNamespace,
  readOwnerEnvelope,
  readOwnerStatement,
} from "./observations.mts";

const startup = "/run/oce-gateway-owner-start";
const privateKeyPath = startup + "/private.pem";
const ownerPath = startup + "/owner.json";

function lockPath() {
  const root = process.env.OPENCLAW_STATE_DIR;
  assert.ok(root, "Expected OPENCLAW_STATE_DIR");
  return root + "/tmp/openclaw-1000/gateway.state.lock";
}

export function assertKeyConsumed() {
  assert.equal(existsSync(privateKeyPath), false);
}

export function printOwner() {
  assertKeyConsumed();
  console.log(readFileSync(ownerPath, "utf8"));
}

export function seedLock(envelope: string, namespace: string) {
  const candidate = parseObservation(envelope, readOwnerEnvelope);
  const { pidNsInitStartTicks, ...processNamespace } = parseObservation(namespace, readNamespace);
  const root = process.env.OPENCLAW_STATE_DIR;
  assert.ok(root, "Expected OPENCLAW_STATE_DIR");
  mkdirSync(root + "/tmp/openclaw-1000", { recursive: true, mode: 0o700 });
  mkdirSync(root + "/state", { recursive: true, mode: 0o700 });
  rmSync(ownerPath, { force: true });
  writeFileSync(ownerPath, JSON.stringify(candidate));
  writeFileSync(
    lockPath(),
    JSON.stringify({
      pid: 999999,
      createdAt: "2026-01-01T00:00:00.000Z",
      configPath: root + "/openclaw.json",
      stateDir: root,
      role: "gateway",
      pidNsInitStartTicks,
      processNamespace,
    }),
    { mode: 0o600 },
  );
}

export function printLock() {
  console.log("lock-present=" + existsSync(lockPath()));
}

export function forgeOwner(statement: string) {
  parseObservation(statement, readOwnerStatement);
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  console.log(
    JSON.stringify({
      statement,
      signature: sign(null, Buffer.from(statement), privateKey).toString("base64"),
    }),
  );
}
