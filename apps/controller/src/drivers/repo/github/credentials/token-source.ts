import type {
  Clock,
  DriverCustody,
  RepositoryBackend,
} from "../../credentials/backend-contracts.ts";
import type { GitHubDriverState } from "./driver/state.ts";
import type { GitHubGraphqlMode } from "./routes/classification.ts";
import type { GitHubStaticTokenOwner, GitHubTokenProfile } from "./types.ts";

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
  readonly kind: GitHubStaticTokenOwner["kind"];
  readonly cleanup: RepositoryBackend["cleanup"];
  /** Folded into the grant identity. */
  capabilityPolicy(profile: GitHubTokenProfile): string;
  graphql(profile: GitHubTokenProfile): GitHubGraphqlMode;
  /** Enforced at the gateway on receive-pack commands when defined. */
  readonly pushRefAllowlist: readonly string[] | undefined;
  bind(session: TokenSourceSession): TokenSourceBinding;
}
