import type {
  DeploymentRequestMatch,
  RepositoryNetworkGrant,
} from "@openclaw-enterprise/contracts";

/** Stock Git and transport helpers eligible to receive Repository credentials. */
export const OPEN_SHELL_GIT_CREDENTIAL_BINARIES = Object.freeze([
  "/usr/bin/git",
  "/usr/lib/git-core/git-remote-https",
  "/usr/lib/git-core/git-remote-http",
  "/usr/libexec/git-core/git-remote-https",
  "/usr/libexec/git-core/git-remote-http",
]);

export function openShellRepositoryMetadataRequest(repository: string) {
  return {
    binary: "/usr/bin/curl",
    host: "api.github.com",
    ports: [{ from: 443, to: 443 }],
    requestPolicy: { type: "http", method: "GET", path: `/repos/${repository}` },
  } satisfies DeploymentRequestMatch;
}

export function openShellGitServiceRules({ repository, access }: RepositoryNetworkGrant) {
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
}
