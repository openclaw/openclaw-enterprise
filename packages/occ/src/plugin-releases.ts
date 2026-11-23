import {
  PluginPackageInspectionError,
  type AuditEvent,
  type InspectedPluginPackage,
  type PluginDriver,
} from "@openclaw-enterprise/contracts";

import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { NotImplementedError, ResourceStateConflictError } from "./errors.ts";
import { exactNamespace, lockNamespace } from "./resource-scope.ts";

export interface PluginReleasePublication {
  readonly digest: string;
  readonly archiveSha256: string;
  readonly audit: (digest: string) => AuditEvent;
}

export function createPluginReleases(dependencies: {
  readonly authority: Pick<ControllerAuthority, "authorize" | "holdAuthority">;
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly pluginDriver: () => PluginDriver;
}) {
  async function authorizePluginPublication(
    principalId: string,
    namespaceId: string,
  ): Promise<void> {
    await dependencies.authority.authorize(principalId, "publish_plugins", {
      kind: "namespace",
      id: namespaceId,
      namespaceId,
    });
  }

  async function importPluginRelease(
    principalId: string,
    namespaceId: string,
    input: { readonly archiveBase64: string; readonly marketplaceEntry?: string },
    publication?: PluginReleasePublication,
  ) {
    await authorizePluginPublication(principalId, namespaceId);
    await dependencies.transactions.read((state) => exactNamespace(state, namespaceId));
    const driver = dependencies.pluginDriver();
    if (!driver.inspectPackage) {
      throw new NotImplementedError(
        "plugin_releases.import",
        "The selected Plugin Driver cannot import a plugin package.",
      );
    }
    const archive = Buffer.from(input.archiveBase64, "base64");
    if (archive.toString("base64") !== input.archiveBase64) {
      throw new PluginPackageInspectionError("The upload must contain one base64-encoded package.");
    }
    const release: InspectedPluginPackage = await driver.inspectPackage(
      archive,
      input.marketplaceEntry,
    );
    if (publication) {
      if (
        release.digest !== publication.digest ||
        release.archiveSha256 !== publication.archiveSha256
      ) {
        throw new ResourceStateConflictError(
          "The package differs from the preview. Review it again before publishing.",
        );
      }
      if (!release.skills.length && !release.mcpServers.length) {
        throw new PluginPackageInspectionError(
          "The package has no supported skills or hosted MCP servers to publish.",
        );
      }
      await dependencies.transactions.transact(async (state) => {
        await dependencies.authority.holdAuthority(state);
        const namespace = await lockNamespace(state, namespaceId);
        await authorizePluginPublication(principalId, namespaceId);
        if (namespace.status !== "ready" && namespace.status !== "provisioning") {
          throw new ResourceStateConflictError(
            "The Namespace is unavailable for plugin publication.",
          );
        }
        const existing = await state.pluginReleases.find(namespace.id, release.digest);
        if (existing && existing.archiveSha256 !== release.archiveSha256) {
          throw new ResourceStateConflictError(
            "This release was already published from a different package archive.",
          );
        }
        await state.pluginReleases.publish(namespace.id, principalId, release);
        await state.audit.append(publication.audit(release.digest));
      });
    }
    const { name, version, description, format, digest, mcpServers, unsupported } = release;
    return {
      name,
      version,
      description,
      format,
      digest,
      archiveSha256: release.archiveSha256,
      skills: release.skills.map(({ name: skill }) => skill),
      mcpServers,
      unsupported,
    };
  }

  return { authorizePluginPublication, importPluginRelease };
}
