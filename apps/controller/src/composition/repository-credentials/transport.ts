import type { CredentialProxyBinding } from "@openclaw-enterprise/contracts";
import type { PostgresPool } from "@openclaw-enterprise/occ";
import type { startPreparedGitHubGitOwner } from "../../backends/repository-credentials/prepared-git-owner.ts";
import type { OpenShellGitRuntimeEmit } from "../../drivers/egress-proxy/openshell-git-runtime.ts";
import type { InstallationRuntimeDrivers } from "../installation-config.ts";

/** Worker-selected authority. The sender never chooses its issuer or the host's recipient evidence. */
export function repositoryGitAuthority(drivers: InstallationRuntimeDrivers) {
  const { tokenService, repositoryGitDriver: driver, repositoryTransport } = drivers;
  if (!tokenService) {
    throw new Error("Prepared repository Git requires the installed Token Service.");
  }
  return {
    tokenService,
    ...(driver && { protectedGitDriver: driver.ref }),
    ...(driver && repositoryTransport && { protectedGitEvidence: repositoryTransport.evidence }),
  };
}

/** Bind the selected sender. The worker retains storage and the right to start the credential owner. */
export async function bindRepositoryGitTransport(
  drivers: InstallationRuntimeDrivers,
  owner: Awaited<ReturnType<typeof startPreparedGitHubGitOwner>>,
  pool: PostgresPool,
  emit?: OpenShellGitRuntimeEmit,
): Promise<CredentialProxyBinding | undefined> {
  const { repositoryTransport, repositoryGitDriver } = drivers;
  if (
    repositoryGitDriver &&
    (!owner.protectedGit || repositoryGitDriver !== drivers.protectedDriver)
  ) {
    throw new Error("Missing the selected Driver's protected repository Git authority.");
  }
  if (repositoryTransport) {
    return repositoryTransport.bind(owner, pool, emit);
  }
  if (repositoryGitDriver && owner.protectedGit) {
    const binding = await repositoryGitDriver.requireRepositoryGitTransport()(owner.protectedGit);
    if (!binding.reconcile) {
      return binding;
    }
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void>;
    const tick = async () => {
      try {
        await binding.reconcile!(AbortSignal.any([stop.signal, AbortSignal.timeout(25_000)]));
      } catch {
        // The next pass must observe an uncertain effect, never repeat it.
        // The Driver retains the operation; request authorization remains fail-closed.
        if (!stop.signal.aborted) {
          emit?.({
            event: "worker.repository-delivery-pending",
            driverId: repositoryGitDriver.ref.id,
          });
        }
      } finally {
        if (!stop.signal.aborted) {
          timer = setTimeout(() => {
            running = tick();
          }, 1_000);
          timer.unref();
        }
      }
    };
    running = tick();
    return {
      async close() {
        stop.abort();
        clearTimeout(timer);
        await running;
        await binding.close();
      },
    };
  }
  return undefined;
}
