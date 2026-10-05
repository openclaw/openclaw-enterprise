import type { RepositoryBackendFactory } from "../../drivers/repo/credentials/backend-contracts.ts";
import type {
  ServiceConfig,
  RepositoryDescriptions,
} from "../../drivers/repo/credentials/service-contracts.ts";
import type { ProviderQueue } from "../../drivers/repo/credentials/provider-queue.ts";
import type { TlsMaterial } from "../../drivers/repo/credentials/internal-contracts.ts";
import type { GitHubTokenClass } from "../../drivers/repo/github/credentials/types.ts";

export interface LoadedConfiguration {
  readonly config: ServiceConfig;
  readonly tls: TlsMaterial;
  readonly factory: RepositoryBackendFactory;
  readonly providerQueue?: ProviderQueue;
  readonly repositoryDescriptions?: RepositoryDescriptions;
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
  /** Names the upstream authority; the token kind is development-only. */
  readonly authority: "github-app" | "github-app-registry" | "github-token-development";
  /** Present for the token authority only; derived from the token prefix, never secret. */
  readonly tokenClass?: GitHubTokenClass;
  close(): void;
}
