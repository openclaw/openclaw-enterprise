import { retireToken } from "../../../../backends/token-service/retirement.ts";
import type { Clock } from "../../credentials/backend-contracts.ts";
import type { PreparedGitHubPostgres } from "./prepared-postgres.ts";
import { createProviderTransport, type ProviderAttempt } from "./provider-transport.ts";

/** Retirement is shared by both background owners. An ambiguous attempt is never replayed. */
export async function retirePreparedGitHubToken(
  repository: Pick<PreparedGitHubPostgres, "takeRetirement" | "finishRetirement">,
  familyId: string | null,
  outer: AbortSignal,
  apiOrigin: string,
  ca: Uint8Array | undefined,
  clock: Clock,
) {
  const result = await retireToken(repository, familyId, async ({ bytes, admission: a }) => {
    const signal = AbortSignal.any([outer, AbortSignal.timeout(25_000)]);
    const assertAdmitted = () => signal.throwIfAborted();
    const attempt: ProviderAttempt = {
      signal,
      deadlineMonoMs: clock.monotonicNow() + 25_000,
      assertAdmitted,
      observeDispatch: assertAdmitted,
    };
    const response = await createProviderTransport(apiOrigin, ca, clock, a.grant).revoke(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(),
      attempt,
      () => {},
    );
    response.body.fill(0);
    return response.status === 204;
  });
  if (result === "unknown") {
    throw new Error("Prepared GitHub token revocation is unconfirmed.");
  }
  return result;
}
