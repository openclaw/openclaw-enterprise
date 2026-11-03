import type { TokenAdmission, TokenPreparationStore } from "./custody.ts";
import { preparationAdmitted, sameTokenAdmission } from "./custody.ts";

/** An admitted worker owns the attempt. The provider adapter owns its issuer protocol and validation. */
export interface TokenIssue {
  readonly attemptId: string;
  readonly bounds: Readonly<{ signal: AbortSignal; deadlineMonoMs: number }>;
  /** Check after obtaining the issuer input, immediately before possible dispatch. */
  assertIssuing(): Promise<void>;
  /** Transfer candidate ownership to cleanup custody before validating it or awaiting transport close. */
  capture(candidate: Uint8Array): void;
  /** Record a complete provider answer that refused issuance. Never for a lost or partial answer. */
  refused(): void;
}

/**
 * How far the issuer's wall clock may run ahead of the store's before it refuses to dispatch. A
 * clock behind only shortens what the issuer signs.
 */
const storeClockToleranceMs = 120_000;

export interface TokenPreparationObservation {
  readonly attemptId: string;
  readonly stage: "intent" | "fence" | "issue" | "publication";
  readonly error?: "store-error" | "issuer-error" | "admission-fenced" | "invalid-material";
  readonly admissionCurrent?: boolean;
  readonly inBounds?: boolean;
  readonly stale?: boolean;
  readonly clockTolerance?: boolean;
  readonly publication?: "committed" | "quarantined" | "unknown";
}

interface PreparationOptions<A extends TokenAdmission> {
  readonly admission: A;
  readonly store: TokenPreparationStore<A>;
  readonly clock: { monotonicNow(): number; wallNow(): number };
  readonly renewBeforeMs: number;
  readonly minimumValidityMs: number;
  readonly observe?: (observation: TokenPreparationObservation) => void;
  readonly issue: (
    attempt: TokenIssue,
  ) => Promise<{ providerExpiresAt: number; usableUntil: number } | undefined>;
}

/**
 * One background worker owner, invoked independently of requests/provisioning.
 */
