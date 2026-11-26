import type { ChannelProviderDriver } from "../drivers/channel/routing.ts";
import { SlackChannelDriver } from "../drivers/channel/slack.ts";
import { sandboxNamespaceLifecycleBinding } from "./namespace-lifecycle.ts";
import { resolveModelCredentialPreset } from "./model-credential-presets.ts";
import {
  admitOpenShellRepositoryCredentials,
  openShellRepositorySourceCeiling,
  prepareOpenShellRepositorySource,
  supportsOpenShellCredentialDeployment,
} from "./openshell-credential-admission.ts";
import { OpenShellCredentialProxyDriver } from "../drivers/credential-proxy/openshell.ts";
import type { NamespaceLifecycleBinding } from "@openclaw-enterprise/occ";
import { githubRepositoryConfiguration } from "../drivers/repo/github/installation.ts";
import type { GitHubRepositoryRegistry } from "../drivers/repo/github/access/registry.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverSelection,
} from "../drivers/sandbox/openshell.ts";
import type { OpenShellSandboxDriverOptions } from "../drivers/sandbox/openshell.ts";
import type { CredentialProxyDriver } from "@openclaw-enterprise/contracts";
import { InstallationFieldError, requireChartGatewayRouting } from "./installation-fields.ts";
import {
  requireConfiguration,
  serializeStartupConfiguration,
} from "@openclaw-enterprise/contracts";
import {
  isSupportedPermission,
  parseRepositoryNetworkPolicyCeiling,
  PERMISSION_ACTIONS,
  RepositoryNetworkPolicyAdmissionError,
  RESOURCE_KINDS,
  validateSandboxNetworkGrants,
} from "@openclaw-enterprise/contracts";
import type {
  RepositoryNetworkPolicyCeiling,
  SandboxNetworkGrant,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Backend,
  ComputeDriver,
  ConfigurationDriver,
  DriverImplementation,
  IAMDriver,
  Identity,
  BackendDefinition,
  OpenShellBackendDefinition,
  Permission,
  PresetDraftDefinition,
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
  SandboxRepositoryRecipientUnverifiedError,
  AuthorizationDeniedError,
  DependencyUnavailableError,
  validateBackendDefinitions,
  type BundledPresetVersion,
  type ControllerOptions,
  type InstallationIAMConfiguration,
  type NativeWorkerSupport,
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
import { ManagedOpenShellSandbox } from "../drivers/sandbox/openshell/managed.ts";
import { refuseRewrittenIpv4Host, refuseWrittenUserinfo } from "../auth/configuration.ts";
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
import { GitHubRepositoryPolicy } from "../drivers/repo/github/policy.ts";
import { loadRepositoryPolicy } from "./repository-credentials/policy.ts";
import type { PreparedRepositoryGitConfiguration } from "../backends/repository-credentials/prepared-git-owner.ts";
import {
  createOpenShellBackend,
  isOpenShellGatewayEligible,
  type OpenShellGateway,
} from "../backends/openshell.ts";
import { OCCTokenServiceDriver } from "../drivers/token-service/occ.ts";
import { OpenShellTokenServiceDriver } from "../drivers/token-service/openshell.ts";

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
  readonly startupConfiguration?: Readonly<Record<string, unknown>>;
}

export interface InstallationStartupConfiguration {
  readonly repository?: SelectedDriverConfiguration;
  readonly sandboxNetworkPolicyCeiling?: readonly SandboxNetworkGrant[];
  readonly repositoryNetworkPolicyCeiling?: RepositoryNetworkPolicyCeiling;
  /** RFC-0026 configured Roles, Groups, and Group bindings; see the configuration reference. */
  readonly iam?: InstallationIAMConfiguration;
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
    readonly token_service?: SelectedDriverConfiguration;
    readonly plugin?: readonly SelectedDriverConfiguration[];
    readonly service_account?: { readonly id: string };
  };
}

