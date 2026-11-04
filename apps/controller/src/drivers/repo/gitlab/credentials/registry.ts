import type {
  AdmittedRepositoryBinding,
  RepositoryApprovalScope,
  RepositoryBindingRequest,
} from "@openclaw-enterprise/contracts";
import { normalizeGitLabProjectPath, type GitLabProfile } from "../client.ts";

/**
 * Installation-approved GitLab.com projects. A caller selects a project by its canonical path;
 * the registry owns the numeric identity and the profiles that project may use. The registry
 * never accepts a host, so the provider origin stays fixed.
 */
export interface GitLabRepositoryRegistration {
  readonly projectId: string;
  readonly path: string;
  readonly displayName?: string;
  readonly profiles: readonly GitLabProfile[];
}

export interface GitLabRepositoryRegistry {
  readonly version: 1;
  readonly backendId: string;
  readonly providerInstanceId: string;
  readonly maximumDurationSeconds: number;
  readonly allowStandingApprovals?: true;
  readonly projects: readonly GitLabRepositoryRegistration[];
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const numericIdPattern = /^[1-9][0-9]{0,15}$/u;
const profiles: readonly GitLabProfile[] = ["git-read", "git-write", "git-full"];

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

function projectProfiles(value: unknown): readonly GitLabProfile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > profiles.length) {
    invalid();
  }
  const unique = new Set<GitLabProfile>();
  for (const entry of value) {
    if (typeof entry !== "string" || !profiles.includes(entry as GitLabProfile)) {
      invalid();
    }
    unique.add(entry as GitLabProfile);
  }
  if (unique.size !== value.length) {
    invalid();
  }
  return Object.freeze([...unique]);
}

export function validateGitLabRepositoryRegistry(
  value: unknown,
  expectedBackendId?: string,
): GitLabRepositoryRegistry {
  const root = asRecord(value, [
    "version",
    "backendId",
    "providerInstanceId",
    "maximumDurationSeconds",
    "allowStandingApprovals",
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
  const maximumDurationSeconds = root.maximumDurationSeconds;
  if (
    typeof maximumDurationSeconds !== "number" ||
    !Number.isSafeInteger(maximumDurationSeconds) ||
    maximumDurationSeconds < 1 ||
    maximumDurationSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
  ) {
    invalid();
  }
  if (root.allowStandingApprovals !== undefined && root.allowStandingApprovals !== true) {
    invalid();
  }
  if (!Array.isArray(root.projects) || root.projects.length === 0 || root.projects.length > 1024) {
    invalid();
  }
  const paths = new Set<string>();
  const ids = new Set<string>();
  const projects = root.projects.map((entry) => {
    const project = asRecord(entry, ["projectId", "path", "displayName", "profiles"]);
    const projectId = numericId(project.projectId);
    const path = text(project.path);
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
      profiles: projectProfiles(project.profiles),
    });
  });
  return Object.freeze({
    version: 1,
    backendId,
    providerInstanceId,
    maximumDurationSeconds,
    ...(root.allowStandingApprovals === true ? { allowStandingApprovals: true as const } : {}),
    projects: Object.freeze(projects),
  });
}

export function resolveGitLabRepositoryBinding(
  registry: GitLabRepositoryRegistry,
  input: RepositoryBindingRequest & { readonly namespaceId: string },
): AdmittedRepositoryBinding {
  const request = asRecord(input, ["namespaceId", "repositoryRef", "profile"]);
  const repositoryRef = text(request.repositoryRef);
  const profile = request.profile;
  if (typeof profile !== "string") {
    invalid();
  }
  const project = registry.projects.find((candidate) => candidate.path === repositoryRef);
  if (project === undefined || !project.profiles.includes(profile as GitLabProfile)) {
    invalid();
  }
  return Object.freeze({
    repositoryRef: project.path,
    profile,
    backendId: registry.backendId,
    grant: Object.freeze({
      providerInstanceId: registry.providerInstanceId,
      repositoryId: project.projectId,
      // Stable and opaque: the same project and profile always name the same grant.
      grantId: `${registry.providerInstanceId}:${project.projectId}:${profile}`,
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
  if (registry.allowStandingApprovals !== true) {
    return undefined;
  }
  const project = registry.projects.find(
    (candidate) => candidate.path === input.binding.repositoryRef,
  );
  if (project === undefined || !project.profiles.includes(input.binding.profile as GitLabProfile)) {
    return undefined;
  }
  return Object.freeze({
    providerInstanceId: registry.providerInstanceId,
    projectId: project.projectId,
    project: project.path,
    profile: input.binding.profile,
  });
}
