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

/**
 * A delivery that keeps failing writes `worker.repository-delivery-pending` at most this often:
 * the reconcile retries every second, which logged about 86,000 lines a day (finding 2251). The
 * same cadence as a yielded stop's `worker.completed` line (STOP_YIELD_LOG_INTERVAL_MS).
 */
const REPOSITORY_DELIVERY_PENDING_LOG_INTERVAL_MS = 60_000;

/**
 * Which failed reconcile passes log: the first after the worker starts or after a completed pass,
 * then at most one a minute. As with a settled yielded stop, a completed pass ends the pending run,
 * so the next failure logs at once.
 */
export class RepositoryDeliveryPendingLog {
  private loggedAt: number | undefined;
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** A pass failed. Returns whether to log it. */
  failed(): boolean {
    const now = this.now();
    if (
      this.loggedAt !== undefined &&
      now - this.loggedAt < REPOSITORY_DELIVERY_PENDING_LOG_INTERVAL_MS
    ) {
      return false;
    }
    this.loggedAt = now;
    return true;
  }

  /** A pass completed: the next failure starts a new pending run and is logged at once. */
  delivered(): void {
    this.loggedAt = undefined;
  }
}

/** Bind the selected sender. The worker retains storage and the right to start the credential owner. */
export async function bindRepositoryGitTransport(
  drivers: InstallationRuntimeDrivers,
  owner: Awaited<ReturnType<typeof startPreparedGitHubGitOwner>>,
  pool: PostgresPool,
  emit?: OpenShellGitRuntimeEmit,
  // Tests pass one with a fake clock.
  pendingLog = new RepositoryDeliveryPendingLog(),
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
        pendingLog.delivered();
      } catch {
        // The next pass must observe an uncertain effect, never repeat it.
        // The Driver retains the operation; request authorization remains fail-closed.
        if (!stop.signal.aborted && pendingLog.failed()) {
          // The protected Git Driver is the selected Sandbox Driver's owner (installation-config),
          // so its ID is the Sandbox Driver ID the log already keeps (finding 2245).
          emit?.({
            event: "worker.repository-delivery-pending",
            sandboxDriverId: repositoryGitDriver.ref.id,
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
