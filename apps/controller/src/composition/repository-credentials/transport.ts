import type { CredentialProxyBinding } from "@openclaw-enterprise/contracts";
import type { PostgresPool } from "@openclaw-enterprise/occ";
import type { startPreparedGitHubGitOwner } from "../../backends/repository-credentials/prepared-git-owner.ts";
import type { OpenShellGitRuntimeEmit } from "../../drivers/egress-proxy/openshell-git-runtime.ts";
import { openShellGitRecipientEvidence } from "../../drivers/repo/credentials/protected-repository-git-installation.ts";
import type { InstallationRuntimeDrivers } from "../installation-config.ts";

/** Worker-selected authority. The sender never chooses its issuer or the host's recipient evidence. */
export function repositoryGitAuthority(drivers: InstallationRuntimeDrivers) {
  const { tokenService, repositoryGitDriver: driver, openShellGit } = drivers;
  if (!tokenService) {
    throw new Error("Prepared repository Git requires the installed Token Service.");
  }
  return {
    tokenService,
    ...(driver && { protectedGitDriver: driver.ref }),
    ...(driver && openShellGit && { protectedGitEvidence: openShellGitRecipientEvidence }),
  };
}

/** Bind the selected sender. The worker retains storage and the right to start the credential owner. */
export async function bindRepositoryGitTransport(
  drivers: InstallationRuntimeDrivers,
  owner: Awaited<ReturnType<typeof startPreparedGitHubGitOwner>>,
  pool: PostgresPool,
  emit?: OpenShellGitRuntimeEmit,
): Promise<CredentialProxyBinding | undefined> {
  const { openShellGit, repositoryGitDriver } = drivers;
  const routes = openShellGit?.connectRouteStore(pool, emit);
  if (repositoryGitDriver) {
    if (!owner.protectedGit || repositoryGitDriver !== drivers.protectedDriver) {
      throw new Error("Missing the selected Driver's protected repository Git authority.");
    }
    return repositoryGitDriver.requireRepositoryGitTransport()(owner.protectedGit);
  }
  // The separately selected, broker-backed profile can still drain its own routes.
  if (openShellGit) {
    await openShellGit.start(owner, emit, routes);
    return openShellGit;
  }
  return undefined;
}
