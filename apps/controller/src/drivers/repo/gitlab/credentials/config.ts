import {
  hasControlCharacter,
  normalizePushRefAllowlist,
} from "../../credentials/client-contracts.ts";
import { normalizeGitLabProjectPath } from "../request-policy.ts";

/**
 * Development-only static GitLab token authority. It mirrors the GitHub static-token
 * configuration field for field so the same composition and driver factory shape applies.
 */
export interface GitLabTokenConfiguration {
  readonly kind: "gitlab-token";
  readonly providerInstanceId: string;
  readonly configVersion: string;
  readonly projectId: string;
  readonly project: string;
  readonly namespaceId: string;
  readonly tokenFile: string;
  readonly developmentOnly: true;
  /** Enforced at the gateway on receive-pack commands; an empty list denies every push. */
  readonly pushRefAllowlist: readonly string[];
  /** GraphQL is available to write profiles and never to the read profile. */
  readonly allowGraphql: boolean;
  readonly leaseSeconds: number;
}

const allowedFields = [
  "kind",
  "providerInstanceId",
  "configVersion",
  "projectId",
  "project",
  "namespaceId",
  "tokenFile",
  "developmentOnly",
  "pushRefAllowlist",
  "allowGraphql",
  "leaseSeconds",
] as const;

const stringFields = [
  "providerInstanceId",
  "configVersion",
  "projectId",
  "project",
  "tokenFile",
] as const;

function invalid(): never {
  throw new Error("invalid-backend");
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function validConfigVersion(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}

function validProjectId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,15}$/u.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

export function validateGitLabConfiguration(value: unknown): GitLabTokenConfiguration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid();
  }
  const input = value as Record<string, unknown>;
  if (
    input.kind !== "gitlab-token" ||
    Object.keys(input).some((key) => !allowedFields.includes(key as (typeof allowedFields)[number]))
  ) {
    invalid();
  }
  for (const key of stringFields) {
    const field = input[key];
    if (
      typeof field !== "string" ||
      field.length < 1 ||
      field.length > 4096 ||
      hasControlCharacter(field)
    ) {
      invalid();
    }
  }
  const { providerInstanceId, configVersion, projectId, namespaceId } = input as Record<
    string,
    string
  >;
  if (typeof input.project !== "string") {
    invalid();
  }
  const project = input.project;
  if (
    !validIdentifier(providerInstanceId) ||
    !validConfigVersion(configVersion) ||
    !validProjectId(projectId) ||
    !validIdentifier(namespaceId)
  ) {
    invalid();
  }
  let normalizedProject: string;
  try {
    normalizedProject = normalizeGitLabProjectPath(project);
  } catch {
    invalid();
  }
  if (normalizedProject !== project) {
    invalid();
  }
  if (input.developmentOnly !== true) {
    invalid();
  }
  if (input.allowGraphql !== undefined && typeof input.allowGraphql !== "boolean") {
    invalid();
  }
  const leaseSeconds = input.leaseSeconds;
  if (
    typeof leaseSeconds !== "number" ||
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < 900 ||
    leaseSeconds > 86400
  ) {
    invalid();
  }
  let pushRefAllowlist: readonly string[];
  try {
    pushRefAllowlist = normalizePushRefAllowlist(input.pushRefAllowlist);
  } catch {
    invalid();
  }
  return Object.freeze({
    kind: "gitlab-token",
    providerInstanceId: providerInstanceId!,
    configVersion: configVersion!,
    projectId: projectId!,
    project: normalizedProject,
    namespaceId: namespaceId!,
    tokenFile: input.tokenFile as string,
    developmentOnly: true,
    pushRefAllowlist,
    allowGraphql: input.allowGraphql === true,
    leaseSeconds,
  });
}
