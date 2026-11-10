import type {
  CredentialProxyBinding,
  ProtectedRepositoryGitAuthority,
} from "@openclaw-enterprise/contracts";
import type { PostgresPool } from "@openclaw-enterprise/occ";
import type { RepositoryServiceFactory } from "../../drivers/repo/access/backend-contracts.ts";
import type { ServiceConfig } from "../../drivers/repo/access/service-contracts.ts";
import type { TlsMaterial } from "../../drivers/repo/access/internal-contracts.ts";
import type { GitHubTokenClass } from "../../drivers/repo/github/access/types.ts";

export interface LoadedConfiguration {
  readonly config: ServiceConfig;
  readonly tls: TlsMaterial;
  readonly factory: RepositoryServiceFactory;
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
  readonly upstreamCa?: Uint8Array;
  /** Names the upstream authority; the token kind is development-only. */
  readonly authority: "github-prepared-git-registry" | "github-token-development";
  /** Present for the token authority only; derived from the token prefix, never secret. */
  readonly tokenClass?: GitHubTokenClass;
  close(): void;
}

export type RepositoryTransportEmit = (event: Readonly<Record<string, unknown>>) => void;

export interface RepositoryTransportBinding {
  bind(
    authority: ProtectedRepositoryGitAuthority,
    pool: PostgresPool,
    emit?: RepositoryTransportEmit,
  ): Promise<CredentialProxyBinding>;
}
