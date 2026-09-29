import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { APIError } from "better-auth";

/**
 * Single-controller sign-in admission. Keys are hashed caller values; entries keep a
 * one-minute window in a bounded, recency-ordered table so key churn cannot grow memory.
 */
export interface AdmissionBudget {
  readonly perMinute: number;
  readonly concurrent: number;
}

interface AdmissionEntry {
  windowStart: number;
  admitted: number;
  active: number;
}

const admissionTableCapacity = 4096;
const admissionWindow = 60_000;

export function tooManyRequests(): APIError {
  return APIError.fromStatus("TOO_MANY_REQUESTS", { message: "Try again later." });
}

/** A refused password sign-in; `retryAfterSeconds` becomes the Retry-After header. */
export class SignInRateLimited extends APIError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("TOO_MANY_REQUESTS", { message: "Try again later." });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function admissionEntry(now: number): AdmissionEntry {
  return { windowStart: now, admitted: 0, active: 0 };
}

function rollWindow(entry: AdmissionEntry, now: number): void {
  if (now - entry.windowStart >= admissionWindow) {
    entry.windowStart = now;
    entry.admitted = 0;
  }
}

// Caller keys are hashed; the address header value is capped before hashing.
export function admissionKey(kind: "ip" | "email", value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  const raw = kind === "ip" ? trimmed.slice(0, 64) : trimmed;
  return `${kind}:${createHash("sha256")
    .update(raw.length === 0 ? "unknown" : raw)
    .digest("hex")}`;
}

function admissionTable() {
  // Map order is recency order: touching an entry deletes and re-inserts it.
  const table = new Map<string, AdmissionEntry>();

  function evict(pinned: readonly AdmissionEntry[]): boolean {
    for (const [key, entry] of table) {
      if (entry.active === 0 && !pinned.includes(entry)) {
        table.delete(key);
        return true;
      }
    }
    return false;
  }

  return function touch(
    key: string,
    now: number,
    pinned: readonly AdmissionEntry[],
  ): AdmissionEntry {
    let entry = table.get(key);
    if (entry === undefined) {
      if (table.size >= admissionTableCapacity && !evict(pinned)) {
        throw tooManyRequests();
      }
      entry = admissionEntry(now);
    } else {
      table.delete(key);
      rollWindow(entry, now);
    }
    table.set(key, entry);
    return entry;
  };
}

/**
 * Attempt-counting admission for the guarded (external provider) profile: every admitted
 * request spends one unit of each key's budget, with a reserved recovery lane.
 */
export function keyedAdmission(
  perKey: AdmissionBudget,
  global: { readonly concurrent: number; readonly reserved: number },
  recovery?: AdmissionBudget,
) {
  const touch = admissionTable();
  // The recovery entry lives outside the table, so key churn can never evict it.
  const recoveryEntry = admissionEntry(performance.now());
  let active = 0;

  async function run<T>(entries: readonly AdmissionEntry[], work: () => Promise<T>): Promise<T> {
    for (const entry of entries) {
      entry.admitted += 1;
      entry.active += 1;
    }
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      for (const entry of entries) {
        entry.active -= 1;
      }
    }
  }

  return {
    async admit<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
      const now = performance.now();
      const entries: AdmissionEntry[] = [];
      for (const key of keys) {
        entries.push(touch(key, now, entries));
      }
      // Check every limit before counting anything, so one exhausted key spends no other budget.
      if (
        active >= global.concurrent ||
        entries.some(
          (entry) => entry.admitted >= perKey.perMinute || entry.active >= perKey.concurrent,
        )
      ) {
        throw tooManyRequests();
      }
      return run(entries, work);
    },
    async admitRecovery<T>(work: () => Promise<T>): Promise<T> {
      if (recovery === undefined) {
        throw tooManyRequests();
      }
      rollWindow(recoveryEntry, performance.now());
      if (
        active >= global.concurrent + global.reserved ||
        recoveryEntry.admitted >= recovery.perMinute ||
        recoveryEntry.active >= recovery.concurrent
      ) {
        throw tooManyRequests();
      }
      return run([recoveryEntry], work);
    },
  };
}

/** One password sign-in attempt as admission sees it. */
export interface PasswordSignInAttempt {
  /**
   * Client address resolved through a configured trusted proxy. Leave it undefined without
   * one: every browser behind an ingress then shares the ingress address, so keying on it
   * would let a few failures refuse everyone.
   */
  readonly clientAddress?: string;
  /** Normalized (trimmed, lower-case) email. */
  readonly email: string;
}

/**
 * The admission seam for password sign-in in the password-only profile. The in-memory
 * implementation below can be replaced by a State-owned attempt budget later.
 */
export interface PasswordSignInAdmission {
  admit<T>(attempt: PasswordSignInAttempt, work: () => Promise<T>): Promise<T>;
}

