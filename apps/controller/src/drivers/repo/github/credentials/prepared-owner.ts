import type { Clock } from "../../credentials/backend-contracts.ts";
import type { GitHubKeyOwner } from "./types.ts";
import type { GitHubPreparationAdmission, GitHubPreparationStore } from "./prepared-contracts.ts";
import { createTokenPreparation } from "../../../../backends/token-service/preparation.ts";
import {
  parseInstallationTokenResponse,
  validateInstallationTokenResponse,
} from "./driver/acquisition-response.ts";
import { preparationIssuerAuthority } from "./grants.ts";
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
    grant.profile === "github-installation"
      ? { profile: grant.profile }
      : {
          repositoryId: grant.repositoryId,
          repository: grant.repository,
          permissions: permissionsForProfile(grant.profile),
        };

  return createTokenPreparation({
    admission,
    store,
    clock,
    renewBeforeMs,
    minimumValidityMs,
    async issue({ bounds, assertIssuing, capture, refused }) {
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
        );
        response.body.fill(0);
        assertCurrent();
        assertAdmitted();
      });
      return verified;
    },
  });
}
