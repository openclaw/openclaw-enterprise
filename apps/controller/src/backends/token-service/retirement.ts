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
  try {
    revoked = await revoke(candidate);
  } finally {
    candidate.bytes.fill(0);
    await store.finishRetirement(candidate.id, revoked);
  }
  return revoked ? ("retired" as const) : ("unknown" as const);
}
