import { isGitHubRepositoryPermissions, type GitHubRepositoryGrant } from "./repository-grant.ts";
import type { RepositoryGitDeliveryResolver } from "../../credentials/delivery.ts";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type {
  AdmittedRepositoryBinding,
  githubInstallationProfile as installationProfile,
  RepositoryApprovalScope,
  RepositoryBindingRequest,
} from "@openclaw-enterprise/contracts";
import type { GitHubProfile } from "./types.ts";
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
} from "../../credentials/client-contracts.ts";

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

function profile(value: unknown): GitHubProfile | "github-repository" {
  if (
    value !== "git-read" &&
    value !== "git-write" &&
    value !== "git-full" &&
    value !== "github-repository"
  ) {
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
            [
              "transport",
              "pushRefAllowlist",
              "pullRequestBase",
              "draftPullLimit",
              "allowStandingApproval",
            ].some((k) => Object.hasOwn(policy, k))
          : Object.hasOwn(policy, "permissions")
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

/** Changing how the sender may use an installation credential changes the grant and its approval. */
const installationGrantPolicy = Object.freeze({
  repositorySelection: "installation",
  apiPermissions: "inherited-from-github-app-installation",
  deliveryPolicy: "github-installation-git-basic-api-bearer-online-authorization-v1",
} as const);

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
    const {
      version,
      backendId,
      providerInstanceId,
      appId,
      githubInstallationId,
      maximumDurationSeconds,
    } = registry;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version,
          backendId,
          providerInstanceId,
          appId,
          githubInstallationId,
          maximumDurationSeconds,
          namespaceId,
          repositoryRef,
          profile: githubInstallationProfile,
          ...installationGrantPolicy,
        }),
      )
      .digest("hex");
    // The shared grant identity is opaque. This selector is not a GitHub repository ID.
    const repositoryId = `github-installation:${githubInstallationId}`;
    return Object.freeze({
      repositoryRef,
      backendId,
      profile: githubInstallationProfile,
      grant: Object.freeze({ providerInstanceId, repositoryId, grantId: `sha256:${fingerprint}` }),
    });
  }
  const repository = registry.repositories.find((entry) => entry.repositoryRef === repositoryRef);
  const policy = repository?.namespaces.find((entry) => entry.namespaceId === namespaceId);
  const selectedProfile = profile(
    request.profile === undefined
      ? policy?.profiles.length === 1 && policy.profiles[0] === "github-repository"
        ? "github-repository"
        : "git-write"
      : request.profile,
  );
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
        ...(policy.pullRequestBase === undefined
          ? {}
          : { pullRequestBase: policy.pullRequestBase }),
        ...(policy.draftPullLimit === undefined ? {} : { draftPullLimit: policy.draftPullLimit }),
        permissions:
          selectedProfile === "github-repository"
            ? policy.permissions
            : permissionsForProfile(
                policy.transport === "git-only"
                  ? "git-ref-write"
                  : policy.transport === "git-and-draft-pr"
                    ? "git-ref-draft-pr"
                    : selectedProfile,
              ),
        capabilityPolicy:
          policy.transport === "git-only"
            ? gitOnlyCapabilityPolicy
            : policy.transport === "git-and-draft-pr"
              ? draftPullCapabilityPolicy
              : githubCapabilityPolicy,
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

/** Resolve the policy ceiling independently of provider token material. */
export function resolveGitHubStandingApprovalScope(
  registry: GitHubRepositoryRegistry,
  input: {
    namespaceId: string;
    binding: AdmittedRepositoryBinding;
  },
): RepositoryApprovalScope | undefined {
  if (input.binding.profile === "github-repository") {
    return undefined;
  }
  const scope = standingApprovalScope(registry, input);
  if (!scope) {
    return;
  }
  const current = resolveGitHubRepositoryBinding(registry, {
    namespaceId: input.namespaceId,
    repositoryRef: input.binding.repositoryRef,
    profile: input.binding.profile,
  });
  if (!isDeepStrictEqual(current, input.binding)) {
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
    pullRequestBase: policy.pullRequestBase ?? null,
    draftPullLimit:
      policy.transport === "git-and-draft-pr" ? (policy.draftPullLimit ?? "one-per-grant") : null,
    apiPermissions: permissionsForProfile(
      policy.transport === "git-only"
        ? "git-ref-write"
        : policy.transport === "git-and-draft-pr"
          ? "git-ref-draft-pr"
          : (input.binding.profile as GitHubProfile),
    ),
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
    if (state?.bindings.length && state.bindings.every((b) => b.profile === "github-repository")) {
      const grant = resolveSelectedRepositoryGrant(
        registry,
        revision.namespaceId,
        revision.id,
        state.bindings,
      );
      return Object.freeze({
        binding: state.bindings[0]!,
        delivery: Object.freeze({
          scope: "github-repository" as const,
          installationId: grant.installationId,
          repositories: grant.repositories,
          permissions: grant.permissions,
        }),
      });
    }
    if (!state || state.bindings.length !== 1 || !binding) {
      throw new Error("Repository Git delivery requires one admitted binding.");
    }
    const resolved = resolveGitHubRepositoryBinding(registry, {
      namespaceId: revision.namespaceId,
      repositoryRef: binding.repositoryRef,
      profile: binding.profile,
    });
    if (!isDeepStrictEqual(binding, resolved)) {
      throw new Error("Repository Git delivery requires the current exact registry grant.");
    }
    if (
      state.standingApprovalId !== undefined &&
      !standingApprovalScope(registry, {
        namespaceId: revision.namespaceId,
        binding,
      })
    ) {
      throw new Error("Standing repository policy is unavailable.");
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

/** Resolve every admitted member; neither registry inventory nor installation membership grants access. */
export function resolveSelectedRepositoryGrant(
  registry: GitHubRepositoryRegistry,
  namespaceId: string,
  revisionId: string,
  bindings: readonly AdmittedRepositoryBinding[],
): GitHubRepositoryGrant {
  if (
    !bindings.length ||
    bindings.length > 16 ||
    new Set(bindings.map((b) => b.repositoryRef)).size !== bindings.length
  ) {
    throw new Error("invalid-selected-repository-set");
  }
  let permissions: Readonly<Record<string, string>> | undefined;
  const repositories = bindings
    .map((binding) => {
      if (
        binding.profile !== "github-repository" ||
        !isDeepStrictEqual(
          binding,
          resolveGitHubRepositoryBinding(registry, {
            namespaceId,
            repositoryRef: binding.repositoryRef,
            profile: binding.profile,
          }),
        )
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
      permissions = policy.permissions;
      return Object.freeze({ repositoryId: repo.repositoryId, repository: repo.repository });
    })
    .sort((a, b) => Number(a.repositoryId) - Number(b.repositoryId));
  return Object.freeze({
    id: bindings[0]!.grant.grantId,
    isolationId: revisionId,
    appId: registry.appId,
    installationId: registry.githubInstallationId,
    profile: "github-repository",
    repositories: Object.freeze(repositories),
    permissions: permissions!,
  });
}
