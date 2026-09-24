import { createResourceScope } from "../resources.mjs";
import { startServiceListeners } from "../service-resources.mjs";

export function createRegistryServiceOwner(
  resources,
  {
    loadGitHubRepositoryRegistry,
    createGitHubRegistryDriverFactory,
    registryFile,
    backendId,
    privateKeyFile,
    config,
    key,
    clock,
    tls,
    apiOrigin,
    gitOrigin,
  },
) {
  let current;
  let activeScope;
  let registry;
  const start = async () => {
    registry = await loadGitHubRepositoryRegistry(registryFile, backendId);
    const factory = createGitHubRegistryDriverFactory({
      registry,
      key,
      privateKeyFile,
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
      clock,
      trustedEndpoints: { apiOrigin, gitOrigin, ca: tls.ca },
    });
    activeScope = createResourceScope();
    const started = await startServiceListeners(activeScope, {
      config,
      factory,
      clock,
      tls,
      upstreamOrigins: [apiOrigin, gitOrigin],
    });
    current = { factory, ...started };
  };
  // Restart closes only service state; the outer scope retains its key and upstreams.
  resources.after(() => activeScope?.close());
  return {
    start,
    stop() {
      return activeScope.close();
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
