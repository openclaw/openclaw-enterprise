import type {
  AuthorityIdentity,
  Clock,
  DriverCustody,
  RepositoryBackend,
} from "../../credentials/backend-contracts.ts";
import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import type { RoutePolicy } from "./routes.ts";
import type { GitHubTokenSource, TokenSourceSession } from "./token-source.ts";
import { createCredentialAuthentication } from "./driver/access.ts";
import { createGitHubDriverState } from "./driver/state.ts";

export { sameAuthority } from "./driver/state.ts";

interface GitHubDriverOptions {
  readonly authority: AuthorityIdentity;
  readonly binding: RepositoryCredentialGrantIdentity;
  readonly custody: DriverCustody;
  readonly clock: Clock;
  readonly routes: RoutePolicy;
  readonly source: GitHubTokenSource;
  readonly session: Pick<
    TokenSourceSession,
    "profile" | "permissions" | "repositoryId" | "repository"
  >;
}

/** One session's backend; the token source supplies only acquisition and retirement. */
export function createGitHubDriver(options: GitHubDriverOptions): RepositoryBackend {
  const { authority, binding, custody, clock, routes, source, session } = options;
  const state = createGitHubDriverState({ authority, custody, routes });
  const { acquire, retire } = source.bind({ state, custody, clock, ...session });
  const withAuthentication = createCredentialAuthentication({ state, custody, clock });
  return Object.freeze<RepositoryBackend>({
    binding,
    replacement: "overlap" as const,
    cleanup: source.cleanup,
    acquire,
    retire,
    finalize: state.finalize,
    settle: state.settle,
    plan: state.plan,
    withAuthentication,
  });
}
