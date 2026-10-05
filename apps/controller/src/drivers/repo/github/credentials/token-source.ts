import type {
  Clock,
  DriverCustody,
  RepositoryBackend,
} from "../../credentials/backend-contracts.ts";
import type { ServiceLimits } from "../../credentials/service-contracts.ts";
import type { GitHubDriverState } from "./driver/state.ts";
import type { GitHubGraphqlMode } from "./routes/classification.ts";
import type { GitHubAuthority, GitHubConfiguration, GitHubTokenProfile } from "./types.ts";
import { createAppTokenSource } from "./token-source/app.ts";
import { createStaticTokenSource } from "./token-source/static.ts";

/** Per-session inputs to a token source; nothing here is secret. */
export interface TokenSourceSession {
  readonly state: GitHubDriverState;
  readonly custody: DriverCustody;
  readonly clock: Clock;
  readonly profile: GitHubTokenProfile;
  readonly permissions: Readonly<Record<string, string>>;
  readonly repositoryId: string;
  readonly repository: string;
}
export interface TokenSourceBinding {
  readonly acquire: RepositoryBackend["acquire"];
  readonly retire: RepositoryBackend["retire"];
}
/** The authority-specific part of the GitHub backend; everything else is shared. */
export interface GitHubTokenSource {
  readonly kind: GitHubAuthority["kind"];
  readonly cleanup: RepositoryBackend["cleanup"];
  /** Folded into the grant identity. */
  capabilityPolicy(profile: GitHubTokenProfile): string;
  graphql(profile: GitHubTokenProfile): GitHubGraphqlMode;
  /** Enforced at the gateway on receive-pack commands when defined. */
  readonly pushRefAllowlist: readonly string[] | undefined;
  bind(session: TokenSourceSession): TokenSourceBinding;
}
export type TokenSourceOptions = Readonly<{
  config: GitHubConfiguration;
  apiOrigin: string;
  ca: Uint8Array | undefined;
  limits: ServiceLimits;
}>;

/** The only authority-kind switch in the GitHub driver tree. */
export function createTokenSource(
  authority: GitHubAuthority,
  options: TokenSourceOptions,
): GitHubTokenSource {
  const { config } = options;
  if (authority.kind === "github-app" && config.kind === "github-app") {
    return createAppTokenSource(authority, { ...options, config });
  }
  if (authority.kind === "github-token" && config.kind === "github-token") {
    return createStaticTokenSource(authority, { ...options, config });
  }
  throw new Error("invalid-configuration");
}