/** Definitions and safe startup projections stay with their selected process identities. */
export function installationDriverConfigurations(
  installation: InstallationStartupConfiguration | undefined,
): readonly import("@openclaw-enterprise/occ").DriverConfigurationRegistration[] {
  const { plugin = [], ...drivers } = installation?.drivers ?? {};
  const selections = [
    ...Object.entries(drivers),
    ...plugin.map((selection) => ["plugin", selection] as const),
  ];
  return selections.flatMap(([capability, selection]) => {
    if (!("definition" in selection)) {
      return [];
    }
    const { startupConfiguration } = selection;
    return [
      {
        capability: capability as import("@openclaw-enterprise/contracts").DriverCapability,
        driverId: selection.id,
        implementation: selection.implementation,
        definition: selection.definition,
        ...(startupConfiguration === undefined ? {} : { startupConfiguration }),
      },
    ];
  });
}

/**
 * Controller options supplied by the Installation and its selected Repository registry. API
 * compositions spread them unchanged, so a startup setting cannot be dropped before OCC.
 */
export function installationControllerOptions(
  installation: InstallationStartupConfiguration | undefined,
  repositoryRegistry?: GitHubRepositoryRegistry,
): Pick<
  ControllerOptions,
  | "driverConfigurations"
  | "sandboxNetworkPolicyCeiling"
  | "repositoryNetworkPolicyCeiling"
  | "iamConfiguration"
  | "nativeWorkerSupport"
  | "modelCredentialSourcePresets"
  | "modelCredentialPreset"
  | "repositoryCredentialAdmission"
  | "stagedRepositoryCeiling"
  | "prepareStagedRepositorySource"
  | "supportsStagedRepositoryRecipient"
  | "supportsCredentialDeployment"
> {
  const tokenService = installation?.drivers.token_service?.implementation;
  const modelCredentialSourcePresets =
    tokenService === OCCTokenServiceDriver.implementation ||
    tokenService === OpenShellTokenServiceDriver.implementation
      ? (["openai", "codex-pat"] as const)
      : undefined;
  return {
    modelCredentialSourcePresets,
    modelCredentialPreset: resolveModelCredentialPreset,
    repositoryCredentialAdmission: (input) =>
      admitOpenShellRepositoryCredentials(repositoryRegistry, input),
    ...(repositoryRegistry && {
      stagedRepositoryCeiling: (input) =>
        openShellRepositorySourceCeiling(repositoryRegistry, input),
      prepareStagedRepositorySource: (input) =>
        prepareOpenShellRepositorySource(repositoryRegistry, input),
    }),
    supportsStagedRepositoryRecipient: ({ compute, sandbox, proxy, harness }) => {
      if (
        !(compute instanceof KubernetesComputeDriver) ||
        !(sandbox instanceof OpenShellSandboxDriver) ||
        !(proxy instanceof OpenShellCredentialProxyDriver) ||
        proxy.id !== sandbox.id ||
        proxy.implementation !== sandbox.implementation
      ) {
        return false;
      }
      try {
        compute.validateRepositoryCredentials(harness, sandbox.id);
        return true;
      } catch {
        return false;
      }
    },
    supportsCredentialDeployment: supportsOpenShellCredentialDeployment,
    driverConfigurations: installationDriverConfigurations(installation),
    sandboxNetworkPolicyCeiling: installation?.sandboxNetworkPolicyCeiling ?? [],
    repositoryNetworkPolicyCeiling: installation?.repositoryNetworkPolicyCeiling ?? [],
    ...(installation?.iam === undefined ? {} : { iamConfiguration: installation.iam }),
    ...(installation?.runtime === undefined
      ? {}
      : { nativeWorkerSupport: installation.runtime.nativeWorkerSupport }),
  };
}

export type ServiceAccountDriverFactory = (
  controller: OpenClawController,
  state: PostgresPlatformState,
) => void;

