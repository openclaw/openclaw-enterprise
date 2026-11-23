import type { IAMDriver, InstallationSecretStore } from "@openclaw-enterprise/contracts";
import type { PostgresPlatformState, PostgresPool } from "@openclaw-enterprise/occ";
import { createRepositorySourceCustody } from "../backends/repository-credentials/source-custody.ts";
import type { SelectedDriverConfiguration } from "../composition/installation-config.ts";
import type { GitHubRepositoryRegistry } from "../drivers/repo/github/access/registry.ts";
import type { RepositorySourceCustody } from "../drivers/repo/github/access/source-loan.ts";
import { OCCTokenServiceDriver } from "../drivers/token-service/occ.ts";

/**
 * TokenService custody for registrations that name a Source. An install whose registry names
 * none builds nothing here: no lock pool, no platform state and no IAM driver.
 *
 * The installation configuration selects only the OCC TokenService (`drivers.token_service.id`
 * must be `occ`), so the custody read constructs that driver, as the API server does.
 */
export async function startWorkerRepositorySourceCustody(options: {
  readonly registry: GitHubRepositoryRegistry | undefined;
  readonly tokenService: SelectedDriverConfiguration | undefined;
  readonly secrets: InstallationSecretStore | undefined;
  /** The row hold spans a Provider write, so it has its own small pool beside the store's. */
  readonly createLockPool: () => Promise<PostgresPool>;
  readonly createState: () => PostgresPlatformState;
  readonly createIAMDriver: (state: PostgresPlatformState) => Pick<IAMDriver, "authorize">;
}): Promise<
  { readonly custody: RepositorySourceCustody; readonly lockPool: PostgresPool } | undefined
> {
  const { registry, tokenService, secrets } = options;
  const namesSource = registry?.repositories.some(({ namespaces }) =>
    namespaces.some(({ credentialSource }) => credentialSource !== undefined),
  );
  if (!namesSource || !tokenService || !secrets) {
    return undefined;
  }
  const state = options.createState();
  const iam = options.createIAMDriver(state);
  const lockPool = await options.createLockPool();
  const custody = createRepositorySourceCustody({
    lockPool,
    state,
    tokenServiceDriverId: tokenService.id,
    tokenService: ({ installationId, tokenServiceInstanceId }) =>
      new OCCTokenServiceDriver(
        tokenService.id,
        installationId,
        secrets,
        tokenServiceInstanceId,
        state,
      ),
    iam,
  });
  return { custody, lockPool };
}
