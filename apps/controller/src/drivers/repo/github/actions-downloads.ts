import type { SandboxDeploymentGrants } from "@openclaw-enterprise/contracts";

// A changed host list needs a new ID. Retain this declaration to verify frozen revisions.
const storageRanges = [
  [0, 19],
  [30, 49],
  [100, 199],
] as const;

const ports = [Object.freeze({ from: 443, to: 443 })];
Object.freeze(ports);

export const githubActionsDownloads: SandboxDeploymentGrants = Object.freeze({
  id: "actions-downloads",
  grants: Object.freeze(
    [
      "results-receiver.actions.githubusercontent.com",
      ...storageRanges.flatMap(([first, last]) =>
        Array.from(
          { length: last - first + 1 },
          (_, index) => `productionresultssa${first + index}.blob.core.windows.net`,
        ),
      ),
    ].map((host, index) =>
      Object.freeze({
        id: `actions-downloads-${index}`,
        binary: "/usr/local/bin/gh",
        host,
        ports,
      }),
    ),
  ),
});
