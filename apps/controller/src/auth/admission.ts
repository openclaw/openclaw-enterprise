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
export function admissionKey(
  kind: "ip" | "email" | "device" | "browser",
  value: string | null | undefined,
): string {
  const trimmed = (value ?? "").trim();
  const raw = kind === "ip" ? trimmed.slice(0, 64) : trimmed;
  return `${kind}:${createHash("sha256")
    .update(raw.length === 0 ? "unknown" : raw)
    .digest("hex")}`;
}

function admissionTable(preserveSpent: boolean) {
  // Map order is recency order: touching an entry deletes and re-inserts it.
  const table = new Map<string, AdmissionEntry>();

  function evict(pinned: readonly AdmissionEntry[], now: number): boolean {
    for (const [key, entry] of table) {
      if (
        entry.active === 0 &&
        !pinned.includes(entry) &&
        (!preserveSpent || now - entry.windowStart >= admissionWindow || entry.admitted === 0)
      ) {
        table.delete(key);
        return true;
      }
    }
    return false;
  }

  function touch(key: string, now: number, pinned: readonly AdmissionEntry[]): AdmissionEntry {
    let entry = table.get(key);
    if (entry === undefined) {
      if (table.size >= admissionTableCapacity && !evict(pinned, now)) {
        throw tooManyRequests();
      }
      entry = admissionEntry(now);
    } else {
      table.delete(key);
      rollWindow(entry, now);
    }
    table.set(key, entry);
    return entry;
  }
  return { touch, peek: (key: string) => table.get(key) };
}

/**
 * Attempt-counting admission for the external sign-in lanes (start, callback, result):
 * every admitted request spends one unit of each key's budget, under a global concurrency cap.
 */
