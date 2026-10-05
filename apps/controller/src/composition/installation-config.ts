import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadYaml } from "@kubernetes/client-node";
import type {
  Backend,
  ComputeDriver,
  ConfigurationDriver,
  CredentialGatewayDriver,
  DriverImplementation,
  IAMDriver,
  Identity,
  BackendDefinition,
  OpenShellBackendDefinition,
  Preset,
  BackendSummary,
  RepoDriver,
  PluginDriver,
  SandboxDriver,
  SecretDriver,
} from "@openclaw-enterprise/contracts";
import { NativeIAMDriver, type NativeIAMStateStore } from "@openclaw-enterprise/iam";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  validateBackendDefinitions,
  type BundledPresetVersion,
  type NativeWorkerSupport,
  type OpenClawController,
  type PostgresPlatformState,
  type SkippedDefaultPreset,
} from "@openclaw-enterprise/occ";
import { Check, Errors } from "typebox/value";
import { validatePresetTemplate } from "@openclaw-enterprise/contracts";
import {
  KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../drivers/compute/kubernetes/index.ts";
import { createExternalDriver, loadDriverPackage } from "./driver-packages.ts";
import { SshComputeDriver, type SshComputeDriverOptions } from "../drivers/compute/ssh/index.ts";
import {
  KubernetesConfigurationDriver,
  type KubernetesConfigurationDriverOptions,
} from "../drivers/configuration/kubernetes/index.ts";
import {
  KubernetesSecretDriver,
  type KubernetesSecretDriverOptions,
} from "../drivers/secret/kubernetes/index.ts";
import { type LoggingConfiguration, operationalLoggingConfiguration } from "../logging.ts";
import { OCCPluginDriver, CodexPluginDriver } from "../drivers/plugin/index.ts";
import { createGatewayNodeEnrollment } from "../gateway/node-enrollment-client.ts";
import { readWorkspaceFilesApiKey } from "./workspace-files.ts";
import { GitHubRepoDriver } from "../drivers/repo/github/driver.ts";
import { composeRepoDriver } from "./repository-credentials/platform.ts";
import { createOpenShellBackend, type OpenShellGateway } from "../backends/openshell.ts";
import {
  OpenShellCredentialGatewayDriver,
  type OpenShellCredentialGatewayOptions,
} from "../drivers/credential-gateway/openshell.ts";

type ConfigurationRecord = Readonly<Record<string, unknown>>;

export interface StartupConfigurationSnapshot {
  readonly configuration?: ConfigurationRecord;
  readonly configurationPath?: string;
  readonly logging: LoggingConfiguration;
  readonly observability?: { readonly url: string };
}

export interface SelectedDriverConfiguration<T = ConfigurationRecord> {
  readonly id: string;
  readonly implementation: string;
  readonly package?: string;
  readonly configuration: T;
}

export interface InstallationStartupConfiguration {
  readonly occ: { readonly cluster: string };
  readonly logging: LoggingConfiguration;
  readonly presets?: { readonly includeDefaults: boolean; readonly files?: readonly string[] };
  readonly observability?: { readonly url: string };
  /** Declares a runtime image built with native worker support; see configuration reference. */
  readonly runtime?: { readonly nativeWorkerSupport: NativeWorkerSupport };
  readonly backend: readonly BackendDefinition[];
  readonly drivers: {
    readonly configuration: SelectedDriverConfiguration;
    readonly iam: SelectedDriverConfiguration<ConfigurationRecord>;
    readonly compute: SelectedDriverConfiguration;
    readonly secret: SelectedDriverConfiguration;
    readonly sandbox?: SelectedDriverConfiguration;
    readonly credential_gateway?: SelectedDriverConfiguration;
    readonly plugin?: SelectedDriverConfiguration;
    readonly service_account?: { readonly id: string };
    readonly repo?: SelectedDriverConfiguration;
  };
}

export type ServiceAccountDriverFactory = (
  controller: OpenClawController,
  state: PostgresPlatformState,
) => void;

/** A bundled default skipped because a `presets.files` entry uses its name. */
export interface ShadowedDefaultPreset {
  readonly presetName: string;
  /** Resolved path of the operator's file. */
  readonly presetFile: string;
}

export interface InstallationRuntimeDrivers {
  readonly defaultPresets?: readonly Pick<Preset, "name" | "template">[];
  /** Bundled defaults replaced by a same-named `presets.files` entry; startup warns once each. */
  readonly shadowedDefaultPresets?: readonly ShadowedDefaultPreset[];
  /** Shipped versions of the bundled defaults, loaded even when they are not seeded. */
  readonly bundledPresetVersions?: readonly BundledPresetVersion[];
  readonly installation: InstallationStartupConfiguration;
  readonly computeDriver: ComputeDriver;
  readonly configurationDriver: ConfigurationDriver;
  readonly secretDriver: SecretDriver;
  readonly sandboxDriver?: SandboxDriver;
  readonly credentialGatewayDriver?: CredentialGatewayDriver;
  readonly pluginDriver?: PluginDriver;
  readonly repoDriver?: RepoDriver;
  readonly repositoryReceipt?: Readonly<{
    controlSocket: string;
    driverId: string;
    implementation: string;
    backendId: string;
  }>;
  readonly createIAMDriver: (state: NativeIAMStateStore) => IAMDriver;
}

/**
 * Resolve an authorized startup actor without depending on persisted identity order.
 *
 * A refresh the policy refuses never stops startup: the copy stays and `onWarning` receives
 * one `presets.default-refresh-skipped` event naming it. The first pass skips only refusals
 * from a deny Restriction, which binds every administrator alike, so an administrator without
 * a Namespace grant never stands in for one who could refresh. If none can, the second pass
 * skips every refusal. Missing defaults still need an administrator who can create them,
 * unless a deny Restriction refuses the creation: then the default stays missing and
 * `onWarning` receives one `presets.default-create-skipped` event naming it.
 */
export async function initializeInstallationPresets(
  controller: OpenClawController,
  iam: IAMDriver,
  identities: readonly Identity[],
  defaults: readonly Pick<Preset, "name" | "template">[],
  onWarning?: (event: Readonly<Record<string, unknown>>) => void,
): Promise<void> {
  if (defaults.length === 0) {
    return;
  }
  const administrators: string[] = [];
  for (const identity of identities) {
    if (identity.kind !== "principal") {
      continue;
    }
    const decision = await iam.authorize({
      principalId: identity.id,
      action: "administer",
      resource: { kind: "installation", id: controller.installation.id },
    });
    if (decision.allowed) {
      administrators.push(identity.id);
    }
  }
  let denied: AuthorizationDeniedError | undefined;
  for (const skipRefusedRefresh of ["restricted", "denied"] as const) {
    for (const principalId of administrators) {
      let skipped: readonly SkippedDefaultPreset[];
      try {
        skipped = await controller.initializeDefaultPresets(principalId, { skipRefusedRefresh });
      } catch (error) {
        // An administrator whose grant stops at the Installation (for example the admin Role
        // bound to the installation resource only) cannot create Presets in a Namespace. Each
        // attempt is one rolled-back transaction, so the next administrator starts clean.
        // Outages are not denials: they stop startup with their own error.
        if (
          !(error instanceof AuthorizationDeniedError) ||
          error instanceof DependencyUnavailableError
        ) {
          throw error;
        }
        denied = error;
        continue;
      }
      for (const preset of skipped) {
        onWarning?.({
          event:
            preset.operation === "create"
              ? "presets.default-create-skipped"
              : "presets.default-refresh-skipped",
          namespaceId: preset.namespaceId,
          ...(preset.operation === "update" ? { presetId: preset.presetId } : {}),
          presetName: preset.presetName,
          reason: preset.reason,
          restrictionIds: preset.restrictionIds,
        });
      }
      return;
    }
  }
  throw new Error(
    "Default Preset initialization requires an Installation administrator who can create Presets in every Namespace.",
    denied === undefined ? undefined : { cause: denied },
  );
}

interface LoadedStartupConfiguration {
  readonly configuration?: ConfigurationRecord;
  readonly path?: string;
}

async function startupConfiguration(
  options: {
    readonly mode: "development" | "production";
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
  required: boolean,
): Promise<LoadedStartupConfiguration> {
  const environment = options.environment ?? process.env;
  const path = environment.OCC_CONFIG_PATH;
  if (path === undefined) {
    if (!required) {
      return {};
    }
    throw new Error("OCC_CONFIG_PATH must identify the Installation startup YAML.");
  }
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("OCC_CONFIG_PATH must identify the Installation startup YAML.");
  }
  if (!isAbsolute(path)) {
    throw new Error("OCC_CONFIG_PATH must identify an absolute Installation startup YAML path.");
  }

  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw new Error("The configured Installation startup YAML is unavailable.");
  }

  let parsed: unknown;
  try {
    parsed = loadYaml(contents);
  } catch {
    throw new Error("The configured Installation startup file must contain valid YAML.");
  }
  const configuration = object(parsed, "Installation startup configuration");
  safe(configuration, "Installation startup configuration");
  if (Object.hasOwn(configuration, "integrations")) {
    throw new Error(
      "integrations is retired; configure ChatGPT with backend[].configuration.apiKeyPath.",
    );
  }
  closed(
    configuration,
    ["occ", "drivers", "backend", "logging", "presets", "observability", "runtime"],
    "Installation startup configuration",
  );
  return { configuration, path };
}

