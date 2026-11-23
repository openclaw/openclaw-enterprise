import type { InspectedPluginPackage } from "@openclaw-enterprise/contracts";

export type PluginReleaseSummary = Pick<
  InspectedPluginPackage,
  "name" | "description" | "digest" | "version" | "mcpServers"
>;

export interface PluginReleaseReadRepository {
  find(namespaceId: string, digest: string): Promise<Readonly<InspectedPluginPackage> | undefined>;
  list(namespaceId: string): Promise<readonly PluginReleaseSummary[]>;
}

export interface PluginReleaseRepository extends PluginReleaseReadRepository {
  publish(namespaceId: string, actorId: string, release: InspectedPluginPackage): Promise<void>;
  purgeNamespace(namespaceId: string): Promise<void>;
}
