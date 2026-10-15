import assert from "node:assert/strict";
import { appModule } from "../runtime.mjs";
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
      authority: key,
      privateKeyFile,
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
      clock,
      trustedEndpoints: { apiOrigin, gitOrigin, ca: tls.ca },
    });
    activeScope = createResourceScope();
    const [{ createProviderQueue }, { createGitHubRepositoryDescriptions }] = await Promise.all([
      appModule("drivers/repo/credentials/provider-queue"),
      appModule("drivers/repo/github/credentials/descriptions"),
    ]);
    const providerQueue = createProviderQueue(config.limits.providerQueue);
    const repositoryDescriptions = createGitHubRepositoryDescriptions({
      registry,
      key,
      privateKeyFile,
      config,
      clock,
      providerQueue,
      trustedEndpoints: { apiOrigin, gitOrigin, ca: tls.ca },
    });
    activeScope.after(async () => {
      const summary = await repositoryDescriptions.shutdown(config.limits.shutdownGraceMs);
      assert.equal(summary.graceExpired, false, "metadata credential cleanup must finish");
    });
    const started = await startServiceListeners(activeScope, {
      config,
      factory,
      clock,
      tls,
      upstreamOrigins: [apiOrigin, gitOrigin],
      providerQueue,
      repositoryDescriptions,
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