export async function loadStartupConfigurationSnapshot(options: {
  readonly mode: "development" | "production";
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<StartupConfigurationSnapshot> {
  const startup = await startupConfiguration(options, options.mode === "production");
  const { configuration } = startup;
  const logging = operationalLoggingConfiguration(configuration?.logging);
  const observability = observabilityConfiguration(configuration?.observability);
  return Object.freeze({
    ...(configuration === undefined ? {} : { configuration }),
    ...(startup.path === undefined ? {} : { configurationPath: startup.path }),
    logging,
    ...(observability === undefined ? {} : { observability }),
  });
}

interface BundledOpenShellSandboxDriverModule extends DriverImplementation {
  readonly OpenShellSandboxDriver: new (
    configuration: ConfigurationRecord,
    selection: {
      readonly id: string;
      readonly implementation: string;
      readonly backend: Backend<OpenShellGateway>;
    },
  ) => SandboxDriver;
}

const FORBIDDEN_SECRET_KEY =
  /(?:password|passwd|api[_-]?key|(?:access[_-]?)?token|private[_-]?key|(?:client[_-]?)?secret|credentials?)$/i;
const FORBIDDEN_SECRET_VALUE =
  /\bBearer\s+[A-Za-z0-9._~-]+|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{12,}|\bAKIA[0-9A-Z]{16}\b/i;

function object(value: unknown, path: string): ConfigurationRecord {
  const result = asRecord(value);
  if (result === undefined) {
    throw new Error(`${path} must be one object.`);
  }
  return result;
}

function closed(value: ConfigurationRecord, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new Error(`${path} contains unsupported option ${key}.`);
    }
  }
}

