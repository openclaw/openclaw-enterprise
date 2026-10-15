import { join } from "node:path";
import { createControlledClock } from "./clock.mjs";
import { serviceConfigurationData } from "./builders.mjs";
import { fixtureAppId } from "./github.mjs";
import { createTlsMaterial } from "./process.mjs";
import { createResourceScope } from "./resources.mjs";
import { socketDirectory } from "../../helpers/socket-directory.mjs";
import {
  credentialDriverModule,
  githubProviderModule,
  credentialCompositionModule,
} from "./runtime.mjs";
import { writeSessionClientConfiguration } from "./service-resources.mjs";
import { createRegistryMaterial } from "./registry/material.mjs";
import { startRegistryProviderFixtures } from "./registry/provider.mjs";
import { createRegistryServiceOwner } from "./registry/service.mjs";

export const defaultRegistryRepositories = Object.freeze([
  Object.freeze({
    repositoryRef: "repo-a",
    repository: "fixture/repository",
    repositoryId: "73",
  }),
  Object.freeze({
    repositoryRef: "repo-b",
    repository: "fixture/other",
    repositoryId: "74",
  }),
]);

export async function startRegistryCredentialServiceFixture(t, options = {}) {
  const resources = createResourceScope();
  try {
    const clock = options.clock ?? createControlledClock();
    const tls = options.tls ?? (await createTlsMaterial(resources));
    const namespaceId = options.namespaceId ?? "namespace-fixture";
    const backendId = options.backendId ?? "github-fixture";
    const durationSeconds = options.durationSeconds ?? 86400;
    const maximumDurationSeconds = options.maximumDurationSeconds ?? 172800;
    const profile = options.profile ?? "git-full";
    const definitions = options.repositories ?? defaultRegistryRepositories;
    const { privateKeyFile, registryFile, keyPair } = await createRegistryMaterial(resources, {
      definitions,
      namespaceId,
      backendId,
      maximumDurationSeconds,
    });
    const [
      { validateServiceConfig },
      { loadGitHubRepositoryRegistry },
      { resolveGitHubRepositoryBinding },
      { createGitHubRegistryDriverFactory },
      { createGitHubKeyOwner },
    ] = await Promise.all([
      credentialDriverModule("configuration"),
      credentialCompositionModule("registry"),
      githubProviderModule("registry"),
      githubProviderModule("registry-factory"),
      githubProviderModule("material"),
    ]);
    const controlDirectory = await socketDirectory(resources, "rcs-control-");
    const configured = validateServiceConfig(
      serviceConfigurationData({
        gateway: {
          publicOrigin: "https://credentials.example.test",
          listen: "0.0.0.0:443",
          controlSocket: join(controlDirectory, "control.sock"),
        },
        sessionPolicy: { maximumDurationSeconds },
        limits: options.limits,
      }),
    );
    // Test listeners can ask the kernel for a port without relaxing production
    // configuration validation, as in the standalone service fixture.
    const config =
      options.gateway === undefined
        ? configured
        : { ...configured, gateway: { ...configured.gateway, ...options.gateway } };
    const { repositories, apiOrigin, gitOrigin } = await startRegistryProviderFixtures(resources, {
      definitions,
      clock,
      tls,
      keyPair,
      tokenLifetimeMs: options.tokenLifetimeMs,
    });
    const key = createGitHubKeyOwner({
      privateKey: keyPair.privateKey,
      appId: fixtureAppId,
      clock,
    });
    resources.after(() => key.close());
    const owner = createRegistryServiceOwner(resources, {
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
    });
    await owner.start();
    const byRef = new Map(repositories.map((entry) => [entry.repositoryRef, entry]));
    const fixture = {
      clock,
      tls,
      config,
      backendId,
      namespaceId,
      registryFile,
      privateKeyFile,
      repositories,
      byRef,
      get registry() {
        return owner.registry;
      },
      get factory() {
        return owner.factory;
      },
      get service() {
        return owner.service;
      },
      get listeners() {
        return owner.listeners;
      },
      async open(repositoryRef, overrides = {}) {
        const entry = byRef.get(repositoryRef);
        if (!entry) {
          throw new Error("unknown fixture repository");
        }
        const binding = resolveGitHubRepositoryBinding(owner.registry, {
          namespaceId,
          repositoryRef,
          profile: overrides.profile ?? entry.profile ?? profile,
        });
        const selectedDuration = overrides.durationSeconds ?? durationSeconds;
        const opened = owner.service.open({
          namespaceId,
          repositoryRef,
          profile: binding.profile,
          expectedBinding: binding.grant,
          durationSeconds: selectedDuration,
          deadlineWallMs: overrides.deadlineWallMs ?? clock.wallNow() + selectedDuration * 1000,
        });
        const clientDirectory = await writeSessionClientConfiguration(resources, {
          opened,
          ca: tls.ca,
        });
        entry.opened = opened;
        entry.clientDirectory = clientDirectory;
        return { opened, clientDirectory };
      },
      async restart() {
        await owner.stop();
        for (const entry of repositories) {
          delete entry.opened;
          delete entry.clientDirectory;
        }
        await owner.start();
      },
      close() {
        return resources.close();
      },
    };
    if (options.autoOpen !== false) {
      for (const entry of repositories) {
        await fixture.open(entry.repositoryRef);
      }
    }
    t.after(() => resources.close());
    return fixture;
  } catch (error) {
    await resources.close(error);
  }
}
