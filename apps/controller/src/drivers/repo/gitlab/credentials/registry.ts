import type {
  AdmittedRepositoryBinding,
  RepositoryApprovalScope,
  RepositoryBindingRequest,
} from "@openclaw-enterprise/contracts";
import { normalizeGitLabProjectPath, type GitLabProfile } from "../request-policy.ts";
import { normalizePushRefAllowlist } from "../../credentials/client-contracts.ts";
import { createGitLabGrantIdentity } from "./grants.ts";

/**
 * Installation-approved GitLab.com projects. A caller selects a project by its opaque numeric
 * identity; the registry owns its path, Namespace scope, profiles, and push allowlist. The
 * registry never accepts a host, so the provider origin stays fixed.
 */
export interface GitLabRepositoryRegistration {
  readonly projectId: string;
  readonly path: string;
  readonly displayName?: string;
  readonly namespaces: readonly GitLabRepositoryNamespacePolicy[];
}

export interface GitLabRepositoryNamespacePolicy {
  readonly namespaceId: string;
  readonly profiles: readonly GitLabProfile[];
  readonly pushRefAllowlist: readonly string[];
  readonly allowStandingApproval?: true;
}

export interface GitLabRepositoryRegistry {
  readonly version: 1;
  readonly backendId: string;
  readonly providerInstanceId: string;
  readonly configVersion: string;
  readonly maximumDurationSeconds: number;
  readonly projects: readonly GitLabRepositoryRegistration[];
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const numericIdPattern = /^[1-9][0-9]{0,15}$/u;
const allowedProfiles: readonly GitLabProfile[] = ["git-read", "git-write", "git-full"];

function invalid(): never {
  throw new Error("invalid-repository-registry");
}

function asRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid();
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    invalid();
  }
  return input;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    invalid();
  }
  return value;
}

function numericId(value: unknown): string {
  const id = text(value);
  if (!numericIdPattern.test(id) || !Number.isSafeInteger(Number(id))) {
    invalid();
  }
  return id;
}

function configVersion(value: unknown): string {
  const version = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(version)) {
    invalid();
  }
  return version;
}

function parseProfiles(value: unknown): readonly GitLabProfile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > allowedProfiles.length) {
    invalid();
  }
  const unique = new Set<GitLabProfile>();
  for (const entry of value) {
    if (typeof entry !== "string" || !allowedProfiles.includes(entry as GitLabProfile)) {
      invalid();
    }
    unique.add(entry as GitLabProfile);
  }
  if (unique.size !== value.length) {
    invalid();
  }
  return Object.freeze([...unique]);
}

function namespacePolicies(value: unknown): readonly GitLabRepositoryNamespacePolicy[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    invalid();
  }
  const namespaceIds = new Set<string>();
  return Object.freeze(
    value.map((candidate) => {
      const policy = asRecord(candidate, [
        "namespaceId",
        "profiles",
        "pushRefAllowlist",
        "allowStandingApproval",
      ]);
      const namespaceId = text(policy.namespaceId);
      if (namespaceIds.has(namespaceId)) {
        invalid();
      }
      namespaceIds.add(namespaceId);
      if (policy.allowStandingApproval !== undefined && policy.allowStandingApproval !== true) {
        invalid();
      }
      let pushRefAllowlist: readonly string[];
      try {
        pushRefAllowlist = normalizePushRefAllowlist(policy.pushRefAllowlist);
      } catch {
        invalid();
      }
      return Object.freeze({
        namespaceId,
        profiles: parseProfiles(policy.profiles),
        pushRefAllowlist,
        ...(policy.allowStandingApproval === true ? { allowStandingApproval: true as const } : {}),
      });
    }),
  );
}

