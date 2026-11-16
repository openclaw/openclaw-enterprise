import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type { CredentialServiceOwner } from "../../../apps/controller/src/drivers/repo/access/internal-contracts.ts";
import type {
  BoundListeners,
  StartListenersOptions,
} from "../../../apps/controller/src/drivers/repo/access/server.ts";
import type {
  RepositoryCredentialSessionResult,
  ServiceConfig,
} from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import type {
  GitHubFactoryOptions,
  GitHubTokenConfiguration,
} from "../../../apps/controller/src/drivers/repo/github/access/types.ts";
import { appFunction } from "./app-functions.ts";
import type { FixtureOwner } from "./resources.ts";
import { temporaryDirectory, type createTlsMaterial } from "./process.mjs";
import { githubTokenConfigurationData } from "./builders.ts";
import { fixtureRepositoryId, fixtureRepository, type startGitHubFixture } from "./github.ts";

type FixtureClock = Clock & { advance?(milliseconds: number): Promise<void> };
type TlsMaterial = Awaited<ReturnType<typeof createTlsMaterial>>;
type TokenOverrides = Partial<GitHubTokenConfiguration>;
type ListenerOptions = Pick<StartListenersOptions, "config" | "factory"> & {
  clock: FixtureClock;
  tls: TlsMaterial;
  upstreamOrigins?: readonly string[] | undefined;
  trustedUpstreamOrigins?: StartListenersOptions["trustedUpstreamOrigins"];
  log?: StartListenersOptions["log"];
};

type TokenFactoryOptions = {
  config: ServiceConfig;
  clock: Clock;
  token: string;
  configuration?: TokenOverrides | undefined;
  repository?: string;
  repositoryId?: string;
  trustedEndpoints?: GitHubFactoryOptions["trustedEndpoints"];
  providerInstanceId?: string;
};

type StaticTokenOptions = Pick<ListenerOptions, "config" | "clock" | "tls"> & {
  github: Pick<Awaited<ReturnType<typeof startGitHubFixture>>, "origin" | "acceptStatic">;
  gitOrigin?: string;
  token?: string;
  configuration?: TokenOverrides | undefined;
};

/** Development token authority: the service owns `token`; GitHub never issues one. */
export async function createGitHubTokenServiceFactory(
  resources: FixtureOwner,
  {
    config,
    clock,
    token,
    configuration = {},
    repository = fixtureRepository,
    repositoryId = fixtureRepositoryId,
    trustedEndpoints,
    providerInstanceId = "github-fixture",
  }: TokenFactoryOptions,
) {
  const [createGitHubDriverFactory, createGitHubStaticTokenOwner, validateGitHubConfiguration] =
    await Promise.all([
      appFunction("drivers/repo/github/access/factory", "createGitHubDriverFactory"),
      appFunction("drivers/repo/github/access/static-token", "createGitHubStaticTokenOwner"),
      appFunction("drivers/repo/github/access/config", "validateGitHubConfiguration"),
    ]);
  const owner = createGitHubStaticTokenOwner({ token: Buffer.from(token) });
  resources.after(() => owner.close());
  return createGitHubDriverFactory({
    configuration: validateGitHubConfiguration(
      githubTokenConfigurationData({
        providerInstanceId,
        repositoryId,
        repository,
        tokenFile: "/unused-fixture-token",
        ...configuration,
      }),
    ),
    authority: owner,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    clock,
    ...(trustedEndpoints === undefined ? {} : { trustedEndpoints }),
  });
}

