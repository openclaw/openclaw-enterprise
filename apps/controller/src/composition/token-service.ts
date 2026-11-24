import { randomUUID } from "node:crypto";

import type { InstallationSecretStore } from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  type OpenClawController,
  type PlatformStateStore,
} from "@openclaw-enterprise/occ";

import { OpenShellCredentialProxyDriver } from "../drivers/credential-proxy/openshell.ts";
import { OCCTokenServiceDriver } from "../drivers/token-service/occ.ts";
import { OpenShellTokenServiceDriver } from "../drivers/token-service/openshell.ts";
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

/** Activate and install the selected TokenService owner. */
export async function installTokenServiceDriver(
  controller: OpenClawController,
  drivers: InstallationRuntimeDrivers | undefined,
  state: PlatformStateStore,
  options: { bindSourceUpdatePlacement?: boolean } = {},
): Promise<void> {
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
  const owner = new OCCTokenServiceDriver(
    selection.id,
    controller.installation.id,
    store,
    instanceId,
    state,
    delivery,
  );
  controller.registerDriver(owner);
  controller.selectDriver("token_service", owner.id);
  if (
    delivery instanceof OpenShellCredentialProxyDriver &&
    options.bindSourceUpdatePlacement !== false
  ) {
    const { OpenShellCredentialDeliveryRefusedError } =
      await import("../drivers/credential-proxy/openshell-pushed-provider.ts");
    delivery.bindSourceNamespaceResolver(async (sourceRef, signal) => {
      signal.throwIfAborted();
      if (controller.selectedDriver("credential_proxy_delivery") !== delivery) {
        throw new OpenShellCredentialDeliveryRefusedError();
      }
      const namespace = await state.read((view) =>
        view.namespaces.findNamespace(sourceRef.namespaceId),
      );
      if (namespace?.status !== "ready") {
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
  }
}
