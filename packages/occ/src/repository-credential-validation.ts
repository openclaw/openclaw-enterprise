import type {
  AdmittedRepositoryBinding,
  RepositoryAccess,
  RepositoryRevisionState,
  SourceBackedRepositoryRevisionState,
} from "@openclaw-enterprise/contracts";
import { isInstallationRepositoryProfile } from "@openclaw-enterprise/contracts";
import { hasControlCharacter, immutableCopy } from "@openclaw-enterprise/utils";
import { ScopeViolationError } from "./errors.ts";

const token = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const backendIdentifier = /^(?!\s)(?!.*\s$).{1,200}$/;
const credentialClientIdentifier =
  /^ccr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function boundedToken(value: unknown): value is string {
  return typeof value === "string" && token.exec(value)?.[0] === value;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function opaqueIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    Buffer.from(value, "utf8").toString("utf8") === value &&
    !hasControlCharacter(value)
  );
}

function selection(value: unknown, admitted: boolean): boolean {
  if (
    !exactObject(
      value,
      admitted ? ["repositoryRef", "profile", "backendId", "grant"] : ["repositoryRef", "profile"],
    ) ||
    !boundedToken(value.repositoryRef) ||
    !boundedToken(value.profile)
  ) {
    return false;
  }
  return (
    !admitted ||
    (typeof value.backendId === "string" &&
      backendIdentifier.test(value.backendId) &&
      !hasControlCharacter(value.backendId) &&
      Buffer.from(value.backendId, "utf8").toString("utf8") === value.backendId &&
      exactObject(value.grant, ["providerInstanceId", "repositoryId", "grantId"]) &&
      opaqueIdentity(value.grant.providerInstanceId) &&
      opaqueIdentity(value.grant.repositoryId) &&
      opaqueIdentity(value.grant.grantId))
  );
}

function bindingArray(value: unknown, admitted: boolean): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    return false;
  }
  const refs = new Set<string>();
  for (const binding of value) {
    if (!selection(binding, admitted) || refs.has(binding.repositoryRef)) {
      return false;
    }
    refs.add(binding.repositoryRef);
  }
  return true;
}

export function validRepositoryAccess(value: unknown): value is RepositoryAccess {
  const hasClient =
    value !== null && typeof value === "object" && Object.hasOwn(value, "githubAppClientId");
  if (
    !exactObject(value, [
      "defaultProfile",
      "repositories",
      ...(hasClient ? ["githubAppClientId"] : []),
    ]) ||
    !boundedToken(value.defaultProfile) ||
    isInstallationRepositoryProfile(value.defaultProfile) ||
    (hasClient &&
      (typeof value.githubAppClientId !== "string" ||
        credentialClientIdentifier.exec(value.githubAppClientId)?.[0] !== value.githubAppClientId ||
        value.defaultProfile !== "github-repository")) ||
    !Array.isArray(value.repositories) ||
    value.repositories.length > 16
  ) {
    return false;
  }
  const seen = new Set<string>();
  return value.repositories.every((entry: unknown) => {
    if (entry === null || typeof entry !== "object") {
      return false;
    }
    const hasProfile = Object.hasOwn(entry, "profile");
    const hasAccess = Object.hasOwn(entry, "access");
    const keys = [
      "repositoryRef",
      ...(hasProfile ? ["profile"] : []),
      ...(hasAccess ? ["access"] : []),
    ];
    if (
      !exactObject(entry, keys) ||
      !boundedToken(entry.repositoryRef) ||
      (hasProfile && !boundedToken(entry.profile)) ||
      (hasClient
        ? !hasAccess ||
          (entry.access !== "read" && entry.access !== "write") ||
          (entry.profile ?? value.defaultProfile) !== "github-repository"
        : hasAccess) ||
      seen.has(entry.repositoryRef)
    ) {
      return false;
    }
    seen.add(entry.repositoryRef);
    return true;
  });
}

export function normalizedRepositoryAccess(value: unknown): RepositoryAccess | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!validRepositoryAccess(value)) {
    throw new ScopeViolationError("The Agent repository access is invalid.");
  }
  return immutableCopy(value);
}

export function validAdmittedRepositoryBindings(
  value: unknown,
): value is readonly AdmittedRepositoryBinding[] {
  return bindingArray(value, true);
}

/** Mirrors the database's closed, material-free immutable snapshot shape. */
export function validRepositoryRevisionState(
  value: unknown,
): value is RepositoryRevisionState | SourceBackedRepositoryRevisionState {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const sourceBacked = Object.hasOwn(value, "authorization");
  if (
    !exactObject(value, [
      "driver",
      "bindings",
      ...(sourceBacked ? ["authorization"] : ["deadlineWallMs"]),
      ...(Object.hasOwn(value, "standingApprovalId") && !sourceBacked
        ? ["standingApprovalId", "standingApprovalGeneration", "standingApprovalScopeFingerprint"]
        : []),
    ]) ||
    !exactObject(value.driver, ["id", "implementation"]) ||
    !opaqueIdentity(value.driver.id) ||
    !opaqueIdentity(value.driver.implementation) ||
    !validAdmittedRepositoryBindings(value.bindings)
  ) {
    return false;
  }
  if (sourceBacked) {
    return value.authorization === "credential_source";
  }
  return (
    (!Object.hasOwn(value, "standingApprovalId") ||
      (boundedToken(value.standingApprovalId) &&
        typeof value.standingApprovalScopeFingerprint === "string" &&
        /^[0-9a-f]{64}$/.test(value.standingApprovalScopeFingerprint) &&
        Number.isSafeInteger(value.standingApprovalGeneration) &&
        Number(value.standingApprovalGeneration) > 0 &&
        Array.isArray(value.bindings) &&
        value.bindings.length === 1)) &&
    typeof value.deadlineWallMs === "number" &&
    Number.isSafeInteger(value.deadlineWallMs) &&
    value.deadlineWallMs > 0
  );
}
