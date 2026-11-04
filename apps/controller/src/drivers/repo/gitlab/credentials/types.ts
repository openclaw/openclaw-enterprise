import type {
  BoundPreparedRepositoryBackendFactory,
  Clock,
} from "../../credentials/backend-contracts.ts";
import type { ServiceLimits } from "../../credentials/service-contracts.ts";
import type { GitLabTokenConfiguration } from "./config.ts";
import type { GitLabProfile } from "../client.ts";

/** Internal route profiles; only the three public access profiles reach callers. */
export type GitLabTokenProfile =
  GitLabProfile | "metadata-read" | "git-ref-write" | "git-ref-draft-pr";

export type GitLabTokenClass = "fine-grained" | "personal" | "unknown";

/** Process-owned static token; lends a copy that is zeroed after use. */
export interface GitLabStaticTokenOwner {
  readonly kind: "gitlab-token";
  readonly tokenClass: GitLabTokenClass;
  withToken<T>(consume: (bytes: Uint8Array, assertCurrent: () => void) => Promise<T>): Promise<T>;
  close(): void;
}

export interface GitLabFactoryOptions {
  readonly configuration: GitLabTokenConfiguration;
  readonly authority: GitLabStaticTokenOwner;
  readonly namespaceId: string;
  readonly gatewayOrigin: string;
  readonly limits: ServiceLimits;
  readonly clock: Clock;
}

export interface GitLabDriverFactory extends BoundPreparedRepositoryBackendFactory {
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
}
