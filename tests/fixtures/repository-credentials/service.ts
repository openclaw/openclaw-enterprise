import type {
  Clock,
  RepositoryServiceFactory,
} from "../../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts";
import type { ServiceConfig } from "../../../apps/controller/src/drivers/repo/credentials/service-contracts.ts";
import type { ProviderQueue } from "../../../apps/controller/src/drivers/repo/credentials/provider-queue.ts";
import { appModule } from "./runtime.mjs";

const [
  { createCredentialService: createService },
  { preparedSessionConstructor },
  { developmentSessionConstructor },
] = await Promise.all([
  appModule("drivers/repo/credentials/service"),
  appModule("drivers/repo/credentials/session-construction"),
  appModule("drivers/repo/credentials/development-session"),
]);

/** Synchronous service fixture with the same construction choice as process composition. */
export function createCredentialService(
  options: Readonly<{
    config: ServiceConfig;
    factory: RepositoryServiceFactory;
    clock: Clock;
    providerQueue?: ProviderQueue;
  }>,
): import("../../../apps/controller/src/drivers/repo/credentials/internal-contracts.ts").CredentialServiceOwner {
  const construct =
    "createPrepared" in options.factory
      ? preparedSessionConstructor(options.factory)
      : developmentSessionConstructor({ ...options, factory: options.factory });
  return createService(options, construct);
}
