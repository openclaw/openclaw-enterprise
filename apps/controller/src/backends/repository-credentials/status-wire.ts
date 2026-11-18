import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import { isRepositoryCredentialIdentity } from "../../drivers/repo/access/grant-identity.ts";

/** Identical private JSON primitives; each boundary owns its failure diagnostic. */
export function createStatusWirePrimitives(invalid: () => never) {
  function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.includes(key)) ||
      fields.some((key) => !Object.hasOwn(value, key))
    ) {
      return invalid();
    }
    return value as Record<string, unknown>;
  }

  function identity(value: unknown): string {
    if (!isRepositoryCredentialIdentity(value)) {
      return invalid();
    }
    return value;
  }

  function counter(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return invalid();
    }
    return value;
  }

  function parseCleanup(value: unknown) {
    const parsed = object(value, [
      "active",
      "pending",
      "revoked",
      "expired",
      "uncertain",
      "auxiliaryPending",
    ]);
    if (typeof parsed.auxiliaryPending !== "boolean") {
      return invalid();
    }
    return {
      active: counter(parsed.active),
      pending: counter(parsed.pending),
      revoked: counter(parsed.revoked),
      expired: counter(parsed.expired),
      uncertain: counter(parsed.uncertain),
      auxiliaryPending: parsed.auxiliaryPending,
    };
  }

  function sessionStatusObject(value: unknown): Record<string, unknown> {
    return object(value, [
      "sessionId",
      "state",
      "deadlineWallMs",
      "binding",
      "activeUses",
      "cleanup",
    ]);
  }

  function grantIdentityObject(value: unknown): Record<string, unknown> {
    return object(value, ["providerInstanceId", "repositoryId", "grantId"]);
  }

  function projectGrantIdentity(
    parsed: Record<string, unknown>,
  ): RepositoryCredentialGrantIdentity {
    return {
      providerInstanceId: identity(parsed.providerInstanceId),
      repositoryId: identity(parsed.repositoryId),
      grantId: identity(parsed.grantId),
    };
  }

  return {
    object,
    identity,
    counter,
    parseCleanup,
    sessionStatusObject,
    grantIdentityObject,
    projectGrantIdentity,
  };
}
