import type {
  AuditEvent,
  CredentialRefreshStatus,
  CredentialSource,
  Namespace,
  OAuthConnectionStatus,
} from "@openclaw-enterprise/contracts";

import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  credentialSourceMetadata,
  githubAppCredentialSourceMetadata,
  isManagedTokenServiceSource,
  oauthCredentialSourceMetadata,
  type CredentialSourceManagementMetadata,
} from "./credential-source-metadata.ts";
import {
  CredentialDeliveryFailedError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import { exactNamespace, namespaceIdentity } from "./resource-scope.ts";

export interface RotateCredentialSourceInput {
  readonly namespaceId: string;
  readonly credentialSourceId: string;
}

interface CredentialSourceDependencies {
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authority: Pick<ControllerAuthority, "authorize" | "canRead">;
  readonly getNamespace: (principalId: string, namespaceId: string) => Promise<Readonly<Namespace>>;
  readonly readConnectionStatus: (
    namespaceId: string,
    sourceId: string,
  ) => Promise<OAuthConnectionStatus>;
  readonly refreshTokenServiceSource: (
    namespaceId: string,
    sourceId: string,
  ) => Promise<CredentialRefreshStatus>;
}

function assertRefreshMinted(status: CredentialRefreshStatus): void {
  if (status.state === "ready") {
    return;
  }
  const code = status.failureCode === undefined ? "" : ` (${status.failureCode})`;
  throw new DependencyUnavailableError(`TokenService did not mint a token${code}.`);
}

export function createCredentialSourceOperations(dependencies: CredentialSourceDependencies) {
  async function rotateCredentialSource(
    principalId: string,
    input: RotateCredentialSourceInput,
    audit?: AuditEvent,
    failureAudit?: (reasonCode: string) => AuditEvent,
  ): Promise<CredentialSourceManagementMetadata> {
    namespaceIdentity(input.namespaceId);
    const source = await dependencies.transactions.transact(async (state) => {
      await dependencies.authority.authorize(principalId, "update", {
        kind: "credential_source",
        namespaceId: input.namespaceId,
        id: input.credentialSourceId,
      });
      const namespace = await exactNamespace(state, input.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const source = await state.credentialSources.lockCredentialSource(
        namespace.id,
        input.credentialSourceId,
      );
      if (!source) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      if (
        !isManagedTokenServiceSource(source) ||
        source.type === "static" ||
        source.state !== "ready"
      ) {
        throw new ResourceStateConflictError(
          "Only a ready TokenService OAuth or GitHub App installation Source can be renewed.",
        );
      }
      return source;
    });
    try {
      const refresh = await dependencies.refreshTokenServiceSource(source.namespaceId, source.id);
      assertRefreshMinted(refresh);
      if (audit) {
        await dependencies.transactions.transact((state) => state.audit.append(audit));
      }
      return dependencies.transactions.read(async (view) => {
        const current = await view.credentialSources.findCredentialSource(
          source.namespaceId,
          source.id,
        );
        if (
          !isManagedTokenServiceSource(current) ||
          current.type !== source.type ||
          current.state !== "ready"
        ) {
          throw new ResourceStateConflictError("The credential Source was retired during renewal.");
        }
        return current.type === "github-app-installation"
          ? githubAppCredentialSourceMetadata(current)
          : oauthCredentialSourceMetadata(view, current, { state: "ready", refresh });
      });
    } catch (error) {
      if (failureAudit) {
        const deliveryFailed = error instanceof CredentialDeliveryFailedError;
        await dependencies.transactions
          .transact(async (state) => {
            if (deliveryFailed && error.credentialUpdated && audit) {
              await state.audit.append(audit);
            }
            await state.audit.append(
              failureAudit(
                deliveryFailed
                  ? "CREDENTIAL_DELIVERY_FAILED"
                  : "CREDENTIAL_REFRESH_ROTATION_FAILED",
              ),
            );
          })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async function readCredentialSource(
    principalId: string,
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<CredentialSourceManagementMetadata> {
    await dependencies.authority.authorize(principalId, "read", {
      kind: "credential_source",
      id: credentialSourceId,
      namespaceId,
    });
    const source = await dependencies.transactions.read(async (state) => {
      await exactNamespace(state, namespaceId);
      const source = await state.credentialSources.findCredentialSource(
        namespaceId,
        credentialSourceId,
      );
      if (!source) {
        throw new ScopeViolationError(
          "The credential source does not belong to the exact Namespace.",
        );
      }
      return source;
    });
    if (!isManagedTokenServiceSource(source)) {
      throw new ResourceStateConflictError("Re-enroll this credential with TokenService.");
    }
    if (source.type === "static") {
      return credentialSourceMetadata(source);
    }
    if (source.type === "github-app-installation") {
      return githubAppCredentialSourceMetadata(source);
    }
    let refresh: OAuthConnectionStatus | undefined;
    if (source.state === "ready") {
      try {
        refresh = await dependencies.readConnectionStatus(namespaceId, source.id);
      } catch (error) {
        if (
          !(error instanceof DependencyUnavailableError) &&
          !(error instanceof ResourceStateConflictError)
        ) {
          throw error;
        }
      }
    }
    return dependencies.transactions.read((view) =>
      oauthCredentialSourceMetadata(
        view,
        source,
        refresh === undefined ? undefined : { state: refresh.state, refresh },
      ),
    );
  }

  async function listCredentialSources(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly CredentialSourceManagementMetadata[]> {
    const namespace = await dependencies.getNamespace(principalId, namespaceId);
    const catalog = await dependencies.transactions.read((state) =>
      state.credentialSources.listCredentialSources(namespace.id),
    );
    const sources: Readonly<CredentialSource>[] = [];
    for (const source of catalog) {
      if (
        isManagedTokenServiceSource(source) &&
        (await dependencies.authority.canRead(principalId, {
          kind: "credential_source",
          id: source.id,
          namespaceId: namespace.id,
        }))
      ) {
        sources.push(source);
      }
    }
    return dependencies.transactions.read(async (view) =>
      Object.freeze(
        await Promise.all(
          sources.map((source) => {
            if (source.type === "static") {
              return credentialSourceMetadata(source);
            }
            if (source.type === "github-app-installation") {
              return githubAppCredentialSourceMetadata(source);
            }
            return oauthCredentialSourceMetadata(view, source);
          }),
        ),
      ),
    );
  }

  return {
    rotateCredentialSource,
    readCredentialSource,
    listCredentialSources,
  };
}

export type CredentialSourceOperations = ReturnType<typeof createCredentialSourceOperations>;