export function createTokenPreparation<A extends TokenAdmission>(options: PreparationOptions<A>) {
  const { store, clock, renewBeforeMs, minimumValidityMs } = options;
  const admission = structuredClone(options.admission);
  if (
    !Number.isFinite(renewBeforeMs) ||
    !Number.isFinite(minimumValidityMs) ||
    minimumValidityMs < 0 ||
    renewBeforeMs < minimumValidityMs ||
    renewBeforeMs <= 0
  ) {
    throw new Error("invalid-preparation-validity");
  }
  return Object.freeze({
    async run(
      attemptId: string,
      bounds: TokenIssue["bounds"],
    ): Promise<"ready" | "committed" | "blocked" | "fenced" | "quarantined"> {
      let stage: TokenPreparationObservation["stage"] = "intent";
      const observe = (observation: Omit<TokenPreparationObservation, "attemptId">) => {
        stage = observation.stage;
        try {
          options.observe?.({ attemptId, ...observation });
        } catch {
          // Reporting must not change issuance, publication or cleanup custody.
        }
      };
      const inBounds = () => !bounds.signal.aborted && clock.monotonicNow() < bounds.deadlineMonoMs;
      if (!attemptId || !inBounds()) {
        return "blocked";
      }
      try {
        observe({ stage: "intent" });
        const begun = await store.transact(admission.familyId, (row) => {
          if (!preparationAdmitted(row, admission)) {
            return "fenced" as const;
          }
          // Successes remain deduplicated; takeover never makes an unknown attempt retryable.
          if (
            row.attempts.some(
              (attempt) => attempt.id === attemptId || attempt.state !== "committed",
            )
          ) {
            return "blocked" as const;
          }
          if (
            row.committed &&
            sameTokenAdmission(row.committed.admission, admission) &&
            row.committed.usableUntil > clock.wallNow() + renewBeforeMs
          ) {
            return "ready" as const;
          }
          row.attempts.push({
            id: attemptId,
            admission: structuredClone(admission),
            state: "issuing",
          });
          return "begun" as const;
        });
        if (begun !== "begun") {
          return begun;
        }
      } catch {
        observe({ stage: "intent", error: "store-error", publication: "unknown" });
        // The durable uncertainty marker may have committed. Do not issue or retry.
        return "quarantined";
      }

      let candidate: Uint8Array | undefined;
      let verified: { providerExpiresAt: number; usableUntil: number } | undefined;
      let refused = false;
      try {
        observe({ stage: "issue" });
        verified = await options.issue({
          attemptId,
          bounds,
          // The issuer might await its signing input before this check. Recovery could have
          // fenced this attempt in the meantime. Publication must independently recheck it.
          async assertIssuing() {
            observe({ stage: "fence" });
            const issuing = await store.readCurrent(admission.familyId, (row) => {
              const admissionCurrent = preparationAdmitted(row, admission);
              observe({ stage: "fence", admissionCurrent });
              const issuing =
                admissionCurrent &&
                row.attempts.some((entry) => {
                  const matches = entry.id === attemptId;
                  if (matches) {
                    observe({ stage: "fence", stale: entry.stale === true });
                  }
                  return (
                    matches &&
                    entry.state === "issuing" &&
                    !entry.stale &&
                    sameTokenAdmission(entry.admission, admission)
                  );
                });
              return issuing ? { observedAt: row.observedAt } : undefined;
            });
            // Settlement measures the attempt in the store's clock, but our clock sets the JWT
            // expiry that bounds when the provider can still mint: ours must not run ahead.
            const currentBounds = issuing ? inBounds() : undefined;
            const clockTolerance =
              issuing && currentBounds && issuing.observedAt !== undefined
                ? clock.wallNow() - issuing.observedAt <= storeClockToleranceMs
                : undefined;
            observe({
              stage: "fence",
              ...(currentBounds !== undefined ? { inBounds: currentBounds } : {}),
              ...(clockTolerance !== undefined ? { clockTolerance } : {}),
            });
            if (!issuing || !currentBounds || clockTolerance === false) {
              observe({ stage: "fence", error: "admission-fenced" });
              throw new Error("preparation-fenced");
            }
          },
          capture(bytes) {
            candidate?.fill(0);
            candidate = bytes;
          },
          refused() {
            refused = true;
          },
        });
      } catch {
        observe({ stage, error: "issuer-error" });
        verified = undefined;
      }

      try {
        observe({ stage: "publication" });
        const outcome = await store.transact(admission.familyId, (row, allocateMaterialVersion) => {
          const attempt = row?.attempts.find(
            (entry) => entry.id === attemptId && sameTokenAdmission(entry.admission, admission),
          );
          if (!attempt || attempt.state === "committed") {
            // A missing durable intent is a repository contract violation, never publication.
            throw new Error("preparation-intent-lost");
          }
          // Keep the original short-circuit order and clock reads; reporting adds no checks.
          const admissionCurrent =
            attempt.state !== "quarantined" ? preparationAdmitted(row, admission) : undefined;
          const currentBounds = admissionCurrent ? inBounds() : undefined;
          observe({
            stage: "publication",
            stale: attempt.stale === true,
            ...(admissionCurrent !== undefined ? { admissionCurrent } : {}),
            ...(currentBounds !== undefined ? { inBounds: currentBounds } : {}),
          });
          if (
            attempt.state === "quarantined" ||
            !admissionCurrent ||
            !currentBounds ||
            !verified ||
            !candidate?.byteLength ||
            !Number.isFinite(verified.providerExpiresAt) ||
            !(verified.usableUntil <= verified.providerExpiresAt) ||
            !(verified.usableUntil > clock.wallNow() + minimumValidityMs)
          ) {
            observe({ stage: "publication", error: "invalid-material" });
            attempt.state = "quarantined";
            if (candidate) {
              attempt.candidate = Uint8Array.from(candidate);
            } else if (refused) {
              // The provider answered this attempt's one request without a token: terminal.
              attempt.notIssued = true;
            }
            return "quarantined" as const;
          }
          const materialVersion = allocateMaterialVersion();
          row!.committed = {
            admission: structuredClone(admission),
            attemptId,
            materialVersion,
            providerExpiresAt: verified.providerExpiresAt,
            usableUntil: verified.usableUntil,
            bytes: Uint8Array.from(candidate),
          };
          attempt.state = "committed";
          attempt.materialVersion = materialVersion;
          return "committed" as const;
        });
        observe({ stage: "publication", publication: outcome });
        return outcome;
      } catch {
        observe({ stage: "publication", error: "store-error", publication: "unknown" });
        // Commit may have succeeded. Only a fresh read can establish warm readiness.
        // The original intent remains non-replayable even if publication did not commit.
        return "quarantined";
      } finally {
        candidate?.fill(0);
      }
    },
  });
}
