/** Malformed package detail suitable for display. Never include supplied file contents or credentials. */
export class PluginPackageInspectionError extends Error {}

/** Content of one admitted skill directory, relative to its SKILL.md. */
export interface ImportedPluginSkill {
  readonly name: string;
  readonly files: readonly {
    readonly path: string;
    readonly contentBase64: string;
    readonly executable: boolean;
  }[];
}

export interface ImportedMcpServer {
  readonly name: string;
  readonly url: string;
  readonly bearerEnv?: string;
}

export interface InspectedPluginPackage {
  readonly format: "agent-plugins" | "claude";
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly archiveSha256: string;
  readonly digest: string;
  readonly marketplaceEntry?: string;
  readonly skills: readonly ImportedPluginSkill[];
  readonly mcpServers: readonly ImportedMcpServer[];
  readonly unsupported: readonly { readonly component: string; readonly reason: string }[];
}

export type PluginConnectionRelease = Pick<
  InspectedPluginPackage,
  "name" | "digest" | "mcpServers"
>;

/** The same release content must hash identically before and after a JSONB round trip. */
export function canonicalPluginPackageContent(
  release: Omit<InspectedPluginPackage, "digest" | "archiveSha256">,
): string {
  return JSON.stringify({
    format: release.format,
    name: release.name,
    version: release.version,
    description: release.description,
    marketplaceEntry: release.marketplaceEntry,
    skills: release.skills.map(({ name, files }) => ({
      name,
      files: files.map(({ path, contentBase64, executable }) => ({
        path,
        contentBase64,
        executable,
      })),
    })),
    mcpServers: release.mcpServers.map(({ name, url, bearerEnv }) => ({ name, url, bearerEnv })),
    unsupported: release.unsupported.map(({ component, reason }) => ({ component, reason })),
  });
}
