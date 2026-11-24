import {
  createRepositorySlugPattern,
  isGitHubRepositoryPermissions,
  parseGitHubNumericId,
  type GitHubRepositoryGrant,
} from "./repository-grant.ts";
import type { RepositoryGitDeliveryResolver } from "../../access/delivery.ts";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type {
  AdmittedRepositoryBinding,
  githubInstallationProfile as installationProfile,
  RepositoryApprovalScope,
  RepositoryBindingRequest,
  RepositoryNetworkGrant,
} from "@openclaw-enterprise/contracts";
import { isGitHubProfile, type GitHubProfile } from "./types.ts";
import {
  githubCapabilityPolicy,
  draftPullCapabilityPolicy,
  gitOnlyCapabilityPolicy,
  permissionsForProfile,
} from "./profiles.ts";
import {
  hasControlCharacter,
  normalizePushRefAllowlist,
  isWellFormedBranchRef,
} from "../../access/client-contracts.ts";

export const GITHUB_REPOSITORY_REGISTRY_MAX_BYTES = 256 * 1024;
// Keep the credential service's runtime boundary closed while checking the shared profile contract.
export const githubInstallationProfile: typeof installationProfile = "github-installation";

export interface GitHubRepositoryRegistration {
  readonly repositoryRef: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly namespaces: readonly Readonly<{
    namespaceId: string;
    profiles: readonly (GitHubProfile | "github-repository")[];
    permissions?: Readonly<Record<string, string>>;
    /** Select deployment-scoped native Git for this repository registration. */
    nativeGit?: "v1";
    /** Enable the versioned REST subset when this binding also has a repository network ACL. */
    scopedRest?: "v1";
    allowStandingApproval?: true;
    pushRefAllowlist?: readonly string[];
    transport?: "git-only" | "git-and-draft-pr";
    pullRequestBase?: string;
    /** Operator opt-out of the one-draft-per-grant limit on the OpenShell Git route
     * (finding 2147). Absent means one draft per grant. */
    draftPullLimit?: "none";
  }>[];
}

/** Installation access is registered separately: it has no repository ID, slug or ref scope. */
export interface GitHubInstallationAccess {
  readonly repositoryRef: string;
  readonly namespaces: readonly Readonly<{
    namespaceId: string;
    accessMode: "installation";
    allowStandingApproval?: true;
  }>[];
}

export interface GitHubRepositoryRegistry {
  readonly version: 1;
  readonly backendId: string;
  readonly providerInstanceId: string;
  readonly appId: string;
  readonly githubInstallationId: string;
  readonly maximumDurationSeconds: number;
  readonly allowStandingApprovals?: true;
  readonly repositories: readonly GitHubRepositoryRegistration[];
  readonly installationAccess?: GitHubInstallationAccess;
}

const selectorPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const backendPattern = /^(?!\s)(?!.*\s$).{1,200}$/;
const repositoryPattern = createRepositorySlugPattern();

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
  if (typeof value !== "string" || parseGitHubNumericId(value) === undefined) {
    return invalid();
  }
  return value;
}

function profile(value: unknown): GitHubProfile | "github-repository" {
  if (!isGitHubProfile(value) && value !== "github-repository") {
    return invalid();
  }
  return value;
}

function array(value: unknown, maximum: number, minimum = 1): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return invalid();
  }
  return value;
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    invalid();
  }
}

function canonicalPermissions(
  permissions: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b))),
  );
}

