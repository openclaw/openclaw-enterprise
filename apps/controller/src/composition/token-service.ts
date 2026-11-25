import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import {
  credentialSourceMatchesSnapshot,
  isNativeStagedRepositoryRevision,
  revisionCredentialSourceSnapshot,
  type PrivateSecretStore,
} from "@openclaw-enterprise/contracts";
import {
  CredentialDeliveryFailedError,
  DependencyUnavailableError,
  type OpenClawController,
  type PlatformStateStore,
} from "@openclaw-enterprise/occ";
import type { FastifyInstance } from "fastify";

import { OAuthAccountTokens } from "../backends/token-service/oauth-connection.ts";
import { OpenShellCredentialProxyDriver } from "../drivers/credential-proxy/openshell.ts";
import { OCCTokenServiceDriver } from "../drivers/token-service/occ.ts";
import { refreshCodexOAuthGrant } from "../drivers/token-service/codex-device-authorization.ts";
import type { GitHubAppIssuerOptions } from "../drivers/token-service/github-app-issuer.ts";
import { OpenShellTokenServiceDriver } from "../drivers/token-service/openshell.ts";
import type { InstallationRuntimeDrivers } from "./installation-config.ts";
import { emitOccLogEvent, type OccLogger } from "../logging.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The marker belongs to the selected Secret Driver's private store ownership. */
async function credentialStoreIdentity(
  store: PrivateSecretStore,
  installationId: string,
  secretDriverId: string,
  role: "api" | "worker",
): Promise<string> {
  const ref = { installationId, id: `token-service-store-identity:${secretDriverId}` };
  const read = () => store.withValue(ref, async (value) => value);
  let value: string;
  try {
    value = await read();
  } catch (error) {
    if (role === "worker") {
      throw error;
    }
    try {
      await store.create(ref, randomUUID());
    } catch {
      // A concurrent startup or uncertain create must read the winning marker.
    }
    value = await read();
  }
  if (!uuid.test(value)) {
    throw new Error("The TokenService credential store identity is invalid.");
  }
  return value;
}

