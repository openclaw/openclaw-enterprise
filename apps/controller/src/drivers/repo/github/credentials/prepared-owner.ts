import type { Clock } from "../../credentials/backend-contracts.ts";
import type { GitHubKeyOwner } from "./types.ts";
import type { GitHubPreparationAdmission, GitHubPreparationStore } from "./prepared-contracts.ts";
import {
  createTokenPreparation,
  type TokenPreparationObservation,
} from "../../../../backends/token-service/preparation.ts";
import type { GitHubPreparationDiagnostic, ProviderObservation } from "./provider-diagnostics.ts";
import {
  parseInstallationTokenResponse,
  validateInstallationTokenResponse,
} from "./installation-token-response.ts";
import { preparationIssuerAuthority } from "./origin.ts";
import { permissionsForProfile } from "./profiles.ts";
import { createProviderTransport, type ProviderAttempt } from "./provider-transport.ts";

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
  readonly observe?: (diagnostic: GitHubPreparationDiagnostic) => void;
}

/**
 * One background worker owner, invoked independently of requests/provisioning.
 */
export function createGitHubPreparationOwner(options: PreparationOptions) {
  const { store, clock, getKey, renewBeforeMs, minimumValidityMs } = options;
  const admission = structuredClone(options.admission);
  if (admission.issuerAuthority !== preparationIssuerAuthority(options.apiOrigin, options.ca)) {
    throw new Error("prepared-issuer-authority-mismatch");
  }
  const { grant } = admission;
  const exchange = createProviderTransport(options.apiOrigin, options.ca, clock, grant);
  const scope =
    grant.profile === "github-repository"
      ? { profile: grant.profile, repositories: grant.repositories, permissions: grant.permissions }
      : grant.profile === "github-installation"
        ? { profile: grant.profile }
        : {
            repositoryId: grant.repositoryId,
            repository: grant.repository,
            permissions: permissionsForProfile(grant.profile),
          };

  type Observation = Omit<TokenPreparationObservation, "attemptId"> | ProviderObservation;
  type Snapshot = Partial<Omit<GitHubPreparationDiagnostic, "attemptId" | "outcome">>;
  const snapshots = new Map<string, Snapshot>();
  const observe = (attemptId: string, observation: Observation) => {
    const snapshot = snapshots.get(attemptId);
    if (!snapshot) {
      return;
    }
    const { error, ...fields } = observation;
    Object.assign(snapshot, fields);
    if (observation.stage === "request-end-called") {
      Object.assign(snapshot, { requestEndCalled: true });
    }
    if (error && snapshot.firstFailureStage === undefined) {
      Object.assign(snapshot, { firstFailureStage: observation.stage, error });
    }
  };
  const preparation = createTokenPreparation({
    admission,
    store,
    clock,
    renewBeforeMs,
    minimumValidityMs,
    observe: ({ attemptId, ...observation }) => observe(attemptId, observation),
    async issue({ attemptId, bounds, assertIssuing, capture, refused }) {
      let verified: { providerExpiresAt: number; usableUntil: number } | undefined;
      const key = await getKey(structuredClone(admission));
      const assertAdmitted = () => {
        if (bounds.signal.aborted || clock.monotonicNow() >= bounds.deadlineMonoMs) {
          throw new Error("preparation-expired");
        }
      };
      const attempt: ProviderAttempt = {
        ...bounds,
        assertAdmitted,
        observeDispatch: assertAdmitted,
      };
      await key.withJwt(async (jwt, assertCurrent) => {
        await assertIssuing();
        const response = await exchange.issue(
          jwt,
          attempt,
          () => {},
          assertCurrent,
          (response) => {
            // Capture before transport close: a late/lost response still has a cleanup owner.
            const { packet, token } = parseInstallationTokenResponse(response.body);
            const candidate = token === undefined ? undefined : Buffer.from(token);
            if (candidate) {
              capture(candidate);
            }
            const result = validateInstallationTokenResponse(
              response.status,
              packet,
              candidate,
              clock.wallNow(),
              {
                ...scope,
                minimumValidityMs,
              },
            );
            observe(attemptId, {
              stage: "validation",
              candidateIdentified: candidate !== undefined,
              validationKind: result.kind,
              ...("code" in result ? { validationCode: result.code } : {}),
              ...(result.kind !== "validated" ? { error: "validation-failed" } : {}),
            });
            if (result.kind === "validated") {
              verified = result;
            } else if (
              result.kind === "reauthorization-required" &&
              packet !== undefined &&
              !Object.hasOwn(packet, "token")
            ) {
              // GitHub refused (401/403/404/422) the one request, and its well-formed answer
              // has no token member. A malformed or ambiguous answer stays uncertain.
              refused();
            }
          },
          (observation) => observe(attemptId, observation),
        );
        response.body.fill(0);
        assertCurrent();
        assertAdmitted();
      });
      return verified;
    },
  });
  return Object.freeze({
    async run(attemptId: string, bounds: Parameters<typeof preparation.run>[1]) {
      const snapshot: Snapshot = { stage: "intent", requestEndCalled: false };
      snapshots.set(attemptId, snapshot);
      try {
        const outcome = await preparation.run(attemptId, bounds);
        try {
          // Readiness/blocked checks have no new durable attempt to diagnose.
          if (snapshot.stage !== "intent" || snapshot.error !== undefined) {
            options.observe?.({
              ...snapshot,
              stage: snapshot.stage ?? "intent",
              attemptId,
              outcome,
            });
          }
        } catch {
          // Logging failures cannot alter the original result or token custody.
        }
        return outcome;
      } finally {
        snapshots.delete(attemptId);
      }
    },
  });
}
