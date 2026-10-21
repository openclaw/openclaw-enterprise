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
}

interface PreparationOptions<A extends TokenAdmission> {
  readonly admission: A;
  readonly store: TokenPreparationStore<A>;
  readonly clock: { monotonicNow(): number; wallNow(): number };
  readonly renewBeforeMs: number;
  readonly minimumValidityMs: number;
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
      const inBounds = () => !bounds.signal.aborted && clock.monotonicNow() < bounds.deadlineMonoMs;
      if (!attemptId || !inBounds()) {
        return "blocked";
      }
      try {
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
        // The durable uncertainty marker may have committed. Do not issue or retry.
        return "quarantined";
      }

      let candidate: Uint8Array | undefined;
      let verified: { providerExpiresAt: number; usableUntil: number } | undefined;
      try {
        verified = await options.issue({
          attemptId,
          bounds,
          // The issuer might await its signing input before this check. Recovery could have
          // fenced this attempt in the meantime. Publication must independently recheck it.
          async assertIssuing() {
            const issuing = await store.readCurrent(
              admission.familyId,
              (row) =>
                preparationAdmitted(row, admission) &&
                row.attempts.some(
                  (entry) =>
                    entry.id === attemptId &&
                    entry.state === "issuing" &&
                    sameTokenAdmission(entry.admission, admission),
                ),
            );
            if (!issuing || !inBounds()) {
              throw new Error("preparation-fenced");
            }
          },
          capture(bytes) {
            candidate?.fill(0);
            candidate = bytes;
          },
        });
      } catch {
        verified = undefined;
      }

      try {
        return await store.transact(admission.familyId, (row, allocateMaterialVersion) => {
          const attempt = row?.attempts.find(
            (entry) => entry.id === attemptId && sameTokenAdmission(entry.admission, admission),
          );
          if (!attempt || attempt.state === "committed") {
            // A missing durable intent is a repository contract violation, never publication.
            throw new Error("preparation-intent-lost");
          }
          if (
            attempt.state === "quarantined" ||
            !preparationAdmitted(row, admission) ||
            !inBounds() ||
            !verified ||
            !candidate?.byteLength ||
            !Number.isFinite(verified.providerExpiresAt) ||
            !(verified.usableUntil <= verified.providerExpiresAt) ||
            !(verified.usableUntil > clock.wallNow() + minimumValidityMs)
          ) {
            attempt.state = "quarantined";
            if (candidate) {
              attempt.candidate = Uint8Array.from(candidate);
            }
            return "quarantined" as const;
          }
          const materialVersion = allocateMaterialVersion();
          row.committed = {
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
      } catch {
        // Commit may have succeeded. Only a fresh read can establish warm readiness.
        // The original intent remains non-replayable even if publication did not commit.
        return "quarantined";
      } finally {
        candidate?.fill(0);
      }
    },
  });
}
