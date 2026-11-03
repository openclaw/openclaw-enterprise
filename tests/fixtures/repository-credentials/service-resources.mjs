import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { appModule } from "./runtime.mjs";
import { temporaryDirectory } from "./process.mjs";
import { githubTokenConfigurationData } from "./builders.mjs";
import { fixtureRepositoryId, fixtureRepository } from "./github.mjs";

/** Development token authority: the service owns `token`; GitHub never issues one. */
export async function createGitHubTokenServiceFactory(
  resources,
  {
    config,
    clock,
    token,
    configuration = {},
    repository = fixtureRepository,
    repositoryId = fixtureRepositoryId,
    trustedEndpoints,
    providerInstanceId = "github-fixture",
  },
) {
  const [{ createGitHubDriverFactory }, { createGitHubStaticTokenOwner }] = await Promise.all([
    appModule("drivers/repo/github/credentials/factory"),
    appModule("drivers/repo/github/credentials/static-token"),
  ]);
  const owner = createGitHubStaticTokenOwner({ token: Buffer.from(token) });
  resources.after(() => owner.close());
  return createGitHubDriverFactory({
    configuration: githubTokenConfigurationData({
      providerInstanceId,
      repositoryId,
      repository,
      tokenFile: "/unused-fixture-token",
      ...configuration,
    }),
    authority: owner,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    clock,
    trustedEndpoints,
  });
}

async function shutdownService(service, clock) {
  let timer;
  try {
    const watchdog = new Promise((_, reject) => {
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
  resources,
  {
    config,
    factory,
    clock,
    tls,
    upstreamOrigins,
    trustedUpstreamOrigins = new Set(upstreamOrigins),
    providerQueue,
    log,
  },
) {
  const [{ createCredentialService }, { startListeners }] = await Promise.all([
    appModule("drivers/repo/credentials/service"),
    appModule("drivers/repo/credentials/server"),
  ]);
  const service = createCredentialService({ config, factory, clock, providerQueue });
  let listeners;
  let closing = false;
  // Registered first, so it runs last: teardown must have closed the listeners it started.
  resources.after(() => assert.ok(listeners === undefined || closing, "listeners never closed"));
  // Separate hooks retain every cleanup failure and keep upstreams alive for revocation.
  resources.after(() => {
    closing = true;
    return listeners?.close();
  });
  resources.after(() => shutdownService(service, clock));
  resources.after(() => listeners?.stopAdmission());
  listeners = await startListeners({
    config,
    tls,
    service,
    factory,
    trustedUpstreamOrigins,
    clock,
    upstreamCa: tls.ca,
    ...(log === undefined ? {} : { log }),
  });
  return { service, listeners };
}

/**
 * A development token factory in front of the fake GitHub, which accepts the static host
 * `token` on git and REST without issuing it. Git goes to `gitOrigin` (default: GitHub).
 */
export async function createStaticTokenServiceFactory(
  resources,
  {
    config,
    clock,
    tls,
    github,
    gitOrigin = github.origin,
    token = `gho_${"t".repeat(36)}`,
    configuration,
  },
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
export async function startStaticTokenService(resources, options) {
  const { github, gitOrigin = github.origin } = options;
  const created = await createStaticTokenServiceFactory(resources, options);
  const started = await startServiceListeners(resources, {
    upstreamOrigins: [...new Set([github.origin, gitOrigin])],
    ...options,
    factory: created.factory,
  });
  return { ...created, ...started };
}

export async function writeSessionClientConfiguration(resources, { opened, ca }) {
  const { writeClientConfiguration } = await appModule(
    "drivers/repo/github/credentials/client/config",
  );
  const parent = await temporaryDirectory(resources, "rcs-client-");
  await chmod(parent, 0o700);
  const clientDirectory = join(parent, "session");
  await writeClientConfiguration(opened, clientDirectory, ca);
  return clientDirectory;
}
