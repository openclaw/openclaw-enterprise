import type { AttemptContext, Bounds, Clock } from "../../credentials/backend-contracts.ts";
import type { GitHubKeyOwner } from "./types.ts";
import type { GitHubPreparationAdmission, GitHubPreparationStore } from "./prepared-contracts.ts";
import { preparationAdmitted, samePreparationAdmission } from "./prepared-contracts.ts";
import {
  parseInstallationTokenResponse,
  validateInstallationTokenResponse,
} from "./driver/acquisition-response.ts";
import { preparationIssuerAuthority } from "./grants.ts";
import { permissionsForProfile } from "./profiles.ts";
import { createProviderTransport } from "./provider-transport.ts";

interface PreparationOptions {
  readonly admission: GitHubPreparationAdmission;
  readonly store: GitHubPreparationStore;
  readonly clock: Clock;
  /** Trusted retrieval of the exact admitted App/input version; never a fallback. */
  readonly getKey: (admission: GitHubPreparationAdmission) => Promise<GitHubKeyOwner>;
  readonly apiOrigin: string;
  readonly ca?: Uint8Array;
  readonly renewBeforeMs: number;
  readonly minimumValidityMs: number;
}

/**
 * One background worker owner, invoked independently of requests/provisioning.
 */
export function createGitHubPreparationOwner(options: PreparationOptions) {
  const { store, clock, getKey, renewBeforeMs, minimumValidityMs } = options;
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
  if (admission.issuerAuthority !== preparationIssuerAuthority(options.apiOrigin, options.ca)) {
    throw new Error("prepared-issuer-authority-mismatch");
  }
  const exchange = createProviderTransport(options.apiOrigin, options.ca, clock, admission.grant);
  const permissions = permissionsForProfile(admission.grant.profile);

  return Object.freeze({
    async run(
      attemptId: string,
      bounds: Bounds,
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
            samePreparationAdmission(row.committed.admission, admission) &&
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
        const key = await getKey(structuredClone(admission));
        const assertAdmitted = () => {
          if (!inBounds()) {
            throw new Error("preparation-expired");
          }
        };
        const attempt: AttemptContext = {
          ...bounds,
          id: attemptId,
          action: "acquire",
          authority: {
            sessionId: admission.familyId,
            providerInstanceId: admission.grant.appId,
            repositoryId: admission.grant.repositoryId,
            grantId: admission.grant.id,
          },
          assertAdmitted,
          observeDispatch: assertAdmitted,
        };
        await key.withJwt(async (jwt, assertCurrent) => {
          // Admission of the family alone is insufficient: recovery may have fenced this
          // attempt while we obtained the key. The later publication fence remains necessary
          // because a local transaction cannot be atomic with the provider's issuance.
          const issuing = await store.readCurrent(
            admission.familyId,
            (row) =>
              preparationAdmitted(row, admission) &&
              row.attempts.some(
                (entry) =>
                  entry.id === attemptId &&
                  entry.state === "issuing" &&
                  samePreparationAdmission(entry.admission, admission),
              ),
          );
          if (!issuing || !inBounds()) {
            throw new Error("preparation-fenced");
          }
          const response = await exchange.issue(
            jwt,
            attempt,
            () => {},
            assertCurrent,
            (response) => {
              // Capture before transport close: a late/lost response still has a cleanup owner.
              const { packet, token } = parseInstallationTokenResponse(response.body);
              if (token !== undefined) {
                candidate = Buffer.from(token);
              }
              const result = validateInstallationTokenResponse(
                response.status,
                packet,
                candidate,
                clock.wallNow(),
                {
                  repositoryId: admission.grant.repositoryId,
                  repository: admission.grant.repository,
                  permissions,
                  minimumValidityMs,
                },
              );
              if (result.kind === "validated") {
                verified = result;
              }
            },
          );
          response.body.fill(0);
          assertCurrent();
          assertAdmitted();
        });
      } catch {
        verified = undefined;
      }

      try {
        return await store.transact(admission.familyId, (row, allocateMaterialVersion) => {
          const attempt = row?.attempts.find(
            (entry) =>
              entry.id === attemptId && samePreparationAdmission(entry.admission, admission),
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
            !candidate ||
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
