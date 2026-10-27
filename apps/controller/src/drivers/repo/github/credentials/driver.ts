import type {
  AuthorityIdentity,
  Clock,
  DriverCustody,
  RepositoryBackend,
} from "../../credentials/backend-contracts.ts";
import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import type { RoutePolicy } from "./routes.ts";
import type { GitHubStaticTokenOwner } from "./types.ts";
import {
  createStaticTokenAcquisition,
  createUnsupportedRetirement,
} from "./driver/static-acquisition.ts";
import { createCredentialAuthentication } from "./driver/access.ts";
import { createGitHubDriverState } from "./driver/state.ts";

export { sameAuthority } from "./driver/state.ts";

interface GitHubDriverOptions {
  readonly authority: AuthorityIdentity;
  readonly binding: RepositoryCredentialGrantIdentity;
  readonly custody: DriverCustody;
  readonly clock: Clock;
  readonly routes: RoutePolicy;
  readonly owner: GitHubStaticTokenOwner;
  readonly leaseMs: number;
}

/** One session's backend for the development-only static token. */
export function createGitHubDriver(options: GitHubDriverOptions): RepositoryBackend {
  const { authority, binding, custody, clock, routes, owner, leaseMs } = options;
  const state = createGitHubDriverState({ authority, custody, routes });
  return Object.freeze<RepositoryBackend>({
    binding,
    replacement: "overlap",
    cleanup: "expiry-only",
    acquire: createStaticTokenAcquisition({ state, custody, clock, owner, leaseMs }),
    retire: createUnsupportedRetirement(state),
    finalize: state.finalize,
    settle: state.settle,
    plan: state.plan,
    withAuthentication: createCredentialAuthentication({ state, custody, clock }),
  });
}