/** The slow lane: attempts the shared budget does not admit are paced, not dropped. */
export interface PasswordSlowLaneOptions {
  /** The first slow attempt's floor; each further one in the window doubles it. */
  readonly floorMs: number;
  /** The largest floor. */
  readonly maxFloorMs: number;
  /** Slow attempts running at once for one email; each holds its slot for its floor. */
  readonly concurrentPerEmail: number;
  /** Slow attempts that may wait for one email's slots. */
  readonly waitingPerEmail: number;
  /** Slow attempts held at once, waiting or running, across all emails. */
  readonly occupancy: number;
  /** Account lookups and password checks running at once in the slow lane. */
  readonly evaluating: number;
}

export interface PasswordFailureAdmissionOptions {
  /** Failures (plus in-flight attempts) per client address per minute. */
  readonly perAddress: number;
  /** Failures (plus in-flight attempts) per email per minute. */
  readonly perEmail: number;
  readonly slow: PasswordSlowLaneOptions;
  /** Entries in the budget table; defaults to the shared admission capacity. */
  readonly tableCapacity?: number;
  /** True when the email belongs to an account that administers the Installation. */
  readonly isReserved: (email: string) => Promise<boolean>;
  /** Failures that spend budget: credential rejections, not dependency errors. */
  readonly countsAsFailure: (error: unknown) => boolean;
}

export const passwordFailureBudget = {
  perAddress: 20,
  perEmail: 10,
  slow: {
    floorMs: 1000,
    maxFloorMs: 8000,
    concurrentPerEmail: 2,
    waitingPerEmail: 16,
    occupancy: 1024,
    evaluating: 16,
  },
} as const;

interface PasswordEntry {
  windowStart: number;
  failures: number;
  active: number;
  /** Slow-lane attempts this entry paced in the window; the floor doubles with each. */
  slowed: number;
}

function passwordEntry(now: number): PasswordEntry {
  return { windowStart: now, failures: 0, active: 0, slowed: 0 };
}

function currentWindow(entry: PasswordEntry, now: number): boolean {
  return now - entry.windowStart < admissionWindow;
}

function rollPasswordEntry(entry: PasswordEntry, now: number): void {
  if (!currentWindow(entry, now)) {
    entry.windowStart = now;
    entry.failures = 0;
    entry.slowed = 0;
  }
}

/**
 * The budget table. Only attempts that will run claim entries; a claim never evicts an
 * entry that is in flight or has spent budget in its current window, so key churn cannot
 * reset anyone's budget. A full table of spent entries makes `claim` return undefined.
 */
function passwordTable(capacity: number) {
  const table = new Map<string, PasswordEntry>();

  function evict(now: number): boolean {
    // Expired entries first, then current entries that have spent nothing.
    for (const expiredOnly of [true, false]) {
      for (const [key, entry] of table) {
        if (
          entry.active === 0 &&
          (!currentWindow(entry, now) || (!expiredOnly && entry.failures === 0))
        ) {
          table.delete(key);
          return true;
        }
      }
    }
    return false;
  }

  return {
    peek(key: string): PasswordEntry | undefined {
      return table.get(key);
    },
    /** Pins (active += 1) and returns the key's entry, or undefined when none can be made. */
    claim(key: string, now: number): PasswordEntry | undefined {
      let entry = table.get(key);
      if (entry === undefined) {
        if (table.size >= capacity && !evict(now)) {
          return undefined;
        }
        entry = passwordEntry(now);
        table.set(key, entry);
      } else {
        rollPasswordEntry(entry, now);
      }
      entry.active += 1;
      return entry;
    },
  };
}

/** A counting semaphore whose waiters are bounded. */
class Gate {
  active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;
  private readonly maxWaiting: number;

  constructor(limit: number, maxWaiting: number) {
    this.limit = limit;
    this.maxWaiting = maxWaiting;
  }

  /** Resolves true once a slot is held, or false at once when the wait list is full. */
  async acquire(): Promise<boolean> {
    if (this.active < this.limit) {
      this.active += 1;
      return true;
    }
    if (this.waiting.length >= this.maxWaiting) {
      return false;
    }
    // release() hands its slot straight to the next waiter.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return true;
  }

  release(): void {
    const next = this.waiting.shift();
    if (next === undefined) {
      this.active -= 1;
    } else {
      next();
    }
  }

  get idle(): boolean {
    return this.active === 0 && this.waiting.length === 0;
  }
}

/**
 * Failure-counting password admission for the password-only profile.
 *
 * Shared lane: budgets per email and, only when a trusted proxy resolves the client, per
 * client address. Only credential failures spend them (in-flight attempts count too, so
 * concurrent guesses cannot overrun them), so successful sign-ins are never limited.
 *
 * Slow lane: an attempt the shared lane does not admit is paced, never dropped outright.
 * It waits for one of the email's slots, holds it for a floor that doubles with each slow
 * attempt in the window (1 s up to 8 s), and looks the email up. Only an Installation
 * administrator's password is then checked; every other outcome is `429` with Retry-After
 * after the same floor, so the lane reveals neither whether an email exists nor whether it
 * administers. Guessing an administrator is bounded by the email's slots and floor, and the
 * administrator's correct password is admitted however many failures were spent.
 *
 * A refused attempt creates no entry and moves none. When the table is full of entries
 * that are in flight or spent, a new key cannot be tracked: that attempt goes through the
 * slow lane and its password is checked for every account, paced by a shared floor.
 */
