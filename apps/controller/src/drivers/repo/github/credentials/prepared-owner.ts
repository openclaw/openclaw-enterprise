import type { AttemptContext, Clock } from "../../credentials/backend-contracts.ts";
import type { GitHubKeyOwner } from "./types.ts";
import type { GitHubPreparationAdmission, GitHubPreparationStore } from "./prepared-contracts.ts";
import { createTokenPreparation } from "../../../../backends/token-service/preparation.ts";
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
  if (admission.issuerAuthority !== preparationIssuerAuthority(options.apiOrigin, options.ca)) {
    throw new Error("prepared-issuer-authority-mismatch");
  }
  const exchange = createProviderTransport(options.apiOrigin, options.ca, clock, admission.grant);
  const permissions = permissionsForProfile(admission.grant.profile);

  return createTokenPreparation({
    admission,
    store,
    clock,
    renewBeforeMs,
    minimumValidityMs,
    async issue({ attemptId, bounds, assertIssuing, capture }) {
      let verified: { providerExpiresAt: number; usableUntil: number } | undefined;
      const key = await getKey(structuredClone(admission));
      const assertAdmitted = () => {
        if (bounds.signal.aborted || clock.monotonicNow() >= bounds.deadlineMonoMs) {
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
      return verified;
    },
  });
}
