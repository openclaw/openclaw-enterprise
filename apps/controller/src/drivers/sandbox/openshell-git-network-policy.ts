import type { RepositoryNetworkGrant } from "@openclaw-enterprise/contracts";

/** Stock Git and transport helpers eligible to receive Repository credentials. */
export const OPEN_SHELL_GIT_CREDENTIAL_BINARIES = Object.freeze([
  "/usr/bin/git",
  "/usr/lib/git-core/git-remote-https",
  "/usr/lib/git-core/git-remote-http",
  "/usr/libexec/git-core/git-remote-https",
  "/usr/libexec/git-core/git-remote-http",
]);

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