export function keyedAdmission(
  perKey: AdmissionBudget,
  global: { readonly concurrent: number; readonly perMinute?: number },
) {
  const table = admissionTable(global.perMinute !== undefined);
  let active = 0;
  const total = admissionEntry(performance.now());

  return {
    async admit<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
      const now = performance.now();
      // Refused work must not change another key's rate budget through table eviction.
      if (active >= global.concurrent) {
        throw tooManyRequests();
      }
      if (global.perMinute !== undefined) {
        rollWindow(total, now);
        // Refused key churn must not touch or evict another key's entry.
        if (total.admitted >= global.perMinute) {
          throw tooManyRequests();
        }
      }
      const distinctKeys = [...new Set(keys)];
      // Inspect every existing limit before inserting or moving any key. A refused
      // combination of a spent key and fresh keys cannot churn another budget away.
      for (const key of distinctKeys) {
        const entry = table.peek(key);
        if (entry !== undefined) {
          const admitted = now - entry.windowStart < admissionWindow ? entry.admitted : 0;
          if (admitted >= perKey.perMinute || entry.active >= perKey.concurrent) {
            throw tooManyRequests();
          }
        }
      }
      const entries: AdmissionEntry[] = [];
      for (const key of distinctKeys) {
        entries.push(table.touch(key, now, entries));
      }
      // Check every limit before counting anything, so one exhausted key spends no other budget.
      if (
        entries.some(
          (entry) => entry.admitted >= perKey.perMinute || entry.active >= perKey.concurrent,
        )
      ) {
        throw tooManyRequests();
      }
      for (const entry of entries) {
        entry.admitted += 1;
        entry.active += 1;
      }
      if (global.perMinute !== undefined) {
        total.admitted += 1;
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
  /**
   * The verified known-device key for this email (see known-device.ts), never raw client
   * input. When present, the attempt spends the device's own budget instead of the email's,
   * and a slowed attempt waits on the device's slots instead of the email's.
   */
  readonly knownDevice?: string;
  /**
   * MAC-authenticated entry keys whose current account binding was not verified.
   * These only add device constraints to the shared email/address lanes; they never
   * select an exemption. The cookie verifier supplies at most three distinct keys.
   */
  readonly deviceConstraints?: readonly string[];
}

/**
 * The admission seam for password sign-in in both profiles. The in-memory implementation
 * below can be replaced by a State-owned attempt budget later.
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
  /**
   * True when the email's password must stay checkable once its budget is spent: an account
   * that administers the Installation or, with an external provider, the recovery account.
   */
  readonly isReserved: (email: string) => Promise<boolean>;
  /** Failures that spend budget: credential rejections, not dependency errors. */
  readonly countsAsFailure: (error: unknown) => boolean;
  /**
   * Called when attempts start going to the slow lane: at most once per lane entry per
   * window. `key` is the hashed admission key (never the email or address); the untracked
   * lane (a full budget table) has none.
   */
  readonly onLimited?: (limited: PasswordSignInLimited) => void;
}

/** One lane entering the slow lane, for operator visibility. */
export interface PasswordSignInLimited {
  readonly lane: "email" | "device" | "address" | "untracked";
  readonly key?: string;
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
  /** When this entry was last reported as limited. */
  reportedAt: number | undefined;
}

function passwordEntry(now: number): PasswordEntry {
  return { windowStart: now, failures: 0, active: 0, slowed: 0, reportedAt: undefined };
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
 * Failure-counting password admission for both sign-in profiles.
 *
 * Shared lane: budgets per email and, only when a trusted proxy resolves the client, per
 * client address. Only credential failures spend them (in-flight attempts count too, so
 * concurrent guesses cannot overrun them), so successful sign-ins are never limited.
 *
 * Slow lane: an attempt the shared lane does not admit is paced, never dropped outright.
 * It waits for one of the email's slots, holds it for a floor that doubles with each slow
 * attempt in the window (1 s up to 8 s), and looks the email up. Only a reserved account's
 * password (an Installation administrator, or the recovery account) is then checked; every
 * other outcome is `429` with Retry-After after the same floor, so the lane reveals neither
 * whether an email exists nor whether it is reserved. Guessing a reserved account is bounded
 * by the email's slots and floor, and its correct password is admitted however many failures
 * were spent.
 *
 * Known devices: an attempt carrying a verified known-device key spends that device's lane
 * instead of the email's and waits on the device's slow-lane slots, so a browser that signed
 * in to the account before is neither refused by nor crowded out by strangers spending the
 * email. The device lane has the email lane's size; the address lane and the global slow-lane
 * bounds still apply.
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

  // Reports a limited lane at most once per entry per window, so a flood logs one line.
  function reportLimited(entry: PasswordEntry, limited: PasswordSignInLimited, now: number): void {
    if (entry.reportedAt !== undefined && now - entry.reportedAt < admissionWindow) {
      return;
    }
    entry.reportedAt = now;
    try {
      options.onLimited?.(limited);
    } catch {
      // Visibility is best-effort; it never changes the admission decision.
    }
  }

  async function runTracked<T>(
    entries: readonly PasswordEntry[],
    identityEntry: PasswordEntry | undefined,
    work: () => Promise<T>,
  ) {
    try {
      const result = await work();
      // A successful sign-in clears its email's (or known device's) failures, not the
      // address's, which other accounts share, so earlier typos do not count toward the
      // rest of the window.
      if (identityEntry !== undefined) {
        identityEntry.failures = 0;
      }
      return result;
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
    gateKey: string,
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
        let gate = emailGates.get(gateKey);
        if (gate === undefined) {
          gate = new Gate(slow.concurrentPerEmail, slow.waitingPerEmail);
          emailGates.set(gateKey, gate);
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
            emailGates.delete(gateKey);
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
      // A known device replaces the email lane with its own lane of the same size, and
      // waits on its own slow-lane slots, so failures spent against the email by anyone
      // else neither refuse it nor crowd it out. The address lane still applies.
      const [identityKey, identityLane] =
        attempt.knownDevice === undefined
          ? [admissionKey("email", attempt.email), "email" as const]
          : [admissionKey("device", attempt.knownDevice), "device" as const];
      const lanes: Array<readonly [string, number, "email" | "device" | "address"]> = [
        ...(attempt.clientAddress === undefined
          ? []
          : [[admissionKey("ip", attempt.clientAddress), options.perAddress, "address"] as const]),
        [identityKey, options.perEmail, identityLane],
        ...(attempt.knownDevice === undefined
          ? [...new Set(attempt.deviceConstraints ?? [])].map(
              (key) => [admissionKey("device", key), options.perEmail, "device"] as const,
            )
          : []),
      ];
      // Decide from existing entries first: a refused attempt creates and moves nothing.
      const blocking: PasswordEntry[] = [];
      for (const [key, limit, lane] of lanes) {
        const entry = table.peek(key);
        if (entry !== undefined && exhausted(entry, limit, now)) {
          blocking.push(entry);
          reportLimited(entry, { lane, key }, now);
        }
      }
      if (blocking.length > 0) {
        return slowLane(attempt, identityKey, blocking, [], true, work);
      }
      const tracked: PasswordEntry[] = [];
      let identityEntry: PasswordEntry | undefined;
      let untracked = false;
      for (const [key] of lanes) {
        const entry = table.claim(key, now);
        if (entry === undefined) {
          untracked = true;
        } else {
          tracked.push(entry);
          if (key === identityKey) {
            identityEntry = entry;
          }
        }
      }
      if (untracked) {
        reportLimited(untrackedPacing, { lane: "untracked" }, now);
        return slowLane(attempt, identityKey, [untrackedPacing], tracked, false, work);
      }
      return runTracked(tracked, identityEntry, work);
    },
  };
}
