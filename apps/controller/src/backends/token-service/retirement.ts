import type { TokenAdmission } from "./custody.ts";

interface RetirementCandidate<A> {
  id: string;
  admission: A;
  bytes: Uint8Array;
}

/** Taking custody durably records possible dispatch. Neither a lost claim nor an uncertain
 * retirement can be replayed. A store may separately establish expiry without claiming revocation. */
export async function retireToken<A extends TokenAdmission>(
  store: {
    takeRetirement(
      familyId: string | null,
    ): Promise<RetirementCandidate<A> | "issuer-mismatch" | undefined>;
    finishRetirement(attemptId: string, revoked: boolean): Promise<void>;
  },
  familyId: string | null,
  revoke: (candidate: RetirementCandidate<A>) => Promise<boolean>,
) {
  const candidate = await store.takeRetirement(familyId);
  if (!candidate || candidate === "issuer-mismatch") {
    return candidate ?? "idle";
  }
  let revoked = false;
  let revocationFailure: { error: unknown } | undefined;
  try {
    revoked = await revoke(candidate);
  } catch (error) {
    revocationFailure = { error };
  }
  candidate.bytes.fill(0);
  try {
    await store.finishRetirement(candidate.id, revoked);
  } catch (error) {
    if (!revocationFailure) {
      throw error;
    }
    revocationFailure.error = new Error("Token revocation and retirement settlement both failed.");
  }
  if (revocationFailure) {
    throw revocationFailure.error;
  }
  return revoked ? ("retired" as const) : ("unknown" as const);
}
