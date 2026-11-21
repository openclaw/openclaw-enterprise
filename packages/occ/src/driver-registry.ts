import type {
  ComputeDriver,
  Driver,
  DriverByCapability,
  DriverCapability,
  NamespaceLifecycleParticipant,
  PluginDriver,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type { DriverConfigurationRegistry } from "./configuration-registry.ts";
import {
  capability,
  driverHasCapabilityContract,
  driverHasValidLifecycleHooks,
} from "./driver-contract.ts";
import { DependencyUnavailableError, DriverSelectionError } from "./errors.ts";
import { InstalledDriver } from "./installed-driver.ts";
import {
  selectedNamespaceLifecycle,
  type NamespaceLifecycleBinding,
} from "./namespace-lifecycle.ts";

export interface RegisteredDriver {
  readonly harnessId?: string;
  readonly owner?: InstalledDriver;
  readonly driver: Driver;
  readonly capability: DriverCapability;
  readonly id: string;
  readonly implementation: string;
}

export type DriverFor<Capability extends DriverCapability> = DriverByCapability[Capability];

interface DriverRegistryDependencies {
  readonly configurations: Pick<DriverConfigurationRegistry, "resolve">;
  readonly namespaceLifecycleBindings: readonly NamespaceLifecycleBinding[];
  readonly hasBuiltInRepositoryPolicy: () => boolean;
}

function driverKey(capability: DriverCapability, id: string): string {
  return `${capability}\u0000${id}`;
}

export function unchangedDriver(selected: RegisteredDriver): boolean {
  return (
    (!selected.owner || selected.owner.require(selected.capability) === selected.driver) &&
    selected.driver.id === selected.id &&
    selected.driver.capability === selected.capability &&
    selected.driver.implementation === selected.implementation &&
    (selected.capability !== "plugin" ||
      (selected.driver as PluginDriver).harnessId === selected.harnessId) &&
    driverHasCapabilityContract(selected.driver)
  );
}

/** Owns the live registrations and publishes selections after lifecycle validation. */
export class DriverRegistry {
  private readonly registrations = new Map<string, RegisteredDriver>();
  private readonly selections = new Map<DriverCapability, RegisteredDriver>();
  private pluginRegistrations: readonly RegisteredDriver[] = [];
  private readonly dependencies: DriverRegistryDependencies;

  constructor(dependencies: DriverRegistryDependencies) {
    this.dependencies = dependencies;
  }

  /** Read the exact selection record, for callers that recheck identity after external work. */
  selection(capability: DriverCapability): RegisteredDriver | undefined {
    return this.selections.get(capability);
  }

  hasSelection(capability: DriverCapability): boolean {
    return this.selections.has(capability);
  }

  hasPluginDrivers(): boolean {
    return this.pluginRegistrations.length > 0;
  }

  registerDriver<T extends Driver | InstalledDriver>(driver: T): T {
    const owner = driver instanceof InstalledDriver ? driver : undefined;
    const views = owner ? owner.capabilities.map((key) => owner.require(key)) : [driver as Driver];
    const entries = views.map((view) => this.driverRegistrationEntry(view, owner));
    if (
      owner &&
      [...this.registrations.values()].some((entry) => entry.owner?.ref.id === owner.ref.id)
    ) {
      throw new DriverSelectionError(
        "A Driver is already registered for this installation identity.",
      );
    }
    // Check every capability and conflict before exposing any part of this registration.
    for (const [key, entry] of entries) {
      this.registrations.set(key, entry);
    }
    return driver;
  }

  /** Install one trusted catalog per Harness family. */
  installPluginDrivers(drivers: readonly PluginDriver[]): void {
    const registrations = drivers.map((driver) => this.driverRegistrationEntry(driver));
    if (
      new Set(drivers.map((driver) => driver.harnessId)).size !== drivers.length ||
      new Set(drivers.map((driver) => driver.id)).size !== drivers.length
    ) {
      throw new DriverSelectionError(
        "Each Plugin Driver must have a distinct identity and Harness.",
      );
    }
    this.selectPluginRegistrations(registrations.map(([, entry]) => entry));
    for (const [key, entry] of registrations) {
      this.registrations.set(key, entry);
    }
  }

  private selectPluginRegistrations(entries: readonly RegisteredDriver[]): void {
    this.applyLifecycleDrivers(this.selections, entries);
    this.pluginRegistrations = entries;
  }

  private driverRegistrationEntry(
    driver: Driver,
    owner?: InstalledDriver,
  ): [string, RegisteredDriver] {
    if (
      !driver ||
      !isNonEmptyString(driver.id) ||
      !isNonEmptyString(driver.implementation) ||
      !capability(driver.capability) ||
      !driverHasCapabilityContract(driver) ||
      !driverHasValidLifecycleHooks(driver)
    ) {
      throw new DriverSelectionError("The Driver does not satisfy its exact capability contract.");
    }
    if (driver.capability === "repo" && this.dependencies.hasBuiltInRepositoryPolicy()) {
      throw new DriverSelectionError(
        "Built-in repository policy cannot be combined with a registered Repo Driver.",
      );
    }
    const key = driverKey(driver.capability, driver.id);
    if (this.registrations.has(key)) {
      throw new DriverSelectionError(
        "A Driver is already registered for this exact capability and identity.",
      );
    }
    if (driver.capability === "sandbox" && (driver as SandboxDriver).networkPolicy !== undefined) {
      this.dependencies.configurations.resolve(
        "sandbox",
        driver.id,
        "agent",
        "sandbox-network-policy",
      );
    }
    return [
      key,
      Object.freeze({
        driver,
        ...(driver.capability === "plugin"
          ? { harnessId: (driver as PluginDriver).harnessId }
          : {}),
        capability: driver.capability,
        id: driver.id,
        implementation: driver.implementation,
        ...(owner && { owner }),
      }),
    ];
  }

  selectDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
    driverId: string,
  ): DriverFor<Capability> {
    if (!capability(selectedCapability) || !isNonEmptyString(driverId)) {
      throw new DriverSelectionError(
        "The Driver capability or implementation identity is invalid.",
      );
    }
    const selected = this.registrations.get(driverKey(selectedCapability, driverId));
    if (!selected || !unchangedDriver(selected)) {
      throw new DriverSelectionError(
        "No registered Driver matches the exact selected capability and identity.",
      );
    }
    if (selectedCapability === "plugin") {
      this.selectPluginRegistrations([selected]);
      return selected.driver as DriverFor<Capability>;
    }
    return this.applyDriverSelection(selectedCapability, selected);
  }

  selectedDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
  ): DriverFor<Capability> {
    if (!capability(selectedCapability)) {
      throw new DriverSelectionError("The requested Driver capability is invalid.");
    }
    const selected =
      selectedCapability === "plugin" && this.pluginRegistrations.length === 1
        ? this.pluginRegistrations[0]
        : this.selections.get(selectedCapability);
    if (!selected || !unchangedDriver(selected)) {
      throw new DriverSelectionError(
        "The selected Driver is unavailable or no longer matches its capability.",
      );
    }
    return selected.driver as DriverFor<Capability>;
  }

  selectedProxyOwner(): InstalledDriver {
    const proxy = this.selections.get("credential_proxy");
    const sandbox = this.selections.get("sandbox");
    const owner = proxy?.owner;
    if (
      !owner ||
      owner !== sandbox?.owner ||
      owner.require("sandbox") !== sandbox.driver ||
      owner.require("credential_proxy") !== proxy.driver
    ) {
      throw new DriverSelectionError(
        "Protected execution requires Sandbox and Credential Proxy from the same registered Driver.",
      );
    }
    return owner;
  }

  backendDrivers(): Partial<Record<DriverCapability, Driver>> {
    const delivery = this.selections.get("credential_proxy_delivery");
    if (
      delivery !== undefined &&
      (!delivery.owner ||
        delivery.owner !== this.selections.get("sandbox")?.owner ||
        delivery.owner.require("credential_proxy_delivery") !== delivery.driver)
    ) {
      throw new DriverSelectionError(
        "Credential delivery and Sandbox must come from the same registered Driver.",
      );
    }
    return Object.fromEntries(
      [...this.selections.entries()].map(([capability, selection]) => [
        capability,
        selection.driver,
      ]),
    );
  }

  namespaceLifecycle(selectCompute: () => ComputeDriver): {
    compute: ComputeDriver;
    participants: readonly NamespaceLifecycleParticipant[];
  } {
    const owners = [...this.selections.values(), ...this.pluginRegistrations].map((selected) => {
      if (!unchangedDriver(selected)) {
        throw new DriverSelectionError("A selected Namespace lifecycle Driver changed identity.");
      }
      return selected.owner ?? selected.driver;
    });
    const compute = selectCompute();
    return {
      compute,
      participants: selectedNamespaceLifecycle(
        owners,
        this.dependencies.namespaceLifecycleBindings,
      ),
    };
  }

  configurationDriverSelected(capability: DriverCapability, id: string): boolean {
    return capability === "plugin"
      ? this.pluginRegistrations.some((entry) => entry.id === id)
      : this.selections.get(capability)?.id === id;
  }

  enabledPluginDrivers(): readonly PluginDriver[] {
    return this.pluginRegistrations.map((entry) => {
      if (!unchangedDriver(entry)) {
        throw new DependencyUnavailableError("A configured Plugin Driver is unavailable.");
      }
      return entry.driver as PluginDriver;
    });
  }

  private applyDriverSelection<Capability extends DriverCapability>(
    selectedCapability: Capability,
    selected: RegisteredDriver,
  ): DriverFor<Capability> {
    const proposed = new Map(this.selections);
    proposed.set(selectedCapability, selected);
    this.applyLifecycleDrivers(proposed, this.pluginRegistrations);
    this.selections.set(selectedCapability, selected);
    return selected.driver as DriverFor<Capability>;
  }

  private applyLifecycleDrivers(
    proposed: ReadonlyMap<DriverCapability, RegisteredDriver>,
    plugins: readonly RegisteredDriver[],
  ): void {
    const namespaceParticipants = selectedNamespaceLifecycle(
      [...proposed.values(), ...plugins].map((entry) => entry.owner ?? entry.driver),
      this.dependencies.namespaceLifecycleBindings,
    );
    const lifecycleDrivers = this.lifecycleDrivers(proposed, plugins);
    const compute = proposed.get("compute");
    if (compute !== undefined) {
      if (!unchangedDriver(compute)) {
        throw new DriverSelectionError("The selected compute Driver identity has changed.");
      }
      const selectedCompute = compute.driver as ComputeDriver;
      if (
        namespaceParticipants.some(({ hooks }) => hooks.deleteNamespace !== undefined) &&
        typeof selectedCompute.checkNamespaceDeletion !== "function"
      ) {
        throw new DriverSelectionError(
          "Namespace cleanup requires Compute deletion eligibility checks.",
        );
      }
      if (typeof selectedCompute.setLifecycleDrivers === "function") {
        selectedCompute.setLifecycleDrivers(lifecycleDrivers);
      } else if (lifecycleDrivers.length > 0) {
        throw new DriverSelectionError(
          "The selected compute Driver cannot accept selected lifecycle Drivers.",
        );
      }
    }
  }

  private lifecycleDrivers(
    selections: ReadonlyMap<DriverCapability, RegisteredDriver>,
    plugins: readonly RegisteredDriver[],
  ): readonly Driver[] {
    const drivers = new Set<Driver>();
    for (const selected of [...selections.values(), ...plugins]) {
      if (selected.capability === "compute") {
        continue;
      }
      if (!unchangedDriver(selected)) {
        throw new DriverSelectionError(
          "A selected lifecycle Driver no longer matches its registered identity.",
        );
      }
      const lifecycle = selected.owner ? selected.owner.lifecycleDriver : selected.driver;
      if (lifecycle?.computeLifecycleHooks !== undefined) {
        drivers.add(lifecycle);
      }
    }
    return Object.freeze([...drivers]);
  }
}