function nonempty(value: unknown, path: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${path} must be a nonempty string.`);
  }
  return value;
}

function runtimeConfiguration(
  value: unknown,
): { readonly nativeWorkerSupport: NativeWorkerSupport } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const configuration = object(value, "runtime");
  closed(configuration, ["nativeWorkerSupport"], "runtime");
  if (configuration.nativeWorkerSupport !== "custom-image") {
    throw new Error('runtime.nativeWorkerSupport must be "custom-image" when set.');
  }
  return Object.freeze({ nativeWorkerSupport: "custom-image" });
}

function observabilityConfiguration(value: unknown): { readonly url: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const configuration = object(value, "observability");
  closed(configuration, ["url"], "observability");
  const raw = nonempty(configuration.url, "observability.url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("observability.url must be an absolute HTTP or HTTPS URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "observability.url must be an absolute HTTP or HTTPS URL without credentials or a fragment.",
    );
  }
  return Object.freeze({ url: url.href });
}

function safe(value: unknown, path: string): void {
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error(`${path} must be a safe integer.`);
  }
  if (typeof value === "string" && FORBIDDEN_SECRET_VALUE.test(value)) {
    throw new Error(`${path} must not contain a plaintext credential.`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => safe(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "installationId" || key === "installation_id") {
      throw new Error("Installation startup configuration must not contain an Installation ID.");
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`${path} contains an unsafe configuration key.`);
    }
    if (FORBIDDEN_SECRET_KEY.test(key) && typeof entry === "string") {
      throw new Error(`${path}.${key} must not contain a plaintext credential.`);
    }
    if (key === "secretRef") {
      nonempty(entry, `${path}.${key}`);
      throw new Error("Installation-scoped secret references cannot be resolved safely.");
    }
    safe(entry, `${path}.${key}`);
  }
}

function backendConfiguration(
  value: unknown,
  serviceAccount: InstallationStartupConfiguration["drivers"]["service_account"],
  repoSelection: InstallationStartupConfiguration["drivers"]["repo"],
  credentialGatewayId: string | undefined,
): readonly BackendDefinition[] {
  const backends = validateBackendDefinitions(value ?? []);
  if (serviceAccount !== undefined && !backends.some((backend) => backend.type === "chatgpt")) {
    throw new Error("drivers.service_account requires an owning backend entry with type chatgpt.");
  }
  if (repoSelection !== undefined && !backends.some((backend) => backend.type === "github")) {
    throw new Error("drivers.repo requires an owning backend entry with type github.");
  }
  if (
    credentialGatewayId !== undefined &&
    !backends.some((backend) => backend.type === "openshell")
  ) {
    throw new Error(
      "drivers.credential_gateway requires an owning backend entry with type openshell.",
    );
  }
  for (const backend of backends) {
    if (backend.type === "openshell") {
      // Sandbox membership is checked once the Sandbox selection is resolved.
      if (backend.drivers.credential_gateway !== credentialGatewayId) {
        throw new Error(
          `backend[${backend.id}].drivers.credential_gateway must match the selected drivers.credential_gateway.id.`,
        );
      }
      continue;
    }
    if (backend.type === "github") {
      if (repoSelection === undefined) {
        throw new Error(`backend[${backend.id}].drivers.repo requires drivers.repo.`);
      }
      if (backend.drivers.repo !== repoSelection.id) {
        throw new Error(
          `backend[${backend.id}].drivers.repo must match the selected drivers.repo.id.`,
        );
      }
      continue;
    }
    if (serviceAccount === undefined) {
      throw new Error(
        `backend[${backend.id}].drivers.service_account requires drivers.service_account.`,
      );
    }
    if (backend.drivers.service_account !== serviceAccount.id) {
      throw new Error(
        `backend[${backend.id}].drivers.service_account must match the selected drivers.service_account.id.`,
      );
    }
  }
  return backends;
}

function presetDefinition(value: unknown, path: string): Pick<Preset, "name" | "template"> {
  const preset = object(value, path);
  closed(preset, ["name", "template"], path);
  return Object.freeze({
    name: nonempty(preset.name, `${path}.name`),
    template: validatePresetTemplate(preset.template),
  });
}

/**
 * A `presets.files` list or entry that cannot become a default Preset: not a list of
 * paths, or a file that is missing, unreadable, malformed, invalid, or a duplicate name. API and worker startup report it as
 * `PRESET_FILE_INVALID` without the path or message, which stay in the thrown error.
 */
export class PresetFileError extends Error {
  override readonly name = "PresetFileError";
}

async function loadPresetDefinition(
  path: string | URL,
): Promise<Pick<Preset, "name" | "template">> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw new Error(`Preset file ${path} is unavailable.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Preset file ${path} must contain valid JSON.`);
  }
  return presetDefinition(parsed, `Preset file ${path}`);
}

const bundledPresetDirectory = new URL("../../../../deploy/presets/", import.meta.url);

/**
 * Load every shipped version of the bundled defaults. `archive/versions.json` lists each
 * bundled file's versions oldest first; the last is the file itself and the others are
 * archived as `archive/<file stem>/<version>.json`. A conformance test keeps it complete.
 */
async function loadBundledPresetVersions(): Promise<readonly BundledPresetVersion[]> {
  const indexPath = new URL("archive/versions.json", bundledPresetDirectory);
  let index: unknown;
  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
  } catch (cause) {
    throw new Error(
      `Bundled Preset version index ${fileURLToPath(indexPath)} is unavailable or invalid.`,
      { cause },
    );
  }
  const versions: BundledPresetVersion[] = [];
  for (const [file, history] of Object.entries(object(index, "Bundled Preset versions"))) {
    if (
      !/^[a-z0-9-]+\.json$/.test(file) ||
      !Array.isArray(history) ||
      history.length === 0 ||
      history.some((version) => typeof version !== "string" || !/^[0-9a-f]{16}$/.test(version))
    ) {
      throw new Error(`Bundled Preset versions for ${file} are invalid.`);
    }
    const stem = file.slice(0, -".json".length);
    for (const [position, version] of (history as string[]).entries()) {
      const current = position === history.length - 1;
      const preset = await loadPresetDefinition(
        new URL(current ? file : `archive/${stem}/${version}.json`, bundledPresetDirectory),
      );
      versions.push(Object.freeze({ ...preset, file, version, current }));
    }
  }
  return Object.freeze(versions);
}

export function backendSummariesFromDefinitions(
  backends: readonly BackendDefinition[],
): readonly BackendSummary[] {
  return Object.freeze(
    backends.map((backend) =>
      Object.freeze({
        id: backend.id,
        type: backend.type,
      }),
    ),
  );
}

function selected(
  value: unknown,
  capability:
    | "configuration"
    | "iam"
    | "compute"
    | "secret"
    | "sandbox"
    | "credential_gateway"
    | "plugin"
    | "repo",
  implementation: string,
  driver: DriverImplementation,
): SelectedDriverConfiguration {
  const path = `drivers.${capability}`;
  const selection = object(value, path);
  const id = nonempty(selection.id, `${path}.id`);
  const configuration = object(selection.configuration, `${path}.configuration`);
  const schema = object(driver.configurationSchema, `${path}.configurationSchema`);
  if (schema.additionalProperties !== false) {
    throw new Error(`${path} must expose a closed configuration schema before construction.`);
  }
  let validSchema = false;
  try {
    validSchema = Check(schema, configuration);
  } catch {
    // An unsupported schema must fail closed instead of skipping validation.
  }
  if (!validSchema) {
    throw new Error(
      `${path}.configuration does not match its Driver configuration schema${schemaMismatch(schema, configuration)}.`,
    );
  }
  driver.validateConfiguration(configuration);
  return Object.freeze({
    id,
    implementation,
    ...(Object.hasOwn(selection, "package")
      ? { package: nonempty(selection.package, `${path}.package`) }
      : {}),
    configuration,
  });
}

// Names the first mismatched field and the expected shape, never the value,
// which may be a credential reference.
function schemaMismatch(schema: Record<string, unknown>, configuration: unknown): string {
  try {
    for (const error of Errors(schema, configuration)) {
      return ` at ${error.instancePath || "/"}: ${error.message}`;
    }
  } catch {
    // The generic message still fails closed.
  }
  return "";
}

export async function loadInstallationConfiguration(options: {
  readonly mode: "development" | "production";
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly packageRoot?: string;
  readonly startupConfiguration?: StartupConfigurationSnapshot;
  /** Real-runtime tests replace the transport or the Driver; never a production path. */
  readonly createOpenShellBackend?: (
    definition: OpenShellBackendDefinition,
  ) => Backend<OpenShellGateway>;
  readonly createSandboxDriver?: (
    selection: SelectedDriverConfiguration,
    backend: Backend<OpenShellGateway> | undefined,
  ) => SandboxDriver;
}): Promise<InstallationRuntimeDrivers | undefined> {
  const environment = options.environment ?? process.env;
  if (environment.OCC_INSTALLATION_ID !== undefined) {
    throw new Error("OCC_INSTALLATION_ID is unsupported; the Installation is a singleton.");
  }
  for (const name of [
    "OCC_COMPUTE_DRIVER",
    "OCC_KUBERNETES_CONFIG_PATH",
    "OCC_NATIVE_IAM_DRIVER_ID",
  ]) {
    if (environment[name] !== undefined) {
      throw new Error(`${name} is unsupported; select Drivers in the Installation startup YAML.`);
    }
  }
  const startup = options.startupConfiguration ?? (await loadStartupConfigurationSnapshot(options));
  const { configuration, configurationPath, logging } = startup;
  if (configuration === undefined && options.mode === "production") {
    throw new Error("OCC_CONFIG_PATH must identify the Installation startup YAML.");
  }
  if (configuration === undefined) {
    return undefined;
  }
  if (
    options.mode === "development" &&
    configuration.occ === undefined &&
    configuration.drivers === undefined &&
    configuration.backend === undefined &&
    configuration.presets === undefined
  ) {
    return undefined;
  }
  const presets = object(
    configuration.presets === undefined ? {} : configuration.presets,
    "presets",
  );
  closed(presets, ["includeDefaults", "files"], "presets");
  if (presets.includeDefaults !== undefined && typeof presets.includeDefaults !== "boolean") {
    throw new Error("presets.includeDefaults must be a boolean.");
  }
  if (
    presets.files !== undefined &&
    (!Array.isArray(presets.files) || presets.files.some((entry) => typeof entry !== "string"))
  ) {
    throw new PresetFileError("presets.files must be an array of Preset JSON file paths.");
  }
  const includeDefaults = presets.includeDefaults === true;
  const bundledPresetVersions = await loadBundledPresetVersions();
  const filePresets: {
    readonly path: string;
    readonly preset: Pick<Preset, "name" | "template">;
  }[] = [];
  const filePresetPaths = new Map<string, string>();
  for (const entry of (presets.files ?? []) as readonly string[]) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new PresetFileError("presets.files entries must be nonempty file paths.");
    }
    if (!isAbsolute(trimmed) && configurationPath === undefined) {
      throw new PresetFileError(
        "Relative presets.files entries require an Installation startup YAML path.",
      );
    }
    const path = isAbsolute(trimmed) ? trimmed : resolve(dirname(configurationPath!), trimmed);
    let preset: Pick<Preset, "name" | "template">;
    try {
      preset = await loadPresetDefinition(path);
    } catch (error) {
      throw new PresetFileError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
    const earlier = filePresetPaths.get(preset.name);
    if (earlier !== undefined) {
      throw new PresetFileError(
        `Default Preset ${preset.name} is configured more than once: ${earlier} and ${path}.`,
      );
    }
    filePresetPaths.set(preset.name, path);
    filePresets.push({ path, preset });
  }
  // An operator file named like a bundled default replaces that default: a later release can
  // bundle a name an operator already uses (default-codex), and startup must not stop for it.
  const defaultPresets: Pick<Preset, "name" | "template">[] = [];
  const shadowedDefaultPresets: ShadowedDefaultPreset[] = [];
  if (includeDefaults) {
    for (const version of bundledPresetVersions) {
      if (!version.current) {
        continue;
      }
      const shadow = filePresets.find(({ preset }) => preset.name === version.name);
      if (shadow !== undefined) {
        shadowedDefaultPresets.push(
          Object.freeze({ presetName: version.name, presetFile: shadow.path }),
        );
        continue;
      }
      defaultPresets.push(Object.freeze({ name: version.name, template: version.template }));
    }
  }
  defaultPresets.push(...filePresets.map(({ preset }) => preset));
  const occ = object(configuration.occ, "occ");
  closed(occ, ["cluster"], "occ");
  const cluster = nonempty(occ.cluster, "occ.cluster");
  const observability = observabilityConfiguration(configuration.observability);
  const runtime = runtimeConfiguration(configuration.runtime);
  const drivers = object(configuration.drivers, "drivers");
  closed(
    drivers,
    [
      "configuration",
      "iam",
      "compute",
      "secret",
      "sandbox",
      "credential_gateway",
      "plugin",
      "service_account",
      "repo",
    ],
    "drivers",
  );

  let serviceAccount: InstallationStartupConfiguration["drivers"]["service_account"];
  if (drivers.service_account !== undefined) {
    const selection = object(drivers.service_account, "drivers.service_account");
    closed(selection, ["id", "configuration"], "drivers.service_account");
    const driverConfiguration = object(
      selection.configuration,
      "drivers.service_account.configuration",
    );
    closed(driverConfiguration, [], "drivers.service_account.configuration");
    serviceAccount = Object.freeze({ id: nonempty(selection.id, "drivers.service_account.id") });
  }
  let repoSelection: SelectedDriverConfiguration | undefined;
  if (drivers.repo !== undefined) {
    const selection = object(drivers.repo, "drivers.repo");
    closed(selection, ["id", "configuration"], "drivers.repo");
    repoSelection = selected(selection, "repo", "github", GitHubRepoDriver);
  }
  let credentialGateway: SelectedDriverConfiguration | undefined;
  if (drivers.credential_gateway !== undefined) {
    const selection = object(drivers.credential_gateway, "drivers.credential_gateway");
    closed(selection, ["id", "configuration"], "drivers.credential_gateway");
    credentialGateway = selected(
      selection,
      "credential_gateway",
      "openshell",
      OpenShellCredentialGatewayDriver,
    );
  }
  const backends = backendConfiguration(
    configuration.backend,
    serviceAccount,
    repoSelection,
    credentialGateway?.id,
  );
  const openShellBackend = backends.find(
    (backend): backend is OpenShellBackendDefinition => backend.type === "openshell",
  );

  const configurationSelection = object(drivers.configuration, "drivers.configuration");
  const iamSelection = object(drivers.iam, "drivers.iam");
  const computeSelection = object(drivers.compute, "drivers.compute");
  const secretSelection = object(drivers.secret, "drivers.secret");
  const sandboxSelection =
    drivers.sandbox === undefined ? undefined : object(drivers.sandbox, "drivers.sandbox");
  const pluginSelection =
    drivers.plugin === undefined ? undefined : object(drivers.plugin, "drivers.plugin");
  if (pluginSelection !== undefined) {
    closed(pluginSelection, ["id", "configuration"], "drivers.plugin");
    if (pluginSelection.id !== "occ-plugin" && pluginSelection.id !== "codex-plugin") {
      throw new Error("drivers.plugin.id must select occ-plugin or codex-plugin.");
    }
  }
  const PluginImplementation =
    pluginSelection?.id === "codex-plugin" ? CodexPluginDriver : OCCPluginDriver;
  const plugin =
    pluginSelection === undefined
      ? undefined
      : selected(
          pluginSelection,
          "plugin",
          pluginSelection.id === "codex-plugin" ? "occ/codex-plugin" : "occ/openclaw-plugin",
          PluginImplementation,
        );
  const pluginDriver =
    plugin === undefined
      ? undefined
      : new PluginImplementation(plugin.configuration, {
          id: plugin.id,
          implementation: plugin.implementation,
        });
  for (const [capability, selection] of [
    ["configuration", configurationSelection],
    ["iam", iamSelection],
    ["compute", computeSelection],
    ["secret", secretSelection],
    ...(sandboxSelection === undefined ? [] : ([["sandbox", sandboxSelection]] as const)),
  ] as const) {
    closed(
      selection,
      capability === "secret" ? ["id", "configuration"] : ["id", "package", "configuration"],
      `drivers.${capability}`,
    );
  }
  const packageRoot = options.packageRoot ?? fileURLToPath(new URL("../../", import.meta.url));
  if (!isAbsolute(packageRoot)) {
    throw new Error("The trusted controller package root must be absolute.");
  }
  const configurationPackage = await loadDriverPackage(
    configurationSelection,
    "configuration",
    packageRoot,
    options.packageRoot !== undefined,
  );
  const iamPackage = await loadDriverPackage(
    iamSelection,
    "iam",
    packageRoot,
    options.packageRoot !== undefined,
  );
  const computePackage = await loadDriverPackage(
    computeSelection,
    "compute",
    packageRoot,
    options.packageRoot !== undefined,
  );
  const sshCompute = computePackage === undefined && computeSelection.id === "compute-ssh";
  const kubernetesCompute = computePackage === undefined && !sshCompute;
  if (repoSelection !== undefined && (!kubernetesCompute || sandboxSelection !== undefined)) {
    throw new Error(
      "drivers.repo requires the bundled Kubernetes Compute Driver without a Sandbox Driver.",
    );
  }
  if (sshCompute && sandboxSelection !== undefined) {
    throw new Error(
      "drivers.sandbox is unsupported with compute-ssh; it requires the bundled Kubernetes Compute Driver.",
    );
  }
  const sandboxPackage =
    sandboxSelection === undefined
      ? undefined
      : await loadDriverPackage(
          sandboxSelection,
          "sandbox",
          packageRoot,
          options.packageRoot !== undefined,
        );
  const bundledSandboxPackage =
    sandboxSelection !== undefined && sandboxPackage === undefined
      ? await loadBundledOpenShellSandboxDriver()
      : undefined;

  const configured = selected(
    configurationSelection,
    "configuration",
    configurationPackage?.implementation ?? "occ/kubernetes-configmap",
    configurationPackage?.module ?? KubernetesConfigurationDriver,
  );
  const iam = selected(
    iamSelection,
    "iam",
    iamPackage?.implementation ?? "occ/native-iam",
    iamPackage?.module ?? NativeIAMDriver,
  );
  const compute = selected(
    computeSelection,
    "compute",
    computePackage?.implementation ?? (sshCompute ? "occ/ssh" : "occ/kubernetes"),
    computePackage?.module ?? (sshCompute ? SshComputeDriver : KubernetesComputeDriver),
  );
  const secret = selected(
    secretSelection,
    "secret",
    "occ/kubernetes-secret",
    KubernetesSecretDriver,
  );
  if (repoSelection !== undefined) {
    const kubernetes = compute.configuration as unknown as KubernetesComputeDriverOptions;
    if (kubernetes.network.repositoryCredentials?.port !== 8443) {
      throw new Error(
        "drivers.repo requires an exact Kubernetes repository service peer on port 8443.",
      );
    }
  }
  const sandbox =
    sandboxSelection === undefined
      ? undefined
      : selected(
          sandboxSelection,
          "sandbox",
          sandboxPackage?.implementation ?? "openshell",
          sandboxPackage?.module ?? bundledSandboxPackage!,
        );
  if (sandbox !== undefined && computePackage !== undefined) {
    throw new Error("drivers.sandbox requires the bundled Kubernetes Compute Driver.");
  }
  if (sandbox !== undefined && sandboxPackage === undefined && openShellBackend === undefined) {
    throw new Error(
      "The bundled OpenShell drivers.sandbox requires a backend entry with type openshell.",
    );
  }
  if (
    openShellBackend !== undefined &&
    (sandbox === undefined ||
      sandboxPackage !== undefined ||
      openShellBackend.drivers.sandbox !== sandbox.id)
  ) {
    throw new Error(
      `backend[${openShellBackend.id}].drivers.sandbox must match the selected bundled OpenShell drivers.sandbox.id.`,
    );
  }
  if (credentialGateway !== undefined && !kubernetesCompute) {
    throw new Error("drivers.credential_gateway requires the bundled Kubernetes Compute Driver.");
  }
  if (options.mode === "production" && kubernetesCompute) {
    const kubernetes = compute.configuration as unknown as KubernetesComputeDriverOptions;
    if (kubernetes.images.requireImmutableDigest !== true) {
      throw new Error("Production Kubernetes workloads require immutable image digests.");
    }
    if (kubernetes.runtime === undefined) {
      throw new Error(
        "Production Kubernetes workloads require the explicitly configured Codex runtime.",
      );
    }
    if (kubernetes.servicePrincipalCredentials.mode !== "projectedServiceAccountToken") {
      throw new Error("Production Codex Agents require projected ServicePrincipal credentials.");
    }
  }
  const installation = Object.freeze({
    occ: Object.freeze({ cluster }),
    presets: Object.freeze({ includeDefaults }),
    logging,
    ...(observability === undefined ? {} : { observability }),
    ...(runtime === undefined ? {} : { runtime }),
    backend: backends,
    drivers: Object.freeze({
      configuration: configured,
      iam,
      compute,
      secret,
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(credentialGateway === undefined ? {} : { credential_gateway: credentialGateway }),
      ...(plugin === undefined ? {} : { plugin }),
      ...(serviceAccount === undefined ? {} : { service_account: serviceAccount }),
      ...(repoSelection === undefined ? {} : { repo: repoSelection }),
    }),
  });
  const configurationDriver =
    configurationPackage === undefined
      ? new KubernetesConfigurationDriver(
          configured.configuration as unknown as KubernetesConfigurationDriverOptions,
          { id: configured.id, implementation: configured.implementation },
        )
      : (createExternalDriver(
          configurationPackage.module,
          configured,
          "configuration",
        ) as ConfigurationDriver);
  // One gateway object serves both member Drivers, so they share clients and naming.
  const openShell =
    openShellBackend === undefined
      ? undefined
      : (options.createOpenShellBackend?.(openShellBackend) ??
        createOpenShellBackend(openShellBackend));
  const sandboxDriver =
    sandbox === undefined
      ? undefined
      : options.createSandboxDriver !== undefined
        ? validateCreatedSandboxDriver(options.createSandboxDriver(sandbox, openShell), sandbox)
        : sandboxPackage === undefined
          ? new bundledSandboxPackage!.OpenShellSandboxDriver(sandbox.configuration, {
              id: sandbox.id,
              implementation: sandbox.implementation,
              backend: openShell!,
            })
          : (createExternalDriver(sandboxPackage.module, sandbox, "sandbox") as SandboxDriver);
  const credentialGatewayDriver =
    credentialGateway === undefined
      ? undefined
      : new OpenShellCredentialGatewayDriver(
          credentialGateway.configuration as unknown as OpenShellCredentialGatewayOptions,
          {
            id: credentialGateway.id,
            implementation: credentialGateway.implementation,
            backend: openShell!,
          },
        );
  let computeDriver: ComputeDriver;
  if (computePackage !== undefined) {
    computeDriver = createExternalDriver(
      computePackage.module,
      compute,
      "compute",
    ) as ComputeDriver;
  } else if (sshCompute) {
    computeDriver = new SshComputeDriver(
      compute.configuration as unknown as SshComputeDriverOptions,
      {
        id: compute.id,
        implementation: compute.implementation,
        lifecycleDrivers: [configurationDriver],
      },
    );
  } else {
    computeDriver = new KubernetesComputeDriver(
      compute.configuration as unknown as KubernetesComputeDriverOptions,
      {
        id: compute.id,
        implementation: compute.implementation,
        lifecycleDrivers: [configurationDriver],
        ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
        ...(credentialGatewayDriver === undefined ? {} : { credentialGatewayDriver }),
        nodeEnrollment: createGatewayNodeEnrollment(() =>
          readWorkspaceFilesApiKey(
            nonempty(environment.OCC_GATEWAY_API_KEY_PATH, "OCC_GATEWAY_API_KEY_PATH"),
          ),
        ),
        readNodeCa: async () => {
          const path = environment.NODE_EXTRA_CA_CERTS;
          if (path === undefined) {
            return undefined;
          }
          const bundle = await readFile(path, "utf8");
          const certificates = bundle.match(
            /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
          );
          if (
            certificates === null ||
            certificates.reduce((rest, certificate) => rest.replace(certificate, ""), bundle).trim()
          ) {
            throw new Error("The Harness trust bundle must contain only public CA certificates.");
          }
          return certificates
            .map((certificate) => new X509Certificate(certificate).toString())
            .join("\n");
        },
      },
    );
  }
  const secretDriver = new KubernetesSecretDriver(
    secret.configuration as unknown as KubernetesSecretDriverOptions,
    { id: secret.id, implementation: secret.implementation },
  );
  const createIAMDriver = (state: NativeIAMStateStore): IAMDriver => {
    return iamPackage === undefined
      ? new NativeIAMDriver(state, { id: iam.id, implementation: iam.implementation })
      : (createExternalDriver(iamPackage.module, iam, "iam", state) as IAMDriver);
  };
  const repositoryBackend = backends.find((backend) => backend.type === "github");
  const repositoryRuntime =
    repoSelection === undefined || repositoryBackend === undefined
      ? undefined
      : await composeRepoDriver({
          backend: repositoryBackend,
          selection: repoSelection,
        });
  if (
    options.mode === "production" &&
    (typeof computeDriver.activateRevision !== "function" ||
      typeof computeDriver.deactivateRevision !== "function" ||
      typeof computeDriver.stopRevision !== "function")
  ) {
    throw new Error(
      "Production Compute Drivers must implement activateRevision, deactivateRevision, and stopRevision.",
    );
  }
  return Object.freeze({
    defaultPresets: Object.freeze(defaultPresets),
    shadowedDefaultPresets: Object.freeze(shadowedDefaultPresets),
    bundledPresetVersions,
    installation,
    computeDriver,
    configurationDriver,
    secretDriver,
    ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
    ...(credentialGatewayDriver === undefined ? {} : { credentialGatewayDriver }),
    createIAMDriver,
    ...(pluginDriver === undefined ? {} : { pluginDriver }),
    ...(repositoryRuntime ?? {}),
  });
}

export async function loadOperationalLoggingConfiguration(options: {
  readonly mode: "development" | "production";
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<LoggingConfiguration> {
  const { configuration } = await startupConfiguration(options, false);
  return operationalLoggingConfiguration(configuration?.logging);
}

async function loadBundledOpenShellSandboxDriver(): Promise<BundledOpenShellSandboxDriverModule> {
  const modulePath = "../drivers/sandbox/openshell.ts";
  let imported: unknown;
  try {
    imported = await import(modulePath);
  } catch {
    throw new Error("drivers.sandbox selects unavailable bundled OpenShell Sandbox Driver.");
  }
  const module = object(imported, "drivers.sandbox bundled OpenShell exports");
  if (
    typeof module.OpenShellSandboxDriver !== "function" ||
    typeof module.validateConfiguration !== "function" ||
    typeof module.configurationSchema !== "object" ||
    module.configurationSchema === null
  ) {
    throw new Error("drivers.sandbox bundled OpenShell module is not a valid Driver package.");
  }
  return module as unknown as BundledOpenShellSandboxDriverModule;
}

function validateCreatedSandboxDriver(
  driver: SandboxDriver,
  selection: SelectedDriverConfiguration,
): SandboxDriver {
  const created = object(driver, "drivers.sandbox factory result");
  if (
    created.capability !== "sandbox" ||
    created.id !== selection.id ||
    created.implementation !== selection.implementation ||
    !Array.isArray(created.facets) ||
    created.facets.length === 0 ||
    (created.ensureNamespace !== undefined && typeof created.ensureNamespace !== "function") ||
    (created.provisionHarness !== undefined && typeof created.provisionHarness !== "function") ||
    typeof created.cleanup !== "function"
  ) {
    throw new Error("drivers.sandbox factory returned an invalid Driver contract.");
  }
  return driver;
}
