import {
  openShellProxyConfiguration,
  validateOpenShellRepositoryTransport,
} from "../drivers/egress-proxy/openshell-configuration.ts";
import {
  githubRepositoryConfiguration,
  selectGitHubRepositoryDelivery,
} from "../drivers/repo/github/installation.ts";
import {
  createOpenShellCapabilities,
  type OpenShellRepositoryTransport,
} from "../drivers/egress-proxy/openshell-registration.ts";
import type { OpenShellSandboxDriverSelection } from "../drivers/sandbox/openshell.ts";
import type { OpenShellSandboxDriverOptions } from "../drivers/sandbox/openshell.ts";
import type { CredentialProxyDriver } from "@openclaw-enterprise/contracts";
import {
  OpenShellCredentialProxyDriver,
  type OpenShellProxyOptions,
} from "../drivers/egress-proxy/openshell.ts";
import type { EgressAuthorityConfiguration } from "./egress-authority.ts";
import {
  chartListeners,
  InstallationFieldError,
  type InstallationFieldDetail,
  requireChartListener,
} from "./installation-fields.ts";
import { requireConfiguration } from "@openclaw-enterprise/contracts";
import { validateSandboxNetworkGrants } from "@openclaw-enterprise/contracts";
import type { SandboxNetworkGrant } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Backend,
  ComputeDriver,
  ConfigurationDriver,
  CredentialGatewayDriver,
  CredentialRefreshDriver,
  DriverImplementation,
  IAMDriver,
  Identity,
  BackendDefinition,
  OpenShellBackendDefinition,
  Preset,
  BackendSummary,
  RepositoryPolicyDriver,
  NativeRepositorySender,
  PluginDriver,
  SandboxDriver,
  SecretDriver,
} from "@openclaw-enterprise/contracts";
import { NativeIAMDriver, type NativeIAMStateStore } from "@openclaw-enterprise/iam";
import {
  InstalledDriver,
  AuthorizationDeniedError,
  DependencyUnavailableError,
  validateBackendDefinitions,
  type BundledPresetVersion,
  type ControllerOptions,
  type CredentialProxyCapacity,
  type NativeWorkerSupport,
  resolveCredentialProxyCapacity,
  type OpenClawController,
  DriverConfigurationRegistry,
  type PostgresPlatformState,
  type SkippedDefaultPreset,
} from "@openclaw-enterprise/occ";

import {
  KubernetesComputeDriver,
  PreprovisionedKubernetesNamespace,
  type KubernetesComputeDriverOptions,
} from "../drivers/compute/kubernetes/index.ts";
import { refuseRewrittenIpv4Host, refuseWrittenUserinfo } from "../auth/configuration.ts";
import {
  createExternalDriver,
  createExternalProtectedDriver,
  loadDriverPackage,
} from "./driver-packages.ts";
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
import {
  closed,
  type ConfigurationRecord,
  nonempty,
  object,
  startupConfiguration,
} from "./startup-file.ts";
import { OCCPluginDriver, CodexPluginDriver } from "../drivers/plugin/index.ts";
import { createGatewayNodeEnrollment } from "../gateway/node-enrollment-client.ts";
import { readWorkspaceFilesApiKey } from "./workspace-files.ts";
import { TokenService } from "../backends/token-service/service.ts";
import { githubMetadataProvider } from "../drivers/egress-proxy/github-metadata.ts";
import { PostgresPreparedGitHubLifecycle } from "../drivers/repo/github/credentials/prepared-lifecycle.ts";
import { GitHubRepositoryPolicy } from "../drivers/repo/github/policy.ts";
import { composeRepositoryAccess } from "./repository-credentials/platform.ts";
import type { PreparedRepositoryGitConfiguration } from "../backends/repository-credentials/prepared-git-owner.ts";
import { createOpenShellBackend, type OpenShellGateway } from "../backends/openshell.ts";
import {
  OpenShellCredentialGatewayDriver,
  type OpenShellCredentialGatewayOptions,
} from "../drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialRefreshDriver } from "../drivers/credential-refresh/openshell.ts";

import { loadInstallationPresets, type ShadowedDefaultPreset } from "./installation-presets.ts";