export interface InstallationRuntimeDrivers {
  readonly channelDrivers?: readonly ChannelProviderDriver[];
  readonly defaultPresets?: readonly PresetDraftDefinition[];
  /** Bundled defaults replaced by a same-named `presets.files` entry; startup warns once each. */
  readonly shadowedDefaultPresets?: readonly ShadowedDefaultPreset[];
  /** Shipped versions of the bundled defaults, loaded even when they are not seeded. */
  readonly bundledPresetVersions?: readonly BundledPresetVersion[];
  readonly installation: InstallationStartupConfiguration;
  readonly computeDriver: ComputeDriver;
  readonly configurationDriver: ConfigurationDriver;
  readonly secretDriver: SecretDriver;
  readonly sandboxDriver?: SandboxDriver;
  /** Same selected Sandbox owner, with the native delivery capability when available. */
  readonly credentialDeliveryRegistration?: InstalledDriver;
  readonly openShellTokenServiceBackend?: Backend<OpenShellGateway>;
  readonly namespaceLifecycleBindings?: readonly NamespaceLifecycleBinding[];
  readonly tokenService?: TokenService;
  readonly pluginDrivers?: readonly PluginDriver[];
  readonly repositoryPolicy?: RepositoryPolicyDriver;
  readonly repositoryAdmission?: Awaited<
    ReturnType<typeof loadRepositoryPolicy>
  >["repositoryAdmission"] & { readonly policyMode?: "built-in" };
  readonly nativeRepositorySender?: NativeRepositorySender;
  readonly preparedRepositoryGit?: PreparedRepositoryGitConfiguration;
  readonly repositoryRegistry?: Awaited<
    ReturnType<typeof loadRepositoryPolicy>
  >["repositoryRegistry"];
  readonly repositoryOwner?: Readonly<{
    controlSocket?: string;
    driverId: string;
    implementation: string;
    backendId: string;
  }>;
  readonly createIAMDriver: (state: NativeIAMStateStore) => IAMDriver;
}

