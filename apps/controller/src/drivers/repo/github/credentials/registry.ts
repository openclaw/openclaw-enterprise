import { createHash } from "node:crypto";
import type {
  AdmittedRepositoryBinding,
  RepositoryBindingRequest,
} from "@openclaw-enterprise/contracts";
import type { GitHubProfile } from "./types.ts";
import { githubCapabilityPolicy, permissionsForProfile } from "./profiles.ts";
import {
  hasControlCharacter,
  normalizePushRefAllowlist,
} from "../../credentials/client-contracts.ts";

export const GITHUB_REPOSITORY_REGISTRY_MAX_BYTES = 256 * 1024;

export interface GitHubRepositoryRegistration {
  readonly repositoryRef: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly namespaces: readonly Readonly<{
    namespaceId: string;
    profiles: readonly GitHubProfile[];
    pushRefAllowlist?: readonly string[];
  }>[];
}

export interface GitHubRepositoryRegistry {
  readonly version: 1;
  readonly backendId: string;
  readonly providerInstanceId: string;
  readonly appId: string;
  readonly githubInstallationId: string;
  readonly maximumDurationSeconds: number;
  readonly repositories: readonly GitHubRepositoryRegistration[];
}

const selectorPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const backendPattern = /^(?!\s)(?!.*\s$).{1,200}$/;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function invalid(): never {
  throw new Error("invalid-repository-registry");
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, pattern = selectorPattern): string {
  if (typeof value !== "string" || !pattern.test(value) || hasControlCharacter(value)) {
    return invalid();
  }
  return value;
}

function numericId(value: unknown): string {
  const id = text(value, /^[1-9][0-9]{0,15}$/);
  if (!Number.isSafeInteger(Number(id))) {
    return invalid();
  }
  return id;
}

function profile(value: unknown): GitHubProfile {
  if (value !== "git-read" && value !== "git-write" && value !== "git-full") {
    return invalid();
  }
  return value;
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    return invalid();
  }
  return value;
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    invalid();
  }
}

/** The same immutable nonsecret authority is loaded by API, worker, and service. */
export function validateGitHubRepositoryRegistry(
  value: unknown,
  expectedBackendId?: string,
): GitHubRepositoryRegistry {
  const root = object(value, [
    "version",
    "backendId",
    "providerInstanceId",
    "appId",
    "githubInstallationId",
    "maximumDurationSeconds",
    "repositories",
  ]);
  const backendId = text(root.backendId, backendPattern);
  if (root.version !== 1 || (expectedBackendId !== undefined && backendId !== expectedBackendId)) {
    return invalid();
  }
  const maximumDurationSeconds = root.maximumDurationSeconds;
  if (
    typeof maximumDurationSeconds !== "number" ||
    !Number.isSafeInteger(maximumDurationSeconds) ||
    maximumDurationSeconds < 1 ||
    maximumDurationSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
  ) {
    return invalid();
  }
  let namespaceRows = 0;
  const repositories = array(root.repositories, 1000).map((candidate) => {
    const entry = object(candidate, ["repositoryRef", "repositoryId", "repository", "namespaces"]);
    const namespaces = array(entry.namespaces, 128).map((candidatePolicy) => {
      const policy = object(candidatePolicy, ["namespaceId", "profiles", "pushRefAllowlist"]);
      const profiles = array(policy.profiles, 3).map(profile).sort();
      unique(profiles);
      let pushRefAllowlist: readonly string[] | undefined;
      if (Object.hasOwn(policy, "pushRefAllowlist")) {
        try {
          pushRefAllowlist = normalizePushRefAllowlist(policy.pushRefAllowlist);
        } catch {
          return invalid();
        }
      }
      namespaceRows += 1;
      return Object.freeze({
        namespaceId: text(policy.namespaceId),
        profiles: Object.freeze(profiles),
        ...(pushRefAllowlist === undefined ? {} : { pushRefAllowlist }),
      });
    });
    unique(namespaces.map((policy) => policy.namespaceId));
    namespaces.sort((a, b) => a.namespaceId.localeCompare(b.namespaceId, "en"));
    const repository = text(entry.repository, repositoryPattern).toLowerCase();
    if (repository.includes("..")) {
      return invalid();
    }
    return Object.freeze({
      repositoryRef: text(entry.repositoryRef),
      repositoryId: numericId(entry.repositoryId),
      repository,
      namespaces: Object.freeze(namespaces),
    });
  });
  if (namespaceRows > 4096) {
    return invalid();
  }
  unique(repositories.map((entry) => entry.repositoryRef));
  unique(repositories.map((entry) => entry.repositoryId));
  unique(repositories.map((entry) => entry.repository));
  repositories.sort((a, b) => a.repositoryRef.localeCompare(b.repositoryRef, "en"));
  return Object.freeze({
    version: 1,
    backendId,
    providerInstanceId: text(root.providerInstanceId),
    appId: numericId(root.appId),
    githubInstallationId: numericId(root.githubInstallationId),
    maximumDurationSeconds,
    repositories: Object.freeze(repositories),
  });
}

export function resolveGitHubRepositoryBinding(
  registry: GitHubRepositoryRegistry,
  input: RepositoryBindingRequest & { readonly namespaceId: string },
): AdmittedRepositoryBinding {
  const request = object(input, ["namespaceId", "repositoryRef", "profile"]);
  const namespaceId = text(request.namespaceId);
  const repositoryRef = text(request.repositoryRef);
  const selectedProfile = profile(request.profile === undefined ? "git-write" : request.profile);
  const repository = registry.repositories.find((entry) => entry.repositoryRef === repositoryRef);
  const policy = repository?.namespaces.find((entry) => entry.namespaceId === namespaceId);
  if (!repository || !policy || !policy.profiles.includes(selectedProfile)) {
    throw new Error("repository-binding-not-authorized");
  }
  // Policy changes cannot preserve an earlier grant merely by retaining an operator label.
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: registry.version,
        backendId: registry.backendId,
        providerInstanceId: registry.providerInstanceId,
        appId: registry.appId,
        githubInstallationId: registry.githubInstallationId,
        maximumDurationSeconds: registry.maximumDurationSeconds,
        repositoryRef,
        repositoryId: repository.repositoryId,
        repository: repository.repository,
        namespaceId,
        allowedProfiles: policy.profiles,
        ...(policy.pushRefAllowlist === undefined
          ? {}
          : { pushRefAllowlist: policy.pushRefAllowlist }),
        profile: selectedProfile,
        permissions: permissionsForProfile(selectedProfile),
        capabilityPolicy: githubCapabilityPolicy,
      }),
    )
    .digest("hex");
  return Object.freeze({
    repositoryRef,
    profile: selectedProfile,
    backendId: registry.backendId,
    grant: Object.freeze({
      providerInstanceId: registry.providerInstanceId,
      repositoryId: repository.repositoryId,
      grantId: `sha256:${fingerprint}`,
    }),
  });
}
