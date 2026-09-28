export const repositoryProfiles = Object.freeze([
  Object.freeze({
    id: "git-read",
    label: "Read-only",
    help: "Read code, issues, pull requests, and checks. No writes.",
    writes: false,
  }),
  Object.freeze({
    id: "git-write",
    label: "Contributor · no issue management",
    help: "Read, push code, create pull requests, and join PR discussions. Does not grant ordinary issue management.",
    writes: true,
  }),
  Object.freeze({
    id: "git-full",
    label: "Contributor",
    help: "Read, push code, work with pull requests, and manage issues by default.",
    writes: true,
  }),
]);

export const repositoryWriteAccessHelp =
  "GraphQL can permit merges and branch changes within the installation token’s permissions. The optional Git branch push allowlist is best effort and does not restrict GraphQL. Repository administration and workflow permissions are not granted by default.";

export function repositoryProfile(id) {
  return repositoryProfiles.find((profile) => profile.id === id);
}
