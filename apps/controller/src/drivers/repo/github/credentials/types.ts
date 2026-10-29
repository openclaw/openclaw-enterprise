import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import type { KeyObject } from "node:crypto";
import type { RepositoryBackendFactory, Clock } from "../../credentials/backend-contracts.ts";
import type { ServiceLimits } from "../../credentials/service-contracts.ts";

export type GitHubProfile = "git-read" | "git-write" | "git-full";
/** The last two scopes are internal; neither is accepted as a user-selected access profile. */
export type GitHubTokenProfile =
  GitHubProfile | "metadata-read" | "git-ref-write" | "git-ref-draft-pr";
interface GitHubTokenConfigurationBase {
  readonly providerInstanceId: string;
  readonly configVersion: string;
  readonly repositoryId: string;
  readonly repository: string;
}
/** Development-only static token authority; production composition never selects it. */
export interface GitHubTokenConfiguration extends GitHubTokenConfigurationBase {
  readonly kind: "github-token";
  readonly tokenFile: string;
  readonly developmentOnly: true;
  /** Enforced at the gateway on receive-pack commands; an empty list denies every push. */
  readonly pushRefAllowlist: readonly string[];
  /** GraphQL for git-write/git-full, and only with a fine-grained token. Never for git-read. */
  readonly allowGraphql: boolean;
  readonly leaseSeconds: number;
}

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
/** The token is copied; the caller zero-fills its own buffer. */
export type GitHubStaticTokenOptions = Readonly<{ token: Uint8Array }>;
export interface GitHubFactoryOptions {
  readonly configuration: GitHubTokenConfiguration;
  readonly binding?: Readonly<{
    profile: GitHubTokenProfile;
    identity: RepositoryCredentialGrantIdentity;
  }>;
  readonly authority: GitHubStaticTokenOwner;
  readonly gatewayOrigin: string;
  readonly limits: ServiceLimits;
  readonly clock: Clock;
  readonly trustedEndpoints?: Readonly<{ apiOrigin: string; gitOrigin: string; ca?: Uint8Array }>;
}
export interface GitHubDriverFactory extends RepositoryBackendFactory {
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
}
export type GitHubKeyOptions = Readonly<{ privateKey: KeyObject; appId: string; clock: Clock }>;