export { loadOperationalLoggingConfiguration } from "./startup-file.ts";

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
  readonly definition: DriverImplementation;
}

export interface InstallationStartupConfiguration {
  readonly repository?: SelectedDriverConfiguration;
  readonly sandboxNetworkPolicyCeiling?: readonly SandboxNetworkGrant[];
  readonly occ: { readonly cluster: string };
  readonly logging: LoggingConfiguration;
  readonly presets?: { readonly includeDefaults: boolean; readonly files?: readonly string[] };
  readonly observability?: { readonly url: string };
  /** Declares a runtime image built with native worker support; see configuration reference. */
  readonly runtime?: { readonly nativeWorkerSupport: NativeWorkerSupport };
  /** `drivers.credential_proxy.requestCapacity`, resolved; absent without a Credential Proxy. */
  readonly credentialProxyCapacity?: CredentialProxyCapacity;
  readonly backend: readonly BackendDefinition[];
  readonly drivers: {
    readonly configuration: SelectedDriverConfiguration;
    readonly iam: SelectedDriverConfiguration<ConfigurationRecord>;
    readonly compute: SelectedDriverConfiguration;
    readonly secret: SelectedDriverConfiguration;
    readonly sandbox?: SelectedDriverConfiguration;
    readonly credential_gateway?: SelectedDriverConfiguration;
    readonly credential_refresh?: SelectedDriverConfiguration;
    readonly credential_proxy?: SelectedDriverConfiguration;
    readonly plugin?: SelectedDriverConfiguration;
    readonly service_account?: { readonly id: string };
  };
}

/** Definitions stay with their selected identities across API and worker composition. */
export function installationDriverConfigurations(
  installation: InstallationStartupConfiguration | undefined,
): readonly import("@openclaw-enterprise/occ").DriverConfigurationRegistration[] {
  const selections = {
    ...installation?.drivers,
    ...(installation?.repository === undefined ? {} : { repo: installation.repository }),
  };
  return Object.entries(selections).flatMap(([capability, selection]) =>
    "definition" in selection
      ? [
          {
            capability: capability as import("@openclaw-enterprise/contracts").DriverCapability,
            driverId: selection.id,
            implementation: selection.implementation,
            definition: selection.definition,
          },
        ]
      : [],
  );
}

/**
 * The controller options that come from the Installation alone. API compositions spread them
 * unchanged, so a startup setting cannot be loaded and then dropped before the controller.
 */
export function installationControllerOptions(
  installation: InstallationStartupConfiguration | undefined,
): Pick<
  ControllerOptions,
  | "driverConfigurations"
  | "sandboxNetworkPolicyCeiling"
  | "nativeWorkerSupport"
  | "credentialProxyCapacity"
> {
  return {
    driverConfigurations: installationDriverConfigurations(installation),
    sandboxNetworkPolicyCeiling: installation?.sandboxNetworkPolicyCeiling ?? [],
    ...(installation?.runtime === undefined
      ? {}
      : { nativeWorkerSupport: installation.runtime.nativeWorkerSupport }),
    ...(installation?.credentialProxyCapacity === undefined
      ? {}
      : { credentialProxyCapacity: installation.credentialProxyCapacity }),
  };
}

export type ServiceAccountDriverFactory = (
  controller: OpenClawController,
  state: PostgresPlatformState,
) => void;

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
  readonly credentialRefreshDriver?: CredentialRefreshDriver;
  readonly protectedDriver?: InstalledDriver;
  readonly proxyDriver?: CredentialProxyDriver;
  /** Present only when this registration owns protected repository delivery. */
  readonly repositoryGitDriver?: InstalledDriver;
  readonly tokenService?: TokenService;
  readonly preparedGitHub?: PostgresPreparedGitHubLifecycle;
  readonly pluginDriver?: PluginDriver;
  readonly repositoryPolicy?: RepositoryPolicyDriver;
  readonly nativeRepositorySender?: NativeRepositorySender;
  readonly preparedRepositoryGit?: PreparedRepositoryGitConfiguration;
  readonly repositoryTransport?: OpenShellRepositoryTransport;
  readonly repositoryRegistry?: Awaited<
    ReturnType<typeof composeRepositoryAccess>
  >["repositoryRegistry"];
  readonly repositoryOwner?: Readonly<{
    controlSocket?: string;
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
    selection: OpenShellSandboxDriverSelection,
  ) => SandboxDriver;
}

