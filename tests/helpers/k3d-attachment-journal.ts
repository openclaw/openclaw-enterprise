import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, isPositiveSafeInteger } from "../../packages/utils/src/index.ts";

export type Attachment = {
  networkId: string;
  containerId: string;
  endpointId?: string;
};

type Holders = Record<string, number>;

type RegistryFields = {
  attachment?: Attachment;
  connectedByHarness: boolean;
  holders: Holders;
};

export type PendingRelease = RegistryFields & {
  attachment: Attachment;
  connectedByHarness: true;
  pendingConnect?: never;
  pendingRelease: true;
  connectRollback?: true;
};

type PendingConnect = RegistryFields & {
  attachment: Attachment;
  connectedByHarness: true;
  pendingConnect: true;
  pendingRelease?: never;
  connectRollback?: never;
};

export type PendingAttachment = PendingConnect | PendingRelease;

export type AttachmentRegistry =
  | PendingAttachment
  | (RegistryFields & {
      pendingConnect?: never;
      pendingRelease?: never;
      connectRollback?: never;
    });

type LockOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function isFullId(id: unknown): id is string {
  return typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
}

export function thrownField(error: unknown, field: "name" | "message" | "code"): unknown {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  switch (field) {
    case "code":
      return "code" in error ? error.code : undefined;
    case "name":
      return "name" in error ? error.name : undefined;
    case "message":
      return "message" in error ? error.message : undefined;
  }
}

export function errorStatus(error: unknown): string {
  return String(thrownField(error, "code") ?? thrownField(error, "name"));
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return thrownField(error, "code") === "EPERM";
  }
}

async function lockHolder(lockPath: string) {
  // A lock file the creator has not written yet reads as 0: wait, never take it over.
  return Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
}

// Removes a lock whose holder died. Takeovers serialize through a breaker file, so a
// waiter that saw the same dead holder can never remove the lock a peer just took.
async function breakStaleLock(lockPath: string, deadHolder: number) {
  const breakerPath = `${lockPath}.break`;
  try {
    await writeFile(breakerPath, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (thrownField(error, "code") !== "EEXIST") {
      throw error;
    }
    // Judge a breaker by its holder like the lock; a stalled but live holder blocks
    // waiters until the deadline rather than losing exclusion. Age decides only for a
    // breaker whose creator died before writing its pid. Two waiters removing the same
    // dead breaker within one sub-millisecond window could still overlap; that needs a
    // crash inside the breaker's two-call window and is accepted.
    const breakerHolder = await lockHolder(breakerPath);
    if (Number.isInteger(breakerHolder) && breakerHolder > 0) {
      if (!processAlive(breakerHolder)) {
        await rm(breakerPath, { force: true });
      }
      return;
    }
    const age =
      Date.now() - (await stat(breakerPath).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
    if (age > 10_000) {
      await rm(breakerPath, { force: true });
    }
    return;
  }
  try {
    if ((await lockHolder(lockPath)) === deadHolder) {
      await rm(lockPath, { force: true });
    }
  } finally {
    await rm(breakerPath, { force: true });
  }
}

// One lock per lane state directory: concurrent test files in a lane are separate
// processes on one runner. A lock left by a dead process is taken over.
export async function withAttachmentLock<T>(
  lockPath: string,
  registryPath: string,
  step: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (thrownField(error, "code") !== "EEXIST") {
        throw error;
      }
      assert.ok(Date.now() < deadline, `timed out waiting for ${lockPath}`);
      const holder = await lockHolder(lockPath);
      if (Number.isInteger(holder) && holder > 0 && !processAlive(holder)) {
        await breakStaleLock(lockPath, holder);
      }
      await delay(100);
    }
  }
  let outcome: LockOutcome<T>;
  try {
    outcome = { ok: true, value: await step() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await rm(lockPath, { force: true });
  } catch (error) {
    const unlockFailure = Object.assign(
      new Error(
        `Could not remove attachment lock ${lockPath} (${errorStatus(error)}). ` +
          "Stop this lane's participants and fix filesystem access. Confirm the lock holder " +
          `cannot resume before clearing the lock. Reconcile ${registryPath} before retrying any attachment operation.`,
        { cause: error },
      ),
      { code: thrownField(error, "code") },
    );
    if (outcome.ok) {
      throw unlockFailure;
    }
    const primaryFailure = outcome.error;
    throw Object.assign(
      new AggregateError(
        [primaryFailure, unlockFailure],
        `${thrownField(primaryFailure, "message") ?? String(primaryFailure)}. ${unlockFailure.message}`,
        { cause: primaryFailure },
      ),
      { code: thrownField(primaryFailure, "code") },
    );
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

export async function readHolders(registryPath: string): Promise<AttachmentRegistry> {
  let contents: string;
  try {
    contents = await readFile(registryPath, "utf8");
  } catch (error) {
    if (thrownField(error, "code") === "ENOENT") {
      return { connectedByHarness: false, holders: {} };
    }
    throw error;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(contents);
  } catch (error) {
    throw new Error(`invalid attachment registry JSON in ${registryPath}`, { cause: error });
  }
  assertRegistry(decoded, registryPath);
  return decoded;
}

function assertRegistry(
  decoded: unknown,
  registryPath: string,
): asserts decoded is AttachmentRegistry {
  const registry = asRecord(decoded);
  const holders = asRecord(registry?.holders);
  assert.ok(
    typeof registry?.connectedByHarness === "boolean" &&
      holders &&
      Object.values(holders).every(isPositiveSafeInteger),
    `invalid attachment holders in ${registryPath}`,
  );
  const { attachment, pendingConnect, pendingRelease, connectRollback } = registry;
  if (attachment !== undefined) {
    const identity = asRecord(attachment);
    assert.ok(
      isFullId(identity?.networkId) &&
        isFullId(identity?.containerId) &&
        (identity.endpointId === undefined || isFullId(identity.endpointId)),
      `invalid attachment IDs in ${registryPath}`,
    );
  }
  if (
    pendingConnect !== undefined ||
    pendingRelease !== undefined ||
    connectRollback !== undefined
  ) {
    assert.ok(
      ((pendingConnect === true && pendingRelease === undefined) ||
        (pendingRelease === true && pendingConnect === undefined)) &&
        (connectRollback === undefined || (connectRollback === true && pendingRelease === true)) &&
        attachment &&
        registry.connectedByHarness &&
        Object.keys(holders).length === 0,
      `invalid pending attachment in ${registryPath}`,
    );
  }
}

export async function writeHolders(registryPath: string, registry: AttachmentRegistry) {
  const temporary = `${registryPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(registry), { mode: 0o600 });
    await rename(temporary, registryPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function liveHolders(registry: AttachmentRegistry): Holders {
  return Object.fromEntries(
    Object.entries(registry.holders).filter(([, pid]) => processAlive(pid)),
  );
}
