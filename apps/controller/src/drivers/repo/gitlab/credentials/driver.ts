import type {
  AuthorityIdentity,
  Clock,
  DriverCustody,
  RepositoryBackend,
} from "../../credentials/backend-contracts.ts";
import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import { createRepositoryDriverState } from "../../credentials/driver-state.ts";
import {
  createStaticTokenAcquisition,
  createUnsupportedRetirement,
} from "../../credentials/static-token-driver.ts";
import { createCredentialAuthentication } from "../../credentials/credential-authentication.ts";
import type { GitLabRoutePolicy } from "./routes.ts";
import type { GitLabStaticTokenOwner } from "./types.ts";

interface GitLabDriverOptions {
  readonly authority: AuthorityIdentity;
  readonly binding: RepositoryCredentialGrantIdentity;
  readonly custody: DriverCustody;
  readonly clock: Clock;
  readonly routes: GitLabRoutePolicy;
  readonly owner: GitLabStaticTokenOwner;
  readonly leaseMs: number;
}

export function createGitLabDriver(options: GitLabDriverOptions): RepositoryBackend {
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
      apiAuthentication: "private-token",
    }),
  });
}