/**
 * Validate `drivers.credential_proxy.requestCapacity`, the request registry's in-memory bounds
 * per API process, and fill omitted bounds. Each fault names its field, never its value.
 */
function credentialProxyCapacityConfiguration(input: unknown): CredentialProxyCapacity {
  const path = "drivers.credential_proxy.requestCapacity";
  const pointer = (field?: string) =>
    `/${path.replaceAll(".", "/")}${field === undefined ? "" : `/${field}`}`;
  const value = asRecord(input);
  if (!value) {
    throw new InstallationFieldError([
      { path: pointer(), code: "INVALID_TYPE", message: `${path} must be one object.` },
    ]);
  }
  const resolved = resolveCredentialProxyCapacity(value, path);
  if (resolved.faults) {
    throw new InstallationFieldError(
      resolved.faults.map((fault) => ({
        path: pointer(fault.field),
        code: fault.code,
        message: fault.message,
      })) as [InstallationFieldDetail, ...InstallationFieldDetail[]],
    );
  }
  return resolved.capacity;
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
  // URL parsing drops an empty user info (http://@host), which profile preflight refuses.
  refuseWrittenUserinfo("observability.url", raw);
  // Other IPv4 spellings parse as a different address, so startup must not store url.href.
  refuseRewrittenIpv4Host("observability.url", raw, url);
  // A tab or newline is deleted. A backslash before the query becomes a slash, so the stored
  // href can name another host. A backslash in the query does not change the host.
  const queryAt = raw.search(/[?#]/u);
  const beforeQuery = queryAt === -1 ? raw : raw.slice(0, queryAt);
  if (/[\t\n\r]/u.test(raw) || beforeQuery.includes("\\")) {
    throw new Error(
      "observability.url must not contain a tab or newline, or a backslash before the query; the URL parser drops or rewrites them into a different host.",
    );
  }
  return Object.freeze({ url: url.href });
}

function backendConfiguration(
  value: unknown,
  serviceAccount: InstallationStartupConfiguration["drivers"]["service_account"],
  repoSelection: InstallationStartupConfiguration["repository"],
  credentialGatewayId: string | undefined,
  credentialRefreshId: string | undefined,
  credentialProxyId: string | undefined,
): readonly BackendDefinition[] {
  const backends = validateBackendDefinitions(value ?? []);
  if (serviceAccount !== undefined && !backends.some((backend) => backend.type === "chatgpt")) {
    throw new Error("drivers.service_account requires an owning backend entry with type chatgpt.");
  }
  if (repoSelection !== undefined && !backends.some((backend) => backend.type === "github")) {
    throw new Error("repository requires an owning backend entry with type github.");
  }
  if (credentialRefreshId !== undefined && credentialGatewayId === undefined) {
    throw new Error("drivers.credential_refresh requires drivers.credential_gateway.");
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
      // Refresh state lives on the gateway's provider record, so both roles share this Backend.
      if (backend.drivers.credential_refresh !== credentialRefreshId) {
        throw new Error(
          `backend[${backend.id}].drivers.credential_refresh must match the selected drivers.credential_refresh.id.`,
        );
      }
      if (backend.drivers.credential_proxy !== credentialProxyId) {
        throw new Error(
          `backend[${backend.id}].drivers.credential_proxy must match the selected drivers.credential_proxy.id; configure both or omit both.`,
        );
      }
      continue;
    }
    if (backend.type === "github") {
      if (repoSelection === undefined) {
        throw new Error(`backend[${backend.id}].drivers.repo requires repository.`);
      }
      if (backend.drivers.repo !== repoSelection.id) {
        throw new Error(
          `backend[${backend.id}].drivers.repo must match the selected repository.id.`,
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
  return Object.freeze({
    id,
    implementation,
    ...(Object.hasOwn(selection, "package")
      ? { package: nonempty(selection.package, `${path}.package`) }
      : {}),
    configuration: validated,
    definition: driver,
  });
}

/**
 * The CA bundle a dedicated Harness node trusts for its Gateway connection.
 * `OCC_GATEWAY_CA_PATH`, when set, names the Gateway-only bundle; an empty value means
 * no private Gateway CA. The chart sets it whenever the API's `NODE_EXTRA_CA_CERTS`
 * also carries other roots (the OIDC CA opt-in), so those roots stay out of Harness Pods.
 * Without it, the API's `NODE_EXTRA_CA_CERTS` is the Gateway bundle.
 */
export async function readHarnessNodeCa(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const gatewayCaPath = environment.OCC_GATEWAY_CA_PATH;
  const path = gatewayCaPath ?? environment.NODE_EXTRA_CA_CERTS;
  if (path === undefined || path === "") {
    return undefined;
  }
  if (gatewayCaPath !== undefined && !isAbsolute(gatewayCaPath)) {
    throw new Error("OCC_GATEWAY_CA_PATH must identify an absolute mounted-file path.");
  }
  return readPublicCaBundle(path);
}

export async function readPublicCaBundle(path: string): Promise<string> {
  const bundle = await readFile(path, "utf8");
  const certificates = bundle.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (
    certificates === null ||
    certificates.reduce((rest, certificate) => rest.replace(certificate, ""), bundle).trim()
  ) {
    throw new Error("The trust bundle must contain only public CA certificates.");
  }
  return certificates.map((certificate) => new X509Certificate(certificate).toString()).join("\n");
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
  const { includeDefaults, bundledPresetVersions, defaultPresets, shadowedDefaultPresets } =
    await loadInstallationPresets(configuration, configurationPath);
  const occ = object(configuration.occ, "occ");
  closed(occ, ["cluster"], "occ");
  const cluster = nonempty(occ.cluster, "occ.cluster");
  const sandboxNetworkPolicyCeiling = configuration.sandboxNetworkPolicyCeiling;
  if (sandboxNetworkPolicyCeiling !== undefined) {
    validateSandboxNetworkGrants(sandboxNetworkPolicyCeiling, "/sandboxNetworkPolicyCeiling");
  }
  const observability = observabilityConfiguration(configuration.observability);
  const runtime = runtimeConfiguration(configuration.runtime);
  const drivers = object(configuration.drivers, "drivers");
  if (Object.hasOwn(drivers, "conduit")) {
    throw new Error("drivers.conduit is retired; use drivers.credential_proxy instead.");
  }
  closed(
    drivers,
    [
      "configuration",
      "iam",
      "compute",
      "secret",
      "sandbox",
      "credential_gateway",
      "credential_refresh",
      "credential_proxy",
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
  if (drivers.repo !== undefined) {
    // Finding 2361: startup refuses repository.nativeSender beside a Sandbox or Credential Proxy,
    // and repository.openShell beside an installed Sandbox package, so name what fits the
    // selected Sandbox.
    const sandbox = drivers.sandbox === undefined ? undefined : asRecord(drivers.sandbox);
    const native =
      "or repository.nativeSender without drivers.sandbox or drivers.credential_proxy.";
    throw new Error(
      `drivers.repo native admission is retired. Drain accepted work ON THE ORIGINAL owner before cutover, then ${
        sandbox === undefined
          ? "configure repository.nativeSender with repository.preparedGitHub."
          : sandbox.package === undefined
            ? `configure repository.openShell with repository.preparedGitHub (the bundled OpenShell Driver refuses git-write), ${native}`
            : `configure repository.preparedGitHub with the package's drivers.credential_proxy and no repository.openShell, ${native}`
      } Do not replay uncertain work.`,
    );
  }
  const repositoryConfiguration = githubRepositoryConfiguration(
    configuration.repository,
    options.mode,
  );
  const repoSelection =
    repositoryConfiguration &&
    selected(
      repositoryConfiguration.selection,
      "repo",
      "github",
      GitHubRepositoryPolicy,
      "repository",
    );
  const nativeRepositorySelection = repositoryConfiguration?.nativeSender;
  const preparedRepositoryGit = repositoryConfiguration?.prepared;
  let repositoryTransportConfiguration = repositoryConfiguration?.transport;
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
  let credentialRefresh: SelectedDriverConfiguration | undefined;
  if (drivers.credential_refresh !== undefined) {
    const selection = object(drivers.credential_refresh, "drivers.credential_refresh");
    closed(selection, ["id", "configuration"], "drivers.credential_refresh");
    credentialRefresh = selected(
      selection,
      "credential_refresh",
      "openshell",
      OpenShellCredentialRefreshDriver,
    );
  }
  const sandboxSelection =
    drivers.sandbox === undefined ? undefined : object(drivers.sandbox, "drivers.sandbox");
  let proxySelection: SelectedDriverConfiguration | undefined;
  let packageProxyId: string | undefined;
  let egressAuthority: EgressAuthorityConfiguration | undefined;
  let credentialProxyCapacity: CredentialProxyCapacity | undefined;
  let preparedGitHubKeyPath: string | undefined;
  let preparedGitHubOrigin: string | undefined;
  let preparedGitHubCa: Buffer | undefined;
  if (drivers.credential_proxy !== undefined) {
    const selection = object(drivers.credential_proxy, "drivers.credential_proxy");
    closed(selection, ["id", "configuration", "requestCapacity"], "drivers.credential_proxy");
    // OCC's request registry, not the Driver, owns these bounds: they apply to any Driver.
    credentialProxyCapacity = credentialProxyCapacityConfiguration(
      selection.requestCapacity === undefined ? {} : selection.requestCapacity,
    );
    const egress = object(selection.configuration, "drivers.credential_proxy.configuration");
    if (sandboxSelection?.package !== undefined) {
      const id = nonempty(selection.id, "drivers.credential_proxy.id");
      if (id !== sandboxSelection.id) {
        throw new Error("Credential Proxy must select the same installed Driver as Sandbox.");
      }
      // Both selections name one instance. Only the sandbox entry configures the package.
      closed(egress, [], "drivers.credential_proxy.configuration");
      packageProxyId = id;
    } else {
      const configuredProxy = openShellProxyConfiguration(
        egress,
        options.mode,
        repositoryTransportConfiguration,
      );
      if (
        configuredProxy.repository &&
        (!sandboxSelection || selection.id !== sandboxSelection.id)
      ) {
        throw new Error("Repository Credential Proxy must select the installed Sandbox Driver.");
      }
      repositoryTransportConfiguration = configuredProxy.repository;
      egressAuthority = configuredProxy.authority;
      preparedGitHubKeyPath = configuredProxy.prepared?.custodyKeyPath;
      preparedGitHubOrigin = configuredProxy.prepared?.apiOrigin;
      if (configuredProxy.prepared?.issuerCaPath) {
        preparedGitHubCa = Buffer.from(
          await readPublicCaBundle(configuredProxy.prepared.issuerCaPath),
        );
      }
      proxySelection = selected(
        { ...selection, configuration: configuredProxy.policy },
        "credential_proxy",
        "openshell",
        OpenShellCredentialProxyDriver,
      );
    }
  }

  requireChartListener(egressAuthority, environment, chartListeners.egressAuthority);
  requireChartListener(
    repositoryTransportConfiguration?.authority,
    environment,
    chartListeners.openshellGit,
  );

  const backends = backendConfiguration(
    configuration.backend,
    serviceAccount,
    repoSelection,
    credentialGateway?.id,
    credentialRefresh?.id,
    proxySelection?.id ?? packageProxyId,
  );
  const openShellBackend = backends.find(
    (backend): backend is OpenShellBackendDefinition => backend.type === "openshell",
  );

  const configurationSelection = object(drivers.configuration, "drivers.configuration");
  const iamSelection = object(drivers.iam, "drivers.iam");
  const computeSelection = object(drivers.compute, "drivers.compute");
  const secretSelection = object(drivers.secret, "drivers.secret");
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
  const repositoryDeliveryMode = selectGitHubRepositoryDelivery(repositoryConfiguration, {
    externalProxy: packageProxyId !== undefined,
    bundledProxy: proxySelection !== undefined,
    sandbox: sandboxSelection !== undefined,
    bundledSandbox: sandboxSelection !== undefined && sandboxSelection.package === undefined,
    openShellBackend: openShellBackend !== undefined,
    kubernetes: kubernetesCompute,
  });
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
  const namespaceBinding = environment.OCC_PREPROVISIONED_NAMESPACE;
  let preprovisionedNamespace: PreprovisionedKubernetesNamespace | undefined;
  if (namespaceBinding !== undefined) {
    const k = compute.configuration as unknown as KubernetesComputeDriverOptions;
    if (
      !kubernetesCompute ||
      configurationPackage !== undefined ||
      !k.gatewayRouting ||
      k.executionCluster !== undefined ||
      !openShellBackend ||
      !sandboxSelection ||
      sandboxPackage !== undefined ||
      (proxySelection === undefined && repositoryTransportConfiguration === undefined)
    ) {
      throw new Error(
        "A preprovisioned Namespace requires single-cluster bundled Kubernetes and OpenShell Drivers with Credential Proxy and gateway routing.",
      );
    }
    const workspace = (sandboxSelection.configuration as unknown as OpenShellSandboxDriverOptions)
      .gateway;
    preprovisionedNamespace = new PreprovisionedKubernetesNamespace(
      namespaceBinding,
      k.gatewayRouting,
      [
        ...(workspace.operatorWorkspaceResources ?? []),
        ...(workspace.networkPolicyResources ?? []),
      ].filter((resource) => resource.kind === "NetworkPolicy"),
    );
  }
  if (repositoryDeliveryMode === "native") {
    const peer = (compute.configuration as unknown as KubernetesComputeDriverOptions).network
      .repositoryCredentials;
    if (peer?.port !== 8443) {
      // A field error, so API and worker startup logs name the field (finding 2227).
      const path = "/drivers/compute/configuration/network/repositoryCredentials";
      throw new InstallationFieldError([
        peer === undefined
          ? {
              path,
              code: "REQUIRED",
              message:
                "repository.nativeSender requires drivers.compute.configuration.network.repositoryCredentials, the Kubernetes repository service peer.",
            }
          : {
              path: `${path}/port`,
              code: "INVALID_VALUE",
              message:
                "repository.nativeSender requires drivers.compute.configuration.network.repositoryCredentials.port to be 8443.",
            },
      ]);
    }
  } else if (
    kubernetesCompute &&
    (compute.configuration as unknown as KubernetesComputeDriverOptions).network
      .repositoryCredentials !== undefined
  ) {
    // The peer makes Compute project and clean up repository material Secrets. Only native
    // delivery creates them, and only its chart grants the worker Secret list, so a peer
    // left behind after a switch to protected Git fails every stop, retire and delete with a
    // 403 (finding 2212). A field error, so startup logs name the field (finding 2226).
    throw new InstallationFieldError([
      {
        path: "/drivers/compute/configuration/network/repositoryCredentials",
        code: "INVALID_VALUE",
        message:
          "drivers.compute.configuration.network.repositoryCredentials requires repository.nativeSender; remove it for protected Git or when no repository is configured.",
      },
    ]);
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
  if (sandbox?.package !== undefined && packageProxyId !== undefined) {
    // The package owns one startup configuration. Its Sandbox-only agent
    // contributions must not be registered a second time as Credential Proxy.
    proxySelection = {
      ...sandbox,
      id: packageProxyId,
      definition: {
        configurationSchema: sandbox.definition.configurationSchema,
        validateConfiguration: (input) => sandbox.definition.validateConfiguration(input),
      },
    };
  }
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
    // Kubernetes Compute runs the Harness itself, so production Agents need their projected
    // ServicePrincipal credentials. A Sandbox Driver may instead use its own infrastructure
    // identity (plan 0044), so only Sandbox-backed installs may disable it (finding 1753).
    if (
      sandbox === undefined &&
      kubernetes.servicePrincipalCredentials.mode !== "projectedServiceAccountToken"
    ) {
      throw new InstallationFieldError([
        {
          path: "/drivers/compute/configuration/servicePrincipalCredentials/mode",
          code: "INVALID_VALUE",
          message:
            "drivers.compute.configuration.servicePrincipalCredentials.mode must be projectedServiceAccountToken in production unless a Sandbox Driver is selected.",
        },
      ]);
    }
  }
  const installation = Object.freeze({
    occ: Object.freeze({ cluster }),
    ...(sandboxNetworkPolicyCeiling === undefined ? {} : { sandboxNetworkPolicyCeiling }),
    presets: Object.freeze({ includeDefaults }),
    logging,
    ...(observability === undefined ? {} : { observability }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(credentialProxyCapacity === undefined ? {} : { credentialProxyCapacity }),
    backend: backends,
    ...(repoSelection === undefined ? {} : { repository: repoSelection }),
    drivers: Object.freeze({
      configuration: configured,
      iam,
      compute,
      secret,
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(credentialGateway === undefined ? {} : { credential_gateway: credentialGateway }),
      ...(credentialRefresh === undefined ? {} : { credential_refresh: credentialRefresh }),
      ...(proxySelection === undefined ? {} : { credential_proxy: proxySelection }),
      ...(plugin === undefined ? {} : { plugin }),
      ...(serviceAccount === undefined ? {} : { service_account: serviceAccount }),
    }),
  });
  const configurationDriver =
    configurationPackage === undefined
      ? new KubernetesConfigurationDriver(
          configured.configuration as unknown as KubernetesConfigurationDriverOptions,
          { id: configured.id, implementation: configured.implementation, preprovisionedNamespace },
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
  const repositoryBackend = backends.find((backend) => backend.type === "github");
  const repositoryRuntime =
    repoSelection === undefined || repositoryBackend === undefined
      ? undefined
      : await composeRepositoryAccess({
          backend: repositoryBackend,
          selection: nativeRepositorySelection
            ? {
                ...repoSelection,
                configuration: { ...repoSelection.configuration, ...nativeRepositorySelection },
              }
            : repoSelection,
          protectedGit: repositoryDeliveryMode === "protected",
          configuration: repositoryConfiguration,
        });
  validateOpenShellRepositoryTransport(repositoryTransportConfiguration, {
    prepared: preparedRepositoryGit !== undefined,
    repository: repositoryRuntime !== undefined,
    backend: openShellBackend,
    backendIndex: openShellBackend === undefined ? -1 : backends.indexOf(openShellBackend),
    sandbox: sandbox !== undefined,
    external: sandboxPackage !== undefined,
    kubernetes: kubernetesCompute,
  });
  const repositoryDelivery = {
    configuration: repositoryTransportConfiguration,
    resolveDelivery: repositoryRuntime?.resolveRepositoryDelivery,
  };
  let repositoryTransport: OpenShellRepositoryTransport | undefined;
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
  if (
    proxySelection !== undefined &&
    sandboxPackage === undefined &&
    (!openShell ||
      !sandbox ||
      options.createSandboxDriver !== undefined ||
      !kubernetesCompute ||
      openShellBackend?.configuration.endpoint === undefined ||
      !openShellBackend.configuration.endpoint.startsWith("https://") ||
      (openShellBackend.configuration.auth?.mode !== "bearerTokenFile" &&
        openShellBackend.configuration.auth?.mode !== "mtls"))
  ) {
    throw new Error(
      "Protected egress requires paired Kubernetes/OpenShell Drivers and an authenticated TLS gateway endpoint.",
    );
  }
  const secretDriver = new KubernetesSecretDriver(
    secret.configuration as unknown as KubernetesSecretDriverOptions,
    { id: secret.id, implementation: secret.implementation, preprovisionedNamespace },
  );
  const tokenService = new TokenService();
  const preparedGitHub =
    preparedGitHubKeyPath === undefined
      ? undefined
      : new PostgresPreparedGitHubLifecycle(
          preparedGitHubKeyPath,
          secretDriver,
          preparedGitHubOrigin,
          preparedGitHubCa,
          tokenService,
        );
  let protectedDriver: InstalledDriver | undefined;
  let sandboxDriver: SandboxDriver | undefined;
  if (sandbox !== undefined && proxySelection !== undefined) {
    if (sandboxPackage !== undefined) {
      protectedDriver = createExternalProtectedDriver(
        sandboxPackage.module,
        sandbox,
        repositoryDeliveryMode === "protected" ? repositoryRuntime?.authorityIdentity : undefined,
      );
    } else {
      // One configured OpenShell owner, with the original capability IDs retained for v2 revisions.
      const capabilities = createOpenShellCapabilities({
        sandbox,
        backend: openShell!,
        operatorOwnedKubernetesResources: preprovisionedNamespace !== undefined,
        createSandbox: (configuration, selection) =>
          new bundledSandboxPackage!.OpenShellSandboxDriver(configuration, selection),
        repository: repositoryDelivery,
        proxy: {
          id: proxySelection.id,
          configuration: proxySelection.configuration as unknown as OpenShellProxyOptions,
          preparedProviders: preparedGitHub ? [githubMetadataProvider] : [],
          ...(egressAuthority && { exchangeAuthority: egressAuthority }),
        },
      });
      repositoryTransport = capabilities.repositoryTransport;
      protectedDriver = new InstalledDriver(
        {
          ...sandbox,
          configuration: {
            sandbox: sandbox.configuration,
            backend: openShellBackend,
            proxy: drivers.credential_proxy,
            ...(repositoryTransport && {
              repositoryAuthorityIdentity: repositoryRuntime!.authorityIdentity,
              modelGateway: drivers.credential_gateway,
            }),
            namespaceBinding,
          },
        },
        {
          capabilities: { sandbox: capabilities.sandbox, credential_proxy: capabilities.proxy! },
          close: capabilities.close,
        },
        { sandbox: sandbox.id, credential_proxy: proxySelection.id },
      );
    }
    sandboxDriver = protectedDriver.require("sandbox");
  } else {
    sandboxDriver =
      sandbox === undefined
        ? undefined
        : options.createSandboxDriver !== undefined
          ? validateCreatedSandboxDriver(options.createSandboxDriver(sandbox, openShell), sandbox)
          : sandboxPackage === undefined
            ? createOpenShellCapabilities({
                sandbox,
                backend: openShell!,
                operatorOwnedKubernetesResources: preprovisionedNamespace !== undefined,
                createSandbox: (configuration, selection) =>
                  new bundledSandboxPackage!.OpenShellSandboxDriver(configuration, selection),
              }).sandbox
            : (createExternalDriver(sandboxPackage.module, sandbox, "sandbox") as SandboxDriver);
  }
  const credentialRefreshDriver =
    credentialRefresh === undefined
      ? undefined
      : new OpenShellCredentialRefreshDriver(credentialRefresh.configuration, {
          id: credentialRefresh.id,
          implementation: credentialRefresh.implementation,
          backend: openShell!,
        });
  const repositoryGitDriver = repositoryDeliveryMode === "protected" ? protectedDriver : undefined;
  // This check admits an implementation to try installation. Compute still verifies its
  // actual recipient and enforcement before release or the first eligible material read.
  repositoryGitDriver?.requireRepositoryGitTransport();
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
        ...(protectedDriver === undefined ? {} : { protectedDriver }),
        preparedTokens: tokenService,
        ...(preparedRepositoryGit === undefined || repositoryTransport || repositoryGitDriver
          ? {}
          : { preparedRepositoryIngress: true }),
        preprovisionedNamespace,
        nodeEnrollment: createGatewayNodeEnrollment(() =>
          readWorkspaceFilesApiKey(
            nonempty(environment.OCC_GATEWAY_API_KEY_PATH, "OCC_GATEWAY_API_KEY_PATH"),
          ),
        ),
        readNodeCa: () => readHarnessNodeCa(environment),
      },
    );
  }
  const createIAMDriver = (state: NativeIAMStateStore): IAMDriver => {
    return iamPackage === undefined
      ? new NativeIAMDriver(state, { id: iam.id, implementation: iam.implementation })
      : (createExternalDriver(iamPackage.module, iam, "iam", state) as IAMDriver);
  };
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
    ...(credentialRefreshDriver === undefined ? {} : { credentialRefreshDriver }),
    ...(protectedDriver === undefined
      ? {}
      : { protectedDriver, proxyDriver: protectedDriver.require("credential_proxy") }),
    ...(repositoryGitDriver && { repositoryGitDriver }),
    tokenService,
    ...(preparedGitHub === undefined ? {} : { preparedGitHub }),
    createIAMDriver,
    ...(pluginDriver === undefined ? {} : { pluginDriver }),
    ...(repositoryRuntime ?? {}),
    ...(preparedRepositoryGit ? { preparedRepositoryGit } : {}),
    ...(repositoryTransport ? { repositoryTransport } : {}),
  });
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
