import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { appModule } from "./runtime.mjs";
import { temporaryDirectory } from "./process.mjs";
import { githubConfigurationData, githubTokenConfigurationData } from "./builders.mjs";
import {
  fixtureAppId,
  fixtureInstallationId,
  fixtureRepositoryId,
  fixtureRepository,
} from "./github.mjs";

export async function createGitHubServiceFactory(
  resources,
  {
    config,
    clock,
    privateKey,
    key: borrowedKey,
    repository = fixtureRepository,
    repositoryId = fixtureRepositoryId,
    trustedEndpoints,
    providerInstanceId = "github-fixture",
  },
) {
  const [{ createGitHubDriverFactory }, { createGitHubKeyOwner }] = await Promise.all([
    appModule("drivers/repo/github/credentials/index"),
    appModule("drivers/repo/github/credentials/material"),
  ]);
  const key = borrowedKey ?? createGitHubKeyOwner({ privateKey, appId: fixtureAppId, clock });
  if (!borrowedKey) {
    resources.after(() => key.close());
  }
  return createGitHubDriverFactory({
    configuration: githubConfigurationData({
      providerInstanceId,
      appId: fixtureAppId,
      installationId: fixtureInstallationId,
      repositoryId,
      repository,
      privateKeyFile: "/unused-fixture-key.pem",
    }),
    authority: key,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    clock,
    trustedEndpoints,
  });
}

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
  const { createGitHubDriverFactory, createGitHubStaticTokenOwner } = await appModule(
    "drivers/repo/github/credentials/index",
  );
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
    repositoryDescriptions,
  },
) {
  const [{ createCredentialService }, { startListeners }] = await Promise.all([
    appModule("drivers/repo/credentials/service"),
    appModule("drivers/repo/credentials/server"),
  ]);
  const service = createCredentialService({ config, factory, clock, providerQueue });
  let listeners;
  // Separate hooks retain every cleanup failure and keep upstreams alive for revocation.
  resources.after(() => listeners?.close());
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
    ...(repositoryDescriptions === undefined ? {} : { repositoryDescriptions }),
  });
  return { service, listeners };
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
