import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { readFile, realpath } from "node:fs/promises";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadYaml } from "@kubernetes/client-node";
import type {
  ComputeDriver,
  ConfigurationDriver,
  DriverImplementation,
  IAMDriver,
  ProviderDefinition,
  ProviderSummary,
  PluginDriver,
  SandboxDriver,
  SecretDriver,
} from "@openclaw-enterprise/contracts";
import { NativeIAMDriver, type NativeIAMStateStore } from "@openclaw-enterprise/iam";
import {
  validateProviderDefinitions,
  type OpenClawController,
  type PostgresPlatformState,
} from "@openclaw-enterprise/occ";
import { Check } from "typebox/value";
import {
  KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../drivers/compute/kubernetes/index.ts";
import { currentComputeAbortSignal } from "../drivers/compute/operation-context.ts";
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

type ConfigurationRecord = Readonly<Record<string, unknown>>;

export interface StartupConfigurationSnapshot {
  readonly configuration?: ConfigurationRecord;
  readonly logging: LoggingConfiguration;
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
  readonly provider: readonly ProviderDefinition[];
  readonly drivers: {
    readonly configuration: SelectedDriverConfiguration;
    readonly iam: SelectedDriverConfiguration<ConfigurationRecord>;
    readonly compute: SelectedDriverConfiguration;
    readonly secret: SelectedDriverConfiguration;
    readonly sandbox?: SelectedDriverConfiguration;
    readonly plugin?: SelectedDriverConfiguration;
    readonly service_account?: { readonly id: string };
  };
}

export type ServiceAccountDriverFactory = (
  controller: OpenClawController,
  state: PostgresPlatformState,
) => void;

export interface InstallationRuntimeDrivers {
  readonly installation: InstallationStartupConfiguration;
  readonly computeDriver: ComputeDriver;
  readonly configurationDriver: ConfigurationDriver;
  readonly secretDriver: SecretDriver;
  readonly sandboxDriver?: SandboxDriver;
  readonly pluginDriver?: PluginDriver;
  readonly createIAMDriver: (state: NativeIAMStateStore) => IAMDriver;
}

async function startupConfiguration(
  options: {
    readonly mode: "development" | "production";
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
  required: boolean,
): Promise<ConfigurationRecord | undefined> {
  const environment = options.environment ?? process.env;
  const path = environment.OCC_CONFIG_PATH;
  if (path === undefined) {
    if (!required) return undefined;
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
      "integrations is retired; configure ChatGPT with provider[].configuration.apiKeyPath.",
    );
  }
  closed(
    configuration,
    ["occ", "drivers", "provider", "logging"],
    "Installation startup configuration",
  );
  return configuration;
}

export async function loadStartupConfigurationSnapshot(options: {
  readonly mode: "development" | "production";
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<StartupConfigurationSnapshot> {
  const configuration = await startupConfiguration(options, options.mode === "production");
  const logging = operationalLoggingConfiguration(configuration?.logging);
  return Object.freeze({
    ...(configuration === undefined ? {} : { configuration }),
    logging,
  });
}

interface ExternalDriverModule extends DriverImplementation {
  createDriver(options: {
    readonly id: string;
    readonly implementation: string;
    readonly configuration: ConfigurationRecord;
    readonly platformState?: NativeIAMStateStore;
    readonly getOperationAbortSignal?: () => AbortSignal | undefined;
  }): unknown;
}

interface LoadedDriverPackage {
  readonly module: ExternalDriverModule;
  readonly implementation: string;
}

interface BundledOpenShellSandboxDriverModule extends DriverImplementation {
  readonly OpenShellSandboxDriver: new (
    configuration: ConfigurationRecord,
    selection: { readonly id: string; readonly implementation: string },
  ) => SandboxDriver;
}

const PACKAGE_NAME = /^(?:@[a-zA-Z0-9][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/;
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
  if (typeof value !== "object" || value === null) return;
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

function providerConfiguration(
  value: unknown,
  serviceAccount: InstallationStartupConfiguration["drivers"]["service_account"],
): readonly ProviderDefinition[] {
  const providers = validateProviderDefinitions(value ?? []);
  if (serviceAccount !== undefined && providers.length === 0) {
    throw new Error("drivers.service_account requires an owning provider entry with type chatgpt.");
  }
  for (const provider of providers) {
    if (serviceAccount === undefined) {
      throw new Error(
        `provider[${provider.id}].drivers.service_account requires drivers.service_account.`,
      );
    }
    if (provider.drivers.service_account !== serviceAccount.id) {
      throw new Error(
        `provider[${provider.id}].drivers.service_account must match the selected drivers.service_account.id.`,
      );
    }
  }
  return providers;
}

export function providerSummariesFromDefinitions(
  providers: readonly ProviderDefinition[],
): readonly ProviderSummary[] {
  return Object.freeze(
    providers.map((provider) =>
      Object.freeze({
        id: provider.id,
        type: provider.type,
      }),
    ),
  );
}

function importEntrypoint(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const conditions = value as Record<string, unknown>;
  if (Object.hasOwn(conditions, ".")) return importEntrypoint(conditions["."]);
  for (const [condition, target] of Object.entries(conditions)) {
    if (condition !== "import" && condition !== "node" && condition !== "default") continue;
    const selected = importEntrypoint(target);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

async function loadDriverPackage(
  selection: ConfigurationRecord,
  capability: "configuration" | "iam" | "compute" | "sandbox",
  packageRoot: string,
  allowFixtureTarball: boolean,
): Promise<LoadedDriverPackage | undefined> {
  if (!Object.hasOwn(selection, "package")) return undefined;

  const path = `drivers.${capability}`;
  const packageName = nonempty(selection.package, `${path}.package`);
  if (!PACKAGE_NAME.test(packageName)) {
    throw new Error(`${path}.package must be one exact npm package name.`);
  }
  const ownerPath = resolve(packageRoot, "package.json");
  let owner: ConfigurationRecord;
  try {
    owner = object(JSON.parse(await readFile(ownerPath, "utf8")), "controller package.json");
  } catch {
    throw new Error(`${path}.package cannot read the controller package manifest.`);
  }
  const dependencies =
    owner.dependencies === undefined
      ? {}
      : object(owner.dependencies, "controller package.json dependencies");
  if (
    !Object.hasOwn(dependencies, packageName) ||
    typeof dependencies[packageName] !== "string" ||
    dependencies[packageName].trim().length === 0
  ) {
    throw new Error(`${path}.package must be a direct controller production dependency.`);
  }
  const dependencyVersion = dependencies[packageName];

  let installedManifestPath: string;
  try {
    const ownerUrl = pathToFileURL(ownerPath);
    const installed = findPackageJSON(packageName, ownerUrl);
    if (installed === undefined) throw new Error("package metadata unavailable");
    installedManifestPath = await realpath(installed);
  } catch {
    throw new Error(`${path}.package selects an unavailable installed Driver package.`);
  }

  let installedManifest: ConfigurationRecord;
  try {
    installedManifest = object(
      JSON.parse(await readFile(installedManifestPath, "utf8")),
      `${path}.package manifest`,
    );
  } catch {
    throw new Error(`${path}.package has invalid installed package metadata.`);
  }
  if (installedManifest.name !== packageName) {
    throw new Error(`${path}.package does not match the installed npm package name.`);
  }
  const installedVersion = nonempty(installedManifest.version, `${path}.package installed version`);
  if (
    dependencyVersion !== installedVersion &&
    !(allowFixtureTarball && /^file:.+\.tgz$/.test(dependencyVersion))
  ) {
    throw new Error(`${path}.package must be pinned to its exact installed production version.`);
  }
  const exportedEntrypoint = importEntrypoint(installedManifest.exports);
  if (exportedEntrypoint === undefined || !exportedEntrypoint.startsWith("./")) {
    throw new Error(`${path}.package must declare an exported compiled ESM entry.`);
  }
  let entryPath: string;
  try {
    entryPath = await realpath(
      createRequire(pathToFileURL(ownerPath)).resolve(
        resolve(dirname(installedManifestPath), exportedEntrypoint),
      ),
    );
  } catch {
    throw new Error(`${path}.package selects an unavailable compiled ESM entry.`);
  }
  const extension = extname(entryPath);
  if (extension !== ".mjs" && !(extension === ".js" && installedManifest.type === "module")) {
    throw new Error(`${path}.package must export precompiled JavaScript ESM.`);
  }
  const contained = relative(dirname(installedManifestPath), entryPath);
  if (contained === "" || contained.startsWith("..") || isAbsolute(contained)) {
    throw new Error(`${path}.package entry escapes its installed package root.`);
  }

  let imported: unknown;
  try {
    imported = await import(pathToFileURL(entryPath).href);
  } catch {
    throw new Error(`${path}.package failed to load its compiled Driver module.`);
  }
  const module = object(imported, `${path}.package exports`);
  if (
    typeof module.validateConfiguration !== "function" ||
    typeof module.createDriver !== "function"
  ) {
    throw new Error(`${path}.package must export Driver validation and a factory.`);
  }
  object(module.configurationSchema, `${path}.configurationSchema`);
  return Object.freeze({
    module: module as unknown as ExternalDriverModule,
    implementation: `${packageName}@${installedVersion}`,
  });
}

function selected(
  value: unknown,
  capability: "configuration" | "iam" | "compute" | "secret" | "sandbox" | "plugin",
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
    throw new Error(`${path}.configuration does not match its Driver configuration schema.`);
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

export async function loadInstallationConfiguration(options: {
  readonly mode: "development" | "production";
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly packageRoot?: string;
  readonly startupConfiguration?: StartupConfigurationSnapshot;
  readonly createSandboxDriver?: (selection: SelectedDriverConfiguration) => SandboxDriver;
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
  const { configuration, logging } = startup;
  if (configuration === undefined && options.mode === "production") {
    throw new Error("OCC_CONFIG_PATH must identify the Installation startup YAML.");
  }
  if (configuration === undefined) return undefined;
  if (
    options.mode === "development" &&
    configuration.occ === undefined &&
    configuration.drivers === undefined &&
    configuration.provider === undefined
  ) {
    return undefined;
  }
  const occ = object(configuration.occ, "occ");
  closed(occ, ["cluster"], "occ");
  const cluster = nonempty(occ.cluster, "occ.cluster");
  const drivers = object(configuration.drivers, "drivers");
  closed(
    drivers,
    ["configuration", "iam", "compute", "secret", "sandbox", "plugin", "service_account"],
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
  const providers = providerConfiguration(configuration.provider, serviceAccount);

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
    logging,
    provider: providers,
    drivers: Object.freeze({
      configuration: configured,
      iam,
      compute,
      secret,
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(plugin === undefined ? {} : { plugin }),
      ...(serviceAccount === undefined ? {} : { service_account: serviceAccount }),
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
  const sandboxDriver =
    sandbox === undefined
      ? undefined
      : options.createSandboxDriver !== undefined
        ? validateCreatedSandboxDriver(options.createSandboxDriver(sandbox), sandbox)
        : sandboxPackage === undefined
          ? new bundledSandboxPackage!.OpenShellSandboxDriver(sandbox.configuration, {
              id: sandbox.id,
              implementation: sandbox.implementation,
            })
          : (createExternalDriver(sandboxPackage.module, sandbox, "sandbox") as SandboxDriver);
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
  if (
    options.mode === "production" &&
    (typeof computeDriver.activateRevision !== "function" ||
      typeof computeDriver.deactivateRevision !== "function")
  ) {
    throw new Error(
      "Production Compute Drivers must implement activateRevision and deactivateRevision.",
    );
  }
  return Object.freeze({
    installation,
    computeDriver,
    configurationDriver,
    secretDriver,
    ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
    createIAMDriver,
    ...(pluginDriver === undefined ? {} : { pluginDriver }),
  });
}

export async function loadOperationalLoggingConfiguration(options: {
  readonly mode: "development" | "production";
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<LoggingConfiguration> {
  const configuration = await startupConfiguration(options, false);
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

function createExternalDriver(
  implementation: ExternalDriverModule,
  selection: SelectedDriverConfiguration,
  capability: "configuration" | "iam" | "compute" | "sandbox",
  platformState?: NativeIAMStateStore,
): ConfigurationDriver | IAMDriver | ComputeDriver | SandboxDriver {
  if (capability === "iam" && typeof platformState?.loadNativeIAMState !== "function") {
    throw new Error("drivers.iam factory requires platform state.");
  }
  const created = object(
    implementation.createDriver({
      id: selection.id,
      implementation: selection.implementation,
      configuration: selection.configuration,
      ...(platformState === undefined ? {} : { platformState }),
      ...(capability === "compute" ? { getOperationAbortSignal: currentComputeAbortSignal } : {}),
    }),
    `drivers.${capability} factory result`,
  );
  if (
    created.capability !== capability ||
    created.id !== selection.id ||
    created.implementation !== selection.implementation
  ) {
    throw new Error(`drivers.${capability} factory returned an unselected Driver identity.`);
  }
  const methods =
    capability === "configuration"
      ? ["create", "read", "update", "delete", "validate"]
      : capability === "iam"
        ? ["lookupIdentity", "authorize"]
        : capability === "compute"
          ? ["ensureNamespace", "deleteNamespace", "prepareRevision", "retireRevision"]
          : ["cleanup"];
  if (methods.some((method) => typeof created[method] !== "function")) {
    throw new Error(`drivers.${capability} factory returned an invalid Driver contract.`);
  }
  if (
    capability === "sandbox" &&
    ((created.ensureNamespace !== undefined && typeof created.ensureNamespace !== "function") ||
      (created.provisionHarness !== undefined && typeof created.provisionHarness !== "function"))
  ) {
    throw new Error("drivers.sandbox factory returned invalid optional lifecycle hooks.");
  }
  if (
    capability === "compute" &&
    created.setLifecycleDrivers !== undefined &&
    typeof created.setLifecycleDrivers !== "function"
  ) {
    throw new Error("drivers.compute factory returned invalid lifecycle Driver wiring.");
  }
  return created as unknown as ConfigurationDriver | IAMDriver | ComputeDriver | SandboxDriver;
}
