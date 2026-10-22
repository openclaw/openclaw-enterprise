import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ComputeLifecycleHooks,
  CredentialProxyDriver,
  Driver,
  DriverByCapability,
  DriverCapability,
  DriverRegistration,
  DriverRegistrationRef,
  ProxyPlan,
} from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { canonicalProvisioningJson } from "./agent-provisioning.ts";
import {
  capability,
  driverHasCapabilityContract,
  driverHasValidLifecycleHooks,
} from "./driver-contract.ts";
import { DriverSelectionError } from "./errors.ts";

/** One process-local owner. Its reference, unlike object identity, survives an API/worker handoff. */
export class InstalledDriver {
  readonly ref: DriverRegistrationRef;
  readonly capabilities: readonly DriverCapability[];
  readonly lifecycleDriver: Driver | undefined;
  readonly #views = new Map<DriverCapability, { id: string; driver: Driver }>();
  readonly #close: (() => void | Promise<void>) | undefined;
  #closing: Promise<void> | undefined;

  constructor(
    selection: {
      readonly id: string;
      readonly implementation: string;
      readonly configuration: unknown;
    },
    registration: DriverRegistration,
    // Installation composition supplies the configured identity for each capability.
    capabilityIds: Readonly<Partial<Record<DriverCapability, string>>> = {},
  ) {
    const { id, implementation, configuration } = selection;
    if (!isNonEmptyString(id) || !isNonEmptyString(implementation)) {
      throw new DriverSelectionError(
        "A Driver registration requires an identity and implementation.",
      );
    }
    const configurationId = createHash("sha256")
      .update(canonicalProvisioningJson({ configuration, capabilityIds }))
      .digest("hex");
    this.ref = Object.freeze({ id, implementation, configurationId });
    for (const [key, driver] of Object.entries(registration.capabilities)) {
      if (
        !capability(key) ||
        !asRecord(driver) ||
        driver.capability !== key ||
        driver.id !== (capabilityIds[key] ?? id) ||
        driver.implementation !== implementation ||
        driver.computeLifecycleHooks !== undefined ||
        !driverHasCapabilityContract(driver)
      ) {
        throw new DriverSelectionError(
          "A Driver registration must provide the exact selected capability contracts and own their lifecycle.",
        );
      }
      this.#views.set(key, { id: driver.id, driver });
    }
    const first = this.#views.keys().next().value;
    if (first === undefined) {
      throw new DriverSelectionError("A Driver registration must provide a capability.");
    }
    this.capabilities = Object.freeze([...this.#views.keys()]);
    const hooks: ComputeLifecycleHooks | undefined = registration.computeLifecycleHooks;
    if (hooks !== undefined) {
      const lifecycle = { id, implementation, capability: first, computeLifecycleHooks: hooks };
      if (!driverHasValidLifecycleHooks(lifecycle)) {
        throw new DriverSelectionError("A Driver registration has invalid lifecycle hooks.");
      }
      this.lifecycleDriver = Object.freeze(lifecycle);
    }
    this.#close = registration.close?.bind(registration);
    Object.freeze(this);
  }

  /** Recheck the exact view and its identity, including after a package has returned it. */
  require<K extends DriverCapability>(key: K): DriverByCapability[K] {
    const view = this.#views.get(key);
    if (
      !view ||
      view.driver.capability !== key ||
      view.driver.id !== view.id ||
      view.driver.implementation !== this.ref.implementation ||
      !driverHasCapabilityContract(view.driver)
    ) {
      throw new DriverSelectionError(
        "The installed Driver no longer supplies the selected capability.",
      );
    }
    return view.driver as DriverByCapability[K];
  }

  /** Admission needs both operational views; release still requires the observed recipient. */
  requireRepositoryGitTransport(): NonNullable<CredentialProxyDriver["bindRepositoryGit"]> {
    const sandbox = this.require("sandbox");
    const proxy = this.require("credential_proxy");
    if (!sandbox.repositoryAccess || typeof proxy.bindRepositoryGit !== "function") {
      throw new DriverSelectionError(
        "Protected repository Git requires the selected Driver's Sandbox access and Credential Proxy transport.",
      );
    }
    return proxy.bindRepositoryGit.bind(proxy);
  }

  /** Match the exact registered owner and configured capability identities. */
  ownsProxyPlan(plan: ProxyPlan): boolean {
    return (
      this.require("sandbox").id === plan.sandboxDriverId &&
      this.require("credential_proxy").id === plan.egressDriverId &&
      isDeepStrictEqual(plan.driver, this.ref)
    );
  }

  close(): Promise<void> {
    return (this.#closing ??= Promise.resolve().then(() => this.#close?.()));
  }
}
