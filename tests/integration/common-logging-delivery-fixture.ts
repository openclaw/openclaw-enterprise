import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  bindRepositoryGitTransport,
  type RepositoryDeliveryPendingLog,
} from "../../apps/controller/src/composition/repository-credentials/transport.ts";
import type { RepositoryTransportEmit } from "../../apps/controller/src/composition/repository-credentials/contracts.ts";
import type {
  CredentialProxyDriver,
  ProtectedRepositoryGitAuthority,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import { InstalledDriver } from "../../packages/occ/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";

export async function bindDeliveryTransport(
  t: TestContext,
  reconcile: () => void | Promise<void>,
  emit: RepositoryTransportEmit,
  pendingLog?: RepositoryDeliveryPendingLog,
) {
  const drivers = await loadInstallationFile(t, createInstallationDriverConfiguration());
  assert.ok(drivers);
  const outOfScope = () => assert.fail("Delivery logging only exercises reconcile and close");
  const identity = { id: "openshell-sandbox", implementation: "openshell" };
  const sandbox: SandboxDriver = {
    ...identity,
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    cleanup: outOfScope,
    facets: ["networking"],
    repositoryAccess: {
      verifyExecution: outOfScope,
      retireExpired: outOfScope,
      routeReadiness: outOfScope,
      materialSettledAt: outOfScope,
      isRouteBlockedError: outOfScope,
    },
  };
  const proxyRef = { id: identity.id, generation: 1 };
  const closeSender = t.mock.fn(async () => {});
  const proxy: CredentialProxyDriver = {
    ...identity,
    capability: "credential_proxy",
    sourceControl: {
      backend: proxyRef,
      sender: proxyRef,
      resolver: proxyRef,
      providers: [],
      assertAvailable: outOfScope,
    },
    async bindRepositoryGit() {
      return {
        async reconcile() {
          await reconcile();
        },
        close: closeSender,
      };
    },
    configureRevision: outOfScope,
    wiringStatus: outOfScope,
    verifyInstallation: outOfScope,
    removeRevision: outOfScope,
  };
  const owner = new InstalledDriver(
    { ...identity, configuration: {} },
    { capabilities: { sandbox, credential_proxy: proxy } },
  );
  const authority: ProtectedRepositoryGitAuthority = {
    readMaterial: outOfScope,
    authorize: outOfScope,
    online: { readMaterial: outOfScope, authorize: outOfScope },
    recipients: { observe: outOfScope, beginInstall: outOfScope, confirmInstall: outOfScope },
  };
  const binding = await bindRepositoryGitTransport(
    {
      ...drivers,
      sandboxDriver: sandbox,
      proxyDriver: proxy,
      repositoryGitDriver: owner,
      protectedDriver: owner,
    },
    authority,
    { connect: outOfScope, end: outOfScope },
    emit,
    pendingLog === undefined ? {} : { pendingLog },
  );
  assert.ok(binding);
  return { binding, closeSender };
}
