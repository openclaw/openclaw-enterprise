import type {
  AttemptContext,
  CaptureObservation,
  Clock,
  CredentialRef,
  DriverCustody,
  RenewalRef,
} from "./backend-contracts.ts";

export interface CapturedCredential {
  readonly ref: CredentialRef;
  readonly reservation: CaptureReservation;
  readonly capturedMonoMs: number;
  readonly deadlineMonoMs: number | undefined;
  useDeadlineMonoMs: number | undefined;
  uses: number;
  callbacks: number;
  accepted: boolean;
  retiring: boolean;
  retirementAttempted: boolean;
  disposition: "pending" | "revoked" | "expired" | "uncertain";
}
export interface CaptureReservation {
  readonly attempt: AttemptContext;
  readonly captured: CapturedCredential[];
  settled: boolean;
  unknown: boolean;
}

export function createCustody(options: {
  clock: Clock;
  maximumSlots: number;
  maximumAccessBytes: number;
  maximumRenewalBytes: number;
  maximumCallbacks: number;
  admitted(): boolean;
  changed(): void;
}) {
  const reservations = new Set<CaptureReservation>();
  const admittedAttempts = new WeakSet<AttemptContext>();
  const retirements = new WeakMap<AttemptContext, CapturedCredential>();
  const attempts = new WeakMap<AttemptContext, CaptureReservation>();
  const access = new WeakMap<CredentialRef, { record: CapturedCredential; bytes: Uint8Array }>();
  const renewals = new Map<
    RenewalRef,
    { bytes: Uint8Array; callbacks: Set<Promise<unknown>>; disposing: boolean }
  >();
  let renewalBytes = 0;
  let renewalCallbacks = 0;
  const records = new Set<CapturedCredential>();
  function get(ref: CredentialRef) {
    const value = access.get(ref);
    if (!value || !records.has(value.record)) {
      throw new Error("FOREIGN_CREDENTIAL");
    }
    return value;
  }
  function releaseReservation(reservation: CaptureReservation) {
    if (
      reservation.settled &&
      !reservation.unknown &&
      reservation.captured.every((record) => !records.has(record))
    ) {
      reservations.delete(reservation);
    }
  }
  async function withBytes<T>(
    record: CapturedCredential,
    consume: (bytes: Uint8Array) => Promise<T>,
  ): Promise<T> {
    const stored = get(record.ref);
    if (stored.record !== record) {
      throw new Error("FOREIGN_CREDENTIAL");
    }
    if (record.callbacks >= options.maximumCallbacks) {
      throw new Error("CALLBACK_CAPACITY");
    }
    const scoped = Uint8Array.from(stored.bytes);
    record.callbacks++;
    try {
      return await consume(scoped);
    } finally {
      scoped.fill(0);
      record.callbacks--;
      options.changed();
    }
  }
  const driver: DriverCustody = Object.freeze({
    assertAttempt(attempt: AttemptContext, action: AttemptContext["action"]): void {
      if (!admittedAttempts.has(attempt) || attempt.action !== action) {
        throw new Error("FOREIGN_ATTEMPT");
      }
    },
    capture(
      attempt: AttemptContext,
      bytes: Uint8Array,
      observation: CaptureObservation,
    ): CredentialRef {
      const reservation = attempts.get(attempt);
      if (!reservation || reservation.settled) {
        throw new Error("FOREIGN_ATTEMPT");
      }
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > options.maximumAccessBytes ||
        reservation.captured.length !== 0
      ) {
        reservation.unknown = true;
        options.changed();
        throw new Error("CAPTURE_LIMIT");
      }
      const observed = observation.observedWallMs;
      const expiry = observation.expiresAtWallMs;
      const capturedMonoMs = options.clock.monotonicNow();
      let deadlineMonoMs: number | undefined;
      if (
        Number.isFinite(observed) &&
        expiry !== undefined &&
        Number.isFinite(expiry) &&
        expiry >= observed
      ) {
        // Local wall movement cannot certify remote expiry or shorten custody.
        deadlineMonoMs = capturedMonoMs + (expiry - observed);
      }
      const ref = Object.freeze({}) as CredentialRef;
      const record: CapturedCredential = {
        ref,
        reservation,
        capturedMonoMs,
        deadlineMonoMs,
        useDeadlineMonoMs: undefined,
        uses: 0,
        callbacks: 0,
        accepted: false,
        retiring: false,
        retirementAttempted: false,
        disposition: "pending",
      };
      access.set(ref, { record, bytes: Uint8Array.from(bytes) });
      reservation.captured.push(record);
      records.add(record);
      options.changed();
      return ref;
    },
    async withRetirement<T>(
      attempt: AttemptContext,
      ref: CredentialRef,
      consume: (bytes: Uint8Array) => Promise<T>,
    ): Promise<T> {
      const { record } = get(ref);
      driver.assertAttempt(attempt, "retire");
      attempt.assertAdmitted();
      if (retirements.get(attempt) !== record || !record.retiring) {
        throw new Error("FOREIGN_RETIREMENT");
      }
      return withBytes(record, consume);
    },
    retainRenewal(bytes: Uint8Array): RenewalRef {
      if (
        !options.admitted() ||
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength === 0 ||
        bytes.byteLength + renewalBytes > options.maximumRenewalBytes ||
        renewals.size >= options.maximumSlots
      ) {
        throw new Error("RENEWAL_LIMIT");
      }
      const ref = Object.freeze({}) as RenewalRef;
      renewals.set(ref, { bytes: Uint8Array.from(bytes), callbacks: new Set(), disposing: false });
      renewalBytes += bytes.byteLength;
      return ref;
    },
    async withRenewal<T>(ref: RenewalRef, consume: (bytes: Uint8Array) => Promise<T>): Promise<T> {
      const entry = renewals.get(ref);
      if (!entry || entry.disposing) {
        throw new Error("FOREIGN_RENEWAL");
      }
      if (renewalCallbacks >= options.maximumCallbacks) {
        throw new Error("CALLBACK_CAPACITY");
      }
      const bytes = Uint8Array.from(entry.bytes);
      renewalCallbacks++;
      const work = Promise.resolve().then(() => consume(bytes));
      entry.callbacks.add(work);
      try {
        return await work;
      } finally {
        bytes.fill(0);
        entry.callbacks.delete(work);
        renewalCallbacks--;
        options.changed();
      }
    },
    async disposeRenewal(ref: RenewalRef): Promise<void> {
      const entry = renewals.get(ref);
      if (!entry) {
        throw new Error("FOREIGN_RENEWAL");
      }
      entry.disposing = true;
      await Promise.allSettled([...entry.callbacks]);
      if (renewals.delete(ref)) {
        renewalBytes -= entry.bytes.byteLength;
        entry.bytes.fill(0);
      }
      options.changed();
    },
  });
  return Object.freeze({
    driver,
    withUseBytes<T>(record: CapturedCredential, consume: (bytes: Uint8Array) => Promise<T>) {
      if (
        !options.admitted() ||
        record.disposition !== "pending" ||
        record.uses === 0 ||
        record.useDeadlineMonoMs === undefined ||
        options.clock.monotonicNow() >= record.useDeadlineMonoMs
      ) {
        return Promise.reject(new Error("CREDENTIAL_CLOSED"));
      }
      return withBytes(record, consume);
    },
    bindRetirement(attempt: AttemptContext, record: CapturedCredential) {
      driver.assertAttempt(attempt, "retire");
      if (!records.has(record) || retirements.has(attempt) || !record.retiring) {
        throw new Error("FOREIGN_RETIREMENT");
      }
      retirements.set(attempt, record);
    },
    records,
    reservations,
    register(attempt: AttemptContext) {
      admittedAttempts.add(attempt);
    },
    endAttempt(attempt: AttemptContext) {
      retirements.delete(attempt);
      admittedAttempts.delete(attempt);
    },
    get renewalCount() {
      return renewals.size;
    },
    get renewalCallbacks() {
      return renewalCallbacks;
    },
    reserve(attempt: AttemptContext): CaptureReservation {
      if (attempts.has(attempt) || reservations.size >= options.maximumSlots) {
        throw new Error("CREDENTIAL_CAPACITY");
      }
      const reservation: CaptureReservation = {
        attempt,
        captured: [],
        settled: false,
        unknown: false,
      };
      reservations.add(reservation);
      attempts.set(attempt, reservation);
      return reservation;
    },
    settle(reservation: CaptureReservation) {
      admittedAttempts.delete(reservation.attempt);
      reservation.settled = true;
      releaseReservation(reservation);
      options.changed();
    },
    lookup(ref: CredentialRef) {
      return get(ref).record;
    },
    release(record: CapturedCredential) {
      if (
        !records.has(record) ||
        !record.reservation.settled ||
        record.uses !== 0 ||
        record.callbacks !== 0 ||
        record.retiring ||
        (record.disposition !== "revoked" && record.disposition !== "expired")
      ) {
        throw new Error("CREDENTIAL_BUSY");
      }
      get(record.ref).bytes.fill(0);
      access.delete(record.ref);
      records.delete(record);
      releaseReservation(record.reservation);
      options.changed();
    },
    async disposeAllRenewal() {
      // Seal all handles before waiting for any callback to release its copy.
      await Promise.all([...renewals.keys()].map((ref) => driver.disposeRenewal(ref)));
    },
  });
}
export type CustodyOwner = ReturnType<typeof createCustody>;
