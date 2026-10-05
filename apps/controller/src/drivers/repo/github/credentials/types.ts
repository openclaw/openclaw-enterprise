import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import type { KeyObject } from "node:crypto";
import type { RepositoryBackendFactory, Clock } from "../../credentials/backend-contracts.ts";
import type { ServiceLimits } from "../../credentials/service-contracts.ts";

export type GitHubProfile = "git-read" | "git-write" | "git-full";
/** Internal scope used only by the repository metadata lookup. */
export type GitHubTokenProfile = GitHubProfile | "metadata-read";
interface GitHubConfigurationBase {
  readonly providerInstanceId: string;
  readonly configVersion: string;
  readonly repositoryId: string;
  readonly repository: string;
}
export interface GitHubAppConfiguration extends GitHubConfigurationBase {
  readonly kind: "github-app";
  readonly appId: string;
  readonly installationId: string;
  readonly privateKeyFile: string;
}
/** Development-only static token authority; production composition never selects it. */
export interface GitHubTokenConfiguration extends GitHubConfigurationBase {
  readonly kind: "github-token";
  readonly tokenFile: string;
  readonly developmentOnly: true;
  /** Enforced at the gateway on receive-pack commands; an empty list denies every push. */
  readonly pushRefAllowlist: readonly string[];
  /** GraphQL for git-write/git-full, and only with a fine-grained token. Never for git-read. */
  readonly allowGraphql: boolean;
  readonly leaseSeconds: number;
}
export type GitHubConfiguration = GitHubAppConfiguration | GitHubTokenConfiguration;

/** Derived from the token prefix; never secret and never more than the prefix. */
export type GitHubTokenClass =
  "fine-grained" | "classic" | "oauth" | "app-user" | "app-installation" | "unknown";

export interface GitHubKeyOwner {
  readonly kind: "github-app";
  withJwt<T>(consume: (jwt: string, assertCurrent: () => void) => Promise<T>): Promise<T>;
  close(): void;
}
/** Process-owned static token; lends a copy that is zeroed after use, never its buffer. */
export interface GitHubStaticTokenOwner {
  readonly kind: "github-token";
  readonly tokenClass: GitHubTokenClass;
  withToken<T>(consume: (bytes: Uint8Array, assertCurrent: () => void) => Promise<T>): Promise<T>;
  /** Zero-fills the token; later withToken calls throw "authority-unavailable". */
  close(): void;
}
export type GitHubAuthority = GitHubKeyOwner | GitHubStaticTokenOwner;
/** The token is copied; the caller zero-fills its own buffer. */
export type GitHubStaticTokenOptions = Readonly<{ token: Uint8Array }>;
export interface GitHubFactoryOptions {
  readonly configuration: GitHubConfiguration;
  /** Restricted service-internal token capability; never a user-facing access profile. */
  readonly metadataOnly?: true;
  readonly binding?: Readonly<{
    profile: GitHubTokenProfile;
    identity: RepositoryCredentialGrantIdentity;
    pushRefAllowlist?: readonly string[];
  }>;
  readonly authority: GitHubAuthority;
  readonly gatewayOrigin: string;
  readonly limits: ServiceLimits;
  readonly clock: Clock;
  readonly trustedEndpoints?: Readonly<{ apiOrigin: string; gitOrigin: string; ca?: Uint8Array }>;
}
export interface GitHubDriverFactory extends RepositoryBackendFactory {
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
}
export type GitHubKeyOptions = Readonly<{ privateKey: KeyObject; appId: string; clock: Clock }>;
