import type {
  GitHubPreparationAdmission,
  GitHubPreparedReadPort,
  GitHubPreparedMaterial,
} from "./prepared-contracts.ts";
import { preparationAdmitted, samePreparationAdmission } from "./prepared-contracts.ts";

export type GitHubWarmResult =
  Readonly<{ kind: "not_ready" }> | Readonly<{ kind: "warm"; material: GitHubPreparedMaterial }>;

/** Trusted Resolver-only facet. Returned bytes belong to custody and must be wiped. */
export function createGitHubWarmReader(store: GitHubPreparedReadPort, wallNow: () => number) {
  return Object.freeze({
    async readWarm(
      target: GitHubPreparationAdmission,
      minimumValidityMs = 0,
    ): Promise<GitHubWarmResult> {
      if (!Number.isFinite(minimumValidityMs) || minimumValidityMs < 0) {
        return { kind: "not_ready" };
      }
      const admission = structuredClone(target);
      const eligible = (usableUntil: number) => {
        const now = wallNow();
        return Number.isFinite(now) && usableUntil > now + minimumValidityMs;
      };
      // Keep custody across the read: its receipt can be lost after select has run.
      let owned: GitHubPreparedMaterial | undefined;
      try {
        const result = await store.readCurrent(admission.familyId, (row): GitHubWarmResult => {
          if (!preparationAdmitted(row, admission)) {
            return { kind: "not_ready" };
          }
          const material = row.committed;
          if (
            !material ||
            !samePreparationAdmission(material.admission, admission) ||
            !material.materialVersion ||
            !Number.isFinite(material.providerExpiresAt) ||
            !Number.isFinite(material.usableUntil) ||
            material.usableUntil > material.providerExpiresAt ||
            !eligible(material.usableUntil) ||
            !row.attempts.some(
              (attempt) =>
                attempt.id === material.attemptId &&
                attempt.state === "committed" &&
                attempt.materialVersion === material.materialVersion &&
                samePreparationAdmission(attempt.admission, admission),
            )
          ) {
            return { kind: "not_ready" };
          }
          owned = structuredClone(material);
          return { kind: "warm", material: owned };
        });
        // Expiry keeps advancing after linearization, e.g. while a database read is in transit.
        // The Resolver must still authorize use and check usability at the actual send.
        if (result.kind === "warm" && result.material === owned && eligible(owned.usableUntil)) {
          owned = undefined; // The caller now owns these live bytes.
          return result;
        }
      } catch {
        // An unavailable read receipt or clock cannot release a warm selection.
      } finally {
        owned?.bytes.fill(0);
      }
      return { kind: "not_ready" };
    },
  });
}
