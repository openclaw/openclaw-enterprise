import type { ChannelDriver } from "./channel/index.ts";
import type { ComputeDriver, ComputeLifecycleHooks } from "./compute/index.ts";
import type {
  ConfigurationContribution,
  ConfigurationDefinition,
} from "../configuration-definition.ts";
import type { ConfigurationDriver } from "./configuration/index.ts";
import type { CredentialGatewayDriver } from "./credential-gateway/index.ts";
import type { CredentialProxyDriver } from "./credential-proxy/index.ts";
import type { CredentialRefreshDriver } from "./credential-refresh/index.ts";
import type { IAMDriver } from "./iam/index.ts";
import type { PluginDriver } from "./plugin/index.ts";
import type { RepositoryPolicyDriver } from "./repo/index.ts";
import type { SandboxDriver } from "./sandbox/index.ts";
import type { SecretDriver } from "./secret/index.ts";
import type { ServiceAccountDriver } from "./service-account/index.ts";

export const DRIVER_CAPABILITIES = Object.freeze([
  "iam",
  "compute",
  "configuration",
  "service_account",
  "secret",
  "sandbox",
  "plugin",
  "channel",
  "repo",
  "credential_gateway",
  "credential_refresh",
  "credential_proxy",
] as const);

export type DriverCapability = (typeof DRIVER_CAPABILITIES)[number];

export function isDriverCapability(value: unknown): value is DriverCapability {
  return (
    typeof value === "string" && DRIVER_CAPABILITIES.some((capability) => capability === value)
  );
}

export interface Driver {
  readonly id: string;
  readonly capability: DriverCapability;
  readonly implementation: string;
  readonly computeLifecycleHooks?: ComputeLifecycleHooks;
}

export type DriverByCapability = {
  iam: IAMDriver;
  configuration: ConfigurationDriver;
  service_account: ServiceAccountDriver;
  secret: SecretDriver;
  sandbox: SandboxDriver;
  compute: ComputeDriver;
  plugin: PluginDriver;
  channel: ChannelDriver;
  repo: RepositoryPolicyDriver;
  credential_gateway: CredentialGatewayDriver;
  credential_refresh: CredentialRefreshDriver;
  credential_proxy: CredentialProxyDriver;
};

/** A package returns the capabilities of this instance and one lifecycle, never support flags. */
export interface DriverRegistration {
  readonly capabilities: Readonly<Partial<DriverByCapability>>;
  readonly computeLifecycleHooks?: ComputeLifecycleHooks;
  close?(): void | Promise<void>;
}

/** Installation-selected identity and a digest of the nonsecret configuration generation. */
export interface DriverRegistrationRef {
  readonly id: string;
  readonly implementation: string;
  readonly configurationId: string;
}

/** An installation-owned capability selection. Object identity proves a common owner in this process. */
export interface SelectedDriverRegistration {
  readonly ref: DriverRegistrationRef;
  require<K extends DriverCapability>(key: K): DriverByCapability[K];
}

export interface DriverImplementation<T = unknown> extends ConfigurationDefinition<T> {
  readonly configurationContributions?: readonly ConfigurationContribution[];
}
