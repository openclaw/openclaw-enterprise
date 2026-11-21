import {
  repositoryGitRestOperations,
  type RepositoryGitRestAuthority,
} from "../repo/access/delivery.ts";
import {
  openShellProfileEndpoint,
  type OpenShellProviderProfileEndpoint,
} from "./openshell-gateway-client.ts";

export type OpenShellGitNetworkTarget =
  | { readonly repository: string; readonly installationId?: never }
  | { readonly repository?: never; readonly installationId: string };

const binaries = Object.freeze([
  "/usr/bin/git",
  "/usr/lib/git-core/git-remote-https",
  "/usr/lib/git-core/git-remote-http",
  "/usr/libexec/git-core/git-remote-https",
  "/usr/libexec/git-core/git-remote-http",
  "/usr/bin/curl",
  "/usr/local/bin/node",
  "/usr/bin/node",
]);

export function openShellGitNetworkDefaults(target: OpenShellGitNetworkTarget) {
  return {
    binaries: target.installationId ? [...binaries, "/usr/bin/gh", "/usr/local/bin/gh"] : binaries,
    gitOrigin: "https://github.com",
    apiOrigin: "https://api.github.com",
  };
}

/** OpenShell imports these endpoints into the Sandbox policy when attaching the Git Provider. */
export function openShellGitEndpoints(
  git: URL,
  api: URL,
  target: OpenShellGitNetworkTarget,
): readonly OpenShellProviderProfileEndpoint[] {
  return target.installationId
    ? [
        {
          host: git.hostname,
          port: 443,
          protocol: "rest",
          rules: [
            { allow: { method: "GET", path: "/**/info/refs" } },
            { allow: { method: "POST", path: "/**/git-upload-pack" } },
            { allow: { method: "POST", path: "/**/git-receive-pack" } },
          ],
        },
        {
          host: api.hostname,
          port: 443,
          protocol: "rest",
          access: "NETWORK_ACCESS_PRESET_FULL",
        },
        {
          host: api.hostname,
          port: 443,
          protocol: "graphql",
          path: "/graphql",
          access: "NETWORK_ACCESS_PRESET_FULL",
        },
      ]
    : [
        {
          host: git.hostname,
          port: Number(git.port || 443),
          protocol: "rest",
          path: "/" + target.repository + ".git/**",
        },
        {
          host: api.hostname,
          port: Number(api.port || 443),
          protocol: "rest",
          path: "/repos/" + target.repository + "/pulls",
        },
      ];
}

interface RepositoryNetworkGrant {
  readonly repository: string;
  readonly access: "read" | "write";
}

function canonicalGrants(grants: readonly RepositoryNetworkGrant[]): RepositoryNetworkGrant[] {
  if (!Array.isArray(grants) || grants.length === 0 || grants.length > 32) {
    throw new Error("Expected between 1 and 32 repository grants.");
  }
  const seen = new Set<string>();
  const policy: RepositoryNetworkGrant[] = [];
  const count = grants.length;
  for (let index = 0; index < count; index++) {
    const grant = grants[index];
    if (
      !grant ||
      typeof grant !== "object" ||
      Array.isArray(grant) ||
      Reflect.ownKeys(grant).length !== 2 ||
      !Object.hasOwn(grant, "repository") ||
      !Object.hasOwn(grant, "access")
    ) {
      throw new Error("Expected a repository and an access level.");
    }
    const { repository, access } = grant;
    if (
      typeof repository !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/.test(repository) ||
      repository.endsWith(".git") ||
      (access !== "read" && access !== "write") ||
      seen.has(repository)
    ) {
      throw new Error("Invalid repository network grant.");
    }
    seen.add(repository);
    policy.push({ repository, access });
  }
  return policy.sort((left, right) => (left.repository < right.repository ? -1 : 1));
}

function repositoryNetworkEndpoint({ repository, access }: RepositoryNetworkGrant) {
  const root = `/${repository}.git`;
  const services =
    access === "write" ? ["git-upload-pack", "git-receive-pack"] : ["git-upload-pack"];
  return openShellProfileEndpoint({
    host: "github.com",
    port: 443,
    protocol: "rest",
    path: `${root}/**`,
    rules: services.flatMap((service) => [
      {
        allow: {
          method: "GET",
          path: `${root}/info/refs`,
          query: { service: { glob: service } },
        },
      },
      { allow: { method: "POST", path: `${root}/${service}` } },
    ]),
  });
}

export type OpenShellScopedRestGrant = RepositoryGitRestAuthority[number];

function scopedApiEndpoints(
  policy: readonly RepositoryNetworkGrant[],
  permissions: readonly OpenShellScopedRestGrant[] | undefined,
): readonly OpenShellProviderProfileEndpoint[] {
  const endpoints: OpenShellProviderProfileEndpoint[] = [];
  for (const { repository, createPullRequests, readIssues } of repositoryGitRestOperations(
    policy,
    permissions,
  )) {
    const rules = [];
    if (createPullRequests) {
      rules.push({ allow: { method: "POST", path: `/repos/${repository}/pulls` } });
    }
    const path = `/repos/${repository}/issues`;
    if (readIssues) {
      rules.push({ allow: { method: "GET", path } });
      // OpenShell matches globs. An unbounded * also admits /issues/comments and /issues/events.
      // Enumerate positive decimal issue-number paths up to 19 digits.
      for (let width = 1; width <= 19; width++) {
        rules.push({ allow: { method: "GET", path: `${path}/[1-9]${"[0-9]".repeat(width - 1)}` } });
      }
    }
    if (rules.length) {
      endpoints.push({
        host: "api.github.com",
        port: 443,
        protocol: "rest",
        path: `/repos/${repository}/**`,
        rules,
      });
    }
  }
  return endpoints;
}

/** The Sandbox owns the grants. The attached Provider supplies only the credential. */
export function compileOpenShellBoundGitRule(
  grants: readonly RepositoryNetworkGrant[],
  provider: string,
  binaries: readonly string[],
  scopedRest?: readonly OpenShellScopedRestGrant[],
) {
  if (typeof provider !== "string" || !/^oce-github-installation-[a-f0-9]{32}$/.test(provider)) {
    throw new Error("Expected an installation Git Provider.");
  }
  if (!Array.isArray(binaries) || binaries.length === 0) {
    throw new Error("Expected exact Git transport binary paths.");
  }
  for (const path of binaries) {
    if (
      typeof path !== "string" ||
      !/^\/[A-Za-z0-9_./-]+$/.test(path) ||
      path
        .slice(1)
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error("Expected exact Git transport binary paths.");
    }
  }
  const policy = canonicalGrants(grants);
  const endpoints = [
    ...policy.map(repositoryNetworkEndpoint),
    ...scopedApiEndpoints(policy, scopedRest).map((endpoint) => openShellProfileEndpoint(endpoint)),
  ];
  return {
    name: "repository-git-network",
    binaries: binaries.map((path) => ({ path })),
    endpoints: endpoints.map((endpoint) => ({
      ...endpoint,
      credential_binding: { provider },
    })),
  };
}
