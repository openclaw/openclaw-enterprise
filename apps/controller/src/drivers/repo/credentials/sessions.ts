import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AuthorityIdentity, Clock, SessionRef } from "./backend-contracts.ts";
import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import { hasControlCharacter } from "./client-contracts.ts";
import type {
  RepositoryCredentialSessionInput,
  RepositoryCredentialBoundSessionInput,
} from "./service-contracts.ts";

export interface SessionAdmission {
  readonly ref: SessionRef;
  readonly authority: AuthorityIdentity;
  readonly bearer: string;
  readonly digest: string;
  readonly binding: RepositoryCredentialGrantIdentity;
  readonly deadlineWallMs: number;
  readonly deadlineMonoMs: number;
}

export function bearerDigest(bearer: string): string | undefined {
  if (typeof bearer !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(bearer)) {
    return undefined;
  }
  return createHash("sha256").update(bearer).digest("hex");
}

export function snapshotBinding(
  binding: RepositoryCredentialGrantIdentity,
): RepositoryCredentialGrantIdentity {
  const { providerInstanceId, repositoryId, grantId } = binding;
  for (const value of [providerInstanceId, repositoryId, grantId]) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value) > 512 ||
      hasControlCharacter(value)
    ) {
      throw new Error("INVALID_BINDING");
    }
  }
  return Object.freeze({ providerInstanceId, repositoryId, grantId });
}

export type SessionInput = RepositoryCredentialSessionInput | RepositoryCredentialBoundSessionInput;

export function isBoundInput(input: SessionInput): input is RepositoryCredentialBoundSessionInput {
  return "namespaceId" in input;
}

/** Copy semantic admission inputs; lookup-only is a control operation, not authority. */
export function snapshotSessionInput(value: unknown): SessionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_ADMISSION");
  }
  const input = value as Record<string, unknown>;
  const boundFields = [
    "namespaceId",
    "repositoryRef",
    "expectedBinding",
    "deadlineWallMs",
    "recoverOnly",
    "durableAdmission",
  ];
  const bound = boundFields.some((field) => Object.hasOwn(input, field));
  const allowed = bound
    ? ["durationSeconds", "profile", ...boundFields]
    : ["durationSeconds", "profile"];
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    !Number.isSafeInteger(input.durationSeconds) ||
    typeof input.durationSeconds !== "number" ||
    input.durationSeconds <= 0 ||
    (input.profile !== undefined &&
      (typeof input.profile !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.profile)))
  ) {
    throw new Error("INVALID_ADMISSION");
  }
  if (!bound) {
    return Object.freeze({
      durationSeconds: input.durationSeconds,
      profile: input.profile as string | undefined,
    });
  }
  if (
    typeof input.namespaceId !== "string" ||
    input.namespaceId.length === 0 ||
    Buffer.byteLength(input.namespaceId) > 512 ||
    hasControlCharacter(input.namespaceId) ||
    typeof input.repositoryRef !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.repositoryRef) ||
    typeof input.profile !== "string" ||
    typeof input.deadlineWallMs !== "number" ||
    !Number.isSafeInteger(input.deadlineWallMs) ||
    input.deadlineWallMs <= 0 ||
    (input.recoverOnly !== undefined && input.recoverOnly !== true) ||
    (input.durableAdmission !== undefined && input.durableAdmission !== true) ||
    !input.expectedBinding ||
    typeof input.expectedBinding !== "object" ||
    Array.isArray(input.expectedBinding) ||
    Object.keys(input.expectedBinding).some(
      (key) => !["providerInstanceId", "repositoryId", "grantId"].includes(key),
    )
  ) {
    throw new Error("INVALID_ADMISSION");
  }
  return Object.freeze({
    durationSeconds: input.durationSeconds,
    profile: input.profile,
    namespaceId: input.namespaceId,
    repositoryRef: input.repositoryRef,
    expectedBinding: snapshotBinding(input.expectedBinding as RepositoryCredentialGrantIdentity),
    deadlineWallMs: input.deadlineWallMs,
  });
}

export function sameBinding(
  left: RepositoryCredentialGrantIdentity,
  right: RepositoryCredentialGrantIdentity,
): boolean {
  return (
    left.providerInstanceId === right.providerInstanceId &&
    left.repositoryId === right.repositoryId &&
    left.grantId === right.grantId
  );
}

export function sameSessionInput(left: SessionInput, right: SessionInput): boolean {
  if (left.durationSeconds !== right.durationSeconds || left.profile !== right.profile) {
    return false;
  }
  if (!isBoundInput(left)) {
    return !isBoundInput(right);
  }
  return (
    isBoundInput(right) &&
    left.namespaceId === right.namespaceId &&
    left.repositoryRef === right.repositoryRef &&
    left.deadlineWallMs === right.deadlineWallMs &&
    sameBinding(left.expectedBinding, right.expectedBinding)
  );
}

export function admitSession(
  binding: RepositoryCredentialGrantIdentity,
  deadlineWallMs: number,
  clock: Clock,
): SessionAdmission {
  const remainingMs = deadlineWallMs - clock.wallNow();
  if (!Number.isSafeInteger(deadlineWallMs) || remainingMs <= 0) {
    throw new Error("INVALID_DEADLINE");
  }
  const deadlineMonoMs = clock.monotonicNow() + remainingMs;
  const bearer = randomBytes(32).toString("base64url");
  const sessionId = randomUUID();
  const immutableBinding = snapshotBinding(binding);
  const authority: AuthorityIdentity = Object.freeze({ ...immutableBinding, sessionId });
  const ref = Object.freeze({}) as SessionRef;
  return {
    ref,
    authority,
    bearer,
    digest: bearerDigest(bearer)!,
    binding: immutableBinding,
    deadlineWallMs,
    deadlineMonoMs,
  };
}
