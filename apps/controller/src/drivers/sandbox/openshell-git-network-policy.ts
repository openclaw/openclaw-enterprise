import { deepFreeze } from "@openclaw-enterprise/utils";

import type { OpenShellProviderProfileEndpoint } from "./openshell-gateway-client.ts";

export type OpenShellGitNetworkTarget =
  | { readonly repository: string; readonly installationId?: never }
  | { readonly repository?: never; readonly installationId: string };

interface RepositoryNetworkGrant {
  readonly repository: string;
  readonly access: "read" | "write";
}

export type OpenShellGitNetworkInput = OpenShellGitNetworkTarget & {
  readonly gitOrigin: string;
  readonly apiOrigin: string;
  readonly binaries: readonly string[];
  readonly scopedRest?: readonly Readonly<{
    repository: string;
    version?: "v1" | "v2";
    readIssues: boolean;
    createIssues?: true;
    createPullRequests?: true;
  }>[];
  readonly repositoryNetworkPolicy?: readonly RepositoryNetworkGrant[];
};

const gitOrigin = "https://github.com";
const apiOrigin = "https://api.github.com";

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

/** Git origins and permitted binary paths for the Agent runtime. */
export function openShellGitNetworkDefaults(target: OpenShellGitNetworkTarget) {
  return {
    gitOrigin,
    apiOrigin,
    binaries: target.installationId ? [...binaries, "/usr/bin/gh", "/usr/local/bin/gh"] : binaries,
  };
}

function origin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(url.hostname)
  ) {
    throw new Error("Invalid Git transport origin.");
  }
  return url;
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

/** OpenShell imports these endpoints into the Sandbox policy when attaching the Git Provider. */
function legacyEndpoints(
  git: URL,
  api: URL,
  repository: string | undefined,
): readonly OpenShellProviderProfileEndpoint[] {
  return repository === undefined
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
          path: "/" + repository + ".git/**",
        },
        {
          host: api.hostname,
          port: Number(api.port || 443),
          protocol: "rest",
          path: "/repos/" + repository + "/pulls",
        },
      ];
}

function repositoryNetworkRules(
  policy: readonly RepositoryNetworkGrant[],
): NonNullable<OpenShellProviderProfileEndpoint["rules"]> {
  return policy.flatMap(({ repository, access }) => {
    const root = `/${repository}.git`;
    const services =
      access === "write" ? ["git-upload-pack", "git-receive-pack"] : ["git-upload-pack"];
    return services.flatMap((service) => [
      {
        allow: {
          method: "GET",
          path: `${root}/info/refs`,
          query: { service: { glob: service } },
        },
      },
      { allow: { method: "POST", path: `${root}/${service}` } },
    ]);
  });
}

function scopedApiEndpoints(
  policy: readonly RepositoryNetworkGrant[],
  permissions: OpenShellGitNetworkInput["scopedRest"],
): readonly OpenShellProviderProfileEndpoint[] {
  const rules = [];
  for (const { repository, access } of policy) {
    const rest = permissions?.find((grant) => grant.repository === repository);
    if (access === "write" && rest?.createPullRequests === true) {
      rules.push({ allow: { method: "POST", path: `/repos/${repository}/pulls` } });
    }
    const path = `/repos/${repository}/issues`;
    if (access === "write" && rest?.version === "v2" && rest.createIssues === true) {
      rules.push({ allow: { method: "POST", path } });
    }
    if (rest?.readIssues === true) {
      rules.push({ allow: { method: "GET", path } });
      // OpenShell matches globs. An unbounded * also admits /issues/comments and /issues/events.
      // Enumerate decimal widths through 19 digits (positive signed 64-bit issue numbers).
      for (let width = 1; width <= 19; width++) {
        rules.push({ allow: { method: "GET", path: `${path}/[1-9]${"[0-9]".repeat(width - 1)}` } });
      }
    }
  }
  return rules.length ? [{ host: "api.github.com", port: 443, protocol: "rest", rules }] : [];
}

/** OpenShell unions matching allows. A repository ACL replaces every legacy Git and API endpoint. */
export function compileOpenShellGitNetworkPolicy(input: OpenShellGitNetworkInput) {
  const { installationId, repository, repositoryNetworkPolicy } = input;
  if (installationId !== undefined) {
    if (
      typeof installationId !== "string" ||
      !/^[1-9][0-9]*$/.test(installationId) ||
      repository !== undefined ||
      input.gitOrigin !== gitOrigin ||
      input.apiOrigin !== apiOrigin
    ) {
      throw new Error("Invalid GitHub installation transport.");
    }
  } else if (
    repositoryNetworkPolicy !== undefined ||
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.endsWith("/.") ||
    repository.endsWith("/..")
  ) {
    throw new Error("Invalid single-repository transport.");
  }

  const git = origin(input.gitOrigin);
  const api = origin(input.apiOrigin);
  const binaries = [...input.binaries];
  if (
    binaries.length === 0 ||
    binaries.some(
      (path) =>
        typeof path !== "string" ||
        !/^\/[A-Za-z0-9_./-]+$/.test(path) ||
        path.split("/").includes(".."),
    )
  ) {
    throw new Error("Expected exact Git transport binary paths.");
  }
  const grants =
    repositoryNetworkPolicy === undefined ? undefined : canonicalGrants(repositoryNetworkPolicy);
  const endpoints: readonly OpenShellProviderProfileEndpoint[] =
    grants === undefined
      ? legacyEndpoints(git, api, repository)
      : [
          {
            host: git.hostname,
            port: 443,
            protocol: "rest",
            rules: repositoryNetworkRules(grants),
          },
          ...scopedApiEndpoints(grants, input.scopedRest),
        ];
  return deepFreeze({
    gitOrigin: git.origin,
    apiOrigin: api.origin,
    binaries,
    grants,
    endpoints,
  });
}
