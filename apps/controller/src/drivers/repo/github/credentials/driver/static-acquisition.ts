import type {
  AcquireOutcome,
  Clock,
  DriverCustody,
  RepositoryBackend,
  RetireOutcome,
} from "../../../credentials/backend-contracts.ts";
import type { GitHubStaticTokenOwner } from "../types.ts";
import type { GitHubDriverState } from "./state.ts";

type StaticAcquisitionDependencies = Readonly<{
  state: GitHubDriverState;
  custody: DriverCustody;
  clock: Clock;
  owner: GitHubStaticTokenOwner;
  leaseMs: number;
}>;

/**
 * Lends the process-owned token into custody for one lease. Every check precedes
 * the borrow, so a refused attempt captures nothing. Nothing is dispatched: the
 * lifecycle can never record an uncertain acquisition for this source.
 */
export function createStaticTokenAcquisition({
  state,
  custody,
  clock,
  owner,
  leaseMs,
}: StaticAcquisitionDependencies): RepositoryBackend["acquire"] {
  return async function acquire(attempt, previous, minimumValidityMs): Promise<AcquireOutcome> {
    if (previous !== undefined && !state.credentials.has(previous)) {
      throw new Error("foreign-credential");
    }
    if (!Number.isFinite(minimumValidityMs) || minimumValidityMs < 0) {
      throw new Error("invalid-validity");
    }
    state.admit(attempt, "acquire");
    try {
      if (state.finalized) {
        return state.outcome(attempt, { kind: "not-dispatched" });
      }
      attempt.assertAdmitted();
      if (attempt.signal.aborted || clock.monotonicNow() >= attempt.deadlineMonoMs) {
        return state.outcome(attempt, { kind: "not-dispatched" });
      }
      if (minimumValidityMs > leaseMs) {
        return state.outcome(attempt, { kind: "rejected", code: "insufficient-validity" });
      }
    } catch {
      return state.outcome(attempt, { kind: "not-dispatched" });
    }
    try {
      return await owner.withToken(async (bytes, assertCurrent) => {
        assertCurrent();
        const observedWallMs = clock.wallNow();
        const expiresAtWallMs = observedWallMs + leaseMs;
        const credential = custody.capture(attempt, bytes, { observedWallMs, expiresAtWallMs });
        state.credentials.set(credential, {
          expiresAt: expiresAtWallMs,
          observedWall: observedWallMs,
          observedMono: clock.monotonicNow(),
          accepted: true,
        });
        return state.outcome(attempt, {
          kind: "acquired",
          credential,
          observedWallMs,
          expiresAtWallMs,
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message === "authority-unavailable") {
        return state.outcome(attempt, {
          kind: "reauthorization-required",
          code: "authority-unavailable",
        });
      }
      return state.outcome(attempt, { kind: "not-dispatched" });
    }
  };
}

/** A static token has no provider retirement; the common owner releases it on expiry. */
export function createUnsupportedRetirement(state: GitHubDriverState): RepositoryBackend["retire"] {
  return async (attempt, credential): Promise<RetireOutcome> => {
    if (!state.credentials.has(credential)) {
      throw new Error("foreign-credential");
    }
    state.admit(attempt, "retire");
    return state.outcome(attempt, { kind: "unsupported" });
  };
}
