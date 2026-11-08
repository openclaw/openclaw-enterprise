import {
  credentialSourceMatchesSnapshot,
  isSecretHarnessAuth,
} from "@openclaw-enterprise/contracts";
import type {
  AgentRevision,
  CredentialSource,
  CredentialSourceSnapshot,
  CredentialGatewayDriver,
  CredentialProxyDriver,
  ResolvedHarnessAuth,
  SecretBindings,
  SecretBackendRef,
  SecretEnvironmentProjection,
} from "@openclaw-enterprise/contracts";
import type { PlatformStateStore } from "@openclaw-enterprise/occ";
import {
  harnessCredentialOwnerMatches,
  projectHarnessCredentialSource,
} from "../drivers/harness-credential-reader.ts";

type PreparationRefusal = {
  readonly result: { readonly outcome: "permanent"; readonly code: string };
};

export function resolveEnvironmentProjections(
  state: Pick<PlatformStateStore, "read">,
  revision: Pick<AgentRevision, "namespaceId" | "agentId">,
  bindings: SecretBindings,
  secretDriverId: string | undefined,
): Promise<SecretEnvironmentProjection[] | undefined> {
  return state.read(async (view) => {
    const projections: SecretEnvironmentProjection[] = [];
    for (const [name, binding] of Object.entries(bindings)) {
      const secret = await view.secrets.findSecret(binding.source.namespaceId, binding.source.id);
      if (
        secret === undefined ||
        secret.namespaceId !== revision.namespaceId ||
        secret.driverId !== secretDriverId ||
        !hasCompleteBackendReference(secret.backendRef)
      ) {
        return undefined;
      }
      projections.push({
        name,
        secretId: secret.id,
        namespaceId: secret.namespaceId,
        agentId: revision.agentId,
        backendRef: secret.backendRef,
      });
    }
    return projections;
  });
}

export async function resolveModelHarnessAuth(
  state: Pick<PlatformStateStore, "read">,
  revision: Pick<
    AgentRevision,
    "namespaceId" | "id" | "harnessAuth" | "executionAdmission" | "egressPlan"
  >,
  secretDriverId: string | undefined,
  gateway: Pick<CredentialGatewayDriver, "id"> | undefined,
  proxy: Pick<CredentialProxyDriver, "id" | "sourceControl"> | undefined,
): Promise<{ readonly harnessAuth: ResolvedHarnessAuth } | PreparationRefusal> {
  if (isSecretHarnessAuth(revision.harnessAuth)) {
    const auth = revision.harnessAuth;
    if (typeof secretDriverId !== "string" || auth.secretDriverId !== secretDriverId) {
      return { result: { outcome: "permanent", code: "SECRET_DRIVER_MISMATCH" } };
    }
    const secret = await state.read((view) =>
      view.secrets.findSecret(auth.source.namespaceId, auth.source.id),
    );
    if (
      secret === undefined ||
      secret.namespaceId !== revision.namespaceId ||
      secret.namespaceId !== auth.source.namespaceId ||
      secret.id !== auth.source.id ||
      secret.driverId !== secretDriverId ||
      !hasCompleteBackendReference(secret.backendRef)
    ) {
      return { result: { outcome: "permanent", code: "HARNESS_AUTH_SOURCE_UNAVAILABLE" } };
    }
    // Admission verifies the physical source. Workers project authoritative
    // OCC metadata without requiring permission to read backend Secret values.
    return { harnessAuth: { ...auth, backendRef: secret.backendRef } };
  }
  if (revision.harnessAuth.method === "credential_source") {
    const auth = revision.harnessAuth;
    if (!harnessCredentialOwnerMatches(auth, gateway, proxy)) {
      return { result: { outcome: "permanent", code: "CREDENTIAL_GATEWAY_MISMATCH" } };
    }
    const { source, withdrawal } = await resolveRevisionCredentialSource(state, revision, auth);
    // A withdrawn source never re-attaches to its revision, for example after Pod loss.
    if (withdrawal !== undefined) {
      return { result: { outcome: "permanent", code: "CREDENTIAL_WITHDRAWN" } };
    }
    // A deleting source can no longer be attached, even to an admitted revision.
    if (source === undefined) {
      return { result: { outcome: "permanent", code: "HARNESS_AUTH_SOURCE_UNAVAILABLE" } };
    }
    const projected = projectHarnessCredentialSource(auth, source, revision, proxy);
    if (projected === undefined) {
      return { result: { outcome: "permanent", code: "EGRESS_PROVIDER_UNAVAILABLE" } };
    }
    return { harnessAuth: { ...auth, source: projected } };
  }
  return { harnessAuth: revision.harnessAuth };
}

export async function resolveAttachedCredentialSources(
  state: Pick<PlatformStateStore, "read">,
  revision: Pick<AgentRevision, "namespaceId" | "id" | "harnessAuth" | "credentialSources">,
  gateway: Pick<CredentialGatewayDriver, "id"> | undefined,
  proxy: Pick<CredentialProxyDriver, "id"> | undefined,
): Promise<{ readonly credentialSources: Readonly<CredentialSource>[] } | PreparationRefusal> {
  const credentialSources: Readonly<CredentialSource>[] = [];
  const modelSourceId =
    revision.harnessAuth.method === "credential_source" ? revision.harnessAuth.sourceId : undefined;
  for (const snapshot of revision.credentialSources ?? []) {
    // The Harness source is listed too; it resolves above through the Harness binding.
    if (snapshot.sourceId === modelSourceId) {
      continue;
    }
    const sourceOwner = snapshot.credentialProxyId ?? snapshot.credentialGatewayId;
    if (sourceOwner !== (snapshot.credentialProxyId === undefined ? gateway?.id : proxy?.id)) {
      return { result: { outcome: "permanent", code: "CREDENTIAL_GATEWAY_MISMATCH" } };
    }
    const { source, withdrawal } = await resolveRevisionCredentialSource(state, revision, snapshot);
    // A withdrawn non-model source stays detached; the revision keeps running without it.
    if (withdrawal !== undefined) {
      continue;
    }
    if (source === undefined) {
      return { result: { outcome: "permanent", code: "CREDENTIAL_SOURCE_UNAVAILABLE" } };
    }
    credentialSources.push(source);
  }
  return { credentialSources };
}

function resolveRevisionCredentialSource(
  state: Pick<PlatformStateStore, "read">,
  revision: Pick<AgentRevision, "namespaceId" | "id">,
  snapshot: CredentialSourceSnapshot,
) {
  const { namespaceId, id: revisionId } = revision;
  const { sourceId } = snapshot;
  return state.read(async (view) => {
    const source = await view.credentialSources.findCredentialSource(namespaceId, sourceId);
    const withdrawal = await view.credentialSources.findCredentialWithdrawal(
      namespaceId,
      revisionId,
      sourceId,
    );
    return {
      source:
        withdrawal === undefined &&
        source?.state === "ready" &&
        credentialSourceMatchesSnapshot(source, snapshot)
          ? source
          : undefined,
      withdrawal,
    };
  });
}

function hasCompleteBackendReference(reference: SecretBackendRef): boolean {
  return (
    reference.namespaceName.trim().length > 0 &&
    reference.name.trim().length > 0 &&
    reference.key.trim().length > 0 &&
    reference.uid.trim().length > 0
  );
}
