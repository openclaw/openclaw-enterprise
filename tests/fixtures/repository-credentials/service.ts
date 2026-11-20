import type {
  Clock,
  RepositoryServiceFactory,
} from "../../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type { ServiceConfig } from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { appFunction } from "./app-functions.ts";

const [createService, preparedSessionConstructor, developmentSessionConstructor] =
  await Promise.all([
    appFunction("drivers/repo/access/service", "createCredentialService"),
    appFunction("drivers/repo/access/session-construction", "preparedSessionConstructor"),
    appFunction("drivers/repo/access/development-session", "developmentSessionConstructor"),
  ]);

/** Synchronous service fixture with the same construction choice as process composition. */
export function createCredentialService(
  options: Readonly<{
    config: ServiceConfig;
    factory: RepositoryServiceFactory;
    clock: Clock;
  }>,
): import("../../../apps/controller/src/drivers/repo/access/internal-contracts.ts").CredentialServiceOwner {
  const construct =
    "createPrepared" in options.factory
      ? preparedSessionConstructor(options.factory)
      : developmentSessionConstructor({ ...options, factory: options.factory });
  return createService(options, construct);
}
