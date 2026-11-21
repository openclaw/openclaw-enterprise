import type { Driver } from "../index.ts";
import type {
  Configuration,
  ConfigurationReference,
  OpenClawConfigurationDocument,
} from "../../index.ts";

/**
 * Options for Configuration rules that also run on Preset defaults. `unresolved` locates text its
 * writer fills in later (an unfilled Preset variable): for the string at `path` in the values (an
 * object key: `key` true, `path` ending in the key), the literal text around each unfilled
 * variable, or undefined. A rule checks that text with a stand-in for each variable, and the
 * Configuration the filled Preset creates is checked like any other. Text is located by path, so
 * literal text that reads the same elsewhere (an escaped token) is checked as written.
 */
export interface ConfigurationValidationOptions {
  readonly unresolved?: (
    path: readonly (string | number)[],
    key?: boolean,
  ) => readonly string[] | undefined;
  /**
   * The declared type of an unfilled variable that is the whole value at `path`, or undefined:
   * a number or boolean fills a field that takes text with no string.
   */
  readonly unresolvedType?: (
    path: readonly (string | number)[],
  ) => "string" | "number" | "boolean" | "password" | undefined;
}

export interface ConfigurationDriver extends Driver {
  readonly capability: "configuration";
  /**
   * Side-effect-free admission of partial native values before Preset storage. `unresolved`
   * locates the text that waits on a Preset variable without a default.
   */
  validateValues?(
    values: OpenClawConfigurationDocument,
    options?: ConfigurationValidationOptions,
  ): Promise<void>;
  /**
   * Refuses values too large to store, as `validate` would. OCC calls it before its content
   * rules on Configuration create and update and Agent provisioning, so no rule walks them.
   * Throw OCC's `ConfigurationSizeError` so the API names the limit to the caller.
   */
  validateSize?(values: OpenClawConfigurationDocument): Promise<void>;
  create(configuration: Configuration): Promise<Configuration>;
  createExact?(configuration: Configuration): Promise<Configuration>;
  inspectExact?(configuration: Configuration): Promise<Configuration | undefined>;
  read(reference: ConfigurationReference): Promise<Configuration>;
  update(configuration: Configuration): Promise<Configuration>;
  delete(reference: ConfigurationReference): Promise<void>;
  validate(configuration: Configuration): Promise<void>;
}