/** Activate and install the selected TokenService owner. */
export async function installTokenServiceDriver(
  controller: OpenClawController,
  drivers: InstallationRuntimeDrivers | undefined,
  state: PlatformStateStore,
  options: {
    readonly role?: "api" | "worker";
    readonly githubAppIssuerOptions?: GitHubAppIssuerOptions;
  } = {},
): Promise<OCCTokenServiceDriver | undefined> {
  const selection = drivers?.installation.drivers.token_service;
  if (!selection || !drivers) {
    return;
  }
  const delivery = drivers.credentialDeliveryRegistration?.require("credential_proxy_delivery");
  if (selection.implementation === OpenShellTokenServiceDriver.implementation) {
    const backend = drivers.openShellTokenServiceBackend;
    if (!backend || !(delivery instanceof OpenShellCredentialProxyDriver)) {
      throw new Error("The OpenShell TokenService requires its paired native Credential Proxy.");
    }
    const storeIdentity = await OpenShellTokenServiceDriver.readStoreIdentity(
      backend,
      AbortSignal.timeout(30_000),
    );
    const instanceId = await controller.activateTokenServiceInstance(
      selection.id,
      `openshell:${backend.id}:${storeIdentity}`,
    );
    const owner = new OpenShellTokenServiceDriver({
      id: selection.id,
      tokenServiceInstanceId: instanceId,
      backend,
      storeIdentity,
      state,
      resolveNamespace: async (namespace) => {
        const placed = await drivers.computeDriver.resolveSandboxNamespace?.(namespace);
        if (!placed) {
          throw new DependencyUnavailableError(
            "The OpenShell TokenService Namespace placement is unavailable.",
          );
        }
        return placed;
      },
      credentialProxy: delivery,
    });
    delivery.bindNativeSourceResolver((sourceRef, signal) =>
      owner.resolveNativeProvider({ sourceRef, tokenServiceInstanceId: instanceId }, signal),
    );
    controller.registerDriver(owner);
    controller.selectDriver("token_service", owner.id);
    return;
  }
  const store = drivers.secretDriver.privateSecrets;
  const role = options.role ?? "api";
  if (!store) {
    throw new Error("The OCC TokenService requires a private credential store.");
  }
  const storeIdentity = await credentialStoreIdentity(
    store,
    controller.installation.id,
    drivers.secretDriver.id,
    role,
  );
  const instanceId = await controller.activateTokenServiceInstance(selection.id, storeIdentity);
  const owner: OCCTokenServiceDriver = new OCCTokenServiceDriver(
    selection.id,
    controller.installation.id,
    store,
    instanceId,
    state,
    delivery,
    new OAuthAccountTokens(
      state,
      store,
      controller.resolveConnectionClient.bind(controller),
      refreshCodexOAuthGrant,
      role === "worker" || delivery === undefined
        ? undefined
        : async (ref, version, signal) => {
            const sourceRef = {
              kind: "credential_source" as const,
              namespaceId: ref.namespaceId,
              id: ref.sourceId,
            };
            try {
              if (delivery.notifyCredentialUpdated === undefined) {
                throw new Error("The selected Credential Proxy cannot deliver a renewal.");
              }
              await delivery.notifyCredentialUpdated(
                { sourceRef, version },
                () =>
                  owner.resolveCredential(
                    { sourceRef, tokenServiceInstanceId: instanceId },
                    signal,
                  ),
                signal,
              );
            } catch {
              throw new CredentialDeliveryFailedError();
            }
          },
      role,
    ),
    options.githubAppIssuerOptions,
    drivers.repositoryRegistry === undefined ? undefined : { registry: drivers.repositoryRegistry },
  );
  controller.registerDriver(owner);
  controller.selectDriver("token_service", owner.id);
  if (delivery instanceof OpenShellCredentialProxyDriver) {
    const { OpenShellCredentialDeliveryRefusedError } =
      await import("../drivers/credential-proxy/openshell-pushed-provider.ts");
    delivery.bindSourceNamespaceResolver(async (sourceRef, signal) => {
      signal.throwIfAborted();
      if (controller.selectedDriver("credential_proxy_delivery") !== delivery) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      const { namespace, source } = await state.read(async (view) => ({
        namespace: await view.namespaces.findNamespace(sourceRef.namespaceId),
        source: await view.credentialSources.findCredentialSource(
          sourceRef.namespaceId,
          sourceRef.id,
        ),
      }));
      if (
        namespace?.status !== "ready" ||
        source?.ownerCapability !== "token_service" ||
        source.state !== "ready" ||
        source.tokenServiceInstanceId !== instanceId ||
        controller.selectedDriver("token_service") !== owner
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      const compute = controller.selectedDriver("compute");
      const placed = await compute.resolveSandboxNamespace?.(namespace);
      signal.throwIfAborted();
      if (placed?.id !== sourceRef.namespaceId || placed.status !== "ready") {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      return placed;
    });
    delivery.bindSourceRevisionResolver(async (sourceRef, agentId, revisionId, signal) => {
      signal.throwIfAborted();
      if (
        controller.selectedDriver("credential_proxy_delivery") !== delivery ||
        controller.selectedDriver("token_service") !== owner
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      const { agent, revision, withdrawals, source } = await state.read(async (view) => ({
        agent: await view.agents.findAgent(sourceRef.namespaceId, agentId),
        revision: await view.revisions.findRevision(sourceRef.namespaceId, agentId, revisionId),
        withdrawals: await view.credentialSources.listCredentialWithdrawals(
          sourceRef.namespaceId,
          revisionId,
        ),
        source: await view.credentialSources.findCredentialSource(
          sourceRef.namespaceId,
          sourceRef.id,
        ),
      }));
      const deployment = revision?.credentialDeployment;
      if (
        agent?.status !== "active" ||
        agent.desiredRuntimeState !== "running" ||
        agent.activeRevisionId !== revisionId ||
        revision?.servicePrincipalId !== agent.servicePrincipalId ||
        revision.executionAdmission.version !== 8 ||
        revision.executionAdmission.mode !== "standalone" ||
        revision.sandboxDriverId !== delivery.id ||
        deployment?.proxyDriverId !== delivery.id ||
        !isDeepStrictEqual(deployment.driver, drivers.credentialDeliveryRegistration?.ref) ||
        deployment.bindings.some(
          ({ sourceRef: bound }) => bound.namespaceId !== sourceRef.namespaceId,
        ) ||
        source?.ownerCapability !== "token_service" ||
        source.type !== "github-app-installation" ||
        source.state !== "ready" ||
        source.tokenServiceInstanceId !== instanceId ||
        !credentialSourceMatchesSnapshot(
          source,
          revisionCredentialSourceSnapshot(revision, sourceRef.id),
        )
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      const withdrawn = new Set(withdrawals.map(({ credentialSourceId }) => credentialSourceId));
      const activeBindings = deployment.bindings.filter(
        ({ sourceRef: bound }) => !withdrawn.has(bound.id),
      );
      if (
        !isNativeStagedRepositoryRevision(revision) ||
        !activeBindings.some(
          ({ sourceRef: bound, consumer }) =>
            consumer.kind === "repository" && bound.id === sourceRef.id,
        )
      ) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      const iam = controller.selectedDriver("iam");
      for (const { sourceRef: bound } of activeBindings) {
        const decision = await iam.authorize({
          principalId: agent.servicePrincipalId,
          action: "operate",
          resource: bound,
        });
        if (decision.driverId !== iam.id || !decision.allowed) {
          throw new OpenShellCredentialDeliveryRefusedError();
        }
      }
      signal.throwIfAborted();
      return {
        revision,
        activeBindingRefs: new Set(activeBindings.map(({ bindingRef }) => bindingRef)),
      };
    });
  }
  return owner;
}

/** The API renews Sources in the private store and drains in-flight exchanges before closing. */
export function scheduleTokenServiceMaintenance(
  app: FastifyInstance,
  owner: OCCTokenServiceDriver,
  logger?: OccLogger,
): () => Promise<void> {
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  app.addHook("onReady", async () => {
    running = Promise.all([
      maintainSources(owner.maintainGitSources.bind(owner), "git-source", stop.signal, logger),
      maintainSources(owner.maintainOAuthSources.bind(owner), "oauth-source", stop.signal, logger),
    ]).then(() => undefined);
  });
  return async () => {
    stop.abort();
    await running;
  };
}

async function maintainSources(
  maintain: OCCTokenServiceDriver["maintainGitSources"],
  kind: "git-source" | "oauth-source",
  stop: AbortSignal,
  logger: OccLogger | undefined,
): Promise<void> {
  const batchSize = 4;
  const renewalFailed =
    kind === "git-source" ? "GIT_SOURCE_RENEWAL_FAILED" : "OAUTH_SOURCE_RENEWAL_FAILED";
  const scanFailed = kind === "git-source" ? "GIT_SOURCE_SCAN_FAILED" : "OAUTH_SOURCE_SCAN_FAILED";
  let cursor: string | undefined;
  while (!stop.aborted) {
    try {
      const result = await maintain(batchSize, cursor);
      if (logger && (result.failed || result.deliveryFailed)) {
        emitOccLogEvent(logger, {
          event: `${kind}.maintenance-failed`,
          code: result.failed ? renewalFailed : "CREDENTIAL_DELIVERY_FAILED",
        });
      }
      cursor = result.cursor;
      if (cursor !== undefined) {
        continue;
      }
    } catch {
      if (logger) {
        emitOccLogEvent(logger, {
          event: `${kind}.maintenance-failed`,
          code: scanFailed,
        });
      }
    }
    try {
      await delay(5_000, undefined, { signal: stop, ref: false });
    } catch {
      return;
    }
  }
}
