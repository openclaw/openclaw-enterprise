import { asRecord, deepFreeze, immutableCopy } from "@openclaw-enterprise/utils";
import {
  type JSONSchema,
  type PluginCatalogEntry,
  type PluginDriver,
  type PluginDriverContext,
  type PluginDriverIdentity,
} from "@openclaw-enterprise/contracts";
import { NotImplementedError, ScopeViolationError } from "@openclaw-enterprise/occ";
import { openClawCatalogEntries, type CodexPluginCatalogReader } from "./runtime-translator.ts";
import { NativeCodexPluginCatalogReader } from "./stdio-catalog-reader.ts";

type ConfigurationRecord = Readonly<Record<string, unknown>>;

interface PluginDriverSelection {
  readonly id?: string;
  readonly implementation?: string;
}

type BundledCatalogEntry = PluginCatalogEntry;

export class PluginValidationError extends ScopeViolationError {}

const OCC_DRIVER_ID = "occ-plugin";
const OCC_IMPLEMENTATION = "occ/openclaw-plugin";
const CODEX_DRIVER_ID = "codex-plugin";
const CODEX_IMPLEMENTATION = "occ/codex-plugin";

const EMPTY_CONFIGURATION_SCHEMA: JSONSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

const CODEX_CONFIGURATION_SCHEMA: JSONSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    codexExecutable: { type: "string", minLength: 1 },
    codexHome: { type: "string", minLength: 1 },
    requestTimeoutMs: { type: "integer", minimum: 1, maximum: 60_000 },
  },
});

const OCC_CATALOG: readonly BundledCatalogEntry[] = deepFreeze(openClawCatalogEntries());

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PluginValidationError(`${path} must be a nonempty string.`);
  }
  return value;
}

function validateEmptyConfiguration(configuration: unknown, name: string): void {
  const value = asRecord(configuration);
  if (value === undefined) {
    throw new PluginValidationError(`${name} configuration must be one object.`);
  }
  const keys = Object.keys(value);
  if (keys.length > 0) {
    throw new PluginValidationError(`${name} configuration does not accept options.`);
  }
}

function validateCodexConfiguration(
  configuration: unknown,
): ConstructorParameters<typeof NativeCodexPluginCatalogReader>[0] | undefined {
  const value = asRecord(configuration);
  if (value === undefined) {
    throw new PluginValidationError("Codex Plugin Driver configuration must be one object.");
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!["codexExecutable", "codexHome", "requestTimeoutMs"].includes(key)) {
      throw new PluginValidationError(`Codex Plugin Driver configuration.${key} is unsupported.`);
    }
  }
  if (keys.length === 0) {
    return undefined;
  }
  const codexExecutable = requiredString(value.codexExecutable, "codexExecutable");
  const codexHome = requiredString(value.codexHome, "codexHome");
  const requestTimeoutMs = value.requestTimeoutMs;
  if (
    requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(requestTimeoutMs) ||
      (requestTimeoutMs as number) < 1 ||
      (requestTimeoutMs as number) > 60_000)
  ) {
    throw new PluginValidationError("requestTimeoutMs must be between 1 and 60000.");
  }
  return {
    codexExecutable,
    codexHome,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs: requestTimeoutMs as number }),
  };
}

function sameDriver(left: PluginDriverIdentity, right: PluginDriverIdentity): boolean {
  return left.id === right.id && left.implementation === right.implementation;
}

function ensureHarness(context: PluginDriverContext, mode: "embedded" | "dedicated"): void {
  if (context.harness.mode !== mode) {
    throw notImplemented(
      "plugin-harness-mismatch",
      "The selected Plugin Driver does not match the Harness.",
    );
  }
}

function notImplemented(operation: string, message: string): NotImplementedError {
  return new NotImplementedError(operation, message);
}

class BundledPluginDriverBase {
  readonly capability = "plugin" as const;
  readonly id: string;
  readonly implementation: string;

  protected constructor(selection: PluginDriverSelection, defaults: PluginDriverIdentity) {
    this.id = requiredString(selection.id ?? defaults.id, "Plugin Driver ID");
    this.implementation = selection.implementation ?? defaults.implementation;
    if (!sameDriver(this, defaults)) {
      throw new PluginValidationError("Unsupported bundled Plugin Driver identity.");
    }
  }

  protected catalog(catalog: readonly BundledCatalogEntry[]): readonly PluginCatalogEntry[] {
    return immutableCopy(catalog) as readonly PluginCatalogEntry[];
  }
}

export class OCCPluginDriver extends BundledPluginDriverBase implements PluginDriver {
  static readonly configurationSchema = EMPTY_CONFIGURATION_SCHEMA;

  static validateConfiguration(configuration: unknown): void {
    validateEmptyConfiguration(configuration, "OpenClaw Plugin Driver");
  }

  constructor(configuration: ConfigurationRecord = {}, selection: PluginDriverSelection = {}) {
    OCCPluginDriver.validateConfiguration(configuration);
    super(selection, { id: OCC_DRIVER_ID, implementation: OCC_IMPLEMENTATION });
  }

  async listCatalog(context: PluginDriverContext): Promise<readonly PluginCatalogEntry[]> {
    ensureHarness(context, "embedded");
    return this.catalog(OCC_CATALOG);
  }
}

export class CodexPluginDriver extends BundledPluginDriverBase implements PluginDriver {
  static readonly configurationSchema = CODEX_CONFIGURATION_SCHEMA;
  private readonly catalogReader: CodexPluginCatalogReader | undefined;

  static validateConfiguration(configuration: unknown): void {
    validateCodexConfiguration(configuration);
  }

  constructor(
    configuration: ConfigurationRecord = {},
    selection: PluginDriverSelection = {},
    catalogReader?: CodexPluginCatalogReader,
  ) {
    const discovery = validateCodexConfiguration(configuration);
    super(selection, { id: CODEX_DRIVER_ID, implementation: CODEX_IMPLEMENTATION });
    this.catalogReader =
      catalogReader ??
      (discovery === undefined ? undefined : new NativeCodexPluginCatalogReader(discovery));
  }

  async listCatalog(context: PluginDriverContext): Promise<readonly PluginCatalogEntry[]> {
    ensureHarness(context, "dedicated");
    if (this.catalogReader === undefined) {
      throw notImplemented(
        "codex-plugin-catalog-discovery",
        "Codex plugin catalog discovery requires configured codexExecutable and codexHome.",
      );
    }
    return this.catalog(await this.catalogReader.listCatalog(context.signal));
  }
}