/** Bind Source retirement to the concrete selected Proxy and its Sandbox placement. */
export function credentialSourceDeliveryBinding(
  drivers: InstallationRuntimeDrivers | undefined,
): ControllerOptions["credentialSourceDelivery"] {
  if (!drivers?.credentialDeliveryRegistration) {
    return undefined;
  }
  return async (proxy, namespace, source, signal) => {
    const compute = drivers.computeDriver;
    if (!(proxy instanceof OpenShellCredentialProxyDriver) || !compute.resolveSandboxNamespace) {
      throw new DependencyUnavailableError(
        "The selected credential delivery Proxy cannot retire this Source.",
      );
    }
    const placed = await compute.resolveSandboxNamespace(namespace);
    signal.throwIfAborted();
    await proxy.retireSource(placed, source, signal);
  };
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
  defaults: readonly PresetDraftDefinition[],
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

const IAM_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function iamName(value: unknown, path: string): string {
  if (typeof value !== "string" || !IAM_NAME.test(value)) {
    throw new Error(
      `${path} must be 1-63 lowercase letters, digits, "_", or "-", starting with a letter or digit.`,
    );
  }
  return value;
}

function iamPermission(value: unknown, path: string): Permission {
  const [resourceKind, action, extra] = typeof value === "string" ? value.split(":") : [];
  const permission = { action, resourceKind } as Permission;
  if (
    extra !== undefined ||
    !PERMISSION_ACTIONS.some((candidate) => candidate === action) ||
    !RESOURCE_KINDS.some((candidate) => candidate === resourceKind) ||
    !isSupportedPermission(permission)
  ) {
    throw new Error(`${path} must be a supported "resourceKind:action" permission.`);
  }
  // Installation authority stays with the administrator Role that bootstrap creates.
  if (resourceKind === "installation") {
    throw new Error(`${path} cannot grant an installation permission.`);
  }
  return Object.freeze(permission);
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${path} must not repeat an entry.`);
  }
}

function iamConfiguration(value: unknown): InstallationIAMConfiguration | undefined {
  if (value === undefined) {
    return undefined;
  }
  const configuration = object(value, "iam");
  closed(configuration, ["roles", "defaultUserGroups", "ownerRole", "roleBindings"], "iam");
  const listed = (field: string): readonly unknown[] => {
    const entries = configuration[field] ?? [];
    if (!Array.isArray(entries)) {
      throw new Error(`iam.${field} must be an array.`);
    }
    return entries;
  };
  const roles = listed("roles").map((entry, index) => {
    const path = `iam.roles[${index}]`;
    const role = object(entry, path);
    closed(role, ["id", "permissions"], path);
    if (!Array.isArray(role.permissions) || role.permissions.length === 0) {
      throw new Error(`${path}.permissions must be a nonempty array.`);
    }
    const permissions = role.permissions.map((permission, permissionIndex) =>
      iamPermission(permission, `${path}.permissions[${permissionIndex}]`),
    );
    unique(
      permissions.map(({ action, resourceKind }) => `${resourceKind}:${action}`),
      `${path}.permissions`,
    );
    return Object.freeze({
      id: iamName(role.id, `${path}.id`),
      permissions: Object.freeze(permissions),
    });
  });
  const roleIds = roles.map((role) => role.id);
  unique(roleIds, "iam.roles");
  const configuredRole = (id: unknown, path: string): string => {
    const name = iamName(id, path);
    if (!roleIds.includes(name)) {
      throw new Error(`${path} must name a Role in iam.roles.`);
    }
    return name;
  };
  const defaultUserGroups = listed("defaultUserGroups").map((group, index) =>
    iamName(group, `iam.defaultUserGroups[${index}]`),
  );
  unique(defaultUserGroups, "iam.defaultUserGroups");
  const roleBindings = listed("roleBindings").map((entry, index) => {
    const path = `iam.roleBindings[${index}]`;
    const binding = object(entry, path);
    closed(binding, ["group", "role", "scope"], path);
    let scope: "installation" | { readonly namespace: string };
    if (binding.scope === "installation") {
      scope = "installation";
    } else {
      const namespaceScope = object(binding.scope, `${path}.scope`);
      closed(namespaceScope, ["namespace"], `${path}.scope`);
      scope = Object.freeze({
        namespace: nonempty(namespaceScope.namespace, `${path}.scope.namespace`),
      });
    }
    return Object.freeze({
      group: iamName(binding.group, `${path}.group`),
      role: configuredRole(binding.role, `${path}.role`),
      scope,
    });
  });
  unique(
    roleBindings.map(({ group, role, scope }) => JSON.stringify([group, role, scope])),
    "iam.roleBindings",
  );
  return Object.freeze({
    roles: Object.freeze(roles),
    defaultUserGroups: Object.freeze(defaultUserGroups),
    ...(configuration.ownerRole === undefined
      ? {}
      : { ownerRole: configuredRole(configuration.ownerRole, "iam.ownerRole") }),
    roleBindings: Object.freeze(roleBindings),
  });
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

function installationRepositoryConfiguration(input: unknown) {
  if (input === undefined) {
    return undefined;
  }
  const selection = object(input, "repository");
  if (Object.hasOwn(selection, "openShell")) {
    throw new Error(
      "repository.openShell is retired. Use an admitted TokenService Repository Source.",
    );
  }
  closed(
    selection,
    ["id", "configuration", "preparedGitHub", "nativeSender", "policyMode"],
    "repository",
  );
  const { policyMode, ...portableSelection } = selection;
  if (policyMode !== undefined && policyMode !== "built-in") {
    throw new Error('repository.policyMode must be "built-in" when supplied.');
  }
  return { ...githubRepositoryConfiguration(portableSelection), selection };
}

function selectGitHubRepositoryDelivery(
  repository: ReturnType<typeof installationRepositoryConfiguration>,
  input: { sandbox: boolean; kubernetes: boolean; stagedTokenService: boolean },
): "native" | "token-service" | undefined {
  if (!repository) {
    return undefined;
  }
  if (repository.nativeSender) {
    if (!repository.prepared || input.sandbox || !input.kubernetes) {
      throw new Error(
        "repository.nativeSender requires prepared GitHub custody and the bundled Kubernetes Compute Driver without a Sandbox.",
      );
    }
    return "native";
  }
  if (input.stagedTokenService && !repository.prepared) {
    return "token-service";
  }
  throw new SandboxRepositoryRecipientUnverifiedError();
}

function backendConfiguration(
  value: unknown,
  serviceAccount: InstallationStartupConfiguration["drivers"]["service_account"],
  repoSelection: InstallationStartupConfiguration["repository"],
): readonly BackendDefinition[] {
  const backends = validateBackendDefinitions(value ?? []);
  if (serviceAccount !== undefined && !backends.some((backend) => backend.type === "chatgpt")) {
    throw new Error("drivers.service_account requires an owning backend entry with type chatgpt.");
  }
  if (repoSelection !== undefined && !backends.some((backend) => backend.type === "github")) {
    throw new Error("repository requires an owning backend entry with type github.");
  }
  for (const backend of backends) {
    if (backend.type === "openshell") {
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
    | "token_service"
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
  return composeInstallationConfiguration(options);
}

function loadRepositoryNetworkPolicyCeiling(
  value: unknown,
  allowRepositoryNames: boolean,
): RepositoryNetworkPolicyCeiling | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return parseRepositoryNetworkPolicyCeiling(value, allowRepositoryNames);
  } catch (error) {
    if (!(error instanceof RepositoryNetworkPolicyAdmissionError)) {
      throw error;
    }
    throw new InstallationFieldError([
      { path: error.path, code: "INVALID_VALUE", message: error.message },
    ]);
  }
}

async function composeInstallationConfiguration(
  options: Parameters<typeof loadInstallationConfiguration>[0],
): Promise<InstallationRuntimeDrivers | undefined> {
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
    configuration.presets === undefined &&
    configuration.repositoryNetworkPolicyCeiling === undefined
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
  const iamSettings = iamConfiguration(configuration.iam);
  const runtime = runtimeConfiguration(configuration.runtime);
  const drivers = object(configuration.drivers, "drivers");
  if (Object.hasOwn(drivers, "conduit")) {
    throw new Error("drivers.conduit is retired.");
  }
  closed(
    drivers,
    [
      "configuration",
      "iam",
      "compute",
      "secret",
      "sandbox",
      "credential_proxy",
      "token_service",
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
  if (Object.hasOwn(drivers, "credential_proxy")) {
    throw new Error(
      "The legacy drivers.credential_proxy startup setting is retired. Select TokenService with the bundled OpenShell Sandbox for credential delivery.",
    );
  }
  if (drivers.repo !== undefined) {
    throw new Error(
      "drivers.repo startup admission is retired. Select repository.nativeSender with repository.preparedGitHub, or configure a TokenService Repository Source.",
    );
  }
  const repositoryConfiguration = installationRepositoryConfiguration(configuration.repository);
  const repoSelection =
    repositoryConfiguration &&
    (selected(
      repositoryConfiguration.selection,
      "repo",
      "github",
      GitHubRepositoryPolicy,
      "repository",
    ) as SelectedDriverConfiguration<Readonly<{ sessionDurationSeconds: number }>>);
  const nativeRepositorySelection = repositoryConfiguration?.nativeSender;
  const preparedRepositoryGit = repositoryConfiguration?.prepared;
  const sandboxSelection =
    drivers.sandbox === undefined ? undefined : object(drivers.sandbox, "drivers.sandbox");
  const backends = backendConfiguration(configuration.backend, serviceAccount, repoSelection);
  const openShellBackend = backends.find(
    (backend): backend is OpenShellBackendDefinition => backend.type === "openshell",
  );

  const configurationSelection = object(drivers.configuration, "drivers.configuration");
  const iamSelection = object(drivers.iam, "drivers.iam");
  const computeSelection = object(drivers.compute, "drivers.compute");
  const secretSelection = object(drivers.secret, "drivers.secret");
  const pluginEntries = drivers.plugin === undefined ? [] : drivers.plugin;
  if (!Array.isArray(pluginEntries)) {
    throw new Error("drivers.plugin must be an array of Plugin Driver registrations.");
  }
  const pluginIds = new Set<string>();
  const plugins = pluginEntries.map((entry, index) => {
    const path = `drivers.plugin[${index}]`;
    const selection = object(entry, path);
    closed(selection, ["id", "configuration"], path);
    if (selection.id !== "occ-plugin" && selection.id !== "codex-plugin") {
      throw new Error(`${path}.id must select occ-plugin or codex-plugin.`);
    }
    if (pluginIds.has(selection.id)) {
      throw new Error(`${path}.id duplicates another Plugin Driver selection.`);
    }
    pluginIds.add(selection.id);
    const Driver = selection.id === "codex-plugin" ? CodexPluginDriver : OCCPluginDriver;
    const implementation =
      selection.id === "codex-plugin" ? "occ/codex-plugin" : "occ/openclaw-plugin";
    const config = selected(selection, "plugin", implementation, Driver, path);
    return { config, driver: new Driver(config.configuration, config) };
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
    sandbox: sandboxSelection !== undefined,
    kubernetes: kubernetesCompute,
    stagedTokenService:
      asRecord(drivers.token_service)?.id === "occ" &&
      openShellBackend !== undefined &&
      kubernetesCompute &&
      sandboxSelection !== undefined &&
      sandboxSelection.package === undefined &&
      sandboxSelection.id !== "strands-box-sandbox" &&
      options.createSandboxDriver === undefined,
  });
  const repositoryNetworkPolicyCeiling = loadRepositoryNetworkPolicyCeiling(
    configuration.repositoryNetworkPolicyCeiling,
    repositoryDeliveryMode === "token-service",
  );
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
  const boxPackage =
    sandboxSelection?.id === "strands-box-sandbox" && sandboxPackage === undefined
      ? await import("../drivers/sandbox/strands-box.ts")
      : undefined;
  const bundledSandboxPackage =
    sandboxSelection !== undefined && sandboxPackage === undefined && boxPackage === undefined
      ? await loadBundledOpenShellSandboxDriver()
      : undefined;

  const sandbox =
    sandboxSelection === undefined
      ? undefined
      : selected(
          sandboxSelection,
          "sandbox",
          sandboxPackage?.implementation ?? (boxPackage ? "strands-box" : "openshell"),
          sandboxPackage?.module ?? boxPackage ?? bundledSandboxPackage!,
        );
  let tokenServiceSelection: SelectedDriverConfiguration | undefined;
  if (drivers.token_service !== undefined) {
    const selection = object(drivers.token_service, "drivers.token_service");
    closed(selection, ["id", "configuration"], "drivers.token_service");
    if (selection.id === "occ") {
      tokenServiceSelection = selected(
        selection,
        "token_service",
        OCCTokenServiceDriver.implementation,
        OCCTokenServiceDriver,
      );
    } else if (selection.id === "openshell" && options.mode === "development") {
      tokenServiceSelection = selected(
        selection,
        "token_service",
        OpenShellTokenServiceDriver.implementation,
        OpenShellTokenServiceDriver,
      );
    } else {
      throw new Error("drivers.token_service.id must select occ, or openshell in development.");
    }
  }
  const openShellServiceIntegration =
    kubernetesCompute &&
    sandbox !== undefined &&
    sandboxPackage === undefined &&
    (sandbox.configuration as unknown as OpenShellSandboxDriverOptions).integrationMode ===
      "service";
  if (openShellServiceIntegration && options.createSandboxDriver !== undefined) {
    throw new Error(
      "Managed Kubernetes + OpenShell Compute requires its bundled Sandbox collaborator.",
    );
  }

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
  const bundledCompute = sshCompute
    ? { implementation: "occ/ssh", module: SshComputeDriver }
    : { implementation: "occ/kubernetes", module: KubernetesComputeDriver };
  const compute = selected(
    computeSelection,
    "compute",
    computePackage?.implementation ?? bundledCompute.implementation,
    computePackage?.module ?? bundledCompute.module,
  );
  if (kubernetesCompute) {
    requireChartGatewayRouting(
      (compute.configuration as unknown as KubernetesComputeDriverOptions).gatewayRouting,
      environment,
    );
  }
  const createOpenShellSandbox = (
    configuration: Readonly<Record<string, unknown>>,
    selection: OpenShellSandboxDriverSelection,
  ): SandboxDriver =>
    openShellServiceIntegration
      ? new ManagedOpenShellSandbox(
          configuration as unknown as OpenShellSandboxDriverOptions,
          selection,
        )
      : new bundledSandboxPackage!.OpenShellSandboxDriver(configuration, selection);
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
      !tokenServiceSelection ||
      options.createSandboxDriver !== undefined ||
      !isOpenShellGatewayEligible(openShellBackend)
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
          "drivers.compute.configuration.network.repositoryCredentials requires repository.nativeSender; remove it for other delivery modes.",
      },
    ]);
  }
  if (sandbox !== undefined && computePackage !== undefined) {
    throw new Error("drivers.sandbox requires the bundled Kubernetes Compute Driver.");
  }
  if (
    boxPackage &&
    (openShellBackend ||
      !kubernetesCompute ||
      (compute.configuration as unknown as KubernetesComputeDriverOptions).executionCluster !==
        undefined)
  ) {
    throw new Error(
      "The Strands Box Pod driver requires same-cluster Kubernetes Compute and a sandbox-only installation.",
    );
  }
  if (
    sandbox !== undefined &&
    sandboxPackage === undefined &&
    !boxPackage &&
    openShellBackend === undefined
  ) {
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
    ...(repositoryNetworkPolicyCeiling === undefined ? {} : { repositoryNetworkPolicyCeiling }),
    ...(iamSettings === undefined ? {} : { iam: iamSettings }),
    presets: Object.freeze({ includeDefaults }),
    logging,
    ...(observability === undefined ? {} : { observability }),
    ...(runtime === undefined ? {} : { runtime }),
    backend: backends,
    ...(repoSelection === undefined ? {} : { repository: repoSelection }),
    drivers: Object.freeze({
      configuration: configured,
      iam,
      compute,
      secret,
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(tokenServiceSelection === undefined ? {} : { token_service: tokenServiceSelection }),
      plugin: plugins.map(({ config }) => config),
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
  let repositoryRuntime;
  if (repoSelection !== undefined && repositoryBackend !== undefined) {
    if (nativeRepositorySelection !== undefined) {
      const { composeRepositoryAccess } = await import("./repository-credentials/platform.ts");
      repositoryRuntime = await composeRepositoryAccess(
        { backend: repositoryBackend, selection: repoSelection },
        nativeRepositorySelection,
      );
    } else {
      repositoryRuntime = await loadRepositoryPolicy(
        { backend: repositoryBackend, selection: repoSelection },
        { allowNameOnlyNativeRepositories: repositoryDeliveryMode === "token-service" },
      );
    }
  }
  const secretDriver = new KubernetesSecretDriver(
    secret.configuration as unknown as KubernetesSecretDriverOptions,
    {
      id: secret.id,
      implementation: secret.implementation,
      preprovisionedNamespace,
      installationSecretNamespace: environment.OCC_INSTALLATION_SECRET_NAMESPACE,
    },
  );
  const tokenService = new TokenService();
  const createCredentialDeliveryProxy = (
    pairedSandbox: SandboxDriver,
    tokenServiceImplementation: string,
  ): CredentialProxyDriver => {
    const sandbox = pairedSandbox as SandboxDriver &
      Pick<OpenShellSandboxDriver, "gitRuntimeProviderName" | "withdrawStagedCredentialRoute">;
    if (
      typeof sandbox.withdrawStagedCredentialRoute !== "function" ||
      typeof sandbox.gitRuntimeProviderName !== "function"
    ) {
      throw new Error(
        "Native credential delivery requires the paired OpenShell Sandbox policy owner.",
      );
    }
    return new OpenShellCredentialProxyDriver({
      id: pairedSandbox.id,
      implementation: pairedSandbox.implementation,
      tokenServiceImplementation,
      backend: openShell!,
      sandbox,
    });
  };
  const sandboxDriver: SandboxDriver | undefined = (() => {
    if (sandbox === undefined) {
      return undefined;
    }
    if (options.createSandboxDriver !== undefined) {
      return validateCreatedSandboxDriver(options.createSandboxDriver(sandbox, openShell), sandbox);
    }
    if (boxPackage) {
      const kubernetes = compute.configuration as unknown as KubernetesComputeDriverOptions;
      if (kubernetes.executionCluster || !kubernetes.gatewayRouting) {
        throw new Error("Strands Box requires a single cluster with Gateway routing.");
      }
      return new boxPackage.StrandsBoxSandboxDriver(
        sandbox.configuration as unknown as import("../drivers/sandbox/strands-box.ts").StrandsBoxOptions,
        {
          id: sandbox.id,
          authentication: kubernetes.authentication,
          dns: kubernetes.network.dns,
          routing: kubernetes.gatewayRouting,
        },
      );
    }
    if (sandboxPackage !== undefined) {
      return createExternalDriver(sandboxPackage.module, sandbox, "sandbox") as SandboxDriver;
    }
    return createOpenShellSandbox(sandbox.configuration, {
      id: sandbox.id,
      implementation: sandbox.implementation,
      backend: openShell!,
      operatorOwnedKubernetesResources: preprovisionedNamespace !== undefined,
      stagedRepositoryPolicy: repositoryDeliveryMode === "token-service",
    });
  })();
  const credentialDeliveryRegistration =
    tokenServiceSelection !== undefined &&
    openShellBackend !== undefined &&
    sandbox !== undefined &&
    sandboxDriver !== undefined &&
    sandboxPackage === undefined &&
    !boxPackage &&
    options.createSandboxDriver === undefined
      ? new InstalledDriver(
          {
            id: sandboxDriver.id,
            implementation: sandboxDriver.implementation,
            configuration: { sandbox: sandbox.configuration, backend: openShellBackend },
          },
          {
            capabilities: {
              sandbox: sandboxDriver,
              credential_proxy: createCredentialDeliveryProxy(
                sandboxDriver,
                tokenServiceSelection.implementation,
              ),
            },
          },
        )
      : undefined;
  const selectsOpenShellTokenService =
    tokenServiceSelection?.implementation === OpenShellTokenServiceDriver.implementation;
  if (
    openShellBackend?.drivers.token_service !==
    (selectsOpenShellTokenService ? tokenServiceSelection?.id : undefined)
  ) {
    throw new Error(
      "The OpenShell Backend token_service member must match the selected OpenShell TokenService.",
    );
  }
  if (
    selectsOpenShellTokenService &&
    (!openShell ||
      !openShellBackend?.configuration.endpoint ||
      !isOpenShellGatewayEligible(openShellBackend) ||
      !credentialDeliveryRegistration ||
      !kubernetesCompute)
  ) {
    throw new Error(
      "The OpenShell TokenService preview requires a fixed authenticated TLS Gateway and paired Kubernetes Compute and OpenShell Sandbox and Credential Proxy.",
    );
  }
  const channelOptions = (compute.configuration as unknown as KubernetesComputeDriverOptions)
    .runtime?.channelEgress;
  const channelHost =
    channelOptions === undefined
      ? undefined
      : `${channelOptions.serviceName}.${channelOptions.envoyNamespace}.svc`;
  const channelDrivers: readonly ChannelProviderDriver[] = Object.freeze([
    {
      provider: "slack",
      driver: new SlackChannelDriver(
        globalThis.fetch,
        channelOptions === undefined
          ? undefined
          : `http://${channelHost}:${channelOptions.occListenerPort}`,
        { expectProxy: true, managedProxyHosts: channelHost === undefined ? [] : [channelHost] },
      ),
    },
  ]);
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
    const selection: NonNullable<ConstructorParameters<typeof KubernetesComputeDriver>[1]> = {
      id: compute.id,
      implementation: compute.implementation,
      lifecycleDrivers: [configurationDriver],
      channelDrivers,
      ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
      ...(credentialDeliveryRegistration === undefined ? {} : { credentialDeliveryRegistration }),
      ...(repositoryDeliveryMode === "native" && { preparedRepositoryIngress: true }),
      preprovisionedNamespace,
      nodeEnrollment: createGatewayNodeEnrollment(() =>
        readWorkspaceFilesApiKey(
          nonempty(environment.OCC_GATEWAY_API_KEY_PATH, "OCC_GATEWAY_API_KEY_PATH"),
        ),
      ),
      readNodeCa: () => readHarnessNodeCa(environment),
    };
    computeDriver = new KubernetesComputeDriver(
      compute.configuration as unknown as KubernetesComputeDriverOptions,
      selection,
    );
  }
  const sandboxOwner = credentialDeliveryRegistration ?? sandboxDriver;
  const namespaceLifecycleBindings =
    sandboxDriver === undefined || sandboxOwner?.namespaceLifecycleHooks !== undefined
      ? []
      : [sandboxNamespaceLifecycleBinding(computeDriver, sandboxDriver, sandboxOwner!)];
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
  const { repositoryPolicy: _repositoryPolicy, ...repositoryServices } = repositoryRuntime ?? {};
  return Object.freeze({
    channelDrivers,
    defaultPresets: Object.freeze(defaultPresets),
    shadowedDefaultPresets: Object.freeze(shadowedDefaultPresets),
    bundledPresetVersions,
    installation,
    computeDriver,
    namespaceLifecycleBindings,
    configurationDriver,
    secretDriver,
    ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
    ...(credentialDeliveryRegistration === undefined ? {} : { credentialDeliveryRegistration }),
    ...(selectsOpenShellTokenService && { openShellTokenServiceBackend: openShell! }),
    tokenService,
    createIAMDriver,
    pluginDrivers: plugins.map(({ driver }) => driver),
    ...repositoryServices,
    ...(repositoryRuntime && {
      repositoryAdmission: Object.freeze({
        ...repositoryRuntime.repositoryAdmission,
        policyMode: "built-in" as const,
      }),
    }),
    ...(preparedRepositoryGit ? { preparedRepositoryGit } : {}),
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
