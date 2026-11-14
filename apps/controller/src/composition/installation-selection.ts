import {
  requireConfiguration,
  serializeStartupConfiguration,
  type DriverImplementation,
} from "@openclaw-enterprise/contracts";
import { DriverConfigurationRegistry } from "@openclaw-enterprise/occ";
import { object, nonempty, type ConfigurationRecord } from "./installation-fields.ts";

export interface SelectedDriverConfiguration<T = ConfigurationRecord> {
  readonly id: string;
  readonly implementation: string;
  readonly package?: string;
  readonly configuration: T;
  readonly definition: DriverImplementation;
  readonly startupConfiguration?: Readonly<Record<string, unknown>>;
}

export function selected(
  value: unknown,
  capability:
    | "configuration"
    | "iam"
    | "compute"
    | "secret"
    | "sandbox"
    | "credential_gateway"
    | "credential_refresh"
    | "credential_proxy"
    | "plugin"
    | "repo",
  implementation: string,
  driver: DriverImplementation,
  path = `drivers.${capability}`,
): SelectedDriverConfiguration {
  const selection = object(value, path);
  const id = nonempty(selection.id, `${path}.id`);
  const configuration = object(selection.configuration, `${path}.configuration`);
  const schema = object(driver.configurationSchema, `${path}.configurationSchema`);
  if (schema.additionalProperties !== false) {
    throw new Error(`${path} must expose a closed configuration schema before construction.`);
  }
  // Registration checks the startup schema and every contributed schema.
  new DriverConfigurationRegistry().register({
    capability,
    driverId: id,
    implementation,
    definition: driver,
  });
  const validated = object(requireConfiguration(driver, configuration), `${path}.configuration`);
  let startupConfiguration: Readonly<Record<string, unknown>> | undefined;
  try {
    // Capture accepted values before a factory can mutate its own configuration input.
    startupConfiguration = serializeStartupConfiguration(schema, validated);
  } catch {
    // Unsupported inspection remains unavailable; never fall back to raw values or exception text.
  }
  return Object.freeze({
    id,
    implementation,
    ...(Object.hasOwn(selection, "package")
      ? { package: nonempty(selection.package, `${path}.package`) }
      : {}),
    configuration: validated,
    definition: driver,
    ...(startupConfiguration === undefined ? {} : { startupConfiguration }),
  });
}
