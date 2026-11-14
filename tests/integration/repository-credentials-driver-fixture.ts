import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { Clock } from "../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type { BoundListeners } from "../../apps/controller/src/drivers/repo/access/server.ts";
import type { ServiceConfig } from "../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import type { GitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import type { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";

type RepositoryObservation = {
  repository: string;
  github: { trace: readonly unknown[]; issuesOfTokens: readonly unknown[] };
  git: { trace: readonly unknown[] };
};
type RegistryFixture = {
  backendId: string;
  namespaceId: string;
  registryFile: string;
  registry: GitHubRepositoryRegistry;
  config: ServiceConfig;
  clock: Clock;
  tls: Awaited<ReturnType<typeof createTlsMaterial>>;
  listeners: BoundListeners;
  repositories: readonly RepositoryObservation[];
  restart(): Promise<void>;
};

type RegistryOptions = {
  namespaceId?: string;
  clock?: Clock;
  autoOpen?: boolean;
  gateway?: Partial<ServiceConfig["gateway"]>;
};

export const controlledClock: () => Clock = createControlledClock;

// The JavaScript fixture selects source or emitted service modules at runtime.
export const startRegistryFixture: (
  t: TestContext,
  options: RegistryOptions,
) => Promise<RegistryFixture | undefined> = startRegistryCredentialServiceFixture;

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(isJsonObject(value));
  return value;
}
