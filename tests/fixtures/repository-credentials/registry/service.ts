import type { Clock } from "../../../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type { ServiceConfig } from "../../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import type { loadGitHubRepositoryRegistry as LoadRegistry } from "../../../../apps/controller/src/composition/repository-credentials/registry.ts";
import type { createPreparedGitHubRegistryFactory as CreateFactory } from "../../../../apps/controller/src/drivers/repo/github/access/warm-registry-factory.ts";
import type { createTlsMaterial } from "../process.ts";
import { createResourceScope, type FixtureOwner } from "../resources.ts";
import { startServiceListeners } from "../service-resources.ts";

type RegistryServiceOptions = {
  loadGitHubRepositoryRegistry: typeof LoadRegistry;
  createPreparedGitHubRegistryFactory: typeof CreateFactory;
  registryFile: string;
  backendId: string;
  socketPath: string;
  config: ServiceConfig;
  clock: Clock;
  tls: Awaited<ReturnType<typeof createTlsMaterial>>;
  apiOrigin: string;
  gitOrigin: string;
};

export async function createRegistryServiceOwner(
  resources: FixtureOwner,
  {
    loadGitHubRepositoryRegistry,
    createPreparedGitHubRegistryFactory,
    registryFile,
    backendId,
    socketPath,
    config,
    clock,
    tls,
    apiOrigin,
    gitOrigin,
  }: RegistryServiceOptions,
) {
  let activeScope: ReturnType<typeof createResourceScope> | undefined;
  let registry = await loadGitHubRepositoryRegistry(registryFile, backendId);
  const start = async () => {
    const factory = createPreparedGitHubRegistryFactory({
      registry,
      socketPath,
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
      clock,
      apiOrigin,
      gitOrigin,
    });
    activeScope = createResourceScope();
    const started = await startServiceListeners(activeScope, {
      config,
      factory,
      clock,
      tls,
      upstreamOrigins: [apiOrigin, gitOrigin],
    });
    return { factory, ...started };
  };
  // Restart closes only service state; the outer scope retains the worker-owned inputs and upstreams.
  resources.after(() => activeScope?.close());
  let current = await start();
  return {
    async start() {
      registry = await loadGitHubRepositoryRegistry(registryFile, backendId);
      current = await start();
    },
    stop() {
      return activeScope?.close();
    },
    get registry() {
      return registry;
    },
    get factory() {
      return current.factory;
    },
    get service() {
      return current.service;
    },
    get listeners() {
      return current.listeners;
    },
  };
}
