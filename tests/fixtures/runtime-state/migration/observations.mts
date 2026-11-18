import assert from "node:assert/strict";
import type { GatewayPidNamespace } from "../../../../apps/controller/src/drivers/compute/embedded-gateway-owner.ts";

export function parseObservation<T>(stdout: string, read: (value: unknown) => T): T {
  const value: unknown = JSON.parse(stdout);
  return read(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Expected an observation object");
  return value;
}

export function wholeNumber(value: unknown): number {
  assert.ok(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "Expected a nonnegative integer",
  );
  return value;
}

export function text(value: unknown): string {
  assert.ok(typeof value === "string", "Expected an observation string");
  return value;
}

function list<T>(value: unknown, read: (item: unknown) => T): T[] {
  assert.ok(Array.isArray(value), "Expected an observation array");
  const items: readonly unknown[] = value;
  return items.map(read);
}

export function readMaintenance(value: unknown) {
  const { attempts, pending, mode } = record(value);
  assert.ok(typeof pending === "boolean", "Expected a pending-maintenance flag");
  return {
    attempts: wholeNumber(attempts),
    pending,
    mode: mode === null ? null : wholeNumber(mode),
  };
}

export function readAgentDatabase(value: unknown) {
  const { version, backups } = record(value);
  return { version: wholeNumber(version), backups: list(backups, text) };
}

export function readNamespace(value: unknown): GatewayPidNamespace {
  const { platform, identity, host, pidNsInode, pidNsInitStartTicks } = record(value);
  assert.equal(platform, "linux");
  assert.ok(
    typeof identity === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(identity),
    "Expected a namespace boot ID",
  );
  assert.ok(
    typeof pidNsInode === "string" && /^\d+$/.test(pidNsInode),
    "Expected a namespace inode",
  );
  assert.ok(typeof host === "string" && host.length > 0, "Expected a namespace host");
  return {
    platform,
    identity,
    host,
    pidNsInode,
    pidNsInitStartTicks: wholeNumber(pidNsInitStartTicks),
  };
}

export function readOwnerEnvelope(value: unknown) {
  const { statement, signature } = record(value);
  assert.ok(
    typeof signature === "string" && /^[A-Za-z0-9+/]{86}==$/.test(signature),
    "Expected a base64 Ed25519 signature",
  );
  return { statement: text(statement), signature };
}

export function readOwnerStatement(value: unknown) {
  const { pod, userNamespace, namespace } = record(value);
  assert.ok(
    typeof userNamespace === "string" && /^user:\[\d+\]$/.test(userNamespace),
    "Expected a user namespace",
  );
  return { pod: text(pod), userNamespace, namespace: readNamespace(namespace) };
}

export function readDeviceId(value: unknown) {
  const id = text(value);
  assert.match(id, /^[\da-f]{64}$/, "Expected a device ID");
  return id;
}

function readLauncher(value: unknown) {
  const { status, output } = record(value);
  return { status: wholeNumber(status), output: text(output) };
}

export function readWorkspaceUpgrade(value: unknown) {
  const {
    savedDeviceId,
    upgraded,
    deviceId,
    identityStatus,
    migrated,
    backups,
    current,
    ancestor,
  } = record(value);
  const { uid, mode } = record(ancestor);
  return {
    savedDeviceId: readDeviceId(savedDeviceId),
    upgraded: readLauncher(upgraded),
    deviceId: deviceId === undefined ? undefined : readDeviceId(deviceId),
    identityStatus: wholeNumber(identityStatus),
    migrated: wholeNumber(migrated),
    backups: list(backups, (backup) => {
      const { name, version, deviceId } = record(backup);
      return {
        name: text(name),
        version: wholeNumber(version),
        deviceId: deviceId === undefined ? undefined : readDeviceId(deviceId),
      };
    }),
    current: readLauncher(current),
    ancestor: { uid: wholeNumber(uid), mode: wholeNumber(mode) },
  };
}