function validateInstallationAccess(value: unknown): GitHubInstallationAccess {
  const { repositoryRef, namespaces } = object(value, ["repositoryRef", "namespaces"]);
  const policies = array(namespaces, 128).map((candidate) => {
    const { namespaceId, accessMode, allowStandingApproval } = object(candidate, [
      "namespaceId",
      "accessMode",
      "allowStandingApproval",
    ]);
    if (
      accessMode !== "installation" ||
      (allowStandingApproval !== undefined && allowStandingApproval !== true)
    ) {
      return invalid();
    }
    return Object.freeze({
      namespaceId: text(namespaceId),
      accessMode,
      ...(allowStandingApproval === true && { allowStandingApproval: true as const }),
    });
  });
  unique(policies.map((policy) => policy.namespaceId));
  policies.sort((a, b) => a.namespaceId.localeCompare(b.namespaceId, "en"));
  return Object.freeze({ repositoryRef: text(repositoryRef), namespaces: Object.freeze(policies) });
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
    "allowStandingApprovals",
    "repositories",
    "installationAccess",
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
  if (Object.hasOwn(root, "allowStandingApprovals") && root.allowStandingApprovals !== true) {
    return invalid();
  }
  const installationAccess = Object.hasOwn(root, "installationAccess")
    ? validateInstallationAccess(root.installationAccess)
    : undefined;
  let namespaceRows = installationAccess?.namespaces.length ?? 0;
  const entries = array(root.repositories, 1000, installationAccess ? 0 : 1);
  const repositories = entries.map((candidate) => {
    const entry = object(candidate, ["repositoryRef", "repositoryId", "repository", "namespaces"]);
    const namespaces = array(entry.namespaces, 128).map((candidatePolicy) => {
      const policy = object(candidatePolicy, [
        "namespaceId",
        "profiles",
        "permissions",
        "nativeGit",
        "scopedRest",
        "allowStandingApproval",
        "pushRefAllowlist",
        "transport",
        "pullRequestBase",
        "draftPullLimit",
      ]);
      const profiles = array(policy.profiles, 4).map(profile).sort();
      unique(profiles);
      const selected = profiles.includes("github-repository");
      if (
        selected
          ? !isGitHubRepositoryPermissions(policy.permissions) ||
            profiles.length !== 1 ||
            ["transport", "pushRefAllowlist", "pullRequestBase", "draftPullLimit"].some((k) =>
              Object.hasOwn(policy, k),
            )
          : Object.hasOwn(policy, "permissions")
      ) {
        return invalid();
      }
      if (
        Object.hasOwn(policy, "scopedRest") &&
        (!selected || policy.scopedRest !== "v1" || policy.nativeGit !== "v1")
      ) {
        return invalid();
      }
      if (
        Object.hasOwn(policy, "nativeGit") &&
        (!selected || policy.nativeGit !== "v1" || Object.hasOwn(policy, "allowStandingApproval"))
      ) {
        return invalid();
      }
      const permissions = selected
        ? canonicalPermissions(policy.permissions as Readonly<Record<string, string>>)
        : undefined;
      if (Object.hasOwn(policy, "allowStandingApproval") && policy.allowStandingApproval !== true) {
        return invalid();
      }
      let pushRefAllowlist: readonly string[] | undefined;
      if (Object.hasOwn(policy, "pushRefAllowlist")) {
        try {
          pushRefAllowlist = normalizePushRefAllowlist(policy.pushRefAllowlist);
        } catch {
          return invalid();
        }
      }
      const { transport } = policy;
      const draft = transport === "git-and-draft-pr";
      const base = draft
        ? text(policy.pullRequestBase, /^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,127}$/)
        : undefined;
      const head = pushRefAllowlist?.[0]?.slice("refs/heads/".length);
      if (
        draft
          ? !head ||
            head === base ||
            head.includes("*") ||
            pushRefAllowlist?.length !== 1 ||
            !isWellFormedBranchRef("refs/heads/" + base) ||
            [head, base!].some(
              (branch) => branch.startsWith("refs/") || /^[a-f0-9]{40,64}$/i.test(branch),
            )
          : Object.hasOwn(policy, "pullRequestBase")
      ) {
        return invalid();
      }
      // Only a draft grant has a draft limit; "one-per-grant" is the default and is not stored.
      const { draftPullLimit } = policy;
      if (
        Object.hasOwn(policy, "draftPullLimit") &&
        (!draft || (draftPullLimit !== "one-per-grant" && draftPullLimit !== "none"))
      ) {
        return invalid();
      }
      // An explicit empty list denies ref updates. Never turn a missing allowlist into an unrestricted push.
      if (
        transport !== undefined &&
        ((transport !== "git-only" && !draft) ||
          pushRefAllowlist === undefined ||
          profiles.length !== 1 ||
          profiles[0] !== "git-write")
      ) {
        return invalid();
      }
      namespaceRows += 1;
      return Object.freeze({
        namespaceId: text(policy.namespaceId),
        profiles: Object.freeze(profiles),
        ...(permissions && { permissions }),
        ...(policy.nativeGit === "v1" && { nativeGit: "v1" as const }),
        ...(policy.scopedRest === "v1" && { scopedRest: "v1" as const }),
        ...(policy.allowStandingApproval === true ? { allowStandingApproval: true as const } : {}),
        ...(pushRefAllowlist === undefined ? {} : { pushRefAllowlist }),
        ...(transport === undefined ? {} : { transport }),
        ...(base === undefined ? {} : { pullRequestBase: base }),
        ...(draftPullLimit === "none" ? { draftPullLimit: "none" as const } : {}),
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
  unique([
    ...repositories.map((entry) => entry.repositoryRef),
    ...(installationAccess ? [installationAccess.repositoryRef] : []),
  ]);
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
    ...(root.allowStandingApprovals === true ? { allowStandingApprovals: true as const } : {}),
    repositories: Object.freeze(repositories),
    ...(installationAccess && { installationAccess }),
  });
}

function repositoryTransportPermissions(
  policy: GitHubRepositoryRegistration["namespaces"][number],
  profile: GitHubProfile | "github-repository",
): Readonly<Record<string, string>> | undefined {
  if (profile === "github-repository") {
    return policy.permissions;
  }
  if (policy.transport === "git-only") {
    return permissionsForProfile("git-ref-write");
  }
  if (policy.transport === "git-and-draft-pr") {
    return permissionsForProfile("git-ref-draft-pr");
  }
  return permissionsForProfile(profile);
}

function resolveRepositoryNamespacePolicy(
  repository: GitHubRepositoryRegistration | undefined,
  namespaceId: string,
) {
  const policy = repository?.namespaces.find((entry) => entry.namespaceId === namespaceId);
  return repository && policy ? { repository, policy } : undefined;
}

/** Check native Git network access against an exact registered repository's Namespace grant. */
export function allowsGitHubRepositoryNetworkGrant(
  registry: GitHubRepositoryRegistry,
  input: { readonly namespaceId: string; readonly grant: RepositoryNetworkGrant },
): boolean {
  const { namespaceId, grant } = input;
  const resolved = resolveRepositoryNamespacePolicy(
    registry.repositories.find((entry) => entry.repository === grant.repository),
    namespaceId,
  );
  if (resolved === undefined) {
    return false;
  }
  const { policy } = resolved;
  return policy.profiles.some((profile) => {
    const contents = repositoryTransportPermissions(policy, profile)?.contents;
    // The network policy cannot preserve an existing push-ref restriction.
    return (
      (grant.access === "read" && (contents === "read" || contents === "write")) ||
      (grant.access === "write" && contents === "write" && policy.pushRefAllowlist === undefined)
    );
  });
}

/** Changing how the sender may use an installation credential changes the grant and its approval. */
const installationGrantPolicy = Object.freeze({
  repositorySelection: "installation",
  apiPermissions: "inherited-from-github-app-installation",
  deliveryPolicy: "github-installation-git-basic-api-bearer-online-authorization-v1",
} as const);

function scopedRestPermissions(policy: GitHubRepositoryRegistration["namespaces"][number]) {
  if (policy.scopedRest !== "v1") {
    return undefined;
  }
  return {
    version: policy.scopedRest,
    readIssues: policy.permissions?.issues === "read" || policy.permissions?.issues === "write",
  };
}

/**
 * Pull request routes follow the registration's `pull_requests` permission. The grant identity
 * already covers that permission and the REST version, so these flags stay out of its hash and
 * a binding saved before pull request routes existed remains current.
 */
function scopedPullRequestPermissions(policy: GitHubRepositoryRegistration["namespaces"][number]) {
  const pullRequests = policy.permissions?.pull_requests;
  return {
    ...((pullRequests === "read" || pullRequests === "write") && {
      readPullRequests: true as const,
    }),
    ...(pullRequests === "write" && { createPullRequests: true as const }),
  };
}

function registryGrantId(
  registry: GitHubRepositoryRegistry,
  fields: Readonly<Record<string, unknown>>,
): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        version: registry.version,
        backendId: registry.backendId,
        providerInstanceId: registry.providerInstanceId,
        appId: registry.appId,
        githubInstallationId: registry.githubInstallationId,
        maximumDurationSeconds: registry.maximumDurationSeconds,
        ...fields,
      }),
    )
    .digest("hex")}`;
}

export function resolveGitHubRepositoryBinding(
  registry: GitHubRepositoryRegistry,
  input: RepositoryBindingRequest & { readonly namespaceId: string },
): AdmittedRepositoryBinding {
  const request = object(input, ["namespaceId", "repositoryRef", "profile"]);
  const namespaceId = text(request.namespaceId);
  const repositoryRef = text(request.repositoryRef);
  const installation = registry.installationAccess;
  if (installation && installation.repositoryRef === repositoryRef) {
    const policy = installation.namespaces.find((entry) => entry.namespaceId === namespaceId);
    if (request.profile !== githubInstallationProfile || policy?.accessMode !== "installation") {
      throw new Error("repository-binding-not-authorized");
    }
    const { backendId, providerInstanceId, githubInstallationId } = registry;
    const grantId = registryGrantId(registry, {
      namespaceId,
      repositoryRef,
      profile: githubInstallationProfile,
      ...installationGrantPolicy,
    });
    // The shared grant identity is opaque. This selector is not a GitHub repository ID.
    const repositoryId = `github-installation:${githubInstallationId}`;
    return Object.freeze({
      repositoryRef,
      backendId,
      profile: githubInstallationProfile,
      grant: Object.freeze({ providerInstanceId, repositoryId, grantId }),
    });
  }
  const resolved = resolveRepositoryNamespacePolicy(
    registry.repositories.find((entry) => entry.repositoryRef === repositoryRef),
    namespaceId,
  );
  if (resolved === undefined) {
    throw new Error("repository-binding-not-authorized");
  }
  const { repository, policy } = resolved;
  const selectedProfile = profile(
    request.profile === undefined
      ? policy.profiles.length === 1 && policy.profiles[0] === "github-repository"
        ? "github-repository"
        : "git-write"
      : request.profile,
  );
  if (!policy.profiles.includes(selectedProfile)) {
    throw new Error("repository-binding-not-authorized");
  }
  // Policy changes cannot preserve an earlier grant merely by retaining an operator label.
  const grantId = registryGrantId(registry, {
    repositoryRef,
    repositoryId: repository.repositoryId,
    repository: repository.repository,
    namespaceId,
    allowedProfiles: policy.profiles,
    ...(policy.pushRefAllowlist === undefined ? {} : { pushRefAllowlist: policy.pushRefAllowlist }),
    profile: selectedProfile,
    ...(policy.pullRequestBase === undefined ? {} : { pullRequestBase: policy.pullRequestBase }),
    ...(policy.draftPullLimit === undefined ? {} : { draftPullLimit: policy.draftPullLimit }),
    permissions: repositoryTransportPermissions(policy, selectedProfile),
    scopedRest: scopedRestPermissions(policy),
    ...(policy.nativeGit === "v1" && { nativeGit: "v1" as const }),
    capabilityPolicy:
      policy.transport === "git-only"
        ? gitOnlyCapabilityPolicy
        : policy.transport === "git-and-draft-pr"
          ? draftPullCapabilityPolicy
          : githubCapabilityPolicy,
  });
  return Object.freeze({
    repositoryRef,
    profile: selectedProfile,
    backendId: registry.backendId,
    grant: Object.freeze({
      providerInstanceId: registry.providerInstanceId,
      repositoryId: repository.repositoryId,
      grantId,
    }),
  });
}

/** Re-resolve saved authority and require the entire admitted binding to remain current. */
export function resolveCurrentGitHubRepositoryBinding(
  registry: GitHubRepositoryRegistry,
  namespaceId: string,
  binding: AdmittedRepositoryBinding,
): AdmittedRepositoryBinding | undefined {
  const current = resolveGitHubRepositoryBinding(registry, {
    namespaceId,
    repositoryRef: binding.repositoryRef,
    profile: binding.profile,
  });
  return isDeepStrictEqual(current, binding) ? current : undefined;
}

/** Resolve the policy ceiling independently of provider token material. */
export function resolveGitHubStandingApprovalScope(
  registry: GitHubRepositoryRegistry,
  input: {
    namespaceId: string;
    binding: AdmittedRepositoryBinding;
  },
): RepositoryApprovalScope | undefined {
  const scope = standingApprovalScope(registry, input);
  if (!scope) {
    return;
  }
  if (!resolveCurrentGitHubRepositoryBinding(registry, input.namespaceId, input.binding)) {
    return;
  }
  return scope;
}

/** Only the standing ceiling; callers must also verify the exact grant. */
function standingApprovalScope(
  registry: GitHubRepositoryRegistry,
  input: { namespaceId: string; binding: AdmittedRepositoryBinding },
): RepositoryApprovalScope | undefined {
  const installation = input.binding.profile === githubInstallationProfile;
  const repository = registry.repositories.find(
    (r) => r.repositoryRef === input.binding.repositoryRef,
  );
  const registration = installation ? registry.installationAccess : repository;
  const policy = registration?.namespaces.find((p) => p.namespaceId === input.namespaceId);
  if (
    registration?.repositoryRef !== input.binding.repositoryRef ||
    registry.allowStandingApprovals !== true ||
    policy?.allowStandingApproval !== true
  ) {
    return;
  }
  if (installation) {
    return Object.freeze({
      appId: registry.appId,
      installationId: registry.githubInstallationId,
      providerInstanceId: registry.providerInstanceId,
      ...installationGrantPolicy,
      profile: githubInstallationProfile,
      maximumSessionDurationSeconds: registry.maximumDurationSeconds,
      installationPolicyAllowsStanding: true,
      namespacePolicyAllowsStanding: true,
    });
  }
  if (!repository || "accessMode" in policy) {
    return;
  }
  return Object.freeze({
    appId: registry.appId,
    installationId: registry.githubInstallationId,
    providerInstanceId: registry.providerInstanceId,
    repositorySelection: "repository",
    repositoryId: repository.repositoryId,
    repository: repository.repository,
    profile: input.binding.profile,
    allowedProfiles: policy.profiles,
    pushRefAllowlist: policy.pushRefAllowlist ?? null,
    transport: policy.transport ?? null,
    ...(policy.scopedRest && { scopedRest: scopedRestPermissions(policy)! }),
    pullRequestBase: policy.pullRequestBase ?? null,
    draftPullLimit:
      policy.transport === "git-and-draft-pr" ? (policy.draftPullLimit ?? "one-per-grant") : null,
    apiPermissions: repositoryTransportPermissions(
      policy,
      input.binding.profile as GitHubProfile | "github-repository",
    )!,
    maximumSessionDurationSeconds: registry.maximumDurationSeconds,
    installationPolicyAllowsStanding: true,
    namespacePolicyAllowsStanding: true,
  });
}

/** Repo owns the policy ceiling; OCC still owns approval validity and withdrawal. */
export function createGitHubRepositoryDeliveryResolver(
  registry: GitHubRepositoryRegistry,
): RepositoryGitDeliveryResolver {
  return (revision) => {
    const state = revision.repositoryCredentials;
    const binding = state?.bindings[0];
    if (
      state?.standingApprovalId !== undefined &&
      (state.bindings.length !== 1 ||
        !binding ||
        !resolveGitHubStandingApprovalScope(registry, {
          namespaceId: revision.namespaceId,
          binding,
        }))
    ) {
      throw new Error("Standing repository policy is unavailable.");
    }
    if (state?.bindings.length && state.bindings.every((b) => b.profile === "github-repository")) {
      const scope = resolveSelectedRepositoryScope(registry, revision.namespaceId, state.bindings);
      const savedPolicy = revision.sandboxPolicy?.repositoryNetworkPolicy;
      if (savedPolicy !== undefined && scope.mixedNativeGit) {
        throw new Error("selected-repository-native-git-differs");
      }
      const nativeGit = savedPolicy !== undefined && scope.nativeGit === "v1";
      if (nativeGit && (state.standingApprovalId !== undefined || !savedPolicy.grants.length)) {
        throw new Error(
          "Native Git requires finite repository access with a nonempty network policy.",
        );
      }
      // The credential covers every bound repository, and a pull request can name any of them
      // in the target's fork network as its head. Creation therefore needs a saved grant on each.
      const granted = new Set(savedPolicy?.grants.map(({ repository }) => repository));
      const scopedRest = scope.repositories.every(({ repository }) => granted.has(repository))
        ? scope.scopedRest
        : scope.scopedRest.map(({ createPullRequests, ...rest }) => Object.freeze(rest));
      return Object.freeze({
        binding: state.bindings[0]!,
        delivery: Object.freeze({
          scope: "github-repository" as const,
          installationId: registry.githubInstallationId,
          repositories: scope.repositories,
          permissions: scope.permissions,
          ...(nativeGit && { nativeGit: "v1" as const }),
          ...(nativeGit && scopedRest.length > 0 && { scopedRest: Object.freeze(scopedRest) }),
        }),
      });
    }
    if (!state || state.bindings.length !== 1 || !binding) {
      throw new Error("Repository Git delivery requires one admitted binding.");
    }
    const resolved = resolveCurrentGitHubRepositoryBinding(registry, revision.namespaceId, binding);
    if (!resolved) {
      throw new Error("Repository Git delivery requires the current exact registry grant.");
    }
    if (binding.profile === githubInstallationProfile) {
      return Object.freeze({
        binding: resolved,
        delivery: Object.freeze({ installationId: registry.githubInstallationId }),
      });
    }
    const repository = registry.repositories.find((r) => r.repositoryRef === binding.repositoryRef);
    const policy = repository?.namespaces.find((p) => p.namespaceId === revision.namespaceId);
    if (
      binding.profile !== "git-write" ||
      !repository ||
      policy?.pushRefAllowlist?.length !== 1 ||
      !["git-only", "git-and-draft-pr"].includes(policy.transport ?? "")
    ) {
      throw new Error("Repository Git delivery requires one explicit review ref and transport.");
    }
    return Object.freeze({
      binding: resolved,
      delivery: Object.freeze({ repository: repository.repository }),
      repository: Object.freeze({
        pushRef: policy.pushRefAllowlist[0]!,
        draftPullRequest: policy.transport === "git-and-draft-pr",
        ...(policy.pullRequestBase === undefined
          ? {}
          : { pullRequestBase: policy.pullRequestBase }),
      }),
    });
  };
}

export function resolveSelectedRepositoryGrant(
  registry: GitHubRepositoryRegistry,
  namespaceId: string,
  revisionId: string,
  bindings: readonly AdmittedRepositoryBinding[],
): GitHubRepositoryGrant {
  const scope = resolveSelectedRepositoryScope(registry, namespaceId, bindings);
  return Object.freeze({
    id: bindings[0]!.grant.grantId,
    isolationId: revisionId,
    appId: registry.appId,
    installationId: registry.githubInstallationId,
    profile: "github-repository",
    repositories: scope.repositories,
    permissions: scope.permissions,
  });
}

/** Resolve every admitted member; neither registry inventory nor installation membership grants access. */
export function resolveSelectedRepositoryScope(
  registry: GitHubRepositoryRegistry,
  namespaceId: string,
  bindings: readonly AdmittedRepositoryBinding[],
) {
  if (
    !bindings.length ||
    bindings.length > 16 ||
    new Set(bindings.map((b) => b.repositoryRef)).size !== bindings.length
  ) {
    throw new Error("invalid-selected-repository-set");
  }
  const scopedRest: ({ repository: string } & NonNullable<
    ReturnType<typeof scopedRestPermissions>
  > &
    ReturnType<typeof scopedPullRequestPermissions>)[] = [];
  const nativeGitModes = new Set<"v1" | undefined>();
  let permissions: Readonly<Record<string, string>> | undefined;
  const repositories = bindings
    .map((binding) => {
      if (
        binding.profile !== "github-repository" ||
        !resolveCurrentGitHubRepositoryBinding(registry, namespaceId, binding)
      ) {
        throw new Error("selected-repository-grant-changed");
      }
      const repo = registry.repositories.find((r) => r.repositoryRef === binding.repositoryRef)!;
      const policy = repo.namespaces.find((p) => p.namespaceId === namespaceId)!;
      if (
        !policy.permissions ||
        (permissions && !isDeepStrictEqual(permissions, policy.permissions))
      ) {
        throw new Error("selected-repository-permissions-differ");
      }
      const rest = scopedRestPermissions(policy);
      if (rest) {
        scopedRest.push(
          Object.freeze({
            repository: repo.repository,
            ...rest,
            ...scopedPullRequestPermissions(policy),
          }),
        );
      }
      nativeGitModes.add(policy.nativeGit);
      permissions = policy.permissions;
      return Object.freeze({ repositoryId: repo.repositoryId, repository: repo.repository });
    })
    .sort((a, b) => Number(a.repositoryId) - Number(b.repositoryId));
  return Object.freeze({
    repositories: Object.freeze(repositories),
    permissions: permissions!,
    ...(nativeGitModes.size > 1 && { mixedNativeGit: true }),
    ...(nativeGitModes.size === 1 && nativeGitModes.has("v1") && { nativeGit: "v1" as const }),
    scopedRest: Object.freeze(scopedRest.sort((a, b) => a.repository.localeCompare(b.repository))),
  });
}