export function passwordFailureAdmission(
  options: PasswordFailureAdmissionOptions,
): PasswordSignInAdmission {
  const table = passwordTable(options.tableCapacity ?? admissionTableCapacity);
  const slow = options.slow;
  // Paces attempts whose key could not be tracked because the table is full.
  const untrackedPacing = passwordEntry(performance.now());
  const emailGates = new Map<string, Gate>();
  const evaluating = new Gate(slow.evaluating, Number.POSITIVE_INFINITY);
  let occupancy = 0;

  function exhausted(entry: PasswordEntry | undefined, limit: number, now: number): boolean {
    if (entry === undefined) {
      return false;
    }
    return (currentWindow(entry, now) ? entry.failures : 0) + entry.active >= limit;
  }

  function retryAfter(entries: readonly PasswordEntry[], now: number): number {
    const reset = Math.max(...entries.map((entry) => entry.windowStart + admissionWindow));
    return Math.max(1, Math.ceil((reset - now) / 1000));
  }

  async function evaluate<T>(work: () => Promise<T>): Promise<T> {
    await evaluating.acquire();
    try {
      return await work();
    } finally {
      evaluating.release();
    }
  }

  function recordFailure(entries: readonly PasswordEntry[]): void {
    for (const entry of entries) {
      entry.failures += 1;
    }
  }

  async function runTracked<T>(entries: readonly PasswordEntry[], work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (options.countsAsFailure(error)) {
        recordFailure(entries);
      }
      throw error;
    } finally {
      for (const entry of entries) {
        entry.active -= 1;
      }
    }
  }

  async function slowLane<T>(
    attempt: PasswordSignInAttempt,
    emailKey: string,
    pacing: readonly PasswordEntry[],
    tracked: readonly PasswordEntry[],
    administratorsOnly: boolean,
    work: () => Promise<T>,
  ): Promise<T> {
    const now = performance.now();
    let slowed = 0;
    for (const entry of pacing) {
      rollPasswordEntry(entry, now);
      slowed = Math.max(slowed, entry.slowed);
      entry.slowed += 1;
    }
    const floorMs = Math.min(slow.maxFloorMs, slow.floorMs * 2 ** slowed);
    const floor = () => delay(floorMs, undefined, { ref: false });
    const refused = new SignInRateLimited(retryAfter(pacing, now));
    try {
      if (occupancy >= slow.occupancy) {
        await floor();
        throw refused;
      }
      occupancy += 1;
      try {
        let gate = emailGates.get(emailKey);
        if (gate === undefined) {
          gate = new Gate(slow.concurrentPerEmail, slow.waitingPerEmail);
          emailGates.set(emailKey, gate);
        }
        if (!(await gate.acquire())) {
          await floor();
          throw refused;
        }
        // The slot is held for the whole floor, so one email sees at most
        // concurrentPerEmail slow checks per floor.
        const floorDone = floor();
        try {
          let admitted: boolean;
          try {
            admitted =
              !administratorsOnly || (await evaluate(() => options.isReserved(attempt.email)));
          } catch (error) {
            // A dependency failure is 503, never a refusal that hides the outage.
            await floorDone;
            throw error;
          }
          if (!admitted) {
            await floorDone;
            throw refused;
          }
          try {
            const result = await evaluate(work);
            await floorDone;
            return result;
          } catch (error) {
            await floorDone;
            if (!options.countsAsFailure(error)) {
              throw error;
            }
            recordFailure(tracked);
            throw administratorsOnly ? refused : error;
          }
        } finally {
          gate.release();
          if (gate.idle) {
            emailGates.delete(emailKey);
          }
        }
      } finally {
        occupancy -= 1;
      }
    } finally {
      for (const entry of tracked) {
        entry.active -= 1;
      }
    }
  }

  return {
    async admit<T>(attempt: PasswordSignInAttempt, work: () => Promise<T>): Promise<T> {
      const now = performance.now();
      const emailKey = admissionKey("email", attempt.email);
      const lanes: Array<readonly [string, number]> = [
        ...(attempt.clientAddress === undefined
          ? []
          : [[admissionKey("ip", attempt.clientAddress), options.perAddress] as const]),
        [emailKey, options.perEmail],
      ];
      // Decide from existing entries first: a refused attempt creates and moves nothing.
      const blocking = lanes
        .map(([key, limit]) => {
          const entry = table.peek(key);
          return exhausted(entry, limit, now) ? entry : undefined;
        })
        .filter((entry): entry is PasswordEntry => entry !== undefined);
      if (blocking.length > 0) {
        return slowLane(attempt, emailKey, blocking, [], true, work);
      }
      const tracked: PasswordEntry[] = [];
      let untracked = false;
      for (const [key] of lanes) {
        const entry = table.claim(key, now);
        if (entry === undefined) {
          untracked = true;
        } else {
          tracked.push(entry);
        }
      }
      if (untracked) {
        return slowLane(attempt, emailKey, [untrackedPacing], tracked, false, work);
      }
      return runTracked(tracked, work);
    },
  };
}
