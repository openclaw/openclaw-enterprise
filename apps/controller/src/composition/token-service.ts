import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  credentialSourceMatchesSnapshot,
  isNativeStagedRepositoryRevision,
  revisionCredentialSourceSnapshot,
  type InstallationSecretStore,
} from "@openclaw-enterprise/contracts";
import {
  CredentialDeliveryFailedError,
  type OpenClawController,
  type PlatformStateStore,
} from "@openclaw-enterprise/occ";

import { OAuthAccountTokens } from "../backends/token-service/oauth-connection.ts";
import { OCCTokenServiceDriver } from "../drivers/token-service/occ.ts";
import { refreshCodexOAuthGrant } from "../drivers/token-service/codex-device-authorization.ts";
import type { InstallationRuntimeDrivers } from "./installation-config.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The marker belongs to the selected Secret Driver's private store ownership. */
async function credentialStoreIdentity(
  store: InstallationSecretStore,
  installationId: string,
  secretDriverId: string,
): Promise<string> {
  const ref = { installationId, id: `token-service-store-identity:${secretDriverId}` };
  const read = () => store.withValue(ref, async (value) => value);
  let value: string;
  try {
    value = await read();
  } catch {
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

/** Install the selected owner after the private Secret store is available. */
export async function installTokenServiceDriver(
  controller: OpenClawController,
  drivers: InstallationRuntimeDrivers | undefined,
  state: PlatformStateStore,
): Promise<void> {
  const selection = drivers?.installation.drivers.token_service;
  if (!selection || !drivers) {
    return;
  }
  const store = drivers.secretDriver.installationSecrets;
  if (!store) {
    throw new Error("The OCC TokenService requires an installation-private credential store.");
  }
  const storeIdentity = await credentialStoreIdentity(
    store,
    controller.installation.id,
    drivers.secretDriver.id,
  );
  const instanceId = await controller.activateTokenServiceInstance(selection.id, storeIdentity);
  const delivery = drivers.credentialDeliveryRegistration?.require("credential_proxy_delivery");
  const owner: OCCTokenServiceDriver = new OCCTokenServiceDriver(
    selection.id,
    controller.installation.id,
    store,
    instanceId,
    state,
    delivery,
    new OAuthAccountTokens(
      state,
      drivers.secretDriver,
      controller.resolveConnectionClient.bind(controller),
      refreshCodexOAuthGrant,
      delivery === undefined
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
    ),
    undefined,
    drivers.repositoryRegistry === undefined ? undefined : { registry: drivers.repositoryRegistry },
  );
  controller.registerDriver(owner);
  controller.selectDriver("token_service", owner.id);
  if (delivery !== undefined) {
    const [{ OpenShellCredentialProxyDriver }, { OpenShellCredentialDeliveryRefusedError }] =
      await Promise.all([
        import("../drivers/credential-proxy/openshell.ts"),
        import("../drivers/credential-proxy/openshell-pushed-provider.ts"),
      ]);
    if (delivery instanceof OpenShellCredentialProxyDriver) {
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
          !revision.repositoryCredentials ||
          Date.now() >= revision.repositoryCredentials.deadlineWallMs ||
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
  }
}
