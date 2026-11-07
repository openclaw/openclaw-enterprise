import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { object, readConfig } from "./launch.ts";
import { processIdentity } from "./transport.ts";

export const OWNER = [
  "driverId",
  "implementation",
  "namespaceId",
  "namespaceName",
  "agentId",
  "revisionId",
] as const;
export type Owner = Record<(typeof OWNER)[number], string>;
export type OwnerPin = Omit<Owner, "revisionId"> & { revisionId?: string };

interface ControllerIdentity {
  pid: number;
  startTicks: string;
  bootId: string;
}
export interface Pending {
  version: 1;
  owner: Owner;
  requirementsDigest: string;
  profileSha256: string;
  image: string;
  commandSha256: string;
  workspaceNode?: {
    readonly mode: "file-only-v1";
    readonly planSha256: string;
    readonly workspaceVolume: { readonly claimUid: string; readonly volumeName: string };
  };
  counts: { environment: number; files: number; mounts: number };
  controller: ControllerIdentity;
}

export function currentController(pid = process.pid, verifiedBootId?: string): ControllerIdentity {
  return {
    pid,
    startTicks: processIdentity(pid).startTicks,
    bootId: verifiedBootId ?? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  };
}

export function sameOwner(pin: OwnerPin, owner: Owner): boolean {
  return OWNER.every((key) =>
    key === "revisionId" && pin.revisionId === undefined ? true : pin[key] === owner[key],
  );
}

export function durableRecord(directory: string, name: string, value: object): void {
  const fd = openSync(join(directory, name), "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const root = openSync(directory, "r");
  try {
    fsyncSync(root);
  } finally {
    closeSync(root);
  }
}

function approvalFor(pending: Pending): { version: 1; pendingSha256: string } {
  return {
    version: 1,
    pendingSha256: createHash("sha256").update(JSON.stringify(pending)).digest("hex"),
  };
}

export function approve(
  runtimeDir: string,
  approvalDir: string,
  pin: OwnerPin,
  revisionId: string,
  requirementsDigest: string,
  verifiedBootId?: string,
): void {
  const pending = object(readConfig(join(runtimeDir, "pending.json"))) as unknown as Pending;
  if (
    pending.version !== 1 ||
    !sameOwner(pin, pending.owner) ||
    pending.owner.revisionId !== revisionId ||
    pending.requirementsDigest !== requirementsDigest ||
    !/^[a-f0-9]{64}$/.test(requirementsDigest) ||
    JSON.stringify(currentController(pending.controller.pid, verifiedBootId)) !==
      JSON.stringify(pending.controller)
  ) {
    throw new Error("approval_custody_mismatch");
  }
  durableRecord(approvalDir, "approval.json", approvalFor(pending));
}

export function isApproved(
  approvalDir: string,
  pending: Pending,
  verifiedBootId?: string,
): boolean {
  try {
    return (
      JSON.stringify(readConfig(join(approvalDir, "approval.json"))) ===
        JSON.stringify(approvalFor(pending)) &&
      JSON.stringify(currentController(undefined, verifiedBootId)) ===
        JSON.stringify(pending.controller)
    );
  } catch {
    return false;
  }
}
