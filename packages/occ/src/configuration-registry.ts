import {
  assertConfigurationSchema,
  DRIVER_CAPABILITIES,
  type ConfigurationContribution,
  type DriverCapability,
  type DriverConfigurationDescriptor,
  type DriverImplementation,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";

export interface DriverConfigurationRegistration {
  readonly capability: DriverCapability;
  readonly driverId: string;
  readonly implementation: string;
  readonly definition: DriverImplementation;
  readonly startupConfiguration?: Readonly<Record<string, unknown>>;
}

interface Entry extends DriverConfigurationRegistration {
  readonly contribution: ConfigurationContribution;
  readonly binding: DriverConfigurationDescriptor["binding"];
}

// Resource owners, rather than Drivers, define which contributions have an API lifecycle.
const ownerBindings = new Map<string, Entry["binding"]>([
  ["sandbox/agent/sandbox-network-policy", "sandbox-policy"],
]);

export class DriverConfigurationRegistry {
  private readonly entries = new Map<string, Entry>();

  register(registration: DriverConfigurationRegistration): void {
    const { capability, driverId, definition } = registration;
    if (
      !DRIVER_CAPABILITIES.includes(capability) ||
      !driverId?.trim() ||
      !registration.implementation?.trim()
    ) {
      throw new Error("Invalid Driver configuration registration identity.");
    }
    const contributions: ConfigurationContribution[] = [
      {
        scope: "installation",
        key: "startup",
        configurationSchema: definition.configurationSchema,
        validateConfiguration: (input) => definition.validateConfiguration(input),
      },
      ...(definition.configurationContributions ?? []),
    ];
    const pending = new Map<string, Entry>();
    for (const [index, contribution] of contributions.entries()) {
      if (
        !["installation", "agent"].includes(contribution.scope) ||
        typeof contribution.key !== "string" ||
        !/^[a-z][a-z0-9-]*$/.test(contribution.key) ||
        (index > 0 && contribution.key === "startup") ||
        typeof contribution.validateConfiguration !== "function"
      ) {
        throw new Error("Invalid Driver configuration contribution.");
      }
      const binding =
        index === 0
          ? "installation-startup"
          : ownerBindings.get(`${capability}/${contribution.scope}/${contribution.key}`);
      if (binding === undefined) {
        throw new Error("Driver configuration contribution has no resource owner binding.");
      }
      assertConfigurationSchema(contribution.configurationSchema);
      const key = this.identity(capability, driverId, contribution.scope, contribution.key);
      if (this.entries.has(key) || pending.has(key)) {
        throw new Error("Duplicate Driver configuration contribution identity.");
      }
      pending.set(key, {
        ...registration,
        ...(registration.startupConfiguration === undefined
          ? {}
          : { startupConfiguration: immutableCopy(registration.startupConfiguration) }),
        contribution,
        binding,
      });
    }
    for (const [key, entry] of pending) {
      this.entries.set(key, entry);
    }
  }

  resolve(capability: DriverCapability, driverId: string, scope: string, key: string): Entry {
    const entry = this.entries.get(this.identity(capability, driverId, scope, key));
    if (entry === undefined) {
      throw new Error("The selected Driver configuration contribution is unavailable.");
    }
    return entry;
  }

  list(scope: "installation" | "agent"): readonly Entry[] {
    return [...this.entries.values()].filter((entry) => entry.contribution.scope === scope);
  }

  private identity(
    capability: DriverCapability,
    driverId: string,
    scope: string,
    key: string,
  ): string {
    return JSON.stringify([capability, driverId, scope, key]);
  }
}
