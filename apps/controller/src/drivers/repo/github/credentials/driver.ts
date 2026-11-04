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
} from "../../credentials/static-token-driver.ts";
import { createCredentialAuthentication } from "../../credentials/credential-authentication.ts";
import { createRepositoryDriverState } from "../../credentials/driver-state.ts";

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
  const state = createRepositoryDriverState({ authority, custody, routes });
  return Object.freeze<RepositoryBackend>({
    binding,
    replacement: "overlap",
    cleanup: "expiry-only",
    acquire: createStaticTokenAcquisition({ state, custody, clock, owner, leaseMs }),
    retire: createUnsupportedRetirement(state),
    finalize: state.finalize,
    settle: state.settle,
    plan: state.plan,
    prepareAuthentication: createCredentialAuthentication({
      state,
      clock,
      apiAuthentication: "bearer",
    }),
  });
}