async function shutdownService(service: CredentialServiceOwner, clock: FixtureClock) {
  let timer: NodeJS.Timeout | undefined;
  try {
    const watchdog = new Promise<never>((_, reject: (reason: unknown) => void) => {
      timer = setTimeout(() => {
        Promise.resolve(clock.advance?.(1000)).then(
          () => reject(new Error("credential fixture shutdown exceeded its grace")),
          reject,
        );
      }, 1500);
    });
    const summary = await Promise.race([service.shutdown(1000), watchdog]);
    assert.equal(summary.graceExpired, false, "fixture shutdown grace expired");
    assert.equal(summary.disposedSessions, summary.closedSessions);
    assert.equal(summary.pendingActions, 0);
    assert.equal(summary.pendingCredentials, 0);
    assert.equal(summary.pendingAuxiliary, 0);
  } finally {
    clearTimeout(timer);
  }
}

export async function startServiceListeners(
  resources: FixtureOwner,
  {
    config,
    factory,
    clock,
    tls,
    upstreamOrigins,
    trustedUpstreamOrigins = new Set(upstreamOrigins),
    log,
  }: ListenerOptions,
) {
  const [{ createCredentialService }, startListeners] = await Promise.all([
    import("./service.ts"),
    appFunction("drivers/repo/access/server", "startListeners"),
  ]);
  const service = createCredentialService({ config, factory, clock });
  const lifetime: { listeners?: BoundListeners; closing: boolean } = { closing: false };
  // Registered first, so it runs last: teardown must have closed the listeners it started.
  resources.after(() =>
    assert.ok(lifetime.listeners === undefined || lifetime.closing, "listeners never closed"),
  );
  // Separate hooks retain every cleanup failure and keep upstreams alive for revocation.
  resources.after(() => {
    lifetime.closing = true;
    return lifetime.listeners?.close();
  });
  resources.after(() => shutdownService(service, clock));
  resources.after(() => lifetime.listeners?.stopAdmission());
  const listeners = await startListeners({
    config,
    tls,
    service,
    factory,
    trustedUpstreamOrigins,
    clock,
    upstreamCa: tls.ca,
    ...(log === undefined ? {} : { log }),
  });
  lifetime.listeners = listeners;
  return { service, listeners };
}

/**
 * A development token factory in front of the fake GitHub, which accepts the static host
 * `token` on git and REST without issuing it. Git goes to `gitOrigin` (default: GitHub).
 */
export async function createStaticTokenServiceFactory(
  resources: FixtureOwner,
  {
    config,
    clock,
    tls,
    github,
    gitOrigin = github.origin,
    token = `gho_${"t".repeat(36)}`,
    configuration,
  }: StaticTokenOptions,
) {
  const tokenIndex = github.acceptStatic(token);
  const factory = await createGitHubTokenServiceFactory(resources, {
    config,
    clock,
    token,
    configuration,
    trustedEndpoints: { apiOrigin: github.origin, gitOrigin, ca: tls.ca },
  });
  return { token, tokenIndex, factory };
}

/**
 * createStaticTokenServiceFactory, then startServiceListeners with the same options. The
 * listeners trust the fake GitHub and `gitOrigin` unless the options name the origins.
 */
export async function startStaticTokenService(
  resources: FixtureOwner,
  options: StaticTokenOptions &
    Pick<ListenerOptions, "trustedUpstreamOrigins" | "upstreamOrigins" | "log">,
) {
  const { github, gitOrigin = github.origin } = options;
  const created = await createStaticTokenServiceFactory(resources, options);
  const started = await startServiceListeners(resources, {
    upstreamOrigins: [...new Set([github.origin, gitOrigin])],
    ...options,
    factory: created.factory,
  });
  return { ...created, ...started };
}

export async function writeSessionClientConfiguration(
  resources: FixtureOwner,
  { opened, ca }: { opened: RepositoryCredentialSessionResult; ca?: Uint8Array },
) {
  const writeClientConfiguration = await appFunction(
    "drivers/repo/github/access/client/config",
    "writeClientConfiguration",
  );
  const parent = await temporaryDirectory(resources, "rcs-client-");
  await chmod(parent, 0o700);
  const clientDirectory = join(parent, "session");
  await writeClientConfiguration(opened, clientDirectory, ca);
  return clientDirectory;
}
