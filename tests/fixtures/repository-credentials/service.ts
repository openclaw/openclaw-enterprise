import type {
  Clock,
  RepositoryServiceFactory,
} from "../../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type { ServiceConfig } from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { appModule } from "./runtime.mjs";

const [
  { createCredentialService: createService },
  { preparedSessionConstructor },
  { developmentSessionConstructor },
] = await Promise.all([
  appModule("drivers/repo/access/service"),
  appModule("drivers/repo/access/session-construction"),
  appModule("drivers/repo/access/development-session"),
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
