import { join } from "node:path";
import { createControlledClock } from "./clock.ts";
import type { Clock } from "../../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type {
  ServiceConfig,
  ServiceLimits,
} from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { appFunction } from "./app-functions.ts";
import { validateFixtureServiceConfiguration } from "./service-fixture.ts";
import { createTlsMaterial } from "./process.ts";
import { createResourceScope, type FixtureOwner } from "./resources.ts";
import { socketDirectory } from "../../helpers/socket-directory.ts";
import { writeSessionClientConfiguration } from "./service-resources.ts";
import { createRegistryMaterial, type RegistryFixtureDefinition } from "./registry/material.ts";
import { startRegistryProviderFixtures } from "./registry/provider.ts";
import { createRegistryServiceOwner } from "./registry/service.ts";

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

type ControlledClock = ReturnType<typeof createControlledClock>;
type RegistryOptions<C extends Clock> = {
  clock?: C | undefined;
  tls?: Awaited<ReturnType<typeof createTlsMaterial>>;
  namespaceId?: string;
  backendId?: string;
  durationSeconds?: number;
  maximumDurationSeconds?: number;
  profile?: string;
  repositories?: readonly RegistryFixtureDefinition[];
  limits?: Partial<ServiceLimits>;
  gateway?: Partial<ServiceConfig["gateway"]>;
  socketPath?: string;
  autoOpen?: boolean;
};
type OpenOptions = { profile?: string; durationSeconds?: number; deadlineWallMs?: number };

type RegistryFixture<C extends Clock> = Awaited<ReturnType<typeof startRegistry<C>>> & { clock: C };

export function startRegistryCredentialServiceFixture(
  t: FixtureOwner,
  options?: RegistryOptions<Clock> & { clock?: undefined },
): Promise<RegistryFixture<ControlledClock>>;
export function startRegistryCredentialServiceFixture<C extends Clock>(
  t: FixtureOwner,
  options: RegistryOptions<C> & { clock: C },
): Promise<RegistryFixture<C>>;
export function startRegistryCredentialServiceFixture(
  t: FixtureOwner,
  options: RegistryOptions<Clock>,
): Promise<RegistryFixture<Clock>>;
export function startRegistryCredentialServiceFixture(
  t: FixtureOwner,
  options: RegistryOptions<Clock> = {},
) {
  return startRegistry(t, options);
}

async function startRegistry<C extends Clock>(t: FixtureOwner, options: RegistryOptions<C>) {
  const resources = createResourceScope();
  try {
    const clock = options.clock ?? createControlledClock();
    const tls = options.tls ?? (await createTlsMaterial(resources));
    const namespaceId = options.namespaceId ?? "namespace-fixture";
    const backendId = options.backendId ?? "github-fixture";
    const durationSeconds = options.durationSeconds ?? 86400;
    const maximumDurationSeconds = options.maximumDurationSeconds ?? 172800;
    const profile = options.profile ?? "git-write";
    const definitions = options.repositories ?? defaultRegistryRepositories;
    const { registryFile } = await createRegistryMaterial(resources, {
      definitions,
      namespaceId,
      backendId,
      maximumDurationSeconds,
    });
    const [
      validateServiceConfig,
      loadGitHubRepositoryRegistry,
      resolveGitHubRepositoryBinding,
      createPreparedGitHubRegistryFactory,
    ] = await Promise.all([
      appFunction("drivers/repo/access/configuration", "validateServiceConfig"),
      appFunction("composition/repository-credentials/registry", "loadGitHubRepositoryRegistry"),
      appFunction("drivers/repo/github/access/registry", "resolveGitHubRepositoryBinding"),
      appFunction(
        "drivers/repo/github/access/warm-registry-factory",
        "createPreparedGitHubRegistryFactory",
      ),
    ]);
    const controlDirectory = await socketDirectory(resources, "rcs-control-");
    const config = validateFixtureServiceConfiguration(
      validateServiceConfig,
      controlDirectory,
      { sessionPolicy: { maximumDurationSeconds }, limits: options.limits },
      options.gateway,
    );
    const { repositories, apiOrigin, gitOrigin } = await startRegistryProviderFixtures(resources, {
      definitions,
      clock,
      tls,
    });
    const owner = await createRegistryServiceOwner(resources, {
      loadGitHubRepositoryRegistry,
      createPreparedGitHubRegistryFactory,
      registryFile,
      backendId,
      socketPath: options.socketPath ?? join(controlDirectory, "prepared-git-use.sock"),
      config,
      clock,
      tls,
      apiOrigin,
      gitOrigin,
    });
    const byRef = new Map(repositories.map((entry) => [entry.repositoryRef, entry]));
    const fixture = {
      clock,
      tls,
      config,
      backendId,
      namespaceId,
      registryFile,
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
      async open(repositoryRef: string, overrides: OpenOptions = {}) {
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
          preparedOnly: true,
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
    throw error;
  }
}