export function validateGitLabRepositoryRegistry(
  value: unknown,
  expectedBackendId?: string,
): GitLabRepositoryRegistry {
  const root = asRecord(value, [
    "version",
    "backendId",
    "providerInstanceId",
    "configVersion",
    "maximumDurationSeconds",
    "projects",
  ]);
  const backendId = text(root.backendId);
  if (root.version !== 1 || (expectedBackendId !== undefined && backendId !== expectedBackendId)) {
    invalid();
  }
  const providerInstanceId = text(root.providerInstanceId);
  if (!identifierPattern.test(providerInstanceId)) {
    invalid();
  }
  const version = configVersion(root.configVersion);
  const maximumDurationSeconds = root.maximumDurationSeconds;
  if (
    typeof maximumDurationSeconds !== "number" ||
    !Number.isSafeInteger(maximumDurationSeconds) ||
    maximumDurationSeconds < 1 ||
    maximumDurationSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
  ) {
    invalid();
  }
  if (!Array.isArray(root.projects) || root.projects.length === 0 || root.projects.length > 1024) {
    invalid();
  }
  const paths = new Set<string>();
  const ids = new Set<string>();
  let namespaceRows = 0;
  const projects = root.projects.map((entry) => {
    const project = asRecord(entry, ["projectId", "path", "displayName", "namespaces"]);
    const projectId = numericId(project.projectId);
    const path = text(project.path);
    const namespaces = namespacePolicies(project.namespaces);
    namespaceRows += namespaces.length;
    let normalized: string;
    try {
      normalized = normalizeGitLabProjectPath(path);
    } catch {
      invalid();
    }
    if (normalized !== path || paths.has(path) || ids.has(projectId)) {
      invalid();
    }
    paths.add(path);
    ids.add(projectId);
    return Object.freeze({
      projectId,
      path,
      ...(project.displayName === undefined ? {} : { displayName: text(project.displayName) }),
      namespaces,
    });
  });
  if (namespaceRows > 4096) {
    invalid();
  }
  return Object.freeze({
    version: 1,
    backendId,
    providerInstanceId,
    configVersion: version,
    maximumDurationSeconds,
    projects: Object.freeze(projects),
  });
}

export function resolveGitLabRepositoryBinding(
  registry: GitLabRepositoryRegistry,
  input: RepositoryBindingRequest & { readonly namespaceId: string },
): AdmittedRepositoryBinding {
  const request = asRecord(input, ["namespaceId", "repositoryRef", "profile"]);
  const namespaceId = text(request.namespaceId);
  const repositoryRef = text(request.repositoryRef);
  const profile = request.profile;
  if (typeof profile !== "string") {
    invalid();
  }
  const project = registry.projects.find((candidate) => candidate.projectId === repositoryRef);
  if (project === undefined) {
    invalid();
  }
  const policy = project.namespaces.find((candidate) => candidate.namespaceId === namespaceId);
  if (policy === undefined || !policy.profiles.includes(profile as GitLabProfile)) {
    invalid();
  }
  return Object.freeze({
    repositoryRef: project.projectId,
    profile,
    backendId: registry.backendId,
    grant: createGitLabGrantIdentity({
      authority: "gitlab-token",
      configVersion: registry.configVersion,
      providerInstanceId: registry.providerInstanceId,
      projectId: project.projectId,
      project: project.path,
      namespaceId,
      profile: profile as GitLabProfile,
      pushRefAllowlist: policy.pushRefAllowlist,
    }),
  });
}

export function resolveGitLabStandingApprovalScope(
  registry: GitLabRepositoryRegistry,
  input: {
    readonly namespaceId: string;
    readonly binding: AdmittedRepositoryBinding;
  },
): RepositoryApprovalScope | undefined {
  const namespaceId = text(input.namespaceId);
  const project = registry.projects.find(
    (candidate) => candidate.projectId === input.binding.repositoryRef,
  );
  if (project === undefined) {
    return undefined;
  }
  const policy = project.namespaces.find((candidate) => candidate.namespaceId === namespaceId);
  if (
    policy?.allowStandingApproval !== true ||
    !policy.profiles.includes(input.binding.profile as GitLabProfile)
  ) {
    return undefined;
  }
  return Object.freeze({
    providerInstanceId: registry.providerInstanceId,
    projectId: project.projectId,
    project: project.path,
    profile: input.binding.profile,
  });
}
